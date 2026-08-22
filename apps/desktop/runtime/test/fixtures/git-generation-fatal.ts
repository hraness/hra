import { BundledGitRunner } from "../../src/workspaces/git-runner";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

const repository = required("HRA_TEST_REPOSITORY");
const checkout = required("HRA_TEST_CHECKOUT");
const runner = new BundledGitRunner(
  {
    bunBinary: process.execPath,
    codexBinary: "/usr/bin/true",
    codexHome: required("HRA_TEST_CODEX_HOME"),
    gitBinary: required("HRA_TEST_GIT_BINARY"),
    gitRoot: required("HRA_TEST_GIT_ROOT"),
  },
  process.env,
  {
    descriptorExecutorBinary: required("HRA_TEST_GIT_EXECUTOR"),
  },
);

// Real `worktree add` emits its preparation diagnostic before materializing
// the checkout. The one-byte boundary injects a post-spawn transport failure
// while a large checkout is still active. Production must end this gateway
// generation; reaching the next statement is itself a fixture failure.
await runner.run(repository, [
  "worktree",
  "add",
  "--detach",
  checkout,
  "HEAD",
], {
  killGraceMs: 1_000,
  stderrLimitBytes: 1,
  stdoutLimitBytes: 1_024,
  terminateGraceMs: 50,
  timeoutMs: 30_000,
});

process.exit(87);
