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

interface RawDescriptor {
  includes?: string;
  context?: { contract?: { deployments?: Deployment[] } };
  metadata?: { owner?: string };
  display?: { formats?: Record<string, { intent?: unknown }> };
}

function loadRaw(filePath: string, depth: number): RawDescriptor {
  if (depth > 3) {
    throw new DescriptorError(`Include chain too deep at ${filePath}`);
  }
  let raw: RawDescriptor;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8")) as RawDescriptor;
  } catch (err) {
    throw new DescriptorError(`Cannot read ${filePath}: ${(err as Error).message}`);
  }
  if (raw.includes) {
    const included = loadRaw(path.resolve(path.dirname(filePath), raw.includes), depth + 1);
    return {
      context: raw.context?.contract?.deployments?.length ? raw.context : included.context ?? raw.context,
      metadata: raw.metadata?.owner ? raw.metadata : included.metadata ?? raw.metadata,
      display: { formats: { ...included.display?.formats, ...raw.display?.formats } },
    };
  }
  return raw;
}

export function loadDescriptor(provider: string, fileName: string, registryRoot: string = REGISTRY_ROOT): Descriptor {
  const filePath = path.join(registryRoot, provider, fileName);
  const raw = loadRaw(filePath, 0);

  const deployments = raw.context?.contract?.deployments ?? [];
  if (deployments.length === 0) {
    throw new DescriptorError(`${fileName} has no contract deployments (maybe an EIP-712 descriptor?)`);
  }

  const formats = raw.display?.formats ?? {};
  const functions: FunctionEntry[] = [];
  const skippedKeys: string[] = [];
  for (const [key, value] of Object.entries(formats)) {
    try {
      const parsed = parseFormatKey(key);
      const intent = value?.intent;
      functions.push({ key, ...parsed, intent: typeof intent === "string" ? intent : undefined });
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
    owner: raw.metadata?.owner,
    deployments,
    functions,
    skippedKeys,
  };
}
