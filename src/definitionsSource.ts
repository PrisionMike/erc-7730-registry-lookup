import * as tarball from "./tarball.js";
import { TarballError } from "./tarball.js";

/**
 * Where definitions come from. A "source" string is whatever trezorctl's
 * --definitions takes: a tarball path, or an http(s) base URL that the
 * `eth/chain-id/…` entries hang off. Everything here accepts either, so the
 * support check, fixture definition JSON and token metadata work the same for both.
 *
 * Both URLs point at the v2 tree (trzd2 blobs). trezorlib's own default
 * (`-a`) is the unversioned data.trezor.io path, which still serves v1 blobs.
 */

/** Output of trezor/definitions' "[Deploy] unsigned dev firmware definitions" workflow. */
export const DEV_DEFINITIONS_URL = "https://dev.firmware.sldev.cz/unsigned/v2/definitions/";

/** Output of the production deploy: <bucket>/firmware/definitions/vN for N ≥ 2. */
export const PROD_DEFINITIONS_URL = "https://data.trezor.io/firmware/definitions/v2/";

const REQUEST_TIMEOUT_MS = 30_000;

/** Present on every network, so a 200 for it proves the base URL serves definitions. */
const PROBE_ENTRY = "eth/chain-id/1/network.dat";

export function isUrl(source: string): boolean {
  return /^https?:\/\//i.test(source);
}

/** trezorlib appends entry paths straight onto the URL, so it must end in a slash. */
export function normalizeSource(source: string): string {
  return isUrl(source) && !source.endsWith("/") ? `${source}/` : source;
}

// One GET per URL per session: the support check and the fixture's definition
// JSON that follows it ask for the same blob.
const fetched = new Map<string, Promise<Buffer | undefined>>();
const servingChecks = new Map<string, Promise<void>>();

async function get(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new TarballError(`Cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * S3 answers 403 rather than 404 for a missing key when the bucket can't be
 * listed, so a bare 403 is ambiguous: "no such definition" or "no access to
 * this source at all". Telling those apart takes a file that must exist.
 */
function ensureServing(base: string): Promise<void> {
  let pending = servingChecks.get(base);
  if (!pending) {
    pending = get(base + PROBE_ENTRY).then((res) => {
      if (!res.ok) {
        throw new TarballError(
          `${base} is not serving definitions (HTTP ${res.status} for ${PROBE_ENTRY}) — ` +
            `it may need VPN or other access.`,
        );
      }
    });
    // A failed check (e.g. VPN not up yet) must not stick for the session.
    pending.catch(() => servingChecks.delete(base));
    servingChecks.set(base, pending);
  }
  return pending;
}

async function fetchEntry(base: string, relativeEntry: string): Promise<Buffer | undefined> {
  const url = base + relativeEntry;
  const res = await get(url);
  if (res.ok) return Buffer.from(await res.arrayBuffer());
  if (res.status === 404) return undefined;
  if (res.status === 403) {
    await ensureServing(base);
    return undefined;
  }
  throw new TarballError(`${url} answered HTTP ${res.status}`);
}

function remoteEntry(source: string, relativeEntry: string): Promise<Buffer | undefined> {
  const base = normalizeSource(source);
  const key = base + relativeEntry;
  let pending = fetched.get(key);
  if (!pending) {
    pending = fetchEntry(base, relativeEntry);
    pending.catch(() => fetched.delete(key));
    fetched.set(key, pending);
  }
  return pending;
}

/** Locate a function-contract-deployment's definition; `found` iff the source has it. */
export async function findDefinition(
  source: string,
  chainId: number,
  address: string,
  selector: string,
): Promise<{ entry: string; found: boolean }> {
  if (!isUrl(source)) return tarball.findDefinition(source, chainId, address, selector);
  const entry = tarball.displayFormatEntry("", chainId, address, selector);
  return { entry, found: (await remoteEntry(source, entry)) !== undefined };
}

/** Read one entry ("eth/chain-id/1/network.dat") into memory; undefined when the source lacks it. */
export async function readEntry(source: string, relativeEntry: string): Promise<Buffer | undefined> {
  return isUrl(source) ? remoteEntry(source, relativeEntry) : tarball.readEntry(source, relativeEntry);
}
