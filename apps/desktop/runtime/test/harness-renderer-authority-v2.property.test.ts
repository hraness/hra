import { expect, test } from "bun:test";
import { assertProperty, fc, propertyParameters } from "@hra-internal/test";

import {
  actorSchema,
  actorTurnSchema,
  type Actor,
  type ActorTurn,
} from "../src/harness/actor-domain";
import {
  actorIncarnationRecordSchema,
  actorPaneBindingSchema,
  type ActorIncarnationRecord,
} from "../src/harness/sqlite-authority-v2";
import {
  deriveHarnessChildActions,
  deriveHarnessChildState,
  deriveHarnessParentProjectionRevision,
  deriveHarnessProjectionRevision,
  harnessChildSemanticDigest,
} from "../src/harness/renderer-authority-v2";

const PROPERTY_TIMEOUT = propertyParameters.interruptAfterTimeLimit + 5_000;
const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const actorId = "hactor_property_child001";
const epochId = "hepoch_property_epoch001";

const actorStateArbitrary = fc.constantFrom(
  "active" as const,
  "stopRequested" as const,
  "stopped" as const,
  "quarantined" as const,
);
const turnStateArbitrary = fc.constantFrom(
  "prepared" as const,
  "starting" as const,
  "running" as const,
  "reconciling" as const,
  "succeeded" as const,
  "failed" as const,
  "cancelled" as const,
  "quotaRejected" as const,
  "ambiguous" as const,
);
const incarnationStateArbitrary = fc.option(
  fc.constantFrom("starting" as const, "idle" as const, "running" as const),
  { nil: null },
);
interface TokenUsageEvidence {
  tokenUsageObservationGeneration: number;
  tokenUsageLatestPosition: number | null;
  tokenUsageCumulativeInputTokens: number;
  tokenUsageCumulativeOutputTokens: number;
  tokenUsageCumulativeCachedInputTokens: number;
  tokenUsageCumulativeReasoningOutputTokens: number;
}

const emptyTokenUsageEvidence: TokenUsageEvidence = {
  tokenUsageObservationGeneration: 1,
  tokenUsageLatestPosition: null,
  tokenUsageCumulativeInputTokens: 0,
  tokenUsageCumulativeOutputTokens: 0,
  tokenUsageCumulativeCachedInputTokens: 0,
  tokenUsageCumulativeReasoningOutputTokens: 0,
};

const observedTokenUsageEvidenceArbitrary = fc.record({
  tokenUsageObservationGeneration: fc.integer({ min: 1, max: 1_000 }),
  tokenUsageLatestPosition: fc.integer({ min: 0, max: 1_000_000 }),
  tokenUsageCumulativeInputTokens: fc.integer({ min: 0, max: 1_000_000 }),
  tokenUsageCumulativeOutputTokens: fc.integer({ min: 0, max: 1_000_000 }),
}).chain((usage) => fc.record({
  tokenUsageCumulativeCachedInputTokens: fc.integer({
    min: 0,
    max: usage.tokenUsageCumulativeInputTokens,
  }),
  tokenUsageCumulativeReasoningOutputTokens: fc.integer({
    min: 0,
    max: usage.tokenUsageCumulativeOutputTokens,
  }),
}).map((breakdown): TokenUsageEvidence => ({ ...usage, ...breakdown })));

const tokenUsageEvidenceArbitrary = fc.oneof(
  fc.constant(emptyTokenUsageEvidence),
  observedTokenUsageEvidenceArbitrary,
);

function makeActor(state: Actor["state"]): Actor {
  const terminal = state === "stopped" || state === "quarantined";
  return actorSchema.parse({
    id: actorId,
    epochId,
    parentActorId: "hactor_property_parent01",
    depth: 1,
    title: "Property child",
    state,
    budget: {
      maxDepth: 3,
      maxActiveDescendants: 8,
      maxDurableDescendants: 50,
      tokenBudget: 10_000,
      byteBudget: 1024 * 1024,
      deadline: "2030-01-02T00:00:00.000Z",
      laneAuthority: "readOnlySnapshot",
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 2,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: terminal ? later : at,
    stoppedAt: terminal ? later : null,
  });
}

function makeTurn(state: ActorTurn["state"]): ActorTurn {
  const prepared = state === "prepared";
  const terminal = state === "succeeded" || state === "failed" ||
    state === "cancelled" || state === "quotaRejected" || state === "ambiguous";
  return actorTurnSchema.parse({
    id: "hturn_property_child001",
    epochId,
    actorId,
    ordinal: 1,
    idempotencyKey: "property-idempotency-0001", // gitleaks:allow - deterministic test vector
    inputValueId: "ctxval_property_input001",
    state,
    desiredState: "run",
    revision: 1,
    createdAt: at,
    startedAt: prepared ? null : at,
    settledAt: terminal ? later : null,
    outcomeCode: terminal ? "terminal" : null,
  });
}

function makeIncarnation(
  state: "starting" | "idle" | "running" | null,
  tokenUsageEvidence: TokenUsageEvidence = emptyTokenUsageEvidence,
): ActorIncarnationRecord | null {
  if (state === null) return null;
  const observed = state === "starting"
    ? {
        observedModel: null,
        observedReasoningEffort: null,
        observedProfileState: "unknown" as const,
        observedProfileAt: null,
      }
    : {
        observedModel: "gpt-5.6-sol" as const,
        observedReasoningEffort: "ultra" as const,
        observedProfileState: "exact" as const,
        observedProfileAt: later,
      };
  return actorIncarnationRecordSchema.parse({
    id: "hincarnation_property01",
    actorId,
    ordinal: 1,
    accountProfileId: "acct_property_fixture01",
    processGeneration: 1,
    startOperationId: "hoperation_property01",
    clientRequestId: "client-request-property01",
    threadSource: "thread-source-property01",
    providerThreadId: state === "starting" ? null : "provider-thread-property01",
    ...(state === "starting" ? emptyTokenUsageEvidence : tokenUsageEvidence),
    requestedModel: "gpt-5.6-sol",
    requestedReasoningEffort: "ultra",
    profileFallbackReason: null,
    capabilityEvidenceDigest: "b".repeat(64),
    supportsFast: true,
    ...observed,
    toolsetDigest: "a".repeat(64),
    state,
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  });
}

test("child-state projection is total and only settled actor terminality dominates provider activity", () => {
  assertProperty(fc.property(
    actorStateArbitrary,
    turnStateArbitrary,
    incarnationStateArbitrary,
    tokenUsageEvidenceArbitrary,
    (actorState, turnState, incarnationState, tokenUsageEvidence) => {
      const state = deriveHarnessChildState({
        actor: makeActor(actorState),
        latestTurn: makeTurn(turnState),
        incarnation: makeIncarnation(incarnationState, tokenUsageEvidence),
      });
      if (actorState === "quarantined") {
        expect(state).toBe("quarantined");
        return;
      }
      if (actorState === "stopped") {
        expect(state).toBe("stopped");
        return;
      }
      const expected = {
        prepared: "starting",
        starting: "starting",
        running: "running",
        reconciling: "waiting",
        succeeded: "idle",
        failed: "failed",
        cancelled: "idle",
        quotaRejected: "failed",
        ambiguous: "quarantined",
      } as const;
      expect(state).toBe(expected[turnState]);
    },
  ));
}, PROPERTY_TIMEOUT);

test("semantic witnesses are deterministic and bind every renderer-visible field", () => {
  assertProperty(fc.property(
    fc.integer({ min: 0, max: 999_999 }),
    fc.stringMatching(/^[A-Za-z0-9]{1,32}$/u),
    fc.constantFrom(
      "starting" as const,
      "running" as const,
      "waiting" as const,
      "idle" as const,
      "failed" as const,
      "stopped" as const,
      "quarantined" as const,
    ),
    fc.boolean(),
    (index, title, state, opened) => {
      const terminal = state === "stopped" || state === "quarantined";
      const child = {
        id: `hactor_property_${String(index).padStart(8, "0")}`,
        title,
        state,
        openedPaneId: opened ? "pane_property_opened01" : null,
        canOpen: false,
        canMessage: false,
        canStop: !terminal,
      };
      const digest = harnessChildSemanticDigest(child);
      expect(harnessChildSemanticDigest(structuredClone(child))).toBe(digest);
      expect(harnessChildSemanticDigest({ ...child, title: `${title}x` }))
        .not.toBe(digest);
      expect(harnessChildSemanticDigest({
        ...child,
        openedPaneId: opened ? null : "pane_property_opened01",
      })).not.toBe(digest);
      if (!terminal) {
        expect(harnessChildSemanticDigest({
          ...child,
          state: state === "idle" ? "running" : "idle",
        })).not.toBe(digest);
      }
    },
  ));
}, PROPERTY_TIMEOUT);

test("child actions require one definitive terminal turn and a proven-idle incarnation", () => {
  assertProperty(fc.property(
    actorStateArbitrary,
    turnStateArbitrary,
    incarnationStateArbitrary,
    fc.boolean(),
    tokenUsageEvidenceArbitrary,
    (actorState, turnState, incarnationState, attached, tokenUsageEvidence) => {
      const actor = makeActor(actorState);
      const latestTurn = makeTurn(turnState);
      const incarnation = makeIncarnation(incarnationState, tokenUsageEvidence);
      const binding = attached
        ? actorPaneBindingSchema.parse({
            id: "hpanebinding_property01",
            actorId,
            paneId: "pane_property_opened01",
            state: "attached",
            revision: 1,
            attachedAt: at,
            detachedAt: null,
          })
        : null;
      const actions = deriveHarnessChildActions({
        actor,
        incarnation,
        latestTurn,
        binding,
      });
      const definitive = turnState === "succeeded" || turnState === "failed" ||
        turnState === "cancelled" || turnState === "quotaRejected";
      const authorized = actorState === "active" &&
        incarnationState === "idle" && definitive;
      expect(actions).toEqual({
        canOpen: authorized && !attached,
        canMessage: authorized && attached,
      });
    },
  ));
}, PROPERTY_TIMEOUT);

test("semantic witnesses bind the complete action authority", () => {
  const openable = {
    id: actorId,
    title: "Property child",
    state: "idle" as const,
    openedPaneId: null,
    canOpen: true,
    canMessage: false,
    canStop: true,
  };
  const openableDigest = harnessChildSemanticDigest(openable);
  expect(harnessChildSemanticDigest({
    ...openable,
    canOpen: false,
  })).not.toBe(openableDigest);

  const messageable = {
    ...openable,
    openedPaneId: "pane_property_opened01",
    canOpen: false,
    canMessage: true,
  };
  const messageableDigest = harnessChildSemanticDigest(messageable);
  expect(harnessChildSemanticDigest({
    ...messageable,
    canMessage: false,
  })).not.toBe(messageableDigest);
});

test("a fully quiesced stop intent remains retryable until explicit settlement", () => {
  const quiesced = deriveHarnessChildState({
    actor: makeActor("stopRequested"),
    latestTurn: null,
    incarnation: null,
  });
  expect(quiesced).toBe("idle");
  expect(deriveHarnessChildState({
    actor: makeActor("stopped"),
    latestTurn: null,
    incarnation: null,
  })).toBe("stopped");
});

test("derived global and parent revisions advance exactly once per one-source advance", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.array(fc.integer({ min: 1, max: 1_000_000 }), {
      minLength: 0,
      maxLength: 32,
    }),
    fc.array(fc.integer({ min: 1, max: 1_000_000 }), {
      minLength: 1,
      maxLength: 50,
    }),
    (settingsRevision, proposalRevisions, childRevisions) => {
      const global = deriveHarnessProjectionRevision(
        settingsRevision,
        proposalRevisions,
      );
      expect(deriveHarnessProjectionRevision(
        settingsRevision + 1,
        proposalRevisions,
      )).toBe(global + 1);

      const parent = deriveHarnessParentProjectionRevision(childRevisions);
      const advanced = [...childRevisions];
      advanced[0] = advanced[0]! + 1;
      expect(deriveHarnessParentProjectionRevision(advanced)).toBe(parent + 1);
    },
  ));
}, PROPERTY_TIMEOUT);
