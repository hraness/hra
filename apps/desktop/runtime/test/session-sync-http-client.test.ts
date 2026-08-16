import { describe, expect, test } from "bun:test";
import {
  MAX_SYNC_PROOF_TTL_MS,
  createSyncDeviceKeyPairs,
  decodeSyncUint64,
  syncDeviceIdSchema,
  syncDeviceProofSchema,
  syncMembershipCoordinateSchema,
} from "@hraness/agent-tasks-protocol";
import { fc } from "@hra-internal/test";
import {
  HumanSessionCoordinator,
  humanAuthenticationSnapshotSchema,
  type HumanAuthenticationStore,
} from "@hraness/hra-human-client";

import {
  SessionSyncBearerClient,
  SessionSyncHttpTransport,
  conservativeSessionSyncProofTime,
  sessionSyncProofMethod,
  sessionSyncResponseMatchesRequest,
  type SessionSyncClockCalibration,
  type SessionSyncProofAuthority,
} from "../src/cloud/session-sync-http-client";

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

function rawProofMethod(request: unknown): unknown {
  return Reflect.apply(sessionSyncProofMethod, undefined, [request]);
}

function rawResponseMatchesRequest(
  request: unknown,
  response: unknown,
  expectedVault: unknown,
): boolean {
  return Reflect.apply(
    sessionSyncResponseMatchesRequest,
    undefined,
    [request, response, expectedVault],
  ) === true;
}

function session(): HumanSessionCoordinator {
  const snapshot = humanAuthenticationSnapshotSchema.parse({
    generation: 1,
    authentication: {
      version: 1,
      apiUrl: "https://oprte.example.com",
      accessToken: "session-sync-access-token",
      refreshToken: "session-sync-refresh-token-in-keychain",
      user: {
        id: "user_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "chef@example.com",
      },
    },
  });
  const store: HumanAuthenticationStore = {
    read: () => Promise.resolve(snapshot),
    compareAndSwap: () => Promise.resolve(null),
    clear: () => Promise.resolve(false),
  };
  return new HumanSessionCoordinator({
    store,
    refresh: {
      refresh: () => Promise.resolve({
        ok: false,
        outcome: "authentication_failed",
      }),
    },
  });
}

async function authority(): Promise<SessionSyncProofAuthority> {
  return {
    membership: syncMembershipCoordinateSchema.parse({
      tenantId: opaque("synctenant", "t"),
      organizationId: opaque("syncorg", "o"),
      ownerUserId: opaque("syncuser", "u"),
      vaultId: opaque("syncvault", "v"),
      vaultGeneration: "1",
      membershipEpoch: "1",
    }),
    deviceId: syncDeviceIdSchema.parse(opaque("syncdevice", "d")),
    keys: await createSyncDeviceKeyPairs(),
  };
}

const readMembership = {
  version: 1 as const,
  operation: "read_membership" as const,
};

describe("session sync relay failures", () => {
  test("preserves one bounded server rate-limit deadline", async () => {
    const transport = new SessionSyncHttpTransport({
      apiUrl: "https://oprte.example.com",
      fetch: () => Promise.resolve(new Response(JSON.stringify({
        ok: false,
        code: "RATE_LIMITED",
        retryAfterMs: 12_345,
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })),
    });
    expect(await transport.negotiate("access-token")).toEqual({
      ok: false,
      error: { code: "RATE_LIMITED", retryAfterMs: 12_345 },
    });
  });

  test("fails malformed or oversized rate limits closed without a retry deadline", async () => {
    for (const retryAfterMs of [-1, 0, 300_001, Number.MAX_SAFE_INTEGER]) {
      const transport = new SessionSyncHttpTransport({
        apiUrl: "https://oprte.example.com",
        fetch: () => Promise.resolve(new Response(JSON.stringify({
          ok: false,
          code: "RATE_LIMITED",
          retryAfterMs,
        }), {
          status: 429,
          headers: { "content-type": "application/json" },
        })),
      });
      expect(await transport.negotiate("access-token")).toEqual({
        ok: false,
        error: { code: "SERVICE_UNAVAILABLE" },
      });
    }
  });
});

test("membership admission uses POST and reconciles the canonical child for the same parent", () => {
  const statement = {
    tenantId: opaque("synctenant", "t"),
    organizationId: opaque("syncorg", "o"),
    ownerUserId: opaque("syncuser", "u"),
    vaultId: opaque("syncvault", "v"),
    vaultGeneration: "1",
    membershipEpoch: "2",
    previousMembershipDigest: `sha256_${"a".repeat(64)}`,
  };
  const request = {
    version: 1,
    operation: "admit_membership_proposal",
    membershipCandidate: {
      statement,
      statementDigest: `sha256_${"b".repeat(64)}`,
    },
  };
  const canonicalWinner = {
    kind: "membership_pending",
    proposal: {
      candidate: {
        statement: { ...statement, rootKeyEpoch: "2" },
        statementDigest: `sha256_${"c".repeat(64)}`,
      },
    },
  };
  const expectedVault = {
    tenantId: statement.tenantId,
    organizationId: statement.organizationId,
    ownerUserId: statement.ownerUserId,
    vaultId: statement.vaultId,
    vaultGeneration: statement.vaultGeneration,
  };
  expect(rawProofMethod(request)).toBe("POST");
  expect(rawResponseMatchesRequest(
    request,
    canonicalWinner,
    expectedVault,
  )).toBeTrue();
  expect(rawResponseMatchesRequest(request, {
    kind: "membership_pending",
    proposal: {
      candidate: {
        statement: {
          ...statement,
          previousMembershipDigest: `sha256_${"d".repeat(64)}`,
        },
      },
    },
  }, expectedVault)).toBeFalse();
  expect(rawResponseMatchesRequest(request, {
    kind: "membership_accepted",
    membershipEpoch: "2",
    membershipDigest: `sha256_${"b".repeat(64)}`,
  }, expectedVault)).toBeTrue();
  expect(rawResponseMatchesRequest(request, {
    kind: "membership_accepted",
    membershipEpoch: "2",
    membershipDigest: `sha256_${"c".repeat(64)}`,
  }, expectedVault)).toBeFalse();
});

test("every scope-bearing relay response rejects a cross-vault projection", () => {
  const expectedVault = {
    tenantId: opaque("synctenant", "t"),
    organizationId: opaque("syncorg", "o"),
    ownerUserId: opaque("syncuser", "u"),
    vaultId: opaque("syncvault", "v"),
    vaultGeneration: "1",
  };
  const foreignVault = {
    ...expectedVault,
    vaultId: opaque("syncvault", "x"),
  };
  const digest = `sha256_${"a".repeat(64)}`;
  const bootId = opaque("syncboot", "b");
  const sessionId = opaque("syncsession", "s");
  const cases = [
    [{ version: 1, operation: "read_membership" }, {
      kind: "membership",
      head: { statement: foreignVault },
    }],
    [{ version: 1, operation: "list_enrollment_requests" }, {
      kind: "enrollment_requests",
      vault: foreignVault,
      requests: [],
    }],
    [{
      version: 1,
      operation: "admit_membership_proposal",
      membershipCandidate: {
        statement: {
          ...expectedVault,
          membershipEpoch: "2",
          previousMembershipDigest: digest,
        },
      },
    }, {
      kind: "membership_pending",
      proposal: {
        candidate: {
          statement: {
            ...foreignVault,
            membershipEpoch: "2",
            previousMembershipDigest: digest,
          },
        },
      },
    }],
    [{
      version: 1,
      operation: "update_membership",
      membershipHead: {
        statement: {
          ...foreignVault,
          membershipEpoch: "2",
        },
        statementDigest: digest,
      },
    }, {
      kind: "membership_accepted",
      membershipEpoch: "2",
      membershipDigest: digest,
    }],
    [{
      version: 1,
      operation: "approve_enrollment",
      requestId: opaque("syncenrollment", "e"),
      membershipHead: {
        statement: { ...expectedVault, membershipEpoch: "2" },
      },
    }, {
      kind: "enrollment_approved",
      vault: foreignVault,
      requestId: opaque("syncenrollment", "e"),
      membershipEpoch: "2",
    }],
    [{
      version: 1,
      operation: "root_key_link_page",
      pageSize: 32,
    }, {
      kind: "root_key_link_page",
      vault: foreignVault,
      links: [],
      hasMore: false,
    }],
    [{
      version: 1,
      operation: "establish_boot",
      bootId,
      heartbeatSequence: "1",
    }, {
      kind: "boot_current",
      vault: foreignVault,
      bootId,
      bootGeneration: "1",
      heartbeatSequence: "1",
    }],
    [{
      version: 1,
      operation: "heartbeat",
      bootId,
      bootGeneration: "1",
      heartbeatSequence: "2",
    }, {
      kind: "boot_current",
      vault: foreignVault,
      bootId,
      bootGeneration: "1",
      heartbeatSequence: "2",
    }],
    [{
      version: 1,
      operation: "reserve_session",
      sessionId,
      creationGrantDigest: digest,
    }, {
      kind: "session_reserved",
      vault: foreignVault,
      sessionId,
      creationGrantDigest: digest,
    }],
    [{
      version: 1,
      operation: "acquire_writer",
      bootId,
      bootGeneration: "1",
    }, {
      kind: "writer_acquired",
      vault: foreignVault,
      bootId,
      bootGeneration: "1",
    }],
    [{
      version: 1,
      operation: "publish_session",
      envelope: { header: { ...expectedVault } },
    }, {
      kind: "session_accepted",
      accepted: { envelope: { header: { ...foreignVault } } },
    }],
    [{
      version: 1,
      operation: "delete_session",
      sessionId,
      tombstoneDigest: digest,
    }, {
      kind: "session_deleted",
      tombstone: {
        ...foreignVault,
        sessionId,
        tombstoneDigest: digest,
      },
    }],
    [{
      version: 1,
      operation: "begin_snapshot",
      snapshotId: `syncsnapshot_${"s".repeat(32)}`,
    }, {
      kind: "snapshot_started",
      vault: foreignVault,
      snapshotId: `syncsnapshot_${"s".repeat(32)}`,
    }],
    [{
      version: 1,
      operation: "snapshot_page",
      snapshotId: `syncsnapshot_${"s".repeat(32)}`,
      pageSize: 32,
    }, {
      kind: "snapshot_page",
      page: { vault: foreignVault },
    }],
    [{
      version: 1,
      operation: "change_page",
      afterVersion: "0",
      pageSize: 32,
    }, {
      kind: "change_page",
      page: { vault: foreignVault, afterVersion: "0" },
    }],
    [{
      version: 1,
      operation: "change_page",
      afterVersion: "0",
      pageSize: 32,
    }, {
      kind: "resnapshot_required",
      vault: foreignVault,
      floorVersion: "1",
    }],
  ] as const;

  for (const [request, response] of cases) {
    expect(rawResponseMatchesRequest(
      request,
      response,
      expectedVault,
    )).toBeFalse();
  }
});

test("empty scoped pages remain usable only with their authenticated vault", () => {
  const vault = {
    tenantId: opaque("synctenant", "t"),
    organizationId: opaque("syncorg", "o"),
    ownerUserId: opaque("syncuser", "u"),
    vaultId: opaque("syncvault", "v"),
    vaultGeneration: "1",
  };
  expect(rawResponseMatchesRequest(
    { version: 1, operation: "list_enrollment_requests" },
    { kind: "enrollment_requests", vault, requests: [] },
    vault,
  )).toBeTrue();
  expect(rawResponseMatchesRequest(
    { version: 1, operation: "root_key_link_page", pageSize: 32 },
    {
      kind: "root_key_link_page",
      vault,
      links: [],
      hasMore: false,
    },
    vault,
  )).toBeTrue();
  expect(rawResponseMatchesRequest(
    {
      version: 1,
      operation: "begin_snapshot",
      snapshotId: `syncsnapshot_${"s".repeat(32)}`,
    },
    {
      kind: "snapshot_started",
      vault,
      snapshotId: `syncsnapshot_${"s".repeat(32)}`,
    },
    vault,
  )).toBeTrue();
});

function acceptedNegotiation(serverObservedAt: number) {
  return {
    ok: true as const,
    data: {
      outcome: "accepted" as const,
      version: 1 as const,
      capabilities: [],
      serverObservedAt: String(serverObservedAt),
      maximumProofTtlMs: MAX_SYNC_PROOF_TTL_MS,
    },
  };
}

describe("session sync bearer proof clock", () => {
  test("uses the RTT lower bound and persists midpoint uncertainty", async () => {
    let monotonicNow = 100;
    let proofJson = "";
    const saved: SessionSyncClockCalibration[] = [];
    const transport = {
      negotiate: () => {
        monotonicNow = 140;
        return Promise.resolve(acceptedNegotiation(1_000));
      },
      execute: (
        _token: string,
        _request: unknown,
        value: string,
      ) => {
        proofJson = value;
        return Promise.resolve({
          ok: false as const,
          error: { code: "SERVICE_UNAVAILABLE" as const },
        });
      },
    } as unknown as SessionSyncHttpTransport;
    const client = new SessionSyncBearerClient({
      session: session(),
      transport,
      now: () => 5_000,
      monotonicNow: () => monotonicNow,
      calibration: {
        load: () => null,
        save: (calibration) => {
          saved.push(calibration);
        },
      },
    });

    expect(await client.negotiate()).toMatchObject({ ok: true });
    monotonicNow = 150;
    await client.execute(readMembership, await authority());

    expect(saved).toEqual([{
      serverObservedAt: 1_000,
      clientObservedAt: 5_020,
      uncertaintyMs: 20,
    }]);
    const proof = syncDeviceProofSchema.parse(JSON.parse(proofJson));
    expect(String(proof.payload.issuedAt)).toBe("1010");
    expect(
      decodeSyncUint64(proof.payload.expiresAt)
        - decodeSyncUint64(proof.payload.issuedAt),
    ).toBe(60_000n);
  });

  test("falls back from implausibly old or future persisted wall deltas", async () => {
    for (const calibration of [{
      serverObservedAt: 10,
      clientObservedAt: 1,
      uncertaintyMs: 0,
    }, {
      serverObservedAt: 10,
      clientObservedAt: 2_000_001,
      uncertaintyMs: 0,
    }]) {
      let proofJson = "";
      const transport = {
        execute: (
          _token: string,
          _request: unknown,
          value: string,
        ) => {
          proofJson = value;
          return Promise.resolve({
            ok: false as const,
            error: { code: "SERVICE_UNAVAILABLE" as const },
          });
        },
      } as unknown as SessionSyncHttpTransport;
      const client = new SessionSyncBearerClient({
        session: session(),
        transport,
        now: () => 1_000_000,
        monotonicNow: () => 100,
        calibration: { load: () => calibration, save: () => undefined },
      });

      await client.execute(readMembership, await authority());
      const proof = syncDeviceProofSchema.parse(JSON.parse(proofJson));
      expect(String(proof.payload.issuedAt)).toBe("1000000");
    }
  });

  test("renegotiates PROOF_INVALID once and does not loop", async () => {
    let executeCalls = 0;
    let negotiationCalls = 0;
    let monotonicNow = 0;
    const transport = {
      negotiate: () => {
        negotiationCalls += 1;
        monotonicNow += 10;
        return Promise.resolve(acceptedNegotiation(10_000));
      },
      execute: () => {
        executeCalls += 1;
        return Promise.resolve({
          ok: false as const,
          error: { code: "PROOF_INVALID" as const },
        });
      },
    } as unknown as SessionSyncHttpTransport;
    const client = new SessionSyncBearerClient({
      session: session(),
      transport,
      now: () => 10_000,
      monotonicNow: () => monotonicNow,
    });

    expect(await client.execute(readMembership, await authority()))
      .toMatchObject({
        ok: false,
        kind: "operation",
        error: { code: "PROOF_INVALID" },
      });
    expect({ executeCalls, negotiationCalls }).toEqual({
      executeCalls: 2,
      negotiationCalls: 1,
    });
  });

  test("property: uncertainty always moves calibrated proofs to a nonfuture lower bound", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 1_000_000_000 }),
      fc.integer({ min: 0, max: 60_000 }),
      fc.integer({ min: 0, max: 300_000 }),
      (serverObservedAt, uncertaintyMs, elapsed) => {
        const issuedAt = conservativeSessionSyncProofTime({
          localNow: 0,
          monotonicNow: 1_000 + elapsed,
          clock: {
            serverObservedAt,
            monotonicObservedAt: 1_000,
            uncertaintyMs,
          },
        });
        const estimate = serverObservedAt + elapsed;
        expect(issuedAt).toBe(Math.max(
          0,
          Math.floor(estimate - uncertaintyMs),
        ));
        expect(issuedAt).toBeLessThanOrEqual(estimate);
        expect(issuedAt).toBeGreaterThanOrEqual(0);
      },
    ));
  });
});
