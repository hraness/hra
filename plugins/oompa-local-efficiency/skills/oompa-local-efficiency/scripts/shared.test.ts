import { describe, expect, test } from "bun:test";

import {
  legacyMarkerAlias,
  legacyMarkerPair,
  replaceManagedBlock,
  resolvedBunBin,
  resolvedCodexHome,
} from "./shared";

const start = "<!-- oompa-local-efficiency:start -->";
const end = "<!-- oompa-local-efficiency:end -->";
const block = `${start}\nmanaged\n${end}\n`;
const legacy = legacyMarkerPair(start, end);
const legacyBlock = `${legacy.start}\nold\n${legacy.end}`;

describe("shared machine configuration helpers", () => {
  test("appends and replaces only the managed block", () => {
    const installed = replaceManagedBlock("# Existing\n", block, start, end);
    expect(installed).toBe(`# Existing\n\n${block}`);
    expect(replaceManagedBlock(installed.replace("managed", "old"), block, start, end))
      .toBe(installed);
  });

  test("preserves every unmanaged byte while replacing a block", () => {
    const prefix = "\ufeff# Existing  \r\n\r\n";
    const suffix = "\r\nTail\t  \r\n\r\n";
    const current = `${prefix}${start}\r\nold\r\n${end}${suffix}`;

    expect(replaceManagedBlock(current, block, start, end))
      .toBe(`${prefix}${block.slice(0, -1)}${suffix}`);
  });

  test("appends with a minimal separator without normalizing existing bytes", () => {
    const withoutNewline = "# Existing  \r\nTail\t ";
    const withNewline = "# Existing  \r\n";
    const withBlankLine = "# Existing  \r\n\n";
    const whitespaceOnly = " \t";

    expect(replaceManagedBlock(withoutNewline, block, start, end))
      .toBe(`${withoutNewline}\n\n${block}`);
    expect(replaceManagedBlock(withNewline, block, start, end))
      .toBe(`${withNewline}\n${block}`);
    expect(replaceManagedBlock(withBlankLine, block, start, end))
      .toBe(`${withBlankLine}${block}`);
    expect(replaceManagedBlock(whitespaceOnly, block, start, end))
      .toBe(`${whitespaceOnly}\n\n${block}`);
  });

  test("refuses incomplete markers", () => {
    expect(() => replaceManagedBlock(start, block, start, end)).toThrow("incomplete");
  });

  test("derives the legacy marker pair from the current pair", () => {
    expect(legacy).toEqual({
      end: "<!-- hra-local-efficiency:end -->",
      start: "<!-- hra-local-efficiency:start -->",
    });
    expect(legacyMarkerAlias("# oompa-local-efficiency:rules:start"))
      .toBe("# hra-local-efficiency:rules:start");
    expect(() => legacyMarkerAlias("<!-- other:start -->")).toThrow("no legacy alias");
  });

  test("replaces one legacy block in place, markers included", () => {
    const current = `# Existing\n\n${legacyBlock}\n\nTail\n`;
    const migrated = replaceManagedBlock(current, block, start, end, legacy);
    expect(migrated).toBe(`# Existing\n\n${block.slice(0, -1)}\n\nTail\n`);
    expect(migrated).not.toContain("hra-local-efficiency");
    expect(replaceManagedBlock(migrated, block, start, end, legacy)).toBe(migrated);
    expect(replaceManagedBlock(`Tail\n${legacyBlock}`, block, start, end, legacy))
      .toBe(`Tail\n${block}`);
  });

  test("ignores legacy markers unless the alias is supplied", () => {
    const current = `${legacyBlock}\n`;
    expect(replaceManagedBlock(current, block, start, end)).toBe(`${current}\n${block}`);
  });

  test("refuses mixed legacy and current markers and malformed legacy blocks", () => {
    expect(() => replaceManagedBlock(`${legacyBlock}\n\n${block}`, block, start, end, legacy))
      .toThrow("mix legacy and current");
    expect(() => replaceManagedBlock(`${legacy.start}\n${end}\n`, block, start, end, legacy))
      .toThrow("mix legacy and current");
    expect(() => replaceManagedBlock(`${legacy.start}\nold\n`, block, start, end, legacy))
      .toThrow(`incomplete: ${legacy.start}`);
    expect(() => replaceManagedBlock(`${legacy.end}\nold\n${legacy.start}\n`, block, start, end, legacy))
      .toThrow("reversed");
    expect(() => replaceManagedBlock(`${legacyBlock}\n${legacyBlock}\n`, block, start, end, legacy))
      .toThrow("duplicated");
  });

  test("resolves Codex and Bun locations without repurposing home variables", () => {
    expect(resolvedCodexHome({}, "/opt/tester")).toBe("/opt/tester/.codex");
    expect(resolvedCodexHome({ CODEX_HOME: "/tmp/codex" }, "/opt/tester"))
      .toBe("/tmp/codex");
    expect(resolvedBunBin({}, "/opt/tester")).toBe("/opt/tester/.bun/bin");
    expect(resolvedBunBin({ BUN_INSTALL: "/opt/bun" }, "/opt/tester"))
      .toBe("/opt/bun/bin");
  });
});
