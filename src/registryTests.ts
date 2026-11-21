import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Transaction } from "ethers";
import { REGISTRY_REPO_ROOT, REGISTRY_ROOT, type Descriptor } from "./registry.js";

/**
 * The registry's own test cases (registry/<provider>/tests and testsv2) for
 * one function, as transactions a cook can start from. A case belongs to the
 * descriptor when its transaction goes to one of the descriptor's deployments,
 * or when a v2 file names the descriptor outright.
 */

export interface RegistryTestCase {
  /** Relative to the submodule root. */
  file: string;
  description: string;
  txHash?: string;
  /** Absent when the raw transaction has no chain id (pre-EIP-155). */
  chainId?: number;
  to: string;
  from?: string;
  data: string;
  value: bigint;
  gasLimit: bigint;
  gasPrice: bigint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** The recovered sender; undefined when unsigned, or when the signature is a placeholder that recovers nothing. */
function signer(tx: Transaction): string | undefined {
  try {
    return tx.from ?? undefined;
  } catch {
    return undefined;
  }
}

export function findRegistryTests(descriptor: Descriptor, selector: string): RegistryTestCase[] {
  const addresses = new Set(descriptor.deployments.map((d) => d.address.toLowerCase()));
  const found: RegistryTestCase[] = [];
  const seen = new Set<string>();
  // v2 first: when both versions carry a case, its description is the one kept.
  for (const dir of ["testsv2", "tests"]) {
    const testsDir = path.join(REGISTRY_ROOT, descriptor.provider, dir);
    if (!existsSync(testsDir)) continue;
    for (const name of readdirSync(testsDir).filter((n) => n.endsWith(".tests.json")).sort()) {
      const filePath = path.join(testsDir, name);
      const json = readJson(filePath);
      if (!isRecord(json) || !Array.isArray(json.tests)) continue;
      const namesDescriptor =
        typeof json.descriptor === "string" && path.resolve(testsDir, json.descriptor) === descriptor.filePath;
      json.tests.forEach((test, i) => {
        if (!isRecord(test) || typeof test.rawTx !== "string") return;
        const key = test.rawTx.toLowerCase();
        if (seen.has(key)) return;
        let tx: Transaction;
        try {
          tx = Transaction.from(test.rawTx);
        } catch {
          return;
        }
        if (!tx.to || !tx.data.toLowerCase().startsWith(selector.toLowerCase())) return;
        if (!namesDescriptor && !addresses.has(tx.to.toLowerCase())) return;
        seen.add(key);
        found.push({
          file: path.relative(REGISTRY_REPO_ROOT, filePath),
          description: typeof test.description === "string" ? test.description : `test #${i + 1}`,
          txHash: typeof test.txHash === "string" ? test.txHash : undefined,
          chainId: tx.chainId === 0n ? undefined : Number(tx.chainId),
          to: tx.to,
          from: typeof test.from === "string" ? test.from : signer(tx),
          data: tx.data,
          value: tx.value,
          gasLimit: tx.gasLimit,
          gasPrice: tx.gasPrice ?? tx.maxFeePerGas ?? 0n,
        });
      });
    }
  }
  return found;
}
