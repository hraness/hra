import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const mainSource = await readFile(
  new URL("../src/main.ts", import.meta.url),
  "utf8",
);

describe("Main harness shutdown ordering", () => {
  test("uses the canonical HRA promoted-runner binding kind", () => {
    expect(mainSource).toContain('kind: "hra";');
    expect(mainSource).toContain('kind: "hra",');
    expect(mainSource).not.toContain('kind: "oprte"');
    expect(mainSource).not.toContain('binding.kind === "oprte"');
  });

  test("router shutdown preserves resumable pane bindings", () => {
    const initialization = sourceBetween(
      "async function initializeGateway(): Promise<void>",
      "async function quiesceGatewayForLocalDataRemoval(): Promise<void>",
    );
    expect(initialization).toContain(
      'cause === "provider_lifecycle"',
    );
    expect(initialization).toContain(
      "?.handleAccountUnavailable(accountProfileId, {",
    );
  });

  test("sweeps verified terminal archive authority before exact admission replay", () => {
    const initialization = sourceBetween(
      "async function initializeGateway(): Promise<void>",
      "async function quiesceGatewayForLocalDataRemoval(): Promise<void>",
    );
    expect(initialization).not.toContain(
      "providerThreadArchiveJournalV57.recoveryInventory()",
    );
    expect(
      initialization.match(/installArchiveAdmissionReplayV57\(/g) ?? [],
    ).toHaveLength(1);
    expect(
      initialization.match(
        /sweepProviderThreadArchiveTerminalAuthorityV57\(/g,
      ) ?? [],
    ).toHaveLength(1);
    expect(initialization).not.toContain("deleteAllTerminalAuthoritySafely");
    expect(initialization).not.toContain(
      "deleteContainedZeroTargetRemovalCutSafely",
    );
    expect(initialization).toContain(
      `initializedAccountService.installArchiveAdmissionReplayV57(
        verifiedProviderThreadArchiveRecoveryInventoryV57,
      )`,
    );
    expect(initialization).toContain(
      `isDeepStrictEqual(
        installedProviderThreadArchiveRecoveryInventoryV57,
        verifiedProviderThreadArchiveRecoveryInventoryV57,
      )`,
    );
    expectOrdered(initialization, [
      "const initializedAccountService = new AccountService({",
      "const verifiedProviderThreadArchiveCommittedTargetIdsV57 =",
      "initializingChatPaneStore.verifyProviderThreadArchiveTerminalAuthorityV57();",
      ".authorizeProviderThreadArchivePaneCleanupAfterStoreVerificationV57(",
      "verifiedProviderThreadArchiveCommittedTargetIdsV57,",
      "await initializingChatAttachmentVault.reconcile(new Date());",
      "const providerThreadArchiveStartupSweepV57 =",
      "initializingChatPaneStore.sweepProviderThreadArchiveTerminalAuthorityV57(",
      "verifiedProviderThreadArchiveCommittedTargetIdsV57,",
      "const verifiedProviderThreadArchiveRecoveryInventoryV57 =",
      "providerThreadArchiveStartupSweepV57.recoveryInventory;",
      "const installedProviderThreadArchiveRecoveryInventoryV57 =",
      "initializedAccountService.installArchiveAdmissionReplayV57(",
      "!isDeepStrictEqual(",
      "chatAttachmentVault = initializingChatAttachmentVault;",
      "initializingChatService.assertProviderThreadArchiveQuarantinesInstalled();",
      "await initializedAccountService.initialize();",
      "await initializingHarnessComposition.initialize();",
    ]);
  });

  test("initialization failure never stops accounts before the producer barrier", () => {
    const cleanup = sourceBetween(
      "async function initializeGateway(): Promise<void>",
      "async function quiesceGatewayForLocalDataRemoval(): Promise<void>",
    );
    expect(cleanup).toContain("if (harnessProviderStopPermitted) {");
    expect(cleanup).toContain(
      "accountService = providerSourcesStopped ? null : initializingService",
    );
    expectOrdered(cleanup, [
      "failedChatService?.closeAdmission()",
      "await initializingHarness.preProviderStop()",
      "await failedChatService?.settled()",
      "await initializingService?.shutdown()",
      "await failedChatService?.settled()",
      "initializingHarness.providerSourcesStopped()",
      "await initializingHarness.shutdown()",
    ]);
  });

  test("local removal completes the producer barrier before account shutdown", () => {
    const cleanup = sourceBetween(
      "async function quiesceGatewayForLocalDataRemoval(): Promise<void>",
      "function currentRemovalInventoryContext():",
    );
    expectOrdered(cleanup, [
      "quiescingChatService?.closeAdmission()",
      "await harness?.preProviderStop()",
      "await quiescingChatService?.settled()",
      "await accountService?.shutdown()",
      "await quiescingChatService?.settled()",
      "harness.providerSourcesStopped()",
      "await harness.shutdown()",
    ]);
  });

  test("terminal cleanup retains accounts and the database when pre-stop fails", () => {
    const cleanup = mainSource.slice(mainSource.indexOf(
      "const terminalCleanupFailures: unknown[] = []",
    ));
    expect(cleanup).toContain(
      "if (!terminalHarnessPreProviderStopPermitted) return;",
    );
    expect(cleanup).toContain(
      "accountService = terminalProviderSourcesStopped ? null : terminalAccountService",
    );
    expect(cleanup).toContain(
      "if (terminalHarnessDatabaseClosePermitted)",
    );
    expectOrdered(cleanup, [
      "terminalChatService?.closeAdmission()",
      "await terminalHarness?.preProviderStop()",
      "await terminalChatService?.settled()",
      "await terminalAccountService?.shutdown()",
      "await terminalChatService?.settled()",
      "terminalHarness.providerSourcesStopped()",
      "await terminalHarness.shutdown()",
      "terminalDatabase?.close()",
    ]);
  });
});

function sourceBetween(start: string, end: string): string {
  const startIndex = mainSource.indexOf(start);
  const endIndex = mainSource.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Main source boundary is missing: ${start} -> ${end}`);
  }
  return mainSource.slice(startIndex, endIndex);
}

function expectOrdered(source: string, fragments: readonly string[]): void {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor + 1);
    expect(next, `missing or misordered Main fragment: ${fragment}`).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}
