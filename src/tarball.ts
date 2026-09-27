import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class TarballError extends Error {}

export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Path of a clear-signing definition inside a definitions archive:
 * <prefix>eth/chain-id/<chainId>/display-format/<address>-<selector>.dat
 * (address and selector in lowercase hex without 0x).
 */
export function displayFormatEntry(
  prefix: string,
  chainId: number,
  address: string,
  selector: string,
): string {
  const addr = address.toLowerCase().replace(/^0x/, "");
  const sel = selector.toLowerCase().replace(/^0x/, "");
  return `${prefix}eth/chain-id/${chainId}/display-format/${addr}-${sel}.dat`;
}

/**
 * Definitions always sit under an `eth/chain-id/` component, but how deeply
 * that is nested depends on which ball you point at:
 *   deploy.tar.xz      → definitions/eth/chain-id/...
 *   definitions.tar.xz → eth/chain-id/...  (the ball nested in deploy.tar.xz)
 * So we take the prefix to be whatever precedes `eth/chain-id/` in the index
 * rather than assuming either layout. The non-greedy group keeps us on the
 * shallowest match, and deploy.tar.xz's sibling `eth-definitions/chain-id/`
 * tree deliberately does not match — it has no `eth/` component.
 */
const ETH_ROOT = /^(|.*?\/)eth\/chain-id\//;

interface Layout {
  /** "definitions/" for deploy.tar.xz, "" for a bare definitions.tar.xz. */
  prefix: string;
  entries: Set<string>;
}

const layoutCache = new Map<string, Layout>();

function detectPrefix(entries: Iterable<string>, resolved: string): string {
  for (const entry of entries) {
    const prefix = ETH_ROOT.exec(entry)?.[1];
    if (prefix !== undefined) return prefix;
  }
  throw new TarballError(
    `${resolved} contains no eth/chain-id/ entries — expected a Trezor definitions ` +
      `tarball (deploy.tar.xz or the definitions.tar.xz inside it).`,
  );
}

/** Entry listing plus detected layout, cached per path for the session. */
async function tarballLayout(tarballPath: string): Promise<Layout> {
  const resolved = expandTilde(tarballPath);
  const cached = layoutCache.get(resolved);
  if (cached) return cached;
  if (!existsSync(resolved)) {
    throw new TarballError(`Definitions tarball not found: ${resolved}`);
  }
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("tar", ["-tJf", resolved], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (err) {
    throw new TarballError(`Cannot list ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const entries = new Set(stdout.split("\n").filter((line) => line.length > 0));
  const layout: Layout = { prefix: detectPrefix(entries, resolved), entries };
  layoutCache.set(resolved, layout);
  return layout;
}

/**
 * Locate a function-contract-deployment's definition, resolving the entry path
 * against whichever layout this tarball uses. The deployment is supported iff
 * `found` — the returned `entry` is what we looked for either way.
 */
export async function findDefinition(
  tarballPath: string,
  chainId: number,
  address: string,
  selector: string,
): Promise<{ entry: string; found: boolean }> {
  const { prefix, entries } = await tarballLayout(tarballPath);
  const entry = displayFormatEntry(prefix, chainId, address, selector);
  return { entry, found: entries.has(entry) };
}

/**
 * Read one entry into memory. `relativeEntry` is the path below the layout
 * prefix ("eth/chain-id/1/network.dat"); undefined when the tarball lacks it.
 */
export async function readEntry(tarballPath: string, relativeEntry: string): Promise<Buffer | undefined> {
  const { prefix, entries } = await tarballLayout(tarballPath);
  const entry = prefix + relativeEntry;
  if (!entries.has(entry)) return undefined;
  try {
    const { stdout } = await execFileAsync("tar", ["-xJOf", expandTilde(tarballPath), entry], {
      encoding: "buffer",
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    throw new TarballError(`Cannot read ${entry}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Extract a definition into destDir, preserving the tarball's internal
 * directory structure. Skips extraction when the target file already exists.
 */
export async function extractDefinition(
  tarballPath: string,
  chainId: number,
  address: string,
  selector: string,
  destDir: string,
): Promise<{ entry: string; path: string; alreadyExtracted: boolean }> {
  const { entry } = await findDefinition(tarballPath, chainId, address, selector);
  const target = path.join(destDir, entry);
  if (existsSync(target)) {
    return { entry, path: target, alreadyExtracted: true };
  }
  mkdirSync(destDir, { recursive: true });
  try {
    await execFileAsync("tar", ["-xJf", expandTilde(tarballPath), "-C", destDir, entry]);
  } catch (err) {
    throw new TarballError(`Cannot extract ${entry}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!existsSync(target)) {
    throw new TarballError(`Extraction ran but ${target} did not appear`);
  }
  return { entry, path: target, alreadyExtracted: false };
}
