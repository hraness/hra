import { describe, expect, test } from "bun:test";

import { randomKeyBytes } from "./crypto";
import {
  decryptDeviceRegistry,
  decryptUsageProjection,
  decryptRemoteCommand,
  encryptDeviceRegistry,
  encryptUsageProjection,
  encryptRemoteCommand,
  parseDeviceRegistryPayload,
  parseRemoteCommandPayload,
  parseSessionMetadataPayload,
} from "./payloads";
import {
  USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
} from "./usage";
import { expectPromiseToReject } from "./testAssertions";

describe("closed encrypted payloads", () => {
  test("encrypts the exact maximum usage projection at the closed envelope boundary", async () => {
    const window = {
      resetsAt: Number.MAX_VALUE,
      usedPercent: 2.2250738585072014e-308,
      windowDurationMinutes: 365 * 24 * 60,
    } as const;
    const projection = {
      data: {
        currentStreakDays: Number.MAX_SAFE_INTEGER,
        daily: [{ startDate: "9999-99-99", tokens: Number.MAX_SAFE_INTEGER }],
        lifetimeTokens: Number.MAX_SAFE_INTEGER,
        limits: Array.from({ length: USAGE_CLOUD_PROJECTION_MAX_LIMITS }, (_, index) => ({
          id: `${index}${"x".repeat(95)}`,
          individual: false,
          name: "\0".repeat(96),
          primary: window,
          reached: false,
          secondary: window,
          unlimited: false,
        })),
        longestRunningTurnSeconds: Number.MAX_SAFE_INTEGER,
        longestStreakDays: Number.MAX_SAFE_INTEGER,
        peakDailyTokens: Number.MAX_SAFE_INTEGER,
      },
      state: "ready",
    } as const;
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "account_12345678",
      keyVersion: 1,
      kind: "usage",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptUsageProjection(projection, key, authority);
    expect(envelope.ciphertext).toHaveLength(
      USAGE_CLOUD_ENVELOPE_MAX_CIPHERTEXT_CHARACTERS,
    );
    expect(await decryptUsageProjection(envelope, key, authority)).toEqual(projection);
  });

  test("admits the fable-max preset in model and default-preset commands", () => {
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "fable-max" }))
      .toEqual({ kind: "set_model", preset: "fable-max" });
    expect(parseRemoteCommandPayload({ kind: "set_default_preset", preset: "fable-max" }))
      .toEqual({ kind: "set_default_preset", preset: "fable-max" });
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "fable" })).toBeNull();
  });

  test("rejects generic RPC and provider method smuggling", () => {
    const absoluteSecretPath = ["", "Users", "name", ".ssh"].join("/");
    expect(parseRemoteCommandPayload({ kind: "rpc", method: "danger" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "send", message: "hello", method: "raw" }))
      .toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_model", preset: "unknown" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "steer", message: `read ${absoluteSecretPath}` }))
      .toBeNull();
  });

  test("keeps exactly one bounded note and name", () => {
    expect(parseSessionMetadataPayload({ name: "Work", note: "Remember this" }))
      .toEqual({ name: "Work", note: "Remember this" });
    expect(parseSessionMetadataPayload({ name: "Work", note: "x", secondNote: "y" }))
      .toBeNull();
  });

  test("remote commands round trip only under their entity authority", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "command_12345678",
      keyVersion: 1,
      kind: "command",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptRemoteCommand({ kind: "set_fast", enabled: true }, key, authority);
    expect(await decryptRemoteCommand(envelope, key, authority))
      .toEqual({ kind: "set_fast", enabled: true });
    await expectPromiseToReject(decryptRemoteCommand(envelope, key, {
      ...authority,
      entityPublicId: "command_87654321",
    }));
  });
});

describe("remote decision payloads", () => {
  const interactionId = "0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b";

  test("accepts once, decline, and cancel decisions and bounded answer maps", () => {
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 3, decision: "once" }))
      .toEqual({ decision: "once", interactionId, kind: "resolve_interaction", revision: 3 });
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "cancel" }))
      .toMatchObject({ decision: "cancel" });
    expect(parseRemoteCommandPayload({
      kind: "resolve_interaction",
      interactionId,
      revision: 2,
      answers: { q1: { answers: ["spaces"] } },
    })).toEqual({ answers: { q1: { answers: ["spaces"] } }, interactionId, kind: "resolve_interaction", revision: 2 });
    expect(parseRemoteCommandPayload({ kind: "send_or_steer", message: "keep going" }))
      .toEqual({ kind: "send_or_steer", message: "keep going" });
  });

  test("refuses session scope, malformed ids, extra keys, and unsafe answers", () => {
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "session" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId: "int_1", revision: 1, decision: "once" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 0, decision: "once" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, decision: "once", answers: {} })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "resolve_interaction", interactionId, revision: 1, answers: {} })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "resolve_interaction",
      interactionId,
      revision: 1,
      answers: { q1: { answers: ["/opt/someone/secret"] } },
    })).toBeNull();
  });
});

describe("settings command payloads", () => {
  test("accepts every settings kind with its exact key set", () => {
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto:workspace", scope: "session" }))
      .toEqual({ kind: "set_approval_mode", mode: "auto:workspace", scope: "session" });
    expect(parseRemoteCommandPayload({ kind: "set_show_thinking", enabled: true, scope: "default" }))
      .toEqual({ enabled: true, kind: "set_show_thinking", scope: "default" });
    expect(parseRemoteCommandPayload({ kind: "set_default_preset", preset: "ultra" }))
      .toEqual({ kind: "set_default_preset", preset: "ultra" });
    expect(parseRemoteCommandPayload({ kind: "archive_session", archived: true }))
      .toEqual({ archived: true, kind: "archive_session" });
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: "Nightly review" }))
      .toEqual({ kind: "rename_session", name: "Nightly review" });
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: null }))
      .toEqual({ kind: "rename_session", name: null });
    expect(parseRemoteCommandPayload({ kind: "set_gateway_key", key: ["gw", "x".repeat(24)].join("-") }))
      .toMatchObject({ kind: "set_gateway_key" });
  });

  test("refuses unknown scopes, modes, presets, extra keys, and unsafe names", () => {
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto:all", scope: "device" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto", scope: "session" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_approval_mode", mode: "auto:all" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_show_thinking", enabled: "yes", scope: "session" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_default_preset", preset: "max" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "archive_session", archived: 1 })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "archive_session", archived: true, session: "sess" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: "" })).toBeNull();
    expect(parseRemoteCommandPayload({
      kind: "rename_session",
      name: ["", "srv", "runner", "job"].join("/"),
    })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "rename_session", name: `bell${String.fromCharCode(7)}` })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_gateway_key", key: "short" })).toBeNull();
    expect(parseRemoteCommandPayload({ kind: "set_gateway_key", key: `gw ${"x".repeat(24)}` })).toBeNull();
  });

  test("carries a settings command through the encrypted command envelope", async () => {
    const key = randomKeyBytes();
    const authority = {
      entityPublicId: "command_12345678",
      keyVersion: 4,
      kind: "command",
      userPublicId: "user_12345678",
    } as const;
    const payload = { kind: "set_show_thinking", enabled: true, scope: "session" } as const;
    const envelope = await encryptRemoteCommand(payload, key, authority);
    expect(await decryptRemoteCommand(envelope, key, authority)).toEqual(payload);
  });
});

describe("session metadata archive", () => {
  test("keeps archive optional and additive", () => {
    expect(parseSessionMetadataPayload({ name: "Session", note: null }))
      .toEqual({ name: "Session", note: null });
    expect(parseSessionMetadataPayload({ archived: true, name: "Session", note: null }))
      .toEqual({ archived: true, name: "Session", note: null });
    expect(parseSessionMetadataPayload({ archived: false, name: "Session", note: null }))
      .toEqual({ archived: false, name: "Session", note: null });
    expect(parseSessionMetadataPayload({ archived: "yes", name: "Session", note: null })).toBeNull();
    expect(parseSessionMetadataPayload({ archived: true, name: "Session", note: null, extra: 1 })).toBeNull();
  });
});

describe("device registry payloads", () => {
  const registry = {
    accounts: [{ label: "Work", provider: "codex", publicId: "acct_00000000000000000000000000000001", status: "signed_in" }],
    daemonVersion: "0.3.0",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    heartbeatAt: 1_700_000_000_000,
    machineLabel: "Studio",
    projects: [{ label: "Control plane", publicId: "proj_00000000000000000000000000000001" }],
    proseAutorespondConfigured: false,
    scheduledTasks: [
      {
        cadence: "every 60 minutes",
        id: "stask_00000000000000000000000000000001",
        kind: "hra_conversation",
        label: "Nightly sweep",
        nextRunAt: 1_700_000_060_000,
        sessionPublicId: "sess_00000000000000000000000000000001",
      },
      {
        cadence: "FREQ=WEEKLY;BYDAY=MO",
        id: "upload-usage",
        kind: "codex_automation",
        label: "Upload usage",
        nextRunAt: null,
        sessionPublicId: null,
      },
    ],
    showThinkingDefault: false,
    version: 1,
  } as const;
  const authority = {
    entityPublicId: "device_12345678",
    keyVersion: 2,
    kind: "device_registry",
    userPublicId: "user_12345678",
  } as const;

  test("round-trips through the account-key envelope under its own authority kind", async () => {
    const key = randomKeyBytes();
    const envelope = await encryptDeviceRegistry(registry, key, authority);
    expect(await decryptDeviceRegistry(envelope, key, authority)).toEqual(registry);
    await expectPromiseToReject(decryptDeviceRegistry(envelope, key, {
      ...authority,
      entityPublicId: "device_87654321",
    }));
    await expectPromiseToReject(decryptDeviceRegistry(envelope, key, {
      ...authority,
      kind: "session_metadata",
    }));
  });

  test("refuses a path-shaped label anywhere in the projection", async () => {
    const absolutePath = ["", "srv", "runner", "checkout"].join("/");
    const homePath = `~/${["projects", "control-plane"].join("/")}`;
    expect(parseDeviceRegistryPayload({ ...registry, machineLabel: absolutePath })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      projects: [{ label: homePath, publicId: "proj_00000000000000000000000000000001" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      accounts: [{ ...registry.accounts[0], label: absolutePath }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[1], label: absolutePath }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[1], cadence: absolutePath }],
    })).toBeNull();
    await expectPromiseToReject(encryptDeviceRegistry(
      { ...registry, machineLabel: absolutePath },
      randomKeyBytes(),
      authority,
    ), "Invalid device registry payload");
  });

  test("refuses unknown versions, unknown keys, and out-of-range members", () => {
    expect(parseDeviceRegistryPayload({ ...registry, version: 2 })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, extra: true })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, defaultPreset: "max" })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, defaultApprovalMode: "auto" })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, showThinkingDefault: "on" })).toBeNull();
    expect(parseDeviceRegistryPayload({ ...registry, heartbeatAt: -1 })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      accounts: [{ ...registry.accounts[0], provider: "codex-cloud" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      accounts: [{ ...registry.accounts[0], status: "removed" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[0], kind: "codex_plugin" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      scheduledTasks: [{ ...registry.scheduledTasks[0], sessionPublicId: "sess 1" }],
    })).toBeNull();
    expect(parseDeviceRegistryPayload({
      ...registry,
      projects: Array.from({ length: 201 }, () => registry.projects[0]),
    })).toBeNull();
  });
});
