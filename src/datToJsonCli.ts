import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DefinitionDecodeError, definitionToJson } from "./definitionJson.js";
import { yellow } from "./ui.js";

// TS twin of trezor-firmware's tools/snippets/eth_defs_dat_to_json.py, minus
// the signature check (see definitionJson.ts).
const USAGE = `Usage:
  npm run dat-to-json -- <file.dat>              write <file>.json next to it
  npm run dat-to-json -- <file.dat> -o <out>     write to <out>, or to stdout with -o -`;

function run(): void {
  const args = process.argv.slice(2);
  const outFlag = args.findIndex((a) => a === "-o" || a === "--output");
  const output = outFlag === -1 ? undefined : args[outFlag + 1];
  const positional = outFlag === -1 ? args : args.filter((_, i) => i !== outFlag && i !== outFlag + 1);
  const datFile = positional[0];
  if (positional.length !== 1 || datFile === undefined || (outFlag !== -1 && output === undefined)) {
    console.error(USAGE);
    process.exit(2);
  }

  let text: string;
  try {
    text = definitionToJson(readFileSync(datFile));
  } catch (err) {
    if (err instanceof DefinitionDecodeError) throw new Error(`${path.basename(datFile)}: ${err.message}`);
    throw err;
  }

  if (output === "-") {
    process.stdout.write(text);
    return;
  }
  const target = output ?? datFile.replace(/(\.dat)?$/, ".json");
  writeFileSync(target, text);
  console.error(`written: ${target}`);
}

try {
  run();
} catch (err: unknown) {
  console.error(yellow(err instanceof Error ? err.message : String(err)));
  process.exit(1);
}
