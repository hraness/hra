import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commandTargets,
  parseBootstrapArguments,
  runBootstrap,
} from "./bootstrap";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { bunBin: string; codexHome: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "hra-cloud-bootstrap-"));
  temporary.push(root);
  const bunBin = join(root, "bin");
  const codexHome = join(root, "codex");
  mkdirSync(bunBin);
  mkdirSync(codexHome);
  return { bunBin, codexHome, root };
}

describe("HRA Cloud efficiency bootstrap", () => {
  test("requires one explicit mode and absolute overrides", () => {
    expect(() => parseBootstrapArguments([])).toThrow("choose --apply or --check");
    expect(() => parseBootstrapArguments(["--apply", "--check"]))
      .toThrow("exactly one");
    expect(() => parseBootstrapArguments(["--check", "--codex-home", "relative"]))
      .toThrow("absolute");
  });

  test("installs marker-bounded guidance and exact command links idempotently", () => {
    const { bunBin, codexHome } = fixture();
    const agents = join(codexHome, "AGENTS.md");
    writeFileSync(agents, "# Existing\n\nKeep this.\n", { mode: 0o600 });
    chmodSync(agents, 0o600);
    const apply = { bunBin, codexHome, mode: "apply" as const };
    expect(runBootstrap(apply).status).toBe("updated");
    const guidance = readFileSync(agents, "utf8");
    expect(guidance).toContain("Keep this.");
    expect(guidance.match(/hra-cloud-efficiency:start/gu)).toHaveLength(1);
    expect(statSync(agents).mode & 0o777).toBe(0o600);
    for (const [link, target] of commandTargets(bunBin)) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(target).toContain("hra-cloud-efficiency/skills/hra-cloud-efficiency/scripts");
    }
    expect(runBootstrap(apply).status).toBe("current");
    expect(runBootstrap({ bunBin, codexHome, mode: "check" }).status).toBe("current");

    writeFileSync(agents, guidance.replace("Cloud routing", "Cloud routing drift"));
    expect(() => runBootstrap({ bunBin, codexHome, mode: "check" }))
      .toThrow("baseline differs");
  });

  test("refuses a symlinked global guidance file", () => {
    const { bunBin, codexHome, root } = fixture();
    const target = join(root, "managed-elsewhere");
    writeFileSync(target, "outside\n");
    symlinkSync(target, join(codexHome, "AGENTS.md"));
    expect(() => runBootstrap({ bunBin, codexHome, mode: "apply" }))
      .toThrow("non-regular global Codex guidance");
    expect(readFileSync(target, "utf8")).toBe("outside\n");
  });
});
