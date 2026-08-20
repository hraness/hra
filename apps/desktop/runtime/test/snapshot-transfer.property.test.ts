import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { assertProperty, fc } from "@hra-internal/test";
import {
  parseRuntimeSnapshotResponse,
  runtimeProtocolVersion,
  type RuntimeSnapshotChunkResponse,
  type RuntimeSnapshotResponse,
} from "../../contracts/runtime";
import {
  nativeBridgeResponseByteLimit,
  SnapshotTransferStore,
} from "../src/snapshot-transfer";

test("paged snapshots round-trip arbitrary multibyte content within every host envelope", () => {
  assertProperty(
    fc.property(
      fc.array(fc.constantFrom("a", "é", "界", "🙂", "\\", "\"", "\n", "\u0000"), {
        minLength: 1,
        maxLength: 16,
      }),
      (pieces) => {
        const response = snapshotResponse(pieces.join(""));
        const store = new SnapshotTransferStore({
          chunkByteLimit: 7,
          createTransferId: () => "snapshot_12345678",
          directByteCeiling: 64,
        });
        const first = store.start(response);
        if (!("base64" in first)) throw new Error("property did not produce a paged snapshot");

        const chunks: RuntimeSnapshotChunkResponse[] = [first];
        for (let index = 1; index < first.count; index += 1) {
          chunks.push(store.continue({
            version: runtimeProtocolVersion,
            transferId: first.transferId,
            index,
          }));
        }

        expect(chunks.map(({ index }) => index)).toEqual(
          Array.from({ length: first.count }, (_, index) => index),
        );
        for (const chunk of chunks) {
          const hostLine = JSON.stringify({ id: "x".repeat(64), ok: true, result: chunk });
          expect(Buffer.byteLength(hostLine)).toBeLessThan(nativeBridgeResponseByteLimit);
        }

        const bytes = Buffer.concat(chunks.map(({ base64 }) => Buffer.from(base64, "base64")));
        expect(parseRuntimeSnapshotResponse(JSON.parse(bytes.toString("utf8")) as unknown)).toEqual(
          response,
        );
      },
    ),
    { numRuns: 30 },
  );
});

function snapshotResponse(text: string): RuntimeSnapshotResponse {
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
        label: text,
        selected: true,
        identityLabel: null,
        planLabel: null,
        usageRemainingPercent: null,
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
