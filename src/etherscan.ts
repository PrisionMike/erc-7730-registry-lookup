import { blockscoutApiKey, etherscanApiKey } from "./localConfig.js";

export interface SampleTx {
  hash: string;
  to: string;
  input: string;
  /** Value in wei, decimal string */
  value: string;
  blockNumber: string;
  timeStamp: string;
  /** Gas limit of the original tx, decimal string */
  gas: string;
  /** Gas price in wei (effective price for EIP-1559 txs), decimal string */
  gasPrice: string;
}

interface EtherscanTx extends SampleTx {
  isError?: string;
}

interface EtherscanResponse {
  status: string;
  message: string;
  result: unknown;
}

export class EtherscanError extends Error {
  constructor(
    message: string,
    /** Transient errors (rate limits, outages, network hiccups) are worth retrying. */
    readonly transient = false,
  ) {
    super(message);
  }
}

/** Keep retrying transient errors until this much time has passed since the first attempt. */
const RETRY_WINDOW_MS = 60_000;
const RETRY_DELAY_MS = 2_000;

const PAGE_SIZE = 1_000;
/** Etherscan's paging window caps page × offset at 10,000 — the deepest we can search. */
export const MAX_SEARCH_DEPTH = 10_000;

/**
 * Explorer providers we can query for transaction history. All expose an
 * Etherscan-compatible schema, so we only need to swap URLs.
 */
type Provider = "etherscan" | "routescan" | "blockscout";

function providerLabel(p: Provider): string {
  return p === "routescan" ? "Routescan" : p === "blockscout" ? "Blockscout" : "Etherscan";
}

/**
 * Keyless Blockscout instances (host plus any path prefix before `/api`), used
 * for chains Etherscan V2 doesn't serve at all or only serves on paid plans
 * (Optimism, Base, Gnosis on the free tier). Bitlayer's btrscan isn't Blockscout
 * but speaks the same Etherscan-compatible dialect, so it lives here too.
 */
const BLOCKSCOUT_HOSTS: Record<number, string> = {
  1: "eth.blockscout.com",
  10: "explorer.optimism.io",
  14: "flare-explorer.flare.network",
  19: "songbird-explorer.flare.network",
  30: "rootstock.blockscout.com",
  100: "gnosis.blockscout.com",
  137: "polygon.blockscout.com",
  223: "backend-blockscout.bsquared.network",
  324: "zksync.blockscout.com",
  4200: "scan.merlinchain.io",
  8453: "base.blockscout.com",
  42161: "arbitrum.blockscout.com",
  42220: "celo.blockscout.com",
  200901: "api.btrscan.com/scan",
  534352: "scroll.blockscout.com",
};

/**
 * Chains served by the Blockscout PRO API (api.blockscout.com/<chainId>). With a
 * key we use it instead of the per-chain host: keyless hosts can allow as few as
 * 10 requests per ~hour, the key 5 per second. The rest run their own explorers.
 */
const BLOCKSCOUT_PRO_CHAINS = new Set([1, 10, 30, 100, 137, 324, 8453, 42161, 42220, 534352]);

/** Chains Etherscan V2 doesn't list at all — skip the pointless first request. */
const NOT_ON_ETHERSCAN = new Set([14, 19, 30, 223, 324, 4200, 200901, 534352]);

/**
 * Avalanche's free Etherscan-V2 tier is unreliable, so route it straight to
 * Routescan. Chains Etherscan doesn't know go straight to Blockscout.
 * Everything else tries Etherscan first, then Blockscout (when we know an
 * instance), then Routescan, whenever a request gives up (rate limit, missing
 * key, paid-only chain, …).
 */
function providersForChain(chainId: number): Provider[] {
  if (chainId === 43114) return ["routescan"];
  if (NOT_ON_ETHERSCAN.has(chainId)) return ["blockscout"];
  const providers: Provider[] = ["etherscan"];
  if (BLOCKSCOUT_HOSTS[chainId]) providers.push("blockscout");
  providers.push("routescan");
  return providers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEtherscanResponse(value: unknown): value is EtherscanResponse {
  return isRecord(value) && typeof value.status === "string" && typeof value.message === "string";
}

/** btrscan sends `status` as a number; normalise it so the rest of the parser sees a string. */
function normaliseStatus(value: unknown): unknown {
  return isRecord(value) && typeof value.status === "number" ? { ...value, status: String(value.status) } : value;
}

function isEtherscanTx(value: unknown): value is EtherscanTx {
  if (!isRecord(value)) return false;
  const stringFields = ["hash", "to", "input", "value", "blockNumber", "timeStamp", "gas", "gasPrice"] as const;
  return (
    stringFields.every((f) => typeof value[f] === "string") &&
    (typeof value.isError === "string" || value.isError === undefined)
  );
}

export function apiKey(): string {
  const key = etherscanApiKey();
  if (!key) {
    throw new EtherscanError(
      "No Etherscan API key configured. Copy config.local.example.json to config.local.json and fill " +
        "in etherscanApiKey, or set the ETHERSCAN_API_KEY environment variable.",
    );
  }
  return key;
}

interface TxPage {
  txs: EtherscanTx[];
  /** Whether the page was full, i.e. older transactions may exist. */
  hasMore: boolean;
}

function providerUrl(provider: Provider, chainId: number, address: string, page: number): string {
  // Numeric endblock instead of `latest`: Routescan's Etherscan-compat layer rejects the sentinel.
  // It must exceed any real block height — Blockscout honours it, and L2s are past 100M blocks —
  // but fit in an int32: Merlin's explorer errors on anything larger.
  const query =
    `module=account&action=txlist&address=${address}` +
    `&startblock=0&endblock=2147483647&sort=desc&page=${page}&offset=${PAGE_SIZE}`;
  if (provider === "blockscout") {
    const key = blockscoutApiKey();
    if (key && BLOCKSCOUT_PRO_CHAINS.has(chainId)) {
      return `https://api.blockscout.com/${chainId}/api?${query}&apikey=${key}`;
    }
    const host = BLOCKSCOUT_HOSTS[chainId];
    if (!host) throw new EtherscanError(`No Blockscout instance known for chainId ${chainId}`);
    return `https://${host}/api?${query}`;
  }
  if (provider === "routescan") {
    // Routescan speaks the Etherscan API on `.../etherscan/api` and doesn't require a key.
    return `https://api.routescan.io/v2/network/mainnet/evm/${chainId}/etherscan/api?${query}`;
  }
  return `https://api.etherscan.io/v2/api?chainid=${chainId}&${query}&apikey=${apiKey()}`;
}

async function fetchTxPage(
  provider: Provider,
  chainId: number,
  address: string,
  page: number,
): Promise<TxPage> {
  const label = providerLabel(provider);
  const url = providerUrl(provider, chainId, address, page);

  let res: Response;
  let body: unknown;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      throw new EtherscanError(`${label} HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    }
    body = normaliseStatus(await res.json());
  } catch (err) {
    if (err instanceof EtherscanError) throw err;
    // fetch/json throw on network failures, timeouts, and truncated bodies — all transient.
    throw new EtherscanError(
      `${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
      true,
    );
  }
  if (!isEtherscanResponse(body)) {
    throw new EtherscanError(`${label} returned an unexpected response shape`);
  }

  if (body.status !== "1") {
    if (typeof body.result === "string" || /no transactions/i.test(body.message)) {
      const detail = typeof body.result === "string" ? body.result : body.message;
      if (/no transactions/i.test(detail) || /no transactions/i.test(body.message)) {
        return { txs: [], hasMore: false };
      }
      throw new EtherscanError(
        `${label} error: ${body.message} (${detail})`,
        /rate limit|max calls/i.test(detail),
      );
    }
    throw new EtherscanError(
      `${label} error: ${body.message}`,
      /rate limit|max calls/i.test(body.message),
    );
  }
  if (!Array.isArray(body.result)) {
    throw new EtherscanError(`${label} returned an unexpected result shape`);
  }
  return { txs: body.result.filter(isEtherscanTx), hasMore: body.result.length === PAGE_SIZE };
}

/** Fetch one page from a single provider, retrying transient errors for up to RETRY_WINDOW_MS. */
async function fetchTxPageWithRetry(
  provider: Provider,
  chainId: number,
  address: string,
  page: number,
): Promise<TxPage> {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchTxPage(provider, chainId, address, page);
    } catch (err) {
      if (!(err instanceof EtherscanError) || !err.transient || Date.now() + RETRY_DELAY_MS >= deadline) {
        throw err;
      }
      console.log(`\x1b[2m${err.message} — retrying (attempt ${attempt})…\x1b[0m`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

/**
 * Fetch one page, trying each configured provider in order. Falls back to the
 * next provider when the current one gives up (missing API key, non-transient
 * error, or transient retries exhausted).
 */
async function fetchTxPageWithFallback(
  providers: Provider[],
  chainId: number,
  address: string,
  page: number,
): Promise<TxPage & { provider: Provider }> {
  let lastErr: unknown = new EtherscanError("No explorer providers configured");
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    try {
      return { ...(await fetchTxPageWithRetry(provider, chainId, address, page)), provider };
    } catch (err) {
      lastErr = err;
      const next = providers[i + 1];
      if (next) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`\x1b[2m${msg} — falling back to ${providerLabel(next)}…\x1b[0m`);
      }
    }
  }
  throw lastErr;
}

/**
 * Find the most recent successful transaction to `address` on `chainId` whose
 * calldata starts with `selector`. Pages backwards through the contract's
 * history, up to MAX_SEARCH_DEPTH transactions (Etherscan's paging limit).
 * Returns null when nothing matches.
 *
 * Each page is fetched via the chain's provider chain (see providersForChain).
 * Transient failures are retried for up to a minute per provider before falling
 * back or giving up.
 */
export async function findSampleTx(chainId: number, address: string, selector: string): Promise<SampleTx | null> {
  const wantTo = address.toLowerCase();
  const wantPrefix = selector.toLowerCase();

  let providers = providersForChain(chainId);
  for (let page = 1; page * PAGE_SIZE <= MAX_SEARCH_DEPTH; page++) {
    const { txs, hasMore, provider } = await fetchTxPageWithFallback(providers, chainId, address, page);
    // Stick with whichever provider answered, so later pages don't re-ask one that already refused.
    providers = providers.slice(providers.indexOf(provider));
    for (const tx of txs) {
      if (
        tx.isError !== "1" &&
        tx.to?.toLowerCase() === wantTo &&
        tx.input?.toLowerCase().startsWith(wantPrefix)
      ) {
        return {
          hash: tx.hash,
          to: tx.to,
          input: tx.input,
          value: tx.value,
          blockNumber: tx.blockNumber,
          timeStamp: tx.timeStamp,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
        };
      }
    }
    if (!hasMore) return null;
    if (page * PAGE_SIZE < MAX_SEARCH_DEPTH) {
      console.log(`\x1b[2mNo match in the ${page * PAGE_SIZE} most recent txs — searching further back…\x1b[0m`);
    }
  }
  return null;
}
