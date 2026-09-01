import { describe, expect, test } from "bun:test";

import { chatgptLoginAvailable } from "./doctor";
import type { CommandResult } from "./shared";

const result = (
  stdout: string,
  stderr: string,
  exitCode = 0,
): CommandResult => ({ exitCode, stderr, stdout });

describe("HRA Cloud efficiency doctor", () => {
  test("recognizes ChatGPT login on either Codex output channel", () => {
    expect(chatgptLoginAvailable(result("Logged in using ChatGPT", ""))).toBe(true);
    expect(chatgptLoginAvailable(result("", "Logged in using ChatGPT"))).toBe(true);
    expect(chatgptLoginAvailable(result(
      "",
      "WARNING: PATH aliases unavailable\nLogged in using ChatGPT",
    ))).toBe(true);
  });

  test("rejects another login mode, command failure, or no observation", () => {
    expect(chatgptLoginAvailable(result("Logged in using an API key", ""))).toBe(false);
    expect(chatgptLoginAvailable(result("", "prefix Logged in using ChatGPT suffix"))).toBe(false);
    expect(chatgptLoginAvailable(result("", "Logged in using ChatGPT", 1))).toBe(false);
    expect(chatgptLoginAvailable(null)).toBe(false);
  });
});
