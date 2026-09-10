import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  effectiveClaudeRuntimeProfileSchema,
  isCodexRuntimeProfile,
  isDevinRuntimeProfile,
  projectPublicReviewedRuntimeProfile,
  publicEffectiveClaudeRuntimeProfileSchema,
  publicReviewedRuntimeProfileSchema,
  reviewedRuntimeProfileProvider,
  reviewedRuntimeProfileSchema,
} from "./runtime-profile";

// Synthetic preimages captured with the pure archived schemas and public
// projector at 0ae317793d5ff694b4d333effe25f85f7e7f1491, Bun 1.3.14, Zod 4.4.3.
// SHA-256 of archived src/domain sources:
// runtime-profile.ts: 10eb575dbde914ce4c5a408a3836c5264122c0ea3aa91f8f615b2c8977097076
// presets.ts: 60c83135e15858462f87f4b09f96eb91675492357729202b63446e8b86145f56
// values.ts: e0bbef6d7f8120027eee9490ff03abaf63fbe67606733b240da42bf5fcf2a347
// Literal fragments retain the archived schema's key order, including nested
// fallback keys. Neither expected preimages nor hashes use the current parser.
// The armed digest is synthetic schema history, not provider acceptance or
// permission to execute fallback. No profile belongs to a real account.
const commonJson = '{"profileId":"acct_00000000000000000000000000000000",'
  + '"processGeneration":3,"observedAt":1700000000000,"preset":"fable-max",'
  + '"model":"claude-fable-5-1","reasoningEffort":"max","claudeVersion":"2.1.260",'
  + '"permissionMode":"default",';
const formatsJson = '"outputFormat":"stream-json","inputFormat":"stream-json"';
const fallbackJson = {
  absent: "}",
  unavailable: ',"nativeFallback":{"model":"claude-opus-5",'
    + '"reason":"live_acceptance_required","status":"unavailable"}}',
  armed: ',"nativeFallback":{"evidenceDigest":'
    + '"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",'
    + '"model":"claude-opus-5","status":"armed"}}',
} as const;

const publicFixtures = {
  absent: {
    json: commonJson + formatsJson + fallbackJson.absent,
    sha256: "04883235e7fec48bddc4ef2d5d5cdd8eae1935f3f8d6afe2c04b8aec376c5d51",
  },
  unavailable: {
    json: commonJson + formatsJson + fallbackJson.unavailable,
    sha256: "aabe81c305c173774e96b2000276e63646348836a9c54366b40e9c397688e1da",
  },
  armed: {
    json: commonJson + formatsJson + fallbackJson.armed,
    sha256: "99cc22810e85de9e06ef42aa939f6117d8a0f35a4329ccaa8e8d2b2e0acf1997",
  },
} as const;

const privateFixtures = [
  {
    home: "isolated",
    fallback: "absent",
    json: commonJson + '"configHome":"isolated",' + formatsJson + fallbackJson.absent,
    sha256: "dc183c61409e38d4b013fa1ac81f52014a0b47d850313f09d9b0ff7c55cdea30",
  },
  {
    home: "isolated",
    fallback: "unavailable",
    json: commonJson + '"configHome":"isolated",' + formatsJson + fallbackJson.unavailable,
    sha256: "0eef81b5091400fd33b7d0f39066db8a037585fb2bd178ef02cf2d89bf1c1edc",
  },
  {
    home: "isolated",
    fallback: "armed",
    json: commonJson + '"configHome":"isolated",' + formatsJson + fallbackJson.armed,
    sha256: "3eea69e5d0672f00a0e02dce4bab744d7da34ad2ec7e9d671ef4e0fa0471242e",
  },
  {
    home: "personal",
    fallback: "absent",
    json: commonJson + '"configHome":"personal",' + formatsJson + fallbackJson.absent,
    sha256: "6abccfcb454e4aa8e125245e243391568bd9e1c6190f32b0f12019c1cfdb1ee5",
  },
  {
    home: "personal",
    fallback: "unavailable",
    json: commonJson + '"configHome":"personal",' + formatsJson + fallbackJson.unavailable,
    sha256: "0e71026daf4837850adf30ec980b6f23f611f80faab801acb0f1265f9eb3673e",
  },
  {
    home: "personal",
    fallback: "armed",
    json: commonJson + '"configHome":"personal",' + formatsJson + fallbackJson.armed,
    sha256: "035e22079abd3ef501644bea4583cbe4d73054956362ac60815a8a65cd21cbbb",
  },
  {
    home: "legacy isolated",
    fallback: "absent",
    json: commonJson + '"isolatedConfigDir":true,' + formatsJson + fallbackJson.absent,
    sha256: "ac4a03eca87c13bb2a5d216823481353ace3ab3870316c44006723aad9a2a42b",
  },
  {
    home: "legacy isolated",
    fallback: "unavailable",
    json: commonJson + '"isolatedConfigDir":true,' + formatsJson + fallbackJson.unavailable,
    sha256: "cb9f7cd2dfe25c7e927fafc90568f24cbcde6601576d18bb278c60113a58061c",
  },
  {
    home: "legacy isolated",
    fallback: "armed",
    json: commonJson + '"isolatedConfigDir":true,' + formatsJson + fallbackJson.armed,
    sha256: "bdd2a27d40c917f940d8a10885a370a31f7922c0248e5041918d2f53731c40b4",
  },
] as const;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("combined49 Claude runtime-profile JSON history", () => {
  for (const fixture of privateFixtures) {
    test(`preserves ${fixture.home} with ${fixture.fallback} fallback through the reviewed union`, () => {
      const input: unknown = JSON.parse(fixture.json);
      const profile = reviewedRuntimeProfileSchema.parse(input);
      const publicFixture = publicFixtures[fixture.fallback];

      expect(sha256(fixture.json)).toBe(fixture.sha256);
      expect(JSON.stringify(profile)).toBe(fixture.json);
      expect(sha256(JSON.stringify(profile))).toBe(fixture.sha256);
      expect(JSON.stringify(effectiveClaudeRuntimeProfileSchema.parse(input))).toBe(fixture.json);
      expect(reviewedRuntimeProfileProvider(profile)).toBe("claude");
      expect(isCodexRuntimeProfile(profile)).toBe(false);
      expect(isDevinRuntimeProfile(profile)).toBe(false);

      const projected = projectPublicReviewedRuntimeProfile(profile);
      expect(JSON.stringify(projected)).toBe(publicFixture.json);
      expect(sha256(JSON.stringify(projected))).toBe(publicFixture.sha256);
      expect(projected).not.toHaveProperty("configHome");
      expect(projected).not.toHaveProperty("isolatedConfigDir");
      expect(JSON.stringify(input)).toBe(fixture.json);
      expect(JSON.stringify(profile)).toBe(fixture.json);
      expect(publicReviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
    });
  }

  for (const [fallback, fixture] of Object.entries(publicFixtures)) {
    test(`preserves the ${fallback} fallback public preimage without private custody authority`, () => {
      const input: unknown = JSON.parse(fixture.json);
      const parsed = publicReviewedRuntimeProfileSchema.parse(input);

      expect(sha256(fixture.json)).toBe(fixture.sha256);
      expect(JSON.stringify(parsed)).toBe(fixture.json);
      expect(sha256(JSON.stringify(parsed))).toBe(fixture.sha256);
      expect(reviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
      expect(effectiveClaudeRuntimeProfileSchema.safeParse(input).success).toBe(false);
    });
  }
});

const invalidFallbacks: readonly { name: string; value: unknown }[] = [
  { name: "null instead of absent", value: null },
  { name: "an empty object", value: {} },
  { name: "an unknown status", value: { model: "claude-opus-5", status: "ready" } },
  { name: "an armed record without evidence", value: { model: "claude-opus-5", status: "armed" } },
  {
    name: "a short evidence digest",
    value: { evidenceDigest: "a".repeat(63), model: "claude-opus-5", status: "armed" },
  },
  {
    name: "an uppercase evidence digest",
    value: { evidenceDigest: "A".repeat(64), model: "claude-opus-5", status: "armed" },
  },
  {
    name: "another armed model",
    value: { evidenceDigest: "a".repeat(64), model: "claude-fable-5-1", status: "armed" },
  },
  {
    name: "an armed record with an unavailable reason",
    value: {
      evidenceDigest: "a".repeat(64), model: "claude-opus-5",
      reason: "live_acceptance_required", status: "armed",
    },
  },
  {
    name: "an unavailable record with evidence",
    value: {
      evidenceDigest: "a".repeat(64), model: "claude-opus-5",
      reason: "live_acceptance_required", status: "unavailable",
    },
  },
  {
    name: "an unavailable record without its reason",
    value: { model: "claude-opus-5", status: "unavailable" },
  },
  {
    name: "an unrecognized unavailable reason",
    value: { model: "claude-opus-5", reason: "disabled", status: "unavailable" },
  },
  {
    name: "another unavailable model",
    value: { model: "claude-fable-5-1", reason: "live_acceptance_required", status: "unavailable" },
  },
  {
    name: "an extra nested authority field",
    value: {
      model: "claude-opus-5", reason: "live_acceptance_required",
      status: "unavailable", execute: true,
    },
  },
];

describe("historical runtime-profile admission remains closed", () => {
  for (const invalid of invalidFallbacks) {
    test(`refuses ${invalid.name} in every private and public shape`, () => {
      for (const fixture of privateFixtures.filter((value) => value.fallback === "absent")) {
        const parsed = reviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
        const input = { ...parsed, nativeFallback: invalid.value };
        expect(reviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
        expect(effectiveClaudeRuntimeProfileSchema.safeParse(input).success).toBe(false);
      }
      const publicProfile = publicReviewedRuntimeProfileSchema.parse(JSON.parse(publicFixtures.absent.json));
      expect(publicReviewedRuntimeProfileSchema.safeParse({
        ...publicProfile, nativeFallback: invalid.value,
      }).success).toBe(false);
    });
  }

  test("refuses missing, ambiguous, false, and unknown config-home attestations", () => {
    for (const fixture of Object.values(publicFixtures)) {
      const publicProfile = publicReviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      for (const home of [
        {},
        { configHome: "personal", isolatedConfigDir: true },
        { configHome: "isolated", isolatedConfigDir: true },
        { configHome: "unknown" },
        { isolatedConfigDir: false },
      ]) {
        const input = { ...publicProfile, ...home };
        expect(reviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
        expect(effectiveClaudeRuntimeProfileSchema.safeParse(input).success).toBe(false);
      }
    }
  });

  test("refuses extra provider fields and wrapper shapes without stripping them", () => {
    for (const fixture of privateFixtures) {
      const parsed = reviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      for (const input of [
        { ...parsed, approvalPolicy: "on-request" },
        { ...parsed, devinVersion: "3000.6.14" },
        { ...parsed, isolatedHome: true },
        { ...parsed, unexpected: true },
        { provider: "claude", profile: parsed },
      ]) {
        expect(reviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
        expect(effectiveClaudeRuntimeProfileSchema.safeParse(input).success).toBe(false);
      }
    }
    for (const fixture of Object.values(publicFixtures)) {
      const parsed = publicReviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      for (const extra of [
        { configHome: "personal" },
        { isolatedConfigDir: true },
        { isolatedHome: true },
        { unexpected: true },
      ]) {
        expect(publicReviewedRuntimeProfileSchema.safeParse({ ...parsed, ...extra }).success).toBe(false);
      }
    }
  });

  test("does not reinterpret fallback as the primary model or another provider preset", () => {
    for (const fixture of privateFixtures) {
      const parsed = reviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      expect(reviewedRuntimeProfileSchema.safeParse({ ...parsed, model: "claude-opus-5" }).success).toBe(false);
      expect(reviewedRuntimeProfileSchema.safeParse({ ...parsed, preset: "astra" }).success).toBe(false);
      expect(reviewedRuntimeProfileSchema.safeParse({ ...parsed, preset: "ultra" }).success).toBe(false);
    }
  });

  test("refuses unshipped primary models with the same private and public diagnostic", () => {
    const models = ["claude-opus-5", "gpt-6-astra", "claude-fable-5-1-next", "CLAUDE-FABLE-5-1"];
    const expectedIssues = [{
      code: "custom" as const, path: [], message: "The effective model must match the exact Oompa preset.",
    }];
    for (const fixture of privateFixtures) {
      const parsed = reviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      for (const model of models) {
        const input = { ...parsed, model };
        const result = effectiveClaudeRuntimeProfileSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues).toEqual(expectedIssues);
        expect(reviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
      }
    }
    for (const fixture of Object.values(publicFixtures)) {
      const parsed = publicReviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      for (const model of models) {
        const input = { ...parsed, model };
        const result = publicEffectiveClaudeRuntimeProfileSchema.safeParse(input);
        expect(result.success).toBe(false);
        if (!result.success) expect(result.error.issues).toEqual(expectedIssues);
        expect(publicReviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
      }
    }
  });

  test("does not admit another shipped provider effort or an unknown Claude effort", () => {
    const efforts = ["ultra", "provider-default", "low", "MAX", null];
    for (const fixture of privateFixtures) {
      const parsed = reviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      for (const reasoningEffort of efforts) {
        const input = { ...parsed, reasoningEffort };
        expect(effectiveClaudeRuntimeProfileSchema.safeParse(input).success).toBe(false);
        expect(reviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
      }
    }
    for (const fixture of Object.values(publicFixtures)) {
      const parsed = publicReviewedRuntimeProfileSchema.parse(JSON.parse(fixture.json));
      for (const reasoningEffort of efforts) {
        const input = { ...parsed, reasoningEffort };
        expect(publicEffectiveClaudeRuntimeProfileSchema.safeParse(input).success).toBe(false);
        expect(publicReviewedRuntimeProfileSchema.safeParse(input).success).toBe(false);
      }
    }
  });
});
