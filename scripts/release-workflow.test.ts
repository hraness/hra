import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildHraGlobalInstallCommand,
  HRA_INSTALL_ARCHIVE_URL,
} from "../src/install-preflight";
import { githubPublisherEnvironment } from "./github-publisher-environment";
import {
  draftReleaseBody,
  githubReleaseRun,
  parseReleaseBody,
} from "./github-release-identity";

const reviewedActions = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  downloadArtifact: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
} as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

describe("release workflow", () => {
  test("keeps every privileged release helper under owner review", async () => {
    const codeowners = await readFile(
      join(import.meta.dir, "..", ".github", "CODEOWNERS"),
      "utf8",
    );
    for (const path of [
      "/scripts/github-publisher-environment.ts",
      "/scripts/github-release-identity.ts",
      "/scripts/github-release-retry-policy.ts",
      "/scripts/bounded-json-response.ts",
      "/scripts/check-commit-ci-run.ts",
      "/scripts/check-npm-trusted-publisher-oidc.ts",
      "/scripts/npm-publisher-boundary.ts",
      "/scripts/publish-github-release.ts",
      "/scripts/publish-npm-release.ts",
      "/scripts/verify-npm-provenance-crypto.mjs",
      "/scripts/verify-npm-provenance.ts",
    ]) expect(codeowners).toContain(`${path} @0thernet`);
  });

  test("bounds every npm metadata read and aligns GitHub artifact output with package policy", async () => {
    const [preflight, npmPublisher, npmBoundary, githubPublisher, distributionPolicy] = await Promise.all([
      readFile(join(import.meta.dir, "check-npm-artifact-state.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-npm-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "npm-publisher-boundary.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-github-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "release-distribution-policy.ts"), "utf8"),
    ]);
    expect(distributionPolicy).toContain("readBoundedJsonResponse(response, label, 128 * 1_024)");
    expect(preflight).toContain("const metadata: Record<string, unknown> | null = await npmRegistryReleaseMetadata(");
    expect(npmPublisher).toContain('metadata(versionUrl, "version")');
    expect(npmPublisher).toContain('metadata(latestUrl, "latest")');
    expect(npmPublisher).toContain("lookupCompleteRelease()");
    expect(npmBoundary).toContain("maximumPublisherOutputBytes");
    expect(npmBoundary).toContain("Successfully retrieved and set token");
    expect(npmBoundary).toContain("GITHUB_REPOSITORY_OWNER_ID");
    expect(npmBoundary).not.toContain("console.log(output)");
    expect(npmBoundary).not.toContain("console.error(output)");
    expect(preflight).not.toContain("response.json()");
    expect(npmPublisher).not.toContain("response.json()");
    expect(githubPublisher).toContain("const maximumArtifactBytes = 64 * 1024 * 1024");
    expect(githubPublisher).toContain("maxBuffer: maximumStdoutBytes + 1");
    expect(githubPublisher.match(/false, maximumArtifactBytes\)\.stdout/gu)?.length).toBe(2);
    expect(githubPublisher).not.toContain("maxBuffer: 32 * 1_024 * 1_024");
  });

  test("matches current Fulcio V2 bytes while retaining every signer claim", async () => {
    const [policy, signer, releaseRecord] = await Promise.all([
      readFile(join(import.meta.dir, "verify-npm-provenance.ts"), "utf8"),
      readFile(join(import.meta.dir, "verify-npm-provenance-crypto.mjs"), "utf8"),
      readFile(join(import.meta.dir, "..", "docs", "beta-release.md"), "utf8"),
    ]);
    for (const source of [policy, signer]) {
      expect(source).toContain("canonicalAsciiDerUtf8String");
      expect(source).toContain("String.fromCharCode(0x0c, value.length)");
      expect(source).toContain('"1.3.6.1.4.1.57264.1.2": "push"');
      expect(source).toContain('"1.3.6.1.4.1.57264.1.11": der("github-hosted")');
      expect(source).toContain(
        "`repo:${GITHUB_REPOSITORY_OWNER}@${GITHUB_REPOSITORY_OWNER_ID}/${GITHUB_REPOSITORY_NAME}@${GITHUB_REPOSITORY_ID}:ref:${ref}`",
      );
      expect(source).not.toContain("`repo:hraness/hra:ref:${ref}`");
    }
    expect(releaseRecord).toContain("Current V2 claims from `.11` onward");
    expect(releaseRecord).toContain("repository path `hraness/hra`, numeric owner ID");
    expect(releaseRecord).toContain("`307125679`, numeric repository ID `1343008607`");
    expect(releaseRecord).toContain("ref `refs/tags/v0.1.6`");
  });

  test("gives GitHub publisher commands only their explicit non-OIDC environment", () => {
    const environment = githubPublisherEnvironment({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/secret",
      GH_TOKEN: "github-secret",
      HOME: "/home/release",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      UNRELATED_SECRET: "private",
    });

    expect(environment).toEqual({
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: "github-secret",
      HOME: "/home/release",
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    });
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(environment.UNRELATED_SECRET).toBeUndefined();
    expect(() => githubPublisherEnvironment({ GH_TOKEN: "github-secret" })).toThrow();
  });

  test("isolates complete release history to reviewed main and the immutable tag", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    )), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");

    for (const jobName of ["verify", "exact_artifact", "publish"] as const) {
      const job = asRecord(jobs[jobName], `${jobName} job`);
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} steps must be an array`);
      const steps = job.steps.map((step, index) => asRecord(step, `${jobName} step ${index}`));
      const checkoutIndex = steps.findIndex((step) => step.uses === reviewedActions.checkout);
      const fetchIndex = steps.findIndex((step) => step.name === "Fetch only governed release history");
      expect(checkoutIndex).toBeGreaterThanOrEqual(0);
      expect(fetchIndex).toBe(checkoutIndex + 1);
      expect(asRecord(steps[checkoutIndex]?.with, `${jobName} checkout inputs`)).toMatchObject({
        "fetch-depth": 1,
        "fetch-tags": false,
        "persist-credentials": false,
      });
      const fetch = String(steps[fetchIndex]?.run);
      expect(fetch).toContain("git fetch --force --no-tags --unshallow origin");
      expect(fetch).toContain("+refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH");
      expect(fetch).toContain("+refs/tags/$VERIFIED_TAG:refs/tags/$VERIFIED_TAG");
      expect(fetch).toContain("git rev-parse --is-shallow-repository");
      expect(fetch).toContain("git for-each-ref --format='%(refname)'");
      expect(fetch).toContain("Unexpected ref entered governed release history");
      expect(fetch).not.toContain("--all");
    }
  });

  test("keeps release authority-supervisor prerequisites byte-aligned with CI", async () => {
    const root = join(import.meta.dir, "..");
    const [ciSource, releaseSource] = await Promise.all([
      readFile(join(root, ".github", "workflows", "ci.yml"), "utf8"),
      readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
    ]);
    const ciJobs = asRecord(asRecord(Bun.YAML.parse(ciSource), "CI workflow").jobs, "CI jobs");
    const releaseJobs = asRecord(
      asRecord(Bun.YAML.parse(releaseSource), "release workflow").jobs,
      "release jobs",
    );
    const ciCheck = asRecord(ciJobs.check, "CI check job");
    const releaseVerify = asRecord(releaseJobs.verify, "release verify job");
    const releaseExactArtifact = asRecord(releaseJobs.exact_artifact, "release exact-artifact job");
    if (
      !Array.isArray(ciCheck.steps)
      || !Array.isArray(releaseVerify.steps)
      || !Array.isArray(releaseExactArtifact.steps)
    ) {
      throw new TypeError("CI, release verify, and exact-artifact steps must be arrays");
    }
    const ciSteps = ciCheck.steps.map((step, index) => asRecord(step, `CI step ${index}`));
    const releaseSteps = releaseVerify.steps
      .map((step, index) => asRecord(step, `release verify step ${index}`));
    const exactArtifactSteps = releaseExactArtifact.steps
      .map((step, index) => asRecord(step, `release exact-artifact step ${index}`));
    const authoritySteps = [
      "Download pinned Zig 0.16.0 for authority supervisor (Linux)",
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "Enable isolated user namespaces for native custody checks",
      "Restore Ubuntu user-namespace restriction",
    ] as const;
    const custodyTestName = "Run Linux authority-supervisor custody test";

    const exactlyOneStep = (
      steps: readonly Record<string, unknown>[],
      name: string,
      label: string,
    ): Record<string, unknown> => {
      const matches = steps.filter((step) => step.name === name);
      expect(matches, `${label} must contain exactly one ${name} step`).toHaveLength(1);
      const [match] = matches;
      if (match === undefined) throw new TypeError(`${label} is missing ${name}`);
      return match;
    };

    for (const name of authoritySteps) {
      const ciStep = exactlyOneStep(ciSteps, name, "CI check");
      const releaseStep = exactlyOneStep(releaseSteps, name, "release verify");
      expect(ciStep.if).toBe(
        name === "Restore Ubuntu user-namespace restriction"
          ? "${{ always() && runner.os == 'Linux' }}"
          : "runner.os == 'Linux'",
      );
      expect(releaseStep.if).toBe(ciStep.if);
      expect(releaseStep.run).toBe(ciStep.run);
    }

    const zigDownload = String(exactlyOneStep(
      ciSteps,
      "Download pinned Zig 0.16.0 for authority supervisor (Linux)",
      "CI check",
    ).run);
    expect(zigDownload).toContain(
      'HRA_ZIG_SHA256="70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00"',
    );
    expect(zigDownload).toContain(
      '"https://ziglang.org/download/0.16.0/zig-x86_64-linux-0.16.0.tar.xz"',
    );
    expect(zigDownload).toContain("sha256sum --check --status");
    expect(String(exactlyOneStep(
      ciSteps,
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "CI check",
    ).run)).toBe(
      'bun ./scripts/verify-authority-supervisor-build.ts --zig "$RUNNER_TEMP/hra-zig-0.16.0/zig-x86_64-linux-0.16.0/zig"',
    );
    const enableNamespaces = String(exactlyOneStep(
      ciSteps,
      "Enable isolated user namespaces for native custody checks",
      "CI check",
    ).run);
    expect(enableNamespaces).toContain(
      'test "$(/usr/sbin/sysctl --values kernel.unprivileged_userns_clone)" = "1"',
    );
    expect(enableNamespaces).toContain(
      "sudo /usr/sbin/sysctl --write kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(enableNamespaces).toContain(
      'test "$(/usr/sbin/sysctl --values kernel.apparmor_restrict_unprivileged_userns)" = "0"',
    );
    expect(enableNamespaces).toContain(
      "/usr/bin/unshare --user --map-root-user --fork /usr/bin/true",
    );
    // CI runs the custody test once, inside `bun run check`; only the release
    // verifier, which no longer reruns the gate, keeps the focused step.
    expect(ciSteps.filter((step) => step.name === custodyTestName)).toHaveLength(0);
    const releaseCustodyTest = exactlyOneStep(releaseSteps, custodyTestName, "release verify");
    expect(releaseCustodyTest.if).toBe("runner.os == 'Linux'");
    expect(String(releaseCustodyTest.run)).toBe(
      "bun test scripts/authority-supervisor-runtime.test.ts --isolate --max-concurrency=1",
    );
    const restoreNamespaces = String(exactlyOneStep(
      ciSteps,
      "Restore Ubuntu user-namespace restriction",
      "CI check",
    ).run);
    expect(restoreNamespaces).toContain(
      "sudo /usr/sbin/sysctl --write kernel.apparmor_restrict_unprivileged_userns=1",
    );
    expect(restoreNamespaces).toContain(
      'test "$(/usr/sbin/sysctl --values kernel.apparmor_restrict_unprivileged_userns)" = "1"',
    );

    const verifyOrder = [
      "Install exact locked dependencies without lifecycle scripts",
      "Require the exact commit's successful CI run",
      "Download pinned Zig 0.16.0 for authority supervisor (Linux)",
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "Enable isolated user namespaces for native custody checks",
      custodyTestName,
      "Restore Ubuntu user-namespace restriction",
      "Create one exact npm tarball and checksum",
    ] as const;
    const verifyIndexes = verifyOrder.map((name) => {
      exactlyOneStep(releaseSteps, name, "release verify");
      return releaseSteps.findIndex((step) => step.name === name);
    });
    expect(verifyIndexes).toEqual([...verifyIndexes].sort((left, right) => left - right));
    const custodyTestIndex = verifyIndexes[5];
    const restoreIndex = verifyIndexes[6];
    expect(restoreIndex).toBe((custodyTestIndex ?? -2) + 1);
    expect(releaseSteps.filter((step) => step.name === "Run complete repository gate")).toHaveLength(0);
    expect(releaseSource).not.toContain("bun run check");

    for (const name of [
      "Enable isolated user namespaces for native custody checks",
      "Restore Ubuntu user-namespace restriction",
    ] as const) {
      const ciStep = exactlyOneStep(ciSteps, name, "CI check");
      const releaseStep = exactlyOneStep(exactArtifactSteps, name, "release exact-artifact");
      expect(releaseStep.if).toBe(ciStep.if);
      expect(releaseStep.run).toBe(ciStep.run);
    }
    const packageCheckName = "Verify checksum and complete installed-package behavior";
    exactlyOneStep(exactArtifactSteps, packageCheckName, "release exact-artifact");
    const packageCheckIndex = exactArtifactSteps.findIndex((step) => step.name === packageCheckName);
    expect(exactArtifactSteps[packageCheckIndex - 1]?.name)
      .toBe("Enable isolated user namespaces for native custody checks");
    expect(exactArtifactSteps[packageCheckIndex + 1]?.name)
      .toBe("Restore Ubuntu user-namespace restriction");
  });

  test("binds residual draft identity to the exact same run and artifact authority", () => {
    const source = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v0.1.7",
      GITHUB_REF_NAME: "v0.1.7",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REPOSITORY: "hraness/hra",
      GITHUB_REPOSITORY_ID: "1343008607",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123",
      GITHUB_WORKFLOW_REF: "hraness/hra/.github/workflows/release.yml@refs/tags/v0.1.7",
    };
    const run = githubReleaseRun("v0.1.7", source);
    const input = {
      artifacts: [{ name: "hra.tgz", sha256: "c".repeat(64), size: 7 }],
      commitSha: "a".repeat(40),
      run,
      tag: "v0.1.7",
      tagObjectSha: "b".repeat(40),
    } as const;
    const body = draftReleaseBody(input);
    expect(parseReleaseBody(body, input, "draft").createdAttempt).toBe(2);
    expect(() => parseReleaseBody(body, { ...input, commitSha: "d".repeat(40) }, "draft")).toThrow();
    expect(() => parseReleaseBody(body, { ...input, tagObjectSha: "e".repeat(40) }, "draft")).toThrow();
    expect(() => parseReleaseBody(body, { ...input, artifacts: [{ ...input.artifacts[0], size: 8 }] }, "draft")).toThrow();
    expect(() => parseReleaseBody(body, {
      ...input,
      run: { ...run, attempt: 3, id: "124" },
    }, "draft")).toThrow();
    const futureAttemptBody = draftReleaseBody({
      ...input,
      run: { ...run, attempt: 3 },
    });
    expect(() => parseReleaseBody(futureAttemptBody, input, "draft"))
      .toThrow("workflow-attempt ordering");
    expect(() => githubReleaseRun("v0.1.7", { ...source, GITHUB_RUN_ATTEMPT: "3", GITHUB_RUN_ID: "124" }))
      .not.toThrow();
  });

  test("publishes the exact transactional installer in the forward release notes", async () => {
    const [releaseNotes, readme, thirdPartyNotices] = await Promise.all([
      readFile(join(import.meta.dir, "..", "docs", "beta-release-notes.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "README.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "THIRD_PARTY_NOTICES.md"), "utf8"),
    ]);
    const installCommand = buildHraGlobalInstallCommand(HRA_INSTALL_ARCHIVE_URL);

    expect(releaseNotes).toContain(installCommand);
    expect(readme).toContain(installCommand);
    expect(releaseNotes).not.toContain("src/install-preflight.ts | bun -");
    expect(releaseNotes).not.toContain("bun add --global");
    expect(releaseNotes).not.toContain(
      'bun "$BUN_INSTALL_GLOBAL_DIR/node_modules/hra/src/install-normalizer.ts"',
    );
    expect(releaseNotes).toContain("Optional hosted encrypted sync is not yet live.");
    expect(releaseNotes).not.toContain("Cloud enrollment is invitation-only");
    expect(releaseNotes).not.toContain("artifact-identity SPDX");
    expect(releaseNotes).not.toContain("runtime SPDX inventory");
    expect(thirdPartyNotices).toContain("exact tarball plus `SHA256SUMS`");
    expect(thirdPartyNotices).not.toContain("SPDX");
  });

  test("keeps the retired fallback-bound path unreachable and exposes only the exact artifact workflow", async () => {
    const root = join(import.meta.dir, "..");
    const packageJson = asRecord(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
      "package manifest",
    );
    const scripts = asRecord(packageJson.scripts, "package scripts");
    const releaseWorkflow = join(root, ".github", "workflows", "release.yml");
    const [domainRecord, releaseRecord] = await Promise.all([
      readFile(join(root, "docs", "domain-cutover.md"), "utf8"),
      readFile(join(root, "docs", "beta-release.md"), "utf8"),
    ]);

    expect(await Bun.file(releaseWorkflow).exists()).toBeTrue();
    expect(scripts["hosted:domain-cutover"]).toBeUndefined();
    expect(scripts["release:candidate"]).toBeUndefined();
    expect(scripts["release:publish"]).toBeUndefined();
    expect(scripts["release:canonical-alias"]).toBeUndefined();
    expect(domainRecord).toContain("HRA v0 status: retired on 2026-08-27.");
    expect(domainRecord).toContain("current-project-only");
    expect(domainRecord).toContain("HRA v0 is never a fallback");
    expect(domainRecord).toContain("--confirm-exact");
    expect(domainRecord).toContain("canonical-alias-release");
    expect(domainRecord).toContain("unresolved_prior_intent");
    expect(domainRecord).toContain("reasserts only the plan's exact source");
    expect(domainRecord).toContain("unresolved_current_intent");
    expect(releaseRecord).toContain("Status: `v0.1.7` release-ready; immutable public `v0.1.6` remains the admitted release until exact `v0.1.7` admission.");
    expect(releaseRecord).toContain("At retirement, `hraness/hra` had no `v0.1.0` tag");
    expect(releaseRecord).toContain("## Immutable v0.1.0 failure record");
    expect(releaseRecord).toContain("Release workflow run `33363290345`, attempt 1");
    expect(releaseRecord).toContain("job `99398751969`");
    expect(releaseRecord).toContain("before registry-only package policy, tarball or checksum creation");
    expect(releaseRecord).toContain("The unexpanded exact-artifact matrix and the publish job were skipped");
    expect(releaseRecord).toContain("The publication variable was deleted after the failure");
    expect(releaseRecord).toContain("## Immutable v0.1.1 failure record");
    expect(releaseRecord).toContain("Release workflow run `33368241909`, attempt 1");
    expect(releaseRecord).toContain("artifact `9749194160`");
    expect(releaseRecord).toContain("`artifacts/SHA256SUMS`");
    expect(releaseRecord).toContain("rejected that extensionless workflow file as `UNREVIEWED_FILE_TYPE`");
    expect(releaseRecord).toContain("moved generated and downloaded release bytes under `RUNNER_TEMP`");
    expect(releaseRecord).toContain("immutable public registry release `@hraness/oh@0.2.7`");
    expect(releaseRecord).toContain("## Immutable v0.1.2 partial failure record");
    expect(releaseRecord).toContain("Release workflow run `33373504473`, attempts 1 and 2");
    expect(releaseRecord).toContain("immutable GitHub Release `379612601`");
    expect(releaseRecord).toContain("Registry readback proves `@hraness/hra@0.1.2` is absent");
    expect(releaseRecord).toContain("pins Node 24.20.0 with npm 11.19.0");
    expect(releaseRecord).toContain("proves the exact OIDC exchange before creating another GitHub Release");
    expect(releaseRecord).toContain("forwards numeric repository-owner identity");
    expect(releaseRecord).toContain("## Immutable v0.1.3 failure record");
    expect(releaseRecord).toContain("tag object `61ebcaf33616bc29675053465725bc294f06f9d2`");
    expect(releaseRecord).toContain("reviewed `main` commit `eef84596ec3891bcd29691d087449641dfda7e62`");
    expect(releaseRecord).toContain("Release workflow run `33411496909`, attempt 1");
    expect(releaseRecord).toContain("Actions artifact `9765501271`");
    expect(releaseRecord).toContain("`sha256:df1f40d36e19b92b92c8d6b256e49c7caa54ed5850bf353dec2c38995b3d449b`");
    expect(releaseRecord).toContain("651,739-byte tarball with SHA-256 `cd7847d3e7c7369f05ad35bb80372e7a648875fc2201b1490591f9028db549ed`");
    expect(releaseRecord).toContain("88-byte checksum file with SHA-256 `371394f881aa1f0ed692ccf287c277571f2e0e78892f84a1652b5d3fea540f6c`");
    expect(releaseRecord).toContain("Publish job `99553962517` stopped at `Prove npm trusted-publisher exchange without publication`");
    expect(releaseRecord).toContain("later GitHub Release, npm publication, and public-admission steps were skipped");
    expect(releaseRecord).toContain("no `v0.1.3` GitHub Release or draft and no npm `0.1.3` exist");
    expect(releaseRecord).toContain("`latest` and `bootstrap` still name `0.1.0-bootstrap.0`");
    expect(releaseRecord).toContain("The publication variable was deleted");
    expect(releaseRecord).toContain("legacy distributed-task path and the bounded current hosted-runner `/idtoken/` path");
    expect(releaseRecord).toContain("permits only one `api-version=2.0` query parameter");
    expect(releaseRecord).toContain("## Immutable v0.1.4 failure record");
    expect(releaseRecord).toContain("tag object `5c7e6add3062096c9545b10eaafddfd43f0b903e`");
    expect(releaseRecord).toContain("reviewed `main` commit `586f954945f614c00efd12f13a0d43c6f5bb809c`");
    expect(releaseRecord).toContain("Release workflow run `33417025171`, attempts 1 and 2");
    expect(releaseRecord).toContain("Actions artifact `9767593195`, named `hra-release-1`, is 652,281 bytes");
    expect(releaseRecord).toContain("`sha256:6816535110350f9bb3d43424caf05f04cc930481a64d9dd4917e0b8e4e7fa4b4`");
    expect(releaseRecord).toContain("expires at `2026-09-07T17:04:20Z`");
    expect(releaseRecord).toContain("651,736-byte tarball with SHA-256 `d9c80317a85139347ec482d7b811aef57045af8175c72cc21e259d0e23249784`");
    expect(releaseRecord).toContain("88-byte `SHA256SUMS` file with SHA-256 `2c67963d34862b06edb818c72644db08585d618d72c17baf3d531a9520dd1a1c`");
    expect(releaseRecord).toContain("Publish jobs `99572060480` and `99574351110`");
    expect(releaseRecord).toContain("with `trusted_exchange_not_proven`");
    expect(releaseRecord).toContain("both `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` to `/dev/null`");
    expect(releaseRecord).toContain("before initialization");
    expect(releaseRecord).toContain("no `v0.1.4` GitHub Release and no npm `0.1.4` exist");
    expect(releaseRecord).toContain("distinct private mode-`0600` user and global npm configuration files");
    expect(releaseRecord).toContain("fresh mode-`0700` directory");
    expect(releaseRecord).toContain("`publisher_configuration_failed`");
    expect(releaseRecord).toContain("`publisher_configuration_cleanup_failed`");
    expect(releaseRecord).toContain("`Successfully retrieved and set token`");
    expect(releaseRecord).toContain("## Immutable v0.1.5 successful release record");
    expect(releaseRecord).toContain("tag object `2503c4cccd52f4de9e8fb966f8050a08d26a3d06`");
    expect(releaseRecord).toContain("reviewed `main` commit `8e9b253bcebe07fc08289f033aaaeda6c574774d`");
    expect(releaseRecord).toContain("Release workflow run `33427625936`, attempts 1 and 2");
    expect(releaseRecord).toContain("Attempt 1 publish job `99607830579`");
    expect(releaseRecord).toContain("bounded post-publication verification request ended with `TimeoutError`");
    expect(releaseRecord).toContain("Attempt 2 publish job `99611394355`");
    expect(releaseRecord).toContain("skipped the first-publication OIDC dry run");
    expect(releaseRecord).toContain("Retained Actions artifact `9771995410`, named `hra-release-2`, is 652,272 bytes");
    expect(releaseRecord).toContain("`sha256:5e52442c02ee3fb8abee520df41a19e48ef9047f24eb6f160ece1686b2331efb`");
    expect(releaseRecord).toContain("expires at `2026-09-07T19:14:29Z`");
    expect(releaseRecord).toContain("GitHub asset `538406590` is the 651,736-byte `hraness-hra-0.1.5.tgz`");
    expect(releaseRecord).toContain("`48f579f8bee54dbf87ccd5f54ff5d4bf89abd9ba9025280344ad0fe9bfdc57c6`");
    expect(releaseRecord).toContain("asset `538406604` is the 88-byte `SHA256SUMS` file");
    expect(releaseRecord).toContain("`a947561b784a41473d5728dfcc96cc6e9d50ba7b542d0010faf3997a041a7091`");
    expect(releaseRecord).toContain("`sha512-Kv5JY5hbijho5MW79s7bygLb120pQ6RM8EV7aHycETK/hImL0/UQQuC9f72Vtgt4NSF39Glh1EVBFQXdddeGTw==`");
    expect(releaseRecord).toContain("`f598c36c331f87676382dfffd19907a8e9107b8f`");
    expect(releaseRecord).toContain("isolated public installation returned `hra-install-safe`");
    expect(releaseRecord).toContain("The publication variable remains absent");
    expect(releaseRecord).toContain("## Immutable v0.1.6 successful release record");
    expect(releaseRecord).toContain("tag object `f125f3dc3d77d41d905327faa1cf825e8f3b0b92`");
    expect(releaseRecord).toContain("reviewed `main` commit `b787e4d767d9bc95a70952e1002c150f5f33661c`");
    expect(releaseRecord).toContain("tree `f46d779d7c56cf011757471790b4c5cd72cf5747`");
    expect(releaseRecord).toContain("merged through PR 65");
    expect(releaseRecord).toContain("Exact-main CI run `33562319207` passed");
    expect(releaseRecord).toContain("Release workflow run `33562952832`, attempts 1 through 3");
    expect(releaseRecord).toContain("Attempt 1 verifier job `100039504965`");
    expect(releaseRecord).toContain("macOS job `100042411399`");
    expect(releaseRecord).toContain("Ubuntu job `100042411450`");
    expect(releaseRecord).toContain("publish job `100042677957`");
    expect(releaseRecord).toContain("HTTP 404 from npm's Sigstore attestations endpoint");
    expect(releaseRecord).toContain("Attempt 2 used verifier job `100043256132`");
    expect(releaseRecord).toContain("macOS job `100043256791`");
    expect(releaseRecord).toContain("Ubuntu job `100043256627`");
    expect(releaseRecord).toContain("publish job `100043256070`");
    expect(releaseRecord).toContain("stopped with `version_conflict`");
    expect(releaseRecord).toContain("Attempt 3 verifier job `100043668390`");
    expect(releaseRecord).toContain("macOS job `100045311262`");
    expect(releaseRecord).toContain("Ubuntu job `100045311412`");
    expect(releaseRecord).toContain("publish job `100045528708`");
    expect(releaseRecord).toContain("skipped the first-publication OIDC dry run");
    expect(releaseRecord).toContain("completed final public admission");
    expect(releaseRecord).toContain("Actions artifact `9822648569`, named `hra-release-3`, is 658,170 bytes");
    expect(releaseRecord).toContain("`sha256:4a4b8f796b3facba97b2ef1a92be916d21637060df48451044ac6b736cb464b3`");
    expect(releaseRecord).toContain("expires at `2026-09-08T22:08:27Z`");
    expect(releaseRecord).toContain("GitHub Release `380848789`");
    expect(releaseRecord).toContain("node `RE_kwDOUAyvX84Ws0qV`");
    expect(releaseRecord).toContain("asset `540202136`, the 657,619-byte `hraness-hra-0.1.6.tgz`");
    expect(releaseRecord).toContain("`c26a9352a8cefd032794a94c0c05c11319897890a78fa4c6e0eb6f2506635aca`");
    expect(releaseRecord).toContain("asset `540202181`, the 88-byte `SHA256SUMS` file");
    expect(releaseRecord).toContain("`de24d6c71005c7528562fff09200e529adfa119d4c1f469f46562931ceaf96c9`");
    expect(releaseRecord).toContain("npm `latest` names `@hraness/hra@0.1.6`");
    expect(releaseRecord).toContain("`sha512-Olb/QneV4Qy4oRabwINocuhakrJLOsm0omCHcFK5bkFqnzCNn5vYd0LplXTEtPxNe+yWqiSBHi+98v+6bLtbZQ==`");
    expect(releaseRecord).toContain("`a36bc66b0c727741c0306e695da8a13ce2104704`");
    expect(releaseRecord).toContain("provenance is present and independent download comparison is byte-identical");
    expect(releaseRecord).toContain("`v0.1.6` is the supported public CLI beta");
    expect(releaseRecord).toContain("Ordinary pull-request and `main` CI uses the same governed-history principle");
    expect(releaseRecord).toContain("unshallows only that exact commit into `refs/remotes/ci/verified`");
    expect(releaseRecord).toContain("The package gate still scans `rev-list --all`");
    expect(releaseRecord).toContain("coordinate completed its non-executable bootstrap");
    expect(releaseRecord).toContain("npm trusted publishing names repository `hraness/hra` and workflow `release.yml`");
    expect(releaseRecord).toContain("Stable `@hraness/hra@0.1.6` is authoritative after");
    expect(releaseRecord).toContain("Immutable local CLI release; hosted sync not yet live.");
    expect(releaseRecord).toContain("The website remains live and the `v0.1.7` local CLI tag stays release-ready until exact release admission");
    expect(releaseRecord).toContain("the install command names the `v0.1.7` GitHub Release and verified archive that admission will publish");
    expect(releaseRecord).toContain("Neither phase claims that hosted sync is available.");
    expect(releaseRecord).toContain("may create\none annotated stable-semver tag before or after");
    expect(releaseRecord).toContain("outer digest is a transport assertion, not independent release authority");
    expect(releaseRecord).toContain("`@hraness/hra@0.1.0-bootstrap.0`");
    expect(releaseRecord).toContain("npm also assigns `latest` to the first published version");
    expect(releaseRecord).toContain("resolves through both `bootstrap` and `latest`");
    expect(releaseRecord).toContain("Exact `0.1.6` publication moved `latest`");
    expect(releaseRecord).not.toContain("becomes authoritative only when");
    expect(releaseRecord).not.toContain("stays `release-ready` until exact release admission");
    expect(releaseRecord).not.toContain("publication will move `latest`");
    expect(releaseRecord).toContain("every earlier attempt's bounded GitHub Jobs API record");
    expect(releaseRecord).toContain("again immediately before the POST");
    expect(releaseRecord).toContain("`dist-tags.latest` to name `0.1.6`");
    expect(releaseRecord).toContain("`HRA_APPROVE_NPM_PUBLICATION=publish:@hraness/hra@0.1.7`");
    expect(releaseRecord).toContain("npm CLI 11.19.0");
    expect(releaseRecord).toContain("numeric owner ID\n`307125679`");
    expect(releaseRecord).toContain("owner ID `307125679`");
    const workflow = await readFile(releaseWorkflow, "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('npm pack --ignore-scripts --pack-destination "$release_artifacts" .');
    expect(workflow).toContain("release-artifact-checksum.ts");
    expect(workflow).toContain("check-release-package.ts");
    expect(workflow).toContain("check-npm-artifact-state.ts");
    expect(workflow).toContain("check-npm-trusted-publisher-oidc.ts");
    expect(workflow).toContain("publish-npm-release.ts");
    expect(workflow).toContain("publish-github-release.ts");
    expect(workflow).toContain("check-public-release.ts");
    expect(workflow).toContain("os: [ubuntu-24.04, macos-15]");
    expect(workflow).toContain("npm_preflight_run_attempt");
    expect(workflow).toContain("HRA_NPM_PREFLIGHT_RUN_ATTEMPT");
    expect(workflow).not.toContain("release-candidate.ts");
    expect(workflow).not.toContain("publish-beta-release.ts");
    for (const retired of [
      "publish-beta-release.ts",
      "publish-beta-release.test.ts",
      "release-candidate.ts",
      "release-candidate.test.ts",
    ]) expect(await Bun.file(join(import.meta.dir, retired)).exists()).toBeFalse();
    expect(workflow).not.toContain("hra-weld.vercel.app");
    expect(workflow).not.toContain("try-hra.vercel.app");
    expect(workflow).not.toContain("convex");
  });

  test("gives the public-text gate complete Git history in CI", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const document = asRecord(Bun.YAML.parse(workflow), "CI workflow");
    const jobs = asRecord(document.jobs, "CI workflow jobs");
    const check = asRecord(jobs.check, "CI check job");
    const required = asRecord(jobs.required, "CI required job");
    const steps = check.steps;

    if (!Array.isArray(steps)) {
      throw new TypeError("CI check job steps must be an array");
    }

    const parsedSteps = steps.map((step, index) => asRecord(step, `CI step ${index}`));
    expect(parsedSteps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string"))
      .toEqual([reviewedActions.checkout, reviewedActions.setupBun]);
    expect(parsedSteps.map((step) => step.name)).toEqual([
      "Check out source",
      "Fetch only governed CI history",
      "Install Bun",
      "Install dependencies",
      "Download pinned Zig 0.16.0 for authority supervisor (Linux)",
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "Enable isolated user namespaces for native custody checks",
      "Run the repository gate",
      "Restore Ubuntu user-namespace restriction",
    ]);
    const checkout = parsedSteps.find((step) => step.name === "Check out source");
    const fetch = parsedSteps.find((step) => step.name === "Fetch only governed CI history");
    const install = parsedSteps.find((step) => step.name === "Install dependencies");
    const gate = parsedSteps.find((step) => step.name === "Run the repository gate");

    const checkoutIndex = parsedSteps.indexOf(asRecord(checkout, "CI checkout step"));
    const fetchIndex = parsedSteps.indexOf(asRecord(fetch, "CI governed-history step"));
    const installIndex = parsedSteps.indexOf(asRecord(install, "CI install step"));
    expect(fetchIndex).toBe(checkoutIndex + 1);
    expect(installIndex).toBeGreaterThan(fetchIndex);
    expect(asRecord(checkout, "CI checkout step").with).toEqual({
      "fetch-depth": 1,
      "fetch-tags": false,
      "persist-credentials": false,
      ref: "${{ github.sha }}",
    });
    expect(asRecord(asRecord(fetch, "CI governed-history step").env, "CI governed-history environment").VERIFIED_SHA)
      .toBe("${{ github.sha }}");
    const governedHistory = String(asRecord(fetch, "CI governed-history step").run);
    expect(governedHistory).toContain('[[ ! "$VERIFIED_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(governedHistory).toContain("git fetch --force --no-tags --unshallow origin");
    expect(governedHistory).toContain('+$VERIFIED_SHA:refs/remotes/ci/verified');
    expect(governedHistory).toContain("git rev-parse --is-shallow-repository");
    expect(governedHistory).toContain("git rev-parse --verify 'HEAD^{commit}'");
    expect(governedHistory).toContain("git rev-parse --verify 'refs/remotes/ci/verified^{commit}'");
    expect(governedHistory).toContain("git for-each-ref --format='%(refname)'");
    expect(governedHistory).toContain("Unexpected ref entered governed CI history");
    expect(governedHistory).toContain("wc -l | tr -d ' '");
    expect(governedHistory).not.toContain("refs/heads/*");
    expect(governedHistory).not.toContain("github.head_ref");
    expect(governedHistory).not.toContain("pull_request.head.sha");
    expect(asRecord(install, "CI install step").run).toBe("bun install --frozen-lockfile --ignore-scripts");
    expect(asRecord(gate, "CI gate step").run).toBe("bun run check");
    // The gate already verifies generated public documents and runs the
    // Linux custody test through `bun test ./scripts`; CI does not repeat them.
    const packageScripts = asRecord(asRecord(
      JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8")),
      "package manifest",
    ).scripts, "package scripts");
    expect(String(packageScripts.check)).toContain("bun run build:site -- --check");
    expect(String(packageScripts.check)).toContain("bun run test");
    expect(String(packageScripts.test)).toContain("bun test ./scripts --isolate --max-concurrency=1");
    expect(workflow).not.toContain("build:site -- --check");
    expect(workflow).not.toContain("authority-supervisor-runtime.test.ts");

    expect(required.name).toBe("Required");
    expect(required.needs).toBe("check");
    expect(required.if).toBe("${{ always() }}");
    if (!Array.isArray(required.steps)) {
      throw new TypeError("CI required job steps must be an array");
    }
    const requiredStep = asRecord(required.steps[0], "CI required step");
    expect(requiredStep.name).toBe("Require every matrix check");
    expect(asRecord(requiredStep.env, "CI required environment").CHECK_RESULT)
      .toBe("${{ needs.check.result }}");
    expect(requiredStep.run).toBe('test "$CHECK_RESULT" = "success"');
  });

  test("admits only a tagged commit whose CI run concluded success before packaging", async () => {
    const source = await readFile(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    const workflow = asRecord(Bun.YAML.parse(source), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const verify = asRecord(jobs.verify, "release verify job");
    expect(asRecord(verify.permissions, "release verify permissions")).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(verify.env).toBeUndefined();
    if (!Array.isArray(verify.steps)) throw new TypeError("release verify steps must be an array");
    const steps = verify.steps.map((step, index) => asRecord(step, `verify step ${index}`));
    const identityIndex = steps.findIndex((step) => step.id === "identity");
    const readbackIndex = steps.findIndex((step) => step.name === "Require the exact commit's successful CI run");
    const packageIndex = steps.findIndex((step) => step.name === "Create one exact npm tarball and checksum");
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(readbackIndex).toBeGreaterThan(identityIndex);
    expect(packageIndex).toBeGreaterThan(readbackIndex);
    const readback = steps[readbackIndex];
    expect(readback?.if).toBeUndefined();
    expect(readback?.run).toBe("bun run ./scripts/check-commit-ci-run.ts");
    expect(asRecord(readback?.env, "CI readback environment")).toEqual({
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      GITHUB_TOKEN: "${{ github.token }}",
      VERIFIED_SHA: "${{ steps.identity.outputs.sha }}",
    });
    for (const step of steps) {
      if (step === readback) continue;
      const environment = step.env === undefined ? {} : asRecord(step.env, `${String(step.name)} environment`);
      expect(environment.GH_TOKEN, String(step.name)).toBeUndefined();
      expect(environment.GITHUB_TOKEN, String(step.name)).toBeUndefined();
    }

    const readbackSource = await readFile(join(import.meta.dir, "check-commit-ci-run.ts"), "utf8");
    expect(readbackSource).toContain('export const ciWorkflowPath = ".github/workflows/ci.yml"');
    expect(readbackSource).toContain('export const ciRequiredJobName = "Required"');
    expect(readbackSource).toContain("/actions/workflows/ci.yml/runs?");
    expect(readbackSource).toContain('run.status !== "completed"');
    expect(readbackSource).toContain('run.conclusion !== "success"');
    expect(readbackSource).toContain('job.conclusion !== "success"');
    expect(readbackSource).toContain("readBoundedJsonResponse(response, label, MAXIMUM_JSON_BYTES)");
    expect(readbackSource).not.toContain("gh api");
    expect(readbackSource).not.toContain("response.json()");
  });

  test("pins the privileged release TCB and scopes GitHub tokens to exact steps", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    )), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const publish = asRecord(jobs.publish, "release publish job");
    expect(asRecord(publish.permissions, "release publish permissions")).toEqual({
      actions: "read",
      contents: "write",
      "id-token": "write",
    });
    const jobEnvironment = asRecord(publish.env, "release publish environment");
    expect(jobEnvironment.GH_TOKEN).toBeUndefined();
    expect(jobEnvironment.GITHUB_TOKEN).toBeUndefined();

    if (!Array.isArray(publish.steps)) {
      throw new TypeError("release publish job steps must be an array");
    }
    const steps = publish.steps.map((step, index) => asRecord(step, `release publish step ${index}`));
    expect(steps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string"))
      .toEqual([
        reviewedActions.checkout,
        reviewedActions.setupBun,
        reviewedActions.setupNode,
        reviewedActions.downloadArtifact,
      ]);

    for (const step of steps.filter((candidate) => candidate.uses === reviewedActions.setupNode)) {
      expect(asRecord(step.with, "release setup-node inputs")).toEqual({
        "node-version": "24.20.0",
        "package-manager-cache": false,
      });
    }

    const tokenEnvironments = Object.fromEntries(steps.map((step) => {
      const environment = step.env === undefined
        ? {}
        : asRecord(step.env, `${String(step.name)} environment`);
      return [String(step.name), Object.fromEntries(Object.entries({
        GH_TOKEN: environment.GH_TOKEN,
        GITHUB_TOKEN: environment.GITHUB_TOKEN,
      }).filter((entry) => entry[1] !== undefined))];
    }));
    expect(tokenEnvironments).toEqual({
      "Check out verified source with complete history": {},
      "Fetch only governed release history": {},
      "Install Bun": {},
      "Install Node and npm trusted-publishing client": {},
      "Install exact locked dependencies without lifecycle scripts": {},
      "Require registry readiness and trusted publishing support": {},
      "Require exact artifact identity": {},
      "Download validated release bytes": {},
      "Revalidate remote authority and checksum": { GH_TOKEN: "${{ github.token }}" },
      "Prove npm trusted-publisher exchange without publication": {},
      "Publish exact tarball through npm trusted publishing": {},
      "Create immutable GitHub Release from the same bytes": { GH_TOKEN: "${{ github.token }}" },
      "Admit exact public npm and GitHub state": { GITHUB_TOKEN: "${{ github.token }}" },
    });
  });

  test("binds every artifact consumer to the verify attempt's numeric artifact identity", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    )), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const verify = asRecord(jobs.verify, "release verify job");
    const verifyOutputs = asRecord(verify.outputs, "release verify outputs");
    expect(verifyOutputs.artifact_id).toBe("${{ steps.release_artifact.outputs.artifact-id }}");
    expect(verifyOutputs.artifact_digest)
      .toBe("${{ steps.release_artifact.outputs.artifact-digest }}");
    if (!Array.isArray(verify.steps)) throw new TypeError("release verify steps must be an array");
    const verifySteps = verify.steps.map((step, index) => asRecord(step, `verify step ${index}`));
    const upload = verifySteps.find((step) => step.name === "Preserve exact release bytes");
    expect(upload?.id).toBe("release_artifact");
    expect(upload?.uses).toBe(reviewedActions.uploadArtifact);
    const uploadInputs = asRecord(upload?.with, "release artifact upload inputs");
    expect(uploadInputs.name).toBe("hra-release-${{ github.run_attempt }}");
    expect(uploadInputs.path).toBe("${{ runner.temp }}/hra-release-artifacts/");

    for (const jobName of ["exact_artifact", "publish"] as const) {
      const job = asRecord(jobs[jobName], `${jobName} job`);
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} steps must be an array`);
      const steps = job.steps.map((step, index) => asRecord(step, `${jobName} step ${index}`));
      const requireIdentityIndex = steps.findIndex((step) => step.name === "Require exact artifact identity");
      const downloadIndex = steps.findIndex((step) => step.uses === reviewedActions.downloadArtifact);
      expect(requireIdentityIndex).toBeGreaterThanOrEqual(0);
      expect(downloadIndex).toBeGreaterThan(requireIdentityIndex);
      const identity = steps[requireIdentityIndex];
      const environment = asRecord(identity?.env, `${jobName} artifact identity environment`);
      expect(environment).toEqual({
        VERIFIED_ARTIFACT_DIGEST: "${{ needs.verify.outputs.artifact_digest }}",
        VERIFIED_ARTIFACT_ID: "${{ needs.verify.outputs.artifact_id }}",
      });
      expect(identity?.run).toContain('[[ "$VERIFIED_ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]');
      expect(identity?.run).toContain('[[ "$VERIFIED_ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]');
      const download = steps[downloadIndex];
      const inputs = asRecord(download?.with, `${jobName} artifact download inputs`);
      expect(inputs).toEqual({
        "artifact-ids": "${{ needs.verify.outputs.artifact_id }}",
        "merge-multiple": true,
        path: "${{ runner.temp }}/hra-release-artifacts",
      });
      expect(inputs.name).toBeUndefined();
    }
  });

  test("keeps generated and downloaded release artifacts outside the checked-out public tree", async () => {
    const workflowSource = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    const workflow = asRecord(Bun.YAML.parse(workflowSource), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const stepsFor = (jobName: string): readonly Record<string, unknown>[] => {
      const job = asRecord(jobs[jobName], `${jobName} job`);
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} steps must be an array`);
      return job.steps.map((step, index) => asRecord(step, `${jobName} step ${index}`));
    };
    const stepFor = (jobName: string, stepName: string): Record<string, unknown> => {
      const matching = stepsFor(jobName).filter((step) => step.name === stepName);
      expect(matching).toHaveLength(1);
      return matching[0]!;
    };
    const runFor = (jobName: string, stepName: string): string => {
      const run = stepFor(jobName, stepName).run;
      if (typeof run !== "string") throw new TypeError(`${jobName} ${stepName} must have a run command`);
      return run;
    };
    const exactShellRoot = "$RUNNER_TEMP/hra-release-artifacts";
    const exactActionRoot = "${{ runner.temp }}/hra-release-artifacts";
    const assertOutsideCheckout = (command: string): void => {
      expect(command).not.toContain("$GITHUB_WORKSPACE");
      expect(command).not.toContain("${{ github.workspace }}");
      expect(command).not.toMatch(/(?:^|[\s"'=])artifacts(?:\/|[\s"']|$)/mu);
      expect(command).toContain(exactShellRoot);
    };

    const producer = runFor("verify", "Create one exact npm tarball and checksum");
    assertOutsideCheckout(producer);
    expect(producer).toContain(`release_artifacts="${exactShellRoot}"`);
    expect(producer).toContain('mkdir "$release_artifacts"');
    expect(producer).not.toContain('mkdir -p "$release_artifacts"');
    expect(producer).toContain('npm pack --ignore-scripts --pack-destination "$release_artifacts" .');
    expect(producer).toContain('"$release_artifacts/SHA256SUMS"');

    const preflight = runFor("verify", "Record exact npm registry preflight");
    assertOutsideCheckout(preflight);
    expect(preflight).toContain(`find "${exactShellRoot}"`);
    expect(asRecord(
      stepFor("verify", "Preserve exact release bytes").with,
      "release artifact upload inputs",
    ).path).toBe(`${exactActionRoot}/`);

    const exactCheck = runFor("exact_artifact", "Verify checksum and complete installed-package behavior");
    assertOutsideCheckout(exactCheck);
    expect(exactCheck).toContain(`find "${exactShellRoot}"`);
    expect(exactCheck).toContain(`"${exactShellRoot}/SHA256SUMS"`);
    expect(exactCheck).toContain('bun run ./scripts/check-package.ts "$artifact"');

    for (const stepName of [
      "Revalidate remote authority and checksum",
      "Create immutable GitHub Release from the same bytes",
      "Publish exact tarball through npm trusted publishing",
    ] as const) {
      const command = runFor("publish", stepName);
      assertOutsideCheckout(command);
      expect(command).toContain(`find "${exactShellRoot}"`);
    }
    expect(runFor("publish", "Revalidate remote authority and checksum"))
      .toContain(`"${exactShellRoot}/SHA256SUMS"`);
    expect(runFor("publish", "Create immutable GitHub Release from the same bytes"))
      .toContain(`"${exactShellRoot}/SHA256SUMS"`);

    for (const [jobName, stepName] of [
      ["exact_artifact", "Download exact release bytes"],
      ["publish", "Download validated release bytes"],
    ] as const) {
      expect(asRecord(stepFor(jobName, stepName).with, `${jobName} artifact download inputs`).path)
        .toBe(exactActionRoot);
    }

    expect(workflowSource).not.toContain("$GITHUB_WORKSPACE/artifacts");
    expect(workflowSource).not.toContain("path: artifacts");
  });

  test("completes only one exact residual GitHub draft without substituting bytes", async () => {
    const [publisher, admission] = await Promise.all([
      readFile(join(import.meta.dir, "publish-github-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "check-public-release.ts"), "utf8"),
    ]);
    expect(publisher.match(/verifyRemoteAnnotatedTag\(\);/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(publisher).toContain("parseGitHubIncludedJsonResponse(result.stdout)");
    expect(publisher).toContain('"-F", "draft=true"');
    expect(publisher).toContain("exactDraft");
    expect(publisher).toContain("matchingDraftIds");
    expect(publisher).toContain("verifyDraftAssets");
    expect(publisher).toContain("parseReleaseInventoryPage(projection, releaseTag)");
    expect(publisher).toContain("ten-page recovery bound");
    expect(publisher).toContain("Multiple residual drafts exist");
    expect(publisher).toContain("waitForCreatedDraftInventory(created.id)");
    expect(publisher).toContain("waitForPublishedDraftInventory(publishedReleaseId)");
    expect(publisher).toContain("waitForLaterAttemptProviderState()");
    expect(publisher).toContain("priorAttemptProvesNoDraftCreation(jobs");
    expect(publisher).toContain("process.env.GITHUB_SHA !== releaseIdentity.commitSha");
    expect(publisher.match(/currentAttemptCanCreateDraft\(\)/gu)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(publisher).toContain("GitHub Release provider state changed before draft creation");
    const providerSnapshotIndex = publisher.indexOf("let initialDraftIds = matchingDraftIds()");
    const priorMutationIndex = publisher.indexOf("const priorMayHaveCreated = releaseRun.attempt > 1");
    const laterConvergenceIndex = publisher.indexOf("if (priorMayHaveCreated)", priorMutationIndex);
    const directDraftIndex = publisher.indexOf('else if (lookup.state === "draft")', laterConvergenceIndex);
    expect(providerSnapshotIndex).toBeGreaterThan(-1);
    expect(priorMutationIndex).toBeGreaterThan(providerSnapshotIndex);
    expect(laterConvergenceIndex).toBeGreaterThan(priorMutationIndex);
    expect(directDraftIndex).toBeGreaterThan(laterConvergenceIndex);
    expect(publisher.slice(laterConvergenceIndex, directDraftIndex))
      .toContain("await waitForLaterAttemptProviderState()");
    const convergenceStart = publisher.indexOf("async function waitForLaterAttemptProviderState");
    const convergenceEnd = publisher.indexOf("function completeDraftAssets", convergenceStart);
    const convergence = publisher.slice(convergenceStart, convergenceEnd);
    expect(convergence).toContain("for (;;)");
    expect(convergence.indexOf("readReleaseTagLookup()"))
      .toBeLessThan(convergence.indexOf("matchingDraftIds()"));
    expect(convergence).toContain("classifyCreatedDraftInventory(draftIds, draft.id)");
    expect(convergence).toContain("classifyPublishedDraftInventory(draftIds, id)");
    const createStart = publisher.indexOf("async function createDraft");
    const createEnd = publisher.indexOf("async function verifyPublishedRelease", createStart);
    const create = publisher.slice(createStart, createEnd);
    expect(create.indexOf("currentAttemptCanCreateDraft()"))
      .toBeLessThan(create.indexOf("readReleaseTagLookup()"));
    expect(create.indexOf("readReleaseTagLookup()"))
      .toBeLessThan(create.indexOf('"gh", "api", "--method", "POST"'));
    expect(publisher).toContain("assertNoResidualDraft();");
    expect(publisher).toContain("remains after immutable publication");
    expect(publisher).toContain("contains ambiguous assets");
    expect(publisher).toContain("has different immutable metadata");
    expect(publisher).toContain("has different bytes");
    expect(publisher).toContain('"--header", "Content-Type: application/octet-stream"');
    expect(publisher).toContain('"--input", source');
    expect(publisher).toContain("https://uploads.github.com/repos/${publicRepository}/releases/${String(draft.id)}/assets?name=${encodeURIComponent(name)}");
    expect(publisher).toContain("readExactDraftById(draft.id)");
    expect(publisher).not.toContain('"gh", "release", "upload"');
    expect(publisher).toContain('"-F", "draft=false", "-F", "prerelease=false", "-f", "make_latest=true"');
    expect(publisher).toContain("parseGitHubRelease(published, inspection.version)");
    expect(publisher).toContain("const publishedBody = publishedReleaseBody(releaseIdentity, draft.createdAttempt)");
    expect(publisher).toContain("published.body !== publishedBody");
    expect(publisher).toContain("releaseId(release(), `Tag-resolved GitHub Release ${tag}`) !== expectedId");
    expect(publisher).toContain("releaseId(latest, \"Latest GitHub Release\") !== publishedReleaseId");
    expect(publisher.indexOf("assertNoResidualDraft();"))
      .toBeGreaterThan(publisher.indexOf("await verifyPublishedRelease(publishedReleaseId);"));
    expect(publisher).toContain("env: githubPublisherEnvironment(process.env)");
    expect(publisher).not.toContain("...process.env");
    expect(publisher).not.toContain("--target");
    expect(publisher).not.toContain("target_commitish");
    expect(publisher).not.toContain("--generate-notes");
    expect(publisher).toContain("const verifiedTagObject = process.env.VERIFIED_TAG_OBJECT");
    expect(publisher).toContain("tagObject.sha !== verifiedTagObject");
    expect(publisher).toContain("/git/tags/${verifiedTagObject}");
    expect(publisher).toContain("/compare/${releaseCommitSha}...${headSha}");
    expect(publisher).toContain("assertReviewedReleaseCommitOnStableBranch(comparison, finalHead");
    expect(publisher).not.toContain("comparison.head_commit");
    const branchRead = "/git/ref/heads/${releaseDefaultBranch}";
    const firstBranchReadIndex = publisher.indexOf(branchRead);
    const compareIndex = publisher.indexOf("/compare/${releaseCommitSha}...${headSha}");
    const finalBranchReadIndex = publisher.lastIndexOf(branchRead);
    expect(publisher.match(/\/git\/ref\/heads\/\$\{releaseDefaultBranch\}/gu)?.length).toBe(2);
    expect(firstBranchReadIndex).toBeGreaterThanOrEqual(0);
    expect(compareIndex).toBeGreaterThan(firstBranchReadIndex);
    expect(finalBranchReadIndex).toBeGreaterThan(compareIndex);
    expect(admission).toContain('environment("VERIFIED_TAG_OBJECT", /^[0-9a-f]{40}$/u)');
    expect(admission).toContain("tagRef.object.sha !== verifiedTagObject");
    expect(admission).toContain("`${api}/git/tags/${verifiedTagObject}`");
  });

  test("publishes and proves GitHub identity before consuming the npm version", async () => {
    const workflow = await readFile(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    const oidcPreflightIndex = workflow.indexOf("Prove npm trusted-publisher exchange without publication");
    const githubIndex = workflow.indexOf("Create immutable GitHub Release from the same bytes");
    const npmIndex = workflow.indexOf("Publish exact tarball through npm trusted publishing");
    const admissionIndex = workflow.indexOf("Admit exact public npm and GitHub state");
    expect(oidcPreflightIndex).toBeGreaterThan(0);
    expect(githubIndex).toBeGreaterThan(oidcPreflightIndex);
    expect(npmIndex).toBeGreaterThan(githubIndex);
    expect(admissionIndex).toBeGreaterThan(npmIndex);
    expect(workflow).toContain("if: needs.verify.outputs.npm_preflight_state == 'absent'");
    expect(workflow).toContain("check-npm-trusted-publisher-oidc.ts");
  });
});
