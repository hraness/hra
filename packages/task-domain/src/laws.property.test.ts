import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  MAX_DIRECT_BLOCKERS,
  blockerContribution,
  blockerPropagationReadBound,
  contiguousEventBatch,
  dispatchRetryAllowed,
  importedRunSummarySchema,
  nextRunPhase,
  operationReceiptSchema,
  dependencyRelationKey,
  parentRelationKey,
  portableTaskCommandSchema,
  promotionCredentialFreeHttpsUrlSchema,
  promotionManifestSchema,
  publicRunEventKindSchema,
  runDisplayBudgetAfterBatch,
  resolvedAmbiguousDispatchPhase,
  taskLabelRelationKey,
  taskRepositoryRelationKey,
  taskStatusSchema,
  transitionBlockerCounters,
  validateDependencyInsertion,
  validatePortableRunInteractionResponse,
  workspaceAuthoritySchema,
} from "./index";

describe("portable task-domain laws", () => {
  test("all foreign contract values parse without throwing", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      for (const schema of [
        importedRunSummarySchema,
        operationReceiptSchema,
        portableTaskCommandSchema,
        promotionCredentialFreeHttpsUrlSchema,
        promotionManifestSchema,
        workspaceAuthoritySchema,
      ]) {
        expect(() => schema.safeParse(value)).not.toThrow();
      }
    }), { numRuns: 2_000 });
  });

  test("portable interaction response validation is total and request-scoped", () => {
    const request = {
      id: "interaction_property01",
      createdAt: 1,
      expiresAt: 2,
      kind: "user_input" as const,
      questions: [{
        id: "question_property01",
        header: "Choice",
        prompt: "Continue?",
        allowOther: false,
        options: [{ id: "option_property001", label: "Yes" }],
      }],
    };
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => validatePortableRunInteractionResponse(request, value)).not.toThrow();
    }), { numRuns: 2_000 });
    expect(validatePortableRunInteractionResponse(request, {
      kind: "user_input",
      answers: [{
        questionId: "question_property01",
        selectedOptionIds: ["option_fabricated01"],
      }],
    })).toEqual({ success: false, reason: "option_mismatch" });
  });

  test("blocker transitions preserve the contribution delta", () => {
    const lifecycle = taskStatusSchema.options;
    fc.assert(fc.property(
      fc.constantFrom(...lifecycle),
      fc.constantFrom(...lifecycle),
      fc.nat({ max: 10_000 }),
      fc.nat({ max: 10_000 }),
      (previous, next, unresolved, cancelled) => {
        const before = blockerContribution(previous);
        const after = blockerContribution(next);
        const counters = {
          unresolved: unresolved + before.unresolved,
          cancelled: cancelled + before.cancelled,
        };
        expect(transitionBlockerCounters(counters, previous, next)).toEqual({
          unresolved: unresolved + after.unresolved,
          cancelled: cancelled + after.cancelled,
        });
      },
    ));
  });

  test("bounded blocker read estimates reject every invalid count", () => {
    fc.assert(fc.property(
      fc.integer(),
      fc.integer(),
      (direct, dependents) => {
        const valid = direct >= 0 &&
          direct <= MAX_DIRECT_BLOCKERS &&
          dependents >= 0 &&
          dependents <= 500;
        expect(blockerPropagationReadBound(direct, dependents) !== null).toBe(valid);
      },
    ));
  });

  test("dependency insertion detects a generated path back to the blocker", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), (length) => {
      const map = new Map<string, readonly string[]>();
      for (let index = 0; index < length; index += 1) {
        map.set(`n${index}`, [`n${index + 1}`]);
      }
      expect(validateDependencyInsertion(map, `n${length}`, "n0").kind).toBe("cycle");
    }));
  });

  test("dispatch retries require every revision, claim, and terminal guard", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(),
      (revisionMatches, sourceFenceMatches, anotherBlocks, alreadyRetried) => {
        expect(dispatchRetryAllowed({
          sourcePhase: "failed",
          sourceSubmissionRejected: false,
          taskRevision: 2,
          expectedTaskRevision: revisionMatches ? 2 : 1,
          taskStatus: "open",
          taskHasCurrentClaim: false,
          sourceFenceMatches,
          anotherDispatchBlocksTask: anotherBlocks,
          sourceAlreadyRetried: alreadyRetried,
        })).toBe(revisionMatches && sourceFenceMatches && !anotherBlocks && !alreadyRetried);
      },
    ));
  });

  test("a rejected submission permits one immutable follow-up attempt", () => {
    const submitted = {
      sourcePhase: "submitted" as const,
      sourceSubmissionRejected: true,
      taskRevision: 3,
      expectedTaskRevision: 3,
      taskStatus: "open" as const,
      taskHasCurrentClaim: false,
      sourceFenceMatches: true,
      anotherDispatchBlocksTask: false,
      sourceAlreadyRetried: false,
    };
    expect(dispatchRetryAllowed(submitted)).toBeTrue();
    expect(dispatchRetryAllowed({
      ...submitted,
      sourceSubmissionRejected: false,
    })).toBeFalse();
  });

  test("a cancellation that later becomes ambiguous remains exactly resolvable", () => {
    const input = {
      sourcePhase: "ambiguous" as const,
      taskRevision: 4,
      expectedTaskRevision: 4,
      taskStatus: "cancelled" as const,
      taskHasCurrentClaim: true,
      sourceFenceMatches: true,
      anotherDispatchBlocksTask: false,
    };
    expect(resolvedAmbiguousDispatchPhase(input, "confirmed_cancelled"))
      .toBe("cancelled");
    expect(resolvedAmbiguousDispatchPhase(input, "declared_failed"))
      .toBe("failed");
    expect(resolvedAmbiguousDispatchPhase({
      ...input,
      taskHasCurrentClaim: false,
    }, "confirmed_cancelled")).toBeNull();
  });

  test("terminal phases reject every further semantic event", () => {
    fc.assert(fc.property(
      fc.constantFrom("submitted", "failed", "cancelled", "ambiguous"),
      fc.constantFrom(...publicRunEventKindSchema.options),
      (phase, kind) => {
        expect(nextRunPhase(phase, "run", kind)).toBeNull();
      },
    ));
  });

  test("contiguous batches and display budgets reject gaps", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 24 }), (count) => {
      const events = Array.from({ length: count }, (_, index) => ({
        id: `event_property_${index.toString().padStart(4, "0")}`,
        sequence: index + 1,
        kind: "codex.running" as const,
      }));
      expect(contiguousEventBatch({ acceptedThroughSequence: 0, events })).toBeTrue();
      const gapped = events.map((event, index) =>
        index === count - 1 ? { ...event, sequence: event.sequence + 1 } : event);
      if (count > 1) {
        expect(contiguousEventBatch({ acceptedThroughSequence: 0, events: gapped })).toBeFalse();
      }
      expect(runDisplayBudgetAfterBatch({
        acceptedThroughSequence: count,
        existingEvents: events,
        events: [],
      }).kind).toBe("accepted");
    }));
  });

  test("canonical relation keys are stable and field-sensitive", () => {
    const leftTask = "tsk_0123456789ABCDEFGHJKMNPQRS";
    const rightTask = "tsk_1123456789ABCDEFGHJKMNPQRS";
    const repository = "repo_0123456789ABCDEFGHJKMNPQRS";
    fc.assert(fc.property(fc.constantFrom("alpha", "beta", "gamma"), (label) => {
      expect(taskRepositoryRelationKey(leftTask, repository)).toBe(
        taskRepositoryRelationKey(leftTask, repository),
      );
      expect(taskRepositoryRelationKey(leftTask, repository)).not.toBe(
        taskRepositoryRelationKey(rightTask, repository),
      );
      expect(parentRelationKey(leftTask, rightTask)).not.toBe(
        parentRelationKey(rightTask, leftTask),
      );
      expect(dependencyRelationKey(leftTask, rightTask)).not.toBe(
        dependencyRelationKey(rightTask, leftTask),
      );
      expect(taskLabelRelationKey(leftTask, label)).not.toBe(
        taskLabelRelationKey(rightTask, label),
      );
      expect(taskLabelRelationKey(leftTask, label)).toBe(
        taskLabelRelationKey(leftTask, label),
      );
    }));
  });
});
