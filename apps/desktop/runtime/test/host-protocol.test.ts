import { describe, expect, test } from "bun:test";
import {
  hostLocalDataRemovalNativeLaunch,
  hostLocalDataRemovalNativeTerminationRequired,
  hostLocalDataRemovalRecoveryCommand,
  hostLocalDataRemovalRecoveryResult,
  hostProjectOnboardingCommand,
  hostFailure,
  hostSuccess,
  parseHostDispatchPayload,
  parseHostLocalDataRemovalRecoveryPayload,
  parseHostProjectOnboardingPayload,
  parseHostRequest,
} from "../src/host-protocol";
import { runtimeProtocolVersion } from "../../contracts/runtime";

describe("native host protocol", () => {
  test("separates renderer bridge commands from private Native onboarding", () => {
    expect(
      parseHostRequest({
        id: "bridge-1",
        command: "hra.runtime.snapshot",
        payload: { version: runtimeProtocolVersion },
      }).command,
    ).toBe("hra.runtime.snapshot");
    const onboarding = parseHostRequest({
      id: "native-onboarding-1",
      command: hostProjectOnboardingCommand,
      payload: {
        version: runtimeProtocolVersion,
        trustedDirectoryPath: "/fixture/example",
        workspaceName: "Example",
      },
    });
    expect(parseHostProjectOnboardingPayload(onboarding)).toEqual({
      version: runtimeProtocolVersion,
      trustedDirectoryPath: "/fixture/example",
      workspaceName: "Example",
    });
    expect(() => parseHostDispatchPayload(onboarding)).toThrow();
    expect(() => parseHostProjectOnboardingPayload(parseHostRequest({
      id: "renderer-dispatch-1",
      command: "hra.runtime.dispatch",
      payload: { version: runtimeProtocolVersion },
    }))).toThrow();
    expect(() =>
      parseHostRequest({ id: "bridge-2", command: "shell.exec", payload: ["rm", "-rf"] }),
    ).toThrow();
    expect(() =>
      parseHostRequest({
        id: "legacy-bridge",
        command: "oprte.runtime.snapshot",
        payload: { version: runtimeProtocolVersion },
      }),
    ).toThrow();
    expect(() => parseHostProjectOnboardingPayload(parseHostRequest({
      id: "native-onboarding-2",
      command: hostProjectOnboardingCommand,
      payload: {
        version: runtimeProtocolVersion,
        trustedDirectoryPath: "/fixture/example",
        installationId: "install_renderer_supplied",
      },
    }))).toThrow();
  });

  test("keeps private transport errors separate from domain responses", () => {
    expect(hostSuccess("bridge-1", { version: runtimeProtocolVersion })).toEqual({
      id: "bridge-1",
      ok: true,
      result: { version: runtimeProtocolVersion },
    });
    expect(hostFailure("", "invalid_request", "Malformed host request")).toEqual({
      id: "",
      ok: false,
      error: { code: "invalid_request", message: "Malformed host request" },
    });
  });

  test("keeps recovery private and launch envelopes exact and signature-free", () => {
    const recoveryRequest = parseHostRequest({
      id: "native-removal-recovery-1",
      command: hostLocalDataRemovalRecoveryCommand,
      payload: { version: 1, nativeRecoveryPrepared: true },
      nativeRemovalCapability: "ab".repeat(32),
    });
    expect(parseHostLocalDataRemovalRecoveryPayload(
      recoveryRequest,
    )).toEqual({ version: 1, nativeRecoveryPrepared: true });
    expect(() => parseHostLocalDataRemovalRecoveryPayload(
      parseHostRequest({
        id: "native-removal-recovery-unprepared",
        command: hostLocalDataRemovalRecoveryCommand,
        payload: { version: 1 },
      }),
    )).toThrow();
    expect(() => parseHostLocalDataRemovalRecoveryPayload(
      parseHostRequest({
        id: "native-removal-recovery-2",
        command: hostLocalDataRemovalRecoveryCommand,
        payload: {
          version: 1,
          nativeRecoveryPrepared: true,
          requestPath: "/private/request",
        },
      }),
    )).toThrow();
    expect(hostLocalDataRemovalRecoveryResult("clear", 2)).toEqual({
      kind: "localDataRemovalRecoveryResult",
      version: 1,
      state: "clear",
      recoveredOperationCount: 2,
    });

    const launch = hostLocalDataRemovalNativeLaunch({
      operationId: "op_removal0001",
      previewId: "removal_preview01",
      parentProcessId: 42_001,
      requestPath:
        "/Users/example/Library/Application Support/OPRTE Removal/requests/op_removal0001.json",
      signingKeyPath:
        "/Users/example/Library/Application Support/OPRTE Removal/removal-signing.key",
      publicResponse: {
        version: runtimeProtocolVersion,
        operationId: "op_removal0001",
        ok: true,
        result: {
          type: "localDataRemovalScheduled",
          previewId: "removal_preview01",
          state: "scheduled",
          willQuitApplication: true,
        },
      },
    });
    expect(Object.keys(launch)).toHaveLength(8);
    const encoded = JSON.stringify(launch);
    expect(encoded).not.toContain("signedRequest");
    expect(encoded).not.toContain("signature");
    expect(encoded).not.toContain("inventoryDigest");
    expect(encoded).not.toContain("confirmationToken");

    const termination = hostLocalDataRemovalNativeTerminationRequired({
      version: runtimeProtocolVersion,
      operationId: "op_removal0001",
      ok: false,
      error: {
        code: "conflict",
        message: "Local state changed.",
        retryable: true,
        action: "retry",
      },
    });
    expect(termination).toEqual({
      kind: "localDataRemovalNativeTerminationRequired",
      version: 1,
      publicResponse: {
        version: runtimeProtocolVersion,
        operationId: "op_removal0001",
        ok: false,
        error: {
          code: "conflict",
          message: "Local state changed.",
          retryable: true,
          action: "retry",
        },
      },
    });
    expect(Object.keys(termination)).toHaveLength(3);
    expect(() => hostLocalDataRemovalNativeTerminationRequired(
      launch.publicResponse,
    )).toThrow();
  });

  test("separates scoped task requests and immutable response continuations", () => {
    const taskRequest = parseHostRequest({
      id: "bridge-task-1",
      command: "hra.runtime.dispatch",
      payload: {
        version: runtimeProtocolVersion,
        operationId: "op_native0001",
        command: {
          type: "task.list",
          workspaceId: "wsp_00000000000000000000000000",
          view: "ready",
          cursor: null,
          limit: 100,
        },
      },
    });
    expect(parseHostDispatchPayload(taskRequest)).toMatchObject({
      command: { type: "task.list" },
    });

    const continuation = parseHostRequest({
      id: "bridge-task-2",
      command: "hra.runtime.dispatch",
      payload: {
        version: runtimeProtocolVersion,
        operationId: "op_native0001",
        transferId: "response_12345678",
        index: 1,
      },
    });
    expect(parseHostDispatchPayload(continuation)).toMatchObject({
      transferId: "response_12345678",
      index: 1,
    });
    expect(() => parseHostDispatchPayload(parseHostRequest({
      id: "bridge-snapshot",
      command: "hra.runtime.snapshot",
      payload: { version: runtimeProtocolVersion },
    }))).toThrow();
  });

  test("rejects private task/session authority inside the allowed Native command", () => {
    for (const command of [
      { type: "project.register", path: "/fixture/example" },
      { type: "workspace.choosePath" },
      { type: "thread.start", prompt: "private" },
      { type: "turn.steer", answer: "private" },
      { type: "run.internal", threadId: "thread_private" },
    ]) {
      const request = parseHostRequest({
        id: "bridge-private",
        command: "hra.runtime.dispatch",
        payload: {
          version: runtimeProtocolVersion,
          operationId: "op_native0001",
          command,
        },
      });
      expect(() => parseHostDispatchPayload(request)).toThrow();
    }
  });
});
