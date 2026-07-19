import { getAddress, HDNodeWallet, Mnemonic, Transaction } from "ethers";
import type { SampleTx } from "./etherscan.js";
import { explorerTxUrl } from "./explorers.js";
import type { TestWallet } from "./localConfig.js";

const DERIVATION_PATH_TREZORCTL = "m/44h/60h/0h/0/0";
const DERIVATION_PATH_FIXTURE = "m/44'/60'/0'/0/0";

// Fixed legacy-tx fields shared by the fixture parameters and the signature
// computed over them — they must stay in sync or the sigs won't verify.
const FIXTURE_NONCE = 0x0;
const FIXTURE_GAS_PRICE = 0x14;
const FIXTURE_GAS_LIMIT = 0x14;

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

interface FixtureResult {
  sig_v: number;
  sig_r: string;
  sig_s: string;
}

/**
 * Sign the fixture's legacy (EIP-155) transaction with the test wallet at the
 * fixture's derivation path. Returns sig_v as chainId*2+35+yParity and r/s as
 * unprefixed 64-char hex, matching the firmware test suite fixtures.
 */
async function signFixtureTx(tx: SampleTx, chainId: number, wallet: TestWallet): Promise<FixtureResult> {
  const mnemonic = Mnemonic.fromPhrase(wallet.mnemonic, wallet.passphrase);
  const signer = HDNodeWallet.fromMnemonic(mnemonic, DERIVATION_PATH_FIXTURE);
  const serialized = await signer.signTransaction({
    type: 0,
    chainId,
    nonce: FIXTURE_NONCE,
    gasPrice: FIXTURE_GAS_PRICE,
    gasLimit: FIXTURE_GAS_LIMIT,
    to: getAddress(tx.to),
    value: BigInt(tx.value),
    data: "0x" + stripHexPrefix(tx.input),
  });
  const signature = Transaction.from(serialized).signature;
  if (!signature) {
    throw new Error("Signing produced a transaction without a signature");
  }
  return {
    sig_v: chainId * 2 + 35 + signature.yParity,
    sig_r: stripHexPrefix(signature.r),
    sig_s: stripHexPrefix(signature.s),
  };
}

export async function fixtureJson(
  sel: Selection,
  tx: SampleTx,
  chainId: number,
  supported?: boolean,
  wallet?: TestWallet,
): Promise<string> {
  const fixture = {
    name: slug(sel.provider, sel.descriptorName, sel.functionName),
    parameters: {
      comment: `${supported === false ? "unsupported" : "supported"} | ${explorerTxUrl(chainId, tx.hash)}`,
      data: stripHexPrefix(tx.input),
      path: DERIVATION_PATH_FIXTURE,
      to_address: getAddress(tx.to),
      chain_id: chainId,
      nonce: "0x" + FIXTURE_NONCE.toString(16),
      gas_price: "0x" + FIXTURE_GAS_PRICE.toString(16),
      gas_limit: "0x" + FIXTURE_GAS_LIMIT.toString(16),
      tx_type: null,
      value: "0x" + BigInt(tx.value).toString(16),
    },
    result: wallet ? await signFixtureTx(tx, chainId, wallet) : { sig_v: 0, sig_r: "", sig_s: "" },
  };
  return JSON.stringify(fixture, null, 2);
}
