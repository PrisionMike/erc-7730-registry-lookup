import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Gitignored folder collecting generated fixtures and extracted definitions. */
export const OUTPUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "output");

export function writeFixtureFile(fileName: string, contents: string): { path: string; overwrote: boolean } {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, fileName);
  const overwrote = existsSync(filePath);
  writeFileSync(filePath, contents.endsWith("\n") ? contents : contents + "\n");
  return { path: filePath, overwrote };
}
