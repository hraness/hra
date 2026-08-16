import { Buffer } from "node:buffer";
import {
  runtimeProtocolVersion,
  runtimeSnapshotChunkByteLimit,
  runtimeSnapshotChunkCountLimit,
  type RuntimeSnapshotChunkResponse,
  type RuntimeSnapshotRequest,
  type RuntimeSnapshotResponse,
  type RuntimeSnapshotTransportResponse,
} from "../../contracts/runtime";

/** Pinned Native SDK 0.5.3 bridge response limit. */
export const nativeBridgeResponseByteLimit = 1024 * 1024;
/** Leaves space for the private host response envelope and future fields. */
export const runtimeSnapshotDirectByteCeiling = 768 * 1024;

const defaultTransferTtlMs = 30_000;

type SnapshotContinuationRequest = Extract<RuntimeSnapshotRequest, { transferId: string }>;

export interface SnapshotTransferScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface SnapshotTransferStoreOptions {
  readonly chunkByteLimit?: number;
  readonly createTransferId?: () => string;
  readonly directByteCeiling?: number;
  readonly scheduler?: SnapshotTransferScheduler;
  readonly transferTtlMs?: number;
}

interface ActiveTransfer {
  readonly bytes: Uint8Array;
  readonly chunkByteLimit: number;
  readonly count: number;
  readonly id: string;
  cancelExpiration: () => void;
}

const defaultScheduler: SnapshotTransferScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export class SnapshotTransferNotFoundError extends Error {
  constructor() {
    super("The snapshot transfer is unavailable");
    this.name = "SnapshotTransferNotFoundError";
  }
}

export class SnapshotTransferCapacityError extends Error {
  constructor() {
    super("The snapshot exceeds the bounded transfer capacity");
    this.name = "SnapshotTransferCapacityError";
  }
}

/**
 * Pages only the private bridge representation. The serialized snapshot is
 * immutable, while the projection barrier is released after the first page so
 * later events can stream and be buffered by the renderer during assembly.
 */
export class SnapshotTransferStore {
  readonly #chunkByteLimit: number;
  readonly #createTransferId: () => string;
  readonly #directByteCeiling: number;
  readonly #scheduler: SnapshotTransferScheduler;
  readonly #transferTtlMs: number;
  #active: ActiveTransfer | null = null;

  constructor(options: SnapshotTransferStoreOptions = {}) {
    const chunkByteLimit = options.chunkByteLimit ?? runtimeSnapshotChunkByteLimit;
    const directByteCeiling = options.directByteCeiling ?? runtimeSnapshotDirectByteCeiling;
    const transferTtlMs = options.transferTtlMs ?? defaultTransferTtlMs;
    if (!Number.isSafeInteger(chunkByteLimit) || chunkByteLimit < 1 || chunkByteLimit > runtimeSnapshotChunkByteLimit) {
      throw new RangeError("snapshot chunk limit must be a positive safe integer within the transport limit");
    }
    if (!Number.isSafeInteger(directByteCeiling) || directByteCeiling < 1 || directByteCeiling > runtimeSnapshotDirectByteCeiling) {
      throw new RangeError("snapshot direct ceiling must be a positive safe integer within the transport limit");
    }
    if (!Number.isSafeInteger(transferTtlMs) || transferTtlMs <= 0) {
      throw new RangeError("snapshot transfer TTL must be a positive safe integer");
    }
    this.#chunkByteLimit = chunkByteLimit;
    this.#createTransferId = options.createTransferId ??
      (() => `snapshot_${crypto.randomUUID().replaceAll("-", "")}`);
    this.#directByteCeiling = directByteCeiling;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#transferTtlMs = transferTtlMs;
  }

  start(response: RuntimeSnapshotResponse): RuntimeSnapshotTransportResponse {
    this.dispose();
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    if (bytes.byteLength <= this.#directByteCeiling) return response;

    const count = Math.ceil(bytes.byteLength / this.#chunkByteLimit);
    if (count > runtimeSnapshotChunkCountLimit) {
      throw new SnapshotTransferCapacityError();
    }
    const transfer: ActiveTransfer = {
      bytes,
      chunkByteLimit: this.#chunkByteLimit,
      count,
      id: this.#createTransferId(),
      cancelExpiration: () => undefined,
    };
    this.#active = transfer;
    this.#touch(transfer);
    return this.#chunk(transfer, 0);
  }

  continue(request: SnapshotContinuationRequest): RuntimeSnapshotChunkResponse {
    const transfer = this.#active;
    if (
      transfer === null ||
      transfer.id !== request.transferId ||
      request.index >= transfer.count
    ) {
      throw new SnapshotTransferNotFoundError();
    }
    const response = this.#chunk(transfer, request.index);
    if (request.index === transfer.count - 1) this.dispose();
    else this.#touch(transfer);
    return response;
  }

  dispose(): void {
    const transfer = this.#active;
    this.#active = null;
    transfer?.cancelExpiration();
  }

  #chunk(transfer: ActiveTransfer, index: number): RuntimeSnapshotChunkResponse {
    const start = index * transfer.chunkByteLimit;
    const end = Math.min(start + transfer.chunkByteLimit, transfer.bytes.byteLength);
    return {
      version: runtimeProtocolVersion,
      transferId: transfer.id,
      index,
      count: transfer.count,
      base64: Buffer.from(transfer.bytes.subarray(start, end)).toString("base64"),
    };
  }

  #touch(transfer: ActiveTransfer): void {
    transfer.cancelExpiration();
    transfer.cancelExpiration = this.#scheduler.schedule(() => {
      if (this.#active === transfer) this.#active = null;
    }, this.#transferTtlMs);
  }
}
