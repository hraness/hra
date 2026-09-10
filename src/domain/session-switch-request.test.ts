import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fc from "fast-check";

import {
  sessionSwitchRawRequestSchema,
  sessionSwitchRawRequestV1Schema,
  sessionSwitchRawRequestV2Schema,
} from "./session-switch-request";

const legacy = { session: "original session", provider: "codex", account: "target", preset: "high" } as const;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("historical switch request retains its exact four-field canonical preimage", () => {
  const json = '{"session":"original session","provider":"codex","account":"target","preset":"high"}';
  expect(JSON.stringify(sessionSwitchRawRequestSchema.parse(legacy))).toBe(json);
  expect(JSON.stringify(sessionSwitchRawRequestV1Schema.parse({
    preset: "high", account: "target", provider: "codex", session: "original session",
  }))).toBe(json);
  expect(sessionSwitchRawRequestV1Schema.safeParse({ ...legacy, presetContract: 2 }).success).toBe(false);
  expect(sessionSwitchRawRequestV1Schema.safeParse({ ...legacy, version: 2, presetContract: null }).success).toBe(false);
});

test("current switch request distinguishes omitted, contract-one and contract-two authorship", () => {
  const values = [null, 1, 2].map((presetContract) =>
    sessionSwitchRawRequestV2Schema.parse({ version: 2, ...legacy, presetContract }));
  expect(values.map((value) => value.presetContract)).toEqual([null, 1, 2]);
  expect(new Set([legacy, ...values].map(digest)).size).toBe(4);
  expect(JSON.stringify(values[0])).toBe(
    '{"version":2,"session":"original session","provider":"codex","account":"target","preset":"high","presetContract":null}',
  );
  for (const value of values) expect(sessionSwitchRawRequestSchema.parse(value)).toEqual(value);
});

test("versioned switch requests do not default malformed or missing authored fields", () => {
  for (const value of [
    { ...legacy, version: 1 },
    { ...legacy, version: 3, presetContract: null },
    { ...legacy, version: 2 },
    { ...legacy, version: 2, presetContract: undefined },
    { ...legacy, version: 2, presetContract: 0 },
    { ...legacy, version: 2, presetContract: 3 },
    { ...legacy, version: 2, presetContract: "1" },
    { ...legacy, version: 2, presetContract: null, targetHostCapabilities: {} },
    { ...legacy, presetContract: null },
  ]) expect(sessionSwitchRawRequestSchema.safeParse(value).success).toBe(false);
});

test("historical provider selectors remain readable without supported-provider admission", () => {
  const value = { session: "retained", provider: "devin", account: null, preset: null } as const;
  expect(sessionSwitchRawRequestV1Schema.parse(value)).toEqual(value);
  // These are interpretation codecs, never authorization for a new runtime.
  expect(sessionSwitchRawRequestV2Schema.parse({ version: 2, ...value, presetContract: null }).provider).toBe("devin");
});

test("switch request canonicalization is independent of foreign object key order", () => {
  fc.assert(fc.property(fc.shuffledSubarray(
    ["version", "session", "provider", "account", "preset", "presetContract"] as const,
    { minLength: 6, maxLength: 6 },
  ), fc.constantFrom(null, 1, 2), (keys, presetContract) => {
    const value = { version: 2, ...legacy, presetContract };
    const reordered = Object.fromEntries(keys.map((key) => [key, value[key]]));
    expect(JSON.stringify(sessionSwitchRawRequestSchema.parse(reordered)))
      .toBe(JSON.stringify(sessionSwitchRawRequestV2Schema.parse(value)));
  }), { seed: 54902, numRuns: 100 });
});

test("switch request parser is total on JSON inputs and successful parses are idempotent", () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    const result = sessionSwitchRawRequestSchema.safeParse(value);
    if (result.success) expect(sessionSwitchRawRequestSchema.parse(result.data)).toEqual(result.data);
  }), { seed: 54903, numRuns: 100 });
});
