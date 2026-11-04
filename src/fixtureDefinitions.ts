import path from "node:path";
import { DefinitionDecodeError, definitionToDict, definitionToJson } from "./definitionJson.js";
import { readEntry } from "./definitionsSource.js";
import { writeFixtureFile } from "./output.js";
import { contractNameEntry, displayFormatEntry, TarballError } from "./tarball.js";
import { dim, green, yellow } from "./ui.js";

/**
 * The definitions a fixture's device test is handed, saved as the JSON the
 * firmware tests read, at the same eth/chain-id/… path as
 * common/tests/fixtures/ethereum/definitions (the tests sign them on the fly).
 */

export interface FixtureTarget {
  chainId: number;
  /** The called contract. */
  address: string;
  selector: string;
  /** Whether the source has the function's display format. */
  supported: boolean | undefined;
}

interface Wanted {
  entry: string;
  /** "Definition", "Contract name of 0x…" — names it in messages. */
  label: string;
  /** Missing ones get their own warning; optional ones are only listed. */
  required: boolean;
}

/** What a definition says about itself: the contract's name, the token's symbol. */
function summary(blob: Buffer): string | undefined {
  try {
    const { data_type, message } = definitionToDict(blob);
    if (data_type === "ETHEREUM_TOKEN") return `${String(message.symbol)} (${String(message.name)})`;
    if (data_type === "ETHEREUM_DISPLAY_FORMAT" && typeof message.provider_name === "string") {
      return message.provider_name;
    }
  } catch {
    // definitionToJson below reports it.
  }
  return undefined;
}

export async function saveFixtureDefinitions(source: string, target: FixtureTarget): Promise<void> {
  const { chainId, address } = target;
  const wanted: Wanted[] = [];
  if (target.supported) {
    wanted.push({ entry: displayFormatEntry("", chainId, address, target.selector), label: "Definition", required: true });
  }
  // The device looks the contract's name up whenever it shows its address.
  wanted.push({ entry: contractNameEntry("", chainId, address), label: `Contract name of ${address}`, required: false });

  // In parallel: each is a request (URL) or a tar extraction (tarball).
  const results = await Promise.all(
    wanted.map(async (w) => {
      try {
        return { w, blob: await readEntry(source, w.entry) };
      } catch (err) {
        if (err instanceof TarballError) return { w, error: err.message };
        throw err;
      }
    }),
  );

  const errors = new Set<string>();
  const missing: string[] = [];
  for (const { w, blob, error } of results) {
    if (error !== undefined) {
      errors.add(error);
      continue;
    }
    if (!blob) {
      if (w.required) console.log(yellow(`${w.entry} is not in the definitions source.`));
      else missing.push(w.label);
      continue;
    }
    let json: string;
    try {
      json = definitionToJson(blob);
    } catch (err) {
      if (!(err instanceof DefinitionDecodeError)) throw err;
      console.log(yellow(`Cannot convert ${w.entry} to JSON: ${err.message}`));
      continue;
    }
    const written = writeFixtureFile(w.entry.replace(/\.dat$/, ".json"), json);
    const about = summary(blob);
    console.log(
      green(`✔ ${w.label}${about ? ` — ${about}` : ""} — saved as JSON to ${path.relative(process.cwd(), written.path)}`) +
        (written.overwrote ? dim(" (replaced previous)") : ""),
    );
  }
  for (const message of errors) console.log(yellow(message));
  if (missing.length > 0) console.log(dim(`Not in the definitions source: ${missing.join("; ")}.`));
}
