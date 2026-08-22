import {
  createAgentEnrollmentEnvelopeSchema,
  createAgentEnrollmentRequestSchema,
  createOrganizationEnvelopeSchema,
  createOrganizationRequestSchema,
  credentialTokenSchema,
  enrollmentTokenSchema,
  errorEnvelopeSchema,
  errorHttpStatus,
  getHRARunInteractionReplyAuthorityEnvelopeSchema,
  getHRARunInteractionReplyAuthorityQuerySchema,
  getHRATaskQuerySchema,
  getHRATaskEnvelopeSchema,
  getHRAWorkspaceContextEnvelopeSchema,
  getHRAWorkspaceEnvelopeSchema,
  hraHumanApiRoutes,
  hraHumanHeaders,
  hraProjectionCursorSchema,
  listHRARepositoriesQuerySchema,
  listHRARepositoriesEnvelopeSchema,
  listHRATasksQuerySchema,
  listHRATasksEnvelopeSchema,
  listHRAWorkspacesQuerySchema,
  listHRAWorkspacesEnvelopeSchema,
  listOrganizationsQuerySchema,
  listOrganizationsEnvelopeSchema,
  listWorkspacesQuerySchema,
  listWorkspacesEnvelopeSchema,
  lookupHRATaskQuerySchema,
  lookupHRATaskEnvelopeSchema,
  mutateHRAWorkspaceEnvelopeSchema,
  mutateHRAWorkspaceRequestSchema,
  pollHRAInvalidationsQuerySchema,
  pollHRAInvalidationsEnvelopeSchema,
  parseCredentialToken,
  parseEnrollmentToken,
  refreshAuthEnvelopeSchema,
  refreshAuthRequestSchema,
  redeemEnrollmentEnvelopeSchema,
  redeemEnrollmentRequestSchema,
  respondHRARunInteractionEnvelopeSchema,
  respondHRARunInteractionRequestSchema,
  safeErrorMessage,
  selectHumanScopeEnvelopeSchema,
  selectHumanScopeRequestSchema,
  startSessionEnvelopeSchema,
  startSessionRequestSchema,
  taskctlApiRoutes,
  uuidV7Schema,
  workspacePublicIdSchema,
  type CredentialToken,
  type CreateAgentEnrollmentResponse,
  type EnrollmentToken,
  type ErrorCode,
  type ErrorDetails,
  type GetHRARunInteractionReplyAuthorityResponse,
  type IdempotencyKey,
  type HRAHumanMutationIntent,
  type HRAProjectionCursor,
  type OrganizationView,
  type RequestId,
  type SelectHumanScopeRequest,
  type RedeemEnrollmentResponse,
  type RespondHRARunInteractionRequest,
  type StartSessionResponse,
  type TaskWorkspaceMutationResult,
  type WorkspaceView,
} from "@hraness/agent-tasks-protocol";
import {
  StrictHumanHttpClient,
  type FetchLike,
  type HumanSessionCoordinator,
  type HumanOperationResult,
  type HumanRefreshDriver,
  type HumanSessionResult,
  type StrictJsonResult,
  type WireSchema,
} from "@hraness/hra-human-client";
import type { z } from "@hra-internal/schema";

const DEFAULT_PAGE_LIMIT = 50;
const LONG_POLL_HTTP_TIMEOUT_MS = 35_000;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

type EnvelopeData<Schema extends z.ZodType> =
  z.infer<Schema> extends Readonly<{ data: infer Data }> ? Data : never;

export type HRAWorkspaceList = EnvelopeData<
  typeof listHRAWorkspacesEnvelopeSchema
>;
export type HRAWorkspaceContext = EnvelopeData<
  typeof getHRAWorkspaceContextEnvelopeSchema
>;
export type HRARepositoryPage = EnvelopeData<
  typeof listHRARepositoriesEnvelopeSchema
>;
export type HRATaskPage = EnvelopeData<
  typeof listHRATasksEnvelopeSchema
>;
export type HRATaskLookup = EnvelopeData<
  typeof lookupHRATaskEnvelopeSchema
>;
export type HRATaskDetail = EnvelopeData<
  typeof getHRATaskEnvelopeSchema
>;
export type HRAInvalidationPage = EnvelopeData<
  typeof pollHRAInvalidationsEnvelopeSchema
>;
export type HRAInteractionReplyAuthority =
  GetHRARunInteractionReplyAuthorityResponse;

export interface HRACloudFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: ErrorDetails;
  readonly requestId?: RequestId;
}

export type HRACloudOperation<Value> = HumanOperationResult<
  Value,
  HRACloudFailure
>;
export type HRACloudSessionResult<Value> = HumanSessionResult<
  Value,
  HRACloudFailure
>;

export interface HRAHttpTransportOptions {
  readonly apiUrl: string;
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
}

interface RequestOptions<Request, Value> {
  readonly accessToken: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly responseSchema: WireSchema<{
    readonly ok: true;
    readonly data: Value;
    readonly requestId: RequestId;
  }>;
  readonly body?: {
    readonly value: unknown;
    readonly schema: WireSchema<Request>;
  };
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly idempotencyKey?: IdempotencyKey;
  readonly signal?: AbortSignal;
  readonly longPoll?: boolean;
}

function serviceFailure(
  message: string = safeErrorMessage.SERVICE_UNAVAILABLE,
): HRACloudFailure {
  return {
    code: "SERVICE_UNAVAILABLE",
    message,
    details: {},
  };
}

function routeBindingFailure(): HRACloudOperation<never> {
  return { ok: false, error: serviceFailure() };
}

function mapStrictResult<Value>(
  result: StrictJsonResult<
    {
      readonly ok: true;
      readonly data: Value;
      readonly requestId: RequestId;
    },
    z.infer<typeof errorEnvelopeSchema>
  >,
): HRACloudOperation<Value> {
  if (result.ok) {
    return { ok: true, data: result.data.data };
  }
  if (result.kind === "transport") {
    return { ok: false, error: serviceFailure(result.error.message) };
  }
  const upstream = result.data.error;
  if (errorHttpStatus[upstream.code] !== result.status) {
    return { ok: false, error: serviceFailure() };
  }
  return {
    ok: false,
    error: {
      code: upstream.code,
      message: safeErrorMessage[upstream.code],
      details: upstream.details,
      requestId: upstream.requestId,
    },
  };
}

function boundedPageLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("cloud page limit must be an integer from 1 to 100");
  }
  return limit;
}

function queryNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("cloud query generation must be a nonnegative safe integer");
  }
  return String(value);
}

function abortableFetch(fetch: FetchLike, external?: AbortSignal): FetchLike {
  if (external === undefined) return fetch;
  return async (input, init) => {
    if (external.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const internal = init?.signal;
    const signal = internal === null || internal === undefined
      ? external
      : AbortSignal.any([internal, external]);
    return await fetch(input, { ...init, signal });
  };
}

function cursorFor(
  cursorValue: HRAProjectionCursor | undefined,
  expected: Readonly<{
    scope: HRAProjectionCursor["scope"]["kind"];
    workspaceId?: string;
  }>,
): HRAProjectionCursor | undefined {
  if (cursorValue === undefined) return undefined;
  const cursor = hraProjectionCursorSchema.parse(cursorValue);
  if (
    cursor.scope.kind !== expected.scope ||
    cursor.workspaceId !== expected.workspaceId
  ) {
    throw new TypeError("cloud cursor is bound to another projection");
  }
  return cursor;
}

function validatedQuery(
  schema: WireSchema<unknown>,
  query: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  if (!schema.safeParse(query).success) {
    throw new TypeError("cloud query is invalid");
  }
  return query;
}

/**
 * Raw typed transport. It owns no credential state and never exposes a raw
 * response body. Callers normally use it through `HumanSessionCoordinator`.
 */
export class HRAHumanHttpTransport {
  readonly #apiUrl: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;

  constructor(options: HRAHttpTransportOptions) {
    this.#apiUrl = options.apiUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    // Validate eagerly without issuing a request.
    void this.#client(undefined, false);
  }

  #client(signal: AbortSignal | undefined, longPoll: boolean): StrictHumanHttpClient {
    return new StrictHumanHttpClient({
      apiUrl: this.#apiUrl,
      fetch: abortableFetch(this.#fetch, signal),
      requestTimeoutMs: longPoll
        ? Math.max(this.#requestTimeoutMs, LONG_POLL_HTTP_TIMEOUT_MS)
        : this.#requestTimeoutMs,
    });
  }

  async #request<Request, Value>(
    options: RequestOptions<Request, Value>,
  ): Promise<HRACloudOperation<Value>> {
    const result = await this.#client(options.signal, options.longPoll === true).request({
      method: options.method,
      path: options.path,
      successSchema: options.responseSchema,
      failureSchema: errorEnvelopeSchema,
      bearerToken: options.accessToken,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.body === undefined
        ? {}
        : {
            body: {
              kind: "json" as const,
              value: options.body.value,
              schema: options.body.schema,
            },
          }),
      ...(options.idempotencyKey === undefined
        ? {}
        : {
            headers: {
              [hraHumanHeaders.idempotencyKey]:
                uuidV7Schema.parse(options.idempotencyKey),
            },
          }),
    });
    return mapStrictResult(result);
  }

  async refresh(
    refreshToken: string,
  ): Promise<ReturnType<HumanRefreshDriver["refresh"]> extends Promise<infer Value> ? Value : never> {
    const body = {};
    const result = await this.#client(undefined, false).request({
      method: "POST",
      path: taskctlApiRoutes.refreshAuth,
      successSchema: refreshAuthEnvelopeSchema,
      failureSchema: errorEnvelopeSchema,
      bearerToken: refreshToken,
      body: {
        kind: "json",
        value: body,
        schema: refreshAuthRequestSchema,
      },
    });
    const mapped = mapStrictResult(result);
    if (mapped.ok) return { ok: true, data: mapped.data };
    return {
      ok: false,
      outcome: mapped.error.code === "AUTHENTICATION_FAILED"
        ? "authentication_failed"
        : "indeterminate",
    };
  }

  async selectHumanScope(
    accessToken: string,
    inputValue: SelectHumanScopeRequest,
  ): Promise<HRACloudOperation<EnvelopeData<typeof selectHumanScopeEnvelopeSchema>>> {
    const input = selectHumanScopeRequestSchema.parse(inputValue);
    return await this.#request({
      accessToken,
      method: "POST",
      path: taskctlApiRoutes.selectHumanScope,
      responseSchema: selectHumanScopeEnvelopeSchema,
      body: {
        value: input,
        schema: selectHumanScopeRequestSchema,
      },
    });
  }

  async listOrganizations(
    accessToken: string,
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<HRACloudOperation<EnvelopeData<typeof listOrganizationsEnvelopeSchema>>> {
    return await this.#request({
      accessToken,
      method: "GET",
      path: taskctlApiRoutes.organizations,
      responseSchema: listOrganizationsEnvelopeSchema,
      query: validatedQuery(listOrganizationsQuerySchema, {
        cursor: input.cursor,
        limit: String(boundedPageLimit(input.limit)),
      }),
    });
  }

  async createOrganization(
    accessToken: string,
    input: {
      readonly name: string;
      readonly idempotencyKey: IdempotencyKey;
    },
  ): Promise<HRACloudOperation<EnvelopeData<typeof createOrganizationEnvelopeSchema>>> {
    const body = createOrganizationRequestSchema.parse({ name: input.name });
    return await this.#request({
      accessToken,
      method: "POST",
      path: taskctlApiRoutes.organizations,
      responseSchema: createOrganizationEnvelopeSchema,
      body: { value: body, schema: createOrganizationRequestSchema },
      idempotencyKey: input.idempotencyKey,
    });
  }

  async createAgentEnrollment(
    accessToken: string,
    agentId: string,
    input: {
      readonly workspaceId: string;
      readonly enrollment: EnrollmentToken;
      readonly idempotencyKey: IdempotencyKey;
    },
  ): Promise<HRACloudOperation<CreateAgentEnrollmentResponse>> {
    const workspaceId = workspacePublicIdSchema.parse(input.workspaceId);
    const enrollment = enrollmentTokenSchema.parse(input.enrollment);
    const expectedLocator = parseEnrollmentToken(enrollment)?.locator;
    if (expectedLocator === undefined) {
      throw new TypeError("runner enrollment token is invalid");
    }
    const body = createAgentEnrollmentRequestSchema.parse({
      workspaceId,
      enrollment,
    });
    const result = await this.#request({
      accessToken,
      method: "POST",
      path: taskctlApiRoutes.agentEnrollments(agentId),
      responseSchema: createAgentEnrollmentEnvelopeSchema,
      body: { value: body, schema: createAgentEnrollmentRequestSchema },
      idempotencyKey: input.idempotencyKey,
    });
    return result.ok && result.data.enrollment.locator !== expectedLocator
      ? routeBindingFailure()
      : result;
  }

  async redeemRunnerEnrollment(
    enrollmentValue: EnrollmentToken,
    input: {
      readonly agentId: string;
      readonly credential: CredentialToken;
      readonly idempotencyKey: IdempotencyKey;
    },
  ): Promise<HRACloudOperation<RedeemEnrollmentResponse>> {
    const enrollment = enrollmentTokenSchema.parse(enrollmentValue);
    const credential = credentialTokenSchema.parse(input.credential);
    const expectedCredentialId = parseCredentialToken(credential)?.locator;
    if (expectedCredentialId === undefined) {
      throw new TypeError("runner credential token is invalid");
    }
    const body = redeemEnrollmentRequestSchema.parse({ credential });
    const result = await this.#request({
      accessToken: enrollment,
      method: "POST",
      path: taskctlApiRoutes.redeemEnrollment,
      responseSchema: redeemEnrollmentEnvelopeSchema,
      body: { value: body, schema: redeemEnrollmentRequestSchema },
      idempotencyKey: input.idempotencyKey,
    });
    return result.ok &&
        (
          result.data.agentId !== input.agentId ||
          result.data.credentialId !== expectedCredentialId
        )
      ? routeBindingFailure()
      : result;
  }

  async startRunnerSession(
    credentialValue: CredentialToken,
    idempotencyKey: IdempotencyKey,
  ): Promise<HRACloudOperation<StartSessionResponse>> {
    const credential = credentialTokenSchema.parse(credentialValue);
    const body = startSessionRequestSchema.parse({});
    return await this.#request({
      accessToken: credential,
      method: "POST",
      path: taskctlApiRoutes.sessions,
      responseSchema: startSessionEnvelopeSchema,
      body: { value: body, schema: startSessionRequestSchema },
      idempotencyKey,
    });
  }

  async listAdministrativeWorkspaces(
    accessToken: string,
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<HRACloudOperation<EnvelopeData<typeof listWorkspacesEnvelopeSchema>>> {
    return await this.#request({
      accessToken,
      method: "GET",
      path: taskctlApiRoutes.workspaces,
      responseSchema: listWorkspacesEnvelopeSchema,
      query: validatedQuery(listWorkspacesQuerySchema, {
        cursor: input.cursor,
        limit: String(boundedPageLimit(input.limit)),
      }),
    });
  }

  async listWorkspaces(
    accessToken: string,
    input: {
      readonly cursor?: HRAProjectionCursor;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<HRACloudOperation<HRAWorkspaceList>> {
    const cursor = cursorFor(input.cursor, { scope: "workspaces" });
    return await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.workspaces,
      responseSchema: listHRAWorkspacesEnvelopeSchema,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      query: validatedQuery(listHRAWorkspacesQuerySchema, {
        cursor: cursor?.token,
        limit: String(boundedPageLimit(input.limit)),
      }),
    });
  }

  async getWorkspace(
    accessToken: string,
    workspaceIdValue: string,
  ): Promise<HRACloudOperation<EnvelopeData<typeof getHRAWorkspaceEnvelopeSchema>>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.workspace(workspaceId),
      responseSchema: getHRAWorkspaceEnvelopeSchema,
    });
    return result.ok && result.data.workspace.id !== workspaceId
      ? routeBindingFailure()
      : result;
  }

  async getContext(
    accessToken: string,
    workspaceIdValue: string,
  ): Promise<HRACloudOperation<HRAWorkspaceContext>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.context(workspaceId),
      responseSchema: getHRAWorkspaceContextEnvelopeSchema,
    });
    return result.ok && result.data.workspace.id !== workspaceId
      ? routeBindingFailure()
      : result;
  }

  async listRepositories(
    accessToken: string,
    workspaceIdValue: string,
    input: {
      readonly cursor?: HRAProjectionCursor;
      readonly limit?: number;
    } = {},
  ): Promise<HRACloudOperation<HRARepositoryPage>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const cursor = cursorFor(input.cursor, {
      scope: "repositories",
      workspaceId,
    });
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.repositories(workspaceId),
      responseSchema: listHRARepositoriesEnvelopeSchema,
      query: validatedQuery(listHRARepositoriesQuerySchema, {
        cursor: cursor?.token,
        projectionHead: cursor?.projectionHead === undefined
          ? undefined
          : queryNumber(cursor.projectionHead),
        limit: String(boundedPageLimit(input.limit)),
      }),
    });
    return result.ok &&
        (
          result.data.workspaceId !== workspaceId ||
          (
            cursor !== undefined &&
            result.data.projectionHead !== cursor.projectionHead
          )
        )
      ? routeBindingFailure()
      : result;
  }

  async listTasks(
    accessToken: string,
    workspaceIdValue: string,
    input: {
      readonly view: HRATaskPage["page"]["view"];
      readonly assignedAgentId?: string;
      readonly cursor?: HRAProjectionCursor;
      readonly limit?: number;
    },
  ): Promise<HRACloudOperation<HRATaskPage>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const cursor = cursorFor(input.cursor, {
      scope: "task_list",
      workspaceId,
    });
    if (
      cursor !== undefined &&
      (
        cursor.scope.kind !== "task_list" ||
        cursor.scope.view !== input.view ||
        cursor.scope.assignedAgentId !== input.assignedAgentId
      )
    ) {
      throw new TypeError("task cursor is bound to another task view");
    }
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.tasks(workspaceId),
      responseSchema: listHRATasksEnvelopeSchema,
      query: validatedQuery(listHRATasksQuerySchema, {
        view: input.view,
        assignedAgentId: input.assignedAgentId,
        cursor: cursor?.token,
        projectionHead: cursor?.projectionHead === undefined
          ? undefined
          : queryNumber(cursor.projectionHead),
        limit: String(boundedPageLimit(input.limit)),
      }),
    });
    return result.ok &&
        (
          result.data.page.workspaceId !== workspaceId ||
          (
            cursor !== undefined &&
            result.data.page.projectionRevision !== cursor.projectionHead
          )
        )
      ? routeBindingFailure()
      : result;
  }

  async lookupTask(
    accessToken: string,
    workspaceIdValue: string,
    input: { readonly key: string; readonly projectionHead?: number },
  ): Promise<HRACloudOperation<HRATaskLookup>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.taskLookup(workspaceId),
      responseSchema: lookupHRATaskEnvelopeSchema,
      query: validatedQuery(lookupHRATaskQuerySchema, {
        key: input.key,
        projectionHead: input.projectionHead === undefined
          ? undefined
          : queryNumber(input.projectionHead),
      }),
    });
    return result.ok &&
        (
          result.data.workspaceId !== workspaceId ||
          result.data.key !== input.key ||
          (
            input.projectionHead !== undefined &&
            result.data.projectionHead !== input.projectionHead
          )
        )
      ? routeBindingFailure()
      : result;
  }

  async getTask(
    accessToken: string,
    workspaceIdValue: string,
    taskId: string,
    projectionHead?: number,
  ): Promise<HRACloudOperation<HRATaskDetail>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.task(workspaceId, taskId),
      responseSchema: getHRATaskEnvelopeSchema,
      query: validatedQuery(getHRATaskQuerySchema, {
        projectionHead: projectionHead === undefined
          ? undefined
          : queryNumber(projectionHead),
      }),
    });
    return result.ok &&
        (
          result.data.workspaceId !== workspaceId ||
          result.data.taskId !== taskId ||
          (
            projectionHead !== undefined &&
            result.data.projectionHead !== projectionHead
          )
        )
      ? routeBindingFailure()
      : result;
  }

  async mutate(
    accessToken: string,
    workspaceIdValue: string,
    input: {
      readonly expectedProjectionHead: number;
      readonly intent: HRAHumanMutationIntent;
      readonly idempotencyKey: IdempotencyKey;
    },
  ): Promise<HRACloudOperation<TaskWorkspaceMutationResult>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const body = mutateHRAWorkspaceRequestSchema.parse({
      expectedProjectionHead: input.expectedProjectionHead,
      intent: input.intent,
    });
    const result = await this.#request({
      accessToken,
      method: "POST",
      path: hraHumanApiRoutes.mutations(workspaceId),
      responseSchema: mutateHRAWorkspaceEnvelopeSchema,
      body: { value: body, schema: mutateHRAWorkspaceRequestSchema },
      idempotencyKey: input.idempotencyKey,
    });
    return result.ok &&
        (
          result.data.mutation.workspaceId !== workspaceId ||
          result.data.mutation.operationId !== input.intent.operationId ||
          result.data.mutation.commandKind !== input.intent.kind
        )
      ? routeBindingFailure()
      : result.ok
        ? { ok: true, data: result.data.mutation }
        : result;
  }

  async getInteractionReplyAuthority(
    accessToken: string,
    route: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly interactionId: string;
    },
    input: {
      readonly requestDigest: string;
      readonly projectionHead: number;
    },
  ): Promise<HRACloudOperation<HRAInteractionReplyAuthority>> {
    const workspaceId = workspacePublicIdSchema.parse(route.workspaceId);
    const query = getHRARunInteractionReplyAuthorityQuerySchema.parse({
      requestDigest: input.requestDigest,
      projectionHead: queryNumber(input.projectionHead),
    });
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.interactionReplyAuthority(
        workspaceId,
        route.runId,
        route.interactionId,
      ),
      responseSchema: getHRARunInteractionReplyAuthorityEnvelopeSchema,
      query: {
        requestDigest: query.requestDigest,
        projectionHead: queryNumber(query.projectionHead),
      },
    });
    return result.ok &&
        (
          result.data.workspaceId !== workspaceId ||
          result.data.runId !== route.runId ||
          result.data.interactionId !== route.interactionId ||
          result.data.requestDigest !== query.requestDigest ||
          result.data.projectionHead !== query.projectionHead ||
          result.data.request.id !== route.interactionId ||
          result.data.request.reply.requestDigest !== query.requestDigest
        )
      ? routeBindingFailure()
      : result;
  }

  async respondInteraction(
    accessToken: string,
    route: {
      readonly workspaceId: string;
      readonly runId: string;
      readonly interactionId: string;
    },
    inputValue: RespondHRARunInteractionRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<HRACloudOperation<TaskWorkspaceMutationResult>> {
    const input = respondHRARunInteractionRequestSchema.parse(inputValue);
    const workspaceId = workspacePublicIdSchema.parse(route.workspaceId);
    if (
      input.workspaceId !== workspaceId ||
      input.sealedResponse.workspaceId !== workspaceId
    ) {
      throw new TypeError("sealed interaction route is bound to another workspace");
    }
    const result = await this.#request({
      accessToken,
      method: "POST",
      path: hraHumanApiRoutes.interactionResponse(
        workspaceId,
        route.runId,
        route.interactionId,
      ),
      responseSchema: respondHRARunInteractionEnvelopeSchema,
      body: {
        value: input,
        schema: respondHRARunInteractionRequestSchema,
      },
      idempotencyKey,
    });
    return result.ok &&
        (
          result.data.mutation.workspaceId !== workspaceId ||
          result.data.mutation.operationId !== input.operationId
        )
      ? routeBindingFailure()
      : result.ok
        ? { ok: true, data: result.data.mutation }
        : result;
  }

  async pollInvalidations(
    accessToken: string,
    workspaceIdValue: string,
    input: {
      readonly afterProjectionHead: number;
      readonly cursor?: HRAProjectionCursor;
      readonly limit?: number;
      readonly waitMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<HRACloudOperation<HRAInvalidationPage>> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const cursor = cursorFor(input.cursor, {
      scope: "invalidations",
      workspaceId,
    });
    const result = await this.#request({
      accessToken,
      method: "GET",
      path: hraHumanApiRoutes.invalidations(workspaceId),
      responseSchema: pollHRAInvalidationsEnvelopeSchema,
      query: validatedQuery(pollHRAInvalidationsQuerySchema, {
        afterProjectionHead: queryNumber(input.afterProjectionHead),
        cursor: cursor?.token,
        cursorProjectionHead: cursor?.projectionHead === undefined
          ? undefined
          : queryNumber(cursor.projectionHead),
        limit: String(boundedPageLimit(input.limit)),
        waitMs: queryNumber(input.waitMs ?? 25_000),
      }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      longPoll: true,
    });
    return result.ok &&
        (
          result.data.workspaceId !== workspaceId ||
          result.data.afterProjectionHead !== input.afterProjectionHead ||
          (
            cursor !== undefined &&
            result.data.projectionHead !== cursor.projectionHead
          )
        )
      ? routeBindingFailure()
      : result;
  }
}

export const hraHumanRefreshDriver = (
  transport: HRAHumanHttpTransport,
): HumanRefreshDriver => ({
  refresh: async (input) =>
    await transport.refresh(input.refreshToken),
});

/**
 * Credential-aware client exposed to `main.ts`. Reads and head-bound writes
 * share the reviewed single-flight refresh coordinator.
 */
export class CloudWorkspaceClient {
  readonly #session: HumanSessionCoordinator;
  readonly #transport: HRAHumanHttpTransport;

  constructor(options: {
    readonly session: HumanSessionCoordinator;
    readonly transport: HRAHumanHttpTransport;
  }) {
    this.#session = options.session;
    this.#transport = options.transport;
  }

  listWorkspaces(
    input: Parameters<HRAHumanHttpTransport["listWorkspaces"]>[1] = {},
  ): Promise<HRACloudSessionResult<HRAWorkspaceList>> {
    return this.#session.execute(
      async (token) => await this.#transport.listWorkspaces(token, input),
    );
  }

  createAgentEnrollment(
    agentId: string,
    input: Parameters<HRAHumanHttpTransport["createAgentEnrollment"]>[2],
  ): Promise<HRACloudSessionResult<CreateAgentEnrollmentResponse>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.createAgentEnrollment(token, agentId, input),
    );
  }

  redeemRunnerEnrollment(
    enrollment: EnrollmentToken,
    input: Parameters<HRAHumanHttpTransport["redeemRunnerEnrollment"]>[1],
  ): Promise<HRACloudOperation<RedeemEnrollmentResponse>> {
    return this.#transport.redeemRunnerEnrollment(enrollment, input);
  }

  startRunnerSession(
    credential: CredentialToken,
    idempotencyKey: IdempotencyKey,
  ): Promise<HRACloudOperation<StartSessionResponse>> {
    return this.#transport.startRunnerSession(credential, idempotencyKey);
  }

  getWorkspace(
    workspaceId: string,
  ): Promise<HRACloudSessionResult<EnvelopeData<typeof getHRAWorkspaceEnvelopeSchema>>> {
    return this.#session.execute(
      async (token) => await this.#transport.getWorkspace(token, workspaceId),
    );
  }

  getContext(
    workspaceId: string,
  ): Promise<HRACloudSessionResult<HRAWorkspaceContext>> {
    return this.#session.execute(
      async (token) => await this.#transport.getContext(token, workspaceId),
    );
  }

  listRepositories(
    workspaceId: string,
    input: Parameters<HRAHumanHttpTransport["listRepositories"]>[2] = {},
  ): Promise<HRACloudSessionResult<HRARepositoryPage>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.listRepositories(token, workspaceId, input),
    );
  }

  listTasks(
    workspaceId: string,
    input: Parameters<HRAHumanHttpTransport["listTasks"]>[2],
  ): Promise<HRACloudSessionResult<HRATaskPage>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.listTasks(token, workspaceId, input),
    );
  }

  lookupTask(
    workspaceId: string,
    input: Parameters<HRAHumanHttpTransport["lookupTask"]>[2],
  ): Promise<HRACloudSessionResult<HRATaskLookup>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.lookupTask(token, workspaceId, input),
    );
  }

  getTask(
    workspaceId: string,
    taskId: string,
    projectionHead?: number,
  ): Promise<HRACloudSessionResult<HRATaskDetail>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.getTask(
          token,
          workspaceId,
          taskId,
          projectionHead,
        ),
    );
  }

  mutate(
    workspaceId: string,
    input: Parameters<HRAHumanHttpTransport["mutate"]>[2],
  ): Promise<HRACloudSessionResult<TaskWorkspaceMutationResult>> {
    return this.#session.execute(
      async (token) => await this.#transport.mutate(token, workspaceId, input),
    );
  }

  getInteractionReplyAuthority(
    route: Parameters<
      HRAHumanHttpTransport["getInteractionReplyAuthority"]
    >[1],
    input: Parameters<
      HRAHumanHttpTransport["getInteractionReplyAuthority"]
    >[2],
  ): Promise<HRACloudSessionResult<HRAInteractionReplyAuthority>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.getInteractionReplyAuthority(
          token,
          route,
          input,
        ),
    );
  }

  respondInteraction(
    route: Parameters<HRAHumanHttpTransport["respondInteraction"]>[1],
    input: RespondHRARunInteractionRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<HRACloudSessionResult<TaskWorkspaceMutationResult>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.respondInteraction(
          token,
          route,
          input,
          idempotencyKey,
        ),
    );
  }

  pollInvalidations(
    workspaceId: string,
    input: Parameters<HRAHumanHttpTransport["pollInvalidations"]>[2],
  ): Promise<HRACloudSessionResult<HRAInvalidationPage>> {
    return this.#session.execute(
      async (token) =>
        await this.#transport.pollInvalidations(token, workspaceId, input),
    );
  }
}

export type HumanOrganizationPage = Readonly<{
  organizations: readonly OrganizationView[];
  cursor: string | null;
}>;
export type HumanWorkspacePage = Readonly<{
  workspaces: readonly WorkspaceView[];
  cursor: string | null;
}>;
