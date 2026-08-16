const MAXIMUM_SESSION_RESPONSE_BYTES = 32_768;
const SESSION_PATH = "/api/suite-auth/session";
const REFRESH_PATH = "/api/suite-auth/refresh";
const SIGN_OUT_PATH = "/api/suite-auth/sign-out";

export const SUITE_OIDC_REFRESH_LOCK_NAME =
  "hra-suite-accounts:oidc-refresh:v1";
export const SUITE_OIDC_SESSION_CHANNEL_NAME =
  "hra-suite-accounts:oidc-session:v1";

const SIGNED_OUT_EVENT = Object.freeze({
  kind: "signed_out",
  version: "suite-oidc-session-event-v1",
});

type SuiteOidcFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type SuiteOidcExclusiveLock = (
  name: string,
  task: () => Promise<unknown>,
) => Promise<unknown>;

export type SuiteOidcBrowserSessionDependencies = Readonly<{
  fetch?: SuiteOidcFetch;
  withExclusiveLock?: SuiteOidcExclusiveLock | null;
}>;

export type SuiteOidcBrowserSignOutDependencies =
  SuiteOidcBrowserSessionDependencies & Readonly<{
    notifySignedOut?: () => void;
  }>;

let localRefresh: Promise<unknown> | null = null;

function isExactRefreshRequired(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Reflect.get(value, "kind") === "refresh_required";
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" || response.body === null) {
    throw new Error("The suite session response was not JSON.");
  }

  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null
    && (
      !/^(?:0|[1-9]\d*)$/u.test(declaredLength)
      || Number(declaredLength) > MAXIMUM_SESSION_RESPONSE_BYTES
    )
  ) {
    await response.body.cancel().catch(() => undefined);
    throw new Error("The suite session response was too large.");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAXIMUM_SESSION_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("The suite session response was too large.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as unknown;
}

async function requestJson(
  fetcher: SuiteOidcFetch,
  path: typeof REFRESH_PATH | typeof SESSION_PATH | typeof SIGN_OUT_PATH,
  method: "GET" | "POST",
): Promise<unknown> {
  const response = await fetcher(path, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
    method,
    redirect: "error",
  });
  const value = await readBoundedJson(response);
  if (!response.ok) {
    throw new Error("The suite session request failed.");
  }
  return value;
}

function exactSignedOut(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && Reflect.get(value, "kind") === "signed_out";
}

/** Notify every open tab on this exact product origin that custody ended. */
export function broadcastSuiteOidcBrowserSignOut(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(SUITE_OIDC_SESSION_CHANNEL_NAME);
  try {
    channel.postMessage(SIGNED_OUT_EVENT);
  } finally {
    channel.close();
  }
}

/** Subscribe to the bounded cross-tab suite-session event. */
export function subscribeSuiteOidcBrowserSignOut(
  listener: () => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") return () => undefined;
  const channel = new BroadcastChannel(SUITE_OIDC_SESSION_CHANNEL_NAME);
  const onMessage = (event: MessageEvent<unknown>): void => {
    const value = event.data;
    if (
      typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && Object.keys(value).length === 2
      && Reflect.get(value, "kind") === SIGNED_OUT_EVENT.kind
      && Reflect.get(value, "version") === SIGNED_OUT_EVENT.version
    ) {
      listener();
    }
  };
  channel.addEventListener("message", onMessage);
  return () => {
    channel.removeEventListener("message", onMessage);
    channel.close();
  };
}

async function withLocalRefreshLock(
  task: () => Promise<unknown>,
): Promise<unknown> {
  if (localRefresh !== null) return await localRefresh;
  const pending = task();
  localRefresh = pending;
  try {
    return await pending;
  } finally {
    if (localRefresh === pending) localRefresh = null;
  }
}

async function withRefreshLock(
  task: () => Promise<unknown>,
  injectedLock: SuiteOidcExclusiveLock | null | undefined,
): Promise<unknown> {
  if (injectedLock !== undefined) {
    return injectedLock === null
      ? await withLocalRefreshLock(task)
      : await injectedLock(SUITE_OIDC_REFRESH_LOCK_NAME, task);
  }
  if (typeof navigator !== "undefined" && navigator.locks !== undefined) {
    return await navigator.locks.request(
      SUITE_OIDC_REFRESH_LOCK_NAME,
      { mode: "exclusive" },
      task,
    );
  }
  return await withLocalRefreshLock(task);
}

/**
 * Reads the product's same-origin suite session and refreshes it when needed.
 *
 * Web Locks serialize refresh-token rotation across tabs on the current
 * product origin. The session is re-read after acquiring the lock so a waiter
 * observes the cookie rotated by the preceding tab instead of replaying the
 * old refresh token.
 */
export async function loadSuiteOidcBrowserSession(
  dependencies: SuiteOidcBrowserSessionDependencies = {},
): Promise<unknown> {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const current = await requestJson(fetcher, SESSION_PATH, "GET");
  if (!isExactRefreshRequired(current)) return current;

  return await withRefreshLock(async () => {
    const latest = await requestJson(fetcher, SESSION_PATH, "GET");
    return isExactRefreshRequired(latest)
      ? await requestJson(fetcher, REFRESH_PATH, "POST")
      : latest;
  }, dependencies.withExclusiveLock);
}

/**
 * End the sealed relying-party session inside the same exclusive section used
 * for refresh-token rotation, then notify sibling tabs only after the server
 * confirms that local cookie custody ended.
 */
export async function signOutSuiteOidcBrowserSession(
  dependencies: SuiteOidcBrowserSignOutDependencies = {},
): Promise<void> {
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  await withRefreshLock(async () => {
    const value = await requestJson(fetcher, SIGN_OUT_PATH, "POST");
    if (!exactSignedOut(value)) {
      throw new Error("The suite sign-out response was invalid.");
    }
  }, dependencies.withExclusiveLock);
  (dependencies.notifySignedOut ?? broadcastSuiteOidcBrowserSignOut)();
}
