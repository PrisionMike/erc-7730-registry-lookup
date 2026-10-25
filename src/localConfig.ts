import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONFIG_FILE = path.join(PROJECT_ROOT, "config.local.json");

export interface TestWallet {
  mnemonic: string;
  passphrase: string;
}

/** Where trezorctl --definitions points: a tarball you hold, or the dev/prod deploys. */
export type DefinitionsSourceKind = "tarball" | "dev" | "prod";

interface LocalConfig {
  etherscanApiKey?: string;
  blockscoutApiKey?: string;
  testWallet?: TestWallet;
  /** Which definitions source to use; absent means "tarball", as before this option existed. */
  definitionsSource?: DefinitionsSourceKind;
  /** Path to the Trezor definitions tarball for trezorctl --definitions */
  definitionsPath?: string;
}

let cached: LocalConfig | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTestWallet(value: unknown): TestWallet | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.mnemonic !== "string" || value.mnemonic.trim().length === 0) return undefined;
  return {
    mnemonic: value.mnemonic.trim(),
    passphrase: typeof value.passphrase === "string" ? value.passphrase : "",
  };
}

/** Raw parsed config.local.json, so writes can preserve keys we don't model. */
function readRaw(): Record<string, unknown> {
  if (!existsSync(LOCAL_CONFIG_FILE)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readLocalConfig(): LocalConfig {
  if (cached) return cached;
  const parsed = readRaw();
  cached = {};
  if (typeof parsed.etherscanApiKey === "string" && parsed.etherscanApiKey.length > 0) {
    cached.etherscanApiKey = parsed.etherscanApiKey;
  }
  if (typeof parsed.blockscoutApiKey === "string" && parsed.blockscoutApiKey.length > 0) {
    cached.blockscoutApiKey = parsed.blockscoutApiKey;
  }
  cached.testWallet = parseTestWallet(parsed.testWallet);
  if (parsed.definitionsSource === "tarball" || parsed.definitionsSource === "dev" || parsed.definitionsSource === "prod") {
    cached.definitionsSource = parsed.definitionsSource;
  }
  // Kept verbatim: "" is a meaningful answer meaning "omit --definitions",
  // and distinguishing it from undefined is what stops us re-prompting.
  if (typeof parsed.definitionsPath === "string") {
    cached.definitionsPath = parsed.definitionsPath;
  }
  return cached;
}

/**
 * Etherscan API key: ETHERSCAN_API_KEY env var wins, otherwise falls back to
 * the gitignored config.local.json (see config.local.example.json).
 */
export function etherscanApiKey(): string | undefined {
  return process.env.ETHERSCAN_API_KEY ?? readLocalConfig().etherscanApiKey;
}

/**
 * Blockscout PRO API key (optional): BLOCKSCOUT_API_KEY env var wins, otherwise
 * config.local.json. Without it we hit the keyless per-chain instances, which
 * rate-limit hard.
 */
export function blockscoutApiKey(): string | undefined {
  return process.env.BLOCKSCOUT_API_KEY ?? readLocalConfig().blockscoutApiKey;
}

/** Test wallet used to sign generated fixtures (fills in result.sig_*). */
export function testWallet(): TestWallet | undefined {
  return readLocalConfig().testWallet;
}

/**
 * Definitions tarball path (tarball source only): TREZOR_DEFINITIONS env var wins, then
 * config.local.json. Returns undefined when neither is set (caller may prompt
 * and save).
 */
export function definitionsPath(): string | undefined {
  return process.env.TREZOR_DEFINITIONS ?? readLocalConfig().definitionsPath;
}

/** Selected definitions source; "tarball" unless the user picked otherwise. */
export function definitionsSourceKind(): DefinitionsSourceKind {
  return readLocalConfig().definitionsSource ?? "tarball";
}

/** Persist one key, leaving the rest of config.local.json untouched. */
function saveKey(key: string, value: string): void {
  const raw = readRaw();
  raw[key] = value;
  writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(raw, null, 2) + "\n");
  cached = undefined;
}

/** Persist the tarball path. */
export function saveDefinitionsPath(p: string): void {
  saveKey("definitionsPath", p);
}

export function saveDefinitionsSourceKind(kind: DefinitionsSourceKind): void {
  saveKey("definitionsSource", kind);
}
