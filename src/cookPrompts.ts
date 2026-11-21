import { input, select } from "@inquirer/prompts";
import { formatEther, getAddress, isAddress } from "ethers";
import { metadataValue } from "./cookSlots.js";
import { chainName, knownChainIds } from "./explorers.js";
import { dim } from "./ui.js";

/**
 * The value pickers a cook edits with. Each offers presets that make useful
 * test cases, plus manual entry pre-filled with the current value, and
 * returns undefined when the user backs out (so nothing changes).
 */

const BACK = Symbol("back");
const MANUAL = Symbol("manual");

/** A new value, and how to name it in a fixture comment or test description. */
export interface Edited<T> {
  value: T;
  summary: string;
}

export const DDDD_ADDRESS = getAddress("0x" + "d".repeat(40));
export const EEEE_ADDRESS = getAddress("0x" + "e".repeat(40));
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Huge integers (uint256 max…) wrap a terminal line; name them compactly instead. */
export function compactInteger(v: bigint): string {
  const s = v.toString();
  if (s.length <= 24) return s;
  const abs = v < 0n ? -v : v;
  const bits = abs.toString(2);
  if (v > 0n && /^1+$/.test(bits)) return `2^${bits.length}−1`;
  if (abs > 0n && /^10*$/.test(bits)) return `${v < 0n ? "−" : ""}2^${bits.length - 1}`;
  return `${s.slice(0, 10)}…${s.slice(-4)} (${s.length} digits)`;
}

function currentMark(same: boolean): string {
  return same ? dim(" (current)") : "";
}

// ── Addresses ───────────────────────────────────────────────────────────────

export interface AddressPreset {
  name: string;
  address: string;
  description?: string;
}

export interface AddressContext {
  /** msg.from of the draft, when known. */
  from?: string;
  /** msg.to of the draft. */
  to: string;
  /** The fixture-signing test wallet's address, when configured. */
  testWallet?: string;
  /** More candidates, e.g. the descriptor's deployments when editing msg.to. */
  extra?: AddressPreset[];
}

export async function editAddress(
  message: string,
  current: string | undefined,
  ctx: AddressContext,
): Promise<Edited<string> | undefined> {
  const presets: AddressPreset[] = [
    { name: "0xDDdD…", address: DDDD_ADDRESS },
    { name: "0xEeee…", address: EEEE_ADDRESS, description: "The usual native-currency placeholder" },
    { name: "0x0000…", address: ZERO_ADDRESS, description: "The zero address" },
  ];
  if (ctx.from) presets.push({ name: "msg.from", address: getAddress(ctx.from), description: "The draft's sender" });
  presets.push({ name: "msg.to", address: getAddress(ctx.to), description: "The contract being called" });
  if (ctx.testWallet && ctx.testWallet.toLowerCase() !== ctx.from?.toLowerCase()) {
    presets.push({
      name: "Test wallet",
      address: ctx.testWallet,
      description: "testWallet at m/44'/60'/0'/0/0 — who fixtures sign as",
    });
  }
  presets.push(...(ctx.extra ?? []));

  const pad = Math.max(...presets.map((p) => p.name.length));
  const same = (a: string) => current !== undefined && a.toLowerCase() === current.toLowerCase();
  const choice = await select<AddressPreset | typeof MANUAL | typeof BACK>({
    message,
    choices: [
      ...presets.map((p) => ({
        name: `${p.name.padEnd(pad)}  ${p.address}${currentMark(same(p.address))}`,
        value: p,
        description: p.description && dim(p.description),
      })),
      { name: "Manual…", value: MANUAL, description: dim("Type an address — starts from the current one") },
      { name: `← Back (keep ${current ?? "as is"})`, value: BACK },
    ],
    pageSize: 15,
  });
  if (choice === BACK) return undefined;
  if (choice !== MANUAL) return { value: choice.address, summary: choice.name.startsWith("0x") ? short(choice.address) : choice.name };
  const answer = (
    await input({
      message: "Address (empty keeps the current one):",
      default: current,
      prefill: "editable",
      validate: (v) => v.trim() === "" || isAddress(v.trim()) || "Not an address (or a bad checksum — lowercase skips the check)",
    })
  ).trim();
  if (!answer) return undefined;
  const value = getAddress(answer);
  return { value, summary: short(value) };
}

// ── Integers ────────────────────────────────────────────────────────────────

export interface IntegerPreset {
  name: string;
  value: bigint;
  description?: string;
}

/** Decimal, 0x-hex, or scientific ("15e17") — integers only. */
export function parseInteger(text: string): bigint | undefined {
  const t = text.trim().replace(/[_,]/g, "");
  if (/^-?\d+$/.test(t)) return BigInt(t);
  if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t);
  const sci = /^(\d+)(?:\.(\d+))?e(\d+)$/i.exec(t);
  if (sci) {
    const fraction = sci[2] ?? "";
    const exponent = Number(sci[3]);
    if (fraction.length > exponent) return undefined;
    return BigInt(sci[1]! + fraction) * 10n ** BigInt(exponent - fraction.length);
  }
  return undefined;
}

export async function editInteger(
  message: string,
  current: bigint | undefined,
  opts: { min: bigint; max: bigint; presets: IntegerPreset[]; describe?: (v: bigint) => string | undefined },
): Promise<Edited<bigint> | undefined> {
  const seen = new Set<bigint>();
  const presets = opts.presets.filter((p) => {
    if (p.value < opts.min || p.value > opts.max || seen.has(p.value)) return false;
    seen.add(p.value);
    return true;
  });
  const pad = Math.max(0, ...presets.map((p) => p.name.length));
  const describe = (v: bigint, name?: string) => {
    const d = opts.describe?.(v);
    return d && d !== name ? dim(`  ${d}`) : "";
  };
  const choice = await select<IntegerPreset | typeof MANUAL | typeof BACK>({
    message,
    choices: [
      ...presets.map((p) => ({
        name: `${p.name.padEnd(pad)}  ${compactInteger(p.value)}${describe(p.value, p.name)}${currentMark(p.value === current)}`,
        value: p,
        description: dim([p.description, compactInteger(p.value) !== p.value.toString() ? p.value.toString() : undefined].filter(Boolean).join(" — ")),
      })),
      {
        name: "Manual…",
        value: MANUAL,
        description: dim("Raw integer — decimal, 0x-hex or 15e17 — starting from the current value"),
      },
      { name: `← Back (keep ${current === undefined ? "as is" : compactInteger(current)})`, value: BACK },
    ],
    pageSize: 15,
  });
  if (choice === BACK) return undefined;
  if (choice !== MANUAL) return { value: choice.value, summary: choice.name };
  const answer = await input({
    message: `Integer, ${compactInteger(opts.min)} … ${compactInteger(opts.max)} (empty keeps the current one):`,
    default: current?.toString(),
    prefill: "editable",
    validate: (v) => {
      if (v.trim() === "") return true;
      const n = parseInteger(v);
      if (n === undefined) return "Not an integer";
      return (n >= opts.min && n <= opts.max) || "Out of range";
    },
  });
  if (answer.trim() === "") return undefined;
  const value = parseInteger(answer)!;
  return { value, summary: value.toString() };
}

const HOUR = 3600n;
const DAY = 24n * HOUR;

function isoDate(seconds: bigint): string | undefined {
  // JS Dates reach ±8.64e15 ms.
  if (seconds < 0n || seconds > 8_640_000_000_000n) return undefined;
  return new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z");
}

/** The library's formatDuration(): hh:mm:ss. */
function hms(seconds: bigint): string {
  const s = seconds < 0n ? -seconds : seconds;
  const two = (n: bigint) => n.toString().padStart(2, "0");
  return `${two(s / HOUR)}:${two((s % HOUR) / 60n)}:${two(s % 60n)}`;
}

function bitsOf(max: bigint): number {
  return max.toString(2).length;
}

/**
 * Presets and a describer for an integer slot, by the format it renders with.
 * `role` is set when the slot is a value a param points at (e.g. amountPath).
 */
export function integerOptions(
  format: string,
  params: Record<string, unknown>,
  metadata: Record<string, unknown>,
  range: [bigint, bigint],
  role?: string,
): { presets: IntegerPreset[]; describe?: (v: bigint) => string | undefined } {
  const [min, max] = range;
  const signed = min < 0n;
  const kind = role === "chainId" ? "chainId" : role === "amount" ? "amount" : format;
  const presets: IntegerPreset[] = [{ name: "0", value: 0n }, { name: "1", value: 1n }];
  if (signed) presets.push({ name: "-1", value: -1n }, { name: `min int${bitsOf(max) + 1}`, value: min });
  presets.push({ name: signed ? `max int${bitsOf(max) + 1}` : `max uint${bitsOf(max)}`, value: max });

  switch (kind) {
    case "amount":
      presets.splice(2, 0, { name: "1 whole coin", value: 10n ** 18n, description: "10^18 — one unit of an 18-decimal native currency" });
      return { presets, describe: (v) => (v >= 0n && v < 10n ** 30n ? `${formatEther(v)} (at 18 decimals)` : undefined) };

    case "tokenAmount": {
      let threshold = params.threshold;
      if (typeof threshold === "string" && threshold.startsWith("$.")) threshold = metadataValue(metadata, threshold);
      const t = typeof threshold === "number" ? BigInt(threshold) : typeof threshold === "string" ? parseInteger(threshold) : undefined;
      if (t !== undefined) {
        const message = typeof params.message === "string" ? params.message : "Unlimited";
        presets.splice(2, 0, { name: `threshold (renders “${message}”)`, value: t, description: "The descriptor's threshold param" });
      }
      return { presets };
    }

    case "date": {
      if (params.encoding === "blockheight") return { presets: presets.slice(0, 2), describe: (v) => `block ${v}` };
      const now = BigInt(Math.floor(Date.now() / 1000));
      return {
        presets: [
          { name: "now", value: now },
          { name: "in 1 hour", value: now + HOUR },
          { name: "in 1 day", value: now + DAY },
          { name: "in 30 days", value: now + 30n * DAY },
          { name: "in 1 year", value: now + 365n * DAY },
          { name: "1 hour ago", value: now - HOUR, description: "An already-expired deadline" },
          { name: "2^32 − 1", value: 2n ** 32n - 1n, description: "Feb 2106: a common “never expires”" },
          ...presets,
        ],
        describe: isoDate,
      };
    }

    case "duration":
      return {
        presets: [
          { name: "1 hour", value: HOUR },
          { name: "1 day", value: DAY },
          { name: "7 days", value: 7n * DAY },
          { name: "30 days", value: 30n * DAY },
          { name: "365 days", value: 365n * DAY },
          ...presets,
        ],
        describe: hms,
      };

    case "enum": {
      const ref = params.$ref;
      const map = typeof ref === "string" ? metadataValue(metadata, ref) : undefined;
      const entries = typeof map === "object" && map !== null ? Object.entries(map as Record<string, unknown>) : [];
      const labels = new Map<bigint, string>();
      const enumPresets: IntegerPreset[] = [];
      for (const [k, label] of entries) {
        const v = parseInteger(k);
        if (v === undefined) continue;
        labels.set(v, String(label));
        enumPresets.push({ name: String(label), value: v });
      }
      return { presets: [...enumPresets, ...presets], describe: (v) => labels.get(v) ?? "not in the enum" };
    }

    case "chainId":
      return {
        presets: [...knownChainIds().map((id) => ({ name: chainName(id), value: BigInt(id) })), ...presets],
        describe: (v) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? chainName(Number(v)) : undefined),
      };

    default:
      return { presets };
  }
}

// ── Everything else ─────────────────────────────────────────────────────────

export async function editBool(message: string, current: boolean | undefined): Promise<Edited<boolean> | undefined> {
  const choice = await select<boolean | typeof BACK>({
    message,
    choices: [
      { name: `true${currentMark(current === true)}`, value: true },
      { name: `false${currentMark(current === false)}`, value: false },
      { name: "← Back", value: BACK },
    ],
  });
  return choice === BACK ? undefined : { value: choice, summary: String(choice) };
}

/** `size` fixes the byte length (bytesN, a slice); otherwise any length goes. */
export async function editHex(message: string, current: string, size?: number): Promise<Edited<string> | undefined> {
  const empty = size === undefined ? "0x" : "0x" + "00".repeat(size);
  const choice = await select<string | typeof MANUAL | typeof BACK>({
    message,
    choices: [
      { name: size === undefined ? "Empty (0x)" : `All zero (${size} bytes)`, value: empty },
      { name: "Manual…", value: MANUAL, description: dim("Hex — starts from the current value") },
      { name: "← Back", value: BACK },
    ],
  });
  if (choice === BACK) return undefined;
  if (choice !== MANUAL) return { value: choice, summary: size === undefined ? "empty" : "zero" };
  const answer = (
    await input({
      message: `Hex${size === undefined ? "" : `, exactly ${size} bytes`} (empty keeps the current value):`,
      default: current,
      prefill: "editable",
      validate: (v) => {
        const t = v.trim();
        if (t === "") return true;
        const body = t.startsWith("0x") ? t.slice(2) : t;
        if (!/^([0-9a-fA-F]{2})*$/.test(body)) return "Not hex bytes";
        return size === undefined || body.length / 2 === size || `Needs exactly ${size} bytes, got ${body.length / 2}`;
      },
    })
  ).trim();
  if (!answer) return undefined;
  const value = answer.startsWith("0x") ? answer : `0x${answer}`;
  return { value, summary: value.length > 18 ? `${value.slice(0, 18)}…` : value };
}

export async function editText(message: string, current: string): Promise<Edited<string> | undefined> {
  const answer = await input({ message: `${message} (left as is, nothing changes):`, default: current, prefill: "editable" });
  return answer === current ? undefined : { value: answer, summary: JSON.stringify(answer) };
}
