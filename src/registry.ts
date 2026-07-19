import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFormatKey } from "./selector.js";

/** Provider directories live inside the submodule's own registry/ subdir. */
export const REGISTRY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "registry",
  "registry",
);

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

function loadRaw(filePath: string, depth: number): RawDescriptor {
  if (depth > 3) {
    throw new DescriptorError(`Include chain too deep at ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new DescriptorError(`Cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const raw = normalize(parsed, filePath);
  if (raw.includes) {
    const included = loadRaw(path.resolve(path.dirname(filePath), raw.includes), depth + 1);
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
