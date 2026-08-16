import { resolve } from "node:path";

import { resolveZigExecutable } from "./zig-toolchain";

const workerBudgetVariable = "HRA_CHECK_WORKER_BUDGET";

export function zigArgumentsWithWorkerBudget(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const configured = environment[workerBudgetVariable];
  if (
    arguments_[0] !== "build"
    || configured === undefined
    || arguments_.some((argument) => argument.startsWith("-j"))
  ) {
    return [...arguments_];
  }
  if (!/^[1-9][0-9]*$/u.test(configured)) {
    throw new Error(`${workerBudgetVariable} must be a positive integer`);
  }
  const workerBudget = Number.parseInt(configured, 10);
  if (!Number.isSafeInteger(workerBudget)) {
    throw new Error(`${workerBudgetVariable} must be a safe integer`);
  }
  return ["build", `-j${workerBudget}`, ...arguments_.slice(1)];
}

async function main(): Promise<void> {
  const desktopRoot = resolve(import.meta.dir, "..");
  const child = Bun.spawn(
    [
      resolveZigExecutable(),
      ...zigArgumentsWithWorkerBudget(process.argv.slice(2)),
    ],
    {
      cwd: desktopRoot,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  process.exitCode = await child.exited;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
