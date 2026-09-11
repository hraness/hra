import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertForegroundLoginRequest } from "./foreground";

const expected = { executablePath: "/synthetic-fixture", environment: { HOME: "/owner", CLAUDE_CONFIG_DIR: "/private-config" } };
const request = { argv: ["/synthetic-fixture", "auth", "login", "--claudeai"], environment: expected.environment, stdin: 0, stdout: 1, stderr: 2 };

test("foreground qualification admits only the exact login, environment and owner descriptors", () => {
  expect(() => assertForegroundLoginRequest(expected, request)).not.toThrow();
  for (const value of [null, [], {}, { ...request, extra: true }, { ...request, stdin: 3 }, { ...request, stdout: 2 }, { ...request, stderr: 1 },
    { ...request, argv: ["/synthetic-fixture", "auth", "login"] }, { ...request, argv: [...request.argv, "--help"] },
    { ...request, argv: ["/synthetic-fixture", "auth", "logout", "--claudeai"] }, { ...request, environment: { ...expected.environment, EXTRA: "refused" } },
    { ...request, environment: { HOME: "/another", CLAUDE_CONFIG_DIR: "/private-config" } }]) {
    expect(() => assertForegroundLoginRequest(expected, value)).toThrow("foreground_request_refused");
  }
});

test("foreign argv substitutions cannot expand the foreground operation", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), fc.string(), (index, content) => {
    fc.pre(content !== request.argv[index]);
    const argv = [...request.argv]; argv[index] = content;
    expect(() => assertForegroundLoginRequest(expected, { ...request, argv })).toThrow("foreground_request_refused");
  }), { numRuns: 100, seed: 20260911 });
});
