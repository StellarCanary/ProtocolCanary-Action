import * as core from "@actions/core";

// Placeholder entry point: proves the project builds and the Action
// runtime is wired up correctly. Replaced with the real orchestration
// once inputs, installation, execution, reporting, and summary/annotation
// support all exist (see CONTRIBUTING.md's repository structure table).
export async function run(): Promise<void> {
  core.info("Stellar Protocol Canary Action: scaffolding only, not yet implemented.");
}

/* istanbul ignore next */
if (require.main === module) {
  run().catch((error: unknown) => {
    core.setFailed(error instanceof Error ? error.message : String(error));
  });
}
