import { getAddress } from "ethers";
import type { SampleTx } from "./etherscan.js";
import { explorerTxUrl } from "./explorers.js";

const DERIVATION_PATH_TREZORCTL = "m/44h/60h/0h/0/0";
const DERIVATION_PATH_FIXTURE = "m/44'/60'/0'/0/0";

export interface Selection {
  provider: string;
  descriptorName: string;
  functionName: string;
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

export function slug(...parts: string[]): string {
  return parts
    .join("_")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function trezorctlCommand(tx: SampleTx, chainId: number, definitionsPath?: string): string {
  const definitions = definitionsPath ? `--definitions ${definitionsPath} ` : "";
  return (
    `trezorctl ethereum ${definitions}sign-tx ` +
    `--chain-id ${chainId} ` +
    `--address "${DERIVATION_PATH_TREZORCTL}" ` +
    `--data ${stripHexPrefix(tx.input)} ` +
    `--gas-limit 333333 --gas-price 22 --nonce 0 ` +
    `${getAddress(tx.to)} ${tx.value}`
  );
}

export function fixtureJson(sel: Selection, tx: SampleTx, chainId: number): string {
  const fixture = {
    name: slug(sel.provider, sel.descriptorName, sel.functionName),
    parameters: {
      comment: `supported | ${explorerTxUrl(chainId, tx.hash)}`,
      data: stripHexPrefix(tx.input),
      path: DERIVATION_PATH_FIXTURE,
      to_address: getAddress(tx.to),
      chain_id: chainId,
      nonce: "0x0",
      gas_price: "0x14",
      gas_limit: "0x14",
      tx_type: null,
      value: "0x" + BigInt(tx.value).toString(16),
    },
    result: {
      sig_v: 0,
      sig_r: "",
      sig_s: "",
    },
  };
  return JSON.stringify(fixture, null, 2);
}
