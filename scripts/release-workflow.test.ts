import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildHraGlobalInstallCommand,
  HRA_INSTALL_ARCHIVE_URL,
} from "../src/install-preflight";

const reviewedActions = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  downloadArtifact: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  sbom: "anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610",
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  uploadArtifact: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
} as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

describe("release workflow", () => {
  test("publishes the exact transactional installer in the immutable release notes", async () => {
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

  test("binds the artifact-only draft job to the exact repository", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    const document = asRecord(Bun.YAML.parse(workflow), "release workflow");
    const jobs = asRecord(document.jobs, "release workflow jobs");
    const verify = asRecord(jobs.verify, "verify job");
    const stage = asRecord(jobs.stage, "stage job");
    const publicationLease = asRecord(jobs.publication_lease, "publication lease job");
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
    expect(verify.if).toBe("${{ github.event_name == 'push' }}");
    expect(stage.if).toBe("${{ github.event_name == 'push' }}");
    expect(document["run-name"]).toContain("HRA publication lease {0}");
    expect(asRecord(document.concurrency, "release concurrency")).toEqual({
      "cancel-in-progress": false,
      group: "hra-release-publication-v0.1.0",
      queue: "max",
    });
    expect(environment.GH_REPO).toBe("${{ github.repository }}");
    expect(environment.GH_TOKEN).toBe("${{ github.token }}");
    expect(releaseStep.run).toContain(
      'gh release create "$GITHUB_REF_NAME"',
    );
    expect(releaseStep.run).toContain('tag_commit="$(gh api "repos/$GH_REPO/commits/refs/tags/$GITHUB_REF_NAME"');
    expect(releaseStep.run).toContain('repos/$GH_REPO/compare/$accepted_commit...main');
    expect(releaseStep.run).toContain('.merge_base_commit.sha == $commit');
    expect(releaseStep.run).toContain('repos/$GH_REPO/rulesets/21213369');
    expect(releaseStep.run).not.toContain("bypass_actors");
    expect(releaseStep.run).not.toContain("current_user_can_bypass");
    expect(releaseStep.run).not.toContain('test "$main_commit" = "$accepted_commit"');
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
    expect(releaseStep.run).toContain("release/RELEASE_NOTES.md");
    expect(releaseStep.run).toContain("--clobber");
    expect(releaseStep.run).not.toContain("--generate-notes");
    expect(releaseStep.run).not.toContain("release/*");
    const stageSteps = steps.map((step, index) => asRecord(step, `stage step ${index}`));
    const stagedDraft = stageSteps.find((step) =>
      step.name === "Read back the staged draft assets");
    expect(stagedDraft?.run).toContain("shasum -a 256 -c SHA256SUMS");
    expect(stagedDraft?.run).toContain("= 5");
    expect(stagedDraft?.run).toContain(".artifact.spdx.json");
    expect(stagedDraft?.run).toContain(".ubuntu-24.04-x64.runtime.spdx.json");
    expect(stagedDraft?.run).toContain("RELEASE_NOTES.md");
    expect(stagedDraft?.run).toContain(
      "cmp release/RELEASE_NOTES.md published-draft/RELEASE_NOTES.md",
    );
    expect(stagedDraft?.run).toContain('test "$tag_commit" = "$accepted_commit"');
    expect(stagedDraft?.run).toContain('commits/refs/tags/$GITHUB_REF_NAME');
    expect(stagedDraft?.run).toContain('repos/$GH_REPO/compare/$accepted_commit...main');
    expect(stagedDraft?.run).toContain('.merge_base_commit.sha == $commit');
    expect(stagedDraft?.run).toContain('repos/$GH_REPO/rulesets/21213369');
    expect(stagedDraft?.run).not.toContain('test "$main_commit" = "$accepted_commit"');
    expect(stagedDraft?.run).toContain("canonical-marker-publish.json");
    expect(stagedDraft?.run).toContain("--jq '.immutable')\" = false");
    expect(stagedDraft?.run).toContain('.source.commit == $commit');
    expect(stagedDraft?.run).not.toContain("immutable-releases");
    expect(stagedDraft?.run).not.toContain("--draft=false");
    expect(jobs.publish).toBeUndefined();
    expect(jobs.accept).toBeUndefined();
    expect(publicationLease.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(publicationLease["timeout-minutes"]).toBe(360);
    const leaseSteps = publicationLease.steps;
    if (!Array.isArray(leaseSteps)) {
      throw new TypeError("publication lease steps must be an array");
    }
    const parsedLeaseSteps = leaseSteps
      .map((step, index) => asRecord(step, `publication lease step ${index}`));
    const holdLease = parsedLeaseSteps
      .find((step) => step.name === "Hold the exact release mutation lease until publication");
    expect(holdLease?.run).toContain("^[0-9a-f]{32}$");
    expect(holdLease?.run).toContain("^[0-9a-f]{64}$");
    expect(holdLease?.run).toContain('test "$tag_candidate_digest" = "$CANDIDATE_DIGEST"');
    expect(asRecord(holdLease, "publication lease hold step").env).toMatchObject({
      CANDIDATE_DIGEST: "${{ inputs.candidate_digest }}",
    });
    expect(holdLease?.run).toContain("true:false) sleep 5");
    expect(holdLease?.run).toContain("false:true) break");
    expect(holdLease?.run).toContain("*) sleep 5");
    expect(holdLease?.run).toContain('if ! release_rows="$(gh api');
    expect(holdLease?.run).toContain("releases?per_page=100");
    const leaseCheckout = parsedLeaseSteps.find((step) =>
      step.name === "Check out the exact published source");
    const leaseSetupBun = parsedLeaseSteps.find((step) =>
      step.name === "Install Bun for public acceptance");
    const publicAcceptance = parsedLeaseSteps.find((step) =>
      step.name === "Accept the exact immutable public URL");
    const publicAcceptanceRun = publicAcceptance?.run;
    if (typeof publicAcceptanceRun !== "string") {
      throw new TypeError("public acceptance run must be a string");
    }
    expect(parsedLeaseSteps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string"))
      .toEqual([reviewedActions.checkout, reviewedActions.setupBun]);
    expect(asRecord(leaseCheckout, "publication lease checkout step").with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(asRecord(leaseSetupBun, "publication lease Bun setup step").with).toEqual({
      "bun-version-file": ".bun-version",
    });
    expect(publicAcceptance?.run).toContain("HRA_PUBLIC_INSTALL_COMMAND");
    expect(publicAcceptance?.run).toContain(
      "buildHraGlobalInstallCommand(HRA_INSTALL_ARCHIVE_URL)",
    );
    expect(publicAcceptance?.run).toContain('/bin/sh -c "$HRA_PUBLIC_INSTALL_COMMAND"');
    expect(publicAcceptance?.run).not.toContain("bun add --global");
    expect(publicAcceptanceRun.indexOf("HRA_PUBLIC_INSTALL_COMMAND")).toBeLessThan(
      publicAcceptanceRun.indexOf('test -L "$BUN_INSTALL/bin/hra"'),
    );
    expect(publicAcceptance?.run).toContain('"$BUN_INSTALL"/install/hra/versions/*/install/global/node_modules/hra/src/cli.ts');
    expect(publicAcceptance?.run).toContain("transactional install paths are missing");
    expect(publicAcceptance?.run).toContain("lifecycle-disabled install changed consumer trust");
    expect(publicAcceptance?.run).not.toContain("normalization changed consumer trust");
    expect(publicAcceptance?.run).not.toContain(
      'bun "$BUN_INSTALL_GLOBAL_DIR/node_modules/hra/src/install-normalizer.ts"',
    );
    expect(publicAcceptance?.run).toContain("broadens lifecycle trust");
    expect(publicAcceptance?.run).toContain("check-installed-package.ts");
    expect(publicAcceptance?.run).toContain('hra" --version');
    expect(publicAcceptance?.run).toContain("doctor --offline --json");
    expect(publicAcceptance?.run).toContain("public-runtime.spdx.json");
    expect(publicAcceptance?.run).toContain(
      "public runtime SPDX does not match the installed package inventory",
    );

    if (!Array.isArray(verify.steps)) {
      throw new TypeError("verify job steps must be an array");
    }
    const verifySteps = verify.steps.map((step, index) => asRecord(step, `verify step ${index}`));
    const upload = verifySteps.find((step) => step.name === "Preserve verified release artifacts");
    const download = stageSteps.find((step) => step.name === "Download verified release artifacts");
    const exactArtifactName = "hra-release-${{ github.ref_name }}-run-${{ github.run_id }}-attempt-${{ github.run_attempt }}";
    expect(asRecord(upload, "release artifact upload step").with).toMatchObject({
      name: exactArtifactName,
    });
    expect(asRecord(download, "release artifact download step").with).toMatchObject({
      name: exactArtifactName,
    });
    const actionUses = [...verifySteps, ...stageSteps]
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string");
    expect(actionUses).toEqual([
      reviewedActions.checkout,
      reviewedActions.setupBun,
      reviewedActions.sbom,
      reviewedActions.sbom,
      reviewedActions.uploadArtifact,
      reviewedActions.downloadArtifact,
    ]);
    const checkout = verifySteps.find((step) => step.name === "Check out the tagged source");
    const exactHead = verifySteps.find((step) => step.name === "Verify exact release head and ordering");
    const generated = verifySteps.find((step) => step.name === "Verify generated public documents");
    const availability = verifySteps.find((step) =>
      step.name === "Verify public release availability");
    const packedInstall = verifySteps.find((step) =>
      step.name === "Accept the exact packed installation");
    const packedInstallRun = packedInstall?.run;
    if (typeof packedInstallRun !== "string") {
      throw new TypeError("packed install run must be a string");
    }
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
    const checksums = verifySteps.find((step) => step.name === "Write checksums");
    expect(asRecord(checkout, "release checkout step").with).toEqual({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(exactHead?.run).toContain("tagged_commit=\"$(git rev-parse \"refs/tags/$GITHUB_REF_NAME^{commit}\")\"");
    expect(workflow).not.toContain('commits/$GITHUB_REF_NAME');
    expect(exactHead?.run).toContain('test "$remote_tagged_commit" = "$tagged_commit"');
    expect(exactHead?.run).toContain('select(.object.type == "tag")');
    expect(exactHead?.run).toContain("hra-release-candidate-sha256:[0-9a-f]{64}");
    expect(exactHead?.run).toContain("HRA_RELEASE_CANDIDATE_SHA256");
    expect(exactHead?.run).toContain('git merge-base --is-ancestor "$tagged_commit" "$main_commit"');
    expect(exactHead?.run).toContain('repos/$GH_REPO/compare/$tagged_commit...main');
    expect(exactHead?.run).toContain('repos/$GH_REPO/rulesets/21213369');
    expect(exactHead?.run).toContain('.conditions.ref_name.include == ["refs/tags/v*"]');
    expect(exactHead?.run).toContain('([.rules[].type] | sort) == ["deletion", "update"]');
    expect(exactHead?.run).not.toContain('test "$tagged_commit" = "$main_commit"');
    expect(asRecord(exactHead, "release head step").env).toEqual({
      GH_REPO: "${{ github.repository }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(workflow).not.toContain("bypass_actors");
    expect(workflow).not.toContain("current_user_can_bypass");
    const localPublisher = await readFile(
      join(import.meta.dir, "publish-beta-release.ts"),
      "utf8",
    );
    expect(localPublisher).toContain("bypass_actors: z.tuple([])");
    expect(localPublisher).toContain('current_user_can_bypass: z.literal("never")');
    expect(localPublisher).toContain("actions/workflows/${workflowFile}/dispatches");
    expect(localPublisher).toContain('"return_run_details=true"');
    expect(localPublisher).toContain("workflow_run_id: positiveIntegerSchema");
    expect(localPublisher).toContain("scanPublicationLeaseCandidates(");
    expect(localPublisher).toContain("publicationLeaseAcquireTimeoutMs = 45 * 60 * 1_000");
    expect(localPublisher).toContain("head_sha=${expectedCommit}&per_page=${String(publicationLeaseCandidatePageSize)}");
    expect(localPublisher).toContain("publicationLeaseCandidatePageSize = 100");
    expect(localPublisher).toContain("publicationLeaseRunSchema");
    expect(localPublisher).toContain("await provider.assertPublicationLease");
    expect(localPublisher).toContain("await provider.publishDraft(release.id, accepted.notes)");
    expect(localPublisher).toContain("`tag_name=${releaseTag}`");
    expect(localPublisher).toContain("`name=${title}`");
    expect(localPublisher).toContain("`body=${notes}`");
    expect(localPublisher).toContain('"make_latest=false"');
    expect(localPublisher).not.toContain("If-Match");
    expect(asRecord(generated, "release generated-documents step").run)
      .toBe("bun run build:site -- --check");
    expect(availability?.run).toContain('publicReleaseState !== "release-ready"');
    expect(availability?.run).toContain('endpoints.hostedSync !== "live"');
    expect(packedInstall?.run).toContain("./release/hra-${GITHUB_REF_NAME}.tgz");
    expect(packedInstall?.run).toContain(
      'test "$(bun ./src/install-preflight.ts "./release/hra-${GITHUB_REF_NAME}.tgz")" = hra-install-safe',
    );
    expect(packedInstallRun.indexOf("hra-install-safe")).toBeLessThan(
      packedInstallRun.indexOf('test -L "$BUN_INSTALL/bin/hra"'),
    );
    expect(packedInstall?.run).not.toContain("bun add --global");
    expect(packedInstall?.run).toContain('"$BUN_INSTALL"/install/hra/versions/*/install/global/node_modules/hra/src/cli.ts');
    expect(packedInstall?.run).toContain("transactional install paths are missing");
    expect(packedInstall?.run).toContain("lifecycle-disabled install changed consumer trust");
    expect(packedInstall?.run).not.toContain("normalization changed consumer trust");
    expect(packedInstall?.run).not.toContain(
      'bun "$BUN_INSTALL_GLOBAL_DIR/node_modules/hra/src/install-normalizer.ts"',
    );
    expect(packedInstall?.run).toContain("broadens lifecycle trust");
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
    expect(runtimeSbomWith.path).toBe("${{ steps.accept_packed_install.outputs.runtime_node_modules }}");
    expect(runtimeSbomWith.config).toBe(".github/syft-runtime.yaml");
    expect(runtimeSbomWith.file).toBeUndefined();
    expect(runtimeSbomWith["output-file"]).toContain(".ubuntu-24.04-x64.runtime.spdx.json");
    expect(runtimeSbomVerification?.run).toContain('["@openai/codex", "0.149.0"]');
    expect(runtimeSbomVerification?.run).toContain('["convex", "1.45.0"]');
    expect(runtimeSbomVerification?.run).toContain('["zod", "4.4.3"]');
    expect(releaseMetadata?.run).toContain('Bun.file("docs/beta-release-notes.md")');
    expect(releaseMetadata?.run).toContain("git rev-parse 'HEAD^{commit}' > release/RELEASE_COMMIT");
    expect(releaseMetadata?.run).toContain("release/RELEASE_CANDIDATE_SHA256");
    expect(checksums?.run).toContain("RELEASE_NOTES.md");
    expect(verifySteps.indexOf(asRecord(releaseMetadata, "release metadata step")))
      .toBeLessThan(verifySteps.indexOf(asRecord(checksums, "release checksum step")));
    const uploadInputs = asRecord(
      asRecord(upload, "release artifact upload step").with,
      "release artifact upload inputs",
    );
    expect(uploadInputs.path).toBeString();
    expect(uploadInputs.path).toContain("release/RELEASE_NOTES.md");
    expect(uploadInputs.path).toContain("release/RELEASE_CANDIDATE_SHA256");

    const trigger = asRecord(document.on, "release workflow trigger");
    const dispatch = asRecord(trigger.workflow_dispatch, "release workflow dispatch");
    const inputs = asRecord(dispatch.inputs, "release workflow dispatch inputs");
    expect(asRecord(inputs.candidate_digest, "candidate digest input")).toMatchObject({
      required: true,
      type: "string",
    });

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
});
