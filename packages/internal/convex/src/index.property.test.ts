import { expect, test } from "bun:test";

import { assertProperty, fc } from "@hra-internal/test";

import { parseConvexDeployment } from "./index";

test("property: parsing is total over arbitrary foreign values", () => {
  assertProperty(
    fc.property(fc.anything(), (value) => {
      expect(() => parseConvexDeployment(value)).not.toThrow();
      const deployment = parseConvexDeployment(value);
      expect(["invalid", "missing", "ready"]).toContain(deployment.kind);
      if (typeof value !== "string") expect(deployment).toEqual({ kind: "missing" });
    }),
  );
});

test("property: surrounding whitespace cannot change a deployment result", () => {
  assertProperty(
    fc.property(fc.string(), fc.stringMatching(/^[ \t\n\r]*$/), (value, whitespace) => {
      expect(parseConvexDeployment(`${whitespace}${value}${whitespace}`)).toEqual(
        parseConvexDeployment(value),
      );
    }),
  );
});

test("property: generated HTTPS origins canonicalize to their URL origin", () => {
  assertProperty(
    fc.property(fc.domain(), fc.option(fc.integer({ min: 1, max: 65_535 })), (host, port) => {
      const input = `https://${host}${port === null ? "" : `:${port}`}`;
      const deployment = parseConvexDeployment(input);
      expect(deployment).toEqual({
        kind: "ready",
        origin: new URL(input).origin,
        transport: "cloud",
        url: new URL(input).origin,
      });
    }),
  );
});

test("property: loopback HTTP origins stay local and remote HTTP origins stay invalid", () => {
  assertProperty(
    fc.property(
      fc.constantFrom("127.0.0.1", "[::1]", "localhost"),
      fc.integer({ min: 1, max: 65_535 }),
      (host, port) => {
        const input = `http://${host}:${port}`;
        const origin = new URL(input).origin;
        expect(parseConvexDeployment(input)).toEqual({
          kind: "ready",
          origin,
          transport: "local",
          url: origin,
        });
      },
    ),
  );

  assertProperty(
    fc.property(fc.domain(), (host) => {
      expect(parseConvexDeployment(`http://${host}`)).toMatchObject({
        kind: "invalid",
        reason: "insecure-remote",
      });
    }),
  );
});
