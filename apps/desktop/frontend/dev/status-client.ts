import {
  candidateMutationBody,
  DEV_ACK_PATH,
  DEV_ACK_SCHEMA,
  DEV_APPLY_PATH,
  DEV_APPLY_SCHEMA,
  DEV_CANCEL_PATH,
  DEV_CANCEL_SCHEMA,
  DEV_RESPONSE_BYTE_LIMIT,
  DEV_STATUS_PATH,
  parseDevStatusEnvelope,
  type DevStatusEnvelope,
} from "./protocol";

export interface DevStatusClient {
  read(): Promise<DevStatusEnvelope>;
  reserve(sessionId: string, candidateId: string): Promise<DevStatusEnvelope>;
  acknowledge(sessionId: string, candidateId: string): Promise<DevStatusEnvelope>;
  cancel(sessionId: string, candidateId: string): Promise<DevStatusEnvelope>;
}

export class DevStatusUnavailableError extends Error {
  constructor() {
    super("The authenticated development coordinator is unavailable.");
    this.name = "DevStatusUnavailableError";
  }
}

async function responseBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("Content-Length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > DEV_RESPONSE_BYTE_LIMIT)
  ) throw new DevStatusUnavailableError();
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > DEV_RESPONSE_BYTE_LIMIT) {
    throw new DevStatusUnavailableError();
  }
  return text;
}

async function statusFromResponse(response: Response): Promise<DevStatusEnvelope> {
  if (response.status !== 200 && response.status !== 409) {
    throw new DevStatusUnavailableError();
  }
  if (
    response.headers.get("Content-Type") !== "application/json; charset=utf-8" ||
    response.headers.get("Cache-Control") !== "no-store" ||
    response.headers.get("X-Content-Type-Options") !== "nosniff"
  ) throw new DevStatusUnavailableError();
  try {
    return parseDevStatusEnvelope(JSON.parse(await responseBody(response)) as unknown);
  } catch {
    throw new DevStatusUnavailableError();
  }
}

async function requestStatus(
  fetcher: typeof fetch,
  path: string,
  init?: RequestInit,
): Promise<DevStatusEnvelope> {
  let response: Response;
  try {
    response = await fetcher(path, {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      ...init,
    });
  } catch {
    throw new DevStatusUnavailableError();
  }
  return await statusFromResponse(response);
}

export function createDevStatusClient(fetcher: typeof fetch = fetch): DevStatusClient {
  const mutate = (
    path: string,
    schema: typeof DEV_APPLY_SCHEMA | typeof DEV_ACK_SCHEMA | typeof DEV_CANCEL_SCHEMA,
    sessionId: string,
    candidateId: string,
  ) => requestStatus(fetcher, path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: candidateMutationBody(schema, sessionId, candidateId),
  });
  return {
    read: () => requestStatus(fetcher, DEV_STATUS_PATH, {
      headers: { Accept: "application/json" },
    }),
    reserve: (sessionId, candidateId) => (
      mutate(DEV_APPLY_PATH, DEV_APPLY_SCHEMA, sessionId, candidateId)
    ),
    acknowledge: (sessionId, candidateId) => (
      mutate(DEV_ACK_PATH, DEV_ACK_SCHEMA, sessionId, candidateId)
    ),
    cancel: (sessionId, candidateId) => (
      mutate(DEV_CANCEL_PATH, DEV_CANCEL_SCHEMA, sessionId, candidateId)
    ),
  };
}
