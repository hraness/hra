import { timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import {
  canonicalAttentionProjection,
  type AttentionProjection,
} from "@hraness/hra-local-observation-protocol/attention";
import {
  localObservationRequestByteLimit,
  localObservationResponseByteLimit,
  localObservationResponseSchema,
  localObservationTimeoutMilliseconds,
  parseLocalObservationRequest,
  type LocalObservationResponse,
} from "@hraness/hra-local-observation-protocol/wire";

import {
  prepareLocalObservationEndpoint,
  type LocalObservationServerProfile,
} from "./endpoint";
import {
  projectFreshLocalPaneList,
  type GatewayPaneObservationSource,
} from "./projection";

const maximumLocalObservationConnections = 16;

export interface LocalObservationServer {
  close(): Promise<void>;
}

export interface LocalObservationCaptures {
  readonly attention: (signal: AbortSignal) => unknown;
  readonly panes: (signal: AbortSignal) =>
    | readonly GatewayPaneObservationSource[]
    | Promise<readonly GatewayPaneObservationSource[]>;
}

function closedError(code: "invalid_request" | "unauthorized" | "runtime_unavailable" | "observation_unavailable"):
  LocalObservationResponse {
  return localObservationResponseSchema.parse({
    version: 1,
    ok: false,
    error: { code },
  });
}

function authorized(candidate: string, expected: Buffer): boolean {
  let decoded: Buffer;
  try {
    decoded = Buffer.from(candidate, "base64url");
  } catch {
    return false;
  }
  return decoded.byteLength === expected.byteLength && timingSafeEqual(decoded, expected);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

interface StartLocalObservationServerOptions {
  readonly endpointRoot: string;
  readonly profile: LocalObservationServerProfile;
  readonly captures: LocalObservationCaptures;
}

interface StartLocalObservationServerInternalOptions
  extends StartLocalObservationServerOptions {
  readonly requestTimeoutMilliseconds?: number;
  readonly maximumConnections?: number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

async function startLocalObservationServerInternal(
  options: StartLocalObservationServerInternalOptions,
): Promise<LocalObservationServer | null> {
  if (options.profile === "automation" || options.profile === "recovery") return null;
  const timeout = options.requestTimeoutMilliseconds ??
    localObservationTimeoutMilliseconds;
  const maximumConnections = options.maximumConnections ??
    maximumLocalObservationConnections;
  if (
    !Number.isSafeInteger(timeout) || timeout < 1 ||
    timeout > localObservationTimeoutMilliseconds ||
    !Number.isSafeInteger(maximumConnections) || maximumConnections < 1 ||
    maximumConnections > maximumLocalObservationConnections
  ) throw new TypeError("Local observation server limits are invalid.");

  const endpoint = prepareLocalObservationEndpoint({
    endpointRoot: options.endpointRoot,
    ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
  });
  const sockets = new Set<Socket>();
  const captureAbort = new AbortController();
  const captureTasks = new Set<Promise<void>>();
  let closing = false;

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const requestAbort = new AbortController();
    const requestSignal = AbortSignal.any([
      captureAbort.signal,
      requestAbort.signal,
    ]);
    let deadline: ReturnType<typeof setTimeout> | null = null;
    socket.once("close", () => {
      if (deadline !== null) clearTimeout(deadline);
      sockets.delete(socket);
      requestAbort.abort(new Error("Local observation client disconnected."));
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let responded = false;
    let framed = false;
    let authorizedRequest = false;
    const respond = (response: LocalObservationResponse) => {
      if (responded) return;
      responded = true;
      const serialized = JSON.stringify(localObservationResponseSchema.parse(response));
      if (Buffer.byteLength(serialized, "utf8") > localObservationResponseByteLimit) {
        socket.end(JSON.stringify(closedError("observation_unavailable")));
        socket.destroySoon();
        return;
      }
      socket.end(serialized);
      // allowHalfOpen is needed for EOF framing, so explicitly close the read
      // side after the bounded response has entered the local socket buffer.
      socket.destroySoon();
    };
    // This is one absolute request deadline. Socket inactivity timeouts reset
    // on each byte and would let a trickling peer hold authority indefinitely.
    deadline = setTimeout(() => {
      requestAbort.abort(new Error("Local observation request timed out."));
      if (!responded) {
        respond(closedError(
          authorizedRequest ? "observation_unavailable" : "invalid_request",
        ));
      } else {
        socket.destroy();
      }
    }, timeout);
    if (closing || sockets.size > maximumConnections) {
      respond(closedError("runtime_unavailable"));
      return;
    }
    const processFrame = (body: Buffer) => {
      if (closing) {
        respond(closedError("runtime_unavailable"));
        return;
      }
      let request;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        request = parseLocalObservationRequest(JSON.parse(text) as unknown);
      } catch {
        respond(closedError("invalid_request"));
        return;
      }
      if (!authorized(request.capability, endpoint.capabilityBytes)) {
        respond(closedError("unauthorized"));
        return;
      }
      authorizedRequest = true;
      const capture = (async () => {
        try {
          if (request.operation === "attention.list") {
            const projection: AttentionProjection = canonicalAttentionProjection(
              await options.captures.attention(requestSignal),
            );
            if (requestSignal.aborted) return;
            respond(localObservationResponseSchema.parse({
              version: 1,
              ok: true,
              result: { type: "attention", projection },
            }));
            return;
          }
          const projection = projectFreshLocalPaneList(
            await options.captures.panes(requestSignal),
          );
          if (requestSignal.aborted) return;
          respond(localObservationResponseSchema.parse({
            version: 1,
            ok: true,
            result: { type: "panes", projection },
          }));
        } catch {
          if (!requestSignal.aborted) {
            respond(closedError("observation_unavailable"));
          }
        }
      })();
      captureTasks.add(capture);
      void capture.finally(() => captureTasks.delete(capture)).catch(() => undefined);
    };
    socket.on("data", (chunk: Buffer) => {
      if (responded) return;
      bytes += chunk.byteLength;
      if (bytes > localObservationRequestByteLimit) {
        respond(closedError("invalid_request"));
        return;
      }
      chunks.push(chunk);
      const buffered = Buffer.concat(chunks, bytes);
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      framed = true;
      if (newline !== buffered.byteLength - 1) {
        respond(closedError("invalid_request"));
        return;
      }
      processFrame(buffered.subarray(0, newline));
    });
    socket.once("error", () => undefined);
    socket.once("end", () => {
      if (!responded && !framed) respond(closedError("invalid_request"));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.paths.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    endpoint.markSocketReady();
  } catch (error: unknown) {
    server.close();
    endpoint.cleanup();
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    close: () => {
      if (closePromise !== null) return closePromise;
      closing = true;
      captureAbort.abort(new Error("Local observation server is closing."));
      for (const socket of sockets) socket.destroy();
      closePromise = (async () => {
        let closeFailure: Error | null = null;
        try {
          await closeServer(server);
        } catch (error: unknown) {
          closeFailure = error instanceof Error
            ? error
            : new Error("Local observation listener could not close.");
        }
        await Promise.allSettled([...captureTasks]);
        endpoint.cleanup();
        if (closeFailure !== null) throw closeFailure;
      })();
      return closePromise;
    },
  });
}

/** Production entrypoint. Security limits and entropy are intentionally fixed. */
export async function startLocalObservationServer(
  options: StartLocalObservationServerOptions,
): Promise<LocalObservationServer | null> {
  return await startLocalObservationServerInternal(options);
}

/** Narrow development-profile seam for deterministic limit and entropy tests. */
export async function startLocalObservationServerForTest(
  options: Omit<StartLocalObservationServerInternalOptions, "profile">,
): Promise<LocalObservationServer> {
  const server = await startLocalObservationServerInternal({
    ...options,
    profile: "development",
  });
  if (server === null) throw new Error("Development observation server was disabled.");
  return server;
}
