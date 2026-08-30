import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildHraGlobalInstallCommand,
  HRA_INSTALL_ARCHIVE_URL,
} from "../src/install-preflight";

const reviewedActions = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
} as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

describe("release workflow", () => {
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
    expect(releaseRecord).toContain("`@hraness/oh` is a GitHub runtime dependency");
    const workflow = await readFile(releaseWorkflow, "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm pack --ignore-scripts --pack-destination artifacts .");
    expect(workflow).toContain("release-artifact-checksum.ts");
    expect(workflow).toContain("check-release-package.ts");
    expect(workflow).toContain("publish-npm-release.ts");
    expect(workflow).toContain("publish-github-release.ts");
    expect(workflow).toContain("check-public-release.ts");
    expect(workflow).toContain("os: [ubuntu-24.04, macos-15]");
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
});
