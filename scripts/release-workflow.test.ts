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
  test("binds the artifact-only publish job to the exact repository", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    const document = asRecord(Bun.YAML.parse(workflow), "release workflow");
    const jobs = asRecord(document.jobs, "release workflow jobs");
    const verify = asRecord(jobs.verify, "verify job");
    const publish = asRecord(jobs.publish, "publish job");
    const steps = publish.steps;

    if (!Array.isArray(steps)) {
      throw new TypeError("publish job steps must be an array");
    }

    const createRelease = steps
      .map((step, index) => asRecord(step, `publish step ${index}`))
      .find((step) => step.name === "Create the GitHub release");

    expect(createRelease).toBeDefined();
    const releaseStep = asRecord(createRelease, "GitHub release step");
    const environment = asRecord(releaseStep.env, "GitHub release environment");

    expect(publish.needs).toBe("verify");
    expect(environment.GH_REPO).toBe("${{ github.repository }}");
    expect(environment.GH_TOKEN).toBe("${{ github.token }}");
    expect(releaseStep.run).toContain(
      'gh release create "$GITHUB_REF_NAME" release/*',
    );

    if (!Array.isArray(verify.steps)) {
      throw new TypeError("verify job steps must be an array");
    }
    const verifySteps = verify.steps.map((step, index) => asRecord(step, `verify step ${index}`));
    const checkout = verifySteps.find((step) => step.name === "Check out the tagged source");
    const generated = verifySteps.find((step) => step.name === "Verify generated public documents");
    expect(asRecord(checkout, "release checkout step").with).toEqual({ "fetch-depth": 0 });
    expect(asRecord(generated, "release generated-documents step").run)
      .toBe("bun run build:site -- --check");
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
