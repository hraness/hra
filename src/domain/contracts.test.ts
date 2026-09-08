import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import { autorespondAfterHoursCommandResultSchema, localCommandSchema } from "./contracts";

describe("local after-hours approval consent contracts", () => {
  const policy = {
    kind: "autorespond_after_hours",
    version: 1,
    revision: 2,
    enabled: false,
  } as const;

  test("admits only the closed status and revision-bound update shapes", () => {
    expect(localCommandSchema.parse({ kind: "autorespond-after-hours.status" }))
      .toEqual({ kind: "autorespond-after-hours.status" });
    for (const kind of ["autorespond-after-hours.enable", "autorespond-after-hours.disable"] as const) {
      for (const expectedRevision of [1, 7, Number.MAX_SAFE_INTEGER]) {
        expect(localCommandSchema.parse({ kind, expectedRevision })).toEqual({ kind, expectedRevision });
      }
      for (const expectedRevision of [undefined, null, "1", 0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(localCommandSchema.safeParse({ kind, expectedRevision }).success).toBe(false);
      }
      for (const extra of [
        { enabled: true }, { session: "sess_example" }, { revision: 1 },
        { idempotencyKey: "00000000-0000-4000-8000-000000000204" },
      ]) expect(localCommandSchema.safeParse({ kind, expectedRevision: 1, ...extra }).success).toBe(false);
    }
    expect(localCommandSchema.safeParse({ kind: "autorespond-after-hours.status", expectedRevision: 1 }).success).toBe(false);
    expect(localCommandSchema.safeParse({ kind: "autorespond-after-hours.set", expectedRevision: 1 }).success).toBe(false);
  });

  test("requires the exact purpose-bound local policy without hosted authority", () => {
    expect(autorespondAfterHoursCommandResultSchema.parse({ policy })).toEqual({ policy });
    for (const value of [
      {}, { policy: null }, { policy, hostedAuthority: { state: "not_observed" } },
      { policy: { ...policy, kind: "notification_email" } },
      { policy: { version: 1, revision: 2, enabled: true } },
      { policy: { ...policy, version: 2 } },
      { policy: { ...policy, revision: 0 } },
      { policy: { ...policy, revision: Number.MAX_SAFE_INTEGER + 1 } },
      { policy: { ...policy, enabled: "true" } },
      { policy: { ...policy, consecutive: 6 } },
    ]) expect(autorespondAfterHoursCommandResultSchema.safeParse(value).success).toBe(false);
  });

  test("parses arbitrary JSON without throwing and preserves valid policy round trips", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(() => autorespondAfterHoursCommandResultSchema.safeParse(value)).not.toThrow();
    }), { numRuns: 500 });
    fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), fc.boolean(), (revision, enabled) => {
      const result = { policy: { ...policy, revision, enabled } };
      expect(autorespondAfterHoursCommandResultSchema.parse(JSON.parse(JSON.stringify(result)) as unknown)).toEqual(result);
    }), { numRuns: 500 });
  });
});
