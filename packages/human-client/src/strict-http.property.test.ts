import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import { normalizeApiOrigin } from "./strict-http";

test("property: no noncanonical 127/8 host receives the local HTTP exception", () => {
  assertProperty(
    fc.property(
      fc.integer({ min: 2, max: 254 }),
      fc.integer({ min: 1, max: 65_535 }),
      (lastOctet, port) => {
        expect(
          normalizeApiOrigin(`http://127.0.0.${lastOctet}:${port}`),
        ).toBeNull();
      },
    ),
  );
});

test("property: credentials and query fragments make an origin invalid", () => {
  assertProperty(
    fc.property(
      fc.stringMatching(/^[a-z]{1,12}$/u),
      fc.stringMatching(/^[a-z]{1,12}$/u),
      (username, password) => {
        expect(
          normalizeApiOrigin(
            `https://${username}:${password}@example.com/?credential=value`,
          ),
        ).toBeNull();
      },
    ),
  );
});
