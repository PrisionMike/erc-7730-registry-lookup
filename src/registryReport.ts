import type { RegistryState, UpdateOutcome, UpdateSummary } from "./registryGit.js";
import { bold, dim, green, truncate, yellow } from "./ui.js";

export function pinLine(state: RegistryState): string {
  const where = state.branch ? ` on ${state.branch}` : " (detached)";
  return `${state.commit.short} ${state.commit.date.slice(0, 10)}${where} — ${truncate(state.commit.subject, 60)}`;
}

const MAX_LISTED_CHANGES = 15;

function reportChanges(sum: UpdateSummary): void {
  if (sum.changedDescriptors.length === 0) {
    console.log(dim("No descriptor files changed."));
  } else {
    console.log(bold(`${sum.changedDescriptors.length} descriptor file(s) changed:`));
    for (const change of sum.changedDescriptors.slice(0, MAX_LISTED_CHANGES)) {
      console.log(`  ${change.status}  ${change.file}`);
    }
    if (sum.changedDescriptors.length > MAX_LISTED_CHANGES) {
      console.log(dim(`  … and ${sum.changedDescriptors.length - MAX_LISTED_CHANGES} more`));
    }
  }
  if (sum.newProviders.length > 0) console.log(green(`New providers: ${sum.newProviders.join(", ")}`));
  if (sum.removedProviders.length > 0) console.log(yellow(`Removed providers: ${sum.removedProviders.join(", ")}`));
  console.log(dim(`Full log: git -C registry log --oneline ${sum.from.short}..${sum.to.short}`));
}

/** Render an updateTo() result. Returns true when the submodule actually moved. */
export function printOutcome(outcome: UpdateOutcome): boolean {
  switch (outcome.kind) {
    case "dirty": {
      const { dirtyPaths } = outcome.state;
      console.log(yellow("registry/ has uncommitted changes — refusing to move it:"));
      for (const p of dirtyPaths.slice(0, 5)) console.log(dim(`  ${p}`));
      if (dirtyPaths.length > 5) console.log(dim(`  … and ${dirtyPaths.length - 5} more`));
      console.log(`Discard them first: ${bold("git -C registry checkout . && git -C registry clean -fd")}`);
      return false;
    }
    case "already": {
      const { commit } = outcome;
      console.log(green(`Already at ${commit.short} (${commit.date.slice(0, 10)}) — ${commit.subject}`));
      return false;
    }
    case "moved": {
      const sum = outcome.summary;
      console.log(
        green(`✔ Moved ${sum.from.short} → ${sum.to.short}`) +
          dim(` (${sum.commitCount} commit(s), ${sum.changedTotal} file(s) changed)`),
      );
      reportChanges(sum);
      console.log(
        yellow("\nThe parent repo now shows `registry` as modified. To pin it:") +
          `\n  ${bold(`git add registry && git commit -m "Bump registry to ${sum.to.short}"`)}` +
          dim("\n  …or `git submodule update --checkout registry` to go back to the pinned commit.\n"),
      );
      return true;
    }
  }
}
