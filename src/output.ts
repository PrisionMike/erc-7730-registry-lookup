import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Gitignored folder collecting generated fixtures and their definitions as JSON. */
export const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "output");

/** `fileName` may include subdirectories, which are created as needed. */
export function writeFixtureFile(fileName: string, contents: string): { path: string; overwrote: boolean } {
  const filePath = path.join(OUTPUT_DIR, fileName);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const overwrote = existsSync(filePath);
  writeFileSync(filePath, contents.endsWith("\n") ? contents : contents + "\n");
  return { path: filePath, overwrote };
}
