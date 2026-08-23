import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

describe("release workflow", () => {
  test("binds the artifact-only draft job to the exact repository", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    const document = asRecord(Bun.YAML.parse(workflow), "release workflow");
    const jobs = asRecord(document.jobs, "release workflow jobs");
    const verify = asRecord(jobs.verify, "verify job");
    const stage = asRecord(jobs.stage, "stage job");
    const steps = stage.steps;

    if (!Array.isArray(steps)) {
      throw new TypeError("stage job steps must be an array");
    }

    const createRelease = steps
      .map((step, index) => asRecord(step, `stage step ${index}`))
      .find((step) => step.name === "Create or resume the accepted release draft");

    expect(createRelease).toBeDefined();
    const releaseStep = asRecord(createRelease, "GitHub release step");
    const environment = asRecord(releaseStep.env, "GitHub release environment");

    expect(stage.needs).toBe("verify");
    expect(environment.GH_REPO).toBe("${{ github.repository }}");
    expect(environment.GH_TOKEN).toBe("${{ github.token }}");
    expect(releaseStep.run).toContain(
      'gh release create "$GITHUB_REF_NAME"',
    );
    expect(releaseStep.run).toContain('tag_commit="$(gh api "repos/$GH_REPO/commits/refs/tags/$GITHUB_REF_NAME"');
    expect(releaseStep.run).toContain('main_commit="$(gh api "repos/$GH_REPO/git/ref/heads/main"');
    expect(releaseStep.run).toContain('test "$main_commit" = "$accepted_commit"');
    expect(releaseStep.run).toContain('test "$accepted_commit" = "$GITHUB_SHA"');
    expect(releaseStep.run).toContain("https://hra.sh/.well-known/hra.json?release-check=");
    expect(releaseStep.run).not.toContain("--location");
    expect(releaseStep.run).toContain("--write-out '%{http_code}'");
    expect(releaseStep.run).toContain('test "$marker_status" = 200');
    expect(releaseStep.run).toContain("'Cache-Control: no-cache, no-store, max-age=0'");
    expect(releaseStep.run).toContain(".schemaVersion == 2");
    expect(releaseStep.run).toContain(".generation == 1");
    expect(releaseStep.run).toContain(".repository.id == 1343008607");
    expect(releaseStep.run).toContain('.repository.path == "hraness/hra"');
    expect(releaseStep.run).toContain('.source.commit == $commit');
    expect(releaseStep.run).toContain("--prerelease");
    expect(releaseStep.run).toContain("--draft");
    expect(releaseStep.run).toContain("--notes-file release/RELEASE_NOTES.md");
    expect(releaseStep.run).toContain("--jq '.immutable')\" = false");
    expect(releaseStep.run).toContain('gh release upload "$GITHUB_REF_NAME"');
    expect(releaseStep.run).toContain("--clobber");
    expect(releaseStep.run).not.toContain("--generate-notes");
    expect(releaseStep.run).not.toContain("release/*");
    const stageSteps = steps.map((step, index) => asRecord(step, `stage step ${index}`));
    const stagedDraft = stageSteps.find((step) =>
      step.name === "Read back the staged draft assets");
    expect(stagedDraft?.run).toContain("shasum -a 256 -c SHA256SUMS");
    expect(stagedDraft?.run).toContain("= 4");
    expect(stagedDraft?.run).toContain(".artifact.spdx.json");
    expect(stagedDraft?.run).toContain(".ubuntu-24.04-x64.runtime.spdx.json");
    expect(stagedDraft?.run).toContain('test "$tag_commit" = "$accepted_commit"');
    expect(stagedDraft?.run).toContain('commits/refs/tags/$GITHUB_REF_NAME');
    expect(stagedDraft?.run).toContain('test "$main_commit" = "$accepted_commit"');
    expect(stagedDraft?.run).toContain("canonical-marker-publish.json");
    expect(stagedDraft?.run).toContain("--jq '.immutable')\" = false");
    expect(stagedDraft?.run).toContain('.source.commit == $commit');
    expect(stagedDraft?.run).not.toContain("immutable-releases");
    expect(stagedDraft?.run).not.toContain("--draft=false");
    expect(jobs.publish).toBeUndefined();
    expect(jobs.accept).toBeUndefined();

    if (!Array.isArray(verify.steps)) {
      throw new TypeError("verify job steps must be an array");
    }
    const verifySteps = verify.steps.map((step, index) => asRecord(step, `verify step ${index}`));
    const checkout = verifySteps.find((step) => step.name === "Check out the tagged source");
    const exactHead = verifySteps.find((step) => step.name === "Verify exact release head and ordering");
    const generated = verifySteps.find((step) => step.name === "Verify generated public documents");
    const availability = verifySteps.find((step) =>
      step.name === "Verify public release availability");
    const packedInstall = verifySteps.find((step) =>
      step.name === "Accept the exact packed installation");
    const artifactSbom = verifySteps.find((step) =>
      step.name === "Generate the artifact identity SPDX SBOM");
    const artifactSbomVerification = verifySteps.find((step) =>
      step.name === "Verify the artifact identity SPDX SBOM");
    const runtimeSbom = verifySteps.find((step) =>
      step.name === "Generate the Ubuntu 24.04 x64 runtime SPDX SBOM");
    const runtimeSbomVerification = verifySteps.find((step) =>
      step.name === "Verify the Ubuntu 24.04 x64 runtime SPDX SBOM");
    const releaseMetadata = verifySteps.find((step) =>
      step.name === "Preserve the reviewed release metadata");
    expect(asRecord(checkout, "release checkout step").with).toEqual({ "fetch-depth": 0 });
    expect(exactHead?.run).toContain("tagged_commit=\"$(git rev-parse \"refs/tags/$GITHUB_REF_NAME^{commit}\")\"");
    expect(workflow).not.toContain('commits/$GITHUB_REF_NAME');
    expect(exactHead?.run).toContain("test \"$tagged_commit\" = \"$main_commit\"");
    expect(exactHead?.run).not.toContain("merge-base --is-ancestor");
    expect(asRecord(generated, "release generated-documents step").run)
      .toBe("bun run build:site -- --check");
    expect(availability?.run).toContain('publicReleaseState !== "release-ready"');
    expect(availability?.run).toContain('endpoints.hostedSync !== "live"');
    expect(packedInstall?.run).toContain("./release/hra-${GITHUB_REF_NAME}.tgz");
    expect(packedInstall?.run).toContain("check-installed-package.ts");
    expect(packedInstall?.run).not.toContain("github:${GITHUB_REPOSITORY}");
    const artifactSbomStep = asRecord(artifactSbom, "artifact identity SBOM step");
    const artifactSbomWith = asRecord(
      artifactSbomStep.with,
      "artifact identity SBOM inputs",
    );
    expect(artifactSbomWith.file).toBe("release/hra-${{ github.ref_name }}.tgz");
    expect(artifactSbomWith.path).toBeUndefined();
    expect(artifactSbomWith["output-file"]).toContain(".artifact.spdx.json");
    expect(asRecord(artifactSbomStep.env, "artifact identity SBOM environment"))
      .toMatchObject({ SYFT_SOURCE_NAME: "hra", SYFT_SOURCE_VERSION: "${{ env.HRA_RELEASE_VERSION }}" });
    expect(artifactSbomVerification?.run).toContain("artifact SPDX checksum does not bind the tarball");
    const runtimeSbomStep = asRecord(runtimeSbom, "runtime SBOM step");
    const runtimeSbomWith = asRecord(runtimeSbomStep.with, "runtime SBOM inputs");
    expect(runtimeSbomWith.path).toBe("${{ runner.temp }}/hra-global/install/global/node_modules");
    expect(runtimeSbomWith.config).toBe(".github/syft-runtime.yaml");
    expect(runtimeSbomWith.file).toBeUndefined();
    expect(runtimeSbomWith["output-file"]).toContain(".ubuntu-24.04-x64.runtime.spdx.json");
    expect(runtimeSbomVerification?.run).toContain('["@openai/codex", "0.149.0"]');
    expect(runtimeSbomVerification?.run).toContain('["convex", "1.45.0"]');
    expect(runtimeSbomVerification?.run).toContain('["zod", "4.4.3"]');
    expect(releaseMetadata?.run).toContain('Bun.file("docs/beta-release-notes.md")');
    expect(releaseMetadata?.run).toContain("git rev-parse 'HEAD^{commit}' > release/RELEASE_COMMIT");

    const syftConfig = await readFile(join(import.meta.dir, "..", ".github", "syft-runtime.yaml"), "utf8");
    expect(Bun.YAML.parse(syftConfig)).toEqual({
      "select-catalogers": ["+javascript-package-cataloger"],
    });
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
});
