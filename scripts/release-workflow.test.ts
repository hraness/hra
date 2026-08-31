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
      "/scripts/bounded-json-response.ts",
      "/scripts/publish-github-release.ts",
      "/scripts/publish-npm-release.ts",
      "/scripts/verify-npm-provenance-crypto.mjs",
      "/scripts/verify-npm-provenance.ts",
    ]) expect(codeowners).toContain(`${path} @0thernet`);
  });

  test("bounds every npm metadata read and aligns GitHub artifact output with package policy", async () => {
    const [preflight, npmPublisher, githubPublisher] = await Promise.all([
      readFile(join(import.meta.dir, "check-npm-artifact-state.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-npm-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-github-release.ts"), "utf8"),
    ]);
    expect(preflight).toContain("readBoundedJsonResponse(response, \"npm registry exact release\")");
    expect(npmPublisher).toContain("readBoundedJsonResponse(response, \"npm registry exact release\")");
    expect(preflight).not.toContain("response.json()");
    expect(npmPublisher).not.toContain("response.json()");
    expect(githubPublisher).toContain("const maximumArtifactBytes = 64 * 1024 * 1024");
    expect(githubPublisher).toContain("maxBuffer: maximumStdoutBytes + 1");
    expect(githubPublisher.match(/false, maximumArtifactBytes\)\.stdout/gu)?.length).toBe(2);
    expect(githubPublisher).not.toContain("maxBuffer: 32 * 1_024 * 1_024");
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

  test("binds residual draft identity to the exact same run and artifact authority", () => {
    const source = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v0.1.0",
      GITHUB_REF_NAME: "v0.1.0",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REPOSITORY: "hraness/hra",
      GITHUB_REPOSITORY_ID: "1343008607",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123",
      GITHUB_WORKFLOW_REF: "hraness/hra/.github/workflows/release.yml@refs/tags/v0.1.0",
    };
    const run = githubReleaseRun("v0.1.0", source);
    const input = {
      artifacts: [{ name: "hra.tgz", sha256: "c".repeat(64), size: 7 }],
      commitSha: "a".repeat(40),
      run,
      tag: "v0.1.0",
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
    expect(() => githubReleaseRun("v0.1.0", { ...source, GITHUB_RUN_ATTEMPT: "3", GITHUB_RUN_ID: "124" }))
      .not.toThrow();
  });

  test("publishes the exact transactional installer in the historical release notes", async () => {
    const [releaseNotes, readme] = await Promise.all([
      readFile(join(import.meta.dir, "..", "docs", "beta-release-notes.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "README.md"), "utf8"),
    ]);
    const installCommand = buildHraGlobalInstallCommand(HRA_INSTALL_ARCHIVE_URL);

    expect(releaseNotes).toContain(installCommand);
    expect(readme).toContain(installCommand);
    expect(releaseNotes).not.toContain("src/install-preflight.ts | bun -");
    expect(releaseNotes).not.toContain("bun add --global");
    expect(releaseNotes).not.toContain(
      'bun "$BUN_INSTALL_GLOBAL_DIR/node_modules/hra/src/install-normalizer.ts"',
    );
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
    expect(scripts["release:canonical-alias"])
      .toBe("bun ./scripts/current-project-alias-release.ts");
    expect(domainRecord).toContain("HRA v0 status: retired on 2026-08-27.");
    expect(domainRecord).toContain("current-project-only");
    expect(domainRecord).toContain("HRA v0 is never a fallback");
    expect(domainRecord).toContain("--confirm-exact");
    expect(domainRecord).toContain("canonical-alias-release");
    expect(domainRecord).toContain("unresolved_prior_intent");
    expect(domainRecord).toContain("reasserts only the plan's exact source");
    expect(domainRecord).toContain("unresolved_current_intent");
    expect(releaseRecord).toContain("Status: prepared but blocked before publication.");
    expect(releaseRecord).toContain("no `v0.1.0` tag");
    expect(releaseRecord).toContain("GitHub `@hraness/oh#v0.2.0` runtime dependency");
    expect(releaseRecord).toContain("exact registry version `0.2.4`");
    expect(releaseRecord).toContain("may create\none annotated stable-semver tag before or after");
    expect(releaseRecord).toContain("outer digest is a transport assertion, not independent release authority");
    expect(releaseRecord).toContain("`@hraness/hra@0.1.0-bootstrap.0`");
    expect(releaseRecord).toContain("`HRA_APPROVE_NPM_PUBLICATION=publish:@hraness/hra@0.1.0`");
    expect(releaseRecord).toContain("npm CLI 11.15.0 or newer");
    const workflow = await readFile(releaseWorkflow, "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm pack --ignore-scripts --pack-destination artifacts .");
    expect(workflow).toContain("release-artifact-checksum.ts");
    expect(workflow).toContain("check-release-package.ts");
    expect(workflow).toContain("check-npm-artifact-state.ts");
    expect(workflow).toContain("publish-npm-release.ts");
    expect(workflow).toContain("publish-github-release.ts");
    expect(workflow).toContain("check-public-release.ts");
    expect(workflow).toContain("os: [ubuntu-24.04, macos-15]");
    expect(workflow).toContain("npm_preflight_run_attempt");
    expect(workflow).toContain("HRA_NPM_PREFLIGHT_RUN_ATTEMPT");
    expect(workflow).not.toContain("release-candidate.ts");
    expect(workflow).not.toContain("publish-beta-release.ts");
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
    const checkout = parsedSteps.find((step) => step.name === "Check out source");
    const install = parsedSteps.find((step) => step.name === "Install dependencies");
    const generated = parsedSteps.find((step) => step.name === "Verify generated public documents");
    const gate = parsedSteps.find((step) => step.name === "Run the repository gate");

    expect(asRecord(checkout, "CI checkout step").with).toEqual({ "fetch-depth": 0 });
    expect(asRecord(install, "CI install step").run).toBe("bun install --frozen-lockfile --ignore-scripts");
    expect(asRecord(generated, "CI generated-documents step").run).toBe("bun run build:site -- --check");
    expect(asRecord(gate, "CI gate step").run).toBe("bun run check");

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

  test("pins the privileged release TCB and scopes GitHub tokens to exact steps", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    )), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const publish = asRecord(jobs.publish, "release publish job");
    expect(asRecord(publish.permissions, "release publish permissions")).toEqual({
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
      "Install Bun": {},
      "Install Node and npm trusted-publishing client": {},
      "Install exact locked dependencies without lifecycle scripts": {},
      "Require registry readiness and trusted publishing support": {},
      "Require exact artifact identity": {},
      "Download validated release bytes": {},
      "Revalidate remote authority and checksum": { GH_TOKEN: "${{ github.token }}" },
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
        path: "artifacts",
      });
      expect(inputs.name).toBeUndefined();
    }
  });

  test("completes only one exact residual GitHub draft without substituting bytes", async () => {
    const [publisher, admission] = await Promise.all([
      readFile(join(import.meta.dir, "publish-github-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "check-public-release.ts"), "utf8"),
    ]);
    expect(publisher.match(/verifyRemoteAnnotatedTag\(\);/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(publisher).toContain("parseGitHubIncludedJsonResponse(existing.stdout)");
    expect(publisher).toContain('"-F", "draft=true"');
    expect(publisher).toContain("exactDraft");
    expect(publisher).toContain("findDraft");
    expect(publisher).toContain("verifyDraftAssets");
    expect(publisher).toContain("inventory.length >= 100");
    expect(publisher).toContain("Multiple residual drafts exist");
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
    expect(admission).toContain('environment("VERIFIED_TAG_OBJECT", /^[0-9a-f]{40}$/u)');
    expect(admission).toContain("tagRef.object.sha !== verifiedTagObject");
    expect(admission).toContain("`${api}/git/tags/${verifiedTagObject}`");
  });

  test("publishes and proves GitHub identity before consuming the npm version", async () => {
    const workflow = await readFile(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    const githubIndex = workflow.indexOf("Create immutable GitHub Release from the same bytes");
    const npmIndex = workflow.indexOf("Publish exact tarball through npm trusted publishing");
    const admissionIndex = workflow.indexOf("Admit exact public npm and GitHub state");
    expect(githubIndex).toBeGreaterThan(0);
    expect(npmIndex).toBeGreaterThan(githubIndex);
    expect(admissionIndex).toBeGreaterThan(npmIndex);
  });
});
