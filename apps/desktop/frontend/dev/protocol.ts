import type { NativeSdkJson } from "@native-sdk/cli";

import { isCanonicalDevSessionId } from "../../runtime/dev-protocol";
import {
  HRA_DEV_ACK_PATH,
  HRA_DEV_ACK_SCHEMA,
  HRA_DEV_APPLY_PATH,
  HRA_DEV_APPLY_SCHEMA,
  HRA_DEV_CANCEL_PATH,
  HRA_DEV_CANCEL_SCHEMA,
  HRA_DEV_STATUS_EVENT,
  HRA_DEV_STATUS_PATH,
  HRA_DEV_STATUS_SCHEMA,
  MAX_DEV_MUTATION_BODY_BYTES,
  isDevCandidateId,
  parseDevCandidateId,
  parseDevStatusEnvelope,
  type DevMutationSchema,
  type DevStatusEnvelope,
  type DevStatusState,
  type DevStatusTarget,
} from "../../runtime/dev/status-protocol";

export {
  HRA_DEV_ACK_PATH as DEV_ACK_PATH,
  HRA_DEV_ACK_SCHEMA as DEV_ACK_SCHEMA,
  HRA_DEV_APPLY_PATH as DEV_APPLY_PATH,
  HRA_DEV_APPLY_SCHEMA as DEV_APPLY_SCHEMA,
  HRA_DEV_CANCEL_PATH as DEV_CANCEL_PATH,
  HRA_DEV_CANCEL_SCHEMA as DEV_CANCEL_SCHEMA,
  HRA_DEV_STATUS_EVENT as DEV_STATUS_EVENT,
  HRA_DEV_STATUS_PATH as DEV_STATUS_PATH,
  HRA_DEV_STATUS_SCHEMA as DEV_STATUS_SCHEMA,
  isDevCandidateId as isCandidateId,
  parseDevCandidateId,
  parseDevStatusEnvelope,
  type DevStatusEnvelope,
  type DevStatusState,
  type DevStatusTarget,
};

export const DEVELOPMENT_RELOAD_COMMAND = "hra.runtime.retryTransport" as const;
export const DEV_RESPONSE_BYTE_LIMIT = 4_096;

export interface DevelopmentReloadRequest {
  readonly version: 1;
  readonly mode: "developmentReload";
  readonly candidateId: string;
}

export type DevelopmentReloadResponse =
  | {
      readonly version: 1;
      readonly mode: "developmentReload";
      readonly status: "accepted";
      readonly candidateId: string;
      readonly currentGeneration: number;
      readonly nextGeneration: number;
    }
  | {
      readonly version: 1;
      readonly mode: "developmentReload";
      readonly status: "busy" | "unavailable";
      readonly candidateId: string;
      readonly currentGeneration: number;
      readonly nextGeneration: null;
    };

export type AcceptedDevelopmentReloadResponse = Extract<
  DevelopmentReloadResponse,
  { readonly status: "accepted" }
>;

export class DevelopmentReloadAcceptedUnconfirmedError extends Error {
  readonly response: AcceptedDevelopmentReloadResponse;
  override readonly cause: unknown;

  constructor(response: AcceptedDevelopmentReloadResponse, cause: unknown) {
    super("Native accepted the development runtime, but readiness could not be confirmed.", {
      cause,
    });
    this.name = "DevelopmentReloadAcceptedUnconfirmedError";
    this.response = response;
    this.cause = cause;
  }
}

export class DevelopmentReloadOutcomeUnconfirmedError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Native did not return a definitive development reload outcome.", {
      cause,
    });
    this.name = "DevelopmentReloadOutcomeUnconfirmedError";
    this.cause = cause;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (
    Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
  );
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function developmentReloadRequest(candidateId: string): DevelopmentReloadRequest {
  return { version: 1, mode: "developmentReload", candidateId: parseDevCandidateId(candidateId) };
}

export function developmentReloadRequestJson(candidateId: string): NativeSdkJson {
  return { ...developmentReloadRequest(candidateId) };
}

export function parseDevelopmentReloadResponse(value: unknown): DevelopmentReloadResponse {
  if (!isRecord(value) || !hasExactKeys(value, [
    "version",
    "mode",
    "status",
    "candidateId",
    "currentGeneration",
    "nextGeneration",
  ])) throw new Error("The development reload response is malformed.");
  if (
    value.version !== 1 ||
    value.mode !== "developmentReload" ||
    !isDevCandidateId(value.candidateId) ||
    !isSafePositive(value.currentGeneration)
  ) throw new Error("The development reload response is malformed.");
  if (
    value.status === "accepted" &&
    isSafePositive(value.nextGeneration) &&
    value.nextGeneration === value.currentGeneration + 1
  ) return value as unknown as DevelopmentReloadResponse;
  if (
    (value.status === "busy" || value.status === "unavailable") &&
    value.nextGeneration === null
  ) return value as unknown as DevelopmentReloadResponse;
  throw new Error("The development reload response is malformed.");
}

export function candidateMutationBody(
  schema: DevMutationSchema,
  sessionId: string,
  candidateId: string,
): string {
  if (!isCanonicalDevSessionId(sessionId)) {
    throw new Error("The development session is malformed.");
  }
  const body = JSON.stringify({
    schema,
    sessionId,
    candidateId: parseDevCandidateId(candidateId),
  });
  if (new TextEncoder().encode(body).byteLength > MAX_DEV_MUTATION_BODY_BYTES) {
    throw new Error("The development mutation is too large.");
  }
  return body;
}
