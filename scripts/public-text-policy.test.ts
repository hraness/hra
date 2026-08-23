import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPublicText, assertPublicTree, PublicTextPolicyError } from "./public-text-policy";

describe("public text policy", () => {
  test("rejects credential sentinels, private scopes, and machine user paths without echoing them", () => {
    const fixtures = [
      ["github", "pat"].join("_") + "_" + "abcdefghijklmnopqrstuvwxyz123456",
      ["-----BEGIN", "PRIVATE", "KEY-----"].join(" "),
      ["A", "KIA"].join("") + "A".repeat(16),
      ["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-"),
      ["npm", "abcdefghijklmnopqrstuvwxyz1234567890"].join("_"),
      ["xoxb", "12345678901234567890"].join("-"),
      ["AI", "za"].join("") + "A".repeat(30),
      ["CONVEX", "DEPLOY", "KEY"].join("_") + "=" + "x".repeat(24),
      ["HRA", "AUTH", "HMAC", "SECRET"].join("_") + "=" + "x".repeat(24),
      ["HRA", "RESEND", "API", "KEY"].join("_") + "=" + "x".repeat(24),
      `@${["private", "scope"].join("-")}/example`,
      ["", "Users", "example", "Documents", "source.ts"].join("/"),
      ["", "home", "example", "source.ts"].join("/"),
      ["C:", "Users", "example", "source.ts"].join("\\"),
    ];
    for (const fixture of fixtures) {
      try {
        assertPublicText(fixture, "sentinel");
        throw new Error("Expected the public-text policy to reject the sentinel.");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(PublicTextPolicyError);
        expect((error as Error).message).not.toContain(fixture);
      }
    }
  });

  test("accepts arbitrary ordinary Unicode prose without throwing accessors", () => {
    fc.assert(fc.property(fc.string(), (value) => {
      try {
        assertPublicText(value, "property input");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(PublicTextPolicyError);
      }
    }));
  });

  test("scans SVG text and rejects unreviewed file types", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-"));
    const svg = join(root, "image.svg");
    const token = ["github", "pat"].join("_") + "_" + "abcdefghijklmnopqrstuvwxyz123456";
    try {
      await writeFile(svg, `<svg><text>${token}</text></svg>`, "utf8");
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "SECRET_SHAPE" });
      await unlink(svg);
      await writeFile(join(root, "payload.bin"), "ordinary bytes", "utf8");
      const error = await assertPublicTree(root).then(
        () => new Error("Expected the public-tree policy to reject an unreviewed file."),
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(PublicTextPolicyError);
      expect(error).toMatchObject({ code: "UNREVIEWED_FILE_TYPE" });
      expect((error as Error).message).not.toContain(root);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
