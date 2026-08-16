import {
  createRunInteractionRequestDigest,
  interactionRequestPayload,
  operationIdSchema,
  respondHRARunInteractionRequestSchema,
  runInteractionRequestPayloadSchema,
  safeErrorMessage,
  sealRunInteractionResponse,
  uuidV7Schema,
  workspacePublicIdSchema,
  type IdempotencyKey,
  type RespondHRARunInteractionRequest,
  type RunInteractionRequest,
  type RunInteractionRequestPayload,
  type RunInteractionResponse,
  type TaskWorkspaceMutationResult,
} from "@hraness/agent-tasks-protocol";

import {
  type CloudWorkspaceClient,
  type HRACloudSessionResult,
} from "./http-client";

export interface SealHRAInteractionInput {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly expectedWorkspaceRevision: number;
  readonly expectedProjectionHead: number;
  readonly request: RunInteractionRequest;
  readonly response: RunInteractionResponse;
  readonly now: number;
}

export interface SealedHRAInteraction {
  readonly route: {
    readonly workspaceId: string;
    readonly runId: string;
    readonly interactionId: string;
  };
  readonly request: RespondHRARunInteractionRequest;
}

export interface RespondHRAInteractionInput {
  readonly operationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly expectedWorkspaceRevision: number;
  readonly expectedProjectionHead: number;
  readonly request: RunInteractionRequestPayload;
  readonly response: RunInteractionResponse;
  readonly idempotencyKey: IdempotencyKey;
}

/**
 * Plaintext enters only this function and is not present in its return value.
 * The fixed-size ciphertext authenticates the request digest and full runner
 * authority tuple through the shared protocol implementation.
 */
export async function sealHRAInteraction(
  input: SealHRAInteractionInput,
): Promise<SealedHRAInteraction> {
  if (
    !Number.isSafeInteger(input.now) ||
    input.now < 0 ||
    input.now >= input.request.expiresAt
  ) {
    throw new Error("The interaction response deadline has passed.");
  }
  const workspaceId = workspacePublicIdSchema.parse(input.workspaceId);
  const operationId = operationIdSchema.parse(input.operationId);
  const sealedResponse = await sealRunInteractionResponse(
    input.request,
    { workspaceId, runId: input.runId },
    input.response,
  );
  const request = respondHRARunInteractionRequestSchema.parse({
    operationId,
    workspaceId,
    expectedWorkspaceRevision: input.expectedWorkspaceRevision,
    expectedProjectionHead: input.expectedProjectionHead,
    requestDigest: input.request.reply.requestDigest,
    sealedResponse,
  });
  return {
    route: {
      workspaceId,
      runId: input.runId,
      interactionId: input.request.id,
    },
    request,
  };
}

export class HRAInteractionGateway {
  readonly #client: Pick<
    CloudWorkspaceClient,
    "getInteractionReplyAuthority" | "respondInteraction"
  >;
  readonly #now: () => number;

  constructor(options: {
    readonly client: Pick<
      CloudWorkspaceClient,
      "getInteractionReplyAuthority" | "respondInteraction"
    >;
    readonly now?: () => number;
  }) {
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
  }

  async respond(
    input: RespondHRAInteractionInput,
  ): Promise<HRACloudSessionResult<TaskWorkspaceMutationResult>> {
    const idempotencyKey = uuidV7Schema.parse(input.idempotencyKey);
    const portableRequest = runInteractionRequestPayloadSchema.parse(
      input.request,
    );
    const requestDigest = await createRunInteractionRequestDigest(
      portableRequest,
    );
    const authority = await this.#client.getInteractionReplyAuthority(
      {
        workspaceId: input.workspaceId,
        runId: input.runId,
        interactionId: portableRequest.id,
      },
      {
        requestDigest,
        projectionHead: input.expectedProjectionHead,
      },
    );
    if (!authority.ok) return authority;
    if (
      JSON.stringify(interactionRequestPayload(authority.data.request)) !==
        JSON.stringify(portableRequest)
    ) {
      return {
        ok: false,
        kind: "operation",
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: safeErrorMessage.SERVICE_UNAVAILABLE,
          details: {},
        },
      };
    }
    const sealed = await sealHRAInteraction({
      ...input,
      request: authority.data.request,
      now: this.#now(),
    });
    return await this.#client.respondInteraction(
      sealed.route,
      sealed.request,
      idempotencyKey,
    );
  }
}
