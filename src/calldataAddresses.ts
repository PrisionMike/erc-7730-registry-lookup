import { AbiCoder, FunctionFragment, getAddress, type ParamType } from "ethers";

/**
 * Every address a transaction's calldata carries, so a fixture can bring the
 * definitions the device may ask for when it shows them: a token's metadata,
 * a contract's name.
 *
 * With the function's signature (a registry format key) the arguments are
 * decoded and the address-typed ones taken, however deeply nested. A `bytes`
 * argument (a multicall leg, a Safe's inner call) has no ABI here, so it is
 * scanned word by word instead — as is the whole calldata when the signature
 * can't be parsed or doesn't decode it.
 */

const ZERO_WORD_PREFIX = "0".repeat(24);
/**
 * A word passes for an address when its top 12 bytes are zero and its top 6
 * address bytes aren't — i.e. it is ≥ 2^112, above any plausible amount or
 * count, while vanity addresses with a few leading zero bytes (Permit2 is
 * 0x000000000022d4…) still pass.
 */
const ZERO_ADDRESS_HEAD = "0".repeat(12);

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function scanWords(hex: string, start: number, into: Set<string>): void {
  for (let i = start; i + 64 <= hex.length; i += 64) {
    const word = hex.slice(i, i + 64);
    if (word.startsWith(ZERO_WORD_PREFIX) && word.slice(24, 36) !== ZERO_ADDRESS_HEAD) {
      into.add(getAddress("0x" + word.slice(24)));
    }
  }
}

/** Nested calldata starts with a 4-byte selector, which shifts its words by 8 hex chars. */
function scanBytes(hex: string, into: Set<string>): void {
  scanWords(hex, hex.length % 64 === 8 ? 8 : 0, into);
}

function walk(type: ParamType, value: unknown, into: Set<string>): void {
  if (type.isArray()) {
    for (const item of value as unknown[]) walk(type.arrayChildren, item, into);
  } else if (type.isTuple()) {
    type.components.forEach((component, i) => walk(component, (value as unknown[])[i], into));
  } else if (type.baseType === "address") {
    if (BigInt(value as string) !== 0n) into.add(getAddress(value as string));
  } else if (type.baseType === "bytes") {
    scanBytes(strip0x(value as string), into);
  }
}

function decodeArguments(functionKey: string, data: string): [ParamType[], unknown[]] | undefined {
  try {
    const fragment = FunctionFragment.from(functionKey);
    if (fragment.selector.slice(2) !== data.slice(0, 8).toLowerCase()) return undefined;
    return [[...fragment.inputs], [...AbiCoder.defaultAbiCoder().decode(fragment.inputs, "0x" + data.slice(8))]];
  } catch {
    return undefined;
  }
}

/** Checksummed and in order of appearance, without duplicates or the zero address. */
export function calldataAddresses(calldata: string, functionKey?: string): string[] {
  const data = strip0x(calldata);
  const found = new Set<string>();
  const decoded = functionKey ? decodeArguments(functionKey, data) : undefined;
  if (decoded) {
    const [types, values] = decoded;
    types.forEach((type, i) => walk(type, values[i], found));
  } else {
    scanWords(data, 8, found);
  }
  return [...found];
}
