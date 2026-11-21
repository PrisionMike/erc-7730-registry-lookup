import path from "node:path";
import { confirm, input, select, Separator } from "@inquirer/prompts";
import type { DisplayField, DisplayModel, RegistryIndex } from "@ethereum-sourcify/clear-signing";
import { formatUnits, getAddress } from "ethers";
import {
  CalldataTree,
  CellError,
  cellShape,
  describeCell,
  integerRange,
  readAddress,
  readHex,
  readInteger,
  writeAddress,
  writeHex,
  writeInteger,
  type Cell,
  type CellShape,
} from "./calldataTree.js";
import {
  compactInteger,
  editAddress,
  editBool,
  editHex,
  editInteger,
  editText,
  integerOptions,
  type AddressContext,
  type Edited,
  type IntegerPreset,
} from "./cookPrompts.js";
import { formatSlots, mergedFormat, type MergedFormat, type Slot, type SlotTarget, type TxField } from "./cookSlots.js";
import type { SampleTx } from "./etherscan.js";
import { chainName, explorerTxUrl } from "./explorers.js";
import type { FixtureTarget } from "./fixtureDefinitions.js";
import { fixtureJson, slug, testWalletAddress, trezorctlCommand, unsignedRawTx, type TxFields } from "./generate.js";
import { testWallet } from "./localConfig.js";
import { writeFixtureFile } from "./output.js";
import { buildIndex, flatFields, formatTx, intentText, parseCalldata, type ParseTx } from "./parse.js";
import { DescriptorError, type Deployment, type Descriptor, type FunctionEntry } from "./registry.js";
import { findRegistryTests, type RegistryTestCase } from "./registryTests.js";
import { registryTestFile } from "./testCase.js";
import { dim, green, printAndCopy, truncate, yellow } from "./ui.js";

/**
 * Cook: take a real transaction calling the function — the latest on-chain
 * one, or a registry test case — edit any value its standard parse shows (or
 * the transaction's own value, chain id, sender, …), watching the parse
 * re-render after each edit, then turn the result into a trezorctl command,
 * a standard parse, a device fixture or a registry test case.
 */

const BACK = Symbol("back");

export interface SupportTarget {
  chainId: number;
  address: string;
  selector: string;
}

/** What cooking borrows from the browse screens. */
export interface CookContext {
  descriptor: Descriptor;
  fn: FunctionEntry;
  deployment: Deployment;
  /** The latest matching on-chain transaction (looked up once per screen), or null. */
  sampleTx(): Promise<SampleTx | null>;
  definitionsSource(): Promise<string | undefined>;
  checkSupport(target: SupportTarget, opts: { verbose: boolean }): Promise<boolean | undefined>;
  saveFixture(fileName: string, target: FixtureTarget, json: string): Promise<void>;
}

/** The transaction being cooked. Nonce is always 0, as for every fixture. */
interface Draft {
  chainId: number;
  to: string;
  from?: string;
  value: bigint;
  gasLimit: bigint;
  gasPrice: bigint;
  data: string;
}

type DraftField = TxField | "gasLimit" | "gasPrice";

interface Seed {
  /** An explorer link, or the registry test case. */
  origin: string;
  draft: Draft;
}

interface State {
  draft: Draft;
  /** Absent when the function has no signature to decode with, or the calldata doesn't decode. */
  tree?: CalldataTree;
  /** What changed, by value identity, for fixture comments and test descriptions. */
  edits: Map<string, { name: string; summary: string }>;
}

// ── Seeds ───────────────────────────────────────────────────────────────────

function draftFromSample(tx: SampleTx, chainId: number): Draft {
  return {
    chainId,
    to: getAddress(tx.to),
    ...(tx.from ? { from: getAddress(tx.from) } : {}),
    value: BigInt(tx.value),
    gasLimit: BigInt(tx.gas),
    gasPrice: BigInt(tx.gasPrice),
    data: tx.input,
  };
}

function draftFromTest(test: RegistryTestCase, descriptor: Descriptor, fallbackChain: number): Draft {
  const deployment = descriptor.deployments.find((d) => d.address.toLowerCase() === test.to.toLowerCase());
  return {
    chainId: test.chainId ?? deployment?.chainId ?? fallbackChain,
    to: getAddress(test.to),
    ...(test.from ? { from: getAddress(test.from) } : {}),
    value: test.value,
    gasLimit: test.gasLimit,
    gasPrice: test.gasPrice,
    data: test.data,
  };
}

async function pickSeed(ctx: CookContext): Promise<Seed | undefined> {
  const { descriptor, fn, deployment } = ctx;
  const tests = findRegistryTests(descriptor, fn.selector);
  for (;;) {
    const choice = await select<"explorer" | RegistryTestCase | typeof BACK>({
      message: `Cook ${fn.name} — start from which transaction?`,
      choices: [
        {
          name: "Latest on-chain transaction (Etherscan / Blockscout)",
          value: "explorer",
          description: dim(`The most recent successful ${fn.selector} call to ${deployment.address} on ${chainName(deployment.chainId)}`),
        },
        new Separator(dim(tests.length > 0 ? `── Registry test cases (${tests.length}) ──` : "── No registry test case calls this function ──")),
        ...tests.map((t) => ({
          name: `Registry test: ${truncate(t.description, 80)}`,
          value: t,
          description: dim(`${t.file} · ${t.chainId ? chainName(t.chainId) : "no chain id"} · to ${t.to}`),
        })),
        { name: "← Back", value: BACK },
      ],
      pageSize: 15,
    });
    if (choice === BACK) return undefined;
    if (choice === "explorer") {
      const tx = await ctx.sampleTx();
      if (tx) return { origin: explorerTxUrl(deployment.chainId, tx.hash), draft: draftFromSample(tx, deployment.chainId) };
      continue;
    }
    return { origin: `${choice.file} “${choice.description}”`, draft: draftFromTest(choice, descriptor, deployment.chainId) };
  }
}

// ── State ───────────────────────────────────────────────────────────────────

function decodeTree(format: MergedFormat | undefined, data: string): CalldataTree | undefined {
  return format?.key ? CalldataTree.decode(format.key, data) : undefined;
}

/** An unknown sender becomes the test wallet: fixtures sign as it, so @.from should read it too. */
function freshState(seed: Seed, format: MergedFormat | undefined, testWallet: string | undefined): State {
  const draft = { ...seed.draft, ...(seed.draft.from ? {} : testWallet ? { from: testWallet } : {}) };
  return { draft, tree: decodeTree(format, draft.data), edits: new Map() };
}

function cellId(cell: Cell): string {
  return `cell:${cell.leaf.key}${cell.slice ? `[${cell.slice.start ?? ""}:${cell.slice.end ?? ""}]` : ""}`;
}

function targetId(target: SlotTarget): string | undefined {
  if (target.kind === "tx") return `tx:${target.field}`;
  if (target.kind === "cell") return cellId(target.cell);
  return undefined;
}

/** "Amount = 0; Recipient = msg.from"; with `max`, whole entries are dropped for a "+N more". */
function editSummary(state: State, max = Infinity): string {
  const parts = [...state.edits.values()].map((e) => `${e.name} = ${e.summary}`);
  for (let kept = parts.length; kept > 0; kept--) {
    const more = parts.length - kept;
    const text = parts.slice(0, kept).join("; ") + (more > 0 ? ` (+${more} more)` : "");
    if (text.length <= max) return text;
  }
  return `${parts.length} edits`;
}

function parseTx(draft: Draft): ParseTx {
  return { chainId: draft.chainId, to: draft.to, data: draft.data, value: draft.value, ...(draft.from ? { from: draft.from } : {}) };
}

function txFields(draft: Draft): TxFields {
  return {
    to: draft.to,
    input: draft.data,
    value: draft.value.toString(),
    gas: draft.gasLimit.toString(),
    gasPrice: draft.gasPrice.toString(),
  };
}

function draftJson(draft: Draft): Record<string, unknown> {
  return {
    chainId: draft.chainId,
    to: draft.to,
    ...(draft.from ? { from: draft.from } : {}),
    value: draft.value.toString(),
    gasLimit: draft.gasLimit.toString(),
    gasPrice: draft.gasPrice.toString(),
    nonce: 0,
    data: draft.data,
  };
}

// ── Reading values for the menu ─────────────────────────────────────────────

function txValueText(draft: Draft, field: DraftField): string {
  switch (field) {
    case "chainId":
      return `${draft.chainId} · ${chainName(draft.chainId)}`;
    case "to":
      return draft.to;
    case "from":
      return draft.from ?? dim("(unknown)");
    case "value":
      return `${compactInteger(draft.value)} wei${draft.value > 0n ? dim(` (${formatUnits(draft.value, 18)} at 18 decimals)`) : ""}`;
    case "gasLimit":
      return compactInteger(draft.gasLimit);
    case "gasPrice":
      return `${compactInteger(draft.gasPrice)} wei (${formatUnits(draft.gasPrice, "gwei")} gwei)`;
  }
}

function targetText(target: SlotTarget, draft: Draft): string {
  switch (target.kind) {
    case "tx":
      return txValueText(draft, target.field);
    case "cell":
      try {
        return describeCell(target.cell);
      } catch (err) {
        return err instanceof CellError ? `? (${err.message})` : "?";
      }
    case "constant":
      return typeof target.value === "string" ? target.value : JSON.stringify(target.value) ?? "?";
    case "unresolved":
      return "—";
  }
}

/**
 * Pair each displayed field with its slot. The renderer lists fields in the
 * descriptor's order, as the walk does, so a forward scan by label lines them
 * up even when visibility rules or empty arrays drop some.
 */
function pairRendered(slots: Slot[], fields: DisplayField[]): Map<Slot, DisplayField> {
  const paired = new Map<Slot, DisplayField>();
  let cursor = 0;
  for (const slot of slots) {
    if (slot.role) continue;
    const j = fields.findIndex((f, i) => i >= cursor && f.label === slot.label);
    if (j === -1) continue;
    paired.set(slot, fields[j]!);
    cursor = j + 1;
  }
  return paired;
}

// ── Editing ─────────────────────────────────────────────────────────────────

type EditKind = "address" | "integer" | "bool" | "hex" | "text";

function shapeKind(shape: CellShape): EditKind {
  switch (shape.kind) {
    case "address":
      return "address";
    case "integer":
      return "integer";
    case "bool":
      return "bool";
    case "string":
      return "text";
    default:
      return "hex";
  }
}

const ROLE_KINDS: Record<string, EditKind> = {
  token: "address",
  collection: "address",
  spender: "address",
  callee: "address",
  amount: "integer",
  chainId: "integer",
  selector: "hex",
};

/** How the field's format reads the value; falls back to the cell's own type when the two can't meet. */
function editKind(slot: Pick<Slot, "format" | "role">, shape: CellShape): EditKind {
  let wanted: EditKind | undefined = slot.role ? ROLE_KINDS[slot.role] : undefined;
  if (!wanted) {
    if (slot.format === "addressName" || slot.format === "tokenTicker") wanted = "address";
    else if (["amount", "tokenAmount", "date", "duration", "unit", "enum", "nftName", "chainId"].includes(slot.format)) wanted = "integer";
    else if (slot.format === "calldata" || slot.format === "interoperableAddressName") wanted = "hex";
  }
  const fits =
    wanted === "address"
      ? shape.kind === "address" || (shape.kind === "integer" && !shape.signed && shape.bits >= 160) || ((shape.kind === "fixedBytes" && shape.size >= 20) || shape.kind === "bytes")
      : wanted === "integer"
        ? shape.kind !== "string"
        : wanted === "hex"
          ? shape.kind === "fixedBytes" || shape.kind === "bytes"
          : false;
  return wanted && fits ? wanted : shapeKind(shape);
}

interface Session {
  ctx: CookContext;
  /** The starting transaction, and its decoded arguments: an edit back to these isn't an edit. */
  initial: State;
  /** Built once: the registry can't move mid-cook, and rebuilding it costs most of a render. */
  index: RegistryIndex;
  format?: MergedFormat;
  state: State;
  testWallet?: string;
}

function addressContext(s: Session, extra?: AddressContext["extra"]): AddressContext {
  return {
    to: s.state.draft.to,
    ...(s.state.draft.from ? { from: s.state.draft.from } : {}),
    ...(s.testWallet ? { testWallet: s.testWallet } : {}),
    ...(extra ? { extra } : {}),
  };
}

/** Apply an edit to a calldata cell; false when the user backed out or it didn't take. */
async function editCell(s: Session, cell: Cell, slot: Pick<Slot, "format" | "role" | "params">, message: string): Promise<Edited<unknown> | undefined> {
  const shape = cellShape(cell);
  const kind = editKind(slot, shape);
  let edited: Edited<unknown> | undefined;
  switch (kind) {
    case "address": {
      const e = await editAddress(message, readAddress(cell), addressContext(s));
      if (e) writeAddress(cell, e.value);
      edited = e;
      break;
    }
    case "integer": {
      const range = integerRange(cell);
      const opts = integerOptions(slot.format, slot.params, s.format?.metadata ?? {}, range, slot.role);
      const e = await editInteger(message, readInteger(cell), { min: range[0], max: range[1], ...opts });
      if (e) writeInteger(cell, e.value);
      edited = e;
      break;
    }
    case "bool": {
      const e = await editBool(message, cell.leaf.get() as boolean);
      if (e) cell.leaf.set(e.value);
      edited = e;
      break;
    }
    case "hex": {
      const e = await editHex(message, readHex(cell), shape.kind === "fixedBytes" ? shape.size : undefined);
      if (e) writeHex(cell, e.value);
      edited = e;
      break;
    }
    case "text": {
      const e = await editText(message, cell.leaf.get() as string);
      if (e) cell.leaf.set(e.value);
      edited = e;
      break;
    }
  }
  if (edited && s.state.tree) s.state.draft.data = s.state.tree.encode();
  return edited;
}

const GAS_LIMITS: IntegerPreset[] = [
  { name: "21000", value: 21_000n, description: "A plain transfer" },
  { name: "100k", value: 100_000n },
  { name: "1M", value: 1_000_000n },
  { name: "30M", value: 30_000_000n, description: "A whole mainnet block" },
];
const GAS_PRICES: IntegerPreset[] = [
  { name: "1 gwei", value: 10n ** 9n },
  { name: "10 gwei", value: 10n ** 10n },
  { name: "100 gwei", value: 10n ** 11n },
  { name: "0", value: 0n },
];
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

/** Edit a transaction field; `format` is the displayed field's, when a field shows it (e.g. @.value as amount). */
async function editDraftField(s: Session, field: DraftField, message: string, format?: Pick<Slot, "format" | "params">): Promise<Edited<unknown> | undefined> {
  const { draft } = s.state;
  const metadata = s.format?.metadata ?? {};
  switch (field) {
    case "value": {
      const opts = integerOptions(format?.format ?? "amount", format?.params ?? {}, metadata, [0n, UINT256_MAX]);
      const e = await editInteger(message, draft.value, { min: 0n, max: UINT256_MAX, ...opts });
      if (e) draft.value = e.value;
      return e;
    }
    case "chainId": {
      const max = BigInt(Number.MAX_SAFE_INTEGER);
      const opts = integerOptions("chainId", {}, metadata, [1n, max]);
      const e = await editInteger(message, BigInt(draft.chainId), { min: 1n, max, ...opts });
      if (e) draft.chainId = Number(e.value);
      return e;
    }
    case "to": {
      const deployments = s.ctx.descriptor.deployments.map((d) => ({
        name: `${chainName(d.chainId)} deployment`,
        address: getAddress(d.address),
        description: `${s.ctx.descriptor.provider}/${s.ctx.descriptor.name} on chain ${d.chainId}`,
      }));
      const e = await editAddress(message, draft.to, addressContext(s, deployments));
      if (e) draft.to = e.value;
      return e;
    }
    case "from": {
      const e = await editAddress(message, draft.from, addressContext(s));
      if (e) draft.from = e.value;
      return e;
    }
    case "gasLimit": {
      const e = await editInteger(message, draft.gasLimit, { min: 0n, max: UINT64_MAX, presets: GAS_LIMITS });
      if (e) draft.gasLimit = e.value;
      return e;
    }
    case "gasPrice": {
      const e = await editInteger(message, draft.gasPrice, {
        min: 0n,
        max: UINT256_MAX,
        presets: GAS_PRICES,
        describe: (v) => `${formatUnits(v, "gwei")} gwei`,
      });
      if (e) draft.gasPrice = e.value;
      return e;
    }
  }
}

type EditTarget = { kind: "tx"; field: DraftField } | { kind: "cell"; cell: Cell };

function isInitial(s: Session, target: EditTarget): boolean {
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
  if (target.kind === "tx") return same(s.state.draft[target.field], s.initial.draft[target.field]);
  const initial = s.initial.tree?.leaves.get(target.cell.leaf.key);
  return initial !== undefined && same(initial.get(), target.cell.leaf.get());
}

function recordEdit(s: Session, target: EditTarget, name: string, edited: Edited<unknown> | undefined): void {
  if (!edited) return;
  const id = target.kind === "tx" ? `tx:${target.field}` : cellId(target.cell);
  if (isInitial(s, target)) s.state.edits.delete(id);
  else s.state.edits.set(id, { name, summary: edited.summary });
}

/** Any decoded argument, displayed or not: the escape hatch for hidden fields. */
async function editAnyArgument(s: Session): Promise<void> {
  const tree = s.state.tree!;
  const leaves = [...tree.leaves.values()];
  const pad = Math.min(40, Math.max(...leaves.map((l) => l.key.length)));
  const leaf = await select<(typeof leaves)[number] | typeof BACK>({
    message: "Which argument?",
    choices: [
      ...leaves.map((l) => ({
        name: `${l.key.padEnd(pad)}  ${truncate(describeCell({ leaf: l }), Math.max(24, (process.stdout.columns || 120) - pad - 16))}${s.state.edits.has(cellId({ leaf: l })) ? yellow("  ✎ edited") : ""}`,
        value: l,
        description: dim(l.type.format("full")),
      })),
      { name: "← Back", value: BACK },
    ],
    pageSize: 20,
  });
  if (leaf === BACK) return;
  const cell = { leaf };
  recordEdit(s, { kind: "cell", cell }, leaf.key, await editCell(s, cell, { format: "raw", params: {} }, `${leaf.key} (${leaf.type.type}):`));
}

async function editRawCalldata(s: Session): Promise<void> {
  const answer = (
    await input({
      message: "Calldata hex (empty keeps it):",
      default: s.state.draft.data,
      prefill: "editable",
      validate: (v) => v.trim() === "" || /^(0x)?([0-9a-fA-F]{2}){4,}$/.test(v.trim()) || "Hex, at least a 4-byte selector",
    })
  ).trim();
  if (!answer || answer.toLowerCase() === s.state.draft.data.toLowerCase()) return;
  s.state.draft.data = answer.startsWith("0x") ? answer : `0x${answer}`;
  s.state.tree = decodeTree(s.format, s.state.draft.data);
  // Cell edits are folded into the hex now; the tree is new, so their ids no longer apply.
  for (const id of [...s.state.edits.keys()]) if (id.startsWith("cell:")) s.state.edits.delete(id);
  s.state.edits.set("raw", { name: "calldata", summary: "hand-edited" });
  if (s.format?.key && !s.state.tree) {
    console.log(yellow(`The calldata no longer decodes as ${s.format.key} — field edits are off until it does.`));
  }
}

// ── The menu ────────────────────────────────────────────────────────────────

type MenuChoice =
  | { kind: "tx"; field: DraftField }
  | { kind: "slot"; slot: Slot }
  | { kind: "other" | "raw" | "reset" | "done" };

const TX_ROWS: { field: DraftField; label: string; description: string }[] = [
  { field: "chainId", label: "chain id", description: "The chain the transaction is signed for" },
  { field: "to", label: "msg.to", description: "The called contract — a non-deployment address finds no descriptor" },
  { field: "value", label: "msg.value", description: "Native currency sent along, in wei" },
  { field: "from", label: "msg.from", description: "Only the standard parse reads it (@.from); trezorctl and fixtures sign as the device's own account" },
  { field: "gasLimit", label: "gas limit", description: "trezorctl and fixtures only" },
  { field: "gasPrice", label: "gas price", description: "trezorctl and fixtures only" },
];

const NAMES: Record<DraftField, string> = { chainId: "chain id", to: "msg.to", value: "msg.value", from: "msg.from", gasLimit: "gas limit", gasPrice: "gas price" };

function menuChoices(s: Session, slots: Slot[], rendered: Map<Slot, DisplayField>, model: DisplayModel) {
  const { state } = s;
  // At the end, not the start: select's type-to-jump matches names by prefix.
  const mark = (id: string | undefined) => (id && state.edits.has(id) ? yellow("  ✎ edited") : "");
  const choices: ({ name: string; value: MenuChoice; description?: string; disabled?: boolean | string } | Separator)[] = [];

  choices.push(new Separator(dim("── Transaction ──")));
  for (const row of TX_ROWS) {
    choices.push({
      name: `${row.label.padEnd(24)}  ${txValueText(state.draft, row.field)}${mark(`tx:${row.field}`)}`,
      value: { kind: "tx", field: row.field },
      description: dim(row.description),
    });
  }

  const intent = intentText(model.intent);
  choices.push(new Separator(dim(`── Displayed fields${intent ? ` (${intent})` : ""} ──`)));
  if (!s.format) choices.push(new Separator(dim("   No display format for this selector in the descriptor")));
  else if (!state.tree) choices.push(new Separator(dim("   The calldata doesn't decode with the function's signature — edit it raw below")));
  const pad = Math.min(28, Math.max(0, ...slots.map((sl) => sl.label.length)));
  // One row per choice: select wraps anything wider than the terminal.
  const room = Math.max(24, (process.stdout.columns || 120) - pad - 18);
  for (const slot of slots) {
    const field = rendered.get(slot);
    const raw = targetText(slot.target, state.draft);
    const shown = slot.role ? raw : field ? field.value : raw;
    const warned = field?.warning && field.warning.code !== "UNKNOWN_ADDRESS" ? yellow(" ⚠") : "";
    const head = slot.role ? `  ↳ ${slot.role}`.padEnd(pad) : slot.label.padEnd(pad);
    const details = [
      slot.role ? `${slot.format} · ${slot.role} param` : slot.format,
      `path ${slot.path}`,
      ...(field && !slot.role && raw !== field.value ? [`raw ${raw}`] : []),
      ...(field?.warning ? [`⚠ ${field.warning.code}: ${field.warning.message}`] : []),
    ].join(" · ");
    const editable = slot.target.kind === "tx" || slot.target.kind === "cell";
    choices.push({
      name: `${head}  ${truncate(shown, room)}${warned}${mark(targetId(slot.target))}`,
      value: { kind: "slot", slot },
      description: dim(details),
      ...(editable ? {} : { disabled: slot.target.kind === "constant" ? "(descriptor constant)" : "(not in the calldata)" }),
    });
  }

  choices.push(new Separator(dim("── More ──")));
  if (state.tree) {
    choices.push({ name: "Any calldata argument (hidden ones too)…", value: { kind: "other" } });
  }
  choices.push({ name: "Raw calldata (hex)…", value: { kind: "raw" } });
  if (state.edits.size > 0) choices.push({ name: "↺ Reset to the starting transaction", value: { kind: "reset" } });
  choices.push({ name: "✔ Done — generate a trezorctl command, parse, fixture or test case…", value: { kind: "done" } });
  return choices;
}

function modelWarnings(model: DisplayModel): string[] {
  const lines = (model.warnings ?? []).map((w) => `⚠ ${w.code}: ${w.message}`);
  if (model.rawCalldataFallback) lines.unshift("Not clear-signed: the renderer fell back to raw calldata.");
  return lines;
}

// ── Generating ──────────────────────────────────────────────────────────────

async function generate(s: Session, seed: Seed): Promise<void> {
  const { ctx, state } = s;
  const { descriptor, fn } = ctx;
  const stem = slug(descriptor.provider, descriptor.name, fn.name);
  let fixtureName = `${stem}_cooked`;
  for (;;) {
    console.log(dim(state.edits.size > 0 ? `Edits: ${editSummary(state)}` : "No edits — the starting transaction as is."));
    const action = await select<string | typeof BACK>({
      message: "Cooked transaction — what do you want from it?",
      choices: [
        { name: "trezorctl command", value: "command" },
        { name: "Standard parse (registry CI renderer)", value: "parse" },
        { name: "Device test fixture JSON (saved to output/)", value: "fixture" },
        { name: "Registry test case (.tests.json, saved to output/)", value: "test" },
        { name: "Raw transaction (fields, calldata and unsigned tx hex)", value: "raw" },
        { name: "All of the above", value: "all" },
        { name: "← Back to editing", value: BACK },
      ],
    });
    if (action === BACK) return;

    const { draft } = state;
    const all = action === "all";
    const origin = `cooked from ${seed.origin}${state.edits.size > 0 ? ` — ${editSummary(state)}` : " (unedited)"}`;
    const definitions = await ctx.definitionsSource();
    const selector = draft.data.slice(0, 10).toLowerCase();

    if (action === "command" || all) {
      await printAndCopy("trezorctl command (cooked):", trezorctlCommand(txFields(draft), draft.chainId, definitions));
    }
    let model: DisplayModel | undefined;
    if (action === "parse" || all) {
      model = await parseCalldata(descriptor, parseTx(draft), definitions, {
        title: "Standard parse of the cooked transaction",
        fileStem: `${stem}_${draft.chainId}_cooked`,
        origin,
        extra: { cooked: draftJson(draft) },
      });
    }
    if (action === "fixture" || all) {
      const supported = await ctx.checkSupport({ chainId: draft.chainId, address: draft.to, selector }, { verbose: all });
      fixtureName = slug((await input({ message: "Fixture name:", default: fixtureName, prefill: "editable" })).trim()) || fixtureName;
      const wallet = testWallet();
      if (!wallet) console.log(dim("No testWallet in config.local.json — result signatures left empty."));
      const json = await fixtureJson(fixtureName, origin, txFields(draft), draft.chainId, supported, wallet);
      await printAndCopy("Device test fixture (cooked):", json);
      await ctx.saveFixture(`${fixtureName}_${draft.chainId}.json`, {
        chainId: draft.chainId,
        address: draft.to,
        selector,
        supported,
        calldata: draft.data,
        functionKey: s.format?.key ?? fn.key,
      }, json);
    }
    if (action === "test" || all) {
      model ??= (await formatTx(descriptor, parseTx(draft), definitions, s.index)).model;
      const intent = intentText(model.intent) ?? fn.name;
      const description = (
        await input({
          message: "Test case description:",
          default: state.edits.size > 0 ? `${intent} — ${editSummary(state, 110 - intent.length)}` : intent,
          prefill: "editable",
        })
      ).trim() || intent;
      const { json, sourceErrors } = await registryTestFile(
        descriptor,
        model,
        {
          description,
          rawTx: unsignedRawTx(txFields(draft), draft.chainId),
          ...(s.format?.readsFrom && draft.from ? { from: draft.from } : {}),
          chainId: draft.chainId,
        },
        definitions,
      );
      for (const message of sourceErrors) console.log(yellow(message));
      await printAndCopy("Registry test case (testsv2):", json);
      const written = writeFixtureFile(`${stem}_${draft.chainId}_cooked.tests.json`, json);
      console.log(
        green(`✔ Saved to ${path.relative(process.cwd(), written.path)}`) +
          (written.overwrote ? dim(" (replaced previous)") : "") +
          dim(` — merge its test into registry/${descriptor.provider}/testsv2/ (expected is what this renderer shows; review it).`) +
          "\n",
      );
    }
    if (action === "raw" || all) {
      const raw = { ...draftJson(draft), unsignedRawTx: unsignedRawTx(txFields(draft), draft.chainId) };
      await printAndCopy("Cooked transaction (legacy, nonce 0 — as fixtures sign it):", JSON.stringify(raw, null, 2));
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function cook(ctx: CookContext): Promise<void> {
  let format: MergedFormat | undefined;
  try {
    format = mergedFormat(ctx.descriptor.filePath, ctx.fn.selector);
  } catch (err) {
    if (!(err instanceof DescriptorError)) throw err;
    console.log(yellow(err.message));
  }
  if (format && !format.key) {
    console.log(dim("This function's format is keyed by a bare selector — no signature to decode with, so only the transaction fields and raw calldata are editable."));
  }

  const seed = await pickSeed(ctx);
  if (!seed) return;
  const wallet = testWallet();
  const walletAddress = wallet && testWalletAddress(wallet);
  const s: Session = {
    ctx,
    // Two decodes: edits change `state` in place, never `initial`.
    initial: freshState(seed, format, walletAddress),
    index: buildIndex(ctx.descriptor),
    ...(format ? { format } : {}),
    state: freshState(seed, format, walletAddress),
    ...(walletAddress ? { testWallet: walletAddress } : {}),
  };
  if (!seed.draft.from && s.state.draft.from) {
    console.log(dim(`The starting transaction names no sender; msg.from is the test wallet, ${s.state.draft.from}.`));
  }
  if (s.state.tree?.trailing) {
    console.log(dim(`The calldata has ${s.state.tree.trailing.length / 2} byte(s) after its arguments; edits keep them.`));
  }
  if (s.state.tree && !s.state.tree.canonical) {
    console.log(yellow("The calldata isn't canonically ABI-encoded; an edit re-encodes it canonically."));
  }
  console.log(dim(`Cooking from ${seed.origin}. Pick a value to change; the parse re-renders after each edit.`));

  const definitions = await ctx.definitionsSource();
  const printed = new Set<string>();
  let lastWarnings = "";
  let cursor: MenuChoice | undefined;
  for (;;) {
    const { model, sourceErrors } = await formatTx(ctx.descriptor, parseTx(s.state.draft), definitions, s.index);
    for (const message of sourceErrors) {
      if (!printed.has(message)) console.log(yellow(message));
      printed.add(message);
    }
    const warnings = modelWarnings(model).join("\n");
    if (warnings !== lastWarnings && warnings) console.log(yellow(warnings));
    if (warnings !== lastWarnings && !warnings && lastWarnings) console.log(green("✔ Renders cleanly again."));
    lastWarnings = warnings;

    const slots = s.format ? formatSlots(s.format, s.state.tree) : [];
    const rendered = pairRendered(slots, flatFields(model));
    const choices = menuChoices(s, slots, rendered, model);
    // Keep the cursor on the row just edited; slots are rebuilt each pass, so match by identity.
    const again = cursor && choices.find((c): c is { name: string; value: MenuChoice } =>
      !(c instanceof Separator) && sameChoice(c.value, cursor!));
    const back = { name: "← Back (discard)", value: BACK as MenuChoice | typeof BACK };
    const choice = await select<MenuChoice | typeof BACK>({
      message: `Cook · ${ctx.descriptor.provider}/${ctx.descriptor.name} · ${ctx.fn.name}`,
      choices: [...choices, back],
      ...(again ? { default: again.value } : {}),
      pageSize: 22,
    });
    if (choice === BACK) {
      if (s.state.edits.size === 0 || (await confirm({ message: "Discard the cooked transaction?", default: false }))) return;
      continue;
    }
    cursor = choice;
    try {
      switch (choice.kind) {
        case "tx": {
          const name = NAMES[choice.field];
          recordEdit(s, { kind: "tx", field: choice.field }, name, await editDraftField(s, choice.field, `${name}:`));
          break;
        }
        case "slot": {
          const { slot } = choice;
          const name = slot.role ? `${slot.label} (${slot.role})` : slot.label;
          const message = `${name} — ${slot.role ? `${slot.role} param of a ${slot.format} field` : slot.format}:`;
          if (slot.target.kind === "tx") {
            const field = slot.target.field;
            recordEdit(s, { kind: "tx", field }, name, await editDraftField(s, field, message, slot.role === "amount" ? { format: "amount", params: {} } : slot));
          } else if (slot.target.kind === "cell") {
            recordEdit(s, { kind: "cell", cell: slot.target.cell }, name, await editCell(s, slot.target.cell, slot, message));
          }
          break;
        }
        case "other":
          await editAnyArgument(s);
          break;
        case "raw":
          await editRawCalldata(s);
          break;
        case "reset":
          s.state = freshState(seed, s.format, s.testWallet);
          console.log(dim("Back to the starting transaction."));
          break;
        case "done":
          await generate(s, seed);
          break;
      }
    } catch (err) {
      if (!(err instanceof CellError)) throw err;
      console.log(yellow(err.message));
    }
  }
}

function sameChoice(a: MenuChoice, b: MenuChoice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tx" && b.kind === "tx") return a.field === b.field;
  if (a.kind === "slot" && b.kind === "slot") {
    return a.slot.label === b.slot.label && a.slot.role === b.slot.role && a.slot.path === b.slot.path;
  }
  return true;
}
