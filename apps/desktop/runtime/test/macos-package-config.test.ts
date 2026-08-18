import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { consumeUtf8Lines, correspondingSourceSpecs } from "../corresponding-sources";
import {
  hranessUiStylesheetInput,
  macosPackage,
  requiredLicenseFileNames,
  trustedThirdPartyTeams,
} from "../macos-package-config";
import runtimeVersions from "../runtime-versions.json";
import { verifyRegularReleaseEntries } from "../verify-macos-package";

describe("macOS ad-hoc package contract", () => {
  test("streams large archive listings with bounded line memory", async () => {
    const encoder = new TextEncoder();
    const totalLines = 200_000;
    let nextLine = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (nextLine === totalLines) {
          controller.close();
          return;
        }
        const lines: string[] = [];
        const end = Math.min(totalLines, nextLine + 1_000);
        while (nextLine < end) {
          lines.push(`entry-${nextLine}-🐦‍🔥\n`);
          nextLine += 1;
        }
        controller.enqueue(encoder.encode(lines.join("")));
      },
    });
    let first = "";
    let last = "";
    const count = await consumeUtf8Lines(stream, "fixture", (line, index) => {
      if (index === 0) first = line;
      last = line;
    });
    expect(count).toBe(totalLines);
    expect(first).toBe("entry-0-🐦‍🔥");
    expect(last).toBe(`entry-${totalLines - 1}-🐦‍🔥`);

    const splitBytes = encoder.encode("alpha-🐦‍🔥\nbeta-unterminated");
    const splitStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < splitBytes.length; offset += 3) {
          controller.enqueue(splitBytes.slice(offset, offset + 3));
        }
        controller.close();
      },
    });
    const splitLines: string[] = [];
    expect(await consumeUtf8Lines(splitStream, "fixture", (line) => splitLines.push(line)))
      .toBe(2);
    expect(splitLines).toEqual(["alpha-🐦‍🔥", "beta-unterminated"]);

    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(1024 * 1024 + 1)));
        controller.close();
      },
    });
    let oversizedRejection: unknown;
    try {
      await consumeUtf8Lines(oversized, "fixture", () => undefined);
    } catch (error) {
      oversizedRejection = error;
    }
    expect(oversizedRejection).toBeInstanceOf(Error);
    expect((oversizedRejection as Error).message).toContain(
      "fixture emitted an oversized output line",
    );
  });

  test("binds the public artifact to the compiled release identity", () => {
    expect(macosPackage).toMatchObject({
      appBundleName: "HRA",
      architecture: "arm64",
      artifactBaseName: "HRA-0.1.11-12-macos-arm64",
      build: 12,
      bundleIdentifier: "kitchen.hraness",
      executableName: "hra",
      minimumMacOS: "13.0",
      version: "0.1.11",
    });
    expect(macosPackage.appBundlePath).toEndWith(
      "/zig-out/package/HRA-0.1.11-12-macos-arm64.app",
    );
  });

  test("keeps the license set exact, unique, and sorted", () => {
    const names: readonly string[] = requiredLicenseFileNames;
    expect([...names]).toEqual([...new Set(names)].sort());
    expect(requiredLicenseFileNames).toContain("HRA-LICENSE.txt");
    expect(requiredLicenseFileNames).toContain("BUN-LICENSE.md");
    expect(requiredLicenseFileNames).toContain("BUN-PROVENANCE.md");
    expect(requiredLicenseFileNames).toContain("BUN-DEPENDENCY-LICENSES.json");
    expect(requiredLicenseFileNames).toContain("BUN-DEPENDENCY-LICENSES.txt");
    expect(requiredLicenseFileNames).toContain("CODEX-NATIVE-LICENSES.json");
    expect(requiredLicenseFileNames).toContain("CODEX-NATIVE-LICENSES.txt");
    expect(requiredLicenseFileNames).toContain("GIT-COPYING.txt");
    expect(requiredLicenseFileNames).toContain("GIT-LFS-LICENSE.md");
    expect(requiredLicenseFileNames).toContain("GIT-CREDENTIAL-MANAGER-LICENSE.txt");
    expect(requiredLicenseFileNames).toContain("HRANESS-UI-LICENSE.txt");
    expect(requiredLicenseFileNames).toContain("RIPGREP-LICENSE-MIT.txt");
    expect(requiredLicenseFileNames).toContain("SHIPPED-JAVASCRIPT-LICENSES.json");
    expect(requiredLicenseFileNames).toContain("SHIPPED-JAVASCRIPT-LICENSES.txt");
    expect(requiredLicenseFileNames).not.toContain("SPARKLE-LICENSE.txt");
  });

  test("requires every declared release entry to be a regular file", async () => {
    const outputRoot = join(import.meta.dir, "../../zig-out");
    await mkdir(outputRoot, { recursive: true });
    const root = await mkdtemp(join(outputRoot, "release-entry-test-"));
    try {
      await writeFile(join(root, "artifact"), "bytes");
      await symlink("artifact", join(root, "checksum"));
      expect(await verifyRegularReleaseEntries(root, ["artifact"])).toBeUndefined();
      let rejection: unknown;
      try {
        await verifyRegularReleaseEntries(root, ["artifact", "checksum"]);
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain("checksum");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("binds the build-time UI stylesheet to its exact source and license", async () => {
    expect(hranessUiStylesheetInput).toEqual({
      licenseSha256: "799b4743aab185faac6fd07349d8ab19f9c9714b47e261996ff0971dda3d4309",
      packageJsonSha256: "f5f5131405ee72b68b341485d6561f107ec14a3c34d82d902fff9e38c764b810",
      sourceCommit: "7d4af51b2e4bf36be7e24a1ceb266b1fa4ee5cd3",
      stylesheetSha256: "f1c131cd97b7d8fa34767b836f41a2b96fe02ae365a60cfc9a210e705df03c63",
      version: "0.3.1",
    });
    const uiRoot = join(import.meta.dir, "../../node_modules/@hraness/ui");
    const sources = new Map([
      ["LICENSE", hranessUiStylesheetInput.licenseSha256],
      ["package.json", hranessUiStylesheetInput.packageJsonSha256],
      ["src/components.css", hranessUiStylesheetInput.stylesheetSha256],
    ]);
    for (const [path, expected] of sources) {
      const content = await readFile(join(uiRoot, path));
      expect(createHash("sha256").update(content).digest("hex")).toBe(expected);
    }
    const checkedLicense = await readFile(join(import.meta.dir, "../HRANESS-UI-LICENSE.txt"));
    expect(createHash("sha256").update(checkedLicense).digest("hex")).toBe(
      hranessUiStylesheetInput.licenseSha256,
    );
  });

  test("binds nested runtime licenses to their exact source and binary pins", async () => {
    expect(runtimeVersions.bun).toMatchObject({
      completeSourceArchiveSha256:
        "3c349132dee8226d33ec169062064e66cc292a1bcb05ccb19fed84f435eac529",
      dependencyLicenseInventorySha256:
        "507345b2eac69d57d8298c0db01a6e6cab40c5f864cfbc0d25f36a09bb13e578",
      dependencyLicenseNoticesSha256:
        "2040901aab37516e398fb21fa90646920700a9db66926b6ce7a72228699cd589",
    });
    expect(runtimeVersions.gitLfs).toMatchObject({
      version: "3.7.1",
      sourceCommit: "b84b33847fe6458f36ef521534dc0eac953cb379",
      binarySha256: "48bb6497160105ef852044da75147acee19502efd5f164b9a4429c3a60be7d4a",
    });
    expect(runtimeVersions.codex).toMatchObject({
      sourceCommit: "5d1fbf26c43abc65a203928b2e31561cb039e06d",
      dependencyLicenseInventorySha256:
        "7d7bae53e8b3c9bde29294caa138c9652fdf00cce9d91cc07c7a35d75b6ca5bd",
      dependencyLicenseNoticesSha256:
        "b992bd0bd3cb5a516a98bde525cafdfa333cbdc6fcffa1c4cda3ecf5b3982e34",
    });
    expect(runtimeVersions.gitCredentialManager).toMatchObject({
      version: "2.7.3",
      sourceCommit: "5fa7116896c82164996a609accd1c5ad90fe730a",
      binarySha256: "312ee623fc8ac8946db49effd5e67532439415c4958692df3e7870138358cf8a",
    });
    expect(runtimeVersions.ripgrep).toMatchObject({
      version: "15.1.0",
      sourceCommit: "af60c2de9d85e7f3d81c78601669468cf02dabab",
      binarySha256: "4fdf1d8365af224bc70e3c1490d8461d859c37cc70e739a11e987af0215f3e94",
    });
    const files = new Map([
      ["GIT-LFS-LICENSE.md", runtimeVersions.gitLfs.licenseSha256],
      [
        "GIT-CREDENTIAL-MANAGER-LICENSE.txt",
        runtimeVersions.gitCredentialManager.licenseSha256,
      ],
      ["RIPGREP-COPYING.txt", runtimeVersions.ripgrep.copyingSha256],
      ["RIPGREP-LICENSE-MIT.txt", runtimeVersions.ripgrep.licenseMitSha256],
      ["RIPGREP-UNLICENSE.txt", runtimeVersions.ripgrep.unlicenseSha256],
      ["PCRE2-LICENCE.md", runtimeVersions.ripgrep.pcre2.licenseSha256],
    ]);
    for (const [fileName, expected] of files) {
      const content = await readFile(join(import.meta.dir, "..", fileName));
      expect(createHash("sha256").update(content).digest("hex")).toBe(expected);
    }
  });

  test("binds every copyleft runtime to one full-commit source archive", () => {
    expect(correspondingSourceSpecs.map((spec) => [
      spec.project,
      spec.commit,
      spec.archiveName,
    ])).toEqual([
      [
        "Bun",
        "0d9b296af33f2b851fcbf4df3e9ec89751734ba4",
        "bun-0d9b296af33f2b851fcbf4df3e9ec89751734ba4-source.tar.gz",
      ],
      [
        "Bun WebKit",
        "5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
        "bun-webkit-5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b-source.tar.gz",
      ],
      [
        "Git",
        "67ad42147a7acc2af6074753ebd03d904476118f",
        "git-67ad42147a7acc2af6074753ebd03d904476118f-source.tar.gz",
      ],
      [
        "Dugite Native",
        "f49d0098409aa243de8b9162127025ab0bb07a88",
        "dugite-native-f49d0098409aa243de8b9162127025ab0bb07a88-source.tar.gz",
      ],
    ]);
    for (const spec of correspondingSourceSpecs) {
      expect(spec.commit).toMatch(/^[0-9a-f]{40}$/u);
      expect(spec.repository).toMatch(/^https:\/\/github\.com\//u);
      expect(spec.sentinels.length).toBeGreaterThanOrEqual(3);
    }
    expect(correspondingSourceSpecs.find((spec) => spec.project === "Git"))
      .toMatchObject({
        gitmodulesSha256:
          "b618e78e69cede7466205f1e9a306bc681772bf418136a15c172057006f562ff",
        submodules: [{
          commit: "855827c583bc30645ba427885caa40c5b81764d2",
          minimumEntries: 18,
          path: "sha1collisiondetection",
          repository: "https://github.com/cr-marcstevens/sha1collisiondetection.git",
          sentinels: ["LICENSE.txt", "README.md", "lib/sha1.c"],
        }],
      });
    expect(correspondingSourceSpecs.find((spec) => spec.project === "Dugite Native")
      ?.submodules).toEqual([
        {
          archiveName: "git-67ad42147a7acc2af6074753ebd03d904476118f-source.tar.gz",
          commit: "67ad42147a7acc2af6074753ebd03d904476118f",
          path: "git",
          repository: "https://github.com/git/git.git",
      },
    ]);
    const bun = correspondingSourceSpecs.find((spec) => spec.project === "Bun");
    expect(bun?.externalSources).toHaveLength(21);
    expect(bun?.externalSources.find((source) => source.project === "TinyCC")).toMatchObject({
      commit: "12882eee073cfe5c7621bcfadf679e1372d4537b",
      kind: "git",
      repository: "https://github.com/oven-sh/tinycc.git",
    });
    expect(bun?.externalSources.find((source) => source.project === "lol-html")).toMatchObject({
      cargoVendor: {
        lockSha256: "02d28352293be00f05be457e59e60d5b9d7e84a4cdc43bd40236a12bf8d1e53d",
        packageCount: 43,
      },
      submodules: [{
        commit: "f994590f528ac8b6073665791ddb1ed85c66dfb2",
        path: "tests/data/html5lib-tests",
      }],
    });
    expect(bun?.externalSources.find((source) => source.project === "HdrHistogram_c"))
      .toMatchObject({
        submodules: [{
          commit: "daff5fead3fbe22c6fc58310ca3f49caf117f185",
          path: "test/vendor/google/benchmark",
        }],
      });
    expect(bun?.externalSources.find((source) => source.project === "lsquic"))
      .toMatchObject({
        submodules: [
          { commit: "1a27f87ece031f9e2fbfb29d5b3ef0a72e0a6bbb", path: "src/liblsquic/ls-qpack" },
          { commit: "8905c024b6d052f083a3d11d0a169b3c2735c8a1", path: "src/lshpack" },
        ],
      });
    expect(bun?.externalSources.find((source) => source.project === "picohttpparser"))
      .toMatchObject({
        submodules: [{
          commit: "70b9797596d81896cba49e5918fd5b1edf57269b",
          path: "picotest",
        }],
      });
    expect(bun?.externalSources.find((source) => source.project === "Bun WebKit"))
      .toMatchObject({
        archiveName: "bun-webkit-5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b-source.tar.gz",
        kind: "linked-archive",
      });
  });

  test("preserves only the reviewed upstream signing teams", () => {
    expect([...trustedThirdPartyTeams]).toEqual([
      ["2DC432GLL2", "OpenAI"],
      ["VEKTX9H2N7", "GitHub"],
      ["UBF8T346G9", "Microsoft"],
    ]);
  });

  test("grants the compiled gateway only its Bun JIT entitlement", async () => {
    const source = await readFile(
      join(import.meta.dir, "../gateway.release.entitlements.plist"),
      "utf8",
    );
    expect(source.match(/<key>/gu)).toHaveLength(1);
    expect(source).toContain(
      "<key>com.apple.security.cs.allow-unsigned-executable-memory</key>",
    );
    expect(source).toContain("<true/>");
  });
});
