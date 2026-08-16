import {
  CLAIM_RENEWAL_THRESHOLD_MS,
  safeErrorMessage,
  type ClaimTaskResponse,
  type ContextResponse,
  type GetTaskResponse,
  type IdempotencyKey,
  type RequestId,
  type TaskKey,
} from "@hraness/agent-tasks-protocol";

import type {
  AgentAuthorization,
  ClientResult,
} from "./client";

export interface OwnedClaimContext {
  readonly revision: number;
  readonly fence: number;
  readonly leaseGeneration: number;
  readonly leaseUntil: number;
}

export interface AutomaticClaimRenewal extends OwnedClaimContext {
  readonly idempotencyKey: IdempotencyKey;
  readonly requestId: RequestId;
}

export interface ClaimPreflightClient {
  getTask(
    authorization: AgentAuthorization,
    key: TaskKey,
  ): Promise<ClientResult<GetTaskResponse>>;
  context(authorization: AgentAuthorization): Promise<ClientResult<ContextResponse>>;
  renewClaim(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: { readonly fence: number },
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<ClaimTaskResponse>>;
}

export interface ClaimBoundExecution<Value> {
  readonly result: ClientResult<Value>;
  readonly automaticClaimRenewal?: AutomaticClaimRenewal;
  readonly failureIdempotencyKey?: IdempotencyKey;
}

function ownedContext(task: ClaimTaskResponse["task"]): OwnedClaimContext {
  return {
    revision: task.revision,
    fence: task.currentClaim.fence,
    leaseGeneration: task.currentClaim.leaseGeneration,
    leaseUntil: task.currentClaim.leaseUntil,
  };
}

function localFailure(
  code: "CLAIM_NOT_OWNED" | "SERVICE_UNAVAILABLE",
  details: { readonly taskKey: TaskKey; readonly fence: number } | Record<string, never>,
): ClientResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: safeErrorMessage[code],
      details,
    },
  };
}

/**
 * Reads claim authority immediately before a claim-bound command. Open tasks do
 * not need a context request; in-progress tasks fail closed unless the current
 * authenticated stable agent owns the claim.
 */
export async function executeClaimBoundCommand<Value>(options: {
  readonly client: ClaimPreflightClient;
  readonly authorization: AgentAuthorization;
  readonly key: TaskKey;
  readonly renewalIdempotencyKey: () => IdempotencyKey;
  readonly target: (context: OwnedClaimContext | null) => Promise<ClientResult<Value>>;
}): Promise<ClaimBoundExecution<Value>> {
  const detail = await options.client.getTask(options.authorization, options.key);
  if (!detail.ok) return { result: detail };
  if (detail.data.task.status !== "in_progress") {
    return { result: await options.target(null) };
  }

  const context = await options.client.context(options.authorization);
  if (!context.ok) return { result: context };
  const current = detail.data.task;
  if (current.currentClaim.agentId !== context.data.principal.agentId) {
    return {
      result: localFailure("CLAIM_NOT_OWNED", {
        taskKey: current.key,
        fence: current.currentClaim.fence,
      }),
    };
  }

  const remaining = current.currentClaim.leaseUntil - context.data.serverTime;
  if (remaining > CLAIM_RENEWAL_THRESHOLD_MS) {
    return { result: await options.target(ownedContext(current)) };
  }

  const renewalIdempotencyKey = options.renewalIdempotencyKey();
  const renewed = await options.client.renewClaim(
    options.authorization,
    options.key,
    { fence: current.currentClaim.fence },
    renewalIdempotencyKey,
  );
  if (!renewed.ok) {
    return {
      result: renewed,
      failureIdempotencyKey: renewalIdempotencyKey,
    };
  }
  const renewedTask = renewed.data.task;
  if (
    renewedTask.key !== current.key ||
    renewedTask.currentClaim.agentId !== context.data.principal.agentId ||
    renewedTask.currentClaim.fence !== current.currentClaim.fence ||
    renewedTask.currentClaim.leaseGeneration !==
      current.currentClaim.leaseGeneration + 1 ||
    renewedTask.currentClaim.leaseUntil <= context.data.serverTime ||
    renewedTask.currentClaim.leaseUntil <= current.currentClaim.leaseUntil ||
    renewedTask.revision !== current.revision + 1
  ) {
    return {
      result: localFailure("SERVICE_UNAVAILABLE", {}),
      failureIdempotencyKey: renewalIdempotencyKey,
    };
  }

  const authoritative = ownedContext(renewedTask);
  return {
    result: await options.target(authoritative),
    automaticClaimRenewal: {
      ...authoritative,
      idempotencyKey: renewalIdempotencyKey,
      requestId: renewed.requestId,
    },
  };
}
