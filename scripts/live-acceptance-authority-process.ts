import {
  requireBoundedProcessCleanup,
  runBoundedProcess,
} from "./bounded-process";
import type { CommandRunner } from "./configure-hosted-sync";

/** Acceptance authority calls must not inherit the ordinary hosted CLI runner. */
export const createLiveAcceptanceAuthorityCommandRunner = (
  run: typeof runBoundedProcess = runBoundedProcess,
): CommandRunner => async (request) => {
  const maximumBytes = request.outputMaximumBytes ?? 64 * 1024;
  const timeoutMs = request.timeoutMs ?? 60_000;
  if (
    request.containment !== "authority"
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > 1024 * 1024
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 120_000
  ) throw new Error("live_acceptance_authority_command_invalid");
  const result = await run({
    arguments: [...request.arguments],
    containment: "authority",
    cwd: request.cwd,
    environment: { ...request.environment },
    executable: request.executable,
    killSettlementMs: 1_000,
    outputMaximumBytes: maximumBytes,
    phase: request.phase,
    stdin: request.stdin,
    terminationGraceMs: 250,
    timeoutMs,
  });
  try {
    const completed = requireBoundedProcessCleanup(result);
    if (
      completed.stdout.byteLength > maximumBytes
      || completed.stderr.byteLength > maximumBytes
      || !Number.isSafeInteger(completed.exitCode)
    ) throw new Error("live_acceptance_authority_output_invalid");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      exitCode: completed.exitCode,
      stderr: decoder.decode(completed.stderr),
      stdout: decoder.decode(completed.stdout),
    };
  } finally {
    result.stdout.fill(0);
    result.stderr.fill(0);
  }
};

export const runLiveAcceptanceAuthorityCommand = createLiveAcceptanceAuthorityCommandRunner();
