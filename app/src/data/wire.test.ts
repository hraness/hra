import { describe, expect, test } from "bun:test";

import {
  WireShapeError,
  parseAccountContext,
  parseBindChallenge,
  parseCommandRecord,
  parseDeviceSummary,
  parseKeyEnvelopes,
  parsePresenceResponse,
  parseSessionChunks,
  parseSessionHead,
  parseSessionHeads,
} from "./wire";

const head = {
  compactHasRecoveryGap: false,
  compactHeadSequence: 12,
  compactStreamEpoch: 0,
  createdAt: 1_700_000_000_000,
  detailHeadSequence: 40,
  detailStreamEpoch: 2,
  executionDevicePublicId: "device_0123456789abcdef",
  metadataRevision: 3,
  projectionRevision: 9,
  publicId: "session_0123456789abcdef",
  state: "active",
  updatedAt: 1_700_000_100_000,
};

describe("parseSessionHead", () => {
  test("accepts a head and carries the detail stream epoch", () => {
    const parsed = parseSessionHead(head);
    expect(parsed?.detailStreamEpoch).toBe(2);
    expect(parsed?.executionDevicePublicId).toBe("device_0123456789abcdef");
    expect(parsed?.metadata).toBeNull();
  });

  test("tolerates a listing head with no detail stream epoch", () => {
    const withoutEpoch = Object.fromEntries(
      Object.entries(head).filter(([name]) => name !== "detailStreamEpoch"),
    );
    expect(parseSessionHead(withoutEpoch)?.detailStreamEpoch).toBeNull();
  });

  test("refuses an unknown session state", () => {
    expect(parseSessionHead({ ...head, state: "paused" })).toBeNull();
  });

  test("refuses an execution device identifier that is not opaque", () => {
    expect(parseSessionHead({ ...head, executionDevicePublicId: "x" })).toBeNull();
  });

  test("refuses a metadata envelope that is not an encrypted envelope", () => {
    expect(parseSessionHead({ ...head, metadata: { ciphertext: "x" } })).toBeNull();
  });

  test("rejects a page that is not an array", () => {
    expect(() => parseSessionHeads(null)).toThrow(WireShapeError);
  });
});

describe("parseAccountContext", () => {
  test("accepts an account with no bound device", () => {
    const parsed = parseAccountContext({
      authEpoch: 1,
      device: null,
      hasActiveDevices: true,
      userPublicId: "user_0123456789abcdef",
    });
    expect(parsed?.device).toBeNull();
    expect(parsed?.hasActiveDevices).toBe(true);
  });

  test("accepts a bound device and its credential generation", () => {
    const parsed = parseAccountContext({
      authEpoch: 2,
      device: {
        credentialGeneration: 3,
        keyVersion: 1,
        publicId: "device_0123456789abcdef",
        revision: 4,
        status: "active",
      },
      hasActiveDevices: true,
      userPublicId: "user_0123456789abcdef",
    });
    expect(parsed?.device?.credentialGeneration).toBe(3);
    expect(parsed?.device?.status).toBe("active");
  });

  test("refuses an unknown device status", () => {
    expect(parseAccountContext({
      authEpoch: 1,
      device: {
        credentialGeneration: 1,
        keyVersion: 1,
        publicId: "device_0123456789abcdef",
        revision: 1,
        status: "approved",
      },
      hasActiveDevices: true,
      userPublicId: "user_0123456789abcdef",
    })).toBeNull();
  });
});

describe("parseDeviceSummary", () => {
  test("accepts a registration summary", () => {
    expect(parseDeviceSummary({
      publicId: "device_0123456789abcdef",
      revision: 1,
      status: "pending",
    })).toEqual({ publicId: "device_0123456789abcdef", revision: 1, status: "pending" });
  });

  test("refuses a revision of zero", () => {
    expect(parseDeviceSummary({
      publicId: "device_0123456789abcdef",
      revision: 0,
      status: "pending",
    })).toBeNull();
  });
});

describe("parseKeyEnvelopes", () => {
  const envelope = {
    algorithm: "P256-HKDF-SHA256+A256GCM",
    ciphertext: "A".repeat(64),
    ephemeralPublicKey: JSON.stringify({
      crv: "P-256",
      kty: "EC",
      x: "A".repeat(43),
      y: "B".repeat(43),
    }),
    keyVersion: 1,
    nonce: "B".repeat(16),
  };

  test("accepts the account key envelope list", () => {
    const parsed = parseKeyEnvelopes([{ createdAt: 5, envelope }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.envelope.keyVersion).toBe(1);
  });

  test("refuses more envelopes than the authority ever returns", () => {
    expect(() => parseKeyEnvelopes(Array.from({ length: 17 }, () => ({
      createdAt: 1,
      envelope,
    })))).toThrow(WireShapeError);
  });

  test("refuses a malformed envelope", () => {
    expect(() => parseKeyEnvelopes([{ createdAt: 1, envelope: { algorithm: "A256GCM" } }]))
      .toThrow(WireShapeError);
  });
});

describe("parseCommandRecord", () => {
  const command = {
    createdAt: 1,
    deadline: 2,
    kind: "send_or_steer",
    payload: {
      algorithm: "A256GCM",
      ciphertext: "A".repeat(32),
      keyVersion: 1,
      nonce: "B".repeat(16),
    },
    publicId: "01931f2a-7c00-7000-8000-000000000001",
    sessionPublicId: "session_0123456789abcdef",
    state: "pending",
    updatedAt: 3,
  };

  test("accepts a command and its optional result code", () => {
    expect(parseCommandRecord(command)?.state).toBe("pending");
    expect(parseCommandRecord({ ...command, resultCode: "APPLIED" })?.resultCode).toBe("APPLIED");
    expect(parseCommandRecord(command)?.resultCode).toBeNull();
  });

  test("refuses a public id that is not a UUIDv7", () => {
    expect(parseCommandRecord({ ...command, publicId: "not-a-uuid" })).toBeNull();
  });

  test("refuses an unknown command kind or state", () => {
    expect(parseCommandRecord({ ...command, kind: "reboot" })).toBeNull();
    expect(parseCommandRecord({ ...command, state: "running" })).toBeNull();
  });
});

describe("parseBindChallenge and parsePresenceResponse", () => {
  test("accepts a bind challenge echo", () => {
    expect(parseBindChallenge({
      challengeId: "bind_0123456789abcdef",
      devicePublicId: "device_0123456789abcdef",
      nonce: "C".repeat(32),
    })?.challengeId).toBe("bind_0123456789abcdef");
  });

  test("accepts a presence response with no connection", () => {
    expect(parsePresenceResponse({
      connectionId: null,
      lastSeenAt: null,
      online: false,
      presenceUntil: null,
      sequence: null,
      serverNow: 10,
    })?.online).toBe(false);
  });
});

describe("parseSessionChunks", () => {
  test("refuses a page larger than the authority's own bound", () => {
    expect(() => parseSessionChunks(Array.from({ length: 101 }, () => ({}))))
      .toThrow(WireShapeError);
  });

  test("refuses a chunk whose sequences run backwards", () => {
    expect(() => parseSessionChunks([{
      authority: { bootGeneration: 1, bootId: "boot_0123456789abcdef", fence: 1 },
      createdAt: 1,
      digest: "a".repeat(64),
      envelope: {
        algorithm: "A256GCM",
        ciphertext: "A".repeat(32),
        keyVersion: 1,
        nonce: "B".repeat(16),
      },
      firstSequence: 9,
      lastSequence: 2,
      sourceDevicePublicId: "device_0123456789abcdef",
      stream: "compact",
      streamEpoch: 0,
    }])).toThrow(WireShapeError);
  });
});
