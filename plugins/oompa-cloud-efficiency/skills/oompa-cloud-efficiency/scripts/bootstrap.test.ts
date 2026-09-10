import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commandTargets,
  legacyCommandTargets,
  parseBootstrapArguments,
  runBootstrap,
} from "./bootstrap";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): { bunBin: string; codexHome: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "oompa-cloud-bootstrap-"));
  temporary.push(root);
  const bunBin = join(root, "bin");
  const codexHome = join(root, "codex");
  mkdirSync(bunBin);
  mkdirSync(codexHome);
  return { bunBin, codexHome, root };
}

// The state the previous plugin identity left behind: a legacy managed block
// and command links into a legacy-named plugin cache.
function legacyInstallation(bunBin: string, codexHome: string): readonly string[] {
  const agents = join(codexHome, "AGENTS.md");
  writeFileSync(
    agents,
    "# Existing\n\nKeep this.\n\n<!-- hra-cloud-efficiency:start -->\n- Old policy.\n<!-- hra-cloud-efficiency:end -->\n\nTail.\n",
    { mode: 0o600 },
  );
  chmodSync(agents, 0o600);
  const pluginRoot = join(codexHome, "plugins", "cache", "hraness", "hra-cloud-efficiency", "0.1.1");
  const skillRoot = join(pluginRoot, "skills", "hra-cloud-efficiency");
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(join(skillRoot, "scripts"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "hra-cloud-efficiency", skills: "./skills/" }),
  );
  writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: hra-cloud-efficiency\ndescription: fixture\n---\n");
  const links = [
    ...legacyCommandTargets(bunBin),
    ...commandTargets(bunBin).filter(([link]) => link.endsWith("/oompa-cloud-route")),
  ];
  return links.map(([link, target]) => {
    const prior = join(skillRoot, "scripts", target.split("/").at(-1) as string);
    writeFileSync(prior, "prior managed command\n");
    symlinkSync(prior, link);
    return prior;
  });
}

describe("Oompa Cloud efficiency bootstrap", () => {
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
    expect(guidance.match(/oompa-cloud-efficiency:start/gu)).toHaveLength(1);
    expect(statSync(agents).mode & 0o777).toBe(0o600);
    for (const [link, target] of commandTargets(bunBin)) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(target).toContain("oompa-cloud-efficiency/skills/oompa-cloud-efficiency/scripts");
    }
    expect(runBootstrap(apply).status).toBe("current");
    expect(runBootstrap({ bunBin, codexHome, mode: "check" }).status).toBe("current");

    writeFileSync(agents, guidance.replace("Cloud routing", "Cloud routing drift"));
    expect(() => runBootstrap({ bunBin, codexHome, mode: "check" }))
      .toThrow("baseline differs");
  });

  test("migrates a previous-identity installation in place", () => {
    const { bunBin, codexHome } = fixture();
    const priorTargets = legacyInstallation(bunBin, codexHome);
    expect(legacyCommandTargets(bunBin).map(([link]) => link.split("/").at(-1)))
      .toEqual(["hra-cloud-adoption", "hra-cloud-efficiency", "hra-cloud-exec", "hra-cloud-route"]);
    expect(() => runBootstrap({ bunBin, codexHome, mode: "check" })).toThrow("baseline differs");

    const apply = { bunBin, codexHome, mode: "apply" as const };
    expect(runBootstrap(apply).status).toBe("updated");
    const agents = join(codexHome, "AGENTS.md");
    const guidance = readFileSync(agents, "utf8");
    expect(guidance.startsWith("# Existing\n\nKeep this.\n\n<!-- oompa-cloud-efficiency:start -->\n")).toBe(true);
    expect(guidance.endsWith("<!-- oompa-cloud-efficiency:end -->\n\nTail.\n")).toBe(true);
    expect(guidance).not.toContain("hra-cloud-efficiency");
    expect(guidance).not.toContain("- Old policy.");
    expect(statSync(agents).mode & 0o777).toBe(0o600);
    for (const [link, target] of [...commandTargets(bunBin), ...legacyCommandTargets(bunBin)]) {
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(target);
      expect(target).toContain("oompa-cloud-efficiency/skills/oompa-cloud-efficiency/scripts");
    }
    for (const prior of priorTargets) expect(readFileSync(prior, "utf8")).toBe("prior managed command\n");
    expect(runBootstrap({ bunBin, codexHome, mode: "check" }).status).toBe("current");

    rmSync(join(bunBin, "hra-cloud-exec"));
    expect(() => runBootstrap({ bunBin, codexHome, mode: "check" })).toThrow("baseline differs");
    expect(runBootstrap(apply).status).toBe("updated");
    expect(readlinkSync(join(bunBin, "hra-cloud-exec"))).toBe(join(import.meta.dir, "cloud-run.ts"));
  });

  test("requires legacy command links only where a legacy name already exists", () => {
    const { bunBin, codexHome } = fixture();
    expect(runBootstrap({ bunBin, codexHome, mode: "apply" }).status).toBe("updated");
    for (const [link] of legacyCommandTargets(bunBin)) rmSync(link);
    expect(runBootstrap({ bunBin, codexHome, mode: "check" }).status).toBe("current");
    symlinkSync(join(import.meta.dir, "cloud-run.ts"), join(bunBin, "hra-cloud-exec"));
    expect(() => runBootstrap({ bunBin, codexHome, mode: "check" })).toThrow("baseline differs");
  });

  test("refuses mixed legacy and current guidance markers without changing anything", () => {
    const { bunBin, codexHome } = fixture();
    const agents = join(codexHome, "AGENTS.md");
    const mixed = "<!-- hra-cloud-efficiency:start -->\n<!-- hra-cloud-efficiency:end -->\n\n<!-- oompa-cloud-efficiency:start -->\n<!-- oompa-cloud-efficiency:end -->\n";
    writeFileSync(agents, mixed);
    expect(() => runBootstrap({ bunBin, codexHome, mode: "check" })).toThrow("mix legacy and current");
    expect(() => runBootstrap({ bunBin, codexHome, mode: "apply" })).toThrow("mix legacy and current");
    expect(readFileSync(agents, "utf8")).toBe(mixed);
    for (const [link] of commandTargets(bunBin)) expect(() => lstatSync(link)).toThrow();
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
