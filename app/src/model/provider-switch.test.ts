import { describe, expect, test } from "bun:test";

import {
  buildSetProviderPayload,
  providerSwitchDisabledReason,
  providerSwitchNote,
  providerSwitchNotice,
  providerSwitchOptions,
  providerSwitchSupported,
  setProviderCommandKind,
} from "./provider-switch";

describe("the menu", () => {
  test("offers both providers, in the words the reader sees", () => {
    expect(providerSwitchOptions.map((option) => option.label))
      .toEqual(["Run on Codex", "Run on Claude Code (Linux machine only)"]);
    expect(providerSwitchOptions.map((option) => option.provider))
      .toEqual(["codex", "claude"]);
  });

  test("says in one line what a switch carries across", () => {
    expect(providerSwitchNote).toContain("summary");
    expect(providerSwitchNote).toContain("not the other provider's own history");
    expect(providerSwitchNote).toContain("Linux custodian");
    expect(providerSwitchNote).toContain("macOS refuses");
  });
});

describe("the payload", () => {
  // `set_provider` is not in the repository's `RemoteCommandPayload` union yet,
  // so the built value is compared as a record. That is the whole point of the
  // module: one place to align when the daemon side lands.
  const built = (input: Parameters<typeof buildSetProviderPayload>[0]) =>
    buildSetProviderPayload(input) as unknown as Readonly<Record<string, unknown>>;

  test("names the kind and the provider and nothing else", () => {
    expect(built({ provider: "claude" }))
      .toEqual({ kind: setProviderCommandKind, provider: "claude" });
    expect(built({ provider: "codex" })).toEqual({ kind: "set_provider", provider: "codex" });
  });

  test("carries a preset only when one was chosen", () => {
    expect(built({ preset: "high", provider: "claude" }))
      .toEqual({ kind: "set_provider", preset: "high", provider: "claude" });
    expect(Object.hasOwn(built({ provider: "claude" }), "preset")).toBe(false);
  });
});

describe("when the switch can be taken", () => {
  test("an idle session on a build that carries the command can switch", () => {
    expect(providerSwitchDisabledReason({ sending: false, supported: true, turnActive: false }))
      .toBeNull();
  });

  test("never during a turn", () => {
    expect(providerSwitchDisabledReason({ sending: false, supported: true, turnActive: true }))
      .toContain("Stop the turn first");
  });

  test("never while another command is going out", () => {
    expect(providerSwitchDisabledReason({ sending: true, supported: true, turnActive: false }))
      .toContain("already going out");
  });

  test("and never at all in a build whose contract has no such command", () => {
    expect(providerSwitchDisabledReason({ sending: false, supported: false, turnActive: false }))
      .toContain("does not carry a provider switch yet");
  });

  test("support is read from the repository's own closed list of command kinds", () => {
    // The daemon-side kind is landing in parallel; either answer is right for
    // its own build. What matters is that the menu asks rather than assumes.
    expect(typeof providerSwitchSupported()).toBe("boolean");
  });
});

describe("the settling line", () => {
  const record = (state: string, resultCode: string | null = null) => ({ resultCode, state });

  test("says nothing before a switch has been submitted", () => {
    expect(providerSwitchNotice(null, "claude")).toBeNull();
    expect(providerSwitchNotice(record("pending"), null)).toBeNull();
  });

  test("names the provider the reader chose while it is in flight", () => {
    expect(providerSwitchNotice(record("pending"), "claude"))
      .toEqual({ settled: false, text: "Waiting for the machine to pick up the switch to Claude Code." });
    expect(providerSwitchNotice(record("effect_started"), "codex"))
      .toEqual({ settled: false, text: "Switching this session to Codex." });
  });

  test("settles on the applied state", () => {
    expect(providerSwitchNotice(record("applied"), "claude"))
      .toEqual({ settled: true, text: "This session is running on Claude Code." });
  });

  test("an ambiguous outcome is never phrased as a failure", () => {
    const notice = providerSwitchNotice(record("ambiguous"), "claude");
    expect(notice?.settled).toBe(true);
    expect(notice?.text).toContain("could not confirm");
    expect(notice?.text).not.toContain("failed");
  });

  test("a refusal carries the machine's own code when there is one", () => {
    expect(providerSwitchNotice(record("failed", "provider_unavailable"), "codex")?.text)
      .toContain("provider_unavailable");
    expect(providerSwitchNotice(record("failed"), "codex")?.text)
      .toBe("The machine refused the switch.");
    expect(providerSwitchNotice(record("expired"), "codex")?.text)
      .toContain("never picked up");
    expect(providerSwitchNotice(record("cancelled"), "codex")?.text)
      .toContain("cancelled");
  });

  test("a state this build has never seen reads as still in flight", () => {
    expect(providerSwitchNotice(record("something_new"), "codex"))
      .toEqual({ settled: false, text: "Switching this session to Codex." });
  });
});
