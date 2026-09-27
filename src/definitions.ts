import { readEntry } from "./tarball.js";

/**
 * Token and network metadata from the Trezor definitions tarball — the same
 * signed blobs the device is handed, so a parse shows the symbols and decimals
 * the device will, and "unknown token" exactly where the device has none.
 *
 * Blob layout: magic "trzdN" (5) · type (1) · data version (4, LE) ·
 * payload length (2, LE) · protobuf payload · Merkle proof · signature.
 */

const HEADER_LENGTH = 12;
const TYPE_NETWORK = 0;
const TYPE_TOKEN = 1;

export interface TokenDefinition {
  symbol: string;
  decimals: number;
  name: string;
}

export interface NetworkDefinition {
  symbol: string;
  name: string;
}

type ProtoFields = Map<number, bigint | Buffer>;

function readVarint(buf: Buffer, offset: number): { value: bigint; next: number } {
  let value = 0n;
  let shift = 0n;
  for (let i = offset; i < buf.length; i++) {
    const byte = buf[i]!;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
    shift += 7n;
  }
  throw new Error("truncated varint");
}

/** Flat decode of one protobuf message: field number → varint or bytes. */
function decodeProto(buf: Buffer): ProtoFields {
  const fields: ProtoFields = new Map();
  let offset = 0;
  while (offset < buf.length) {
    const key = readVarint(buf, offset);
    const field = Number(key.value >> 3n);
    const wireType = Number(key.value & 7n);
    offset = key.next;
    if (wireType === 0) {
      const v = readVarint(buf, offset);
      fields.set(field, v.value);
      offset = v.next;
    } else if (wireType === 2) {
      const len = readVarint(buf, offset);
      const end = len.next + Number(len.value);
      if (end > buf.length) throw new Error("truncated field");
      fields.set(field, buf.subarray(len.next, end));
      offset = end;
    } else if (wireType === 1) {
      offset += 8;
    } else if (wireType === 5) {
      offset += 4;
    } else {
      throw new Error(`unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

function payloadOf(blob: Buffer, expectedType: number): ProtoFields | undefined {
  if (blob.length < HEADER_LENGTH || !/^trzd\d$/.test(blob.subarray(0, 5).toString("latin1"))) return undefined;
  if (blob[5] !== expectedType) return undefined;
  const length = blob.readUInt16LE(10);
  if (HEADER_LENGTH + length > blob.length) return undefined;
  try {
    return decodeProto(blob.subarray(HEADER_LENGTH, HEADER_LENGTH + length));
  } catch {
    return undefined;
  }
}

function str(fields: ProtoFields, n: number): string | undefined {
  const v = fields.get(n);
  return Buffer.isBuffer(v) ? v.toString("utf8") : undefined;
}

function num(fields: ProtoFields, n: number): number | undefined {
  const v = fields.get(n);
  return typeof v === "bigint" ? Number(v) : undefined;
}

// Keyed by tarball + entry: each read decompresses the archive (~0.5s), and a
// single parse can ask about the same token several times.
const cache = new Map<string, Promise<ProtoFields | undefined>>();

function definition(tarballPath: string, entry: string, type: number): Promise<ProtoFields | undefined> {
  const key = `${tarballPath}\0${entry}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = readEntry(tarballPath, entry).then((blob) => (blob ? payloadOf(blob, type) : undefined));
    // A failed read (TarballError) must not stick for the session.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

/** EthereumTokenInfo: address=1, chain_id=2, symbol=3, decimals=4, name=5. */
export async function tokenDefinition(
  tarballPath: string,
  chainId: number,
  address: string,
): Promise<TokenDefinition | undefined> {
  const addr = address.toLowerCase().replace(/^0x/, "");
  const fields = await definition(tarballPath, `eth/chain-id/${chainId}/token-${addr}.dat`, TYPE_TOKEN);
  if (!fields) return undefined;
  const symbol = str(fields, 3);
  const decimals = num(fields, 4);
  if (symbol === undefined || decimals === undefined) return undefined;
  return { symbol, decimals, name: str(fields, 5) ?? symbol };
}

/** EthereumNetworkInfo: chain_id=1, symbol=2, slip44=3, name=4. */
export async function networkDefinition(
  tarballPath: string,
  chainId: number,
): Promise<NetworkDefinition | undefined> {
  const fields = await definition(tarballPath, `eth/chain-id/${chainId}/network.dat`, TYPE_NETWORK);
  if (!fields) return undefined;
  const symbol = str(fields, 2);
  if (symbol === undefined) return undefined;
  return { symbol, name: str(fields, 4) ?? symbol };
}
