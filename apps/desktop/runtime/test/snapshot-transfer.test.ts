import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  parseRuntimeSnapshotResponse,
  runtimeProtocolVersion,
  type RuntimeSnapshotChunkResponse,
  type RuntimeSnapshotResponse,
} from "../../contracts/runtime";
import {
  nativeBridgeResponseByteLimit,
  SnapshotTransferCapacityError,
  SnapshotTransferNotFoundError,
  SnapshotTransferStore,
  type SnapshotTransferScheduler,
} from "../src/snapshot-transfer";

function snapshotResponse(label = "Personal"): RuntimeSnapshotResponse {
  return {
    version: runtimeProtocolVersion,
    snapshot: {
      revision: 1,
      lastSequence: 0,
      runtime: { state: "starting", generation: 0 },
      runner: { state: "notPaired" },
      accounts: [{
        id: "acct_snapshot01",
        revision: 1,
        label,
        selected: true,
        identityLabel: null,
        planLabel: null,
        weeklyUsage: null,
        authState: "signedOut",
        login: { state: "idle" },
        runtime: { state: "stopped", generation: 0 },
      }],
      retainedAccountLocalData: [],
      humanAccount: { state: "signedOut", revision: 0 },
      execution: {
        folderAccess: { revision: 1, displayName: "Documents", availability: "ready" },
        approvalPolicy: "never",
        approvalsReviewer: "auto_review",
        sandbox: "danger-full-access",
        computerUse: "required",
      },
      chat: { revision: 1, panes: [] },
      sessionSync: {
        status: {
          state: "unavailable",
          reason: "cloudConfigurationMissing",
          retryable: false,
        },
        localGridSlots: [],
        remoteSessions: [],
      },
      harness: null,
    },
  };
}

function expectChunk(value: unknown): RuntimeSnapshotChunkResponse {
  if (typeof value !== "object" || value === null || !("base64" in value)) {
    throw new Error("Expected a snapshot transfer chunk");
  }
  return value as RuntimeSnapshotChunkResponse;
}

describe("snapshot transfer store", () => {
  test("returns small snapshots directly", () => {
    const response = snapshotResponse();
    expect(new SnapshotTransferStore().start(response)).toEqual(response);
  });

  test("reassembles a multibyte snapshot while every host line stays below one MiB", () => {
    const response = snapshotResponse("🌿".repeat(20));
    const store = new SnapshotTransferStore({
      chunkByteLimit: 64,
      createTransferId: () => "snapshot_12345678",
      directByteCeiling: 96,
    });
    const chunks: RuntimeSnapshotChunkResponse[] = [expectChunk(store.start(response))];
    const count = chunks[0]?.count ?? 0;
    for (let index = 1; index < count; index += 1) {
      chunks.push(store.continue({
        version: runtimeProtocolVersion,
        transferId: "snapshot_12345678",
        index,
      }));
    }

    for (const chunk of chunks) {
      const hostLine = JSON.stringify({ id: "x".repeat(64), ok: true, result: chunk });
      expect(Buffer.byteLength(hostLine)).toBeLessThan(nativeBridgeResponseByteLimit);
    }
    const bytes = Buffer.concat(chunks.map(({ base64 }) => Buffer.from(base64, "base64")));
    expect(parseRuntimeSnapshotResponse(JSON.parse(bytes.toString("utf8")) as unknown)).toEqual(
      response,
    );
  });

  test("expires abandoned transfers without retaining a projection barrier", () => {
    let expire: () => void = () => undefined;
    const scheduler: SnapshotTransferScheduler = {
      schedule(callback) {
        expire = callback;
        return () => undefined;
      },
    };
    const store = new SnapshotTransferStore({
      chunkByteLimit: 64,
      createTransferId: () => "snapshot_12345678",
      directByteCeiling: 96,
      scheduler,
      transferTtlMs: 1,
    });
    const first = expectChunk(store.start(snapshotResponse("x".repeat(80))));
    expire();
    expect(() => store.continue({
      version: runtimeProtocolVersion,
      transferId: first.transferId,
      index: 1,
    })).toThrow(SnapshotTransferNotFoundError);
  });

  test("rejects a serialized snapshot beyond the hard chunk-count bound", () => {
    const store = new SnapshotTransferStore({
      chunkByteLimit: 1,
      directByteCeiling: 1,
    });
    expect(() => store.start(snapshotResponse())).toThrow(
      SnapshotTransferCapacityError,
    );
  });
});
