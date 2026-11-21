import { AbiCoder, FunctionFragment, getAddress, toBeHex, type ParamType } from "ethers";

/**
 * A function call's arguments as an editable tree, addressed by the same path
 * keys the clear-signing library uses ("params.amountIn", "path.[0]",
 * "orders.[-1].maker"), so a descriptor field's `path` finds the value it
 * renders. Edits change values in place; encode() re-serializes the call.
 * Array lengths are fixed: an edit never adds or removes elements.
 */

/** A leaf as ethers decodes it: bigint (u)int, checksummed address, boolean, 0x-hex bytes(N), or a string. */
export type AbiValue = bigint | string | boolean;

export interface Leaf {
  /** "params.amounts.[1]" — as the library names it. */
  key: string;
  type: ParamType;
  get(): AbiValue;
  set(value: AbiValue): void;
}

export interface ByteSlice {
  start?: number;
  end?: number;
}

/** What a path points at: a whole leaf, or a byte slice of a bytes leaf (".[0:20]"). */
export interface Cell {
  leaf: Leaf;
  slice?: ByteSlice;
}

export class CellError extends Error {}

/** The library's argumentName(): unnamed components take their parent's name. */
function argumentName(prefix: string | undefined, raw: string): string | undefined {
  const trimmed = raw.trim();
  if (prefix !== undefined) return trimmed.length === 0 ? prefix : `${prefix}.${trimmed}`;
  return trimmed.length === 0 ? undefined : trimmed;
}

function stripRoot(path: string): string {
  return path.startsWith("#.") ? path.slice(2) : path;
}

/** The library's normalizeNegativeIndices(): "[-1]" counts from the end of its array. */
function normalizeNegativeIndices(path: string, lengths: Map<string, number>): string | undefined {
  if (!path.includes("[-")) return path;
  const segments = path.split(".");
  for (let i = 0; i < segments.length; i++) {
    const match = segments[i]!.match(/^\[(-\d+)\]$/);
    if (!match) continue;
    const length = lengths.get(segments.slice(0, i).join("."));
    if (length === undefined) return undefined;
    const index = length + parseInt(match[1]!, 10);
    if (index < 0) return undefined;
    segments[i] = `[${index}]`;
  }
  return segments.join(".");
}

/** The library's parseByteSlice(): a trailing ".[start:end]". */
function parseByteSlice(path: string): { base: string; slice: ByteSlice } | undefined {
  const match = path.match(/^(.+)\.\[(-?\d*):(-?\d*)\]$/);
  if (!match) return undefined;
  return {
    base: match[1]!,
    slice: {
      start: match[2]!.length > 0 ? parseInt(match[2]!, 10) : undefined,
      end: match[3]!.length > 0 ? parseInt(match[3]!, 10) : undefined,
    },
  };
}

/** The library's applyByteSlice() bounds, as [start, end) over `length` bytes. */
function sliceBounds(length: number, slice: ByteSlice): [number, number] {
  let start = slice.start ?? 0;
  let end = slice.end ?? length;
  if (start < 0) start = Math.max(0, length + start);
  if (end < 0) end = Math.max(0, length + end);
  start = Math.min(start, length);
  end = Math.min(end, length);
  return start >= end ? [start, start] : [start, end];
}

export class CalldataTree {
  readonly leaves = new Map<string, Leaf>();
  readonly arrayLengths = new Map<string, number>();

  /**
   * Bytes after the ABI-encoded arguments (some routers append a referral or
   * tracking suffix); kept through edits. Empty when there are none.
   */
  readonly trailing: string;
  /** False when the original arguments weren't canonically encoded, so an edit re-lays them out. */
  readonly canonical: boolean;

  private constructor(
    readonly fragment: FunctionFragment,
    private readonly args: unknown[],
    originalArgs: string,
  ) {
    this.index(fragment.inputs, args, undefined);
    const encoded = this.encodeArgs();
    this.canonical = originalArgs.startsWith(encoded);
    this.trailing = this.canonical ? originalArgs.slice(encoded.length) : "";
  }

  /** undefined when the key isn't a signature or the calldata doesn't decode with it. */
  static decode(functionKey: string, calldata: string): CalldataTree | undefined {
    try {
      const fragment = FunctionFragment.from(functionKey);
      const data = calldata.toLowerCase().startsWith("0x") ? calldata.slice(2) : calldata;
      if (data.slice(0, 8).toLowerCase() !== fragment.selector.slice(2)) return undefined;
      const args = data.slice(8).toLowerCase();
      const decoded = AbiCoder.defaultAbiCoder().decode(fragment.inputs, "0x" + args);
      return new CalldataTree(fragment, decoded.toArray(true), args);
    } catch {
      return undefined;
    }
  }

  /** The call with every edit applied: 0x + selector + arguments (+ any trailing bytes). */
  encode(): string {
    return this.fragment.selector + this.encodeArgs() + this.trailing;
  }

  private encodeArgs(): string {
    return AbiCoder.defaultAbiCoder().encode(this.fragment.inputs, this.args).slice(2);
  }

  /** A descriptor path ("#.a.[0].b", "data.[-20:]") → its cell; undefined when nothing is there. */
  resolve(path: string): Cell | undefined {
    const sliced = parseByteSlice(path);
    const key = normalizeNegativeIndices(stripRoot(sliced ? sliced.base : path), this.arrayLengths);
    const leaf = key === undefined ? undefined : this.leaves.get(key);
    if (!leaf) return undefined;
    return sliced ? { leaf, slice: sliced.slice } : { leaf };
  }

  /** Length of the array at `path` (0 when there is none), as the library's getArrayLength(). */
  arrayLength(path: string): number {
    const key = normalizeNegativeIndices(stripRoot(path), this.arrayLengths);
    return key === undefined ? 0 : (this.arrayLengths.get(key) ?? 0);
  }

  private index(types: readonly ParamType[], container: unknown[], prefix: string | undefined): void {
    types.forEach((type, i) => this.visit(type, container, i, argumentName(prefix, type.name)));
  }

  private visit(type: ParamType, container: unknown[], i: number, name: string | undefined): void {
    if (type.isArray()) {
      const items = container[i] as unknown[];
      if (name !== undefined) this.arrayLengths.set(name, items.length);
      items.forEach((_, j) => this.visit(type.arrayChildren, items, j, argumentName(name, `[${j}]`)));
      return;
    }
    if (type.isTuple()) {
      this.index(type.components, container[i] as unknown[], name);
      return;
    }
    if (name === undefined) return;
    // An unnamed tuple component shares its parent's key; like the library, the last one wins.
    this.leaves.set(name, {
      key: name,
      type,
      get: () => container[i] as AbiValue,
      set: (value) => {
        container[i] = value;
      },
    });
  }
}

// ── Typed reads and writes ──────────────────────────────────────────────────
//
// A cell holds whatever the ABI says; a field's format says how to read it.
// The library reads an address out of a uint, a bytes32 or a 20-byte slice,
// and an amount out of a slice — these mirror that, both ways.

const MAX_UINT160 = (1n << 160n) - 1n;

export type CellShape =
  | { kind: "address" }
  | { kind: "integer"; signed: boolean; bits: number }
  | { kind: "bool" }
  | { kind: "fixedBytes"; size: number }
  | { kind: "bytes" }
  | { kind: "string" };

function hexBody(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/** For a slice, its byte length in the current value. */
export function cellShape(cell: Cell): CellShape {
  const base = cell.leaf.type.baseType;
  if (cell.slice) {
    if (base !== "bytes" && !/^bytes\d+$/.test(cell.leaf.type.type)) {
      throw new CellError(`Byte slices of ${cell.leaf.type.type} can't be edited`);
    }
    const length = hexBody(cell.leaf.get() as string).length / 2;
    const [start, end] = sliceBounds(length, cell.slice);
    return { kind: "fixedBytes", size: end - start };
  }
  const t = cell.leaf.type.type;
  if (base === "address") return { kind: "address" };
  if (base === "bool") return { kind: "bool" };
  if (base === "string") return { kind: "string" };
  if (base === "bytes") return { kind: "bytes" };
  const int = /^(u?)int(\d*)$/.exec(t);
  if (int) return { kind: "integer", signed: int[1] === "", bits: int[2] ? Number(int[2]) : 256 };
  const fixed = /^bytes(\d+)$/.exec(t);
  if (fixed) return { kind: "fixedBytes", size: Number(fixed[1]) };
  throw new CellError(`Unsupported type ${t}`);
}

/** The cell's bytes as 0x-hex (the slice, for a slice). Only for bytes-like cells. */
export function readHex(cell: Cell): string {
  const body = hexBody(cell.leaf.get() as string);
  if (!cell.slice) return "0x" + body;
  const [start, end] = sliceBounds(body.length / 2, cell.slice);
  return "0x" + body.slice(start * 2, end * 2);
}

/** Write bytes; a fixed-size cell (bytesN, a slice) must get exactly its size. */
export function writeHex(cell: Cell, hex: string): void {
  const shape = cellShape(cell);
  const next = hexBody(hex).toLowerCase();
  if (!/^([0-9a-f]{2})*$/.test(next)) throw new CellError(`Not hex bytes: ${hex}`);
  if (shape.kind === "fixedBytes" && next.length / 2 !== shape.size) {
    throw new CellError(`Needs exactly ${shape.size} bytes, got ${next.length / 2}`);
  }
  if (shape.kind !== "fixedBytes" && shape.kind !== "bytes") throw new CellError(`Not a bytes value`);
  if (!cell.slice) {
    cell.leaf.set("0x" + next);
    return;
  }
  const body = hexBody(cell.leaf.get() as string);
  const [start, end] = sliceBounds(body.length / 2, cell.slice);
  cell.leaf.set("0x" + body.slice(0, start * 2) + next + body.slice(end * 2));
}

/** The address a cell renders as, or undefined when it can't hold one. */
export function readAddress(cell: Cell): string | undefined {
  const shape = cellShape(cell);
  if (shape.kind === "address") return cell.leaf.get() as string;
  if (shape.kind === "integer") {
    const v = cell.leaf.get() as bigint;
    return v >= 0n && v <= MAX_UINT160 ? getAddress(toBeHex(v, 20)) : undefined;
  }
  if (shape.kind === "fixedBytes" || shape.kind === "bytes") {
    // The library takes the last 20 bytes of anything longer.
    const body = hexBody(readHex(cell));
    return body.length >= 40 ? getAddress("0x" + body.slice(-40)) : undefined;
  }
  return undefined;
}

export function writeAddress(cell: Cell, address: string): void {
  const shape = cellShape(cell);
  const checksummed = getAddress(address);
  if (shape.kind === "address") return cell.leaf.set(checksummed);
  if (shape.kind === "integer") {
    if (shape.bits < 160) throw new CellError(`${cell.leaf.type.type} is too narrow for an address`);
    return cell.leaf.set(BigInt(checksummed));
  }
  if (shape.kind === "fixedBytes") {
    if (shape.size < 20) throw new CellError(`${shape.size} bytes is too short for an address`);
    // Left-padded, so the address is the last 20 bytes as the library reads it.
    return writeHex(cell, "0x" + "00".repeat(shape.size - 20) + hexBody(checksummed));
  }
  if (shape.kind === "bytes") return writeHex(cell, checksummed);
  throw new CellError(`A ${cell.leaf.type.type} can't hold an address`);
}

/** The integer a cell renders as (bytes read big-endian, unsigned). */
export function readInteger(cell: Cell): bigint | undefined {
  const shape = cellShape(cell);
  if (shape.kind === "integer") return cell.leaf.get() as bigint;
  if (shape.kind === "address") return BigInt(cell.leaf.get() as string);
  if (shape.kind === "bool") return cell.leaf.get() ? 1n : 0n;
  if (shape.kind === "fixedBytes" || shape.kind === "bytes") {
    const body = hexBody(readHex(cell));
    return body.length === 0 ? 0n : BigInt("0x" + body);
  }
  return undefined;
}

/** Inclusive bounds of what a cell can hold as an integer. */
export function integerRange(cell: Cell): [bigint, bigint] {
  const shape = cellShape(cell);
  if (shape.kind === "integer") {
    return shape.signed
      ? [-(1n << BigInt(shape.bits - 1)), (1n << BigInt(shape.bits - 1)) - 1n]
      : [0n, (1n << BigInt(shape.bits)) - 1n];
  }
  if (shape.kind === "fixedBytes") return [0n, (1n << BigInt(shape.size * 8)) - 1n];
  if (shape.kind === "address") return [0n, MAX_UINT160];
  if (shape.kind === "bool") return [0n, 1n];
  if (shape.kind === "bytes") return [0n, (1n << 256n) - 1n];
  throw new CellError(`A ${cell.leaf.type.type} can't hold an integer`);
}

export function writeInteger(cell: Cell, value: bigint): void {
  const [min, max] = integerRange(cell);
  if (value < min || value > max) throw new CellError(`${value} is out of range for ${cell.leaf.type.type}`);
  const shape = cellShape(cell);
  if (shape.kind === "integer") return cell.leaf.set(value);
  if (shape.kind === "address") return cell.leaf.set(getAddress(toBeHex(value, 20)));
  if (shape.kind === "bool") return cell.leaf.set(value === 1n);
  if (shape.kind === "fixedBytes") return writeHex(cell, toBeHex(value, shape.size));
  if (shape.kind === "bytes") return writeHex(cell, toBeHex(value, 32));
}

/** How a cell's current value reads when shown raw. */
export function describeCell(cell: Cell): string {
  const shape = cellShape(cell);
  if (shape.kind === "fixedBytes" || shape.kind === "bytes") return readHex(cell);
  return String(cell.leaf.get());
}
