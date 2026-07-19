import { etherscanApiKey } from "./localConfig.js";

export interface SampleTx {
  hash: string;
  to: string;
  input: string;
  /** Value in wei, decimal string */
  value: string;
  blockNumber: string;
  timeStamp: string;
}

interface EtherscanTx extends SampleTx {
  isError?: string;
}

interface EtherscanResponse {
  status: string;
  message: string;
  result: unknown;
}

export class EtherscanError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEtherscanResponse(value: unknown): value is EtherscanResponse {
  return isRecord(value) && typeof value.status === "string" && typeof value.message === "string";
}

function isEtherscanTx(value: unknown): value is EtherscanTx {
  if (!isRecord(value)) return false;
  const stringFields = ["hash", "to", "input", "value", "blockNumber", "timeStamp"] as const;
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

async function fetchTxList(chainId: number, address: string): Promise<EtherscanTx[]> {
  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=txlist` +
    `&address=${address}&startblock=0&endblock=latest&sort=desc&page=1&offset=200&apikey=${apiKey()}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new EtherscanError(`Etherscan HTTP ${res.status}`);
  }
  const body: unknown = await res.json();
  if (!isEtherscanResponse(body)) {
    throw new EtherscanError("Etherscan returned an unexpected response shape");
  }

  if (body.status !== "1") {
    if (typeof body.result === "string" || /no transactions/i.test(body.message)) {
      const detail = typeof body.result === "string" ? body.result : body.message;
      if (/no transactions/i.test(detail) || /no transactions/i.test(body.message)) {
        return [];
      }
      throw new EtherscanError(`Etherscan error: ${body.message} (${detail})`);
    }
    throw new EtherscanError(`Etherscan error: ${body.message}`);
  }
  if (!Array.isArray(body.result)) {
    throw new EtherscanError("Etherscan returned an unexpected result shape");
  }
  return body.result.filter(isEtherscanTx);
}

/**
 * Find the most recent successful transaction to `address` on `chainId` whose
 * calldata starts with `selector`. Searches the last 200 transactions.
 * Returns null when nothing matches.
 */
export async function findSampleTx(chainId: number, address: string, selector: string): Promise<SampleTx | null> {
  let txs: EtherscanTx[];
  try {
    txs = await fetchTxList(chainId, address);
  } catch (err) {
    if (err instanceof EtherscanError && /rate limit/i.test(err.message)) {
      await new Promise((r) => setTimeout(r, 1200));
      txs = await fetchTxList(chainId, address);
    } else {
      throw err;
    }
  }

  const wantTo = address.toLowerCase();
  const wantPrefix = selector.toLowerCase();
  for (const tx of txs) {
    if (
      tx.isError !== "1" &&
      tx.to?.toLowerCase() === wantTo &&
      tx.input?.toLowerCase().startsWith(wantPrefix)
    ) {
      return { hash: tx.hash, to: tx.to, input: tx.input, value: tx.value, blockNumber: tx.blockNumber, timeStamp: tx.timeStamp };
    }
  }
  return null;
}
