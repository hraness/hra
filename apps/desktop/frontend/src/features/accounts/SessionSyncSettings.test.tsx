import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  runtimeSessionSyncCapabilities,
  sessionSyncStatusProjectionSchema,
} from "../../../../contracts/runtime";
import type { RuntimeShell } from "../../runtime";
import {
  confirmationIdForSecurityBoundary,
  nextSessionSyncSecurityGeneration,
  recoverySecretsForSecurityBoundary,
  SessionSyncSettings,
  sessionSyncSecurityScope,
  type ScopedRecoverySecrets,
  type ScopedConfirmationId,
} from "./SessionSyncSettings";

test("session sync settings expose opt-in while incomplete administration stays unavailable", async () => {
  const shell = {
    getSnapshot: () => ({ state: "connecting" as const }),
    subscribe: () => () => undefined,
  } as unknown as RuntimeShell;
  const html = renderToStaticMarkup(createElement(SessionSyncSettings, { shell }));
  const source = await Bun.file(new URL("./SessionSyncSettings.tsx", import.meta.url)).text();

  expect(html).toContain("Devices");
  expect(html).toContain("Session sync is temporarily unavailable");
  expect(source).toContain('type: "sessionSync.enable"');
  expect(source).toContain('type: "sessionSync.disable"');
  expect(source).toContain("expectedRevision: status.revision");
  expect(source).toContain("Device approval and revocation are unavailable in this build");
  expect(runtimeSessionSyncCapabilities.enrollmentApproval).toBeFalse();
  expect(runtimeSessionSyncCapabilities.deviceRevocation).toBeFalse();
  expect(runtimeSessionSyncCapabilities.disable).toBeTrue();
  expect(source).not.toContain('type: "sessionSync.device.revoke"');
  expect(source).not.toContain('type: "sessionSync.enrollment.approve"');
  expect(source).toContain("Pairing code to compare on the approving Mac");
  expect(source).toContain("formatPairingCode(status.pairingCode)");
});

test("recovery reveal is transient and cloud retirement is not exposed", async () => {
  const source = await Bun.file(new URL("./SessionSyncSettings.tsx", import.meta.url)).text();

  expect(source).toContain("revealedKit.expiresAt - Date.now()");
  expect(source).toContain('type: "sessionSync.recovery.reveal"');
  expect(source).toContain('type: "sessionSync.recoveryKitSavedOffline"');
  expect(source).toContain("revealId: response.result.revealId");
  expect(source).toContain("Saved offline");
  expect(source).toContain("Recovery import and rotation are unavailable in this build");
  expect(runtimeSessionSyncCapabilities.recoveryImport).toBeFalse();
  expect(runtimeSessionSyncCapabilities.recoveryRotation).toBeFalse();
  expect(runtimeSessionSyncCapabilities.vaultReset).toBeFalse();
  expect(source).not.toContain('type: "sessionSync.recovery.import"');
  expect(source).not.toContain('type: "sessionSync.recovery.copy"');
  expect(source).not.toContain('type: "sessionSync.recovery.export"');
  expect(source).not.toContain('type: "sessionSync.recovery.rotate"');
  expect(source).not.toContain('type: "sessionSync.reset"');
  expect(source).not.toContain("Reset synced data");
  expect(source).not.toContain("localStorage");
  expect(source).not.toContain("sessionStorage");
});

test("recovery plaintext is generation-fenced across every security scope transition", () => {
  const statuses = [
    { state: "unavailable", reason: "signedOut", retryable: false },
    { state: "unavailable", reason: "serviceUnavailable", retryable: true },
    { state: "disabled", revision: 1, deviceName: "This Mac" },
    {
      state: "enrolling",
      revision: 1,
      deviceId: `syncdevice_${"e".repeat(32)}`,
      deviceName: "This Mac",
      requestId: `syncenroll_${"r".repeat(32)}`,
      pairingCode: "123456",
      phase: "awaitingApproval",
      retryable: true,
    },
    {
      state: "active",
      revision: 1,
      scopeGeneration: 1,
      currentDeviceId: `syncdevice_${"a".repeat(32)}`,
      deviceName: "This Mac",
      health: "current",
      retryable: false,
      notice: null,
      recovery: "ready",
      devices: [{
        id: `syncdevice_${"a".repeat(32)}`,
        name: "This Mac",
        status: "active",
        current: true,
        connection: "online",
      }],
      pendingEnrollments: [],
    },
    {
      state: "active",
      revision: 1,
      scopeGeneration: 1,
      currentDeviceId: `syncdevice_${"b".repeat(32)}`,
      deviceName: "Travel Mac",
      health: "current",
      retryable: false,
      notice: null,
      recovery: "ready",
      devices: [{
        id: `syncdevice_${"b".repeat(32)}`,
        name: "Travel Mac",
        status: "active",
        current: true,
        connection: "online",
      }],
      pendingEnrollments: [],
    },
    {
      state: "active",
      revision: 2,
      scopeGeneration: 2,
      currentDeviceId: `syncdevice_${"a".repeat(32)}`,
      deviceName: "This Mac",
      health: "current",
      retryable: false,
      notice: null,
      recovery: "ready",
      devices: [{
        id: `syncdevice_${"a".repeat(32)}`,
        name: "This Mac",
        status: "active",
        current: true,
        connection: "online",
      }],
      pendingEnrollments: [],
    },
  ].map((status) => sessionSyncStatusProjectionSchema.parse(status));
  const scopes = statuses.map(sessionSyncSecurityScope);
  expect(new Set(scopes).size).toBe(scopes.length);

  for (const fromScope of scopes) {
    const secret: ScopedRecoverySecrets = {
      generation: 7,
      recoveryInput: "pasted-old-secret",
      revealedKit: {
        expiresAt: Date.now() + 30_000,
        revealId: "reveal-old",
        value: "revealed-old-secret",
      },
      scope: fromScope,
    };
    for (const toScope of scopes) {
      const generation = nextSessionSyncSecurityGeneration(fromScope, 7, toScope);
      const visible = recoverySecretsForSecurityBoundary(secret, toScope, generation);
      const confirmation: ScopedConfirmationId = {
        generation: 7,
        id: "old-confirmation",
        scope: fromScope,
      };
      if (toScope === fromScope) {
        expect(visible).toBe(secret);
        expect(confirmationIdForSecurityBoundary(
          confirmation,
          toScope,
          generation,
        )).toBe("old-confirmation");
      } else {
        expect(visible).toEqual({
          generation: 8,
          recoveryInput: "",
          revealedKit: null,
          scope: toScope,
        });
        expect(confirmationIdForSecurityBoundary(
          confirmation,
          toScope,
          generation,
        )).toBeNull();
      }
    }
  }

  const first = scopes.at(-2)!;
  const second = scopes.at(-1)!;
  const secret: ScopedRecoverySecrets = {
    generation: 1,
    recoveryInput: "must-not-return",
    revealedKit: null,
    scope: first,
  };
  const secondGeneration = nextSessionSyncSecurityGeneration(first, 1, second);
  const returnGeneration = nextSessionSyncSecurityGeneration(second, secondGeneration, first);
  expect(recoverySecretsForSecurityBoundary(secret, first, returnGeneration)).toEqual({
    generation: 3,
    recoveryInput: "",
    revealedKit: null,
    scope: first,
  });
});

test("unavailable administration has no latent confirmation controls", async () => {
  const source = await Bun.file(new URL("./SessionSyncSettings.tsx", import.meta.url)).text();

  expect(source).not.toContain("<DialogTrigger");
  expect(source).not.toContain("<DialogContent");
  expect(source).not.toContain('variant="danger"');
  expect(source).not.toContain("Revoke device");
  expect(source).not.toContain("Codes match, approve");
});

test("sensitive async results are rejected after scope change or unmount", async () => {
  const source = await Bun.file(new URL("./SessionSyncSettings.tsx", import.meta.url)).text();

  expect(source).toContain("const commandGeneration = securityGenerationRef.current");
  expect(source).toContain("securityGenerationRef.current !== commandGeneration");
  expect(source).toContain('securityScopeRef.current = "unmounted"');
  expect(source).toContain('emptyRecoverySecrets(\n      "unmounted"');
  expect(source).toContain('if (action === "disable") clearRecoverySecrets()');
});
