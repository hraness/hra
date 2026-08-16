import { expect, test } from "bun:test";
import { assertAsyncProperty, assertProperty, fc } from "@hra-internal/test";
import {
  createRunInteractionReplyKeyPair,
  createRunInteractionRequestDigest,
  interactionRequestPayload,
  runInteractionRequestSchema,
  type RunInteractionRequestPayload,
} from "@hraness/agent-tasks-protocol";

import {
  HRAInteractionGateway,
  WorkspaceAuthorityRouter,
  sealHRAInteraction,
} from "../src/cloud";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const OTHER_LOCATOR = "1123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = `wsp_${LOCATOR}`;
const OTHER_WORKSPACE_ID = `wsp_${OTHER_LOCATOR}`;
const OPERATION_ID = `op_${LOCATOR}`;

test("authority routing chooses exactly one stable adapter and every transition fails closed", () => {
  assertProperty(fc.property(
    fc.constantFrom(
      "snapshot_frozen",
      "staging",
      "uploading",
      "activating",
      "outcome_unknown",
    ),
    fc.constantFrom(
      "activation_outcome_unknown",
      "read_only_local_copy",
      "repair_required",
    ),
    (phase, recoveryState) => {
      const router = new WorkspaceAuthorityRouter({
        local: { kind: "local-adapter" },
        cloud: { kind: "cloud-adapter" },
      });
      expect(router.route(WORKSPACE_ID, {
        kind: "local",
        localWorkspaceId: WORKSPACE_ID,
        ownerInstallationId: "install_property_router",
      })).toMatchObject({ ok: true, kind: "local" });
      expect(router.route(WORKSPACE_ID, {
        kind: "cloud",
        cloudWorkspaceId: WORKSPACE_ID,
      })).toMatchObject({ ok: true, kind: "cloud" });
      expect(router.route(WORKSPACE_ID, {
        kind: "promoting",
        localWorkspaceId: WORKSPACE_ID,
        promotionId: `promotion_${LOCATOR}`,
        phase,
      })).toMatchObject({ ok: false });
      expect(router.route(WORKSPACE_ID, {
        kind: "recovery",
        localWorkspaceId: WORKSPACE_ID,
        state: recoveryState,
      })).toMatchObject({ ok: false });
      expect(router.route(WORKSPACE_ID, {
        kind: "cloud",
        cloudWorkspaceId: OTHER_WORKSPACE_ID,
      })).toEqual({ ok: false, reason: "authority_mismatch" });
    },
  ));
});

test("sealed interaction requests contain no answer plaintext for arbitrary decisions", async () => {
  await assertAsyncProperty(fc.asyncProperty(
    fc.constantFrom("approve_once", "decline"),
    async (decision) => {
      const keyPair = await createRunInteractionReplyKeyPair();
      const payload: RunInteractionRequestPayload = {
        id: "interaction_cloud001",
        kind: "file_change_approval",
        scope: "once",
        createdAt: 1_000,
        expiresAt: 61_000,
      };
      const request = runInteractionRequestSchema.parse({
        ...payload,
        reply: {
          version: 1,
          algorithm: "P256-HKDF-SHA256-A256GCM",
          keyId: keyPair.keyId,
          publicKey: keyPair.publicKey,
          runnerId: "runner_cloud0001",
          bootId: "boot_cloud000001",
          bootGeneration: 3,
          claimId: "claim_cloud00001",
          claimFence: 7,
          requestDigest: await createRunInteractionRequestDigest(payload),
        },
      });
      const sealed = await sealHRAInteraction({
        operationId: OPERATION_ID,
        workspaceId: WORKSPACE_ID,
        runId: "run_cloud000001",
        expectedWorkspaceRevision: 4,
        expectedProjectionHead: 9,
        request,
        response: {
          kind: "file_change_approval",
          decision,
        },
        now: 2_000,
      });
      const source = JSON.stringify(sealed);
      expect(source).not.toContain(decision);
      expect(source).not.toContain("\"decision\"");
      expect(source).not.toContain("\"response\"");
      expect(sealed.request.requestDigest).toBe(request.reply.requestDigest);
      expect(sealed.route.interactionId).toBe(request.id);
    },
  ), { numRuns: 40 });
});

test("the gateway derives a digest from the portable request before fetching sealing authority", async () => {
  const keyPair = await createRunInteractionReplyKeyPair();
  const payload: RunInteractionRequestPayload = {
    id: "interaction_cloud001",
    kind: "file_change_approval",
    scope: "once",
    createdAt: 1_000,
    expiresAt: 61_000,
  };
  const requestDigest = await createRunInteractionRequestDigest(payload);
  const request = runInteractionRequestSchema.parse({
    ...payload,
    reply: {
      version: 1,
      algorithm: "P256-HKDF-SHA256-A256GCM",
      keyId: keyPair.keyId,
      publicKey: keyPair.publicKey,
      runnerId: "runner_cloud0001",
      bootId: "boot_cloud000001",
      bootGeneration: 3,
      claimId: "claim_cloud00001",
      claimFence: 7,
      requestDigest,
    },
  });
  const calls: unknown[] = [];
  const gateway = new HRAInteractionGateway({
    now: () => 2_000,
    client: {
      getInteractionReplyAuthority: (route, query) => {
        calls.push({ kind: "authority", route, query });
        return Promise.resolve({
          ok: true,
          data: {
            workspaceId: WORKSPACE_ID,
            runId: "run_cloud000001",
            interactionId: request.id,
            requestDigest,
            projectionHead: 9,
            request,
          },
        });
      },
      respondInteraction: (route, sealed, idempotencyKey) => {
        calls.push({ kind: "response", route, sealed, idempotencyKey });
        return Promise.resolve({
          ok: true,
          data: {
            operationId: OPERATION_ID,
            workspaceId: WORKSPACE_ID,
            commandKind: "interaction.respond",
            workspaceRevision: 10,
            projectionRevision: 10,
            result: {
              kind: "interaction_updated",
              runId: "run_cloud000001",
              interactionId: request.id,
              state: "answered",
            },
          },
        });
      },
    },
  });

  expect(await gateway.respond({
    operationId: OPERATION_ID,
    workspaceId: WORKSPACE_ID,
    runId: "run_cloud000001",
    expectedWorkspaceRevision: 9,
    expectedProjectionHead: 9,
    request: interactionRequestPayload(request),
    response: {
      kind: "file_change_approval",
      decision: "approve_once",
    },
    idempotencyKey: "018f22c0-6b3c-7a91-8abc-123456789abc", // gitleaks:allow - deterministic test vector
  })).toMatchObject({ ok: true });
  expect(calls[0]).toEqual({
    kind: "authority",
    route: {
      workspaceId: WORKSPACE_ID,
      runId: "run_cloud000001",
      interactionId: request.id,
    },
    query: { requestDigest, projectionHead: 9 },
  });
  const source = JSON.stringify(calls);
  expect(source).not.toContain("\"decision\"");
  expect(source).not.toContain("approve_once");
});
