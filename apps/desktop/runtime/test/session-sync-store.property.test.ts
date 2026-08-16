import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  normalizeSessionSyncRetryErrorCode,
  redactSessionSyncAbsolutePaths,
  sessionSyncRetryErrorCodeSchema,
} from "../src/state/session-sync-store";

const localPath = fc.constantFrom(
  "/Users/private-person/secret-repository/file.ts",
  "file:///Users/private-person/secret-repository/file.ts",
  "file://localhost/Users/private-person/secret-repository/file.ts",
  String.raw`C:\Users\private-person\secret-repository\file.ts`,
  String.raw`\\private-host\private-share\secret-repository\file.ts`,
  "~/private-person/secret-repository/file.ts",
);

const surroundingText = fc.constantFrom(
  ["open=", " now"],
  ["open:", "; now"],
  ["open [", "] now"],
  ["open {", "} now"],
  ["open (", ") now"],
  ["open '", "' now"],
  ['open "', '" now'],
) as fc.Arbitrary<readonly [string, string]>;

test("session-sync title redaction removes absolute paths behind every delimiter", () => {
  assertProperty(fc.property(
    localPath,
    surroundingText,
    (path, [prefix, suffix]) => {
      const redacted = redactSessionSyncAbsolutePaths(`${prefix}${path}${suffix}`);
      expect(redacted).toContain("[local path]");
      expect(redacted).not.toContain("private-person");
      expect(redacted).not.toContain("secret-repository");
      expect(redacted).not.toContain("private-host");
      expect(redacted).not.toContain("private-share");
    },
  ));
});

test("quoted local paths with spaces cannot leak an unredacted tail", () => {
  for (const title of [
    'open "/Users/Private Person/secret repository/file.ts" now',
    "open 'file:///Users/Private Person/secret repository/file.ts' now",
    "open [C:\\Users\\Private Person\\secret repository\\file.ts] now",
  ]) {
    const redacted = redactSessionSyncAbsolutePaths(title);
    expect(redacted).toContain("[local path]");
    expect(redacted).not.toContain("Private Person");
    expect(redacted).not.toContain("secret repository");
  }
});

test("arbitrary foreign exception text maps to one closed retry code", () => {
  assertProperty(fc.property(
    fc.string({ maxLength: 512 }).filter(
      (value) => !sessionSyncRetryErrorCodeSchema.safeParse(value).success,
    ),
    (foreignText) => {
      const code = normalizeSessionSyncRetryErrorCode(foreignText);
      expect(code).toBe("LOCAL_UNKNOWN");
      expect(code).not.toBe(foreignText);
    },
  ));
});
