import { expect, test } from "bun:test";

import {
  parseRuntimeDispatchRequest,
  parseRuntimeDispatchResponse,
  parseRuntimeLocalDataRemovalResponseForRequest,
  runtimeLocalDataRemovalConfirmation,
  runtimeProtocolVersion,
  type RuntimeLocalDataRemovalDispatchRequest,
} from "./runtime";

const preview = {
  previewId: "removal_example1",
  confirmationToken: "confirm_example1",
  expiresAt: "2026-07-25T16:30:00.000Z",
  removes: {
    controlPlaneItems: 3,
    hraCodexProfileDataItems: 7,
    humanCredentialGenerations: 2,
    runnerPairingSecrets: 4,
    harnessContextHeapKeys: 1,
    sessionSyncKeyMaterials: 2,
    releaseUpdateArtifacts: 5,
    applicationStateItems: 6,
    managedWorktrees: 2,
    dirtyManagedWorktrees: 1,
  },
  preserves: {
    userRepositories: 2,
    externalCodexData: true,
    taskctlCredentials: true,
    credentialRecoveryEvidenceRecords: 0,
    unrelatedData: true,
  },
  dirtyWorktreeAcknowledgementRequired: true,
  blockers: [],
  canRemove: true,
} as const;

test("whole-app local-data confirmation is preview-bound and explicit", () => {
  expect(parseRuntimeDispatchRequest({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    command: {
      type: "maintenance.localDataRemoval.remove",
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
      confirmation: runtimeLocalDataRemovalConfirmation,
      acknowledgeDirtyWorktrees: true,
    },
  }).command).toEqual({
    type: "maintenance.localDataRemoval.remove",
    previewId: preview.previewId,
    confirmationToken: preview.confirmationToken,
    confirmation: runtimeLocalDataRemovalConfirmation,
    acknowledgeDirtyWorktrees: true,
  });

  expect(() => parseRuntimeDispatchRequest({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    command: {
      type: "maintenance.localDataRemoval.remove",
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
      confirmation: "remove it",
      acknowledgeDirtyWorktrees: true,
    },
  })).toThrow();
});

test("renderer preview contains bounded categories and counts without privileged paths", () => {
  const response = parseRuntimeDispatchResponse({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: { type: "localDataRemovalPreview", preview },
  });

  expect(response.ok).toBe(true);
  expect(JSON.stringify(response)).not.toContain("/");
  expect(JSON.stringify(response)).not.toContain("path");
  expect(JSON.stringify(response)).not.toContain("service");
  expect(JSON.stringify(response)).not.toContain("keychain");
  expect(response.ok && response.result.type === "localDataRemovalPreview"
    ? response.result.preview.removes.harnessContextHeapKeys
    : null).toBe(1);
  expect(response.ok && response.result.type === "localDataRemovalPreview"
    ? response.result.preview.removes.sessionSyncKeyMaterials
    : null).toBe(2);
  expect(() => parseRuntimeDispatchResponse({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: {
      type: "localDataRemovalPreview",
      preview: {
        ...preview,
        removes: { ...preview.removes, harnessContextHeapKeys: 3 },
      },
    },
  })).toThrow();
  expect(() => parseRuntimeDispatchResponse({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: {
      type: "localDataRemovalPreview",
      preview: {
        ...preview,
        removes: { ...preview.removes, sessionSyncKeyMaterials: 3 },
      },
    },
  })).toThrow();
});

test("dirty-worktree acknowledgement and availability are derived consistently", () => {
  expect(() => parseRuntimeDispatchResponse({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: {
      type: "localDataRemovalPreview",
      preview: {
        ...preview,
        dirtyWorktreeAcknowledgementRequired: false,
      },
    },
  })).toThrow();

  expect(() => parseRuntimeDispatchResponse({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: {
      type: "localDataRemovalPreview",
      preview: {
        ...preview,
        removes: {
          ...preview.removes,
          managedWorktrees: 0,
        },
      },
    },
  })).toThrow();

  expect(() => parseRuntimeDispatchResponse({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: {
      type: "localDataRemovalPreview",
      preview: {
        ...preview,
        blockers: ["helperUnavailable"],
        canRemove: true,
      },
    },
  })).toThrow();
});

test("local-data scheduling response is correlated to operation and preview", () => {
  const request: RuntimeLocalDataRemovalDispatchRequest = {
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    command: {
      type: "maintenance.localDataRemoval.remove",
      previewId: preview.previewId,
      confirmationToken: preview.confirmationToken,
      confirmation: runtimeLocalDataRemovalConfirmation,
      acknowledgeDirtyWorktrees: true,
    },
  };
  const response = {
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: {
      type: "localDataRemovalScheduled",
      previewId: preview.previewId,
      state: "scheduled",
      willQuitApplication: true,
    },
  } as const;

  expect(parseRuntimeLocalDataRemovalResponseForRequest(response, request)).toEqual(
    response,
  );
  expect(() => parseRuntimeLocalDataRemovalResponseForRequest({
    ...response,
    result: { ...response.result, previewId: "removal_other001" },
  }, request)).toThrow();
});

test("private helper launch details are rejected at the renderer boundary", () => {
  expect(() => parseRuntimeDispatchResponse({
    version: runtimeProtocolVersion,
    operationId: "op_removal01",
    ok: true,
    result: {
      type: "localDataRemovalScheduled",
      previewId: preview.previewId,
      state: "scheduled",
      willQuitApplication: true,
      requestPath: "/private/helper/request.json",
      signature: "secret",
      targets: [],
    },
  })).toThrow();
});
