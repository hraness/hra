import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { renderIdentityCutoverCompatibilitySchema } from "./identity-cutover-schema";

const sourceExtensions = new Set([".cjs", ".js", ".json", ".md", ".mjs", ".ts", ".tsx"]);
const skippedDirectories = new Set([".next", "coverage", "dist", "node_modules"]);

function sourceFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...sourceFiles(root, path));
      continue;
    }
    if (sourceExtensions.has(extname(entry.name)) || entry.name === ".env.example") {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files;
}

describe("identity cutover compatibility schema", () => {
  test("adds only the staged predecessor shapes while retaining final auth tables", async () => {
    const strict = await Bun.file(new URL("../convex/schema.ts", import.meta.url)).text();
    const compatibility = renderIdentityCutoverCompatibilitySchema(strict);

    for (const finalTable of [
      "authSessionSelections",
      "authSessionRotationRequests",
      "passwordMigrationClaims",
      "desktopPairingRequests",
      "syncVaults",
      "syncScheduledChats",
    ]) {
      expect(compatibility).toContain(`${finalTable}: defineTable`);
    }
    for (const predecessorShape of [
      "workosUserId: v.optional",
      "workosOrganizationId: v.optional",
      "workosMembershipId: v.optional",
      "startedByWorkosUserId: v.optional",
      "startedByUserPublicId: v.optional",
      "workosMembershipRetirements: defineTable",
      "identityWebhookReceipts: defineTable",
      "identityReconciliationState: defineTable",
      "identityReconciliationQuarantines: defineTable",
      "accountProvisioningOperations: defineTable",
    ]) {
      expect(compatibility).toContain(predecessorShape);
    }
    expect(compatibility).not.toBe(strict);
    expect(compatibility).not.toContain("startedByUserPublicId: v.string(),");
    expect(() => renderIdentityCutoverCompatibilitySchema(compatibility)).toThrow(
      "expected one exact organization schema block",
    );
  });

  test("retains predecessor names only in bounded migration and environment-denial artifacts", () => {
    const webRoot = fileURLToPath(new URL("..", import.meta.url));
    const matches = sourceFiles(webRoot)
      .filter((path) => /authkit|workos/iu.test(readFileSync(join(webRoot, path), "utf8")))
      .sort();
    expect(matches).toEqual([
      "convex/identityCutover.test.ts",
      "convex/identityCutover.ts",
      "scripts/identity-cutover-schema.test.ts",
      "scripts/identity-cutover-schema.ts",
      "scripts/vercel-build.test.ts",
      "scripts/vercel-build.ts",
    ]);
  });
});
