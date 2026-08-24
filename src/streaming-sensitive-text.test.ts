import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import { redactCompleteSensitiveText } from "./sensitive-text";
import { StreamingSensitiveRedactor } from "./streaming-sensitive-text";

const privateKeyBanner = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");

const fixtures = [
  { text: "prefix Bearer abc suffix", secrets: ["Bearer abc"] },
  { text: "prefix Basic Zg== suffix", secrets: ["Basic Zg=="] },
  { text: "prefix Bearer $AUTH-SYMBOL-SECRET suffix", secrets: ["AUTH-SYMBOL-SECRET"] },
  { text: "prefix Basic 💥UNICODE-AUTH-SECRET suffix", secrets: ["UNICODE-AUTH-SECRET"] },
  { text: "prefix eyJabcdefgh suffix", secrets: ["eyJabcdefgh"] },
  { text: "prefix eyJabcdefgh.segment. suffix", secrets: ["eyJabcdefgh"] },
  { text: "prefix sk_abcdefgh suffix", secrets: ["sk_abcdefgh"] },
  { text: "prefix re-proj-abcdefgh suffix", secrets: ["re-proj-abcdefgh"] },
  { text: "prefix ghp_abcdefgh suffix", secrets: ["ghp_abcdefgh"] },
  { text: "prefix github_pat_abcdefgh suffix", secrets: ["github_pat_abcdefgh"] },
  { text: "prefix xoxb-abcdefgh suffix", secrets: ["xoxb-abcdefgh"] },
  { text: "prefix AKIAABCDEFGHIJKL suffix", secrets: ["AKIAABCDEFGHIJKL"] },
  {
    text: "prefix Proxy-Authorization: Odd secret value, with whitespace\nsuffix",
    secrets: ["Odd secret value"],
  },
  {
    text: "prefix Set-Cookie: session=COOKIE-SECRET; Secure\nsuffix",
    secrets: ["COOKIE-SECRET"],
  },
  {
    text: 'prefix password = "QUOTED CREDENTIAL SECRET" suffix',
    secrets: ["QUOTED CREDENTIAL SECRET"],
  },
  {
    text: "prefix device_code=DEVICE-CODE-SECRET suffix",
    secrets: ["DEVICE-CODE-SECRET"],
  },
  {
    text: 'prefix api_key={ "token": "OBJECT-SECRET", "nested": [1, 2] } suffix',
    secrets: ["OBJECT-SECRET", '"nested": [1, 2]', "suffix"],
  },
  {
    text: 'prefix access_token=[ "ARRAY SECRET", { "x": 1 } ] suffix',
    secrets: ["ARRAY SECRET", '"x": 1', "suffix"],
  },
  { text: "prefix token = Bearer tiny suffix", secrets: ["Bearer tiny"] },
  {
    text: `prefix ${privateKeyBanner} PRIVATE-KEY-SECRET suffix`,
    secrets: ["PRIVATE-KEY-SECRET", "PRIVATE KEY"],
  },
] as const;

const longAuthorizationFixtures = [
  {
    text: `prefix Bearer $${"AUTH-SYMBOL-SECRET".repeat(12)} suffix`,
    secrets: ["AUTH-SYMBOL-SECRET"],
  },
  {
    text: `prefix Basic 💥${"UNICODE-AUTH-SECRET".repeat(12)} suffix`,
    secrets: ["UNICODE-AUTH-SECRET"],
  },
  {
    text: `prefix Bearer ${" ".repeat(200)}$LONG-WHITESPACE-AUTH-SECRET suffix`,
    secrets: ["LONG-WHITESPACE-AUTH-SECRET"],
  },
  {
    text: `prefix ${"tenant_".repeat(40)}api_key=LONG-PREFIX-CREDENTIAL-SECRET suffix`,
    secrets: ["LONG-PREFIX-CREDENTIAL-SECRET"],
  },
  {
    text: `prefix ${"tenant-".repeat(40)}authorization: LONG-PREFIX-HEADER-SECRET\nsuffix`,
    secrets: ["LONG-PREFIX-HEADER-SECRET"],
  },
] as const;

type Fixture = (typeof fixtures)[number] | (typeof longAuthorizationFixtures)[number];

const assertCompleteFixedPoint = (value: string): void => {
  if (redactCompleteSensitiveText(value, "[protected]") !== value) {
    throw new Error(`Streaming output retained complete sensitive grammar: ${value}`);
  }
};

const stream = (chunks: readonly string[]): string => {
  const redactor = new StreamingSensitiveRedactor();
  let output = "";
  for (const chunk of chunks) {
    output += redactor.push(chunk);
    assertCompleteFixedPoint(output);
  }
  output += redactor.push("", true);
  assertCompleteFixedPoint(output);
  return output;
};

const expectConservative = (
  fixture: Fixture,
  chunks: readonly string[],
): void => {
  const output = stream(chunks);
  expect(redactCompleteSensitiveText(output, "[protected]")).toBe(output);
  expect(output).toContain("[protected]");
  for (const secret of fixture.secrets) expect(output).not.toContain(secret);
};

describe("StreamingSensitiveRedactor", () => {
  test("is at least as conservative as complete redaction at every one- and two-split partition", () => {
    for (const fixture of fixtures) {
      for (let first = 0; first <= fixture.text.length; first += 1) {
        expectConservative(fixture, [
          fixture.text.slice(0, first),
          fixture.text.slice(first),
        ]);
        for (let second = first; second <= fixture.text.length; second += 1) {
          expectConservative(fixture, [
            fixture.text.slice(0, first),
            fixture.text.slice(first, second),
            fixture.text.slice(second),
          ]);
        }
      }
    }
  });

  test("protects complete grammar beyond the carry bound at every split", () => {
    for (const fixture of longAuthorizationFixtures) {
      for (let split = 0; split <= fixture.text.length; split += 1) {
        expectConservative(fixture, [
          fixture.text.slice(0, split),
          fixture.text.slice(split),
        ]);
      }
    }
  });

  test("stays conservative for arbitrary high-fragmentation partitions", () => {
    fc.assert(fc.property(
      fc.constantFrom(...fixtures, ...longAuthorizationFixtures),
      fc.array(fc.nat(200), { minLength: 0, maxLength: 96 }),
      (fixture, rawCuts) => {
        const cuts = [...new Set(rawCuts.map((cut) => cut % (fixture.text.length + 1)))]
          .sort((left, right) => left - right);
        const boundaries = [0, ...cuts, fixture.text.length];
        const chunks = boundaries.slice(1).map((boundary, index) =>
          fixture.text.slice(boundaries[index] ?? 0, boundary));
        expectConservative(fixture, chunks);
      },
    ), { numRuns: 500 });
  });
});
