import { z } from "@hra-internal/schema";
import {
  HRA_DISPATCH_PROTOCOL_VERSION,
  appendRunEventsEnvelopeSchema,
  claimDispatchEnvelopeSchema,
  createBearerSecret,
  createLocator,
  createRunInteractionReplyKeyPair,
  createRunInteractionRequestDigest,
  createUuidV7,
  credentialStatusSchema,
  decodeBearerSecret,
  encodeBase64Url,
  errorEnvelopeSchema,
  errorHttpStatus,
  eventCommandSchema,
  formatCredentialToken,
  formatEnrollmentToken,
  hraDispatchRoutes,
  openRunInteractionResponse,
  redactSecretsInText,
  runInteractionRequestSchema,
  runnerHeartbeatEnvelopeSchema,
  sealRunInteractionResponse,
  syncRunInteractionsEnvelopeSchema,
  taskKeySchema,
  taskViewSchema,
  taskctlApiOperations,
  taskctlApiRoutes,
  taskctlHeaders,
  type AgentScope,
  type appendRunEventsRequestSchema,
  type ClaimTaskResponse,
  type ClaimedDispatch,
  type ContextResponse,
  type CreateTaskRequest,
  type CreateTaskResponse,
  type CredentialToken,
  type EnrollmentToken,
  type ErrorCode,
  type ErrorEnvelope,
  type IdempotencyKey,
  type ReadyTasksResponse,
  type RedeemEnrollmentResponse,
  type RequestId,
  type RunInteractionRequestPayload,
  type RunnerHeartbeatRequest,
  type RunnerHeartbeatResponse,
  type SealedRunInteractionResponse,
  type ReviewQueueResponse,
  type ReviewTaskResponse,
  type SessionId,
  type StartSessionResponse,
  type SubmitTaskRequest,
  type SubmitTaskResponse,
  type SyncRunInteractionsRequest,
  type SyncRunInteractionsResponse,
  type TaskKey,
} from "@hraness/agent-tasks-protocol";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONVEX_BINARY = fileURLToPath(new URL("../node_modules/.bin/convex", import.meta.url));
const ENV_FILE = fileURLToPath(new URL("../.env.local", import.meta.url));
const LOCAL_FIXTURE_ISSUER = "https://taskctl.local.invalid";
const LOCAL_FIXTURE_SUBJECT = "taskctl-local-black-box";
const LOCAL_POLL_TIMEOUT_MS = 20_000;
const LOCAL_POLL_INTERVAL_MS = 75;
const SCOPES = [
  "tasks:read",
  "tasks:create",
  "tasks:edit",
  "tasks:assign",
  "tasks:claim",
  "tasks:submit",
  "tasks:review",
  "dependencies:write",
  "comments:write",
] as const satisfies readonly AgentScope[];
const DISPATCH_SCOPES = [
  "tasks:read",
  "tasks:claim",
  "tasks:submit",
  "runs:report",
  "dispatch:execute",
  "runtime:heartbeat",
] as const satisfies readonly AgentScope[];

interface WireSchema<Value> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: Value }
    | { readonly success: false };
}

interface ParseSchema<Value> {
  parse(value: unknown): Value;
}

type SuccessEnvelope<Value> = {
  readonly ok: true;
  readonly data: Value;
  readonly requestId: RequestId;
};

type HttpResult<Value> =
  | { readonly ok: true; readonly status: number; readonly envelope: SuccessEnvelope<Value> }
  | { readonly ok: false; readonly status: number; readonly envelope: ErrorEnvelope };

type ClaimDispatchResponse = { readonly run: ClaimedDispatch };
type AppendRunEventsRequest = z.infer<typeof appendRunEventsRequestSchema>;
type AppendRunEventsResponse = {
  readonly acceptedThroughSequence: number;
  readonly serverTime: number;
};

interface AgentAuthorization {
  readonly credential: CredentialToken;
  readonly sessionId: SessionId;
}

interface TestAgent {
  readonly agentId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly enrollment: EnrollmentToken;
  readonly enrollmentLocator: string;
  readonly enrollmentDigest: string;
  readonly credential: CredentialToken;
  readonly credentialLocator: string;
  readonly scopes: readonly AgentScope[];
}

interface ActiveTestAgent extends TestAgent {
  readonly sessionId: SessionId;
}

const fixtureIdentity = {
  issuer: LOCAL_FIXTURE_ISSUER,
  subject: LOCAL_FIXTURE_SUBJECT,
  tokenIdentifier: `${LOCAL_FIXTURE_ISSUER}|${LOCAL_FIXTURE_SUBJECT}`,
};

const persistedActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), userId: z.string() }).strict(),
  z
    .object({
      kind: z.literal("agent"),
      agentId: z.string(),
      credentialId: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("system"),
      jobKind: z.enum(["claim_expiry", "defer_wake", "repair", "reconciliation"]),
      sourceId: z.string().optional(),
    })
    .strict(),
]);

const seedResultSchema = z
  .object({
    organizationId: z.string(),
    workspaceId: z.string(),
    agentId: z.string(),
    enrollmentLocator: z.string(),
    enrollmentExpiresAt: z.number(),
  })
  .strict();

const shortenResultSchema = z
  .object({
    taskKey: z.string(),
    fence: z.number().int().positive(),
    leaseGeneration: z.number().int().positive(),
    leaseUntil: z.number().int().nonnegative(),
  })
  .strict();

const inspectResultSchema = z
  .object({
    workspaceId: z.string(),
    rawSecretLikeValueCount: z.number().int().nonnegative(),
    counts: z
      .object({
        enrollments: z.number().int().nonnegative(),
        credentials: z.number().int().nonnegative(),
        sessions: z.number().int().nonnegative(),
        tasks: z.number().int().nonnegative(),
        claims: z.number().int().nonnegative(),
        wakes: z.number().int().nonnegative(),
        taskEvents: z.number().int().nonnegative(),
        securityEvents: z.number().int().nonnegative(),
        receipts: z.number().int().nonnegative(),
        submissions: z.number().int().nonnegative(),
        cancellations: z.number().int().nonnegative(),
      })
      .strict(),
    enrollments: z.array(
      z
        .object({
          locator: z.string(),
          status: z.string(),
          digestEncoding: z.literal("bytes"),
          digestByteLength: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    credentials: z.array(
      z
        .object({
          locator: z.string(),
          status: credentialStatusSchema,
          digestEncoding: z.literal("bytes"),
          digestByteLength: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    sessions: z.array(
      z
        .object({ id: z.string(), status: z.string(), credentialLocator: z.string() })
        .strict(),
    ),
    tasks: z.array(taskViewSchema),
    claims: z.array(
      z
        .object({
          id: z.string(),
          taskId: z.string(),
          state: z.string(),
          fence: z.number().int().positive(),
          leaseGeneration: z.number().int().positive(),
          leaseUntil: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    wakes: z.array(
      z
        .object({
          taskId: z.string(),
          state: z.string(),
          generation: z.number().int().positive(),
          expectedAvailableAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    taskEvents: z.array(
      z
        .object({
          type: z.string(),
          taskId: z.string(),
          taskRevision: z.number().int().positive(),
          actor: persistedActorSchema,
          command: eventCommandSchema,
        })
        .strict(),
    ),
    securityEvents: z.array(
      z
        .object({ type: z.string(), actor: persistedActorSchema, command: eventCommandSchema })
        .strict(),
    ),
    receipts: z.array(
      z
        .object({
          operation: z.string(),
          idempotencyKey: z.string(),
          requestId: z.string(),
        })
        .strict(),
    ),
    submissions: z.array(
      z
        .object({
          id: z.string(),
          taskId: z.string(),
          status: z.string(),
          submittedByAgentId: z.string(),
          reviewRevision: z.number().int().positive(),
          summary: z.string(),
          reviewReason: z.string().optional(),
          cancellationReason: z.string().optional(),
        })
        .strict(),
    ),
    cancellations: z.array(
      z
        .object({
          taskId: z.string(),
          reason: z.string(),
          cancelledAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

const revokeResultSchema = z.object({ revoked: z.boolean() }).strict();
const rateLimitBucketSchema = z
  .object({
    subjectKind: z.enum(["credential", "workspace", "user", "unauthenticated"]),
    subjectKey: z.string(),
    routeClass: z.enum([
      "refresh_auth",
      "agent_read",
      "agent_write",
      "agent_claim",
      "agent_review",
      "agent_session",
      "human_read",
      "human_mutation",
      "agent_auth_failure",
      "enrollment_auth_failure",
    ]),
    windowStartedAt: z.number().int().nonnegative(),
    shard: z.number().int().nonnegative(),
    count: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();
const resetApiRateLimitsResultSchema = z.object({ deleted: z.number().int().nonnegative() }).strict();
const validateApiRateLimitSubjectsResultSchema = z
  .object({
    total: z.number().int().nonnegative(),
    authenticated: z.number().int().nonnegative(),
    credentials: z.number().int().nonnegative(),
    workspaces: z.number().int().nonnegative(),
    users: z.number().int().nonnegative(),
    unauthenticated: z.number().int().nonnegative(),
    refreshRows: z.number().int().nonnegative(),
    refreshSlots: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
  })
  .strict();

const seededDispatchSchema = z
  .object({
    workspaceId: z.string(),
    taskId: z.string(),
    taskKey: taskKeySchema,
    repositoryId: z.string(),
    runId: z.string(),
  })
  .strict();

const queuedDispatchReadinessSchema = z
  .object({
    runId: z.string(),
    phase: z.literal("queued"),
    availableAt: z.number().int().nonnegative(),
    taskRevision: z.number().int().positive(),
    queuedTaskRevision: z.number().int().positive(),
    taskIsReady: z.boolean(),
    taskReadyNow: z.boolean(),
  })
  .strict();

const dispatchTaskBodyPresenceSchema = z
  .object({ present: z.boolean(), bodyCount: z.number().int().min(0).max(1) })
  .strict();

const shortenedDispatchSchema = z
  .object({
    workspaceId: z.string(),
    runId: z.string(),
    phase: z.enum(["leased", "provisioning", "starting", "running", "waiting", "cancel_requested"]),
    leaseGeneration: z.number().int().positive(),
    leaseUntil: z.number().int().nonnegative(),
  })
  .strict();

const agedSubmittedClaimSchema = z.object({
  workspaceId: z.string(),
  runId: z.string(),
  endedAt: z.number().int().nonnegative(),
}).strict();

const shortenedRunnerAuthoritySchema = z
  .object({
    workspaceId: z.string(),
    runnerId: z.string(),
    installationId: z.string(),
    generation: z.number().int().positive(),
    leaseUntil: z.number().int().nonnegative(),
  })
  .strict();

const clearedRunnerHeartbeatResponseSchema = z.object({
  workspaceId: z.string(),
  runnerId: z.string(),
  cleared: z.boolean(),
}).strict();

const duplicatedRunnerCapabilitySchema = z.object({
  workspaceId: z.string(),
  runnerId: z.string(),
  repositoryId: z.string(),
  duplicateCount: z.literal(2),
}).strict();

const repairedRunnerCapabilitiesSchema = z.object({
  deleted: z.number().int().positive(),
}).strict();

const seededSealedInteractionResponseSchema = z
  .object({
    workspaceId: z.string(),
    runId: z.string(),
    interactionId: z.string(),
    responseRevision: z.number().int().positive(),
  })
  .strict();

const dispatchInteractionInspectionSchema = z
  .object({
    workspaceId: z.string(),
    runId: z.string(),
    interactionId: z.string(),
    state: z.enum(["pending", "answered", "resolved", "expired"]),
    responseRevision: z.number().int().positive().optional(),
    responseRowCount: z.number().int().nonnegative(),
    plaintextResponseFieldCount: z.number().int().nonnegative(),
  })
  .strict();

const dispatchInspectionSchema = z
  .object({
    workspaceId: z.string(),
    authority: z
      .object({
        runnerId: z.string(),
        installationId: z.string(),
        generation: z.number().int().positive(),
        leaseUntil: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    repositories: z.array(
      z.object({ id: z.string(), status: z.enum(["active", "removed"]) }).strict(),
    ),
    runners: z.array(
      z
        .object({
          id: z.string(),
          bootId: z.string(),
          bootGeneration: z.number().int().positive(),
          sequence: z.number().int().positive(),
          reportedState: z.enum(["starting", "ready", "busy", "degraded"]),
          leaseUntil: z.number().int().nonnegative(),
          repositoryIds: z.array(z.string()),
        })
        .strict(),
    ),
    dispatches: z.array(
      z
        .object({
          runId: z.string(),
          taskId: z.string(),
          taskKey: taskKeySchema,
          repositoryId: z.string(),
          phase: z.enum([
            "queued",
            "leased",
            "provisioning",
            "starting",
            "running",
            "waiting",
            "submitted",
            "failed",
            "cancel_requested",
            "cancelled",
            "ambiguous",
          ]),
          desiredState: z.enum(["run", "stop"]),
          acceptedThroughSequence: z.number().int().nonnegative(),
          runnerId: z.string().optional(),
          claimId: z.string().optional(),
          claimFence: z.number().int().positive().optional(),
          leaseGeneration: z.number().int().positive().optional(),
          leaseUntil: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
    events: z.array(
      z
        .object({
          runId: z.string(),
          id: z.string(),
          sequence: z.number().int().positive(),
          kind: z.string(),
        })
        .strict(),
    ),
    claims: z.array(
      z
        .object({
          id: z.string(),
          taskId: z.string(),
          state: z.enum(["active", "submitted", "released", "expired", "replaced"]),
          fence: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual<Value>(actual: Value, expected: Value, message: string): void {
  if (!Object.is(actual, expected)) throw new Error(message);
}

function assertJsonEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message);
}

function logStep(message: string): void {
  console.log(`  ${message}`);
}

function deterministicBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + 3_266_489_917) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const owned = new Uint8Array(bytes.length);
  owned.set(bytes);
  return owned.buffer;
}

function unknownCredentialToken(seed: number): CredentialToken {
  return formatCredentialToken(
    createLocator(deterministicBytes(seed, 26)),
    createBearerSecret(deterministicBytes(seed + 1, 32)),
  );
}

function unknownEnrollmentToken(seed: number): EnrollmentToken {
  return formatEnrollmentToken(
    createLocator(deterministicBytes(seed, 26)),
    createBearerSecret(deterministicBytes(seed + 1, 32)),
  );
}

async function hmacSha256Base64Url(key: string, message: string): Promise<string> {
  const keyBytes = decodeBearerSecret(key);
  const messageBytes = decodeBearerSecret(message);
  assert(keyBytes !== null && messageBytes !== null, "Synthetic HMAC material is invalid.");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    ownedArrayBuffer(keyBytes),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, ownedArrayBuffer(messageBytes));
  return encodeBase64Url(new Uint8Array(digest));
}

let idempotencyCounter = 0;

function nextIdempotencyKey(): IdempotencyKey {
  idempotencyCounter += 1;
  return createUuidV7(Date.now(), deterministicBytes(0x51f15e + idempotencyCounter, 10));
}

async function readDotEnv(): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const file = Bun.file(ENV_FILE);
  if (!(await file.exists())) return values;
  for (const rawLine of (await file.text()).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }
  return values;
}

function localSiteOrigin(candidate: string | undefined): string | null {
  if (candidate === undefined || candidate.length === 0) return null;
  try {
    const url = new URL(candidate);
    const isLoopback =
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (
      !isLoopback ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function deploymentConfiguration(): Promise<{ readonly siteOrigin: string }> {
  const dotEnv = await readDotEnv();
  const deployment = process.env.CONVEX_DEPLOYMENT ?? dotEnv.get("CONVEX_DEPLOYMENT");
  assert(
    deployment?.startsWith("anonymous:") === true,
    "The local acceptance test requires an anonymous Convex deployment.",
  );
  const candidates = [
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL,
    process.env.CONVEX_SITE_URL,
    dotEnv.get("NEXT_PUBLIC_CONVEX_SITE_URL"),
    dotEnv.get("CONVEX_SITE_URL"),
  ];
  const siteOrigin = candidates.map(localSiteOrigin).find((value) => value !== null) ?? null;
  assert(siteOrigin !== null, "The anonymous local Convex HTTP origin is unavailable.");
  return { siteOrigin };
}

async function spawnConvex(
  args: readonly string[],
  options: { readonly captureJson?: boolean } = {},
): Promise<unknown> {
  const child = Bun.spawn([CONVEX_BINARY, ...args], {
    cwd: WEB_ROOT,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  if (exitCode !== 0) {
    const detail = redactSecretsInText(stderr.trim()).slice(0, 1_000);
    throw new Error(`Convex CLI command failed${detail.length === 0 ? "." : `: ${detail}`}`);
  }
  if (options.captureJson !== true) return undefined;
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const firstObject = trimmed.indexOf("{");
    const lastObject = trimmed.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return JSON.parse(trimmed.slice(firstObject, lastObject + 1)) as unknown;
      } catch {
        // Fall through to the fixed, secret-free boundary error below.
      }
    }
    throw new Error("Convex CLI returned a non-JSON fixture response.");
  }
}

async function setConvexEnvironment(name: string, value: string): Promise<void> {
  await spawnConvex(["env", "set", name, value]);
}

async function runFixture<Value>(
  functionName: string,
  args: Readonly<Record<string, unknown>>,
  schema: ParseSchema<Value>,
): Promise<Value> {
  const result = await spawnConvex(
    [
      "run",
      functionName,
      JSON.stringify(args),
      "--identity",
      JSON.stringify(fixtureIdentity),
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
    ],
    { captureJson: true },
  );
  try {
    return schema.parse(result);
  } catch {
    throw new Error(`Convex fixture ${functionName} returned an invalid result.`);
  }
}

async function expectFixtureInvocationDenied(
  functionName: string,
  args: Readonly<Record<string, unknown>>,
  identity?: Readonly<Record<string, string>>,
): Promise<void> {
  const command = ["run", functionName, JSON.stringify(args)];
  if (identity !== undefined) command.push("--identity", JSON.stringify(identity));
  command.push("--typecheck", "disable", "--codegen", "disable");
  let denied = false;
  try {
    await spawnConvex(command);
  } catch {
    denied = true;
  }
  assert(denied, `Convex fixture ${functionName} accepted a missing or incorrect identity.`);
}

async function parseHttpBody(response: Response): Promise<unknown> {
  const text = await response.text();
  assert(new TextEncoder().encode(text).length <= 2 * 1_024 * 1_024, "HTTP response exceeded 2 MiB.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The public API returned a non-JSON response.");
  }
}

async function apiRequest<Value>(options: {
  readonly siteOrigin: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly authorization: EnrollmentToken | CredentialToken;
  readonly responseSchema: WireSchema<SuccessEnvelope<Value>>;
  readonly body?: unknown;
  readonly sessionId?: SessionId;
  readonly idempotencyKey?: IdempotencyKey;
  readonly query?: URLSearchParams;
}): Promise<HttpResult<Value>> {
  const url = new URL(options.path, `${options.siteOrigin}/`);
  if (options.query !== undefined) url.search = options.query.toString();
  const headers = new Headers({
    [taskctlHeaders.authorization]: `Bearer ${options.authorization}`,
    [taskctlHeaders.contentType]: "application/json",
  });
  if (options.sessionId !== undefined) headers.set(taskctlHeaders.session, options.sessionId);
  if (options.idempotencyKey !== undefined) {
    headers.set(taskctlHeaders.idempotencyKey, options.idempotencyKey);
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new Error("The local Convex HTTP API could not be reached.");
  }
  const contentType = response.headers.get("content-type");
  assert(contentType?.startsWith("application/json") === true, "The public API omitted its JSON content type.");
  const body = await parseHttpBody(response);
  if (response.ok) {
    const parsed = options.responseSchema.safeParse(body);
    assert(parsed.success, "The public API returned an invalid success envelope.");
    return { ok: true, status: response.status, envelope: parsed.data };
  }
  const parsed = errorEnvelopeSchema.safeParse(body);
  assert(parsed.success, "The public API returned an invalid error envelope.");
  return { ok: false, status: response.status, envelope: parsed.data };
}

async function authenticatedGet<Value>(options: {
  readonly siteOrigin: string;
  readonly auth: AgentAuthorization;
  readonly path: string;
  readonly responseSchema: WireSchema<SuccessEnvelope<Value>>;
  readonly query?: URLSearchParams;
}): Promise<HttpResult<Value>> {
  return await apiRequest({
    siteOrigin: options.siteOrigin,
    method: "GET",
    path: options.path,
    authorization: options.auth.credential,
    sessionId: options.auth.sessionId,
    responseSchema: options.responseSchema,
    ...(options.query === undefined ? {} : { query: options.query }),
  });
}

async function authenticatedPost<Value>(options: {
  readonly siteOrigin: string;
  readonly auth: AgentAuthorization;
  readonly path: string;
  readonly body: unknown;
  readonly responseSchema: WireSchema<SuccessEnvelope<Value>>;
  readonly idempotencyKey?: IdempotencyKey;
}): Promise<HttpResult<Value>> {
  return await apiRequest({
    siteOrigin: options.siteOrigin,
    method: "POST",
    path: options.path,
    authorization: options.auth.credential,
    sessionId: options.auth.sessionId,
    idempotencyKey: options.idempotencyKey ?? nextIdempotencyKey(),
    body: options.body,
    responseSchema: options.responseSchema,
  });
}

function expectSuccess<Value>(result: HttpResult<Value>, label: string): SuccessEnvelope<Value> {
  if (!result.ok) throw new Error(`${label} failed with ${result.envelope.error.code}.`);
  assertEqual(result.status, 200, `${label} returned an unexpected success status.`);
  return result.envelope;
}

function expectError<Value>(
  result: HttpResult<Value>,
  code: ErrorCode,
  label: string,
): ErrorEnvelope {
  if (result.ok) throw new Error(`${label} unexpectedly succeeded.`);
  assertEqual(result.envelope.error.code, code, `${label} returned the wrong error code.`);
  assertEqual(result.status, errorHttpStatus[code], `${label} returned the wrong HTTP status.`);
  return result.envelope;
}

function authorization(agent: ActiveTestAgent): AgentAuthorization {
  return { credential: agent.credential, sessionId: agent.sessionId };
}

async function redeemEnrollment(
  siteOrigin: string,
  agent: TestAgent,
  idempotencyKey: IdempotencyKey,
): Promise<HttpResult<RedeemEnrollmentResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.redeemEnrollment.method,
    path: taskctlApiRoutes.redeemEnrollment,
    authorization: agent.enrollment,
    idempotencyKey,
    body: { credential: agent.credential },
    responseSchema: taskctlApiOperations.redeemEnrollment.responseSchema,
  });
}

async function startSession(
  siteOrigin: string,
  agent: TestAgent,
): Promise<HttpResult<StartSessionResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.startSession.method,
    path: taskctlApiRoutes.sessions,
    authorization: agent.credential,
    idempotencyKey: nextIdempotencyKey(),
    body: {},
    responseSchema: taskctlApiOperations.startSession.responseSchema,
  });
}

async function context(
  siteOrigin: string,
  auth: AgentAuthorization,
): Promise<HttpResult<ContextResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.context.method,
    path: taskctlApiRoutes.context,
    authorization: auth.credential,
    sessionId: auth.sessionId,
    responseSchema: taskctlApiOperations.context.responseSchema,
  });
}

async function createTask(
  siteOrigin: string,
  auth: AgentAuthorization,
  request: CreateTaskRequest,
  idempotencyKey: IdempotencyKey = nextIdempotencyKey(),
): Promise<HttpResult<CreateTaskResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.createTask.method,
    path: taskctlApiRoutes.tasks,
    authorization: auth.credential,
    sessionId: auth.sessionId,
    idempotencyKey,
    body: request,
    responseSchema: taskctlApiOperations.createTask.responseSchema,
  });
}

async function readyTasks(
  siteOrigin: string,
  auth: AgentAuthorization,
  options: { readonly cursor?: string; readonly limit?: number } = {},
): Promise<HttpResult<ReadyTasksResponse>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 100) });
  if (options.cursor !== undefined) query.set("cursor", options.cursor);
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.readyTasks.method,
    path: taskctlApiRoutes.readyTasks,
    authorization: auth.credential,
    sessionId: auth.sessionId,
    query,
    responseSchema: taskctlApiOperations.readyTasks.responseSchema,
  });
}

async function collectReadyTasks(
  siteOrigin: string,
  auth: AgentAuthorization,
  limit: number,
  maximumPages = 20,
): Promise<{ readonly tasks: ReadyTasksResponse["tasks"]; readonly pageCount: number }> {
  const tasks: ReadyTasksResponse["tasks"] = [];
  const taskIds = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;
  do {
    pageCount += 1;
    assert(pageCount <= maximumPages, `Ready pagination did not terminate within ${maximumPages} pages.`);
    const page = expectSuccess(
      await readyTasks(siteOrigin, auth, {
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      }),
      `Ready page ${pageCount}`,
    );
    for (const task of page.data.tasks) {
      assert(!taskIds.has(task.id), `Ready pagination duplicated task ${task.key}.`);
      taskIds.add(task.id);
      tasks.push(task);
    }
    cursor = page.data.cursor ?? undefined;
  } while (cursor !== undefined);
  return { tasks, pageCount };
}

async function claimTask(
  siteOrigin: string,
  auth: AgentAuthorization,
  key: TaskKey,
  idempotencyKey: IdempotencyKey = nextIdempotencyKey(),
): Promise<HttpResult<ClaimTaskResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.claimTask.method,
    path: taskctlApiRoutes.claimTask(key),
    authorization: auth.credential,
    sessionId: auth.sessionId,
    idempotencyKey,
    body: {},
    responseSchema: taskctlApiOperations.claimTask.responseSchema,
  });
}

async function submitTask(
  siteOrigin: string,
  auth: AgentAuthorization,
  key: TaskKey,
  request: SubmitTaskRequest,
  idempotencyKey: IdempotencyKey = nextIdempotencyKey(),
): Promise<HttpResult<SubmitTaskResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.submitTask.method,
    path: taskctlApiRoutes.submitTask(key),
    authorization: auth.credential,
    sessionId: auth.sessionId,
    idempotencyKey,
    body: request,
    responseSchema: taskctlApiOperations.submitTask.responseSchema,
  });
}

async function reviewQueue(
  siteOrigin: string,
  auth: AgentAuthorization,
  limit = 100,
): Promise<HttpResult<ReviewQueueResponse>> {
  return await authenticatedGet({
    siteOrigin,
    auth,
    path: taskctlApiRoutes.reviews,
    query: new URLSearchParams({ limit: String(limit) }),
    responseSchema: taskctlApiOperations.reviewQueue.responseSchema,
  });
}

async function acceptTask(
  siteOrigin: string,
  auth: AgentAuthorization,
  key: TaskKey,
  request: { readonly submissionId: string; readonly reviewRevision: number },
  idempotencyKey: IdempotencyKey = nextIdempotencyKey(),
): Promise<HttpResult<ReviewTaskResponse>> {
  return await authenticatedPost({
    siteOrigin,
    auth,
    path: taskctlApiRoutes.acceptTask(key),
    body: request,
    responseSchema: taskctlApiOperations.acceptTask.responseSchema,
    idempotencyKey,
  });
}

async function rejectTask(
  siteOrigin: string,
  auth: AgentAuthorization,
  key: TaskKey,
  request: {
    readonly submissionId: string;
    readonly reviewRevision: number;
    readonly reason: string;
  },
  idempotencyKey: IdempotencyKey = nextIdempotencyKey(),
): Promise<HttpResult<ReviewTaskResponse>> {
  return await authenticatedPost({
    siteOrigin,
    auth,
    path: taskctlApiRoutes.rejectTask(key),
    body: request,
    responseSchema: taskctlApiOperations.rejectTask.responseSchema,
    idempotencyKey,
  });
}

async function renewClaim(
  siteOrigin: string,
  auth: AgentAuthorization,
  key: TaskKey,
  fence: number,
): Promise<HttpResult<ClaimTaskResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.renewClaim.method,
    path: taskctlApiRoutes.renewClaim(key),
    authorization: auth.credential,
    sessionId: auth.sessionId,
    idempotencyKey: nextIdempotencyKey(),
    body: { fence },
    responseSchema: taskctlApiOperations.renewClaim.responseSchema,
  });
}

async function releaseClaim(
  siteOrigin: string,
  auth: AgentAuthorization,
  key: TaskKey,
  fence: number,
): Promise<HttpResult<CreateTaskResponse>> {
  return await apiRequest({
    siteOrigin,
    method: taskctlApiOperations.releaseClaim.method,
    path: taskctlApiRoutes.releaseClaim(key),
    authorization: auth.credential,
    sessionId: auth.sessionId,
    idempotencyKey: nextIdempotencyKey(),
    body: { fence },
    responseSchema: taskctlApiOperations.releaseClaim.responseSchema,
  });
}

async function runnerHeartbeat(
  siteOrigin: string,
  auth: AgentAuthorization,
  request: RunnerHeartbeatRequest,
): Promise<HttpResult<RunnerHeartbeatResponse>> {
  return await apiRequest({
    siteOrigin,
    method: "POST",
    path: hraDispatchRoutes.heartbeat,
    authorization: auth.credential,
    sessionId: auth.sessionId,
    body: request,
    responseSchema: runnerHeartbeatEnvelopeSchema,
  });
}

async function claimDispatch(
  siteOrigin: string,
  auth: AgentAuthorization,
  request: {
    readonly runnerId: string;
    readonly bootId: string;
    readonly bootGeneration: number;
    readonly taskKey: TaskKey;
    readonly repositoryId: string;
  },
): Promise<HttpResult<ClaimDispatchResponse>> {
  return await apiRequest({
    siteOrigin,
    method: "POST",
    path: hraDispatchRoutes.claim,
    authorization: auth.credential,
    sessionId: auth.sessionId,
    body: request,
    responseSchema: claimDispatchEnvelopeSchema,
  });
}

async function appendRunEvents(
  siteOrigin: string,
  auth: AgentAuthorization,
  runId: string,
  request: AppendRunEventsRequest,
): Promise<HttpResult<AppendRunEventsResponse>> {
  return await apiRequest({
    siteOrigin,
    method: "POST",
    path: hraDispatchRoutes.events(runId),
    authorization: auth.credential,
    sessionId: auth.sessionId,
    body: request,
    responseSchema: appendRunEventsEnvelopeSchema,
  });
}

async function syncRunInteractions(
  siteOrigin: string,
  auth: AgentAuthorization,
  runId: string,
  request: SyncRunInteractionsRequest,
): Promise<HttpResult<SyncRunInteractionsResponse>> {
  return await apiRequest({
    siteOrigin,
    method: "POST",
    path: hraDispatchRoutes.interactions(runId),
    authorization: auth.credential,
    sessionId: auth.sessionId,
    body: request,
    responseSchema: syncRunInteractionsEnvelopeSchema,
  });
}

async function seedQueuedDispatch(args: {
  readonly workspaceId: string;
  readonly repositoryId: string;
  readonly title: string;
  readonly availableAt?: number;
}) {
  return await runFixture(
    "localFixtures:seedQueuedDispatch",
    args,
    seededDispatchSchema,
  );
}

async function inspectQueuedDispatchReadiness(args: {
  readonly workspaceId: string;
  readonly runId: string;
}) {
  return await runFixture(
    "localFixtures:inspectQueuedDispatchReadiness",
    args,
    queuedDispatchReadinessSchema,
  );
}

async function setDispatchTaskBodyPresence(args: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly present: boolean;
}) {
  return await runFixture(
    "localFixtures:setDispatchTaskBodyPresence",
    args,
    dispatchTaskBodyPresenceSchema,
  );
}

async function inspectDispatchWorkspace(workspaceId: string) {
  return await runFixture(
    "localFixtures:inspectDispatchWorkspace",
    { workspaceId },
    dispatchInspectionSchema,
  );
}

async function shortenDispatchLease(args: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly delayMs: number;
}) {
  return await runFixture(
    "localFixtures:shortenDispatchLease",
    { ...args, scheduleExpiry: true },
    shortenedDispatchSchema,
  );
}

async function ageSubmittedDispatchClaim(args: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly ageMs: number;
}) {
  return await runFixture(
    "localFixtures:ageSubmittedDispatchClaim",
    args,
    agedSubmittedClaimSchema,
  );
}

async function shortenRunnerAuthorityLease(args: {
  readonly workspaceId: string;
  readonly delayMs: number;
}) {
  return await runFixture(
    "localFixtures:shortenRunnerAuthorityLease",
    args,
    shortenedRunnerAuthoritySchema,
  );
}

async function duplicateRunnerCapability(args: {
  readonly workspaceId: string;
  readonly runnerId: string;
}) {
  return await runFixture(
    "localFixtures:duplicateRunnerCapability",
    args,
    duplicatedRunnerCapabilitySchema,
  );
}

async function clearRunnerHeartbeatResponse(args: {
  readonly workspaceId: string;
  readonly runnerId: string;
}) {
  return await runFixture(
    "localFixtures:clearRunnerHeartbeatResponse",
    args,
    clearedRunnerHeartbeatResponseSchema,
  );
}

async function repairRunnerCapabilities(args: {
  readonly workspaceId: string;
  readonly runnerId: string;
}) {
  return await runFixture(
    "localFixtures:repairRunnerCapabilities",
    args,
    repairedRunnerCapabilitiesSchema,
  );
}

async function seedSealedDispatchInteractionResponse(args: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly interactionId: string;
  readonly sealedResponse: SealedRunInteractionResponse;
}) {
  return await runFixture(
    "localFixtures:seedSealedDispatchInteractionResponse",
    args,
    seededSealedInteractionResponseSchema,
  );
}

async function inspectDispatchInteraction(args: {
  readonly workspaceId: string;
  readonly runId: string;
  readonly interactionId: string;
}) {
  return await runFixture(
    "localFixtures:inspectDispatchInteraction",
    args,
    dispatchInteractionInspectionSchema,
  );
}

function dispatchById(
  inspection: z.infer<typeof dispatchInspectionSchema>,
  runId: string,
) {
  const dispatch = inspection.dispatches.find((candidate) => candidate.runId === runId);
  assert(dispatch !== undefined, `Dispatch inspection did not contain ${runId}.`);
  return dispatch;
}

async function waitUntil<Value>(
  label: string,
  probe: () => Promise<Value | null>,
  timeoutMs = LOCAL_POLL_TIMEOUT_MS,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error: unknown) {
      lastError = error;
    }
    await Bun.sleep(LOCAL_POLL_INTERVAL_MS);
  }
  if (lastError instanceof Error) {
    throw new Error(`${label} did not converge: ${redactSecretsInText(lastError.message)}`);
  }
  throw new Error(`${label} did not converge within ${timeoutMs}ms.`);
}

async function waitPast(timestamp: number, extraMs: number): Promise<void> {
  const remaining = timestamp + extraMs - Date.now();
  if (remaining > 0) await Bun.sleep(Math.min(remaining, LOCAL_POLL_TIMEOUT_MS));
  assert(Date.now() >= timestamp, "The local clock did not reach the fixture deadline.");
}

async function makeAgent(
  runSeed: number,
  offset: number,
  organizationId: string,
  workspaceId: string,
  agentId: string,
  enrollmentPepper: string,
  scopes: readonly AgentScope[] = SCOPES,
): Promise<TestAgent> {
  const enrollmentLocator = createLocator(deterministicBytes(runSeed + offset * 101 + 1, 26));
  const enrollmentSecret = createBearerSecret(deterministicBytes(runSeed + offset * 101 + 2, 32));
  const credentialLocator = createLocator(deterministicBytes(runSeed + offset * 101 + 3, 26));
  const credentialSecret = createBearerSecret(deterministicBytes(runSeed + offset * 101 + 4, 32));
  return {
    agentId,
    organizationId,
    workspaceId,
    enrollment: formatEnrollmentToken(enrollmentLocator, enrollmentSecret),
    enrollmentLocator,
    enrollmentDigest: await hmacSha256Base64Url(enrollmentPepper, enrollmentSecret),
    credential: formatCredentialToken(credentialLocator, credentialSecret),
    credentialLocator,
    scopes,
  };
}

async function seedAgent(
  agent: TestAgent,
  input: {
    readonly organizationName: string;
    readonly workspaceSlug: string;
    readonly workspaceName: string;
    readonly agentName: string;
    readonly enrollmentExpiresAt?: number;
  },
): Promise<void> {
  const result = await runFixture(
    "localFixtures:seedAgentEnrollment",
    {
      organizationId: agent.organizationId,
      organizationName: input.organizationName,
      workspaceId: agent.workspaceId,
      workspaceSlug: input.workspaceSlug,
      workspaceName: input.workspaceName,
      taskKeyPrefix: "OPS",
      agentId: agent.agentId,
      agentName: input.agentName,
      scopes: [...agent.scopes],
      enrollmentLocator: agent.enrollmentLocator,
      enrollmentDigest: agent.enrollmentDigest,
      enrollmentExpiresAt: input.enrollmentExpiresAt ?? Date.now() + 10 * 60_000,
    },
    seedResultSchema,
  );
  assertEqual(result.organizationId, agent.organizationId, "The seeded organization ID changed.");
  assertEqual(result.workspaceId, agent.workspaceId, "The seeded workspace ID changed.");
  assertEqual(result.agentId, agent.agentId, "The seeded agent ID changed.");
  assertEqual(result.enrollmentLocator, agent.enrollmentLocator, "The seeded enrollment locator changed.");
}

async function activateAgent(siteOrigin: string, agent: TestAgent): Promise<ActiveTestAgent> {
  const enrollmentKey = nextIdempotencyKey();
  const redeemed = expectSuccess(
    await redeemEnrollment(siteOrigin, agent, enrollmentKey),
    `Enrollment redemption for ${agent.agentId}`,
  );
  assertEqual(redeemed.data.agentId, agent.agentId, "Enrollment resolved the wrong agent.");
  assertEqual(redeemed.data.credentialId, agent.credentialLocator, "Enrollment resolved the wrong credential.");
  assertJsonEqual(redeemed.data.scopes, [...agent.scopes], "Enrollment returned the wrong scopes.");
  const replay = expectSuccess(
    await redeemEnrollment(siteOrigin, agent, enrollmentKey),
    `Enrollment replay for ${agent.agentId}`,
  );
  assertJsonEqual(replay, redeemed, "Enrollment replay did not return the original response.");
  expectError(
    await redeemEnrollment(siteOrigin, agent, nextIdempotencyKey()),
    "ENROLLMENT_REDEEMED",
    `Fresh-key redeemed enrollment for ${agent.agentId}`,
  );
  const session = expectSuccess(await startSession(siteOrigin, agent), `Session start for ${agent.agentId}`);
  return { ...agent, sessionId: session.data.sessionId };
}

function taskByKey(inspect: z.infer<typeof inspectResultSchema>, key: TaskKey) {
  const task = inspect.tasks.find((candidate) => candidate.key === key);
  assert(task !== undefined, `Persistence inspection did not contain task ${key}.`);
  return task;
}

function assertOneEventPerRevision(
  inspect: z.infer<typeof inspectResultSchema>,
  includeTask: (task: z.infer<typeof taskViewSchema>) => boolean = () => true,
): void {
  for (const task of inspect.tasks) {
    if (!includeTask(task)) continue;
    const revisions = inspect.taskEvents
      .filter((event) => event.taskId === task.id)
      .map((event) => event.taskRevision)
      .sort((left, right) => left - right);
    assert(
      revisions.length >= task.revision,
      `Task ${task.key} has fewer events than durable revisions.`,
    );
    assertJsonEqual(
      [...new Set(revisions)],
      Array.from({ length: task.revision }, (_, index) => index + 1),
      `Task ${task.key} has a missing durable revision event.`,
    );
  }
}

function receiptCount(inspect: z.infer<typeof inspectResultSchema>, operation: string): number {
  return inspect.receipts.filter((receipt) => receipt.operation === operation).length;
}

async function inspectApiRateLimits() {
  return await runFixture(
    "localFixtures:inspectApiRateLimits",
    {},
    z.array(rateLimitBucketSchema),
  );
}

async function resetApiRateLimits(filters: {
  readonly subjectKind?: "credential" | "workspace" | "user" | "unauthenticated";
  readonly subjectKey?: string;
  readonly routeClass?: z.infer<typeof rateLimitBucketSchema>["routeClass"];
} = {}) {
  return await runFixture(
    "localFixtures:resetApiRateLimits",
    filters,
    resetApiRateLimitsResultSchema,
  );
}

async function saturateAuthenticationFailureSlot(args: {
  readonly label: string;
  readonly routeClass: "agent_auth_failure" | "enrollment_auth_failure";
  readonly perShardAllowance: number;
  readonly request: () => Promise<HttpResult<unknown>>;
}): Promise<string> {
  await resetApiRateLimits({ routeClass: args.routeClass });
  saturation: for (let attempt = 0; attempt < 256; attempt += 1) {
    const result = await args.request();
    assert(!result.ok, `${args.label} authentication failure unexpectedly succeeded.`);
    assert(
      result.envelope.error.code === "AUTHENTICATION_FAILED" ||
        result.envelope.error.code === "RATE_LIMITED",
      `${args.label} authentication failure returned an unstable error.`,
    );
    if ((attempt + 1) % 4 !== 0) continue;
    const rows = (await inspectApiRateLimits()).filter(
      (row) =>
        row.routeClass === args.routeClass && row.subjectKind === "unauthenticated",
    );
    const subjectKeys = [...new Set(rows.map((row) => row.subjectKey))];
    assertEqual(subjectKeys.length, 1, `${args.label} persisted more than one opaque slot.`);
    const subjectKey = subjectKeys[0];
    assert(subjectKey !== undefined, `${args.label} omitted its opaque slot.`);
    const latestWindow = Math.max(...rows.map((row) => row.windowStartedAt));
    const currentRows = rows.filter(
      (row) => row.subjectKey === subjectKey && row.windowStartedAt === latestWindow,
    );
    if (
      new Set(currentRows.map((row) => row.shard)).size === 4 &&
      currentRows.every((row) => row.count === args.perShardAllowance)
    ) {
      const retryAfterValues: number[] = [];
      for (let verification = 0; verification < 8; verification += 1) {
        const limited = expectError(
          await args.request(),
          "RATE_LIMITED",
          `${args.label} saturated request ${verification + 1}`,
        );
        const retryAfterMs = limited.error.details.retryAfterMs;
        assert(
          typeof retryAfterMs === "number" && retryAfterMs > 0 && retryAfterMs <= 60_000,
          `${args.label} omitted a bounded retryAfterMs.`,
        );
        if (verification === 0 && retryAfterMs < 5_000) {
          await resetApiRateLimits({ routeClass: args.routeClass });
          continue saturation;
        }
        retryAfterValues.push(retryAfterMs);
      }
      assert(
        retryAfterValues.every(
          (value, index) => index === 0 || value <= (retryAfterValues[index - 1] ?? value),
        ),
        `${args.label} retryAfterMs increased inside one fixed window.`,
      );
      return subjectKey;
    }
  }
  throw new Error(`${args.label} did not saturate every selected shard within 256 requests.`);
}

async function exerciseDispatchProtocol(args: {
  readonly siteOrigin: string;
  readonly runId: string;
  readonly runSeed: number;
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly agentA: ActiveTestAgent;
  readonly agentB: ActiveTestAgent;
}): Promise<void> {
  const repositoryA = `repo_${createLocator(deterministicBytes(args.runSeed + 801, 26))}`;
  const repositoryB = `repo_${createLocator(deterministicBytes(args.runSeed + 802, 26))}`;
  const deferredRepository = `repo_${createLocator(deterministicBytes(args.runSeed + 803, 26))}`;
  const contention = await seedQueuedDispatch({
    workspaceId: args.workspaceA,
    repositoryId: repositoryA,
    title: "Dispatch claim contention and terminal submission",
  });
  const beforeBarrierExpiry = await seedQueuedDispatch({
    workspaceId: args.workspaceA,
    repositoryId: repositoryA,
    title: "Dispatch lease expiry before publication barrier",
  });
  const stalledCompletion = await seedQueuedDispatch({
    workspaceId: args.workspaceA,
    repositoryId: repositoryA,
    title: "Dispatch submission whose terminal event never arrives",
  });
  const afterBarrierExpiry = await seedQueuedDispatch({
    workspaceId: args.workspaceA,
    repositoryId: repositoryA,
    title: "Dispatch lease expiry after publication barrier",
  });
  const tenantBDispatch = await seedQueuedDispatch({
    workspaceId: args.workspaceB,
    repositoryId: repositoryB,
    title: "Tenant Beta terminal dispatch",
  });

  const primary = {
    runnerId: `runner_primary_${args.runId}`,
    installationId: `install_primary_${args.runId}`,
    bootId: `boot_primary_${args.runId}`,
    bootGeneration: 1,
  } as const;
  const contender = {
    runnerId: `runner_contender_${args.runId}`,
    installationId: `install_contender_${args.runId}`,
    bootId: `boot_contender_${args.runId}`,
    bootGeneration: 1,
  } as const;
  const tenantB = {
    runnerId: `runner_tenantb_${args.runId}`,
    installationId: `install_tenantb_${args.runId}`,
    bootId: `boot_tenantb_${args.runId}`,
    bootGeneration: 1,
  } as const;
  let primarySequence = 1;
  const contenderSequence = 1;
  let tenantBSequence = 1;
  const heartbeatRequest = (
    runner: typeof primary | typeof contender | typeof tenantB,
    sequence: number,
    repositoryId: string,
    activeRuns = 0,
    currentRunIds: readonly string[] = [],
    retainedRunIds: readonly string[] = currentRunIds,
  ): RunnerHeartbeatRequest => ({
    ...runner,
    sequence,
    protocolVersion: HRA_DISPATCH_PROTOCOL_VERSION,
    clientVersion: "local-black-box-v1",
    reportedState: activeRuns < 2 ? "ready" : "busy",
    capacity: 2,
    activeRuns,
    currentRunIds: [...currentRunIds],
    retainedRunIds: [...retainedRunIds],
    repositoryIds: [repositoryId],
  });
  const primaryHeartbeat = heartbeatRequest(primary, primarySequence, repositoryA);
  const firstHeartbeat = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), primaryHeartbeat),
    "Primary runner heartbeat",
  );
  assert(
    firstHeartbeat.data.candidates.some(({ taskKey }) => taskKey === contention.taskKey),
    "Ready runner heartbeat omitted its tenant-local dispatch candidate.",
  );
  const heartbeatReplay = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), primaryHeartbeat),
    "Primary runner heartbeat replay",
  );
  assertEqual(
    heartbeatReplay.data.leaseUntil,
    firstHeartbeat.data.leaseUntil,
    "Exact heartbeat replay changed the durable runner lease.",
  );
  assertJsonEqual(
    heartbeatReplay.data.candidates,
    firstHeartbeat.data.candidates,
    "Exact heartbeat replay changed the dispatch candidates.",
  );
  const legacyMigration = await clearRunnerHeartbeatResponse({
    workspaceId: args.workspaceA,
    runnerId: primary.runnerId,
  });
  assert(legacyMigration.cleared, "Legacy heartbeat fixture found no persisted response to clear.");
  const migratedHeartbeatReplay = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), primaryHeartbeat),
    "Legacy runner heartbeat replay migration",
  );
  assertEqual(
    migratedHeartbeatReplay.data.serverTime,
    firstHeartbeat.data.serverTime,
    "Legacy heartbeat migration changed the original server clock.",
  );
  assertEqual(
    migratedHeartbeatReplay.data.leaseUntil,
    firstHeartbeat.data.leaseUntil,
    "Legacy heartbeat migration changed the durable runner lease.",
  );
  assertJsonEqual(
    {
      candidates: migratedHeartbeatReplay.data.candidates,
      runLeases: migratedHeartbeatReplay.data.runLeases,
      stopRunIds: migratedHeartbeatReplay.data.stopRunIds,
      releaseRunIds: migratedHeartbeatReplay.data.releaseRunIds,
    },
    { candidates: [], runLeases: [], stopRunIds: [], releaseRunIds: [] },
    "Legacy heartbeat migration exposed mutable current-state projections.",
  );
  const persistedMigratedReplay = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), primaryHeartbeat),
    "Persisted legacy runner heartbeat replay",
  );
  assertJsonEqual(
    persistedMigratedReplay.data,
    migratedHeartbeatReplay.data,
    "Legacy heartbeat migration was not stable after persistence.",
  );
  expectError(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), {
      ...primaryHeartbeat,
      reportedState: "busy",
    }),
    "IDEMPOTENCY_CONFLICT",
    "Conflicting runner heartbeat replay",
  );
  expectError(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), {
      ...primaryHeartbeat,
      sequence: 3,
    }),
    "CLAIM_STALE",
    "Gapped runner heartbeat",
  );
  expectError(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(contender, contenderSequence, repositoryA),
    ),
    "RUNNER_ALREADY_CONNECTED",
    "Contender runner heartbeat while primary authority is live",
  );
  expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentB),
      heartbeatRequest(tenantB, tenantBSequence, repositoryB),
    ),
    "Tenant Beta runner heartbeat",
  );
  expectError(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentB), {
      ...primaryHeartbeat,
      repositoryIds: [repositoryB],
    }),
    "AUTHORIZATION_DENIED",
    "Cross-tenant runner heartbeat",
  );
  expectError(
    await claimDispatch(args.siteOrigin, authorization(args.agentB), {
      runnerId: tenantB.runnerId,
      bootId: tenantB.bootId,
      bootGeneration: tenantB.bootGeneration,
      taskKey: contention.taskKey,
      repositoryId: repositoryA,
    }),
    "NOT_FOUND",
    "Cross-tenant dispatch claim",
  );
  const beforeRollback = await inspectDispatchWorkspace(args.workspaceA);
  const runnerBeforeRollback = beforeRollback.runners.find(({ id }) => id === primary.runnerId);
  assert(runnerBeforeRollback !== undefined, "Primary runner was absent before rollback proof.");
  await duplicateRunnerCapability({ workspaceId: args.workspaceA, runnerId: primary.runnerId });
  primarySequence += 1;
  const rollbackHeartbeat = heartbeatRequest(primary, primarySequence, repositoryA);
  expectError(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), rollbackHeartbeat),
    "INTERNAL_ERROR",
    "Heartbeat projection rollback",
  );
  const afterRollback = await inspectDispatchWorkspace(args.workspaceA);
  const runnerAfterRollback = afterRollback.runners.find(({ id }) => id === primary.runnerId);
  assert(runnerAfterRollback !== undefined, "Primary runner was absent after rollback proof.");
  assertEqual(
    runnerAfterRollback.sequence,
    runnerBeforeRollback.sequence,
    "Failed heartbeat committed its runner sequence prefix.",
  );
  assertEqual(
    runnerAfterRollback.leaseUntil,
    runnerBeforeRollback.leaseUntil,
    "Failed heartbeat committed its runner lease prefix.",
  );
  const repairedCapabilities = await repairRunnerCapabilities({
    workspaceId: args.workspaceA,
    runnerId: primary.runnerId,
  });
  assertEqual(repairedCapabilities.deleted, 1, "Capability repair removed the wrong row count.");
  const recoveredHeartbeat = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), rollbackHeartbeat),
    "Heartbeat retry after projection repair",
  );
  const recoveredReplay = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), rollbackHeartbeat),
    "Recovered heartbeat exact replay",
  );
  assertJsonEqual(
    recoveredReplay.data,
    recoveredHeartbeat.data,
    "Recovered heartbeat replay changed its persisted response.",
  );
  logStep("proved credential-bound runner readiness, heartbeat replay/order laws, and tenant opacity");

  const deferredAvailableAt = Date.now() + 5_000;
  const deferredDispatch = await seedQueuedDispatch({
    workspaceId: args.workspaceA,
    repositoryId: deferredRepository,
    title: "Deferred dispatch wake revision continuity",
    availableAt: deferredAvailableAt,
  });
  const beforeWakeProjection = await inspectQueuedDispatchReadiness({
    workspaceId: args.workspaceA,
    runId: deferredDispatch.runId,
  });
  assert(
    !beforeWakeProjection.taskIsReady &&
      beforeWakeProjection.taskRevision === 1 &&
      beforeWakeProjection.queuedTaskRevision === 1,
    "Deferred dispatch did not begin on one unready bound revision.",
  );
  primarySequence += 1;
  const beforeWakeHeartbeat = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), {
      ...heartbeatRequest(primary, primarySequence, repositoryA),
      repositoryIds: [repositoryA, deferredRepository],
    }),
    "Heartbeat before deferred dispatch wake",
  );
  assert(
    !beforeWakeHeartbeat.data.candidates.some(
      ({ taskKey }) => taskKey === deferredDispatch.taskKey,
    ),
    "Deferred dispatch was offered before its availability deadline.",
  );
  const awakenedDispatch = await waitUntil(
    "Deferred dispatch scheduler wake",
    async () => {
      const projection = await inspectQueuedDispatchReadiness({
        workspaceId: args.workspaceA,
        runId: deferredDispatch.runId,
      });
      return projection.taskIsReady &&
        projection.taskReadyNow &&
        projection.taskRevision === 2 &&
        projection.queuedTaskRevision === projection.taskRevision
        ? projection
        : null;
    },
    30_000,
  );
  assertEqual(
    awakenedDispatch.availableAt,
    deferredAvailableAt,
    "Scheduled wake changed the deferred availability deadline.",
  );
  primarySequence += 1;
  const afterWakeHeartbeat = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), {
      ...heartbeatRequest(primary, primarySequence, repositoryA),
      repositoryIds: [repositoryA, deferredRepository],
    }),
    "Heartbeat after deferred dispatch wake",
  );
  assert(
    afterWakeHeartbeat.data.candidates.some(
      ({ taskKey, repositoryId }) =>
        taskKey === deferredDispatch.taskKey && repositoryId === deferredRepository,
    ),
    "Awakened dispatch was not offered to its capable runner.",
  );
  const awakenedClaim = expectSuccess(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      taskKey: deferredDispatch.taskKey,
      repositoryId: deferredRepository,
    }),
    "Awakened deferred dispatch claim",
  ).data.run;
  expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), awakenedClaim.runId, {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      claimId: awakenedClaim.claimId,
      claimFence: awakenedClaim.claimFence,
      events: [{ id: `event_deferred_failed_${args.runId}`, sequence: 1, kind: "run.failed" }],
    }),
    "Awakened deferred dispatch terminal publication",
  );
  primarySequence += 1;
  const awakenedRelease = expectSuccess(
    await runnerHeartbeat(args.siteOrigin, authorization(args.agentA), {
      ...heartbeatRequest(primary, primarySequence, repositoryA, 1, [], [awakenedClaim.runId]),
      repositoryIds: [repositoryA, deferredRepository],
    }),
    "Awakened deferred dispatch release heartbeat",
  );
  assert(
    awakenedRelease.data.releaseRunIds.includes(awakenedClaim.runId),
    "Awakened deferred dispatch did not reach terminal release.",
  );
  logStep("proved future dispatch wake revision continuity through heartbeat eligibility and claim");

  expectError(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: contender.runnerId,
      bootId: contender.bootId,
      bootGeneration: contender.bootGeneration,
      taskKey: contention.taskKey,
      repositoryId: repositoryA,
    }),
    "NOT_FOUND",
    "Non-authoritative runner dispatch claim",
  );
  const claimed = expectSuccess(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      taskKey: contention.taskKey,
      repositoryId: repositoryA,
    }),
    "Authoritative runner dispatch claim",
  ).data.run;
  assertEqual(claimed.runId, contention.runId, "Dispatch claim returned the wrong queued run.");
  const claimReplay = expectSuccess(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      taskKey: contention.taskKey,
      repositoryId: repositoryA,
    }),
    "Dispatch claim replay",
  );
  assertJsonEqual(claimReplay.data.run, claimed, "Dispatch claim replay changed the claim tuple.");

  const firstEvent = {
    id: `event_contention_01_${args.runId}`,
    sequence: 1,
    kind: "worktree.preparing" as const,
  };
  const eventTuple = {
    runnerId: primary.runnerId,
    bootId: primary.bootId,
    claimId: claimed.claimId,
    claimFence: claimed.claimFence,
  };
  const prepared = expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...eventTuple,
      events: [firstEvent],
    }),
    "Worktree publication barrier",
  );
  assertEqual(prepared.data.acceptedThroughSequence, 1, "Publication barrier did not advance sequence.");
  const eventReplay = expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...eventTuple,
      events: [firstEvent],
    }),
    "Run event replay",
  );
  assertEqual(eventReplay.data.acceptedThroughSequence, 1, "Run event replay advanced sequence.");
  expectError(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...eventTuple,
      events: [{ ...firstEvent, id: `event_contention_conflict_${args.runId}` }],
    }),
    "IDEMPOTENCY_CONFLICT",
    "Conflicting run event replay",
  );
  expectError(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...eventTuple,
      events: [{ id: `event_contention_gap_${args.runId}`, sequence: 3, kind: "codex.running" }],
    }),
    "CLAIM_STALE",
    "Out-of-order run event",
  );
  expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...eventTuple,
      events: [
        { id: `event_contention_02_${args.runId}`, sequence: 2, kind: "worktree.ready" },
        { id: `event_contention_03_${args.runId}`, sequence: 3, kind: "codex.running" },
      ],
    }),
    "Running phase publication",
  );

  const interactionCreatedAt = Date.now();
  const interactionPayload: RunInteractionRequestPayload = {
    id: `interaction_acceptance_${args.runId}`,
    kind: "user_input",
    createdAt: interactionCreatedAt,
    expiresAt: interactionCreatedAt + 5 * 60_000,
    questions: [{
      id: `question_acceptance_${args.runId}`,
      header: "Local acceptance",
      prompt: "Provide the bounded local interaction response.",
      allowOther: true,
      options: [],
    }],
  };
  const interactionReplyKey = await createRunInteractionReplyKeyPair();
  const interactionRequest = runInteractionRequestSchema.parse({
    ...interactionPayload,
    reply: {
      version: 1,
      algorithm: "P256-HKDF-SHA256-A256GCM",
      keyId: interactionReplyKey.keyId,
      publicKey: interactionReplyKey.publicKey,
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      claimId: claimed.claimId,
      claimFence: claimed.claimFence,
      requestDigest: await createRunInteractionRequestDigest(interactionPayload),
    },
  });
  const interactionTuple = {
    ...eventTuple,
    bootGeneration: primary.bootGeneration,
  };
  const publishedInteraction = expectSuccess(
    await syncRunInteractions(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...interactionTuple,
      upserts: [interactionRequest],
      settlements: [],
    }),
    "Authenticated interaction upsert",
  );
  assertJsonEqual(
    publishedInteraction.data.acceptedInteractionIds,
    [interactionRequest.id],
    "Interaction upsert did not acknowledge the exact request.",
  );
  assertEqual(
    publishedInteraction.data.responses.length,
    0,
    "Interaction upsert unexpectedly returned a response.",
  );

  const plaintextInteractionAnswer = {
    kind: "user_input" as const,
    answers: [{
      questionId: interactionPayload.questions[0]?.id ?? "",
      selectedOptionIds: [],
      otherText: `local-only-answer-${args.runId}`,
    }],
  };
  const sealedInteractionAnswer = await sealRunInteractionResponse(
    interactionRequest,
    { runId: claimed.runId, workspaceId: args.workspaceA },
    plaintextInteractionAnswer,
  );
  const seededInteractionAnswer = await seedSealedDispatchInteractionResponse({
    workspaceId: args.workspaceA,
    runId: claimed.runId,
    interactionId: interactionRequest.id,
    sealedResponse: sealedInteractionAnswer,
  });
  assertEqual(
    seededInteractionAnswer.responseRevision,
    1,
    "Sealed interaction response did not begin at revision one.",
  );
  const answeredInteraction = await inspectDispatchInteraction({
    workspaceId: args.workspaceA,
    runId: claimed.runId,
    interactionId: interactionRequest.id,
  });
  assertEqual(answeredInteraction.state, "answered", "Sealed interaction response was not durable.");
  assertEqual(answeredInteraction.responseRowCount, 1, "Answered interaction lost its sealed response row.");
  assertEqual(
    answeredInteraction.plaintextResponseFieldCount,
    0,
    "Answered interaction persisted a plaintext response field.",
  );

  const deliveredInteraction = expectSuccess(
    await syncRunInteractions(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...interactionTuple,
      upserts: [],
      settlements: [],
    }),
    "Authenticated interaction response delivery",
  );
  const deliveredResponse = deliveredInteraction.data.responses[0];
  assert(
    deliveredResponse !== undefined && deliveredInteraction.data.responses.length === 1,
    "Interaction sync did not return exactly one sealed response.",
  );
  assertEqual(
    deliveredResponse.interactionId,
    interactionRequest.id,
    "Interaction sync returned the wrong response.",
  );
  assertJsonEqual(
    await openRunInteractionResponse(
      interactionRequest,
      { runId: claimed.runId, workspaceId: args.workspaceA },
      deliveredResponse.sealedResponse,
      interactionReplyKey.privateKey,
    ),
    plaintextInteractionAnswer,
    "The exact boot key could not open the delivered interaction response.",
  );
  const settledInteraction = expectSuccess(
    await syncRunInteractions(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...interactionTuple,
      upserts: [],
      settlements: [{
        interactionId: interactionRequest.id,
        responseRevision: deliveredResponse.responseRevision,
        outcome: "applied",
      }],
    }),
    "Authenticated interaction terminal settlement",
  );
  assertJsonEqual(
    settledInteraction.data.acceptedSettlementIds,
    [interactionRequest.id],
    "Interaction settlement did not acknowledge the exact response.",
  );
  assertEqual(
    settledInteraction.data.responses.length,
    0,
    "Settled interaction replayed its deleted response.",
  );
  const resolvedInteraction = await inspectDispatchInteraction({
    workspaceId: args.workspaceA,
    runId: claimed.runId,
    interactionId: interactionRequest.id,
  });
  assertEqual(resolvedInteraction.state, "resolved", "Applied interaction did not reach a terminal state.");
  assertEqual(resolvedInteraction.responseRowCount, 0, "Applied interaction retained its ciphertext row.");
  assertEqual(
    resolvedInteraction.plaintextResponseFieldCount,
    0,
    "Applied interaction persisted a plaintext response field.",
  );
  logStep("proved sealed interaction upsert, delivery, and terminal settlement through desktop HTTP sync");

  expectSuccess(
    await submitTask(args.siteOrigin, authorization(args.agentA), contention.taskKey, {
      fence: claimed.claimFence,
      expectedReviewRevision: claimed.inputReviewRevision,
      dispatch: {
        runId: claimed.runId,
        runnerId: primary.runnerId,
        bootId: primary.bootId,
        claimId: claimed.claimId,
        claimFence: claimed.claimFence,
      },
      summary: "Local dispatch completed through the production submission route.",
      evidence: [{ kind: "note", text: "Deterministic local Convex protocol evidence." }],
    }),
    "Dispatch task submission",
  );
  const beforeCompletionHeartbeat = dispatchById(
    await inspectDispatchWorkspace(args.workspaceA),
    claimed.runId,
  );
  const beforeCompletionEvents = beforeCompletionHeartbeat.acceptedThroughSequence;
  const beforeCompletionLease = beforeCompletionHeartbeat.leaseUntil;
  assert(beforeCompletionLease !== undefined, "Completion-window dispatch lost its lease.");
  primarySequence += 1;
  const completionWindowHeartbeat = expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(primary, primarySequence, repositoryA, 1, [claimed.runId]),
    ),
    "Heartbeat between task submission and terminal run event",
  );
  assert(
    !completionWindowHeartbeat.data.releaseRunIds.includes(claimed.runId),
    "Completion-window heartbeat released the run before its ordered terminal event.",
  );
  const afterCompletionHeartbeat = dispatchById(
    await inspectDispatchWorkspace(args.workspaceA),
    claimed.runId,
  );
  assertEqual(
    afterCompletionHeartbeat.phase,
    beforeCompletionHeartbeat.phase,
    "Completion-window heartbeat changed the run phase without an ordered event.",
  );
  assertEqual(
    afterCompletionHeartbeat.acceptedThroughSequence,
    beforeCompletionEvents,
    "Completion-window heartbeat synthesized a run event.",
  );
  assert(
    afterCompletionHeartbeat.leaseUntil !== undefined &&
      afterCompletionHeartbeat.leaseUntil > beforeCompletionLease,
    "Completion-window heartbeat did not advance only the dispatch publication lease.",
  );
  expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), claimed.runId, {
      ...eventTuple,
      events: [{ id: `event_contention_04_${args.runId}`, sequence: 4, kind: "run.submitted" }],
    }),
    "Terminal run submission publication",
  );
  primarySequence += 1;
  const terminalHeartbeat = expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(primary, primarySequence, repositoryA, 1, [], [claimed.runId]),
    ),
    "Terminal release heartbeat",
  );
  assert(
    terminalHeartbeat.data.releaseRunIds.includes(claimed.runId),
    "Heartbeat did not expose the terminal run release acknowledgement.",
  );

  const stalled = expectSuccess(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      taskKey: stalledCompletion.taskKey,
      repositoryId: repositoryA,
    }),
    "Stalled completion dispatch claim",
  ).data.run;
  const stalledTuple = {
    runnerId: primary.runnerId,
    bootId: primary.bootId,
    claimId: stalled.claimId,
    claimFence: stalled.claimFence,
  };
  expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), stalled.runId, {
      ...stalledTuple,
      events: [
        { id: `event_stalled_01_${args.runId}`, sequence: 1, kind: "worktree.preparing" },
        { id: `event_stalled_02_${args.runId}`, sequence: 2, kind: "worktree.ready" },
        { id: `event_stalled_03_${args.runId}`, sequence: 3, kind: "codex.running" },
      ],
    }),
    "Stalled completion running publication",
  );
  expectSuccess(
    await submitTask(args.siteOrigin, authorization(args.agentA), stalledCompletion.taskKey, {
      fence: stalled.claimFence,
      expectedReviewRevision: stalled.inputReviewRevision,
      dispatch: {
        runId: stalled.runId,
        runnerId: primary.runnerId,
        bootId: primary.bootId,
        claimId: stalled.claimId,
        claimFence: stalled.claimFence,
      },
      summary: "Task submission committed before its terminal event was lost.",
      evidence: [{ kind: "note", text: "Bounded completion reconciliation evidence." }],
    }),
    "Stalled completion task submission",
  );
  await ageSubmittedDispatchClaim({
    workspaceId: args.workspaceA,
    runId: stalled.runId,
    ageMs: 90_001,
  });
  primarySequence += 1;
  const boundedCompletionHeartbeat = expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(primary, primarySequence, repositoryA, 1, [stalled.runId]),
    ),
    "Heartbeat after bounded completion publication grace",
  );
  assert(
    boundedCompletionHeartbeat.data.releaseRunIds.includes(stalled.runId),
    "A stalled terminal publication remained renewable beyond its bounded grace.",
  );
  const reconciledWorkspace = await inspectDispatchWorkspace(args.workspaceA);
  const reconciled = dispatchById(reconciledWorkspace, stalled.runId);
  assertEqual(reconciled.phase, "submitted", "Stalled completion did not reconcile to submitted.");
  assertEqual(
    reconciled.acceptedThroughSequence,
    4,
    "Stalled completion did not append exactly one terminal event.",
  );
  assertEqual(
    reconciledWorkspace.events.filter((event) =>
      event.runId === stalled.runId && event.kind === "run.submitted").length,
    1,
    "Stalled completion synthesized more than one terminal event.",
  );
  logStep("proved singleton authority, authoritative claim replay/order, and terminal visibility");

  const preClaimRollback = await inspectDispatchWorkspace(args.workspaceA);
  const preClaimRollbackRun = dispatchById(preClaimRollback, beforeBarrierExpiry.runId);
  const preClaimRollbackClaims = preClaimRollback.claims.filter(
    ({ taskId }) => taskId === preClaimRollbackRun.taskId,
  );
  const removedBody = await setDispatchTaskBodyPresence({
    workspaceId: args.workspaceA,
    runId: beforeBarrierExpiry.runId,
    present: false,
  });
  assert(!removedBody.present && removedBody.bodyCount === 0, "Dispatch body fault was not injected.");
  expectError(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      taskKey: beforeBarrierExpiry.taskKey,
      repositoryId: repositoryA,
    }),
    "INTERNAL_ERROR",
    "Claim projection rollback fault",
  );
  const postClaimRollback = await inspectDispatchWorkspace(args.workspaceA);
  assertJsonEqual(
    dispatchById(postClaimRollback, beforeBarrierExpiry.runId),
    preClaimRollbackRun,
    "Failed claim committed its dispatch binding prefix.",
  );
  assertJsonEqual(
    postClaimRollback.claims.filter(({ taskId }) => taskId === preClaimRollbackRun.taskId),
    preClaimRollbackClaims,
    "Failed claim committed its task claim prefix.",
  );
  const restoredBody = await setDispatchTaskBodyPresence({
    workspaceId: args.workspaceA,
    runId: beforeBarrierExpiry.runId,
    present: true,
  });
  assert(restoredBody.present && restoredBody.bodyCount === 1, "Dispatch body fault was not repaired.");
  logStep("proved a post-write claim projection fault rolls back its task, claim, and run prefix");

  const leased = expectSuccess(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      taskKey: beforeBarrierExpiry.taskKey,
      repositoryId: repositoryA,
    }),
    "Pre-barrier expiry dispatch claim",
  ).data.run;
  const shortenedLeased = await shortenDispatchLease({
    workspaceId: args.workspaceA,
    runId: leased.runId,
    delayMs: 2_000,
  });
  primarySequence += 1;
  expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(primary, primarySequence, repositoryA, 1, [], [leased.runId]),
    ),
    "Same-boot reconnect without the forgotten local lease",
  );
  const unrenewed = dispatchById(await inspectDispatchWorkspace(args.workspaceA), leased.runId);
  assertEqual(
    unrenewed.leaseUntil,
    shortenedLeased.leaseUntil,
    "A same-boot reconnect renewed a run absent from the exact local renewal allowlist.",
  );
  await waitPast(shortenedLeased.leaseUntil, 25);
  const requeued = await waitUntil("pre-barrier dispatch requeue", async () => {
    const inspection = await inspectDispatchWorkspace(args.workspaceA);
    return dispatchById(inspection, leased.runId).phase === "queued" ? inspection : null;
  });
  assertEqual(dispatchById(requeued, leased.runId).acceptedThroughSequence, 0, "Requeued lease crossed the publication barrier.");
  assert(
    requeued.claims.some((claim) => claim.id === leased.claimId && claim.state === "released"),
    "Pre-barrier lease expiry did not release its exact task claim.",
  );
  primarySequence += 1;
  const requeueHeartbeat = expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(primary, primarySequence, repositoryA),
    ),
    "Requeued candidate heartbeat",
  );
  assert(
    requeueHeartbeat.data.candidates.some(({ taskKey }) => taskKey === beforeBarrierExpiry.taskKey),
    "Safely requeued pre-barrier work did not become claimable again.",
  );

  const ambiguous = expectSuccess(
    await claimDispatch(args.siteOrigin, authorization(args.agentA), {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      bootGeneration: primary.bootGeneration,
      taskKey: afterBarrierExpiry.taskKey,
      repositoryId: repositoryA,
    }),
    "Post-barrier expiry dispatch claim",
  ).data.run;
  expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentA), ambiguous.runId, {
      runnerId: primary.runnerId,
      bootId: primary.bootId,
      claimId: ambiguous.claimId,
      claimFence: ambiguous.claimFence,
      events: [{ id: `event_ambiguous_01_${args.runId}`, sequence: 1, kind: "worktree.preparing" }],
    }),
    "Post-barrier worktree publication",
  );
  const shortenedProvisioning = await shortenDispatchLease({
    workspaceId: args.workspaceA,
    runId: ambiguous.runId,
    delayMs: 125,
  });
  await waitPast(shortenedProvisioning.leaseUntil, 25);
  const quarantined = await waitUntil("post-barrier ambiguity quarantine", async () => {
    const inspection = await inspectDispatchWorkspace(args.workspaceA);
    return dispatchById(inspection, ambiguous.runId).phase === "ambiguous" ? inspection : null;
  });
  const ambiguousRow = dispatchById(quarantined, ambiguous.runId);
  assertEqual(ambiguousRow.acceptedThroughSequence, 1, "Ambiguous run lost its publication barrier evidence.");
  assert(
    quarantined.claims.some((claim) => claim.id === ambiguous.claimId && claim.state === "active"),
    "Post-barrier ambiguity incorrectly released its reserved task claim.",
  );
  primarySequence += 1;
  const ambiguityHeartbeat = expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(primary, primarySequence, repositoryA, 1, [], [ambiguous.runId]),
    ),
    "Ambiguous release heartbeat",
  );
  assert(
    !ambiguityHeartbeat.data.releaseRunIds.includes(ambiguous.runId),
    "Heartbeat incorrectly released an ambiguous run before human resolution.",
  );
  logStep("proved pre-barrier expiry safely requeues while post-barrier expiry quarantines as ambiguous");

  const betaClaim = expectSuccess(
    await claimDispatch(args.siteOrigin, authorization(args.agentB), {
      runnerId: tenantB.runnerId,
      bootId: tenantB.bootId,
      bootGeneration: tenantB.bootGeneration,
      taskKey: tenantBDispatch.taskKey,
      repositoryId: repositoryB,
    }),
    "Tenant Beta dispatch claim",
  ).data.run;
  expectSuccess(
    await appendRunEvents(args.siteOrigin, authorization(args.agentB), betaClaim.runId, {
      runnerId: tenantB.runnerId,
      bootId: tenantB.bootId,
      claimId: betaClaim.claimId,
      claimFence: betaClaim.claimFence,
      events: [{ id: `event_tenantb_failed_${args.runId}`, sequence: 1, kind: "run.failed" }],
    }),
    "Tenant Beta terminal failure",
  );
  tenantBSequence += 1;
  const betaRelease = expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentB),
      heartbeatRequest(tenantB, tenantBSequence, repositoryB, 1, [], [betaClaim.runId]),
    ),
    "Tenant Beta terminal release heartbeat",
  );
  assert(betaRelease.data.releaseRunIds.includes(betaClaim.runId), "Tenant Beta terminal run was not releasable.");
  const [finalDispatchA, finalDispatchB] = await Promise.all([
    inspectDispatchWorkspace(args.workspaceA),
    inspectDispatchWorkspace(args.workspaceB),
  ]);
  const tenantARepositoryIds = new Set([repositoryA, deferredRepository]);
  assert(
    finalDispatchA.repositories.length === tenantARepositoryIds.size &&
      finalDispatchA.repositories.every(({ id }) => tenantARepositoryIds.has(id)) &&
      finalDispatchB.repositories.every(({ id }) => id === repositoryB),
    "Dispatch repository inspection crossed tenant boundaries.",
  );
  assert(
    !finalDispatchB.dispatches.some(({ runId }) =>
      [contention.runId, beforeBarrierExpiry.runId, afterBarrierExpiry.runId].includes(runId)),
    "Tenant Beta inspection exposed Tenant Alpha run history.",
  );
  assertEqual(dispatchById(finalDispatchA, contention.runId).phase, "submitted", "Submitted run was not durable.");
  assertEqual(dispatchById(finalDispatchB, betaClaim.runId).phase, "failed", "Failed run was not durable.");

  const shortenedAuthority = await shortenRunnerAuthorityLease({
    workspaceId: args.workspaceA,
    delayMs: 125,
  });
  assertEqual(
    shortenedAuthority.runnerId,
    primary.runnerId,
    "Runner authority fixture shortened the wrong installation.",
  );
  await waitPast(shortenedAuthority.leaseUntil, 25);
  const takeoverHeartbeat = expectSuccess(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(contender, contenderSequence, repositoryA),
    ),
    "Contender runner takeover after authority expiry",
  );
  assert(
    takeoverHeartbeat.data.leaseUntil > shortenedAuthority.leaseUntil,
    "Runner authority takeover did not publish a fresh lease.",
  );
  expectError(
    await runnerHeartbeat(
      args.siteOrigin,
      authorization(args.agentA),
      heartbeatRequest(primary, primarySequence + 1, repositoryA, 1, [], [ambiguous.runId]),
    ),
    "RUNNER_ALREADY_CONNECTED",
    "Superseded runner heartbeat",
  );
  const postTakeover = await inspectDispatchWorkspace(args.workspaceA);
  assertEqual(
    postTakeover.authority?.runnerId,
    contender.runnerId,
    "Expired authority was not transferred to the contender.",
  );
  assertEqual(
    postTakeover.authority?.generation,
    shortenedAuthority.generation + 1,
    "Runner authority takeover did not advance its fence generation.",
  );
  logStep("audited tenant-local projections and expiry-fenced singleton runner takeover");
}

async function main(): Promise<void> {
  console.log("taskctl local Convex black-box acceptance");
  const { siteOrigin } = await deploymentConfiguration();

  const credentialPepper = createBearerSecret(deterministicBytes(0x43524544, 32));
  const enrollmentPepper = createBearerSecret(deterministicBytes(0x454e524c, 32));
  const hostedMutationFingerprintKey = createBearerSecret(
    deterministicBytes(0x4f505254, 32),
  );
  const deploymentEnvironment = [
    [
      "HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT",
      hostedMutationFingerprintKey,
    ],
    [
      "HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION",
      "local-black-box-v1",
    ],
    ["TASKCTL_CREDENTIAL_PEPPER_CURRENT", credentialPepper],
    ["TASKCTL_CREDENTIAL_PEPPER_CURRENT_VERSION", "local-black-box-v1"],
    ["TASKCTL_ENROLLMENT_PEPPER_CURRENT", enrollmentPepper],
    ["TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION", "local-black-box-v1"],
    ["TASKCTL_LOCAL_FIXTURES_ENABLED", "true"],
    ["TASKCTL_LOCAL_FIXTURE_ISSUER", LOCAL_FIXTURE_ISSUER],
    ["TASKCTL_LOCAL_FIXTURE_SUBJECT", LOCAL_FIXTURE_SUBJECT],
  ] as const;
  for (const [name, value] of deploymentEnvironment) await setConvexEnvironment(name, value);
  await runFixture(
    "localFixtures:resetApiRateLimits",
    {},
    resetApiRateLimitsResultSchema,
  );
  logStep("configured deterministic local-only identity and digest keys");

  const startedAt = Date.now();
  const runId = startedAt.toString(36);
  const runSeed = startedAt & 0x7fffffff;
  const organizationA = `org-a-${runId}`;
  const organizationB = `org-b-${runId}`;
  const workspaceA = `ws-a-${runId}`;
  const workspaceAPagination = `ws-a-pagination-${runId}`;
  const workspaceB = `ws-b-${runId}`;
  const workspaceExpired = `ws-expired-${runId}`;
  const dispatchOrganizationA = `org-dispatch-a-${runId}`;
  const dispatchOrganizationB = `org-dispatch-b-${runId}`;
  const dispatchWorkspaceA = `ws-dispatch-a-${runId}`;
  const dispatchWorkspaceB = `ws-dispatch-b-${runId}`;
  const agentA1 = await makeAgent(
    runSeed,
    1,
    organizationA,
    workspaceA,
    `agent-a1-${runId}`,
    enrollmentPepper,
  );
  const agentA2 = await makeAgent(
    runSeed,
    2,
    organizationA,
    workspaceA,
    `agent-a2-${runId}`,
    enrollmentPepper,
  );
  const agentB1 = await makeAgent(
    runSeed,
    3,
    organizationB,
    workspaceB,
    `agent-b1-${runId}`,
    enrollmentPepper,
  );
  const agentA1Pagination = await makeAgent(
    runSeed,
    4,
    organizationA,
    workspaceAPagination,
    agentA1.agentId,
    enrollmentPepper,
  );
  const expiredAgent = await makeAgent(
    runSeed,
    5,
    organizationA,
    workspaceExpired,
    `agent-expired-${runId}`,
    enrollmentPepper,
  );
  const dispatchAgentA = await makeAgent(
    runSeed,
    6,
    dispatchOrganizationA,
    dispatchWorkspaceA,
    `agent-dispatch-a-${runId}`,
    enrollmentPepper,
    DISPATCH_SCOPES,
  );
  const dispatchAgentB = await makeAgent(
    runSeed,
    7,
    dispatchOrganizationB,
    dispatchWorkspaceB,
    `agent-dispatch-b-${runId}`,
    enrollmentPepper,
    DISPATCH_SCOPES,
  );
  await seedAgent(agentA1, {
    organizationName: "Tenant Alpha",
    workspaceSlug: `alpha-${runId}`,
    workspaceName: "Alpha Operations",
    agentName: "Alpha One",
  });
  await expectFixtureInvocationDenied("localFixtures:inspectWorkspace", { workspaceId: workspaceA });
  await expectFixtureInvocationDenied(
    "localFixtures:inspectWorkspace",
    { workspaceId: workspaceA },
    {
      issuer: LOCAL_FIXTURE_ISSUER,
      subject: "wrong-local-subject",
      tokenIdentifier: `${LOCAL_FIXTURE_ISSUER}|wrong-local-subject`,
    },
  );
  logStep("rejected local fixture calls with missing and incorrect identities");
  await seedAgent(agentA2, {
    organizationName: "Tenant Alpha",
    workspaceSlug: `alpha-${runId}`,
    workspaceName: "Alpha Operations",
    agentName: "Alpha Two",
  });
  await seedAgent(agentB1, {
    organizationName: "Tenant Beta",
    workspaceSlug: `beta-${runId}`,
    workspaceName: "Beta Operations",
    agentName: "Beta One",
  });
  await seedAgent(agentA1Pagination, {
    organizationName: "Tenant Alpha",
    workspaceSlug: `alpha-pagination-${runId}`,
    workspaceName: "Alpha Pagination",
    agentName: "Alpha One",
  });
  await seedAgent(expiredAgent, {
    organizationName: "Tenant Alpha",
    workspaceSlug: `expired-${runId}`,
    workspaceName: "Expired Enrollment",
    agentName: "Expired Agent",
    enrollmentExpiresAt: Date.now() - 1,
  });
  await seedAgent(dispatchAgentA, {
    organizationName: "Dispatch Tenant Alpha",
    workspaceSlug: `dispatch-alpha-${runId}`,
    workspaceName: "Dispatch Alpha",
    agentName: "Dispatch Alpha Runner",
  });
  await seedAgent(dispatchAgentB, {
    organizationName: "Dispatch Tenant Beta",
    workspaceSlug: `dispatch-beta-${runId}`,
    workspaceName: "Dispatch Beta",
    agentName: "Dispatch Beta Runner",
  });
  expectError(
    await redeemEnrollment(siteOrigin, expiredAgent, nextIdempotencyKey()),
    "ENROLLMENT_EXPIRED",
    "Expired enrollment redemption",
  );
  const activeA1 = await activateAgent(siteOrigin, agentA1);
  const activeA2 = await activateAgent(siteOrigin, agentA2);
  const activeB1 = await activateAgent(siteOrigin, agentB1);
  const activeA1Pagination = await activateAgent(siteOrigin, agentA1Pagination);
  const activeDispatchA = await activateAgent(siteOrigin, dispatchAgentA);
  const activeDispatchB = await activateAgent(siteOrigin, dispatchAgentB);
  logStep("covered expired/redeemed enrollment recovery and started six bound sessions");

  await exerciseDispatchProtocol({
    siteOrigin,
    runId,
    runSeed,
    workspaceA: dispatchWorkspaceA,
    workspaceB: dispatchWorkspaceB,
    agentA: activeDispatchA,
    agentB: activeDispatchB,
  });

  expectError(
    await context(siteOrigin, {
      credential: activeA1.credential,
      sessionId: activeA2.sessionId,
    }),
    "SESSION_INVALID",
    "Credential/session mismatch",
  );
  const contextA = expectSuccess(await context(siteOrigin, authorization(activeA1)), "Tenant A context");
  const contextB = expectSuccess(await context(siteOrigin, authorization(activeB1)), "Tenant B context");
  assertEqual(contextA.data.organization.id, organizationA, "Tenant A context crossed organizations.");
  assertEqual(contextA.data.workspace.id, workspaceA, "Tenant A context crossed workspaces.");
  assertEqual(contextB.data.organization.id, organizationB, "Tenant B context crossed organizations.");
  assertEqual(contextB.data.workspace.id, workspaceB, "Tenant B context crossed workspaces.");
  logStep("rejected a mismatched session and bound both tenant contexts");

  const sharedRequest = {
    title: "Same tenant-visible title",
    type: "task" as const,
    priority: 2,
  };
  const sharedKey = nextIdempotencyKey();
  const tenantATaskEnvelope = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1), sharedRequest, sharedKey),
    "Tenant A task creation",
  );
  const tenantATaskReplay = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1), sharedRequest, sharedKey),
    "Tenant A task replay",
  );
  assertJsonEqual(tenantATaskReplay, tenantATaskEnvelope, "Task replay did not return the original envelope.");
  expectError(
    await createTask(
      siteOrigin,
      authorization(activeA1),
      { ...sharedRequest, title: "Conflicting use of the same key" },
      sharedKey,
    ),
    "IDEMPOTENCY_CONFLICT",
    "Conflicting task replay",
  );
  const tenantBTaskEnvelope = expectSuccess(
    await createTask(siteOrigin, authorization(activeB1), sharedRequest),
    "Tenant B task creation",
  );
  const tenantATask = tenantATaskEnvelope.data.task;
  const tenantBTask = tenantBTaskEnvelope.data.task;
  assert(tenantATask.key.startsWith("OPS-") && tenantBTask.key.startsWith("OPS-"), "Tenant keys did not overlap by prefix.");
  const readyA = expectSuccess(await readyTasks(siteOrigin, authorization(activeA1)), "Tenant A ready list");
  const readyB = expectSuccess(await readyTasks(siteOrigin, authorization(activeB1)), "Tenant B ready list");
  assert(readyA.data.tasks.some((task) => task.key === tenantATask.key), "Tenant A could not read its task.");
  assert(!readyA.data.tasks.some((task) => task.key === tenantBTask.key), "Tenant A read Tenant B task data.");
  assert(readyB.data.tasks.some((task) => task.key === tenantBTask.key), "Tenant B could not read its task.");
  assert(!readyB.data.tasks.some((task) => task.key === tenantATask.key), "Tenant B read Tenant A task data.");
  expectError(
    await claimTask(siteOrigin, authorization(activeA1), tenantBTask.key),
    "NOT_FOUND",
    "Cross-tenant claim",
  );
  logStep("proved task idempotency and two-tenant ready/lookup isolation");

  const graphBlocker = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1), {
      title: "Phase 3 graph blocker",
      description: "A normalized body used by graph acceptance.",
      type: "feature",
      priority: 1,
      labels: ["phase-three"],
    }),
    "Graph blocker creation",
  ).data.task;
  const graphDependent = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1), {
      title: "Phase 3 graph dependent",
      description: "Must be blocked until its prerequisite edge is removed.",
      type: "task",
      priority: 3,
      parentKey: graphBlocker.key,
      labels: ["phase-three"],
    }),
    "Graph dependent creation",
  ).data.task;
  const graphAuth = authorization(activeA1);
  const initialDetail = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.task(graphDependent.key),
      responseSchema: taskctlApiOperations.getTask.responseSchema,
    }),
    "Initial graph task detail",
  );
  assertEqual(initialDetail.data.parentKey, graphBlocker.key, "Created parent was not resolved by key.");
  assertEqual(
    initialDetail.data.description,
    "Must be blocked until its prerequisite edge is removed.",
    "Normalized task body was not returned.",
  );
  assertJsonEqual(initialDetail.data.labels, ["phase-three"], "Created labels were not returned.");

  const dependency = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(graphDependent.key),
      body: { revision: graphDependent.revision, blockerKey: graphBlocker.key },
      responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
    }),
    "Dependency insertion",
  );
  assertEqual(dependency.data.task.revision, 2, "Dependency insertion did not bump record revision.");
  assertEqual(
    dependency.data.task.reviewRevision,
    2,
    "Dependency insertion did not bump review revision.",
  );
  assert(!dependency.data.task.isReady, "Blocked work remained ready.");
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(graphDependent.key),
      body: { revision: 2, blockerKey: graphBlocker.key },
      responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
    }),
    "DEPENDENCY_DUPLICATE",
    "Duplicate dependency insertion",
  );
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(graphBlocker.key),
      body: { revision: graphBlocker.revision, blockerKey: graphDependent.key },
      responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
    }),
    "DEPENDENCY_CYCLE",
    "Dependency back-edge insertion",
  );
  const blocked = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.blockedTasks,
      query: new URLSearchParams({ limit: "100" }),
      responseSchema: taskctlApiOperations.blockedTasks.responseSchema,
    }),
    "Blocked task list",
  );
  assert(
    blocked.data.tasks.some(({ task }) => task.key === graphDependent.key),
    "Exact blocked projection omitted the dependent.",
  );
  const dependencyList = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(graphDependent.key),
      query: new URLSearchParams({ direction: "both", limit: "100" }),
      responseSchema: taskctlApiOperations.listTaskDependencies.responseSchema,
    }),
    "Dependency list",
  );
  assertEqual(dependencyList.data.dependencies.length, 1, "Dependency list lost or duplicated an edge.");

  const beforeComment = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.task(graphDependent.key),
      responseSchema: taskctlApiOperations.getTask.responseSchema,
    }),
    "Pre-comment task detail",
  ).data.task;
  expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskComments(graphDependent.key),
      body: { body: "Comments append an event without invalidating review state." },
      responseSchema: taskctlApiOperations.addTaskComment.responseSchema,
    }),
    "Comment insertion",
  );
  const afterComment = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.task(graphDependent.key),
      responseSchema: taskctlApiOperations.getTask.responseSchema,
    }),
    "Post-comment task detail",
  ).data.task;
  assertEqual(afterComment.revision, beforeComment.revision, "Comment changed record revision.");
  assertEqual(
    afterComment.reviewRevision,
    beforeComment.reviewRevision,
    "Comment changed review revision.",
  );
  const comments = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskComments(graphDependent.key),
      query: new URLSearchParams({ limit: "100" }),
      responseSchema: taskctlApiOperations.listTaskComments.responseSchema,
    }),
    "Comment list",
  );
  assertEqual(comments.data.comments.length, 1, "Comment list lost the inserted comment.");

  const updatedGraphTask = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskUpdate(graphDependent.key),
      body: { revision: afterComment.revision, title: "Phase 3 graph dependent updated" },
      responseSchema: taskctlApiOperations.updateTask.responseSchema,
    }),
    "Task update",
  ).data.task;
  assertEqual(updatedGraphTask.revision, 3, "Task update did not advance revision.");
  assertEqual(updatedGraphTask.reviewRevision, 3, "Task update did not advance review revision.");
  const labelledGraphTask = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskLabels(graphDependent.key),
      body: { revision: updatedGraphTask.revision, label: "acceptance" },
      responseSchema: taskctlApiOperations.addTaskLabel.responseSchema,
    }),
    "Task label insertion",
  ).data.task;
  const clearedParent = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskParentClear(graphDependent.key),
      body: { revision: labelledGraphTask.revision },
      responseSchema: taskctlApiOperations.clearTaskParent.responseSchema,
    }),
    "Parent clearing",
  ).data.task;
  const resetParent = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskParentSet(graphDependent.key),
      body: { revision: clearedParent.revision, parentKey: graphBlocker.key },
      responseSchema: taskctlApiOperations.setTaskParent.responseSchema,
    }),
    "Parent resetting",
  ).data.task;
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskParentSet(graphBlocker.key),
      body: { revision: graphBlocker.revision, parentKey: graphDependent.key },
      responseSchema: taskctlApiOperations.setTaskParent.responseSchema,
    }),
    "HIERARCHY_CYCLE",
    "Hierarchy cycle insertion",
  );

  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskReferences(graphDependent.key),
      body: {
        revision: resetParent.revision,
        reference: {
          kind: "url",
          label: "credential-bearing reference",
          url: "https://fixture-user:fixture-password@example.com/spec",
        },
      },
      responseSchema: taskctlApiOperations.addTaskReference.responseSchema,
    }),
    "VALIDATION_ERROR",
    "Credential-bearing task reference",
  );
  const reference = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskReferences(graphDependent.key),
      body: {
        revision: resetParent.revision,
        reference: { kind: "url", label: "acceptance spec", url: "https://example.com/spec" },
      },
      responseSchema: taskctlApiOperations.addTaskReference.responseSchema,
    }),
    "Task reference insertion",
  ).data.reference;
  const references = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskReferences(graphDependent.key),
      query: new URLSearchParams({ limit: "100" }),
      responseSchema: taskctlApiOperations.listTaskReferences.responseSchema,
    }),
    "Task reference list",
  );
  assertEqual(references.data.references.length, 1, "Reference list lost the inserted reference.");
  const beforeReferenceRemoval = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.task(graphDependent.key),
      responseSchema: taskctlApiOperations.getTask.responseSchema,
    }),
    "Reference revision detail",
  ).data.task;
  const removedReference = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskReferenceRemove(graphDependent.key, reference.id),
      body: { revision: beforeReferenceRemoval.revision },
      responseSchema: taskctlApiOperations.removeTaskReference.responseSchema,
    }),
    "Task reference removal",
  ).data.task;
  const graph = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskGraph(graphDependent.key),
      query: new URLSearchParams({ depth: "2", limit: "20" }),
      responseSchema: taskctlApiOperations.taskGraph.responseSchema,
    }),
    "Task graph read",
  );
  assertEqual(graph.data.nodes.length, 2, "Graph traversal did not return both tasks.");
  assertEqual(graph.data.dependencies.length, 1, "Graph traversal did not return its edge.");
  assert(!graph.data.truncated, "Small graph traversal was unexpectedly truncated.");

  const unblockedGraphTask = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencyRemove(graphDependent.key),
      body: { revision: removedReference.revision, blockerKey: graphBlocker.key },
      responseSchema: taskctlApiOperations.removeTaskDependency.responseSchema,
    }),
    "Dependency removal",
  ).data.task;
  assert(unblockedGraphTask.isReady, "Removing the final blocker did not materialize readiness.");
  const assignedGraphTask = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskAssign(graphDependent.key),
      body: { revision: unblockedGraphTask.revision, assigneeAgentId: activeA2.agentId },
      responseSchema: taskctlApiOperations.assignTask.responseSchema,
    }),
    "Task assignment",
  ).data.task;
  const deferredGraphTask = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDefer(graphDependent.key),
      body: { revision: assignedGraphTask.revision, availableAt: Date.now() },
      responseSchema: taskctlApiOperations.deferTask.responseSchema,
    }),
    "Immediate task defer",
  ).data.task;
  assertEqual(
    deferredGraphTask.reviewRevision,
    assignedGraphTask.reviewRevision + 1,
    "Defer did not advance review revision.",
  );
  const filteredTasks = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.tasks,
      query: new URLSearchParams({ label: "acceptance", parentKey: graphBlocker.key, limit: "100" }),
      responseSchema: taskctlApiOperations.listTasks.responseSchema,
    }),
    "Filtered task list",
  );
  assertEqual(filteredTasks.data.tasks.length, 1, "Combined task filters returned the wrong cardinality.");
  assertEqual(filteredTasks.data.tasks[0]?.key, graphDependent.key, "Combined task filters returned the wrong task.");
  const taskEvents = expectSuccess(
    await authenticatedGet({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskEvents(graphDependent.key),
      query: new URLSearchParams({ limit: "100" }),
      responseSchema: taskctlApiOperations.listTaskEvents.responseSchema,
    }),
    "Task event list",
  );
  const eventTypes = new Set(taskEvents.data.events.map((event) => event.type));
  for (const expectedType of [
    "task.created",
    "dependency.added",
    "task.comment_added",
    "task.updated",
    "task.label_added",
    "task.parent_cleared",
    "task.parent_set",
    "task.reference_added",
    "task.reference_removed",
    "dependency.removed",
    "task.assigned",
    "task.deferred",
  ] as const) {
    assert(eventTypes.has(expectedType), `Event history omitted ${expectedType}.`);
  }
  logStep("covered normalized task CRUD, comments, labels, refs, parent/dependency laws, graph, events, and exact projections");

  const completionBlocker = expectSuccess(
    await createTask(siteOrigin, graphAuth, {
      title: "Review lifecycle blocker",
      type: "task",
      priority: 0,
    }),
    "Review blocker creation",
  ).data.task;
  const completionDependent = expectSuccess(
    await createTask(siteOrigin, graphAuth, {
      title: "Review lifecycle dependent",
      type: "task",
      priority: 1,
    }),
    "Review dependent creation",
  ).data.task;
  const completionDependency = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(completionDependent.key),
      body: { revision: completionDependent.revision, blockerKey: completionBlocker.key },
      responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
    }),
    "Review dependency insertion",
  ).data.task;
  assert(!completionDependency.isReady, "Review dependent remained ready behind its blocker.");
  const completionClaim = expectSuccess(
    await claimTask(siteOrigin, graphAuth, completionBlocker.key),
    "Review blocker claim",
  ).data.task.currentClaim;
  expectError(
    await submitTask(siteOrigin, graphAuth, completionBlocker.key, {
      fence: completionClaim.fence,
      summary: "Credential-bearing evidence must be rejected.",
      evidence: [{ kind: "url", label: "unsafe", url: "https://user:secret@example.com/build" }],
    }),
    "VALIDATION_ERROR",
    "Credential-bearing submission evidence",
  );
  const submitKey = nextIdempotencyKey();
  const submitted = expectSuccess(
    await submitTask(
      siteOrigin,
      graphAuth,
      completionBlocker.key,
      {
        fence: completionClaim.fence,
        summary: "The blocker is complete and its evidence is immutable.",
        evidence: [
          { kind: "test", command: "bun test" },
          { kind: "url", label: "build", url: "https://example.com/build/42" },
        ],
      },
      submitKey,
    ),
    "Task submission",
  );
  const submittedReplay = expectSuccess(
    await submitTask(
      siteOrigin,
      graphAuth,
      completionBlocker.key,
      {
        fence: completionClaim.fence,
        summary: "The blocker is complete and its evidence is immutable.",
        evidence: [
          { kind: "test", command: "bun test" },
          { kind: "url", label: "build", url: "https://example.com/build/42" },
        ],
      },
      submitKey,
    ),
    "Task submission replay",
  );
  assertJsonEqual(submittedReplay, submitted, "Submission replay changed its immutable result.");
  assertEqual(submitted.data.task.status, "in_review", "Submission did not freeze task review state.");
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskUpdate(completionBlocker.key),
      body: { revision: submitted.data.task.revision, title: "Forbidden review edit" },
      responseSchema: taskctlApiOperations.updateTask.responseSchema,
    }),
    "TASK_IN_REVIEW",
    "Review-surface edit",
  );
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskReferences(completionBlocker.key),
      body: {
        revision: submitted.data.task.revision,
        reference: { kind: "url", label: "frozen", url: "https://example.com/frozen" },
      },
      responseSchema: taskctlApiOperations.addTaskReference.responseSchema,
    }),
    "TASK_IN_REVIEW",
    "Review-surface reference",
  );
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskParentSet(completionBlocker.key),
      body: { revision: submitted.data.task.revision, parentKey: completionDependent.key },
      responseSchema: taskctlApiOperations.setTaskParent.responseSchema,
    }),
    "TASK_IN_REVIEW",
    "Review-surface hierarchy",
  );
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(completionBlocker.key),
      body: { revision: submitted.data.task.revision, blockerKey: completionDependent.key },
      responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
    }),
    "TASK_IN_REVIEW",
    "Review-surface dependency",
  );
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskAssign(completionBlocker.key),
      body: { revision: submitted.data.task.revision, assigneeAgentId: activeA2.agentId },
      responseSchema: taskctlApiOperations.assignTask.responseSchema,
    }),
    "TASK_IN_REVIEW",
    "Review-surface assignment",
  );
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDefer(completionBlocker.key),
      body: { revision: submitted.data.task.revision, availableAt: Date.now() + 1_000 },
      responseSchema: taskctlApiOperations.deferTask.responseSchema,
    }),
    "TASK_IN_REVIEW",
    "Review-surface defer",
  );
  expectError(
    await acceptTask(siteOrigin, graphAuth, completionBlocker.key, {
      submissionId: submitted.data.submission.id,
      reviewRevision: submitted.data.submission.reviewRevision,
    }),
    "SELF_REVIEW_DENIED",
    "Stable-agent self review",
  );
  const reviewerAuth = authorization(activeA2);
  const queuedReview = expectSuccess(
    await reviewQueue(siteOrigin, reviewerAuth),
    "Reviewer queue",
  );
  assert(
    queuedReview.data.reviews.some(
      ({ submission }) => submission.id === submitted.data.submission.id,
    ),
    "Reviewer queue omitted the pending immutable submission.",
  );
  const acceptKey = nextIdempotencyKey();
  const accepted = expectSuccess(
    await acceptTask(
      siteOrigin,
      reviewerAuth,
      completionBlocker.key,
      {
        submissionId: submitted.data.submission.id,
        reviewRevision: submitted.data.submission.reviewRevision,
      },
      acceptKey,
    ),
    "Submission acceptance",
  );
  const acceptedReplay = expectSuccess(
    await acceptTask(
      siteOrigin,
      reviewerAuth,
      completionBlocker.key,
      {
        submissionId: submitted.data.submission.id,
        reviewRevision: submitted.data.submission.reviewRevision,
      },
      acceptKey,
    ),
    "Submission acceptance replay",
  );
  assertJsonEqual(acceptedReplay, accepted, "Acceptance replay changed its terminal result.");
  assertEqual(accepted.data.task.status, "done", "Acceptance did not complete the blocker.");
  const readyAfterAcceptance = expectSuccess(
    await readyTasks(siteOrigin, graphAuth),
    "Ready list after acceptance",
  );
  assert(
    readyAfterAcceptance.data.tasks.some((task) => task.key === completionDependent.key),
    "Acceptance did not make the dependent ready.",
  );

  const rejectionTask = expectSuccess(
    await createTask(siteOrigin, graphAuth, {
      title: "Review rejection lifecycle",
      type: "bug",
      priority: 2,
    }),
    "Rejection task creation",
  ).data.task;
  const rejectionClaim = expectSuccess(
    await claimTask(siteOrigin, graphAuth, rejectionTask.key),
    "Rejection task claim",
  ).data.task.currentClaim;
  const rejectionSubmission = expectSuccess(
    await submitTask(siteOrigin, graphAuth, rejectionTask.key, {
      fence: rejectionClaim.fence,
      summary: "First attempt requires reviewer feedback.",
      evidence: [{ kind: "note", text: "Evidence remains immutable after rejection." }],
    }),
    "Rejection task submission",
  );
  const fullReviewReason = `Missing delayed-session coverage: ${"r".repeat(1_500)}`;
  const rejected = expectSuccess(
    await rejectTask(siteOrigin, reviewerAuth, rejectionTask.key, {
      submissionId: rejectionSubmission.data.submission.id,
      reviewRevision: rejectionSubmission.data.submission.reviewRevision,
      reason: fullReviewReason,
    }),
    "Submission rejection",
  );
  assertEqual(
    rejected.data.submission.status === "rejected"
      ? rejected.data.submission.reviewReason
      : undefined,
    fullReviewReason,
    "Rejection did not preserve its full durable reason.",
  );
  assertEqual(rejected.data.task.status, "open", "Rejection did not reopen unclaimed work.");
  const editedAfterRejection = expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskUpdate(rejectionTask.key),
      body: { revision: rejected.data.task.revision, title: "Review rejection lifecycle fixed" },
      responseSchema: taskctlApiOperations.updateTask.responseSchema,
    }),
    "Post-rejection edit",
  );
  assertEqual(
    editedAfterRejection.data.task.reviewRevision,
    rejected.data.task.reviewRevision + 1,
    "Post-rejection specification edit did not advance review revision.",
  );
  logStep("completed submit/freeze/queue/four-eyes/accept/reject idempotent review lifecycle");

  for (const reviewCorruption of [
    { mode: "revision_mismatch" as const, expected: "SUBMISSION_STALE" as const },
    { mode: "zero_pending" as const, expected: "PROJECTION_MISMATCH" as const },
    { mode: "multiple_pending" as const, expected: "PROJECTION_MISMATCH" as const },
  ]) {
    const seeded = await runFixture(
      "localFixtures:seedInReviewTask",
      {
        workspaceId: workspaceA,
        title: `Review repair ${reviewCorruption.mode}`,
      },
      z
        .object({
          key: taskKeySchema,
          submissionId: z.string(),
          revision: z.number().int().positive(),
        })
        .strict(),
    );
    const corrupted = await runFixture(
      "localFixtures:corruptReviewProjection",
      {
        workspaceId: workspaceA,
        key: seeded.key,
        mode: reviewCorruption.mode,
      },
      z
        .object({
          revision: z.number().int().positive(),
          reviewRevision: z.number().int().positive(),
          pending: z.number().int().nonnegative(),
        })
        .strict(),
    );
    expectError(
      await acceptTask(siteOrigin, reviewerAuth, seeded.key, {
        submissionId: seeded.submissionId,
        reviewRevision: 1,
      }),
      reviewCorruption.expected,
      `Corrupt ${reviewCorruption.mode} review acceptance`,
    );
    const repaired = await waitUntil(`Review repair ${reviewCorruption.mode}`, async () => {
      const inspection = await runFixture(
        "localFixtures:inspectWorkspace",
        { workspaceId: workspaceA },
        inspectResultSchema,
      );
      const task = taskByKey(inspection, seeded.key);
      const submissions = inspection.submissions.filter(
        (submission) => submission.taskId === seeded.key,
      );
      return task.status === "open" &&
        task.reviewRevision >= corrupted.reviewRevision &&
        submissions.length >= 1 &&
        submissions.every((submission) => submission.status === "cancelled")
        ? { task, submissions }
        : null;
    });
    assertEqual(
      repaired.task.reviewRevision,
      corrupted.reviewRevision,
      `Review repair ${reviewCorruption.mode} moved reviewRevision backward.`,
    );
    expectError(
      await acceptTask(siteOrigin, reviewerAuth, seeded.key, {
        submissionId: seeded.submissionId,
        reviewRevision: 1,
      }),
      "TASK_STATE_CONFLICT",
      `Terminal ${reviewCorruption.mode} submission acceptance`,
    );
  }
  logStep("cancelled inconsistent review evidence monotonically and converged zero/multiple pending states");

  const driftBlocker = expectSuccess(
    await createTask(siteOrigin, graphAuth, { title: "Projection drift blocker", type: "task", priority: 1 }),
    "Projection blocker creation",
  ).data.task;
  const driftDependent = expectSuccess(
    await createTask(siteOrigin, graphAuth, { title: "Projection drift dependent", type: "task", priority: 1 }),
    "Projection dependent creation",
  ).data.task;
  const driftClaimed = expectSuccess(
    await claimTask(siteOrigin, graphAuth, driftDependent.key),
    "Projection dependent claim",
  ).data.task;
  const driftClaim = driftClaimed.currentClaim;
  expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(driftDependent.key),
      body: {
        revision: driftClaimed.revision,
        fence: driftClaim.fence,
        blockerKey: driftBlocker.key,
      },
      responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
    }),
    "Claimed-work blocker insertion",
  );
  await runFixture(
    "localFixtures:corruptTaskReadiness",
    { workspaceId: workspaceA, key: driftDependent.key },
    z.object({ corrupted: z.literal(true) }).strict(),
  );
  expectError(
    await submitTask(siteOrigin, graphAuth, driftDependent.key, {
      fence: driftClaim.fence,
      summary: "A corrupt compact counter must not hide the newly added blocker.",
      evidence: [{ kind: "test", command: "counter-corruption-submit" }],
    }),
    "PROJECTION_MISMATCH",
    "Corrupt blocker projection submission",
  );
  await waitUntil("Corrupt blocker projection repair", async () => {
    const detail = expectSuccess(
      await authenticatedGet({
        siteOrigin,
        auth: graphAuth,
        path: taskctlApiRoutes.task(driftDependent.key),
        responseSchema: taskctlApiOperations.getTask.responseSchema,
      }),
      "Projection repair detail",
    );
    return detail.data.task.unresolvedBlockerCount === 1 && !detail.data.task.isReady
      ? detail
      : null;
  });
  expectError(
    await submitTask(siteOrigin, graphAuth, driftDependent.key, {
      fence: driftClaim.fence,
      summary: "The repaired actual blocker must still prevent submission.",
      evidence: [{ kind: "test", command: "actual-blocker-submit" }],
    }),
    "TASK_BLOCKED",
    "Repaired blocker projection submission",
  );
  const releasedDriftTask = expectSuccess(
    await releaseClaim(siteOrigin, graphAuth, driftDependent.key, driftClaim.fence),
    "Blocked claimed-work release",
  ).data.task;
  assert(
    releasedDriftTask.status === "open" && !releasedDriftTask.isReady,
    "Releasing blocker-gated work made it ready.",
  );

  const claimBoundEditCases = [
    {
      label: "update",
      invoke: async (task: { readonly key: TaskKey; readonly revision: number }, fence: number) =>
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskUpdate(task.key),
          body: { revision: task.revision, fence, title: "Forbidden corrupt-claim update" },
          responseSchema: taskctlApiOperations.updateTask.responseSchema,
        }),
    },
    {
      label: "assignment",
      invoke: async (task: { readonly key: TaskKey; readonly revision: number }) =>
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskAssign(task.key),
          body: { revision: task.revision, assigneeAgentId: activeA2.agentId },
          responseSchema: taskctlApiOperations.assignTask.responseSchema,
        }),
    },
    {
      label: "defer",
      invoke: async (task: { readonly key: TaskKey; readonly revision: number }, fence: number) =>
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskDefer(task.key),
          body: { revision: task.revision, fence, availableAt: Date.now() + 5_000 },
          responseSchema: taskctlApiOperations.deferTask.responseSchema,
        }),
    },
    {
      label: "label",
      invoke: async (task: { readonly key: TaskKey; readonly revision: number }, fence: number) =>
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskLabels(task.key),
          body: { revision: task.revision, fence, label: "corrupt-claim" },
          responseSchema: taskctlApiOperations.addTaskLabel.responseSchema,
        }),
    },
    {
      label: "reference",
      invoke: async (task: { readonly key: TaskKey; readonly revision: number }, fence: number) =>
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskReferences(task.key),
          body: {
            revision: task.revision,
            fence,
            reference: { kind: "url", label: "corrupt", url: "https://example.com/corrupt" },
          },
          responseSchema: taskctlApiOperations.addTaskReference.responseSchema,
        }),
    },
    {
      label: "dependency",
      invoke: async (task: { readonly key: TaskKey; readonly revision: number }, fence: number) =>
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskDependencies(task.key),
          body: { revision: task.revision, fence, blockerKey: driftBlocker.key },
          responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
        }),
    },
    {
      label: "parent",
      invoke: async (task: { readonly key: TaskKey; readonly revision: number }, fence: number) =>
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskParentSet(task.key),
          body: { revision: task.revision, fence, parentKey: driftBlocker.key },
          responseSchema: taskctlApiOperations.setTaskParent.responseSchema,
        }),
    },
  ] as const;
  for (const [index, editCase] of claimBoundEditCases.entries()) {
    const created = expectSuccess(
      await createTask(siteOrigin, graphAuth, {
        title: `Compact claim drift ${editCase.label}`,
        type: "task",
        priority: 1,
      }),
      `Claim drift ${editCase.label} task creation`,
    ).data.task;
    const claimedTask = expectSuccess(
      await claimTask(siteOrigin, graphAuth, created.key),
      `Claim drift ${editCase.label} acquisition`,
    ).data.task;
    await runFixture(
      "localFixtures:corruptClaimTuple",
      { workspaceId: workspaceA, key: created.key },
      z.object({ corrupted: z.literal(true) }).strict(),
    );
    const deniedEdit: HttpResult<unknown> = await editCase.invoke(
      claimedTask,
      claimedTask.currentClaim.fence,
    );
    expectError(
      deniedEdit,
      "PROJECTION_MISMATCH",
      `Corrupt compact claim ${editCase.label}`,
    );
    if (index === 0) {
      expectSuccess(
        await authenticatedPost({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.taskComments(created.key),
          body: { body: "Ordinary comments remain scope-based during claim repair." },
          responseSchema: taskctlApiOperations.addTaskComment.responseSchema,
        }),
        "Corrupt-claim ordinary comment",
      );
    }
    await waitUntil(`Compact claim ${editCase.label} repair`, async () => {
      const detail = expectSuccess(
        await authenticatedGet({
          siteOrigin,
          auth: graphAuth,
          path: taskctlApiRoutes.task(created.key),
          responseSchema: taskctlApiOperations.getTask.responseSchema,
        }),
        `Claim ${editCase.label} repair detail`,
      );
      return detail.data.task.status === "open" ? detail : null;
    });
  }
  logStep("failed closed on every claim-bound edit under durable tuple corruption while comments remained scope-based");

  const fanoutRoot = expectSuccess(
    await createTask(siteOrigin, graphAuth, {
      title: "Maximum dependency fanout root",
      type: "task",
      priority: 0,
    }),
    "Maximum fanout root creation",
  ).data.task;
  const maximumFanout = 500;
  for (let ordinalStart = 0; ordinalStart < maximumFanout; ordinalStart += 50) {
    const seeded = await runFixture(
      "localFixtures:seedBlockingDependents",
      {
        workspaceId: workspaceA,
        blockerKey: fanoutRoot.key,
        ordinalStart,
        count: 50,
      },
      z.object({ created: z.number().int().positive() }).strict(),
    );
    assertEqual(seeded.created, 50, "Maximum fanout fixture seeded the wrong batch size.");
  }
  const overflowDependent = expectSuccess(
    await createTask(siteOrigin, graphAuth, {
      title: "Fanout 501 must fail",
      type: "task",
      priority: 4,
    }),
    "Fanout overflow dependent creation",
  ).data.task;
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: graphAuth,
      path: taskctlApiRoutes.taskDependencies(overflowDependent.key),
      body: { revision: overflowDependent.revision, blockerKey: fanoutRoot.key },
      responseSchema: taskctlApiOperations.addTaskDependency.responseSchema,
    }),
    "DEPENDENT_LIMIT",
    "Fanout 501 insertion",
  );
  const fanoutClaim = expectSuccess(
    await claimTask(siteOrigin, graphAuth, fanoutRoot.key),
    "Maximum fanout root claim",
  ).data.task.currentClaim;
  const fanoutSubmission = expectSuccess(
    await submitTask(siteOrigin, graphAuth, fanoutRoot.key, {
      fence: fanoutClaim.fence,
      summary: "Completing this root must atomically unblock exactly 500 dependents.",
      evidence: [{ kind: "test", command: "maximum-fanout-live-acceptance" }],
    }),
    "Maximum fanout root submission",
  );
  const fanoutStartedAt = performance.now();
  const fanoutAccepted = expectSuccess(
    await acceptTask(siteOrigin, reviewerAuth, fanoutRoot.key, {
      submissionId: fanoutSubmission.data.submission.id,
      reviewRevision: fanoutSubmission.data.submission.reviewRevision,
    }),
    "Maximum fanout root acceptance",
  );
  const fanoutElapsedMs = performance.now() - fanoutStartedAt;
  assertEqual(fanoutAccepted.data.task.status, "done", "Maximum fanout root did not complete.");
  const fanoutProjection = await runFixture(
    "localFixtures:inspectBlockingDependents",
    { workspaceId: workspaceA, blockerKey: fanoutRoot.key },
    z
      .object({
        total: z.number().int().nonnegative(),
        ready: z.number().int().nonnegative(),
        unresolved: z.number().int().nonnegative(),
      })
      .strict(),
  );
  assertEqual(fanoutProjection.total, maximumFanout, "Maximum fanout edge count changed.");
  assertEqual(fanoutProjection.ready, maximumFanout, "Maximum fanout did not make every dependent ready.");
  assertEqual(fanoutProjection.unresolved, 0, "Maximum fanout left unresolved blocker counters.");
  logStep(`propagated the exact 500-dependent maximum in ${fanoutElapsedMs.toFixed(1)}ms and rejected dependent 501`);

  const fanoutRateFixture = await runFixture(
    "localFixtures:inspectWorkspace",
    { workspaceId: workspaceA },
    inspectResultSchema,
  );
  const claimLoadTasks = fanoutRateFixture.tasks
    .filter((task) => task.title.startsWith("Fanout dependent ") && task.isReady)
    .sort((left, right) => left.title.localeCompare(right.title))
    .slice(0, 100);
  assertEqual(claimLoadTasks.length, 100, "Claim-class load fixture did not expose 100 distinct tasks.");
  await resetApiRateLimits({ routeClass: "agent_claim" });
  const claimLoadResults = await Promise.all(
    claimLoadTasks.map(async (task, index) =>
      await claimTask(
        siteOrigin,
        authorization(index % 2 === 0 ? activeA1 : activeA2),
        task.key,
      ),
    ),
  );
  for (const [index, result] of claimLoadResults.entries()) {
    expectSuccess(result, `Rate-limited distinct-task claim ${index + 1}`);
  }
  expectSuccess(
    await claimTask(siteOrigin, authorization(activeB1), tenantBTask.key),
    "Second-workspace claim-rate isolation",
  );
  const authenticatedRateRows = await inspectApiRateLimits();
  const agentClaimRows = authenticatedRateRows.filter(
    (row) => row.routeClass === "agent_claim",
  );
  const aggregateBySubject = (
    rows: readonly z.infer<typeof rateLimitBucketSchema>[],
    kind: z.infer<typeof rateLimitBucketSchema>["subjectKind"],
  ) => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.subjectKind !== kind) continue;
      counts.set(row.subjectKey, (counts.get(row.subjectKey) ?? 0) + row.count);
    }
    return [...counts.values()].sort((left, right) => left - right);
  };
  assertJsonEqual(
    aggregateBySubject(agentClaimRows, "credential"),
    [1, 50, 50],
    "Claim-class limiter did not isolate three credential subjects.",
  );
  assertJsonEqual(
    aggregateBySubject(agentClaimRows, "workspace"),
    [1, 100],
    "Claim-class limiter did not isolate two workspace subjects.",
  );
  const publicRateSelectors = [
    activeA1.credentialLocator,
    activeA2.credentialLocator,
    activeB1.credentialLocator,
    workspaceA,
    workspaceB,
    activeA1.agentId,
    activeA2.agentId,
    activeB1.agentId,
  ];
  for (const row of authenticatedRateRows) {
    assert(
      !publicRateSelectors.includes(row.subjectKey) &&
        !row.subjectKey.includes("user_") &&
        !row.subjectKey.includes("agt_") &&
        !row.subjectKey.includes("enr_"),
      "Authenticated limiter persistence exposed a public identity or bearer selector.",
    );
  }
  const validatedAuthenticatedRateSubjects = await runFixture(
    "localFixtures:validateApiRateLimitSubjects",
    {},
    validateApiRateLimitSubjectsResultSchema,
  );
  assert(
    validatedAuthenticatedRateSubjects.authenticated > 0 &&
      validatedAuthenticatedRateSubjects.invalid === 0,
    "Authenticated limiter subject keys were not live Convex document IDs.",
  );
  assert(
    authenticatedRateRows.some((row) => row.routeClass !== "agent_claim"),
    "Rate-limit route-class isolation fixture lacked a non-claim row.",
  );
  const clearedClaimRateRows = await resetApiRateLimits({ routeClass: "agent_claim" });
  assert(clearedClaimRateRows.deleted > 0, "Claim-rate fixture reset deleted no selected rows.");
  const afterClaimRateReset = await inspectApiRateLimits();
  assert(
    !afterClaimRateReset.some((row) => row.routeClass === "agent_claim") &&
      afterClaimRateReset.some((row) => row.routeClass !== "agent_claim"),
    "Selected claim-rate reset crossed route classes or left current buckets behind.",
  );
  logStep("admitted 100 distinct-task claims under credential/workspace limits and proved selected route reset isolation");

  const crossTenantClaimSource = expectSuccess(
    await createTask(siteOrigin, graphAuth, {
      title: "Cross-tenant compact claim pointer",
      type: "task",
      priority: 1,
    }),
    "Cross-tenant claim source creation",
  ).data.task;
  expectSuccess(
    await claimTask(siteOrigin, graphAuth, crossTenantClaimSource.key),
    "Cross-tenant claim source acquisition",
  );
  const foreignPointer = await runFixture(
    "localFixtures:corruptClaimPointerAcrossTenants",
    {
      sourceWorkspaceId: workspaceA,
      sourceKey: crossTenantClaimSource.key,
      targetWorkspaceId: workspaceB,
      targetKey: tenantBTask.key,
    },
    z.object({ corrupted: z.literal(true), targetClaimId: z.string() }).strict(),
  );
  const corruptPointerContextError = expectError(
    await context(siteOrigin, graphAuth),
    "PROJECTION_MISMATCH",
    "Cross-tenant compact claim context",
  );
  assert(
    corruptPointerContextError.error.details.ownerAgentId === undefined &&
      corruptPointerContextError.error.details.leaseUntil === undefined,
    "Context disclosed ownership metadata from a corrupt compact claim pointer.",
  );
  const corruptPointerClaimError = expectError(
    await claimTask(siteOrigin, graphAuth, crossTenantClaimSource.key),
    "PROJECTION_MISMATCH",
    "Cross-tenant compact claim acquisition",
  );
  assert(
    corruptPointerClaimError.error.details.ownerAgentId === undefined &&
      corruptPointerClaimError.error.details.leaseUntil === undefined,
    "A corrupt compact claim pointer disclosed claim ownership or lease metadata.",
  );
  assert(
    !JSON.stringify(corruptPointerClaimError).includes(foreignPointer.targetClaimId),
    "A corrupt compact claim pointer disclosed the foreign durable claim ID.",
  );
  await waitUntil("Cross-tenant compact claim repair", async () => {
    const source = expectSuccess(
      await authenticatedGet({
        siteOrigin,
        auth: graphAuth,
        path: taskctlApiRoutes.task(crossTenantClaimSource.key),
        responseSchema: taskctlApiOperations.getTask.responseSchema,
      }),
      "Cross-tenant source detail",
    );
    return source.data.task.status === "open" ? source : null;
  });
  const foreignWorkspaceAfterRepair = await runFixture(
    "localFixtures:inspectWorkspace",
    { workspaceId: workspaceB },
    inspectResultSchema,
  );
  assert(
    foreignWorkspaceAfterRepair.claims.some(
      (claim) => claim.id === foreignPointer.targetClaimId && claim.state === "active",
    ),
    "Local claim repair mutated the foreign tenant's durable active claim.",
  );
  const readyAfterForeignPointer = expectSuccess(
    await readyTasks(siteOrigin, graphAuth),
    "Ready list after foreign compact pointer repair",
  );
  assert(
    !readyAfterForeignPointer.data.tasks.some((task) => task.id === tenantBTask.id),
    "Foreign-tenant task data leaked through a corrupt compact claim pointer.",
  );
  logStep("repaired a cross-tenant compact pointer without exposing or mutating the foreign claim");

  const scopedPaginationTask = expectSuccess(
    await createTask(
      siteOrigin,
      authorization(activeA1Pagination),
      { title: "Same agent and idempotency key in another workspace", type: "task", priority: 2 },
      sharedKey,
    ),
    "Workspace-scoped idempotency key reuse",
  );
  const paginationTasks = [scopedPaginationTask.data.task];
  const additionalPaginationTaskCount = 104;
  const paginationBatchSize = 20;
  for (let start = 0; start < additionalPaginationTaskCount; start += paginationBatchSize) {
    const count = Math.min(paginationBatchSize, additionalPaginationTaskCount - start);
    const batch = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const ordinal = start + index + 2;
        return expectSuccess(
          await createTask(siteOrigin, authorization(activeA1Pagination), {
            title: `Pagination task ${ordinal.toString().padStart(3, "0")}`,
            type: "task",
            priority: ordinal % 5,
          }),
          `Pagination task ${ordinal}`,
        ).data.task;
      }),
    );
    paginationTasks.push(...batch);
  }
  const paginationOverdueTask = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1Pagination), {
      title: "Pagination overdue direct-reclaim candidate",
      type: "bug",
      priority: 0,
    }),
    "Pagination overdue task creation",
  ).data.task;
  const paginationClaim = expectSuccess(
    await claimTask(siteOrigin, authorization(activeA1Pagination), paginationOverdueTask.key),
    "Pagination overdue task claim",
  ).data.task.currentClaim;
  const paginationDeadline = await runFixture(
    "localFixtures:shortenClaimDeadline",
    {
      workspaceId: workspaceAPagination,
      key: paginationOverdueTask.key,
      delayMs: 125,
      scheduleExpiry: false,
    },
    shortenResultSchema,
  );
  assertEqual(
    paginationDeadline.fence,
    paginationClaim.fence,
    "Pagination deadline shortening changed the fence.",
  );
  await waitPast(paginationDeadline.leaseUntil, 25);
  const paginatedReady = await collectReadyTasks(
    siteOrigin,
    authorization(activeA1Pagination),
    31,
  );
  const expectedPaginationTaskIds = new Set([
    ...paginationTasks.map((task) => task.id),
    paginationOverdueTask.id,
  ]);
  assertEqual(expectedPaginationTaskIds.size, 106, "Pagination fixture did not create 106 unique tasks.");
  assert(paginatedReady.pageCount >= 4, "Ready pagination did not traverse more than 100 tasks.");
  assertEqual(
    paginatedReady.tasks.length,
    expectedPaginationTaskIds.size,
    "Ready pagination lost or added tasks.",
  );
  for (const taskId of expectedPaginationTaskIds) {
    assert(
      paginatedReady.tasks.some((task) => task.id === taskId),
      `Ready pagination lost task ${taskId}.`,
    );
  }
  const paginatedOverdue = paginatedReady.tasks.find(
    (task) => task.id === paginationOverdueTask.id,
  );
  assert(
    paginatedOverdue?.status === "in_progress",
    "Ready pagination omitted the overdue direct-reclaim branch.",
  );
  logStep("scoped receipts by workspace and traversed 106 ready rows without duplicates or loss");

  let expectedPaginationTaskCount = 106;
  if (process.env.TASKCTL_LOCAL_READY_LOAD_10000 === "true") {
    const target = 10_000;
    const remaining = target - expectedPaginationTaskCount;
    const seedStartedAt = performance.now();
    for (let start = 0; start < remaining; start += 100) {
      const count = Math.min(100, remaining - start);
      const seeded = await runFixture(
        "localFixtures:seedReadyTaskBatch",
        {
          workspaceId: workspaceAPagination,
          ordinalStart: expectedPaginationTaskCount + start,
          count,
        },
        z.object({ created: z.number().int().positive() }).strict(),
      );
      assertEqual(seeded.created, count, "Ready load fixture seeded the wrong batch size.");
    }
    const seedElapsedMs = performance.now() - seedStartedAt;
    const clearedReadRateRows = await resetApiRateLimits({ routeClass: "agent_read" });
    assert(
      clearedReadRateRows.deleted > 0,
      "Ready load fixture reset no prior agent-read buckets before measurement.",
    );
    const queryStartedAt = performance.now();
    const loaded = await collectReadyTasks(
      siteOrigin,
      authorization(activeA1Pagination),
      100,
      120,
    );
    const queryElapsedMs = performance.now() - queryStartedAt;
    assertEqual(loaded.tasks.length, target, "10,000-task ready load lost or duplicated work.");
    expectedPaginationTaskCount = target;
    logStep(
      `measured 10,000 ready tasks: seed=${seedElapsedMs.toFixed(1)}ms query=${queryElapsedMs.toFixed(1)}ms pages=${loaded.pageCount}`,
    );
  }

  const raceTaskEnvelope = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1), {
      title: "Atomic claim race",
      type: "bug",
      priority: 0,
    }),
    "Claim-race task creation",
  );
  const raceTask = raceTaskEnvelope.data.task;
  const racers = Array.from({ length: 100 }, (_, index) =>
    index % 2 === 0 ? activeA1 : activeA2,
  );
  const raceResults = await Promise.all(
    racers.map(async (agent) => ({ agent, result: await claimTask(siteOrigin, authorization(agent), raceTask.key) })),
  );
  const winners = raceResults.filter((entry) => entry.result.ok);
  const losers = raceResults.filter((entry) => !entry.result.ok);
  assertEqual(winners.length, 1, "The claim race did not produce exactly one winner.");
  assertEqual(losers.length, 99, "The 100-way claim race did not produce exactly 99 losers.");
  const winningEntry = winners[0];
  assert(winningEntry !== undefined, "The claim race result omitted its winner.");
  const losingAgent =
    winningEntry.agent.agentId === activeA1.agentId ? activeA2 : activeA1;
  const losingEntry = losers.find((entry) => entry.agent.agentId === losingAgent.agentId);
  assert(losingEntry !== undefined, "The claim race omitted a losing attempt from the other stable agent.");
  const claimed = expectSuccess(winningEntry.result, "Winning claim");
  for (const [index, loser] of losers.entries()) {
    expectError(loser.result, "TASK_ALREADY_CLAIMED", `Losing claim ${index + 1}`);
  }
  const initialClaim = claimed.data.task.currentClaim;
  assertEqual(initialClaim.agentId, winningEntry.agent.agentId, "The claim was assigned to the wrong agent.");
  logStep("resolved 100 simultaneous claim attempts with one winner and 99 typed losers");

  const shortenedForRenewal = await runFixture(
    "localFixtures:shortenClaimDeadline",
    { workspaceId: workspaceA, key: raceTask.key, delayMs: 1_000, scheduleExpiry: true },
    shortenResultSchema,
  );
  assertEqual(shortenedForRenewal.fence, initialClaim.fence, "Deadline shortening changed the ownership fence.");
  const renewed = expectSuccess(
    await renewClaim(siteOrigin, authorization(winningEntry.agent), raceTask.key, initialClaim.fence),
    "Claim renewal",
  );
  assertEqual(renewed.data.task.currentClaim.fence, initialClaim.fence, "Renewal changed the ownership fence.");
  assertEqual(
    renewed.data.task.currentClaim.leaseGeneration,
    shortenedForRenewal.leaseGeneration + 1,
    "Renewal did not advance the lease generation.",
  );
  assert(
    renewed.data.task.currentClaim.leaseUntil > shortenedForRenewal.leaseUntil,
    "Renewal did not extend the lease deadline.",
  );
  const beforeStaleExpiry = await runFixture(
    "localFixtures:inspectWorkspace",
    { workspaceId: workspaceA },
    inspectResultSchema,
  );
  const beforeStaleTask = taskByKey(beforeStaleExpiry, raceTask.key);
  await waitPast(shortenedForRenewal.leaseUntil, 1_500);
  const afterStaleExpiry = await runFixture(
    "localFixtures:inspectWorkspace",
    { workspaceId: workspaceA },
    inspectResultSchema,
  );
  const afterStaleTask = taskByKey(afterStaleExpiry, raceTask.key);
  assertEqual(afterStaleTask.status, "in_progress", "A stale expiry released the renewed claim.");
  assertEqual(afterStaleTask.revision, beforeStaleTask.revision, "A stale expiry changed the task revision.");
  assertEqual(
    afterStaleExpiry.taskEvents.filter((event) => event.taskId === raceTask.id).length,
    beforeStaleExpiry.taskEvents.filter((event) => event.taskId === raceTask.id).length,
    "A stale expiry appended a task event.",
  );
  assert(
    afterStaleTask.status === "in_progress" &&
      afterStaleTask.currentClaim.leaseGeneration === renewed.data.task.currentClaim.leaseGeneration,
    "A stale expiry changed the renewed lease generation.",
  );
  logStep("renewed without changing the fence and observed the stale expiry no-op");

  const shortenedForReclaim = await runFixture(
    "localFixtures:shortenClaimDeadline",
    { workspaceId: workspaceA, key: raceTask.key, delayMs: 125, scheduleExpiry: false },
    shortenResultSchema,
  );
  await waitPast(shortenedForReclaim.leaseUntil, 25);
  const reclaimed = expectSuccess(
    await claimTask(siteOrigin, authorization(losingEntry.agent), raceTask.key),
    "Direct overdue reclaim",
  );
  assert(
    reclaimed.data.task.currentClaim.fence > initialClaim.fence,
    "Direct reclaim did not advance the ownership fence.",
  );
  assertEqual(reclaimed.data.task.currentClaim.leaseGeneration, 1, "Direct reclaim did not start a new lease generation.");
  assertEqual(reclaimed.data.task.currentClaim.agentId, losingEntry.agent.agentId, "Direct reclaim kept the stale owner.");
  expectError(
    await renewClaim(siteOrigin, authorization(winningEntry.agent), raceTask.key, initialClaim.fence),
    "CLAIM_NOT_OWNED",
    "Stale owner renewal",
  );
  expectError(
    await submitTask(siteOrigin, authorization(winningEntry.agent), raceTask.key, {
      fence: initialClaim.fence,
      summary: "A stale owner must not submit after reassignment.",
      evidence: [{ kind: "test", command: "stale-owner-submit" }],
    }),
    "CLAIM_NOT_OWNED",
    "Stale owner submission",
  );
  expectError(
    await authenticatedPost({
      siteOrigin,
      auth: authorization(winningEntry.agent),
      path: taskctlApiRoutes.taskUpdate(raceTask.key),
      body: {
        revision: reclaimed.data.task.revision,
        fence: initialClaim.fence,
        title: "A stale owner must not edit reassigned work",
      },
      responseSchema: taskctlApiOperations.updateTask.responseSchema,
    }),
    "CLAIM_NOT_OWNED",
    "Stale owner claim-bound edit",
  );
  expectSuccess(
    await authenticatedPost({
      siteOrigin,
      auth: authorization(winningEntry.agent),
      path: taskctlApiRoutes.taskComments(raceTask.key),
      body: { body: "Ordinary comments remain scope-based after claim reassignment." },
      responseSchema: taskctlApiOperations.addTaskComment.responseSchema,
    }),
    "Stale owner ordinary comment",
  );
  expectError(
    await releaseClaim(siteOrigin, authorization(winningEntry.agent), raceTask.key, initialClaim.fence),
    "CLAIM_NOT_OWNED",
    "Stale owner release",
  );
  const released = expectSuccess(
    await releaseClaim(
      siteOrigin,
      authorization(losingEntry.agent),
      raceTask.key,
      reclaimed.data.task.currentClaim.fence,
    ),
    "Current owner release",
  );
  assertEqual(released.data.task.status, "open", "Release did not return the task to open.");
  assert(released.data.task.isReady, "Released unblocked work was not ready.");
  logStep("reclaimed an overdue lease directly, fenced its stale owner, and released it");

  const scheduledExpiryTask = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1), {
      title: "Scheduled claim expiry",
      type: "chore",
      priority: 1,
    }),
    "Scheduled-expiry task creation",
  ).data.task;
  const scheduledExpiryClaim = expectSuccess(
    await claimTask(siteOrigin, authorization(activeA1), scheduledExpiryTask.key),
    "Scheduled-expiry task claim",
  ).data.task.currentClaim;
  const scheduledExpiryDeadline = await runFixture(
    "localFixtures:shortenClaimDeadline",
    {
      workspaceId: workspaceA,
      key: scheduledExpiryTask.key,
      delayMs: 125,
      scheduleExpiry: true,
    },
    shortenResultSchema,
  );
  assertEqual(
    scheduledExpiryDeadline.fence,
    scheduledExpiryClaim.fence,
    "Scheduled expiry fixture changed the claim fence.",
  );
  await waitUntil("Scheduled claim expiry", async () => {
    const detail = expectSuccess(
      await authenticatedGet({
        siteOrigin,
        auth: authorization(activeA1),
        path: taskctlApiRoutes.task(scheduledExpiryTask.key),
        responseSchema: taskctlApiOperations.getTask.responseSchema,
      }),
      "Scheduled-expiry task detail",
    );
    return detail.data.task.status === "open" && detail.data.task.isReady ? detail : null;
  });
  logStep("observed an abandoned claim return to ready through the real scheduler");

  // A prior interrupted local run may have stopped after seeding its global
  // sweep fixture. Drain those due rows through the real production sweeps so
  // this run's exact 65-row page assertion remains deterministic without
  // deleting or replacing the developer's local Convex database.
  await waitUntil(
    "Prior local sweep backlog",
    async () => {
      try {
        const prior = await runFixture(
          "localFixtures:runTaskSweepsNow",
          {},
          z
            .object({
              claims: z.object({ scheduled: z.number().int().nonnegative(), hasMore: z.boolean() }).strict(),
              wakes: z.object({ scheduled: z.number().int().nonnegative(), hasMore: z.boolean() }).strict(),
            })
            .strict(),
        );
        if (prior.claims.scheduled === 0 && prior.wakes.scheduled === 0) return prior;
      } catch (error: unknown) {
        // An already scheduled expiry can win against the sweep's indexed
        // range read. Let the production self-chain drain before probing again
        // instead of creating a tight retry loop that starves both mutations.
        await Bun.sleep(1_000);
        throw error;
      }
      await Bun.sleep(1_000);
      return null;
    },
    120_000,
  );

  const sweepBacklog = await runFixture(
    "localFixtures:seedSweepBacklog",
    { workspaceId: workspaceA, count: 65 },
    z.object({ seeded: z.literal(65) }).strict(),
  );
  assertEqual(sweepBacklog.seeded, 65, "Sweep backlog fixture did not cross the 64-row page.");
  const sweepStarted = await runFixture(
    "localFixtures:runTaskSweepsNow",
    {},
    z
      .object({
        claims: z.object({ scheduled: z.number().int().nonnegative(), hasMore: z.boolean() }).strict(),
        wakes: z.object({ scheduled: z.number().int().nonnegative(), hasMore: z.boolean() }).strict(),
      })
      .strict(),
  );
  assert(
    sweepStarted.claims.scheduled === 64 &&
      sweepStarted.claims.hasMore &&
      sweepStarted.wakes.scheduled === 64 &&
      sweepStarted.wakes.hasMore,
    "The first bounded sweep page did not schedule 64 rows and self-chain its remainder.",
  );
  await waitUntil("Self-chained claim and wake sweep backlog", async () => {
    const inspection = await runFixture(
      "localFixtures:inspectWorkspace",
      { workspaceId: workspaceA },
      inspectResultSchema,
    );
    const tasks = inspection.tasks.filter((task) => task.title.startsWith("Sweep backlog "));
    const claimIds = new Set(tasks.map((task) => task.id));
    const claims = inspection.claims.filter((claim) => claimIds.has(claim.taskId));
    const wakes = inspection.wakes.filter((wake) =>
      tasks.some((task) => task.key === wake.taskId),
    );
    return tasks.length === 65 &&
      tasks.every((task) => task.status === "open" && task.isReady) &&
      claims.length === 65 &&
      claims.every((claim) => claim.state === "expired") &&
      wakes.length === 65 &&
      wakes.every((wake) => wake.state !== "pending")
      ? inspection
      : null;
  });
  logStep("self-chained claim and wake sweeps drained a 65-row backlog past the 64-row page");

  const deferredAvailableAt = Date.now() + 2_000;
  const deferred = expectSuccess(
    await createTask(siteOrigin, authorization(activeA1), {
      title: "Scheduled defer wake",
      type: "chore",
      priority: 1,
      availableAt: deferredAvailableAt,
    }),
    "Deferred task creation",
  );
  assert(!deferred.data.task.isReady, "Deferred work was ready before its deadline.");
  const beforeWake = expectSuccess(await readyTasks(siteOrigin, authorization(activeA1)), "Ready list before defer wake");
  assert(
    !beforeWake.data.tasks.some((task) => task.key === deferred.data.task.key),
    "Deferred work appeared in ready results before its deadline.",
  );
  await waitUntil("Deferred task wake", async () => {
    const detail = expectSuccess(
      await authenticatedGet({
        siteOrigin,
        auth: authorization(activeA1),
        path: taskctlApiRoutes.task(deferred.data.task.key),
        responseSchema: taskctlApiOperations.getTask.responseSchema,
      }),
      "Deferred task detail during wake",
    );
    return detail.data.task.isReady ? detail : null;
  });
  const readyAfterWake = await collectReadyTasks(siteOrigin, authorization(activeA1), 100);
  assert(
    readyAfterWake.tasks.some((task) => task.key === deferred.data.task.key),
    "Materialized deferred work was missing from complete ready pagination.",
  );
  logStep("observed the real scheduler materialize deferred readiness");

  const revoked = await runFixture(
    "localFixtures:revokeCredential",
    { credentialLocator: activeB1.credentialLocator },
    revokeResultSchema,
  );
  assert(revoked.revoked, "The credential revocation fixture did not find its target.");
  expectError(
    await context(siteOrigin, authorization(activeB1)),
    "AUTHENTICATION_FAILED",
    "Revoked credential request",
  );
  logStep("proved final-transaction credential revocation");

  const unknownCredential = unknownCredentialToken(runSeed + 900_000);
  const credentialFailureRequest = async (credential: CredentialToken) =>
    await context(siteOrigin, { credential, sessionId: activeA1.sessionId });
  const saturatedCredentialSlot = await saturateAuthenticationFailureSlot({
    label: "Unknown credential",
    routeClass: "agent_auth_failure",
    perShardAllowance: 8,
    request: async () => await credentialFailureRequest(unknownCredential),
  });
  let isolatedCredentialSlot: string | undefined;
  for (let offset = 0; offset < 16; offset += 1) {
    const candidate = unknownCredentialToken(runSeed + 910_000 + offset * 17);
    const result = await credentialFailureRequest(candidate);
    if (!result.ok && result.envelope.error.code === "AUTHENTICATION_FAILED") {
      const slots = new Set(
        (await inspectApiRateLimits())
          .filter(
            (row) =>
              row.routeClass === "agent_auth_failure" &&
              row.subjectKind === "unauthenticated",
          )
          .map((row) => row.subjectKey),
      );
      isolatedCredentialSlot = [...slots].find((slot) => slot !== saturatedCredentialSlot);
      if (isolatedCredentialSlot !== undefined) break;
    } else {
      expectError(result, "RATE_LIMITED", `Credential slot collision ${offset + 1}`);
    }
  }
  assert(
    isolatedCredentialSlot !== undefined,
    "A distinct unknown credential did not receive an isolated opaque slot.",
  );
  const clearedCredentialSlot = await resetApiRateLimits({
    subjectKind: "unauthenticated",
    subjectKey: saturatedCredentialSlot,
    routeClass: "agent_auth_failure",
  });
  assert(clearedCredentialSlot.deleted >= 4, "Credential failure-slot reset was incomplete.");
  expectError(
    await credentialFailureRequest(unknownCredential),
    "AUTHENTICATION_FAILED",
    "Credential failure-slot admission after reset",
  );

  const unknownEnrollment = unknownEnrollmentToken(runSeed + 920_000);
  const enrollmentBodyCredential = unknownCredentialToken(runSeed + 930_000);
  const enrollmentFailureRequest = async (enrollment: EnrollmentToken) =>
    await apiRequest({
      siteOrigin,
      method: taskctlApiOperations.redeemEnrollment.method,
      path: taskctlApiRoutes.redeemEnrollment,
      authorization: enrollment,
      idempotencyKey: nextIdempotencyKey(),
      body: { credential: enrollmentBodyCredential },
      responseSchema: taskctlApiOperations.redeemEnrollment.responseSchema,
    });
  const saturatedEnrollmentSlot = await saturateAuthenticationFailureSlot({
    label: "Unknown enrollment",
    routeClass: "enrollment_auth_failure",
    perShardAllowance: 4,
    request: async () => await enrollmentFailureRequest(unknownEnrollment),
  });
  let isolatedEnrollmentSlot: string | undefined;
  for (let offset = 0; offset < 16; offset += 1) {
    const candidate = unknownEnrollmentToken(runSeed + 940_000 + offset * 17);
    const result = await enrollmentFailureRequest(candidate);
    if (!result.ok && result.envelope.error.code === "AUTHENTICATION_FAILED") {
      const slots = new Set(
        (await inspectApiRateLimits())
          .filter(
            (row) =>
              row.routeClass === "enrollment_auth_failure" &&
              row.subjectKind === "unauthenticated",
          )
          .map((row) => row.subjectKey),
      );
      isolatedEnrollmentSlot = [...slots].find((slot) => slot !== saturatedEnrollmentSlot);
      if (isolatedEnrollmentSlot !== undefined) break;
    } else {
      expectError(result, "RATE_LIMITED", `Enrollment slot collision ${offset + 1}`);
    }
  }
  assert(
    isolatedEnrollmentSlot !== undefined,
    "A distinct unknown enrollment did not receive an isolated opaque slot.",
  );
  const clearedEnrollmentSlot = await resetApiRateLimits({
    subjectKind: "unauthenticated",
    subjectKey: saturatedEnrollmentSlot,
    routeClass: "enrollment_auth_failure",
  });
  assert(clearedEnrollmentSlot.deleted >= 4, "Enrollment failure-slot reset was incomplete.");
  expectError(
    await enrollmentFailureRequest(unknownEnrollment),
    "AUTHENTICATION_FAILED",
    "Enrollment failure-slot admission after reset",
  );
  const failureRateRows = (await inspectApiRateLimits()).filter(
    (row) => row.subjectKind === "unauthenticated",
  );
  assert(
    failureRateRows.length > 0 &&
      failureRateRows.every(
        (row) =>
          /^slot_[0-9]{3}$/u.test(row.subjectKey) &&
          !String(unknownCredential).includes(row.subjectKey) &&
          !String(unknownEnrollment).includes(row.subjectKey),
      ),
    "Authentication-failure limiter persisted non-slot or raw authentication material.",
  );
  const validatedFinalRateSubjects = await runFixture(
    "localFixtures:validateApiRateLimitSubjects",
    {},
    validateApiRateLimitSubjectsResultSchema,
  );
  assertEqual(validatedFinalRateSubjects.invalid, 0, "Final limiter subject validation failed.");
  logStep("saturated credential/enrollment failure slots, observed stable 429s, isolated tokens, and reset admission");

  const finalA = await waitUntil("Final Tenant A persistence", async () => {
    const result = await runFixture(
      "localFixtures:inspectWorkspace",
      { workspaceId: workspaceA },
      inspectResultSchema,
    );
    const deferredTask = taskByKey(result, deferred.data.task.key);
    const wake = result.wakes.find((candidate) => candidate.taskId === deferred.data.task.key);
    return deferredTask.isReady && wake?.state === "completed" ? result : null;
  });
  const finalB = await runFixture(
    "localFixtures:inspectWorkspace",
    { workspaceId: workspaceB },
    inspectResultSchema,
  );
  const finalPagination = await runFixture(
    "localFixtures:inspectWorkspace",
    {
      workspaceId: workspaceAPagination,
      ...(expectedPaginationTaskCount > 8_192
        ? { omitTaskTitlePrefix: "Ready load task " }
        : {}),
    },
    inspectResultSchema,
  );
  const finalExpired = await runFixture(
    "localFixtures:inspectWorkspace",
    { workspaceId: workspaceExpired },
    inspectResultSchema,
  );
  assertEqual(finalA.rawSecretLikeValueCount, 0, "Tenant A persistence contains raw bearer material.");
  assertEqual(finalB.rawSecretLikeValueCount, 0, "Tenant B persistence contains raw bearer material.");
  assertEqual(
    finalPagination.rawSecretLikeValueCount,
    0,
    "Pagination workspace persistence contains raw bearer material.",
  );
  assertEqual(
    finalExpired.rawSecretLikeValueCount,
    0,
    "Expired-enrollment persistence contains raw bearer material.",
  );
  assert(finalA.enrollments.every((item) => item.digestByteLength === 32), "Tenant A enrollment digest encoding changed.");
  assert(finalA.credentials.every((item) => item.digestByteLength === 32), "Tenant A credential digest encoding changed.");
  assert(finalB.enrollments.every((item) => item.digestByteLength === 32), "Tenant B enrollment digest encoding changed.");
  assert(finalB.credentials.every((item) => item.digestByteLength === 32), "Tenant B credential digest encoding changed.");
  assertEqual(finalA.counts.enrollments, 2, "Tenant A inspection crossed enrollment boundaries.");
  assertEqual(finalA.counts.credentials, 2, "Tenant A inspection crossed credential boundaries.");
  assertEqual(finalA.counts.sessions, 2, "Tenant A inspection crossed session boundaries.");
  assertEqual(finalA.counts.tasks, 589, "Tenant A inspection crossed task boundaries.");
  assertEqual(finalA.counts.submissions, 7, "Tenant A submission scope changed.");
  assertEqual(finalA.counts.cancellations, 0, "Tenant A cancellation scope changed.");
  assertEqual(finalB.counts.enrollments, 1, "Tenant B inspection crossed enrollment boundaries.");
  assertEqual(finalB.counts.credentials, 1, "Tenant B inspection crossed credential boundaries.");
  assertEqual(finalB.counts.sessions, 1, "Tenant B inspection crossed session boundaries.");
  assertEqual(finalB.counts.tasks, 1, "Tenant B inspection crossed task boundaries.");
  assertEqual(finalPagination.counts.enrollments, 1, "Pagination enrollment scope changed.");
  assertEqual(finalPagination.counts.credentials, 1, "Pagination credential scope changed.");
  assertEqual(finalPagination.counts.sessions, 1, "Pagination session scope changed.");
  assertEqual(
    finalPagination.counts.tasks,
    expectedPaginationTaskCount,
    "Pagination task scope changed.",
  );
  assertEqual(finalPagination.counts.claims, 1, "Pagination claim scope changed.");
  assertEqual(finalExpired.counts.enrollments, 1, "Expired enrollment scope changed.");
  assertEqual(finalExpired.counts.credentials, 0, "Expired enrollment created a credential.");
  assertEqual(finalExpired.counts.sessions, 0, "Expired enrollment created a session.");
  assertEqual(finalExpired.counts.receipts, 0, "Expired enrollment stored a denied receipt.");
  assert(
    finalA.submissions.some(
      (submission) =>
        submission.id === submitted.data.submission.id && submission.status === "accepted",
    ),
    "Accepted review submission was not durable.",
  );
  assert(
    finalA.submissions.some(
      (submission) =>
        submission.id === rejectionSubmission.data.submission.id &&
        submission.status === "rejected" &&
        submission.reviewReason === fullReviewReason,
    ),
    "Rejected review submission did not preserve its full durable reason.",
  );
  assert(
    finalA.submissions.some(
      (submission) =>
        submission.id === fanoutSubmission.data.submission.id && submission.status === "accepted",
    ),
    "Maximum-fanout submission was not durably accepted.",
  );
  assertEqual(
    finalB.credentials.find((credential) => credential.locator === activeB1.credentialLocator)?.status,
    "revoked",
    "Revoked credential status was not durable.",
  );
  assertOneEventPerRevision(finalA);
  assertOneEventPerRevision(finalB);
  assertOneEventPerRevision(
    finalPagination,
    (task) => !task.title.startsWith("Ready load task "),
  );
  const raceEvents = finalA.taskEvents
    .filter((event) => event.taskId === raceTask.id)
    .sort((left, right) => left.taskRevision - right.taskRevision)
    .map((event) => event.type);
  assertJsonEqual(
    raceEvents,
    [
      "task.created",
      "task.claimed",
      "task.updated",
      "task.claim_renewed",
      "task.updated",
      "task.reclaimed",
      "task.comment_added",
      "task.claim_released",
    ],
    "The claim lifecycle event sequence changed.",
  );
  const deferredEvents = finalA.taskEvents
    .filter((event) => event.taskId === deferred.data.task.id)
    .sort((left, right) => left.taskRevision - right.taskRevision)
    .map((event) => event.type);
  assertJsonEqual(
    deferredEvents,
    ["task.created", "task.became_ready"],
    "The deferred wake event sequence changed.",
  );
  assertEqual(receiptCount(finalA, "agent.enrollments.redeem"), 2, "Tenant A redemption receipts were not idempotent.");
  assertEqual(receiptCount(finalA, "agent.sessions.start"), 2, "Tenant A session receipt count changed.");
  assertEqual(receiptCount(finalA, "tasks.create"), 21, "Tenant A task receipt count changed.");
  assertEqual(receiptCount(finalA, "tasks.claim"), 115, "Tenant A claim receipt count changed.");
  assertEqual(receiptCount(finalA, "tasks.claim.renew"), 1, "Tenant A renewal receipt count changed.");
  assertEqual(receiptCount(finalA, "tasks.claim.release"), 2, "Tenant A release receipt count changed.");
  assertEqual(finalA.counts.receipts, 165, "Tenant A stored a receipt for a replay or denied command.");
  assertEqual(receiptCount(finalB, "tasks.claim"), 1, "Tenant B claim receipt count changed.");
  assertEqual(finalB.counts.receipts, 4, "Tenant B stored a receipt for a replay or denied command.");
  assertEqual(receiptCount(finalPagination, "agent.enrollments.redeem"), 1, "Pagination redemption receipt count changed.");
  assertEqual(receiptCount(finalPagination, "agent.sessions.start"), 1, "Pagination session receipt count changed.");
  assertEqual(receiptCount(finalPagination, "tasks.create"), 106, "Pagination create receipt count changed.");
  assertEqual(receiptCount(finalPagination, "tasks.claim"), 1, "Pagination claim receipt count changed.");
  assertEqual(finalPagination.counts.receipts, 109, "Pagination receipt total changed.");
  assert(
    finalA.receipts.some(
      (receipt) => receipt.operation === "tasks.create" && receipt.idempotencyKey === sharedKey,
    ) &&
      finalPagination.receipts.some(
        (receipt) => receipt.operation === "tasks.create" && receipt.idempotencyKey === sharedKey,
      ),
    "The same agent could not reuse an idempotency key across workspace scopes.",
  );
  assert(
    new Set(finalA.receipts.map((receipt) => receipt.idempotencyKey)).size === finalA.receipts.length,
    "Tenant A contains duplicate command receipts.",
  );
  logStep("audited tenant-local rows, digest-only secrets, receipts, events, and revisions");

  console.log("✓ local Convex black-box acceptance passed");
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown local acceptance failure.";
  console.error(`✗ ${redactSecretsInText(message)}`);
  process.exitCode = 1;
}
