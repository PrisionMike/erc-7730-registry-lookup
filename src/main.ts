import path from "node:path";
import { input, search, select } from "@inquirer/prompts";
import { cook, type SupportTarget } from "./cook.js";
import { EtherscanError, findSampleTx, MAX_SEARCH_DEPTH, type SampleTx } from "./etherscan.js";
import { chainName, explorerTxUrl } from "./explorers.js";
import { fixtureJson, slug, trezorctlCommand } from "./generate.js";
import { showRegistryJson } from "./jsonView.js";
import {
  DEV_DEFINITIONS_URL,
  DEV_SIGNED_DEFINITIONS_URL,
  findDefinition,
  normalizeSource,
  PROD_DEFINITIONS_URL,
} from "./definitionsSource.js";
import { saveFixtureDefinitions, type FixtureTarget } from "./fixtureDefinitions.js";
import {
  definitionsPath,
  definitionsSourceKind,
  saveDefinitionsPath,
  saveDefinitionsSourceKind,
  testWallet,
  type DefinitionsSourceKind,
} from "./localConfig.js";
import { writeFixtureFile } from "./output.js";
import { parseCalldata } from "./parse.js";
import { GitError, registryState, updateTo, type RegistryState } from "./registryGit.js";
import { pinLine, printOutcome } from "./registryReport.js";
import { TarballError } from "./tarball.js";
import { bold, dim, green, printAndCopy, truncate, yellow } from "./ui.js";
import {
  DescriptorError,
  listDescriptorFiles,
  listProviders,
  loadDescriptor,
  type Deployment,
  type Descriptor,
  type FunctionEntry,
} from "./registry.js";

const BACK = Symbol("back");

type Screen =
  | { kind: "home" }
  | { kind: "registry" }
  | { kind: "definitions" }
  | { kind: "providers" }
  | { kind: "descriptors"; provider: string }
  | { kind: "functions"; descriptor: Descriptor }
  | { kind: "deployments"; descriptor: Descriptor; fn: FunctionEntry }
  | { kind: "actions"; descriptor: Descriptor; fn: FunctionEntry; deployment: Deployment; sampleTx?: SampleTx | null };

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** search prompt over a fixed list of choices, with a Back entry pinned first. */
async function filterableList<T>(
  message: string,
  entries: { name: string; value: T; description?: string }[],
  backLabel: string,
): Promise<T | typeof BACK> {
  const backChoice = { name: backLabel, value: BACK as T | typeof BACK };
  const choices = [backChoice, ...entries];
  return search<T | typeof BACK>({
    message,
    source: (term) => {
      if (!term) return choices;
      const t = term.toLowerCase();
      return [backChoice, ...entries.filter((e) => e.name.toLowerCase().includes(t))];
    },
    pageSize: 15,
  });
}

async function ensureSampleTx(screen: Extract<Screen, { kind: "actions" }>): Promise<SampleTx | null> {
  const { deployment, fn } = screen;
  if (screen.sampleTx === undefined) {
    console.log(
      dim(
        `Fetching recent ${fn.name} (${fn.selector}) transactions to ${deployment.address} on ${chainName(deployment.chainId)}…`,
      ),
    );
    try {
      screen.sampleTx = await findSampleTx(deployment.chainId, deployment.address, fn.selector);
    } catch (err) {
      if (err instanceof EtherscanError) {
        console.log(yellow(`Explorer lookup failed: ${err.message}`));
        return null;
      }
      throw err;
    }
  }
  if (screen.sampleTx === null) {
    console.log(
      yellow(
        `No successful tx matching ${fn.selector} in the last ${MAX_SEARCH_DEPTH} txs (Etherscan's search limit) to this contract on ${chainName(deployment.chainId)}.` +
          (screen.descriptor.deployments.length > 1 ? " Try another deployment (go back one step)." : ""),
      ),
    );
  }
  return screen.sampleTx;
}

/** What --definitions gets for the selected source: a tarball path or a URL; undefined omits the flag. */
async function resolveDefinitionsSource(): Promise<string | undefined> {
  const kind = definitionsSourceKind();
  if (kind === "dev") return DEV_DEFINITIONS_URL;
  if (kind === "dev-signed") return DEV_SIGNED_DEFINITIONS_URL;
  if (kind === "prod") return PROD_DEFINITIONS_URL;
  const existing = definitionsPath();
  if (existing !== undefined) return normalizeSource(existing) || undefined;
  const answer = (
    await input({
      message:
        "Path to Trezor definitions tarball — deploy.tar.xz or definitions.tar.xz — for --definitions (leave empty to omit the flag):",
    })
  ).trim();
  saveDefinitionsPath(answer);
  if (answer) {
    console.log(dim("Saved. Override later with TREZOR_DEFINITIONS, by editing config.local.json, or via “Definitions source” on the home screen."));
  }
  return normalizeSource(answer) || undefined;
}

function describeDefinitionsSource(kind: DefinitionsSourceKind): string {
  switch (kind) {
    case "dev":
      return `Dev definitions (${DEV_DEFINITIONS_URL})`;
    case "dev-signed":
      return `Dev signed definitions (${DEV_SIGNED_DEFINITIONS_URL})`;
    case "prod":
      return `Prod definitions (${PROD_DEFINITIONS_URL})`;
    case "tarball":
      return `Tarball (${definitionsPath() || "none — --definitions omitted"})`;
  }
}

/** Startup must never abort just because the registry cannot be read. */
async function registryBanner(): Promise<string> {
  try {
    const state = await registryState();
    return dim(`Registry: ${pinLine(state)}`) + (state.dirty ? yellow(" (working tree dirty)") : "");
  } catch (err) {
    if (err instanceof GitError) return yellow(`Registry: ${err.message}`);
    throw err;
  }
}

/** Move the registry submodule to upstream tip, or to a ref the user names. */
async function updateRegistry(target: "latest" | "ref", stack: Screen[]): Promise<void> {
  let ref: string | undefined;
  if (target === "ref") {
    ref = (await input({ message: "Commit hash, tag or ref:" })).trim();
    if (!ref) return;
  }
  try {
    const moved = printOutcome(await updateTo(ref, () => console.log(dim("Fetching origin…"))));
    if (moved) {
      // Nothing above the registry screen can survive a registry change: a cached
      // Descriptor would point at files that may no longer exist. The screen is only
      // reachable from home, so this is a no-op today — keep it that way.
      stack.length = Math.min(stack.length, 2);
    }
  } catch (err) {
    if (err instanceof GitError) {
      console.log(yellow(err.message));
      return;
    }
    throw err;
  }
}

/**
 * Whether the definitions source (tarball or URL) has a definition for this
 * function-contract-deployment. Returns undefined when none is configured or
 * it cannot be read.
 */
async function checkSupport(target: SupportTarget, { verbose }: { verbose: boolean }): Promise<boolean | undefined> {
  const defs = await resolveDefinitionsSource();
  if (!defs) {
    if (verbose) console.log(yellow("No definitions source configured — cannot check Trezor support."));
    return undefined;
  }
  let entry: string;
  let supported: boolean;
  try {
    ({ entry, found: supported } = await findDefinition(defs, target.chainId, target.address, target.selector));
  } catch (err) {
    if (err instanceof TarballError) {
      console.log(yellow(err.message));
      return undefined;
    }
    throw err;
  }
  if (verbose) {
    console.log(
      supported
        ? green(`✔ Supported — the definitions source contains ${entry}`)
        : yellow(`✗ Not supported — ${entry} is not in the definitions source.`),
    );
  }
  return supported;
}

/** Write the fixture to output/, then the definitions its test needs, as JSON beside it. */
async function saveFixture(fileName: string, target: FixtureTarget, json: string): Promise<void> {
  const written = writeFixtureFile(fileName, json);
  console.log(green(`✔ Fixture saved to ${path.relative(process.cwd(), written.path)}`) + (written.overwrote ? dim(" (replaced previous)") : ""));

  const defs = await resolveDefinitionsSource();
  if (!defs) return;
  await saveFixtureDefinitions(defs, target);
}

async function runAction(action: string, screen: Extract<Screen, { kind: "actions" }>): Promise<void> {
  if (action === "cook") {
    await cook({
      descriptor: screen.descriptor,
      fn: screen.fn,
      deployment: screen.deployment,
      sampleTx: () => ensureSampleTx(screen),
      definitionsSource: resolveDefinitionsSource,
      checkSupport,
      saveFixture,
    });
    return;
  }

  const target = { chainId: screen.deployment.chainId, address: screen.deployment.address, selector: screen.fn.selector };
  const needsSupport = action === "support" || action === "fixture" || action === "all";
  const supported = needsSupport ? await checkSupport(target, { verbose: action !== "fixture" }) : undefined;
  if (action === "support") return;

  if (action === "format" || action === "descriptor") {
    try {
      await showRegistryJson(action, screen.descriptor, screen.fn);
    } catch (err) {
      if (err instanceof DescriptorError) {
        console.log(yellow(err.message));
        return;
      }
      throw err;
    }
    return;
  }

  const tx = await ensureSampleTx(screen);
  if (!tx) return;
  const { descriptor, fn, deployment } = screen;
  const stem = slug(descriptor.provider, descriptor.name, fn.name);
  const txUrl = explorerTxUrl(deployment.chainId, tx.hash);

  if (action === "command" || action === "all") {
    const defs = await resolveDefinitionsSource();
    await printAndCopy("trezorctl command:", trezorctlCommand(tx, deployment.chainId, defs));
  }
  if (action === "link" || action === "all") {
    await printAndCopy("Etherscan link:", txUrl);
  }
  if (action === "parse" || action === "all") {
    const parseTx = {
      chainId: deployment.chainId,
      to: tx.to,
      data: tx.input,
      value: BigInt(tx.value),
      ...(tx.from ? { from: tx.from } : {}),
    };
    await parseCalldata(descriptor, parseTx, await resolveDefinitionsSource(), {
      title: "Standard parse",
      fileStem: `${stem}_${deployment.chainId}`,
      origin: txUrl,
    });
  }
  if (action === "fixture" || action === "all") {
    const wallet = testWallet();
    if (!wallet) {
      console.log(dim("No testWallet in config.local.json — result signatures left empty."));
    }
    const json = await fixtureJson(stem, txUrl, tx, deployment.chainId, supported, wallet);
    await printAndCopy("Device test fixture:", json);
    await saveFixture(`${stem}_${deployment.chainId}.json`, { ...target, supported, calldata: tx.input, functionKey: fn.key }, json);
  }
}

async function showScreen(screen: Screen, stack: Screen[]): Promise<void> {
  switch (screen.kind) {
    case "home": {
      const choice = await select<string | typeof BACK>({
        message: "What do you want to do?",
        choices: [
          { name: "Browse the registry", value: "browse" },
          { name: "Registry (update / pin info)", value: "registry" },
          {
            name: "Definitions source (tarball / dev / dev signed / prod)",
            value: "definitions",
            description: dim(`Current: ${describeDefinitionsSource(definitionsSourceKind())}`),
          },
          { name: "✕ Exit", value: BACK },
        ],
      });
      if (choice === BACK) {
        stack.pop();
        return;
      }
      stack.push(
        choice === "registry"
          ? { kind: "registry" }
          : choice === "definitions"
            ? { kind: "definitions" }
            : { kind: "providers" },
      );
      return;
    }

    case "definitions": {
      const current = definitionsSourceKind();
      const label = (kind: DefinitionsSourceKind, name: string) => (kind === current ? `${name} (current)` : name);
      const choice = await select<DefinitionsSourceKind | typeof BACK>({
        message: "Where should definitions come from?",
        default: current,
        choices: [
          {
            name: label("tarball", "Tarball"),
            value: "tarball",
            description: dim(`Local deploy.tar.xz / definitions.tar.xz — currently ${definitionsPath() || "not set"}`),
          },
          {
            name: label("dev", "Dev definitions"),
            value: "dev",
            description: dim(`${DEV_DEFINITIONS_URL} (trezor/definitions “unsigned dev” deploy, v2)`),
          },
          {
            name: label("dev-signed", "Dev signed definitions"),
            value: "dev-signed",
            description: dim(`${DEV_SIGNED_DEFINITIONS_URL} (dev channel, signed, v2)`),
          },
          {
            name: label("prod", "Prod definitions"),
            value: "prod",
            description: dim(`${PROD_DEFINITIONS_URL} (data.trezor.io, v2)`),
          },
          { name: "← Back", value: BACK },
        ],
      });
      if (choice === BACK) {
        stack.pop();
        return;
      }
      if (choice === "tarball") {
        const answer = (
          await input({
            message: "Path to Trezor definitions tarball (or URL) for --definitions (leave empty to omit the flag):",
            default: definitionsPath() || undefined,
          })
        ).trim();
        saveDefinitionsPath(answer);
        if (process.env.TREZOR_DEFINITIONS !== undefined) {
          console.log(yellow("TREZOR_DEFINITIONS is set and takes precedence over the saved path."));
        }
      }
      saveDefinitionsSourceKind(choice);
      console.log(green(`✔ Definitions source: ${describeDefinitionsSource(choice)}`));
      stack.pop();
      return;
    }

    case "registry": {
      // Re-read on every visit, so the pin shown is always current after an update.
      let state: RegistryState | undefined;
      try {
        state = await registryState();
      } catch (err) {
        if (!(err instanceof GitError)) throw err;
        console.log(yellow(err.message));
      }
      const choice = await select<string | typeof BACK>({
        message: state ? `Registry — pinned at ${pinLine(state)}` : "Registry",
        choices: [
          {
            name: `Update to the latest upstream commit (origin/${state?.defaultBranch ?? "master"})`,
            value: "latest",
          },
          { name: "Check out a specific commit or ref…", value: "ref" },
          { name: "← Back", value: BACK },
        ],
      });
      if (choice === BACK) {
        stack.pop();
        return;
      }
      await updateRegistry(choice === "ref" ? "ref" : "latest", stack);
      return;
    }

    case "providers": {
      const providers = listProviders();
      const choice = await filterableList(
        "Select a provider (type to filter):",
        providers.map((p) => ({ name: p, value: p })),
        "← Back",
      );
      if (choice === BACK) {
        stack.pop();
        return;
      }
      stack.push({ kind: "descriptors", provider: choice });
      return;
    }

    case "descriptors": {
      const files = listDescriptorFiles(screen.provider);
      if (files.length === 0) {
        console.log(yellow(`${screen.provider} has no calldata descriptors (EIP-712 only?).`));
        stack.pop();
        return;
      }
      const choice = await filterableList(
        `${screen.provider} — select a contract descriptor:`,
        files.map((f) => ({ name: f.replace(/^calldata-/, "").replace(/\.json$/, ""), value: f })),
        "← Back",
      );
      if (choice === BACK) {
        stack.pop();
        return;
      }
      let descriptor: Descriptor;
      try {
        descriptor = loadDescriptor(screen.provider, choice);
      } catch (err) {
        if (err instanceof DescriptorError) {
          console.log(yellow(err.message));
          return;
        }
        throw err;
      }
      if (descriptor.skippedKeys.length > 0) {
        console.log(dim(`Skipped ${descriptor.skippedKeys.length} unparseable format key(s).`));
      }
      stack.push({ kind: "functions", descriptor });
      return;
    }

    case "functions": {
      const { descriptor } = screen;
      const owner = descriptor.owner ? ` (${descriptor.owner})` : "";
      const fn = await select<FunctionEntry | typeof BACK>({
        message: `${descriptor.provider}/${descriptor.name}${owner} — select a function:`,
        choices: [
          { name: "← Back", value: BACK },
          ...descriptor.functions.map((f) => ({
            name: f.intent ? `${f.name} — ${f.intent}` : f.name,
            value: f,
            description: dim(`${f.selector}  ${truncate(f.signature ?? "", 100)}`),
          })),
        ],
        pageSize: 15,
      });
      if (fn === BACK) {
        stack.pop();
        return;
      }
      stack.push({ kind: "deployments", descriptor, fn });
      return;
    }

    case "deployments": {
      const { descriptor, fn } = screen;
      const deployment = await select<Deployment | typeof BACK>({
        message: `${fn.name} — select a deployment (chain):`,
        choices: [
          { name: "← Back", value: BACK },
          ...descriptor.deployments.map((d) => ({
            name: `${chainName(d.chainId)} (${d.chainId}) — ${shorten(d.address)}`,
            value: d,
            description: dim(d.address),
          })),
        ],
        pageSize: 15,
      });
      if (deployment === BACK) {
        stack.pop();
        return;
      }
      stack.push({ kind: "actions", descriptor, fn, deployment });
      return;
    }

    case "actions": {
      const { descriptor, fn, deployment } = screen;
      const action = await select<string | typeof BACK>({
        message: `${descriptor.provider}/${descriptor.name} · ${fn.name} · ${chainName(deployment.chainId)} — what do you need?`,
        choices: [
          { name: "trezorctl command (from a real Etherscan payload)", value: "command" },
          { name: "Etherscan link to a real transaction", value: "link" },
          { name: "Standard parse of that transaction's calldata (registry CI renderer)", value: "parse" },
          { name: "Device test fixture JSON (saved to output/)", value: "fixture" },
          { name: "Check Trezor support (is the definition in the definitions source?)", value: "support" },
          { name: "All of the above", value: "all" },
          {
            name: "Cook a transaction — edit a real one's fields, then generate any of the above",
            value: "cook",
            description: dim("Start from the latest on-chain tx or a registry test case; change amounts, addresses, dates, msg.value, chain id…"),
          },
          { name: "Show the registry's display format for this function (JSON)", value: "format" },
          { name: "Show the whole descriptor file (JSON)", value: "descriptor" },
          { name: "← Back", value: BACK },
        ],
      });
      if (action === BACK) {
        stack.pop();
        return;
      }
      await runAction(action, screen);
      return;
    }
  }
}

async function main(): Promise<void> {
  console.log(bold("ERC-7730 registry lookup — Trezor clear-signing QA helper"));
  console.log((await registryBanner()) + "\n");

  const stack: Screen[] = [{ kind: "home" }];
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    await showScreen(top, stack);
  }
  console.log(dim("Bye."));
}

main().catch((err) => {
  if (err instanceof Error && err.name === "ExitPromptError") {
    console.log(dim("\nBye."));
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});
