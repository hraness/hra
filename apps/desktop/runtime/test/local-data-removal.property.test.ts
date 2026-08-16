import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  canonicalLocalDataRemovalJson,
  isPathWithinExactOwnedRoot,
  signLocalDataRemovalHelperPayload,
  verifyLocalDataRemovalHelperRequest,
} from "../src/maintenance/local-data-removal";

const SIGNING_KEY = new Uint8Array(32).fill(0x2c);

test("TypeScript canonical JSON and HMAC match the native Unicode golden", () => {
  const roots = {
    applicationState: ["/Users/example/Library/状态/é"],
    controlPlane: ["/Users/example/Library/e\u0301/\"quoted\"\nline"],
    helperStateRoot:
      "/Users/example/Library/Application Support/OPRTE Removal",
    kitchenCodexProfileData: ["/Users/example/Library/Codex/雪"],
    managedWorktrees: ["/Users/example/Library/Worktrees"],
    releaseUpdateArtifacts: ["/Users/example/Library/Caches/🚀"],
  };
  const payload = {
    acknowledgeDirtyWorktrees: false,
    allowlistDigest: `sha256_${"a".repeat(64)}`,
    exclusionPath:
      "/Users/example/Library/Application Support/.OPRTE Removal.removal-in-progress",
    executionLockPath:
      "/Users/example/Library/Application Support/OPRTE Removal/execution.lock",
    expiresAt: 2_000,
    helperStateRoot: roots.helperStateRoot,
    inventoryDigest: `sha256_${"b".repeat(64)}`,
    issuedAt: 1_000,
    kind: "hraness-kitchen-local-data-removal",
    operationId: "op_unicode01",
    ownedRoots: roots,
    parentProcessId: 4_242,
    preservedUserRepositories: ["/Users/example/Repos/café"],
    previewId: "removal_unicode01",
    receiptPath:
      "/Users/example/Library/Application Support/OPRTE Removal/helper-receipts/op_unicode01.json",
    stageRoot:
      "/Users/example/Library/Application Support/OPRTE Removal/staging/op_unicode01",
    targets: [{
      category: "application_state",
      id: `target_${"1".repeat(32)}`,
      kind: "directory",
      path: "/Users/example/Library/状态/é",
    }],
    version: 1,
    waitForParentExit: true,
  } as const;
  const canonical =
    "{\"acknowledgeDirtyWorktrees\":false,\"allowlistDigest\":\"sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"exclusionPath\":\"/Users/example/Library/Application Support/.OPRTE Removal.removal-in-progress\",\"executionLockPath\":\"/Users/example/Library/Application Support/OPRTE Removal/execution.lock\",\"expiresAt\":2000,\"helperStateRoot\":\"/Users/example/Library/Application Support/OPRTE Removal\",\"inventoryDigest\":\"sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"issuedAt\":1000,\"kind\":\"hraness-kitchen-local-data-removal\",\"operationId\":\"op_unicode01\",\"ownedRoots\":{\"applicationState\":[\"/Users/example/Library/状态/é\"],\"controlPlane\":[\"/Users/example/Library/é/\\\"quoted\\\"\\nline\"],\"helperStateRoot\":\"/Users/example/Library/Application Support/OPRTE Removal\",\"kitchenCodexProfileData\":[\"/Users/example/Library/Codex/雪\"],\"managedWorktrees\":[\"/Users/example/Library/Worktrees\"],\"releaseUpdateArtifacts\":[\"/Users/example/Library/Caches/🚀\"]},\"parentProcessId\":4242,\"preservedUserRepositories\":[\"/Users/example/Repos/café\"],\"previewId\":\"removal_unicode01\",\"receiptPath\":\"/Users/example/Library/Application Support/OPRTE Removal/helper-receipts/op_unicode01.json\",\"stageRoot\":\"/Users/example/Library/Application Support/OPRTE Removal/staging/op_unicode01\",\"targets\":[{\"category\":\"application_state\",\"id\":\"target_11111111111111111111111111111111\",\"kind\":\"directory\",\"path\":\"/Users/example/Library/状态/é\"}],\"version\":1,\"waitForParentExit\":true}";

  expect(canonicalLocalDataRemovalJson(payload)).toBe(canonical);
  expect(
    signLocalDataRemovalHelperPayload(
      payload,
      new Uint8Array(32).fill(0x5a),
    ).signature,
  ).toBe(
    "hmac_sha256_e5d8815773d609d7176bbbc027239f1af79a823b0093ad6bda3133d7ed2b4cc8",
  );
});

test("normalized descendants are allowed while arbitrary sibling-prefix and escape paths are rejected", () => {
  assertProperty(fc.property(
    fc.array(
      fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/u),
      { minLength: 1, maxLength: 6 },
    ),
    fc.stringMatching(/^[a-z][a-z0-9_-]{0,15}$/u),
    (segments, siblingSuffix) => {
      const root = "/private/tmp/oprte-owned-root";
      const descendant = `${root}/${segments.join("/")}`;
      const sibling = `${root}-${siblingSuffix}`;
      const escape = `/private/tmp/${segments.join("/")}`;
      expect(isPathWithinExactOwnedRoot(root, descendant)).toBe(true);
      expect(isPathWithinExactOwnedRoot(root, sibling)).toBe(false);
      expect(isPathWithinExactOwnedRoot(root, escape)).toBe(false);
      expect(isPathWithinExactOwnedRoot(root, `${root}/../outside`)).toBe(false);
    },
  ));
});

test("any valid timestamp mutation invalidates a signed helper request", () => {
  const request = signLocalDataRemovalHelperPayload({
    version: 1,
    kind: "hraness-kitchen-local-data-removal",
    operationId: "op_property01",
    previewId: "removal_property1",
    inventoryDigest: `sha256_${"1".repeat(64)}`,
    allowlistDigest: `sha256_${"2".repeat(64)}`,
    issuedAt: 1_000,
    expiresAt: 10_000,
    parentProcessId: 41_001,
    waitForParentExit: true,
    acknowledgeDirtyWorktrees: false,
    helperStateRoot: "/private/tmp/oprte-helper",
    exclusionPath:
      "/private/tmp/.oprte-helper.removal-in-progress",
    executionLockPath: "/private/tmp/oprte-helper/execution.lock",
    ownedRoots: {
      controlPlane: ["/private/tmp/oprte-control-plane"],
      kitchenCodexProfileData: ["/private/tmp/oprte-codex"],
      releaseUpdateArtifacts: ["/private/tmp/oprte-updates"],
      applicationState: ["/private/tmp/oprte-owned"],
      managedWorktrees: ["/private/tmp/oprte-worktrees"],
      helperStateRoot: "/private/tmp/oprte-helper",
    },
    stageRoot: "/private/tmp/oprte-helper/staging/op_property01",
    receiptPath:
      "/private/tmp/oprte-helper/helper-receipts/op_property01.json",
    targets: [{
      id: `target_${"3".repeat(32)}`,
      category: "application_state",
      path: "/private/tmp/oprte-owned/state.json",
      kind: "file",
    }],
    preservedUserRepositories: ["/private/tmp/user-repository"],
  }, SIGNING_KEY);

  assertProperty(fc.property(
    fc.integer({ min: 1_001, max: 9_999 }),
    (issuedAt) => {
      expect(() => verifyLocalDataRemovalHelperRequest({
        ...request,
        payload: { ...request.payload, issuedAt },
      }, SIGNING_KEY)).toThrow();
    },
  ));
});
