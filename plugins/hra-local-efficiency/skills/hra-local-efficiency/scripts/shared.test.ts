import { describe, expect, test } from "bun:test";

import { replaceManagedBlock, resolvedBunBin, resolvedCodexHome } from "./shared";

const start = "<!-- hra-local-efficiency:start -->";
const end = "<!-- hra-local-efficiency:end -->";
const block = `${start}\nmanaged\n${end}\n`;

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

  test("resolves Codex and Bun locations without repurposing home variables", () => {
    expect(resolvedCodexHome({}, "/opt/tester")).toBe("/opt/tester/.codex");
    expect(resolvedCodexHome({ CODEX_HOME: "/tmp/codex" }, "/opt/tester"))
      .toBe("/tmp/codex");
    expect(resolvedBunBin({}, "/opt/tester")).toBe("/opt/tester/.bun/bin");
    expect(resolvedBunBin({ BUN_INSTALL: "/opt/bun" }, "/opt/tester"))
      .toBe("/opt/bun/bin");
  });
});
