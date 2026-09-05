import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
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
  claudeAutoModeCapability,
  ensureManagedCommandSymlink,
  parseBootstrapArguments,
} from "./bootstrap";

const temporary: string[] = [];
const validAutoModeProbeLists = {
  allow: ["default allow"],
  environment: ["default environment"],
  hard_deny: ["default hard deny"],
  soft_deny: ["default soft deny"],
} as const;
const validAutoModeProbeOutput = JSON.stringify(validAutoModeProbeLists);

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

function fakeClaude(
  root: string,
  version = "2.1.261",
  configExit = 0,
  configOutput = validAutoModeProbeOutput,
  defaultsOutput = validAutoModeProbeOutput,
): Readonly<NodeJS.ProcessEnv> {
  const tools = join(root, "tools");
  mkdirSync(tools, { recursive: true });
  const executable = join(tools, "claude");
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' '${version} (Claude Code)'
  exit 0
fi
if [ "$1" = "auto-mode" ] && [ "$2" = "config" ]; then
  printf '%s\\n' '${configOutput}'
  exit ${configExit}
fi
if [ "$1" = "auto-mode" ] && [ "$2" = "defaults" ]; then
  printf '%s\\n' '${defaultsOutput}'
  exit ${configExit}
fi
exit 2
`);
  chmodSync(executable, 0o755);
  return {
    ...process.env,
    PATH: `${tools}:${process.env.PATH ?? ""}`,
  };
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
    const claudeHome = join(root, "claude");
    const bunBin = join(root, "bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    mkdirSync(join(codexHome, "rules"), { recursive: true });
    writeFileSync(join(codexHome, "AGENTS.md"), "# Existing\n\nKeep me.\n");
    chmodSync(join(codexHome, "AGENTS.md"), 0o600);
    const originalCodexConfig = "# Keep this comment exactly.\napproval_policy = \"never\"\n\n[features]\nkeep_me = true\n";
    writeFileSync(join(codexHome, "config.toml"), originalCodexConfig);
    chmodSync(join(codexHome, "config.toml"), 0o640);
    const rulesPath = join(codexHome, "rules", "hra-local-efficiency.rules");
    writeFileSync(rulesPath, "# Existing rule before the managed block.\n");
    chmodSync(rulesPath, 0o640);
    const originalClaudeSettings = `{
  "keep": { "spacing":  true },
  "permissions": {
    "allow": ["Read", "PowerShell", "Monitor", "NotebookEdit", "Artifact", "Workflow", "mcp__example__deploy", "NotebookEdit(*)", "Artifact(**)", "Workflow(/**)", "mcp__example__deploy( * )", "PowerShell(*)", "Bash(gh *)", "Bash(gh:*)", "Bash(gh release *)", "Bash(python*)", "Bash(vercel *)", "Bash(bun run cli *)", "Bash(git status)", "Read(./docs/**)"],
    "deny": ["Bash(rm -rf *)"],
    "defaultMode": "default"
  },
  "autoMode": {
    "allow": ["Bash(git status)"],
    "soft_deny": ["Never destroy production"],
    "environment": ["A custom environment constraint that should be preserved.", "$defaults", "$defaults"]
  }
}
`;
    writeFileSync(join(claudeHome, "settings.json"), originalClaudeSettings);
    chmodSync(join(claudeHome, "settings.json"), 0o600);
    writeFileSync(join(claudeHome, "CLAUDE.md"), "# Existing Claude guidance\n\nKeep this too.\n");
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");
    const environment = {
      ...fakeClaude(root),
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
        "--claude-home",
        claudeHome,
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
    const codexConfig = readFileSync(join(codexHome, "config.toml"), "utf8");
    expect(codexConfig).toContain('# Keep this comment exactly.\n\n[features]\nkeep_me = true\n');
    expect(codexConfig).not.toContain('approval_policy = "never"');
    expect(Bun.TOML.parse(codexConfig)).toMatchObject({
      approval_policy: "on-request",
      approvals_reviewer: "auto_review",
      default_permissions: ":workspace",
      features: { keep_me: true },
    });
    expect(statSync(join(codexHome, "config.toml")).mode & 0o777).toBe(0o640);
    const claudeSettingsText = readFileSync(join(claudeHome, "settings.json"), "utf8");
    expect(claudeSettingsText).toContain('  "keep": { "spacing":  true },');
    expect(claudeSettingsText).toContain('    "allow": ["Bash(git status)","Read(./docs/**)"]');
    expect(claudeSettingsText).toContain('    "deny": ["Bash(rm -rf *)"],');
    expect(claudeSettingsText).not.toContain('"Bash(gh *)"');
    expect(claudeSettingsText).not.toContain('"Bash(vercel *)"');
    expect(claudeSettingsText).not.toContain('"Bash(gh:*)"');
    expect(claudeSettingsText).not.toContain('"Bash(gh release *)"');
    expect(claudeSettingsText).not.toContain('"Bash(python*)"');
    expect(claudeSettingsText).not.toContain('"Bash(bun run cli *)"');
    expect(claudeSettingsText).not.toContain('"PowerShell"');
    expect(claudeSettingsText).not.toContain('"PowerShell(*)"');
    expect(claudeSettingsText).not.toContain('"Read"');
    expect(claudeSettingsText).not.toContain('"Monitor"');
    expect(claudeSettingsText).not.toContain('"NotebookEdit"');
    expect(claudeSettingsText).not.toContain('"Artifact"');
    expect(claudeSettingsText).not.toContain('"Workflow"');
    expect(claudeSettingsText).not.toContain('"mcp__example__deploy"');
    expect(claudeSettingsText).not.toContain('"NotebookEdit(*)"');
    expect(claudeSettingsText).not.toContain('"Artifact(**)"');
    expect(claudeSettingsText).not.toContain('"Workflow(/**)"');
    expect(claudeSettingsText).not.toContain('"mcp__example__deploy( * )"');
    expect(claudeSettingsText).toContain('    "allow": ["$defaults","Bash(git status)"],');
    const parsedClaudeSettings = JSON.parse(claudeSettingsText) as {
      autoMode: { allow: unknown; environment: unknown; soft_deny: unknown };
      permissions: { allow: unknown; defaultMode: unknown; deny: unknown };
    };
    expect(parsedClaudeSettings.permissions.defaultMode).toBe("auto");
    expect(parsedClaudeSettings.permissions.allow).toEqual([
      "Bash(git status)",
      "Read(./docs/**)",
    ]);
    expect(parsedClaudeSettings.permissions.deny).toEqual(["Bash(rm -rf *)"]);
    expect(parsedClaudeSettings.autoMode.allow).toEqual(["$defaults", "Bash(git status)"]);
    expect(parsedClaudeSettings.autoMode.environment).toEqual([
      "$defaults",
      "A custom environment constraint that should be preserved.",
    ]);
    expect(parsedClaudeSettings.autoMode.soft_deny).toEqual(["$defaults", "Never destroy production"]);
    const claudeGuidance = readFileSync(join(claudeHome, "CLAUDE.md"), "utf8");
    expect(claudeGuidance).toContain("Keep this too.");
    expect(claudeGuidance.match(/hra-local-efficiency:start/gu)).toHaveLength(1);
    expect(readlinkSync(join(bunBin, "hra-host-run"))).toContain("host-run.ts");
    expect(readlinkSync(join(bunBin, "hra-throughput-report"))).toContain("throughput-report.ts");
    expect(readlinkSync(join(bunBin, "hra-ci-ref-audit"))).toContain("ci-ref-audit.ts");
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
        "--claude-home",
        claudeHome,
        "--bun-bin",
        bunBin,
      ],
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(reapplied.exitCode, reapplied.stderr.toString()).toBe(0);
    expect(readFileSync(rulesPath, "utf8")).toBe(rules);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(codexConfig);
    expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(claudeSettingsText);
    expect(readFileSync(join(claudeHome, "CLAUDE.md"), "utf8")).toBe(claudeGuidance);

    const second = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--check",
        "--codex-home",
        codexHome,
        "--claude-home",
        claudeHome,
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
        "--claude-home",
        claudeHome,
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

  test("leaves Claude permission settings unchanged when Auto mode is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-claude-fallback-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const claudeHome = join(root, "claude");
    const bunBin = join(root, "bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    const settings = '{\n  "permissions": { "defaultMode": "default" },\n  "keep": true\n}\n';
    writeFileSync(join(claudeHome, "settings.json"), settings);
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");
    const environment = {
      ...fakeClaude(root, "2.1.82"),
      HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
    };

    expect(claudeAutoModeCapability(environment)).toEqual({
      available: false,
      reason: "cli_too_old",
      version: "2.1.82",
    });
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--claude-home",
        claudeHome,
        "--bun-bin",
        bunBin,
      ],
      env: environment,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("SKIP\tClaude Auto mode unavailable (cli_too_old)");
    expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(join(claudeHome, "CLAUDE.md"), "utf8"))
      .toContain("Use Claude Code auto mode when it is available");
  });

  test("reports a malformed Auto-mode configuration surface accurately", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-claude-config-"));
    temporary.push(root);
    expect(claudeAutoModeCapability(fakeClaude(root, "2.1.261", 0, "not-json"))).toEqual({
      available: false,
      reason: "config_unavailable",
      version: "2.1.261",
    });
  });

  test("accepts empty effective Auto-mode lists but requires nonempty shipped defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-empty-config-"));
    temporary.push(root);
    const emptyLists = JSON.stringify({
      allow: [],
      environment: [],
      hard_deny: [],
      soft_deny: [],
    });

    expect(
      claudeAutoModeCapability(
        fakeClaude(root, "2.1.261", 0, emptyLists, validAutoModeProbeOutput),
      ),
    ).toEqual({ available: true, reason: "available", version: "2.1.261" });
    for (const key of ["allow", "environment", "hard_deny", "soft_deny"] as const) {
      const invalidDefaults = JSON.stringify({ ...validAutoModeProbeLists, [key]: [] });
      expect(
        claudeAutoModeCapability(
          fakeClaude(root, "2.1.261", 0, emptyLists, invalidDefaults),
        ),
      ).toEqual({ available: false, reason: "config_unavailable", version: "2.1.261" });
    }
  });

  test("repairs an empty effective soft deny and detects later drift", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-soft-deny-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const claudeHome = join(root, "claude");
    const bunBin = join(root, "bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    writeFileSync(
      join(claudeHome, "settings.json"),
      `${JSON.stringify({ autoMode: { soft_deny: [] } }, null, 2)}\n`,
    );
    const modulePath = join(root, "host-resources.js");
    writeFileSync(modulePath, "export const createHostResourceCoordinator = () => ({})\n");
    const emptyLists = JSON.stringify({
      allow: [],
      environment: [],
      hard_deny: [],
      soft_deny: [],
    });
    const environment = {
      ...fakeClaude(root, "2.1.261", 0, emptyLists, validAutoModeProbeOutput),
      HRA_ATET_HOST_RESOURCES_MODULE: modulePath,
    };
    const arguments_ = [
      process.execPath,
      import.meta.dir + "/bootstrap.ts",
      "--apply",
      "--skip-dependency-install",
      "--codex-home",
      codexHome,
      "--claude-home",
      claudeHome,
      "--bun-bin",
      bunBin,
    ];

    const applied = Bun.spawnSync({ cmd: arguments_, env: environment, stderr: "pipe" });
    expect(applied.exitCode, applied.stderr.toString()).toBe(0);
    const settingsPath = join(claudeHome, "settings.json");
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      autoMode: { soft_deny: unknown };
    };
    expect(settings.autoMode.soft_deny).toEqual(["$defaults"]);

    writeFileSync(
      settingsPath,
      `${JSON.stringify({ ...settings, autoMode: { ...settings.autoMode, soft_deny: [] } }, null, 2)}\n`,
    );
    const checked = Bun.spawnSync({
      cmd: arguments_.map((argument) => argument === "--apply" ? "--check" : argument),
      env: environment,
      stderr: "pipe",
    });
    expect(checked.exitCode).toBe(1);
    expect(checked.stderr.toString()).toContain("Claude settings differ");
  });

  test("refuses managed-marker lookalikes inside TOML multiline strings", () => {
    for (const quote of ['"""', "'''"]) {
      const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-toml-marker-"));
      temporary.push(root);
      const codexHome = join(root, "codex");
      const claudeHome = join(root, "claude");
      const bunBin = join(root, "bin");
      mkdirSync(codexHome, { recursive: true });
      mkdirSync(claudeHome, { recursive: true });
      mkdirSync(bunBin, { recursive: true });
      const config = `note = ${quote}\n# hra-local-efficiency:config:start\nkeep me\n# hra-local-efficiency:config:end\n${quote}\n`;
      writeFileSync(join(codexHome, "config.toml"), config);
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
          "--claude-home",
          claudeHome,
          "--bun-bin",
          bunBin,
        ],
        env: { ...fakeClaude(root), HRA_ATET_HOST_RESOURCES_MODULE: modulePath },
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain("managed marker must be a TOML comment token");
      expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(config);
    }
  });

  test("preflights every managed config before changing any target", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-preflight-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const claudeHome = join(root, "claude");
    const bunBin = join(root, "bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    const originalGuidance = "# User-owned guidance\n";
    writeFileSync(join(codexHome, "AGENTS.md"), originalGuidance);
    writeFileSync(join(claudeHome, "settings.json"), "{ invalid JSON\n");
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
        "--claude-home",
        claudeHome,
        "--bun-bin",
        bunBin,
      ],
      env: { ...fakeClaude(root), HRA_ATET_HOST_RESOURCES_MODULE: modulePath },
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Claude settings is not valid JSON");
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toBe(originalGuidance);
    expect(existsSync(join(codexHome, "config.toml"))).toBe(false);
    expect(existsSync(join(claudeHome, "CLAUDE.md"))).toBe(false);
  });

  test("refuses hard-linked user configuration before changing guidance", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-local-efficiency-bootstrap-hardlink-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const claudeHome = join(root, "claude");
    const bunBin = join(root, "bin");
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(claudeHome, { recursive: true });
    mkdirSync(bunBin, { recursive: true });
    const originalGuidance = "# User-owned guidance\n";
    writeFileSync(join(codexHome, "AGENTS.md"), originalGuidance);
    const managedElsewhere = join(root, "managed-config.toml");
    writeFileSync(managedElsewhere, "model = \"keep-me\"\n");
    linkSync(managedElsewhere, join(codexHome, "config.toml"));

    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        import.meta.dir + "/bootstrap.ts",
        "--apply",
        "--skip-dependency-install",
        "--codex-home",
        codexHome,
        "--claude-home",
        claudeHome,
        "--bun-bin",
        bunBin,
      ],
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("hard-linked Codex config");
    expect(readFileSync(managedElsewhere, "utf8")).toBe("model = \"keep-me\"\n");
    expect(readFileSync(join(codexHome, "AGENTS.md"), "utf8")).toBe(originalGuidance);
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
        "--claude-home",
        join(root, "claude"),
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
        "--claude-home",
        join(root, "claude"),
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
      "--claude-home",
      join(root, "claude"),
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
  }, 10_000);

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
        "--claude-home",
        join(root, "claude"),
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
        "--claude-home",
        join(root, "claude"),
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
