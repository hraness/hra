import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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

import { ensureManagedCommandSymlink, parseBootstrapArguments } from "./bootstrap";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createPluginCommand(pluginRoot: string, script: string, body = "#!/usr/bin/env bun\n"): string {
  const skillRoot = join(pluginRoot, "skills", "hra-local-efficiency");
  const target = join(skillRoot, "scripts", script);
  mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
  mkdirSync(join(skillRoot, "scripts"), { recursive: true });
  writeFileSync(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({ name: "hra-local-efficiency", skills: "./skills/" }, null, 2)}\n`,
  );
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    "---\nname: hra-local-efficiency\ndescription: Test fixture.\n---\n",
  );
  writeFileSync(target, body);
  return target;
}

describe("machine bootstrap", () => {
  test("requires one explicit mode and bounded absolute overrides", () => {
    expect(() => parseBootstrapArguments([])).toThrow("choose --apply or --check");
    expect(() => parseBootstrapArguments(["--apply", "--check"]))
      .toThrow("exactly one");
    expect(() => parseBootstrapArguments(["--check", "--codex-home", "relative"]))
      .toThrow("absolute");
  });

  test("installs marker-bounded guidance and command links in a fixture", async () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    mkdirSync(join(codexHome, "rules"), { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "# Existing\n\nKeep me.\n");
    chmodSync(join(codexHome, "AGENTS.md"), 0o600);
    const rulesPath = join(codexHome, "rules", "hra-local-efficiency.rules");
    writeFileSync(rulesPath, "# Existing rule before the managed block.\n");
    chmodSync(rulesPath, 0o640);
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");
    const environment = {
      ...process.env,
      HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
    };
    const first = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const guidance = readFileSync(join(codexHome, "AGENTS.md"), "utf8");
    expect(guidance).toContain("Keep me.");
    expect(guidance.match(/hra-local-efficiency:start/gu)).toHaveLength(1);
    expect(statSync(join(codexHome, "AGENTS.md")).mode & 0o777).toBe(0o600);
    expect(readlinkSync(join(bunBin, "hra-host-run"))).toContain("host-run.ts");
    let rules = readFileSync(rulesPath, "utf8");
    expect(rules).toContain("# Existing rule before the managed block.\n");
    expect(rules.match(/hra-local-efficiency:rules:start/gu)).toHaveLength(1);
    expect(rules).toContain(`pattern = [${JSON.stringify(join(bunBin, "hra-host-run"))}]`);
    expect(rules).toContain('decision = "prompt"');
    expect(rules).not.toContain('decision = "allow"');
    expect(statSync(rulesPath).mode & 0o777).toBe(0o640);

    rules += "# Existing rule after the managed block.\n";
    writeFileSync(rulesPath, rules);
    const reapplied = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(reapplied.exitCode, reapplied.stderr.toString()).toBe(0);
    expect(readFileSync(rulesPath, "utf8")).toBe(rules);

    const second = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--check",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(second.exitCode, second.stderr.toString()).toBe(0);
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toBe(guidance);
    expect(readFileSync(rulesPath, "utf8")).toBe(rules);

    writeFileSync(rulesPath, rules.replace('decision = "prompt"', 'decision = "allow"'));
    const drifted = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--check",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stderr.toString()).toContain("Codex host-access rule differs");
  });

  test("refuses a symlinked Codex rule without changing its target", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-rule-link-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    const rulesDirectory = join(codexHome, "rules");
    mkdirSync(rulesDirectory, { recursive: true });
    mkdirSync(bunBin);
    const managedTarget = join(root, "managed-rule.rules");
    writeFileSync(managedTarget, "# Managed elsewhere\n");
    symlinkSync(managedTarget, join(rulesDirectory, "hra-local-efficiency.rules"));
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: { ...process.env, HRA_ATET_HOST_RESOURCES_MODULE: modulePath },
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("non-regular Codex rule file");
    expect(readFileSync(managedTarget, "utf8")).toBe("# Managed elsewhere\n");
    expect(existsSync(join(codexHome, "AGENTS.md"))).toBe(false);
  });

  test("refuses a dotfiles-managed global guidance symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-link-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    mkdirSync(codexHome);
    mkdirSync(bunBin);
    const managedTarget = join(root, "managed-agents.md");
    writeFileSync(managedTarget, "# Managed elsewhere\n");
    symlinkSync(managedTarget, join(codexHome, "AGENTS.md"));
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: { ...process.env, HRA_ATET_HOST_RESOURCES_MODULE: modulePath },
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("non-regular global guidance");
    expect(readFileSync(managedTarget, "utf8")).toBe("# Managed elsewhere\n");
  });

  test("preserves exact profile symlinks and existing global Atet commands", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-dotfiles-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    const dotfiles = join(root, "dotfiles");
    const globalRoot = join(root, "global-bun");
    mkdirSync(codexHome);
    mkdirSync(bunBin);
    mkdirSync(dotfiles);
    mkdirSync(join(globalRoot, "bin"), { recursive: true });
    const globalAtet = join(globalRoot, "bin", "atet");
    writeFileSync(globalAtet, "existing-global-command\n");
    for (const profile of ["hra-worker.config.toml", "hra-routine.config.toml"]) {
      const target = join(dotfiles, profile);
      writeFileSync(target, readFileSync(join(import.meta.dir, "..", "assets", profile), "utf8"));
      symlinkSync(target, join(codexHome, profile));
    }
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");
    const environment = {
      ...process.env,
      BUN_INSTALL: globalRoot,
      HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
    };
    const arguments_ = [
      process.execPath,
      import.meta.dir + "/bootstrap.ts",
      "--apply",
      "--skip-dependency-install",
      "--codex-home",
      codexHome,
      "--bun-bin",
      bunBin,
    ];
    const applied = Bun.spawnSync({ cmd: arguments_, env: environment, stderr: "pipe" });
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    expect(readFileSync(globalAtet, "utf8")).toBe("existing-global-command\n");
    for (const profile of ["hra-worker.config.toml", "hra-routine.config.toml"]) {
      expect(lstatSync(join(codexHome, profile)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(codexHome, profile))).toBe(join(dotfiles, profile));
    }

    writeFileSync(join(dotfiles, "hra-worker.config.toml"), "changed externally\n");
    const check = Bun.spawnSync({
      cmd: arguments_.map((argument) => argument === "--apply" ? "--check" : argument),
      env: environment,
      stderr: "pipe",
    });
    expect(check.exitCode).toBe(1);
    const refused = Bun.spawnSync({ cmd: arguments_, env: environment, stderr: "pipe" });
    expect(refused.exitCode).toBe(1);
    expect(lstatSync(join(codexHome, "hra-worker.config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(globalAtet, "utf8")).toBe("existing-global-command\n");
  });

  test("updates a command link owned by a prior plugin-cache install", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-upgrade-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    const priorTarget = join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "hra-local-efficiency",
      "0.0.9",
      "skills",
      "hra-local-efficiency",
      "scripts",
      "host-run.ts",
    );
    mkdirSync(bunBin, { recursive: true });
    createPluginCommand(
      join(codexHome, "plugins", "cache", "hraness", "hra-local-efficiency", "0.0.9"),
      "host-run.ts",
      "prior managed command\n",
    );
    symlinkSync(priorTarget, join(bunBin, "hra-host-run"));
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: { ...process.env, HRA_ATET_HOST_RESOURCES_MODULE: modulePath },
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readlinkSync(join(bunBin, "hra-host-run"))).toBe(join(import.meta.dir, "host-run.ts"));
    expect(readFileSync(priorTarget, "utf8")).toBe("prior managed command\n");
  });

  test("updates a dangling command link after its prior plugin cache was pruned", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-pruned-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    const link = join(bunBin, "hra-host-run");
    const prunedTarget = join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "hra-local-efficiency",
      "0.0.8+codex.local-pruned",
      "skills",
      "hra-local-efficiency",
      "scripts",
      "host-run.ts",
    );
    mkdirSync(bunBin, { recursive: true });
    symlinkSync(prunedTarget, link);

    const currentTarget = join(import.meta.dir, "host-run.ts");
    expect(ensureManagedCommandSymlink(currentTarget, link, codexHome)).toBe("updated");
    expect(readlinkSync(link)).toBe(currentTarget);
  });

  test("refuses dangling checkout and cache lookalikes without changing them", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-dangling-lookalike-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    mkdirSync(bunBin, { recursive: true });
    const currentTarget = join(import.meta.dir, "host-run.ts");
    const lookalikes = [
      join(
        root,
        "repo",
        "plugins",
        "hra-local-efficiency",
        "skills",
        "hra-local-efficiency",
        "scripts",
        "host-run.ts",
      ),
      join(
        codexHome,
        "plugins",
        "cache",
        "hraness",
        "hra-local-efficiency",
        "versions",
        "0.0.8",
        "skills",
        "hra-local-efficiency",
        "scripts",
        "host-run.ts",
      ),
    ];

    for (const [index, lookalike] of lookalikes.entries()) {
      const link = join(bunBin, `hra-host-run-lookalike-${index}`);
      symlinkSync(lookalike, link);
      expect(() => ensureManagedCommandSymlink(currentTarget, link, codexHome))
        .toThrow("refusing to replace unmanaged command symlink");
      expect(readlinkSync(link)).toBe(lookalike);
    }
  });

  test("retargets an owned command between a source checkout and plugin cache", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-roundtrip-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    const link = join(bunBin, "hra-host-run");
    const checkoutTarget = createPluginCommand(
      join(root, "repo", "plugins", "hra-local-efficiency"),
      "host-run.ts",
    );
    const cacheTarget = createPluginCommand(
      join(codexHome, "plugins", "cache", "hraness", "hra-local-efficiency", "0.1.0"),
      "host-run.ts",
    );
    mkdirSync(bunBin, { recursive: true });
    symlinkSync(checkoutTarget, link);

    expect(ensureManagedCommandSymlink(cacheTarget, link, codexHome)).toBe("updated");
    expect(readlinkSync(link)).toBe(cacheTarget);
    expect(ensureManagedCommandSymlink(checkoutTarget, link, codexHome)).toBe("updated");
    expect(readlinkSync(link)).toBe(checkoutTarget);
  });

  test("refuses a lookalike command symlink without changing its target", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-unmanaged-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bunBin = join(root, "bin");
    const userTarget = createPluginCommand(
      join(root, "lookalike", "hra-local-efficiency"),
      "host-run.ts",
      "user-owned command\n",
    );
    mkdirSync(bunBin, { recursive: true });
    symlinkSync(userTarget, join(bunBin, "hra-host-run"));
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--bun-bin",
        bunBin,
      ],
      env: { ...process.env, HRA_ATET_HOST_RESOURCES_MODULE: modulePath },
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("refusing to replace unmanaged command symlink");
    expect(readlinkSync(join(bunBin, "hra-host-run"))).toBe(userTarget);
    expect(readFileSync(userTarget, "utf8")).toBe("user-owned command\n");
  });
});
