import { expect, test } from "bun:test";
import {
  createBearerSecret,
  createLocator,
  formatCredentialToken,
} from "@hraness/agent-tasks-protocol";
import { assertProperty, fc } from "@hra-internal/test";

import { writeData, type CliIo } from "./output";

test("property: valid credentials embedded in output values are always redacted", () => {
  assertProperty(
    fc.property(
      fc.uint8Array({ minLength: 26, maxLength: 26 }),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      (locatorBytes, secretBytes) => {
        const token = formatCredentialToken(
          createLocator(locatorBytes),
          createBearerSecret(secretBytes),
        );
        const stdout: string[] = [];
        const io: CliIo = {
          stdout: (value) => stdout.push(value),
          stderr: () => undefined,
          readStdin: () => Promise.resolve(""),
          stdinIsTTY: false,
        };
        writeData(io, { value: `prefix ${token} suffix` }, true);
        const rendered = stdout.join("");
        expect(rendered).not.toContain(token);
        expect(rendered).not.toContain(token.slice(-43));
      },
    ),
  );
});
