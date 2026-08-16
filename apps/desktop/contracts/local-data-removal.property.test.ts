import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  parseRuntimeDispatchResponse,
  runtimeProtocolVersion,
} from "./runtime";

const safePreview = {
  previewId: "removal_example1",
  confirmationToken: "confirm_example1",
  expiresAt: "2026-07-25T16:30:00.000Z",
  removes: {
    controlPlaneItems: 1,
    hraCodexProfileDataItems: 1,
    humanCredentialGenerations: 1,
    runnerPairingSecrets: 1,
    harnessContextHeapKeys: 1,
    sessionSyncKeyMaterials: 2,
    releaseUpdateArtifacts: 1,
    applicationStateItems: 1,
    managedWorktrees: 0,
    dirtyManagedWorktrees: 0,
  },
  preserves: {
    userRepositories: 1,
    externalCodexData: true,
    taskctlCredentials: true,
    credentialRecoveryEvidenceRecords: 0,
    unrelatedData: true,
  },
  dirtyWorktreeAcknowledgementRequired: false,
  blockers: [],
  canRemove: true,
} as const;

test("arbitrary raw target fields never fit a renderer local-data preview", () => {
  assertProperty(fc.property(
    fc.constantFrom(
      "path",
      "paths",
      "target",
      "targets",
      "requestPath",
      "receiptPath",
      "stageRoot",
      "keychainService",
      "keychainName",
    ),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseRuntimeDispatchResponse({
        version: runtimeProtocolVersion,
        operationId: "op_removal01",
        ok: true,
        result: {
          type: "localDataRemovalPreview",
          preview: { ...safePreview, [key]: value },
        },
      })).toThrow();
    },
  ));
});
