import { expect, test } from "bun:test";
import { createBearerSecret, createLocator, formatCredentialToken } from "@hraness/agent-tasks-protocol";
import { assertProperty, fc } from "@hra-internal/test";

import { parseArgs } from "./args";

test("property: generated bearer tokens are rejected and absent from parse results", () => {
  assertProperty(
    fc.property(
      fc.uint8Array({ minLength: 26, maxLength: 26 }),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      (locatorBytes, secretBytes) => {
        const token = formatCredentialToken(
          createLocator(locatorBytes),
          createBearerSecret(secretBytes),
        );
        const result = parseArgs(["task", "create", "--title", token, "--json"]);
        expect(result.ok).toBeFalse();
        expect(JSON.stringify(result)).not.toContain(token);
        expect(JSON.stringify(result)).not.toContain(token.slice(-43));
      },
    ),
  );
});

test("property: arbitrary argv never makes parsing throw", () => {
  assertProperty(
    fc.property(fc.array(fc.string(), { maxLength: 20 }), (argv) => {
      expect(() => parseArgs(argv)).not.toThrow();
    }),
  );
});
