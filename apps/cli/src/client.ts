import {
  acceptTaskEnvelopeSchema,
  acceptTaskRequestSchema,
  addTaskCommentEnvelopeSchema,
  addTaskCommentRequestSchema,
  addTaskReferenceRequestSchema,
  assignTaskRequestSchema,
  blockedTasksEnvelopeSchema,
  cancelTaskRequestSchema,
  claimTaskEnvelopeSchema,
  claimTaskRequestSchema,
  clearTaskParentRequestSchema,
  contextEnvelopeSchema,
  createAgentEnvelopeSchema,
  createAgentEnrollmentEnvelopeSchema,
  createAgentEnrollmentRequestSchema,
  createAgentRequestSchema,
  createOrganizationEnvelopeSchema,
  createOrganizationRequestSchema,
  createTaskEnvelopeSchema,
  createTaskRequestSchema,
  createWorkspaceRepositoryRequestSchema,
  createWorkspaceEnvelopeSchema,
  createWorkspaceRequestSchema,
  disableAgentEnvelopeSchema,
  disableAgentRequestSchema,
  deferTaskRequestSchema,
  encodeBlockedTasksQuery,
  encodeReadyTasksQuery,
  errorEnvelopeSchema,
  getAgentEnvelopeSchema,
  getTaskEnvelopeSchema,
  listTaskCommentsEnvelopeSchema,
  listTaskDependenciesEnvelopeSchema,
  listTaskEventsEnvelopeSchema,
  listTaskLabelsEnvelopeSchema,
  listTaskReferencesEnvelopeSchema,
  listTasksEnvelopeSchema,
  listWorkspaceRepositoriesEnvelopeSchema,
  listAgentCredentialsEnvelopeSchema,
  listAgentSessionsEnvelopeSchema,
  listAgentsEnvelopeSchema,
  listOrganizationsEnvelopeSchema,
  listWorkspacesEnvelopeSchema,
  readyTasksEnvelopeSchema,
  redeemEnrollmentEnvelopeSchema,
  redeemEnrollmentRequestSchema,
  refreshAuthEnvelopeSchema,
  refreshAuthRequestSchema,
  rejectTaskEnvelopeSchema,
  rejectTaskRequestSchema,
  revokeAgentCredentialEnvelopeSchema,
  revokeAgentCredentialRequestSchema,
  releaseClaimEnvelopeSchema,
  releaseClaimRequestSchema,
  removeTaskReferenceEnvelopeSchema,
  removeTaskReferenceRequestSchema,
  removeWorkspaceRepositoryEnvelopeSchema,
  removeWorkspaceRepositoryRequestSchema,
  reopenTaskRequestSchema,
  reviewQueueEnvelopeSchema,
  renewClaimEnvelopeSchema,
  renewClaimRequestSchema,
  safeErrorMessage,
  selectHumanScopeEnvelopeSchema,
  selectHumanScopeRequestSchema,
  startSessionEnvelopeSchema,
  startSessionRequestSchema,
  setTaskParentRequestSchema,
  submitTaskEnvelopeSchema,
  submitTaskRequestSchema,
  taskDependencyMutationEnvelopeSchema,
  taskDependencyMutationRequestSchema,
  taskGraphEnvelopeSchema,
  taskLabelMutationRequestSchema,
  taskMutationEnvelopeSchema,
  taskReferenceEnvelopeSchema,
  taskctlApiOperations,
  taskctlApiRoutes,
  taskctlHeaders,
  updateTaskRequestSchema,
  workspaceRepositoryEnvelopeSchema,
  type AcceptTaskRequest,
  type AddTaskCommentRequest,
  type AddTaskCommentResponse,
  type AddTaskReferenceRequest,
  type AssignTaskRequest,
  type BlockedTasksResponse,
  type CancelTaskRequest,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type CreateAgentEnrollmentRequest,
  type CreateAgentEnrollmentResponse,
  type CreateOrganizationRequest,
  type CreateOrganizationResponse,
  type ContextResponse,
  type CreateWorkspaceRepositoryRequest,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type CreateWorkspaceRequest,
  type CreateWorkspaceResponse,
  type CredentialToken,
  type DisableAgentRequest,
  type DisableAgentResponse,
  type EnrollmentToken,
  type ErrorCode,
  type ErrorEnvelope,
  type IdempotencyKey,
  type GetAgentResponse,
  type GetTaskResponse,
  type ListAgentCredentialsResponse,
  type ListAgentSessionsResponse,
  type ListAgentsResponse,
  type ListOrganizationsResponse,
  type ListTaskCommentsResponse,
  type ListTaskDependenciesResponse,
  type ListTaskEventsResponse,
  type ListTaskLabelsResponse,
  type ListTaskReferencesResponse,
  type ListTasksResponse,
  type ListWorkspaceRepositoriesResponse,
  type ListWorkspacesResponse,
  type ReadyTasksResponse,
  type RejectTaskRequest,
  type RedeemEnrollmentResponse,
  type ReleaseClaimRequest,
  type RenewClaimRequest,
  type RequestId,
  type RefreshAuthRequest,
  type RefreshAuthResponse,
  type SelectHumanScopeRequest,
  type SelectHumanScopeResponse,
  type RevokeAgentCredentialRequest,
  type RevokeAgentCredentialResponse,
  type ReopenTaskRequest,
  type ReviewQueueResponse,
  type ReviewTaskResponse,
  type SessionId,
  type StartSessionResponse,
  type SubmitTaskRequest,
  type SubmitTaskResponse,
  type TaskDependencyMutationRequest,
  type TaskDependencyMutationResponse,
  type TaskGraphResponse,
  type TaskKey,
  type TaskLabelMutationRequest,
  type TaskMutationResponse,
  type TaskPriority,
  type TaskReferenceResponse,
  type TaskStatus,
  type TaskType,
  type UpdateTaskRequest,
  type WorkspaceRepositoryResponse,
  type ClaimTaskResponse,
} from "@hraness/agent-tasks-protocol";
import {
  normalizeApiOrigin,
  readBoundedJsonResponse,
  type FetchLike,
} from "@hraness/hra-human-client";

export type { FetchLike } from "@hraness/hra-human-client";

type RenewClaimResponse = ClaimTaskResponse;
type ReleaseClaimResponse = CreateTaskResponse;

const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const REQUEST_TIMED_OUT = Symbol("request timed out");

interface WireSchema<Value> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: Value }
    | { readonly success: false };
}

export interface ClientFailure {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details: ErrorEnvelope["error"]["details"];
  readonly requestId?: RequestId;
}

export type ClientResult<Value> =
  | { readonly ok: true; readonly data: Value; readonly requestId: RequestId }
  | { readonly ok: false; readonly error: ClientFailure };

export interface AgentAuthorization {
  readonly credential: CredentialToken;
  readonly sessionId: SessionId;
}

export interface PaginationQuery {
  readonly cursor?: string;
  readonly limit: number;
}

export interface TaskListQuery extends PaginationQuery {
  readonly status?: TaskStatus;
  readonly type?: TaskType;
  readonly priority?: TaskPriority;
  readonly assigneeAgentId?: string;
  readonly label?: string;
  readonly parentKey?: TaskKey;
  readonly updatedAfter?: number;
}

export interface TaskctlClientOptions {
  readonly apiUrl: string;
  readonly fetch?: FetchLike;
  readonly requestTimeoutMs?: number;
}

interface RequestOptions<Value> {
  readonly path: string;
  readonly method: "GET" | "POST";
  readonly authorization: string;
  readonly responseSchema: WireSchema<{ readonly ok: true; readonly data: Value; readonly requestId: RequestId }>;
  readonly body?: unknown;
  readonly idempotencyKey?: IdempotencyKey;
  readonly sessionId?: SessionId;
  readonly query?: Readonly<Record<string, string | undefined>>;
}

function transportFailure(message: string): ClientResult<never> {
  return {
    ok: false,
    error: { code: "SERVICE_UNAVAILABLE", message, details: {} },
  };
}

export const normalizeApiUrl = normalizeApiOrigin;

async function parseResponseBody(response: Response, signal: AbortSignal): Promise<unknown> {
  const parsed = await readBoundedJsonResponse(response, {
    maxBytes: MAX_RESPONSE_BYTES,
    signal,
  });
  return parsed.ok ? parsed.value : null;
}

export class TaskctlClient {
  readonly #apiUrl: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;

  constructor(options: TaskctlClientOptions) {
    const apiUrl = normalizeApiUrl(options.apiUrl);
    if (apiUrl === null) throw new TypeError("TASKCTL_API_URL must be an absolute HTTP(S) origin");
    const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0 ||
      requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw new TypeError("request timeout must be an integer from 1 to 60000 milliseconds");
    }
    this.#apiUrl = apiUrl;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async #request<Value>(options: RequestOptions<Value>): Promise<ClientResult<Value>> {
    const url = new URL(options.path, `${this.#apiUrl}/`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, value);
    }

    const headers = new Headers({
      [taskctlHeaders.authorization]: `Bearer ${options.authorization}`,
      [taskctlHeaders.contentType]: "application/json",
    });
    if (options.idempotencyKey !== undefined) {
      headers.set(taskctlHeaders.idempotencyKey, options.idempotencyKey);
    }
    if (options.sessionId !== undefined) headers.set(taskctlHeaders.session, options.sessionId);

    const controller = new AbortController();
    let timedOut = false;
    const request = async (): Promise<ClientResult<Value>> => {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: options.method,
          headers,
          redirect: "error",
          signal: controller.signal,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        });
      } catch {
        return transportFailure(
          timedOut ? "the task service request timed out" : "could not reach the task service",
        );
      }

      let body: unknown;
      try {
        body = await parseResponseBody(response, controller.signal);
      } catch {
        return transportFailure("could not read the task service response");
      }
      if (body === null) {
        return transportFailure(
          timedOut
            ? "the task service request timed out"
            : "the task service returned an invalid response",
        );
      }

      if (response.ok) {
        const parsed = options.responseSchema.safeParse(body);
        if (!parsed.success) {
          return transportFailure("the task service returned an invalid success response");
        }
        return { ok: true, data: parsed.data.data, requestId: parsed.data.requestId };
      }

      const parsedError = errorEnvelopeSchema.safeParse(body);
      if (!parsedError.success) {
        return transportFailure("the task service returned an invalid error response");
      }
      return {
        ok: false,
        error: {
          code: parsedError.data.error.code,
          message: safeErrorMessage[parsedError.data.error.code],
          details: parsedError.data.error.details,
          requestId: parsedError.data.error.requestId,
        },
      };
    };

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<typeof REQUEST_TIMED_OUT>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve(REQUEST_TIMED_OUT);
      }, this.#requestTimeoutMs);
    });
    const result = await Promise.race([request(), timeoutResult]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result === REQUEST_TIMED_OUT
      ? transportFailure("the task service request timed out")
      : result;
  }

  async redeemEnrollment(
    enrollment: EnrollmentToken,
    credential: CredentialToken,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<RedeemEnrollmentResponse>> {
    const body = redeemEnrollmentRequestSchema.parse({ credential });
    return await this.#request({
      method: taskctlApiOperations.redeemEnrollment.method,
      path: taskctlApiRoutes.redeemEnrollment,
      authorization: enrollment,
      idempotencyKey,
      body,
      responseSchema: redeemEnrollmentEnvelopeSchema,
    });
  }

  async refreshHumanAuthentication(
    refreshToken: string,
  ): Promise<ClientResult<RefreshAuthResponse>> {
    const body: RefreshAuthRequest = refreshAuthRequestSchema.parse({});
    return await this.#request({
      method: taskctlApiOperations.refreshAuth.method,
      path: taskctlApiRoutes.refreshAuth,
      authorization: refreshToken,
      body,
      responseSchema: refreshAuthEnvelopeSchema,
    });
  }

  async selectHumanScope(
    accessToken: string,
    request: SelectHumanScopeRequest,
  ): Promise<ClientResult<SelectHumanScopeResponse>> {
    const body = selectHumanScopeRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.selectHumanScope.method,
      path: taskctlApiRoutes.selectHumanScope,
      authorization: accessToken,
      body,
      responseSchema: selectHumanScopeEnvelopeSchema,
    });
  }

  async listOrganizations(
    accessToken: string,
    query: { readonly cursor?: string; readonly limit: number },
  ): Promise<ClientResult<ListOrganizationsResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listOrganizations.method,
      path: taskctlApiRoutes.organizations,
      authorization: accessToken,
      query: {
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      responseSchema: listOrganizationsEnvelopeSchema,
    });
  }

  async createOrganization(
    accessToken: string,
    request: CreateOrganizationRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<CreateOrganizationResponse>> {
    const body = createOrganizationRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.createOrganization.method,
      path: taskctlApiRoutes.organizations,
      authorization: accessToken,
      idempotencyKey,
      body,
      responseSchema: createOrganizationEnvelopeSchema,
    });
  }

  async listWorkspaces(
    accessToken: string,
    query: { readonly cursor?: string; readonly limit: number },
  ): Promise<ClientResult<ListWorkspacesResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listWorkspaces.method,
      path: taskctlApiRoutes.workspaces,
      authorization: accessToken,
      query: {
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      responseSchema: listWorkspacesEnvelopeSchema,
    });
  }

  async createWorkspace(
    accessToken: string,
    request: CreateWorkspaceRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<CreateWorkspaceResponse>> {
    const body = createWorkspaceRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.createWorkspace.method,
      path: taskctlApiRoutes.workspaces,
      authorization: accessToken,
      idempotencyKey,
      body,
      responseSchema: createWorkspaceEnvelopeSchema,
    });
  }

  async createAgent(
    accessToken: string,
    request: CreateAgentRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<CreateAgentResponse>> {
    const body = createAgentRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.createAgent.method,
      path: taskctlApiRoutes.agents,
      authorization: accessToken,
      idempotencyKey,
      body,
      responseSchema: createAgentEnvelopeSchema,
    });
  }

  async listAgents(
    accessToken: string,
    query: { readonly workspaceId: string; readonly cursor?: string; readonly limit: number },
  ): Promise<ClientResult<ListAgentsResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listAgents.method,
      path: taskctlApiRoutes.agents,
      authorization: accessToken,
      query: {
        workspaceId: query.workspaceId,
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      responseSchema: listAgentsEnvelopeSchema,
    });
  }

  async getAgent(
    accessToken: string,
    agentId: string,
    workspaceId: string,
  ): Promise<ClientResult<GetAgentResponse>> {
    return await this.#request({
      method: taskctlApiOperations.getAgent.method,
      path: taskctlApiRoutes.agent(agentId),
      authorization: accessToken,
      query: { workspaceId },
      responseSchema: getAgentEnvelopeSchema,
    });
  }

  async createAgentEnrollment(
    accessToken: string,
    agentId: string,
    request: CreateAgentEnrollmentRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<CreateAgentEnrollmentResponse>> {
    const body = createAgentEnrollmentRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.createAgentEnrollment.method,
      path: taskctlApiRoutes.agentEnrollments(agentId),
      authorization: accessToken,
      idempotencyKey,
      body,
      responseSchema: createAgentEnrollmentEnvelopeSchema,
    });
  }

  async listAgentCredentials(
    accessToken: string,
    agentId: string,
    query: { readonly workspaceId: string; readonly cursor?: string; readonly limit: number },
  ): Promise<ClientResult<ListAgentCredentialsResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listAgentCredentials.method,
      path: taskctlApiRoutes.agentCredentials(agentId),
      authorization: accessToken,
      query: {
        workspaceId: query.workspaceId,
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      responseSchema: listAgentCredentialsEnvelopeSchema,
    });
  }

  async revokeAgentCredential(
    accessToken: string,
    agentId: string,
    credentialId: string,
    request: RevokeAgentCredentialRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<RevokeAgentCredentialResponse>> {
    const body = revokeAgentCredentialRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.revokeAgentCredential.method,
      path: taskctlApiRoutes.agentCredentialRevoke(agentId, credentialId),
      authorization: accessToken,
      idempotencyKey,
      body,
      responseSchema: revokeAgentCredentialEnvelopeSchema,
    });
  }

  async listAgentSessions(
    accessToken: string,
    agentId: string,
    query: { readonly workspaceId: string; readonly cursor?: string; readonly limit: number },
  ): Promise<ClientResult<ListAgentSessionsResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listAgentSessions.method,
      path: taskctlApiRoutes.agentSessions(agentId),
      authorization: accessToken,
      query: {
        workspaceId: query.workspaceId,
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      responseSchema: listAgentSessionsEnvelopeSchema,
    });
  }

  async disableAgent(
    accessToken: string,
    agentId: string,
    request: DisableAgentRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<DisableAgentResponse>> {
    const body = disableAgentRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.disableAgent.method,
      path: taskctlApiRoutes.agentDisable(agentId),
      authorization: accessToken,
      idempotencyKey,
      body,
      responseSchema: disableAgentEnvelopeSchema,
    });
  }

  async listWorkspaceRepositories(
    accessToken: string,
    query: PaginationQuery & { readonly workspaceId: string },
  ): Promise<ClientResult<ListWorkspaceRepositoriesResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listWorkspaceRepositories.method,
      path: taskctlApiRoutes.workspaceRepositories,
      authorization: accessToken,
      query: {
        workspaceId: query.workspaceId,
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      responseSchema: listWorkspaceRepositoriesEnvelopeSchema,
    });
  }

  async createWorkspaceRepository(
    accessToken: string,
    request: CreateWorkspaceRepositoryRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<WorkspaceRepositoryResponse>> {
    return await this.#request({
      method: taskctlApiOperations.createWorkspaceRepository.method,
      path: taskctlApiRoutes.workspaceRepositories,
      authorization: accessToken,
      idempotencyKey,
      body: createWorkspaceRepositoryRequestSchema.parse(request),
      responseSchema: workspaceRepositoryEnvelopeSchema,
    });
  }

  async removeWorkspaceRepository(
    accessToken: string,
    repositoryId: string,
    workspaceId: string,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<{ readonly repositoryId: string; readonly removed: true }>> {
    return await this.#request({
      method: taskctlApiOperations.removeWorkspaceRepository.method,
      path: taskctlApiRoutes.workspaceRepositoryRemove(repositoryId),
      authorization: accessToken,
      idempotencyKey,
      body: removeWorkspaceRepositoryRequestSchema.parse({ workspaceId }),
      responseSchema: removeWorkspaceRepositoryEnvelopeSchema,
    });
  }

  async startSession(
    credential: CredentialToken,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<StartSessionResponse>> {
    return await this.#request({
      method: taskctlApiOperations.startSession.method,
      path: taskctlApiRoutes.sessions,
      authorization: credential,
      idempotencyKey,
      body: startSessionRequestSchema.parse({}),
      responseSchema: startSessionEnvelopeSchema,
    });
  }

  async context(authorization: AgentAuthorization): Promise<ClientResult<ContextResponse>> {
    return await this.#request({
      method: taskctlApiOperations.context.method,
      path: taskctlApiRoutes.context,
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      responseSchema: contextEnvelopeSchema,
    });
  }

  async createTask(
    authorization: AgentAuthorization,
    request: CreateTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<CreateTaskResponse>> {
    const body = createTaskRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.createTask.method,
      path: taskctlApiRoutes.tasks,
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body,
      responseSchema: createTaskEnvelopeSchema,
    });
  }

  async getTask(
    authorization: AgentAuthorization,
    key: TaskKey,
  ): Promise<ClientResult<GetTaskResponse>> {
    return await this.#request({
      method: taskctlApiOperations.getTask.method,
      path: taskctlApiRoutes.task(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      responseSchema: getTaskEnvelopeSchema,
    });
  }

  async listTasks(
    authorization: AgentAuthorization,
    query: TaskListQuery,
  ): Promise<ClientResult<ListTasksResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listTasks.method,
      path: taskctlApiRoutes.tasks,
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: {
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.priority === undefined ? {} : { priority: String(query.priority) }),
        ...(query.assigneeAgentId === undefined ? {} : { assigneeAgentId: query.assigneeAgentId }),
        ...(query.label === undefined ? {} : { label: query.label }),
        ...(query.parentKey === undefined ? {} : { parentKey: query.parentKey }),
        ...(query.updatedAfter === undefined ? {} : { updatedAfter: String(query.updatedAfter) }),
      },
      responseSchema: listTasksEnvelopeSchema,
    });
  }

  async blockedTasks(
    authorization: AgentAuthorization,
    query: PaginationQuery & { readonly attentionOnly: boolean },
  ): Promise<ClientResult<BlockedTasksResponse>> {
    const parsed = encodeBlockedTasksQuery(query);
    return await this.#request({
      method: taskctlApiOperations.blockedTasks.method,
      path: taskctlApiRoutes.blockedTasks,
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: Object.fromEntries(parsed),
      responseSchema: blockedTasksEnvelopeSchema,
    });
  }

  async updateTask(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: UpdateTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: taskctlApiOperations.updateTask.method,
      path: taskctlApiRoutes.taskUpdate(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: updateTaskRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async cancelTask(
    accessToken: string,
    key: TaskKey,
    request: CancelTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: taskctlApiOperations.cancelTask.method,
      path: taskctlApiRoutes.taskCancel(key),
      authorization: accessToken,
      idempotencyKey,
      body: cancelTaskRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async reopenTask(
    accessToken: string,
    key: TaskKey,
    request: ReopenTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: taskctlApiOperations.reopenTask.method,
      path: taskctlApiRoutes.taskReopen(key),
      authorization: accessToken,
      idempotencyKey,
      body: reopenTaskRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async assignTask(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: AssignTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: taskctlApiOperations.assignTask.method,
      path: taskctlApiRoutes.taskAssign(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: assignTaskRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async deferTask(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: { readonly revision: number; readonly availableAt: number; readonly fence?: number },
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: taskctlApiOperations.deferTask.method,
      path: taskctlApiRoutes.taskDefer(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: deferTaskRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async listTaskLabels(
    authorization: AgentAuthorization,
    key: TaskKey,
  ): Promise<ClientResult<ListTaskLabelsResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listTaskLabels.method,
      path: taskctlApiRoutes.taskLabels(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      responseSchema: listTaskLabelsEnvelopeSchema,
    });
  }

  async mutateTaskLabel(
    authorization: AgentAuthorization,
    key: TaskKey,
    operation: "add" | "remove",
    request: TaskLabelMutationRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: "POST",
      path:
        operation === "add"
          ? taskctlApiRoutes.taskLabels(key)
          : taskctlApiRoutes.taskLabelRemove(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: taskLabelMutationRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async addTaskComment(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: AddTaskCommentRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<AddTaskCommentResponse>> {
    return await this.#request({
      method: taskctlApiOperations.addTaskComment.method,
      path: taskctlApiRoutes.taskComments(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: addTaskCommentRequestSchema.parse(request),
      responseSchema: addTaskCommentEnvelopeSchema,
    });
  }

  async listTaskComments(
    authorization: AgentAuthorization,
    key: TaskKey,
    query: PaginationQuery,
  ): Promise<ClientResult<ListTaskCommentsResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listTaskComments.method,
      path: taskctlApiRoutes.taskComments(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: { limit: String(query.limit), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
      responseSchema: listTaskCommentsEnvelopeSchema,
    });
  }

  async readyTasks(
    authorization: AgentAuthorization,
    query: { readonly cursor?: string; readonly limit: number },
  ): Promise<ClientResult<ReadyTasksResponse>> {
    const parsed = encodeReadyTasksQuery(query);
    return await this.#request({
      method: taskctlApiOperations.readyTasks.method,
      path: taskctlApiRoutes.readyTasks,
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: Object.fromEntries(parsed),
      responseSchema: readyTasksEnvelopeSchema,
    });
  }

  async listTaskEvents(
    authorization: AgentAuthorization,
    key: TaskKey,
    query: PaginationQuery,
  ): Promise<ClientResult<ListTaskEventsResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listTaskEvents.method,
      path: taskctlApiRoutes.taskEvents(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: { limit: String(query.limit), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
      responseSchema: listTaskEventsEnvelopeSchema,
    });
  }

  async taskGraph(
    authorization: AgentAuthorization,
    key: TaskKey,
    query: { readonly depth: number; readonly limit: number },
  ): Promise<ClientResult<TaskGraphResponse>> {
    return await this.#request({
      method: taskctlApiOperations.taskGraph.method,
      path: taskctlApiRoutes.taskGraph(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: { depth: String(query.depth), limit: String(query.limit) },
      responseSchema: taskGraphEnvelopeSchema,
    });
  }

  async listTaskDependencies(
    authorization: AgentAuthorization,
    key: TaskKey,
    query: PaginationQuery & { readonly direction: "blockers" | "dependents" | "both" },
  ): Promise<ClientResult<ListTaskDependenciesResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listTaskDependencies.method,
      path: taskctlApiRoutes.taskDependencies(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: {
        direction: query.direction,
        limit: String(query.limit),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      },
      responseSchema: listTaskDependenciesEnvelopeSchema,
    });
  }

  async mutateTaskDependency(
    authorization: AgentAuthorization,
    key: TaskKey,
    operation: "add" | "remove",
    request: TaskDependencyMutationRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskDependencyMutationResponse>> {
    return await this.#request({
      method: "POST",
      path:
        operation === "add"
          ? taskctlApiRoutes.taskDependencies(key)
          : taskctlApiRoutes.taskDependencyRemove(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: taskDependencyMutationRequestSchema.parse(request),
      responseSchema: taskDependencyMutationEnvelopeSchema,
    });
  }

  async setTaskParent(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: { readonly revision: number; readonly parentKey: TaskKey; readonly fence?: number },
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: taskctlApiOperations.setTaskParent.method,
      path: taskctlApiRoutes.taskParentSet(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: setTaskParentRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async clearTaskParent(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: { readonly revision: number; readonly fence?: number },
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskMutationResponse>> {
    return await this.#request({
      method: taskctlApiOperations.clearTaskParent.method,
      path: taskctlApiRoutes.taskParentClear(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: clearTaskParentRequestSchema.parse(request),
      responseSchema: taskMutationEnvelopeSchema,
    });
  }

  async listTaskReferences(
    authorization: AgentAuthorization,
    key: TaskKey,
    query: PaginationQuery,
  ): Promise<ClientResult<ListTaskReferencesResponse>> {
    return await this.#request({
      method: taskctlApiOperations.listTaskReferences.method,
      path: taskctlApiRoutes.taskReferences(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: { limit: String(query.limit), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
      responseSchema: listTaskReferencesEnvelopeSchema,
    });
  }

  async addTaskReference(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: AddTaskReferenceRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<TaskReferenceResponse>> {
    return await this.#request({
      method: taskctlApiOperations.addTaskReference.method,
      path: taskctlApiRoutes.taskReferences(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: addTaskReferenceRequestSchema.parse(request),
      responseSchema: taskReferenceEnvelopeSchema,
    });
  }

  async removeTaskReference(
    authorization: AgentAuthorization,
    key: TaskKey,
    referenceId: string,
    request: { readonly revision: number; readonly fence?: number },
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<{ readonly referenceId: string; readonly task: unknown }>> {
    return await this.#request({
      method: taskctlApiOperations.removeTaskReference.method,
      path: taskctlApiRoutes.taskReferenceRemove(key, referenceId),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: removeTaskReferenceRequestSchema.parse(request),
      responseSchema: removeTaskReferenceEnvelopeSchema,
    });
  }

  async claimTask(
    authorization: AgentAuthorization,
    key: TaskKey,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<ClaimTaskResponse>> {
    return await this.#request({
      method: taskctlApiOperations.claimTask.method,
      path: taskctlApiRoutes.claimTask(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: claimTaskRequestSchema.parse({}),
      responseSchema: claimTaskEnvelopeSchema,
    });
  }

  async renewClaim(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: RenewClaimRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<RenewClaimResponse>> {
    const body = renewClaimRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.renewClaim.method,
      path: taskctlApiRoutes.renewClaim(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body,
      responseSchema: renewClaimEnvelopeSchema,
    });
  }

  async releaseClaim(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: ReleaseClaimRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<ReleaseClaimResponse>> {
    const body = releaseClaimRequestSchema.parse(request);
    return await this.#request({
      method: taskctlApiOperations.releaseClaim.method,
      path: taskctlApiRoutes.releaseClaim(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body,
      responseSchema: releaseClaimEnvelopeSchema,
    });
  }

  async submitTask(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: SubmitTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<SubmitTaskResponse>> {
    return await this.#request({
      method: taskctlApiOperations.submitTask.method,
      path: taskctlApiRoutes.submitTask(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: submitTaskRequestSchema.parse(request),
      responseSchema: submitTaskEnvelopeSchema,
    });
  }

  async reviewQueue(
    authorization: AgentAuthorization,
    query: PaginationQuery,
  ): Promise<ClientResult<ReviewQueueResponse>> {
    return await this.#request({
      method: taskctlApiOperations.reviewQueue.method,
      path: taskctlApiRoutes.reviews,
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      query: { limit: String(query.limit), ...(query.cursor === undefined ? {} : { cursor: query.cursor }) },
      responseSchema: reviewQueueEnvelopeSchema,
    });
  }

  async acceptTask(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: AcceptTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<ReviewTaskResponse>> {
    return await this.#request({
      method: taskctlApiOperations.acceptTask.method,
      path: taskctlApiRoutes.acceptTask(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: acceptTaskRequestSchema.parse(request),
      responseSchema: acceptTaskEnvelopeSchema,
    });
  }

  async rejectTask(
    authorization: AgentAuthorization,
    key: TaskKey,
    request: RejectTaskRequest,
    idempotencyKey: IdempotencyKey,
  ): Promise<ClientResult<ReviewTaskResponse>> {
    return await this.#request({
      method: taskctlApiOperations.rejectTask.method,
      path: taskctlApiRoutes.rejectTask(key),
      authorization: authorization.credential,
      sessionId: authorization.sessionId,
      idempotencyKey,
      body: rejectTaskRequestSchema.parse(request),
      responseSchema: rejectTaskEnvelopeSchema,
    });
  }
}
