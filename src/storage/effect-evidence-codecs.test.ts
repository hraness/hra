import { expect, test } from "bun:test";

import type { EffectiveRuntimeProfileV1 } from "../domain/runtime-profile";
import {
  mutationEffectEvidence49Schema,
  queueEffectEvidence49Schema,
} from "./effect-evidence-codecs";

// Boundary cases for stable shared leaf schemas. Historical acceptance is not
// new-effect admission: in particular, an old timestamp has no inferred unit.
const baseline = { providerUpdatedAt: null, status: "idle", activeTurnId: null } as const;
const rename = {
  kind: "session.rename",
  providerThreadId: "historical-thread",
  baseline,
  requestedName: "Historical name",
} as const;
const runtimeProfile = {
  profileId: "acct_" + "a".repeat(32),
  processGeneration: 0,
  observedAt: 0,
  preset: "high",
  model: "gpt-5.6-sol",
  reasoningEffort: "max",
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request",
  reviewMode: "auto_review",
  permissionProfile: ":workspace",
  computerUse: true,
  pluginCapability: true,
  enabledApps: [],
} satisfies EffectiveRuntimeProfileV1;
const queue = {
  kind: "queue.dispatch",
  queueId: "queue_" + "b".repeat(32),
  sessionId: "sess_" + "c".repeat(32),
  providerThreadId: "historical-thread",
  profileGeneration: 0,
  baseline,
  clientMessageId: "historical-message",
  messageDigest: "d".repeat(64),
  runtimeProfile,
} as const;

test("retained titles trim exterior whitespace without Unicode normalization", () => {
  const requestedName = "e\u0301";
  const parsed = mutationEffectEvidence49Schema.parse({ ...rename, requestedName: ` \t${requestedName}\n` });
  expect(parsed).toEqual({ ...rename, requestedName });
  expect(JSON.stringify(parsed)).toBe(
    '{"kind":"session.rename","providerThreadId":"historical-thread",'
    + '"baseline":{"providerUpdatedAt":null,"status":"idle","activeTurnId":null},'
    + '"requestedName":"e\u0301"}',
  );
});

test("retained title bounds count UTF-8 bytes after trimming", () => {
  for (const requestedName of ["a".repeat(320), "é".repeat(160), "😀".repeat(80)]) {
    expect(mutationEffectEvidence49Schema.parse({ ...rename, requestedName: ` ${requestedName} ` }))
      .toEqual({ ...rename, requestedName });
    expect(mutationEffectEvidence49Schema.safeParse({ ...rename, requestedName: requestedName + "a" }).success)
      .toBe(false);
  }
  expect(mutationEffectEvidence49Schema.safeParse({ ...rename, requestedName: " \t\n" }).success).toBe(false);
});

test("retained provider timestamps stay unconverted and accept historical fractions", () => {
  for (const providerUpdatedAt of [null, 0, 0.25, 1_700_000_000, 1_700_000_000_000, 1e20]) {
    const input = { ...rename, baseline: { ...baseline, providerUpdatedAt } };
    expect(mutationEffectEvidence49Schema.parse(input)).toEqual(input);
    expect(JSON.stringify(mutationEffectEvidence49Schema.parse(input))).toBe(JSON.stringify(input));
  }
  for (const providerUpdatedAt of [-1, Number.NaN, Number.POSITIVE_INFINITY, "1700000000"]) {
    expect(mutationEffectEvidence49Schema.safeParse({ ...rename, baseline: { ...baseline, providerUpdatedAt } }).success)
      .toBe(false);
  }
});

test("retained provider thread IDs keep their original untrimmed code-unit bounds", () => {
  for (const providerThreadId of [" ", " thread ", "a".repeat(200), "😀".repeat(100)]) {
    expect(mutationEffectEvidence49Schema.parse({ ...rename, providerThreadId })).toEqual({ ...rename, providerThreadId });
  }
  for (const providerThreadId of ["", "a".repeat(201), "😀".repeat(101)]) {
    expect(mutationEffectEvidence49Schema.safeParse({ ...rename, providerThreadId }).success).toBe(false);
  }
});

test("retained login IDs reject control characters without adding format-character normalization", () => {
  for (const loginId of [" ", "synthetic\u200dlogin", "x".repeat(512)]) {
    const input = { kind: "account.login-cancel", loginId } as const;
    expect(mutationEffectEvidence49Schema.parse(input)).toEqual(input);
  }
  for (const loginId of ["", "x".repeat(513), "synthetic\nlogin", "synthetic\u0085login"]) {
    expect(mutationEffectEvidence49Schema.safeParse({ kind: "account.login-cancel", loginId }).success).toBe(false);
  }
});

test("retained queue and runtime identities keep exact prefixes and lowercase hexadecimal", () => {
  expect(queueEffectEvidence49Schema.parse(queue)).toEqual(queue);
  for (const queueId of ["queue_" + "B".repeat(32), "sess_" + "b".repeat(32), "queue_" + "b".repeat(31)]) {
    expect(queueEffectEvidence49Schema.safeParse({ ...queue, queueId }).success).toBe(false);
  }
  for (const sessionId of ["sess_" + "C".repeat(32), "queue_" + "c".repeat(32)]) {
    expect(queueEffectEvidence49Schema.safeParse({ ...queue, sessionId }).success).toBe(false);
  }
  for (const profileId of ["acct_" + "A".repeat(32), "proj_" + "a".repeat(32)]) {
    expect(queueEffectEvidence49Schema.safeParse({ ...queue, runtimeProfile: { ...runtimeProfile, profileId } }).success)
      .toBe(false);
  }
});

test("retained runtime times are integer milliseconds, unlike provider baselines", () => {
  for (const observedAt of [0, 1_700_000_000_000, Number.MAX_SAFE_INTEGER]) {
    const input = { ...queue, runtimeProfile: { ...runtimeProfile, observedAt } };
    expect(queueEffectEvidence49Schema.parse(input)).toEqual(input);
  }
  for (const observedAt of [-1, 0.25, Number.POSITIVE_INFINITY]) {
    expect(queueEffectEvidence49Schema.safeParse({ ...queue, runtimeProfile: { ...runtimeProfile, observedAt } }).success)
      .toBe(false);
  }
});

test("retained runtime documents do not accept new tuple or nested capability fields", () => {
  for (const model of ["gpt-5.6-sol", "gpt-6-astra"]) {
    const input = { ...queue, runtimeProfile: { ...runtimeProfile, model } };
    expect(queueEffectEvidence49Schema.parse(input)).toEqual(input);
  }
  for (const profile of [
    { ...runtimeProfile, model: "future-model" },
    { ...runtimeProfile, reasoningEffort: "high" },
    { ...runtimeProfile, hostCapability: "future" },
    { ...runtimeProfile, enabledApps: [{ id: "app", name: "App", pluginDisplayNames: [], hostCapability: "future" }] },
  ]) {
    expect(queueEffectEvidence49Schema.safeParse({ ...queue, runtimeProfile: profile }).success).toBe(false);
  }
});
