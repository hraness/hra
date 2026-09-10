import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ensureManagedSymlink,
  legacyMarkerPair,
  replaceManagedBlock,
  symlinkMatches,
  writeAtomic,
} from "./shared";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("shared Cloud efficiency helpers", () => {
  function pluginCommand(pluginRoot: string, pluginName = "oompa-cloud-efficiency"): string {
    const skillRoot = join(pluginRoot, "skills", pluginName);
    const target = join(skillRoot, "scripts", "route-check.ts");
    mkdirSync(join(pluginRoot, ".codex-plugin"), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({
      name: pluginName,
      skills: "./skills/",
    }));
    writeFileSync(join(skillRoot, "SKILL.md"), `---\nname: ${pluginName}\ndescription: fixture\n---\n`);
    writeFileSync(target, "fixture\n");
    return target;
  }

  test("replaces one legacy managed block in place and refuses mixed markers", () => {
    const start = "<!-- oompa-cloud-efficiency:start -->";
    const end = "<!-- oompa-cloud-efficiency:end -->";
    const legacy = legacyMarkerPair(start, end);
    expect(legacy).toEqual({
      end: "<!-- hra-cloud-efficiency:end -->",
      start: "<!-- hra-cloud-efficiency:start -->",
    });
    const block = `${start}\nnew\n${end}\n`;
    const current = `before\n\n${legacy.start}\nold\n${legacy.end}\n\nafter\n`;
    expect(replaceManagedBlock(current, block, start, end, legacy))
      .toBe(`before\n\n${block.slice(0, -1)}\n\nafter\n`);
    expect(replaceManagedBlock(current, block, start, end))
      .toBe(`${current}\n${block}`);
    expect(() => replaceManagedBlock(`${current}\n${block}`, block, start, end, legacy))
      .toThrow("mix legacy and current");
    expect(() => replaceManagedBlock(`${legacy.start}\n`, block, start, end, legacy))
      .toThrow("incomplete");
  });

  test("updates a prior link owned by the previous plugin identity", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-cloud-legacy-link-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bin = join(root, "bin");
    const legacyTarget = pluginCommand(
      join(codexHome, "plugins", "cache", "hraness", "hra-cloud-efficiency", "0.1.1"),
      "hra-cloud-efficiency",
    );
    const newTarget = pluginCommand(join(root, "source", "plugins", "oompa-cloud-efficiency"));
    mkdirSync(bin);
    symlinkSync(legacyTarget, join(bin, "hra-cloud-route"));
    expect(() => ensureManagedSymlink(
      join(bin, "hra-cloud-route"),
      newTarget,
      "oompa-cloud-efficiency",
      codexHome,
    )).toThrow("unrelated");
    expect(ensureManagedSymlink(
      join(bin, "hra-cloud-route"),
      newTarget,
      ["oompa-cloud-efficiency", "hra-cloud-efficiency"],
      codexHome,
    )).toBe("updated");
    expect(readFileSync(legacyTarget, "utf8")).toBe("fixture\n");

    // A cache whose directory and manifest disagree on the plugin name is not owned.
    const inconsistent = pluginCommand(
      join(codexHome, "plugins", "cache", "hraness", "oompa-cloud-efficiency", "0.1.2"),
      "hra-cloud-efficiency",
    );
    symlinkSync(inconsistent, join(bin, "inconsistent"));
    expect(() => ensureManagedSymlink(
      join(bin, "inconsistent"),
      newTarget,
      ["oompa-cloud-efficiency", "hra-cloud-efficiency"],
      codexHome,
    )).toThrow("unrelated");
  });

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
    const root = mkdtempSync(join(tmpdir(), "oompa-cloud-shared-"));
    temporary.push(root);
    const path = join(root, "nested", "value.txt");
    writeAtomic(path, "value\n", 0o600);
    expect(readFileSync(path, "utf8")).toBe("value\n");
  });

  test("requires a live executable regular target for a current command link", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-cloud-current-link-"));
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
    const root = mkdtempSync(join(tmpdir(), "oompa-cloud-link-"));
    temporary.push(root);
    const codexHome = join(root, "codex");
    const bin = join(root, "bin");
    const oldTarget = pluginCommand(join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "oompa-cloud-efficiency",
      "0.0.1",
    ));
    const newTarget = pluginCommand(join(root, "source", "plugins", "oompa-cloud-efficiency"));
    mkdirSync(bin);
    symlinkSync(oldTarget, join(bin, "hra-cloud-route"));
    expect(ensureManagedSymlink(
      join(bin, "hra-cloud-route"),
      newTarget,
      "oompa-cloud-efficiency",
      codexHome,
    )).toBe("updated");

    const unrelated = join(root, "unrelated");
    writeFileSync(unrelated, "other");
    symlinkSync(unrelated, join(bin, "other"));
    expect(() => ensureManagedSymlink(
      join(bin, "other"),
      newTarget,
      "oompa-cloud-efficiency",
      codexHome,
    )).toThrow("unrelated");

    const lookalike = join(
      root,
      "lookalike",
      "plugins",
      "oompa-cloud-efficiency",
      "skills",
      "oompa-cloud-efficiency",
      "scripts",
      "route-check.ts",
    );
    mkdirSync(dirname(lookalike), { recursive: true });
    writeFileSync(lookalike, "unowned\n");
    symlinkSync(lookalike, join(bin, "lookalike"));
    expect(() => ensureManagedSymlink(
      join(bin, "lookalike"),
      newTarget,
      "oompa-cloud-efficiency",
      codexHome,
    )).toThrow("unrelated");

    const dangling = join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "oompa-cloud-efficiency",
      "0.0.0-pruned",
      "skills",
      "oompa-cloud-efficiency",
      "scripts",
      "route-check.ts",
    );
    symlinkSync(dangling, join(bin, "dangling"));
    expect(ensureManagedSymlink(
      join(bin, "dangling"),
      newTarget,
      "oompa-cloud-efficiency",
      codexHome,
    )).toBe("updated");

    const danglingLookalike = join(
      codexHome,
      "plugins",
      "cache",
      "hraness",
      "oompa-cloud-efficiency",
      "versions",
      "0.0.0",
      "skills",
      "oompa-cloud-efficiency",
      "scripts",
      "route-check.ts",
    );
    symlinkSync(danglingLookalike, join(bin, "dangling-lookalike"));
    expect(() => ensureManagedSymlink(
      join(bin, "dangling-lookalike"),
      newTarget,
      "oompa-cloud-efficiency",
      codexHome,
    )).toThrow("unrelated");
  });
});
