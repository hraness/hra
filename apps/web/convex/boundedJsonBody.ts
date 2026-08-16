const INITIAL_BODY_CAPACITY_BYTES = 8 * 1_024;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const DEFAULT_BODY_READ_TIMEOUT_MS = 10_000;
const MAXIMUM_BODY_READ_TIMEOUT_MS = 60_000;
// Network runtimes normally coalesce request bytes. This separate work bound
// prevents a legal but adversarial stream of tiny ready chunks from consuming
// one microtask per byte even before its byte or wall-clock limit is reached.
const MAXIMUM_BODY_CHUNKS = 4_096;
const CANCELLATION_SETTLE_TIMEOUT_MS = 100;

function declaredContentLength(request: Request): number | null | undefined {
  const value = request.headers.get("content-length");
  if (value === null) return undefined;
  if (!CONTENT_LENGTH_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  let cancellation: Promise<void>;
  try {
    cancellation = reader.cancel();
  } catch {
    // A failed transport cancellation must not turn a bounded rejection into a 500.
    return;
  }
  await settleCancellation(cancellation);
}

async function cancelStream(
  stream: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (stream === null) return;
  let cancellation: Promise<void>;
  try {
    cancellation = stream.cancel();
  } catch {
    // The request stream may already have failed or been closed by the runtime.
    return;
  }
  await settleCancellation(cancellation);
}

async function settleCancellation(cancellation: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cancellation.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CANCELLATION_SETTLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function readBoundedUtf8Bytes(
  request: Request,
  maximumBytes: number,
  options: Readonly<{ readTimeoutMs?: number }> = {},
): Promise<Uint8Array | null> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("maximumBytes must be a non-negative safe integer");
  }
  const readTimeoutMs = options.readTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(readTimeoutMs) ||
    readTimeoutMs < 1 ||
    readTimeoutMs > MAXIMUM_BODY_READ_TIMEOUT_MS
  ) {
    throw new RangeError(
      "readTimeoutMs must be a positive bounded safe integer",
    );
  }

  const contentEncoding = request.headers.get("content-encoding");
  if (
    contentEncoding !== null &&
    contentEncoding.trim().toLowerCase() !== "identity"
  ) {
    await cancelStream(request.body);
    return null;
  }

  const declaredBytes = declaredContentLength(request);
  if (
    declaredBytes === null ||
    (declaredBytes !== undefined && declaredBytes > maximumBytes)
  ) {
    await cancelStream(request.body);
    return null;
  }

  const stream = request.body;
  if (stream === null) return null;

  const initialCapacity = Math.min(
    maximumBytes,
    declaredBytes ?? INITIAL_BODY_CAPACITY_BYTES,
  );
  let bytes = new Uint8Array(initialCapacity);
  let receivedBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return null;
  }
  const timedOut = Symbol("body-read-timeout");
  const aborted = Symbol("body-read-aborted");
  const deadline = performance.now() + readTimeoutMs;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<typeof timedOut>((resolve) => {
    timeout = setTimeout(() => resolve(timedOut), readTimeoutMs);
  });
  let removeAbortListener = (): void => undefined;
  const abortResult = new Promise<typeof aborted>((resolve) => {
    const onAbort = (): void => resolve(aborted);
    request.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () =>
      request.signal.removeEventListener("abort", onAbort);
    if (request.signal.aborted) onAbort();
  });
  let chunkCount = 0;

  try {
    for (;;) {
      if (request.signal.aborted || performance.now() >= deadline) {
        await cancelReader(reader);
        return null;
      }
      const next = await Promise.race([
        reader.read(),
        timeoutResult,
        abortResult,
      ]);
      if (
        next === timedOut ||
        next === aborted ||
        request.signal.aborted ||
        performance.now() >= deadline
      ) {
        await cancelReader(reader);
        return null;
      }
      const { done, value } = next;
      if (done) break;
      chunkCount += 1;
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength === 0 ||
        chunkCount > MAXIMUM_BODY_CHUNKS ||
        value.byteLength > maximumBytes - receivedBytes
      ) {
        await cancelReader(reader);
        return null;
      }

      const requiredCapacity = receivedBytes + value.byteLength;
      if (requiredCapacity > bytes.byteLength) {
        let nextCapacity = Math.max(
          requiredCapacity,
          Math.max(INITIAL_BODY_CAPACITY_BYTES, bytes.byteLength * 2),
        );
        nextCapacity = Math.min(maximumBytes, nextCapacity);
        const grown = new Uint8Array(nextCapacity);
        grown.set(bytes.subarray(0, receivedBytes));
        bytes = grown;
      }
      bytes.set(value, receivedBytes);
      receivedBytes = requiredCapacity;
    }
  } catch {
    await cancelReader(reader);
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener();
    try {
      reader.releaseLock();
    } catch {
      // A transport whose cancellation never settles may retain its read lock.
      // The parser still returns within its fixed deadline.
    }
  }

  if (declaredBytes !== undefined && declaredBytes !== receivedBytes) {
    return null;
  }

  const result = bytes.slice(0, receivedBytes);
  try {
    // Validate before this exact byte sequence crosses a signature or JSON
    // boundary. `ignoreBOM: true` means a leading BOM is preserved as U+FEFF
    // instead of being silently stripped by TextDecoder.
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result);
  } catch {
    return null;
  }
  return result;
}

export async function readBoundedUtf8Body(
  request: Request,
  maximumBytes: number,
  options: Readonly<{ readTimeoutMs?: number }> = {},
): Promise<string | null> {
  const bytes = await readBoundedUtf8Bytes(request, maximumBytes, options);
  return bytes === null
    ? null
    : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function parseBoundedJsonBody(
  request: Request,
  maximumBytes: number,
  options: Readonly<{ readTimeoutMs?: number }> = {},
): Promise<unknown | null> {
  const body = await readBoundedUtf8Body(request, maximumBytes, options);
  if (body === null) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}
