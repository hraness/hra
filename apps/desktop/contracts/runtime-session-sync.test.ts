import { describe, expect, test } from "bun:test";

import { reduceRuntimeProjectionEvent } from "./runtime-projection";
import {
  parseRuntimeDispatchRequest,
  parseRuntimeDispatchResponse,
  remoteSessionSummaryProjectionSchema,
  runtimeProtocolVersion,
  runtimeSessionSyncResetConfirmation,
  runtimeSnapshotSchema,
  sessionSyncSnapshotSchema,
  sessionSyncStatusProjectionSchema,
} from "./runtime";

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

const currentDeviceId = opaque("syncdevice", "d");
const remoteDeviceId = opaque("syncdevice", "r");
const remoteSession = remoteSessionSummaryProjectionSchema.parse({
  sessionId: opaque("syncsession", "s"),
  originDeviceId: remoteDeviceId,
  originDeviceName: "Travel Mac",
  gridPosition: 7,
  sourceRevision: 4,
  title: "Review the desktop build",
  repositoryDisplayName: "Example",
  modelEffort: "max",
  state: "ready",
  updatedAt: 500,
});
const activeStatus = sessionSyncStatusProjectionSchema.parse({
  state: "active",
  revision: 9,
  scopeGeneration: 1,
  currentDeviceId,
  deviceName: "Studio Mac",
  health: "current",
  retryable: false,
  notice: null,
  recovery: "ready",
  devices: [
    {
      id: currentDeviceId,
      name: "Studio Mac",
      status: "active",
      current: true,
      connection: "online",
    },
    {
      id: remoteDeviceId,
      name: "Travel Mac",
      status: "active",
      current: false,
      connection: "offline",
    },
  ],
  pendingEnrollments: [],
});
if (activeStatus.state !== "active") {
  throw new Error("The active session-sync fixture did not parse as active.");
}

function baseSnapshot() {
  return runtimeSnapshotSchema.parse({
    revision: 1,
    lastSequence: 0,
    runtime: { state: "ready", generation: 1 },
    runner: { state: "connected" },
    accounts: [],
    retainedAccountLocalData: [],
    humanAccount: { state: "signedOut", revision: 0 },
    chat: { revision: 1, panes: [] },
    harness: null,
  });
}

describe("renderer-safe session sync contract", () => {
  test("defaults to a compact unavailable state and keeps remote summaries bounded", () => {
    expect(baseSnapshot().sessionSync).toEqual({
      status: {
        state: "unavailable",
        reason: "cloudConfigurationMissing",
        retryable: false,
      },
      localGridSlots: [],
      remoteSessions: [],
    });
    expect(sessionSyncSnapshotSchema.parse({
      status: activeStatus,
      remoteSessions: [remoteSession],
    }).remoteSessions).toHaveLength(1);
    expect(() => sessionSyncSnapshotSchema.parse({
      status: { state: "disabled", revision: 0, deviceName: "Studio Mac" },
      remoteSessions: [remoteSession],
    })).toThrow("must stay hidden");
  });

  test("all renderer sync display fields reject bidi and invisible spoofing controls", () => {
    for (const dangerous of [
      "right\u202eto-left",
      "isolate\u2066payload\u2069",
      "zero\u200bwidth",
      "word\u2060joiner",
      "bom\ufeffmarker",
    ]) {
      expect(remoteSessionSummaryProjectionSchema.safeParse({
        ...remoteSession,
        title: dangerous,
      }).success).toBeFalse();
      expect(remoteSessionSummaryProjectionSchema.safeParse({
        ...remoteSession,
        repositoryDisplayName: dangerous,
      }).success).toBeFalse();
      expect(sessionSyncStatusProjectionSchema.safeParse({
        ...activeStatus,
        deviceName: dangerous,
      }).success).toBeFalse();
    }
    expect(remoteSessionSummaryProjectionSchema.safeParse({
      ...remoteSession,
      title: "Fix 👩‍💻 sync café 日本語",
      repositoryDisplayName: "Développement 🚀",
    }).success).toBeTrue();
    expect(sessionSyncStatusProjectionSchema.safeParse({
      ...activeStatus,
      deviceName: "Studio 👩‍💻",
    }).success).toBeTrue();
  });

  test("requires exact revision-bound device and recovery actions", () => {
    expect(sessionSyncStatusProjectionSchema.parse({
      state: "enrolling",
      revision: 2,
      deviceId: opaque("syncdevice", "n"),
      deviceName: "New Mac",
      requestId: opaque("syncenroll", "e"),
      pairingCode: "123456",
      phase: "awaitingApproval",
      retryable: false,
    })).toMatchObject({ pairingCode: "123456" });
    expect(() => sessionSyncStatusProjectionSchema.parse({
      state: "enrolling",
      revision: 2,
      deviceId: opaque("syncdevice", "n"),
      deviceName: "New Mac",
      requestId: opaque("syncenroll", "e"),
      pairingCode: "65432",
      phase: "awaitingApproval",
      retryable: false,
    })).toThrow();
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_enable",
      command: {
        type: "sessionSync.enable",
        expectedRevision: 0,
        deviceName: "Studio Mac",
      },
    }).command.type).toBe("sessionSync.enable");
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_revoke",
      command: {
        type: "sessionSync.device.revoke",
        expectedRevision: 9,
        deviceId: remoteDeviceId,
      },
    }).command.type).toBe("sessionSync.device.revoke");
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_approve",
      command: {
        type: "sessionSync.enrollment.approve",
        expectedRevision: 9,
        requestId: opaque("syncenroll", "e"),
        pairingCode: "123456",
      },
    }).command).toMatchObject({ pairingCode: "123456" });
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_approve_bad_code",
      command: {
        type: "sessionSync.enrollment.approve",
        expectedRevision: 9,
        requestId: opaque("syncenroll", "e"),
        pairingCode: "12345",
      },
    })).toThrow();
    expect(() => parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_reset",
      command: {
        type: "sessionSync.reset",
        expectedRevision: 9,
        confirmation: "reset it",
      },
    })).toThrow();
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_reset",
      command: {
        type: "sessionSync.reset",
        expectedRevision: 9,
        confirmation: runtimeSessionSyncResetConfirmation,
      },
    }).command.type).toBe("sessionSync.reset");
    const recoveryKit = "R".repeat(64);
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_import",
      command: {
        type: "sessionSync.recovery.import",
        expectedRevision: 9,
        recoveryKit,
      },
    }).command).toEqual({
      type: "sessionSync.recovery.import",
      expectedRevision: 9,
      recoveryKit,
    });
    expect(parseRuntimeDispatchRequest({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_saved",
      command: {
        type: "sessionSync.recoveryKitSavedOffline",
        expectedRevision: 9,
        revealId: `syncreveal_${"r".repeat(32)}`,
      },
    }).command.type).toBe("sessionSync.recoveryKitSavedOffline");
    for (const type of [
      "sessionSync.recovery.copy",
      "sessionSync.recovery.export",
    ]) {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: `op_${type}`,
        command: { type, expectedRevision: 9 },
      })).toThrow();
    }
  });

  test("permits recovery material only in one explicit transient response", () => {
    const recoveryKit = JSON.stringify({
      version: 1,
      recoverySigningPkcs8: "A".repeat(180),
      vaultRootKeys: [{ keyEpoch: "1", rootKey: "B".repeat(43) }],
    });
    const response = parseRuntimeDispatchResponse({
      version: runtimeProtocolVersion,
      operationId: "op_session_sync_reveal",
      ok: true,
      result: {
        type: "sessionSyncRecoveryKit",
        revealId: `syncreveal_${"r".repeat(32)}`,
        recoveryKit,
        expiresAt: 60_000,
      },
    });
    expect(response.ok && response.result.type === "sessionSyncRecoveryKit"
      ? response.result.recoveryKit
      : null).toBe(recoveryKit);
    expect(JSON.stringify(activeStatus)).not.toContain("Pkcs8");
    expect(JSON.stringify(remoteSession)).not.toContain("Pkcs8");
  });

  test("applies remote observation events separately and clears them when sync stops", () => {
    const active = reduceRuntimeProjectionEvent(baseSnapshot(), {
      type: "sessionSync.statusChanged",
      status: activeStatus,
    });
    const withLocalGrid = reduceRuntimeProjectionEvent(active, {
      type: "sessionSync.localGrid.changed",
      slots: [{ paneId: "pane_local_grid", gridPosition: 2 }],
    });
    expect(withLocalGrid.sessionSync.localGridSlots).toEqual([
      { paneId: "pane_local_grid", gridPosition: 2 },
    ]);
    const installed = reduceRuntimeProjectionEvent(withLocalGrid, {
      type: "sessionSync.remote.upserted",
      session: remoteSession,
    });
    expect(installed.sessionSync.remoteSessions).toEqual([remoteSession]);
    const nextVault = reduceRuntimeProjectionEvent(installed, {
      type: "sessionSync.statusChanged",
      status: {
        ...activeStatus,
        revision: 10,
        scopeGeneration: 2,
      },
    });
    expect(nextVault.sessionSync.remoteSessions).toEqual([]);
    expect(nextVault.sessionSync.localGridSlots).toEqual(
      installed.sessionSync.localGridSlots,
    );
    const disabled = reduceRuntimeProjectionEvent(installed, {
      type: "sessionSync.statusChanged",
      status: { state: "disabled", revision: 10, deviceName: "Studio Mac" },
    });
    expect(disabled.sessionSync.remoteSessions).toEqual([]);
    expect(() => reduceRuntimeProjectionEvent(disabled, {
      type: "sessionSync.remote.upserted",
      session: remoteSession,
    })).toThrow("inactive");
    expect(() => reduceRuntimeProjectionEvent(active, {
      type: "sessionSync.localGrid.changed",
      slots: [{ paneId: "pane_local_grid", gridPosition: 7 }],
    })).not.toThrow();
    expect(() => reduceRuntimeProjectionEvent(installed, {
      type: "sessionSync.localGrid.changed",
      slots: [{ paneId: "pane_local_grid", gridPosition: 7 }],
    })).toThrow("conflict");
  });
});
