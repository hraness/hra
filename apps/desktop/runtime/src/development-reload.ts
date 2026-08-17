import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

export const hostDevelopmentReloadCommand =
  "hra.runtime.developmentReload" as const;
export const runtimeBridgeProfileEnvironment =
  "HRA_RUNTIME_BRIDGE_PROFILE" as const;

const candidateIdSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const hostDevelopmentReloadPayloadSchema = z.object({
  version: z.literal(1),
  mode: z.literal("developmentReload"),
  candidateId: candidateIdSchema,
}).strict();

export const hostDevelopmentReloadDecisionSchema = z.object({
  kind: z.literal("developmentReloadDecision"),
  version: z.literal(1),
  status: z.enum(["accepted", "busy"]),
  candidateId: candidateIdSchema,
}).strict();

export type HostDevelopmentReloadPayload = z.infer<
  typeof hostDevelopmentReloadPayloadSchema
>;
export type HostDevelopmentReloadDecision = z.infer<
  typeof hostDevelopmentReloadDecisionSchema
>;

export function parseRuntimeBridgeProfile(
  environment: NodeJS.ProcessEnv = process.env,
): "production" | "development" | "automation" | null {
  return z.enum(["production", "development", "automation"])
    .safeParse(environment[runtimeBridgeProfileEnvironment]).data ?? null;
}

export function hostDevelopmentReloadDecision(
  payload: HostDevelopmentReloadPayload,
  status: "accepted" | "busy",
): HostDevelopmentReloadDecision {
  return hostDevelopmentReloadDecisionSchema.parse({
    kind: "developmentReloadDecision",
    version: 1,
    status,
    candidateId: payload.candidateId,
  });
}

const activeWorkCountSchema = z.object({
  count: z.number().int().nonnegative(),
});

/**
 * Reads only durable states that can own work or an external effect in this
 * gateway generation. Historical terminal ambiguity remains recoverable on a
 * clean generation boundary; live/prepared/reconciling rows do not.
 */
export function hasAuthoritativeDevelopmentReloadWork(
  database: Database,
): boolean {
  const row = activeWorkCountSchema.parse(database.query(`
    SELECT COUNT(*) AS count FROM (
      SELECT pane_id AS identity
      FROM chat_panes
      WHERE state IN ('starting', 'streaming', 'continuing')
         OR turn_status IN ('starting', 'streaming', 'continuing')
         OR workspace_state IN ('preparing', 'waiting_capacity')

      UNION ALL
      SELECT run_id
      FROM local_task_runs
      WHERE phase NOT IN ('submitted', 'failed', 'cancelled')

      UNION ALL
      SELECT run_id
      FROM dispatch_bindings
      WHERE stage IN (
        'reserved', 'worktree_ready', 'thread_starting', 'thread_ready',
        'turn_starting', 'running', 'waiting'
      )

      UNION ALL
      SELECT promotion_id
      FROM local_promotion_sessions
      WHERE state NOT IN ('activated', 'aborted')

      UNION ALL
      SELECT operation_id
      FROM session_sync_operation_journal
      WHERE state IN ('prepared', 'dispatched')

      UNION ALL
      SELECT attempt_id
      FROM local_renderer_mutation_attempts
      WHERE state != 'settled'

      UNION ALL
      SELECT operation_id
      FROM operation_receipts
      WHERE state = 'started'

      UNION ALL
      SELECT operation_id
      FROM human_organization_operations
      WHERE state = 'started'

      UNION ALL
      SELECT operation_id
      FROM cloud_human_operation_receipts
      WHERE state = 'started'

      UNION ALL
      SELECT turn_id
      FROM harness_actor_turns
      WHERE state IN ('prepared', 'starting', 'running', 'reconciling')

      UNION ALL
      SELECT operation_id
      FROM harness_actor_operations
      WHERE state IN ('prepared', 'effectStarted')

      UNION ALL
      SELECT incarnation_id
      FROM harness_actor_incarnations
      WHERE state IN ('starting', 'running')

      UNION ALL
      SELECT attempt_id
      FROM harness_actor_turn_attempts
      WHERE state IN ('starting', 'running', 'reconciling')

      UNION ALL
      SELECT run_id
      FROM harness_program_runs
      WHERE state IN ('prepared', 'running')

      UNION ALL
      SELECT receipt_id
      FROM harness_program_operation_receipts
      WHERE state IN ('prepared', 'effectStarted', 'replayRequired')

      UNION ALL
      SELECT value_id
      FROM harness_context_values
      WHERE state IN ('prepared', 'effectStarted', 'replayRequired')

      UNION ALL
      SELECT intent_id
      FROM harness_actor_continuation_intents
      WHERE state IN (
        'prepared', 'injectionEffectStarted', 'injected',
        'continueDispatchPrepared', 'continueDispatchEffectStarted'
      )
    )
  `).get());
  return row.count > 0;
}

/** A one-way admission seal. Busy probes reopen it; acceptance never does. */
export class DevelopmentReloadAdmission {
  #state: "open" | "probing" | "sealed" = "open";

  get sealed(): boolean {
    return this.#state !== "open";
  }

  get allowsOrdinaryRequests(): boolean {
    return this.#state === "open";
  }

  beginProbe(): boolean {
    if (this.#state !== "open") return false;
    this.#state = "probing";
    return true;
  }

  decideProbe(input: Readonly<{
    gatewayReady: boolean;
    ordinaryRequestsInFlight: number;
    inMemoryWorkActive?: boolean;
    database: Database | null;
  }>): "accepted" | "busy" {
    if (this.#state !== "probing") return "busy";
    const busy = !input.gatewayReady
      || input.ordinaryRequestsInFlight !== 0
      || input.inMemoryWorkActive === true
      || input.database === null
      || hasAuthoritativeDevelopmentReloadWork(input.database);
    this.#state = busy ? "open" : "sealed";
    return busy ? "busy" : "accepted";
  }

  trySeal(input: Readonly<{
    gatewayReady: boolean;
    ordinaryRequestsInFlight: number;
    inMemoryWorkActive?: boolean;
    database: Database | null;
  }>): "accepted" | "busy" {
    if (!this.beginProbe()) return "busy";
    return this.decideProbe(input);
  }
}
