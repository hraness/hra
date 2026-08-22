import { describe, expect, test } from "bun:test";

import { LocalCliUsageError, parseLocalCliArgs } from "./args";

describe("local hra CLI arguments", () => {
  test("accepts exactly the two JSON read commands", () => {
    expect(parseLocalCliArgs(["attention", "list", "--json"])).toEqual({
      operation: "attention.list",
    });
    expect(parseLocalCliArgs(["pane", "list", "--json"])).toEqual({
      operation: "panes.list",
    });
  });

  const rejected = [
    [],
    ["attention", "list"],
    ["panes", "list", "--json"],
    ["pane", "list", "--json", "extra"],
    ["pane", "send", "pane_abcdefgh", "--json"],
    ["pane", "list", "--socket", "/tmp/override"],
    ["attention", "list", "--capability", "secret"],
  ] as const;
  for (const [index, argv] of rejected.entries()) {
    test(`rejects undocumented argv ${index + 1}`, () => {
      expect(() => parseLocalCliArgs(argv)).toThrow(LocalCliUsageError);
    });
  }
});
