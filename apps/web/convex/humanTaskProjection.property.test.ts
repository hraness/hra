import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";
import type { RunInteractionRequest } from "@hraness/agent-tasks-protocol";

import {
  boundedHumanInputPreview,
  deriveActionableHumanInputSummary,
  deriveHumanInputProjection,
  deriveHumanInputSummary,
  humanInputProjectionFromTask,
  storedHumanInputProjection,
} from "./humanTaskProjection";
import { MAX_HUMAN_INPUT_PREVIEW_BYTES } from "./model";

function request(id: number, createdAt: number, prompt: string): RunInteractionRequest {
  return {
    id: `interaction_${id}`,
    createdAt,
    expiresAt: createdAt + 1,
    kind: "user_input",
    questions: [{
      id: `question_${id}`,
      header: "Input",
      prompt,
      allowOther: true,
      options: [],
    }],
    reply: {
      version: 1,
      algorithm: "P256-HKDF-SHA256-A256GCM",
      keyId: `hitlkey_${"a".repeat(32)}`,
      publicKey: "B".repeat(87),
      runnerId: "runner_property001",
      bootId: "boot_property0001",
      bootGeneration: 1,
      claimId: "claim_property001",
      claimFence: 1,
      requestDigest: `sha256_${"b".repeat(64)}`,
    },
  };
}

test("preview normalization is one-line, UTF-8 bounded, and code-point safe", () => {
  const fragment = fc.constantFrom("a", " ", "\n", "\t", "é", "🙂", "中");
  assertProperty(fc.property(fc.array(fragment, { maxLength: 1_000 }), (fragments) => {
    const preview = boundedHumanInputPreview(fragments.join(""));
    expect(preview.length).toBeGreaterThan(0);
    expect(preview.includes("\n")).toBeFalse();
    expect(new TextEncoder().encode(preview).byteLength)
      .toBeLessThanOrEqual(MAX_HUMAN_INPUT_PREVIEW_BYTES);
    expect(preview.includes("�")).toBeFalse();
  }));
});

test("summary derivation is permutation-invariant and round-trips storage", () => {
  assertProperty(fc.property(
    fc.array(fc.record({
      id: fc.integer({ min: 0, max: 1_000_000 }),
      createdAt: fc.integer({ min: 0, max: 1_000_000 }),
      prompt: fc.string({ maxLength: 300 }),
    }), { minLength: 1, maxLength: 32 }),
    (values) => {
      const interactions = values.map(({ id, createdAt, prompt }) => ({
        publicId: `interaction_${id}`,
        request: request(id, createdAt, prompt),
      }));
      const forward = deriveHumanInputSummary(interactions);
      const reversed = deriveHumanInputSummary([...interactions].reverse());
      expect(forward).toEqual(reversed);
      expect(forward?.pendingCount).toBe(interactions.length);
      expect(forward?.oldestRequestedAt)
        .toBe(Math.min(...values.map(({ createdAt }) => createdAt)));
      const projection = deriveHumanInputProjection(interactions);
      expect(humanInputProjectionFromTask(storedHumanInputProjection(projection)))
        .toEqual(projection);
    },
  ));
});

test("actionable summaries are exactly the unexpired pending subset", () => {
  assertProperty(fc.property(
    fc.array(fc.record({
      id: fc.integer({ min: 0, max: 1_000_000 }),
      createdAt: fc.integer({ min: 0, max: 1_000_000 }),
      ttl: fc.integer({ min: 1, max: 1_000_000 }),
      prompt: fc.string({ maxLength: 300 }),
    }), { maxLength: 32 }),
    fc.integer({ min: 0, max: 2_000_000 }),
    (values, now) => {
      const interactions = values.map(({ id, createdAt, ttl, prompt }) => ({
        publicId: `interaction_${id}`,
        request: {
          ...request(id, createdAt, prompt),
          expiresAt: createdAt + ttl,
        },
      }));
      const live = interactions.filter(({ request: value }) => value.expiresAt > now);
      const summary = deriveActionableHumanInputSummary(interactions, now);
      expect(summary).toEqual(deriveHumanInputSummary(live));
      if (summary !== null) {
        expect(summary.expiresAt).toBeGreaterThan(now);
        expect(summary.pendingCount).toBe(live.length);
      }
    },
  ));
});

test("expiry-aware phases skip stale marker prefixes and retain live-first recency", () => {
  assertProperty(fc.property(
    fc.array(fc.record({
      latestExpiresAt: fc.option(fc.integer({ min: 0, max: 1_000_000 }), {
        nil: undefined,
      }),
      updatedAt: fc.integer({ min: 0, max: 1_000_000 }),
      id: fc.integer({ min: 0, max: 1_000_000 }),
    }), { maxLength: 500 }),
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.integer({ min: 1, max: 100 }),
    (values, now, pageSize) => {
      const byRecency = [...values].sort((left, right) =>
        right.updatedAt - left.updatedAt || right.id - left.id);
      const live = byRecency.filter(({ latestExpiresAt }) =>
        latestExpiresAt !== undefined && latestExpiresAt > now);
      const ordinary = byRecency.filter(({ latestExpiresAt }) =>
        latestExpiresAt === undefined || latestExpiresAt <= now);
      const ordered = [...live, ...ordinary];
      const pages = Array.from(
        { length: Math.ceil(ordered.length / pageSize) },
        (_, index) => ordered.slice(index * pageSize, (index + 1) * pageSize),
      );
      expect(pages.every((page) => page.length > 0)).toBeTrue();
      expect(pages.flat()).toEqual(ordered);
      expect(ordered.slice(0, live.length)).toEqual(live);
      expect(ordered.slice(live.length)).toEqual(ordinary);
    },
  ));
});
