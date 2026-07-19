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
 * Path of a clear-signing definition inside the Trezor definitions tarball:
 * definitions/eth/chain-id/<chainId>/display-format/<address>-<selector>.dat
 * (address and selector in lowercase hex without 0x).
 */
export function displayFormatEntry(chainId: number, address: string, selector: string): string {
  const addr = address.toLowerCase().replace(/^0x/, "");
  const sel = selector.toLowerCase().replace(/^0x/, "");
  return `definitions/eth/chain-id/${chainId}/display-format/${addr}-${sel}.dat`;
}

const indexCache = new Map<string, Set<string>>();

/** Full entry listing of the tarball, cached per path for the session. */
export async function tarballIndex(tarballPath: string): Promise<Set<string>> {
  const resolved = expandTilde(tarballPath);
  const cached = indexCache.get(resolved);
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
  indexCache.set(resolved, entries);
  return entries;
}

/** A function-contract-deployment is supported iff its definition is in the tarball. */
export async function hasDefinition(
  tarballPath: string,
  chainId: number,
  address: string,
  selector: string,
): Promise<boolean> {
  return (await tarballIndex(tarballPath)).has(displayFormatEntry(chainId, address, selector));
}

/**
 * Extract a single entry into destDir, preserving the tarball's internal
 * directory structure. Skips extraction when the target file already exists.
 */
export async function extractEntry(
  tarballPath: string,
  entry: string,
  destDir: string,
): Promise<{ path: string; alreadyExtracted: boolean }> {
  const target = path.join(destDir, entry);
  if (existsSync(target)) {
    return { path: target, alreadyExtracted: true };
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
  return { path: target, alreadyExtracted: false };
}
