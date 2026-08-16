import { describe, expect, test } from "bun:test";

import {
  MAX_RUN_INTERACTION_VIEWS,
  RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS,
  hraDispatchRoutes,
  runInteractionRequestSchema,
  runInteractionResponseSchema,
  runInteractionViewSchema,
  syncRunInteractionsRequestSchema,
  syncRunInteractionsResponseSchema,
  taskRunViewSchema,
  validateRunInteractionResponse,
  type RunInteractionRequest,
  type RunInteractionResponse,
} from "./index";

const reply = {
  version: 1 as const,
  algorithm: "P256-HKDF-SHA256-A256GCM" as const,
  keyId: `hitlkey_${"a".repeat(32)}`,
  publicKey: "B".repeat(87),
  runnerId: "runner_primary0001",
  bootId: "boot_primary0001",
  bootGeneration: 1,
  claimId: "claim_primary001",
  claimFence: 2,
  requestDigest: `sha256_${"b".repeat(64)}`,
};

const userInputRequest: Extract<RunInteractionRequest, { kind: "user_input" }> = {
  id: "interaction_primary001",
  kind: "user_input",
  createdAt: 10,
  expiresAt: 20,
  reply,
  questions: [{
    id: "question_primary001",
    header: "Direction",
    prompt: "Which implementation should continue?",
    allowOther: true,
    options: [
      { id: "option_primary0001", label: "Smaller change" },
      { id: "option_primary0002", label: "Broader change", description: "Includes the cleanup." },
    ],
  }],
};

describe("HRA run interactions", () => {
  test("accepts only bounded provider-declared non-secret public requests", () => {
    expect(runInteractionRequestSchema.parse(userInputRequest)).toEqual(userInputRequest);
    expect(runInteractionRequestSchema.safeParse({
      ...userInputRequest,
      questions: [{ ...userInputRequest.questions[0], isSecret: false }],
    }).success).toBeFalse();
    expect(runInteractionRequestSchema.safeParse({
      ...userInputRequest,
      expiresAt: userInputRequest.createdAt,
    }).success).toBeFalse();
    expect(runInteractionRequestSchema.safeParse({
      ...userInputRequest,
      questions: [userInputRequest.questions[0], userInputRequest.questions[0]],
    }).success).toBeFalse();
    expect(runInteractionRequestSchema.safeParse({
      ...userInputRequest,
      questions: [{
        ...userInputRequest.questions[0],
        options: [
          userInputRequest.questions[0]?.options[0],
          userInputRequest.questions[0]?.options[0],
        ],
      }],
    }).success).toBeFalse();
  });

  test("validates answers against the exact stored question and option IDs", () => {
    const accepted: RunInteractionResponse = {
      kind: "user_input",
      answers: [{
        questionId: "question_primary001",
        selectedOptionIds: ["option_primary0002"],
      }],
    };
    expect(validateRunInteractionResponse(userInputRequest, accepted)).toEqual({
      success: true,
      data: accepted,
    });
    expect(validateRunInteractionResponse(userInputRequest, {
      ...accepted,
      answers: [{ ...accepted.answers[0], questionId: "question_unknown0001" }],
    })).toEqual({ success: false, reason: "question_mismatch" });
    expect(validateRunInteractionResponse(userInputRequest, {
      ...accepted,
      answers: [{ ...accepted.answers[0], selectedOptionIds: ["option_unknown00001"] }],
    })).toEqual({ success: false, reason: "option_mismatch" });
    expect(validateRunInteractionResponse({
      ...userInputRequest,
      questions: [{
        id: "question_primary001",
        header: "Direction",
        prompt: "Which implementation should continue?",
        allowOther: false,
        options: [
          { id: "option_primary0001", label: "Smaller change" },
          { id: "option_primary0002", label: "Broader change" },
        ],
      }],
    }, {
      kind: "user_input",
      answers: [{ questionId: "question_primary001", selectedOptionIds: [], otherText: "A third way" }],
    })).toEqual({ success: false, reason: "other_not_allowed" });
    expect(runInteractionResponseSchema.safeParse({
      kind: "user_input",
      answers: [{
        questionId: "question_primary001",
        selectedOptionIds: [],
        otherText: "   ",
      }],
    }).success).toBeFalse();
    expect(runInteractionResponseSchema.safeParse({
      kind: "user_input",
      answers: [
        accepted.answers[0],
        accepted.answers[0],
      ],
    }).success).toBeFalse();
  });

  test("sync is claim-fenced, strict, and includes explicit applied acknowledgements", () => {
    const sync = {
      runnerId: "runner_primary0001",
      bootId: "boot_primary0001",
      bootGeneration: 1,
      claimId: "claim_primary001",
      claimFence: 2,
      upserts: [userInputRequest],
      settlements: [{
        interactionId: "interaction_previous01",
        responseRevision: 1,
        outcome: "applied",
      }],
    };
    expect(syncRunInteractionsRequestSchema.parse(sync)).toEqual(syncRunInteractionsRequestSchema.parse(sync));
    expect(syncRunInteractionsRequestSchema.safeParse({ ...sync, accountId: "secret" }).success).toBeFalse();
    expect(hraDispatchRoutes.interactions("run_primary0001")).toBe(
      "/v1/dispatch/runs/run_primary0001/interactions/sync",
    );
    expect(syncRunInteractionsRequestSchema.safeParse({
      ...sync,
      settlements: [{
        interactionId: "interaction_previous01",
        outcome: "expired",
        reason: "local_deadline",
      }],
    }).success).toBeTrue();
    expect(syncRunInteractionsRequestSchema.safeParse({
      ...sync,
      settlements: [{ interactionId: "interaction_previous01", outcome: "applied" }],
    }).success).toBeFalse();
  });

  test("run views expose bounded requests and lifecycle metadata but never response bodies", () => {
    const interaction = runInteractionViewSchema.parse({
      runId: "run_primary0001",
      request: userInputRequest,
      state: "answered",
      responseRevision: 1,
      respondedAt: 15,
    });
    expect(interaction.state).toBe("answered");
    expect(runInteractionViewSchema.safeParse({
      ...interaction,
      response: { kind: "user_input", answers: [] },
    }).success).toBeFalse();

    const run = {
      id: "run_primary0001",
      taskKey: "OPS-123ABCD",
      phase: "waiting",
      repositoryId: "repo_0123456789ABCDEFGHJKMNPQRS",
      desiredState: "run",
      updatedAt: 15,
      events: [],
      interactions: [interaction],
    };
    expect(taskRunViewSchema.parse(run)).toEqual(taskRunViewSchema.parse(run));
    expect(taskRunViewSchema.safeParse({
      ...run,
      interactions: Array.from({ length: MAX_RUN_INTERACTION_VIEWS + 1 }, () => interaction),
    }).success).toBeFalse();
    expect(taskRunViewSchema.safeParse({
      ...run,
      interactions: [{ ...interaction, runId: "run_someone_else1" }],
    }).success).toBeFalse();
    expect(taskRunViewSchema.safeParse({
      ...run,
      interactions: [interaction, interaction],
    }).success).toBeFalse();
  });

  test("sync responses cannot issue contradictory answer, expiry, or settlement commands", () => {
    const delivered = {
      interactionId: "interaction_primary001",
      responseRevision: 1,
      sealedResponse: {
        version: 1 as const,
        algorithm: "P256-HKDF-SHA256-A256GCM" as const,
        keyId: reply.keyId,
        workspaceId: "workspace_primary001",
        ephemeralPublicKey: "A".repeat(87),
        nonce: "A".repeat(16),
        ciphertext: "A".repeat(RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS),
      },
    };
    const response = {
      serverTime: 100,
      acceptedInteractionIds: [],
      acceptedSettlementIds: [],
      responses: [delivered],
      expiredInteractions: [],
      hasMoreResponses: false,
    };
    expect(syncRunInteractionsResponseSchema.safeParse(response).success).toBeTrue();
    expect(syncRunInteractionsResponseSchema.safeParse({
      ...response,
      expiredInteractions: [{ interactionId: delivered.interactionId }],
    }).success).toBeFalse();
    expect(syncRunInteractionsResponseSchema.safeParse({
      ...response,
      acceptedSettlementIds: [delivered.interactionId],
    }).success).toBeFalse();
    expect(syncRunInteractionsResponseSchema.safeParse({
      ...response,
      responses: [
        delivered,
        {
          ...delivered,
          interactionId: "interaction_primary002",
          sealedResponse: { ...delivered.sealedResponse, workspaceId: "workspace_other0001" },
        },
      ],
    }).success).toBeFalse();
  });
});
