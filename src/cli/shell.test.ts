import { describe, expect, test } from "bun:test";

import fc from "fast-check";

import { parseCli } from "./parser";
import {
  SHELL_LINE_MAX_BYTES,
  ShellUsageError,
  compileShellLine,
  formatShellPrompt,
  shellHelp,
  tokenizeShellCommand,
} from "./shell";

describe("HRA line shell", () => {
  test("sends ordinary text faithfully to the selected session", () => {
    expect(compileShellLine("keep  both spaces", { session: "Release work" })).toEqual({
      argv: ["session", "send", "Release work", "--", "keep  both spaces"],
      kind: "dispatch",
    });
    expect(compileShellLine("//review this", { session: "Release work" })).toEqual({
      argv: ["session", "send", "Release work", "--", "/review this"],
      kind: "dispatch",
    });
    expect(compileShellLine("/send --literal  value", { session: "Release work" })).toEqual({
      argv: ["session", "send", "Release work", "--", "--literal  value"],
      kind: "dispatch",
    });
    expect(() => compileShellLine("hello")).toThrow("Select a session");
  });

  test("tokenizes quotes and escapes without shell expansion", () => {
    expect(tokenizeShellCommand("session status 'Release work'")).toEqual([
      "session",
      "status",
      "Release work",
    ]);
    expect(tokenizeShellCommand("interaction show \"$(no expansion)\"")).toEqual([
      "interaction",
      "show",
      "$(no expansion)",
    ]);
    expect(tokenizeShellCommand("account show Work\\ Account")).toEqual([
      "account",
      "show",
      "Work Account",
    ]);
    expect(tokenizeShellCommand("account ''")).toEqual(["account", ""]);
    expect(() => tokenizeShellCommand("account 'unfinished")).toThrow(ShellUsageError);
    expect(() => tokenizeShellCommand("account unfinished\\")).toThrow(ShellUsageError);
  });

  test("compiles selection and selected-session conveniences into ordinary argv", () => {
    expect(compileShellLine("/account")).toEqual({ argv: ["account", "list"], kind: "dispatch" });
    expect(compileShellLine("/account 'Personal Plus'")).toEqual({
      kind: "select-account",
      selector: "Personal Plus",
    });
    expect(compileShellLine("/account usage work --refresh")).toEqual({
      argv: ["account", "usage", "work", "--refresh"],
      kind: "dispatch",
    });
    expect(compileShellLine("/account usage-history work --limit 20")).toEqual({
      argv: ["account", "usage-history", "work", "--limit", "20"],
      kind: "dispatch",
    });
    expect(compileShellLine("/session", { account: "work" })).toEqual({
      argv: ["session", "list", "--account", "work"],
      kind: "dispatch",
    });
    expect(compileShellLine("/session 'Release work'")).toEqual({
      kind: "select-session",
      selector: "Release work",
    });
    expect(compileShellLine("/events --limit 20", { session: "release" })).toEqual({
      argv: ["session", "events", "release", "--limit", "20"],
      kind: "dispatch",
    });
    expect(compileShellLine("/watch --cursor c1", { session: "release" })).toEqual({
      argv: ["session", "watch", "release", "--cursor", "c1"],
      kind: "dispatch",
    });
    expect(compileShellLine("/watch --jsonl", { session: "release" })).toEqual({
      argv: ["session", "watch", "release", "--jsonl"],
      kind: "dispatch",
    });
    expect(compileShellLine("/interactions --limit 8", { session: "release" })).toEqual({
      argv: ["session", "interactions", "release", "--pending", "--limit", "8"],
      kind: "dispatch",
    });
    expect(compileShellLine("/interrupt", { session: "release" })).toEqual({
      argv: ["session", "stop", "release"],
      kind: "dispatch",
    });
  });

  test("binds plugin discovery to the selected account and keeps lifecycle effects closed", () => {
    expect(() => compileShellLine("/plugin")).toThrow("Select an account");
    expect(compileShellLine("/plugin", { account: "Personal Plus" })).toEqual({
      argv: ["plugin", "list", "Personal Plus"],
      kind: "dispatch",
    });
    expect(compileShellLine("/plugin list --project release --refresh", { account: "work" }))
      .toEqual({
        argv: ["plugin", "list", "work", "--project", "release", "--refresh"],
        kind: "dispatch",
      });
    expect(compileShellLine("/plugin show 'Files Search'", { account: "work" }))
      .toEqual({
        argv: ["plugin", "show", "work", "Files Search"],
        kind: "dispatch",
      });
    expect(() => compileShellLine("/plugin install files@official", { account: "work" }))
      .toThrow("Use /plugin list or /plugin show");
  });

  test("keeps protected interaction values on the shell input channel", () => {
    const interaction = "70000000-0000-4000-8000-000000000001";
    const answer = compileShellLine(`/answer ${interaction} --revision 3`);
    expect(answer).toEqual({
      argv: ["interaction", "answer", interaction, "--revision", "3", "--input-stdin"],
      kind: "dispatch",
    });
    if (answer.kind !== "dispatch") throw new Error("Expected an answer dispatch.");
    expect(parseCli(answer.argv)).toMatchObject({
      input: { kind: "stdin" },
      kind: "interaction.resolve-protected",
      resolution: { kind: "user_answers" },
    });
    expect(compileShellLine(`/approve ${interaction} --revision 4`)).toEqual({
      argv: ["interaction", "decide", interaction, "--revision", "4", "--decision", "once"],
      kind: "dispatch",
    });
    const inspect = compileShellLine(`/inspect ${interaction} --revision 4`);
    expect(inspect).toEqual({
      argv: ["interaction", "inspect", interaction, "--revision", "4"],
      kind: "dispatch",
    });
    if (inspect.kind !== "dispatch") throw new Error("Expected an inspect dispatch.");
    expect(parseCli(inspect.argv)).toMatchObject({
      command: { interaction, expectedRevision: 4, kind: "interaction.inspect" },
      kind: "interaction.inspect-protected",
    });
    expect(compileShellLine(`/decline ${interaction} --revision 5`)).toEqual({
      argv: ["interaction", "decide", interaction, "--revision", "5", "--decision", "decline"],
      kind: "dispatch",
    });
    expect(compileShellLine(`/submit ${interaction} --revision 6 --action decline`)).toEqual({
      argv: ["interaction", "submit", interaction, "--revision", "6", "--action", "decline"],
      kind: "dispatch",
    });
    expect(compileShellLine(`/submit ${interaction} --revision 7 --action accept`)).toEqual({
      argv: ["interaction", "submit", interaction, "--revision", "7", "--action", "accept", "--input-stdin"],
      kind: "dispatch",
    });
  });

  test("routes cloud identity login through protected shell input", () => {
    const login = compileShellLine("/auth login");
    expect(login).toEqual({
      argv: ["auth", "login", "--input-stdin"],
      kind: "dispatch",
    });
    if (login.kind !== "dispatch") throw new Error("Expected an auth dispatch.");
    expect(parseCli(login.argv)).toEqual({
      input: { kind: "stdin" },
      json: false,
      kind: "auth.login-protected",
    });
  });

  test("keeps hosted identity erasure explicit inside the persistent shell", () => {
    const deletion = compileShellLine("/auth delete --acknowledge-erasure");
    expect(deletion).toEqual({
      argv: ["auth", "delete", "--acknowledge-erasure"],
      kind: "dispatch",
    });
    if (deletion.kind !== "dispatch") throw new Error("Expected an auth deletion dispatch.");
    expect(parseCli(deletion.argv)).toEqual({
      command: { acknowledgeErasure: true, kind: "auth.delete" },
      json: false,
      kind: "command",
    });
  });

  test("keeps initialization outside the daemon-owned persistent shell", () => {
    for (const line of ["/init", "/init --json", "/init --yes"]) {
      expect(() => compileShellLine(line)).toThrow("Exit the shell, then run `hra init --yes`.");
    }
  });

  test("keeps provider account login in a dedicated one-shot terminal", () => {
    for (const line of [
      "/account login",
      "/account login personal",
      "/account login personal --device-code",
      "/account login personal --handoff-file /private/login.json --json",
    ]) {
      expect(() => compileShellLine(line)).toThrow(
        "Exit the shell, then run `hra account login <profile> [--device-code]`.",
      );
    }
  });

  test("renders a bounded terminal-safe prompt and closed shell controls", () => {
    const prompt = formatShellPrompt({
      account: "work\u001b]0;owned\u0007",
      session: "a very long selected session whose rest should be omitted",
    });
    expect(prompt).toStartWith("hra[");
    expect(prompt).toEndWith("]> ");
    expect(prompt).not.toContain("\u001b");
    expect(prompt).not.toContain("\u0007");
    expect(prompt).toContain("...");
    expect(compileShellLine("/exit")).toEqual({ kind: "exit" });
    expect(compileShellLine("/quit")).toEqual({ kind: "exit" });
    expect(compileShellLine("/help")).toEqual({ kind: "help" });
    expect(compileShellLine("   ")).toEqual({ kind: "noop" });
    expect(() => compileShellLine("/exit now")).toThrow(ShellUsageError);
  });

  test("makes detailed interaction inspection discoverable in shell help", () => {
    expect(shellHelp).toContain("/interaction show ID");
    expect(shellHelp).toContain("questions, choices, or form fields");
    expect(compileShellLine("/interaction show 70000000-0000-4000-8000-000000000001")).toEqual({
      argv: ["interaction", "show", "70000000-0000-4000-8000-000000000001"],
      kind: "dispatch",
    });
  });

  test("makes human and machine session watching discoverable in shell help", () => {
    expect(shellHelp).toContain("/watch [--jsonl]");
    expect(shellHelp).toContain("JSONL is opt-in");
    expect(compileShellLine("/session watch release --jsonl")).toEqual({
      argv: ["session", "watch", "release", "--jsonl"],
      kind: "dispatch",
    });
  });

  test("bounds lines and remains total for arbitrary short input", () => {
    expect(() => compileShellLine("x".repeat(SHELL_LINE_MAX_BYTES + 1), { session: "s" }))
      .toThrow("exceeds");
    fc.assert(
      fc.property(fc.string({ maxLength: 1_000 }), (line) => {
        try {
          const result = compileShellLine(line, { account: "a", session: "s" });
          expect(result).toHaveProperty("kind");
        } catch (error: unknown) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
      { numRuns: 1_000 },
    );
  });
});
