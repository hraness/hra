import type { AuthorityTuple } from "./contracts";

export type LeaseSnapshot = Readonly<{
  bootGeneration: number;
  bootId: string;
  devicePublicId: string;
  fence: number;
  heartbeatFingerprint: string;
  heartbeatSequence: number;
  leaseUntil: number;
}>;

export type LeaseAcquireInput = Readonly<{
  bootGeneration: number;
  bootId: string;
  devicePublicId: string;
  leaseDurationMs: number;
  now: number;
}>;

export type LeaseAcquireDisposition =
  | Readonly<{ kind: "acquired"; lease: LeaseSnapshot }>
  | Readonly<{ kind: "renewed"; lease: LeaseSnapshot }>
  | Readonly<{
      kind: "rejected";
      reason: "boot_generation" | "invalid_duration" | "lease_live" | "wrong_device";
    }>;

export type HeartbeatDisposition =
  | Readonly<{ kind: "advanced"; lease: LeaseSnapshot }>
  | Readonly<{ kind: "replay"; lease: LeaseSnapshot }>
  | Readonly<{
      kind: "rejected";
      reason:
        | "authority"
        | "fingerprint_conflict"
        | "invalid_duration"
        | "sequence_gap"
        | "stale_sequence";
    }>;

function validLeaseDuration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 5_000 && value <= 120_000;
}

export function leaseAuthority(lease: LeaseSnapshot): AuthorityTuple {
  return {
    bootGeneration: lease.bootGeneration,
    bootId: lease.bootId,
    fence: lease.fence,
  };
}

export function acquireLeaseDisposition(
  existing: LeaseSnapshot | null,
  input: LeaseAcquireInput,
): LeaseAcquireDisposition {
  if (!validLeaseDuration(input.leaseDurationMs)) {
    return { kind: "rejected", reason: "invalid_duration" };
  }
  if (existing === null) {
    if (!Number.isSafeInteger(input.bootGeneration) || input.bootGeneration < 1) {
      return { kind: "rejected", reason: "boot_generation" };
    }
    return {
      kind: "acquired",
      lease: {
        bootGeneration: input.bootGeneration,
        bootId: input.bootId,
        devicePublicId: input.devicePublicId,
        fence: 1,
        heartbeatFingerprint: "initial",
        heartbeatSequence: 0,
        leaseUntil: input.now + input.leaseDurationMs,
      },
    };
  }
  if (existing.devicePublicId !== input.devicePublicId) {
    return { kind: "rejected", reason: "wrong_device" };
  }
  if (
    existing.bootId === input.bootId
    && existing.bootGeneration === input.bootGeneration
  ) {
    if (input.now >= existing.leaseUntil) return {
      kind: "acquired",
      lease: {
        bootGeneration: input.bootGeneration,
        bootId: input.bootId,
        devicePublicId: input.devicePublicId,
        fence: existing.fence + 1,
        heartbeatFingerprint: "initial",
        heartbeatSequence: 0,
        leaseUntil: input.now + input.leaseDurationMs,
      },
    };
    return {
      kind: "renewed",
      // Treat an acquire retry as a replay while the fence is live. After
      // expiry, even the same daemon identity receives a new fence so any
      // delayed work from the previous lease remains fenced out.
      lease: existing,
    };
  }
  if (input.now < existing.leaseUntil) {
    return { kind: "rejected", reason: "lease_live" };
  }
  if (input.bootGeneration <= existing.bootGeneration) {
    return { kind: "rejected", reason: "boot_generation" };
  }
  return {
    kind: "acquired",
    lease: {
      bootGeneration: input.bootGeneration,
      bootId: input.bootId,
      devicePublicId: input.devicePublicId,
      fence: existing.fence + 1,
      heartbeatFingerprint: "initial",
      heartbeatSequence: 0,
      leaseUntil: input.now + input.leaseDurationMs,
    },
  };
}

export function heartbeatDisposition(
  existing: LeaseSnapshot,
  input: Readonly<{
    authority: AuthorityTuple;
    fingerprint: string;
    leaseDurationMs: number;
    now: number;
    sequence: number;
  }>,
): HeartbeatDisposition {
  if (
    existing.bootGeneration !== input.authority.bootGeneration
    || existing.bootId !== input.authority.bootId
    || existing.fence !== input.authority.fence
    || input.now >= existing.leaseUntil
  ) return { kind: "rejected", reason: "authority" };
  if (!validLeaseDuration(input.leaseDurationMs)) {
    return { kind: "rejected", reason: "invalid_duration" };
  }

  if (input.sequence === existing.heartbeatSequence) {
    if (input.fingerprint !== existing.heartbeatFingerprint) {
      return { kind: "rejected", reason: "fingerprint_conflict" };
    }
    return { kind: "replay", lease: existing };
  }
  if (input.sequence < existing.heartbeatSequence) {
    return { kind: "rejected", reason: "stale_sequence" };
  }
  if (input.sequence !== existing.heartbeatSequence + 1) {
    return { kind: "rejected", reason: "sequence_gap" };
  }
  return {
    kind: "advanced",
    lease: {
      ...existing,
      heartbeatFingerprint: input.fingerprint,
      heartbeatSequence: input.sequence,
      leaseUntil: input.now + input.leaseDurationMs,
    },
  };
}
