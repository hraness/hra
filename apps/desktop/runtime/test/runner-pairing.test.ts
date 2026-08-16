import { describe, expect, test } from "bun:test";
import {
  agentPresetScopes,
  credentialTokenSchema,
  type AgentScope,
  createOpaqueId,
  enrollmentTokenSchema,
  parseCredentialToken,
  parseEnrollmentToken,
  uuidV7Schema,
  type CreateAgentEnrollmentResponse,
  type CredentialToken,
  type EnrollmentToken,
  type IdempotencyKey,
  type RedeemEnrollmentResponse,
  type StartSessionResponse,
} from "@hraness/agent-tasks-protocol";
import {
  HRA_RUNNER_KEYCHAIN_SERVICE,
  SecretStoreAccessDeniedError,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyMetadataStore,
  type SecretCustodyQuarantinePointer,
  type SecretStore,
} from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";

import {
  HRARunnerPairingCoordinator,
  HRARunnerPairingInspectionCache,
  hraRunnerPairingFailureCodeValues,
  hraRunnerKeychainName,
  runnerPairingFailureMayRequireCredentialRecovery,
  type HRARunnerPairingCloudPort,
  type HRARunnerPairingInput,
  type HRARunnerPairingRandom,
  type HRARunnerPairingStatusPort,
} from "../src/promotion";

const NOW = 2_000_000_000_000;
const PROMOTION_ID = "promotion_0123456789ABCDEFGHJKMNPQRS";
const WORKSPACE_ID = "wsp_0123456789ABCDEFGHJKMNPQRS";
const AGENT_ID = `imported_local_codex_${PROMOTION_ID}`;
const INPUT: HRARunnerPairingInput = {
  promotionId: PROMOTION_ID,
  destinationWorkspaceId: WORKSPACE_ID,
  importedAgentId: AGENT_ID,
};
const NAME_KEY = Uint8Array.from(
  { length: 32 },
  (_, index) => index + 1,
);

const keychainEnvelopeFixtureSchema = z
  .object({
    version: z.literal(1),
    generation: z.number().int().nonnegative(),
    value: z.string(),
  })
  .strict();

const preparedPayloadFixtureSchema = z
  .object({
    state: z.literal("prepared"),
    enrollment: enrollmentTokenSchema,
    credential: credentialTokenSchema,
    idempotency: z
      .object({
        createEnrollment: uuidV7Schema,
        redeemEnrollment: uuidV7Schema,
        startSession: uuidV7Schema,
      })
      .strict(),
  })
  .passthrough();

function descriptorKey(descriptor: SecretCustodyDescriptor): string {
  return `${descriptor.service}:${descriptor.name}`;
}

class MemoryMetadata implements SecretCustodyMetadataStore {
  readonly events: string[];
  readonly journals = new Map<string, SecretCustodyJournal>();
  readonly quarantined = new Map<string, SecretCustodyQuarantinePointer[]>();
  failCasAttempts = new Set<number>();
  falseCasAttempts = new Set<number>();
  #casAttempts = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  read(descriptor: SecretCustodyDescriptor): Promise<unknown> {
    return Promise.resolve(
      this.journals.get(descriptorKey(descriptor)) ?? null,
    );
  }

  compareAndSwap(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly expectedRevision: number | null;
    readonly next: SecretCustodyJournal;
  }): Promise<boolean> {
    this.#casAttempts += 1;
    this.events.push(`metadata:cas:${this.#casAttempts}`);
    if (this.failCasAttempts.delete(this.#casAttempts)) {
      return Promise.reject(new Error("injected metadata CAS failure"));
    }
    if (this.falseCasAttempts.delete(this.#casAttempts)) {
      return Promise.resolve(false);
    }
    const key = descriptorKey(input.descriptor);
    const current = this.journals.get(key);
    if ((current?.revision ?? null) !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.journals.set(key, input.next);
    return Promise.resolve(true);
  }

  compareAndSwapWithQuarantine(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly expectedRevision: number;
    readonly next: SecretCustodyJournal;
    readonly quarantined: readonly SecretCustodyQuarantinePointer[];
  }): Promise<boolean> {
    const key = descriptorKey(input.descriptor);
    const current = this.journals.get(key);
    if (current?.revision !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.journals.set(key, input.next);
    this.quarantined.set(key, [
      ...(this.quarantined.get(key) ?? []),
      ...input.quarantined,
    ]);
    return Promise.resolve(true);
  }

  isQuarantinedSlot(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly slot: string;
  }): Promise<boolean> {
    return Promise.resolve(
      (this.quarantined.get(descriptorKey(input.descriptor)) ?? [])
        .some(({ pointer }) => pointer.slot === input.slot),
    );
  }
}

class MemorySecrets implements SecretStore {
  readonly events: string[];
  readonly values = new Map<string, string>();
  readonly inaccessibleNames = new Set<string>();
  failDeleteAttempts = new Set<number>();
  failSetAttempts = new Set<number>();
  legacyDeleteAttempts = 0;
  #deleteAttempts = 0;
  #setAttempts = 0;

  constructor(events: string[]) {
    this.events = events;
  }

  get(input: {
    readonly service: string;
    readonly name: string;
  }): Promise<string | null> {
    if (this.inaccessibleNames.has(input.name)) {
      return Promise.reject(new SecretStoreAccessDeniedError());
    }
    return Promise.resolve(
      this.values.get(`${input.service}:${input.name}`) ?? null,
    );
  }

  set(input: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }): Promise<void> {
    this.#setAttempts += 1;
    this.events.push(`keychain:set:${this.#setAttempts}`);
    if (this.failSetAttempts.delete(this.#setAttempts)) {
      return Promise.reject(
        new Error("injected keychain write failure with a secret payload"),
      );
    }
    this.values.set(`${input.service}:${input.name}`, input.value);
    return Promise.resolve();
  }

  delete(input: {
    readonly service: string;
    readonly name: string;
  }): Promise<boolean> {
    if (this.inaccessibleNames.has(input.name)) {
      this.legacyDeleteAttempts += 1;
      return Promise.reject(new Error("legacy code requirement denied"));
    }
    this.#deleteAttempts += 1;
    this.events.push(`keychain:delete:${this.#deleteAttempts}`);
    if (this.failDeleteAttempts.delete(this.#deleteAttempts)) {
      return Promise.reject(new Error("injected keychain delete failure"));
    }
    return Promise.resolve(
      this.values.delete(`${input.service}:${input.name}`),
    );
  }
}

class DeterministicRandom implements HRARunnerPairingRandom {
  #seed = 1;

  bytes(length: number): Uint8Array {
    const seed = this.#seed;
    this.#seed += 1;
    return Uint8Array.from(
      { length },
      (_, index) => (seed * 31 + index * 17) % 256,
    );
  }
}

interface EnrollmentCall {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly enrollment: EnrollmentToken;
  readonly idempotencyKey: IdempotencyKey;
}

interface RedemptionCall {
  readonly enrollment: EnrollmentToken;
  readonly agentId: string;
  readonly credential: CredentialToken;
  readonly idempotencyKey: IdempotencyKey;
}

interface SessionCall {
  readonly credential: CredentialToken;
  readonly idempotencyKey: IdempotencyKey;
}

type CloudStage = "create" | "redeem" | "session";

class ReplayCloud implements HRARunnerPairingCloudPort {
  readonly events: string[];
  readonly enrollmentCalls: EnrollmentCall[] = [];
  readonly redemptionCalls: RedemptionCall[] = [];
  readonly sessionCalls: SessionCall[] = [];
  failOnceAfter: CloudStage | null = null;
  mismatched: "enrollment" | "agent" | "credential" | null = null;
  now: () => number = () => NOW;
  scopes: readonly AgentScope[] = [...agentPresetScopes.dispatcher];
  #failed = false;
  readonly #enrollments = new Map<
    IdempotencyKey,
    CreateAgentEnrollmentResponse
  >();
  readonly #redemptions = new Map<
    IdempotencyKey,
    RedeemEnrollmentResponse
  >();
  readonly #sessions = new Map<IdempotencyKey, StartSessionResponse>();

  constructor(events: string[]) {
    this.events = events;
  }

  #maybeFail(stage: CloudStage, secret: string): void {
    if (this.failOnceAfter === stage && !this.#failed) {
      this.#failed = true;
      throw new Error(`injected ${stage} response loss ${secret}`);
    }
  }

  createAgentEnrollment(
    agentId: string,
    input: {
      readonly workspaceId: string;
      readonly enrollment: EnrollmentToken;
      readonly idempotencyKey: IdempotencyKey;
    },
  ) {
    this.events.push("cloud:create");
    this.enrollmentCalls.push({ agentId, ...input });
    const locator = parseEnrollmentToken(input.enrollment)?.locator;
    if (locator === undefined) throw new Error("invalid enrollment fixture");
    const response = this.#enrollments.get(input.idempotencyKey) ?? {
      enrollment: {
        locator: this.mismatched === "enrollment"
          ? "1123456789ABCDEFGHJKMNPQRS"
          : locator,
        expiresAt: this.now() + 3_600_000,
      },
    };
    this.#enrollments.set(input.idempotencyKey, response);
    this.#maybeFail("create", input.enrollment);
    return Promise.resolve({ ok: true as const, data: response });
  }

  redeemRunnerEnrollment(
    enrollment: EnrollmentToken,
    input: {
      readonly agentId: string;
      readonly credential: CredentialToken;
      readonly idempotencyKey: IdempotencyKey;
    },
  ) {
    this.events.push("cloud:redeem");
    this.redemptionCalls.push({ enrollment, ...input });
    const locator = parseCredentialToken(input.credential)?.locator;
    if (locator === undefined) throw new Error("invalid credential fixture");
    const response = this.#redemptions.get(input.idempotencyKey) ?? {
      agentId: this.mismatched === "agent"
        ? "another-imported-agent"
        : input.agentId,
      credentialId: this.mismatched === "credential"
        ? "2123456789ABCDEFGHJKMNPQRS"
        : locator,
      credentialExpiresAt: this.now() + 86_400_000,
      scopes: [...this.scopes],
    };
    this.#redemptions.set(input.idempotencyKey, response);
    this.#maybeFail("redeem", enrollment);
    return Promise.resolve({ ok: true as const, data: response });
  }

  startRunnerSession(
    credential: CredentialToken,
    idempotencyKey: IdempotencyKey,
  ) {
    this.events.push("cloud:session");
    this.sessionCalls.push({ credential, idempotencyKey });
    const response = this.#sessions.get(idempotencyKey) ?? {
      sessionId: createOpaqueId(
        "ses",
        Uint8Array.from(
          { length: 26 },
          (_, index) => (this.#sessions.size * 29 + index) % 256,
        ),
      ),
      expiresAt: this.now() + 3_600_000,
    };
    this.#sessions.set(idempotencyKey, response);
    this.#maybeFail("session", credential);
    return Promise.resolve({ ok: true as const, data: response });
  }
}

class MemoryStatus implements HRARunnerPairingStatusPort {
  readonly events: string[];
  readonly updates: Array<{
    readonly cloudWorkspaceId: string;
    readonly promotionId: string;
    readonly state: "pairing" | "paired" | "blocked";
    readonly faultCode: string | null;
    readonly now: number;
  }> = [];
  failStateOccurrence: {
    readonly state: "pairing" | "paired" | "blocked";
    readonly occurrence: number;
  } | null = null;
  readonly #stateCounts = new Map<string, number>();

  constructor(events: string[]) {
    this.events = events;
  }

  markPairingState(input: {
    readonly cloudWorkspaceId: string;
    readonly promotionId: string;
    readonly state: "pairing" | "paired" | "blocked";
    readonly faultCode: string | null;
    readonly now: number;
  }): void {
    this.events.push(`status:${input.state}`);
    this.updates.push(input);
    const occurrence = (this.#stateCounts.get(input.state) ?? 0) + 1;
    this.#stateCounts.set(input.state, occurrence);
    if (
      this.failStateOccurrence?.state === input.state &&
      this.failStateOccurrence.occurrence === occurrence
    ) {
      this.failStateOccurrence = null;
      throw new Error("injected local status failure");
    }
  }
}

function slotSource(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `runner_test_slot_${String(counter).padStart(6, "0")}`;
  };
}

function harness() {
  const events: string[] = [];
  const clock = { now: NOW };
  const metadata = new MemoryMetadata(events);
  const secrets = new MemorySecrets(events);
  const cloud = new ReplayCloud(events);
  cloud.now = () => clock.now;
  const status = new MemoryStatus(events);
  const coordinator = new HRARunnerPairingCoordinator({
    apiOrigin: "https://oprte.example.com",
    cloud,
    metadata,
    nameKey: NAME_KEY,
    secrets,
    status,
    now: () => clock.now,
    random: new DeterministicRandom(),
    nextSlot: slotSource(),
  });
  return {
    cloud,
    clock,
    coordinator,
    events,
    metadata,
    secrets,
    status,
  };
}

function expectSamePreparedCalls(
  calls: readonly (
    | EnrollmentCall
    | RedemptionCall
    | SessionCall
  )[],
): void {
  if (calls.length < 2) return;
  expect(calls[1]).toEqual(calls[0]);
}

function keychainPayloads(secrets: MemorySecrets): unknown[] {
  return [...secrets.values.values()].map((source) => {
    const envelope = keychainEnvelopeFixtureSchema.parse(
      JSON.parse(source) as unknown,
    );
    return JSON.parse(envelope.value) as unknown;
  });
}

describe("OPRTE runner pairing custody", () => {
  test("steady paired heartbeats keep the inspection cache bounded", () => {
    const cache = new HRARunnerPairingInspectionCache();
    let inspections = 0;
    const inspect = (pairing: {
      readonly cloudWorkspaceId: string;
      readonly promotionId: string;
      readonly state: string;
      readonly attemptCount: number;
      readonly updatedAt: number;
    }): void => {
      if (cache.hasCurrent(pairing)) return;
      inspections += 1;
      cache.record(pairing);
    };
    const pairing = {
      cloudWorkspaceId: WORKSPACE_ID,
      promotionId: PROMOTION_ID,
      state: "paired",
      attemptCount: 0,
      updatedAt: NOW,
    };
    for (let heartbeat = 0; heartbeat < 500; heartbeat += 1) {
      inspect({ ...pairing, updatedAt: NOW + heartbeat * 2_000 });
    }
    expect(inspections).toBe(1);
    expect(cache.size).toBe(1);

    inspect({ ...pairing, state: "blocked", attemptCount: 1 });
    expect(inspections).toBe(2);
    expect(cache.size).toBe(1);
    inspect({ ...pairing, state: "blocked", attemptCount: 2 });
    expect(inspections).toBe(3);
    expect(cache.size).toBe(1);
    cache.evict(pairing);
    expect(cache.size).toBe(0);
  });

  test("only custody-shaped failures trigger a fresh cached inspection", async () => {
    expect(hraRunnerPairingFailureCodeValues.filter(
      runnerPairingFailureMayRequireCredentialRecovery,
    )).toEqual([
      "invalid_binding",
      "custody_recovery_required",
      "custody_unavailable",
      "custody_invalid",
    ]);

    for (const mutation of ["denied", "deleted", "cross_binding"] as const) {
      const fixture = harness();
      expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
      expect(await fixture.coordinator.inspectLegacyCredentialReconnect(INPUT))
        .toEqual({ ok: true, state: "not_required" });
      const entry = [...fixture.secrets.values.entries()][0];
      if (entry === undefined) throw new Error("paired Keychain fixture is missing");
      const [key, source] = entry;
      const name = key.slice(`${HRA_RUNNER_KEYCHAIN_SERVICE}:`.length);
      if (mutation === "denied") {
        fixture.secrets.inaccessibleNames.add(name);
      } else if (mutation === "deleted") {
        fixture.secrets.values.delete(key);
      } else {
        const envelope = keychainEnvelopeFixtureSchema.parse(
          JSON.parse(source) as unknown,
        );
        const payload = z.record(z.string(), z.unknown()).parse(
          JSON.parse(envelope.value) as unknown,
        );
        fixture.secrets.values.set(key, JSON.stringify({
          ...envelope,
          value: JSON.stringify({
            ...payload,
            promotionId: "promotion_1123456789ABCDEFGHJKMNPQRS",
          }),
        }));
      }

      const recovered = await fixture.coordinator.recoverAuthorization(INPUT, {
        abandonMissingPending: true,
      });
      expect(recovered.ok).toBeFalse();
      if (recovered.ok) throw new Error("mutated custody unexpectedly recovered");
      expect(runnerPairingFailureMayRequireCredentialRecovery(
        recovered.error.code,
      )).toBeTrue();
      expect(recovered.error.code).toBe(
        mutation === "denied"
          ? "custody_recovery_required"
          : mutation === "deleted"
          ? "custody_invalid"
          : "invalid_binding",
      );
    }
  });

  test("durably prepares every bearer and idempotency key before the first cloud write", async () => {
    const fixture = harness();
    const paired = await fixture.coordinator.pair(INPUT);
    expect(paired).toMatchObject({
      ok: true,
      pairing: {
        promotionId: PROMOTION_ID,
        destinationWorkspaceId: WORKSPACE_ID,
        importedAgentId: AGENT_ID,
      },
    });

    const firstKeychainWrite = fixture.events.indexOf("keychain:set:1");
    const pairingStatus = fixture.events.indexOf("status:pairing");
    const firstCloudWrite = fixture.events.indexOf("cloud:create");
    expect(firstKeychainWrite).toBeGreaterThan(-1);
    expect(pairingStatus).toBeGreaterThan(firstKeychainWrite);
    expect(firstCloudWrite).toBeGreaterThan(pairingStatus);

    const enrollment = fixture.cloud.enrollmentCalls[0]?.enrollment;
    const credential = fixture.cloud.redemptionCalls[0]?.credential;
    expect(enrollment).toBeDefined();
    expect(credential).toBeDefined();
    expect(JSON.stringify(paired)).not.toContain(enrollment);
    expect(JSON.stringify(paired)).not.toContain(credential);

    const sqliteSource = JSON.stringify(
      [...fixture.metadata.journals.values()],
    );
    expect(sqliteSource).not.toContain(enrollment);
    expect(sqliteSource).not.toContain(credential);
    expect(sqliteSource).not.toContain(WORKSPACE_ID);
    expect(JSON.stringify(fixture.status.updates)).not.toContain(enrollment);
    expect(JSON.stringify(fixture.status.updates)).not.toContain(credential);

    const expectedName = hraRunnerKeychainName(
      NAME_KEY,
      "https://oprte.example.com",
      WORKSPACE_ID,
    );
    expect(expectedName).not.toContain(WORKSPACE_ID);
    expect([...fixture.metadata.journals.keys()][0]).toBe(
      `${HRA_RUNNER_KEYCHAIN_SERVICE}:${expectedName}`,
    );
    expect(fixture.secrets.values).toHaveLength(1);
    const finalEnvelope = [...fixture.secrets.values.values()][0];
    expect(finalEnvelope).toContain(credential);
    expect(finalEnvelope).not.toContain(enrollment);

    const authorization = await fixture.coordinator.readAuthorization(INPUT);
    expect(authorization).toMatchObject({
      ok: true,
      authorization: {
        apiOrigin: "https://oprte.example.com",
        credential,
      },
    });
    expect(fixture.status.updates.at(-1)).toMatchObject({
      cloudWorkspaceId: WORKSPACE_ID,
      promotionId: PROMOTION_ID,
      state: "pairing",
      faultCode: null,
    });
    expect(fixture.status.updates.some(({ state }) => state === "paired"))
      .toBeFalse();
  });

  test("does not call the cloud when initial custody reservation fails", async () => {
    const fixture = harness();
    fixture.metadata.failCasAttempts.add(1);
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
      ok: false,
      error: { code: "custody_unavailable" },
    });
    expect(fixture.cloud.enrollmentCalls).toHaveLength(0);
    expect(fixture.secrets.values).toHaveLength(0);
    expect(fixture.metadata.journals).toHaveLength(0);

    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
  });

  test("requires explicit abandonment after a crash before the initial Keychain write", async () => {
    const fixture = harness();
    fixture.secrets.failSetAttempts.add(1);
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
      ok: false,
      error: { code: "custody_unavailable" },
    });
    expect(fixture.cloud.enrollmentCalls).toHaveLength(0);
    expect(await fixture.coordinator.recoverAuthorization(INPUT, {
      abandonMissingPending: false,
    })).toMatchObject({
      ok: false,
      error: { code: "custody_recovery_required" },
    });
    expect(await fixture.coordinator.recoverAuthorization(INPUT, {
      abandonMissingPending: true,
    })).toMatchObject({
      ok: false,
      error: { code: "not_paired" },
    });
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
  });

  test("recovers the exact staged preparation after a crash before its metadata commit", async () => {
    const fixture = harness();
    fixture.metadata.failCasAttempts.add(2);
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
      ok: false,
      error: { code: "custody_unavailable" },
    });
    expect(fixture.cloud.enrollmentCalls).toHaveLength(0);
    const preparedValue = keychainPayloads(fixture.secrets)[0];
    if (preparedValue === undefined) {
      throw new Error("prepared keychain payload is missing");
    }
    const prepared = preparedPayloadFixtureSchema.parse(preparedValue);
    expect(prepared.state).toBe("prepared");

    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    expect(fixture.cloud.enrollmentCalls[0]).toMatchObject({
      enrollment: prepared.enrollment,
      idempotencyKey: prepared.idempotency.createEnrollment,
    });
    expect(fixture.cloud.redemptionCalls[0]).toMatchObject({
      enrollment: prepared.enrollment,
      credential: prepared.credential,
      idempotencyKey: prepared.idempotency.redeemEnrollment,
    });
    expect(fixture.cloud.sessionCalls[0]).toMatchObject({
      credential: prepared.credential,
      idempotencyKey: prepared.idempotency.startSession,
    });
  });

  test("preserves the prepared bundle when final metadata reservation fails", async () => {
    const fixture = harness();
    fixture.metadata.failCasAttempts.add(3);
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
      ok: false,
      error: { code: "custody_unavailable" },
    });
    expect(fixture.cloud.enrollmentCalls).toHaveLength(1);
    expect(fixture.cloud.redemptionCalls).toHaveLength(1);
    expect(fixture.cloud.sessionCalls).toHaveLength(1);

    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    expectSamePreparedCalls(fixture.cloud.enrollmentCalls);
    expectSamePreparedCalls(fixture.cloud.redemptionCalls);
    expectSamePreparedCalls(fixture.cloud.sessionCalls);
  });

  for (
    const boundary of [
      {
        name: "final metadata commit",
        inject(fixture: ReturnType<typeof harness>): void {
          fixture.metadata.failCasAttempts.add(4);
        },
      },
      {
        name: "superseded preparation deletion",
        inject(fixture: ReturnType<typeof harness>): void {
          fixture.secrets.failDeleteAttempts.add(1);
        },
      },
      {
        name: "superseded-pointer retirement",
        inject(fixture: ReturnType<typeof harness>): void {
          fixture.metadata.failCasAttempts.add(5);
        },
      },
    ] as const
  ) {
    test(`recovers committed authorization after a crash at ${boundary.name}`, async () => {
      const fixture = harness();
      boundary.inject(fixture);
      expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
        ok: false,
        error: { code: "custody_unavailable" },
      });
      const callCounts = [
        fixture.cloud.enrollmentCalls.length,
        fixture.cloud.redemptionCalls.length,
        fixture.cloud.sessionCalls.length,
      ];

      expect(await fixture.coordinator.recoverAuthorization(INPUT, {
        abandonMissingPending: false,
      })).toMatchObject({ ok: true });
      expect([
        fixture.cloud.enrollmentCalls.length,
        fixture.cloud.redemptionCalls.length,
        fixture.cloud.sessionCalls.length,
      ]).toEqual(callCounts);
      expect(fixture.status.updates.at(-1)).toMatchObject({
        promotionId: PROMOTION_ID,
        cloudWorkspaceId: WORKSPACE_ID,
        state: "pairing",
      });
    });
  }

  test("halts before the cloud when token-free pairing status cannot be bound", async () => {
    const fixture = harness();
    fixture.status.failStateOccurrence = {
      state: "pairing",
      occurrence: 1,
    };
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
      ok: false,
      error: { code: "local_state_unavailable" },
    });
    expect(fixture.cloud.enrollmentCalls).toHaveLength(0);
    const preparedValue = keychainPayloads(fixture.secrets)[0];
    if (preparedValue === undefined) {
      throw new Error("prepared keychain payload is missing");
    }
    const prepared = preparedPayloadFixtureSchema.parse(preparedValue);

    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    expect(fixture.cloud.enrollmentCalls[0]?.enrollment)
      .toBe(prepared.enrollment);
  });

  test("concurrent process-local attempts converge on one prepared bundle", async () => {
    const fixture = harness();
    const [left, right] = await Promise.all([
      fixture.coordinator.pair(INPUT),
      fixture.coordinator.pair(INPUT),
    ]);
    expect(left.ok).toBeTrue();
    expect(right.ok).toBeTrue();
    const enrollment = fixture.cloud.enrollmentCalls[0];
    const redemption = fixture.cloud.redemptionCalls[0];
    const session = fixture.cloud.sessionCalls[0];
    if (
      enrollment === undefined ||
      redemption === undefined ||
      session === undefined
    ) {
      throw new Error("concurrent cloud call fixture is missing");
    }
    for (const call of fixture.cloud.enrollmentCalls) {
      expect(call).toEqual(enrollment);
    }
    for (const call of fixture.cloud.redemptionCalls) {
      expect(call).toEqual(redemption);
    }
    for (const call of fixture.cloud.sessionCalls) {
      expect(call).toEqual(session);
    }
    expect(await fixture.coordinator.readAuthorization(INPUT))
      .toMatchObject({ ok: true });
  });

  for (const stage of ["create", "redeem", "session"] as const) {
    test(`replays the exact prepared bundle after an ambiguous ${stage} boundary`, async () => {
      const fixture = harness();
      fixture.cloud.failOnceAfter = stage;

      const first = await fixture.coordinator.pair(INPUT);
      expect(first).toMatchObject({
        ok: false,
        error: { code: "cloud_unavailable", retryable: true },
      });
      const enrollment = fixture.cloud.enrollmentCalls[0]?.enrollment;
      const credential =
        fixture.cloud.redemptionCalls[0]?.credential ??
        fixture.cloud.sessionCalls[0]?.credential;
      expect(JSON.stringify(first)).not.toContain(enrollment);
      if (credential !== undefined) {
        expect(JSON.stringify(first)).not.toContain(credential);
      }

      const replay = await fixture.coordinator.pair(INPUT);
      expect(replay.ok).toBeTrue();
      expectSamePreparedCalls(fixture.cloud.enrollmentCalls);
      expectSamePreparedCalls(fixture.cloud.redemptionCalls);
      expectSamePreparedCalls(fixture.cloud.sessionCalls);

      const firstEnrollment = fixture.cloud.enrollmentCalls[0];
      if (firstEnrollment === undefined) {
        throw new Error("enrollment call fixture is missing");
      }
      for (const call of fixture.cloud.enrollmentCalls) {
        expect(call).toEqual(firstEnrollment);
      }
      const firstRedemption = fixture.cloud.redemptionCalls[0];
      if (firstRedemption === undefined) {
        throw new Error("redemption call fixture is missing");
      }
      for (const call of fixture.cloud.redemptionCalls) {
        expect(call).toEqual(firstRedemption);
      }
      const firstSession = fixture.cloud.sessionCalls[0];
      if (firstSession === undefined) {
        throw new Error("session call fixture is missing");
      }
      for (const call of fixture.cloud.sessionCalls) {
        expect(call).toEqual(firstSession);
      }
    });
  }

  test("recovers a crash before final Keychain custody without minting new cloud inputs", async () => {
    const fixture = harness();
    fixture.secrets.failSetAttempts.add(2);

    const interrupted = await fixture.coordinator.pair(INPUT);
    expect(interrupted).toMatchObject({
      ok: false,
      error: { code: "custody_unavailable" },
    });
    const preparedCalls = {
      enrollment: fixture.cloud.enrollmentCalls[0],
      redemption: fixture.cloud.redemptionCalls[0],
      session: fixture.cloud.sessionCalls[0],
    };

    expect(await fixture.coordinator.recoverAuthorization(INPUT, {
      abandonMissingPending: false,
    })).toMatchObject({
      ok: false,
      error: { code: "custody_recovery_required" },
    });
    const recovered = await fixture.coordinator.recoverAuthorization(INPUT, {
      abandonMissingPending: true,
    });
    expect(recovered.ok).toBeTrue();
    expect(fixture.cloud.enrollmentCalls.at(-1)).toEqual(
      preparedCalls.enrollment,
    );
    expect(fixture.cloud.redemptionCalls.at(-1)).toEqual(
      preparedCalls.redemption,
    );
    expect(fixture.cloud.sessionCalls.at(-1)).toEqual(preparedCalls.session);
  });

  test("keeps completed authorization recoverable when the token-free status update fails", async () => {
    const fixture = harness();
    fixture.status.failStateOccurrence = {
      state: "pairing",
      occurrence: 2,
    };
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
      ok: false,
      error: { code: "local_state_unavailable" },
    });
    const callCounts = [
      fixture.cloud.enrollmentCalls.length,
      fixture.cloud.redemptionCalls.length,
      fixture.cloud.sessionCalls.length,
    ];

    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    expect([
      fixture.cloud.enrollmentCalls.length,
      fixture.cloud.redemptionCalls.length,
      fixture.cloud.sessionCalls.length,
    ]).toEqual(callCounts);
    expect(await fixture.coordinator.readAuthorization(INPUT))
      .toMatchObject({ ok: true });
  });

  test("durably prepares and replays one session-renewal idempotency key", async () => {
    const fixture = harness();
    const initial = await fixture.coordinator.pair(INPUT);
    expect(initial.ok).toBeTrue();
    const initialAuthorization =
      await fixture.coordinator.readAuthorization(INPUT);
    expect(initialAuthorization.ok).toBeTrue();
    const initialSession = initialAuthorization.ok
      ? initialAuthorization.authorization.sessionId
      : "";

    fixture.clock.now += 3_550_000;
    fixture.cloud.failOnceAfter = "session";
    const ambiguous = await fixture.coordinator.recoverAuthorization(INPUT, {
      abandonMissingPending: false,
    });
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { code: "cloud_unavailable" },
    });
    const preparedRenewal = fixture.cloud.sessionCalls.at(-1);
    expect(preparedRenewal).toBeDefined();

    const recovered = await fixture.coordinator.recoverAuthorization(INPUT, {
      abandonMissingPending: false,
    });
    expect(recovered).toMatchObject({ ok: true });
    const replayedRenewal = fixture.cloud.sessionCalls.at(-1);
    expect(replayedRenewal).toEqual(preparedRenewal);
    if (recovered.ok) {
      expect(recovered.authorization.sessionId).not.toBe(initialSession);
    }

    const metadataSource = JSON.stringify(
      [...fixture.metadata.journals.values()],
    );
    expect(metadataSource).not.toContain(
      preparedRenewal?.credential,
    );
  });

  for (
    const mismatch of [
      ["enrollment", "cloud_response_invalid"],
      ["agent", "cloud_response_invalid"],
      ["credential", "cloud_response_invalid"],
    ] as const
  ) {
    test(`fails closed on a ${mismatch[0]} response binding mismatch`, async () => {
      const fixture = harness();
      fixture.cloud.mismatched = mismatch[0];
      const result = await fixture.coordinator.pair(INPUT);
      expect(result).toMatchObject({
        ok: false,
        error: { code: mismatch[1] },
      });
      const serialized = JSON.stringify(result);
      for (const secret of [
        fixture.cloud.enrollmentCalls[0]?.enrollment,
        fixture.cloud.redemptionCalls[0]?.credential,
      ]) {
        if (secret !== undefined) expect(serialized).not.toContain(secret);
      }
      expect(await fixture.coordinator.readAuthorization(INPUT))
        .toMatchObject({
          ok: false,
          error: { code: "pairing_incomplete" },
        });
      expect(await fixture.coordinator.inspectLegacyCredentialReconnect(INPUT))
        .toEqual({ ok: true, state: "not_required" });
    });
  }

  test("fails closed when the imported agent lacks any dispatcher scope", async () => {
    const fixture = harness();
    fixture.cloud.scopes = agentPresetScopes.dispatcher.slice(0, -1);
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({
      ok: false,
      error: { code: "dispatcher_scope_missing", retryable: false },
    });
    expect(fixture.cloud.sessionCalls).toHaveLength(0);
  });

  test("rejects cross-promotion agent substitution before custody or network", async () => {
    const fixture = harness();
    expect(await fixture.coordinator.pair({
      ...INPUT,
      importedAgentId: "imported_local_codex_another-promotion",
    })).toMatchObject({
      ok: false,
      error: { code: "invalid_binding" },
    });
    expect(fixture.metadata.journals).toHaveLength(0);
    expect(fixture.secrets.values).toHaveLength(0);
    expect(fixture.cloud.enrollmentCalls).toHaveLength(0);
    expect(fixture.status.updates).toHaveLength(0);
  });

  test("maps malformed Keychain payloads to a static gateway-only custody fault", async () => {
    const fixture = harness();
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    const credential = fixture.cloud.redemptionCalls[0]?.credential;
    const entry = [...fixture.secrets.values.entries()][0];
    if (credential === undefined || entry === undefined) {
      throw new Error("paired keychain fixture is missing");
    }
    const [key, source] = entry;
    const envelope = keychainEnvelopeFixtureSchema.parse(
      JSON.parse(source) as unknown,
    );
    fixture.secrets.values.set(key, JSON.stringify({
      ...envelope,
      value: JSON.stringify({
        state: "paired",
        credential,
        unexpected: "corrupt",
      }),
    }));

    const result = await fixture.coordinator.readAuthorization(INPUT);
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "custody_invalid",
        message: "Runner credential custody is invalid.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(await fixture.coordinator.inspectLegacyCredentialReconnect(INPUT))
      .toEqual({ ok: true, state: "required" });
    fixture.status.failStateOccurrence = { state: "pairing", occurrence: 3 };
    expect(await fixture.coordinator.confirmLegacyCredentialReconnect(INPUT))
      .toMatchObject({
        ok: false,
        error: { code: "local_state_unavailable" },
      });
    expect(fixture.secrets.values.get(key)).toBeDefined();
    expect(await fixture.coordinator.confirmLegacyCredentialReconnect(INPUT))
      .toEqual({ ok: true, state: "not_required" });
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    expect(await fixture.coordinator.readAuthorization(INPUT))
      .toMatchObject({ ok: true });
  });

  test("preserves a schema-valid cross-binding runner payload before re-enrollment", async () => {
    const fixture = harness();
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    const entry = [...fixture.secrets.values.entries()][0];
    if (entry === undefined) throw new Error("paired keychain fixture is missing");
    const [key, source] = entry;
    const envelope = keychainEnvelopeFixtureSchema.parse(
      JSON.parse(source) as unknown,
    );
    const payload = z.record(z.string(), z.unknown()).parse(
      JSON.parse(envelope.value) as unknown,
    );
    fixture.secrets.values.set(key, JSON.stringify({
      ...envelope,
      value: JSON.stringify({
        ...payload,
        promotionId: "promotion_1123456789ABCDEFGHJKMNPQRS",
      }),
    }));

    expect(await fixture.coordinator.inspectLegacyCredentialReconnect(INPUT))
      .toEqual({ ok: true, state: "required" });
    expect(await fixture.coordinator.confirmLegacyCredentialReconnect(INPUT))
      .toEqual({ ok: true, state: "quarantined" });
    expect(fixture.secrets.values.has(key)).toBeTrue();
    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    expect(await fixture.coordinator.readAuthorization(INPUT))
      .toMatchObject({ ok: true });
  });

  test("fault reinspection preserves missing or invalid deleting runner roles", async () => {
    for (const anomaly of ["missing", "invalid"] as const) {
      const fixture = harness();
      const name = hraRunnerKeychainName(
        NAME_KEY,
        "https://oprte.example.com",
        WORKSPACE_ID,
      );
      const descriptor = {
        service: HRA_RUNNER_KEYCHAIN_SERVICE,
        name,
      } as const;
      const slot = `runner_deleting_${anomaly}01`;
      fixture.metadata.journals.set(descriptorKey(descriptor), {
        version: 1,
        revision: 5,
        latestGeneration: 1,
        service: descriptor.service,
        name: descriptor.name,
        deleting: [{ generation: 1, slot }],
      });
      if (anomaly === "invalid") {
        fixture.secrets.values.set(
          `${descriptor.service}:${descriptor.name}:slot:${slot}`,
          "{invalid-envelope",
        );
      }

      expect(await fixture.coordinator.inspectLegacyCredentialReconnect(INPUT))
        .toEqual({ ok: true, state: "not_required" });
      expect(await fixture.coordinator.inspectCredentialReconnect(INPUT))
        .toEqual({ ok: true, state: "required" });
      expect(await fixture.coordinator.confirmLegacyCredentialReconnect(INPUT))
        .toEqual({ ok: true, state: "quarantined" });
      expect(fixture.metadata.quarantined.get(descriptorKey(descriptor))?.map(
        ({ reason }) => reason,
      )).toEqual([
        anomaly === "missing"
          ? "missing_pointer_abandoned"
          : "invalid_pointer_preserved",
      ]);
      expect(fixture.secrets.legacyDeleteAttempts).toBe(0);
      expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
      expect(await fixture.coordinator.readAuthorization(INPUT))
        .toMatchObject({ ok: true });
    }
  });

  test("explicit legacy reconnect preserves old runner items and re-enrolls durably", async () => {
    const fixture = harness();
    const name = hraRunnerKeychainName(
      NAME_KEY,
      "https://oprte.example.com",
      WORKSPACE_ID,
    );
    const descriptor = {
      service: HRA_RUNNER_KEYCHAIN_SERVICE,
      name,
    } as const;
    const committedSlot = "runner_test_slot_000001";
    const deletingSlot = "legacy_runner_delete0";
    const committedName = `${name}:slot:${committedSlot}`;
    const deletingName = `${name}:slot:${deletingSlot}`;
    fixture.metadata.journals.set(descriptorKey(descriptor), {
      version: 1,
      revision: 9,
      latestGeneration: 1,
      service: descriptor.service,
      name: descriptor.name,
      committed: { generation: 1, slot: committedSlot },
      deleting: [{ generation: 0, slot: deletingSlot }],
    });
    for (const [slotName, generation] of [
      [committedName, 1],
      [deletingName, 0],
    ] as const) {
      fixture.secrets.inaccessibleNames.add(slotName);
      fixture.secrets.values.set(
        `${descriptor.service}:${slotName}`,
        JSON.stringify({
          version: 1,
          generation,
          value: "opaque legacy runner bearer that remains in Keychain",
        }),
      );
    }

    expect(await fixture.coordinator.recoverAuthorization(INPUT, {
      abandonMissingPending: true,
    })).toMatchObject({
      ok: false,
      error: { code: "custody_recovery_required" },
    });
    expect(fixture.secrets.legacyDeleteAttempts).toBe(0);
    expect(fixture.cloud.enrollmentCalls).toHaveLength(0);

    expect(await fixture.coordinator.confirmLegacyCredentialReconnect(INPUT))
      .toEqual({ ok: true, state: "quarantined" });
    const retired = fixture.metadata.journals.get(descriptorKey(descriptor));
    expect(retired).toMatchObject({ revision: 10, latestGeneration: 1 });
    expect(retired?.committed).toBeUndefined();
    expect(retired?.deleting).toBeUndefined();
    expect(fixture.metadata.quarantined.get(descriptorKey(descriptor)))
      .toHaveLength(2);
    expect(fixture.secrets.legacyDeleteAttempts).toBe(0);
    expect(fixture.secrets.values.has(
      `${descriptor.service}:${committedName}`,
    )).toBeTrue();
    expect(fixture.secrets.values.has(
      `${descriptor.service}:${deletingName}`,
    )).toBeTrue();

    expect(await fixture.coordinator.pair(INPUT)).toMatchObject({ ok: true });
    expect(await fixture.coordinator.readAuthorization(INPUT))
      .toMatchObject({ ok: true });
    const current = fixture.metadata.journals.get(descriptorKey(descriptor));
    expect(current?.committed).toEqual({
      generation: 3,
      slot: "runner_test_slot_000003",
    });
    expect(fixture.secrets.legacyDeleteAttempts).toBe(0);

    const restarted = new HRARunnerPairingCoordinator({
      apiOrigin: "https://oprte.example.com",
      cloud: fixture.cloud,
      metadata: fixture.metadata,
      nameKey: NAME_KEY,
      secrets: fixture.secrets,
      status: fixture.status,
      now: () => fixture.clock.now,
      random: new DeterministicRandom(),
      nextSlot: () => "runner_restart_slot_0001",
    });
    expect(await restarted.readAuthorization(INPUT)).toMatchObject({ ok: true });
    expect(fixture.secrets.legacyDeleteAttempts).toBe(0);
  });
});
