import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type {
  RunInteractionRequestPayload,
  SyncRunInteractionsRequest,
} from "@hraness/agent-tasks-protocol";
import {
  createRunInteractionReplyKeyPair,
  sealRunInteractionResponse,
} from "@hraness/agent-tasks-protocol";

import { DispatchActivityAdapter } from "../src/dispatch/activity-adapter";
import { DispatchInteractionAdapter } from "../src/dispatch/interaction-adapter";
import { applyMigrations } from "../src/state/database";
import { DispatchInteractionStore } from "../src/state/dispatch-interaction-store";
import { DispatchStore } from "../src/state/dispatch-store";

const identity = {
  runnerId: "runner_interaction01",
  bootId: "boot_interaction0001",
  bootGeneration: 1,
} as const;
const run = {
  runId: "run_interaction0001",
  taskId: "task_interaction001",
  taskKey: "OPS-7K2M4Q9",
  claimId: "claim_interaction01",
  claimFence: 7,
  inputReviewRevision: 3,
  runtimePublicId: identity.runnerId,
  runtimeBootId: identity.bootId,
  repositoryPublicId: "repo_interaction0001",
} as const;
const owner = {
  accountProfileId: "acct_interaction0001",
  threadId: "thread_interaction001",
  turnId: "turn_interaction00001",
} as const;
const request: RunInteractionRequestPayload = {
  id: "interaction_adapter001",
  kind: "user_input",
  createdAt: 100,
  expiresAt: 200,
  questions: [{
    id: "question_adapter0001",
    header: "Direction",
    prompt: "Which direction should continue?",
    allowOther: false,
    options: [{ id: "option_adapter00001", label: "Focused" }],
  }],
};

function prepared(): { database: Database; dispatch: DispatchStore } {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const at = "2026-07-20T12:00:00.000Z";
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation, created_at, updated_at
    ) VALUES (?1, 'Fixture', 'signedIn', 1, ?2, ?2)
  `).run(owner.accountProfileId, at);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES ('project_interaction', '/fixture/repo', '/fixture/repo/.git', 'Fixture', ?1, ?1)
  `).run(at);
  const dispatch = new DispatchStore(database);
  dispatch.bindRepository({
    repositoryPublicId: run.repositoryPublicId,
    projectId: "project_interaction",
    canonicalRepositoryPath: "/fixture/repo",
    canonicalGitCommonDir: "/fixture/repo/.git",
  });
  dispatch.reserve(run);
  dispatch.transition({
    runId: run.runId,
    to: "worktree_ready",
    accountProfileId: owner.accountProfileId,
  });
  dispatch.transition({ runId: run.runId, to: "thread_starting" });
  dispatch.transition({ runId: run.runId, to: "thread_ready", threadId: owner.threadId });
  dispatch.transition({ runId: run.runId, to: "turn_starting" });
  dispatch.transition({ runId: run.runId, to: "running", turnId: owner.turnId });
  dispatch.appendPublicEvent({ runId: run.runId, eventId: "event_running0001", kind: "codex.running" });
  return { database, dispatch };
}

describe("dispatch interaction adapter", () => {
  test("keeps answers in memory until provider apply and cloud settlement acknowledgement", async () => {
    const { database, dispatch } = prepared();
    try {
      const fence = { assertCurrent: () => Promise.resolve(true) };
      const activity = new DispatchActivityAdapter({ fence, store: dispatch });
      await activity.observe({ ...owner, kind: "waiting_for_input" });
      const durable = new DispatchInteractionStore(database);
      const requests: SyncRunInteractionsRequest[] = [];
      const providerResponses: unknown[] = [];
      const replyKey = await createRunInteractionReplyKeyPair();
      let call = 0;
      const adapter = new DispatchInteractionAdapter({
        activity,
        bindings: dispatch,
        fence,
        identity,
        interactions: durable,
        replyKey,
        sessions: {
          resolveInteraction: (_interactionId, response) => {
            providerResponses.push(response);
            return Promise.resolve({ kind: "applied" as const });
          },
          expireInteraction: () => Promise.resolve(false),
        },
        cloud: {
          syncInteractions: async (_runId, body) => {
            requests.push(body);
            call += 1;
            const upsert = body.upserts[0];
            return call === 1 && upsert !== undefined
              ? {
                  ok: true,
                  requestId: "req_interaction00001",
                  data: {
                    serverTime: 150,
                    acceptedInteractionIds: [request.id],
                    acceptedSettlementIds: [],
                    responses: [{
                      interactionId: request.id,
                      responseRevision: 1,
                      sealedResponse: await sealRunInteractionResponse(
                        upsert,
                        { workspaceId: "workspace_adapter001", runId: run.runId },
                        {
                        kind: "user_input",
                        answers: [{
                          questionId: "question_adapter0001",
                          selectedOptionIds: ["option_adapter00001"],
                        }],
                        },
                      ),
                    }],
                    expiredInteractions: [],
                    hasMoreResponses: false,
                  },
                }
              : {
                  ok: true,
                  requestId: "req_interaction00002",
                  data: {
                    serverTime: 151,
                    acceptedInteractionIds: [],
                    acceptedSettlementIds: [request.id],
                    responses: [],
                    expiredInteractions: [],
                    hasMoreResponses: false,
                  },
                };
          },
        },
      });

      const boundRequest = await adapter.observeRequest({ ...owner, request });
      expect(boundRequest).not.toBeNull();
      if (boundRequest === null) throw new Error("Expected a bound interaction request");
      expect(await adapter.syncOnce([run.runId])).toBe("ok");
      expect(providerResponses).toHaveLength(1);
      expect(requests[0]?.upserts).toEqual([boundRequest]);
      expect(durable.syncBatch(run.runId).settlements).toEqual([{
        interactionId: request.id,
        responseRevision: 1,
        outcome: "applied",
      }]);
      expect(dispatch.read(run.runId)?.stage).toBe("running");
      expect(dispatch.latestPublicEvent(run.runId)?.kind).toBe("codex.running");

      expect(await adapter.syncOnce([run.runId])).toBe("ok");
      expect(requests[1]?.settlements).toEqual([{
        interactionId: request.id,
        responseRevision: 1,
        outcome: "applied",
      }]);
      expect(requests[1]?.upserts).toEqual([]);
      expect(durable.pendingRunIds()).toEqual([]);
      const persisted = JSON.stringify(database.query("SELECT * FROM dispatch_interactions").all());
      expect(persisted).not.toContain("selectedOptionIds");
      expect(persisted).not.toContain("answer");
    } finally {
      database.close();
    }
  });

  test("refuses to publish or retain an interaction without a current claim fence", async () => {
    const { database, dispatch } = prepared();
    try {
      const activity = new DispatchActivityAdapter({
        fence: { assertCurrent: () => Promise.resolve(true) },
        store: dispatch,
      });
      await activity.observe({ ...owner, kind: "waiting_for_input" });
      const durable = new DispatchInteractionStore(database);
      const replyKey = await createRunInteractionReplyKeyPair();
      const adapter = new DispatchInteractionAdapter({
        activity,
        bindings: dispatch,
        cloud: { syncInteractions: () => Promise.reject(new Error("not reached")) },
        fence: { assertCurrent: () => Promise.resolve(false) },
        identity,
        interactions: durable,
        replyKey,
        sessions: {
          resolveInteraction: () => Promise.resolve({ kind: "rejected" }),
          expireInteraction: () => Promise.resolve(false),
        },
      });
      expect(await adapter.observeRequest({ ...owner, request })).toBeNull();
      expect(durable.pendingRunIds()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("publishes the bounded request before acknowledging an expiry that happened offline", async () => {
    const { database, dispatch } = prepared();
    try {
      const fence = { assertCurrent: () => Promise.resolve(true) };
      const activity = new DispatchActivityAdapter({ fence, store: dispatch });
      await activity.observe({ ...owner, kind: "waiting_for_input" });
      const durable = new DispatchInteractionStore(database);
      const requests: SyncRunInteractionsRequest[] = [];
      const replyKey = await createRunInteractionReplyKeyPair();
      const adapter = new DispatchInteractionAdapter({
        activity,
        bindings: dispatch,
        fence,
        identity,
        interactions: durable,
        replyKey,
        sessions: {
          resolveInteraction: () => Promise.resolve({ kind: "rejected" }),
          expireInteraction: () => Promise.resolve(false),
        },
        cloud: {
          syncInteractions: (_runId, body) => {
            requests.push(body);
            const first = requests.length === 1;
            return Promise.resolve({
              ok: true,
              requestId: "req_interaction_expired1",
              data: {
                serverTime: 250,
                acceptedInteractionIds: first ? [request.id] : [],
                acceptedSettlementIds: first ? [] : [request.id],
                responses: [],
                expiredInteractions: [],
                hasMoreResponses: false,
              },
            });
          },
        },
      });

      const boundRequest = await adapter.observeRequest({ ...owner, request });
      expect(boundRequest).not.toBeNull();
      if (boundRequest === null) throw new Error("Expected a bound interaction request");
      adapter.observeExpired({ interactionId: request.id, reason: "provider_expired" });
      expect(await adapter.syncOnce([run.runId])).toBe("ok");
      expect(await adapter.syncOnce([run.runId])).toBe("ok");
      expect(requests).toEqual([{
        ...identity,
        claimId: run.claimId,
        claimFence: run.claimFence,
        upserts: [boundRequest],
        settlements: [],
      }, {
        ...identity,
        claimId: run.claimId,
        claimFence: run.claimFence,
        upserts: [],
        settlements: [{
          interactionId: request.id,
          outcome: "expired",
          reason: "provider_expired",
        }],
      }]);
      expect(durable.pendingRunIds()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("retains the durable answer and terminates when provider application is unproved", async () => {
    for (const reason of ["local_deadline", "provider_expired"] as const) {
      const { database, dispatch } = prepared();
      try {
        const fence = { assertCurrent: () => Promise.resolve(true) };
        const activity = new DispatchActivityAdapter({ fence, store: dispatch });
        await activity.observe({ ...owner, kind: "waiting_for_input" });
        const durable = new DispatchInteractionStore(database);
        const replyKey = await createRunInteractionReplyKeyPair();
        const adapter = new DispatchInteractionAdapter({
          activity,
          bindings: dispatch,
          fence,
          identity,
          interactions: durable,
          replyKey,
          sessions: {
            resolveInteraction: () => Promise.resolve({ kind: "expired", reason }),
            expireInteraction: () => Promise.resolve(false),
          },
          cloud: {
            syncInteractions: async (_runId, body) => {
              const upsert = body.upserts[0];
              if (upsert === undefined) throw new Error("Expected first interaction publication");
              return {
                ok: true,
                requestId: `req_${reason}0001`,
                data: {
                  serverTime: 150,
                  acceptedInteractionIds: [upsert.id],
                  acceptedSettlementIds: [],
                  responses: [{
                    interactionId: upsert.id,
                    responseRevision: 5,
                    sealedResponse: await sealRunInteractionResponse(
                      upsert,
                      { workspaceId: "workspace_adapter001", runId: run.runId },
                      {
                        kind: "user_input",
                        answers: [{
                          questionId: "question_adapter0001",
                          selectedOptionIds: ["option_adapter00001"],
                        }],
                      },
                    ),
                  }],
                  expiredInteractions: [],
                  hasMoreResponses: false,
                },
              };
            },
          },
        });
        expect(await adapter.observeRequest({ ...owner, request })).not.toBeNull();
        expect(await adapter.syncOnce([run.runId])).toEqual({
          kind: "run_terminal",
          runId: run.runId,
          reason: "interaction_resolution_ambiguous",
        });
        expect(durable.pending(request.id)).not.toBeNull();
        expect(durable.syncBatch(run.runId).settlements).toEqual([]);
        expect(dispatch.read(run.runId)?.stage).toBe("waiting");
      } finally {
        database.close();
      }
    }
  });

  test("drains more than one bounded page of cloud expiries monotonically", async () => {
    const { database, dispatch } = prepared();
    try {
      const fence = { assertCurrent: () => Promise.resolve(true) };
      const activity = new DispatchActivityAdapter({ fence, store: dispatch });
      await activity.observe({ ...owner, kind: "waiting_for_input" });
      const durable = new DispatchInteractionStore(database);
      const replyKey = await createRunInteractionReplyKeyPair();
      const expiredLocally: string[] = [];
      let call = 0;
      const boundIds: string[] = [];
      const adapter = new DispatchInteractionAdapter({
        activity,
        bindings: dispatch,
        fence,
        identity,
        interactions: durable,
        replyKey,
        sessions: {
          resolveInteraction: () => Promise.resolve({ kind: "rejected" }),
          expireInteraction: async (interactionId, _reason, authority) => {
            await activity.observe({ ...owner, kind: "waiting_for_input" });
            expect(await authority?.()).toBe(true);
            expiredLocally.push(interactionId);
            await activity.observe({ ...owner, kind: "running" });
            return true;
          },
        },
        cloud: {
          syncInteractions: (_runId, body) => {
            call += 1;
            const expiredInteractions = call === 2
              ? boundIds.slice(0, 8).map((interactionId) => ({ interactionId }))
              : call === 3
                ? boundIds.slice(8).map((interactionId) => ({ interactionId }))
                : [];
            return Promise.resolve({
              ok: true,
              requestId: `req_expiry_page${call.toString().padStart(4, "0")}`,
              data: {
                serverTime: 150 + call,
                acceptedInteractionIds: body.upserts.map(({ id }) => id),
                acceptedSettlementIds: body.settlements.map(({ interactionId }) => interactionId),
                responses: [],
                expiredInteractions,
                hasMoreResponses: false,
              },
            });
          },
        },
      });
      for (let index = 0; index < 9; index += 1) {
        const bound = await adapter.observeRequest({
          ...owner,
          request: {
            ...request,
            id: `interaction_page${index.toString().padStart(4, "0")}`,
          },
        });
        if (bound === null) throw new Error("Expected a bound paged interaction");
        boundIds.push(bound.id);
      }

      for (let index = 0; index < 4; index += 1) {
        expect(await adapter.syncOnce([run.runId])).toBe("ok");
      }
      expect(expiredLocally).toEqual(boundIds);
      expect(durable.pendingRunIds()).toEqual([]);
      expect(call).toBe(4);
    } finally {
      database.close();
    }
  });

  test("terminates cloud expiry when provider cleanup cannot prove turn resumption", async () => {
    for (const cleanup of ["missing", "failed", "stuck"] as const) {
      const { database, dispatch } = prepared();
      try {
        const fence = { assertCurrent: () => Promise.resolve(true) };
        const activity = new DispatchActivityAdapter({ fence, store: dispatch });
        await activity.observe({ ...owner, kind: "waiting_for_input" });
        const replyKey = await createRunInteractionReplyKeyPair();
        const beforeRestart = new DispatchInteractionStore(database);
        const publisher = new DispatchInteractionAdapter({
          activity,
          bindings: dispatch,
          fence,
          identity,
          interactions: beforeRestart,
          replyKey,
          sessions: {
            resolveInteraction: () => Promise.resolve({ kind: "rejected" }),
            expireInteraction: () => Promise.resolve(false),
          },
          cloud: { syncInteractions: () => Promise.reject(new Error("not reached")) },
        });
        const bound = await publisher.observeRequest({ ...owner, request });
        if (bound === null) throw new Error("Expected a bound interaction before restart");

        const afterRestart = new DispatchInteractionStore(database);
        const syncRequests: SyncRunInteractionsRequest[] = [];
        let cleanupAttempts = 0;
        const restarted = new DispatchInteractionAdapter({
          activity,
          bindings: dispatch,
          fence,
          identity,
          interactions: afterRestart,
          replyKey,
          sessions: {
            resolveInteraction: () => Promise.resolve({ kind: "rejected" }),
            expireInteraction: () => {
              cleanupAttempts += 1;
              return cleanup === "missing"
                ? Promise.resolve(false)
                : cleanup === "failed"
                  ? Promise.reject(new Error("provider mapping unavailable"))
                  : Promise.resolve(true);
            },
          },
          cloud: {
            syncInteractions: (_runId, body) => {
              syncRequests.push(body);
              return Promise.resolve({
                ok: true,
                requestId: `req_restart_expiry_${cleanup}`,
                data: {
                  serverTime: 250,
                  acceptedInteractionIds: body.upserts.map(({ id }) => id),
                  acceptedSettlementIds: body.settlements.map(({ interactionId }) => interactionId),
                  responses: [],
                  expiredInteractions: [{ interactionId: request.id, responseRevision: 4 }],
                  hasMoreResponses: false,
                },
              });
            },
          },
        });

        expect(await restarted.syncOnce([run.runId])).toEqual({
          kind: "run_terminal",
          runId: run.runId,
          reason: "interaction_resolution_ambiguous",
        });
        expect(cleanupAttempts).toBe(1);
        expect(syncRequests).toHaveLength(1);
        expect(afterRestart.pending(request.id)).not.toBeNull();
        expect(afterRestart.syncBatch(run.runId).settlements).toEqual([]);
        expect(dispatch.read(run.runId)?.stage).toBe("waiting");
      } finally {
        database.close();
      }
    }
  });

  test("settles cloud expiry when provider cleanup resumes the same exact turn", async () => {
    const { database, dispatch } = prepared();
    try {
      const fence = { assertCurrent: () => Promise.resolve(true) };
      const activity = new DispatchActivityAdapter({ fence, store: dispatch });
      await activity.observe({ ...owner, kind: "waiting_for_input" });
      const durable = new DispatchInteractionStore(database);
      const replyKey = await createRunInteractionReplyKeyPair();
      const syncRequests: SyncRunInteractionsRequest[] = [];
      let authorityChecks = 0;
      const adapter = new DispatchInteractionAdapter({
        activity,
        bindings: dispatch,
        fence,
        identity,
        interactions: durable,
        replyKey,
        sessions: {
          resolveInteraction: () => Promise.resolve({ kind: "rejected" }),
          expireInteraction: async (_interactionId, _reason, authority) => {
            authorityChecks += 1;
            expect(await authority?.()).toBe(true);
            await activity.observe({ ...owner, kind: "running" });
            return true;
          },
        },
        cloud: {
          syncInteractions: (_runId, body) => {
            syncRequests.push(body);
            const first = syncRequests.length === 1;
            return Promise.resolve({
              ok: true,
              requestId: `req_expiry_resume${syncRequests.length}`,
              data: {
                serverTime: 250 + syncRequests.length,
                acceptedInteractionIds: first ? [request.id] : [],
                acceptedSettlementIds: first ? [] : [request.id],
                responses: [],
                expiredInteractions: first
                  ? [{ interactionId: request.id, responseRevision: 6 }]
                  : [],
                hasMoreResponses: false,
              },
            });
          },
        },
      });

      expect(await adapter.observeRequest({ ...owner, request })).not.toBeNull();
      expect(await adapter.syncOnce([run.runId])).toBe("ok");
      expect(dispatch.read(run.runId)?.stage).toBe("running");
      expect(durable.syncBatch(run.runId).settlements).toEqual([{
        interactionId: request.id,
        outcome: "expired",
        responseRevision: 6,
        reason: "cloud_expired",
      }]);

      expect(await adapter.syncOnce([run.runId])).toBe("ok");
      expect(authorityChecks).toBe(1);
      expect(syncRequests[1]?.settlements).toEqual([{
        interactionId: request.id,
        outcome: "expired",
        responseRevision: 6,
        reason: "cloud_expired",
      }]);
      expect(durable.pendingRunIds()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("defers a cloud answer when provider expiry wins during the sync request", async () => {
    for (const reason of ["provider_expired", "local_deadline"] as const) {
      const { database, dispatch } = prepared();
      try {
        const fence = { assertCurrent: () => Promise.resolve(true) };
        const activity = new DispatchActivityAdapter({ fence, store: dispatch });
        await activity.observe({ ...owner, kind: "waiting_for_input" });
        const durable = new DispatchInteractionStore(database);
        const replyKey = await createRunInteractionReplyKeyPair();
        let releaseGate: () => void = () => { throw new Error("Sync gate was not initialized"); };
        const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
        let enteredCloud = false;
        let providerApplyCount = 0;
        const adapter = new DispatchInteractionAdapter({
          activity,
          bindings: dispatch,
          fence,
          identity,
          interactions: durable,
          replyKey,
          sessions: {
            resolveInteraction: () => {
              providerApplyCount += 1;
              return Promise.resolve({ kind: "applied" });
            },
            expireInteraction: () => Promise.resolve(false),
          },
          cloud: {
            syncInteractions: async (_runId, body) => {
              enteredCloud = true;
              await gate;
              const upsert = body.upserts[0];
              if (upsert === undefined) throw new Error("Expected in-flight upsert");
              return {
                ok: true,
                requestId: `req_crossing_${reason}`,
                data: {
                  serverTime: 150,
                  acceptedInteractionIds: [upsert.id],
                  acceptedSettlementIds: [],
                  responses: [{
                    interactionId: upsert.id,
                    responseRevision: 1,
                    sealedResponse: await sealRunInteractionResponse(
                      upsert,
                      { workspaceId: "workspace_adapter001", runId: run.runId },
                      {
                        kind: "user_input",
                        answers: [{
                          questionId: "question_adapter0001",
                          selectedOptionIds: ["option_adapter00001"],
                        }],
                      },
                    ),
                  }],
                  expiredInteractions: [],
                  hasMoreResponses: false,
                },
              };
            },
          },
        });
        expect(await adapter.observeRequest({ ...owner, request })).not.toBeNull();
        const syncing = adapter.syncOnce([run.runId]);
        while (!enteredCloud) await Bun.sleep(0);
        adapter.observeExpired({ interactionId: request.id, reason });
        releaseGate();
        expect(await syncing).toBe("ok");
        expect(providerApplyCount).toBe(0);
        expect(durable.syncBatch(run.runId).settlements).toEqual([{
          interactionId: request.id,
          outcome: "expired",
          reason,
        }]);
      } finally {
        database.close();
      }
    }
  });

  test("surfaces the lifetime limit as a terminal result for only the selected run", async () => {
    const { database, dispatch } = prepared();
    try {
      const fence = { assertCurrent: () => Promise.resolve(true) };
      const activity = new DispatchActivityAdapter({ fence, store: dispatch });
      await activity.observe({ ...owner, kind: "waiting_for_input" });
      const replyKey = await createRunInteractionReplyKeyPair();
      const adapter = new DispatchInteractionAdapter({
        activity,
        bindings: dispatch,
        fence,
        identity,
        interactions: new DispatchInteractionStore(database),
        replyKey,
        sessions: {
          resolveInteraction: () => Promise.resolve({ kind: "rejected" }),
          expireInteraction: () => Promise.resolve(false),
        },
        cloud: {
          syncInteractions: () => Promise.resolve({
            ok: false,
            error: {
              kind: "remote",
              code: "RUN_INTERACTION_LIMIT",
              requestId: "req_interaction_limit01",
            },
          }),
        },
      });
      expect(await adapter.observeRequest({ ...owner, request })).not.toBeNull();
      expect(await adapter.syncOnce([run.runId])).toEqual({
        kind: "run_terminal",
        runId: run.runId,
        reason: "interaction_limit",
      });
    } finally {
      database.close();
    }
  });

  test("isolates an authenticated-shape but undecryptable answer to its run", async () => {
    const { database, dispatch } = prepared();
    try {
      const fence = { assertCurrent: () => Promise.resolve(true) };
      const activity = new DispatchActivityAdapter({ fence, store: dispatch });
      await activity.observe({ ...owner, kind: "waiting_for_input" });
      const replyKey = await createRunInteractionReplyKeyPair();
      let providerApplyCount = 0;
      const adapter = new DispatchInteractionAdapter({
        activity,
        bindings: dispatch,
        fence,
        identity,
        interactions: new DispatchInteractionStore(database),
        replyKey,
        sessions: {
          resolveInteraction: () => {
            providerApplyCount += 1;
            return Promise.resolve({ kind: "applied" });
          },
          expireInteraction: () => Promise.resolve(false),
        },
        cloud: {
          syncInteractions: async (_runId, body) => {
            const upsert = body.upserts[0];
            if (upsert === undefined) throw new Error("Expected interaction upsert");
            const sealed = await sealRunInteractionResponse(
              upsert,
              { workspaceId: "workspace_adapter001", runId: run.runId },
              {
                kind: "user_input",
                answers: [{
                  questionId: "question_adapter0001",
                  selectedOptionIds: ["option_adapter00001"],
                }],
              },
            );
            const first = sealed.ciphertext[0];
            return {
              ok: true,
              requestId: "req_poisoned_answer01",
              data: {
                serverTime: 150,
                acceptedInteractionIds: [upsert.id],
                acceptedSettlementIds: [],
                responses: [{
                  interactionId: upsert.id,
                  responseRevision: 1,
                  sealedResponse: {
                    ...sealed,
                    // Mutate a significant base64url sextet. Changing the final
                    // character can alter only unused padding bits and is flaky.
                    ciphertext: `${first === "A" ? "B" : "A"}${sealed.ciphertext.slice(1)}`,
                  },
                }],
                expiredInteractions: [],
                hasMoreResponses: false,
              },
            };
          },
        },
      });
      expect(await adapter.observeRequest({ ...owner, request })).not.toBeNull();
      expect(await adapter.syncOnce([run.runId])).toEqual({
        kind: "run_terminal",
        runId: run.runId,
        reason: "invalid_interaction_response",
      });
      expect(providerApplyCount).toBe(0);
    } finally {
      database.close();
    }
  });
});
