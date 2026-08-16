import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import {
  parseRuntimeDispatchTransportResponse,
  parseRuntimeTaskDispatchResponse,
  runtimeProtocolVersion,
  type RuntimeDispatchChunkResponse,
  type RuntimeTaskDispatchResponse,
} from "../../contracts/runtime";
import {
  DispatchTransferCapacityError,
  DispatchTransferNotFoundError,
  DispatchTransferStore,
  type DispatchTransferScheduler,
} from "../src/dispatch-transfer";
import { nativeBridgeResponseByteLimit } from "../src/snapshot-transfer";

function taskErrorResponse(
  operationId = "op_dispatch01",
  message = "🌿".repeat(100),
): RuntimeTaskDispatchResponse {
  return {
    version: runtimeProtocolVersion,
    operationId,
    ok: false,
    error: {
      code: "operation_failed",
      message,
      retryable: false,
      action: "none",
    },
  };
}

function expectChunk(value: unknown): RuntimeDispatchChunkResponse {
  const parsed = parseRuntimeDispatchTransportResponse(value);
  if (!("base64" in parsed)) throw new Error("Expected a dispatch transfer chunk");
  return parsed;
}

describe("dispatch response transfer store", () => {
  test("returns small responses directly", () => {
    const response = taskErrorResponse("op_direct0001", "failed");
    expect(new DispatchTransferStore().start(response)).toEqual(response);
  });

  test("round-trips immutable multibyte responses below the Native envelope limit", () => {
    const response = taskErrorResponse();
    const store = new DispatchTransferStore({
      chunkByteLimit: 64,
      createTransferId: () => "response_12345678",
      directByteCeiling: 96,
      maximumActiveBytes: 4_096,
    });
    const first = expectChunk(store.start(response));
    const chunks = [first];
    for (let index = 1; index < first.count; index += 1) {
      chunks.push(store.continue({
        version: runtimeProtocolVersion,
        operationId: response.operationId,
        transferId: first.transferId,
        index,
      }));
    }

    for (const chunk of chunks) {
      const hostLine = JSON.stringify({
        id: "x".repeat(64),
        ok: true,
        result: chunk,
      });
      expect(Buffer.byteLength(hostLine)).toBeLessThan(nativeBridgeResponseByteLimit);
    }
    const bytes = Buffer.concat(
      chunks.map(({ base64 }) => Buffer.from(base64, "base64")),
    );
    expect(
      parseRuntimeTaskDispatchResponse(JSON.parse(bytes.toString("utf8")) as unknown),
    ).toEqual(response);
    expect(() => store.continue({
      version: runtimeProtocolVersion,
      operationId: response.operationId,
      transferId: first.transferId,
      index: first.count - 1,
    })).toThrow(DispatchTransferNotFoundError);
  });

  test("binds continuations to both operation and transfer identity", () => {
    const store = new DispatchTransferStore({
      chunkByteLimit: 64,
      createTransferId: () => "response_12345678",
      directByteCeiling: 96,
      maximumActiveBytes: 4_096,
    });
    const first = expectChunk(store.start(taskErrorResponse()));

    expect(() => store.continue({
      version: runtimeProtocolVersion,
      operationId: "op_wrong0001",
      transferId: first.transferId,
      index: 1,
    })).toThrow(DispatchTransferNotFoundError);
    expect(() => store.continue({
      version: runtimeProtocolVersion,
      operationId: first.operationId,
      transferId: "response_wrong0001",
      index: 1,
    })).toThrow(DispatchTransferNotFoundError);
  });

  test("expires transfers and enforces aggregate capacity", () => {
    let expire: () => void = () => undefined;
    const scheduler: DispatchTransferScheduler = {
      schedule(callback) {
        expire = callback;
        return () => undefined;
      },
    };
    let nextId = 0;
    const store = new DispatchTransferStore({
      chunkByteLimit: 64,
      createTransferId: () => `response_${String(++nextId).padStart(8, "0")}`,
      directByteCeiling: 96,
      maximumActiveBytes: 4_096,
      maximumActiveTransfers: 1,
      scheduler,
      transferTtlMs: 1,
    });
    const first = expectChunk(store.start(taskErrorResponse()));
    expect(() => store.start(taskErrorResponse("op_dispatch02"))).toThrow(
      DispatchTransferCapacityError,
    );
    expire();
    expect(() => store.continue({
      version: runtimeProtocolVersion,
      operationId: first.operationId,
      transferId: first.transferId,
      index: 1,
    })).toThrow(DispatchTransferNotFoundError);
    expectChunk(store.start(taskErrorResponse("op_dispatch02")));
  });
});
