import {
  organizationNameSchema,
  workosMembershipIdSchema,
  workosOrganizationIdSchema,
  workosUserIdSchema,
} from "@hraness/agent-tasks-protocol";
import type {
  Event as WorkOSEvent,
} from "@workos-inc/node";
import { v, type Infer } from "convex/values";

import { internal } from "./_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server";
import { digestArrayBuffer, encodeDigest } from "./crypto";
import { randomCrockford } from "./domain";
import {
  applyMembershipObservation,
  applyMissingMembershipObservation,
  applyMissingOrganizationObservation,
  applyOrganizationObservation,
  membershipObservationValidator,
  missingMembershipObservationValidator,
  missingOrganizationObservationValidator,
  organizationObservationValidator,
  type MembershipObservation,
  type MissingMembershipObservation,
  type MissingOrganizationObservation,
  type OrganizationObservation,
} from "./identityProjection";
import {
  getWorkOSMembership,
  getWorkOSOrganization,
  listWorkOSMembershipsForOrganization,
  readWorkOSMembershipLocator,
} from "./workos";

const WEBHOOK_RECEIPT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
const RECONCILIATION_LEASE_MS = 14 * 60 * 1_000;
const RECONCILIATION_ACTION_BUDGET_MS = 8 * 60 * 1_000;
const RECONCILIATION_PAGE_SIZE = 25;
const RECONCILIATION_MAX_PAGES = 20;
const RECONCILIATION_CURSOR_VERSION = 1;
const MAX_RECONCILIATION_QUARANTINES = 512;

const reconciliationQuarantineReasonValidator = v.union(
  v.literal("provider_locator_mismatch"),
  v.literal("invalid_provider_record"),
  v.literal("projection_collision"),
);
const reconciliationQuarantineDiagnosticValidator = v.object({
  resourceKind: v.union(v.literal("organization"), v.literal("organization_membership")),
  resourceId: v.string(),
  reason: reconciliationQuarantineReasonValidator,
});
type ReconciliationQuarantineDiagnostic = Infer<
  typeof reconciliationQuarantineDiagnosticValidator
>;

const ignoredObservationValidator = v.object({
  kind: v.literal("ignored"),
  resourceId: v.string(),
});

const webhookObservationValidator = v.union(
  organizationObservationValidator,
  membershipObservationValidator,
  ignoredObservationValidator,
);

const reconciliationObservationValidator = v.union(
  membershipObservationValidator,
  missingMembershipObservationValidator,
);
const organizationReconciliationObservationValidator = v.union(
  organizationObservationValidator,
  missingOrganizationObservationValidator,
);

export type NormalizedWebhookObservation = Infer<typeof webhookObservationValidator>;

export interface NormalizedWorkOSWebhook {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly eventCreatedAt: number;
  readonly observation: NormalizedWebhookObservation;
}

function quarantineResourceKey(
  resourceKind: ReconciliationQuarantineDiagnostic["resourceKind"],
  resourceId: string,
): string {
  return `${resourceKind}:${resourceId}`;
}

async function recordReconciliationQuarantines(
  ctx: MutationCtx,
  diagnostics: readonly ReconciliationQuarantineDiagnostic[],
  now: number,
): Promise<void> {
  const deduplicated = new Map<string, ReconciliationQuarantineDiagnostic>();
  for (const diagnostic of diagnostics.slice(0, MAX_RECONCILIATION_QUARANTINES)) {
    deduplicated.set(
      quarantineResourceKey(diagnostic.resourceKind, diagnostic.resourceId),
      diagnostic,
    );
  }
  const pending: Array<{
    resourceKey: string;
    diagnostic: ReconciliationQuarantineDiagnostic;
  }> = [];
  for (const [resourceKey, diagnostic] of deduplicated) {
    const existing = await ctx.db
      .query("identityReconciliationQuarantines")
      .withIndex("by_resource_key", (query) => query.eq("resourceKey", resourceKey))
      .unique();
    if (existing === null) {
      pending.push({ resourceKey, diagnostic });
    } else {
      await ctx.db.patch(existing._id, {
        reason: diagnostic.reason,
        occurrences: existing.occurrences + 1,
        lastSeenAt: now,
        resolvedAt: undefined,
      });
    }
  }
  if (pending.length === 0) return;
  const bounded = await ctx.db
    .query("identityReconciliationQuarantines")
    .withIndex("by_last_seen")
    .order("asc")
    .take(MAX_RECONCILIATION_QUARANTINES);
  const evictionCount = Math.max(
    0,
    bounded.length + pending.length - MAX_RECONCILIATION_QUARANTINES,
  );
  const evictionCandidates = [
    ...bounded.filter((entry) => entry.resolvedAt !== undefined),
    ...bounded.filter((entry) => entry.resolvedAt === undefined),
  ];
  for (const entry of evictionCandidates.slice(0, evictionCount)) {
    await ctx.db.delete(entry._id);
  }
  for (const { resourceKey, diagnostic } of pending) {
    await ctx.db.insert("identityReconciliationQuarantines", {
      resourceKey,
      resourceKind: diagnostic.resourceKind,
      resourceId: diagnostic.resourceId,
      reason: diagnostic.reason,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
    });
  }
}

async function resolveReconciliationQuarantine(
  ctx: MutationCtx,
  resourceKind: ReconciliationQuarantineDiagnostic["resourceKind"],
  resourceId: string,
  now: number,
): Promise<void> {
  const existing = await ctx.db
    .query("identityReconciliationQuarantines")
    .withIndex("by_resource_key", (query) =>
      query.eq("resourceKey", quarantineResourceKey(resourceKind, resourceId)),
    )
    .unique();
  if (existing !== null && existing.resolvedAt === undefined) {
    await ctx.db.patch(existing._id, { resolvedAt: now, lastSeenAt: now });
  }
}

function isProjectionCollision(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "WorkOS organization external ID collision." ||
      error.message === "WorkOS membership ID collision." ||
      error.message === "WorkOS membership generation collision." ||
      error.message === "WorkOS membership retirement collision.")
  );
}

async function applyQuarantineRestriction(
  ctx: MutationCtx,
  diagnostic: ReconciliationQuarantineDiagnostic,
  now: number,
): Promise<void> {
  if (diagnostic.resourceKind === "organization") {
    const organization = await ctx.db
      .query("organizations")
      .withIndex("by_workos_organization_id", (query) =>
        query.eq("workosOrganizationId", diagnostic.resourceId),
      )
      .unique();
    if (organization !== null) {
      await ctx.db.patch(organization._id, {
        status: "disabled",
        failureCode: undefined,
        workosQuarantinedAt: now,
        workosObservedAt: now,
        updatedAt: now,
      });
    }
    return;
  }
  const membership = await ctx.db
    .query("organizationMemberships")
    .withIndex("by_workos_membership_id", (query) =>
      query.eq("workosMembershipId", diagnostic.resourceId),
    )
    .unique();
  if (membership !== null) {
    await ctx.db.patch(membership._id, {
      status: "removed",
      workosQuarantinedAt: now,
      workosObservedAt: now,
      updatedAt: now,
    });
  }
}

async function applyReconciledMembership(
  ctx: MutationCtx,
  observation: MembershipObservation | MissingMembershipObservation,
  now: number,
): Promise<ReconciliationQuarantineDiagnostic | null> {
  try {
    if (observation.kind === "organization_membership") {
      await applyMembershipObservation(ctx, observation, now);
    } else {
      await applyMissingMembershipObservation(ctx, observation, now);
    }
    await resolveReconciliationQuarantine(
      ctx,
      "organization_membership",
      observation.workosMembershipId,
      now,
    );
    return null;
  } catch (error) {
    if (!isProjectionCollision(error)) throw error;
    const diagnostic = {
      resourceKind: "organization_membership" as const,
      resourceId: observation.workosMembershipId,
      reason: "projection_collision" as const,
    };
    await applyQuarantineRestriction(ctx, diagnostic, now);
    return diagnostic;
  }
}

async function applyReconciledOrganization(
  ctx: MutationCtx,
  observation: OrganizationObservation | MissingOrganizationObservation,
  now: number,
): Promise<ReconciliationQuarantineDiagnostic | null> {
  try {
    if (observation.kind === "organization") {
      await applyOrganizationObservation(ctx, observation, now);
    } else {
      await applyMissingOrganizationObservation(ctx, observation, now);
    }
    await resolveReconciliationQuarantine(
      ctx,
      "organization",
      observation.workosOrganizationId,
      now,
    );
    return null;
  } catch (error) {
    if (!isProjectionCollision(error)) throw error;
    const diagnostic = {
      resourceKind: "organization" as const,
      resourceId: observation.workosOrganizationId,
      reason: "projection_collision" as const,
    };
    await applyQuarantineRestriction(ctx, diagnostic, now);
    return diagnostic;
  }
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function validEventBase(event: unknown): { id: string; createdAt: number } | null {
  const value = recordValue(event);
  const id = value?.["id"];
  const createdAt = parseTimestamp(value?.["createdAt"]);
  return typeof id === "string" && id.length > 0 && id.length <= 160 && createdAt !== null
    ? { id, createdAt }
    : null;
}

function membershipStatus(value: unknown): MembershipObservation["status"] | null {
  return value === "active" ||
    value === "inactive" ||
    value === "pending" ||
    value === "removed"
    ? value
    : null;
}

function membershipRoleSlugs(membership: Record<string, unknown>): string[] | null {
  const roles = membership["roles"];
  const fallback = recordValue(membership["role"]);
  if (
    (roles !== undefined && roles !== null && !Array.isArray(roles)) ||
    typeof fallback?.["slug"] !== "string"
  ) {
    return null;
  }
  const configured: string[] = [];
  for (const value of roles ?? []) {
    const role = recordValue(value);
    if (typeof role?.["slug"] !== "string") return null;
    configured.push(role["slug"]);
  }
  const roleSlugs = [
    ...new Set(configured.length === 0 ? [fallback["slug"]] : configured),
  ];
  return roleSlugs.length > 0 &&
    roleSlugs.length <= 32 &&
    roleSlugs.every((role) => role.length > 0 && role.length <= 128)
    ? roleSlugs
    : null;
}

function normalizeMembership(
  value: unknown,
  observedAt: number,
  statusOverride?: MembershipObservation["status"],
  hardDeleted = false,
): MembershipObservation | null {
  const membership = recordValue(value);
  if (membership === null) return null;
  const id = membership["id"];
  const organizationId = membership["organizationId"];
  const userId = membership["userId"];
  const providerUpdatedAt = parseTimestamp(membership["updatedAt"]);
  const organizationName = organizationNameSchema.safeParse(membership["organizationName"]);
  const roleSlugs = membershipRoleSlugs(membership);
  const parsedStatus = membershipStatus(membership["status"]);
  if (
    !workosMembershipIdSchema.safeParse(id).success ||
    !workosOrganizationIdSchema.safeParse(organizationId).success ||
    !workosUserIdSchema.safeParse(userId).success ||
    !organizationName.success ||
    providerUpdatedAt === null ||
    roleSlugs === null ||
    parsedStatus === null ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0
  ) {
    return null;
  }
  if (typeof id !== "string" || typeof organizationId !== "string" || typeof userId !== "string") {
    return null;
  }
  return {
    kind: "organization_membership",
    workosMembershipId: id,
    workosOrganizationId: organizationId,
    workosUserId: userId,
    organizationName: organizationName.data,
    status: statusOverride ?? parsedStatus,
    roleSlugs,
    providerUpdatedAt,
    observedAt,
    ...(hardDeleted ? { hardDeleted: true as const } : {}),
  };
}

export function normalizeWorkOSMembershipForReconciliation(
  membership: unknown,
  observedAt: number,
): MembershipObservation | null {
  return normalizeMembership(membership, observedAt);
}

function normalizeOrganization(
  value: unknown,
  observedAt: number,
  status: OrganizationObservation["status"],
  hardDeleted = false,
): OrganizationObservation | null {
  const organization = recordValue(value);
  if (organization === null) return null;
  const id = organization["id"];
  const name = organizationNameSchema.safeParse(organization["name"]);
  const externalId = organization["externalId"];
  const providerUpdatedAt = parseTimestamp(organization["updatedAt"]);
  if (
    !workosOrganizationIdSchema.safeParse(id).success ||
    !name.success ||
    providerUpdatedAt === null ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    (externalId !== null &&
      (typeof externalId !== "string" || externalId.length === 0 || externalId.length > 255))
  ) {
    return null;
  }
  if (typeof id !== "string") return null;
  return {
    kind: "organization",
    workosOrganizationId: id,
    name: name.data,
    ...(externalId === null ? {} : { externalId }),
    status,
    providerUpdatedAt,
    observedAt,
    ...(hardDeleted ? { hardDeleted: true as const } : {}),
  };
}

export function normalizeWorkOSOrganizationForReconciliation(
  organization: unknown,
  observedAt: number,
): OrganizationObservation | null {
  return normalizeOrganization(organization, observedAt, "active");
}

export function normalizeWorkOSWebhookEvent(event: WorkOSEvent): NormalizedWorkOSWebhook | null {
  const base = validEventBase(event);
  const eventRecord = recordValue(event);
  const eventType = eventRecord?.["event"];
  if (
    base === null ||
    typeof eventType !== "string" ||
    eventType.length === 0 ||
    eventType.length > 160
  ) {
    return null;
  }
  const data = eventRecord?.["data"];
  // Unsupported but correctly signed WorkOS events are intentionally receipted as ignored.
  switch (eventType) {
    case "organization_membership.created":
    case "organization_membership.updated":
    case "organization_membership.deleted": {
      const observation = normalizeMembership(
        data,
        base.createdAt,
        eventType === "organization_membership.deleted" ? "removed" : undefined,
        eventType === "organization_membership.deleted",
      );
      return observation === null
        ? null
        : {
            providerEventId: base.id,
            eventType,
            eventCreatedAt: base.createdAt,
            observation,
          };
    }
    case "organization.created":
    case "organization.updated":
    case "organization.deleted": {
      const hardDeleted = eventType === "organization.deleted";
      const observation = normalizeOrganization(
        data,
        base.createdAt,
        hardDeleted ? "disabled" : "active",
        hardDeleted,
      );
      return observation === null
        ? null
        : {
            providerEventId: base.id,
            eventType,
            eventCreatedAt: base.createdAt,
            observation,
          };
    }
    default:
      return {
        providerEventId: base.id,
        eventType,
        eventCreatedAt: base.createdAt,
        observation: { kind: "ignored", resourceId: base.id },
      };
  }
}

const webhookResultValidator = v.object({
  status: v.union(
    v.literal("applied"),
    v.literal("stale"),
    v.literal("ignored"),
    v.literal("duplicate"),
    v.literal("conflict"),
  ),
});

export const applyWorkOSWebhook = internalMutation({
  args: {
    providerEventId: v.string(),
    eventType: v.string(),
    eventCreatedAt: v.number(),
    payloadDigest: v.string(),
    observation: webhookObservationValidator,
  },
  returns: webhookResultValidator,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("identityWebhookReceipts")
      .withIndex("by_provider_event_id", (query) =>
        query.eq("providerEventId", args.providerEventId),
      )
      .unique();
    if (existing !== null) {
      return existing.eventType === args.eventType &&
        encodeDigest(existing.payloadDigest) === args.payloadDigest
        ? { status: "duplicate" as const }
        : { status: "conflict" as const };
    }
    const payloadDigest = digestArrayBuffer(args.payloadDigest);
    if (payloadDigest === null) return { status: "conflict" as const };
    const now = Date.now();
    const result: "applied" | "stale" | "ignored" =
      args.observation.kind === "ignored"
        ? "ignored"
        : args.observation.kind === "organization"
          ? await applyOrganizationObservation(ctx, args.observation, now)
          : await applyMembershipObservation(ctx, args.observation, now);
    await ctx.db.insert("identityWebhookReceipts", {
      providerEventId: args.providerEventId,
      eventType: args.eventType,
      payloadDigest,
      eventCreatedAt: args.eventCreatedAt,
      resourceKind:
        args.observation.kind === "organization"
          ? "organization"
          : args.observation.kind === "organization_membership"
            ? "organization_membership"
            : "ignored",
      resourceId:
        args.observation.kind === "organization"
          ? args.observation.workosOrganizationId
          : args.observation.kind === "organization_membership"
            ? args.observation.workosMembershipId
            : args.observation.resourceId,
      result,
      createdAt: now,
      expiresAt: now + WEBHOOK_RECEIPT_LIFETIME_MS,
    });
    return { status: result };
  },
});

const reserveRunResultValidator = v.union(
  v.object({ kind: v.literal("busy") }),
  v.object({
    kind: v.literal("started"),
    runId: v.string(),
    cursor: v.union(v.string(), v.null()),
  }),
);

const reserveDiscoveryRunResultValidator = v.union(
  v.object({ kind: v.literal("busy") }),
  v.object({
    kind: v.literal("started"),
    runId: v.string(),
    cursor: v.union(v.string(), v.null()),
    providerOrganizationId: v.union(v.string(), v.null()),
    providerCursor: v.union(v.string(), v.null()),
  }),
);

export const reserveMembershipReconciliationRun = internalMutation({
  args: {},
  returns: reserveRunResultValidator,
  handler: async (ctx) => {
    const now = Date.now();
    const expiredReceipts = await ctx.db
      .query("identityWebhookReceipts")
      .withIndex("by_expiry", (query) => query.lt("expiresAt", now))
      .take(100);
    for (const receipt of expiredReceipts) await ctx.db.delete(receipt._id);

    let state = await ctx.db
      .query("identityReconciliationState")
      .withIndex("by_key", (query) => query.eq("key", "workos_memberships"))
      .unique();
    if (
      state !== null &&
      state.version === RECONCILIATION_CURSOR_VERSION &&
      state.leaseUntil !== undefined &&
      state.leaseUntil > now
    ) {
      return { kind: "busy" as const };
    }
    const runId = `reconcile_${randomCrockford(26)}`;
    if (state === null) {
      const stateId = await ctx.db.insert("identityReconciliationState", {
        key: "workos_memberships",
        version: RECONCILIATION_CURSOR_VERSION,
        runId,
        leaseUntil: now + RECONCILIATION_LEASE_MS,
        lastStartedAt: now,
        updatedAt: now,
      });
      state = await ctx.db.get(stateId);
    } else {
      await ctx.db.patch(state._id, {
        version: RECONCILIATION_CURSOR_VERSION,
        ...(state.version === RECONCILIATION_CURSOR_VERSION
          ? {}
          : { cursor: undefined, providerOrganizationId: undefined, providerCursor: undefined }),
        runId,
        leaseUntil: now + RECONCILIATION_LEASE_MS,
        lastStartedAt: now,
        updatedAt: now,
      });
      state = await ctx.db.get(state._id);
    }
    if (state === null) throw new Error("Membership reconciliation state disappeared.");
    return {
      kind: "started" as const,
      runId,
      cursor: state.cursor ?? null,
    };
  },
});

export const reserveOrganizationDiscoveryRun = internalMutation({
  args: {},
  returns: reserveDiscoveryRunResultValidator,
  handler: async (ctx) => {
    const now = Date.now();
    let state = await ctx.db
      .query("identityReconciliationState")
      .withIndex("by_key", (query) => query.eq("key", "workos_organizations"))
      .unique();
    if (
      state !== null &&
      state.version === RECONCILIATION_CURSOR_VERSION &&
      state.leaseUntil !== undefined &&
      state.leaseUntil > now
    ) {
      return { kind: "busy" as const };
    }
    const runId = `discover_${randomCrockford(26)}`;
    if (state === null) {
      const stateId = await ctx.db.insert("identityReconciliationState", {
        key: "workos_organizations",
        version: RECONCILIATION_CURSOR_VERSION,
        runId,
        leaseUntil: now + RECONCILIATION_LEASE_MS,
        lastStartedAt: now,
        updatedAt: now,
      });
      state = await ctx.db.get(stateId);
    } else {
      await ctx.db.patch(state._id, {
        version: RECONCILIATION_CURSOR_VERSION,
        ...(state.version === RECONCILIATION_CURSOR_VERSION
          ? {}
          : { cursor: undefined, providerOrganizationId: undefined, providerCursor: undefined }),
        runId,
        leaseUntil: now + RECONCILIATION_LEASE_MS,
        lastStartedAt: now,
        updatedAt: now,
      });
      state = await ctx.db.get(state._id);
    }
    if (state === null) throw new Error("Organization discovery state disappeared.");
    return {
      kind: "started" as const,
      runId,
      cursor: state.cursor ?? null,
      providerOrganizationId: state.providerOrganizationId ?? null,
      providerCursor: state.providerCursor ?? null,
    };
  },
});

const reconciliationPageResultValidator = v.object({
  memberships: v.array(
    v.object({
      workosMembershipId: v.string(),
      workosOrganizationId: v.union(v.string(), v.null()),
      workosUserId: v.union(v.string(), v.null()),
    }),
  ),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

export const loadMembershipReconciliationPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: reconciliationPageResultValidator,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizationMemberships")
      .withIndex("by_workos_membership_id", (query) => query.gte("workosMembershipId", ""))
      .paginate({ cursor: args.cursor, numItems: RECONCILIATION_PAGE_SIZE });
    const memberships = (
      await Promise.all(
        page.page.map(async (membership) => {
          if (membership.workosMembershipId === undefined) return null;
          const [organization, user] = await Promise.all([
            ctx.db.get(membership.organizationId),
            ctx.db.get(membership.userId),
          ]);
          return {
            workosMembershipId: membership.workosMembershipId,
            workosOrganizationId: organization?.workosOrganizationId ?? null,
            workosUserId: user?.workosUserId ?? null,
          };
        }),
      )
    ).flatMap((membership) => (membership === null ? [] : [membership]));
    return {
      memberships,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

const organizationDiscoveryPageValidator = v.object({
  organization: v.union(
    v.object({ workosOrganizationId: v.string() }),
    v.null(),
  ),
  continueCursor: v.string(),
  isDone: v.boolean(),
});

export const loadOrganizationDiscoveryPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: organizationDiscoveryPageValidator,
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("organizations")
      .withIndex("by_workos_organization_id", (query) =>
        query.gte("workosOrganizationId", ""),
      )
      .paginate({ cursor: args.cursor, numItems: 1 });
    const organization = page.page[0];
    return {
      organization:
        organization?.workosOrganizationId === undefined
          ? null
          : { workosOrganizationId: organization.workosOrganizationId },
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const applyMembershipReconciliationPage = internalMutation({
  args: {
    runId: v.string(),
    continueCursor: v.string(),
    isDone: v.boolean(),
    observations: v.array(reconciliationObservationValidator),
    diagnostics: v.array(reconciliationQuarantineDiagnosticValidator),
  },
  returns: v.object({ accepted: v.boolean(), completed: v.boolean() }),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("identityReconciliationState")
      .withIndex("by_key", (query) => query.eq("key", "workos_memberships"))
      .unique();
    if (state === null || state.runId !== args.runId) {
      return { accepted: false, completed: false };
    }
    const now = Date.now();
    const projectionDiagnostics: ReconciliationQuarantineDiagnostic[] = [];
    for (const observation of args.observations) {
      const diagnostic = await applyReconciledMembership(ctx, observation, now);
      if (diagnostic !== null) projectionDiagnostics.push(diagnostic);
    }
    for (const diagnostic of args.diagnostics) {
      await applyQuarantineRestriction(ctx, diagnostic, now);
    }
    await recordReconciliationQuarantines(
      ctx,
      [...args.diagnostics, ...projectionDiagnostics],
      now,
    );
    await ctx.db.patch(state._id, {
      ...(args.isDone ? { cursor: undefined } : { cursor: args.continueCursor }),
      ...(args.isDone ? { lastCompletedAt: now } : {}),
      leaseUntil: now + RECONCILIATION_LEASE_MS,
      updatedAt: now,
    });
    return { accepted: true, completed: args.isDone };
  },
});

export const applyOrganizationDiscoveryPage = internalMutation({
  args: {
    runId: v.string(),
    nextCursor: v.union(v.string(), v.null()),
    sweepDone: v.boolean(),
    providerOrganizationId: v.union(v.string(), v.null()),
    providerCursor: v.union(v.string(), v.null()),
    organizationObservation: v.union(organizationReconciliationObservationValidator, v.null()),
    observations: v.array(reconciliationObservationValidator),
    diagnostics: v.array(reconciliationQuarantineDiagnosticValidator),
  },
  returns: v.object({ accepted: v.boolean(), completed: v.boolean() }),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("identityReconciliationState")
      .withIndex("by_key", (query) => query.eq("key", "workos_organizations"))
      .unique();
    if (state === null || state.runId !== args.runId) {
      return { accepted: false, completed: false };
    }
    const now = Date.now();
    const projectionDiagnostics: ReconciliationQuarantineDiagnostic[] = [];
    if (args.organizationObservation?.kind === "organization") {
      const diagnostic = await applyReconciledOrganization(ctx, args.organizationObservation, now);
      if (diagnostic !== null) projectionDiagnostics.push(diagnostic);
    } else if (args.organizationObservation?.kind === "organization_missing") {
      const diagnostic = await applyReconciledOrganization(ctx, args.organizationObservation, now);
      if (diagnostic !== null) projectionDiagnostics.push(diagnostic);
    }
    for (const observation of args.observations) {
      const diagnostic = await applyReconciledMembership(ctx, observation, now);
      if (diagnostic !== null) projectionDiagnostics.push(diagnostic);
    }
    for (const diagnostic of args.diagnostics) {
      await applyQuarantineRestriction(ctx, diagnostic, now);
    }
    await recordReconciliationQuarantines(
      ctx,
      [...args.diagnostics, ...projectionDiagnostics],
      now,
    );
    await ctx.db.patch(state._id, {
      ...(args.sweepDone || args.nextCursor === null
        ? { cursor: undefined }
        : { cursor: args.nextCursor }),
      ...(args.providerOrganizationId === null
        ? { providerOrganizationId: undefined }
        : { providerOrganizationId: args.providerOrganizationId }),
      ...(args.providerCursor === null
        ? { providerCursor: undefined }
        : { providerCursor: args.providerCursor }),
      ...(args.sweepDone ? { lastCompletedAt: now } : {}),
      leaseUntil: now + RECONCILIATION_LEASE_MS,
      updatedAt: now,
    });
    return { accepted: true, completed: args.sweepDone };
  },
});

export const finishMembershipReconciliationRun = internalMutation({
  args: { runId: v.string(), failed: v.boolean() },
  returns: v.object({ finished: v.boolean() }),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("identityReconciliationState")
      .withIndex("by_key", (query) => query.eq("key", "workos_memberships"))
      .unique();
    if (state === null || state.runId !== args.runId) return { finished: false };
    const now = Date.now();
    await ctx.db.patch(state._id, {
      runId: undefined,
      leaseUntil: undefined,
      ...(args.failed ? { cursor: undefined } : {}),
      ...(args.failed ? { lastErrorAt: now } : {}),
      updatedAt: now,
    });
    return { finished: true };
  },
});

export const finishOrganizationDiscoveryRun = internalMutation({
  args: { runId: v.string(), failed: v.boolean() },
  returns: v.object({ finished: v.boolean() }),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("identityReconciliationState")
      .withIndex("by_key", (query) => query.eq("key", "workos_organizations"))
      .unique();
    if (state === null || state.runId !== args.runId) return { finished: false };
    const now = Date.now();
    await ctx.db.patch(state._id, {
      runId: undefined,
      leaseUntil: undefined,
      ...(args.failed
        ? { cursor: undefined, providerOrganizationId: undefined, providerCursor: undefined }
        : {}),
      ...(args.failed ? { lastErrorAt: now } : {}),
      updatedAt: now,
    });
    return { finished: true };
  },
});

const reconciliationResultValidator = v.object({
  status: v.union(
    v.literal("completed"),
    v.literal("partial"),
    v.literal("busy"),
    v.literal("unavailable"),
    v.literal("failed"),
  ),
  processed: v.number(),
});

export const reconcileWorkOSMemberships = internalAction({
  args: {},
  returns: reconciliationResultValidator,
  handler: async (ctx) => {
    const reservation = await ctx.runMutation(
      internal.identitySync.reserveMembershipReconciliationRun,
      {},
    );
    if (reservation.kind === "busy") return { status: "busy" as const, processed: 0 };
    const startedAt = Date.now();
    let cursor = reservation.cursor;
    let processed = 0;
    try {
      for (let pageNumber = 0; pageNumber < RECONCILIATION_MAX_PAGES; pageNumber += 1) {
        if (Date.now() - startedAt >= RECONCILIATION_ACTION_BUDGET_MS) break;
        const page = await ctx.runQuery(internal.identitySync.loadMembershipReconciliationPage, {
          cursor,
        });
        const candidates = await Promise.all(
          page.memberships.map(async (expected): Promise<{
            observation: MembershipObservation | MissingMembershipObservation;
            diagnostic?: ReconciliationQuarantineDiagnostic;
          }> => {
            const { workosMembershipId } = expected;
            const observedAt = Date.now();
            const membership = await getWorkOSMembership(workosMembershipId);
            if (membership === undefined) throw new Error("WorkOS membership API is unavailable.");
            if (membership === null) {
              return {
                observation: {
                  kind: "organization_membership_missing" as const,
                  workosMembershipId,
                  observedAt,
                },
              };
            }
            const normalized = normalizeWorkOSMembershipForReconciliation(membership, observedAt);
            if (normalized === null) {
              return {
                observation: {
                  kind: "organization_membership_missing" as const,
                  workosMembershipId,
                  observedAt,
                },
                diagnostic: {
                  resourceKind: "organization_membership" as const,
                  resourceId: workosMembershipId,
                  reason: "invalid_provider_record" as const,
                },
              };
            }
            if (
              normalized.workosMembershipId !== workosMembershipId ||
              normalized.workosOrganizationId !== expected.workosOrganizationId ||
              normalized.workosUserId !== expected.workosUserId
            ) {
              return {
                observation: {
                  kind: "organization_membership_missing",
                  workosMembershipId,
                  observedAt,
                },
                diagnostic: {
                  resourceKind: "organization_membership",
                  resourceId: workosMembershipId,
                  reason: "provider_locator_mismatch",
                },
              };
            }
            return { observation: normalized };
          }),
        );
        const observations = candidates.flatMap((candidate) =>
          [candidate.observation],
        );
        const diagnostics = candidates.flatMap((candidate) =>
          candidate.diagnostic === undefined ? [] : [candidate.diagnostic],
        );
        const applied = await ctx.runMutation(
          internal.identitySync.applyMembershipReconciliationPage,
          {
            runId: reservation.runId,
            continueCursor: page.continueCursor,
            isDone: page.isDone,
            observations,
            diagnostics,
          },
        );
        if (!applied.accepted) return { status: "busy" as const, processed };
        processed += page.memberships.length;
        cursor = page.continueCursor;
        if (applied.completed) {
          await ctx.runMutation(internal.identitySync.finishMembershipReconciliationRun, {
            runId: reservation.runId,
            failed: false,
          });
          return { status: "completed" as const, processed };
        }
      }
      await ctx.runMutation(internal.identitySync.finishMembershipReconciliationRun, {
        runId: reservation.runId,
        failed: false,
      });
      await ctx.scheduler.runAfter(0, internal.identitySync.reconcileWorkOSMemberships, {});
      return { status: "partial" as const, processed };
    } catch (error) {
      await ctx.runMutation(internal.identitySync.finishMembershipReconciliationRun, {
        runId: reservation.runId,
        failed: true,
      });
      const status: "unavailable" | "failed" =
        error instanceof Error && error.message === "WorkOS membership API is unavailable."
          ? "unavailable"
          : "failed";
      return { status, processed };
    }
  },
});

export const discoverWorkOSMemberships = internalAction({
  args: {},
  returns: reconciliationResultValidator,
  handler: async (ctx) => {
    const reservation = await ctx.runMutation(
      internal.identitySync.reserveOrganizationDiscoveryRun,
      {},
    );
    if (reservation.kind === "busy") return { status: "busy" as const, processed: 0 };
    const startedAt = Date.now();
    let cursor = reservation.cursor;
    let providerOrganizationId = reservation.providerOrganizationId;
    let providerCursor = reservation.providerCursor;
    let processed = 0;
    try {
      for (let pageNumber = 0; pageNumber < RECONCILIATION_MAX_PAGES; pageNumber += 1) {
        if (Date.now() - startedAt >= RECONCILIATION_ACTION_BUDGET_MS) break;
        if (providerOrganizationId === null) {
          const organizationPage = await ctx.runQuery(
            internal.identitySync.loadOrganizationDiscoveryPage,
            { cursor },
          );
          cursor = organizationPage.continueCursor;
          if (organizationPage.organization === null) {
            const advanced = await ctx.runMutation(
              internal.identitySync.applyOrganizationDiscoveryPage,
              {
                runId: reservation.runId,
                nextCursor: organizationPage.continueCursor,
                sweepDone: organizationPage.isDone,
                providerOrganizationId: null,
                providerCursor: null,
                organizationObservation: null,
                observations: [],
                diagnostics: [],
              },
            );
            if (!advanced.accepted) return { status: "busy" as const, processed };
            if (advanced.completed) {
              await ctx.runMutation(internal.identitySync.finishOrganizationDiscoveryRun, {
                runId: reservation.runId,
                failed: false,
              });
              return { status: "completed" as const, processed };
            }
            continue;
          }
          providerOrganizationId = organizationPage.organization.workosOrganizationId;
          providerCursor = null;
        }

        const organizationObservedAt = Date.now();
        const providerOrganization = await getWorkOSOrganization(providerOrganizationId);
        if (providerOrganization === undefined) {
          throw new Error("WorkOS organization API is unavailable.");
        }
        if (providerOrganization === null) {
          const advanced = await ctx.runMutation(
            internal.identitySync.applyOrganizationDiscoveryPage,
            {
              runId: reservation.runId,
              nextCursor: cursor,
              sweepDone: false,
              providerOrganizationId: null,
              providerCursor: null,
              organizationObservation: {
                kind: "organization_missing",
                workosOrganizationId: providerOrganizationId,
                observedAt: organizationObservedAt,
              },
              observations: [],
              diagnostics: [],
            },
          );
          if (!advanced.accepted) return { status: "busy" as const, processed };
          processed += 1;
          providerOrganizationId = null;
          providerCursor = null;
          continue;
        }
        const organizationObservation = normalizeWorkOSOrganizationForReconciliation(
          providerOrganization,
          organizationObservedAt,
        );
        const organizationLocatorMatches =
          organizationObservation?.workosOrganizationId === providerOrganizationId;
        if (!organizationLocatorMatches || organizationObservation === null) {
          const advanced = await ctx.runMutation(
            internal.identitySync.applyOrganizationDiscoveryPage,
            {
              runId: reservation.runId,
              nextCursor: cursor,
              sweepDone: false,
              providerOrganizationId: null,
              providerCursor: null,
              organizationObservation: {
                kind: "organization_missing",
                workosOrganizationId: providerOrganizationId,
                observedAt: organizationObservedAt,
              },
              observations: [],
              diagnostics: [
                {
                  resourceKind: "organization",
                  resourceId: providerOrganizationId,
                  reason: organizationLocatorMatches
                    ? "invalid_provider_record"
                    : "provider_locator_mismatch",
                },
              ],
            },
          );
          if (!advanced.accepted) return { status: "busy" as const, processed };
          processed += 1;
          providerOrganizationId = null;
          providerCursor = null;
          continue;
        }

        const observedAt = Date.now();
        const providerPage = await listWorkOSMembershipsForOrganization({
          organizationId: providerOrganizationId,
          ...(providerCursor === null ? {} : { cursor: providerCursor }),
          limit: 100,
        });
        if (providerPage === null) throw new Error("WorkOS membership API is unavailable.");
        const observations: Array<MembershipObservation | MissingMembershipObservation> = [];
        const diagnostics: ReconciliationQuarantineDiagnostic[] = providerPage.diagnostics.map(
          (diagnostic) => ({
            resourceKind: diagnostic.resourceKind,
            resourceId: diagnostic.resourceId,
            reason: diagnostic.reason,
          }),
        );
        for (const membership of providerPage.memberships) {
          const normalized = normalizeWorkOSMembershipForReconciliation(membership, observedAt);
          if (normalized === null) {
            const locator = readWorkOSMembershipLocator(membership);
            const resourceId =
              locator !== null && locator.id.length > 0 && locator.id.length <= 255
                ? locator.id
                : providerOrganizationId;
            observations.push({
              kind: "organization_membership_missing",
              workosMembershipId: resourceId,
              observedAt,
            });
            diagnostics.push({
              resourceKind: "organization_membership",
              resourceId,
              reason: "invalid_provider_record",
            });
          } else {
            observations.push(normalized);
          }
        }
        for (const diagnostic of providerPage.diagnostics) {
          if (diagnostic.resourceKind === "organization_membership") {
            observations.push({
              kind: "organization_membership_missing",
              workosMembershipId: diagnostic.resourceId,
              observedAt,
            });
          }
        }
        const nextProviderCursor = providerPage.cursor;
        const advanced = await ctx.runMutation(
          internal.identitySync.applyOrganizationDiscoveryPage,
          {
            runId: reservation.runId,
            nextCursor: cursor,
            sweepDone: false,
            providerOrganizationId:
              nextProviderCursor === null ? null : providerOrganizationId,
            providerCursor: nextProviderCursor,
            organizationObservation,
            observations,
            diagnostics,
          },
        );
        if (!advanced.accepted) return { status: "busy" as const, processed };
        processed += observations.length + 1;
        providerCursor = nextProviderCursor;
        if (nextProviderCursor === null) providerOrganizationId = null;
      }
      await ctx.runMutation(internal.identitySync.finishOrganizationDiscoveryRun, {
        runId: reservation.runId,
        failed: false,
      });
      await ctx.scheduler.runAfter(0, internal.identitySync.discoverWorkOSMemberships, {});
      return { status: "partial" as const, processed };
    } catch (error) {
      await ctx.runMutation(internal.identitySync.finishOrganizationDiscoveryRun, {
        runId: reservation.runId,
        failed: true,
      });
      const status: "unavailable" | "failed" =
        error instanceof Error &&
        (error.message === "WorkOS membership API is unavailable." ||
          error.message === "WorkOS organization API is unavailable.")
          ? "unavailable"
          : "failed";
      return { status, processed };
    }
  },
});
