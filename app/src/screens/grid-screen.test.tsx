import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { parseDeviceRegistryPayload } from "../oompa/cloud";
import { toMachineView, type MachineView } from "../model/settings-view";

let loading = false;
let submitted = 0;
let machines: readonly MachineView[] = [];
const refuseCommand = () => {
  submitted += 1;
  throw new Error("Unexpected command from an empty-grid render");
};

await mock.module("../data/session-heads", () => ({
  useSessionHeads: () => ({ heads: [], isLoading: loading, loadMore: () => {}, status: "Exhausted" }),
}));
await mock.module("../data/registry", () => ({
  useDeviceRegistries: () => ({ machines }),
}));
await mock.module("../data/commands", () => ({
  useSubmitCommand: () => refuseCommand,
}));
await mock.module("../data/device-commands", () => ({
  deviceCommandCommittedRowUnavailableMessage: "Command result unavailable.",
  DeviceCommandResponseInvalidError: class extends Error {},
  useDeviceCommandTracker: () => ({
    observation: { protocolWarning: null, record: null },
    setHandle: () => {},
  }),
  useSubmitDeviceCommand: () => refuseCommand,
}));
await mock.module("../custody/custody-context", () => ({
  useCustody: () => ({ lock: () => {} }),
}));
await mock.module("../components/session-card", () => ({ SessionCard: () => null }));

const { GridScreen } = await import("./grid-screen");

function readyMachine(): MachineView {
  const now = 1_760_000_000_000;
  const payload = parseDeviceRegistryPayload({
    accountLinkingAllowed: false,
    accounts: [{ label: "Work", provider: "codex", publicId: "acct_primary0001", status: "signed_in" }],
    daemonVersion: "0.7.1",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    deviceCommandsAllowed: true,
    heartbeatAt: now,
    machineLabel: "Studio",
    projects: [{ label: "Example", publicId: "proj_alpha000001" }],
    proseAutorespondConfigured: false,
    scheduledTasks: [],
    showThinkingDefault: false,
    version: 1,
  });
  if (payload === null) throw new Error("Expected a valid ready-machine registry fixture");
  return toMachineView({
    device: { online: true, status: "active" },
    devicePublicId: "device_studio01",
    now,
    payload,
    revision: 1,
    updatedAt: now,
  });
}

describe("grid composer guidance", () => {
  beforeEach(() => {
    loading = false;
    submitted = 0;
    machines = [];
  });

  test("names the unavailable new-session composer and points to Settings", () => {
    const markup = renderToStaticMarkup(<GridScreen onSelect={() => {}} selectedSessionId={null} />);
    const input = markup.match(/<input[^>]+aria-label="Start a new session"[^>]*>/)?.[0];
    expect(input).toContain('placeholder="Start a new session"');
    expect(input).toContain('disabled=""');
    expect(markup).toContain("Check your machines and accounts in Settings before starting a session.");
    expect(markup).not.toContain("Type a prompt above");
    expect(markup).toContain('aria-label="Settings"');
    expect(submitted).toBe(0);
  });

  test("names follow-up mode accurately without enabling an unavailable session", () => {
    const markup = renderToStaticMarkup(<GridScreen onSelect={() => {}} selectedSessionId="session_missing01" />);
    const input = markup.match(/<input[^>]+aria-label="Send a follow-up"[^>]*>/)?.[0];
    expect(input).toContain('placeholder="Send a follow-up"');
    expect(input).toContain('disabled=""');
    expect(markup).not.toContain('aria-label="Start a new session"');
    expect(markup).toContain("Nothing to send to yet.");
    expect(submitted).toBe(0);
  });

  test("does not suggest typing when a ready machine cannot serve a missing selected session", () => {
    machines = [readyMachine()];
    const markup = renderToStaticMarkup(<GridScreen onSelect={() => {}} selectedSessionId="session_missing01" />);
    const input = markup.match(/<input[^>]+aria-label="Send a follow-up"[^>]*>/)?.[0];
    expect(input).toContain('disabled=""');
    expect(markup).toContain("No sessions are available for a follow-up.");
    expect(markup).not.toContain("Type a prompt above");
    expect(markup).not.toContain('aria-label="Start a new session"');
    const submit = parseHTML(markup).document.querySelector('button[type="submit"]');
    expect(submit?.hasAttribute("disabled")).toBe(true);
    expect(submit?.textContent).toBe("Send");
    expect(submitted).toBe(0);
  });

  test("guides a genuinely startable empty workspace to its enabled composer", () => {
    machines = [readyMachine()];
    const markup = renderToStaticMarkup(<GridScreen onSelect={() => {}} selectedSessionId={null} />);
    const input = markup.match(/<input[^>]+aria-label="Start a new session"[^>]*>/)?.[0];
    expect(input).toContain('placeholder="Start a new session"');
    expect(input).not.toContain('disabled=""');
    expect(markup).toContain("No sessions yet. Type a prompt above to start one on a machine.");
    expect(markup).not.toContain("No sessions are available for a follow-up.");
    expect(markup).toContain('value="proj_alpha000001"');
    const submit = parseHTML(markup).document.querySelector('button[type="submit"]');
    expect(submit?.hasAttribute("disabled")).toBe(true);
    expect(submit?.textContent).toBe("Start");
    expect(submitted).toBe(0);
  });

  test("announces loading without prematurely declaring an empty workspace", () => {
    loading = true;
    const markup = renderToStaticMarkup(<GridScreen onSelect={() => {}} selectedSessionId={null} />);
    expect(markup).toMatch(/<p[^>]+role="status">Loading sessions\.<\/p>/);
    expect(markup).not.toContain("No sessions yet.");
    expect(submitted).toBe(0);
  });
});
