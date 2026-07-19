import { FunctionFragment } from "ethers";

export interface ParsedFormatKey {
  /** 4-byte selector, 0x-prefixed lowercase hex */
  selector: string;
  /** Function name, or the selector hex itself for 0x-keyed formats */
  name: string;
  /** Full human-readable signature, when the key is a signature */
  signature?: string;
}

const SELECTOR_KEY = /^0x[0-9a-fA-F]{8}$/;

/**
 * Parse a `display.formats` key from an ERC-7730 descriptor. Keys are either
 * a full function signature (with parameter names and named tuples) or a raw
 * 4-byte selector.
 */
export function parseFormatKey(key: string): ParsedFormatKey {
  if (SELECTOR_KEY.test(key)) {
    return { selector: key.toLowerCase(), name: key.toLowerCase() };
  }
  const fragment = FunctionFragment.from(key);
  return { selector: fragment.selector, name: fragment.name, signature: key };
}
