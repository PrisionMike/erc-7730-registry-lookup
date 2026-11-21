import { createRequire } from "node:module";
import path from "node:path";
import {
  format,
  isFieldGroup,
  type DisplayField,
  type DisplayFieldGroup,
  type DisplayModel,
  type ExternalDataProvider,
  type RegistryIndex,
  type Warning,
} from "@ethereum-sourcify/clear-signing";
import { createFilesystemResolver } from "@ethereum-sourcify/clear-signing/filesystem";
import { networkDefinition, tokenDefinition } from "./definitions.js";
import { writeFixtureFile } from "./output.js";
import {
  DescriptorError,
  listDescriptorFiles,
  listProviders,
  loadDescriptor,
  REGISTRY_REPO_ROOT,
  type Deployment,
  type Descriptor,
} from "./registry.js";
import { TarballError } from "./tarball.js";
import { dim, green, printAndCopy, yellow } from "./ui.js";

/**
 * Standard parse: render a real transaction the way the registry CI's Sourcify
 * test runner does, with @ethereum-sourcify/clear-signing — the reference
 * ERC-7730 implementation. (The Python `erc7730` package CI also installs only
 * lints and converts descriptors; it never decodes calldata.)
 */

const LIBRARY = "@ethereum-sourcify/clear-signing";

function libraryVersion(): string {
  const pkg: unknown = createRequire(import.meta.url)(`${LIBRARY}/package.json`);
  const version = typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : undefined;
  return typeof version === "string" ? version : "unknown";
}

function caip10(d: Deployment): string {
  return `eip155:${d.chainId}:${d.address.toLowerCase()}`;
}

/**
 * Index every browsable descriptor's deployments, so calldata-formatted
 * fields (a Safe's inner call, a multicall's legs) can resolve their callee's
 * descriptor too. Paths are relative to the submodule root, which gives the
 * library's include resolution room for "../../ercs/…" walks.
 *
 * Rebuilt per parse rather than cached, as the registry can be moved
 * mid-session; a caller rendering many times in a row (cooking) builds it once.
 */
export function buildIndex(selected: Descriptor): RegistryIndex {
  const calldataIndex: Record<string, string> = {};
  for (const provider of listProviders()) {
    for (const file of listDescriptorFiles(provider)) {
      let descriptor: Descriptor;
      try {
        descriptor = loadDescriptor(provider, file);
      } catch (err) {
        if (err instanceof DescriptorError) continue;
        throw err;
      }
      for (const d of descriptor.deployments) {
        calldataIndex[caip10(d)] ??= path.relative(REGISTRY_REPO_ROOT, descriptor.filePath);
      }
    }
  }
  // Two descriptors can claim one deployment; parse with the one the user picked.
  const own = path.relative(REGISTRY_REPO_ROOT, selected.filePath);
  for (const d of selected.deployments) calldataIndex[caip10(d)] = own;
  return { calldataIndex, typedDataIndex: {} };
}

/**
 * Token and native-currency metadata come from the definitions source, as on
 * the device. Everything else (ENS, local names, NFT collections, block
 * timestamps) is left unresolved, so those fields render raw with a warning.
 */
function dataProvider(tarball: string | undefined, errors: Set<string>): ExternalDataProvider {
  if (!tarball) return {};
  const guard = async <T>(lookup: () => Promise<T | undefined>): Promise<T | null> => {
    try {
      return (await lookup()) ?? null;
    } catch (err) {
      if (!(err instanceof TarballError)) throw err;
      errors.add(err.message);
      return null;
    }
  };
  return {
    resolveToken: (chainId, address) => guard(() => tokenDefinition(tarball, chainId, address)),
    resolveChainInfo: (chainId) =>
      guard(async () => {
        const net = await networkDefinition(tarball, chainId);
        // Trezor network definitions carry no decimals; every EVM native currency uses 18.
        return net && { name: net.name, nativeCurrency: { name: net.symbol, symbol: net.symbol, decimals: 18 } };
      }),
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const INDENT = "  ";
const MAX_LABEL_PAD = 28;

export function intentText(intent: DisplayModel["intent"]): string | undefined {
  if (intent == null) return undefined;
  if (typeof intent === "string") return intent;
  return Object.entries(intent)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
}

interface Render {
  lines: string[];
  /** Any warning worth a look, i.e. anything but a suppressed UNKNOWN_ADDRESS. */
  warned: boolean;
  /** addressName fields left raw — inevitable, as nothing here resolves names. */
  unnamedAddresses: number;
}

function pushWarning(r: Render, indent: string, w: Warning): void {
  if (w.code === "UNKNOWN_ADDRESS") {
    r.unnamedAddresses++;
    return;
  }
  r.warned = true;
  r.lines.push(`${indent}⚠ ${w.code}: ${w.message}`);
}

function fieldValue(f: DisplayField): string {
  let value = f.value;
  if (f.rawAddress && f.rawAddress.toLowerCase() !== value.toLowerCase()) value += ` (${f.rawAddress})`;
  if (f.tokenAddress && f.warning?.code === "UNKNOWN_TOKEN") value += ` [token ${f.tokenAddress}]`;
  return value;
}

function renderFields(r: Render, fields: (DisplayField | DisplayFieldGroup)[], indent: string): void {
  // An unlabelled group is only structure (e.g. a struct argument): show its fields inline.
  const flat = fields.flatMap((f) => (isFieldGroup(f) && !f.label ? [...(f.warning ? [f] : []), ...f.fields] : [f]));
  const pad = Math.min(
    MAX_LABEL_PAD,
    Math.max(0, ...flat.filter((f): f is DisplayField => !isFieldGroup(f)).map((f) => f.label.length)),
  );
  for (const f of flat) {
    if (isFieldGroup(f)) {
      if (f.label) r.lines.push(`${indent}${f.label}:`);
      if (f.warning) pushWarning(r, indent + INDENT, f.warning);
      if (f.label) renderFields(r, f.fields, indent + INDENT);
      continue;
    }
    if (f.separator) r.lines.push(`${indent}— ${f.separator} —`);
    if (f.embeddedCalldata) {
      const { display, callee, chainId } = f.embeddedCalldata;
      const target = [callee && `to ${callee}`, chainId !== undefined && `on chain ${chainId}`].filter(Boolean);
      r.lines.push(`${indent}${f.label}:${target.length > 0 ? ` (${target.join(" ")})` : ""}`);
      renderModel(r, display, indent + INDENT);
    } else {
      r.lines.push(`${indent}${f.label.padEnd(pad)}  ${fieldValue(f)}`);
    }
    if (f.warning) pushWarning(r, indent + INDENT, f.warning);
  }
}

function renderModel(r: Render, model: DisplayModel, indent: string): void {
  const intent = intentText(model.intent);
  if (intent) r.lines.push(`${indent}Intent:   ${intent}`);
  if (model.interpolatedIntent) r.lines.push(`${indent}Summary:  ${model.interpolatedIntent}`);
  if (model.metadata?.owner) r.lines.push(`${indent}Owner:    ${model.metadata.owner}`);
  if (model.fields?.length) {
    r.lines.push("");
    renderFields(r, model.fields, indent);
  }
  if (model.rawCalldataFallback) {
    const { selector, args } = model.rawCalldataFallback;
    r.lines.push(`${indent}Not clear-signed — raw fallback, selector ${selector}, ${args.length} arg(s):`);
    args.forEach((arg, i) => r.lines.push(`${indent}${INDENT}[${i}] ${arg}`));
  }
  if (model.warnings?.length) {
    r.lines.push("");
    for (const w of model.warnings) pushWarning(r, indent, w);
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

/** What the renderer needs of a transaction: a real one, or a cooked one. */
export interface ParseTx {
  chainId: number;
  to: string;
  /** Calldata, 0x-prefixed. */
  data: string;
  value: bigint;
  /** The sender, for descriptors that show @.from. */
  from?: string;
}

/**
 * Render a transaction against the pinned registry, with token and network
 * metadata from the definitions source. Definitions-source errors are
 * collected rather than thrown, so a source outage still renders (raw).
 */
export async function formatTx(
  selected: Descriptor,
  tx: ParseTx,
  definitions: string | undefined,
  index: RegistryIndex = buildIndex(selected),
): Promise<{ model: DisplayModel; sourceErrors: Set<string> }> {
  const sourceErrors = new Set<string>();
  const model = await format(
    { chainId: tx.chainId, to: tx.to, data: tx.data, value: tx.value, ...(tx.from ? { from: tx.from } : {}) },
    {
      descriptorResolverOptions: {
        type: "custom",
        resolver: createFilesystemResolver({ index, descriptorDirectory: REGISTRY_REPO_ROOT }),
      },
      externalDataProvider: dataProvider(definitions, sourceErrors),
    },
  );
  return { model, sourceErrors };
}

/** The rendered fields in display order, groups flattened, as a wallet lists them. */
export function flatFields(model: DisplayModel): DisplayField[] {
  const out: DisplayField[] = [];
  const walk = (fields: (DisplayField | DisplayFieldGroup)[]) => {
    for (const f of fields) {
      if (isFieldGroup(f)) walk(f.fields);
      else out.push(f);
    }
  };
  walk(model.fields ?? []);
  return out;
}

export const RENDERER = (): string => `${LIBRARY}@${libraryVersion()}`;

export interface ParseOutput {
  /** Heading above the rendered display. */
  title: string;
  /** output/<fileStem>_parsed.json */
  fileStem: string;
  /** Where the transaction came from: an explorer link, or how it was cooked. */
  origin: string;
  /** Extra keys for the saved JSON, e.g. a cooked transaction's fields. */
  extra?: Record<string, unknown>;
}

/** Print, copy and save the standard parse of a transaction; returns the display model. */
export async function parseCalldata(
  descriptor: Descriptor,
  tx: ParseTx,
  definitions: string | undefined,
  out: ParseOutput,
): Promise<DisplayModel> {
  if (!definitions) {
    console.log(dim("No definitions source configured — token amounts and the native currency will render raw."));
  }
  const { model, sourceErrors } = await formatTx(descriptor, tx, definitions);
  for (const message of sourceErrors) console.log(yellow(message));

  const r: Render = { lines: [], warned: false, unnamedAddresses: 0 };
  renderModel(r, model, "");
  await printAndCopy(`${out.title} (${RENDERER()}, as the registry CI renders it):`, r.lines.join("\n"));
  if (r.unnamedAddresses > 0) {
    console.log(dim(`${r.unnamedAddresses} address field(s) shown raw: no ENS or local-name source is wired in.`));
  }
  console.log(
    r.warned ? yellow("The renderer reported warnings — see ⚠ lines above.") : green("✔ Rendered with no warnings."),
  );

  const payload = { transaction: out.origin, ...out.extra, renderer: RENDERER(), display: model };
  const written = writeFixtureFile(
    `${out.fileStem}_parsed.json`,
    JSON.stringify(payload, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2),
  );
  console.log(
    dim(`Full display model saved to ${path.relative(process.cwd(), written.path)}`) +
      (written.overwrote ? dim(" (replaced previous)") : "") +
      "\n",
  );
  return model;
}
