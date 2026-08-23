import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertLocalOperatorEnvironment,
  buildGitHubCliEnvironment,
  buildIsolatedInstallEnvironment,
  executeReleasePublication,
  parsePublicationArguments,
  verifyAcceptedBundle,
  withBestEffortReleaseCleanup,
  type PublicationArguments,
  type ReleasePublicationProvider,
} from "./publish-beta-release";

const commit = "a".repeat(40);
const tag = "v0.1.0";
const runId = 9_876_543;
const runAttempt = 2;
const releaseId = 456;
const notes = "# HRA v0.1.0 friend beta\n\nAccepted notes.";
const temporaryRoots: string[] = [];

const digest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const assetNames = [
  "SHA256SUMS",
  `hra-${tag}.artifact.spdx.json`,
  `hra-${tag}.tgz`,
  `hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`,
] as const;

const makeAssets = (): ReadonlyMap<string, Buffer> => {
  const archive = Buffer.from("accepted archive bytes");
  const artifactSbom = Buffer.from(JSON.stringify({
    packages: [{
      checksums: [{ algorithm: "SHA256", checksumValue: digest(archive) }],
      name: "hra",
      versionInfo: "0.1.0",
    }],
  }));
  const runtimeSbom = Buffer.from(JSON.stringify({
    packages: [
      { name: "hra", versionInfo: "0.1.0" },
      { name: "@openai/codex", versionInfo: "0.149.0" },
      { name: "convex", versionInfo: "1.45.0" },
      { name: "zod", versionInfo: "4.4.3" },
    ],
  }));
  const checksums = Buffer.from([
    `${digest(archive)}  hra-${tag}.tgz`,
    `${digest(artifactSbom)}  hra-${tag}.artifact.spdx.json`,
    `${digest(runtimeSbom)}  hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`,
    "",
  ].join("\n"));
  return new Map([
    ["SHA256SUMS", checksums],
    [`hra-${tag}.artifact.spdx.json`, artifactSbom],
    [`hra-${tag}.tgz`, archive],
    [`hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`, runtimeSbom],
  ]);
};

const writeAccepted = async (
  directory: string,
  assets = makeAssets(),
): Promise<void> => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of assets) {
    await writeFile(join(directory, name), value, { flag: "wx", mode: 0o600 });
  }
  await writeFile(join(directory, "RELEASE_COMMIT"), `${commit}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(join(directory, "RELEASE_NOTES.md"), notes, {
    flag: "wx",
    mode: 0o600,
  });
};

class FakeProvider implements ReleasePublicationProvider {
  readonly calls: string[] = [];
  readonly assets = makeAssets();
  draftImmutable = false;
  immutable = true;
  mainCommit = commit;
  markerRedirected = false;
  markerStatus = 200;
  published = false;
  publicInstallFails = false;
  publishFailsAfterCommit = false;
  publishFailsBeforeCommit = false;
  publishedReleaseId: number | undefined;
  publicReleaseImmutable = true;
  tagCommit = commit;

  async verifyLocalSource(expectedCommit: string, requireCurrentMain: boolean): Promise<void> {
    this.calls.push(`local:${expectedCommit}:${String(requireCurrentMain)}`);
  }

  async readRepository(): Promise<unknown> {
    this.calls.push("repository");
    return { full_name: "hraness/hra", id: 1_343_008_607 };
  }

  async readWorkflow(): Promise<unknown> {
    this.calls.push("workflow");
    return {
      id: 123,
      name: "Release",
      path: ".github/workflows/release.yml",
      state: "active",
    };
  }

  async readRun(id: number): Promise<unknown> {
    this.calls.push(`run:${String(id)}`);
    return {
      conclusion: "success",
      event: "push",
      head_branch: tag,
      head_sha: commit,
      id: runId,
      name: "Release",
      path: ".github/workflows/release.yml",
      repository: { full_name: "hraness/hra", id: 1_343_008_607 },
      run_attempt: runAttempt,
      status: "completed",
      workflow_id: 123,
    };
  }

  async readRunArtifacts(id: number): Promise<unknown> {
    this.calls.push(`artifacts:${String(id)}`);
    return {
      artifacts: [{
        expired: false,
        id: 321,
        name: `hra-release-${tag}`,
        workflow_run: { id: runId },
      }],
      total_count: 1,
    };
  }

  async downloadRunArtifact(_id: number, _name: string, destination: string): Promise<void> {
    this.calls.push("download-run-artifact");
    await writeAccepted(destination, this.assets);
  }

  private release(): unknown {
    return {
      body: notes,
      draft: !this.published,
      id: releaseId,
      immutable: this.published ? this.publicReleaseImmutable : this.draftImmutable,
      name: `HRA ${tag}`,
      prerelease: true,
      tag_name: tag,
    };
  }

  async listReleases(): Promise<unknown> {
    this.calls.push(`releases:${this.published ? "public" : "draft"}`);
    return [this.release()];
  }

  async listReleaseAssets(id: number): Promise<unknown> {
    this.calls.push(`release-assets:${String(id)}`);
    return assetNames.map((name, index) => ({ id: index + 1, name, state: "uploaded" }));
  }

  async downloadReleaseAsset(assetId: number, destination: string): Promise<void> {
    const name = assetNames[assetId - 1];
    if (name === undefined) throw new Error("unknown asset");
    this.calls.push(`download-asset:${name}`);
    await writeFile(destination, this.assets.get(name) ?? Buffer.alloc(0), {
      flag: "wx",
      mode: 0o600,
    });
  }

  async acceptPackedInstall(): Promise<void> {
    this.calls.push("accept-packed-install");
  }

  async readTagCommit(): Promise<string> {
    this.calls.push("tag-commit");
    return this.tagCommit;
  }

  async readMainCommit(): Promise<string> {
    this.calls.push("main-commit");
    return this.mainCommit;
  }

  async readImmutableSetting(): Promise<unknown> {
    this.calls.push("immutable-setting");
    return { enabled: this.immutable, enforced_by_owner: false };
  }

  async readMarker(): Promise<Readonly<{
    body: unknown;
    redirected: boolean;
    status: number;
    url: string;
  }>> {
    this.calls.push("marker");
    return {
      body: {
        generation: 1,
        product: "HRA",
        repository: { id: 1_343_008_607, path: "hraness/hra" },
        schemaVersion: 2,
        source: { commit },
        version: "0.1.0",
      },
      redirected: this.markerRedirected,
      status: this.markerStatus,
      url: "https://hra.sh/.well-known/hra.json?release-check=test",
    };
  }

  async publishDraft(id: number): Promise<void> {
    this.calls.push("publish");
    this.publishedReleaseId = id;
    if (this.publishFailsBeforeCommit) throw new Error("lost before commit");
    this.published = true;
    if (this.publishFailsAfterCommit) throw new Error("lost after commit");
  }

  async acceptPublicInstall(url: string): Promise<void> {
    this.calls.push(`public-install:${url}`);
    if (this.publicInstallFails) throw new Error("public route unavailable");
  }
}

const publicationArguments = (action: "accept" | "publish"): PublicationArguments => ({
  action,
  expectedCommit: commit,
  ghCli: "/opt/homebrew/bin/gh",
  runAttempt,
  runId,
  tag,
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hra-release-publish-test-"));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

describe("release publication arguments", () => {
  test("requires an exact run, source commit, CLI, tag, and explicit publish acknowledgement", () => {
    expect(parsePublicationArguments([
      "publish",
      "--tag", tag,
      "--run-id", String(runId),
      "--run-attempt", String(runAttempt),
      "--expected-commit", commit,
      "--gh-cli", "/opt/homebrew/bin/gh",
      "--acknowledge-immutable-publication",
    ])).toEqual(publicationArguments("publish"));
    expect(parsePublicationArguments([
      "accept",
      "--tag", tag,
      "--run-id", String(runId),
      "--run-attempt", String(runAttempt),
      "--expected-commit", commit,
      "--gh-cli", "/opt/homebrew/bin/gh",
    ])).toEqual(publicationArguments("accept"));
    expect(() => parsePublicationArguments([
      "publish",
      "--tag", tag,
      "--run-id", String(runId),
      "--run-attempt", String(runAttempt),
      "--expected-commit", commit,
      "--gh-cli", "/opt/homebrew/bin/gh",
    ])).toThrow("usage_invalid");
    expect(() => parsePublicationArguments([
      "accept",
      "--tag", tag,
      "--run-id", String(runId),
      "--run-attempt", String(runAttempt),
      "--expected-commit", commit,
      "--gh-cli", "/opt/homebrew/bin/gh",
      "--acknowledge-immutable-publication",
    ])).toThrow("usage_invalid");
  });

  test("uses local keyring authority and isolates install state without changing HOME", async () => {
    const source = {
      CI: "",
      GH_ENTERPRISE_TOKEN: "sentinel",
      GH_HOST: "enterprise.invalid",
      GH_TOKEN: "sentinel",
      GITHUB_AUTH_TOKEN: "sentinel",
      GITHUB_ENTERPRISE_TOKEN: "sentinel",
      GITHUB_TOKEN: "sentinel",
      HOME: "/Users/operator",
      NODE_AUTH_TOKEN: "sentinel",
      NPM_TOKEN: "sentinel",
    };
    expect(buildGitHubCliEnvironment(source)).toEqual({ CI: "", HOME: "/Users/operator", NODE_AUTH_TOKEN: "sentinel", NPM_TOKEN: "sentinel" });
    const root = await makeRoot();
    const isolated = await buildIsolatedInstallEnvironment(source, root);
    expect(isolated.environment.HOME).toBe(source.HOME);
    for (const name of [
      "GH_ENTERPRISE_TOKEN",
      "GH_TOKEN",
      "GITHUB_AUTH_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GITHUB_TOKEN",
      "NODE_AUTH_TOKEN",
      "NPM_TOKEN",
    ]) expect(isolated.environment[name]).toBeUndefined();
    expect(isolated.environment.BUN_INSTALL).toStartWith(root);
    expect(isolated.environment.TMPDIR).toStartWith(root);
    expect(isolated.environment.XDG_CONFIG_HOME).toStartWith(root);
    expect(() => assertLocalOperatorEnvironment({ GITHUB_ACTIONS: "true" }))
      .toThrow("local_source_invalid");
    expect(() => assertLocalOperatorEnvironment({ CI: "1" }))
      .toThrow("local_source_invalid");
  });
});

describe("release publication cleanup", () => {
  test("never replaces the authoritative result or publication phase", async () => {
    await expect(withBestEffortReleaseCleanup(
      async () => "published" as const,
      async () => { throw new Error("cleanup failed"); },
    )).resolves.toBe("published");

    const primary = new Error("publication outcome");
    let observed: unknown;
    try {
      await withBestEffortReleaseCleanup(
        async () => { throw primary; },
        async () => { throw new Error("cleanup failed"); },
      );
    } catch (error: unknown) {
      observed = error;
    }
    expect(observed).toBe(primary);
  });
});

describe("accepted release bundle", () => {
  test("binds checksums and both SPDX contracts to the exact artifact set", async () => {
    const root = await makeRoot();
    await writeAccepted(root);
    const accepted = await verifyAcceptedBundle(root, commit);
    expect(accepted.commit).toBe(commit);
    expect(accepted.notes).toBe(notes);
    expect([...accepted.releaseAssets.keys()].sort()).toEqual([...assetNames]);
  });

  test("rejects a changed tarball before publication", async () => {
    const root = await makeRoot();
    await writeAccepted(root);
    await writeFile(join(root, `hra-${tag}.tgz`), "changed");
    await expect(verifyAcceptedBundle(root, commit)).rejects.toMatchObject({
      code: "accepted_artifact_invalid",
    });
  });
});

describe("release publication authority", () => {
  test("publishes only after exact reversible evidence and accepts the public URL", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    const result = await executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    });
    expect(result).toEqual({ commit, status: "published", tag });
    expect(provider.publishedReleaseId).toBe(releaseId);
    expect(provider.calls.indexOf("marker")).toBeLessThan(provider.calls.indexOf("releases:draft"));
    expect(provider.calls.indexOf(`download-asset:hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`))
      .toBeLessThan(provider.calls.indexOf("tag-commit"));
    expect(provider.calls.indexOf(`download-asset:hra-${tag}.ubuntu-24.04-x64.runtime.spdx.json`))
      .toBeLessThan(provider.calls.indexOf("main-commit"));
    expect(provider.calls.indexOf("immutable-setting")).toBeLessThan(provider.calls.indexOf("publish"));
    expect(provider.calls.indexOf("immutable-setting") + 1).toBe(provider.calls.indexOf("publish"));
    expect(provider.calls.indexOf("marker")).toBeLessThan(provider.calls.indexOf("publish"));
    expect(provider.calls).toContain(
      `public-install:https://github.com/hraness/hra/releases/download/${tag}/hra-${tag}.tgz`,
    );
  });

  test("fails closed when main moves, immutability is off, or canonical traffic redirects", async () => {
    for (const mutate of [
      (provider: FakeProvider): void => { provider.mainCommit = "b".repeat(40); },
      (provider: FakeProvider): void => { provider.immutable = false; },
      (provider: FakeProvider): void => { provider.markerRedirected = true; },
      (provider: FakeProvider): void => { provider.draftImmutable = true; },
    ]) {
      const root = await makeRoot();
      const provider = new FakeProvider();
      mutate(provider);
      await expect(executeReleasePublication({
        arguments: publicationArguments("publish"),
        provider,
        temporaryRoot: root,
      })).rejects.toMatchObject({ phase: "before_publication" });
      expect(provider.calls).not.toContain("publish");
    }
  });

  test("recovers a lost publish response only from an immutable public readback", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.publishFailsAfterCommit = true;
    const result = await executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    });
    expect(result.status).toBe("published");
    expect(provider.calls).toContain("releases:public");
  });

  test("reports an unknown commit point when publication fails without a public readback", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.publishFailsBeforeCommit = true;
    await expect(executeReleasePublication({
      arguments: publicationArguments("publish"),
      provider,
      temporaryRoot: root,
    })).rejects.toMatchObject({
      code: "publication_unknown",
      phase: "publication_unknown",
    });
    expect(provider.published).toBeFalse();
  });

  test("keeps post-publication failures in acceptance-only recovery", async () => {
    for (const mutate of [
      (provider: FakeProvider): void => { provider.publicInstallFails = true; },
      (provider: FakeProvider): void => { provider.publicReleaseImmutable = false; },
    ]) {
      const root = await makeRoot();
      const provider = new FakeProvider();
      mutate(provider);
      await expect(executeReleasePublication({
        arguments: publicationArguments("publish"),
        provider,
        temporaryRoot: root,
      })).rejects.toMatchObject({ phase: "published_acceptance_failed" });
      expect(provider.published).toBeTrue();
    }
  });

  test("accepts an existing immutable release without invoking publication", async () => {
    const root = await makeRoot();
    const provider = new FakeProvider();
    provider.published = true;
    const result = await executeReleasePublication({
      arguments: publicationArguments("accept"),
      provider,
      temporaryRoot: root,
    });
    expect(result.status).toBe("accepted");
    expect(provider.calls).not.toContain("publish");
    expect(provider.calls[0]).toBe(`local:${commit}:false`);
  });
});
