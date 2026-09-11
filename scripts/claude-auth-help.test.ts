import { createHash } from "node:crypto";

import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import { ClaudeAuthHelpError, inspectClaudeAuthLoginHelp, parseClaudeAuthLogoutHelp } from "./claude-auth-help";

const help = "Usage: claude auth logout [options]\n\nLog out from your Anthropic account\n\nOptions:\n  -h, --help  Display help for command\n";
const output = (stdout = help) => ({ exitCode: 0, stderr: "", stdout });

test("shared logout grammar retains exact-byte digests, descriptive prose and supported help spacing", () => {
  for (const stdout of [help, help.slice(0, -1), help.replace("Log out from your Anthropic account", "Updated descriptive prose"),
    "\nUsage: claude auth logout [options]\n\nOptions:\n    -h,   --help      Render command help\n"]) {
    expect(parseClaudeAuthLogoutHelp(output(stdout))).toBe(createHash("sha256").update(stdout, "utf8").digest("hex"));
  }
});

test("logout capability refuses changed usage, option grammar, extra flags and output ambiguity", () => {
  const bad: unknown[] = [null, {}, { ...output(), exitCode: 1 }, { ...output(), stderr: "diagnostic" }, { ...output(), extra: true },
    output(""), output(help.replace("logout", "login")), output(help.replace("[options]", "[arguments]")),
    output(help.replace("Options:", "Options:\nOptions:")), output(help.replace("  -h, --help", "  -h, --help <value>")),
    output(`${help}  --token <value>  Token\n`), output(`${help}  -h, --help  duplicate\n`), output(help.replace("--help", "--helpful")),
    output(`${help}${"x".repeat(16 * 1024)}`)];
  for (const input of bad) expect(() => parseClaudeAuthLogoutHelp(input)).toThrow(ClaudeAuthHelpError);
});

test("every ASCII control except LF is refused at the shared help boundary", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 127 }).filter((value) => (value < 32 || value === 127) && value !== 10), (control) => {
    const input = output(help.replace("Log out", `Log${String.fromCharCode(control)}out`));
    expect(() => parseClaudeAuthLogoutHelp(input)).toThrow(ClaudeAuthHelpError);
    expect(() => inspectClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
  }));
});

test("oversized unknown help refuses before allocating or scanning normalized text", () => {
  const replace = spyOn(String.prototype, "replaceAll").mockImplementation(() => { throw new Error("oversized text was processed"); });
  try {
    const input = output("x".repeat(16_385));
    expect(() => parseClaudeAuthLogoutHelp(input)).toThrow(ClaudeAuthHelpError);
    expect(() => inspectClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
    expect(replace).not.toHaveBeenCalled();
  } finally { replace.mockRestore(); }
});

test("login help yields private diagnostic evidence only, never capability admission", () => {
  for (const stdout of ["Usage: claude auth login [options]\n\nOptions:\n  --claudeai\n  -h, --help\n", "unreviewed future help text\n"]) {
    expect(inspectClaudeAuthLoginHelp(output(stdout))).toMatchObject({ admitted: false, reason: "login_help_unverified",
      helpSha256: createHash("sha256").update(stdout, "utf8").digest("hex") });
  }
  for (const input of [output(" \n"), { ...output(), exitCode: 1 }, { ...output(), stderr: "unexpected" }, output("\u001b[32mhelp"), output("x".repeat(16_385))]) {
    expect(() => inspectClaudeAuthLoginHelp(input)).toThrow(ClaudeAuthHelpError);
  }
});

test("unverified option projection returns only flag tokens and argument kind", () => {
  const stdout = "Usage: claude auth login [options]\n\nPrivate description\n\nOptions:\n"
    + "  --claudeai  Use a browser\n  --email <privatePlaceholder>  Private description\n"
    + "  --organization [privatePlaceholder]  Private description\n  -h, --help  Display help\n";
  const value = inspectClaudeAuthLoginHelp(output(stdout));
  expect(value).toMatchObject({ admitted: false, projectionComplete: true, optionRows: [
    { flags: ["--claudeai"], argument: "none" }, { flags: ["--email"], argument: "required" },
    { flags: ["--organization"], argument: "optional" }, { flags: ["-h", "--help"], argument: "none" },
  ] });
  expect(JSON.stringify(value)).not.toContain("Private"); expect(JSON.stringify(value)).not.toContain("privatePlaceholder");
  expect(Object.isFrozen(value.optionRows)).toBeTrue(); expect(Object.isFrozen(value.optionRows[0]?.flags)).toBeTrue();
});

test("duplicate, malformed, unknown and excess option rows remain explicitly incomplete", () => {
  const prefix = "Usage: claude auth login [options]\nOptions:\n  --claudeai  description\n";
  for (const suffix of ["  --claudeai  duplicate\n", "  --unknown=value  unsupported spelling\n", "  unexpected description continuation\n",
    "Options:\n  --another\n", `  --${"x".repeat(65)}\n`, `  --flag <${"x".repeat(256)}>\n`, "\n".repeat(256),
    Array.from({ length: 33 }, (_, index) => `  --flag-${index}\n`).join("")]) {
    const value = inspectClaudeAuthLoginHelp(output(prefix + suffix));
    expect(value.admitted).toBeFalse(); expect(value.projectionComplete).toBeFalse(); expect(value.optionRows.length).toBeLessThanOrEqual(32);
    expect(value).not.toHaveProperty("stdout");
  }
});

test("unverified projection has fixed token and row bounds for arbitrary help text", () => {
  fc.assert(fc.property(fc.string({ maxLength: 2000 }), (suffix) => {
    const stdout = `Usage: claude auth login [options]\nOptions:\n${suffix.replace(/\p{Cc}/gu, " ")}`;
    const value = inspectClaudeAuthLoginHelp(output(stdout));
    expect(value.admitted).toBeFalse(); expect(value.optionRows.length).toBeLessThanOrEqual(32);
    for (const row of value.optionRows) {
      expect(row.flags.length).toBeLessThanOrEqual(2); expect(["none", "required", "optional"]).toContain(row.argument);
      for (const flag of row.flags) expect(flag).toMatch(/^(?:-[A-Za-z0-9]|--[a-z][a-z0-9-]{0,63})$/u);
    }
  }));
});
