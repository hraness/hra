import { describe, expect, test } from "bun:test";

import {
  commandAuthorityTransitionDisposition,
  commandTransitionDisposition,
  idempotencyDisposition,
} from "./commands";
import type { AuthorityTuple, CommandState } from "./contracts";
import {
  acquireLeaseDisposition,
  heartbeatDisposition,
  leaseAuthority,
  type LeaseSnapshot,
} from "./leases";

const commandStates: readonly CommandState[] = [
  "pending",
  "prepared",
  "effect_started",
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
];

const terminalStates = new Set<CommandState>([
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
]);

const invalidLeaseDurations: readonly number[] = [
  Number.NEGATIVE_INFINITY,
  Number.MIN_SAFE_INTEGER,
  -1,
  0,
  4_999,
  5_000.5,
  120_000.5,
  120_001,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.POSITIVE_INFINITY,
  Number.NaN,
];

type SimulationCampaign = "authority" | "leases" | "reducer";

function selectedCampaign(): SimulationCampaign | null {
  const requested = process.env.HRA_SIMULATION_CAMPAIGN;
  if (requested === undefined) return null;
  if (requested === "authority" || requested === "leases" || requested === "reducer") {
    return requested;
  }
  throw new Error(
    "HRA_SIMULATION_CAMPAIGN must be one of: authority, leases, reducer.",
  );
}

const campaign = selectedCampaign();

function campaignEnabled(candidate: SimulationCampaign): boolean {
  return campaign === null || campaign === candidate;
}

function describeCampaign(
  candidate: SimulationCampaign,
  name: string,
  body: () => void,
): void {
  (campaignEnabled(candidate) ? describe : describe.skip)(name, body);
}

function replayCommand(candidate: SimulationCampaign, seed: number): string {
  return `HRA_SIMULATION_CAMPAIGN=${candidate} HRA_SIMULATION_SEED=${seed} bun run test:simulation`;
}

function selectedSeeds(): readonly number[] {
  const requested = process.env.HRA_SIMULATION_SEED;
  if (requested === undefined) return [1, 11, 97, 0x5eed_0a];
  if (!/^\d{1,10}$/u.test(requested)) {
    throw new Error("HRA_SIMULATION_SEED must be one unsigned decimal 32-bit seed.");
  }
  const seed = Number(requested);
  if (!Number.isSafeInteger(seed) || seed > 0xffff_ffff) {
    throw new Error("HRA_SIMULATION_SEED must be one unsigned decimal 32-bit seed.");
  }
  return [seed];
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) | 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 0x1_0000_0000;
  };
}

function choose<T>(values: readonly T[], next: () => number): T {
  return values[Math.floor(next() * values.length)]!;
}

function assertLeaseSafety(lease: LeaseSnapshot): void {
  expect(Number.isSafeInteger(lease.bootGeneration)).toBeTrue();
  expect(Number.isSafeInteger(lease.fence)).toBeTrue();
  expect(Number.isSafeInteger(lease.heartbeatSequence)).toBeTrue();
  expect(lease.bootGeneration).toBeGreaterThan(0);
  expect(lease.fence).toBeGreaterThan(0);
  expect(lease.heartbeatSequence).toBeGreaterThanOrEqual(0);
  expect(lease.leaseUntil).toBeGreaterThanOrEqual(0);
}

describeCampaign(
  "leases",
  "deterministic execution lease fault campaign",
  () => {
  for (const seed of selectedSeeds()) {
    test(`seed ${seed} preserves fencing and verifies a supplied healthy authority path`, () => {
      const next = random(seed);
      const trace: string[] = [];
      const coverage = [0, 0, 0, 0, 0, 0];
      let now = 0;
      let highestFence = 0;

      try {
        const initial = acquireLeaseDisposition(null, {
          bootGeneration: 1,
          bootId: "boot_primary_0001",
          devicePublicId: "device_primary_0001",
          leaseDurationMs: 10_000,
          now,
        });
        expect(initial.kind).toBe("acquired");
        if (initial.kind !== "acquired") throw new Error("initial lease unavailable");
        let lease = initial.lease;
        highestFence = lease.fence;

        // Every replay covers each invalid numeric family under matching live
        // authority, independent of the random schedule.
        for (const leaseDurationMs of invalidLeaseDurations) {
          const acquire = acquireLeaseDisposition(lease, {
            bootGeneration: lease.bootGeneration,
            bootId: lease.bootId,
            devicePublicId: lease.devicePublicId,
            leaseDurationMs,
            now,
          });
          trace.push(`invalid-acquire:${String(leaseDurationMs)}:${acquire.kind}`);
          expect(acquire).toEqual({ kind: "rejected", reason: "invalid_duration" });

          const heartbeat = heartbeatDisposition(lease, {
            authority: leaseAuthority(lease),
            fingerprint: `invalid-duration-${String(leaseDurationMs)}`,
            leaseDurationMs,
            now,
            sequence: lease.heartbeatSequence + 1,
          });
          trace.push(`invalid-heartbeat:${String(leaseDurationMs)}:${heartbeat.kind}`);
          expect(heartbeat).toEqual({ kind: "rejected", reason: "invalid_duration" });
        }

        for (const authority of [
          { ...leaseAuthority(lease), bootGeneration: lease.bootGeneration + 1 },
          { ...leaseAuthority(lease), bootId: "boot_stale_0001" },
          { ...leaseAuthority(lease), fence: lease.fence + 1 },
        ]) {
          const heartbeat = heartbeatDisposition(lease, {
            authority,
            fingerprint: "mixed-authority-duration",
            leaseDurationMs: 0,
            now,
            sequence: lease.heartbeatSequence + 1,
          });
          trace.push(`mixed-heartbeat:${heartbeat.kind}`);
          expect(heartbeat).toEqual({ kind: "rejected", reason: "authority" });
        }
        expect(heartbeatDisposition(lease, {
          authority: leaseAuthority(lease),
          fingerprint: "mixed-expired-duration",
          leaseDurationMs: 0,
          now: lease.leaseUntil,
          sequence: lease.heartbeatSequence + 1,
        })).toEqual({ kind: "rejected", reason: "authority" });

        for (let step = 0; step < 160; step += 1) {
          const action = step < coverage.length ? step : Math.floor(next() * coverage.length);
          coverage[action] = coverage[action]! + 1;
          const before = lease;
          if (action === 0) {
            const elapsed = Math.floor(next() * 20_001);
            now += elapsed;
            trace.push(`${step}:advance:${elapsed}`);
          } else if (action === 1) {
            const sameBoot = next() < 0.5;
            const result = acquireLeaseDisposition(lease, {
              bootGeneration: sameBoot ? lease.bootGeneration : lease.bootGeneration + 1,
              bootId: sameBoot ? lease.bootId : `boot_next_${step}`,
              devicePublicId: lease.devicePublicId,
              leaseDurationMs: 5_000 + Math.floor(next() * 115_001),
              now,
            });
            trace.push(`${step}:acquire:${sameBoot ? "same" : "next"}:${result.kind}`);
            if (result.kind === "acquired" || result.kind === "renewed") lease = result.lease;
            if (result.kind === "acquired") {
              expect(result.lease.fence).toBeGreaterThan(before.fence);
            }
            if (!sameBoot && now < before.leaseUntil) expect(result.kind).toBe("rejected");
          } else if (action === 2) {
            const result = acquireLeaseDisposition(lease, {
              bootGeneration: lease.bootGeneration + 1,
              bootId: `boot_foreign_${step}`,
              devicePublicId: "device_foreign_0001",
              leaseDurationMs: 10_000,
              now,
            });
            trace.push(`${step}:foreign-acquire:${result.kind}`);
            expect(result.kind).toBe("rejected");
            expect(lease).toBe(before);
          } else if (action === 3) {
            const variant = Math.floor(next() * 5);
            const authority = variant === 4
              ? { ...leaseAuthority(lease), fence: lease.fence + 1 }
              : leaseAuthority(lease);
            const sequence = variant === 0
              ? lease.heartbeatSequence + 1
              : variant === 1
                ? lease.heartbeatSequence
                : variant === 2
                  ? Math.max(0, lease.heartbeatSequence - 1)
                  : lease.heartbeatSequence + 2;
            const fingerprint = variant === 1
              ? lease.heartbeatFingerprint
              : `heartbeat_${step}_${variant}`;
            const result = heartbeatDisposition(lease, {
              authority,
              fingerprint,
              leaseDurationMs: 10_000,
              now,
              sequence,
            });
            trace.push(`${step}:heartbeat:${variant}:${result.kind}`);
            if (result.kind === "advanced" || result.kind === "replay") lease = result.lease;
            else expect(lease).toBe(before);
          } else if (action === 4) {
            const leaseDurationMs = choose(invalidLeaseDurations, next);
            const heartbeatFault = next() < 0.5;
            const result = heartbeatFault
              ? heartbeatDisposition(lease, {
                authority: leaseAuthority(lease),
                fingerprint: `invalid_${step}`,
                leaseDurationMs,
                now,
                sequence: lease.heartbeatSequence + 1,
              })
              : acquireLeaseDisposition(lease, {
                bootGeneration: lease.bootGeneration,
                bootId: lease.bootId,
                devicePublicId: lease.devicePublicId,
                leaseDurationMs,
                now,
              });
            trace.push(
              `${step}:invalid-${heartbeatFault ? "heartbeat" : "acquire"}:${String(leaseDurationMs)}:${result.kind}`,
            );
            const expectedReason = heartbeatFault && now >= lease.leaseUntil
              ? "authority"
              : "invalid_duration";
            expect(result).toEqual({ kind: "rejected", reason: expectedReason });
            expect(lease).toBe(before);
          } else {
            const digest = next() < 0.5 ? "request-a" : "request-b";
            const disposition = idempotencyDisposition({ requestDigest: "request-a" }, digest);
            trace.push(`${step}:idempotency:${digest}:${disposition}`);
            expect(disposition).toBe(digest === "request-a" ? "replay" : "conflict");
          }

          assertLeaseSafety(lease);
          expect(lease.fence).toBeGreaterThanOrEqual(highestFence);
          highestFence = lease.fence;
        }
        expect(coverage.every((count) => count > 0)).toBeTrue();

        // Conditional reachability witness only: given an expired prior lease,
        // an explicitly supplied newer generation, and successful calls in
        // this exact order, the pure policies admit the healthy path. This is
        // not a scheduler-fairness or eventual-progress claim.
        now = Math.max(now, lease.leaseUntil);
        const takeover = acquireLeaseDisposition(lease, {
          bootGeneration: lease.bootGeneration + 1,
          bootId: "boot_recovery_final",
          devicePublicId: lease.devicePublicId,
          leaseDurationMs: 10_000,
          now,
        });
        trace.push(`healthy:acquire:${takeover.kind}`);
        expect(takeover.kind).toBe("acquired");
        if (takeover.kind !== "acquired") throw new Error("healthy-path lease unavailable");
        expect(takeover.lease.fence).toBeGreaterThan(highestFence);

        const heartbeat = heartbeatDisposition(takeover.lease, {
          authority: leaseAuthority(takeover.lease),
          fingerprint: "healthy-path-heartbeat",
          leaseDurationMs: 10_000,
          now,
          sequence: 1,
        });
        trace.push(`healthy:heartbeat:${heartbeat.kind}`);
        expect(heartbeat.kind).toBe("advanced");
        if (heartbeat.kind !== "advanced") throw new Error("healthy-path heartbeat unavailable");

        let command: CommandState = "pending";
        let boundAuthority: AuthorityTuple | null = null;
        const liveAuthority = leaseAuthority(heartbeat.lease);
        for (const requested of ["prepared", "effect_started", "applied"] as const) {
          const disposition = commandAuthorityTransitionDisposition({
            boundAuthority,
            leaseUntil: heartbeat.lease.leaseUntil,
            liveAuthority,
            next: requested,
            now,
            requestedAuthority: liveAuthority,
            state: command,
          });
          trace.push(`healthy:command:${command}->${requested}:${disposition.kind}`);
          expect(disposition.kind).toBe("applied");
          if (disposition.kind !== "applied") {
            throw new Error(`healthy-path ${requested} unavailable`);
          }
          command = disposition.state;
          boundAuthority = disposition.boundAuthority;
        }
        expect(command).toBe("applied");
        const afterExpiry = commandAuthorityTransitionDisposition({
          boundAuthority,
          leaseUntil: heartbeat.lease.leaseUntil,
          liveAuthority,
          next: "applied",
          now: heartbeat.lease.leaseUntil,
          requestedAuthority: liveAuthority,
          state: "effect_started",
        });
        expect(afterExpiry).toEqual({
          boundAuthority,
          kind: "rejected",
          reason: "lease_not_live",
          state: "effect_started",
        });
      } catch (error) {
        throw new Error(
          `Lease simulation failed. Replay exactly with \`${replayCommand("leases", seed)}\`. Trace: ${trace.join(",")}`,
          { cause: error },
        );
      }
    });
  }
  },
);

describeCampaign(
  "authority",
  "deterministic command authority fault campaign",
  () => {
  for (const seed of selectedSeeds()) {
    test(`seed ${seed} couples effects to the live and bound authority`, () => {
      const next = random(seed ^ 0xa071_0f17);
      const trace: string[] = [];
      const coverage = [0, 0, 0, 0, 0, 0, 0];
      const liveAuthority: AuthorityTuple = {
        bootGeneration: 4,
        bootId: "boot_live_0001",
        fence: 9,
      };
      const staleAuthorityFamilies: readonly AuthorityTuple[] = [
        { ...liveAuthority, bootGeneration: liveAuthority.bootGeneration - 1 },
        { ...liveAuthority, bootId: "boot_stale_0001" },
        { ...liveAuthority, fence: liveAuthority.fence - 1 },
      ];

      try {
        for (let step = 0; step < 160; step += 1) {
          const action = step < coverage.length ? step : Math.floor(next() * coverage.length);
          coverage[action] = coverage[action]! + 1;
          const staleAuthority = staleAuthorityFamilies[step % staleAuthorityFamilies.length]!;
          const base = {
            boundAuthority: liveAuthority,
            leaseUntil: 20_000,
            liveAuthority,
            next: "effect_started" as const,
            now: 10_000,
            requestedAuthority: liveAuthority,
            state: "prepared" as CommandState,
          };
          const input = action === 0
            ? { ...base, boundAuthority: null, next: "prepared" as const, state: "pending" as const }
            : action === 1
              ? { ...base, boundAuthority: staleAuthority, next: "prepared" as const }
              : action === 2
                ? base
                : action === 3
                  ? { ...base, next: "applied" as const, state: "effect_started" as const }
                  : action === 4
                    ? { ...base, now: 20_000 }
                    : action === 5
                      ? { ...base, requestedAuthority: staleAuthority }
                      : { ...base, boundAuthority: staleAuthority };
          const before = {
            boundAuthority: input.boundAuthority,
            state: input.state,
          };
          const result = commandAuthorityTransitionDisposition(input);
          trace.push(`${step}:${action}:${input.state}->${input.next}:${result.kind}`);

          if (action <= 3) {
            expect(["applied", "rebound"]).toContain(result.kind);
          } else {
            expect(result.kind).toBe("rejected");
            expect({
              boundAuthority: result.boundAuthority,
              state: result.state,
            }).toEqual(before);
          }
        }
        expect(coverage.every((count) => count > 0)).toBeTrue();

        const attemptedEffectFromPending = commandAuthorityTransitionDisposition({
          boundAuthority: liveAuthority,
          leaseUntil: 20_000,
          liveAuthority,
          next: "effect_started",
          now: 10_000,
          requestedAuthority: liveAuthority,
          state: "pending",
        });
        expect(attemptedEffectFromPending).toEqual({
          boundAuthority: liveAuthority,
          kind: "rejected",
          reason: "invalid_transition",
          state: "pending",
        });
        const rebindAfterEffect = commandAuthorityTransitionDisposition({
          boundAuthority: liveAuthority,
          leaseUntil: 20_000,
          liveAuthority,
          next: "prepared",
          now: 10_000,
          requestedAuthority: liveAuthority,
          state: "effect_started",
        });
        expect(rebindAfterEffect).toEqual({
          boundAuthority: liveAuthority,
          kind: "rejected",
          reason: "invalid_transition",
          state: "effect_started",
        });
      } catch (error) {
        throw new Error(
          `Command authority simulation failed. Replay exactly with \`${replayCommand("authority", seed)}\`. Trace: ${trace.join(",")}`,
          { cause: error },
        );
      }
    });
  }
  },
);

describeCampaign(
  "reducer",
  "deterministic remote-command reducer campaign",
  () => {
  for (const seed of selectedSeeds()) {
    test(`seed ${seed} keeps rejected and terminal transitions inert`, () => {
      const next = random(seed ^ 0xc011_ab1e);
      const trace: string[] = [];
      const coverage = commandStates.map(() => 0);
      let command: CommandState = "pending";

      try {
        for (let step = 0; step < 160; step += 1) {
          if (terminalStates.has(command) && step % 8 === 0) {
            trace.push(`${step}:new-command`);
            command = "pending";
          }
          const requestedIndex = step < commandStates.length
            ? step
            : Math.floor(next() * commandStates.length);
          const requested = commandStates[requestedIndex]!;
          coverage[requestedIndex] = coverage[requestedIndex]! + 1;
          const before = command;
          const result = commandTransitionDisposition(command, requested);
          trace.push(`${step}:${command}->${requested}:${result.kind}`);
          if (result.kind === "applied" || result.kind === "replay") command = result.next;
          else expect(command).toBe(before);
          if (terminalStates.has(before)) expect(command).toBe(before);
        }
        expect(coverage.every((count) => count > 0)).toBeTrue();
      } catch (error) {
        throw new Error(
          `Command reducer simulation failed. Replay exactly with \`${replayCommand("reducer", seed)}\`. Trace: ${trace.join(",")}`,
          { cause: error },
        );
      }
    });
  }
  },
);
