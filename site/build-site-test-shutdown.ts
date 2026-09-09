import type { siteTestBuildTerminal } from "./build-site-test-protocol";

type Terminal = ReturnType<typeof siteTestBuildTerminal.parse>;

export async function finishSiteTestBuild(
  build: () => Promise<readonly string[]>,
  stop: () => Promise<void>,
): Promise<Terminal> {
  let outcome: { status: "success"; mismatches: string[] } | { status: "failure"; error: unknown };
  try {
    outcome = { status: "success", mismatches: [...await build()] };
  } catch (error: unknown) {
    outcome = { status: "failure", error };
  }
  try {
    // This requests shutdown only. The unchanged parent still requires
    // process exit and proven collection before accepting this terminal.
    await stop();
  } catch (error: unknown) {
    throw new AggregateError([
      ...(outcome.status === "success" ? [] : [new Error("SITE_COMPILER_BUILD_FAILED", { cause: outcome.error })]),
      new Error("SITE_COMPILER_SHUTDOWN_FAILED", { cause: error }),
    ], "SITE_COMPILER_SHUTDOWN_FAILED");
  }
  if (outcome.status === "success") return outcome;
  const error = outcome.error;
  return error instanceof Error
    ? { status: "failure", name: error.name, message: error.message, stack: error.stack }
    : { status: "failure", name: "Error", message: String(error) };
}
