import {
  HRA_DEV_FRONTEND_URL,
  HRA_DEV_SESSION_ENV,
  isCanonicalDevSessionId,
  type DevSessionId,
} from "../dev-protocol.ts";

export const HRA_DEV_STATUS_PATH = "/__hra_dev_status";
export const HRA_DEV_APPLY_PATH = "/__hra_dev_apply";
export const HRA_DEV_ACK_PATH = "/__hra_dev_ack";
export const HRA_DEV_CANCEL_PATH = "/__hra_dev_cancel";
export const HRA_DEV_STATUS_EVENT = "hra:dev-status";
export const HRA_DEV_STATUS_SCHEMA = "hra-dev-status/v1";
export const HRA_DEV_APPLY_SCHEMA = "hra-dev-apply/v1";
export const HRA_DEV_ACK_SCHEMA = "hra-dev-ack/v1";
export const HRA_DEV_CANCEL_SCHEMA = "hra-dev-cancel/v1";
export const HRA_DEV_ERROR_SCHEMA = "hra-dev-error/v1";
export const HRA_DEV_FRONTEND_ORIGIN = new URL(HRA_DEV_FRONTEND_URL).origin;
export const MAX_DEV_CHANGE_COUNT = 999;
export const MAX_DEV_MUTATION_BODY_BYTES = 1_024;

const CANDIDATE_ID_LENGTH = 64;

export type DevCandidateId = string & {
  readonly __devCandidateId: unique symbol;
};

export type DevStatusAuthority = "launcher" | "uiOnly";
export type DevStatusState =
  | "current"
  | "building"
  | "staged"
  | "applying"
  | "restartRequired"
  | "failed";
export type DevStatusTarget = "none" | "gateway" | "native" | "launcher";

interface DevStatusCommon<Authority extends DevStatusAuthority> {
  readonly authority: Authority;
  readonly changeCount: number;
  readonly revision: number;
  readonly schema: typeof HRA_DEV_STATUS_SCHEMA;
  readonly sessionId: DevSessionId;
}

export type DevStatusEnvelope =
  | Readonly<DevStatusCommon<"uiOnly"> & {
    readonly candidateId: null;
    readonly changeCount: 0;
    readonly state: "current";
    readonly target: "none";
  }>
  | Readonly<DevStatusCommon<"launcher"> & {
    readonly candidateId: DevCandidateId | null;
    readonly changeCount: 0;
    readonly state: "current";
    readonly target: "none";
  }>
  | Readonly<DevStatusCommon<"launcher"> & {
    readonly candidateId: null;
    readonly state: "building" | "failed";
    readonly target: "gateway";
  }>
  | Readonly<DevStatusCommon<"launcher"> & {
    readonly candidateId: DevCandidateId;
    readonly state: "staged" | "applying";
    readonly target: "gateway";
  }>
  | Readonly<DevStatusCommon<"launcher"> & {
    readonly candidateId: null;
    readonly state: "restartRequired";
    readonly target: "native" | "launcher";
  }>;

export type DevMutationSchema =
  | typeof HRA_DEV_APPLY_SCHEMA
  | typeof HRA_DEV_ACK_SCHEMA
  | typeof HRA_DEV_CANCEL_SCHEMA;

export interface DevMutationEnvelope {
  readonly candidateId: DevCandidateId;
  readonly schema: DevMutationSchema;
  readonly sessionId: DevSessionId;
}

export type DevErrorCode =
  | "badRequest"
  | "bodyTooLarge"
  | "contentType"
  | "forbidden";

export interface DevErrorEnvelope {
  readonly code: DevErrorCode;
  readonly schema: typeof HRA_DEV_ERROR_SCHEMA;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isBoundedChangeCount(value: unknown, allowZero: boolean): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= (allowZero ? 0 : 1)
    && (value as number) <= MAX_DEV_CHANGE_COUNT;
}

function isStatusRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isDevCandidateId(value: unknown): value is DevCandidateId {
  return typeof value === "string"
    && value.length === CANDIDATE_ID_LENGTH
    && /^[0-9a-f]+$/u.test(value);
}

export function parseDevCandidateId(value: unknown): DevCandidateId {
  if (!isDevCandidateId(value)) {
    throw new Error("HRA development candidate ID must be a lowercase SHA-256 digest.");
  }
  return value;
}

export function createInitialDevStatus(
  sessionId: DevSessionId,
  authority: DevStatusAuthority,
): DevStatusEnvelope {
  return {
    schema: HRA_DEV_STATUS_SCHEMA,
    sessionId,
    authority,
    revision: 0,
    state: "current",
    target: "none",
    changeCount: 0,
    candidateId: null,
  };
}

export function parseDevStatusEnvelope(value: unknown): DevStatusEnvelope {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "authority",
    "candidateId",
    "changeCount",
    "revision",
    "schema",
    "sessionId",
    "state",
    "target",
  ])) {
    throw new Error("HRA development status must use the exact status envelope.");
  }
  if (value.schema !== HRA_DEV_STATUS_SCHEMA) {
    throw new Error("HRA development status used an unsupported schema.");
  }
  if (!isCanonicalDevSessionId(value.sessionId)) {
    throw new Error(`HRA development status requires a canonical ${HRA_DEV_SESSION_ENV}.`);
  }
  if (value.authority !== "launcher" && value.authority !== "uiOnly") {
    throw new Error("HRA development status used an invalid authority.");
  }
  if (!isStatusRevision(value.revision)) {
    throw new Error("HRA development status used an invalid revision.");
  }
  if (
    value.authority === "uiOnly"
    && (
      value.state !== "current"
      || value.target !== "none"
      || value.changeCount !== 0
      || value.candidateId !== null
      || value.revision !== 0
    )
  ) {
    throw new Error("HRA UI-only development status cannot claim launcher authority.");
  }

  const common = {
    schema: HRA_DEV_STATUS_SCHEMA,
    sessionId: value.sessionId,
    authority: value.authority,
    revision: value.revision,
  } as const;

  if (value.state === "current") {
    if (
      value.target !== "none"
      || value.changeCount !== 0
      || (value.candidateId !== null && !isDevCandidateId(value.candidateId))
      || (value.candidateId !== null && value.revision === 0)
    ) {
      throw new Error("HRA current development status was inconsistent.");
    }
    return value.authority === "uiOnly" ? {
      ...common,
      authority: "uiOnly",
      state: "current",
      target: "none",
      changeCount: 0,
      candidateId: null,
    } : {
      ...common,
      authority: "launcher",
      state: "current",
      target: "none",
      changeCount: 0,
      candidateId: value.candidateId,
    };
  }

  if (value.revision === 0) {
    throw new Error("HRA non-current development status requires a positive revision.");
  }

  if (value.state === "building" || value.state === "failed") {
    if (
      value.target !== "gateway"
      || value.candidateId !== null
      || !isBoundedChangeCount(value.changeCount, false)
    ) {
      throw new Error("HRA gateway development status was inconsistent.");
    }
    return {
      ...common,
      authority: "launcher",
      state: value.state,
      target: "gateway",
      changeCount: value.changeCount,
      candidateId: null,
    };
  }

  if (value.state === "staged" || value.state === "applying") {
    if (
      value.target !== "gateway"
      || !isDevCandidateId(value.candidateId)
      || !isBoundedChangeCount(value.changeCount, false)
    ) {
      throw new Error("HRA staged development status was inconsistent.");
    }
    return {
      ...common,
      authority: "launcher",
      state: value.state,
      target: "gateway",
      changeCount: value.changeCount,
      candidateId: value.candidateId,
    };
  }

  if (value.state === "restartRequired") {
    if (
      (value.target !== "native" && value.target !== "launcher")
      || value.candidateId !== null
      || !isBoundedChangeCount(value.changeCount, false)
    ) {
      throw new Error("HRA restart-required development status was inconsistent.");
    }
    return {
      ...common,
      authority: "launcher",
      state: "restartRequired",
      target: value.target,
      changeCount: value.changeCount,
      candidateId: null,
    };
  }

  throw new Error("HRA development status used an invalid state.");
}

export function parseDevStatusJson(text: string): DevStatusEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("HRA development status was not valid JSON.");
  }
  return parseDevStatusEnvelope(value);
}

export function parseDevMutationEnvelope(
  value: unknown,
  expectedSchema: DevMutationSchema,
): DevMutationEnvelope {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "candidateId",
    "schema",
    "sessionId",
  ])) {
    throw new Error("HRA development mutation must use the exact request envelope.");
  }
  if (value.schema !== expectedSchema) {
    throw new Error("HRA development mutation used an unsupported schema.");
  }
  if (!isCanonicalDevSessionId(value.sessionId)) {
    throw new Error("HRA development mutation used an invalid session ID.");
  }
  return {
    schema: expectedSchema,
    sessionId: value.sessionId,
    candidateId: parseDevCandidateId(value.candidateId),
  };
}

export function devErrorEnvelope(code: DevErrorCode): DevErrorEnvelope {
  return { schema: HRA_DEV_ERROR_SCHEMA, code };
}
