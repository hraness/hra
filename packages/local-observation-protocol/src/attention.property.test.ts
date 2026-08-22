import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  attentionItemKey,
  attentionProjectionSchema,
  canonicalAttentionProjection,
  compareAttentionItems,
  type AttentionItem,
} from "./attention";

const identifierArbitrary = fc.integer({ min: 0, max: 999_999 });

const paneItemArbitrary = identifierArbitrary.map((value): AttentionItem => ({
  source: "pane",
  paneId: `pane_property${String(value).padStart(12, "0")}`,
  title: `Pane ${String(value)}`,
  repositoryName: `Repository ${String(value % 17)}`,
  reason: { kind: "ambiguous_delivery" },
}));

const accountItemArbitrary = identifierArbitrary.map((value): AttentionItem => ({
  source: "account",
  accountProfileId: `acct_property${String(value).padStart(12, "0")}`,
  label: `Account ${String(value)}`,
  reason: "expired",
}));

const systemItemArbitrary = fc.constantFrom(
  "local_runtime_unavailable" as const,
  "folder_access_missing" as const,
  "codex_account_required" as const,
  "runner_configuration" as const,
  "runner_connection" as const,
  "runner_repository_missing" as const,
  "human_account_recovery" as const,
  "human_account_attention" as const,
  "session_sync_attention" as const,
  "session_sync_recovery" as const,
  "scheduled_chat_recovery" as const,
).map((reason): AttentionItem => ({ source: "system", reason }));

const attentionItemArbitrary = fc.oneof(
  paneItemArbitrary,
  accountItemArbitrary,
  systemItemArbitrary,
);

test("property: attention parsing is total for arbitrary JSON values", () => {
  assertProperty(fc.property(fc.jsonValue(), (value) => {
    expect(() => attentionProjectionSchema.safeParse(value)).not.toThrow();
  }), { numRuns: 1_000 });
});

test("property: unique items sort into one canonical round-trippable projection", () => {
  assertProperty(fc.property(
    fc.uniqueArray(attentionItemArbitrary, {
      maxLength: 80,
      selector: attentionItemKey,
    }),
    (items) => {
      const sorted = [...items].sort(compareAttentionItems);
      const projection = canonicalAttentionProjection({
        version: 1,
        completeness: "complete",
        items: sorted,
      });
      expect(projection.items.map(attentionItemKey)).toEqual(
        sorted.map(attentionItemKey),
      );
      expect(
        canonicalAttentionProjection(JSON.parse(JSON.stringify(projection))),
      ).toEqual(projection);
      for (let index = 1; index < sorted.length; index += 1) {
        expect(compareAttentionItems(sorted[index - 1]!, sorted[index]!))
          .toBeLessThanOrEqual(0);
      }
    },
  ), { numRuns: 300 });
});

test("property: canonical attention comparison is antisymmetric", () => {
  assertProperty(fc.property(
    attentionItemArbitrary,
    attentionItemArbitrary,
    (left, right) => {
      expect(
        Math.sign(compareAttentionItems(left, right)) +
          Math.sign(compareAttentionItems(right, left)),
      ).toBe(0);
    },
  ), { numRuns: 1_000 });
});
