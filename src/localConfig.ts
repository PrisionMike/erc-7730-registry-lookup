import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_CONFIG_FILE = path.join(PROJECT_ROOT, "config.local.json");

interface LocalConfig {
  etherscanApiKey?: string;
}

let cached: LocalConfig | undefined;

function readLocalConfig(): LocalConfig {
  if (cached) return cached;
  if (!existsSync(LOCAL_CONFIG_FILE)) {
    cached = {};
    return cached;
  }
  try {
    cached = JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8")) as LocalConfig;
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
