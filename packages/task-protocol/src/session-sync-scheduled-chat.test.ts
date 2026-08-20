import { describe, expect, test } from "bun:test";

import {
  canonicalSessionSyncJson,
  clearOrphanedScheduledChatRequestSchema,
  clearOrphanedScheduledChatAsHumanRequestSchema,
  clearScheduledChatRequestSchema,
  hasValidScheduledChatCiphertextDigest,
  MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE,
  MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES,
  MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
  nextScheduledChatOccurrence,
  openScheduledChatDefinition,
  parseCanonicalScheduledChatRRule,
  putScheduledChatRequestSchema,
  readScheduledChatRecoveryInventoryAsHumanRequestSchema,
  routeForSessionSyncRequest,
  sealScheduledChatDefinition,
  scheduledChatDefinitionHeaderSchema,
  scheduledChatDefinitionSchema,
  scheduledChatScheduleSchema,
  scheduledChatRunPageResponseSchema,
  scheduledChatInventoryResponseSchema,
  scheduledChatRecoveryInventoryResponseSchema,
} from "./index";

const opaque = (prefix: string, character: string) => `${prefix}_${character.repeat(32)}`;
const daily = "DTSTART;TZID=America/New_York:20260307T090000\nRRULE:FREQ=DAILY;INTERVAL=1";

function header() {
  return scheduledChatDefinitionHeaderSchema.parse({
    protocol: "oprte.session-sync/v1",
    payloadKind: "scheduled_chat_definition",
    payloadVersion: 1,
    tenantId: opaque("synctenant", "t"),
    organizationId: opaque("syncorg", "o"),
    ownerUserId: opaque("syncuser", "u"),
    vaultId: opaque("syncvault", "v"),
    vaultGeneration: "1",
    membershipEpoch: "1",
    originDeviceId: opaque("syncdevice", "d"),
    sessionId: opaque("syncsession", "s"),
    mirrorEpoch: "1",
    writerGeneration: "2",
    bootId: opaque("syncboot", "b"),
    bootGeneration: "3",
    keyEpoch: "1",
    previousGeneration: "0",
    generation: "1",
    rrule: daily,
    timeZone: "America/New_York",
  });
}

describe("scheduled chat RRULE", () => {
  test("accepts one strict canonical RFC5545 subset", () => {
    expect(parseCanonicalScheduledChatRRule(daily)).toMatchObject({
      timeZone: "America/New_York",
      frequency: "DAILY",
      interval: 1,
    });
    const weekly = "DTSTART;TZID=UTC:20260817T090000\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR";
    expect(parseCanonicalScheduledChatRRule(weekly)?.byDay).toEqual(["MO", "WE", "FR"]);
    const monthly = "DTSTART;TZID=UTC:20260801T083000\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1,15";
    expect(parseCanonicalScheduledChatRRule(monthly)?.byMonthDay).toEqual([1, 15]);
    for (const invalid of [
      `${daily}\n`,
      daily.replace("INTERVAL=1", "INTERVAL=01"),
      daily.replace("DAILY;INTERVAL=1", "DAILY;BYDAY=MO;INTERVAL=1"),
      "DTSTART;TZID=UTC:20260817T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR,MO",
      "DTSTART;TZID=UTC:20260817T090000\nRRULE:FREQ=SECONDLY;INTERVAL=1",
    ]) expect(parseCanonicalScheduledChatRRule(invalid)).toBeNull();
  });

  test("keeps daily wall time across a daylight-saving transition", () => {
    const first = nextScheduledChatOccurrence({
      rrule: daily,
      timeZone: "America/New_York",
      after: Date.parse("2026-03-07T14:00:00.000Z"),
    });
    expect(first).toBe(Date.parse("2026-03-08T13:00:00.000Z"));
    const second = nextScheduledChatOccurrence({
      rrule: daily,
      timeZone: "America/New_York",
      after: first!,
    });
    expect(second).toBe(Date.parse("2026-03-09T13:00:00.000Z"));
  });

  test("calculates minute, weekly, and monthly occurrences strictly after the cut", () => {
    expect(nextScheduledChatOccurrence({
      rrule: "DTSTART;TZID=UTC:20260819T120000\nRRULE:FREQ=MINUTELY;INTERVAL=15",
      timeZone: "UTC",
      after: Date.parse("2026-08-19T12:44:59.000Z"),
    })).toBe(Date.parse("2026-08-19T12:45:00.000Z"));
    expect(nextScheduledChatOccurrence({
      rrule: "DTSTART;TZID=UTC:20260817T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR",
      timeZone: "UTC",
      after: Date.parse("2026-08-19T09:00:00.000Z"),
    })).toBe(Date.parse("2026-08-21T09:00:00.000Z"));
    expect(nextScheduledChatOccurrence({
      rrule: "DTSTART;TZID=UTC:20260131T090000\nRRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31",
      timeZone: "UTC",
      after: Date.parse("2026-01-31T09:00:00.000Z"),
    })).toBe(Date.parse("2026-03-31T09:00:00.000Z"));
  });
});

describe("scheduled chat definition custody", () => {
  test("seals the prompt under schedule-specific authenticated coordinates", async () => {
    const definition = scheduledChatDefinitionSchema.parse({
      version: 1,
      sessionId: header().sessionId,
      generation: "1",
      rrule: daily,
      timeZone: "America/New_York",
      prompt: "Review the overnight build and fix regressions.",
    });
    const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const envelope = await sealScheduledChatDefinition({
      definition,
      header: header(),
      rootKey,
      nonce: Uint8Array.from({ length: 12 }, (_, index) => index),
    });
    const serialized = canonicalSessionSyncJson(envelope);
    expect(serialized).not.toContain(definition.prompt);
    expect(serialized).not.toContain('"prompt"');
    expect(await hasValidScheduledChatCiphertextDigest(envelope)).toBeTrue();
    expect(await openScheduledChatDefinition({
      envelope,
      expectedHeader: header(),
      rootKey,
    })).toEqual(definition);
    let rejectedMismatchedAuthority = false;
    try {
      await openScheduledChatDefinition({
        envelope,
        expectedHeader: scheduledChatDefinitionHeaderSchema.parse({
          ...header(),
          generation: "2",
          previousGeneration: "1",
        }),
        rootKey,
      });
    } catch {
      rejectedMismatchedAuthority = true;
    }
    expect(rejectedMismatchedAuthority).toBeTrue();
    const request = putScheduledChatRequestSchema.parse({
      version: 1,
      operation: "put_scheduled_chat",
      definition: envelope,
    });
    expect(routeForSessionSyncRequest(request)).toBe("sync.schedule.write");
    expect(scheduledChatRunPageResponseSchema.parse({
      kind: "scheduled_run_page",
      runs: [{
        runId: `syncrun_${"A".repeat(26)}`,
        sessionId: definition.sessionId,
        scheduleGeneration: definition.generation,
        occurrenceSequence: "1",
        scheduledFor: 1,
        definition: envelope,
      }],
      hasMore: false,
    }).runs[0]?.definition).toEqual(envelope);
  });

  test("binds schedule metadata and clear authority exactly", () => {
    expect(() => scheduledChatScheduleSchema.parse({
      generation: "1",
      rrule: daily,
      timeZone: "UTC",
      nextRunAt: 1,
    })).toThrow("time zone");
    const value = header();
    expect(routeForSessionSyncRequest(clearScheduledChatRequestSchema.parse({
      version: 1,
      operation: "clear_scheduled_chat",
      tenantId: value.tenantId,
      organizationId: value.organizationId,
      ownerUserId: value.ownerUserId,
      vaultId: value.vaultId,
      vaultGeneration: value.vaultGeneration,
      membershipEpoch: value.membershipEpoch,
      originDeviceId: value.originDeviceId,
      sessionId: value.sessionId,
      mirrorEpoch: value.mirrorEpoch,
      writerGeneration: value.writerGeneration,
      bootId: value.bootId,
      bootGeneration: value.bootGeneration,
      keyEpoch: value.keyEpoch,
      expectedGeneration: value.generation,
    }))).toBe("sync.schedule.write");
    expect(routeForSessionSyncRequest(clearOrphanedScheduledChatRequestSchema.parse({
      version: 1,
      operation: "clear_orphaned_scheduled_chat",
      originDeviceId: value.originDeviceId,
      sessionId: value.sessionId,
      expectedGeneration: value.generation,
      expectedCiphertextDigest: `sha256_${"a".repeat(64)}`,
    }))).toBe("sync.schedule.write");
    expect(clearOrphanedScheduledChatAsHumanRequestSchema.parse({
      version: 1,
      operation: "clear_orphaned_scheduled_chat_as_human",
      tenantId: value.tenantId,
      organizationId: value.organizationId,
      ownerUserId: value.ownerUserId,
      vaultId: value.vaultId,
      vaultGeneration: value.vaultGeneration,
      originDeviceId: value.originDeviceId,
      sessionId: value.sessionId,
      expectedGeneration: value.generation,
      expectedCiphertextDigest: `sha256_${"b".repeat(64)}`,
    })).toMatchObject({ sessionId: value.sessionId, expectedGeneration: "1" });
    expect(readScheduledChatRecoveryInventoryAsHumanRequestSchema.parse({
      version: 1,
      operation: "scheduled_chat_recovery_inventory_as_human",
      tenantId: value.tenantId,
      organizationId: value.organizationId,
      ownerUserId: value.ownerUserId,
      vaultId: value.vaultId,
      vaultGeneration: value.vaultGeneration,
      originDeviceId: value.originDeviceId,
      pageSize: MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE,
    })).toMatchObject({ vaultId: value.vaultId, pageSize: 8 });
  });

  test("bounds and orders same-human recovery inventory", () => {
    const schedules = Array.from(
      { length: MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE },
      (_, index) => ({
        state: index % 2 === 0 ? "active" as const : "cleared" as const,
        sessionId: opaque("syncsession", String(index + 1)),
        originDeviceId: header().originDeviceId,
        generation: "1",
        ciphertextDigest: `sha256_${String(index + 1).repeat(64)}`,
      }),
    );
    expect(scheduledChatRecoveryInventoryResponseSchema.parse({
      kind: "scheduled_chat_recovery_inventory",
      vault: {
        tenantId: header().tenantId,
        organizationId: header().organizationId,
        ownerUserId: header().ownerUserId,
        vaultId: header().vaultId,
        vaultGeneration: header().vaultGeneration,
      },
      originDeviceId: header().originDeviceId,
      schedules,
      hasMore: true,
      nextAfterSessionId: schedules.at(-1)?.sessionId,
    }).schedules).toHaveLength(MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE);
    expect(() => scheduledChatRecoveryInventoryResponseSchema.parse({
      kind: "scheduled_chat_recovery_inventory",
      vault: {
        tenantId: header().tenantId,
        organizationId: header().organizationId,
        ownerUserId: header().ownerUserId,
        vaultId: header().vaultId,
        vaultGeneration: header().vaultGeneration,
      },
      originDeviceId: header().originDeviceId,
      schedules: [...schedules, schedules.at(-1)],
      hasMore: false,
    })).toThrow();
    expect(() => scheduledChatRecoveryInventoryResponseSchema.parse({
      kind: "scheduled_chat_recovery_inventory",
      vault: {
        tenantId: header().tenantId,
        organizationId: header().organizationId,
        ownerUserId: header().ownerUserId,
        vaultId: header().vaultId,
        vaultGeneration: header().vaultGeneration,
      },
      originDeviceId: header().originDeviceId,
      schedules: [{
        ...schedules[0],
        originDeviceId: opaque("syncdevice", "z"),
      }],
      hasMore: false,
    })).toThrow("page origin");
  });

  test("bounds maximal encrypted inventory pages below the response limit", async () => {
    const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const schedules = await Promise.all(
      Array.from({ length: MAX_SCHEDULED_CHAT_INVENTORY_PAGE_SIZE }, async (_, index) => {
        const sessionId = opaque("syncsession", String(index + 1));
        const definitionHeader = scheduledChatDefinitionHeaderSchema.parse({
          ...header(),
          sessionId,
        });
        const definition = scheduledChatDefinitionSchema.parse({
          version: 1,
          sessionId,
          generation: "1",
          rrule: daily,
          timeZone: "America/New_York",
          prompt: "x".repeat(MAX_SCHEDULED_CHAT_PROMPT_UTF8_BYTES),
        });
        const envelope = await sealScheduledChatDefinition({
          definition,
          header: definitionHeader,
          rootKey,
          nonce: new Uint8Array(12).fill(index + 1),
        });
        return {
          state: "active" as const,
          sessionId,
          originDeviceId: definitionHeader.originDeviceId,
          generation: "1" as const,
          nextRunAt: index + 1,
          definition: envelope,
        };
      }),
    );
    const response = scheduledChatInventoryResponseSchema.parse({
      kind: "scheduled_chat_inventory",
      schedules,
      hasMore: false,
    });
    expect(new TextEncoder().encode(canonicalSessionSyncJson(response)).byteLength)
      .toBeLessThan(MAX_SESSION_SYNC_RESPONSE_JSON_BYTES);
    expect(() => scheduledChatInventoryResponseSchema.parse({
      kind: "scheduled_chat_inventory",
      schedules: [...schedules, schedules.at(-1)],
      hasMore: false,
    })).toThrow();
  });
});
