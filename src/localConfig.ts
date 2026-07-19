import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONFIG_FILE = path.join(PROJECT_ROOT, "config.local.json");

export interface TestWallet {
  mnemonic: string;
  passphrase: string;
}

interface LocalConfig {
  etherscanApiKey?: string;
  testWallet?: TestWallet;
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

function readLocalConfig(): LocalConfig {
  if (cached) return cached;
  if (!existsSync(LOCAL_CONFIG_FILE)) {
    cached = {};
    return cached;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8"));
    if (!isRecord(parsed)) {
      cached = {};
      return cached;
    }
    cached = {};
    if (typeof parsed.etherscanApiKey === "string" && parsed.etherscanApiKey.length > 0) {
      cached.etherscanApiKey = parsed.etherscanApiKey;
    }
    cached.testWallet = parseTestWallet(parsed.testWallet);
  } catch {
    cached = {};
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

/** Test wallet used to sign generated fixtures (fills in result.sig_*). */
export function testWallet(): TestWallet | undefined {
  return readLocalConfig().testWallet;
}
