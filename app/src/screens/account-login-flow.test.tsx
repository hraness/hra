import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { DeviceCommandResultPayload } from "../hra/cloud";
import type { AccountRowView } from "../model/settings-view";

const loginCommandId = "018bcfe5-6800-7000-8000-000000000001";
const statusCommandId = "018bcfe5-6800-7000-8000-000000000002";
const settledAt = 1_760_000_000_000;
const expiresAt = settledAt + 300_000;
const submittedKinds: string[] = [];
let consumed = 0;
let consumeFailure: Error | null = null;
let hostedResultConsumed = false;
let hostedUpdatedAt = settledAt;
let statusResult: DeviceCommandResultPayload = {
  instruction: "A login is in progress for this account.",
  kind: "account_login_status",
  status: "pending",
};
const loginResult = {
  expiresAt,
  handoffVersion: 2,
  kind: "account_login_start",
  loginUrl: "https://auth.openai.com/codex/device",
  userCode: "ABCD-EFGH",
} as const;

await mock.module("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => undefined }),
}));

const { useState } = await import("react");
const commandHooks = await import("../data/device-commands");
await mock.module("../data/device-commands", () => ({
  ...commandHooks,
  useConsumeDeviceCommandResult: () => async () => {
    consumed += 1;
    if (consumeFailure !== null) throw consumeFailure;
    return loginResult;
  },
  useDeviceCommandTracker: () => {
    const [handle, setHandle] = useState<{ publicId: string } | null>(null);
    const record = handle === null ? null : {
      createdAt: settledAt,
      deadline: expiresAt,
      kind: handle.publicId === loginCommandId ? "account_login_start" : "account_login_status",
      publicId: handle.publicId,
      result: handle.publicId === loginCommandId ? null : {},
      resultCode: "APPLIED",
      resultConsumed: hostedResultConsumed,
      resultSingleUse: handle.publicId === loginCommandId,
      state: "applied",
      updatedAt: hostedUpdatedAt,
    };
    return { observation: { protocolWarning: null, record, status: "present" }, setHandle };
  },
  useReadDeviceCommandResult: () => async () => statusResult,
  useSubmitDeviceCommand: () => async (input: { payload: { kind: string } }) => {
    submittedKinds.push(input.payload.kind);
    return input.payload.kind === "account_login_start" ? loginCommandId : statusCommandId;
  },
}));

const { AccountRow } = await import("./settings-screen");

const installedGlobals = [
  "document", "Document", "DocumentFragment", "Element", "Event", "HTMLElement",
  "Node", "navigator", "window",
] as const;
const globalRecord = globalThis as unknown as Record<string, unknown>;
const originalDescriptors = new Map(
  installedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
let mountedRoot: Root | null = null;

const account: AccountRowView = {
  accountLinkingAllowed: true,
  deviceCommandsAllowed: true,
  label: "work",
  machineLabel: "studio",
  provider: "codex",
  publicId: "acct_primary0001",
  status: "signed_out",
  targetDevicePublicId: "device_daemon01",
};

beforeEach(() => {
  const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const name of installedGlobals) {
    globalRecord[name] = name === "window" ? window : name === "document" ? document : windowRecord[name];
  }
  globalRecord.IS_REACT_ACT_ENVIRONMENT = true;
  consumed = 0;
  consumeFailure = null;
  hostedResultConsumed = false;
  hostedUpdatedAt = settledAt;
  submittedKinds.length = 0;
  statusResult = {
    instruction: "A login is in progress for this account.",
    kind: "account_login_status",
    status: "pending",
  };
});

afterEach(() => {
  if (mountedRoot !== null) {
    act(() => { mountedRoot?.unmount(); });
    mountedRoot = null;
  }
  for (const name of installedGlobals) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(globalRecord, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  Reflect.deleteProperty(globalRecord, "IS_REACT_ACT_ENVIRONMENT");
});

async function renderMounted(node: ReactNode): Promise<HTMLElement> {
  const container = document.getElementById("root");
  if (!(container instanceof HTMLElement)) throw new Error("missing test root");
  mountedRoot ??= createRoot(container);
  await act(async () => { mountedRoot?.render(node); });
  return container;
}

async function click(container: HTMLElement, label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent === label);
  if (button === undefined) throw new Error(`missing button: ${label}`);
  await act(async () => {
    button.dispatchEvent(new Event("click", { bubbles: true }));
  });
}

describe("mounted account login handoff lifecycle", () => {
  test("checking pending status keeps the already-consumed code and never reads it again", async () => {
    const container = await renderMounted(<AccountRow account={account} now={settledAt} serverClockReady />);
    await click(container, "Link here");
    expect(container.textContent).toContain("ABCD-EFGH");
    expect(consumed).toBe(1);

    await click(container, "Check status");

    expect(container.textContent).toContain("ABCD-EFGH");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(loginResult.loginUrl);
    expect(container.textContent).toContain("A login is in progress");
    expect(consumed).toBe(1);
    expect(submittedKinds).toEqual(["account_login_start", "account_login_status"]);
  });

  test("a lagging signed-out registry cannot offer a second link while the code is live", async () => {
    const container = await renderMounted(<AccountRow account={account} now={settledAt} serverClockReady />);
    await click(container, "Link here");
    expect(container.textContent).toContain("ABCD-EFGH");
    expect(container.textContent).not.toContain("Link here");
    expect(container.textContent).toContain("Check status");
  });

  test("drops the code when the projected account confirms sign-in", async () => {
    const container = await renderMounted(<AccountRow account={account} now={settledAt} serverClockReady />);
    await click(container, "Link here");
    await renderMounted(<AccountRow account={{ ...account, status: "signed_in" }} now={settledAt} serverClockReady />);
    expect(container.textContent).not.toContain("ABCD-EFGH");
    expect(consumed).toBe(1);
  });

  test("an exact status response closes the handoff even before the registry catches up", async () => {
    const container = await renderMounted(<AccountRow account={account} now={settledAt} serverClockReady />);
    await click(container, "Link here");
    statusResult = {
      instruction: "This account is signed in on this machine.",
      kind: "account_login_status",
      status: "signed_in",
    };
    await click(container, "Check status");
    expect(container.textContent).not.toContain("ABCD-EFGH");
    expect(container.textContent).toContain("This account is signed in on this machine.");
    expect(consumed).toBe(1);
  });

  test("a rejected read releases the row at expiry without spending another read", async () => {
    consumeFailure = new commandHooks.DeviceCommandConsumePrecommitError(new Error("temporarily refused"));
    const container = await renderMounted(<AccountRow account={account} now={settledAt} serverClockReady />);
    await click(container, "Link here");
    expect(container.textContent).toContain("Try reading again");
    // Hosted expiry erases the ciphertext and advances updatedAt. That must
    // not extend this browser's original, admitted read deadline.
    hostedResultConsumed = true;
    hostedUpdatedAt = expiresAt;
    await renderMounted(<AccountRow account={{ ...account, status: "login_pending" }} now={expiresAt} serverClockReady />);
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(container.textContent).not.toContain("Try reading again");
    expect(container.textContent).toContain("handoff expired");
    const statusButton = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Check status");
    expect(statusButton?.hasAttribute("disabled")).toBe(false);
    expect(consumed).toBe(1);
  });

  test("expiry explains pending-login recovery without pretending a new start is always available", async () => {
    const container = await renderMounted(<AccountRow account={account} now={settledAt} serverClockReady />);
    await click(container, "Link here");
    await renderMounted(<AccountRow account={{ ...account, status: "login_pending" }} now={expiresAt} serverClockReady />);
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
    expect(container.textContent).not.toContain("ABCD-EFGH");
    expect(container.textContent).toContain("handoff expired");
    expect(container.textContent).toContain("hra account login-cancel acct_primary0001");
    expect(container.textContent).not.toContain("Start a new login.");
  });
});
