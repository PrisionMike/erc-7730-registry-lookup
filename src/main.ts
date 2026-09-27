import path from "node:path";
import { input, search, select } from "@inquirer/prompts";
import { EtherscanError, findSampleTx, MAX_SEARCH_DEPTH, type SampleTx } from "./etherscan.js";
import { chainName, explorerTxUrl } from "./explorers.js";
import { fixtureJson, slug, trezorctlCommand } from "./generate.js";
import { showRegistryJson } from "./jsonView.js";
import { definitionsPath, saveDefinitionsPath, testWallet } from "./localConfig.js";
import { OUTPUT_DIR, writeFixtureFile } from "./output.js";
import { parseCalldata } from "./parse.js";
import { GitError, registryState, updateTo, type RegistryState } from "./registryGit.js";
import { pinLine, printOutcome } from "./registryReport.js";
import { extractDefinition, findDefinition, TarballError } from "./tarball.js";
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

async function resolveDefinitionsPath(): Promise<string | undefined> {
  const existing = definitionsPath();
  if (existing !== undefined) return existing || undefined;
  const answer = (
    await input({
      message:
        "Path to Trezor definitions tarball — deploy.tar.xz or definitions.tar.xz — for --definitions (leave empty to omit the flag):",
    })
  ).trim();
  saveDefinitionsPath(answer);
  if (answer) {
    console.log(dim("Saved. Override later with TREZOR_DEFINITIONS or by editing config.local.json"));
  }
  return answer || undefined;
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
 * Whether the tarball has a definition for this function-contract-deployment.
 * Returns undefined when no tarball is configured or it cannot be read.
 */
async function checkSupport(
  screen: Extract<Screen, { kind: "actions" }>,
  { verbose }: { verbose: boolean },
): Promise<boolean | undefined> {
  const defs = await resolveDefinitionsPath();
  if (!defs) {
    if (verbose) console.log(yellow("No definitions tarball configured — cannot check Trezor support."));
    return undefined;
  }
  const { fn, deployment } = screen;
  let entry: string;
  let supported: boolean;
  try {
    ({ entry, found: supported } = await findDefinition(
      defs,
      deployment.chainId,
      deployment.address,
      fn.selector,
    ));
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
        ? green(`✔ Supported — the tarball contains ${entry}`)
        : yellow(`✗ Not supported — ${entry} is not in the tarball.`),
    );
  }
  return supported;
}

async function saveFixture(
  screen: Extract<Screen, { kind: "actions" }>,
  json: string,
  supported: boolean | undefined,
): Promise<void> {
  const { descriptor, fn, deployment } = screen;
  const fileName = `${slug(descriptor.provider, descriptor.name, fn.name)}_${deployment.chainId}.json`;
  const written = writeFixtureFile(fileName, json);
  console.log(green(`✔ Fixture saved to ${path.relative(process.cwd(), written.path)}`) + (written.overwrote ? dim(" (replaced previous)") : ""));

  if (!supported) return;
  const defs = await resolveDefinitionsPath();
  if (!defs) return;
  try {
    const extracted = await extractDefinition(
      defs,
      deployment.chainId,
      deployment.address,
      fn.selector,
      OUTPUT_DIR,
    );
    const rel = path.relative(process.cwd(), extracted.path);
    console.log(extracted.alreadyExtracted ? dim(`Definition already extracted: ${rel}`) : green(`✔ Definition extracted to ${rel}`));
  } catch (err) {
    if (err instanceof TarballError) {
      console.log(yellow(err.message));
      return;
    }
    throw err;
  }
}

async function runAction(action: string, screen: Extract<Screen, { kind: "actions" }>): Promise<void> {
  const needsSupport = action === "support" || action === "fixture" || action === "all";
  const supported = needsSupport ? await checkSupport(screen, { verbose: action !== "fixture" }) : undefined;
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
  const selection = { provider: descriptor.provider, descriptorName: descriptor.name, functionName: fn.name };

  if (action === "command" || action === "all") {
    const defs = await resolveDefinitionsPath();
    await printAndCopy("trezorctl command:", trezorctlCommand(tx, deployment.chainId, defs));
  }
  if (action === "link" || action === "all") {
    await printAndCopy("Etherscan link:", explorerTxUrl(deployment.chainId, tx.hash));
  }
  if (action === "parse" || action === "all") {
    await parseCalldata(descriptor, fn, deployment, tx, await resolveDefinitionsPath());
  }
  if (action === "fixture" || action === "all") {
    const wallet = testWallet();
    if (!wallet) {
      console.log(dim("No testWallet in config.local.json — result signatures left empty."));
    }
    const json = await fixtureJson(selection, tx, deployment.chainId, supported, wallet);
    await printAndCopy("Device test fixture:", json);
    await saveFixture(screen, json, supported);
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
          { name: "✕ Exit", value: BACK },
        ],
      });
      if (choice === BACK) {
        stack.pop();
        return;
      }
      stack.push(choice === "registry" ? { kind: "registry" } : { kind: "providers" });
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
          { name: "Check Trezor support (is the definition in the tarball?)", value: "support" },
          { name: "All of the above", value: "all" },
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
