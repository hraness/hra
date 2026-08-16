import type { PortableSystemCommand } from "@hraness/agent-tasks-protocol";
import { createHash } from "node:crypto";

import type {
  LocalTaskDueWork,
  LocalTaskDueWorkCurrentAuthority,
  LocalTaskDueWorkHandlerContext,
  LocalTaskDueWorkHandlerResult,
  LocalTaskDueWorkHandlers,
  LocalTaskDueWorkStaleAuthority,
} from "./reconciler";

const crockfordAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const defaultQueuedRunRetryMs = 1_000;

export type LocalTaskDueWorkPreparation =
  | Readonly<{
      kind: "current";
      authority: LocalTaskDueWorkCurrentAuthority;
      /**
       * Null is valid only for queued_run while its Phase 4 executor is absent.
       */
      command: PortableSystemCommand | null;
    }>
  | Readonly<{
      kind: "stale";
      authority: LocalTaskDueWorkStaleAuthority;
    }>;

export type LocalTaskSystemCommandOutcome =
  | Readonly<{
      kind: "committed";
      /**
       * The same transaction must have completed the durable due-work row.
       */
      authority: LocalTaskDueWorkCurrentAuthority;
    }>
  | Readonly<{
      kind: "obsolete";
      authority: LocalTaskDueWorkStaleAuthority;
    }>
  | Readonly<{
      kind: "retry";
      authority: LocalTaskDueWorkCurrentAuthority;
      errorCode: string;
      retryAfterMs?: number | undefined;
    }>;

/**
 * SQLite-backed implementations resolve entity-specific command fields during
 * preparation, then revalidate them again in the command transaction. A
 * committed transaction owns due-row completion along with the domain mutation
 * and portable events, so the outer reconciler must not settle it a second time.
 */
export interface LocalTaskAuthorityCommandPort {
  prepareDueWork(input: Readonly<{
    work: LocalTaskDueWork;
    bootGeneration: number;
    now: number;
    operationId: string;
  }>): LocalTaskDueWorkPreparation | Promise<LocalTaskDueWorkPreparation>;
  executeSystemCommand(input: Readonly<{
    work: LocalTaskDueWork;
    command: PortableSystemCommand;
    authority: LocalTaskDueWorkCurrentAuthority;
    now: number;
  }>): LocalTaskSystemCommandOutcome | Promise<LocalTaskSystemCommandOutcome>;
}

export interface LocalTaskHandlerAdapterOptions {
  readonly authorityCommands: LocalTaskAuthorityCommandPort;
  readonly queuedRuns?: LocalQueuedRunExecutorPort;
  readonly queuedRunRetryMs?: number;
}

export interface LocalQueuedRunExecutorPort {
  start(input: Readonly<{
    authority: LocalTaskDueWorkCurrentAuthority;
    context: LocalTaskDueWorkHandlerContext;
    work: LocalTaskDueWork;
  }>): LocalTaskDueWorkHandlerResult | Promise<LocalTaskDueWorkHandlerResult>;
}

/**
 * Builds the production handler table. All current Phase 3 system work is
 * delegated to an atomic authority/command port. queued_run is intentionally
 * left pending until the Phase 4 executor can claim and start it under a fence.
 */
export function createLocalTaskDueWorkHandlers(
  options: LocalTaskHandlerAdapterOptions,
): LocalTaskDueWorkHandlers {
  const queuedRunRetryMs = positiveInteger(
    options.queuedRunRetryMs ?? defaultQueuedRunRetryMs,
    "queued-run retry interval",
  );

  const prepare = async (
    work: LocalTaskDueWork,
    context: LocalTaskDueWorkHandlerContext,
  ): Promise<LocalTaskDueWorkPreparation> =>
    await options.authorityCommands.prepareDueWork({
      work,
      bootGeneration: context.bootGeneration,
      now: context.wallNow,
      operationId: localDueWorkOperationId(work, context.bootGeneration),
    });

  const system = async (
    work: LocalTaskDueWork,
    context: LocalTaskDueWorkHandlerContext,
  ): Promise<LocalTaskDueWorkHandlerResult> => {
    const prepared = await prepare(work, context);
    if (prepared.kind === "stale") {
      return { outcome: "obsolete", authority: prepared.authority };
    }
    const authorityMismatch = stalePreparedAuthority(
      prepared.authority,
      work,
      context,
    );
    if (authorityMismatch !== null) {
      return { outcome: "obsolete", authority: authorityMismatch };
    }
    if (prepared.command === null) {
      throw new Error("System due work did not prepare a command");
    }
    if (work.kind === "queued_run") {
      throw new Error("Queued run reached the system-command handler");
    }
    const expectedKind = systemCommandKind(work.kind);
    if (
      prepared.command.kind !== expectedKind ||
      !commandMatchesWork(prepared.command, work, context)
    ) {
      throw new Error("System command did not match durable due work");
    }
    const outcome = await options.authorityCommands.executeSystemCommand({
      work,
      command: prepared.command,
      authority: prepared.authority,
      now: context.wallNow,
    });
    switch (outcome.kind) {
      case "committed":
        return { outcome: "settled", authority: outcome.authority };
      case "obsolete":
        return { outcome: "obsolete", authority: outcome.authority };
      case "retry":
        return {
          outcome: "retry",
          authority: outcome.authority,
          errorCode: outcome.errorCode,
          ...(outcome.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: outcome.retryAfterMs }),
        };
    }
  };

  const queuedRun = async (
    work: LocalTaskDueWork,
    context: LocalTaskDueWorkHandlerContext,
  ): Promise<LocalTaskDueWorkHandlerResult> => {
    const prepared = await prepare(work, context);
    if (prepared.kind === "stale") {
      return { outcome: "obsolete", authority: prepared.authority };
    }
    const authorityMismatch = stalePreparedAuthority(
      prepared.authority,
      work,
      context,
    );
    if (authorityMismatch !== null) {
      return { outcome: "obsolete", authority: authorityMismatch };
    }
    if (prepared.command !== null) {
      throw new Error("Queued run preparation must not start a system command");
    }
    if (options.queuedRuns !== undefined) {
      return await options.queuedRuns.start({
        authority: prepared.authority,
        context,
        work,
      });
    }
    return {
      outcome: "retry",
      authority: prepared.authority,
      errorCode: "executor_unavailable",
      retryAfterMs: queuedRunRetryMs,
    };
  };

  return {
    deferWake: system,
    startQueuedRun: queuedRun,
    expireClaim: system,
    recoverStartedRun: system,
    expireInteraction: system,
    repair: system,
  };
}

export function localDueWorkOperationId(
  work: LocalTaskDueWork,
  bootGeneration: number,
): string {
  const digest = createHash("sha256")
    .update([
      work.id,
      work.workspaceId,
      work.kind,
      work.entityId,
      String(work.dueAt),
      String(work.expectedRevision),
      String(work.expectedFence),
      String(bootGeneration),
    ].join("\0"))
    .digest();
  let value = 0n;
  for (const byte of digest.subarray(0, 16)) {
    value = (value << 8n) | BigInt(byte);
  }
  let locator = "";
  for (let index = 0; index < 26; index += 1) {
    locator = (crockfordAlphabet[Number(value & 31n)] ?? "0") + locator;
    value >>= 5n;
  }
  return `op_${locator}`;
}

function systemCommandKind(
  kind: Exclude<LocalTaskDueWork["kind"], "queued_run">,
): PortableSystemCommand["kind"] {
  switch (kind) {
    case "defer_wake":
      return "defer.wake";
    case "claim_expiry":
      return "claim.expire";
    case "run_recovery":
      return "run.reconcile";
    case "interaction_expiry":
      return "interaction.expire";
    case "repair":
      return "workspace.repair";
  }
}

function stalePreparedAuthority(
  authority: LocalTaskDueWorkCurrentAuthority,
  work: LocalTaskDueWork,
  context: LocalTaskDueWorkHandlerContext,
): LocalTaskDueWorkStaleAuthority | null {
  if (authority.bootGeneration !== context.bootGeneration) {
    return { kind: "stale", reason: "boot" };
  }
  if (authority.deadlineCheckedAt < work.dueAt) {
    return { kind: "stale", reason: "deadline" };
  }
  if (authority.revision !== work.expectedRevision) {
    return { kind: "stale", reason: "revision" };
  }
  if (authority.fence !== work.expectedFence) {
    return { kind: "stale", reason: "fence" };
  }
  return null;
}

function commandMatchesWork(
  command: PortableSystemCommand,
  work: LocalTaskDueWork,
  context: LocalTaskDueWorkHandlerContext,
): boolean {
  if (
    command.operationId !== localDueWorkOperationId(work, context.bootGeneration) ||
    command.workspaceId !== work.workspaceId
  ) {
    return false;
  }
  switch (command.kind) {
    case "defer.wake":
      return work.kind === "defer_wake" &&
        command.taskId === work.entityId &&
        command.expectedTaskRevision === work.expectedRevision &&
        command.scheduledFor === work.dueAt;
    case "claim.expire":
      return work.kind === "claim_expiry" &&
        command.claimId === work.entityId &&
        command.fence === work.expectedFence &&
        command.leaseGeneration === work.expectedRevision &&
        command.expectedDeadline === work.dueAt;
    case "run.reconcile":
      return work.kind === "run_recovery" &&
        command.runId === work.entityId &&
        command.bootGeneration === context.bootGeneration;
    case "interaction.expire":
      return work.kind === "interaction_expiry" &&
        command.interactionId === work.entityId &&
        command.expectedDeadline === work.dueAt;
    case "workspace.repair":
      return work.kind === "repair" &&
        command.expectedWorkspaceRevision === work.expectedRevision;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}
