import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { BoundedProcessContainmentUnavailableError } from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
  rethrowAuthorityContainmentUnavailable,
} from "./authority-containment";

describe("authority containment refusal rendering", () => {
  test("renders a stable refused result without reusing recovery semantics", () => {
    expect(renderAuthorityContainmentUnavailable(
      new BoundedProcessContainmentUnavailableError("authority_unsupported_platform"),
    )).toBe(`${JSON.stringify({
      code: "authority_containment_unavailable",
      reason: "authority_unsupported_platform",
      schemaVersion: 1,
      status: "refused",
    })}\n`);
  });

  test("does not reclassify unrelated failures", () => {
    expect(isAuthorityContainmentUnavailable(new Error("unrelated"))).toBe(false);
    expect(renderAuthorityContainmentUnavailable(new Error("unrelated"))).toBeUndefined();
  });

  test("preserves the exact refusal through reconciliation catch paths", () => {
    const refusal = new BoundedProcessContainmentUnavailableError(
      "authority_backend_unavailable",
    );
    expect(() => rethrowAuthorityContainmentUnavailable(refusal)).toThrow(refusal);
    expect(() => rethrowAuthorityContainmentUnavailable(new Error("unrelated"))).not.toThrow();
  });

  test("keeps every provider operator wired to the shared refused renderer", async () => {
    const operatorEntryPoints = [
      ["configure-hosted-sync.ts", 2],
      ["bootstrap-hosted-sync.ts", 2],
      ["deploy-hosted-sync.ts", 2],
      ["manage-hosted-admission.ts", 2],
      ["manage-hosted-invites.ts", 2],
      ["replace-hosted-convex-target.ts", 2],
      ["hosted-status.ts", 2],
      ["current-project-alias-release.ts", 1],
      ["domain-cutover.ts", 1],
      ["release-candidate.ts", 1],
      ["publish-beta-release.ts", 1],
    ] as const;
    for (const [name, expectedReferences] of operatorEntryPoints) {
      const source = await Bun.file(join(import.meta.dir, name)).text();
      expect(source.match(/renderAuthorityContainmentUnavailable\(error\)/gu)).toHaveLength(
        expectedReferences,
      );
    }
  });
});
