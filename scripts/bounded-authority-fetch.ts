export type AuthorityFetcher = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export const createBoundedAuthorityFetch = (
  fetcher: AuthorityFetcher,
  timeoutMs: number,
  timeoutCode: string,
): typeof fetch => Object.assign(async (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> => {
  const controller = new AbortController();
  const upstream = init?.signal;
  if (upstream?.aborted === true) {
    throw upstream.reason instanceof Error
      ? upstream.reason
      : new Error(timeoutCode);
  }

  let deadlineError: Error | undefined;
  let rejectDeadline: ((error: Error) => void) | undefined;
  const bodyState: {
    reader?: ReadableStreamDefaultReader<Uint8Array>;
  } = {};
  let settled = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  // Observe the original promise immediately. It remains the rejection arm of
  // every header and body race, including a body read begun after expiry.
  deadline.catch(() => undefined);
  const cleanup = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    upstream?.removeEventListener("abort", abortFromUpstream);
  };
  const stop = (error: Error): void => {
    if (deadlineError !== undefined) return;
    deadlineError = error;
    controller.abort(error);
    rejectDeadline?.(error);
    const cancellation = bodyState.reader?.cancel(error);
    cancellation?.then(() => undefined, () => undefined);
    cleanup();
  };
  const abortFromUpstream = (): void => {
    const reason: unknown = upstream?.reason;
    stop(reason instanceof Error ? reason : new Error(timeoutCode));
  };
  upstream?.addEventListener("abort", abortFromUpstream, { once: true });
  const timeout = setTimeout(() => stop(new Error(timeoutCode)), timeoutMs);
  const transport = Promise.resolve()
    .then(async () => await fetcher(input, { ...init, signal: controller.signal }));
  // A transport that ignores AbortSignal may settle after the deadline. Both
  // late fulfillment and late rejection are consumed.
  transport.then((lateResponse) => {
    if (deadlineError === undefined) return;
    const cancellation = lateResponse.body?.cancel(deadlineError);
    cancellation?.then(() => undefined, () => undefined);
  }, () => undefined);

  let response: Response;
  try {
    response = await Promise.race([transport, deadline]);
  } catch (error: unknown) {
    cleanup();
    throw error;
  }
  if (response.body === null) {
    cleanup();
    return response;
  }

  const bodyReader = response.body.getReader();
  bodyState.reader = bodyReader;
  const body = new ReadableStream<Uint8Array>({
    async cancel(reason): Promise<void> {
      stop(reason instanceof Error ? reason : new Error(timeoutCode));
      cleanup();
    },
    async pull(streamController): Promise<void> {
      try {
        const next = await Promise.race([bodyReader.read(), deadline]);
        if (next.done) {
          cleanup();
          streamController.close();
        } else {
          streamController.enqueue(next.value);
        }
      } catch (error: unknown) {
        stop(error instanceof Error ? error : new Error(timeoutCode));
        cleanup();
        streamController.error(error);
      }
    },
  });
  const boundedResponse = new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  // Re-wrapping the body otherwise erases the transport's final URL and
  // redirect provenance. Publication acceptance treats that readback as
  // authority, so preserve it while the new Response owns the bounded body.
  Object.defineProperties(boundedResponse, {
    redirected: { configurable: false, enumerable: false, value: response.redirected },
    type: { configurable: false, enumerable: false, value: response.type },
    url: { configurable: false, enumerable: false, value: response.url },
  });
  return boundedResponse;
}, {
  preconnect: (url: string | URL): void => {
    void url;
  },
});
