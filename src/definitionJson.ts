import { definitionPayload } from "./definitions.js";

/**
 * Signed definition (.dat) → the JSON fixture format trezor-firmware's device
 * tests read (common/tests/fixtures/ethereum/definitions, trezor-firmware#8001):
 *
 *   { "data_type": "ETHEREUM_DISPLAY_FORMAT", "message": { …protobuf fields… } }
 *
 * A port of `dat_to_dict` from tools/snippets/eth_defs_refresh_json.py
 * (trezor-firmware#8002) — trezorlib's `load_message` + `to_dict`, then
 * `json.dumps(indent=2)` — so the output is byte-identical to what that script
 * writes. Unlike it, the signature is not verified: the tests re-sign every
 * definition with the dev key anyway, and trezorlib rejects the dev deploy's
 * blobs even with `--dev`.
 *
 * Schemas follow common/protob/messages-definitions.proto. Fields are listed in
 * declaration order, which is trezorlib's FIELDS order and hence the key order
 * of `to_dict` — not tag order (`threshold_message` = 13 precedes `decimals` = 6).
 */

export class DefinitionDecodeError extends Error {}

type Kind =
  | "uint"
  | "sint"
  | "bool"
  | "bytes"
  | "string"
  | { enum: Record<number, string> }
  | { message: () => Schema };

interface Field {
  tag: number;
  name: string;
  kind: Kind;
  repeated?: boolean;
  required?: boolean;
}

type Schema = Field[];

const DEFINITION_TYPE: Record<number, string> = {
  0: "ETHEREUM_NETWORK",
  1: "ETHEREUM_TOKEN",
  2: "SOLANA_TOKEN",
  3: "ETHEREUM_DISPLAY_FORMAT",
};

const ABI_TYPE: Record<number, string> = {
  0: "ABI_ADDRESS",
  1: "ABI_UINT256",
  2: "ABI_UINT248",
  3: "ABI_UINT160",
  4: "ABI_UINT128",
  5: "ABI_UINT120",
  6: "ABI_UINT112",
  7: "ABI_UINT96",
  8: "ABI_UINT72",
  9: "ABI_UINT64",
  10: "ABI_UINT48",
  11: "ABI_UINT40",
  12: "ABI_UINT32",
  13: "ABI_UINT24",
  14: "ABI_UINT16",
  15: "ABI_UINT8",
  16: "ABI_BOOL",
  17: "ABI_INT160",
  20: "ABI_BYTES32",
  21: "ABI_BYTES16",
  22: "ABI_BYTES8",
  23: "ABI_BYTES4",
  24: "ABI_BYTES20",
  30: "ABI_BYTES",
  31: "ABI_STRING",
};

const FORMATTER_TYPE: Record<number, string> = {
  0: "FORMATTER_ADDRESS_NAME",
  1: "FORMATTER_AMOUNT",
  2: "FORMATTER_TOKEN_AMOUNT",
  3: "FORMATTER_UNIT",
  4: "FORMATTER_RAW",
  5: "FORMATTER_DATE",
  6: "FORMATTER_CALLDATA",
  7: "FORMATTER_ENUM",
  8: "FORMATTER_DURATION",
};

const CONTAINER_PATH: Record<number, string> = { 1: "FROM", 2: "VALUE", 3: "TO" };

const ETHEREUM_NETWORK_INFO: Schema = [
  { tag: 1, name: "chain_id", kind: "uint", required: true },
  { tag: 2, name: "symbol", kind: "string", required: true },
  { tag: 3, name: "slip44", kind: "uint", required: true },
  { tag: 4, name: "name", kind: "string", required: true },
];

const ETHEREUM_TOKEN_INFO: Schema = [
  { tag: 1, name: "address", kind: "bytes", required: true },
  { tag: 2, name: "chain_id", kind: "uint", required: true },
  { tag: 3, name: "symbol", kind: "string", required: true },
  { tag: 4, name: "decimals", kind: "uint", required: true },
  { tag: 5, name: "name", kind: "string", required: true },
];

const SOLANA_TOKEN_INFO: Schema = [
  { tag: 1, name: "mint", kind: "bytes", required: true },
  { tag: 2, name: "symbol", kind: "string", required: true },
  { tag: 3, name: "name", kind: "string", required: true },
];

const ABI_VALUE_INFO: Schema = [
  { tag: 1, name: "atomic", kind: { enum: ABI_TYPE } },
  { tag: 2, name: "dynamic", kind: { enum: ABI_TYPE } },
  { tag: 3, name: "tuple", kind: { message: () => ABI_TUPLE_INFO } },
  { tag: 4, name: "array", kind: { message: () => ABI_VALUE_INFO } },
];

const ABI_TUPLE_INFO: Schema = [
  { tag: 1, name: "fields", kind: { message: () => ABI_VALUE_INFO }, repeated: true },
  { tag: 2, name: "is_dynamic", kind: "bool", required: true },
];

const ERC7730_PATH: Schema = [
  { tag: 1, name: "path", kind: "sint", repeated: true },
  { tag: 2, name: "container_path", kind: { enum: CONTAINER_PATH } },
  { tag: 3, name: "const_value", kind: "string" },
  { tag: 4, name: "slice_start", kind: "sint" },
  { tag: 5, name: "slice_end", kind: "sint" },
];

const ERC7730_ENUM_ENTRY: Schema = [
  { tag: 1, name: "key", kind: "uint", required: true },
  { tag: 2, name: "value", kind: "string", required: true },
];

const ERC7730_FIELD_INFO: Schema = [
  { tag: 1, name: "path", kind: { message: () => ERC7730_PATH }, required: true },
  { tag: 2, name: "label", kind: "string", required: true },
  { tag: 3, name: "formatter", kind: { enum: FORMATTER_TYPE }, required: true },
  { tag: 4, name: "token_path", kind: { message: () => ERC7730_PATH } },
  { tag: 5, name: "threshold", kind: "bytes" },
  { tag: 13, name: "threshold_message", kind: "string" },
  { tag: 14, name: "native_currency_address", kind: "bytes", repeated: true },
  { tag: 6, name: "decimals", kind: "uint" },
  { tag: 7, name: "base", kind: "string" },
  { tag: 8, name: "prefix", kind: "bool" },
  { tag: 9, name: "const_token_address", kind: "bytes" },
  { tag: 10, name: "callee_path", kind: { message: () => ERC7730_PATH } },
  { tag: 11, name: "selector", kind: "bytes" },
  { tag: 12, name: "enum_values", kind: { message: () => ERC7730_ENUM_ENTRY }, repeated: true },
];

const ETHEREUM_DISPLAY_FORMAT_INFO: Schema = [
  { tag: 1, name: "chain_id", kind: "uint", required: true },
  { tag: 2, name: "address", kind: "bytes", required: true },
  { tag: 3, name: "func_sig", kind: "bytes", required: true },
  { tag: 4, name: "intent", kind: "string", required: true },
  { tag: 5, name: "parameter_definitions", kind: { message: () => ABI_VALUE_INFO }, repeated: true },
  { tag: 6, name: "field_definitions", kind: { message: () => ERC7730_FIELD_INFO }, repeated: true },
  { tag: 7, name: "provider_name", kind: "string" },
];

const MESSAGE_TYPES: Record<number, Schema> = {
  0: ETHEREUM_NETWORK_INFO,
  1: ETHEREUM_TOKEN_INFO,
  2: SOLANA_TOKEN_INFO,
  3: ETHEREUM_DISPLAY_FORMAT_INFO,
};

const WIRE_VARINT = 0;
const WIRE_LENGTH = 2;

const utf8 = new TextDecoder("utf-8", { fatal: true });

class Reader {
  offset = 0;
  constructor(private readonly buf: Buffer) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  varint(): bigint {
    let value = 0n;
    let shift = 0n;
    while (this.offset < this.buf.length) {
      const byte = this.buf[this.offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
    throw new DefinitionDecodeError("truncated varint");
  }

  bytes(): Buffer {
    const length = Number(this.varint());
    const end = this.offset + length;
    if (end > this.buf.length) throw new DefinitionDecodeError("truncated field");
    const out = this.buf.subarray(this.offset, end);
    this.offset = end;
    return out;
  }
}

function wireType(kind: Kind): number {
  return kind === "bytes" || kind === "string" || (typeof kind === "object" && "message" in kind)
    ? WIRE_LENGTH
    : WIRE_VARINT;
}

function toNumber(value: bigint, field: Field): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DefinitionDecodeError(`Field ${field.name} value ${value} is too large`);
  }
  return Number(value);
}

/** decode_varint_field: unknown enum values stay numbers, as trezorlib keeps the raw int. */
function varintValue(field: Field, value: bigint): unknown {
  const { kind } = field;
  if (kind === "bool") return value !== 0n;
  if (kind === "sint") return toNumber((value >> 1n) ^ -(value & 1n), field);
  if (typeof kind === "object" && "enum" in kind) return kind.enum[toNumber(value, field)] ?? toNumber(value, field);
  return toNumber(value, field);
}

/** decode_length_delimited_field, with bytes already hexlified as to_dict does. */
function lengthValue(field: Field, data: Buffer): unknown {
  const { kind } = field;
  if (kind === "bytes") return data.toString("hex");
  if (kind === "string") {
    try {
      return utf8.decode(data);
    } catch {
      throw new DefinitionDecodeError(`Field ${field.name} is not valid UTF-8`);
    }
  }
  if (typeof kind === "object" && "message" in kind) return decodeMessage(data, kind.message());
  throw new DefinitionDecodeError(`Field ${field.name} is not length-delimited`);
}

/** trezorlib's load_message followed by to_dict: unset fields and empty repeated fields are left out. */
function decodeMessage(buf: Buffer, schema: Schema): Record<string, unknown> {
  const values = new Map<string, unknown[]>();
  const reader = new Reader(buf);
  while (!reader.done) {
    const key = reader.varint();
    const tag = Number(key >> 3n);
    const wt = Number(key & 7n);
    const field = schema.find((f) => f.tag === tag);

    if (!field) {
      if (wt === WIRE_VARINT) reader.varint();
      else if (wt === WIRE_LENGTH) reader.bytes();
      else throw new DefinitionDecodeError(`Unknown field ${tag} has unsupported wire type ${wt}`);
      continue;
    }

    let decoded: unknown[];
    if (wt === WIRE_LENGTH && wireType(field.kind) === WIRE_VARINT && field.repeated) {
      const packed = new Reader(reader.bytes());
      decoded = [];
      while (!packed.done) decoded.push(varintValue(field, packed.varint()));
    } else if (wt !== wireType(field.kind)) {
      throw new DefinitionDecodeError(`Field ${field.name} received value does not match schema`);
    } else if (wt === WIRE_LENGTH) {
      decoded = [lengthValue(field, reader.bytes())];
    } else {
      decoded = [varintValue(field, reader.varint())];
    }

    if (field.repeated) {
      values.set(field.name, [...(values.get(field.name) ?? []), ...decoded]);
    } else if (decoded.length !== 1) {
      throw new DefinitionDecodeError("Unexpected multiple values in non-repeating field");
    } else {
      values.set(field.name, decoded);
    }
  }

  const out: Record<string, unknown> = {};
  for (const field of schema) {
    const value = values.get(field.name);
    if (value === undefined) {
      if (field.required) throw new DefinitionDecodeError(`Did not receive value for field ${field.name}`);
      continue;
    }
    if (field.repeated) {
      if (value.length > 0) out[field.name] = value;
    } else {
      out[field.name] = value[0];
    }
  }
  return out;
}

/** The `dat_to_dict` result: definition type name plus the decoded message. */
export function definitionToDict(blob: Buffer): { data_type: string; message: Record<string, unknown> } {
  const payload = definitionPayload(blob);
  if (!payload) throw new DefinitionDecodeError("not a Trezor definition (bad magic or truncated header)");
  const dataType = DEFINITION_TYPE[payload.type];
  const schema = MESSAGE_TYPES[payload.type];
  if (dataType === undefined || schema === undefined) {
    throw new DefinitionDecodeError(`unknown definition type ${payload.type}`);
  }
  return { data_type: dataType, message: decodeMessage(payload.data, schema) };
}

/**
 * `json.dumps(…, indent=2) + "\n"`. JSON.stringify already escapes control
 * characters the way Python does; ensure_ascii additionally escapes DEL and
 * everything non-ASCII (per UTF-16 code unit, as Python does for astral chars).
 */
export function definitionToJson(blob: Buffer): string {
  const text = JSON.stringify(definitionToDict(blob), null, 2);
  return text.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
}
