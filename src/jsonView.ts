import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { confirm } from "@inquirer/prompts";
import { copy } from "./clipboard.js";
import { slug } from "./generate.js";
import { writeFixtureFile } from "./output.js";
import { loadDescriptorChain, loadFormatBlock, type Descriptor, type FunctionEntry } from "./registry.js";
import { bold, dim, green, printAndCopy, yellow } from "./ui.js";

/** Above this, dumping to the terminal buries everything that came before it. */
const MAX_INLINE_LINES = 120;
const PREVIEW_LINES = 40;

const UNRESOLVED = "<not defined anywhere in the include chain>";

async function openPager(filePath: string): Promise<void> {
  const [command, ...args] = (process.env.PAGER ?? "less -R").split(/\s+/).filter(Boolean);
  if (command === undefined) return;
  try {
    await new Promise<void>((resolve, reject) => {
      // Hand the pager a real file rather than piping: `less` needs stdin for the
      // keyboard, so content on stdin leaves it unnavigable.
      const child = spawn(command, [...args, filePath], { stdio: "inherit" });
      child.on("error", reject);
      child.on("close", () => resolve());
    });
  } catch (err) {
    console.log(yellow(`Cannot open ${command}: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * Print, copy and save one JSON dump. Always writes the file: the pager needs
 * one, and a long dump outlives terminal scrollback.
 */
async function deliver(label: string, text: string, fileName: string): Promise<void> {
  const written = writeFixtureFile(fileName, text);
  const rel = path.relative(process.cwd(), written.path);
  const lines = text.split("\n");

  if (lines.length <= MAX_INLINE_LINES) {
    await printAndCopy(label, text);
    console.log(dim(`Saved to ${rel}`) + (written.overwrote ? dim(" (replaced previous)") : "") + "\n");
    return;
  }

  console.log(`\n${bold(label)}`);
  console.log(lines.slice(0, PREVIEW_LINES).join("\n"));
  console.log(dim(`… ${lines.length - PREVIEW_LINES} more lines`));
  if (await copy(text)) {
    console.log(green("✔ Copied to clipboard."));
  } else {
    console.log(yellow("Clipboard unavailable (install xclip or wl-clipboard)."));
  }
  console.log(green(`✔ Saved to ${rel}`));
  if (await confirm({ message: "Open it in a pager?", default: true })) {
    await openPager(written.path);
  }
}

/**
 * Dump what the registry says about the selected function: either the resolved
 * display-format block, or the descriptor file verbatim.
 */
export async function showRegistryJson(
  action: "format" | "descriptor",
  descriptor: Descriptor,
  fn: FunctionEntry,
): Promise<void> {
  if (action === "descriptor") {
    const chain = loadDescriptorChain(descriptor.filePath);
    console.log(`\n${dim(`File: ${chain[0]?.displayPath ?? descriptor.filePath}`)}`);
    if (chain.length > 1) {
      console.log(dim(`Includes: ${chain.slice(1).map((f) => f.displayPath).join(" → ")}`));
      console.log(dim("This file may define no formats of its own — use the display-format action for the resolved block."));
    }
    // Verbatim, so the registry's own key order and formatting survive.
    await deliver(
      `${descriptor.provider}/${descriptor.name} — descriptor file:`,
      readFileSync(descriptor.filePath, "utf8"),
      `${slug(descriptor.provider, descriptor.name)}_descriptor.json`,
    );
    return;
  }

  const found = loadFormatBlock(descriptor.filePath, fn.key);
  console.log(`\n${dim(`Source: ${found.source.displayPath}`)}`);
  if (found.source.filePath !== descriptor.filePath) {
    console.log(dim(`Via: ${found.chain.map((f) => f.displayPath).join(" → ")}`));
  }
  if (found.matchedBySelector) {
    console.log(yellow(`Matched on selector ${fn.selector}; the owning file spells the key as:\n  ${found.key}`));
  }

  const references: Record<string, unknown> = {};
  for (const reference of found.references) {
    references[reference.ref] = reference.source ? reference.value : UNRESOLVED;
  }

  // A wrapper rather than the bare block: the block alone is full of "$." pointers,
  // and the resolved values are the half that says what actually gets displayed.
  const payload = {
    function: found.key,
    selector: fn.selector,
    source: found.source.displayPath,
    format: found.block,
    ...(found.references.length > 0 ? { references } : {}),
  };

  await deliver(
    `${descriptor.provider}/${descriptor.name} · ${fn.name} — registry display format:`,
    JSON.stringify(payload, null, 2),
    `${slug(descriptor.provider, descriptor.name, fn.name)}_format.json`,
  );
}
