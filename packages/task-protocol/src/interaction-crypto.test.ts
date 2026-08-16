import { describe, expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import {
  createRunInteractionReplyKeyPair,
  createRunInteractionRequestDigest,
  openRunInteractionResponse,
  sealRunInteractionResponse,
} from "./interaction-crypto";
import {
  MAX_RUN_INTERACTION_ID_CHARACTERS,
  MAX_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS,
  MAX_RUN_INTERACTION_RESPONSE_JSON_BYTES,
  RUN_INTERACTION_RESPONSE_LENGTH_BYTES,
  RUN_INTERACTION_RESPONSE_PADDED_BYTES,
  RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS,
  RUN_INTERACTION_SEALED_CIPHERTEXT_BYTES,
  runInteractionRequestSchema,
  type RunInteractionReplyBinding,
  type RunInteractionRequest,
  type RunInteractionRequestPayload,
  type RunInteractionResponse,
  type SealedRunInteractionResponse,
} from "./interactions";

const context = { workspaceId: "workspace_public001", runId: "run_crypto000001" } as const;

async function bind(
  payload: RunInteractionRequestPayload,
  keyPair: Awaited<ReturnType<typeof createRunInteractionReplyKeyPair>>,
  overrides: Partial<RunInteractionReplyBinding> = {},
): Promise<RunInteractionRequest> {
  return runInteractionRequestSchema.parse({
    ...payload,
    reply: {
      version: 1,
      algorithm: "P256-HKDF-SHA256-A256GCM",
      keyId: keyPair.keyId,
      publicKey: keyPair.publicKey,
      runnerId: "runner_crypto0001",
      bootId: "boot_crypto000001",
      bootGeneration: 3,
      claimId: "claim_crypto00001",
      claimFence: 7,
      requestDigest: await createRunInteractionRequestDigest(payload),
      ...overrides,
    },
  });
}

const filePayload: RunInteractionRequestPayload = {
  id: "interaction_crypto001",
  kind: "file_change_approval",
  scope: "once",
  createdAt: 1_000,
  expiresAt: 61_000,
};

function maxUserPayload(): Extract<RunInteractionRequestPayload, { kind: "user_input" }> {
  return {
    id: "interaction_crypto002",
    kind: "user_input",
    createdAt: 1_000,
    expiresAt: 61_000,
    questions: Array.from({ length: 3 }, (_, questionIndex) => ({
      id: `question_crypto000${questionIndex}`,
      header: `Choice ${questionIndex}`,
      prompt: "Choose a bounded response.",
      allowOther: true,
      options: Array.from({ length: 8 }, (_, optionIndex) => ({
        id: `option_crypto_${questionIndex}_${optionIndex}`,
        label: `Option ${optionIndex}`,
      })),
    })),
  };
}

function maxUserResponse(
  request: Extract<RunInteractionRequest, { kind: "user_input" }>,
): RunInteractionResponse {
  return {
    kind: "user_input",
    answers: request.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: question.options.map(({ id }) => id),
      otherText: "x".repeat(2_000),
    })),
  };
}

function maximumOpaqueId(prefix: "interaction" | "question" | "option", suffix: string): string {
  const stem = `${prefix}_${suffix}`;
  return `${stem}${"a".repeat(MAX_RUN_INTERACTION_ID_CHARACTERS - stem.length)}`;
}

function worstCaseUnicodePayload(): Extract<RunInteractionRequestPayload, { kind: "user_input" }> {
  return {
    id: maximumOpaqueId("interaction", "response"),
    kind: "user_input",
    createdAt: 1_000,
    expiresAt: 61_000,
    questions: Array.from({ length: 3 }, (_, questionIndex) => ({
      id: maximumOpaqueId("question", String(questionIndex)),
      header: "Response",
      prompt: "Provide the bounded response.",
      allowOther: true,
      options: Array.from({ length: 8 }, (_, optionIndex) => ({
        id: maximumOpaqueId("option", `${questionIndex}${optionIndex}`),
        label: `Option ${optionIndex}`,
      })),
    })),
  };
}

describe("sealed HRA interaction responses", () => {
  test("round trips, randomizes low-entropy answers, pads every response equally, and exposes no plaintext", async () => {
    const keyPair = await createRunInteractionReplyKeyPair();
    const fileRequest = await bind(filePayload, keyPair);
    const userRequest = await bind(maxUserPayload(), keyPair) as Extract<RunInteractionRequest, { kind: "user_input" }>;
    expect(keyPair.privateKey.extractable).toBeFalse();
    const decision = { kind: "file_change_approval", decision: "approve_once" } as const;
    const first = await sealRunInteractionResponse(fileRequest, context, decision);
    const second = await sealRunInteractionResponse(fileRequest, context, decision);
    const largest = await sealRunInteractionResponse(
      userRequest,
      context,
      maxUserResponse(userRequest),
    );

    expect(first).not.toEqual(second);
    expect(first.ciphertext.length).toBe(largest.ciphertext.length);
    expect(base64UrlBytes(first.ciphertext)).toBe(RUN_INTERACTION_SEALED_CIPHERTEXT_BYTES);
    const serialized = JSON.stringify([first, second, largest]);
    for (const plaintext of ["approve_once", "decision", "answers", "selectedOptionIds", "otherText"]) {
      expect(serialized).not.toContain(plaintext);
    }
    expect(await openRunInteractionResponse(fileRequest, context, first, keyPair.privateKey)).toEqual(decision);
    expect(await openRunInteractionResponse(
      userRequest,
      context,
      largest,
      keyPair.privateKey,
    )).toEqual(maxUserResponse(userRequest));
  });

  test("rejects every wrong AAD authority field, envelope tamper, and a restarted boot key", async () => {
    const keyPair = await createRunInteractionReplyKeyPair();
    const request = await bind(filePayload, keyPair);
    const userRequest = await bind(maxUserPayload(), keyPair) as Extract<RunInteractionRequest, { kind: "user_input" }>;
    const userSealed = await sealRunInteractionResponse(
      userRequest,
      context,
      maxUserResponse(userRequest),
    );
    const sealed = await sealRunInteractionResponse(request, context, {
      kind: "file_change_approval",
      decision: "decline",
    });
    const wrongRequests: RunInteractionRequest[] = [
      { ...request, id: "interaction_crypto099" },
      { ...request, expiresAt: request.expiresAt + 1 },
      { ...request, reply: { ...request.reply, runnerId: "runner_crypto0099" } },
      { ...request, reply: { ...request.reply, bootId: "boot_crypto000099" } },
      { ...request, reply: { ...request.reply, bootGeneration: 4 } },
      { ...request, reply: { ...request.reply, claimId: "claim_crypto00099" } },
      { ...request, reply: { ...request.reply, claimFence: 8 } },
      { ...request, reply: { ...request.reply, requestDigest: `sha256_${"c".repeat(64)}` } },
      { ...request, reply: { ...request.reply, keyId: `hitlkey_${"d".repeat(32)}` } },
    ].map((value) => runInteractionRequestSchema.parse(value));
    for (const wrongRequest of wrongRequests) {
      expect(openRunInteractionResponse(
        wrongRequest,
        context,
        sealed,
        keyPair.privateKey,
      )).rejects.toThrow();
    }
    for (const tamperedRequest of [
      {
        ...userRequest,
        questions: userRequest.questions.map((question, index) => index === 0
          ? { ...question, prompt: "A tampered prompt." }
          : question),
      },
      {
        ...userRequest,
        questions: userRequest.questions.map((question, index) => index === 0
          ? {
              ...question,
              options: question.options.map((option, optionIndex) => optionIndex === 0
                ? { ...option, label: "Tampered option" }
                : option),
            }
          : question),
      },
    ]) {
      expect(openRunInteractionResponse(
        runInteractionRequestSchema.parse(tamperedRequest),
        context,
        userSealed,
        keyPair.privateKey,
      )).rejects.toThrow("digest");
    }
    expect(openRunInteractionResponse(
      request,
      { ...context, workspaceId: "workspace_public099" },
      sealed,
      keyPair.privateKey,
    )).rejects.toThrow();
    expect(openRunInteractionResponse(
      request,
      { ...context, runId: "run_crypto000099" },
      sealed,
      keyPair.privateKey,
    )).rejects.toThrow();

    const otherEphemeral = await createRunInteractionReplyKeyPair();
    const tampered: SealedRunInteractionResponse[] = [
      { ...sealed, ephemeralPublicKey: otherEphemeral.publicKey },
      { ...sealed, nonce: flipBase64Url(sealed.nonce) },
      { ...sealed, ciphertext: flipBase64Url(sealed.ciphertext) },
    ];
    for (const envelope of tampered) {
      expect(openRunInteractionResponse(request, context, envelope, keyPair.privateKey)).rejects.toThrow();
    }
    const restarted = await createRunInteractionReplyKeyPair();
    expect(openRunInteractionResponse(
      request,
      context,
      sealed,
      restarted.privateKey,
    )).rejects.toThrow();
  });

  test("round trips arbitrary approval decisions without placing them in the envelope", async () => {
    const keyPair = await createRunInteractionReplyKeyPair();
    const request = await bind(filePayload, keyPair);
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("approve_once", "decline", "cancel"),
      async (decision) => {
        const response = { kind: "file_change_approval" as const, decision };
        const sealed = await sealRunInteractionResponse(request, context, response);
        expect(JSON.stringify(sealed)).not.toContain(decision);
        expect(await openRunInteractionResponse(request, context, sealed, keyPair.privateKey))
          .toEqual(response);
      },
    ), { numRuns: 24 });
  });

  test("round trips the exact worst-case Unicode JSON response within the derived envelope", async () => {
    const keyPair = await createRunInteractionReplyKeyPair();
    const request = await bind(worstCaseUnicodePayload(), keyPair) as Extract<
      RunInteractionRequest,
      { kind: "user_input" }
    >;
    const response: RunInteractionResponse = {
      kind: "user_input",
      answers: request.questions.map((question) => ({
        questionId: question.id,
        selectedOptionIds: question.options.map(({ id }) => id),
        otherText: "\u0000".repeat(MAX_RUN_INTERACTION_OTHER_TEXT_CODE_UNITS),
      })),
    };
    const serializedBytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;

    expect(serializedBytes).toBe(MAX_RUN_INTERACTION_RESPONSE_JSON_BYTES);
    expect(serializedBytes + RUN_INTERACTION_RESPONSE_LENGTH_BYTES).toBeLessThanOrEqual(
      RUN_INTERACTION_RESPONSE_PADDED_BYTES,
    );

    const sealed = await sealRunInteractionResponse(request, context, response);
    expect(sealed.ciphertext).toHaveLength(
      RUN_INTERACTION_SEALED_CIPHERTEXT_BASE64URL_CHARACTERS,
    );
    expect(base64UrlBytes(sealed.ciphertext)).toBe(RUN_INTERACTION_SEALED_CIPHERTEXT_BYTES);
    expect(await openRunInteractionResponse(request, context, sealed, keyPair.privateKey)).toEqual(
      response,
    );
  });
});

function flipBase64Url(value: string): string {
  const first = value[0];
  return `${first === "A" ? "B" : "A"}${value.slice(1)}`;
}

function base64UrlBytes(value: string): number {
  return Math.floor(value.length * 3 / 4);
}
