import type {
  CodexAccountAvailability,
  CodexFactOrigin,
  CodexHydrationStatus,
  CodexItemSnapshot,
  CodexOperationOutcome,
  CodexRuntimeAvailability,
  CodexSessionOperation,
  CodexThreadStatus,
  CodexToolActivity,
  CodexTurnActivity,
  CodexTurnStatus,
} from "../codex";
import { createSessionEntityMap, type SessionEntityMap } from "./entity-map";
import { SESSION_RETENTION_POLICY } from "./retention-policy";

export const MAX_SESSION_ITEM_TEXT_UTF8_BYTES =
  SESSION_RETENTION_POLICY.maxDisplayBytesPerThread;

export interface SessionFactCursor {
  readonly factIndex: number;
  readonly generation: number;
  readonly streamPosition: number;
}

export interface SessionAccountState {
  readonly accountProfileId: string;
  readonly availability: CodexAccountAvailability;
  readonly runtime: CodexRuntimeAvailability;
}

export interface SessionThreadState {
  readonly accountProfileId: string;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly cwd: string;
  readonly id: string;
  readonly status: CodexThreadStatus;
  readonly title: string | null;
  readonly turnKeys: readonly string[];
  readonly updatedAt: string;
}

export interface SessionTurnState {
  readonly accountProfileId: string;
  readonly activity: CodexTurnActivity | null;
  readonly completedAt: string | null;
  readonly id: string;
  readonly itemKeys: readonly string[];
  readonly quotaProof?: "provider_usage_limit_exceeded";
  readonly startedAt: string | null;
  readonly status: CodexTurnStatus;
  readonly threadKey: string;
}

export interface SessionTextBuffer {
  readonly chunks: readonly string[];
  readonly complete: boolean;
  readonly deltaCount: number;
  readonly overflowed: boolean;
  readonly utf8Bytes: number;
}

export type SessionItemDisplay =
  | Readonly<{
      clientMessageId: string | null;
      kind: "user_text";
    }>
  | Readonly<{ kind: "assistant_text" }>
  | Readonly<{ kind: "reasoning_summary" }>
  | Readonly<{
      activity: CodexToolActivity;
      kind: "tool";
    }>
  | Readonly<{
      category: Extract<CodexItemSnapshot, { kind: "error" }>["category"];
      kind: "error";
    }>;

export interface SessionItemState {
  readonly accountProfileId: string;
  readonly display: SessionItemDisplay;
  readonly id: string;
  readonly status: "completed" | "failed" | "interrupted" | "streaming";
  readonly text: SessionTextBuffer | null;
  readonly threadKey: string;
  readonly turnKey: string;
}

export interface SessionInteractionState {
  readonly accountProfileId: string;
  readonly expiresAt: number;
  readonly id: string;
  readonly kind: "approval" | "user_input";
  readonly outcome: "answered" | "expired" | "pending" | "provider_resolved" | "rejected";
  readonly threadKey: string;
  readonly turnKey: string;
}

export interface SessionOperationState {
  readonly accountProfileId: string;
  readonly id: string;
  readonly operation: CodexSessionOperation;
  readonly outcome: CodexOperationOutcome;
  readonly threadKey: string | null;
}

export interface SessionHydrationState {
  readonly accountProfileId: string;
  readonly attempt: number;
  readonly origin: CodexFactOrigin;
  readonly status: CodexHydrationStatus;
  readonly threadKey: string | null;
}

export interface SessionThreadTombstone {
  readonly accountProfileId: string;
  readonly cursor: SessionFactCursor;
  readonly threadId: string;
}

export interface SessionState {
  readonly accounts: Readonly<Record<string, SessionAccountState>>;
  readonly cursors: Readonly<Record<string, SessionFactCursor>>;
  readonly hydration: Readonly<Record<string, SessionHydrationState>>;
  readonly interactions: Readonly<Record<string, SessionInteractionState>>;
  readonly items: SessionEntityMap<SessionItemState>;
  readonly operations: Readonly<Record<string, SessionOperationState>>;
  readonly retainedDisplayTextUtf8Bytes: number;
  readonly revision: number;
  readonly threadTombstones: Readonly<Record<string, SessionThreadTombstone>>;
  readonly threadDisplayTextUtf8Bytes: SessionEntityMap<number>;
  readonly threads: Readonly<Record<string, SessionThreadState>>;
  readonly turns: Readonly<Record<string, SessionTurnState>>;
  readonly version: 1;
}

const emptyRecord = Object.freeze({}) as Readonly<Record<string, never>>;

export function createSessionState(): SessionState {
  return {
    version: 1,
    revision: 0,
    accounts: emptyRecord,
    cursors: emptyRecord,
    hydration: emptyRecord,
    interactions: emptyRecord,
    items: createSessionEntityMap(),
    operations: emptyRecord,
    retainedDisplayTextUtf8Bytes: 0,
    threadTombstones: emptyRecord,
    threadDisplayTextUtf8Bytes: createSessionEntityMap(),
    threads: emptyRecord,
    turns: emptyRecord,
  };
}

/** Length-prefixing prevents delimiter and prototype-key collisions. */
export function sessionEntityKey(accountProfileId: string, providerId: string): string {
  return `${String(accountProfileId.length)}:${accountProfileId}${providerId}`;
}

export function sessionAccountKey(accountProfileId: string): string {
  return sessionEntityKey(accountProfileId, "");
}

export function emptySessionTextBuffer(): SessionTextBuffer {
  return {
    chunks: Object.freeze([]),
    complete: false,
    deltaCount: 0,
    overflowed: false,
    utf8Bytes: 0,
  };
}
