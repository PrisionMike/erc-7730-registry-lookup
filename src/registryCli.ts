import { GitError, registryState, updateTo } from "./registryGit.js";
import { pinLine, printOutcome } from "./registryReport.js";
import { dim, yellow } from "./ui.js";

const USAGE = `Usage:
  npm run registry:status            show the pinned registry commit
  npm run registry:update            move to the latest upstream commit
  npm run registry:update -- <ref>   move to a specific commit hash, tag or ref`;

async function run(): Promise<void> {
  const command = process.argv[2];
  const ref = process.argv[3];

  if (command === "status") {
    const state = await registryState();
    console.log(pinLine(state));
    if (state.dirty) console.log(yellow(`working tree dirty (${state.dirtyPaths.length} path(s))`));
    return;
  }

  if (command === "update") {
    const outcome = await updateTo(ref, () => console.log(dim("Fetching origin…")));
    printOutcome(outcome);
    // A refusal is a failure for anything scripting this; "already there" is not.
    if (outcome.kind === "dirty") process.exit(1);
    return;
  }

  console.error(USAGE);
  process.exit(2);
}

run().catch((err: unknown) => {
  console.error(yellow(err instanceof GitError ? err.message : String(err)));
  process.exit(1);
});
