import { mergeDescriptors, type Descriptor as LibDescriptor } from "@ethereum-sourcify/clear-signing";
import { isAddress } from "ethers";
import type { CalldataTree, Cell } from "./calldataTree.js";
import { loadDescriptorChain } from "./registry.js";
import { parseFormatKey } from "./selector.js";

/**
 * Which calldata (or transaction) value each field of a function's display
 * format shows — the "slots" a cook can edit. The walk mirrors the
 * clear-signing library's applyFieldFormats(): field groups, ".[]" iteration,
 * struct-group path scoping and $ref definitions all resolve the same way, so
 * a slot's path is the one the renderer reads.
 */

export type TxField = "value" | "from" | "to" | "chainId";

export type SlotTarget =
  | { kind: "tx"; field: TxField }
  | { kind: "cell"; cell: Cell }
  /** A descriptor constant ($.metadata…) or literal: shown, but not in the transaction. */
  | { kind: "constant"; value: unknown }
  /** A path the calldata doesn't have (or no ABI to look in). */
  | { kind: "unresolved" };

/** A field param that points at another value the field renders with. */
export type ParamRole = "token" | "collection" | "spender" | "callee" | "amount" | "chainId" | "selector";

export interface Slot {
  /** The field's label. */
  label: string;
  /** Absent for the field's own value; set for a value one of its params points at. */
  role?: ParamRole;
  /** The field's format ("tokenAmount", "addressName", …). */
  format: string;
  params: Record<string, unknown>;
  /** The concrete path, after scoping and array expansion (or the param's spec). */
  path: string;
  target: SlotTarget;
}

/** The library resolves `token ?? tokenPath` (and so on): a literal or $. constant, or a path. */
const PARAM_ROLES: { role: ParamRole; keys: [string, string] }[] = [
  { role: "token", keys: ["token", "tokenPath"] },
  { role: "collection", keys: ["collection", "collectionPath"] },
  { role: "spender", keys: ["spender", "spenderPath"] },
  { role: "callee", keys: ["callee", "calleePath"] },
  { role: "amount", keys: ["amount", "amountPath"] },
  { role: "chainId", keys: ["chainId", "chainIdPath"] },
  { role: "selector", keys: ["selector", "selectorPath"] },
];

type Json = Record<string, unknown>;

interface FieldSpec {
  path?: string;
  value?: unknown;
  label?: string;
  format?: string;
  params?: Json;
  visible?: unknown;
  $ref?: string;
  fields?: FieldSpec[];
  iteration?: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The descriptor as the library sees it: its include chain merged, leaf winning. */
export interface MergedFormat {
  /** The format key whose signature the calldata is decoded with (undefined for bare-selector keys). */
  key?: string;
  spec: Json;
  definitions: Record<string, FieldSpec>;
  metadata: Json;
  /** Whether anything in the format reads @.from — only then does a registry test case carry `from`. */
  readsFrom: boolean;
}

export function mergedFormat(descriptorFile: string, selector: string): MergedFormat | undefined {
  // Leaf first; merge from the root include down, as resolveWithIncludes() does.
  const chain = loadDescriptorChain(descriptorFile).map((f) => f.json);
  let merged = chain.at(-1)!;
  for (let i = chain.length - 2; i >= 0; i--) {
    merged = mergeDescriptors(chain[i] as LibDescriptor, merged as LibDescriptor) as unknown as Json;
  }
  const display = isRecord(merged.display) ? merged.display : {};
  const formats = isRecord(display.formats) ? display.formats : {};
  // Like the library's findFormatBySelector(): the first key with that selector, signature keys only.
  let found: { key: string; spec: Json } | undefined;
  let bareSelectorSpec: Json | undefined;
  for (const [key, spec] of Object.entries(formats)) {
    if (!isRecord(spec)) continue;
    let parsed;
    try {
      parsed = parseFormatKey(key);
    } catch {
      continue;
    }
    if (parsed.selector !== selector.toLowerCase()) continue;
    if (parsed.signature) {
      found = { key, spec };
      break;
    }
    bareSelectorSpec ??= spec;
  }
  const spec = found?.spec ?? bareSelectorSpec;
  if (!spec) return undefined;
  return {
    key: found?.key,
    spec,
    definitions: (isRecord(display.definitions) ? display.definitions : {}) as Record<string, FieldSpec>,
    metadata: isRecord(merged.metadata) ? merged.metadata : {},
    readsFrom: JSON.stringify(spec).includes('"@.from"') || JSON.stringify(display.definitions ?? {}).includes('"@.from"'),
  };
}

/** "$.metadata.enums.x" → the value there, as the library's resolveMetadataValue(). */
export function metadataValue(metadata: Json, pointer: string): unknown {
  const prefix = "$.metadata.";
  if (!pointer.startsWith(prefix)) return undefined;
  let cur: unknown = metadata;
  for (const segment of pointer.slice(prefix.length).split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[segment];
  }
  return cur;
}

function stripRoot(path: string): string {
  return path.startsWith("#.") ? path.slice(2) : path;
}

function isAbsolute(path: string): boolean {
  return path.startsWith("@.") || path.startsWith("$.");
}

/** A struct group's scoped resolver: children's paths hang off the group's (unless @. or $.). */
type Scope = (path: string) => string;
const ROOT: Scope = (p) => p;
function scoped(prefix: string): Scope {
  return prefix ? (p) => (isAbsolute(p) ? p : `${prefix}.${stripRoot(p)}`) : ROOT;
}

function groupBase(path: string | undefined): string {
  if (!path) return "";
  const i = path.indexOf(".[]");
  return i === -1 ? path : path.slice(0, i);
}

/** The library's expandFieldForIndex(): the first ".[]" in the path and in path-valued params. */
function expandIndex(field: FieldSpec, index: number): FieldSpec {
  const params = field.params && Object.fromEntries(
    Object.entries(field.params).map(([k, v]) => [k, typeof v === "string" && v.includes(".[]") ? v.replace(".[]", `.[${index}]`) : v]),
  );
  return { ...field, path: field.path?.replace(".[]", `.[${index}]`), ...(params ? { params } : {}) };
}

function mergeDefinition(field: FieldSpec, definitions: Record<string, FieldSpec>): FieldSpec {
  const prefix = "$.display.definitions.";
  if (!field.$ref?.startsWith(prefix)) return field;
  const def = definitions[field.$ref.slice(prefix.length)];
  if (!def) return field;
  const params: Json = { ...(def.params ?? {}) };
  for (const [k, v] of Object.entries(field.params ?? {})) if (v !== null && v !== undefined) params[k] = v;
  return {
    path: field.path ?? def.path,
    value: field.value ?? def.value,
    label: field.label ?? def.label,
    format: field.format ?? def.format,
    params,
    visible: field.visible ?? def.visible,
  };
}

function target(path: string, tree: CalldataTree | undefined, metadata: Json): SlotTarget {
  if (path === "@.value" || path === "@.from" || path === "@.to" || path === "@.chainId") {
    return { kind: "tx", field: path.slice(2) as TxField };
  }
  if (path.startsWith("$.")) return { kind: "constant", value: metadataValue(metadata, path) };
  const cell = tree?.resolve(path);
  return cell ? { kind: "cell", cell } : { kind: "unresolved" };
}

function walkSingle(field: FieldSpec, scope: Scope, ctx: WalkContext): void {
  const merged = mergeDefinition(field, ctx.format.definitions);
  if (merged.visible === "never" || !merged.label) return;
  const format = merged.format ?? "raw";
  const params = merged.params ?? {};
  if (merged.value !== undefined) {
    const value = typeof merged.value === "string" && merged.value.startsWith("$.metadata.")
      ? metadataValue(ctx.format.metadata, merged.value)
      : merged.value;
    ctx.slots.push({ label: merged.label, format, params, path: String(merged.value), target: { kind: "constant", value } });
    return;
  }
  if (merged.path === undefined) return;
  const path = scope(merged.path);
  ctx.slots.push({ label: merged.label, format, params, path, target: target(path, ctx.tree, ctx.format.metadata) });

  for (const { role, keys } of PARAM_ROLES) {
    const spec = params[keys[0]] ?? params[keys[1]];
    if (spec === undefined || spec === null) continue;
    if (typeof spec !== "string" || isAddress(spec) || !/^[#@$a-zA-Z_[]/.test(spec)) {
      // A literal (an address, a chain id): nothing in the transaction to edit.
      ctx.slots.push({ label: merged.label, role, format, params, path: String(spec), target: { kind: "constant", value: spec } });
      continue;
    }
    const rolePath = scope(spec);
    ctx.slots.push({ label: merged.label, role, format, params, path: rolePath, target: target(rolePath, ctx.tree, ctx.format.metadata) });
  }
}

interface WalkContext {
  format: MergedFormat;
  tree: CalldataTree | undefined;
  slots: Slot[];
}

/** Every displayed field's slot, plus one per path-valued param, in display order. */
export function formatSlots(format: MergedFormat, tree: CalldataTree | undefined): Slot[] {
  const ctx: WalkContext = { format, tree, slots: [] };
  const length = (path: string) => tree?.arrayLength(path) ?? 0;
  const fields = Array.isArray(format.spec.fields) ? (format.spec.fields as FieldSpec[]) : [];

  for (const spec of fields) {
    if (Array.isArray(spec.fields)) {
      const children = spec.fields.filter((c) => !Array.isArray(c.fields));
      if (spec.path?.endsWith(".[]")) {
        const base = groupBase(spec.path);
        for (let i = 0; i < length(base); i++) {
          for (const child of children) walkSingle(child, scoped(`${base}.[${i}]`), ctx);
        }
      } else if (children.some((c) => c.path?.includes(".[]"))) {
        // The library resolves these children unscoped, whatever the group's path.
        if (spec.iteration === "bundled") {
          const n = length(groupBase(children.find((c) => c.path?.includes(".[]"))!.path));
          for (let i = 0; i < n; i++) {
            for (const child of children) walkSingle(child.path?.includes(".[]") ? expandIndex(child, i) : child, ROOT, ctx);
          }
        } else {
          for (const child of children) {
            if (!child.path?.includes(".[]")) walkSingle(child, ROOT, ctx);
            else for (let i = 0; i < length(groupBase(child.path)); i++) walkSingle(expandIndex(child, i), ROOT, ctx);
          }
        }
      } else {
        const scope = scoped(stripRoot(groupBase(spec.path)));
        for (const child of children) walkSingle(child, scope, ctx);
      }
    } else if (spec.path?.includes(".[]")) {
      if (spec.visible === "never") continue;
      for (let i = 0; i < length(groupBase(spec.path)); i++) walkSingle(expandIndex(spec, i), ROOT, ctx);
    } else {
      walkSingle(spec, ROOT, ctx);
    }
  }
  return ctx.slots;
}
