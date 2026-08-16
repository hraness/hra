import type { AgentScope, taskctlApiOperations } from "@hraness/agent-tasks-protocol";

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_BUCKET_RETENTION_WINDOWS = 2;
export const AUTHENTICATED_RATE_LIMIT_SHARDS = 8;
export const UNAUTHENTICATED_RATE_LIMIT_SHARDS = 4;
export const UNAUTHENTICATED_RATE_LIMIT_SLOTS = 256;
export const MAX_RATE_LIMIT_CLEANUP_ROWS = 100;
export const RATE_LIMIT_SELECTED_SHARD_INDEX_FIELDS = [
  "subjectKind",
  "subjectKey",
  "routeClass",
  "windowStartedAt",
  "shard",
] as const;
export const RATE_LIMIT_EXPIRY_INDEX_FIELDS = ["expiresAt"] as const;

export const rateLimitRouteClasses = [
  "agent_read",
  "agent_write",
  "agent_claim",
  "agent_review",
  "agent_session",
  "human_read",
  "human_mutation",
  "human_poll",
  "refresh_auth",
  "agent_auth_failure",
  "enrollment_auth_failure",
] as const;

export type RateLimitRouteClass = (typeof rateLimitRouteClasses)[number];
export type AuthenticatedAgentRouteClass = Extract<RateLimitRouteClass, `agent_${string}`> extends infer Class
  ? Exclude<Class, "agent_auth_failure">
  : never;
export type HumanRouteClass = Extract<RateLimitRouteClass, `human_${string}`>;
export type FailureRouteClass = Extract<RateLimitRouteClass, `${string}_auth_failure`>;
export type RateLimitSubjectKind = "credential" | "workspace" | "user" | "unauthenticated";

export interface RateLimitPolicy {
  readonly windowMs: number;
  readonly shardCount: number;
  /** Desired aggregate limit; enforcement uses ceil(limit / shards) per shard. */
  readonly limits: Readonly<Partial<Record<RateLimitSubjectKind, number>>>;
}

/**
 * Prerelease aggregate targets. Persistence enforces
 * `ceil(target / shardCount)` independently on the selected shard, so the
 * transaction reads and writes no sibling shards. The effective aggregate can
 * exceed the target by fewer than `shardCount` requests, a deliberate bounded
 * tradeoff for disjoint Convex OCC read sets.
 */
export const rateLimitPolicies = {
  agent_read: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { credential: 600, workspace: 6_000 },
  },
  agent_write: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { credential: 240, workspace: 2_400 },
  },
  agent_claim: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { credential: 120, workspace: 1_200 },
  },
  agent_review: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { credential: 120, workspace: 1_200 },
  },
  agent_session: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { credential: 60, workspace: 600 },
  },
  human_read: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { user: 600, workspace: 6_000 },
  },
  human_mutation: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { user: 120, workspace: 1_200 },
  },
  human_poll: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: AUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { user: 24, workspace: 64 },
  },
  refresh_auth: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: UNAUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { unauthenticated: 8 },
  },
  agent_auth_failure: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: UNAUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { unauthenticated: 30 },
  },
  enrollment_auth_failure: {
    windowMs: RATE_LIMIT_WINDOW_MS,
    shardCount: UNAUTHENTICATED_RATE_LIMIT_SHARDS,
    limits: { unauthenticated: 15 },
  },
} as const satisfies Record<RateLimitRouteClass, RateLimitPolicy>;

export type RateLimitSubjectProfile =
  | "agent_credential_workspace"
  | "human_user"
  | "human_user_workspace";

export type ApiRateLimitRule =
  | {
      readonly kind: "consume";
      readonly routeClass: Exclude<RateLimitRouteClass, FailureRouteClass>;
      readonly subjectProfile: RateLimitSubjectProfile;
      readonly authenticationFailureClass?: FailureRouteClass;
    }
  | {
      readonly kind: "failure_only";
      readonly authenticationFailureClass: FailureRouteClass;
    }
  | { readonly kind: "opaque_pre_auth"; readonly routeClass: "refresh_auth" };

const humanUser = (routeClass: HumanRouteClass): ApiRateLimitRule => ({
  kind: "consume",
  routeClass,
  subjectProfile: "human_user",
});

const humanWorkspace = (routeClass: HumanRouteClass): ApiRateLimitRule => ({
  kind: "consume",
  routeClass,
  subjectProfile: "human_user_workspace",
});

type AgentRateLimitRule = Extract<ApiRateLimitRule, { readonly kind: "consume" }> & {
  readonly authenticationFailureClass: "agent_auth_failure";
  readonly routeClass: AuthenticatedAgentRouteClass;
  readonly subjectProfile: "agent_credential_workspace";
};

const agent = (routeClass: AuthenticatedAgentRouteClass): AgentRateLimitRule => ({
  kind: "consume",
  routeClass,
  subjectProfile: "agent_credential_workspace",
  authenticationFailureClass: "agent_auth_failure",
});

/** Exhaustive even for operations implemented by dynamic path-prefix handlers. */
export const apiOperationRateLimitClass = {
  refreshAuth: { kind: "opaque_pre_auth", routeClass: "refresh_auth" },
  listOrganizations: humanUser("human_read"),
  createOrganization: humanUser("human_mutation"),
  listWorkspaces: humanUser("human_read"),
  createWorkspace: humanUser("human_mutation"),
  createAgent: humanWorkspace("human_mutation"),
  listAgents: humanWorkspace("human_read"),
  getAgent: humanWorkspace("human_read"),
  createAgentEnrollment: humanWorkspace("human_mutation"),
  listAgentCredentials: humanWorkspace("human_read"),
  revokeAgentCredential: humanWorkspace("human_mutation"),
  listAgentSessions: humanWorkspace("human_read"),
  disableAgent: humanWorkspace("human_mutation"),
  redeemEnrollment: {
    kind: "failure_only",
    authenticationFailureClass: "enrollment_auth_failure",
  },
  startSession: agent("agent_session"),
  context: agent("agent_session"),
  createTask: agent("agent_write"),
  readyTasks: agent("agent_read"),
  claimTask: agent("agent_claim"),
  renewClaim: agent("agent_claim"),
  releaseClaim: agent("agent_claim"),
  listTasks: agent("agent_read"),
  getTask: agent("agent_read"),
  blockedTasks: agent("agent_read"),
  updateTask: agent("agent_write"),
  cancelTask: humanWorkspace("human_mutation"),
  reopenTask: humanWorkspace("human_mutation"),
  assignTask: agent("agent_write"),
  deferTask: agent("agent_write"),
  listTaskLabels: agent("agent_read"),
  addTaskLabel: agent("agent_write"),
  removeTaskLabel: agent("agent_write"),
  listTaskComments: agent("agent_read"),
  addTaskComment: agent("agent_write"),
  listTaskEvents: agent("agent_read"),
  taskGraph: agent("agent_read"),
  listTaskDependencies: agent("agent_read"),
  addTaskDependency: agent("agent_write"),
  removeTaskDependency: agent("agent_write"),
  setTaskParent: agent("agent_write"),
  clearTaskParent: agent("agent_write"),
  listWorkspaceRepositories: humanWorkspace("human_read"),
  createWorkspaceRepository: humanWorkspace("human_mutation"),
  removeWorkspaceRepository: humanWorkspace("human_mutation"),
  listTaskReferences: agent("agent_read"),
  addTaskReference: agent("agent_write"),
  removeTaskReference: agent("agent_write"),
  submitTask: agent("agent_review"),
  reviewQueue: agent("agent_review"),
  acceptTask: agent("agent_review"),
  rejectTask: agent("agent_review"),
} as const satisfies Record<keyof typeof taskctlApiOperations, ApiRateLimitRule>;

export type AuthenticatedAgentOperation = {
  [Operation in keyof typeof apiOperationRateLimitClass]:
    (typeof apiOperationRateLimitClass)[Operation] extends AgentRateLimitRule
      ? Operation
      : never;
}[keyof typeof apiOperationRateLimitClass];

export type AgentOperationAuthorizationPolicy =
  | Readonly<{ kind: "read"; requiredScope: AgentScope }>
  | Readonly<{ kind: "write"; requiredScope: AgentScope }>
  | Readonly<{ kind: "session_start" }>;

/**
 * Exhaustive final-authorization policy for every bearer-authenticated route.
 * `read` routes may debit in the dedicated validating limiter mutation. Every
 * `write` route debits transaction-locally after its final authorization.
 */
export const agentOperationAuthorizationPolicy = {
  startSession: { kind: "session_start" },
  context: { kind: "read", requiredScope: "tasks:read" },
  createTask: { kind: "write", requiredScope: "tasks:create" },
  readyTasks: { kind: "read", requiredScope: "tasks:read" },
  claimTask: { kind: "write", requiredScope: "tasks:claim" },
  renewClaim: { kind: "write", requiredScope: "tasks:claim" },
  releaseClaim: { kind: "write", requiredScope: "tasks:claim" },
  listTasks: { kind: "read", requiredScope: "tasks:read" },
  getTask: { kind: "read", requiredScope: "tasks:read" },
  blockedTasks: { kind: "read", requiredScope: "tasks:read" },
  updateTask: { kind: "write", requiredScope: "tasks:edit" },
  assignTask: { kind: "write", requiredScope: "tasks:assign" },
  deferTask: { kind: "write", requiredScope: "tasks:edit" },
  listTaskLabels: { kind: "read", requiredScope: "tasks:read" },
  addTaskLabel: { kind: "write", requiredScope: "tasks:edit" },
  removeTaskLabel: { kind: "write", requiredScope: "tasks:edit" },
  listTaskComments: { kind: "read", requiredScope: "tasks:read" },
  addTaskComment: { kind: "write", requiredScope: "comments:write" },
  listTaskEvents: { kind: "read", requiredScope: "tasks:read" },
  taskGraph: { kind: "read", requiredScope: "tasks:read" },
  listTaskDependencies: { kind: "read", requiredScope: "tasks:read" },
  addTaskDependency: { kind: "write", requiredScope: "dependencies:write" },
  removeTaskDependency: { kind: "write", requiredScope: "dependencies:write" },
  setTaskParent: { kind: "write", requiredScope: "dependencies:write" },
  clearTaskParent: { kind: "write", requiredScope: "dependencies:write" },
  listTaskReferences: { kind: "read", requiredScope: "tasks:read" },
  addTaskReference: { kind: "write", requiredScope: "tasks:edit" },
  removeTaskReference: { kind: "write", requiredScope: "tasks:edit" },
  submitTask: { kind: "write", requiredScope: "tasks:submit" },
  reviewQueue: { kind: "read", requiredScope: "tasks:review" },
  acceptTask: { kind: "write", requiredScope: "tasks:review" },
  rejectTask: { kind: "write", requiredScope: "tasks:review" },
} as const satisfies Record<AuthenticatedAgentOperation, AgentOperationAuthorizationPolicy>;

export type AgentReadOperation = {
  [Operation in AuthenticatedAgentOperation]:
    (typeof agentOperationAuthorizationPolicy)[Operation] extends { readonly kind: "read" }
      ? Operation
      : never;
}[AuthenticatedAgentOperation];

export const agentReadOperations = Object.freeze(
  (Object.keys(agentOperationAuthorizationPolicy) as AuthenticatedAgentOperation[]).filter(
    (operation): operation is AgentReadOperation =>
      agentOperationAuthorizationPolicy[operation].kind === "read",
  ),
);

export function isAgentReadOperation(
  operation: AuthenticatedAgentOperation,
): operation is AgentReadOperation {
  return agentReadOperations.some((candidate) => candidate === operation);
}

export interface RateLimitSubject {
  readonly kind: RateLimitSubjectKind;
  /** Server-derived Convex ID, or a fixed `slot_NNN` unauthenticated slot. */
  readonly key: string;
}

export interface RateLimitBucketSnapshot extends RateLimitSubject {
  readonly id: string;
  readonly routeClass: RateLimitRouteClass;
  readonly windowStartedAt: number;
  readonly shard: number;
  readonly count: number;
  readonly expiresAt: number;
}

export type RateLimitWrite =
  | {
      readonly kind: "insert";
      readonly bucket: Omit<RateLimitBucketSnapshot, "id">;
    }
  | {
      readonly kind: "increment";
      readonly id: string;
      readonly count: number;
      readonly expiresAt: number;
    };

export type RateLimitPlan =
  | { readonly kind: "allowed"; readonly writes: readonly RateLimitWrite[] }
  | { readonly kind: "limited"; readonly retryAfterMs: number; readonly writes: readonly [] }
  | { readonly kind: "invalid"; readonly reason: string; readonly writes: readonly [] };

function safeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function rateLimitWindow(
  now: number,
  windowMs: number,
): { readonly startedAt: number; readonly endsAt: number; readonly expiresAt: number } | null {
  if (!safeNonnegativeInteger(now) || !Number.isSafeInteger(windowMs) || windowMs <= 0) return null;
  const startedAt = Math.floor(now / windowMs) * windowMs;
  const endsAt = startedAt + windowMs;
  const expiresAt = startedAt + windowMs * RATE_LIMIT_BUCKET_RETENTION_WINDOWS;
  if (!Number.isSafeInteger(endsAt) || !Number.isSafeInteger(expiresAt)) return null;
  return { startedAt, endsAt, expiresAt };
}

function stableHash32(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0;
  }
  return hash;
}

const REQUEST_ID_PATTERN = /^req_[0-9A-HJKMNP-TV-Z]{26}$/u;
const OPAQUE_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UNAUTHENTICATED_SLOT_PATTERN = /^slot_([0-9]{3})$/u;

export function rateLimitShard(requestId: string, shardCount: number): number | null {
  if (!REQUEST_ID_PATTERN.test(requestId) || !Number.isSafeInteger(shardCount) || shardCount <= 0) {
    return null;
  }
  return stableHash32(requestId) % shardCount;
}

/**
 * Accepts only a keyed opaque digest produced outside persistence. The bearer,
 * token locator, authorization header, and IP address are never inputs here.
 */
export function unauthenticatedSlotKey(opaqueDigest: string): string | null {
  if (!OPAQUE_DIGEST_PATTERN.test(opaqueDigest)) return null;
  const slot = stableHash32(opaqueDigest) % UNAUTHENTICATED_RATE_LIMIT_SLOTS;
  return `slot_${slot.toString().padStart(3, "0")}`;
}

export function isUnauthenticatedSlotKey(value: string): boolean {
  const match = UNAUTHENTICATED_SLOT_PATTERN.exec(value);
  if (match?.[1] === undefined) return false;
  return Number(match[1]) < UNAUTHENTICATED_RATE_LIMIT_SLOTS;
}

function subjectToken(subject: RateLimitSubject): string {
  return `${subject.kind}\u0000${subject.key}`;
}

export function perShardRateLimit(
  routeClass: RateLimitRouteClass,
  subjectKind: RateLimitSubjectKind,
): number | null {
  const policy: RateLimitPolicy = rateLimitPolicies[routeClass];
  const aggregateTarget = policy.limits[subjectKind];
  return aggregateTarget === undefined ? null : Math.ceil(aggregateTarget / policy.shardCount);
}

export function subjectKindsForProfile(
  profile: RateLimitSubjectProfile,
): readonly RateLimitSubjectKind[] {
  switch (profile) {
    case "agent_credential_workspace":
      return ["credential", "workspace"];
    case "human_user":
      return ["user"];
    case "human_user_workspace":
      return ["user", "workspace"];
  }
}

function dimensionsAreValid(
  routeClass: RateLimitRouteClass,
  actualKinds: ReadonlySet<RateLimitSubjectKind>,
): boolean {
  if (
    routeClass === "agent_auth_failure" ||
    routeClass === "enrollment_auth_failure" ||
    routeClass === "refresh_auth"
  ) {
    return actualKinds.size === 1 && actualKinds.has("unauthenticated");
  }
  if (
    routeClass === "human_read" ||
    routeClass === "human_mutation" ||
    routeClass === "human_poll"
  ) {
    return (
      (actualKinds.size === 1 && actualKinds.has("user")) ||
      (actualKinds.size === 2 && actualKinds.has("user") && actualKinds.has("workspace"))
    );
  }
  return actualKinds.size === 2 && actualKinds.has("credential") && actualKinds.has("workspace");
}

/**
 * Plans every dimension before producing any writes. Callers apply the returned
 * writes in one transaction; a limited or invalid plan cannot partially debit
 * a credential before discovering an exhausted workspace bucket.
 */
export function planRateLimitConsumption(args: {
  readonly routeClass: RateLimitRouteClass;
  readonly subjects: readonly RateLimitSubject[];
  readonly currentWindowBuckets: readonly RateLimitBucketSnapshot[];
  readonly requestId: string;
  readonly now: number;
}): RateLimitPlan {
  const policy: RateLimitPolicy = rateLimitPolicies[args.routeClass];
  const window = rateLimitWindow(args.now, policy.windowMs);
  const shard = rateLimitShard(args.requestId, policy.shardCount);
  if (window === null || shard === null) return { kind: "invalid", reason: "invalid_clock_or_request", writes: [] };

  const subjects = new Map<string, RateLimitSubject>();
  for (const subject of args.subjects) {
    if (subject.key.length === 0 || subject.key.length > 256) {
      return { kind: "invalid", reason: "invalid_subject", writes: [] };
    }
    if (subject.kind === "unauthenticated" && !isUnauthenticatedSlotKey(subject.key)) {
      return { kind: "invalid", reason: "invalid_unauthenticated_slot", writes: [] };
    }
    const token = subjectToken(subject);
    if (subjects.has(token)) return { kind: "invalid", reason: "duplicate_subject", writes: [] };
    subjects.set(token, subject);
  }

  const actualKinds = new Set(args.subjects.map((subject) => subject.kind));
  if (!dimensionsAreValid(args.routeClass, actualKinds)) {
    return { kind: "invalid", reason: "subject_dimensions_mismatch", writes: [] };
  }

  const bucketsBySubject = new Map<string, Map<number, RateLimitBucketSnapshot>>();
  for (const bucket of args.currentWindowBuckets) {
    const token = subjectToken(bucket);
    if (
      !subjects.has(token) ||
      bucket.routeClass !== args.routeClass ||
      bucket.windowStartedAt !== window.startedAt ||
      bucket.shard !== shard ||
      bucket.expiresAt !== window.expiresAt ||
      !safeNonnegativeInteger(bucket.count) ||
      !safeNonnegativeInteger(bucket.shard) ||
      bucket.shard >= policy.shardCount
    ) {
      return { kind: "invalid", reason: "invalid_bucket", writes: [] };
    }
    const byShard = bucketsBySubject.get(token) ?? new Map<number, RateLimitBucketSnapshot>();
    if (byShard.has(bucket.shard)) return { kind: "invalid", reason: "duplicate_bucket", writes: [] };
    byShard.set(bucket.shard, bucket);
    bucketsBySubject.set(token, byShard);
  }

  for (const subject of args.subjects) {
    const limit = policy.limits[subject.kind];
    if (limit === undefined) return { kind: "invalid", reason: "missing_limit", writes: [] };
    const allowance = perShardRateLimit(args.routeClass, subject.kind);
    if (allowance === null || limit <= 0) {
      return { kind: "invalid", reason: "missing_limit", writes: [] };
    }
    const selectedCount = bucketsBySubject.get(subjectToken(subject))?.get(shard)?.count ?? 0;
    if (selectedCount >= allowance) {
      return {
        kind: "limited",
        retryAfterMs: Math.max(1, window.endsAt - args.now),
        writes: [],
      };
    }
  }

  const writes: RateLimitWrite[] = [];
  for (const subject of args.subjects) {
    const bucket = bucketsBySubject.get(subjectToken(subject))?.get(shard);
    if (bucket === undefined) {
      writes.push({
        kind: "insert",
        bucket: {
          ...subject,
          routeClass: args.routeClass,
          windowStartedAt: window.startedAt,
          shard,
          count: 1,
          expiresAt: window.expiresAt,
        },
      });
    } else {
      writes.push({ kind: "increment", id: bucket.id, count: bucket.count + 1, expiresAt: window.expiresAt });
    }
  }
  return { kind: "allowed", writes };
}

export function selectExpiredRateLimitBucketIds(
  buckets: readonly Pick<RateLimitBucketSnapshot, "id" | "expiresAt">[],
  now: number,
  requestedLimit = MAX_RATE_LIMIT_CLEANUP_ROWS,
): readonly string[] {
  if (!safeNonnegativeInteger(now) || !Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    return [];
  }
  const limit = Math.min(requestedLimit, MAX_RATE_LIMIT_CLEANUP_ROWS);
  return buckets
    .filter((bucket) => safeNonnegativeInteger(bucket.expiresAt) && bucket.expiresAt <= now)
    .toSorted((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((bucket) => bucket.id);
}
