import { describe, expect, test } from "bun:test";

import type {
  ChatPaneProjection,
  HarnessChildProjection,
} from "../../contracts/runtime";
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
  type ActorPaneBinding,
} from "../src/harness/sqlite-authority-v2";
import {
  deriveHarnessChildActions,
  deriveHarnessChildState,
  HarnessRendererAuthorityV2,
  type HarnessRendererActorReadPort,
  type HarnessRendererAuthorityV2Options,
  type HarnessRendererChatAttachmentPort,
  harnessChildSemanticDigest,
} from "../src/harness/renderer-authority-v2";
import type { HarnessRendererProjection } from "../src/harness/renderer-service-v2";

const MIB = 1024 * 1024;
const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const parentPaneId = "pane_renderer_parent01";
const childPaneId = "pane_renderer_child001";
const parentActorId = "hactor_renderer_parent01";
const childActorId = "hactor_renderer_child001";
const epochId = "hepoch_renderer_epoch001";

const budget = {
  maxDepth: 3,
  maxActiveDescendants: 8,
  maxDurableDescendants: 50,
  tokenBudget: 100_000,
  byteBudget: 16 * MIB,
  deadline: "2030-01-02T00:00:00.000Z",
  laneAuthority: "managedWrite" as const,
};

interface Witness {
  actorId: string;
  revision: number;
  semanticDigest: string;
}

interface MutableFixture {
  settings: {
    revision: number;
    recursiveSessionsEnabled: boolean;
    contextQuotaBytes: number;
    refinementMode: "off" | "suggest";
  };
  proposals: Array<{ id: string; revision: number; title: string }>;
  paneIds: string[];
  actors: Map<string, Actor>;
  paneActors: Map<string, string>;
  children: Map<string, string[]>;
  turns: Map<string, ActorTurn>;
  incarnations: Map<string, ActorIncarnationRecord>;
  bindings: Map<string, ActorPaneBinding>;
  witnesses: Map<string, Witness>;
  paneListReads: number;
  mutateOnSecondPaneRead: (() => void) | null;
  settingsUpdates: number;
  opens: number;
  stops: number;
}

function actor(
  id: string,
  parentActorIdValue: string | null,
  title: string,
  nextTurnOrdinal: number,
): Actor {
  return actorSchema.parse({
    id,
    epochId,
    parentActorId: parentActorIdValue,
    depth: parentActorIdValue === null ? 0 : 1,
    title,
    state: "active",
    budget,
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal,
    nextResultOrdinal: nextTurnOrdinal,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
}

function turn(id: string, ownerActorId: string): ActorTurn {
  return actorTurnSchema.parse({
    id,
    epochId,
    actorId: ownerActorId,
    ordinal: 1,
    idempotencyKey: `idempotency-${ownerActorId}`,
    inputValueId: `ctxval_${ownerActorId.slice("hactor_".length)}`,
    state: "succeeded",
    desiredState: "run",
    revision: 4,
    createdAt: at,
    startedAt: at,
    settledAt: later,
    outcomeCode: "completed",
  });
}

function incarnation(ownerActorId: string): ActorIncarnationRecord {
  const suffix = ownerActorId.slice("hactor_".length);
  return actorIncarnationRecordSchema.parse({
    id: `hincarnation_${suffix}`,
    actorId: ownerActorId,
    ordinal: 1,
    accountProfileId: "acct_renderer_fixture01",
    processGeneration: 1,
    startOperationId: `hoperation_${suffix}`,
    clientRequestId: `client-request-${suffix}`,
    threadSource: `thread-source-${suffix}`,
    providerThreadId: `provider-thread-${suffix}`,
    tokenUsageObservationGeneration: 1,
    tokenUsageLatestPosition: null,
    tokenUsageCumulativeInputTokens: 0,
    tokenUsageCumulativeOutputTokens: 0,
    tokenUsageCumulativeCachedInputTokens: 0,
    tokenUsageCumulativeReasoningOutputTokens: 0,
    requestedModel: "gpt-5.6-sol",
    requestedReasoningEffort: "ultra",
    profileFallbackReason: null,
    capabilityEvidenceDigest: "b".repeat(64),
    supportsFast: true,
    observedModel: "gpt-5.6-sol",
    observedReasoningEffort: "ultra",
    observedProfileState: "exact",
    observedProfileAt: later,
    toolsetDigest: "a".repeat(64),
    state: "idle",
    createdAt: at,
    updatedAt: later,
    closedAt: null,
  });
}

function openedPane(): ChatPaneProjection {
  return {
    id: childPaneId,
    paletteIndex: 0,
    revision: 1,
    title: "Inspect replay",
    repository: {
      id: "repo_00000000000000000000000001",
      name: "example",
    },
    accountProfileId: null,
    interactionMode: "harnessObserver",
    state: "ready",
    activity: { ordinal: 0, kind: "idle" },
    workspace: null,
    turn: null,
    attention: null,
    recoverablePrompt: false,
    canStartFreshContext: false,
    schedule: null,
    messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
    attachments: { drafts: [], referenced: [] },
    harness: null,
  };
}

function initialChildProjection(
  value: MutableFixture,
  owner: Actor,
  revision: number,
  openedPaneId: string | null = null,
): HarnessChildProjection {
  const state = deriveHarnessChildState({
    actor: owner,
    incarnation: value.incarnations.get(owner.id) ?? null,
    latestTurn: value.turns.get(owner.id) ?? null,
  });
  const actions = deriveHarnessChildActions({
    actor: owner,
    incarnation: value.incarnations.get(owner.id) ?? null,
    latestTurn: value.turns.get(owner.id) ?? null,
    binding: value.bindings.get(owner.id) ?? null,
  });
  return {
    id: owner.id,
    revision,
    title: owner.title,
    state,
    openedPaneId,
    ...actions,
    canStop: state !== "stopped" && state !== "quarantined",
  };
}

function setWitness(
  fixture: MutableFixture,
  childId: string,
  revision: number,
): Witness {
  const owner = fixture.actors.get(childId);
  if (owner === undefined) throw new Error("fixture actor missing");
  const paneId = fixture.bindings.get(childId)?.paneId ?? null;
  const projection = initialChildProjection(fixture, owner, revision, paneId);
  const witness = {
    actorId: childId,
    revision,
    semanticDigest: harnessChildSemanticDigest({
      id: projection.id,
      title: projection.title,
      state: projection.state,
      openedPaneId: projection.openedPaneId,
      canOpen: projection.canOpen,
      canMessage: projection.canMessage,
      canStop: projection.canStop,
    }),
  };
  fixture.witnesses.set(childId, witness);
  return witness;
}

function fixture(): MutableFixture {
  const parent = actor(parentActorId, null, "Parent", 1);
  const child = actor(childActorId, parentActorId, "Inspect replay", 2);
  const value: MutableFixture = {
    settings: {
      revision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 16 * MIB,
      refinementMode: "suggest",
    },
    proposals: [],
    paneIds: [parentPaneId],
    actors: new Map([[parent.id, parent], [child.id, child]]),
    paneActors: new Map([[parentPaneId, parent.id]]),
    children: new Map([[parent.id, [child.id]], [child.id, []]]),
    turns: new Map([[child.id, turn("hturn_renderer_child001", child.id)]]),
    incarnations: new Map([[child.id, incarnation(child.id)]]),
    bindings: new Map(),
    witnesses: new Map(),
    paneListReads: 0,
    mutateOnSecondPaneRead: null,
    settingsUpdates: 0,
    opens: 0,
    stops: 0,
  };
  setWitness(value, child.id, 1);
  return value;
}

function harnessRevision(value: MutableFixture): number {
  return value.settings.revision + value.proposals.reduce(
    (sum, proposal) => sum + proposal.revision,
    0,
  );
}

function parentRevision(value: MutableFixture, parentId: string): number {
  return (value.children.get(parentId) ?? []).reduce((sum, childId) => {
    const witness = value.witnesses.get(childId);
    if (witness === undefined) throw new Error("fixture witness missing");
    return sum + witness.revision;
  }, 0);
}

function page<T extends string | { id: string }>(
  values: readonly T[],
  after: string | null,
  limit: number,
): readonly T[] {
  return values.filter((value) => {
    const id = typeof value === "string" ? value : value.id;
    return after === null || id > after;
  }).slice(0, limit).map((value) => structuredClone(value));
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
}

function options(value: MutableFixture): HarnessRendererAuthorityV2Options {
  const actors: HarnessRendererActorReadPort = {
    readActorForPane: (paneId) => {
      const id = value.paneActors.get(paneId);
      return id === undefined ? null : structuredClone(value.actors.get(id));
    },
    listActorChildren: ({ parentActorId: parentId, afterActorId, limit }) => {
      const rows = (value.children.get(parentId) ?? []).map((id) => {
        const row = value.actors.get(id);
        if (row === undefined) throw new Error("fixture child missing");
        return row;
      }).sort((left, right) => left.id.localeCompare(right.id));
      return page(rows.map((row) => ({ ...row, id: row.id })), afterActorId, limit);
    },
    readActiveIncarnationForActor: (actorId) =>
      structuredClone(value.incarnations.get(actorId) ?? null),
    readLatestActorTurnForActor: (actorId) =>
      structuredClone(value.turns.get(actorId) ?? null),
    readPaneBindingForActor: (actorId) =>
      structuredClone(value.bindings.get(actorId) ?? null),
    readProjectionWitness: (actorId) =>
      structuredClone(value.witnesses.get(actorId) ?? null),
  };
  const chat: HarnessRendererChatAttachmentPort = {
    listPaneIds: ({ afterPaneId, limit }) => {
      value.paneListReads += 1;
      if (value.paneListReads === 2) value.mutateOnSecondPaneRead?.();
      return page([...value.paneIds].sort(), afterPaneId, limit);
    },
    openChild: (input) => {
      value.opens += 1;
      const child = value.actors.get(input.childActorId);
      if (child === undefined) throw codedError("not_found");
      if (
        parentRevision(value, input.parentActorId) !== input.expectedParentRevision ||
        value.witnesses.get(child.id)?.revision !== input.expectedChildRevision
      ) throw codedError("revision_conflict");
      const binding = actorPaneBindingSchema.parse({
        id: "hpanebinding_renderer01",
        actorId: child.id,
        paneId: childPaneId,
        state: "attached",
        revision: 1,
        attachedAt: later,
        detachedAt: null,
      });
      value.bindings.set(child.id, binding);
      value.paneIds.push(childPaneId);
      value.paneIds.sort();
      value.paneActors.set(childPaneId, child.id);
      const childWitness = setWitness(value, child.id, input.expectedChildRevision + 1);
      return {
        parentPaneId: input.parentPaneId,
        parentActorId: input.parentActorId,
        parentRevision: parentRevision(value, input.parentActorId),
        childActorId: child.id,
        childWitness,
        binding,
        pane: openedPane(),
      };
    },
  };
  return {
    settings: {
      read: () => ({
        settings: structuredClone(value.settings),
        harnessRevision: harnessRevision(value),
      }),
      update: (input) => {
        value.settingsUpdates += 1;
        if (
          input.expectedHarnessRevision !== harnessRevision(value) ||
          input.expectedSettingsRevision !== value.settings.revision
        ) throw codedError("revision_conflict");
        value.settings = {
          revision: value.settings.revision + 1,
          recursiveSessionsEnabled: input.recursiveSessionsEnabled,
          contextQuotaBytes: input.contextQuotaBytes,
          refinementMode: input.refinementMode,
        };
        return {
          settings: structuredClone(value.settings),
          harnessRevision: harnessRevision(value),
        };
      },
    },
    proposals: {
      list: ({ afterProposalId, limit }) => page(
        [...value.proposals].sort((left, right) => left.id.localeCompare(right.id)),
        afterProposalId,
        limit,
      ),
    },
    actors,
    chat,
    coordinator: {
      requestAndSettleStop: (input) => {
        value.stops += 1;
        const child = value.actors.get(input.childActorId);
        if (child === undefined) throw codedError("not_found");
        if (
          parentRevision(value, input.parentActorId) !== input.expectedParentRevision ||
          value.witnesses.get(child.id)?.revision !== input.expectedChildRevision
        ) throw codedError("revision_conflict");
        const stopped = actorSchema.parse({
          ...child,
          state: "stopped",
          revision: child.revision + 2,
          updatedAt: later,
          stoppedAt: later,
        });
        value.actors.set(child.id, stopped);
        value.incarnations.delete(child.id);
        const childWitness = setWitness(value, child.id, input.expectedChildRevision + 1);
        return {
          parentPaneId: input.parentPaneId,
          parentActorId: input.parentActorId,
          parentRevision: parentRevision(value, input.parentActorId),
          child: stopped,
          childWitness,
        };
      },
    },
  };
}

describe("minimal v2 renderer authority", () => {
  test("assembles one stable content-free projection with derived revisions", async () => {
    const value = fixture();
    value.proposals.push({
      id: "hproposal_renderer0001",
      revision: 2,
      title: "Prefer bounded context",
    });
    const authority = new HarnessRendererAuthorityV2(options(value));
    const projection = await authority.readProjection();
    expect(projection).toMatchObject({
      harness: {
        revision: 3,
        settings: { revision: 1 },
        proposals: [{ id: "hproposal_renderer0001", revision: 2 }],
      },
      panes: [{
        paneId: parentPaneId,
        harness: {
          revision: 1,
          descendants: {
            count: 1,
            truncated: false,
            children: [{
              id: childActorId,
              revision: 1,
              state: "idle",
              openedPaneId: null,
              canOpen: true,
              canMessage: false,
              canStop: true,
            }],
          },
        },
      }],
    });
    expect(JSON.stringify(projection)).not.toMatch(
      /provider|account|processGeneration|threadSource|inputValue/iu,
    );
  });

  test("authorizes every definitive idle outcome and quarantines ambiguity", async () => {
    for (const turnState of [
      "succeeded",
      "cancelled",
      "failed",
      "quotaRejected",
      "ambiguous",
    ] as const) {
      const value = fixture();
      const latest = value.turns.get(childActorId);
      if (latest === undefined) throw new Error("fixture turn missing");
      value.turns.set(childActorId, actorTurnSchema.parse({
        ...latest,
        state: turnState,
        outcomeCode: turnState,
      }));
      setWitness(value, childActorId, 1);
      const projection = await new HarnessRendererAuthorityV2(options(value))
        .readProjection() as HarnessRendererProjection;
      const child = projection.panes[0]?.harness?.descendants.children[0];
      if (turnState === "ambiguous") {
        expect(child).toMatchObject({
          state: "quarantined",
          canOpen: false,
          canMessage: false,
          canStop: false,
        });
      } else {
        expect(child).toMatchObject({
          state: turnState === "failed" || turnState === "quotaRejected"
            ? "failed"
            : "idle",
          canOpen: true,
          canMessage: false,
          canStop: true,
        });
      }
    }
  });

  test("settings CAS advances only the global and settings revisions", async () => {
    const value = fixture();
    const authority = new HarnessRendererAuthorityV2(options(value));
    const outcome = await authority.execute({
      type: "harness.settings.update",
      expectedHarnessRevision: 1,
      expectedRevision: 1,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "off",
    }) as { result: { harnessRevision: number; settings: { revision: number } } };
    expect(outcome.result).toMatchObject({
      type: "harnessSettings",
      harnessRevision: 2,
      settings: { revision: 2, contextQuotaBytes: 8 * MIB },
    });
    expect(value.settingsUpdates).toBe(1);

    await expectErrorCode(authority.execute({
      type: "harness.settings.update",
      expectedHarnessRevision: 1,
      expectedRevision: 1,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "off",
    }), "stale_revision");
    expect(value.settingsUpdates).toBe(1);
  });

  test("Open atomically attaches a full pane and advances child and parent once", async () => {
    const value = fixture();
    const authority = new HarnessRendererAuthorityV2(options(value));
    const outcome = await authority.execute({
      type: "harness.child.open",
      parentPaneId,
      childId: childActorId,
      expectedParentRevision: 1,
      expectedChildRevision: 1,
    }) as {
      result: {
        parentRevision: number;
        child: HarnessChildProjection;
        pane: ChatPaneProjection;
      };
      projection: { panes: Array<{ paneId: string }> };
    };
    expect(outcome.result.parentRevision).toBe(2);
    expect(outcome.result.child).toMatchObject({
      revision: 2,
      openedPaneId: childPaneId,
      canOpen: false,
      canMessage: true,
    });
    expect(outcome.result.pane.id).toBe(childPaneId);
    expect(outcome.projection.panes.map(({ paneId }) => paneId)).toEqual([
      childPaneId,
      parentPaneId,
    ]);
    expect(value.opens).toBe(1);
  });

  test("Stop coalesces durable request and settlement into one visible revision", async () => {
    const value = fixture();
    const authority = new HarnessRendererAuthorityV2(options(value));
    const outcome = await authority.execute({
      type: "harness.child.stop",
      parentPaneId,
      childId: childActorId,
      expectedParentRevision: 1,
      expectedChildRevision: 1,
    }) as { result: { parentRevision: number; child: HarnessChildProjection } };
    expect(outcome.result).toMatchObject({
      type: "harnessChild",
      parentRevision: 2,
      child: {
        revision: 2,
        state: "stopped",
        canOpen: false,
        canMessage: false,
        canStop: false,
      },
    });
    expect(value.actors.get(childActorId)?.revision).toBe(3);
    expect(value.stops).toBe(1);
  });

  test("durable stop intent projects live cleanup until terminal settlement", async () => {
    const value = fixture();
    const child = value.actors.get(childActorId);
    const latest = value.turns.get(childActorId);
    if (child === undefined || latest === undefined) {
      throw new Error("fixture child lifecycle is missing");
    }
    value.actors.set(child.id, actorSchema.parse({
      ...child,
      state: "stopRequested",
      revision: child.revision + 1,
      updatedAt: later,
    }));
    value.turns.set(child.id, actorTurnSchema.parse({
      ...latest,
      state: "reconciling",
      desiredState: "stop",
      revision: latest.revision + 1,
      settledAt: null,
      outcomeCode: null,
    }));
    setWitness(value, child.id, 2);

    const projection = await new HarnessRendererAuthorityV2(options(value))
      .readProjection() as HarnessRendererProjection;
    expect(projection.panes[0]?.harness?.descendants.children[0]).toMatchObject({
      state: "waiting",
      canOpen: false,
      canMessage: false,
      canStop: true,
    });

    await expectErrorCode(new HarnessRendererAuthorityV2(options(value)).execute({
      type: "harness.child.open",
      parentPaneId,
      childId: childActorId,
      expectedParentRevision: 2,
      expectedChildRevision: 2,
    }), "invalid_state");
    expect(value.opens).toBe(0);
  });

  test("fails closed when a bounded double read observes different authority", async () => {
    const value = fixture();
    value.mutateOnSecondPaneRead = () => {
      const child = value.actors.get(childActorId);
      if (child === undefined) throw new Error("fixture child missing");
      value.actors.set(child.id, actorSchema.parse({
        ...child,
        title: "Changed during read",
        revision: child.revision + 1,
        updatedAt: later,
      }));
      setWitness(value, child.id, 2);
    };
    const authority = new HarnessRendererAuthorityV2(options(value));
    await expectErrorCode(authority.readProjection(), "authority_conflict");
  });

  test("fails closed on a stale semantic witness and incoherent latest turn", async () => {
    const staleWitness = fixture();
    const child = staleWitness.actors.get(childActorId);
    if (child === undefined) throw new Error("fixture child missing");
    staleWitness.actors.set(child.id, actorSchema.parse({
      ...child,
      title: "Digest not advanced",
      revision: child.revision + 1,
      updatedAt: later,
    }));
    await expectErrorCode(
      new HarnessRendererAuthorityV2(options(staleWitness)).readProjection(),
      "authority_conflict",
    );

    const wrongOrdinal = fixture();
    const latest = wrongOrdinal.turns.get(childActorId);
    if (latest === undefined) throw new Error("fixture turn missing");
    wrongOrdinal.turns.set(childActorId, actorTurnSchema.parse({
      ...latest,
      ordinal: 2,
    }));
    await expectErrorCode(
      new HarnessRendererAuthorityV2(options(wrongOrdinal)).readProjection(),
      "authority_conflict",
    );
  });

  test("rejects out-of-order child pages before exposing a projection", async () => {
    const value = fixture();
    const base = options(value);
    const badActors: HarnessRendererActorReadPort = {
      ...base.actors,
      listActorChildren: ({ parentActorId: parentId }) => {
        if (parentId !== parentActorId) return [];
        const child = value.actors.get(childActorId);
        if (child === undefined) throw new Error("fixture child missing");
        return [child, child];
      },
    };
    await expectErrorCode(new HarnessRendererAuthorityV2({
      ...base,
      actors: badActors,
    }).readProjection(), "authority_conflict");
  });
});
