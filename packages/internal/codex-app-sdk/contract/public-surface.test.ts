import { describe, expect, test } from "bun:test";

import * as sdk from "@hra-internal/codex-app-sdk";
import * as sdkReact from "@hra-internal/codex-app-sdk/react";
import * as sdkTesting from "@hra-internal/codex-app-sdk/testing";

describe("Codex App SDK public runtime surface", () => {
  test("preserves the v0.1.1 root exports", () => {
    expect(Object.keys(sdk).toSorted()).toEqual([
      "ClientHostLifecycleError",
      "GenerationStoreContractError",
      "MAX_OPERATION_TIMEOUT_MS",
      "MIN_OPERATION_TIMEOUT_MS",
      "ambiguous",
      "assertGeneration",
      "cancelled",
      "compareSourceCoordinates",
      "confirmed",
      "createAttemptId",
      "createCodexAppClientHost",
      "createGenerationFence",
      "createMutationFingerprint",
      "createReducerStore",
      "createSourceCoordinate",
      "defineOperation",
      "defineOperationRegistry",
      "isAttemptId",
      "isMutationFingerprint",
      "isSourceCoordinateCurrent",
      "rejected",
      "reserveMonotonicGeneration",
    ]);
  });

  test("preserves the v0.1.1 React and testing subpaths", () => {
    expect(Object.keys(sdkReact).toSorted()).toEqual([
      "createExternalStoreSelectorReader",
      "useExternalStoreSelector",
    ]);
    expect(Object.keys(sdkTesting).toSorted()).toEqual([
      "attemptIdFixture",
      "createDeterministicNumberSource",
      "createMemoryBindingStore",
      "createMemoryChangeFeed",
      "createMemoryGenerationStore",
      "createMemoryMutationAttemptJournal",
      "createMemoryProjectionCheckpointStore",
      "createScriptedCodexAppDriver",
      "sourceCoordinateFixture",
    ]);
  });
});
