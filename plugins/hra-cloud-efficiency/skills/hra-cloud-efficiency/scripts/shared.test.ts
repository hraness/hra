import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ensureManagedSymlink, replaceManagedBlock, symlinkMatches, writeAtomic } from "./shared";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("shared Cloud efficiency helpers", () => {
  function pluginCommand(pluginRoot: string): string {
    const skillRoot = join(pluginRoot, "skills", "hra-cloud-efficiency");
    const target = join(skillRoot, "scripts", "route-check.ts");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: "hra-cloud-efficiency",
      skills: "./skills/",
    }));
    writeFileSync(join(skillRoot, "SKILL.md"), "---\nname: hra-cloud-efficiency\ndescription: fixture\n---\n");
    writeFileSync(target, "fixture\n");
    return target;
  }

  test("replaces one managed block and preserves surrounding content", () => {
    const current = "before\n\n<!-- x:start -->\nold\n<!-- x:end -->\n\nafter\n";
    expect(replaceManagedBlock(
      current,
      "<!-- x:start -->\nnew\n<!-- x:end -->\n",
      "<!-- x:start -->",
      "<!-- x:end -->",
    )).toBe("before\n\n<!-- x:start -->\nnew\n<!-- x:end -->\n\nafter\n");
    expect(() => replaceManagedBlock(
      "<!-- x:start -->\n",
      "block",
      "<!-- x:start -->",
      "<!-- x:end -->",
    )).toThrow("incomplete");
  });

  test("writes exact content atomically", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-cloud-shared-"));
    temporary.push(root);
    const path = join(root, "nested", "value.txt");
    writeAtomic(path, "value\n", 0o600);
    expect(readFileSync(path, "utf8")).toBe("value\n");
  });

  test("requires a live executable regular target for a current command link", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-cloud-current-link-"));
    temporary.push(root);
    const target = join(root, "command.ts");
    const link = join(root, "command");
    writeFileSync(target, "#!/usr/bin/env bun\n", { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, link);
    expect(symlinkMatches(link, target)).toBe(true);
    chmodSync(target, 0o644);
    expect(symlinkMatches(link, target)).toBe(false);
    rmSync(target);
    expect(symlinkMatches(link, target)).toBe(false);
  });

  test("updates only a prior link owned by this plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "hra-cloud-link-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bin = join(root, "bin");
    const oldTarget = pluginCommand(join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "hra-cloud-efficiency",
      "0.0.1",
    ));
    const newTarget = pluginCommand(join(root, "source", "plugins", "hra-cloud-efficiency"));
    mkdirSync(bin);
    symlinkSync(oldTarget, join(bin, "hra-cloud-route"));
    expect(ensureManagedSymlink(
      join(bin, "hra-cloud-route"),
      newTarget,
      "hra-cloud-efficiency",
      codexHome,
    )).toBe("updated");

    const unrelated = join(root, "unrelated");
    writeFileSync(unrelated, "other");
    symlinkSync(unrelated, join(bin, "other"));
    expect(() => ensureManagedSymlink(
      join(bin, "other"),
      newTarget,
      "hra-cloud-efficiency",
      codexHome,
    )).toThrow("unrelated");

    const lookalike = join(
      root,
      "lookalike",
      "plugins",
      "hra-cloud-efficiency",
      "skills",
      "hra-cloud-efficiency",
      "scripts",
      "route-check.ts",
    );
    mkdirSync(dirname(lookalike), { recursive: true });
    writeFileSync(lookalike, "unowned\n");
    symlinkSync(lookalike, join(bin, "lookalike"));
    expect(() => ensureManagedSymlink(
      join(bin, "lookalike"),
      newTarget,
      "hra-cloud-efficiency",
      codexHome,
    )).toThrow("unrelated");

    const dangling = join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "hra-cloud-efficiency",
      "0.0.0-pruned",
      "skills",
      "hra-cloud-efficiency",
      "scripts",
      "route-check.ts",
    );
    symlinkSync(dangling, join(bin, "dangling"));
    expect(ensureManagedSymlink(
      join(bin, "dangling"),
      newTarget,
      "hra-cloud-efficiency",
      codexHome,
    )).toBe("updated");

    const danglingLookalike = join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "hra-cloud-efficiency",
      "versions",
      "0.0.0",
      "skills",
      "hra-cloud-efficiency",
      "scripts",
      "route-check.ts",
    );
    symlinkSync(danglingLookalike, join(bin, "dangling-lookalike"));
    expect(() => ensureManagedSymlink(
      join(bin, "dangling-lookalike"),
      newTarget,
      "hra-cloud-efficiency",
      codexHome,
    )).toThrow("unrelated");
  });
});
