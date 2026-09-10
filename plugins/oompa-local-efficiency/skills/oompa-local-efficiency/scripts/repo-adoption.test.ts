import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRepositoryAdoptionArguments,
  runRepositoryAdoption,
} from "./repo-adoption";

const temporary: string[] = [];
const startMarker = "<!-- oompa-local-efficiency:start -->";
const endMarker = "<!-- oompa-local-efficiency:end -->";

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(git = true): string {
  const root = mkdtempSync(join(tmpdir(), "oompa-repo-adoption-"));
  temporary.push(root);
  if (git) {
    const initialized = Bun.spawnSync({
      cmd: ["git", "init", "--quiet", root],
      stderr: "pipe",
      stdout: "pipe",
    });
    if (initialized.exitCode !== 0) {
      throw new Error(initialized.stderr.toString() || "fixture git init failed");
    }
  }
  return root;
}

function policy(): string {
  return readFileSync(join(import.meta.dir, "..", "assets", "repository-policy.md"), "utf8");
}

function invoke(arguments_: readonly string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "repo-adoption.ts"), ...arguments_],
    stderr: "pipe",
    stdout: "pipe",
  });
}

describe("repository adoption arguments", () => {
  test("defaults to the current repository and requires one explicit mode", () => {
    expect(parseRepositoryAdoptionArguments(["--check", "--json"], "/tmp/repository"))
      .toEqual({ json: true, mode: "check", root: "/tmp/repository" });
    expect(() => parseRepositoryAdoptionArguments([], "/tmp/repository"))
      .toThrow("choose --apply or --check");
    expect(() => parseRepositoryAdoptionArguments(["--apply", "--check"], "/tmp/repository"))
      .toThrow("exactly one");
  });

  test("accepts one absolute root override", () => {
    expect(parseRepositoryAdoptionArguments(["--apply", "--root", "/tmp/target"], "/tmp/source"))
      .toEqual({ json: false, mode: "apply", root: "/tmp/target" });
    expect(() => parseRepositoryAdoptionArguments(["--check", "--root", "relative"]))
      .toThrow("absolute path");
    expect(() => parseRepositoryAdoptionArguments([
      "--check",
      "--root",
      "/tmp/one",
      "--root",
      "/tmp/two",
    ])).toThrow("only once");
  });
});

describe("repository policy adoption", () => {
  test("checks without mutation, applies the asset exactly, and is idempotent", () => {
    const root = fixture();
    const agentsPath = join(root, "AGENTS.md");
    const claudePath = join(root, "CLAUDE.md");
    const original = "# Contents\n\n- Existing content.\n\n# Guidelines\n\n- Keep this.\n";
    writeFileSync(agentsPath, original);

    const checked = invoke(["--check", "--json", "--root", root]);
    expect(checked.exitCode).toBe(1);
    expect(JSON.parse(checked.stdout.toString())).toEqual({
      agentsPath,
      claudePath,
      changed: false,
      mode: "check",
      root,
      status: "needs-update",
      version: 2,
    });
    expect(readFileSync(agentsPath, "utf8")).toBe(original);

    const applied = invoke(["--apply", "--json", "--root", root]);
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    expect(applied.stdout.toString()).toContain('"status": "updated"');
    const adopted = readFileSync(agentsPath, "utf8");
    expect(adopted).toBe(`${original.trimEnd()}\n\n${policy()}`);
    expect(readFileSync(claudePath, "utf8")).toBe("@AGENTS.md\n");

    const repeated = invoke(["--apply", "--json", "--root", root]);
    expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
    expect(JSON.parse(repeated.stdout.toString())).toMatchObject({
      changed: false,
      status: "current",
    });
    expect(readFileSync(agentsPath, "utf8")).toBe(adopted);

    const rechecked = invoke(["--check", "--json", "--root", root]);
    expect(rechecked.exitCode, rechecked.stderr.toString()).toBe(0);
    expect(JSON.parse(rechecked.stdout.toString())).toMatchObject({
      changed: false,
      status: "current",
    });
  });

  test("replaces legacy delivery policy idempotently while preserving unrelated guidance and file modes", () => {
    const root = fixture();
    const agentsPath = join(root, "AGENTS.md");
    const claudePath = join(root, "CLAUDE.md");
    const before = "# Contents\n\n- Untouched before.";
    const after = "# Guidelines\n\n- Untouched after.\n";
    const legacyDeliveryPolicy = "- Treat the user's request to change this repository as standing authorization for routine task-owned commits, pushes, pull requests, merges, releases, deployments, and production verification after the repository's required validation, review, identity, and rollout gates pass. Do not ask for another confirmation at each delivery step.";
    const original = `${before}\n\n${startMarker}\n${legacyDeliveryPolicy}\n${endMarker}\n\n${after}`;
    writeFileSync(
      agentsPath,
      original,
    );
    chmodSync(agentsPath, 0o640);
    const existingClaude = "# Existing Claude rules\n\n```text\n@AGENTS.md\n```\n\nInline example: `@AGENTS.md`.\n\n- Preserve me.\n";
    writeFileSync(claudePath, existingClaude);
    chmodSync(claudePath, 0o600);

    expect(runRepositoryAdoption({ json: false, mode: "check", root }))
      .toMatchObject({ changed: false, status: "needs-update" });
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
    expect(readFileSync(claudePath, "utf8")).toBe(existingClaude);

    const report = runRepositoryAdoption({ json: false, mode: "apply", root });

    expect(report).toMatchObject({ changed: true, status: "updated" });
    const adopted = `${before}\n\n${policy().trimEnd()}\n\n${after}`;
    expect(readFileSync(agentsPath, "utf8")).toBe(adopted);
    expect(adopted).not.toContain(legacyDeliveryPolicy);
    expect(adopted.split(startMarker)).toHaveLength(2);
    expect(adopted.split(endMarker)).toHaveLength(2);
    expect(statSync(agentsPath).mode & 0o777).toBe(0o640);
    expect(readFileSync(claudePath, "utf8")).toBe(
      `${existingClaude.trimEnd()}\n\n<!-- oompa-local-efficiency:claude-import:start -->\n@AGENTS.md\n<!-- oompa-local-efficiency:claude-import:end -->\n`,
    );
    expect(statSync(claudePath).mode & 0o777).toBe(0o600);
    const adoptedClaude = readFileSync(claudePath, "utf8");

    expect(runRepositoryAdoption({ json: false, mode: "apply", root }))
      .toMatchObject({ changed: false, status: "current" });
    expect(runRepositoryAdoption({ json: false, mode: "check", root }))
      .toMatchObject({ changed: false, status: "current" });
    expect(readFileSync(agentsPath, "utf8")).toBe(adopted);
    expect(readFileSync(claudePath, "utf8")).toBe(adoptedClaude);
    expect(statSync(agentsPath).mode & 0o777).toBe(0o640);
    expect(statSync(claudePath).mode & 0o777).toBe(0o600);
  });

  test("migrates the previous plugin's managed blocks in place", () => {
    const root = fixture();
    const agentsPath = join(root, "AGENTS.md");
    const claudePath = join(root, "CLAUDE.md");
    const before = "# Contents\n\n- Untouched before.";
    const after = "# Guidelines\n\n- Untouched after.\n";
    const legacyAgents = `${before}\n\n<!-- hra-local-efficiency:start -->\n- Old policy.\n<!-- hra-local-efficiency:end -->\n\n${after}`;
    const legacyClaude = "# Existing Claude rules\n\n- Preserve me.\n\n<!-- hra-local-efficiency:claude-import:start -->\n@AGENTS.md\n<!-- hra-local-efficiency:claude-import:end -->\n";
    writeFileSync(agentsPath, legacyAgents);
    chmodSync(agentsPath, 0o640);
    writeFileSync(claudePath, legacyClaude);
    chmodSync(claudePath, 0o600);

    expect(runRepositoryAdoption({ json: false, mode: "check", root }))
      .toMatchObject({ changed: false, status: "needs-update" });
    expect(readFileSync(agentsPath, "utf8")).toBe(legacyAgents);
    expect(readFileSync(claudePath, "utf8")).toBe(legacyClaude);

    expect(runRepositoryAdoption({ json: false, mode: "apply", root }))
      .toMatchObject({ changed: true, status: "updated" });
    const adopted = readFileSync(agentsPath, "utf8");
    expect(adopted).toBe(`${before}\n\n${policy().trimEnd()}\n\n${after}`);
    expect(adopted).not.toContain("hra-local-efficiency");
    expect(adopted).not.toContain("- Old policy.");
    expect(readFileSync(claudePath, "utf8")).toBe(
      "# Existing Claude rules\n\n- Preserve me.\n\n<!-- oompa-local-efficiency:claude-import:start -->\n@AGENTS.md\n<!-- oompa-local-efficiency:claude-import:end -->\n",
    );
    expect(statSync(agentsPath).mode & 0o777).toBe(0o640);
    expect(statSync(claudePath).mode & 0o777).toBe(0o600);
    expect(runRepositoryAdoption({ json: false, mode: "check", root }))
      .toMatchObject({ changed: false, status: "current" });
  });

  test("refuses mixed legacy and current markers without modifying guidance", () => {
    const root = fixture();
    const agentsPath = join(root, "AGENTS.md");
    const mixed = `<!-- hra-local-efficiency:start -->\n- Old policy.\n<!-- hra-local-efficiency:end -->\n\n${policy()}`;
    writeFileSync(agentsPath, mixed);

    expect(() => runRepositoryAdoption({ json: false, mode: "check", root }))
      .toThrow("mix legacy and current");
    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root }))
      .toThrow("mix legacy and current");
    expect(readFileSync(agentsPath, "utf8")).toBe(mixed);
    expect(() => statSync(join(root, "CLAUDE.md"))).toThrow();

    const duplicatedRoot = fixture();
    const duplicated = join(duplicatedRoot, "AGENTS.md");
    const twice = "<!-- hra-local-efficiency:start -->\n<!-- hra-local-efficiency:end -->\n".repeat(2);
    writeFileSync(duplicated, twice);
    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root: duplicatedRoot }))
      .toThrow("duplicate");
    expect(readFileSync(duplicated, "utf8")).toBe(twice);
  });

  test("creates a missing root AGENTS.md from the policy asset", () => {
    const root = fixture();

    const report = runRepositoryAdoption({ json: false, mode: "apply", root });

    expect(report).toMatchObject({ changed: true, status: "updated" });
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toBe(policy());
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  test("preserves an existing Claude import byte for byte", () => {
    const root = fixture();
    const claudePath = join(root, "CLAUDE.md");
    const originalClaude = "# Claude-specific guidance\r\n\r\n@AGENTS.md\r\n\r\nKeep this layout.\r\n";
    writeFileSync(claudePath, originalClaude);

    const report = runRepositoryAdoption({ json: false, mode: "apply", root });

    expect(report).toMatchObject({ changed: true, claudePath, status: "updated", version: 2 });
    expect(readFileSync(claudePath, "utf8")).toBe(originalClaude);
  });

  test("recognizes an active Claude import in prose", () => {
    const root = fixture();
    const existingClaude = [
      "# Claude guide",
      "",
      "See @AGENTS.md for the shared repository policy.",
      "",
      "Inline example: `@AGENTS.md`.",
      "",
      "```md",
      "@AGENTS.md",
      "```",
      "",
    ].join("\n");
    writeFileSync(join(root, "CLAUDE.md"), existingClaude);

    const report = runRepositoryAdoption({ json: false, mode: "apply", root });

    expect(report.status).toBe("updated");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(existingClaude);
  });

  test("does not mistake a nested-fence-looking example import for an active import", () => {
    const root = fixture();
    const existingClaude = [
      "# Claude guide",
      "",
      "```md",
      "```js",
      "@AGENTS.md",
      "```",
      "",
    ].join("\n");
    writeFileSync(join(root, "CLAUDE.md"), existingClaude);

    const report = runRepositoryAdoption({ json: false, mode: "apply", root });

    expect(report.status).toBe("updated");
    expect(readFileSync(join(root, "CLAUDE.md"), "utf8")).toBe(
      `${existingClaude.trimEnd()}\n\n<!-- oompa-local-efficiency:claude-import:start -->\n@AGENTS.md\n<!-- oompa-local-efficiency:claude-import:end -->\n`,
    );
  });

  test("preflights both root guidance targets before writing either", () => {
    const root = fixture();
    const agentsPath = join(root, "AGENTS.md");
    const original = "# Existing root guidance\n";
    writeFileSync(agentsPath, original);
    mkdirSync(join(root, "CLAUDE.md"));

    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root }))
      .toThrow("non-file root Claude guidance");
    expect(readFileSync(agentsPath, "utf8")).toBe(original);
  });

  test("refuses ambiguous markers without modifying guidance", () => {
    const root = fixture();
    const agentsPath = join(root, "AGENTS.md");
    const ambiguous = `${policy()}\n${policy()}`;
    writeFileSync(agentsPath, ambiguous);

    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root }))
      .toThrow("duplicate");
    expect(readFileSync(agentsPath, "utf8")).toBe(ambiguous);

    const directoryRoot = fixture();
    mkdirSync(join(directoryRoot, "AGENTS.md"));
    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root: directoryRoot }))
      .toThrow("non-file");
  });

  test("refuses a non-repository or a path below the Git top-level", () => {
    const nonRepository = fixture(false);
    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root: nonRepository }))
      .toThrow("not a Git worktree");

    const repository = fixture();
    const nested = join(repository, "nested");
    mkdirSync(nested);
    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root: nested }))
      .toThrow("exact Git top-level");
    expect(() => statSync(join(nested, "AGENTS.md"))).toThrow();
  });
});
