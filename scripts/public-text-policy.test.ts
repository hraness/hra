import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  assertPublicCopyText,
  assertPublicCheckout,
  assertPublicSensitiveText,
  assertPublicText,
  assertPublicTree,
  PublicTextPolicyError,
} from "./public-text-policy";
import { authoritySupervisorArtifactManifest } from "./authority-supervisor-artifact";

function fixtureGit(root: string, args: readonly string[]): void {
  const result = spawnSync("/usr/bin/git", [...args], {
    cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error !== undefined || result.signal !== null || result.status !== 0) {
    throw new Error("Public-checkout fixture Git command failed.");
  }
}

async function withPublicCheckout(check: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-public-checkout-")));
  try {
    fixtureGit(root, ["init", "--quiet", "--template=", "--initial-branch=fixture"]);
    await writeFile(join(root, ".gitignore"), "tmp/\n");
    await writeFile(join(root, "README.md"), "# Public fixture\n");
    fixtureGit(root, ["add", "--", ".gitignore", "README.md"]);
    await check(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

const syntheticPrivatePath = (): string => ["", "Users", "example", "private", "source.ts"].join("/");

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
    expect(() => assertPublicText("@hraness/slopcamera", "public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/atet@2.0.0", "historical public dependency"))
      .not.toThrow();
    expect(() => assertPublicText("@hraness/slopcamera-unreviewed", "unreviewed package suffix"))
      .toThrow(PublicTextPolicyError);
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

  test("admits the exact public Direct package and its imported subpaths without opening its scope", async () => {
    const name = "@hraness/direct";
    for (const specifier of [name, `${name}/testing`, `${name}/web`, `${name}/tooling/bundle-boundary`]) {
      expect(() => assertPublicText(`import * as publicModule from ${JSON.stringify(specifier)};`, "public Direct import"))
        .not.toThrow();
    }
    expect(() => assertPublicText(`${name}@0.7.0`, "pinned public Direct package")).not.toThrow();
    for (const path of ["app/fixtures/product/main.tsx", "app/fixtures/product/definition.ts", "scripts/build-site.ts", "scripts/app-browser.ts"]) {
      const source = await readFile(join(import.meta.dir, "..", path), "utf8");
      expect(source).toContain(name);
      expect(() => assertPublicText(source, path)).not.toThrow();
    }
    for (const privatePackage of [["@hraness", "private-package"], ["@unreviewed", "direct"]]) {
      expect(() => assertPublicText(privatePackage.join("/"), "unreviewed Direct sibling"))
        .toThrow(PublicTextPolicyError);
    }
    fc.assert(fc.property(fc.constantFrom("-", ".", "_", ""), fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u), (separator, suffix) => {
      expect(() => assertPublicText(`${name}${separator}${suffix}`, "unreviewed Direct package suffix"))
        .toThrow(PublicTextPolicyError);
    }), { numRuns: 40, seed: 20260908 });
  });

  test("public Direct imports do not exempt nearby credentials or private paths", () => {
    const publicImport = 'import { installDirectBrowser } from "@hraness/direct/web";';
    const secret = ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    for (const sensitive of [secret, syntheticPrivatePath()]) {
      expect(() => assertPublicText(`${publicImport}\n${sensitive}`, "sensitive Direct source"))
        .toThrow(PublicTextPolicyError);
    }
  });

  test("allows only the reviewed public Claude capture packages", () => {
    for (const packageName of [
      "@anthropic-ai/claude-code",
      "@anthropic-ai/claude-code-darwin-arm64",
    ]) {
      expect(() => assertPublicText(`${packageName}@2.1.260`, "public capture package"))
        .not.toThrow();
      expect(() => assertPublicText(`${packageName}-unreviewed`, "unreviewed capture package"))
        .toThrow(PublicTextPolicyError);
    }
    const unreviewed = ["@anthropic-ai", ["claude-code", "linux-x64"].join("-")].join("/");
    expect(() => assertPublicText(unreviewed, "unreviewed native package"))
      .toThrow(PublicTextPolicyError);
  });

  test("admits the three exact StyleX compiler packages without opening their scopes", () => {
    const packages = ["@babel/core", "@stylexjs/babel-plugin", "@stylexjs/stylex"] as const;
    for (const name of packages) {
      expect(() => assertPublicText(`${name}@0.19.0`, "reviewed compiler dependency")).not.toThrow();
      expect(() => assertPublicText(`${name}/reviewed-subpath`, "reviewed package subpath")).not.toThrow();
      expect(() => assertPublicText(`${name}-unreviewed`, "unreviewed compiler dependency"))
        .toThrow(PublicTextPolicyError);
    }
    for (const name of [["@babel", "unreviewed"], ["@stylexjs", "unreviewed"], ["@other", "ui"], ["@foreign", "package"]]) {
      expect(() => assertPublicText(name.join("/"), "unreviewed scoped dependency")).toThrow(PublicTextPolicyError);
    }
    fc.assert(fc.property(fc.constantFrom(...packages), fc.stringMatching(/^[a-z][a-z0-9]{0,12}$/u), (name, suffix) => {
      expect(() => assertPublicText(`${name}-${suffix}`, "unreviewed package suffix")).toThrow(PublicTextPolicyError);
    }), { numRuns: 40 });
  });

  test("omits only the physical ignored checkout-root temporary evidence directory", async () => {
    await withPublicCheckout(async (root) => {
      await expect(assertPublicCheckout(root)).resolves.toBeUndefined();
      await mkdir(join(root, "tmp", "app-browser-fixture"), { recursive: true });
      await writeFile(join(root, "tmp", "app-browser-fixture", "request.json"), JSON.stringify({ root: syntheticPrivatePath() }));
      await writeFile(join(root, "tmp", "app-browser-fixture", "profile.bin"), Buffer.from([0, 1, 2]));
      await expect(assertPublicCheckout(root)).resolves.toBeUndefined();
      await expect(assertPublicTree(root)).rejects.toBeInstanceOf(PublicTextPolicyError);
    });
  });

  test("tracked temporary source cannot be hidden by its ignore rule", async () => {
    await withPublicCheckout(async (root) => {
      await mkdir(join(root, "tmp"));
      await writeFile(join(root, "tmp", "source.json"), JSON.stringify({ path: syntheticPrivatePath() }));
      fixtureGit(root, ["add", "--force", "--", "tmp/source.json"]);
      await expect(assertPublicCheckout(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
      const secret = ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
      await writeFile(join(root, "tmp", "source.json"), JSON.stringify({ secret }));
      await expect(assertPublicCheckout(root)).rejects.toMatchObject({ code: "SECRET_SHAPE" });
    });
  });

  test("unignored temporary source and local-only ignore rules do not qualify for omission", async () => {
    await withPublicCheckout(async (root) => {
      await writeFile(join(root, ".gitignore"), "");
      await mkdir(join(root, "tmp"));
      await writeFile(join(root, "tmp", "source.json"), JSON.stringify({ path: syntheticPrivatePath() }));
      await expect(assertPublicCheckout(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
      await mkdir(join(root, ".git", "info"), { recursive: true });
      await writeFile(join(root, ".git", "info", "exclude"), "tmp/\n");
      await expect(assertPublicCheckout(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
    });
  });

  test("temporary evidence symlinks fail closed without following their contents", async () => {
    await withPublicCheckout(async (root) => {
      await mkdir(join(root, "retained"));
      await symlink(join(root, "retained"), join(root, "tmp"));
      await expect(assertPublicCheckout(root)).rejects.toThrow("one physical directory");
    });
  });

  test("nested temporary source and public archives never inherit the root exception", async () => {
    await withPublicCheckout(async (root) => {
      await mkdir(join(root, "tmp"));
      await mkdir(join(root, "site", "tmp"), { recursive: true });
      await writeFile(join(root, "site", "tmp", "source.json"), JSON.stringify({ path: syntheticPrivatePath() }));
      await expect(assertPublicCheckout(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
      await unlink(join(root, "site", "tmp", "source.json"));
      await mkdir(join(root, "package", "tmp"), { recursive: true });
      await writeFile(join(root, "package", "tmp", "receipt.json"), JSON.stringify({ path: syntheticPrivatePath() }));
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
    });
  });

  test("tracked edits and current nonignored untracked source still receive sensitive checks", async () => {
    await withPublicCheckout(async (root) => {
      await mkdir(join(root, "tmp"));
      await writeFile(join(root, "new-source.ts"), JSON.stringify(syntheticPrivatePath()));
      await expect(assertPublicCheckout(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
      await unlink(join(root, "new-source.ts"));
      await writeFile(join(root, "README.md"), syntheticPrivatePath());
      await expect(assertPublicCheckout(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
    });
  });

  test("checkout admission rejects nonrepositories and subdirectories of a Git root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-public-no-git-")));
    try {
      await expect(assertPublicCheckout(root)).rejects.toThrow("Git evidence");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
    await withPublicCheckout(async (checkout) => {
      await mkdir(join(checkout, "source"));
      await expect(assertPublicCheckout(join(checkout, "source"))).rejects.toThrow("exact physical Git root");
    });
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

  test("distinguishes the exact public npm certificate subject from numeric package scopes", () => {
    const subject = "repo:hraness@307125679/hra@1343008607:environment:npm-release";
    expect(() => assertPublicText(subject, "certificate subject")).not.toThrow();
    expect(() => assertPublicText(`Subject: \`${subject}\`.`, "quoted certificate subject")).not.toThrow();
    for (const value of [
      ["@307125679", "hra"].join("/"),
      subject.replace("npm-release", "unreviewed"),
      subject.replace("1343008607", "1343008608"),
      `private-${subject}`,
      `${subject}/unreviewed`,
      `${subject}-unreviewed`,
      `π${subject}`,
      `${subject}１`,
      `１${subject}`,
      `${subject}π`,
      `${subject}\u0301`,
      `${subject}\u200b`,
      `${subject}.\u200b`,
      `${subject}.π`,
      `${subject}..`,
      `π${subject}.`,
    ]) expect(() => assertPublicText(value, "unreviewed identity")).toThrow(PublicTextPolicyError);
  });

  test("admits only the exact reviewed Fulcio repository subject", () => {
    const subject = "repo:hraness@307125679/hra@1343008607:environment:npm-release";
    const numericPackageShape = ["@307125679", "hra"].join("/");
    expect(() => assertPublicText(`OID .24 contains ${subject}.`, "provenance record"))
      .not.toThrow();
    for (const value of [
      numericPackageShape,
      subject.replace(":environment:npm-release", ":environment:other"),
      subject.replace("@307125679", "@1"),
      subject.replace("@1343008607", "@1"),
      `${subject}/private`,
      `${subject}.private`,
      `x${subject}`,
    ]) {
      expect(() => assertPublicText(value, "unreviewed provenance subject"))
        .toThrow(PublicTextPolicyError);
    }
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

  test("scans the reviewed released-state SQL fixture without admitting arbitrary SQL files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-public-policy-sql-"));
    const fixture = join(root, "scripts/fixtures/released-state/v0.5.0/control-plane.sql");
    try {
      await mkdir(dirname(fixture), { recursive: true });
      await writeFile(fixture, "CREATE TABLE fixture (id TEXT);\n", "utf8");
      await expect(assertPublicTree(root)).resolves.toBeUndefined();
      const secret = ["github", "pat"].join("_") + "_" + "abcdefghijklmnopqrstuvwxyz123456";
      await writeFile(fixture, `INSERT INTO fixture VALUES ('${secret}');\n`, "utf8");
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "SECRET_SHAPE" });
      const privatePackage = `@${["private", "scope"].join("-")}/example`;
      await writeFile(fixture, `-- ${privatePackage}\n`, "utf8");
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "PRIVATE_SCOPE" });
      const privatePath = ["", "Users", "example", "state"].join("/");
      await writeFile(fixture, `-- ${privatePath}\n`, "utf8");
      await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "ABSOLUTE_USER_PATH" });
      await unlink(fixture);
      for (const path of ["unreviewed.sql", "scripts/fixtures/released-state/v0.5.0/unreviewed.sql"]) {
        const unreviewed = join(root, path);
        await writeFile(unreviewed, "CREATE TABLE fixture (id TEXT);\n", "utf8");
        await expect(assertPublicTree(root)).rejects.toMatchObject({ code: "UNREVIEWED_FILE_TYPE" });
        await unlink(unreviewed);
      }
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
