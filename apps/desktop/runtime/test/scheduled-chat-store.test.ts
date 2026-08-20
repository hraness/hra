import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  SESSION_SYNC_PROTOCOL,
  positiveSyncUint64Schema,
  sealedScheduledChatDefinitionSchema,
  sessionPublicIdSchema,
  syncSha256DigestSchema,
} from "@hraness/agent-tasks-protocol";

import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";
import {
  SCHEDULED_CHAT_LOCAL_RUN_RETENTION_MS,
  ScheduledChatStore,
  scheduledChatMessageId,
} from "../src/state/scheduled-chat-store";

const NOW = Date.parse("2026-08-19T12:00:00.000Z");
const PANE = "pane_scheduled_store_01";
const ACCOUNT = "acct_scheduled_store_01";
const REPOSITORY = `repo_${"1".repeat(26)}`;
const SESSION = sessionPublicIdSchema.parse(`syncsession_${"s".repeat(32)}`);
const RRULE_ONE = "DTSTART;TZID=America/Puerto_Rico:20260820T090000\nRRULE:FREQ=DAILY;INTERVAL=1";
const RRULE_TWO = "DTSTART;TZID=America/Puerto_Rico:20260821T120000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR";

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

function digest(character: string) {
  return syncSha256DigestSchema.parse(`sha256_${character.repeat(64)}`);
}

function definition(input: {
  generation: number;
  rrule: string;
  digestCharacter: string;
}) {
  return sealedScheduledChatDefinitionSchema.parse({
    header: {
      protocol: SESSION_SYNC_PROTOCOL,
      payloadKind: "scheduled_chat_definition",
      payloadVersion: 1,
      tenantId: opaque("synctenant", "t"),
      organizationId: opaque("syncorg", "o"),
      ownerUserId: opaque("syncuser", "u"),
      vaultId: opaque("syncvault", "v"),
      vaultGeneration: "1",
      membershipEpoch: "1",
      originDeviceId: opaque("syncdevice", "d"),
      sessionId: SESSION,
      mirrorEpoch: "1",
      writerGeneration: "1",
      bootId: opaque("syncboot", "b"),
      bootGeneration: "1",
      keyEpoch: "1",
      previousGeneration: String(input.generation - 1),
      generation: String(input.generation),
      rrule: input.rrule,
      timeZone: "America/Puerto_Rico",
    },
    algorithm: "HKDF-SHA256-A256GCM",
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA",
    ciphertextBytes: 17,
    ciphertextDigest: digest(input.digestCharacter),
  });
}

function createFixture(): Readonly<{
  database: Database;
  panes: ChatPaneStore;
  schedules: ScheduledChatStore;
}> {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles(
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Scheduled account', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, new Date(NOW).toISOString());
  const schedules = new ScheduledChatStore(database);
  const panes = new ChatPaneStore(database, { scheduledChatStore: schedules });
  panes.create({
    paneId: PANE,
    repository: {
      id: REPOSITORY,
      name: "Scheduled fixture",
      workingDirectory: "/fixture/scheduled",
    },
    accountProfileId: ACCOUNT,
    now: new Date(NOW),
  });
  database.query(`
    INSERT INTO session_sync_grid_positions(
      session_id, grid_position, origin, discovered_at
    ) VALUES (?1, 0, 'local', ?2)
  `).run(SESSION, NOW);
  database.query(`
    INSERT INTO session_sync_pane_bindings(
      pane_id, session_id, tenant_id, organization_id, owner_user_id,
      vault_id, vault_generation, origin_device_id, included,
      binding_state, creation_grant_digest, reserved_at, created_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, '1', ?7, 1,
      'accepted', ?8, ?9, ?9
    )
  `).run(
    PANE,
    SESSION,
    opaque("synctenant", "t"),
    opaque("syncorg", "o"),
    opaque("syncuser", "u"),
    opaque("syncvault", "v"),
    opaque("syncdevice", "d"),
    digest("e"),
    NOW,
  );
  return { database, panes, schedules };
}

function preparePut(input: {
  schedules: ScheduledChatStore;
  expectedPaneRevision: number;
  operationSuffix: string;
  generation: number;
  rrule: string;
  nextRunAt: number;
  digestCharacter: string;
}) {
  const sealed = definition({
    generation: input.generation,
    rrule: input.rrule,
    digestCharacter: input.digestCharacter,
  });
  return input.schedules.preparePut({
    operationId: `syncop_${input.operationSuffix.repeat(32)}`,
    paneId: PANE,
    sessionId: SESSION,
    expectedPaneRevision: input.expectedPaneRevision,
    targetGeneration: positiveSyncUint64Schema.parse(String(input.generation)),
    request: { version: 1, operation: "put_scheduled_chat", definition: sealed },
    definition: sealed,
    nextRunAt: input.nextRunAt,
    now: NOW,
  });
}

function putResponse(input: {
  generation: number;
  rrule: string;
  nextRunAt: number;
  digestCharacter: string;
}) {
  return {
    kind: "scheduled_chat_put" as const,
    sessionId: SESSION,
    schedule: {
      generation: positiveSyncUint64Schema.parse(String(input.generation)),
      rrule: input.rrule,
      timeZone: "America/Puerto_Rico",
      nextRunAt: input.nextRunAt,
    },
    ciphertextDigest: digest(input.digestCharacter),
    replay: false,
  };
}

function clearResponse(generation: number) {
  return {
    kind: "scheduled_chat_cleared" as const,
    sessionId: SESSION,
    generation: positiveSyncUint64Schema.parse(String(generation)),
    replay: false,
  };
}

test("scheduled chat replacement is cloud-fenced and projection-atomic", () => {
  const fixture = createFixture();
  try {
    const prepared = preparePut({
      schedules: fixture.schedules,
      expectedPaneRevision: 1,
      operationSuffix: "1",
      generation: 1,
      rrule: RRULE_ONE,
      nextRunAt: NOW + 86_400_000,
      digestCharacter: "a",
    });
    expect(prepared).toMatchObject({
      kind: "put",
      state: "prepared",
      expectedScheduleRevision: null,
      targetScheduleRevision: 1,
    });
    expect(fixture.panes.require(PANE).projection.schedule).toBeNull();

    fixture.schedules.markEffectStarted(prepared.operationId, NOW + 1);
    fixture.schedules.transaction(() => {
      fixture.schedules.completeMutationInTransaction(
        prepared.operationId,
        NOW + 2,
        putResponse({
          generation: 1,
          rrule: RRULE_ONE,
          nextRunAt: NOW + 86_400_000,
          digestCharacter: "a",
        }),
      );
    });
    expect(fixture.panes.require(PANE).projection).toMatchObject({
      revision: 2,
      schedule: {
        revision: 1,
        rrule: RRULE_ONE,
        timeZone: "America/Puerto_Rico",
        nextRunAt: new Date(NOW + 86_400_000).toISOString(),
      },
    });

    const replacement = preparePut({
      schedules: fixture.schedules,
      expectedPaneRevision: 2,
      operationSuffix: "2",
      generation: 2,
      rrule: RRULE_TWO,
      nextRunAt: NOW + 172_800_000,
      digestCharacter: "b",
    });
    fixture.schedules.markEffectStarted(replacement.operationId, NOW + 3);
    expect(() => fixture.schedules.transaction(() => {
      fixture.schedules.completeMutationInTransaction(
        replacement.operationId,
        NOW + 4,
        putResponse({
          generation: 2,
          rrule: RRULE_TWO,
          nextRunAt: NOW + 172_800_000,
          digestCharacter: "b",
        }),
      );
      throw new Error("injected rollback");
    })).toThrow("injected rollback");
    expect(fixture.schedules.mutation(replacement.operationId)?.state).toBe(
      "effect_started",
    );
    expect(fixture.panes.require(PANE).projection.schedule?.rrule).toBe(RRULE_ONE);

    fixture.schedules.transaction(() => {
      fixture.schedules.completeMutationInTransaction(
        replacement.operationId,
        NOW + 5,
        putResponse({
          generation: 2,
          rrule: RRULE_TWO,
          nextRunAt: NOW + 172_800_000,
          digestCharacter: "b",
        }),
      );
    });
    expect(fixture.panes.require(PANE).projection).toMatchObject({
      revision: 3,
      schedule: { revision: 2, rrule: RRULE_TWO },
    });
  } finally {
    fixture.database.close();
  }
});

test("scheduled chat removal preserves the prior schedule until cloud success", () => {
  const fixture = createFixture();
  try {
    const put = preparePut({
      schedules: fixture.schedules,
      expectedPaneRevision: 1,
      operationSuffix: "3",
      generation: 1,
      rrule: RRULE_ONE,
      nextRunAt: NOW + 86_400_000,
      digestCharacter: "c",
    });
    fixture.schedules.markEffectStarted(put.operationId, NOW + 1);
    fixture.schedules.completeMutationInTransaction(
      put.operationId,
      NOW + 2,
      putResponse({
        generation: 1,
        rrule: RRULE_ONE,
        nextRunAt: NOW + 86_400_000,
        digestCharacter: "c",
      }),
    );

    const operationId = `syncop_${"4".repeat(32)}`;
    const clear = fixture.schedules.prepareClear({
      operationId,
      paneId: PANE,
      sessionId: SESSION,
      expectedPaneRevision: 2,
      targetGeneration: positiveSyncUint64Schema.parse("1"),
      request: {
        version: 1,
        operation: "clear_scheduled_chat",
        sessionId: SESSION,
        expectedGeneration: "1",
      },
      now: NOW + 3,
    });
    expect(clear).toMatchObject({ kind: "clear", state: "prepared" });
    expect(fixture.panes.require(PANE).projection.schedule).not.toBeNull();
    fixture.schedules.discardPrepared(operationId);
    expect(fixture.panes.require(PANE).projection.schedule).not.toBeNull();

    const retried = fixture.schedules.prepareClear({
      operationId: `syncop_${"5".repeat(32)}`,
      paneId: PANE,
      sessionId: SESSION,
      expectedPaneRevision: 2,
      targetGeneration: positiveSyncUint64Schema.parse("1"),
      request: {
        version: 1,
        operation: "clear_scheduled_chat",
        sessionId: SESSION,
        expectedGeneration: "1",
      },
      now: NOW + 4,
    });
    fixture.schedules.markEffectStarted(retried.operationId, NOW + 5);
    fixture.schedules.completeMutationInTransaction(
      retried.operationId,
      NOW + 6,
      clearResponse(1),
    );
    expect(fixture.panes.require(PANE).projection).toMatchObject({
      revision: 3,
      schedule: null,
    });
  } finally {
    fixture.database.close();
  }
});

test("durable off intent survives a lost put postimage and fences due execution", () => {
  const fixture = createFixture();
  try {
    const put = preparePut({
      schedules: fixture.schedules,
      expectedPaneRevision: 1,
      operationSuffix: "o",
      generation: 1,
      rrule: RRULE_ONE,
      nextRunAt: NOW + 86_400_000,
      digestCharacter: "8",
    });
    fixture.schedules.markEffectStarted(put.operationId, NOW + 1);
    expect(fixture.schedules.requestDesiredOff({
      paneId: PANE,
      expectedPaneRevision: 1,
      now: NOW + 2,
    })).toMatchObject({
      sessionId: SESSION,
      targetGeneration: "1",
    });

    fixture.schedules.completeMutationInTransaction(
      put.operationId,
      NOW + 3,
      putResponse({
        generation: 1,
        rrule: RRULE_ONE,
        nextRunAt: NOW + 86_400_000,
        digestCharacter: "8",
      }),
    );
    expect(fixture.schedules.desiredOff(PANE)).toMatchObject({
      targetGeneration: "1",
    });
    expect(fixture.panes.require(PANE).projection).toMatchObject({
      revision: 2,
      schedule: { revision: 1 },
    });
    expect(() => fixture.database.query(`
      UPDATE chat_panes SET title = 'must not write' WHERE pane_id = ?1
    `).run(PANE)).toThrow("scheduled chat off intent quarantines pane updates");
    expect(() => fixture.schedules.enqueueRunInTransaction({
      runId: `syncrun_${"8".repeat(26)}`,
      paneId: PANE,
      scheduleGeneration: positiveSyncUint64Schema.parse("1"),
      occurrenceSequence: positiveSyncUint64Schema.parse("1"),
      scheduledFor: NOW + 86_400_000,
      definitionCiphertextDigest: digest("8"),
      now: NOW + 4,
      enqueue: () => "must not enqueue",
    })).toThrow("being turned off");

    const clear = fixture.schedules.prepareClear({
      operationId: `syncop_${"p".repeat(32)}`,
      paneId: PANE,
      sessionId: SESSION,
      expectedPaneRevision: 2,
      targetGeneration: positiveSyncUint64Schema.parse("1"),
      request: {
        version: 1,
        operation: "clear_scheduled_chat",
        sessionId: SESSION,
        expectedGeneration: "1",
      },
      now: NOW + 5,
    });
    fixture.schedules.markEffectStarted(clear.operationId, NOW + 6);
    fixture.schedules.completeMutationInTransaction(
      clear.operationId,
      NOW + 7,
      clearResponse(1),
    );
    expect(fixture.schedules.desiredOff(PANE)).toBeNull();
    expect(fixture.panes.require(PANE).projection).toMatchObject({
      revision: 3,
      schedule: null,
    });
  } finally {
    fixture.database.close();
  }
});

test("scheduled occurrences map to one durable message and advance only after ack", () => {
  const fixture = createFixture();
  try {
    const put = preparePut({
      schedules: fixture.schedules,
      expectedPaneRevision: 1,
      operationSuffix: "6",
      generation: 1,
      rrule: RRULE_ONE,
      nextRunAt: NOW + 86_400_000,
      digestCharacter: "d",
    });
    fixture.schedules.markEffectStarted(put.operationId, NOW + 1);
    fixture.schedules.completeMutationInTransaction(
      put.operationId,
      NOW + 2,
      putResponse({
        generation: 1,
        rrule: RRULE_ONE,
        nextRunAt: NOW + 86_400_000,
        digestCharacter: "d",
      }),
    );

    const runId = `syncrun_${"0".repeat(26)}`;
    let enqueueCount = 0;
    const first = fixture.schedules.transaction(() =>
      fixture.schedules.enqueueRunInTransaction({
        runId,
        paneId: PANE,
        scheduleGeneration: positiveSyncUint64Schema.parse("1"),
        occurrenceSequence: positiveSyncUint64Schema.parse("1"),
        scheduledFor: NOW + 86_400_000,
        definitionCiphertextDigest: digest("d"),
        now: NOW + 3,
        enqueue: (messageId) => {
          enqueueCount += 1;
          expect(messageId).toBe(scheduledChatMessageId(runId));
          return "queued" as const;
        },
      })
    );
    expect(first).toMatchObject({ disposition: "applied", value: "queued" });
    const replay = fixture.schedules.enqueueRunInTransaction({
      runId,
      paneId: PANE,
      scheduleGeneration: positiveSyncUint64Schema.parse("1"),
      occurrenceSequence: positiveSyncUint64Schema.parse("1"),
      scheduledFor: NOW + 86_400_000,
      definitionCiphertextDigest: digest("d"),
      now: NOW + 4,
      enqueue: () => {
        enqueueCount += 1;
        return "unexpected" as const;
      },
    });
    expect(replay).toMatchObject({ disposition: "replayed", value: null });
    expect(enqueueCount).toBe(1);

    fixture.schedules.acknowledgeRunInTransaction({
      runId,
      expectedPaneId: PANE,
      expectedSessionId: SESSION,
      expectedScheduleGeneration: positiveSyncUint64Schema.parse("1"),
      expectedOccurrenceSequence: positiveSyncUint64Schema.parse("1"),
      expectedScheduledFor: NOW + 86_400_000,
      nextRunAt: NOW + 172_800_000,
      now: NOW + 5,
    });
    expect(fixture.schedules.run(runId)?.state).toBe("acknowledged");
    expect(fixture.schedules.get(PANE)?.nextRunAt).toBe(NOW + 172_800_000);
  } finally {
    fixture.database.close();
  }
});

test("terminal scheduled runs purge at the retention boundary and leave live runs", () => {
  const fixture = createFixture();
  try {
    const put = preparePut({
      schedules: fixture.schedules,
      expectedPaneRevision: 1,
      operationSuffix: "7",
      generation: 1,
      rrule: RRULE_ONE,
      nextRunAt: NOW + 86_400_000,
      digestCharacter: "f",
    });
    fixture.schedules.markEffectStarted(put.operationId, NOW + 1);
    fixture.schedules.completeMutationInTransaction(
      put.operationId,
      NOW + 2,
      putResponse({
        generation: 1,
        rrule: RRULE_ONE,
        nextRunAt: NOW + 86_400_000,
        digestCharacter: "f",
      }),
    );

    const enqueue = (runId: string, occurrenceSequence: string, now: number) =>
      fixture.schedules.transaction(() => fixture.schedules.enqueueRunInTransaction({
        runId,
        paneId: PANE,
        scheduleGeneration: positiveSyncUint64Schema.parse("1"),
        occurrenceSequence: positiveSyncUint64Schema.parse(occurrenceSequence),
        scheduledFor: NOW + Number(occurrenceSequence) * 86_400_000,
        definitionCiphertextDigest: digest("f"),
        now,
        enqueue: (messageId) => fixture.panes.enqueueMessage({
          paneId: PANE,
          expectedQueueRevision: fixture.panes.messageQueue(PANE).revision,
          messageId,
          content: { text: `Scheduled run ${occurrenceSequence}`, attachmentRefs: [] },
          now: new Date(now),
        }),
      }));

    const terminalRunId = `syncrun_${"1".repeat(26)}`;
    const terminal = enqueue(terminalRunId, "1", NOW + 3).run;
    fixture.schedules.acknowledgeRunInTransaction({
      runId: terminalRunId,
      expectedPaneId: PANE,
      expectedSessionId: SESSION,
      expectedScheduleGeneration: positiveSyncUint64Schema.parse("1"),
      expectedOccurrenceSequence: positiveSyncUint64Schema.parse("1"),
      expectedScheduledFor: NOW + 86_400_000,
      nextRunAt: NOW + 172_800_000,
      now: NOW + 5,
    });
    expect(fixture.panes.cancelUnclaimedScheduledMessage({
      paneId: PANE,
      messageId: terminal.messageId,
      now: new Date(NOW + 6),
    })).toBeTrue();

    const liveRunId = `syncrun_${"2".repeat(26)}`;
    enqueue(liveRunId, "2", NOW + 7);
    expect(fixture.schedules.purgeTerminalRuns(
      NOW + 5 + SCHEDULED_CHAT_LOCAL_RUN_RETENTION_MS - 1,
    )).toBe(0);
    expect(fixture.schedules.run(terminalRunId)).not.toBeNull();

    expect(fixture.schedules.purgeTerminalRuns(
      NOW + 5 + SCHEDULED_CHAT_LOCAL_RUN_RETENTION_MS,
    )).toBe(1);
    expect(fixture.schedules.run(terminalRunId)).toBeNull();
    expect(fixture.schedules.run(liveRunId)).toMatchObject({
      state: "enqueued",
      cancelledAt: null,
    });
    expect(fixture.schedules.purgeTerminalRuns(
      NOW + 5 + SCHEDULED_CHAT_LOCAL_RUN_RETENTION_MS,
    )).toBe(0);
  } finally {
    fixture.database.close();
  }
});
