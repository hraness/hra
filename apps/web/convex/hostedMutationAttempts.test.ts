import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  convexTest,
  type TestConvex,
} from "convex-test";

import { api, internal } from "./_generated/api";
import { opaqueHostedMutationFingerprint } from "./hostedMutationFingerprint";
import {
  hraOperationIdFromLegacyHostedMutationRecord,
  legacyHostedMutationOperationIdFields,
} from "./hostedMutationPersistence";
import schema from "./schema";

const ORGANIZATION_PUBLIC_ID = "org_00000000000000000000000001";
const USER_PUBLIC_ID = "usr_00000000000000000000000001";
const SECOND_USER_PUBLIC_ID = "usr_00000000000000000000000002";
const WORKSPACE_PUBLIC_ID = "wsp_00000000000000000000000001";
const FOREIGN_WORKSPACE_PUBLIC_ID = "wsp_00000000000000000000000002";
const SOURCE_ID = "oprte.web.task-workspace.v1";
const SECOND_SOURCE_ID = "oprte.web.task-workspace.v2";
const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const FINGERPRINT_KEY =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // gitleaks:allow - deterministic test vector
const SECOND_FINGERPRINT_KEY =
  "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8"; // gitleaks:allow - deterministic test vector
const FINGERPRINT_KEY_VERSION = "test-v1";
const originalFingerprintKey =
  process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT;
const originalFingerprintKeyVersion =
  process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION;
const originalPreviousFingerprintKey =
  process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS;
const originalPreviousFingerprintKeyVersion =
  process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION;
const originalLegacyFingerprintKey =
  process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT;
const originalLegacyFingerprintKeyVersion =
  process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION;
const originalLegacyPreviousFingerprintKey =
  process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS;
const originalLegacyPreviousFingerprintKeyVersion =
  process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION;

const modules = {
  "./_generated/api.ts": async () => await import("./_generated/api"),
  "./_generated/server.ts": async () => await import("./_generated/server"),
  "./hostedMutationAttempts.ts": async () =>
    await import("./hostedMutationAttempts"),
};

type HostedMutationTest = TestConvex<typeof schema>;
type HostedMutationActor = ReturnType<HostedMutationTest["withIdentity"]>;

function operationId(index: number): string {
  return `op_${String(index).padStart(26, "0")}`;
}

function taskId(index: number): string {
  return `tsk_${String(index).padStart(26, "0")}`;
}

function idempotencyKey(index: number): string {
  return `018f0f7d-8b4c-7000-8000-${index
    .toString(16)
    .padStart(12, "0")}`;
}

function clientFingerprint(index: number): string {
  return `sha256_${String(index).padStart(43, "0")}`;
}

function opaqueFingerprint(index: number): string {
  return `hmac_sha256_${String(index).padStart(43, "0")}`;
}

function identity(userId: string, sessionId: string) {
  return {
    issuer: "https://convex.test",
    subject: `${userId}|${sessionId}`,
    tokenIdentifier: `https://convex.test|${userId}|${sessionId}`,
  };
}

function prepareArgs(index: number) {
  return {
    workspaceId: WORKSPACE_PUBLIC_ID,
    sourceId: SOURCE_ID,
    operation: "task.comment_add",
    clientFingerprint: clientFingerprint(index),
    fingerprint: opaqueFingerprint(index),
    fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
    idempotencyKey: idempotencyKey(index),
    hraOperationId: operationId(index),
    suppliedTaskId: taskId(index + 1_000),
    targetTaskId: taskId(1),
  };
}

function unresolvedPrepareRequest(index: number) {
  const input = prepareArgs(index);
  return {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    operation: input.operation,
    fingerprint: input.fingerprint,
    fingerprintKeyVersion: input.fingerprintKeyVersion,
    prepareProof: opaqueFingerprint(999_999),
    idempotencyKey: input.idempotencyKey,
    hraOperationId: input.hraOperationId,
    suppliedTaskId: input.suppliedTaskId,
    targetTaskId: input.targetTaskId,
  };
}

async function resolvedPrepareArgs(
  actor: HostedMutationActor,
  index: number,
  overrides: Partial<ReturnType<typeof prepareArgs>> = {},
) {
  const input = { ...prepareArgs(index), ...overrides };
  const resolved = await actor.mutation(
    api.hostedMutationAttempts.resolveFingerprint,
    {
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      clientFingerprint: input.clientFingerprint,
    },
  );
  if (!resolved.ok) {
    throw new Error("Hosted mutation fingerprint fixture did not resolve.");
  }
  return {
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    hraOperationId: input.hraOperationId,
    suppliedTaskId: input.suppliedTaskId,
    targetTaskId: input.targetTaskId,
    ...resolved.data,
  };
}

async function seedTenancy(t: HostedMutationTest) {
  return await t.run(async (ctx) => {
    const organizationId = await ctx.db.insert("organizations", {
      publicId: ORGANIZATION_PUBLIC_ID,
      name: "HRA",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const userId = await ctx.db.insert("users", {
      publicId: USER_PUBLIC_ID,
      name: "Ada",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const secondUserId = await ctx.db.insert("users", {
      publicId: SECOND_USER_PUBLIC_ID,
      name: "Grace",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("organizationMemberships", {
      organizationId,
      userId,
      role: "owner",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("organizationMemberships", {
      organizationId,
      userId: secondUserId,
      role: "admin",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const workspaceId = await ctx.db.insert("workspaces", {
      organizationId,
      publicId: WORKSPACE_PUBLIC_ID,
      slug: "hra",
      name: "HRA",
      taskKeyPrefix: "OP",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });

    const foreignOrganizationId = await ctx.db.insert("organizations", {
      publicId: "org_00000000000000000000000002",
      name: "Foreign",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    await ctx.db.insert("workspaces", {
      organizationId: foreignOrganizationId,
      publicId: FOREIGN_WORKSPACE_PUBLIC_ID,
      slug: "foreign",
      name: "Foreign",
      taskKeyPrefix: "FR",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const sessionExpiration = Date.now() + 60_000;
    const firstSessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: sessionExpiration,
    });
    const secondSessionId = await ctx.db.insert("authSessions", {
      userId: secondUserId,
      expirationTime: sessionExpiration,
    });
    for (const [sessionId, selectedUserId] of [
      [firstSessionId, userId],
      [secondSessionId, secondUserId],
    ] as const) {
      await ctx.db.insert("authSessionSelections", {
        sessionId,
        userId: selectedUserId,
        organizationId,
        workspaceId,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    return { firstSessionId, secondSessionId, userId, secondUserId };
  });
}

async function fixture() {
  const t = convexTest(schema, modules);
  const seeded = await seedTenancy(t);
  return {
    anonymous: t,
    first: t.withIdentity(identity(seeded.userId, seeded.firstSessionId)),
    second: t.withIdentity(identity(seeded.secondUserId, seeded.secondSessionId)),
  };
}

beforeEach(() => {
  process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT =
    FINGERPRINT_KEY;
  process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION =
    FINGERPRINT_KEY_VERSION;
  delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS;
  delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION;
  delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT;
  delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION;
  delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS;
  delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION;
});

afterEach(() => {
  if (originalFingerprintKey === undefined) {
    delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT;
  } else {
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT =
      originalFingerprintKey;
  }
  if (originalFingerprintKeyVersion === undefined) {
    delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION;
  } else {
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION =
      originalFingerprintKeyVersion;
  }
  if (originalPreviousFingerprintKey === undefined) {
    delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS;
  } else {
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS =
      originalPreviousFingerprintKey;
  }
  if (originalPreviousFingerprintKeyVersion === undefined) {
    delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION;
  } else {
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION =
      originalPreviousFingerprintKeyVersion;
  }
  if (originalLegacyFingerprintKey === undefined) {
    delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT;
  } else {
    process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT =
      originalLegacyFingerprintKey;
  }
  if (originalLegacyFingerprintKeyVersion === undefined) {
    delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION;
  } else {
    process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION =
      originalLegacyFingerprintKeyVersion;
  }
  if (originalLegacyPreviousFingerprintKey === undefined) {
    delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS;
  } else {
    process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS =
      originalLegacyPreviousFingerprintKey;
  }
  if (originalLegacyPreviousFingerprintKeyVersion === undefined) {
    delete process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION;
  } else {
    process.env.OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION =
      originalLegacyPreviousFingerprintKeyVersion;
  }
});

describe("hosted Convex mutation attempt journal", () => {
  test("binds opaque fingerprints to tenant, principal, and source", async () => {
    const key = { key: FINGERPRINT_KEY, version: FINGERPRINT_KEY_VERSION };
    const base = {
      organizationId: "organization-a",
      workspaceId: "workspace-a",
      principalId: "principal-a",
      sourceId: SOURCE_ID,
    };
    const clientDigest = clientFingerprint(1);
    const values = await Promise.all([
      opaqueHostedMutationFingerprint(key, base, clientDigest),
      opaqueHostedMutationFingerprint(
        key,
        { ...base, organizationId: "organization-b" },
        clientDigest,
      ),
      opaqueHostedMutationFingerprint(
        key,
        { ...base, workspaceId: "workspace-b" },
        clientDigest,
      ),
      opaqueHostedMutationFingerprint(
        key,
        { ...base, principalId: "principal-b" },
        clientDigest,
      ),
      opaqueHostedMutationFingerprint(
        key,
        { ...base, sourceId: SECOND_SOURCE_ID },
        clientDigest,
      ),
    ]);
    expect(new Set(values.map(({ fingerprint }) => fingerprint)).size).toBe(
      values.length,
    );
    for (const value of values) {
      expect(value.fingerprint).toMatch(
        /^hmac_sha256_[A-Za-z0-9_-]{43}$/u,
      );
      expect(JSON.stringify(value)).not.toContain(clientDigest);
    }
  });

  test("requires a current authenticated workspace principal", async () => {
    const { anonymous, first } = await fixture();
    expect(await anonymous.mutation(
      api.hostedMutationAttempts.prepare,
      unresolvedPrepareRequest(1),
    )).toMatchObject({
      ok: false,
      error: { code: "AUTHENTICATION_FAILED" },
    });
    expect(await first.mutation(
      api.hostedMutationAttempts.prepare,
      {
        ...unresolvedPrepareRequest(1),
        workspaceId: FOREIGN_WORKSPACE_PUBLIC_ID,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await anonymous.run(async (ctx) =>
      await ctx.db.query("hostedMutationAttempts").collect()
    )).toEqual([]);
  });

  test("fails closed when fingerprint key configuration is absent or malformed", async () => {
    const { anonymous, first } = await fixture();
    delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT;
    expect(await first.mutation(
      api.hostedMutationAttempts.resolveFingerprint,
      {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SOURCE_ID,
        clientFingerprint: clientFingerprint(1),
      },
    )).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT = "malformed";
    expect(await first.mutation(
      api.hostedMutationAttempts.prepare,
      unresolvedPrepareRequest(1),
    )).toMatchObject({
      ok: false,
      error: { code: "SERVICE_UNAVAILABLE" },
    });
    expect(await anonymous.run(async (ctx) =>
      await ctx.db.query("hostedMutationAttempts").collect()
    )).toEqual([]);
  });

  test("persists only scope-bound HMACs and rejects noncanonical sources", async () => {
    const { anonymous, first } = await fixture();
    const originalClientFingerprint = clientFingerprint(1);
    const original = await resolvedPrepareArgs(first, 1, {
      clientFingerprint: originalClientFingerprint,
    });
    expect(await first.mutation(
      api.hostedMutationAttempts.resolveFingerprint,
      {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SECOND_SOURCE_ID,
        clientFingerprint: originalClientFingerprint,
      },
    )).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    await first.mutation(api.hostedMutationAttempts.prepare, original);
    const rows = await anonymous.run(async (ctx) =>
      await ctx.db.query("hostedMutationAttempts").collect()
    );
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(originalClientFingerprint);
    expect(serialized).not.toContain(FINGERPRINT_KEY);
    expect(rows[0]?.fingerprint).toMatch(
      /^hmac_sha256_[A-Za-z0-9_-]{43}$/u,
    );
    expect(rows[0]?.fingerprintKeyVersion).toBe(FINGERPRINT_KEY_VERSION);
  });

  test("resolves the previous key only during an explicit bounded rotation", async () => {
    const { first } = await fixture();
    const originalClientFingerprint = clientFingerprint(1);
    const original = await resolvedPrepareArgs(first, 1, {
      clientFingerprint: originalClientFingerprint,
    });
    await first.mutation(api.hostedMutationAttempts.prepare, original);

    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT =
      SECOND_FINGERPRINT_KEY;
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION =
      "test-v2";
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS =
      FINGERPRINT_KEY;
    process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION =
      FINGERPRINT_KEY_VERSION;
    expect(await first.mutation(
      api.hostedMutationAttempts.resolveFingerprint,
      {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SOURCE_ID,
        clientFingerprint: originalClientFingerprint,
      },
    )).toMatchObject({
      ok: true,
      data: {
        fingerprint: original.fingerprint,
        fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
      },
    });

    delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS;
    delete process.env.HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION;
    const current = await first.mutation(
      api.hostedMutationAttempts.resolveFingerprint,
      {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SOURCE_ID,
        clientFingerprint: originalClientFingerprint,
      },
    );
    expect(current).toMatchObject({
      ok: true,
      data: { fingerprintKeyVersion: "test-v2" },
    });
    if (!current.ok) throw new Error("Current fingerprint did not resolve.");
    expect(current.data.fingerprint).not.toBe(original.fingerprint);
    expect(await first.mutation(api.hostedMutationAttempts.prepare, {
      ...original,
      ...current.data,
      idempotencyKey: idempotencyKey(98),
      hraOperationId: operationId(98),
      suppliedTaskId: taskId(1_098),
    })).toMatchObject({
      ok: true,
      data: {
        status: "collision",
        current: { attemptId: original.hraOperationId },
      },
    });

    const unrelated = await resolvedPrepareArgs(first, 2, {
      targetTaskId: taskId(2),
    });
    expect(await first.mutation(
      api.hostedMutationAttempts.prepare,
      unrelated,
    )).toMatchObject({
      ok: true,
      data: {
        status: "created",
        record: { fingerprintKeyVersion: "test-v2" },
      },
    });
  });

  test("prepares before effect, survives remount, and distinguishes collisions", async () => {
    const { first } = await fixture();
    const originalClientFingerprint = clientFingerprint(1);
    const original = await resolvedPrepareArgs(first, 1, {
      clientFingerprint: originalClientFingerprint,
    });
    const created = await first.mutation(
      api.hostedMutationAttempts.prepare,
      original,
    );
    expect(created).toMatchObject({
      ok: true,
      data: {
        status: "created",
        record: {
          fingerprint: expect.stringMatching(/^hmac_sha256_[A-Za-z0-9_-]{43}$/u),
          fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
          state: "prepared",
          workspaceId: WORKSPACE_PUBLIC_ID,
          recovery: {
            idempotencyKey: original.idempotencyKey,
            hraOperationId: original.hraOperationId,
            suppliedTaskId: original.suppliedTaskId,
            targetTaskId: original.targetTaskId,
          },
        },
      },
    });
    expect(JSON.stringify(created)).not.toContain(originalClientFingerprint);

    const remounted = await first.mutation(
      api.hostedMutationAttempts.prepare,
      {
        ...original,
        idempotencyKey: idempotencyKey(2),
        hraOperationId: operationId(2),
        suppliedTaskId: taskId(1_002),
      },
    );
    expect(remounted).toMatchObject({
      ok: true,
      data: {
        status: "existing",
        record: {
          attemptId: original.hraOperationId,
          fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
          recovery: {
            idempotencyKey: original.idempotencyKey,
            suppliedTaskId: original.suppliedTaskId,
          },
        },
      },
    });
    const recovered = await first.mutation(
      api.hostedMutationAttempts.resolveFingerprint,
      {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SOURCE_ID,
        clientFingerprint: originalClientFingerprint,
      },
    );
    expect(recovered).toMatchObject({
      ok: true,
      data: {
        fingerprint: original.fingerprint,
        fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
      },
    });
    expect(JSON.stringify(recovered)).not.toContain(
      originalClientFingerprint,
    );

    expect(await first.mutation(
      api.hostedMutationAttempts.prepare,
      {
        ...original,
        idempotencyKey: idempotencyKey(3),
        hraOperationId: operationId(3),
        suppliedTaskId: taskId(1_003),
        operation: "task.update",
      },
    )).toMatchObject({
      ok: true,
      data: {
        status: "collision",
        current: { attemptId: original.hraOperationId },
      },
    });
    expect(await first.mutation(
      api.hostedMutationAttempts.prepare,
      {
        ...await resolvedPrepareArgs(first, 4),
        hraOperationId: original.hraOperationId,
      },
    )).toMatchObject({
      ok: true,
      data: {
        status: "collision",
        current: { attemptId: original.hraOperationId },
      },
    });
  });

  test("rejects tampered or cross-scope prepare proofs without writing", async () => {
    const { anonymous, first } = await fixture();
    const original = await resolvedPrepareArgs(first, 1);
    const forgedRequests = [
      {
        ...original,
        prepareProof: opaqueFingerprint(999_998),
      },
      {
        ...original,
        fingerprint: opaqueFingerprint(999_997),
      },
      {
        ...original,
        sourceId: SECOND_SOURCE_ID,
      },
    ];

    for (const forged of forgedRequests) {
      expect(await first.mutation(
        api.hostedMutationAttempts.prepare,
        forged,
      )).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR" },
      });
    }
    expect(await anonymous.run(async (ctx) =>
      await ctx.db.query("hostedMutationAttempts").collect()
    )).toEqual([]);
  });

  test("keeps attempts principal-scoped and returns opaque absence across users", async () => {
    const { first, second } = await fixture();
    const original = await resolvedPrepareArgs(first, 1);
    await first.mutation(api.hostedMutationAttempts.prepare, original);

    expect(await second.query(api.hostedMutationAttempts.get, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      attemptId: original.hraOperationId,
      sourceId: SOURCE_ID,
    })).toMatchObject({
      ok: true,
      data: null,
    });
    expect(await second.query(api.hostedMutationAttempts.listOpen, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      after: null,
      limit: 50,
    })).toMatchObject({
      ok: true,
      data: {
        attempts: [],
        hasMore: false,
        nextCursor: null,
      },
    });
  });

  test("retains the effect-started crash window and permits proven safe cancellation", async () => {
    const { first } = await fixture();
    const original = await resolvedPrepareArgs(first, 1);
    await first.mutation(api.hostedMutationAttempts.prepare, original);
    const marked = await first.mutation(
      api.hostedMutationAttempts.markEffectStarted,
      {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SOURCE_ID,
        attemptId: original.hraOperationId,
        expectedRevision: 1,
      },
    );
    expect(marked).toMatchObject({
      ok: true,
      data: {
        status: "applied",
        record: { state: "effect-started", revision: 2 },
      },
    });
    expect(await first.query(api.hostedMutationAttempts.listOpen, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      after: null,
      limit: 50,
    })).toMatchObject({
      ok: true,
      data: {
        attempts: [{
          attemptId: original.hraOperationId,
          state: "effect-started",
        }],
      },
    });

    expect(await first.mutation(api.hostedMutationAttempts.settle, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      attemptId: original.hraOperationId,
      expectedRevision: 2,
      operation: original.operation,
      settlement: { kind: "confirmed", commandKind: "task.cancel" },
    })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(await first.mutation(api.hostedMutationAttempts.settle, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      attemptId: original.hraOperationId,
      expectedRevision: 2,
      operation: "task.update",
      settlement: { kind: "cancelled", reason: "caller" },
    })).toMatchObject({
      ok: true,
      data: {
        status: "invalid-transition",
        current: { state: "effect-started", revision: 2 },
      },
    });
    expect(await first.mutation(api.hostedMutationAttempts.settle, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      attemptId: original.hraOperationId,
      expectedRevision: 2,
      operation: original.operation,
      settlement: { kind: "cancelled", reason: "caller" },
    })).toMatchObject({
      ok: true,
      data: {
        status: "applied",
        record: {
          state: "settled",
          outcome: { status: "cancelled", reason: "caller" },
        },
      },
    });
    const replay = {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      attemptId: original.hraOperationId,
      operation: original.operation,
      settlement: { kind: "cancelled" as const, reason: "caller" as const },
    };
    expect(await first.mutation(api.hostedMutationAttempts.settle, {
      ...replay,
      expectedRevision: 2,
    })).toMatchObject({
      ok: true,
      data: {
        status: "conflict",
        current: { state: "settled", revision: 3 },
      },
    });
    expect(await first.mutation(api.hostedMutationAttempts.settle, {
      ...replay,
      expectedRevision: 2,
      operation: "task.update",
      settlement: { kind: "cancelled", reason: "caller" },
    })).toMatchObject({
      ok: true,
      data: {
        status: "conflict",
        current: { state: "settled", revision: 3 },
      },
    });
    expect(await first.mutation(api.hostedMutationAttempts.settle, {
      ...replay,
      expectedRevision: 3,
    })).toMatchObject({
      ok: true,
      data: {
        status: "invalid-transition",
        current: { state: "settled", revision: 3 },
      },
    });
  });

  test("drains only proven absence and gates key retirement on linked recovery", async () => {
    const { anonymous, first } = await fixture();
    const absent = await resolvedPrepareArgs(first, 41);
    const linked = await resolvedPrepareArgs(first, 42);
    for (const attempt of [absent, linked]) {
      await first.mutation(api.hostedMutationAttempts.prepare, attempt);
      await first.mutation(api.hostedMutationAttempts.markEffectStarted, {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SOURCE_ID,
        attemptId: attempt.hraOperationId,
        expectedRevision: 1,
      });
    }
    await anonymous.run(async (ctx) => {
      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_public_id", (index) =>
          index.eq("publicId", ORGANIZATION_PUBLIC_ID)
        )
        .unique();
      const linkedAttempt = (await ctx.db
        .query("hostedMutationAttempts")
        .collect())
        .find((record) =>
          hraOperationIdFromLegacyHostedMutationRecord(record) ===
            linked.hraOperationId
        );
      if (organization === null || linkedAttempt === undefined) {
        throw new Error("Missing linked drain fixture.");
      }
      const receiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: USER_PUBLIC_ID,
        organizationId: organization._id,
        operation: "tasks.comments.add",
        idempotencyKey: linked.idempotencyKey,
        requestDigest: "sha256_linked_drain",
        requestId: "request_linked_drain",
        responseJson: "{}",
        createdAt: NOW,
        expiresAt: NOW + 60_000,
      });
      await ctx.db.patch(linkedAttempt._id, { receiptId });
    });

    expect(await anonymous.query(
      internal.hostedMutationAttempts.fingerprintKeyRetirementGate,
      { keyVersion: FINGERPRINT_KEY_VERSION },
    )).toEqual({ canRetire: false, openAttemptsAtLeast: 1 });
    expect(await first.mutation(
      api.hostedMutationAttempts.reconcileOpenPage,
      {
        workspaceId: WORKSPACE_PUBLIC_ID,
        sourceId: SOURCE_ID,
        after: null,
        limit: 50,
      },
    )).toMatchObject({
      ok: true,
      data: {
        blocked: 0,
        pendingReceipts: 1,
        reconciled: 1,
      },
    });
    expect(await first.query(api.hostedMutationAttempts.listOpen, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      after: null,
      limit: 50,
    })).toMatchObject({
      ok: true,
      data: {
        attempts: [{
          attemptId: linked.hraOperationId,
          state: "effect-started",
        }],
      },
    });
    expect(await first.mutation(api.hostedMutationAttempts.settle, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      attemptId: linked.hraOperationId,
      expectedRevision: 2,
      operation: linked.operation,
      settlement: {
        kind: "confirmed",
        commandKind: "task.comment_add",
      },
    })).toMatchObject({
      ok: true,
      data: { status: "applied" },
    });
    expect(await anonymous.query(
      internal.hostedMutationAttempts.fingerprintKeyRetirementGate,
      { keyVersion: FINGERPRINT_KEY_VERSION },
    )).toEqual({ canRetire: true, openAttemptsAtLeast: 0 });
  });

  test("retains terminal tombstones without blocking a later deliberate action", async () => {
    const { anonymous, first } = await fixture();
    const originalClientFingerprint = clientFingerprint(1);
    const original = await resolvedPrepareArgs(first, 1, {
      clientFingerprint: originalClientFingerprint,
    });
    await first.mutation(api.hostedMutationAttempts.prepare, original);
    await first.mutation(api.hostedMutationAttempts.markEffectStarted, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      attemptId: original.hraOperationId,
      expectedRevision: 1,
    });
    const linkedReceiptId = await anonymous.run(async (ctx) => {
      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_public_id", (index) =>
          index.eq("publicId", ORGANIZATION_PUBLIC_ID)
        )
        .unique();
      const attempt = (await ctx.db
        .query("hostedMutationAttempts")
        .collect())
        .find((record) =>
          hraOperationIdFromLegacyHostedMutationRecord(record) ===
            original.hraOperationId
        ) ?? null;
      if (organization === null || attempt === null) {
        throw new Error("Missing receipt-link fixture.");
      }
      const receiptId = await ctx.db.insert("humanCommandReceipts", {
        principalKind: "organization",
        principalId: USER_PUBLIC_ID,
        organizationId: organization._id,
        operation: "tasks.comments.add",
        idempotencyKey: original.idempotencyKey,
        requestDigest: "sha256_fixture",
        requestId: "request_fixture",
        responseJson: "{}",
        createdAt: NOW,
        expiresAt: NOW + 60_000,
      });
      await ctx.db.patch(attempt._id, { receiptId });
      return receiptId;
    });
    await first.mutation(api.hostedMutationAttempts.settle, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      attemptId: original.hraOperationId,
      expectedRevision: 2,
      operation: original.operation,
      settlement: {
        kind: "confirmed",
        commandKind: "task.comment_add",
      },
    });
    expect(await first.query(api.hostedMutationAttempts.listOpen, {
      workspaceId: WORKSPACE_PUBLIC_ID,
      sourceId: SOURCE_ID,
      after: null,
      limit: 50,
    })).toMatchObject({
      ok: true,
      data: { attempts: [], hasMore: false },
    });

    const deliberate = await resolvedPrepareArgs(first, 2, {
      clientFingerprint: originalClientFingerprint,
    });
    expect(await first.mutation(
      api.hostedMutationAttempts.prepare,
      deliberate,
    )).toMatchObject({
      ok: true,
      data: {
        status: "created",
        record: { attemptId: deliberate.hraOperationId },
      },
    });
    const rows = await anonymous.run(async (ctx) =>
      await ctx.db.query("hostedMutationAttempts").collect()
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(({ state }) => state).sort()).toEqual([
      "prepared",
      "settled",
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("body");
    expect(serialized).not.toContain("answer");
    expect(serialized).not.toContain("transcript");
    expect(serialized).not.toContain("provider");

    await anonymous.run(async (ctx) => {
      const settled = (await ctx.db
        .query("hostedMutationAttempts")
        .collect())
        .find((record) =>
          hraOperationIdFromLegacyHostedMutationRecord(record) ===
            original.hraOperationId
        );
      if (settled === undefined || settled.state !== "settled") {
        throw new Error("Missing settled tombstone fixture.");
      }
      await ctx.db.patch(settled._id, { retireAt: Date.now() - 1 });
    });
    expect(await anonymous.mutation(
      internal.hostedMutationAttempts.sweepSettledTombstones,
      {},
    )).toEqual({ processed: 1, scheduled: false });
    expect(await anonymous.mutation(
      internal.hostedMutationAttempts.sweepSettledTombstones,
      {},
    )).toEqual({ processed: 0, scheduled: false });
    expect(await anonymous.run(async (ctx) => ({
      receipt: await ctx.db.get(linkedReceiptId),
      attempts: await ctx.db.query("hostedMutationAttempts").collect(),
    }))).toMatchObject({
      receipt: null,
      attempts: [{ state: "prepared" }],
    });
  });

  test("rejects capacity without evicting any ambiguous attempt", async () => {
    const { anonymous, first } = await fixture();
    const scope = await anonymous.run(async (ctx) => {
      const organization = await ctx.db
        .query("organizations")
        .withIndex("by_public_id", (index) =>
          index.eq("publicId", ORGANIZATION_PUBLIC_ID)
        )
        .unique();
      const user = await ctx.db
        .query("users")
        .withIndex("by_public_id", (index) =>
          index.eq("publicId", USER_PUBLIC_ID)
        )
        .unique();
      const workspace = await ctx.db
        .query("workspaces")
        .withIndex("by_public_id", (index) =>
          index.eq("publicId", WORKSPACE_PUBLIC_ID)
        )
        .unique();
      if (organization === null || user === null || workspace === null) {
        throw new Error("Missing hosted mutation attempt fixture.");
      }
      return { organization, user, workspace };
    });
    await anonymous.run(async (ctx) => {
      for (let index = 1; index <= 256; index += 1) {
        const preparedAt = NOW + index;
        const attemptId = operationId(index);
        await ctx.db.insert("hostedMutationAttempts", {
          organizationId: scope.organization._id,
          workspaceId: scope.workspace._id,
          workspacePublicId: WORKSPACE_PUBLIC_ID,
          principalId: scope.user._id,
          sourceId: SOURCE_ID,
          operation: "task.comment_add",
          fingerprint: opaqueFingerprint(index),
          fingerprintKeyVersion: FINGERPRINT_KEY_VERSION,
          idempotencyKey: idempotencyKey(index),
          ...legacyHostedMutationOperationIdFields(attemptId),
          suppliedTaskId: taskId(index + 1_000),
          targetTaskId: taskId(1),
          state: "prepared",
          open: true,
          revision: 1,
          preparedAt,
          orderKey:
            `${String(preparedAt).padStart(16, "0")}:${attemptId}`,
        });
      }
    });

    expect(await first.mutation(
      api.hostedMutationAttempts.prepare,
      await resolvedPrepareArgs(first, 1_000),
    )).toMatchObject({
      ok: true,
      data: { status: "capacity" },
    });
    expect(await anonymous.run(async (ctx) =>
      await ctx.db.query("hostedMutationAttempts").collect()
    )).toHaveLength(256);
  });
});
