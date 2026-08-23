import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { containsAbsolutePath, redactAbsolutePaths } from "./contracts";
import { randomKeyBytes } from "./crypto";
import {
  decryptCompactEvents,
  detailProjectionIsSafe,
  encryptCompactEvents,
  isProjectRelativePath,
  parseCompactSessionEvents,
} from "./projection";
import { expectPromiseToReject } from "./testAssertions";

const events = [
  { kind: "user_message", sequence: 1, text: "fix it", turnId: "turn_12345678" },
  { kind: "assistant_message", sequence: 2, text: "done", turnId: "turn_12345678" },
  {
    fast: true,
    filesTouched: ["src/example.ts"],
    gitActions: [{ commit: "abcdef0", kind: "commit" }],
    kind: "turn_summary",
    model: "high",
    runtimeMs: 1_234,
    sequence: 3,
    turnId: "turn_12345678",
  },
] as const;

describe("encrypted session projections", () => {
  test("allows only project-relative bounded file names", () => {
    expect(isProjectRelativePath("src/example.ts")).toBe(true);
    const absoluteFixture = ["", "Users", "name", "repo", "file"].join("/");
    const windowsFixture = ["C:", "Users", "alice", "secret"].join("/");
    for (const path of [
      absoluteFixture,
      "../secret",
      "src/../secret",
      "~/secret",
      "C:\\secret",
      windowsFixture,
      `file://${absoluteFixture}`,
    ]) {
      expect(isProjectRelativePath(path)).toBe(false);
    }
  });

  test("redacts punctuation-delimited local paths without touching web URLs or relative paths", () => {
    const privatePath = ["", "Users", "alice", "private", "secret.ts"].join("/");
    const windowsSlashPath = ["C:", "Users", "alice", "private", "secret.ts"].join("/");
    const windowsBackslashPath = ["C:", "Users", "alice", "private", "secret.ts"].join("\\");
    const uncPath = ["", "", "server", "share", "private", "secret.ts"].join("\\");
    const candidates = [
      `\`${privatePath}\``,
      `[${privatePath}]`,
      `{~/private/secret.ts}`,
      `(${windowsSlashPath})`,
      `{${windowsBackslashPath}}`,
      `<${uncPath}>`,
      `file://${privatePath}`,
      `FILE://${privatePath}`,
      `/${privatePath}`,
      `//${privatePath}`,
    ];
    for (const candidate of candidates) {
      expect(containsAbsolutePath(candidate)).toBe(true);
      const redacted = redactAbsolutePaths(candidate);
      expect(redacted).not.toContain("alice");
      expect(redacted).not.toContain("private");
      expect(containsAbsolutePath(redacted)).toBe(false);
    }
    const webUrl = `https://example.com${privatePath}`;
    expect(redactAbsolutePaths(`${webUrl} src/example.ts`))
      .toBe(`${webUrl} src/example.ts`);
    fc.assert(fc.property(
      fc.constantFrom("`", "[", "{", "(", "<", ":", ";", "!", " "),
      fc.constantFrom("`", "]", "}", ")", ">", ",", ";", "!", " "),
      (prefix, suffix) => {
        const redacted = redactAbsolutePaths(`${prefix}${privatePath}${suffix}`);
        return !redacted.includes("alice") && !containsAbsolutePath(redacted);
      },
    ));
  });

  test("requires contiguous closed compact events", () => {
    expect(parseCompactSessionEvents(events)).toEqual(events);
    expect(parseCompactSessionEvents([events[0], { ...events[1], sequence: 3 }])).toBeNull();
    expect(parseCompactSessionEvents([{ ...events[0], rawReasoning: "hidden" }])).toBeNull();
    for (const attack of ["\u001b]52;c;owned\u0007", "owned\u202etxt"]) {
      expect(parseCompactSessionEvents([{ ...events[0], text: attack }])).toBeNull();
      expect(parseCompactSessionEvents([{ ...events[2], filesTouched: [`src/${attack}.ts`] }])).toBeNull();
      expect(parseCompactSessionEvents([{ ...events[2], gitActions: [{ kind: "status", label: attack }] }])).toBeNull();
    }
    const secretFixtures = [
      ["Bearer", "secret-token-value"].join(" "),
      ["sk", "secret_token_value_123456789"].join("_"),
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    ];
    for (const secret of secretFixtures) {
      expect(parseCompactSessionEvents([{ ...events[0], text: secret }])).toBeNull();
      expect(parseCompactSessionEvents([{
        ...events[2],
        gitActions: [{ kind: "status", label: secret }],
      }])).toBeNull();
    }
  });

  test("round trips only under the full session authority tuple", async () => {
    const key = randomKeyBytes();
    const authority = {
      firstSequence: 1,
      keyVersion: 1,
      lastSequence: 3,
      sessionPublicId: "session_12345678",
      sourceBootId: "boot_12345678",
      sourceDevicePublicId: "device_12345678",
      sourceFence: 1,
      stream: "compact",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptCompactEvents(events, key, authority);
    expect(JSON.stringify(envelope)).not.toContain("fix it");
    expect(await decryptCompactEvents(envelope, key, authority)).toEqual(events);
    await expectPromiseToReject(
      decryptCompactEvents(envelope, key, { ...authority, sourceFence: 2 }),
    );
  });

  test("detail projections reject secrets and prohibited raw fields", () => {
    expect(detailProjectionIsSafe({ event: "tool", summary: "read a bounded file" })).toBe(true);
    expect(detailProjectionIsSafe({ raw_reasoning: "private" })).toBe(false);
    expect(detailProjectionIsSafe({ tool_output: "arbitrary" })).toBe(false);
    expect(detailProjectionIsSafe({ text: "Bearer secret-token-value" })).toBe(false);
  });
});
