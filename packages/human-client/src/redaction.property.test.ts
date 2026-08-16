import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import { redactHumanDiagnostic } from "./redaction";

test("property: opaque refresh values supplied by custody are always redacted", () => {
  assertProperty(
    fc.property(
      fc.stringMatching(/^[A-Za-z0-9_-]{20,128}$/u),
      fc.string({ maxLength: 256 }),
      (refreshToken, context) => {
        const redacted = redactHumanDiagnostic(
          `${context} refreshToken=${refreshToken}`,
          [refreshToken],
        );
        expect(redacted).not.toContain(refreshToken);
      },
    ),
  );
});

test("property: JSON-shaped token fields are redacted without known-secret input", () => {
  assertProperty(
    fc.property(
      fc.string({ minLength: 1, maxLength: 128 }),
      (refreshToken) => {
        const source = JSON.stringify({ refreshToken });
        expect(JSON.parse(redactHumanDiagnostic(source))).toEqual({
          refreshToken: "[REDACTED]",
        });
      },
    ),
  );
});
