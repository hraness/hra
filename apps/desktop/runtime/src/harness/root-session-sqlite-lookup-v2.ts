import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  chatTurnIdSchema,
} from "../../../contracts/runtime";
import type {
  SessionTurnLifecycle,
} from "../sessions/session-service";
import {
  deriveRootActorId,
  deriveRootActorTurnId,
  deriveRootEpochId,
  type HarnessRootActorAuthorityV2,
} from "./root-actor-authority-v2";
import type {
  HarnessRootSessionLookupV2,
} from "./root-session-lifecycle-v2";
import {
  HarnessSQLiteAuthorityV2,
} from "./sqlite-authority-v2";

const candidateSchema = z.object({
  pane_id: chatPaneIdSchema,
  active_turn_id: chatTurnIdSchema,
}).strict();

export class HarnessRootSessionSQLiteLookupV2Error extends Error {
  readonly code: "ambiguous_lineage" | "corrupt_lineage";

  constructor(
    code: HarnessRootSessionSQLiteLookupV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRootSessionSQLiteLookupV2Error";
    this.code = code;
  }
}

/**
 * Translates one current gateway lifecycle tuple through its ordinary chat
 * pane to the stable pane/chat-turn root. Raw restart identities are never
 * selected, and a prior continuation tuple stops resolving as soon as the
 * pane installs its next account session.
 */
export class HarnessRootSessionSQLiteLookupV2
implements HarnessRootSessionLookupV2 {
  readonly #database: Database;
  readonly #actors: HarnessSQLiteAuthorityV2;
  readonly #roots: HarnessRootActorAuthorityV2;

  constructor(
    database: Database,
    options: Readonly<{
      actors?: HarnessSQLiteAuthorityV2;
      roots: HarnessRootActorAuthorityV2;
    }>,
  ) {
    this.#database = database;
    this.#actors = options.actors ?? new HarnessSQLiteAuthorityV2(database);
    this.#roots = options.roots;
  }

  resolveCurrentRootTurn(event: SessionTurnLifecycle): Promise<unknown> {
    return Promise.resolve(this.#resolve(event));
  }

  #resolve(event: SessionTurnLifecycle): unknown {
    let candidates: readonly z.infer<typeof candidateSchema>[];
    try {
      const rows: unknown[] = this.#database.query(`
        SELECT pane_id, active_turn_id FROM chat_panes
        WHERE provider_account_profile_id = ?1
          AND provider_thread_id = ?2
          AND active_provider_turn_id = ?3
          AND interaction_mode = 'chat'
          AND state IN ('starting', 'streaming', 'continuing')
          AND turn_status IN ('starting', 'streaming', 'continuing')
        ORDER BY pane_id LIMIT 2
      `).all(event.accountProfileId, event.threadId, event.turnId);
      candidates = z.array(candidateSchema).max(2).parse(rows);
    } catch (cause: unknown) {
      throw new HarnessRootSessionSQLiteLookupV2Error(
        "corrupt_lineage",
        "root lifecycle pane lookup returned invalid state",
        cause,
      );
    }
    if (candidates.length === 0) return Object.freeze({ kind: "foreign" });
    if (candidates.length > 1) {
      const candidateRootTurnIds = candidates.map((candidate) =>
        this.#requireCandidateRootTurnId(candidate));
      if (new Set(candidateRootTurnIds).size !== candidateRootTurnIds.length) {
        throw new HarnessRootSessionSQLiteLookupV2Error(
          "ambiguous_lineage",
          "ambiguous gateway lifecycle candidates collapse to one root turn",
        );
      }
      return Object.freeze({
        kind: "ambiguous",
        accountProfileId: event.accountProfileId,
        providerThreadId: event.threadId,
        providerTurnId: event.turnId,
        candidateRootTurnIds: Object.freeze(candidateRootTurnIds),
      });
    }

    const candidate = candidates[0]!;
    const actor = this.#actors.readActorForPane(candidate.pane_id);
    if (
      actor === null || actor.parentActorId !== null || actor.depth !== 0 ||
      actor.state !== "active"
    ) return Object.freeze({ kind: "foreign" });
    const epoch = this.#actors.readActorEpoch(actor.epochId);
    if (
      epoch === null || epoch.state !== "active" ||
      epoch.rootActorId !== actor.id ||
      epoch.id !== deriveRootEpochId({
        projectId: epoch.projectId,
        sourceSha: epoch.sourceSha,
        paneId: candidate.pane_id,
      }) ||
      actor.id !== deriveRootActorId(epoch.id)
    ) return Object.freeze({ kind: "foreign" });
    const rootTurnId = deriveRootActorTurnId(epoch.id, candidate.active_turn_id);
    const root = this.#roots.readRootTurn(rootTurnId);
    if (
      root === null || root.actor.id !== actor.id ||
      root.paneBinding.paneId !== candidate.pane_id
    ) return Object.freeze({ kind: "foreign" });
    return Object.freeze({
      kind: "exact",
      accountProfileId: event.accountProfileId,
      paneId: candidate.pane_id,
      providerThreadId: event.threadId,
      providerTurnId: event.turnId,
      rootTurnId,
    });
  }

  #requireCandidateRootTurnId(
    candidate: z.infer<typeof candidateSchema>,
  ): string {
    const actor = this.#actors.readActorForPane(candidate.pane_id);
    if (actor === null || actor.parentActorId !== null) {
      throw new HarnessRootSessionSQLiteLookupV2Error(
        "ambiguous_lineage",
        "ambiguous gateway lifecycle candidate has no attached root actor",
      );
    }
    return deriveRootActorTurnId(actor.epochId, candidate.active_turn_id);
  }
}
