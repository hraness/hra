import { createConnection } from "node:net";

import {
  localObservationRequestSchema,
  localObservationResponseByteLimit,
  localObservationTimeoutMilliseconds,
  parseLocalObservationResponse,
  type LocalObservationRequest,
  type LocalObservationResponse,
} from "@hraness/hra-local-observation-protocol/wire";

import {
  discoverFixedLocalObservationEndpoints,
  type DiscoveredLocalObservationEndpoint,
} from "./discovery";

export type LocalCliFailureCode =
  | "runtime_unavailable"
  | "multiple_runtimes"
  | "invalid_response"
  | "unauthorized"
  | "observation_unavailable";

export class LocalCliFailure extends Error {
  readonly code: LocalCliFailureCode;

  constructor(code: LocalCliFailureCode) {
    super(code);
    this.name = "LocalCliFailure";
    this.code = code;
  }
}

interface QueryOptions {
  readonly homeDirectory: string;
  readonly expectedUid?: number;
  readonly timeoutMilliseconds?: number;
}

function requestFor(
  operation: LocalObservationRequest["operation"],
  capability: string,
): LocalObservationRequest {
  return localObservationRequestSchema.parse({
    version: 1,
    capability,
    operation,
  });
}

function requestEndpoint(
  endpoint: DiscoveredLocalObservationEndpoint,
  operation: LocalObservationRequest["operation"],
  timeoutMilliseconds: number,
): Promise<LocalObservationResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: endpoint.socket });
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const clearDeadline = () => {
      if (deadline === null) return;
      clearTimeout(deadline);
      deadline = null;
    };
    const fail = (code: LocalCliFailureCode) => {
      if (settled) return;
      settled = true;
      clearDeadline();
      socket.destroy();
      reject(new LocalCliFailure(code));
    };
    // Bound the whole exchange. An inactivity timeout would be extended by a
    // malicious runtime that trickles bytes without completing one response.
    deadline = setTimeout(
      () => fail("runtime_unavailable"),
      timeoutMilliseconds,
    );
    socket.once("connect", () => {
      const request = requestFor(operation, endpoint.capability);
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      byteLength += chunk.byteLength;
      if (byteLength > localObservationResponseByteLimit) {
        fail("invalid_response");
        return;
      }
      chunks.push(chunk);
    });
    socket.once("error", () => fail("runtime_unavailable"));
    socket.once("end", () => {
      if (settled) return;
      let response: LocalObservationResponse;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, byteLength),
        );
        response = parseLocalObservationResponse(JSON.parse(text) as unknown);
      } catch {
        fail("invalid_response");
        return;
      }
      if (
        response.ok &&
        ((operation === "attention.list" && response.result.type !== "attention") ||
          (operation === "panes.list" && response.result.type !== "panes"))
      ) {
        fail("invalid_response");
        return;
      }
      settled = true;
      clearDeadline();
      resolve(response);
    });
  });
}

export async function queryLocalDesktop(
  operation: LocalObservationRequest["operation"],
  options: QueryOptions,
): Promise<LocalObservationResponse> {
  const timeoutMilliseconds = options.timeoutMilliseconds ??
    localObservationTimeoutMilliseconds;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 ||
    timeoutMilliseconds > localObservationTimeoutMilliseconds
  ) throw new LocalCliFailure("runtime_unavailable");

  const endpoints = discoverFixedLocalObservationEndpoints(
    options.homeDirectory,
    options.expectedUid === undefined
      ? {}
      : { expectedUid: options.expectedUid },
  );
  if (endpoints.length === 0) throw new LocalCliFailure("runtime_unavailable");

  const attempts = await Promise.allSettled(
    endpoints.map(async (endpoint) => await requestEndpoint(
      endpoint,
      operation,
      timeoutMilliseconds,
    )),
  );
  const responses = attempts.flatMap((attempt) =>
    attempt.status === "fulfilled" ? [attempt.value] : []
  );
  if (responses.length === 0) {
    if (attempts.length === 1 && attempts[0]?.status === "rejected") {
      const reason: unknown = attempts[0].reason;
      if (reason instanceof LocalCliFailure) throw reason;
    }
    throw new LocalCliFailure("runtime_unavailable");
  }
  if (responses.length !== 1) throw new LocalCliFailure("multiple_runtimes");
  return responses[0]!;
}
