export const HRA_DEV_FRONTEND_HOST = "127.0.0.1";
export const HRA_DEV_FRONTEND_PORT = 5173;
export const HRA_DEV_FRONTEND_URL =
  `http://${HRA_DEV_FRONTEND_HOST}:${HRA_DEV_FRONTEND_PORT}/`;
export const HRA_DEV_READY_PATH = "/__hra_dev_ready";
export const HRA_DEV_READY_URL =
  `${HRA_DEV_FRONTEND_URL.slice(0, -1)}${HRA_DEV_READY_PATH}`;
export const HRA_DEV_READY_SCHEMA = "hra-vite-dev/v1";
export const HRA_DEV_SESSION_ENV = "HRA_DEV_SESSION_ID";

const RETIRED_SELF_EDIT_ENVIRONMENT = [
  "HRA_DEV_LOCAL_EXECUTION",
  "HRA_INTERNAL_DEV_SOURCE_ROOT",
] as const;

const SESSION_ID_BYTES = 32;
const SESSION_ID_LENGTH = SESSION_ID_BYTES * 2;
const MAX_READY_BODY_BYTES = 512;

export type DevSessionId = string & { readonly __devSessionId: unique symbol };

export interface DevReadinessEnvelope {
  readonly schema: typeof HRA_DEV_READY_SCHEMA;
  readonly sessionId: DevSessionId;
}

export interface DevReadinessHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}

export type DevLaunchPhase =
  | "checking-listener"
  | "starting-vite"
  | "building-native"
  | "waiting-for-readiness"
  | "starting-app"
  | "running"
  | "refused"
  | "stopping"
  | "stopped";

export type DevLaunchEvent =
  | "listener-clear"
  | "listener-reachable"
  | "vite-started"
  | "build-succeeded"
  | "readiness-matched"
  | "app-started"
  | "stop-requested"
  | "cleanup-complete";

export type DevProcessName = "app" | "build" | "vite";

export interface OwnedDevProcesses {
  readonly app: boolean;
  readonly build: boolean;
  readonly vite: boolean;
}

export function nativeDevFrontendEnvironment(
  sessionId: DevSessionId,
): Readonly<Record<
  | "NATIVE_SDK_FRONTEND_URL"
  | "NATIVE_SDK_HMR"
  | "NATIVE_SDK_MODE"
  | typeof HRA_DEV_SESSION_ENV,
  string
>> {
  return {
    NATIVE_SDK_FRONTEND_URL: HRA_DEV_FRONTEND_URL,
    NATIVE_SDK_HMR: "1",
    NATIVE_SDK_MODE: "dev",
    [HRA_DEV_SESSION_ENV]: sessionId,
  };
}

/**
 * Prevents retired self-edit markers from reaching any development child.
 * They no longer authorize anything, but scrubbing them closes the old launch
 * boundary instead of depending on every descendant to ignore stale values.
 */
export function scrubRetiredSelfEditEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const scrubbed = { ...environment };
  for (const name of RETIRED_SELF_EDIT_ENVIRONMENT) delete scrubbed[name];
  return scrubbed;
}

export function gatewayExecutableNameForNativeMode(
  mode: "dev" | "run",
): "oprte-gateway" | "oprte-gateway-dev" {
  return mode === "dev" ? "oprte-gateway-dev" : "oprte-gateway";
}

export function isCanonicalDevSessionId(value: unknown): value is DevSessionId {
  return typeof value === "string"
    && value.length === SESSION_ID_LENGTH
    && /^[0-9a-f]+$/u.test(value);
}

export function devSessionIdFromBytes(bytes: Uint8Array): DevSessionId {
  if (bytes.byteLength !== SESSION_ID_BYTES) {
    throw new Error(`A development session ID requires exactly ${SESSION_ID_BYTES} random bytes.`);
  }
  const sessionId = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!isCanonicalDevSessionId(sessionId)) {
    throw new Error("Could not encode a canonical development session ID.");
  }
  return sessionId;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function parseDevReadinessPayload(
  value: unknown,
  expectedSessionId: DevSessionId,
): DevReadinessEnvelope {
  if (!isPlainRecord(value)) {
    throw new Error("HRA Vite readiness must be a JSON object.");
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "schema" || keys[1] !== "sessionId") {
    throw new Error("HRA Vite readiness must contain exactly schema and sessionId.");
  }
  if (value.schema !== HRA_DEV_READY_SCHEMA) {
    throw new Error("HRA Vite readiness used an unsupported schema.");
  }
  if (!isCanonicalDevSessionId(value.sessionId)) {
    throw new Error("HRA Vite readiness contained an invalid session ID.");
  }
  if (value.sessionId !== expectedSessionId) {
    throw new Error("HRA Vite readiness belongs to a different launch session.");
  }
  return {
    schema: HRA_DEV_READY_SCHEMA,
    sessionId: value.sessionId,
  };
}

export function parseDevReadinessJson(
  text: string,
  expectedSessionId: DevSessionId,
): DevReadinessEnvelope {
  if (new TextEncoder().encode(text).byteLength > MAX_READY_BODY_BYTES) {
    throw new Error("HRA Vite readiness exceeded its size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("HRA Vite readiness was not valid JSON.");
  }
  return parseDevReadinessPayload(value, expectedSessionId);
}

export function parseDevReadinessResponse(
  response: DevReadinessHttpResponse,
  expectedSessionId: DevSessionId,
): DevReadinessEnvelope {
  if (response.status !== 200) {
    throw new Error(`HRA Vite readiness returned HTTP ${response.status}.`);
  }
  if (response.headers["content-type"] !== "application/json; charset=utf-8") {
    throw new Error("HRA Vite readiness returned an invalid content type.");
  }
  if (response.headers["cache-control"] !== "no-store") {
    throw new Error("HRA Vite readiness did not disable caching.");
  }
  if (response.headers["x-content-type-options"] !== "nosniff") {
    throw new Error("HRA Vite readiness did not disable content sniffing.");
  }
  return parseDevReadinessJson(response.body, expectedSessionId);
}

const transitionTable: Readonly<
  Partial<Record<DevLaunchPhase, Partial<Record<DevLaunchEvent, DevLaunchPhase>>>>
> = {
  "checking-listener": {
    "listener-clear": "starting-vite",
    "listener-reachable": "refused",
    "stop-requested": "stopping",
  },
  "starting-vite": {
    "vite-started": "building-native",
    "stop-requested": "stopping",
  },
  "building-native": {
    "build-succeeded": "waiting-for-readiness",
    "stop-requested": "stopping",
  },
  "waiting-for-readiness": {
    "readiness-matched": "starting-app",
    "stop-requested": "stopping",
  },
  "starting-app": {
    "app-started": "running",
    "stop-requested": "stopping",
  },
  running: { "stop-requested": "stopping" },
  refused: { "stop-requested": "stopping" },
  stopping: { "cleanup-complete": "stopped" },
};

export function advanceDevLaunch(
  phase: DevLaunchPhase,
  event: DevLaunchEvent,
): DevLaunchPhase {
  const next = transitionTable[phase]?.[event];
  if (next === undefined) {
    throw new Error(`Invalid HRA development launch transition: ${phase} + ${event}.`);
  }
  return next;
}

export function maySpawnDevApp(phase: DevLaunchPhase): boolean {
  return phase === "starting-app";
}

/**
 * Cleanup runs in reverse dependency order. A started process remains owned
 * even after its leader exits because a descendant may still hold the group.
 */
export function devCleanupOrder(processes: OwnedDevProcesses): readonly DevProcessName[] {
  return (["app", "build", "vite"] as const).filter((name) => processes[name]);
}
