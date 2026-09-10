import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseRepositoryAdoptionArguments,
  runRepositoryAdoption,
} from "./repo-adoption";
import { command } from "./shared";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function repositoryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "oompa-cloud-adoption-"));
  temporary.push(root);
  const initialized = command(["git", "init", "--initial-branch=main"], root);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
  return root;
}

describe("repository Cloud policy adoption", () => {
  test("requires one explicit mode and an absolute root override", () => {
    expect(() => parseRepositoryAdoptionArguments([])).toThrow("choose --apply or --check");
    expect(() => parseRepositoryAdoptionArguments(["--apply", "--check"]))
      .toThrow("exactly one");
    expect(() => parseRepositoryAdoptionArguments(["--check", "--root", "relative"]))
      .toThrow("absolute");
  });

  test("applies and checks only its managed block while preserving file mode", () => {
    const root = repositoryFixture();
    const agents = join(root, "AGENTS.md");
    writeFileSync(agents, "# Existing\n\nKeep me.\n", { mode: 0o600 });
    chmodSync(agents, 0o600);
    expect(runRepositoryAdoption({ json: false, mode: "check", root }).status)
      .toBe("needs-update");
    expect(runRepositoryAdoption({ json: false, mode: "apply", root }).status)
      .toBe("updated");
    const value = readFileSync(agents, "utf8");
    expect(value).toContain("Keep me.");
    expect(value.match(/oompa-cloud-efficiency:start/gu)).toHaveLength(1);
    expect(statSync(agents).mode & 0o777).toBe(0o600);
    expect(runRepositoryAdoption({ json: false, mode: "check", root }).status)
      .toBe("current");
  });

  test("migrates the previous plugin's managed block in place", () => {
    const root = repositoryFixture();
    const agents = join(root, "AGENTS.md");
    const legacy = "# Existing\n\nKeep me.\n\n<!-- hra-cloud-efficiency:start -->\n- Old policy.\n<!-- hra-cloud-efficiency:end -->\n\nTail.\n";
    writeFileSync(agents, legacy, { mode: 0o600 });
    chmodSync(agents, 0o600);
    expect(runRepositoryAdoption({ json: false, mode: "check", root }).status)
      .toBe("needs-update");
    expect(readFileSync(agents, "utf8")).toBe(legacy);
    expect(runRepositoryAdoption({ json: false, mode: "apply", root }).status)
      .toBe("updated");
    const value = readFileSync(agents, "utf8");
    expect(value.startsWith("# Existing\n\nKeep me.\n\n<!-- oompa-cloud-efficiency:start -->\n")).toBe(true);
    expect(value.endsWith("<!-- oompa-cloud-efficiency:end -->\n\nTail.\n")).toBe(true);
    expect(value).not.toContain("hra-cloud-efficiency");
    expect(value).not.toContain("- Old policy.");
    expect(statSync(agents).mode & 0o777).toBe(0o600);
    expect(runRepositoryAdoption({ json: false, mode: "check", root }).status)
      .toBe("current");
  });

  test("refuses mixed legacy and current markers without modifying guidance", () => {
    const root = repositoryFixture();
    const agents = join(root, "AGENTS.md");
    const mixed = "<!-- hra-cloud-efficiency:start -->\n<!-- hra-cloud-efficiency:end -->\n<!-- oompa-cloud-efficiency:start -->\n<!-- oompa-cloud-efficiency:end -->\n";
    writeFileSync(agents, mixed);
    expect(() => runRepositoryAdoption({ json: false, mode: "check", root }))
      .toThrow("mix legacy and current");
    expect(() => runRepositoryAdoption({ json: false, mode: "apply", root }))
      .toThrow("mix legacy and current");
    expect(readFileSync(agents, "utf8")).toBe(mixed);
  });

  test("rejects duplicate managed markers", () => {
    const root = repositoryFixture();
    writeFileSync(
      join(root, "AGENTS.md"),
      "<!-- oompa-cloud-efficiency:start -->\n<!-- oompa-cloud-efficiency:end -->\n<!-- oompa-cloud-efficiency:start -->\n<!-- oompa-cloud-efficiency:end -->\n",
    );
    expect(() => runRepositoryAdoption({ json: false, mode: "check", root }))
      .toThrow("duplicated");
  });
});
