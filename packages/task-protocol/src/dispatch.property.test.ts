import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  appendRunEventsRequestSchema,
  DISPATCH_LEASE_MS,
  MAX_RUN_DISPLAY_TEXT_UTF8_BYTES,
  publicRunEventKindSchema,
  RUNNER_PRESENCE_LEASE_MS,
  runnerHeartbeatRequestSchema,
  runnerHeartbeatResponseMatchesRequest,
  runnerHeartbeatResponseSchema,
  runDisplayTextSchema,
  taskRunViewSchema,
} from "./dispatch";

const eventKindArbitrary = fc.constantFrom(...publicRunEventKindSchema.options);

describe("HRA dispatch parser laws", () => {
  test("arbitrary foreign heartbeat and event values never make parsing throw", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => runnerHeartbeatRequestSchema.safeParse(value)).not.toThrow();
      expect(() => appendRunEventsRequestSchema.safeParse(value)).not.toThrow();
    }), { numRuns: 2_000 });
  });

  test("a valid event batch rejects every freeform status or local-path field", () => {
    fc.assert(fc.property(
      eventKindArbitrary,
      fc.constantFrom("summary", "text", "path", "cwd", "output", "reasoning", "prompt"),
      fc.string(),
      (kind, key, value) => {
        const parsed = appendRunEventsRequestSchema.safeParse({
          runnerId: "runner_primary0001",
          bootId: "boot_primary0001",
          claimId: "claim_primary001",
          claimFence: 1,
          events: [{ id: "event_primary001", sequence: 1, kind, [key]: value }],
        });
        expect(parsed.success).toBeFalse();
      },
    ));
  });

  test("display text accepts exactly its UTF-8 bound and rejects forbidden controls", () => {
    fc.assert(fc.property(
      fc.string(),
      (value) => {
        const bytes = new TextEncoder().encode(value).length;
        const hasForbiddenControl = [...value].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return (codePoint <= 31 && ![9, 10, 13].includes(codePoint)) || codePoint === 127;
        });
        expect(runDisplayTextSchema.safeParse(value).success).toBe(
          value.length > 0 && bytes <= MAX_RUN_DISPLAY_TEXT_UTF8_BYTES && !hasForbiddenControl,
        );
      },
    ), { numRuns: 2_000 });
  });

  test("text event channels require displayText and all other event kinds forbid it", () => {
    fc.assert(fc.property(eventKindArbitrary, fc.string({ minLength: 1, maxLength: 128 }),
      (kind, displayText) => {
        const textKind = kind === "codex.reasoning_summary.delta" ||
          kind === "codex.assistant_message.delta";
        const base = {
          runnerId: "runner_primary0001",
          bootId: "boot_primary0001",
          claimId: "claim_primary001",
          claimFence: 1,
          events: [{ id: "event_primary001", sequence: 1, kind }],
        };
        expect(appendRunEventsRequestSchema.safeParse(base).success).toBe(!textKind);
        expect(appendRunEventsRequestSchema.safeParse({
          ...base,
          events: [{ ...base.events[0], displayText }],
        }).success).toBe(textKind);
      },
    ), { numRuns: 1_000 });
  });

  test("shuffled, duplicated, or gapped run-view transcripts always fail closed", () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 100 }),
      (eventCount) => {
        const events = Array.from({ length: eventCount }, (_, index) => ({
          id: `event_property_${String(index).padStart(4, "0")}`,
          sequence: index + 1,
          kind: "codex.running" as const,
          observedAt: index + 1,
        }));
        const run = {
          id: "run_property0001",
          taskKey: "OPS-123ABCD",
          phase: "running" as const,
          repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
          desiredState: "run" as const,
          updatedAt: eventCount,
          events,
          interactions: [],
        };
        expect(taskRunViewSchema.safeParse(run).success).toBeTrue();
        expect(taskRunViewSchema.safeParse({ ...run, events: [...events].reverse() }).success)
          .toBeFalse();
        const duplicated = [...events];
        duplicated[eventCount - 1] = events[0]!;
        expect(taskRunViewSchema.safeParse({ ...run, events: duplicated }).success).toBeFalse();
        const gapped = events.map((event, index) => index === eventCount - 1
          ? { ...event, sequence: event.sequence + 1 }
          : event);
        expect(taskRunViewSchema.safeParse({ ...run, events: gapped }).success).toBeFalse();
      },
    ), { numRuns: 1_000 });
  }, 15_000);

  test("heartbeat success leases stay bounded and control sets cannot contradict", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: RUNNER_PRESENCE_LEASE_MS }),
      fc.integer({ min: 1, max: DISPATCH_LEASE_MS }),
      fc.integer({ min: 1, max: 8 }),
      (runnerLeaseMs, runLeaseMs, activeCount) => {
        const serverTime = 10_000;
        const runLeases = Array.from({ length: activeCount }, (_, index) => ({
          runId: `run_property_${index.toString().padStart(4, "0")}`,
          leaseUntil: serverTime + runLeaseMs,
        }));
        const response = {
          serverTime,
          leaseUntil: serverTime + runnerLeaseMs,
          desiredState: "active" as const,
          candidates: [],
          runLeases,
          stopRunIds: runLeases.filter((_, index) => index % 2 === 0).map(({ runId }) => runId),
          releaseRunIds: ["run_released0001"],
        };
        expect(runnerHeartbeatResponseSchema.safeParse(response).success).toBeTrue();
        const request = runnerHeartbeatRequestSchema.parse({
          runnerId: "runner_primary0001",
          installationId: "install_primary001",
          bootId: "boot_primary0001",
          bootGeneration: 1,
          sequence: 1,
          protocolVersion: 1,
          clientVersion: "property-v1",
          reportedState: "ready",
          capacity: activeCount + 1,
          activeRuns: activeCount + 1,
          currentRunIds: runLeases.map(({ runId }) => runId),
          retainedRunIds: [...runLeases.map(({ runId }) => runId), "run_released0001"],
          repositoryIds: [],
        });
        expect(runnerHeartbeatResponseMatchesRequest(request, response)).toBeTrue();
        const activeId = runLeases[0]?.runId;
        if (activeId === undefined) throw new Error("Expected an active run");
        expect(runnerHeartbeatResponseSchema.safeParse({
          ...response,
          stopRunIds: ["run_not_active001"],
        }).success).toBeFalse();
        expect(runnerHeartbeatResponseMatchesRequest(request, {
          ...response,
          releaseRunIds: ["run_foreign00001"],
        })).toBeFalse();
        expect(runnerHeartbeatResponseSchema.safeParse({
          ...response,
          releaseRunIds: [activeId],
        }).success).toBeFalse();
      },
    ));
  });
});
