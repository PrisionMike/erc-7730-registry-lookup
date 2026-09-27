import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { REGISTRY_REPO_ROOT } from "./registry.js";

const execFileAsync = promisify(execFile);

export type GitFailure = "no-git" | "not-initialized" | "network" | "unknown-ref" | "other";

export class GitError extends Error {
  constructor(
    message: string,
    /** What went wrong, so callers branch on the kind rather than on stderr text. */
    readonly kind: GitFailure,
  ) {
    super(message);
  }
}

export interface CommitInfo {
  sha: string;
  short: string;
  /** Committer date, ISO 8601. */
  date: string;
  subject: string;
}

export interface RegistryState {
  commit: CommitInfo;
  /** Branch name when HEAD is attached, undefined when detached. */
  branch?: string;
  dirty: boolean;
  /** Paths reported by `git status --porcelain`, empty when clean. */
  dirtyPaths: string[];
  /** From origin/HEAD, falling back to "master". */
  defaultBranch: string;
}

export interface DescriptorChange {
  status: "A" | "M" | "D" | "R";
  file: string;
}

export interface UpdateSummary {
  from: CommitInfo;
  to: CommitInfo;
  /** Commits in from..to — 0 when `to` is not a descendant of `from`. */
  commitCount: number;
  changedDescriptors: DescriptorChange[];
  /** Every changed path, including the ones filtered out of changedDescriptors. */
  changedTotal: number;
  newProviders: string[];
  removedProviders: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

const NETWORK_HINT =
  /could not resolve host|could not read from remote|connection timed out|unable to access|network is unreachable|operation timed out|failed to connect/i;

function classify(err: unknown, args: string[]): GitError {
  // execFile rejects with an Error carrying `code` and `stderr`; neither is on Error itself.
  const failure = isRecord(err) ? err : {};
  if (failure.code === "ENOENT") {
    return new GitError("git is not on PATH — install git to manage the registry submodule.", "no-git");
  }
  const stderr = failure.stderr === undefined ? "" : String(failure.stderr);
  if (NETWORK_HINT.test(stderr)) {
    return new GitError(`Cannot reach the registry remote: ${firstLine(stderr)}`, "network");
  }
  const detail = firstLine(stderr) || (err instanceof Error ? err.message : String(err));
  return new GitError(`git ${args.join(" ")} failed: ${detail}`, "other");
}

/** A submodule's .git is a *file* ("gitdir: ../.git/modules/registry"), not a directory. */
function ensureInitialized(): void {
  if (!existsSync(path.join(REGISTRY_REPO_ROOT, ".git"))) {
    throw new GitError("registry/ is not initialized — run: git submodule update --init", "not-initialized");
  }
}

async function git(args: string[]): Promise<string> {
  ensureInitialized();
  try {
    const { stdout } = await execFileAsync("git", ["-C", REGISTRY_REPO_ROOT, ...args], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (err) {
    throw classify(err, args);
  }
}

/**
 * Like git(), but a plain non-zero exit yields undefined instead of throwing —
 * for commands where failure is a legitimate answer (`symbolic-ref` on a
 * detached HEAD, `rev-parse --verify` on an unknown ref).
 */
async function gitOptional(args: string[]): Promise<string | undefined> {
  try {
    return await git(args);
  } catch (err) {
    if (err instanceof GitError && err.kind === "other") return undefined;
    throw err;
  }
}

const LOG_FORMAT = "%H%x00%h%x00%cI%x00%s";

function parseCommit(line: string, ref: string): CommitInfo {
  const parts = line.split("\0");
  const [sha, short, date] = parts;
  if (sha === undefined || short === undefined || date === undefined) {
    throw new GitError(`Cannot read commit info for ${ref}`, "other");
  }
  return { sha, short, date, subject: parts[3] ?? "" };
}

async function commitInfo(ref: string): Promise<CommitInfo> {
  return parseCommit(await git(["log", "-1", `--format=${LOG_FORMAT}`, ref]), ref);
}

export async function registryState(): Promise<RegistryState> {
  const commit = await commitInfo("HEAD");
  const branch = await gitOptional(["symbolic-ref", "-q", "--short", "HEAD"]);
  const status = await git(["status", "--porcelain", "--ignore-submodules=all"]);
  const originHead = await gitOptional(["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  const dirtyPaths = status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.slice(3));
  return {
    commit,
    branch: branch || undefined,
    dirty: dirtyPaths.length > 0,
    dirtyPaths,
    defaultBranch: originHead?.replace(/^origin\//, "") || "master",
  };
}

export async function fetchUpstream(): Promise<void> {
  await git(["fetch", "--prune", "origin"]);
}

export async function resolveRef(ref: string): Promise<CommitInfo> {
  const sha = await gitOptional(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (!sha) {
    throw new GitError(
      `No such commit or ref in the registry: ${ref} — check the hash, or it may not be on origin yet.`,
      "unknown-ref",
    );
  }
  return commitInfo(sha);
}

/**
 * Detaching matches what `git submodule update` itself produces, and sidesteps
 * fast-forward/divergence questions on the branch the submodule may be sitting on.
 */
export async function checkout(sha: string): Promise<void> {
  await git(["checkout", "--detach", sha]);
}

/** Descriptor sources, as paths relative to the submodule root. */
const DESCRIPTOR_PATH = /^(registry\/[^/]+\/(calldata|common)-.*\.json|ercs\/.*\.json)$/;
const TEST_SEGMENT = /(^|\/)tests?v?\d*(\/|$)/;

function changeStatus(raw: string): DescriptorChange["status"] {
  const first = raw.charAt(0);
  return first === "A" || first === "D" || first === "R" ? first : "M";
}

/** Directories directly under registry/, i.e. the provider list at that commit. */
async function providersAt(sha: string): Promise<Set<string>> {
  const out = await git(["ls-tree", "-d", "--name-only", sha, "registry/"]);
  return new Set(
    out
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^registry\//, "").replace(/\/$/, "")),
  );
}

export async function summarize(fromSha: string, toSha: string): Promise<UpdateSummary> {
  const from = await commitInfo(fromSha);
  const to = await commitInfo(toSha);
  const commitCount = Number(await git(["rev-list", "--count", `${fromSha}..${toSha}`])) || 0;

  const lines = (await git(["diff", "--name-status", fromSha, toSha]))
    .split("\n")
    .filter((line) => line.length > 0);

  const changedDescriptors: DescriptorChange[] = [];
  for (const line of lines) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const status = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    // A rename is "R100\told\tnew" — report where the file ended up.
    const file = status.startsWith("R") ? rest.slice(rest.indexOf("\t") + 1) : rest;
    if (TEST_SEGMENT.test(file) || !DESCRIPTOR_PATH.test(file)) continue;
    changedDescriptors.push({ status: changeStatus(status), file });
  }

  const before = await providersAt(fromSha);
  const after = await providersAt(toSha);
  return {
    from,
    to,
    commitCount,
    changedDescriptors,
    changedTotal: lines.length,
    newProviders: [...after].filter((p) => !before.has(p)).sort(),
    removedProviders: [...before].filter((p) => !after.has(p)).sort(),
  };
}

export type UpdateOutcome =
  | { kind: "dirty"; state: RegistryState }
  | { kind: "already"; commit: CommitInfo }
  | { kind: "moved"; summary: UpdateSummary };

/**
 * Move the submodule to `ref`, or to the tip of the default branch when `ref`
 * is undefined. Always fetches first — a hash pushed minutes ago is not local
 * yet. Refuses to touch a dirty tree. Throws GitError; callers render it.
 */
export async function updateTo(ref?: string, onFetch?: () => void): Promise<UpdateOutcome> {
  const state = await registryState();
  if (state.dirty) return { kind: "dirty", state };

  onFetch?.();
  await fetchUpstream();
  const to = await resolveRef(ref ?? `origin/${state.defaultBranch}`);
  if (to.sha === state.commit.sha) return { kind: "already", commit: to };

  // Summarise before checking out, so a failed checkout reports nothing at all
  // rather than changes that did not happen.
  const summary = await summarize(state.commit.sha, to.sha);
  await checkout(to.sha);
  return { kind: "moved", summary };
}
