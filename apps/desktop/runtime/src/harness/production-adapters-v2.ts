import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import type { AccountRuntimeRouter } from "../accounts/runtime-router";
import type { ControlPlaneLifetimeLock } from "../state/control-plane-lock";
import type {
  PersistentActorMutationFencePort,
  PersistentActorWorkspaceLookupPort,
} from "./codex-persistent-actor-provider";

const accountProfileIdSchema = z.string().min(1).max(96);
const actorIdSchema = z.string().min(16).max(96)
  .regex(/^hactor_[A-Za-z0-9_-]+$/u);
const laneIdSchema = z.string().min(1).max(128)
  .refine((value) => !value.includes("\0"), "lane identity contains NUL");
const effectKeySchema = z.string().regex(/^[a-f0-9]{64}$/u);
const absolutePathSchema = z.string().min(1).max(4_096).startsWith("/");

const workspaceRowSchema = z.object({
  lane_id: laneIdSchema,
  canonical_checkout_path: absolutePathSchema,
  mode: z.enum(["managed_worktree", "harness_read_only_snapshot"]),
  status: z.literal("ready"),
  binding_state: z.literal("active").optional(),
}).strict();

export class HarnessProductionAdapterV2Error extends Error {
  readonly code: "authority_conflict" | "not_found";

  constructor(
    code: HarnessProductionAdapterV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessProductionAdapterV2Error";
    this.code = code;
  }
}

/**
 * Content-free lookup for the exact lane already admitted by the actor
 * workspace coordinator. It cannot resolve arbitrary paths supplied by a
 * model or renderer.
 */
export class HarnessActorWorkspaceLookupV2
  implements PersistentActorWorkspaceLookupPort {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  resolveLane(laneIdValue: string): Promise<Readonly<{
    checkoutPath: string;
    authority: "readOnlySnapshot" | "managedWrite";
  }>> {
    const laneId = laneIdSchema.parse(laneIdValue);
    const rows: unknown[] = this.#database.query(`
      SELECT lane_id, canonical_checkout_path, mode, status
      FROM workspace_leases
      WHERE lane_id = ?1 AND status = 'ready'
      LIMIT 2
    `).all(laneId);
    if (rows.length === 0) notFound("actor workspace lane is unavailable");
    if (rows.length !== 1) conflict("actor workspace lane is ambiguous");
    const row = parseWorkspace(rows[0]);
    return Promise.resolve(projectWorkspace(row));
  }

  resolveActor(actorIdValue: string): Promise<Readonly<{
    checkoutPath: string;
    authority: "readOnlySnapshot" | "managedWrite";
  }>> {
    const actorId = actorIdSchema.parse(actorIdValue);
    const rows: unknown[] = this.#database.query(`
      SELECT lease.lane_id, lease.canonical_checkout_path,
        lease.mode, lease.status, binding.state AS binding_state
      FROM harness_actor_workspace_bindings AS binding
      JOIN workspace_leases AS lease ON lease.lane_id = binding.lane_id
      WHERE binding.actor_id = ?1 AND binding.state = 'active'
        AND lease.status = 'ready'
      ORDER BY binding.binding_id
      LIMIT 2
    `).all(actorId);
    if (rows.length === 0) notFound("actor has no ready workspace binding");
    if (rows.length !== 1) conflict("actor has multiple active workspace bindings");
    const row = parseWorkspace(rows[0]);
    if (row.binding_state !== "active") {
      conflict("actor workspace binding is not active");
    }
    return Promise.resolve(projectWorkspace(row));
  }
}

/**
 * Converts existing process invariants into the exact negative-observation
 * fence required by Codex reconciliation. The live runtime must be a stable
 * successor to the generation that admitted the external mutation: the same
 * generation can still be completing a request whose response was lost. A
 * released lifetime lock, absent successor, or generation change while the
 * evidence is read keeps the outcome pending instead of permitting a retry.
 */
export class HarnessActorMutationFenceV2
  implements PersistentActorMutationFencePort {
  readonly #runtimes: Pick<AccountRuntimeRouter, "generation" | "isRunning">;
  readonly #lifetimeLock: ControlPlaneLifetimeLock;

  constructor(input: Readonly<{
    runtimes: Pick<AccountRuntimeRouter, "generation" | "isRunning">;
    lifetimeLock: ControlPlaneLifetimeLock;
  }>) {
    this.#runtimes = input.runtimes;
    this.#lifetimeLock = input.lifetimeLock;
  }

  read(inputValue: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    effectKey: string;
  }>): Promise<Readonly<{
    previousGenerationTerminated: boolean;
    exclusiveMutationLease: boolean;
    externalDeletionExcluded: boolean;
  }>> {
    const input = z.object({
      accountProfileId: accountProfileIdSchema,
      processGeneration: z.number().int().positive().safe(),
      effectKey: effectKeySchema,
    }).strict().parse(inputValue);
    let lockHeld = false;
    try {
      this.#lifetimeLock.bindControlPlane();
      lockHeld = true;
    } catch {
      lockHeld = false;
    }
    const successorGeneration = lockHeld
      ? this.#runtimes.generation(input.accountProfileId)
      : null;
    const successorFenced = successorGeneration !== null &&
      successorGeneration > input.processGeneration &&
      this.#runtimes.isRunning(input.accountProfileId) &&
      this.#runtimes.generation(input.accountProfileId) === successorGeneration;
    return Promise.resolve(Object.freeze({
      previousGenerationTerminated: successorFenced,
      exclusiveMutationLease: successorFenced,
      externalDeletionExcluded: successorFenced,
    }));
  }
}

function parseWorkspace(value: unknown): z.infer<typeof workspaceRowSchema> {
  try {
    return workspaceRowSchema.parse(value);
  } catch (cause: unknown) {
    throw new HarnessProductionAdapterV2Error(
      "authority_conflict",
      "stored actor workspace authority is invalid",
      cause,
    );
  }
}

function projectWorkspace(row: z.infer<typeof workspaceRowSchema>): Readonly<{
  checkoutPath: string;
  authority: "readOnlySnapshot" | "managedWrite";
}> {
  return Object.freeze({
    checkoutPath: row.canonical_checkout_path,
    authority: row.mode === "harness_read_only_snapshot"
      ? "readOnlySnapshot"
      : "managedWrite",
  });
}

function notFound(message: string): never {
  throw new HarnessProductionAdapterV2Error("not_found", message);
}

function conflict(message: string): never {
  throw new HarnessProductionAdapterV2Error("authority_conflict", message);
}
