import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import type { CloudSecretCustodyPort } from "./local-control";
import {
  addCloudCommandJournalEntry,
  addCloudProjectionRecovery,
  advanceCloudSessionRemoteCursor,
  assertCloudDaemonJournalFutureCapacity,
  cloudProjectionRecoveryReceiptResult,
  cloudProjectionRecoveryWindowMs,
  CloudDaemonJournalRecoveryBlocker,
  CustodyCloudAttentionNotificationReconciliation,
  completePendingCloudUsageAccount,
  createCloudProjectionRecoveryTerminalReceipt,
  CustodyCloudDaemonJournal,
  CustodyCloudSessionSyncCursor,
  bindCloudAttentionNotificationReconciliationState,
  emptyCloudAttentionNotificationReconciliationState,
  emptyCloudDaemonJournal,
  emptyCloudSessionSyncCursor,
  hasUnsettledCompactProjectionRecoveryForProfile,
  invalidIdempotencyProjectionRecoveryCode,
  isIdentityBoundCloudProjectionRecovery,
  matchesCloudProjectionRecoveryIdentity,
  parseCloudDaemonJournal,
  parseCloudAttentionNotificationReconciliationState,
  parseCloudSessionSyncCursor,
  parseCloudProjectionRecoveryEntry,
  parseCloudProjectionRecoveryTerminalReceipt,
  providerDeletionProjectionRecoveryCode,
  pruneExpiredCloudProjectionRecoveryReceipts,
  replaceCloudAttentionNotificationReconciliationDevice,
  sameCloudProjectionRecoveryEntry,
  sameCloudProjectionRecoveryTerminalReceipt,
  setCloudAttentionNotificationPending,
  settleCloudAttentionNotificationReconciliation,
  supersedeCloudProjectionRecoveryForProviderDeletion,
  terminalizeUnreservedPreparedCloudCommands,
  transitionCloudProjectionRecovery,
  transitionCloudCommandJournalEntry,
  type CloudCommandJournalEntry,
  type CloudDaemonJournalState,
  type CloudProjectionRecoveryJournalEntry,
  type CloudProjectionRecoveryTerminalReceipt,
  type LegacyCloudDaemonJournalState,
  type LegacyCloudDaemonJournalV2State,
  type LegacyCloudDaemonJournalV4State,
  type LegacyCloudProjectionRecoveryJournalEntry,
  type PendingCloudUsageAccount,
} from "./daemon-journal";

const fixedNow = 1_700_000_000_000;
const productionCustodyMaximumBytes = 65_536;
const utf8Encoder = new TextEncoder();

function uuidV7(value: number): string {
  return uuidV7At(fixedNow, value);
}

function uuidV7At(timestamp: number, value: number): string {
  const timestampHex = timestamp.toString(16).padStart(12, "0");
  return `${timestampHex.slice(0, 8)}-${timestampHex.slice(8)}-7000-8000-${value
    .toString(16).padStart(12, "0")}`;
}

function digest(character: string): string {
  return character.repeat(64);
}

function recovery(
  index: number,
  phase: CloudProjectionRecoveryJournalEntry["phase"],
  baselineCount = 2,
  expectedCompactStreamEpoch = 0,
): CloudProjectionRecoveryJournalEntry {
  const sessionPublicId = `session_${index.toString().padStart(8, "0")}`;
  const epochPublicId = uuidV7(index * 2);
  const expectedHeadSequence = index + 1;
  const expectedTailDigest = digest("c");
  const base = {
    authority: {
      bootGeneration: index + 1,
      bootId: `boot_${index.toString().padStart(8, "0")}`,
      fence: index + 1,
    },
    baselineCompletedTurns: Array.from({ length: baselineCount }, (_, turnIndex) => ({
      bodyDigest: digest(turnIndex % 2 === 0 ? "d" : "e"),
      turnId: `turn_${index.toString().padStart(8, "0")}_${turnIndex.toString().padStart(4, "0")}`,
    })),
    epochPublicId,
    expectedCompactStreamEpoch,
    expectedHeadSequence,
    expectedTailDigest,
    idempotencyKey: uuidV7(index * 2 + 1),
    lineageCommitment: digest("a"),
    localAuthority: {
      profileGeneration: index + 1,
      profileId: `profile_${index.toString().padStart(8, "0")}`,
      providerUpdatedAt: fixedNow + index,
      providerThreadId: `thread/${index}`,
      sessionRevision: index + 1,
    },
    requestDigest: digest("b"),
    replacementCacheId: `cache_replacement_${index.toString().padStart(8, "0")}`,
    requestedAt: fixedNow + index,
    sessionPublicId,
    sourceDevicePublicId: `device_${index.toString().padStart(8, "0")}`,
    sourceCacheId: `cache_source_${index.toString().padStart(8, "0")}`,
    userPublicId: `user_${index.toString().padStart(8, "0")}`,
  } as const;
  if (phase === "prepared" || phase === "effect_started") return { ...base, phase };
  return {
    ...base,
    cacheActivated: false,
    phase,
    response: {
      boundaryHeadSequence: expectedHeadSequence,
      boundaryTailDigest: expectedTailDigest,
      compactHasRecoveryGap: true,
      compactStreamEpoch: expectedCompactStreamEpoch + 1,
      epochPublicId,
      projectionRevision: index + 1,
      sessionPublicId,
    },
  };
}

function terminalReceipt(
  index: number,
  phase: CloudProjectionRecoveryTerminalReceipt["phase"],
): CloudProjectionRecoveryTerminalReceipt {
  return phase === "applied"
    ? createCloudProjectionRecoveryTerminalReceipt(recovery(index, "applied"), { phase })
    : createCloudProjectionRecoveryTerminalReceipt(recovery(index, "effect_started"), {
        phase,
        rejectionCode: "SESSION_COMPACT_EPOCH_CONFLICT",
      });
}

function withoutIdentity(
  entry: CloudProjectionRecoveryJournalEntry,
): Omit<CloudProjectionRecoveryJournalEntry, "sourceDevicePublicId" | "userPublicId"> {
  return Object.fromEntries(Object.entries(entry).filter(([key]) =>
    key !== "sourceDevicePublicId" && key !== "userPublicId")) as Omit<
      CloudProjectionRecoveryJournalEntry,
      "sourceDevicePublicId" | "userPublicId"
    >;
}

function stateWith(
  projectionRecoveries: readonly CloudProjectionRecoveryJournalEntry[],
  projectionRecoveryReceipts: readonly CloudProjectionRecoveryTerminalReceipt[] = [],
): CloudDaemonJournalState {
  return {
    commands: [],
    deviceCommands: [],
    pendingUsageAccount: null,
    projectionRecoveries,
    projectionRecoveryReceipts,
    usageAccounts: [],
    version: 5,
  };
}

function command(index: number): CloudCommandJournalEntry {
  return {
    authority: {
      bootGeneration: index + 1,
      bootId: `boot_${index.toString().padStart(8, "0")}`,
      fence: index + 1,
    },
    commandPublicId: uuidV7(index + 1),
    kind: "stop",
    localAuthorityDigest: digest("1"),
    payloadDigest: digest("2"),
    sessionPublicId: `session_${index.toString().padStart(8, "0")}`,
    phase: "prepared",
  };
}

function pendingUsageAccount(metadataCiphertextCharacters: number): PendingCloudUsageAccount {
  return {
    accountPublicId: "account_12345678",
    encryptedLocalReference: {
      algorithm: "A256GCM",
      ciphertext: "a".repeat(16_384),
      keyVersion: 1,
      nonce: "b".repeat(16),
    },
    encryptedMetadata: {
      algorithm: "A256GCM",
      ciphertext: "c".repeat(metadataCiphertextCharacters),
      keyVersion: 1,
      nonce: "d".repeat(16),
    },
    idempotencyKey: uuidV7(1_000),
    matchKey: digest("4"),
    requestDigest: digest("5"),
    sourceGeneration: 2,
    sourceRevision: 0,
  };
}

const capacityCommands = Array.from({ length: 100 }, (_, index) => command(index));
const settledCapacityCommands = capacityCommands.slice(0, 70).map((entry) => ({
  ...entry,
  phase: "terminal" as const,
  resultCode: "APPLIED",
  resultDigest: digest("f"),
  terminalState: "applied" as const,
}));

/**
 * The bytes the journal actually writes to custody, which is what every
 * capacity bound is measured against. A version-4 state whose device-command
 * array is empty is stored in the version-3 shape (see
 * `serializeCloudDaemonJournalForCustody`), so the empty key is dropped here
 * rather than inflating every byte fixture by a key that is never written.
 */
function serializedUtf8Bytes(value: unknown): number {
  const stored = typeof value === "object"
    && value !== null
    && "deviceCommands" in value
    && Array.isArray((value as { deviceCommands: unknown[] }).deviceCommands)
    && (value as { deviceCommands: unknown[] }).deviceCommands.length === 0
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "deviceCommands"))
    : value;
  return utf8Encoder.encode(JSON.stringify(stored)).byteLength;
}

function metadataCiphertextCharactersForTarget(
  targetBytes: number,
  build: (metadataCiphertextCharacters: number) => unknown,
): number {
  const minimumCharacters = 22;
  const minimumBytes = serializedUtf8Bytes(build(minimumCharacters));
  const characters = minimumCharacters + targetBytes - minimumBytes;
  if (characters < minimumCharacters || characters > 16_384) {
    throw new Error("The requested journal byte fixture is not constructible.");
  }
  return characters;
}

function legacyJournalAtRawBytes(targetBytes: number): LegacyCloudDaemonJournalState {
  const build = (metadataCiphertextCharacters: number): LegacyCloudDaemonJournalState => ({
    commands: capacityCommands,
    pendingUsageAccount: pendingUsageAccount(metadataCiphertextCharacters),
    usageAccounts: [],
    version: 1,
  });
  return build(metadataCiphertextCharactersForTarget(targetBytes, build));
}

function legacyV2JournalAtRawBytes(targetBytes: number): LegacyCloudDaemonJournalV2State {
  const active = withoutIdentity(
    recovery(73, "prepared"),
  ) as LegacyCloudProjectionRecoveryJournalEntry;
  const build = (metadataCiphertextCharacters: number): LegacyCloudDaemonJournalV2State => ({
    commands: capacityCommands,
    pendingUsageAccount: pendingUsageAccount(metadataCiphertextCharacters),
    projectionRecoveries: [active],
    usageAccounts: [],
    version: 2,
  });
  return build(metadataCiphertextCharactersForTarget(targetBytes, build));
}

function legacyJournalAtCanonicalBytes(targetBytes: number): LegacyCloudDaemonJournalState {
  const canonical = (metadataCiphertextCharacters: number): CloudDaemonJournalState => ({
    commands: capacityCommands,
    deviceCommands: [],
    pendingUsageAccount: pendingUsageAccount(metadataCiphertextCharacters),
    projectionRecoveries: [],
    projectionRecoveryReceipts: [],
    usageAccounts: [],
    version: 5,
  });
  const metadataCharacters = metadataCiphertextCharactersForTarget(targetBytes, canonical);
  const state = canonical(metadataCharacters);
  return {
    commands: state.commands,
    pendingUsageAccount: state.pendingUsageAccount,
    usageAccounts: state.usageAccounts,
    version: 1,
  };
}

function journalAtBytesWithProviderThread(
  targetBytes: number,
  providerThreadId: string,
): CloudDaemonJournalState {
  const original = recovery(70, "prepared", 0);
  const adjusted = {
    ...original,
    localAuthority: { ...original.localAuthority, providerThreadId },
  };
  const build = (metadataCiphertextCharacters: number): CloudDaemonJournalState => ({
    commands: capacityCommands,
    deviceCommands: [],
    pendingUsageAccount: pendingUsageAccount(metadataCiphertextCharacters),
    projectionRecoveries: [adjusted],
    projectionRecoveryReceipts: [],
    usageAccounts: [],
    version: 5,
  });
  return build(metadataCiphertextCharactersForTarget(targetBytes, build));
}

function journalAtBytesWithReceipt(targetBytes: number): CloudDaemonJournalState {
  const completed = terminalReceipt(71, "applied");
  const build = (metadataCiphertextCharacters: number): CloudDaemonJournalState => ({
    commands: capacityCommands,
    deviceCommands: [],
    pendingUsageAccount: pendingUsageAccount(metadataCiphertextCharacters),
    projectionRecoveries: [],
    projectionRecoveryReceipts: [completed],
    usageAccounts: [],
    version: 5,
  });
  return build(metadataCiphertextCharactersForTarget(targetBytes, build));
}

function capacityAppliedRecovery(
  entry: CloudProjectionRecoveryJournalEntry,
): CloudProjectionRecoveryJournalEntry {
  return parseCloudProjectionRecoveryEntry({
    ...entry,
    cacheActivated: false,
    phase: "applied",
    response: {
      boundaryHeadSequence: entry.expectedHeadSequence,
      boundaryTailDigest: entry.expectedTailDigest,
      compactHasRecoveryGap: true,
      compactStreamEpoch: entry.expectedCompactStreamEpoch + 1,
      epochPublicId: entry.epochPublicId,
      projectionRevision: Number.MAX_SAFE_INTEGER,
      sessionPublicId: entry.sessionPublicId,
    },
  });
}

function journalBeforeRecoveryAtAppliedBytes(
  targetBytes: number,
  entry: CloudProjectionRecoveryJournalEntry,
): CloudDaemonJournalState {
  const applied = capacityAppliedRecovery(entry);
  const buildWithApplied = (metadataCiphertextCharacters: number): CloudDaemonJournalState => ({
    commands: settledCapacityCommands,
    deviceCommands: [],
    pendingUsageAccount: pendingUsageAccount(metadataCiphertextCharacters),
    projectionRecoveries: [applied],
    projectionRecoveryReceipts: [],
    usageAccounts: [],
    version: 5,
  });
  const metadataCharacters = metadataCiphertextCharactersForTarget(
    targetBytes,
    buildWithApplied,
  );
  return {
    ...buildWithApplied(metadataCharacters),
    projectionRecoveries: [],
  };
}

function capacityTerminalCommand(
  entry: CloudCommandJournalEntry,
  terminalState: "applied" | "failed" | "ambiguous" = "ambiguous",
): CloudCommandJournalEntry {
  return {
    ...entry,
    authority: {
      bootGeneration: Number.MAX_SAFE_INTEGER,
      bootId: "b".repeat(96),
      fence: Number.MAX_SAFE_INTEGER,
    },
    phase: "terminal",
    resultCode: "R".repeat(64),
    resultDigest: digest("f"),
    terminalState,
  };
}

function journalBeforeCommandAtTerminalBytes(
  targetBytes: number,
  entry: CloudCommandJournalEntry,
): CloudDaemonJournalState {
  const terminal = capacityTerminalCommand(entry);
  const buildWithTerminal = (metadataCiphertextCharacters: number): CloudDaemonJournalState => ({
    commands: [...settledCapacityCommands.slice(0, 69), terminal],
    deviceCommands: [],
    pendingUsageAccount: pendingUsageAccount(metadataCiphertextCharacters),
    projectionRecoveries: [],
    projectionRecoveryReceipts: [],
    usageAccounts: [],
    version: 5,
  });
  const metadataCharacters = metadataCiphertextCharactersForTarget(
    targetBytes,
    buildWithTerminal,
  );
  return {
    ...buildWithTerminal(metadataCharacters),
    commands: settledCapacityCommands.slice(0, 69),
  };
}

function jsonClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

class MemoryCustody implements CloudSecretCustodyPort {
  readonly values = new Map<string, Readonly<{ generation: number; value: string }>>();
  compareAndSwapCalls = 0;

  async read(slot: string): Promise<Readonly<{ generation: number; value: string }> | null> {
    return this.values.get(slot) ?? null;
  }

  async compareAndSwap(
    slot: string,
    expectedGeneration: number | null,
    value: string,
  ): Promise<Readonly<{ generation: number; value: string }> | null> {
    this.compareAndSwapCalls += 1;
    const current = this.values.get(slot);
    if ((current?.generation ?? null) !== expectedGeneration) return null;
    const committed = {
      generation: expectedGeneration === null ? 0 : expectedGeneration + 1,
      value,
    };
    this.values.set(slot, committed);
    return committed;
  }

  async clearIfGeneration(slot: string, expectedGeneration: number): Promise<boolean> {
    if (this.values.get(slot)?.generation !== expectedGeneration) return false;
    return this.values.delete(slot);
  }
}

describe("cloud daemon journal", () => {
  test("migrates a v1 journal in memory without losing command or usage state", () => {
    const legacy = {
      commands: [{
        authority: { bootGeneration: 2, bootId: "boot_12345678", fence: 3 },
        commandPublicId: uuidV7(100),
        kind: "stop",
        localAuthorityDigest: digest("1"),
        payloadDigest: digest("2"),
        phase: "terminal",
        resultCode: "APPLIED",
        resultDigest: digest("3"),
        sessionPublicId: "session_12345678",
        terminalState: "applied",
      }],
      pendingUsageAccount: {
        accountPublicId: "account_12345678",
        encryptedLocalReference: {
          algorithm: "A256GCM",
          ciphertext: "a".repeat(22),
          keyVersion: 1,
          nonce: "b".repeat(16),
        },
        encryptedMetadata: {
          algorithm: "A256GCM",
          ciphertext: "c".repeat(22),
          keyVersion: 1,
          nonce: "d".repeat(16),
        },
        idempotencyKey: uuidV7(101),
        matchKey: digest("4"),
        requestDigest: digest("5"),
        sourceGeneration: 2,
        sourceRevision: 0,
      },
      usageAccounts: [{
        accountPublicId: "account_87654321",
        sourceGeneration: 3,
        sourceRevision: 4,
      }],
      version: 1,
    } as const;

    expect(parseCloudDaemonJournal(legacy)).toEqual({
      commands: legacy.commands,
      deviceCommands: [],
      pendingUsageAccount: legacy.pendingUsageAccount,
      projectionRecoveries: [],
      projectionRecoveryReceipts: [],
      usageAccounts: legacy.usageAccounts,
      version: 5,
    });
  });

  test("marks a v4 applied login without ciphertext for exact remote reconciliation", () => {
    const legacy: LegacyCloudDaemonJournalV4State = {
      commands: [],
      deviceCommands: [{
        authority: { bootGeneration: 2, bootId: "boot_12345678", fence: 1 },
        commandPublicId: uuidV7(102),
        kind: "account_login_start",
        payloadDigest: digest("a"),
        phase: "terminal",
        requestingDevicePublicId: "device_browser1",
        resultCode: "APPLIED",
        resultDigest: digest("b"),
        terminalState: "applied",
      }],
      pendingUsageAccount: null,
      projectionRecoveries: [],
      projectionRecoveryReceipts: [],
      usageAccounts: [],
      version: 4,
    };

    const migrated = parseCloudDaemonJournal(legacy);
    expect(migrated.version).toBe(5);
    expect(migrated.deviceCommands).toEqual([{
      authority: { bootGeneration: 2, bootId: "boot_12345678", fence: 1 },
      commandPublicId: uuidV7(102),
      kind: "account_login_start",
      legacyResultMissing: true,
      payloadDigest: digest("a"),
      phase: "terminal",
      requestingDevicePublicId: "device_browser1",
      resultCode: "APPLIED",
      resultDigest: digest("b"),
      terminalState: "applied",
    }]);
    expect(() => parseCloudDaemonJournal({ ...legacy, version: 5 })).toThrow(
      "Cloud daemon journal is corrupt.",
    );
  });

  test("round-trips every active recovery phase and bounded baseline length", () => {
    fc.assert(fc.property(
      fc.constantFrom("prepared", "effect_started", "applied" as const),
      fc.integer({ min: 0, max: 128 }),
      fc.integer({ min: 0, max: 10_000 }),
      (phase, baselineCount, expectedEpoch) => {
        const original = recovery(7, phase, baselineCount, expectedEpoch);
        const parsed = parseCloudProjectionRecoveryEntry(jsonClone(original));
        expect(parsed).toEqual(original);
        expect(sameCloudProjectionRecoveryEntry(original, parsed)).toBe(true);
      },
    ));
  });

  test("crash-journals only the bounded public interaction baseline exactly", () => {
    const baselineInteraction = {
      blocking: true,
      detailMarkdown: "- Resolve this interaction on the machine.",
      detailVersion: 2,
      headline: "Interaction no longer accepts a response",
      interactionId: "70000000-0000-4000-8000-000000000001",
      interactionKind: "mcp_elicitation",
      label: "MCP form",
      remotePolicy: {
        actions: [],
        deadlineAt: fixedNow + 60_000,
        questions: [],
        reasonCodes: ["INTERACTION_NOT_PENDING"],
        version: 2,
      },
      revision: 2,
      state: "expired",
      summary: "Interaction state updated",
    } as const;
    const prepared = {
      ...recovery(70, "prepared"),
      baselineInteractions: [baselineInteraction],
    } as const;
    const persisted = parseCloudDaemonJournal(jsonClone(stateWith([prepared])));
    expect(persisted.projectionRecoveries).toEqual([prepared]);
    expect(parseCloudProjectionRecoveryEntry(
      jsonClone(persisted.projectionRecoveries[0]),
    )).toEqual(prepared);

    const privatePath = ["", "Users", "alice", "private"].join("/");
    const privateValues = [
      "provider_thread_private",
      "https://private.example/mcp",
      "sk_secret_answer",
      privatePath,
      digest("f"),
    ];
    expect(privateValues.every((value) =>
      !JSON.stringify(persisted.projectionRecoveries[0]?.baselineInteractions).includes(value)))
      .toBe(true);

    for (const corrupt of [
      { ...baselineInteraction, providerPath: privatePath },
      { ...baselineInteraction, summary: privatePath },
      { ...baselineInteraction, summary: "Bearer sk_secret_answer" },
      { ...baselineInteraction, revision: 0 },
    ]) {
      expect(() => parseCloudProjectionRecoveryEntry({
        ...prepared,
        baselineInteractions: [corrupt],
      })).toThrow("Cloud daemon journal is corrupt.");
    }
    expect(() => parseCloudProjectionRecoveryEntry({
      ...prepared,
      baselineInteractions: Array.from(
        { length: 201 },
        (_, index) => ({
          ...baselineInteraction,
          interactionId: `70000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
        }),
      ),
    })).toThrow("Cloud daemon journal is corrupt.");
  });

  test("round-trips compact terminal receipts", () => {
    for (const phase of ["applied", "rejected"] as const) {
      const original = terminalReceipt(7, phase);
      const parsed = parseCloudProjectionRecoveryTerminalReceipt(jsonClone(original));
      expect(parsed).toEqual(original);
      expect(sameCloudProjectionRecoveryTerminalReceipt(original, parsed)).toBe(true);
    }
  });

  test("uses structural equality independent of object key insertion order", () => {
    const original = recovery(8, "applied");
    const reordered = parseCloudProjectionRecoveryEntry(jsonClone({
      response: original.phase === "applied" ? original.response : null,
      ...original,
    }));

    expect(sameCloudProjectionRecoveryEntry(original, reordered)).toBe(true);
    expect(sameCloudProjectionRecoveryEntry(original, recovery(9, "applied"))).toBe(false);
  });

  test("accepts 25 unique recoveries and rejects aggregate duplicates or overflow", () => {
    const recoveries = Array.from({ length: 25 }, (_, index) =>
      recovery(index + 1, "prepared"));
    expect(parseCloudDaemonJournal(stateWith(recoveries)).projectionRecoveries).toHaveLength(25);
    expect(() => parseCloudDaemonJournal(stateWith([
      ...recoveries,
      recovery(26, "prepared"),
    ]))).toThrow("Cloud daemon journal is corrupt.");

    const distinct = recovery(30, "prepared");
    for (const duplicate of [
      { ...distinct, sessionPublicId: recoveries[0]?.sessionPublicId },
      { ...distinct, idempotencyKey: recoveries[0]?.idempotencyKey },
      { ...distinct, epochPublicId: recoveries[0]?.epochPublicId },
    ]) {
      expect(() => parseCloudDaemonJournal(stateWith([
        recoveries[0] as CloudProjectionRecoveryJournalEntry,
        duplicate as CloudProjectionRecoveryJournalEntry,
      ]))).toThrow("Cloud daemon journal is corrupt.");
    }
  });

  test("terminal receipts do not consume active capacity or block a newer recovery", () => {
    const completed = terminalReceipt(31, "applied");
    const next = {
      ...recovery(32, "prepared"),
      sessionPublicId: completed.sessionPublicId,
    } as const;
    const parsed = parseCloudDaemonJournal(stateWith([next], [completed]));
    expect(parsed.projectionRecoveries).toHaveLength(1);
    expect(parsed.projectionRecoveryReceipts).toEqual([completed]);
    expect(() => parseCloudDaemonJournal(stateWith([
      next,
      { ...recovery(33, "prepared"), sessionPublicId: next.sessionPublicId },
    ]))).toThrow("Cloud daemon journal is corrupt.");
    expect(() => parseCloudDaemonJournal(stateWith([next], [{
      ...terminalReceipt(34, "rejected"),
      idempotencyKey: next.idempotencyKey,
    }]))).toThrow("Cloud daemon journal is corrupt.");
  });

  test("enforces baseline bounds and uniqueness by turn id only", () => {
    expect(() => parseCloudProjectionRecoveryEntry(
      recovery(40, "prepared", 129),
    )).toThrow("Cloud daemon journal is corrupt.");

    const original = recovery(41, "prepared");
    const first = original.baselineCompletedTurns[0];
    const second = original.baselineCompletedTurns[1];
    if (first === undefined || second === undefined) throw new Error("Invalid test fixture.");
    expect(() => parseCloudProjectionRecoveryEntry({
      ...original,
      baselineCompletedTurns: [first, { ...second, turnId: first.turnId }],
    })).toThrow("Cloud daemon journal is corrupt.");
    expect(parseCloudProjectionRecoveryEntry({
      ...original,
      baselineCompletedTurns: [first, { ...second, bodyDigest: first.bodyDigest }],
    }).baselineCompletedTurns).toHaveLength(2);
  });

  test("retains known and unavailable source-cache authority across phases", () => {
    const known = recovery(45, "effect_started");
    const unavailable = { ...recovery(46, "prepared"), sourceCacheId: null };

    expect(parseCloudProjectionRecoveryEntry(known).sourceCacheId).toBe(
      "cache_source_00000045",
    );
    expect(parseCloudProjectionRecoveryEntry(unavailable).sourceCacheId).toBeNull();
  });

  test("rejects corrupt exact-key, scalar, authority, and terminal data", () => {
    const prepared = recovery(50, "prepared");
    const applied = recovery(51, "applied");
    const rejected = terminalReceipt(52, "rejected");
    if (applied.phase !== "applied") throw new Error("Invalid test fixture.");
    const corrupt: unknown[] = [
      { ...prepared, extra: true },
      { ...prepared, expectedCompactStreamEpoch: Number.MAX_SAFE_INTEGER },
      { ...prepared, expectedHeadSequence: 0 },
      { ...prepared, expectedTailDigest: "not-a-digest" },
      { ...prepared, lineageCommitment: "lineage_opaque" },
      { ...prepared, replacementCacheId: "short" },
      { ...prepared, requestedAt: fixedNow + 0.5 },
      { ...prepared, sourceCacheId: "short" },
      { ...prepared, sourceDevicePublicId: null },
      { ...prepared, userPublicId: null },
      { ...prepared, localAuthority: { ...prepared.localAuthority, profileGeneration: 0 } },
      { ...prepared, localAuthority: { ...prepared.localAuthority, profileId: "short" } },
      { ...prepared, localAuthority: { ...prepared.localAuthority, providerThreadId: "bad\nthread" } },
      { ...prepared, localAuthority: { ...prepared.localAuthority, providerThreadId: "x".repeat(321) } },
      { ...prepared, authority: { ...prepared.authority, extra: true } },
      {
        ...prepared,
        baselineCompletedTurns: [{
          ...prepared.baselineCompletedTurns[0],
          extra: true,
        }],
      },
      {
        ...applied,
        response: { ...applied.response, compactHasRecoveryGap: false },
      },
      {
        ...applied,
        response: { ...applied.response, compactStreamEpoch: applied.response.compactStreamEpoch + 1 },
      },
      {
        ...applied,
        response: { ...applied.response, boundaryTailDigest: digest("f") },
      },
      { ...applied, cacheActivated: "yes" },
      { ...applied, cacheActivated: true },
      { ...prepared, response: applied.response },
    ];

    for (const value of corrupt) {
      expect(() => parseCloudProjectionRecoveryEntry(value)).toThrow(
        "Cloud daemon journal is corrupt.",
      );
    }
    for (const value of [
      { ...rejected, rejectionCode: "not_uppercase" },
      { ...rejected, rejectionCode: `A${"B".repeat(64)}` },
      { ...rejected, sourceDevicePublicId: null },
      { ...rejected, userPublicId: null },
    ]) {
      expect(() => parseCloudProjectionRecoveryTerminalReceipt(value)).toThrow(
        "Cloud daemon journal is corrupt.",
      );
    }
  });

  test("never returns a noncanonical state for arbitrary JSON", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      try {
        const parsed = parseCloudDaemonJournal(value);
        expect(parsed.version).toBe(5);
        expect(parseCloudDaemonJournal(jsonClone(parsed))).toEqual(parsed);
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error);
      }
    }));
  });

  test("migrates v2 active evidence and terminal outcomes without inventing identity", () => {
    const prepared = withoutIdentity(recovery(60, "prepared"));
    const applied = withoutIdentity(recovery(61, "applied"));
    const activated = { ...withoutIdentity(recovery(62, "applied")), cacheActivated: true };
    const rejectedBase = withoutIdentity(recovery(63, "effect_started"));
    const rejected = {
      ...rejectedBase,
      phase: "rejected" as const,
      rejectionCode: "SESSION_COMPACT_EPOCH_CONFLICT",
    };
    const legacy: LegacyCloudDaemonJournalV2State = {
      commands: [],
      pendingUsageAccount: null,
      projectionRecoveries: [
        prepared,
        applied,
        activated,
        rejected,
      ] as readonly LegacyCloudProjectionRecoveryJournalEntry[],
      usageAccounts: [],
      version: 2,
    };

    const migrated = parseCloudDaemonJournal(legacy);
    expect(migrated.version).toBe(5);
    expect(migrated.projectionRecoveries).toHaveLength(2);
    expect(migrated.projectionRecoveryReceipts).toHaveLength(2);
    expect(migrated.projectionRecoveries.every((entry) =>
      !isIdentityBoundCloudProjectionRecovery(entry))).toBe(true);
    expect(migrated.projectionRecoveryReceipts.every((receipt) =>
      !isIdentityBoundCloudProjectionRecovery(receipt))).toBe(true);
    expect(hasUnsettledCompactProjectionRecoveryForProfile(
      migrated,
      prepared.localAuthority.profileId,
    )).toBe(true);
    expect(() => transitionCloudProjectionRecovery(
      migrated,
      migrated.projectionRecoveries[0] as CloudProjectionRecoveryJournalEntry,
      {
        ...(migrated.projectionRecoveries[0] as CloudProjectionRecoveryJournalEntry),
        phase: "effect_started",
      },
      fixedNow + 100,
    )).toThrow("Cloud projection recovery identity is unbound.");
    expect(parseCloudDaemonJournal(jsonClone(migrated))).toEqual(migrated);
  });

  test("keeps terminal receipts outside the 25-active capacity", () => {
    const receipts = Array.from({ length: 25 }, (_, index) =>
      terminalReceipt(index + 1, index % 2 === 0 ? "applied" : "rejected"));
    const next = recovery(100, "prepared");

    const added = addCloudProjectionRecovery(
      stateWith([], receipts),
      next,
      fixedNow + 100,
    );

    expect(added.projectionRecoveries).toEqual([next]);
    expect(added.projectionRecoveryReceipts).toEqual(receipts);
  });

  test("permits more than 25 lifetime recoveries after strict time pruning", () => {
    const receipts = Array.from({ length: 30 }, (_, index) =>
      terminalReceipt(index + 1, "rejected"));
    const now = fixedNow + cloudProjectionRecoveryWindowMs + 1_000;
    const next: CloudProjectionRecoveryJournalEntry = {
      ...recovery(200, "prepared"),
      idempotencyKey: uuidV7At(now, 900),
      requestedAt: now,
    };

    const added = addCloudProjectionRecovery(stateWith([], receipts), next, now);

    expect(added.projectionRecoveryReceipts).toEqual([]);
    expect(added.projectionRecoveries).toEqual([next]);
  });

  test("never ages active recovery evidence and prunes receipts only when both clocks are older", () => {
    const pending = { ...recovery(201, "effect_started"), requestedAt: fixedNow };
    const completed = terminalReceipt(202, "rejected");
    const exactRequestedAtCutoff = completed.requestedAt + cloudProjectionRecoveryWindowMs;

    const retained = pruneExpiredCloudProjectionRecoveryReceipts(
      stateWith([pending], [completed]),
      exactRequestedAtCutoff,
    );
    expect(retained.projectionRecoveries).toEqual([pending]);
    expect(retained.projectionRecoveryReceipts).toEqual([completed]);

    const pruned = pruneExpiredCloudProjectionRecoveryReceipts(
      retained,
      exactRequestedAtCutoff + 1,
    );
    expect(pruned.projectionRecoveries).toEqual([pending]);
    expect(pruned.projectionRecoveryReceipts).toEqual([]);
  });

  test("transitions active evidence to byte-identical replay receipts", () => {
    const prepared = recovery(210, "prepared");
    const effectStarted = recovery(210, "effect_started");
    const applied = recovery(210, "applied");
    if (applied.phase !== "applied" || !isIdentityBoundCloudProjectionRecovery(applied)) {
      throw new Error("Invalid test fixture.");
    }
    const startedState = transitionCloudProjectionRecovery(
      stateWith([prepared]),
      prepared,
      effectStarted,
      fixedNow + 210,
    );
    const appliedState = transitionCloudProjectionRecovery(
      startedState,
      effectStarted,
      applied,
      fixedNow + 210,
    );
    const receipt = createCloudProjectionRecoveryTerminalReceipt(applied, {
      phase: "applied",
    });
    const terminalState = transitionCloudProjectionRecovery(
      appliedState,
      applied,
      receipt,
      fixedNow + 210,
    );
    const expectedResult = {
      boundaryHeadSequence: applied.response.boundaryHeadSequence,
      compactHasRecoveryGap: true,
      compactStreamEpoch: applied.response.compactStreamEpoch,
      idempotencyKey: applied.idempotencyKey,
      phase: "applied",
      projectionRevision: applied.response.projectionRevision,
      sessionPublicId: applied.sessionPublicId,
    } as const;

    expect(terminalState.projectionRecoveries).toEqual([]);
    expect(terminalState.projectionRecoveryReceipts).toEqual([receipt]);
    expect(JSON.stringify(cloudProjectionRecoveryReceiptResult(receipt))).toBe(
      JSON.stringify(expectedResult),
    );
    expect(matchesCloudProjectionRecoveryIdentity(
      receipt,
      applied.userPublicId,
      applied.sourceDevicePublicId,
    )).toBe(true);
    expect(receipt.sessionPublicId).toBe(applied.sessionPublicId);

    const rejectedActive = recovery(211, "effect_started");
    const rejectedReceipt = createCloudProjectionRecoveryTerminalReceipt(rejectedActive, {
      phase: "rejected",
      rejectionCode: "SESSION_COMPACT_EPOCH_CONFLICT",
    });
    const rejectedState = transitionCloudProjectionRecovery(
      stateWith([rejectedActive]),
      rejectedActive,
      rejectedReceipt,
      fixedNow + 211,
    );
    expect(rejectedState.projectionRecoveries).toEqual([]);
    expect(JSON.stringify(cloudProjectionRecoveryReceiptResult(rejectedReceipt))).toBe(
      JSON.stringify({
        idempotencyKey: rejectedActive.idempotencyKey,
        phase: "rejected",
        rejectionCode: "SESSION_COMPACT_EPOCH_CONFLICT",
        sessionPublicId: rejectedActive.sessionPublicId,
      }),
    );
  });

  test("rebinds only prepared lease proofs and safely settles expired no-effect authority", () => {
    const prepared = recovery(212, "prepared");
    const rebound = parseCloudProjectionRecoveryEntry({
      ...prepared,
      authority: { ...prepared.authority, fence: prepared.authority.fence + 1 },
      lineageCommitment: digest("d"),
      requestDigest: digest("e"),
    });
    const reboundState = transitionCloudProjectionRecovery(
      stateWith([prepared]),
      prepared,
      rebound,
      fixedNow + 212,
    );
    expect(reboundState.projectionRecoveries).toEqual([rebound]);
    expect(() => transitionCloudProjectionRecovery(
      stateWith([prepared]),
      prepared,
      rebound,
      fixedNow + cloudProjectionRecoveryWindowMs + 212,
    )).toThrow("Cloud projection recovery terminal transition is invalid.");

    for (const invalid of [
      { ...rebound, expectedHeadSequence: rebound.expectedHeadSequence + 1 },
      {
        ...rebound,
        localAuthority: {
          ...rebound.localAuthority,
          sessionRevision: rebound.localAuthority.sessionRevision + 1,
        },
      },
      { ...rebound, phase: "effect_started" as const, requestDigest: digest("f") },
    ]) {
      expect(() => transitionCloudProjectionRecovery(
        reboundState,
        rebound,
        parseCloudProjectionRecoveryEntry(invalid),
        fixedNow + 213,
      )).toThrow("Cloud projection recovery terminal transition is invalid.");
    }

    const rejected = createCloudProjectionRecoveryTerminalReceipt(rebound, {
      phase: "rejected",
      rejectionCode: invalidIdempotencyProjectionRecoveryCode,
    });
    const settled = transitionCloudProjectionRecovery(
      reboundState,
      rebound,
      rejected,
      fixedNow + cloudProjectionRecoveryWindowMs + 212,
    );
    expect(settled.projectionRecoveries).toEqual([]);
    expect(settled.projectionRecoveryReceipts).toMatchObject([{
      idempotencyKey: rebound.idempotencyKey,
      phase: "rejected",
      rejectionCode: invalidIdempotencyProjectionRecoveryCode,
    }]);
    expect(() => createCloudProjectionRecoveryTerminalReceipt(prepared, {
      phase: "rejected",
      rejectionCode: "AUTHORITY_NOT_CURRENT",
    })).toThrow("Cloud projection recovery terminal transition is invalid.");
  });

  test("terminal provider deletion supersedes every active recovery phase idempotently", () => {
    for (const phase of ["prepared", "effect_started", "applied"] as const) {
      const active = recovery(230 + phase.length, phase);
      const superseded = supersedeCloudProjectionRecoveryForProviderDeletion(
        stateWith([active]),
        active.sessionPublicId,
        fixedNow + 500,
      );
      expect(superseded.projectionRecoveries).toEqual([]);
      expect(superseded.projectionRecoveryReceipts).toEqual([
        expect.objectContaining({
          idempotencyKey: active.idempotencyKey,
          phase: "rejected",
          rejectionCode: providerDeletionProjectionRecoveryCode,
          sessionPublicId: active.sessionPublicId,
        }),
      ]);
      expect(supersedeCloudProjectionRecoveryForProviderDeletion(
        superseded,
        active.sessionPublicId,
        fixedNow + 501,
      )).toEqual(superseded);
      expect(parseCloudDaemonJournal(JSON.parse(JSON.stringify(superseded))))
        .toEqual(superseded);
    }
  });

  test("retains an aged active recovery result for a full window after terminal CAS", () => {
    const applied = recovery(212, "applied");
    if (applied.phase !== "applied") throw new Error("Invalid test fixture.");
    const receipt = createCloudProjectionRecoveryTerminalReceipt(applied, {
      phase: "applied",
    });
    const completedAt = applied.requestedAt + cloudProjectionRecoveryWindowMs + 1;

    const terminal = transitionCloudProjectionRecovery(
      stateWith([applied]),
      applied,
      receipt,
      completedAt,
    );

    expect(terminal.projectionRecoveries).toEqual([]);
    expect(terminal.projectionRecoveryReceipts).toHaveLength(1);
    expect(terminal.projectionRecoveryReceipts[0]?.requestedAt).toBe(completedAt);
    expect(cloudProjectionRecoveryReceiptResult(
      terminal.projectionRecoveryReceipts[0] as CloudProjectionRecoveryTerminalReceipt,
    )).toEqual(cloudProjectionRecoveryReceiptResult(receipt));
    expect(pruneExpiredCloudProjectionRecoveryReceipts(
      terminal,
      completedAt + cloudProjectionRecoveryWindowMs,
    ).projectionRecoveryReceipts).toHaveLength(1);
    expect(pruneExpiredCloudProjectionRecoveryReceipts(
      terminal,
      completedAt + cloudProjectionRecoveryWindowMs + 1,
    ).projectionRecoveryReceipts).toEqual([]);
  });

  test("rejects expired same-key recovery without mutating active evidence", () => {
    const expired = terminalReceipt(220, "rejected");
    const current = recovery(221, "effect_started");
    const state = stateWith([current], [expired]);
    const snapshot = structuredClone(state);
    const now = fixedNow + cloudProjectionRecoveryWindowMs + 1_000;
    const staleReplay: CloudProjectionRecoveryJournalEntry = {
      ...recovery(222, "prepared"),
      idempotencyKey: expired.idempotencyKey,
      requestedAt: expired.requestedAt,
    };

    expect(pruneExpiredCloudProjectionRecoveryReceipts(state, now)
      .projectionRecoveryReceipts).toEqual([]);
    expect(() => addCloudProjectionRecovery(state, staleReplay, now)).toThrow(
      "Cloud projection recovery idempotency authority is expired.",
    );
    expect(state).toEqual(snapshot);
    expect(state.projectionRecoveries).toEqual([current]);
  });

  test("requires exact bound identity for active recovery and receipt replay", () => {
    const active = recovery(230, "prepared");
    const receipt = terminalReceipt(231, "applied");
    if (
      !isIdentityBoundCloudProjectionRecovery(active)
      || !isIdentityBoundCloudProjectionRecovery(receipt)
    ) throw new Error("Invalid test fixture.");

    expect(matchesCloudProjectionRecoveryIdentity(
      active,
      active.userPublicId,
      active.sourceDevicePublicId,
    )).toBe(true);
    expect(matchesCloudProjectionRecoveryIdentity(
      active,
      "user_mismatch_12345678",
      active.sourceDevicePublicId,
    )).toBe(false);
    expect(matchesCloudProjectionRecoveryIdentity(
      receipt,
      receipt.userPublicId,
      "device_mismatch_12345678",
    )).toBe(false);
    expect(() => matchesCloudProjectionRecoveryIdentity(
      active,
      "short",
      active.sourceDevicePublicId,
    )).toThrow("Cloud projection recovery identity authority is invalid.");
  });

  test("custody reads migrate v1 and writes v3 with exact generation CAS", async () => {
    const custody = new MemoryCustody();
    custody.values.set("cloud-daemon-journal", {
      generation: 7,
      value: JSON.stringify({
        commands: [],
        pendingUsageAccount: null,
        usageAccounts: [],
        version: 1,
      }),
    });
    const journal = new CustodyCloudDaemonJournal(custody);
    const observed = await journal.read();

    expect(observed).toEqual({
      generation: 7,
      state: emptyCloudDaemonJournal(),
    });
    expect(await journal.compareAndSwap(6, observed.state)).toBeNull();
    expect((await custody.read("cloud-daemon-journal"))?.generation).toBe(7);

    const committed = await journal.compareAndSwap(7, {
      commands: [],
      pendingUsageAccount: null,
      usageAccounts: [],
      version: 1,
    });
    expect(committed?.generation).toBe(8);
    expect(JSON.parse((await custody.read("cloud-daemon-journal"))?.value ?? "null")).toEqual(
      emptyCloudDaemonJournal(),
    );
  });

  test("persists bounded session pagination cursors with exact restart CAS", async () => {
    const custody = new MemoryCustody();
    const writer = new CustodyCloudSessionSyncCursor(custody);
    expect(await writer.read()).toEqual({
      generation: null,
      state: emptyCloudSessionSyncCursor(),
    });
    const first = await writer.compareAndSwap(null, advanceCloudSessionRemoteCursor({
      ...emptyCloudSessionSyncCursor(),
      localAfterPublicId: "session_12345678",
    }, "opaque-remote-cursor"));
    expect(first?.generation).toBe(0);
    if (first === null) throw new Error("Session sync cursor CAS did not commit.");
    expect(await writer.compareAndSwap(null, emptyCloudSessionSyncCursor())).toBeNull();
    expect(await new CustodyCloudSessionSyncCursor(custody).read()).toEqual(first);
    expect(parseCloudSessionSyncCursor({
      localAfterPublicId: "session_12345678",
      remoteContinueCursor: "opaque-remote-cursor",
      version: 1,
    })).toEqual(first.state);
  });

  test("carries bounded cycle authority through long advancing remote cursor sequences", () => {
    let state = emptyCloudSessionSyncCursor();
    for (let page = 1; page <= 10_000; page += 1) {
      state = advanceCloudSessionRemoteCursor(state, `page-${String(page)}`);
    }
    expect(state).toMatchObject({
      remoteContinueCursor: "page-10000",
      remoteCycle: { pageCount: 10_000 },
      version: 2,
    });
    expect(JSON.stringify(state).length).toBeLessThan(1_024);
  });

  test("rejects malformed or unbounded session pagination cursors", () => {
    expect(() => parseCloudSessionSyncCursor({
      localAfterPublicId: "short",
      remoteContinueCursor: null,
      version: 1,
    })).toThrow("Cloud session sync cursor is corrupt.");
    expect(() => parseCloudSessionSyncCursor({
      localAfterPublicId: null,
      remoteContinueCursor: "x".repeat(16_385),
      version: 1,
    })).toThrow("Cloud session sync cursor is corrupt.");
    expect(() => parseCloudSessionSyncCursor({
      localAfterPublicId: null,
      remoteContinueCursor: "😀".repeat(6_000),
      version: 1,
    })).toThrow("Cloud session sync cursor is corrupt.");
    expect(() => parseCloudSessionSyncCursor({
      extra: true,
      localAfterPublicId: null,
      remoteContinueCursor: null,
      version: 1,
    })).toThrow("Cloud session sync cursor is corrupt.");
  });

  test("accepts the exact canonical custody byte bound with exact CAS", async () => {
    const custody = new MemoryCustody();
    const journal = new CustodyCloudDaemonJournal(custody);
    const atLimitLegacy = legacyJournalAtCanonicalBytes(productionCustodyMaximumBytes);
    const atLimitCanonical = parseCloudDaemonJournal(atLimitLegacy);

    expect(atLimitLegacy.version).toBe(1);
    expect(atLimitCanonical.version).toBe(5);
    expect(serializedUtf8Bytes(atLimitCanonical)).toBe(productionCustodyMaximumBytes);

    const committed = await journal.compareAndSwap(null, atLimitLegacy);
    expect(committed?.generation).toBe(0);
    expect(custody.compareAndSwapCalls).toBe(1);
    const storedAtLimit = await custody.read("cloud-daemon-journal");
    expect(utf8Encoder.encode(storedAtLimit?.value ?? "").byteLength).toBe(
      productionCustodyMaximumBytes,
    );

    expect(custody.compareAndSwapCalls).toBe(1);
    expect(await custody.read("cloud-daemon-journal")).toEqual(storedAtLimit);
  });

  test("keeps a maximum-size v1 journal readable until its lossless v3 form fits", async () => {
    const custody = new MemoryCustody();
    const rawLegacy = legacyJournalAtRawBytes(productionCustodyMaximumBytes);
    const rawSerialized = JSON.stringify(rawLegacy);
    custody.values.set("cloud-daemon-journal", {
      generation: 11,
      value: rawSerialized,
    });
    const journal = new CustodyCloudDaemonJournal(custody);

    expect(utf8Encoder.encode(rawSerialized).byteLength).toBe(
      productionCustodyMaximumBytes,
    );
    const observed = await journal.read();
    expect(observed.generation).toBe(11);
    expect(observed.state.version).toBe(5);
    expect(serializedUtf8Bytes(observed.state)).toBeGreaterThan(
      productionCustodyMaximumBytes,
    );

    const preserved = await journal.compareAndSwap(11, observed.state);
    expect(preserved?.generation).toBe(12);
    const stillBounded = await custody.read("cloud-daemon-journal");
    expect(utf8Encoder.encode(stillBounded?.value ?? "").byteLength).toBe(
      productionCustodyMaximumBytes,
    );
    expect(JSON.parse(stillBounded?.value ?? "null")).toEqual(rawLegacy);

    const shrunk = await journal.compareAndSwap(12, {
      ...observed.state,
      pendingUsageAccount: null,
    });
    expect(shrunk?.generation).toBe(13);
    const migrated = JSON.parse(
      (await custody.read("cloud-daemon-journal"))?.value ?? "null",
    ) as { version?: unknown };
    expect(migrated.version).toBe(5);

    const oversizedRaw = JSON.stringify(
      legacyJournalAtRawBytes(productionCustodyMaximumBytes + 1),
    );
    custody.values.set("cloud-daemon-journal", {
      generation: 14,
      value: oversizedRaw,
    });
    await expect(journal.read()).rejects.toThrow("Cloud daemon journal is corrupt.");
  });

  test("keeps maximum-size active v2 recovery evidence in its lossless storage form", async () => {
    const custody = new MemoryCustody();
    const rawLegacy = legacyV2JournalAtRawBytes(productionCustodyMaximumBytes);
    custody.values.set("cloud-daemon-journal", {
      generation: 20,
      value: JSON.stringify(rawLegacy),
    });
    const journal = new CustodyCloudDaemonJournal(custody);

    const observed = await journal.read();
    expect(observed.state.version).toBe(5);
    expect(observed.state.projectionRecoveries).toHaveLength(1);
    expect(serializedUtf8Bytes(observed.state)).toBeGreaterThan(
      productionCustodyMaximumBytes,
    );
    const preserved = await journal.compareAndSwap(20, observed.state);
    expect(preserved?.generation).toBe(21);
    const stored = await custody.read("cloud-daemon-journal");
    expect(utf8Encoder.encode(stored?.value ?? "").byteLength).toBe(
      productionCustodyMaximumBytes,
    );
    expect((JSON.parse(stored?.value ?? "null") as { version?: unknown }).version)
      .toBe(2);
  });

  test("counts canonical UTF-8 bytes rather than JavaScript characters", () => {
    const providerThreadCharacters = 320;
    const ascii = journalAtBytesWithProviderThread(
      productionCustodyMaximumBytes,
      "e".repeat(providerThreadCharacters),
    );
    const originalRecovery = ascii.projectionRecoveries[0];
    if (originalRecovery === undefined) throw new Error("Invalid test fixture.");
    const multibyte: CloudDaemonJournalState = {
      ...ascii,
      projectionRecoveries: [{
        ...originalRecovery,
        localAuthority: {
          ...originalRecovery.localAuthority,
          providerThreadId: "é".repeat(providerThreadCharacters),
        },
      }],
    };

    expect(JSON.stringify(ascii).length).toBe(JSON.stringify(multibyte).length);
    expect(serializedUtf8Bytes(ascii)).toBe(productionCustodyMaximumBytes);
    expect(serializedUtf8Bytes(multibyte)).toBe(
      productionCustodyMaximumBytes + providerThreadCharacters,
    );
    expect(parseCloudDaemonJournal(ascii)).toEqual(ascii);
    expect(() => parseCloudDaemonJournal(multibyte)).toThrow(
      "Cloud daemon journal is corrupt.",
    );
  });

  test("retains recent receipts and rejects a new recovery above the aggregate byte bound", () => {
    const atLimit = journalAtBytesWithReceipt(productionCustodyMaximumBytes);
    const receipt = atLimit.projectionRecoveryReceipts[0];
    if (receipt === undefined) throw new Error("Invalid test fixture.");

    expect(serializedUtf8Bytes(atLimit)).toBe(productionCustodyMaximumBytes);
    expect(() => addCloudProjectionRecovery(
      atLimit,
      recovery(240, "prepared"),
      fixedNow + 240,
    )).toThrow("Cloud daemon journal is corrupt.");
    expect(atLimit.projectionRecoveryReceipts).toEqual([receipt]);
    expect(pruneExpiredCloudProjectionRecoveryReceipts(
      atLimit,
      fixedNow + 240,
    ).projectionRecoveryReceipts).toEqual([receipt]);
  });

  test("reserves the worst-case applied response before admitting a remote effect", () => {
    const prepared = recovery(241, "prepared", 0);
    const atLimit = journalBeforeRecoveryAtAppliedBytes(
      productionCustodyMaximumBytes,
      prepared,
    );
    const admitted = addCloudProjectionRecovery(atLimit, prepared, fixedNow + 241);
    const effectStarted = parseCloudProjectionRecoveryEntry({
      ...prepared,
      phase: "effect_started",
    });
    const started = transitionCloudProjectionRecovery(
      admitted,
      prepared,
      effectStarted,
      fixedNow + 241,
    );
    const applied = capacityAppliedRecovery(prepared);
    const completed = transitionCloudProjectionRecovery(
      started,
      effectStarted,
      applied,
      fixedNow + 241,
    );

    expect(serializedUtf8Bytes({
      ...atLimit,
      projectionRecoveries: [applied],
    })).toBe(productionCustodyMaximumBytes);
    expect(serializedUtf8Bytes(completed)).toBe(productionCustodyMaximumBytes);

    const oneByteTooSmall = journalBeforeRecoveryAtAppliedBytes(
      productionCustodyMaximumBytes + 1,
      prepared,
    );
    const snapshot = structuredClone(oneByteTooSmall);
    expect(() => addCloudProjectionRecovery(
      oneByteTooSmall,
      prepared,
      fixedNow + 241,
    )).toThrow("Cloud daemon journal is corrupt.");
    expect(oneByteTooSmall).toEqual(snapshot);
  });

  test("reserves applied capacity by UTF-8 bytes for multibyte recovery authority", () => {
    const original = recovery(242, "prepared", 0);
    const prepared = parseCloudProjectionRecoveryEntry({
      ...original,
      localAuthority: {
        ...original.localAuthority,
        providerThreadId: "é".repeat(320),
      },
    });
    const atLimit = journalBeforeRecoveryAtAppliedBytes(
      productionCustodyMaximumBytes,
      prepared,
    );
    const admitted = addCloudProjectionRecovery(atLimit, prepared, fixedNow + 242);
    expect(admitted.projectionRecoveries).toEqual([prepared]);
    expect(serializedUtf8Bytes({
      ...atLimit,
      projectionRecoveries: [capacityAppliedRecovery(prepared)],
    })).toBe(productionCustodyMaximumBytes);
  });

  test("reserves every maximum command terminal outcome before an effect can start", () => {
    const prepared = command(500);
    const atLimit = journalBeforeCommandAtTerminalBytes(
      productionCustodyMaximumBytes,
      prepared,
    );
    const admitted = addCloudCommandJournalEntry(atLimit, prepared);
    const effectStarted: CloudCommandJournalEntry = {
      ...prepared,
      phase: "effect_started",
    };
    const started = transitionCloudCommandJournalEntry(admitted, effectStarted);

    for (const terminalState of ["applied", "failed", "ambiguous"] as const) {
      const terminal = capacityTerminalCommand(effectStarted, terminalState);
      const completed = transitionCloudCommandJournalEntry(
        started,
        terminal,
      );
      expect(serializedUtf8Bytes(completed)).toBeLessThanOrEqual(
        productionCustodyMaximumBytes,
      );
      expect(completed.commands.at(-1)).toEqual(terminal);
    }
    expect(serializedUtf8Bytes(transitionCloudCommandJournalEntry(
      started,
      capacityTerminalCommand(effectStarted),
    ))).toBe(productionCustodyMaximumBytes);

    const overLimit = journalBeforeCommandAtTerminalBytes(
      productionCustodyMaximumBytes + 128,
      prepared,
    );
    const snapshot = structuredClone(overLimit);
    expect(() => addCloudCommandJournalEntry(overLimit, prepared)).toThrow(
      "Cloud daemon journal is corrupt.",
    );
    expect(overLimit).toEqual(snapshot);
  });

  test("incrementally settles dense legacy commands without admitting a new effect", () => {
    const legacyCommands = capacityCommands.map((entry) => ({
      ...entry,
      phase: "effect_started" as const,
    }));
    let current = parseCloudDaemonJournal({
      commands: legacyCommands,
      pendingUsageAccount: null,
      usageAccounts: [],
      version: 1,
    });

    for (const active of legacyCommands) {
      const terminal = {
        ...active,
        phase: "terminal" as const,
        resultCode: "LOCAL_EFFECT_RECOVERY_REQUIRED",
        resultDigest: digest("f"),
        terminalState: "ambiguous" as const,
      };
      current = transitionCloudCommandJournalEntry(current, terminal);
      expect(current.commands.find((entry) =>
        entry.commandPublicId === active.commandPublicId)).toEqual(terminal);
      current = parseCloudDaemonJournal({
        ...current,
        commands: current.commands.filter((entry) =>
          entry.commandPublicId !== active.commandPublicId),
      });
    }
    expect(current.commands).toEqual([]);

    const prepared = parseCloudDaemonJournal({
      commands: capacityCommands,
      pendingUsageAccount: null,
      usageAccounts: [],
      version: 1,
    });
    expect(() => transitionCloudCommandJournalEntry(prepared, {
      ...capacityCommands[0] as CloudCommandJournalEntry,
      phase: "effect_started",
    })).toThrow("Cloud daemon journal is corrupt.");
    expect(() => transitionCloudCommandJournalEntry(prepared, {
      ...capacityCommands[0] as CloudCommandJournalEntry,
      phase: "terminal",
      resultCode: "NO_EFFECT",
      resultDigest: digest("e"),
      terminalState: "failed",
    })).not.toThrow();
  });

  test("atomically terminalizes every prepared command in a dense legacy cohort", () => {
    const legacy = parseCloudDaemonJournal({
      commands: capacityCommands,
      pendingUsageAccount: null,
      usageAccounts: [],
      version: 1,
    });
    const resultCode = "LOCAL_JOURNAL_CAPACITY_BEFORE_EFFECT";
    const resultDigest = digest("e");

    expect(() => assertCloudDaemonJournalFutureCapacity(legacy)).toThrow(
      "Cloud daemon journal is corrupt.",
    );
    const terminalized = terminalizeUnreservedPreparedCloudCommands(legacy, {
      resultCode,
      resultDigest,
    });

    expect(terminalized.commands).toEqual(capacityCommands.map((entry) => ({
      ...entry,
      phase: "terminal",
      resultCode,
      resultDigest,
      terminalState: "failed",
    })));
    expect(terminalized.commands.map((entry) => entry.commandPublicId)).toEqual(
      capacityCommands.map((entry) => entry.commandPublicId),
    );
    expect(serializedUtf8Bytes(terminalized)).toBeLessThanOrEqual(
      productionCustodyMaximumBytes,
    );

    const reserved = addCloudCommandJournalEntry(emptyCloudDaemonJournal(), command(700));
    expect(terminalizeUnreservedPreparedCloudCommands(reserved, {
      resultCode,
      resultDigest,
    })).toEqual(reserved);
  });

  test("completes a legacy pending usage outbox by retiring one reconstructable cursor", () => {
    const pending = {
      ...pendingUsageAccount(22),
      accountPublicId: "account_pending_12345678",
    };
    const usageAccounts = Array.from({ length: 100 }, (_, index) => ({
      accountPublicId: `account_${index.toString().padStart(8, "0")}`,
      sourceGeneration: 1,
      sourceRevision: 0,
    }));
    const legacy = parseCloudDaemonJournal({
      commands: [],
      pendingUsageAccount: pending,
      usageAccounts,
      version: 1,
    });

    const completed = completePendingCloudUsageAccount(legacy, pending);

    expect(completed.pendingUsageAccount).toBeNull();
    expect(completed.usageAccounts).toHaveLength(100);
    expect(completed.usageAccounts.some((entry) =>
      entry.accountPublicId === pending.accountPublicId)).toBe(true);
    expect(completed.usageAccounts.some((entry) =>
      entry.accountPublicId === "account_00000000")).toBe(false);

    const advancedPending = { ...pending, sourceGeneration: 2, sourceRevision: 5 };
    const advancedState = parseCloudDaemonJournal({
      ...legacy,
      pendingUsageAccount: advancedPending,
    });
    expect(completePendingCloudUsageAccount(advancedState, advancedPending, 3, 8)
      .usageAccounts.find((entry) => entry.accountPublicId === pending.accountPublicId))
      .toMatchObject({ sourceGeneration: 3, sourceRevision: 8 });
    expect(() => completePendingCloudUsageAccount(advancedState, advancedPending, 1, 8))
      .toThrow("Cloud usage account cursor regressed.");
    expect(() => completePendingCloudUsageAccount(advancedState, advancedPending, 3, 4))
      .toThrow("Cloud usage account cursor regressed.");
  });

  test("rejects custody payloads above the production byte bound before decoding", async () => {
    const custody = new MemoryCustody();
    const oversized = journalAtBytesWithProviderThread(
      productionCustodyMaximumBytes + 1,
      "e".repeat(320),
    );
    expect(serializedUtf8Bytes(oversized)).toBe(productionCustodyMaximumBytes + 1);
    custody.values.set("cloud-daemon-journal", {
      generation: 0,
      value: JSON.stringify(oversized),
    });

    await expect(new CustodyCloudDaemonJournal(custody).read()).rejects.toThrow(
      "Cloud daemon journal is corrupt.",
    );
  });

  test("a newly opened blocker preserves exact unsettled session and profile authority", async () => {
    const custody = new MemoryCustody();
    const writer = new CustodyCloudDaemonJournal(custody);
    const pending = recovery(3, "effect_started");
    expect(await writer.compareAndSwap(null, stateWith([pending]))).not.toBeNull();

    const reopened = new CloudDaemonJournalRecoveryBlocker(
      new CustodyCloudDaemonJournal(custody),
    );
    expect(await reopened.isCompactProjectionRecoveryUnsettled(pending.sessionPublicId)).toBe(true);
    expect(await reopened.isCompactProjectionRecoveryUnsettled("session_unrelated_12345678")).toBe(false);
    expect(await reopened.isCompactProjectionRecoveryUnsettledForProfile(
      pending.localAuthority.profileId,
    )).toBe(true);
    expect(await reopened.isCompactProjectionRecoveryUnsettledForProfile(
      "profile_unrelated_12345678",
    )).toBe(false);
    expect(hasUnsettledCompactProjectionRecoveryForProfile(
      (await writer.read()).state,
      pending.localAuthority.profileId,
    )).toBe(true);
    expect(() => hasUnsettledCompactProjectionRecoveryForProfile(
      stateWith([pending]),
      "short",
    )).toThrow("Cloud projection recovery profile authority is invalid.");

    const observed = await writer.read();
    const receipt = createCloudProjectionRecoveryTerminalReceipt(pending, {
      phase: "rejected",
      rejectionCode: "AUTHORITY_REJECTED",
    });
    const settled = transitionCloudProjectionRecovery(
      observed.state,
      pending,
      receipt,
      fixedNow + 3,
    );
    expect(await writer.compareAndSwap(observed.generation, settled)).not.toBeNull();
    expect(await reopened.isCompactProjectionRecoveryUnsettled(pending.sessionPublicId)).toBe(false);
    expect(await reopened.isCompactProjectionRecoveryUnsettledForProfile(
      pending.localAuthority.profileId,
    )).toBe(false);
  });

  test("a reopened blocker supersedes only recoveries whose local session is terminal", async () => {
    const custody = new MemoryCustody();
    const writer = new CustodyCloudDaemonJournal(custody);
    const terminal = recovery(240, "effect_started");
    const active = recovery(241, "prepared");
    expect(await writer.compareAndSwap(null, stateWith([terminal, active])))
      .not.toBeNull();

    const reopened = new CloudDaemonJournalRecoveryBlocker(
      new CustodyCloudDaemonJournal(custody),
      { isSessionTerminal: (sessionPublicId) => sessionPublicId === terminal.sessionPublicId },
    );
    expect(await reopened.supersedeTerminalCompactProjectionRecoveries())
      .toEqual({ superseded: 1 });
    const observed = (await writer.read()).state;
    expect(observed.projectionRecoveries).toEqual([active]);
    expect(observed.projectionRecoveryReceipts).toEqual([
      expect.objectContaining({
        idempotencyKey: terminal.idempotencyKey,
        rejectionCode: providerDeletionProjectionRecoveryCode,
      }),
    ]);
    expect(await reopened.supersedeTerminalCompactProjectionRecoveries())
      .toEqual({ superseded: 0 });
  });

  test("persists only bounded identity-bound attention reconciliation evidence", async () => {
    const custody = new MemoryCustody();
    const writer = new CustodyCloudAttentionNotificationReconciliation(custody);
    const identityBound = bindCloudAttentionNotificationReconciliationState(
      emptyCloudAttentionNotificationReconciliationState(),
      "user_attention_12345678",
      "device_attention_12345678",
    );
    const complete = {
      allowedWindowEnd: fixedNow + 60_000,
      candidateCount: 2,
      expectedGlobalNotificationGeneration: 3,
      localNotificationPolicyRevision: 4,
      mode: "complete" as const,
      reconciliationSequence: 5,
    };
    const pending = setCloudAttentionNotificationPending(identityBound, complete);
    const first = await writer.compareAndSwap(null, pending);
    expect(first?.generation).toBe(0);
    const stored = custody.values.get("cloud-attention-notification-reconciliation");
    expect(stored?.value).not.toContain("interaction_");
    expect(stored?.value).not.toContain("session_");
    expect(new TextEncoder().encode(stored?.value).byteLength).toBeLessThanOrEqual(4_096);

    const receipt = {
      acknowledgedAt: fixedNow,
      candidateCount: 2,
      consentLeaseUntil: fixedNow + 60_000,
      globalNotificationGeneration: 3,
      localNotificationPolicyRevision: 4,
      reconciliationSequence: 5,
      state: "complete" as const,
    };
    const settled = settleCloudAttentionNotificationReconciliation(
      pending,
      complete,
      receipt,
    );
    expect(await writer.compareAndSwap(first?.generation ?? null, settled)).not.toBeNull();
    expect((await new CustodyCloudAttentionNotificationReconciliation(custody).read()).state)
      .toEqual(settled);
    expect(await writer.compareAndSwap(0, pending)).toBeNull();
    expect(() => bindCloudAttentionNotificationReconciliationState(
      settled,
      "user_other_12345678",
      "device_attention_12345678",
    )).toThrow("identity changed");
  });

  test("rejects corrupt attention custody, invalid receipts, and nonadvancing sequences", async () => {
    const bound = bindCloudAttentionNotificationReconciliationState(
      emptyCloudAttentionNotificationReconciliationState(),
      "user_attention_12345678",
      "device_attention_12345678",
    );
    const invalidation = {
      localNotificationPolicyRevision: 2,
      mode: "invalidate" as const,
      reconciliationSequence: 7,
    };
    const pending = setCloudAttentionNotificationPending(bound, invalidation);
    expect(() => setCloudAttentionNotificationPending(pending, {
      ...invalidation,
      reconciliationSequence: 6,
    })).toThrow("sequence did not advance");
    expect(() => settleCloudAttentionNotificationReconciliation(
      pending,
      invalidation,
      {
        acknowledgedAt: fixedNow,
        consentLeaseUntil: fixedNow + 1,
        globalNotificationGeneration: 1,
        localNotificationPolicyRevision: 2,
        reconciliationSequence: 7,
        state: "invalidated",
      },
    )).toThrow("changed concurrently");
    expect(() => parseCloudAttentionNotificationReconciliationState({
      ...bound,
      extra: true,
    })).toThrow("is corrupt");
    expect(() => parseCloudAttentionNotificationReconciliationState({
      ...bound,
      devicePublicId: null,
    })).toThrow("is corrupt");

    const custody = new MemoryCustody();
    custody.values.set("cloud-attention-notification-reconciliation", {
      generation: 0,
      value: "x".repeat(4_097),
    });
    await expect(new CustodyCloudAttentionNotificationReconciliation(custody).read())
      .rejects.toThrow("is corrupt");
  });

  test("reserves the final attention sequence against foreign complete evidence", () => {
    const bound = bindCloudAttentionNotificationReconciliationState(
      emptyCloudAttentionNotificationReconciliationState(),
      "user_attention_12345678",
      "device_attention_12345678",
    );
    const complete = {
      allowedWindowEnd: fixedNow + 60_000,
      candidateCount: 0,
      expectedGlobalNotificationGeneration: 1,
      localNotificationPolicyRevision: 1,
      mode: "complete" as const,
      reconciliationSequence: Number.MAX_SAFE_INTEGER,
    };
    const receipt = {
      acknowledgedAt: fixedNow,
      candidateCount: 0,
      consentLeaseUntil: fixedNow + 60_000,
      globalNotificationGeneration: 1,
      localNotificationPolicyRevision: 1,
      reconciliationSequence: Number.MAX_SAFE_INTEGER,
      state: "complete" as const,
    };

    expect(() => parseCloudAttentionNotificationReconciliationState({
      ...bound,
      pending: complete,
    })).toThrow("is corrupt");
    expect(() => parseCloudAttentionNotificationReconciliationState({
      ...bound,
      lastReceipt: { receipt, request: complete },
    })).toThrow("is corrupt");
    expect(parseCloudAttentionNotificationReconciliationState({
      ...bound,
      pending: {
        localNotificationPolicyRevision: 1,
        mode: "invalidate",
        reconciliationSequence: Number.MAX_SAFE_INTEGER,
      },
    }).pending).toMatchObject({
      mode: "invalidate",
      reconciliationSequence: Number.MAX_SAFE_INTEGER,
    });
  });

  test("resets attention reconciliation only for an explicit same-user replacement device", () => {
    const user = "user_attention_replacement_12345678";
    const oldDevice = "device_attention_old_12345678";
    const newDevice = "device_attention_new_12345678";
    const bound = bindCloudAttentionNotificationReconciliationState(
      emptyCloudAttentionNotificationReconciliationState(),
      user,
      oldDevice,
    );
    const pending = setCloudAttentionNotificationPending(bound, {
      localNotificationPolicyRevision: 7,
      mode: "invalidate",
      reconciliationSequence: 4,
    });
    expect(replaceCloudAttentionNotificationReconciliationDevice(
      pending,
      user,
      newDevice,
    )).toEqual({
      devicePublicId: newDevice,
      lastReceipt: null,
      pending: null,
      userPublicId: user,
      version: 1,
    });
    expect(() => replaceCloudAttentionNotificationReconciliationDevice(
      pending,
      "user_attention_foreign_12345678",
      newDevice,
    )).toThrow("identity changed");
    expect(() => replaceCloudAttentionNotificationReconciliationDevice(
      pending,
      user,
      oldDevice,
    )).toThrow("device did not change");
    expect(() => replaceCloudAttentionNotificationReconciliationDevice(
      emptyCloudAttentionNotificationReconciliationState(),
      user,
      newDevice,
    )).toThrow("identity changed");
  });

  test("canonical attention reconciliation states round-trip for bounded requests and receipts", () => {
    fc.assert(fc.property(
      fc.record({
        candidateCount: fc.integer({ min: 0, max: 64 }),
        complete: fc.boolean(),
        globalGeneration: fc.integer({ min: 1, max: 1_000 }),
        revision: fc.integer({ min: 1, max: 1_000 }),
        sequence: fc.integer({ min: 1, max: 1_000_000 }),
      }),
      (sample) => {
        const bound = bindCloudAttentionNotificationReconciliationState(
          emptyCloudAttentionNotificationReconciliationState(),
          "user_property_12345678",
          "device_property_12345678",
        );
        const request = sample.complete
          ? {
              allowedWindowEnd: fixedNow + 120_000,
              candidateCount: sample.candidateCount,
              expectedGlobalNotificationGeneration: sample.globalGeneration,
              localNotificationPolicyRevision: sample.revision,
              mode: "complete" as const,
              reconciliationSequence: sample.sequence,
            }
          : {
              localNotificationPolicyRevision: sample.revision,
              mode: "invalidate" as const,
              reconciliationSequence: sample.sequence,
            };
        const pending = setCloudAttentionNotificationPending(bound, request);
        const receipt = sample.complete
          ? {
              acknowledgedAt: fixedNow,
              candidateCount: sample.candidateCount,
              consentLeaseUntil: fixedNow + 60_000,
              globalNotificationGeneration: sample.globalGeneration,
              localNotificationPolicyRevision: sample.revision,
              reconciliationSequence: sample.sequence,
              state: "complete" as const,
            }
          : {
              acknowledgedAt: fixedNow,
              consentLeaseUntil: fixedNow,
              globalNotificationGeneration: sample.globalGeneration,
              localNotificationPolicyRevision: sample.revision,
              reconciliationSequence: sample.sequence,
              state: "invalidated" as const,
            };
        const settled = settleCloudAttentionNotificationReconciliation(
          pending,
          request,
          receipt,
        );
        expect(parseCloudAttentionNotificationReconciliationState(
          jsonClone(settled),
        )).toEqual(settled);
      },
    ), { numRuns: 100 });
  });
});
