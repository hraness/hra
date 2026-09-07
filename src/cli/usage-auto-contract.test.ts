import { describe, expect, test } from "bun:test";

import type { LocalCommand } from "../domain/contracts";
import { createAutomaticUsagePolicyCommandResult } from "../domain/usage-policy-command";
import { CliUsageError, helpGroupNames, parseCli, usage, usageForGroup } from "./parser";
import { InvalidCommandResponseError, renderSuccess, type Output } from "./render";

const key = "11111111-1111-4111-8111-111111111111";
const mutationFlags = ["--revision", "6", "--idempotency-key", key];
const configuration = {
  version: 1, defaultEnabled: false,
  overrides: { codex: "on", claude: "inherit" }, automaticPolicyRevision: 7,
} as const;
const result = createAutomaticUsagePolicyCommandResult(configuration);
const status = { kind: "usage.auto.status" } as const;
const setDefault = {
  kind: "usage.auto.set", idempotencyKey: key, expectedAutomaticPolicyRevision: 6,
  change: { kind: "set_default", enabled: false },
} as const;
const capture = (): { output: Output; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, output: {
    writeStdout: (value) => { stdout.push(value); },
    writeStderr: (value) => { stderr.push(value); },
  } };
};

describe("usage auto CLI contract", () => {
  test("parses all supported status, default, and override forms with exact wire fields", () => {
    for (const json of [false, true]) {
      const output = json ? ["--json"] : [];
      for (const provider of [undefined, "codex", "claude"] as const) {
        const selection = provider === undefined ? [] : [provider];
        expect(parseCli(["usage", "auto", "status", ...selection, ...output])).toEqual({
          kind: "command", json,
          command: { kind: "usage.auto.status", ...(provider === undefined ? {} : { provider }) },
        });
        for (const action of ["on", "off", "inherit"] as const) {
          if (action === "inherit" && provider === undefined) continue;
          expect(parseCli(["usage", "auto", action, ...selection, ...mutationFlags, ...output])).toEqual({
            kind: "command", json,
            command: {
              kind: "usage.auto.set", idempotencyKey: key, expectedAutomaticPolicyRevision: 6,
              change: provider === undefined
                ? { kind: "set_default", enabled: action === "on" }
                : { kind: "set_override", provider, override: action },
            },
          });
        }
      }
    }
    expect(parseCli(["--json", "--idempotency-key", key, "usage", "auto", "off", "--revision", "6"])).toEqual({
      kind: "command", json: true, command: setDefault,
    });
  });

  test("rejects missing authority, unsupported providers, duplicates, flags and literal extras", () => {
    const invalid = [
      [], ["auto"], ["wrong", "status"], ["auto", "wrong"],
      ["auto", "status", "devin"], ["auto", "status", "CODEX"],
      ["auto", "status", "codex", "claude"], ["auto", "status", "--revision", "6"],
      ["auto", "status", "--idempotency-key", key], ["auto", "status", "--refresh"],
      ["auto", "status", "--jsonl"], ["auto", "status", "--json", "--json"],
      ["auto", "status", "--"], ["auto", "status", "--", "codex"],
      ["auto", "on"], ["auto", "on", "--revision", "6"],
      ["auto", "off", "--idempotency-key", key],
      ["auto", "inherit", ...mutationFlags], ["auto", "on", "devin", ...mutationFlags],
      ["auto", "on", "codex", "extra", ...mutationFlags],
      ["auto", "off", ...mutationFlags, "--revision", "6"],
      ["auto", "off", ...mutationFlags, "--idempotency-key", key],
      ["auto", "off", ...mutationFlags, "--json", "--jsonl"],
      ["auto", "off", ...mutationFlags, "--follow"],
      ["auto", "off", ...mutationFlags, "--provider", "codex"],
      ["auto", "off", ...mutationFlags, "--"],
      ["auto", "off", ...mutationFlags, "--", "ignored"],
      ["auto", "off", "--revision", "6", "--idempotency-key", "bad-key"],
      ["auto", "off", "--revision"], ["auto", "off", "--idempotency-key"],
      ...["0", "-1", "1.5", "01", "+1", "1e2", "9007199254740992", "Infinity", ""].map((revision) =>
        ["auto", "off", "--revision", revision, "--idempotency-key", key]),
    ];
    for (const args of invalid) expect(() => parseCli(["usage", ...args])).toThrow(CliUsageError);
  });

  test("help exposes required authority flags, examples and independent overrides", () => {
    expect(helpGroupNames).toContain("usage");
    expect(usage).toContain("hra usage auto status|on|off|inherit");
    for (const help of [usageForGroup("usage"), usageForGroup("usage", "auto")]) {
      expect(help).toContain("--revision <n> --idempotency-key <uuid>");
      expect(help).toContain(key);
      expect(help).toContain("not a global kill switch");
      expect(help).toContain("provider override of on can remain enabled");
      expect(help).toContain("receipt, not the current policy head");
    }
    for (const args of [["usage", "auto", "--help"], ["help", "usage", "auto"]]) {
      expect(parseCli(args)).toEqual({ kind: "help", json: false, group: "usage", leaf: "auto" });
    }
  });

  test("prints exact public JSON and honest human status or saved receipt in one write", () => {
    const expectedData = '{"version":1,"configuration":{"version":1,"defaultEnabled":false,"overrides":{"codex":"on","claude":"inherit"},"automaticPolicyRevision":7},"effective":[{"provider":"codex","enabled":true,"source":"override","automaticPolicyRevision":7},{"provider":"claude","enabled":false,"source":"default","automaticPolicyRevision":7}]}';
    for (const command of [status, setDefault]) {
      const json = capture();
      renderSuccess(command, result, true, json.output);
      expect(json.stdout).toEqual([`{"ok":true,"version":1,"command":"${command.kind}","data":${expectedData}}\n`]);
      expect(json.stderr).toEqual([]);
      const human = capture();
      renderSuccess(command, result, false, human.output);
      expect(human.stdout).toEqual([
        `Automatic usage policy ${command.kind === "usage.auto.set" ? "receipt" : "status"}, revision 7.\n`
        + "Inherited default: off. Provider overrides take precedence.\n"
        + "codex: on (override on).\nclaude: off (inherits default).\n"
        + (command.kind === "usage.auto.set" ? "This is the saved receipt. Run `hra usage auto status` for the current policy.\n" : ""),
      ]);
      expect(human.stderr).toEqual([]);
    }
    for (const provider of ["codex", "claude"] as const) {
      for (const json of [false, true]) {
        const sink = capture();
        renderSuccess({ ...status, provider }, createAutomaticUsagePolicyCommandResult(configuration, provider), json, sink.output);
        expect(sink.stdout).toHaveLength(1);
      }
    }
  });

  test("refuses malformed or request-mismatched results before stdout in either mode", () => {
    const override: LocalCommand = {
      ...setDefault, change: { kind: "set_override", provider: "codex", override: "off" },
    };
    const invalid: readonly [LocalCommand, unknown][] = [
      [status, null], [status, { ...result, accountId: "private" }],
      [status, { ...result, configuration: { ...configuration, profileId: "private" } }],
      [status, { ...result, effective: result.effective.map((entry) => ({ ...entry, processGeneration: 3 })) }],
      [status, { ...result, effective: [...result.effective].reverse() }],
      [status, { ...result, effective: result.effective.map((entry) => ({ ...entry, enabled: !entry.enabled })) }],
      [status, createAutomaticUsagePolicyCommandResult(configuration, "codex")],
      [{ ...status, provider: "codex" }, result],
      [{ ...status, provider: "claude" }, createAutomaticUsagePolicyCommandResult(configuration, "codex")],
      [setDefault, createAutomaticUsagePolicyCommandResult(configuration, "codex")],
      [{ ...setDefault, expectedAutomaticPolicyRevision: 7 }, result],
      [{ ...setDefault, expectedAutomaticPolicyRevision: Number.MAX_SAFE_INTEGER }, result],
      [{ ...setDefault, change: { kind: "set_default", enabled: true } }, result],
      [override, result],
    ];
    for (const [command, candidate] of invalid) {
      for (const json of [false, true]) {
        const sink = capture();
        expect(() => renderSuccess(command, candidate, json, sink.output)).toThrow(InvalidCommandResponseError);
        expect(sink.stdout).toEqual([]);
        expect(sink.stderr).toEqual([]);
      }
    }
  });
});
