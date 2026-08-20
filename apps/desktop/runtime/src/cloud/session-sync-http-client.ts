import {
  MAX_SESSION_SYNC_HTTP_BODY_BYTES,
  MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
  SESSION_SYNC_PROTOCOL,
  bootstrapSyncVaultRequestSchema,
  canonicalSessionSyncJson,
  clearOrphanedScheduledChatAsHumanRequestSchema,
  readScheduledChatRecoveryInventoryAsHumanRequestSchema,
  claimSyncEnrollmentRequestSchema,
  createSyncProofNonce,
  decodeSyncUint64,
  digestSyncRequestBody,
  encodeSyncUint64,
  parseSessionSyncResponseJson,
  positiveSyncUint64Schema,
  recoverSyncVaultRequestSchema,
  routeForSessionSyncRequest,
  sessionSyncBackendRequestSchema,
  sessionSyncBackendResultSchema,
  sessionSyncHelloSchema,
  sessionSyncHttpRoutes,
  sessionSyncHumanInvocationSchema,
  sessionSyncInvocationSchema,
  sessionSyncNegotiationInvocationSchema,
  sessionSyncNegotiationSchema,
  signSyncDeviceProof,
  submitSyncEnrollmentRequestSchema,
  syncDeviceIdSchema,
  syncDeviceProofPayloadSchema,
  syncMembershipCoordinateSchema,
  type BootstrapSyncVaultRequest,
  type ClaimSyncEnrollmentRequest,
  type ClearOrphanedScheduledChatAsHumanRequest,
  type ReadScheduledChatRecoveryInventoryAsHumanRequest,
  type RecoverSyncVaultRequest,
  type SessionSyncBackendErrorCode,
  type SessionSyncBackendRequest,
  type SessionSyncBackendResult,
  type SessionSyncBackendResponse,
  type SyncDeviceId,
  type SyncDeviceKeyPairs,
  type SyncMembershipCoordinate,
  type SyncVaultCoordinate,
  type SubmitSyncEnrollmentRequest,
} from "@hraness/agent-tasks-protocol";
import {
  StrictHumanHttpClient,
  type FetchLike,
  type HumanOperationResult,
  type HumanSessionCoordinator,
  type HumanSessionResult,
} from "@hraness/hra-human-client";

const DEFAULT_SESSION_SYNC_HTTP_TIMEOUT_MS = 15_000;
const DEVICE_PROOF_TTL_MS = 60_000;
const MAX_CLOCK_CALIBRATION_RTT_MS = 60_000;
const MAX_PERSISTED_CLOCK_CALIBRATION_AGE_MS = 5 * 60_000;
const MAX_PERSISTED_CLOCK_FUTURE_SKEW_MS = 60_000;

export interface SessionSyncTransportFailure {
  readonly code: SessionSyncBackendErrorCode | "SERVICE_UNAVAILABLE";
  readonly retryAfterMs?: number;
}

export type SessionSyncOperationResult<Value> = HumanOperationResult<
  Value,
  SessionSyncTransportFailure
>;

export type SessionSyncSessionResult<Value> = HumanSessionResult<
  Value,
  SessionSyncTransportFailure
>;

export interface SessionSyncProofAuthority {
  readonly membership: SyncMembershipCoordinate;
  readonly deviceId: SyncDeviceId;
  readonly keys: SyncDeviceKeyPairs;
}

export interface SessionSyncClockCalibration {
  readonly serverObservedAt: number;
  readonly clientObservedAt: number;
  readonly uncertaintyMs: number;
}

export interface SessionSyncClockCalibrationPort {
  load(): SessionSyncClockCalibration | null;
  save(calibration: SessionSyncClockCalibration): void | Promise<void>;
}

function failure(
  code: SessionSyncTransportFailure["code"] = "SERVICE_UNAVAILABLE",
  retryAfterMs?: number,
): SessionSyncOperationResult<never> {
  if (
    code === "RATE_LIMITED"
    && Number.isSafeInteger(retryAfterMs)
    && retryAfterMs !== undefined
    && retryAfterMs >= 1
    && retryAfterMs <= 300_000
  ) {
    return { ok: false, error: { code, retryAfterMs } };
  }
  return { ok: false, error: { code } };
}

function backendFailure(
  result: Extract<SessionSyncBackendResult, { readonly ok: false }>,
): SessionSyncOperationResult<never> {
  return failure(
    result.code,
    result.code === "RATE_LIMITED" ? result.retryAfterMs : undefined,
  );
}

function statusForBackendError(code: SessionSyncBackendErrorCode): number {
  switch (code) {
    case "AUTHENTICATION_FAILED": return 401;
    case "AUTHORIZATION_DENIED": return 403;
    case "INVALID_REQUEST":
    case "FORBIDDEN_CONTENT": return 400;
    case "NOT_FOUND": return 404;
    case "RETIRED": return 410;
    case "DIRECTORY_LIMIT":
    case "DEVICE_LIMIT":
    case "EVENT_LIMIT":
    case "QUOTA_EXCEEDED": return 429;
    case "RATE_LIMITED": return 429;
    case "SERVICE_UNAVAILABLE": return 503;
    case "CONFLICT":
    case "GRANT_EXPIRED":
    case "PROOF_EXPIRED":
    case "PROOF_INVALID":
    case "PROOF_REPLAYED":
    case "KEY_EPOCH_LIMIT":
    case "MAINTENANCE_REQUIRED":
    case "SEQUENCE_GAP":
    case "SNAPSHOT_EXPIRED":
    case "STALE_BOOT":
    case "STALE_MEMBERSHIP":
    case "STALE_MIRROR":
    case "STALE_REVISION":
    case "STALE_WRITER":
    case "UPDATE_REQUIRED": return 409;
  }
}

function abortableFetch(fetch: FetchLike, signal?: AbortSignal): FetchLike {
  if (signal === undefined) return fetch;
  return async (input, init) => {
    if (signal.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const requestSignal = init?.signal;
    return await fetch(input, {
      ...init,
      signal: requestSignal === undefined || requestSignal === null
        ? signal
        : AbortSignal.any([requestSignal, signal]),
    });
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalSessionSyncJson(left) === canonicalSessionSyncJson(right);
}

function sameVaultCoordinates(
  left: SyncVaultCoordinate,
  right: SyncVaultCoordinate,
): boolean {
  return left.tenantId === right.tenantId
    && left.organizationId === right.organizationId
    && left.ownerUserId === right.ownerUserId
    && left.vaultId === right.vaultId
    && left.vaultGeneration === right.vaultGeneration;
}

function assertNever(value: never): never {
  throw new TypeError(`Unhandled session sync operation: ${String(value)}`);
}

function proposalMatchesMembershipRequest(
  request: Extract<
    SessionSyncBackendRequest,
    { readonly operation: "update_membership" | "approve_enrollment" }
  >,
  response: Extract<
    SessionSyncBackendResponse,
    { readonly kind: "membership_pending" }
  >,
): boolean {
  const proposal = response.proposal;
  return proposal.proposalKind === (
    request.operation === "approve_enrollment" ? "enrollment" : "update"
  )
    && (
      request.operation !== "approve_enrollment"
      || proposal.enrollmentRequestId === request.requestId
    )
    && proposal.candidate.statementDigest ===
      request.membershipHead.statementDigest
    && sameValue(
      proposal.candidate.statement,
      request.membershipHead.statement,
    )
    && sameValue(proposal.wrappedRoots, request.wrappedRoots)
    && sameValue(proposal.rootKeyLink, request.rootKeyLink)
    && sameValue(proposal.recoveryRootWrap, request.recoveryRootWrap);
}

function admittedProposalMatchesRequest(
  request: Extract<
    SessionSyncBackendRequest,
    { readonly operation: "admit_membership_proposal" }
  >,
  response: Extract<
    SessionSyncBackendResponse,
    { readonly kind: "membership_pending" }
  >,
): boolean {
  const requested = request.membershipCandidate.statement;
  const admitted = response.proposal.candidate.statement;
  // A racing device may have admitted a different canonical child. Bind the
  // response to the same vault and parent without pretending the caller won.
  // The coordinator compares the returned candidate digest before it signs.
  return requested.tenantId === admitted.tenantId
    && requested.organizationId === admitted.organizationId
    && requested.ownerUserId === admitted.ownerUserId
    && requested.vaultId === admitted.vaultId
    && requested.vaultGeneration === admitted.vaultGeneration
    && requested.membershipEpoch === admitted.membershipEpoch
    && requested.previousMembershipDigest === admitted.previousMembershipDigest;
}

function rootKeyLinkPageMatchesRequest(
  request: Extract<
    SessionSyncBackendRequest,
    { readonly operation: "root_key_link_page" }
  >,
  response: Extract<
    SessionSyncBackendResponse,
    { readonly kind: "root_key_link_page" }
  >,
  expectedVault: SyncVaultCoordinate,
): boolean {
  if (
    response.links.length > request.pageSize
    || !sameVaultCoordinates(response.vault, expectedVault)
  ) return false;
  const first = response.links[0];
  const last = response.links.at(-1);
  for (let index = 0; index < response.links.length; index += 1) {
    const current = response.links[index]!;
    const previous = response.links[index - 1];
    if (
      !sameVaultCoordinates(current.context, expectedVault)
      || (previous !== undefined
        && previous.context.parentRootKeyEpoch
          !== current.context.childRootKeyEpoch)
    ) return false;
  }
  if (
    request.beforeChildRootKeyEpoch !== undefined
    && first !== undefined
    && decodeSyncUint64(first.context.childRootKeyEpoch)
      >= decodeSyncUint64(request.beforeChildRootKeyEpoch)
  ) return false;
  if (!response.hasMore) return response.nextBeforeChildRootKeyEpoch === undefined;
  return last !== undefined
    && response.nextBeforeChildRootKeyEpoch === last.context.childRootKeyEpoch
    && (
      request.beforeChildRootKeyEpoch === undefined
      || decodeSyncUint64(response.nextBeforeChildRootKeyEpoch)
        < decodeSyncUint64(request.beforeChildRootKeyEpoch)
    );
}

export function sessionSyncResponseMatchesRequest(
  request: SessionSyncBackendRequest,
  response: SessionSyncBackendResponse,
  expectedVault: SyncVaultCoordinate,
): boolean {
  const requestScope = request.operation === "admit_membership_proposal"
    ? request.membershipCandidate.statement
    : request.operation === "update_membership"
      || request.operation === "approve_enrollment"
    ? request.membershipHead.statement
    : request.operation === "publish_session"
    ? request.envelope.header
    : request.operation === "put_scheduled_chat"
    ? request.definition.header
    : request.operation === "clear_scheduled_chat"
    ? request
    : null;
  if (
    requestScope !== null
    && !sameVaultCoordinates(requestScope, expectedVault)
  ) return false;
  switch (request.operation) {
    case "read_membership":
      return response.kind === "membership"
        && sameVaultCoordinates(response.head.statement, expectedVault);
    case "list_enrollment_requests":
      return response.kind === "enrollment_requests"
        && sameVaultCoordinates(response.vault, expectedVault)
        && response.requests.every(({ pairingTranscript }) =>
          pairingTranscript.vaultId === expectedVault.vaultId
          && pairingTranscript.vaultGeneration === expectedVault.vaultGeneration
        );
    case "admit_membership_proposal":
      return (
        response.kind === "membership_pending"
        && admittedProposalMatchesRequest(request, response)
      ) || (
        response.kind === "membership_accepted"
        && response.membershipEpoch ===
          request.membershipCandidate.statement.membershipEpoch
        && response.membershipDigest === request.membershipCandidate.statementDigest
      );
    case "update_membership":
      return (
        response.kind === "membership_accepted"
        && response.membershipEpoch ===
          request.membershipHead.statement.membershipEpoch
        && response.membershipDigest === request.membershipHead.statementDigest
      ) || (
        response.kind === "membership_pending"
        && proposalMatchesMembershipRequest(request, response)
      );
    case "approve_enrollment":
      return (
        response.kind === "enrollment_approved"
        && sameVaultCoordinates(response.vault, expectedVault)
        && response.requestId === request.requestId
        && response.membershipEpoch ===
          request.membershipHead.statement.membershipEpoch
      ) || (
        response.kind === "membership_pending"
        && proposalMatchesMembershipRequest(request, response)
      );
    case "root_key_link_page":
      return response.kind === "root_key_link_page"
        && rootKeyLinkPageMatchesRequest(request, response, expectedVault);
    case "establish_boot":
    case "heartbeat":
      return response.kind === "boot_current"
        && sameVaultCoordinates(response.vault, expectedVault)
        && response.bootId === request.bootId
        && (
          request.bootGeneration === undefined
          || response.bootGeneration === request.bootGeneration
        )
        && response.heartbeatSequence === request.heartbeatSequence;
    case "reserve_session":
      return response.kind === "session_reserved"
        && sameVaultCoordinates(response.vault, expectedVault)
        && response.sessionId === request.sessionId
        && response.creationGrantDigest === request.creationGrantDigest;
    case "acquire_writer":
      return (
        response.kind === "reconcile_required"
        && sameVaultCoordinates(response.vault, expectedVault)
      )
        || (
          response.kind === "writer_acquired"
          && sameVaultCoordinates(response.vault, expectedVault)
          && response.bootId === request.bootId
          && response.bootGeneration === request.bootGeneration
        );
    case "publish_session":
      return response.kind === "session_accepted"
        && sameVaultCoordinates(response.accepted.envelope.header, expectedVault)
        && sameValue(response.accepted.envelope, request.envelope);
    case "delete_session":
      return response.kind === "session_deleted"
        && sameVaultCoordinates(response.tombstone, expectedVault)
        && response.tombstone.sessionId === request.sessionId
        && response.tombstone.tombstoneDigest === request.tombstoneDigest;
    case "put_scheduled_chat":
      return response.kind === "scheduled_chat_put"
        && response.sessionId === request.definition.header.sessionId
        && response.schedule.generation === request.definition.header.generation
        && response.schedule.rrule === request.definition.header.rrule
        && response.schedule.timeZone === request.definition.header.timeZone
        && response.ciphertextDigest === request.definition.ciphertextDigest;
    case "clear_scheduled_chat":
      return response.kind === "scheduled_chat_cleared"
        && response.sessionId === request.sessionId
        && response.generation === request.expectedGeneration;
    case "clear_orphaned_scheduled_chat":
      return response.kind === "scheduled_chat_cleared"
        && response.sessionId === request.sessionId
        && response.generation === request.expectedGeneration;
    case "scheduled_chat_inventory":
      return response.kind === "scheduled_chat_inventory"
        && response.schedules.length <= request.pageSize
        && response.hasMore === (response.nextAfterSessionId !== undefined)
        && (!response.hasMore
          || response.nextAfterSessionId
            === response.schedules.at(-1)?.sessionId)
        && response.schedules.every((schedule, index) =>
          (request.afterSessionId === undefined
            || schedule.sessionId > request.afterSessionId)
          && (index === 0
            || response.schedules[index - 1]!.sessionId < schedule.sessionId)
          && (schedule.state === "cleared"
            || sameVaultCoordinates(schedule.definition.header, expectedVault))
        );
    case "scheduled_run_page":
      return response.kind === "scheduled_run_page"
        && response.runs.length <= request.pageSize
        && response.runs.every((run) =>
          sameVaultCoordinates(run.definition.header, expectedVault)
          && run.definition.header.sessionId === run.sessionId
          && run.definition.header.generation === run.scheduleGeneration
        );
    case "ack_scheduled_run":
      return response.kind === "scheduled_run_acknowledged"
        && response.runId === request.runId
        && response.sessionId === request.sessionId
        && response.generation === request.scheduleGeneration;
    case "begin_snapshot":
      return response.kind === "snapshot_started"
        && sameVaultCoordinates(response.vault, expectedVault)
        && response.snapshotId === request.snapshotId;
    case "snapshot_page":
      return response.kind === "snapshot_page"
        && sameVaultCoordinates(response.page.vault, expectedVault)
        && sameValue(response.page.after, request.after);
    case "change_page":
      return (
        response.kind === "resnapshot_required"
        && sameVaultCoordinates(response.vault, expectedVault)
      )
        || (
          response.kind === "change_page"
          && sameVaultCoordinates(response.page.vault, expectedVault)
          && response.page.afterVersion === request.afterVersion
        );
    default:
      return assertNever(request);
  }
}

export function sessionSyncProofMethod(
  request: SessionSyncBackendRequest,
): "GET" | "POST" {
  switch (request.operation) {
    case "read_membership":
    case "list_enrollment_requests":
    case "root_key_link_page":
    case "snapshot_page":
    case "change_page":
    case "scheduled_chat_inventory":
    case "scheduled_run_page":
      return "GET";
    case "admit_membership_proposal":
    case "update_membership":
    case "approve_enrollment":
    case "establish_boot":
    case "heartbeat":
    case "reserve_session":
    case "acquire_writer":
    case "publish_session":
    case "delete_session":
    case "put_scheduled_chat":
    case "clear_scheduled_chat":
    case "clear_orphaned_scheduled_chat":
    case "ack_scheduled_run":
    case "begin_snapshot":
      return "POST";
    default:
      return assertNever(request);
  }
}

/** Strict, token-stateless HTTP wire for the encrypted session relay. */
export class SessionSyncHttpTransport {
  readonly #apiUrl: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;

  constructor(options: {
    readonly apiUrl: string;
    readonly fetch?: FetchLike;
    readonly requestTimeoutMs?: number;
  }) {
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs
      ?? DEFAULT_SESSION_SYNC_HTTP_TIMEOUT_MS;
    void this.#client();
  }

  #client(signal?: AbortSignal): StrictHumanHttpClient {
    return new StrictHumanHttpClient({
      apiUrl: this.#apiUrl,
      fetch: abortableFetch(this.#fetch, signal),
      requestTimeoutMs: this.#requestTimeoutMs,
      maxRequestBytes: MAX_SESSION_SYNC_HTTP_BODY_BYTES,
      maxResponseBytes: MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
    });
  }

  async negotiate(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<ReturnType<
    typeof sessionSyncNegotiationSchema.parse
  >>> {
    const hello = sessionSyncHelloSchema.parse({
      protocol: SESSION_SYNC_PROTOCOL,
      minimumVersion: 1,
      maximumVersion: 1,
      capabilities: [
        "device_enrollment",
        "summary_publication",
        "remote_observation",
      ],
    });
    const body = sessionSyncNegotiationInvocationSchema.parse({
      helloJson: canonicalSessionSyncJson(hello),
    });
    const result = await this.#client(signal).request({
      method: "POST",
      path: sessionSyncHttpRoutes.negotiate,
      successSchema: sessionSyncNegotiationSchema,
      failureSchema: sessionSyncBackendResultSchema,
      bearerToken: accessToken,
      body: {
        kind: "json",
        value: body,
        schema: sessionSyncNegotiationInvocationSchema,
      },
      maxRequestBytes: MAX_SESSION_SYNC_HTTP_BODY_BYTES,
      maxResponseBytes: MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
    });
    if (result.ok) return { ok: true, data: result.data };
    if (result.kind === "transport") return failure();
    if (
      result.data.ok
      || statusForBackendError(result.data.code) !== result.status
    ) return failure();
    return backendFailure(result.data);
  }

  async bootstrap(
    accessToken: string,
    requestValue: BootstrapSyncVaultRequest,
    proofJson: string,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "vault_created" }
  >>> {
    const request = bootstrapSyncVaultRequestSchema.parse(requestValue);
    const result = await this.#invoke(
      accessToken,
      sessionSyncHttpRoutes.bootstrap,
      canonicalSessionSyncJson(request),
      proofJson,
      signal,
    );
    if (!result.ok) return result;
    const response = result.data;
    if (
      response.kind !== "vault_created"
      || !sameVaultCoordinates(
        response.vault,
        request.membershipHead.statement,
      )
      || response.vaultId !== request.membershipHead.statement.vaultId
      || response.membershipEpoch !==
        request.membershipHead.statement.membershipEpoch
      || response.rootKeyEpoch !== request.wrappedRoot.context.rootKeyEpoch
    ) return failure();
    return { ok: true, data: response };
  }

  async submitEnrollment(
    accessToken: string,
    requestValue: SubmitSyncEnrollmentRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "enrollment_submitted" }
  >>> {
    const request = submitSyncEnrollmentRequestSchema.parse(requestValue);
    const result = await this.#invokeHuman(
      accessToken,
      sessionSyncHttpRoutes.enrollmentSubmit,
      canonicalSessionSyncJson(request),
      signal,
    );
    if (!result.ok) return result;
    if (
      result.data.kind !== "enrollment_submitted"
      || result.data.vault.vaultId !== request.vaultId
      || result.data.vault.vaultGeneration !== request.vaultGeneration
      || result.data.deviceId !== request.deviceId
    ) return failure();
    return { ok: true, data: result.data };
  }

  async claimEnrollment(
    accessToken: string,
    requestValue: ClaimSyncEnrollmentRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "enrollment_pending" | "enrollment_claimed" }
  >>> {
    const request = claimSyncEnrollmentRequestSchema.parse(requestValue);
    const result = await this.#invokeHuman(
      accessToken,
      sessionSyncHttpRoutes.enrollmentClaim,
      canonicalSessionSyncJson(request),
      signal,
    );
    if (!result.ok) return result;
    if (
      (result.data.kind !== "enrollment_pending"
        && result.data.kind !== "enrollment_claimed")
      || result.data.vault.vaultId !== request.vaultId
      || result.data.vault.vaultGeneration !== request.vaultGeneration
      || result.data.requestId !== request.requestId
    ) return failure();
    if (result.data.kind === "enrollment_claimed") {
      const claimed = result.data;
      const member = claimed.head.statement.members.find(
        ({ deviceId }) => deviceId === request.deviceId,
      );
      const wrappedRoots = claimed.wrappedRoots;
      if (
        member?.status !== "active"
        || claimed.wrappedRoot.context.recipientDeviceId !==
          request.deviceId
        || !wrappedRoots.some((root) => sameValue(root, claimed.wrappedRoot))
        || wrappedRoots.some((root) =>
          root.context.recipientDeviceId !== request.deviceId
          || root.context.membershipEpoch !==
            claimed.head.statement.membershipEpoch
        )
      ) return failure();
    }
    return { ok: true, data: result.data };
  }

  async recover(
    accessToken: string,
    requestValue: RecoverSyncVaultRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "vault_recovered" }
  >>> {
    const request = recoverSyncVaultRequestSchema.parse(requestValue);
    const result = await this.#invokeHuman(
      accessToken,
      sessionSyncHttpRoutes.recover,
      canonicalSessionSyncJson(request),
      signal,
    );
    if (!result.ok) return result;
    if (
      result.data.kind !== "vault_recovered"
      || !sameVaultCoordinates(
        result.data.vault,
        request.authorization.statement.vault,
      )
      || result.data.membershipEpoch !==
        request.membershipHead.statement.membershipEpoch
      || result.data.receipt.acceptedMembershipDigest !==
        request.membershipHead.statementDigest
      || !sameValue(
        result.data.receipt.authorization,
        request.authorization,
      )
    ) return failure();
    return { ok: true, data: result.data };
  }

  async clearOrphanedScheduledChat(
    accessToken: string,
    requestValue: ClearOrphanedScheduledChatAsHumanRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "scheduled_chat_cleared" }
  >>> {
    const request = clearOrphanedScheduledChatAsHumanRequestSchema.parse(requestValue);
    const result = await this.#invokeHuman(
      accessToken,
      sessionSyncHttpRoutes.orphanClear,
      canonicalSessionSyncJson(request),
      signal,
    );
    if (!result.ok) return result;
    if (
      result.data.kind !== "scheduled_chat_cleared"
      || result.data.sessionId !== request.sessionId
      || result.data.generation !== request.expectedGeneration
    ) return failure();
    return { ok: true, data: result.data };
  }

  async readScheduledChatRecoveryInventory(
    accessToken: string,
    requestValue: ReadScheduledChatRecoveryInventoryAsHumanRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "scheduled_chat_recovery_inventory" }
  >>> {
    const request = readScheduledChatRecoveryInventoryAsHumanRequestSchema.parse(
      requestValue,
    );
    const result = await this.#invokeHuman(
      accessToken,
      sessionSyncHttpRoutes.orphanInventory,
      canonicalSessionSyncJson(request),
      signal,
    );
    if (!result.ok) return result;
    if (
      result.data.kind !== "scheduled_chat_recovery_inventory"
      || !sameVaultCoordinates(result.data.vault, request)
      || result.data.originDeviceId !== request.originDeviceId
    ) return failure();
    return { ok: true, data: result.data };
  }

  async execute(
    accessToken: string,
    requestValue: SessionSyncBackendRequest,
    proofJson: string,
    expectedVault: SyncVaultCoordinate,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<SessionSyncBackendResponse>> {
    const request = sessionSyncBackendRequestSchema.parse(requestValue);
    const result = await this.#invoke(
      accessToken,
      sessionSyncHttpRoutes.execute,
      canonicalSessionSyncJson(request),
      proofJson,
      signal,
    );
    if (!result.ok) return result;
    if (!sessionSyncResponseMatchesRequest(request, result.data, expectedVault)) {
      return failure();
    }
    return result;
  }

  async #invoke(
    accessToken: string,
    path: string,
    requestJson: string,
    proofJson: string,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<SessionSyncBackendResponse>> {
    const invocation = sessionSyncInvocationSchema.parse({
      requestJson,
      proofJson,
    });
    const result = await this.#client(signal).request({
      method: "POST",
      path,
      successSchema: sessionSyncBackendResultSchema,
      failureSchema: sessionSyncBackendResultSchema,
      bearerToken: accessToken,
      body: {
        kind: "json",
        value: invocation,
        schema: sessionSyncInvocationSchema,
      },
      maxRequestBytes: MAX_SESSION_SYNC_HTTP_BODY_BYTES,
      maxResponseBytes: MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
    });
    if (!result.ok) {
      if (result.kind === "transport") return failure();
      if (
        result.data.ok
        || statusForBackendError(result.data.code) !== result.status
      ) return failure();
      return backendFailure(result.data);
    }
    if (!result.data.ok) return failure();
    try {
      return {
        ok: true,
        data: parseSessionSyncResponseJson(result.data.responseJson),
      };
    } catch {
      return failure();
    }
  }

  async #invokeHuman(
    accessToken: string,
    path: string,
    requestJson: string,
    signal?: AbortSignal,
  ): Promise<SessionSyncOperationResult<SessionSyncBackendResponse>> {
    const invocation = sessionSyncHumanInvocationSchema.parse({ requestJson });
    const result = await this.#client(signal).request({
      method: "POST",
      path,
      successSchema: sessionSyncBackendResultSchema,
      failureSchema: sessionSyncBackendResultSchema,
      bearerToken: accessToken,
      body: {
        kind: "json",
        value: invocation,
        schema: sessionSyncHumanInvocationSchema,
      },
      maxRequestBytes: MAX_SESSION_SYNC_HTTP_BODY_BYTES,
      maxResponseBytes: MAX_SESSION_SYNC_RESPONSE_JSON_BYTES,
    });
    if (!result.ok) {
      if (result.kind === "transport") return failure();
      if (
        result.data.ok
        || statusForBackendError(result.data.code) !== result.status
      ) return failure();
      return backendFailure(result.data);
    }
    if (!result.data.ok) return failure();
    try {
      return {
        ok: true,
        data: parseSessionSyncResponseJson(result.data.responseJson),
      };
    } catch {
      return failure();
    }
  }
}

/**
 * Credential-aware proof client. A proof is minted inside the coordinator's
 * operation callback, so a bearer refresh gets a fresh nonce and signature.
 */
export class SessionSyncBearerClient {
  readonly #calibrationPort: SessionSyncClockCalibrationPort | null;
  #clock: Readonly<{
    serverObservedAt: number;
    monotonicObservedAt: number;
    uncertaintyMs: number;
  }> | null;
  readonly #monotonicNow: () => number;
  readonly #now: () => number;
  #proofTtlMs = DEVICE_PROOF_TTL_MS;
  readonly #session: HumanSessionCoordinator;
  readonly #transport: SessionSyncHttpTransport;

  constructor(options: {
    readonly session: HumanSessionCoordinator;
    readonly transport: SessionSyncHttpTransport;
    readonly now?: () => number;
    readonly monotonicNow?: () => number;
    readonly calibration?: SessionSyncClockCalibrationPort;
  }) {
    this.#session = options.session;
    this.#transport = options.transport;
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#calibrationPort = options.calibration ?? null;
    const persisted = this.#calibrationPort?.load() ?? null;
    const localNow = this.#now();
    const monotonicNow = this.#monotonicNow();
    this.#clock = restoreSessionSyncClock(
      persisted,
      localNow,
      monotonicNow,
    );
  }

  async negotiate(signal?: AbortSignal): Promise<SessionSyncSessionResult<
    ReturnType<typeof sessionSyncNegotiationSchema.parse>
  >> {
    const clientStartedAt = this.#now();
    const monotonicStartedAt = this.#monotonicNow();
    const result = await this.#session.execute(
      async (token) => await this.#transport.negotiate(token, signal),
    );
    if (!result.ok || result.data.outcome !== "accepted") return result;
    const monotonicFinishedAt = this.#monotonicNow();
    const elapsed = monotonicFinishedAt - monotonicStartedAt;
    const serverObserved = decodeSyncUint64(result.data.serverObservedAt);
    if (
      !Number.isFinite(elapsed)
      || elapsed < 0
      || elapsed > MAX_CLOCK_CALIBRATION_RTT_MS
      || serverObserved > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return result;
    }
    const uncertaintyMs = Math.ceil(elapsed / 2);
    const clientObservedAt = clientStartedAt + Math.floor(elapsed / 2);
    const calibration: SessionSyncClockCalibration = {
      serverObservedAt: Number(serverObserved),
      clientObservedAt,
      uncertaintyMs,
    };
    this.#clock = {
      serverObservedAt: calibration.serverObservedAt,
      monotonicObservedAt: monotonicStartedAt + elapsed / 2,
      uncertaintyMs,
    };
    this.#proofTtlMs = Math.min(
      DEVICE_PROOF_TTL_MS,
      result.data.maximumProofTtlMs,
    );
    await this.#calibrationPort?.save(calibration);
    return result;
  }

  async bootstrap(
    requestValue: BootstrapSyncVaultRequest,
    authorityValue: SessionSyncProofAuthority,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "vault_created" }
  >>> {
    const request = bootstrapSyncVaultRequestSchema.parse(requestValue);
    const authority = this.#parseAuthority(authorityValue);
    return await this.#withProofRefresh(async () =>
      await this.#session.execute(async (token) => {
        const proof = await this.#proof({
          authority,
          method: "POST",
          route: "sync.membership.update",
          body: request,
        });
        return await this.#transport.bootstrap(
          token,
          request,
          canonicalSessionSyncJson(proof),
          signal,
        );
      }), signal);
  }

  recover(
    requestValue: RecoverSyncVaultRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "vault_recovered" }
  >>> {
    const request = recoverSyncVaultRequestSchema.parse(requestValue);
    return this.#session.execute(
      async (token) => await this.#transport.recover(token, request, signal),
    );
  }

  clearOrphanedScheduledChat(
    requestValue: ClearOrphanedScheduledChatAsHumanRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "scheduled_chat_cleared" }
  >>> {
    const request = clearOrphanedScheduledChatAsHumanRequestSchema.parse(requestValue);
    return this.#session.execute(
      async (token) => await this.#transport.clearOrphanedScheduledChat(
        token,
        request,
        signal,
      ),
    );
  }

  readScheduledChatRecoveryInventory(
    requestValue: ReadScheduledChatRecoveryInventoryAsHumanRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "scheduled_chat_recovery_inventory" }
  >>> {
    const request = readScheduledChatRecoveryInventoryAsHumanRequestSchema.parse(
      requestValue,
    );
    return this.#session.execute(
      async (token) => await this.#transport.readScheduledChatRecoveryInventory(
        token,
        request,
        signal,
      ),
    );
  }

  submitEnrollment(
    requestValue: SubmitSyncEnrollmentRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "enrollment_submitted" }
  >>> {
    const request = submitSyncEnrollmentRequestSchema.parse(requestValue);
    return this.#session.execute(
      async (token) =>
        await this.#transport.submitEnrollment(token, request, signal),
    );
  }

  claimEnrollment(
    requestValue: ClaimSyncEnrollmentRequest,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<Extract<
    SessionSyncBackendResponse,
    { readonly kind: "enrollment_pending" | "enrollment_claimed" }
  >>> {
    const request = claimSyncEnrollmentRequestSchema.parse(requestValue);
    return this.#session.execute(
      async (token) =>
        await this.#transport.claimEnrollment(token, request, signal),
    );
  }

  async execute(
    requestValue: SessionSyncBackendRequest,
    authorityValue: SessionSyncProofAuthority,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<SessionSyncBackendResponse>> {
    const request = sessionSyncBackendRequestSchema.parse(requestValue);
    const authority = this.#parseAuthority(authorityValue);
    return await this.#withProofRefresh(async () =>
      await this.#session.execute(async (token) => {
        const proof = await this.#proof({
          authority,
          method: sessionSyncProofMethod(request),
          route: routeForSessionSyncRequest(request),
          body: request,
        });
        return await this.#transport.execute(
          token,
          request,
          canonicalSessionSyncJson(proof),
          authority.membership,
          signal,
        );
      }), signal);
  }

  async #withProofRefresh<Value>(
    run: () => Promise<SessionSyncSessionResult<Value>>,
    signal?: AbortSignal,
  ): Promise<SessionSyncSessionResult<Value>> {
    const first = await run();
    if (
      first.ok
      || first.kind !== "operation"
      || (
        first.error.code !== "PROOF_EXPIRED"
        && first.error.code !== "PROOF_INVALID"
      )
    ) return first;
    const negotiation = await this.negotiate(signal);
    if (!negotiation.ok || negotiation.data.outcome !== "accepted") {
      return first;
    }
    return await run();
  }

  #parseAuthority(
    value: SessionSyncProofAuthority,
  ): SessionSyncProofAuthority {
    const membership = syncMembershipCoordinateSchema.parse(value.membership);
    const deviceId = syncDeviceIdSchema.parse(value.deviceId);
    if (value.keys.publicKeys.signing.keyId.length === 0) {
      throw new TypeError("Session sync signing authority is invalid.");
    }
    return { membership, deviceId, keys: value.keys };
  }

  async #proof(input: {
    readonly authority: SessionSyncProofAuthority;
    readonly method: "GET" | "POST";
    readonly route: ReturnType<typeof routeForSessionSyncRequest>;
    readonly body: unknown;
  }) {
    const now = conservativeSessionSyncProofTime({
      localNow: this.#now(),
      monotonicNow: this.#monotonicNow(),
      clock: this.#clock,
    });
    const expiresAt = now + this.#proofTtlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      throw new TypeError("Session sync proof time is invalid.");
    }
    const payload = syncDeviceProofPayloadSchema.parse({
      version: 1,
      ...input.authority.membership,
      deviceId: input.authority.deviceId,
      method: input.method,
      route: input.route,
      bodyDigest: await digestSyncRequestBody(input.body),
      nonce: createSyncProofNonce(),
      issuedAt: encodeSyncUint64(BigInt(now)),
      expiresAt: positiveSyncUint64Schema.parse(
        encodeSyncUint64(BigInt(expiresAt)),
      ),
    });
    return await signSyncDeviceProof(
      payload,
      input.authority.keys.publicKeys.signing.keyId,
      input.authority.keys.signingPrivateKey,
    );
  }
}

function restoreSessionSyncClock(
  persisted: SessionSyncClockCalibration | null,
  localNow: number,
  monotonicNow: number,
): Readonly<{
  serverObservedAt: number;
  monotonicObservedAt: number;
  uncertaintyMs: number;
}> | null {
  if (persisted === null) return null;
  const wallValues = [
    persisted.serverObservedAt,
    persisted.clientObservedAt,
    persisted.uncertaintyMs,
    localNow,
  ];
  if (
    wallValues.some((value) => !Number.isSafeInteger(value) || value < 0)
    || !Number.isFinite(monotonicNow)
    || monotonicNow < 0
    || persisted.uncertaintyMs > MAX_CLOCK_CALIBRATION_RTT_MS
  ) return null;
  const wallElapsed = localNow - persisted.clientObservedAt;
  if (
    wallElapsed < -MAX_PERSISTED_CLOCK_FUTURE_SKEW_MS
    || wallElapsed > MAX_PERSISTED_CLOCK_CALIBRATION_AGE_MS
  ) return null;
  const elapsed = Math.max(0, wallElapsed);
  const serverObservedAt = persisted.serverObservedAt + elapsed;
  if (!Number.isSafeInteger(serverObservedAt)) return null;
  return {
    serverObservedAt,
    monotonicObservedAt: monotonicNow,
    uncertaintyMs: Math.min(
      MAX_CLOCK_CALIBRATION_RTT_MS,
      persisted.uncertaintyMs + Math.max(0, -wallElapsed),
    ),
  };
}

export function conservativeSessionSyncProofTime(input: {
  readonly localNow: number;
  readonly monotonicNow: number;
  readonly clock: Readonly<{
    readonly serverObservedAt: number;
    readonly monotonicObservedAt: number;
    readonly uncertaintyMs: number;
  }> | null;
}): number {
  const localNow = input.localNow;
  if (input.clock === null) {
    if (!Number.isSafeInteger(localNow) || localNow < 0) {
      throw new TypeError("Session sync proof time is invalid.");
    }
    return localNow;
  }
  if (
    !Number.isSafeInteger(input.clock.serverObservedAt)
    || input.clock.serverObservedAt < 0
    || !Number.isFinite(input.clock.monotonicObservedAt)
    || input.clock.monotonicObservedAt < 0
    || !Number.isFinite(input.monotonicNow)
    || input.monotonicNow < 0
  ) {
    throw new TypeError("Session sync proof time is invalid.");
  }
  const elapsed = Math.max(
    0,
    input.monotonicNow - input.clock.monotonicObservedAt,
  );
  const estimate = input.clock.serverObservedAt + elapsed;
  const issuedAt = Math.max(
    0,
    Math.floor(estimate - input.clock.uncertaintyMs),
  );
  if (
    !Number.isFinite(elapsed)
    || !Number.isSafeInteger(issuedAt)
    || input.clock.uncertaintyMs < 0
    || !Number.isSafeInteger(input.clock.uncertaintyMs)
  ) {
    throw new TypeError("Session sync proof time is invalid.");
  }
  return issuedAt;
}
