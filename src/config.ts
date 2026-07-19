import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
  "erc7730-lookup",
);
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

interface Config {
  /** Path to the Trezor definitions tarball for trezorctl --definitions */
  definitionsPath?: string;
}

export function loadConfig(): Config {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Definitions tarball path: TREZOR_DEFINITIONS env var wins, then the saved
 * config. Returns undefined when neither is set (caller may prompt and save).
 */
export function definitionsPath(): string | undefined {
  return process.env.TREZOR_DEFINITIONS ?? loadConfig().definitionsPath;
}

export function saveDefinitionsPath(p: string): void {
  saveConfig({ ...loadConfig(), definitionsPath: p });
}
