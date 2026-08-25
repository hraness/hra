import { describe, expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";

import schema from "./schema";
import { modules } from "./test.setup";

const readReleaseAttestation = makeFunctionReference<"query", Record<string, never>, unknown>(
  "releaseAttestation:read",
);

describe("release attestation", () => {
  test("the tracked source is explicitly unbound and exposes no provider state", async () => {
    const runtime = convexTest(schema, modules);
    expect(await runtime.query(readReleaseAttestation, {})).toEqual({
      bound: false,
      schemaIdentity: "hra-release-attestation-v1",
      schemaVersion: 1,
    });
  });
});
