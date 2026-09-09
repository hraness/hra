import { Cause, Option } from "effect";

import type { ClaudeFact } from "./assembler.ts";
import type { ClaudeProcess } from "./process.ts";

/** Every rejected foreign value is represented, including undefined and false. */
export type ClaudeTaskFailure = Readonly<{ _tag: "ClaudeFailure"; reason: unknown }>;

export const taskFailure = (reason: unknown): ClaudeTaskFailure => ({ _tag: "ClaudeFailure", reason });

export function failureReason(cause: Cause.Cause<ClaudeTaskFailure>): unknown {
  const failure = Cause.failureOption(cause);
  if (Option.isSome(failure)) return failure.value.reason;
  const defect = Cause.dieOption(cause);
  return Option.isSome(defect) ? defect.value : Cause.squash(cause);
}

export type TaskGroup = "admission" | "writes" | "stdout" | "stderr" | "exit-watch"
  | "facts" | "manager-continuations" | "capabilities" | "control";

export const taskGroups: readonly TaskGroup[] = [
  "admission", "writes", "stdout", "stderr", "exit-watch", "facts",
  "manager-continuations", "capabilities", "control",
];

export interface ClaudeNativeObservation {
  readonly promise: Promise<unknown>;
}

export type ClaudeInteractionDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "answer"; answers: Readonly<Record<string, string>> }>
  | Readonly<{ kind: "deny"; message: string }>;

export interface ClaudeStreamClientOptions {
  readonly process: ClaudeProcess;
  /** Absolute reviewed logical home that owns this process. Fences every write. */
  readonly configDir: string;
  /**
   * May await fact handling, but not this client's cleanup. Schedule cleanup
   * under a separate owner after the callback returns.
   */
  readonly onFact: (fact: ClaudeFact) => void | Promise<void>;
  readonly onSafeDiagnostic?: (message: string) => void;
  readonly maxJsonLineBytes?: number;
  readonly shutdownTermGraceMs?: number;
  readonly shutdownSettlementMs?: number;
  readonly now?: () => number;
}

export type ClaudeStreamInitialization = Readonly<{
  providerSessionId: string;
  model: string;
  permissionMode: string;
  claudeVersion: string;
}>;

