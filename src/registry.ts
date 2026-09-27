import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFormatKey } from "./selector.js";

/** Root of the registry git submodule. */
export const REGISTRY_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "registry",
);

/** Provider directories live inside the submodule's own registry/ subdir. */
export const REGISTRY_ROOT = path.join(REGISTRY_REPO_ROOT, "registry");

export interface Deployment {
  chainId: number;
  address: string;
}

export interface FunctionEntry {
  /** Raw display.formats key */
  key: string;
  name: string;
  signature?: string;
  selector: string;
  intent?: string;
}

export interface Descriptor {
  provider: string;
  /** "MorphoBlue" from calldata-MorphoBlue.json */
  name: string;
  filePath: string;
  owner?: string;
  deployments: Deployment[];
  functions: FunctionEntry[];
  /** Format keys that could not be parsed into a selector */
  skippedKeys: string[];
}

export class DescriptorError extends Error {}

export function listProviders(registryRoot: string = REGISTRY_ROOT): string[] {
  return readdirSync(registryRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

export function listDescriptorFiles(provider: string, registryRoot: string = REGISTRY_ROOT): string[] {
  return readdirSync(path.join(registryRoot, provider), { withFileTypes: true })
    .filter((e) => e.isFile() && /^calldata-.*\.json$/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** A descriptor file's contents, validated and flattened. */
interface RawDescriptor {
  includes?: string;
  deployments: Deployment[];
  owner?: string;
  /** format key → intent (when present and a string) */
  formats: Record<string, string | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDeployment(value: unknown): value is Deployment {
  return isRecord(value) && typeof value.chainId === "number" && typeof value.address === "string";
}

function normalize(value: unknown, filePath: string): RawDescriptor {
  if (!isRecord(value)) {
    throw new DescriptorError(`${filePath} is not a JSON object`);
  }
  const contract = isRecord(value.context) && isRecord(value.context.contract) ? value.context.contract : {};
  const deployments = Array.isArray(contract.deployments) ? contract.deployments.filter(isDeployment) : [];
  const owner = isRecord(value.metadata) && typeof value.metadata.owner === "string" ? value.metadata.owner : undefined;

  const formats: Record<string, string | undefined> = {};
  const rawFormats = isRecord(value.display) && isRecord(value.display.formats) ? value.display.formats : {};
  for (const [key, format] of Object.entries(rawFormats)) {
    formats[key] = isRecord(format) && typeof format.intent === "string" ? format.intent : undefined;
  }

  return {
    includes: typeof value.includes === "string" ? value.includes : undefined,
    deployments,
    owner,
    formats,
  };
}

const MAX_INCLUDE_DEPTH = 3;

/**
 * Resolve an `includes` value against the file that declares it. Usually leaves
 * the provider directory entirely — 105 of the 150 uses point at
 * "../../ercs/calldata-erc4626-vaults.json", i.e. outside REGISTRY_ROOT.
 */
function resolveInclude(filePath: string, includes: string): string {
  return path.resolve(path.dirname(filePath), includes);
}

function readDescriptorJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new DescriptorError(`Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadRaw(filePath: string, depth: number): RawDescriptor {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new DescriptorError(`Include chain too deep at ${filePath}`);
  }
  const raw = normalize(readDescriptorJson(filePath), filePath);
  if (raw.includes) {
    const included = loadRaw(resolveInclude(filePath, raw.includes), depth + 1);
    return {
      deployments: raw.deployments.length > 0 ? raw.deployments : included.deployments,
      owner: raw.owner ?? included.owner,
      formats: { ...included.formats, ...raw.formats },
    };
  }
  return raw;
}

export function loadDescriptor(provider: string, fileName: string, registryRoot: string = REGISTRY_ROOT): Descriptor {
  const filePath = path.join(registryRoot, provider, fileName);
  const raw = loadRaw(filePath, 0);

  if (raw.deployments.length === 0) {
    throw new DescriptorError(`${fileName} has no contract deployments (maybe an EIP-712 descriptor?)`);
  }

  const functions: FunctionEntry[] = [];
  const skippedKeys: string[] = [];
  for (const [key, intent] of Object.entries(raw.formats)) {
    try {
      functions.push({ key, ...parseFormatKey(key), intent });
    } catch {
      skippedKeys.push(key);
    }
  }
  if (functions.length === 0) {
    throw new DescriptorError(`${fileName} has no parseable display formats`);
  }
  functions.sort((a, b) => a.name.localeCompare(b.name));

  return {
    provider,
    name: fileName.replace(/^calldata-/, "").replace(/\.json$/, ""),
    filePath,
    owner: raw.owner,
    deployments: raw.deployments,
    functions,
    skippedKeys,
  };
}

/** One file in a descriptor's include chain. */
export interface DescriptorFile {
  filePath: string;
  /** Relative to the submodule root: "registry/kiln/calldata-….json". */
  displayPath: string;
  json: Record<string, unknown>;
}

/** A descriptor and every file it includes, leaf (the descriptor itself) first. */
export function loadDescriptorChain(filePath: string): DescriptorFile[] {
  const chain: DescriptorFile[] = [];
  let current = filePath;
  for (let depth = 0; ; depth++) {
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new DescriptorError(`Include chain too deep at ${current}`);
    }
    const parsed = readDescriptorJson(current);
    if (!isRecord(parsed)) {
      throw new DescriptorError(`${current} is not a JSON object`);
    }
    chain.push({
      filePath: current,
      displayPath: path.relative(REGISTRY_REPO_ROOT, current),
      json: parsed,
    });
    const includes = parsed.includes;
    if (typeof includes !== "string") return chain;
    current = resolveInclude(current, includes);
  }
}

/** Distinguishes "absent" from "present but null", which `value ?? undefined` cannot. */
function getPath(root: unknown, segments: string[]): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const segment of segments) {
    if (!isRecord(cur) || !Object.prototype.hasOwnProperty.call(cur, segment)) {
      return { found: false, value: undefined };
    }
    cur = cur[segment];
  }
  return { found: true, value: cur };
}

function formatsOf(file: DescriptorFile): Record<string, unknown> | undefined {
  const found = getPath(file.json, ["display", "formats"]);
  return isRecord(found.value) ? found.value : undefined;
}

function selectorOf(key: string): string | undefined {
  try {
    return parseFormatKey(key).selector;
  } catch {
    return undefined;
  }
}

/** A "$.path.to.value" reference from inside a format block, and what it points at. */
export interface ResolvedReference {
  ref: string;
  value: unknown;
  /** Which chain file supplied it; undefined when nothing in the chain defines it. */
  source?: DescriptorFile;
}

const REF_PREFIX = "$.";
/** References chain ($.display.definitions.x → $.metadata.constants.y); bound the walk. */
const MAX_REF_DEPTH = 4;

function collectRefs(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith(REF_PREFIX)) into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectRefs(item, into);
  }
}

function resolveReferences(block: unknown, chain: DescriptorFile[]): ResolvedReference[] {
  const resolved = new Map<string, ResolvedReference>();
  let frontier = new Set<string>();
  collectRefs(block, frontier);

  for (let depth = 0; depth < MAX_REF_DEPTH && frontier.size > 0; depth++) {
    const next = new Set<string>();
    for (const ref of frontier) {
      if (resolved.has(ref)) continue;
      const segments = ref.slice(REF_PREFIX.length).split(".");
      let entry: ResolvedReference = { ref, value: undefined };
      // Leaf-first: the nearest definition wins, which is how a 6-line descriptor
      // can supply constants consumed by a format block two includes up.
      for (const file of chain) {
        const hit = getPath(file.json, segments);
        if (hit.found) {
          entry = { ref, value: hit.value, source: file };
          break;
        }
      }
      resolved.set(ref, entry);
      if (entry.source) collectRefs(entry.value, next);
    }
    frontier = next;
  }

  return [...resolved.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

export interface FormatBlock {
  /** The key as spelled in the file that owns it. */
  key: string;
  block: unknown;
  source: DescriptorFile;
  /** True when found by selector rather than by exact key text. */
  matchedBySelector: boolean;
  references: ResolvedReference[];
  chain: DescriptorFile[];
}

function findBySelector(chain: DescriptorFile[], key: string): { file: DescriptorFile; key: string } | undefined {
  const wanted = selectorOf(key);
  if (wanted === undefined) return undefined;
  for (const file of chain) {
    const formats = formatsOf(file);
    if (!formats) continue;
    for (const candidate of Object.keys(formats)) {
      if (selectorOf(candidate) === wanted) return { file, key: candidate };
    }
  }
  return undefined;
}

/**
 * Locate a function's format block anywhere in the include chain, with its
 * "$." references resolved. 145 of the 247 browsable descriptors define no
 * formats of their own, so the block usually lives in an included file.
 */
export function loadFormatBlock(filePath: string, key: string): FormatBlock {
  const chain = loadDescriptorChain(filePath);

  let owner = chain.find((file) => {
    const formats = formatsOf(file);
    return formats !== undefined && Object.prototype.hasOwnProperty.call(formats, key);
  });
  let ownerKey = key;
  let matchedBySelector = false;

  if (!owner) {
    // A leaf override and its include can spell the same function differently
    // (parameter names, whitespace), so fall back to matching on selector.
    const bySelector = findBySelector(chain, key);
    if (bySelector) {
      owner = bySelector.file;
      ownerKey = bySelector.key;
      matchedBySelector = true;
    }
  }

  if (!owner) {
    throw new DescriptorError(
      `No display.formats entry for ${key} in ${chain.map((f) => f.displayPath).join(" → ")}`,
    );
  }

  const block = getPath(owner.json, ["display", "formats", ownerKey]).value;
  return {
    key: ownerKey,
    block,
    source: owner,
    matchedBySelector,
    references: resolveReferences(block, chain),
    chain,
  };
}
