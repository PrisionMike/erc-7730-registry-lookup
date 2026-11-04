import path from "node:path";
import { getAddress } from "ethers";
import { calldataAddresses } from "./calldataAddresses.js";
import { DefinitionDecodeError, definitionToDict, definitionToJson } from "./definitionJson.js";
import { readEntry } from "./definitionsSource.js";
import { writeFixtureFile } from "./output.js";
import { contractNameEntry, displayFormatEntry, TarballError, tokenEntry } from "./tarball.js";
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
  /** The transaction's input, whose addresses get looked up too. */
  calldata: string;
  /** The registry format key, i.e. the function's signature, to decode the calldata with. */
  functionKey?: string;
}

interface Wanted {
  entry: string;
  /** "Definition", "Contract name of 0x…" — names it in messages. */
  label: string;
  /** Missing ones get their own warning; per-address ones are only listed. */
  required: boolean;
  /** The address it describes, for per-address lookups. */
  address?: string;
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
  // The device names a contract whenever it shows its address — from its
  // name-only display format, or failing that its token definition — and shows
  // token amounts from token definitions. So bring both for the called contract
  // and for every address the calldata carries.
  const addresses = [...new Set([getAddress(address), ...calldataAddresses(target.calldata, target.functionKey)])];
  for (const a of addresses) {
    wanted.push({ entry: contractNameEntry("", chainId, a), label: `Contract name of ${a}`, required: false, address: a });
    wanted.push({ entry: tokenEntry("", chainId, a), label: `Token ${a}`, required: false, address: a });
  }

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
  const unknown = new Set(addresses);
  for (const { w, blob, error } of results) {
    if (error !== undefined) {
      errors.add(error);
      continue;
    }
    if (!blob) {
      if (w.required) console.log(yellow(`${w.entry} is not in the definitions source.`));
      continue;
    }
    if (w.address) unknown.delete(w.address);
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
  if (errors.size === 0) {
    const looked = `Looked up ${addresses.length} address(es) — the contract and the calldata's — as contract names and tokens`;
    console.log(dim(unknown.size > 0 ? `${looked}; none for ${[...unknown].join(", ")}.` : `${looked}.`));
  }
}
