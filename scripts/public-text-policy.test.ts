import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertPublicCopyText,
  assertPublicSensitiveText,
  assertPublicText,
  assertPublicTree,
  PublicTextPolicyError,
} from "./public-text-policy";
import { authoritySupervisorArtifactManifest } from "./authority-supervisor-artifact";

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

  test("checks generated dependency text for secrets and paths without treating package scopes as prose", () => {
    expect(() => assertPublicSensitiveText(
      `@${["third", "party"].join("-")}/package`,
      "generated dependency text",
    )).not.toThrow();
    const secret = ["github", "pat"].join("_") + "_" + "abcdefghijklmnopqrstuvwxyz123456";
    expect(() => assertPublicSensitiveText(secret, "generated dependency text"))
      .toThrow(PublicTextPolicyError);
  });

  test("allows only the reviewed public Hraness packages", () => {
    expect(() => assertPublicText("@hraness/atet", "public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/hra", "public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/design-kit", "public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/oh", "public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/posthog", "public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/site-footer", "public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/ui", "public dependency"))
      .not.toThrow();
    const privatePackage = `@${["hraness", "private-package"].join("/")}`;
    expect(() => assertPublicText(privatePackage, "private dependency"))
      .toThrow(PublicTextPolicyError);
  });

  test("distinguishes annotated Git tag references from package scopes", () => {
    expect(() => assertPublicText(
      "https://github.com/hraness/hra@refs/tags/v0.1.1",
      "Git tag reference",
    )).not.toThrow();
    expect(() => assertPublicText(["@refs", "tags"].join("/"), "unreviewed package"))
      .toThrow(PublicTextPolicyError);
    expect(() => assertPublicText(["@refs", "private", "v0.1.1"].join("/"), "unreviewed reference"))
      .toThrow(PublicTextPolicyError);
  });

  test("scans SVG and TOML text and rejects unreviewed file types", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-"));
    const svg = join(root, "image.svg");
    const token = ["github", "pat"].join("_") + "_" + "abcdefghijklmnopqrstuvwxyz123456";
    try {
      await writeFile(svg, `<svg><text>${token}</text></svg>`, "utf8");
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "SECRET_SHAPE" });
      await unlink(svg);
      const toml = join(root, "profile.toml");
      await writeFile(toml, 'model = "routine"\n', "utf8");
      await expect(assertPublicTree(root)).resolves.toBeUndefined();
      await writeFile(toml, `credential = "${token}"\n`, "utf8");
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "SECRET_SHAPE" });
      await unlink(toml);
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

  test("scans the exact GitHub CODEOWNERS control as public text", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-codeowners-"));
    try {
      await mkdir(join(root, ".github"));
      await writeFile(join(root, ".github", "CODEOWNERS"), "* @hraness\n", "utf8");
      await expect(assertPublicTree(root)).resolves.toBeUndefined();
      await writeFile(join(root, ".github", "UNREVIEWED"), "ordinary text\n", "utf8");
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "UNREVIEWED_FILE_TYPE" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("admits only bounded, structurally valid editorial WebP files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-webp-"));
    const editorialDirectory = join(root, "site", "images", "editorial");
    try {
      await mkdir(editorialDirectory, { recursive: true });
      const reviewed = Buffer.alloc(20);
      reviewed.write("RIFF", 0, "ascii");
      reviewed.writeUInt32LE(reviewed.byteLength - 8, 4);
      reviewed.write("WEBP", 8, "ascii");
      reviewed.write("VP8 ", 12, "ascii");
      await writeFile(join(editorialDirectory, "reviewed-384.webp"), reviewed);
      await expect(assertPublicTree(root)).resolves.toBeUndefined();

      reviewed[0] = 0;
      await writeFile(join(editorialDirectory, "reviewed-384.webp"), reviewed);
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "UNREVIEWED_FILE_TYPE" });

      await unlink(join(editorialDirectory, "reviewed-384.webp"));
      await writeFile(join(root, "unreviewed.webp"), reviewed);
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "UNREVIEWED_FILE_TYPE" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects an em dash in public copy but not in internal notes or history text", async () => {
    const emDash = String.fromCodePoint(0x2014);
    expect(() => assertPublicCopyText(`plain ${emDash} prose`, "public copy"))
      .toThrow(PublicTextPolicyError);
    try {
      assertPublicCopyText(`plain ${emDash} prose`, "public copy");
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "EM_DASH" });
    }
    expect(() => assertPublicCopyText("plain prose, an en dash 0\u20132, and -- flags", "public copy"))
      .not.toThrow();
    expect(() => assertPublicText(`history ${emDash} patch`, "commit patch")).not.toThrow();

    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-em-dash-"));
    try {
      await mkdir(join(root, "kb"));
      await writeFile(join(root, "kb", "note.md"), `internal ${emDash} note\n`, "utf8");
      await expect(assertPublicTree(root)).resolves.toBeUndefined();

      for (const publicCopy of [
        "README.md",
        "package.json",
        join("site", "content.ts"),
        join("docs", "roadmap.md"),
        join(".github", "ISSUE_TEMPLATE", "bug_report.yml"),
      ]) {
        await mkdir(dirname(join(root, publicCopy)), { recursive: true });
        await writeFile(join(root, publicCopy), `copy ${emDash} text\n`, "utf8");
        await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "EM_DASH" });
        await writeFile(join(root, publicCopy), "copy text\n", "utf8");
        await expect(assertPublicTree(root)).resolves.toBeUndefined();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("ignores the regular .git pointer used by linked worktrees", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-worktree-"));
    try {
      await writeFile(join(root, ".git"), "gitdir: /private/tmp/repository/.git/worktrees/review\n", "utf8");
      await writeFile(join(root, "README.md"), "# Public package\n", "utf8");
      await expect(assertPublicTree(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("permits only the two verified authority-supervisor binary names", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-authority-artifacts-"));
    const repositoryRoot = join(import.meta.dir, "..");
    const sourceRelativePath = join("scripts", "authority-supervisor.zig");
    const binaryDirectory = join("scripts", "authority-supervisor-bin");
    const binaries = [
      "authority-supervisor-linux-x64-musl",
      "authority-supervisor-linux-arm64-musl",
    ];
    try {
      await mkdir(join(root, binaryDirectory), { recursive: true, mode: 0o700 });
      await writeFile(
        join(root, sourceRelativePath),
        await readFile(join(repositoryRoot, sourceRelativePath)),
        { mode: 0o644 },
      );
      await chmod(join(root, sourceRelativePath), 0o644);
      for (const binary of binaries) {
        const destination = join(root, binaryDirectory, binary);
        await writeFile(
          destination,
          await readFile(join(repositoryRoot, binaryDirectory, binary)),
          { mode: 0o755 },
        );
        await chmod(destination, 0o755);
      }
      await expect(assertPublicTree(root)).resolves.toBeUndefined();

      await writeFile(join(root, binaryDirectory, "unreviewed"), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "UNREVIEWED_FILE_TYPE" });
      await unlink(join(root, binaryDirectory, "unreviewed"));

      const x64Path = join(root, binaryDirectory, binaries[0] ?? "");
      await writeFile(x64Path, Buffer.alloc(authoritySupervisorArtifactManifest.artifacts.x64.byteLength, 0));
      await chmod(x64Path, 0o755);
      await expect(assertPublicTree(root)).rejects.toThrow("authority_supervisor_binary_hash_mismatch");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
