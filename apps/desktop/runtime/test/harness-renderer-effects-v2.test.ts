import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

import {
  actorEpochSchema,
  actorSchema,
  type Actor,
  type ActorEpoch,
} from "../src/harness/actor-domain";
import {
  type HarnessContextOperationRangeReaderV2,
  type HarnessContextOperationValuePortV2,
  type HarnessContextOperationValueRecordV2,
} from "../src/harness/context-value-ports-v2";
import {
  HarnessRendererEffectsV2,
  type HarnessRendererActorResponsePort,
} from "../src/harness/renderer-effects-v2";
import {
  harnessChildSemanticDigest,
} from "../src/harness/renderer-authority-v2";
import { HarnessRendererSQLiteAdapterV2 } from "../src/harness/renderer-sqlite-adapter-v2";
import type { PersistentActorTurnView } from "../src/harness/persistent-actors";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { applyMigrations } from "../src/state/database";
import {
  ChatPaneStore,
  harnessObserverPaneId,
} from "../src/state/chat-pane-store";

const at = "2030-01-01T00:00:00.000Z";
const started = "2030-01-01T00:00:01.000Z";
const completed = "2030-01-01T00:00:02.000Z";
const later = "2030-01-01T00:00:03.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const repositoryId = `repo_${"7".repeat(26)}`;
const accountId = "acct_renderer_effects01";
const epochId = "hepoch_renderer_effects01";
const rootActorId = "hactor_renderer_effectroot";
const childActorId = "hactor_renderer_effectchild";
const parentPaneId = "pane_renderer_effectparent";
const childTurnId = "hturn_renderer_effectchild";
const resultValueId = "ctxval_renderer_effectresult";
const followupResultValueId = "ctxval_renderer_followupresult";
const followupTurnId = "hturn_renderer_effectfollowup";
const followupProviderTurnId = "provider-turn-renderer-effect-followup";
const providerThreadId = "provider-thread-renderer-effects";
const MIB = 1024 * 1024;

interface Fixture {
  readonly actors: HarnessSQLiteAuthorityV2;
  readonly database: Database;
  readonly effects: HarnessRendererEffectsV2;
  readonly panes: ChatPaneStore;
  readonly published: Array<ReturnType<ChatPaneStore["list"]>[number]>;
  readonly livenessCalls: string[];
  readonly renderer: HarnessRendererSQLiteAdapterV2;
  readonly responseReads: Array<Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    valueId: string;
  }>>;
  readonly sessionReads: Array<Readonly<{
    kind: "chat" | "event" | "turn";
    expectedGeneration: number;
  }>>;
  readonly sendCalls: unknown[];
  readonly stopCalls: string[];
  readonly values: ExactValues;
  readonly root: Actor;
  readonly child: Actor;
}

class ExactValues implements HarnessContextOperationValuePortV2 {
  readonly records = new Map<string, Readonly<{
    input: Parameters<HarnessContextOperationValuePortV2["putExact"]>[0];
    value: HarnessContextOperationValueRecordV2;
  }>>();

  putExact(
    input: Parameters<HarnessContextOperationValuePortV2["putExact"]>[0],
  ): Promise<Readonly<{ value: HarnessContextOperationValueRecordV2 }>> {
    const existing = this.records.get(input.valueId);
    if (existing !== undefined) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) {
        return Promise.reject(new Error("immutable renderer input conflict"));
      }
      return Promise.resolve({ value: existing.value });
    }
    const value = Object.freeze({
      epochId: input.epochId,
      ownerActorId: input.ownerActorId,
      sourceTurnId: input.sourceTurnId,
      valueId: input.valueId,
      kind: input.kind,
      purpose: input.purpose,
      nameDigest: null,
      utf8Bytes: Buffer.byteLength(input.plaintext, "utf8"),
      quotaLimitBytes: input.quotaLimitBytes,
    });
    this.records.set(input.valueId, Object.freeze({
      input: structuredClone(input),
      value,
    }));
    return Promise.resolve({ value });
  }

  openExact(
    input: Parameters<HarnessContextOperationValuePortV2["openExact"]>[0],
  ): Promise<Readonly<{
    plaintext: string;
    value: HarnessContextOperationValueRecordV2;
  }>> {
    const record = this.records.get(input.valueId);
    if (record === undefined) return Promise.reject(new Error("renderer input missing"));
    const address = {
      epochId: record.input.epochId,
      ownerActorId: record.input.ownerActorId,
      sourceTurnId: record.input.sourceTurnId,
      valueId: record.input.valueId,
      kind: record.input.kind,
      purpose: record.input.purpose,
    };
    if (JSON.stringify(address) !== JSON.stringify(input)) {
      return Promise.reject(new Error("renderer input address conflict"));
    }
    return Promise.resolve({ plaintext: record.input.plaintext, value: record.value });
  }

  withExactRangeReader<Result>(
    _input: Parameters<HarnessContextOperationValuePortV2["withExactRangeReader"]>[0],
    _operation: (reader: HarnessContextOperationRangeReaderV2) => Promise<Result> | Result,
  ): Promise<Result> {
    void _input;
    void _operation;
    return Promise.reject(new Error("unexpected completed-prefix range read"));
  }

  withExactActorResultRangeReader<Result>(
    _input: Parameters<HarnessContextOperationValuePortV2["withExactActorResultRangeReader"]>[0],
    _operation: (reader: HarnessContextOperationRangeReaderV2) => Promise<Result> | Result,
  ): Promise<Result> {
    void _input;
    void _operation;
    return Promise.reject(new Error("unexpected actor-result range read"));
  }

  listActive(): Promise<readonly HarnessContextOperationValueRecordV2[]> {
    return Promise.resolve([]);
  }
}

function budget() {
  return {
    maxDepth: 3,
    maxActiveDescendants: 8,
    maxDurableDescendants: 50,
    tokenBudget: 100_000,
    byteBudget: 16 * MIB,
    deadline,
    laneAuthority: "managedWrite" as const,
  };
}

function epochAndRoot(): { epoch: ActorEpoch; rootActor: Actor } {
  const actorBudget = budget();
  return {
    epoch: actorEpochSchema.parse({
      id: epochId,
      projectId: repositoryId,
      sourceSha: "a".repeat(40),
      rootActorId,
      budget: actorBudget,
      tokenReserved: 0,
      byteReserved: 0,
      nextRootCompletionSequence: 1,
      state: "active",
      revision: 1,
      createdAt: at,
      updatedAt: at,
      stoppedAt: null,
    }),
    rootActor: actorSchema.parse({
      id: rootActorId,
      epochId,
      parentActorId: null,
      depth: 0,
      title: "Root actor",
      state: "active",
      budget: actorBudget,
      tokenReserved: 0,
      byteReserved: 0,
      nextTurnOrdinal: 1,
      nextResultOrdinal: 1,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      stoppedAt: null,
    }),
  };
}

function childActor(parent: Actor): Actor {
  return actorSchema.parse({
    id: childActorId,
    epochId,
    parentActorId: parent.id,
    depth: 1,
    title: "Research actor",
    state: "active",
    budget: {
      ...parent.budget,
      tokenBudget: 20_000,
      byteBudget: 4 * MIB,
      laneAuthority: "readOnlySnapshot",
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
}

function fixture(input: Readonly<{
  eventRoute?: (request: Readonly<{
    accountProfileId: string;
    threadId: string;
    turnId: string;
  }>) => Readonly<{
    actorId: string;
    admissionGeneration: number;
    generation: number;
    providerThreadId: string;
    threadId: string;
    turnId: string;
  }> | null;
  response?: string | null;
  publish?: (pane: ReturnType<ChatPaneStore["list"]>[number]) => void;
  reconcile?: () => Promise<void>;
  repositoryPath?: string;
  send?: (request: unknown) => Promise<PersistentActorTurnView>;
  sessionGeneration?: number;
  withResult?: boolean;
}> = {}): Fixture {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/renderer-effects', '/tmp/renderer-effects/.git',
      'Renderer Effects', ?2, ?2)
  `).run(repositoryId, at);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Renderer account', 'signed_in', 1, 1, ?2, ?2)
  `).run(accountId, at);

  const actors = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(later),
  });
  const { epoch, rootActor } = epochAndRoot();
  const root = actors.createActorEpoch({ epoch, rootActor }).rootActor;
  const child = actors.createChildActor(childActor(root));
  const panes = new ChatPaneStore(database);
  panes.create({
    paneId: parentPaneId,
    repository: {
      id: repositoryId,
      name: "Renderer Effects",
      workingDirectory: "/tmp/renderer-effects",
    },
    accountProfileId: null,
    reasoningEffort: "ultra",
    now: new Date(at),
  });
  actors.attachActorPane({
    bindingId: "hpanebinding_effectroot1",
    actorId: root.id,
    paneId: parentPaneId,
    attachedAt: at,
  });
  const sessionGeneration = input.sessionGeneration ?? 1;
  createIdleIncarnation(database, actors, sessionGeneration);
  if (input.withResult !== false) createSuccessfulResult(database, actors);

  const renderer = new HarnessRendererSQLiteAdapterV2(database, {
    actors,
    now: () => new Date(later),
  });
  const currentChild = actors.readActor(child.id)!;
  renderer.writeProjectionWitness({
    actorId: child.id,
    expectedRevision: null,
    projection: {
      id: child.id,
      title: child.title,
      state: "idle",
      openedPaneId: null,
      canOpen: input.withResult !== false,
      canMessage: false,
      canStop: true,
    },
  });
  const published: Fixture["published"] = [];
  const livenessCalls: Fixture["livenessCalls"] = [];
  const responseReads: Fixture["responseReads"] = [];
  const sessionReads: Fixture["sessionReads"] = [];
  const sendCalls: unknown[] = [];
  const stopCalls: string[] = [];
  const values = new ExactValues();
  const responses: HarnessRendererActorResponsePort = {
    readActorResponse: (request) => {
      responseReads.push(request);
      return Promise.resolve(input.response === undefined ? "Completed answer." : input.response);
    },
  };
  const effects = new HarnessRendererEffectsV2({
    database,
    actors,
    renderer,
    panes,
    sessions: {
      readHarnessActorChatAttachment: (request) => {
        sessionReads.push({
          kind: "chat",
          expectedGeneration: request.expectedGeneration,
        });
        return request.accountProfileId === accountId &&
            request.expectedGeneration === sessionGeneration &&
            request.providerThreadId === providerThreadId
          ? { threadId: "thread_owned_renderer_effects", restartThreadId: providerThreadId }
          : null;
      },
      readHarnessActorChatEventRoute: (request) => {
        sessionReads.push({
          kind: "event",
          expectedGeneration: sessionGeneration,
        });
        return input.eventRoute === undefined
          ? request.accountProfileId === accountId &&
              request.threadId === "thread_owned_renderer_effects" &&
              request.turnId === "turn_owned_renderer_effects_followup"
            ? {
                actorId: childActorId,
                admissionGeneration: 1,
                generation: sessionGeneration,
                providerThreadId,
                threadId: "thread_owned_renderer_effects",
                turnId: "turn_owned_renderer_effects_followup",
              }
            : null
          : input.eventRoute(request);
      },
      readHarnessActorChatTurnAttachment: (request) => {
        sessionReads.push({
          kind: "turn",
          expectedGeneration: request.expectedGeneration,
        });
        return request.accountProfileId === accountId &&
            request.expectedGeneration === sessionGeneration &&
            request.providerThreadId === providerThreadId &&
            request.providerTurnId === "provider-turn-renderer-effect-followup"
          ? {
              threadId: "thread_owned_renderer_effects",
              turnId: "turn_owned_renderer_effects_followup",
            }
          : null;
      },
    },
    repositories: {
      resolve: (id) => Promise.resolve(id === repositoryId
        ? {
            id: repositoryId,
            name: "Renderer Effects",
            workingDirectory: input.repositoryPath ?? "/tmp/renderer-effects",
          }
        : null),
    },
    coordinator: {
      send: async (request) => {
        sendCalls.push(structuredClone(request));
        if (input.send === undefined) throw new Error("unexpected actor send");
        return await input.send(request);
      },
      quiesceActorForStop: ({ callerActorId, actorId }: {
        callerActorId: string;
        actorId: string;
      }) => {
        stopCalls.push(actorId);
        if (callerActorId !== rootActorId || actorId !== childActorId) {
          throw new Error("unauthorized stop");
        }
        const descendants = actors.listActorChildren({
          parentActorId: actorId,
          afterActorId: null,
          limit: 51,
        });
        if (descendants.some((descendant) =>
          descendant.state !== "stopped" && descendant.state !== "quarantined")) {
          throw Object.assign(new Error("live descendant"), { code: "invalid_state" });
        }
        const incarnation = actors.readActiveIncarnationForActor(actorId);
        if (incarnation !== null) {
          actors.transitionActorIncarnation({
            incarnationId: incarnation.id,
            expectedState: incarnation.state,
            nextState: "closed",
            now: later,
          });
        }
        const actor = actors.readActor(actorId)!;
        return Promise.resolve(actor.state === "stopRequested"
          ? actor
          : actors.requestActorStop({
              actorId,
              expectedRevision: actor.revision,
              now: later,
            }));
      },
    },
    liveness: {
      ensureCurrent: async () => {
        livenessCalls.push("ensureCurrent");
        await input.reconcile?.();
      },
    },
    values,
    responses,
    projection: {
      paneChanged: (pane) => {
        input.publish?.(pane);
        published.push(pane);
      },
    },
    now: () => new Date(later),
  });
  expect(currentChild.state).toBe("active");
  return {
    actors,
    database,
    effects,
    panes,
    published,
    livenessCalls,
    renderer,
    responseReads,
    sessionReads,
    sendCalls,
    stopCalls,
    values,
    root,
    child,
  };
}

function createIdleIncarnation(
  database: Database,
  actors: HarnessSQLiteAuthorityV2,
  liveGeneration: number,
): void {
  let operation = actors.prepareActorOperation({
    operationId: "hoperation_rendererstart1",
    actorId: childActorId,
    turnId: null,
    kind: "actorStart",
    requestDigest: "b".repeat(64),
    effectKey: "c".repeat(64),
    providerIdentityJson: '{"request":{"fixture":true},"version":1}',
    createdAt: at,
  });
  operation = actors.transitionActorOperation({
    operationId: operation.id,
    expectedState: "prepared",
    nextState: "effectStarted",
    now: started,
  });
  actors.transitionActorOperation({
    operationId: operation.id,
    expectedState: "effectStarted",
    nextState: "succeeded",
    providerIdentityJson: JSON.stringify({ providerThreadId }),
    now: started,
  });
  const incarnation = actors.createActorIncarnation({
    incarnationId: "hincarnation_renderereffect1",
    actorId: childActorId,
    accountProfileId: accountId,
    processGeneration: 1,
    startOperationId: operation.id,
    clientRequestId: "client-request-renderer-effect-01",
    threadSource: "oprte:renderer:effect:thread:1",
    toolsetDigest: "d".repeat(64),
    createdAt: started,
  });
  actors.transitionActorIncarnation({
    incarnationId: incarnation.id,
    expectedState: "starting",
    nextState: "idle",
    providerThreadId,
    now: started,
  });
  bindSessionFixture(database, actors, {
    actorId: childActorId,
    incarnationId: incarnation.id,
    liveGeneration,
    suffix: "child01",
  });
}

function bindSessionFixture(
  database: Database,
  actors: HarnessSQLiteAuthorityV2,
  input: Readonly<{
    actorId: string;
    incarnationId: string;
    liveGeneration: number;
    suffix: string;
  }>,
): void {
  const laneId = "lane_renderer_effects_shared";
  const existingLane = database.query<{ lane_id: string }, [string]>(`
    SELECT lane_id FROM workspace_leases WHERE lane_id = ?1
  `).get(laneId);
  if (existingLane === null) {
    database.query(`
      INSERT INTO workspace_leases (
        lane_id, project_id, canonical_checkout_path, mode, status,
        base_sha, branch_name, retention, dirty_hint,
        created_at, updated_at, quarantine_reason, quarantined_at
      ) VALUES (
        ?1, ?2, '/tmp/renderer-effects-shared',
        'harness_read_only_snapshot', 'ready', ?3, NULL,
        'preserve', 0, ?4, ?4, NULL, NULL
      )
    `).run(laneId, repositoryId, "a".repeat(40), at);
  }
  actors.bindActorWorkspace({
    bindingId: `hbinding_renderer_effects_${input.suffix}`,
    actorId: input.actorId,
    laneId,
    authority: "readOnlySnapshot",
    createdAt: at,
  });
  const firstProof = actorSessionRecoveryProof({
    incarnationId: input.incarnationId,
    generation: 1,
    priorRecoveryProofDigest: null,
  });
  let binding = actors.bindActorSession({
    incarnationId: input.incarnationId,
    recoveryProof: firstProof,
    createdAt: started,
  });
  if (input.liveGeneration === 1) return;
  database.query(`
    UPDATE account_profiles SET process_generation = ?2, updated_at = ?3
    WHERE profile_id = ?1
  `).run(accountId, input.liveGeneration, later);
  binding = actors.advanceActorSessionBinding({
    incarnationId: input.incarnationId,
    expectedRevision: binding.revision,
    expectedLiveGeneration: binding.liveGeneration,
    liveCapabilityEvidence: {
      evidenceDigest: "c".repeat(64),
      supportsFast: true,
    },
    recoveryProof: actorSessionRecoveryProof({
      incarnationId: input.incarnationId,
      generation: input.liveGeneration,
      priorRecoveryProofDigest: binding.recoveryProof.recoveryProofDigest,
    }),
    now: later,
  });
  expect(binding).toMatchObject({
    admissionGeneration: 1,
    liveGeneration: input.liveGeneration,
  });
}

function actorSessionRecoveryProof(input: Readonly<{
  incarnationId: string;
  generation: number;
  priorRecoveryProofDigest: string | null;
}>) {
  const digest = (domain: string) => createHash("sha256")
    .update(`${domain}\0${input.incarnationId}\0${String(input.generation)}`, "utf8")
    .digest("hex");
  return {
    recoveryProofDigest: digest("renderer-session-proof"),
    priorRecoveryProofDigest: input.priorRecoveryProofDigest,
    observationGeneration: input.generation,
    historyEvidenceDigest: digest("renderer-history-evidence"),
    firstObservationPosition: input.generation * 10,
    secondObservationPosition: input.generation * 10 + 1,
    historyTurnCount: 0,
    historyItemCount: 0,
  } as const;
}

function createSuccessfulResult(
  database: Database,
  actors: HarnessSQLiteAuthorityV2,
): void {
  insertContextValue(database, {
    valueId: "ctxval_renderer_effectinput1",
    actorId: childActorId,
    purpose: "currentInput",
    sourceTurnId: null,
    marker: "e",
  });
  let turn = actors.createActorTurn({
    turnId: childTurnId,
    epochId,
    actorId: childActorId,
    idempotencyKey: "idempotency-renderer-effect-01", // gitleaks:allow - deterministic test vector
    inputValueId: "ctxval_renderer_effectinput1",
    createdAt: at,
  });
  turn = actors.transitionActorTurn({
    turnId: turn.id,
    expectedRevision: turn.revision,
    nextState: "starting",
    now: started,
  });
  turn = actors.transitionActorTurn({
    turnId: turn.id,
    expectedRevision: turn.revision,
    nextState: "running",
    now: started,
  });
  let attempt = actors.createActorAttempt({
    attemptId: "hattempt_renderer_effect01",
    turnId: turn.id,
    incarnationId: "hincarnation_renderereffect1",
    accountProfileId: accountId,
    processGeneration: 1,
    clientUserMessageId: "client-message-renderer-effect01",
    createdAt: started,
  });
  attempt = actors.transitionActorAttempt({
    attemptId: attempt.id,
    expectedState: "starting",
    nextState: "running",
    providerTurnId: "provider-turn-renderer-effect",
    now: started,
  });
  attempt = actors.transitionActorAttempt({
    attemptId: attempt.id,
    expectedState: "running",
    nextState: "completed",
    now: completed,
  });
  insertContextValue(database, {
    valueId: resultValueId,
    actorId: childActorId,
    purpose: "agentResult",
    sourceTurnId: turn.id,
    marker: "f",
  });
  actors.settleActorResult({
    resultId: "hresult_renderer_effect01",
    turnId: turn.id,
    terminalAttemptId: attempt.id,
    outcome: "succeeded",
    valueId: resultValueId,
    expectedTurnRevision: turn.revision,
    outcomeCode: "completed",
    createdAt: completed,
  });
}

function insertContextValue(
  database: Database,
  input: Readonly<{
    valueId: string;
    actorId: string;
    purpose: "currentInput" | "agentResult";
    sourceTurnId: string | null;
    marker: string;
  }>,
): void {
  const digest = input.marker.repeat(64);
  database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, 1,
      ?8, 65536, 1, ?8, 1, 16777216, 'active', NULL,
      3, ?9, ?9, ?9, ?9
    )
  `).run(
    input.valueId,
    `contextop_${input.valueId}`,
    epochId,
    input.actorId,
    input.sourceTurnId,
    input.purpose === "agentResult" ? "agentResult" : "text",
    input.purpose,
    digest,
    at,
  );
  database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 1, ?2, 1)
  `).run(input.valueId, digest);
}

function driveFollowup(
  value: Fixture,
  requestValue: unknown,
  outcome: "accepted" | "succeeded",
): PersistentActorTurnView {
  const request = requestValue as Readonly<{
    callerActorId: string;
    actorId: string;
    idempotencyKey: string;
    inputValueId: string;
  }>;
  expect(request).toMatchObject({
    callerActorId: rootActorId,
    actorId: childActorId,
  });
  insertContextValue(value.database, {
    valueId: request.inputValueId,
    actorId: childActorId,
    purpose: "currentInput",
    sourceTurnId: null,
    marker: "9",
  });
  let turn = value.actors.createActorTurn({
    turnId: followupTurnId,
    epochId,
    actorId: childActorId,
    idempotencyKey: request.idempotencyKey,
    inputValueId: request.inputValueId,
    createdAt: later,
  });
  turn = value.actors.transitionActorTurn({
    turnId: turn.id,
    expectedRevision: turn.revision,
    nextState: "starting",
    now: later,
  });
  turn = value.actors.transitionActorTurn({
    turnId: turn.id,
    expectedRevision: turn.revision,
    nextState: "running",
    now: later,
  });
  const incarnationId = "hincarnation_renderereffect1";
  let attempt = value.actors.createActorAttempt({
    attemptId: productionAttemptId(turn.id, incarnationId),
    turnId: turn.id,
    incarnationId,
    accountProfileId: accountId,
    processGeneration: 1,
    clientUserMessageId: "client-message-renderer-followup01",
    createdAt: later,
  });
  attempt = value.actors.transitionActorAttempt({
    attemptId: attempt.id,
    expectedState: "starting",
    nextState: "running",
    providerTurnId: followupProviderTurnId,
    now: later,
  });
  if (outcome === "accepted") return { turn, result: null };

  attempt = value.actors.transitionActorAttempt({
    attemptId: attempt.id,
    expectedState: "running",
    nextState: "completed",
    now: later,
  });
  insertContextValue(value.database, {
    valueId: followupResultValueId,
    actorId: childActorId,
    purpose: "agentResult",
    sourceTurnId: turn.id,
    marker: "7",
  });
  const result = value.actors.settleActorResult({
    resultId: "hresult_renderer_followup01",
    turnId: turn.id,
    terminalAttemptId: attempt.id,
    outcome: "succeeded",
    valueId: followupResultValueId,
    expectedTurnRevision: turn.revision,
    outcomeCode: "completed",
    createdAt: later,
  });
  return { turn: value.actors.readActorTurn(turn.id)!, result };
}

function productionAttemptId(turnId: string, incarnationId: string): string {
  const hash = createHash("sha256").update("oprte.attempt.v2\0", "utf8");
  hash.update(turnId, "utf8").update("\0", "utf8");
  hash.update(incarnationId, "utf8").update("\0", "utf8");
  return `hattempt_${hash.digest("base64url").slice(0, 48)}`;
}

function open(value: Fixture, expectedParentRevision = 1, expectedChildRevision = 1) {
  return value.effects.openChild({
    parentPaneId,
    parentActorId: rootActorId,
    childActorId,
    expectedParentRevision,
    expectedChildRevision,
  });
}

function stop(value: Fixture, expectedParentRevision: number, expectedChildRevision: number) {
  return value.effects.requestAndSettleStop({
    parentPaneId,
    parentActorId: rootActorId,
    childActorId,
    expectedParentRevision,
    expectedChildRevision,
  });
}

async function rejection(value: Promise<unknown>): Promise<unknown> {
  try {
    await value;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the renderer effect to reject.");
}

describe("HarnessRendererEffectsV2", () => {
  test("opens one idle actor atomically and seeds only its latest completed response", async () => {
    const value = fixture();
    try {
      const outcome = await open(value);
      expect(outcome).toMatchObject({
        parentPaneId,
        parentActorId: rootActorId,
        parentRevision: 2,
        childActorId,
        childWitness: { actorId: childActorId, revision: 2 },
        binding: {
          actorId: childActorId,
          paneId: harnessObserverPaneId(childActorId),
          state: "attached",
        },
        pane: {
          id: harnessObserverPaneId(childActorId),
          interactionMode: "harnessObserver",
          state: "ready",
          title: "Research actor",
          turn: {
            status: "completed",
            responseMarkdown: {
              tail: "Completed answer.",
              totalUtf8Bytes: 17,
              truncatedPrefix: false,
            },
          },
        },
      });
      expect(value.responseReads).toEqual([{
        epochId,
        actorId: childActorId,
        turnId: childTurnId,
        valueId: resultValueId,
      }]);
      expect(value.published).toEqual([outcome.pane]);
      expect(value.renderer.readProjectionWitness(childActorId)?.semanticDigest)
        .toBe(harnessChildSemanticDigest({
          id: childActorId,
          title: "Research actor",
          state: "idle",
          openedPaneId: outcome.pane.id,
          canOpen: false,
          canMessage: true,
          canStop: true,
        }));

      expect(await open(value)).toEqual(outcome);
      expect(value.responseReads).toHaveLength(1);
      expect(value.panes.list()).toHaveLength(2);
      expect(value.published).toEqual([outcome.pane, outcome.pane]);
    } finally {
      value.database.close();
    }
  });

  test("uses the recovered live generation for open, event routing, rebind, and running turns", async () => {
    let replayed: PersistentActorTurnView | null = null;
    const value = fixture({
      sessionGeneration: 2,
      send: (request) => Promise.resolve(
        replayed ??= driveFollowup(value, request, "accepted"),
      ),
    });
    try {
      expect(value.actors.readActorSessionBinding(
        "hincarnation_renderereffect1",
      )).toMatchObject({
        admissionGeneration: 1,
        liveGeneration: 2,
        state: "bound",
      });
      const opened = await open(value);
      value.panes.rebindAttachedHarnessSession({
        paneId: opened.pane.id,
        binding: {
          accountProfileId: accountId,
          threadId: "thread_owned_stale_renderer_effects",
          restartThreadId: "provider-thread-stale-renderer-effects",
        },
        now: new Date(later),
      });
      expect(value.effects.routeSessionEvent({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        turnId: "turn_owned_renderer_effects_followup",
      })).toBe(opened.pane.id);
      expect(await value.effects.startTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_recovered_generation1",
        prompt: "Continue through the recovered session.",
        createdAt: later,
      })).toEqual({
        kind: "accepted",
        actorTurnId: followupTurnId,
        providerTurnId: "turn_owned_renderer_effects_followup",
      });
      expect(value.sessionReads).toEqual([
        { kind: "chat", expectedGeneration: 2 },
        { kind: "event", expectedGeneration: 2 },
        { kind: "chat", expectedGeneration: 2 },
        { kind: "chat", expectedGeneration: 2 },
        { kind: "turn", expectedGeneration: 2 },
      ]);
    } finally {
      value.database.close();
    }
  });

  test("replays a committed Open after publication loses its response", async () => {
    let failPublish = true;
    const value = fixture({
      publish: () => {
        if (failPublish) {
          failPublish = false;
          throw new Error("renderer disconnected");
        }
      },
    });
    try {
      expect(await rejection(open(value))).toHaveProperty(
        "message",
        "renderer disconnected",
      );
      expect(value.panes.get(harnessObserverPaneId(childActorId))).not.toBeNull();
      const replay = await open(value);
      expect(replay.childWitness.revision).toBe(2);
      expect(value.responseReads).toHaveLength(1);
      expect(value.published).toEqual([replay.pane]);
    } finally {
      value.database.close();
    }
  });

  test("routes an early replacement-thread event through exact actor and session authority", async () => {
    const value = fixture();
    try {
      const opened = await open(value);
      value.panes.rebindAttachedHarnessSession({
        paneId: opened.pane.id,
        binding: {
          accountProfileId: accountId,
          threadId: "thread_owned_stale_renderer_effects",
          restartThreadId: "provider-thread-stale-renderer-effects",
        },
        now: new Date(later),
      });
      expect(value.effects.routeSessionEvent({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        turnId: "turn_owned_wrong",
      })).toBeNull();
      expect(value.panes.require(opened.pane.id).binding?.threadId)
        .toBe("thread_owned_stale_renderer_effects");

      expect(value.effects.routeSessionEvent({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        turnId: "turn_owned_renderer_effects_followup",
      })).toBe(opened.pane.id);
      expect(value.panes.require(opened.pane.id).binding).toEqual({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        restartThreadId: providerThreadId,
      });
      expect(value.published.at(-1)).toEqual(
        value.panes.require(opened.pane.id).projection,
      );
    } finally {
      value.database.close();
    }
  });

  test("rejects a reverse route whose live generation is outside durable lineage", async () => {
    const value = fixture({
      eventRoute: (request) => ({
        actorId: childActorId,
        admissionGeneration: 1,
        generation: 2,
        providerThreadId,
        threadId: request.threadId,
        turnId: request.turnId,
      }),
    });
    try {
      const opened = await open(value);
      expect(() => value.effects.routeSessionEvent({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        turnId: "turn_owned_renderer_effects_followup",
      })).toThrow(expect.objectContaining({ code: "authority_conflict" }));
      expect(value.panes.require(opened.pane.id).binding?.threadId)
        .toBe("thread_owned_renderer_effects");
    } finally {
      value.database.close();
    }
  });

  test("retains the first routed event when renderer publication disconnects after rebind", async () => {
    let failPublish = false;
    const value = fixture({
      publish: () => {
        if (failPublish) throw new Error("renderer disconnected after rebind");
      },
    });
    try {
      const opened = await open(value);
      value.panes.rebindAttachedHarnessSession({
        paneId: opened.pane.id,
        binding: {
          accountProfileId: accountId,
          threadId: "thread_owned_stale_renderer_effects",
          restartThreadId: "provider-thread-stale-renderer-effects",
        },
        now: new Date(later),
      });
      failPublish = true;
      expect(value.effects.routeSessionEvent({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        turnId: "turn_owned_renderer_effects_followup",
      })).toBe(opened.pane.id);
      expect(value.panes.require(opened.pane.id).binding).toEqual({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        restartThreadId: providerThreadId,
      });
      expect(value.published).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("an unrelated corrupt actor session cannot block an exact reverse-routed event", async () => {
    const otherProviderThreadId = "provider-thread-renderer-effects-other";
    const value = fixture();
    try {
      const opened = await open(value);
      const otherActorId = "hactor_renderer_effectother";
      const other = value.actors.createChildActor(actorSchema.parse({
        ...childActor(value.root),
        id: otherActorId,
        title: "Other actor",
      }));
      let operation = value.actors.prepareActorOperation({
        operationId: "hoperation_rendererstart2",
        actorId: other.id,
        turnId: null,
        kind: "actorStart",
        requestDigest: "8".repeat(64),
        effectKey: "9".repeat(64),
        providerIdentityJson: '{"request":{"fixture":true},"version":1}',
        createdAt: at,
      });
      operation = value.actors.transitionActorOperation({
        operationId: operation.id,
        expectedState: "prepared",
        nextState: "effectStarted",
        now: started,
      });
      value.actors.transitionActorOperation({
        operationId: operation.id,
        expectedState: "effectStarted",
        nextState: "succeeded",
        providerIdentityJson: JSON.stringify({
          providerThreadId: otherProviderThreadId,
        }),
        now: started,
      });
      const incarnation = value.actors.createActorIncarnation({
        incarnationId: "hincarnation_renderereffect2",
        actorId: other.id,
        accountProfileId: accountId,
        processGeneration: 1,
        startOperationId: operation.id,
        clientRequestId: "client-request-renderer-effect-02",
        threadSource: "oprte:renderer:effect:thread:2",
        toolsetDigest: "a".repeat(64),
        createdAt: started,
      });
      value.actors.transitionActorIncarnation({
        incarnationId: incarnation.id,
        expectedState: "starting",
        nextState: "idle",
        providerThreadId: otherProviderThreadId,
        now: started,
      });
      bindSessionFixture(value.database, value.actors, {
        actorId: other.id,
        incarnationId: incarnation.id,
        liveGeneration: 1,
        suffix: "other01",
      });
      const otherPane = value.panes.createAttachedHarnessSession({
        actorId: other.id,
        repository: {
          id: repositoryId,
          name: "Renderer Effects",
          workingDirectory: "/tmp/renderer-effects",
        },
        binding: {
          accountProfileId: accountId,
          threadId: "thread_owned_renderer_effects_other",
          restartThreadId: otherProviderThreadId,
        },
        title: other.title,
        now: new Date(later),
      }).pane;
      value.actors.attachActorPane({
        bindingId: "hpanebinding_effectother1",
        actorId: other.id,
        paneId: otherPane.id,
        attachedAt: later,
      });

      value.database.exec(`
        DROP TRIGGER harness_actor_session_binding_transition_guard;
        PRAGMA ignore_check_constraints = ON;
        UPDATE harness_actor_session_bindings SET live_generation = 0
        WHERE incarnation_id = 'hincarnation_renderereffect2';
      `);
      expect(value.effects.routeSessionEvent({
        accountProfileId: accountId,
        threadId: "thread_owned_renderer_effects",
        turnId: "turn_owned_renderer_effects_followup",
      })).toBe(opened.pane.id);
      expect(value.panes.require(opened.pane.id).binding?.threadId)
        .toBe("thread_owned_renderer_effects");
      expect(value.panes.require(otherPane.id).binding?.threadId)
        .toBe("thread_owned_renderer_effects_other");
      expect(value.sessionReads.filter(({ kind }) => kind === "event"))
        .toEqual([{ kind: "event", expectedGeneration: 1 }]);
    } finally {
      value.database.close();
    }
  });

  test("sends one later pane turn through persistent actor authority and binds its exact session turn", async () => {
    let replayed: PersistentActorTurnView | null = null;
    const value = fixture({
      send: (request) => Promise.resolve(
        replayed ??= driveFollowup(value, request, "accepted"),
      ),
    });
    try {
      const opened = await open(value);
      const outcome = await value.effects.startTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_followup1",
        prompt: "Inspect the retained actor.",
        createdAt: later,
      });
      expect(outcome).toEqual({
        kind: "accepted",
        actorTurnId: followupTurnId,
        providerTurnId: "turn_owned_renderer_effects_followup",
      });
      expect(value.sendCalls).toHaveLength(1);
      expect(value.values.records.size).toBe(1);
      const stored = [...value.values.records.values()][0];
      expect(stored?.input).toMatchObject({
        epochId,
        ownerActorId: rootActorId,
        sourceTurnId: null,
        kind: "text",
        purpose: "currentInput",
        plaintext: "Inspect the retained actor.",
      });
      expect(value.renderer.readProjectionWitness(childActorId)).toMatchObject({
        revision: 3,
        semanticDigest: harnessChildSemanticDigest({
          id: childActorId,
          title: "Research actor",
          state: "running",
          openedPaneId: opened.pane.id,
          canOpen: false,
          canMessage: false,
          canStop: true,
        }),
      });

      expect(await value.effects.startTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_followup1",
        prompt: "Inspect the retained actor.",
        createdAt: later,
      })).toEqual(outcome);
      expect(value.sendCalls).toHaveLength(2);
      expect(value.actors.readActor(childActorId)?.nextTurnOrdinal).toBe(3);
      expect(await rejection(value.effects.startTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_followup1",
        prompt: "Substitute a different replay prompt.",
        createdAt: later,
      }))).toHaveProperty("message", "immutable renderer input conflict");
      expect(value.sendCalls).toHaveLength(2);
      expect(await rejection(value.effects.startTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_different1",
        prompt: "Start a second overlapping turn.",
        createdAt: later,
      }))).toMatchObject({ code: "invalid_state" });
      expect(value.sendCalls).toHaveLength(2);
    } finally {
      value.database.close();
    }
  });

  test("recovers exact provider admission when the coordinator response is lost", async () => {
    const value = fixture({
      send: (request) => {
        driveFollowup(value, request, "accepted");
        return Promise.reject(new Error("lost coordinator response"));
      },
    });
    try {
      const opened = await open(value);
      expect(await value.effects.startTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_lostresponse1",
        prompt: "Recover the admitted provider turn.",
        createdAt: later,
      })).toEqual({
        kind: "accepted",
        actorTurnId: followupTurnId,
        providerTurnId: "turn_owned_renderer_effects_followup",
      });
      expect(value.sendCalls).toHaveLength(1);
      expect(value.panes.require(opened.pane.id)).toMatchObject({
        binding: {
          accountProfileId: accountId,
          threadId: "thread_owned_renderer_effects",
          restartThreadId: providerThreadId,
        },
      });
    } finally {
      value.database.close();
    }
  });

  test("reconciles provider evidence before replaying one exact active pane turn", async () => {
    const value = fixture({
      send: (request) => Promise.resolve(driveFollowup(value, request, "succeeded")),
    });
    try {
      const opened = await open(value);
      const begun = value.panes.beginAttachedHarnessTurn({
        paneId: opened.pane.id,
        expectedRevision: opened.pane.revision,
        turnId: "chatturn_renderer_reconcile1",
        prompt: "Recover only this actor turn.",
        now: new Date(later),
      }).pane;
      const outcome = await value.effects.reconcileTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_reconcile1",
        prompt: "Recover only this actor turn.",
        createdAt: begun.turn!.startedAt,
      });

      expect(value.livenessCalls).toEqual(["ensureCurrent"]);
      expect(value.sendCalls).toHaveLength(1);
      expect(outcome).toEqual({
        kind: "settled",
        actorTurnId: followupTurnId,
        outcome: "succeeded",
        responseMarkdown: "Completed answer.",
      });
    } finally {
      value.database.close();
    }
  });

  test("rejects stale terminal hints before running actor reconciliation", async () => {
    const value = fixture();
    try {
      const opened = await open(value);
      expect(await rejection(value.effects.reconcileTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_stalehint1",
        prompt: "This turn was never admitted.",
        createdAt: later,
      }))).toMatchObject({ code: "invalid_state" });
      expect(value.livenessCalls).toEqual([]);
      expect(value.sendCalls).toEqual([]);
    } finally {
      value.database.close();
    }
  });

  test("returns an already-settled success from the exact encrypted actor result", async () => {
    const value = fixture({
      response: "Recovered actor answer.",
      send: (request) => Promise.resolve(driveFollowup(value, request, "succeeded")),
    });
    try {
      const opened = await open(value);
      const outcome = await value.effects.startTurn({
        paneId: opened.pane.id,
        chatTurnId: "chatturn_renderer_settled1",
        prompt: "Recover the completed turn.",
        createdAt: later,
      });
      expect(outcome).toEqual({
        kind: "settled",
        actorTurnId: followupTurnId,
        outcome: "succeeded",
        responseMarkdown: "Recovered actor answer.",
      });
      expect(value.responseReads.at(-1)).toEqual({
        epochId,
        actorId: childActorId,
        turnId: followupTurnId,
        valueId: followupResultValueId,
      });
      expect(value.renderer.readProjectionWitness(childActorId)?.revision).toBe(2);
      expect(value.sendCalls).toHaveLength(1);
    } finally {
      value.database.close();
    }
  });

  test("keeps the observer empty when the latest encrypted response is unavailable", async () => {
    const unavailable = fixture({ response: null });
    try {
      const opened = await open(unavailable);
      expect(opened.pane.turn).toBeNull();
      expect(unavailable.responseReads).toHaveLength(1);
    } finally {
      unavailable.database.close();
    }

    const noResult = fixture({ withResult: false, response: "must not leak" });
    try {
      expect(await rejection(open(noResult))).toMatchObject({
        code: "invalid_state",
      });
      expect(noResult.panes.get(harnessObserverPaneId(childActorId))).toBeNull();
      expect(noResult.responseReads).toHaveLength(0);
    } finally {
      noResult.database.close();
    }
  });

  test("rejects an oversized or NUL-bearing response before creating a pane", async () => {
    for (const response of ["x".repeat(MIB + 1), "unsafe\0response"]) {
      const value = fixture({ response });
      try {
        expect(await rejection(open(value))).toBeInstanceOf(Error);
        expect(value.panes.get(harnessObserverPaneId(childActorId))).toBeNull();
        expect(value.responseReads).toHaveLength(1);
        expect(value.published).toHaveLength(0);
      } finally {
        value.database.close();
      }
    }
  });

  test("rolls pane and binding back when the semantic witness commit aborts", async () => {
    const value = fixture();
    try {
      value.database.exec(`
        CREATE TRIGGER renderer_effect_witness_abort
        BEFORE UPDATE ON harness_actor_projection_witnesses
        BEGIN
          SELECT RAISE(ABORT, 'witness abort');
        END;
      `);
      expect(await rejection(open(value))).toHaveProperty("message", "witness abort");
      expect(value.panes.get(harnessObserverPaneId(childActorId))).toBeNull();
      expect(value.actors.readPaneBindingForActor(childActorId)).toBeNull();
      expect(value.renderer.readProjectionWitness(childActorId)?.revision).toBe(1);
      expect(value.published).toHaveLength(0);
    } finally {
      value.database.close();
    }
  });

  test("rejects repository drift and non-idle actors before attachment", async () => {
    const drifted = fixture({ repositoryPath: "/tmp/different-repository" });
    try {
      expect(await rejection(open(drifted))).toMatchObject({
        code: "authority_conflict",
      });
      expect(drifted.panes.get(harnessObserverPaneId(childActorId))).toBeNull();
    } finally {
      drifted.database.close();
    }

    const running = fixture({ withResult: false });
    try {
      insertContextValue(running.database, {
        valueId: "ctxval_renderer_runninginput1",
        actorId: childActorId,
        purpose: "currentInput",
        sourceTurnId: null,
        marker: "8",
      });
      let turn = running.actors.createActorTurn({
        turnId: "hturn_renderer_running01",
        epochId,
        actorId: childActorId,
        idempotencyKey: "idempotency-renderer-running-01",
        inputValueId: "ctxval_renderer_runninginput1",
        createdAt: at,
      });
      turn = running.actors.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "starting",
        now: started,
      });
      running.actors.transitionActorTurn({
        turnId: turn.id,
        expectedRevision: turn.revision,
        nextState: "running",
        now: started,
      });
      running.renderer.writeProjectionWitness({
        actorId: childActorId,
        expectedRevision: 1,
        projection: {
          id: childActorId,
          title: "Research actor",
          state: "running",
          openedPaneId: null,
          canOpen: false,
          canMessage: false,
          canStop: true,
        },
      });
      expect(await rejection(open(running, 2, 2))).toMatchObject({
        code: "invalid_state",
      });
      expect(running.panes.get(harnessObserverPaneId(childActorId))).toBeNull();
    } finally {
      running.database.close();
    }
  });

  test("stops outside-provider effects then atomically settles while retaining the observer", async () => {
    const value = fixture();
    try {
      const opened = await open(value);
      const stopped = await stop(value, 2, 2);
      expect(stopped).toMatchObject({
        parentRevision: 3,
        child: { id: childActorId, state: "stopped" },
        childWitness: { actorId: childActorId, revision: 3 },
      });
      expect(value.panes.require(opened.pane.id).projection).toEqual(opened.pane);
      expect(value.actors.readPaneBindingForActor(childActorId)).toMatchObject({
        paneId: opened.pane.id,
        state: "attached",
      });
      expect(value.stopCalls).toEqual([childActorId]);
      expect(await stop(value, 2, 2)).toEqual(stopped);
      expect(value.stopCalls).toEqual([childActorId]);
    } finally {
      value.database.close();
    }
  });

  test("keeps quiesced stop intent durable when settlement rolls back, then retries", async () => {
    const value = fixture();
    try {
      value.database.exec(`
        CREATE TRIGGER renderer_stop_witness_abort
        BEFORE UPDATE ON harness_actor_projection_witnesses
        BEGIN
          SELECT RAISE(ABORT, 'stop witness abort');
        END;
      `);
      expect(await rejection(stop(value, 1, 1))).toHaveProperty(
        "message",
        "stop witness abort",
      );
      expect(value.actors.readActor(childActorId)?.state).toBe("stopRequested");
      expect(value.actors.readActiveIncarnationForActor(childActorId)).toBeNull();
      expect(value.renderer.readProjectionWitness(childActorId)?.revision).toBe(1);
      value.database.exec("DROP TRIGGER renderer_stop_witness_abort");
      const stopped = await stop(value, 1, 1);
      expect(stopped.child.state).toBe("stopped");
      expect(stopped.childWitness.revision).toBe(2);
      expect(value.stopCalls).toEqual([childActorId, childActorId]);
    } finally {
      value.database.close();
    }
  });

  test("rejects stop while a live descendant exists without changing its witness", async () => {
    const value = fixture();
    try {
      const child = value.actors.readActor(childActorId)!;
      value.actors.createChildActor(actorSchema.parse({
        ...child,
        id: "hactor_renderer_grandchild1",
        parentActorId: child.id,
        depth: 2,
        title: "Grandchild",
        tokenReserved: 0,
        byteReserved: 0,
        nextTurnOrdinal: 1,
        nextResultOrdinal: 1,
        revision: 1,
        createdAt: later,
        updatedAt: later,
      }));
      expect(await rejection(stop(value, 1, 1))).toMatchObject({
        code: "invalid_state",
      });
      expect(value.actors.readActor(childActorId)?.state).toBe("active");
      expect(value.renderer.readProjectionWitness(childActorId)?.revision).toBe(1);
    } finally {
      value.database.close();
    }
  });
});
