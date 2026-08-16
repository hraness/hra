import { Buffer } from "node:buffer";
import {
  dispatchTransferIdSchema,
  runtimeDispatchChunkByteLimit,
  runtimeDispatchChunkCountLimit,
  runtimeProtocolVersion,
  type RuntimeDispatchChunkResponse,
  type RuntimeDispatchContinuationRequest,
  type RuntimeDispatchResponse,
  type RuntimeDispatchTransportResponse,
  type RuntimeTaskDispatchResponse,
} from "../../contracts/runtime";

/** Leaves room beneath the pinned Native SDK one-MiB response ceiling. */
export const runtimeDispatchDirectByteCeiling = 768 * 1024;

const defaultTransferTtlMs = 30_000;
const defaultMaximumActiveTransfers = 8;
const defaultMaximumActiveBytes =
  runtimeDispatchChunkByteLimit * runtimeDispatchChunkCountLimit * 2;

export interface DispatchTransferScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface DispatchTransferStoreOptions {
  readonly chunkByteLimit?: number;
  readonly createTransferId?: () => string;
  readonly directByteCeiling?: number;
  readonly maximumActiveBytes?: number;
  readonly maximumActiveTransfers?: number;
  readonly scheduler?: DispatchTransferScheduler;
  readonly transferTtlMs?: number;
}

interface ActiveTransfer {
  readonly bytes: Uint8Array;
  readonly chunkByteLimit: number;
  readonly count: number;
  readonly id: string;
  readonly operationId: string;
  cancelExpiration: () => void;
}

const defaultScheduler: DispatchTransferScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export class DispatchTransferNotFoundError extends Error {
  constructor() {
    super("The dispatch response transfer is unavailable");
    this.name = "DispatchTransferNotFoundError";
  }
}

export class DispatchTransferCapacityError extends Error {
  constructor(message = "The dispatch response transfer capacity is exhausted") {
    super(message);
    this.name = "DispatchTransferCapacityError";
  }
}

/**
 * Retains only immutable serialized responses. Transfers are bounded by count,
 * bytes, chunk count, and TTL so a renderer cannot turn continuation requests
 * into unbounded gateway memory.
 */
export class DispatchTransferStore {
  readonly #chunkByteLimit: number;
  readonly #createTransferId: () => string;
  readonly #directByteCeiling: number;
  readonly #maximumActiveBytes: number;
  readonly #maximumActiveTransfers: number;
  readonly #scheduler: DispatchTransferScheduler;
  readonly #transferTtlMs: number;
  readonly #active = new Map<string, ActiveTransfer>();
  #activeBytes = 0;

  constructor(options: DispatchTransferStoreOptions = {}) {
    const chunkByteLimit = options.chunkByteLimit ?? runtimeDispatchChunkByteLimit;
    const directByteCeiling =
      options.directByteCeiling ?? runtimeDispatchDirectByteCeiling;
    const maximumActiveBytes =
      options.maximumActiveBytes ?? defaultMaximumActiveBytes;
    const maximumActiveTransfers =
      options.maximumActiveTransfers ?? defaultMaximumActiveTransfers;
    const transferTtlMs = options.transferTtlMs ?? defaultTransferTtlMs;
    if (
      !Number.isSafeInteger(chunkByteLimit) ||
      chunkByteLimit < 1 ||
      chunkByteLimit > runtimeDispatchChunkByteLimit
    ) {
      throw new RangeError(
        "dispatch chunk limit must be a positive safe integer within the transport limit",
      );
    }
    if (
      !Number.isSafeInteger(directByteCeiling) ||
      directByteCeiling < 1 ||
      directByteCeiling > runtimeDispatchDirectByteCeiling
    ) {
      throw new RangeError(
        "dispatch direct ceiling must be a positive safe integer within the transport limit",
      );
    }
    if (
      !Number.isSafeInteger(maximumActiveBytes) ||
      maximumActiveBytes < chunkByteLimit
    ) {
      throw new RangeError("dispatch transfer byte capacity is invalid");
    }
    if (
      !Number.isSafeInteger(maximumActiveTransfers) ||
      maximumActiveTransfers < 1 ||
      maximumActiveTransfers > runtimeDispatchChunkCountLimit
    ) {
      throw new RangeError("dispatch transfer count capacity is invalid");
    }
    if (!Number.isSafeInteger(transferTtlMs) || transferTtlMs <= 0) {
      throw new RangeError("dispatch transfer TTL must be a positive safe integer");
    }
    this.#chunkByteLimit = chunkByteLimit;
    this.#createTransferId = options.createTransferId ??
      (() => `response_${crypto.randomUUID().replaceAll("-", "")}`);
    this.#directByteCeiling = directByteCeiling;
    this.#maximumActiveBytes = maximumActiveBytes;
    this.#maximumActiveTransfers = maximumActiveTransfers;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#transferTtlMs = transferTtlMs;
  }

  start(
    response: RuntimeDispatchResponse | RuntimeTaskDispatchResponse,
  ): RuntimeDispatchTransportResponse {
    const bytes = new TextEncoder().encode(JSON.stringify(response));
    if (bytes.byteLength <= this.#directByteCeiling) return response;

    const count = Math.ceil(bytes.byteLength / this.#chunkByteLimit);
    if (count > runtimeDispatchChunkCountLimit) {
      throw new DispatchTransferCapacityError(
        "The dispatch response exceeds the transport chunk limit",
      );
    }
    if (
      this.#active.size >= this.#maximumActiveTransfers ||
      this.#activeBytes + bytes.byteLength > this.#maximumActiveBytes
    ) {
      throw new DispatchTransferCapacityError();
    }
    const id = dispatchTransferIdSchema.parse(this.#createTransferId());
    if (this.#active.has(id)) {
      throw new DispatchTransferCapacityError(
        "The dispatch response transfer ID is already active",
      );
    }
    const transfer: ActiveTransfer = {
      bytes,
      chunkByteLimit: this.#chunkByteLimit,
      count,
      id,
      operationId: response.operationId,
      cancelExpiration: () => undefined,
    };
    this.#active.set(id, transfer);
    this.#activeBytes += bytes.byteLength;
    this.#touch(transfer);
    return this.#chunk(transfer, 0);
  }

  continue(
    request: RuntimeDispatchContinuationRequest,
  ): RuntimeDispatchChunkResponse {
    const transfer = this.#active.get(request.transferId);
    if (
      transfer === undefined ||
      transfer.operationId !== request.operationId ||
      request.index >= transfer.count
    ) {
      throw new DispatchTransferNotFoundError();
    }
    const response = this.#chunk(transfer, request.index);
    if (request.index === transfer.count - 1) this.#remove(transfer);
    else this.#touch(transfer);
    return response;
  }

  dispose(): void {
    for (const transfer of this.#active.values()) {
      transfer.cancelExpiration();
    }
    this.#active.clear();
    this.#activeBytes = 0;
  }

  #chunk(
    transfer: ActiveTransfer,
    index: number,
  ): RuntimeDispatchChunkResponse {
    const start = index * transfer.chunkByteLimit;
    const end = Math.min(start + transfer.chunkByteLimit, transfer.bytes.byteLength);
    return {
      version: runtimeProtocolVersion,
      operationId: transfer.operationId,
      transferId: transfer.id,
      index,
      count: transfer.count,
      base64: Buffer.from(transfer.bytes.subarray(start, end)).toString("base64"),
    };
  }

  #remove(transfer: ActiveTransfer): void {
    if (this.#active.get(transfer.id) !== transfer) return;
    this.#active.delete(transfer.id);
    this.#activeBytes -= transfer.bytes.byteLength;
    transfer.cancelExpiration();
  }

  #touch(transfer: ActiveTransfer): void {
    transfer.cancelExpiration();
    transfer.cancelExpiration = this.#scheduler.schedule(() => {
      this.#remove(transfer);
    }, this.#transferTtlMs);
  }
}
