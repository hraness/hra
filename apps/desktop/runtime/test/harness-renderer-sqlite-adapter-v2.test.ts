import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { fc } from "@hra-internal/test";

import {
  actorEpochSchema,
  actorSchema,
  type Actor,
  type ActorEpoch,
} from "../src/harness/actor-domain";
import {
  HarnessRendererSQLiteAdapterV2,
} from "../src/harness/renderer-sqlite-adapter-v2";
import { HarnessSQLiteAuthorityV2 } from "../src/harness/sqlite-authority-v2";
import { applyMigrations } from "../src/state/database";
import { ChatPaneStore } from "../src/state/chat-pane-store";

const at = "2030-01-01T00:00:00.000Z";
const later = "2030-01-01T00:00:01.000Z";
const deadline = "2030-01-02T00:00:00.000Z";
const projectId = "project-renderer-sqlite-v2";
const repositoryId = `repo_${"7".repeat(26)}`;
const epochId = "hepoch_renderer_sqlite01";
const rootActorId = "hactor_renderer_root001";
const childActorId = "hactor_renderer_child01";
const sourceSha = "a".repeat(40);
const MIB = 1024 * 1024;
const PROPERTY_TIMEOUT = 30_000;

interface Fixture {
  readonly adapter: HarnessRendererSQLiteAdapterV2;
  readonly actors: HarnessSQLiteAuthorityV2;
  readonly chats: ChatPaneStore;
  readonly database: Database;
  readonly root: Actor;
  readonly child: Actor;
}

function budget() {
  return {
    maxDepth: 3,
    maxActiveDescendants: 8,
    maxDurableDescendants: 50,
    tokenBudget: 100_000,
    byteBudget: 16 * MIB,
    deadline,
    laneAuthority: "managedWrite" as const,
  };
}

function epochAndRoot(): { epoch: ActorEpoch; rootActor: Actor } {
  const actorBudget = budget();
  const epoch = actorEpochSchema.parse({
    id: epochId,
    projectId,
    sourceSha,
    rootActorId,
    budget: actorBudget,
    tokenReserved: 0,
    byteReserved: 0,
    nextRootCompletionSequence: 1,
    state: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  const rootActor = actorSchema.parse({
    id: rootActorId,
    epochId,
    parentActorId: null,
    depth: 0,
    title: "Root actor",
    state: "active",
    budget: actorBudget,
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: at,
    updatedAt: at,
    stoppedAt: null,
  });
  return { epoch, rootActor };
}

function childActor(parent: Actor): Actor {
  return actorSchema.parse({
    id: childActorId,
    epochId,
    parentActorId: parent.id,
    depth: 1,
    title: "Child actor",
    state: "active",
    budget: {
      ...parent.budget,
      tokenBudget: 20_000,
      byteBudget: 4 * MIB,
      laneAuthority: "readOnlySnapshot",
    },
    tokenReserved: 0,
    byteReserved: 0,
    nextTurnOrdinal: 1,
    nextResultOrdinal: 1,
    revision: 1,
    createdAt: later,
    updatedAt: later,
    stoppedAt: null,
  });
}

function fixture(): Fixture {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO projects (
      project_id, canonical_repository_path, canonical_git_common_dir,
      display_name, created_at, updated_at
    ) VALUES (?1, '/tmp/renderer-sqlite', '/tmp/renderer-sqlite/.git',
      'Renderer SQLite', ?2, ?2)
  `).run(projectId, at);

  const actors = new HarnessSQLiteAuthorityV2(database, {
    now: () => new Date(later),
  });
  const { epoch, rootActor } = epochAndRoot();
  const root = actors.createActorEpoch({ epoch, rootActor }).rootActor;
  const child = actors.createChildActor(childActor(root));
  const chats = new ChatPaneStore(database);
  chats.create({
    paneId: "pane_renderer_parent01",
    repository: {
      id: repositoryId,
      name: "Renderer SQLite",
      workingDirectory: "/tmp/renderer-sqlite",
    },
    accountProfileId: null,
    now: new Date(at),
  });
  actors.attachActorPane({
    bindingId: "hpanebinding_root00001",
    actorId: root.id,
    paneId: "pane_renderer_parent01",
    attachedAt: at,
  });
  return {
    adapter: new HarnessRendererSQLiteAdapterV2(database, {
      actors,
      now: () => new Date(later),
    }),
    actors,
    chats,
    database,
    root,
    child,
  };
}

function insertContextValue(
  value: Fixture,
  input: Readonly<{
    valueId: string;
    actorId?: string;
    purpose: "actorTask" | "proposal";
    sourceTurnId?: string | null;
    marker: string;
  }>,
): void {
  const digest = input.marker.repeat(64);
  value.database.query(`
    INSERT INTO harness_context_values (
      value_id, operation_id, epoch_id, owner_actor_id, source_turn_id,
      kind, purpose, schema_version, name_digest, utf8_bytes,
      content_digest, chunk_size, chunk_count, manifest_digest,
      manifest_byte_length, quota_limit_bytes, state, recovery_reason,
      revision, created_at, updated_at, effect_started_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, 1,
      ?8, 65536, 1, ?8, 1, 16777216, 'active', NULL,
      3, ?9, ?9, ?9, ?9
    )
  `).run(
    input.valueId,
    `contextop_${input.valueId}`,
    epochId,
    input.actorId ?? value.child.id,
    input.sourceTurnId ?? null,
    input.purpose === "proposal" ? "json" : "text",
    input.purpose,
    digest,
    at,
  );
  value.database.query(`
    INSERT INTO harness_context_value_chunks (
      value_id, ordinal, plaintext_bytes, object_digest, object_byte_length
    ) VALUES (?1, 0, 1, ?2, 1)
  `).run(input.valueId, digest);
}

function createChildTurn(value: Fixture): void {
  insertContextValue(value, {
    valueId: "ctxval_renderer_task001",
    purpose: "actorTask",
    marker: "b",
  });
  value.actors.createActorTurn({
    turnId: "hturn_renderer_child001",
    epochId,
    actorId: value.child.id,
    idempotencyKey: "renderer-idempotency-0001", // gitleaks:allow - deterministic test vector
    inputValueId: "ctxval_renderer_task001",
    createdAt: at,
  });
}

function insertProposal(
  value: Fixture,
  input: Readonly<{
    id: string;
    revision: number;
    marker: string;
    state?: "active" | "prepared" | "recoveryRequired";
  }>,
): void {
  if (value.adapter.readLatestActorTurnForActor(value.child.id) === null) {
    createChildTurn(value);
  }
  const valueId = `ctxval_proposal_${input.marker.repeat(8)}`;
  insertContextValue(value, {
    valueId,
    purpose: "proposal",
    sourceTurnId: "hturn_renderer_child001",
    marker: input.marker,
  });
  value.database.query(`
    INSERT INTO harness_proposals (
      proposal_id, epoch_id, actor_id, source_turn_id, operation_id,
      title, body_value_id, body_digest, state, recovery_reason,
      revision, created_at, updated_at, activated_at
    ) VALUES (
      ?1, ?2, ?3, 'hturn_renderer_child001', ?4,
      ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12
    )
  `).run(
    input.id,
    epochId,
    value.child.id,
    `proposal_operation_${input.marker.repeat(4)}`,
    `Proposal ${input.marker}`,
    valueId,
    input.marker.repeat(64),
    input.state ?? "active",
    input.state === "recoveryRequired" ? "proposal_recovery_required" : null,
    input.revision,
    at,
    (input.state ?? "active") === "active" ? at : null,
  );
}

function childProjection(openedPaneId: string | null) {
  return {
    id: childActorId,
    title: "Child actor",
    state: "starting" as const,
    openedPaneId,
    canOpen: false,
    canMessage: false,
    canStop: true,
  };
}

describe("HarnessRendererSQLiteAdapterV2", () => {
  test("constructs against the migrated projection-witness authority", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    expect(() => new HarnessRendererSQLiteAdapterV2(database)).not.toThrow();
    database.close();
  });

  test("keeps the retired Fast setting column inert across settings CAS", () => {
    const database = new Database(":memory:", { strict: true });
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    const adapter = new HarnessRendererSQLiteAdapterV2(database);

    expect(adapter.read()).toMatchObject({
      harnessRevision: 1,
      settings: {
        revision: 1,
      },
    });
    expect(adapter.update({
      expectedHarnessRevision: 1,
      expectedSettingsRevision: 1,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 64 * MIB,
      refinementMode: "off",
    })).toMatchObject({
      harnessRevision: 2,
      settings: {
        revision: 2,
      },
    });
    expect(database.query(`
      SELECT automatic_fast_mode FROM harness_settings WHERE singleton = 1
    `).get()).toEqual({ automatic_fast_mode: "criticalPath" });
    database.close();
  });

  test("derives the global revision and commits settings through exact CAS", () => {
    const value = fixture();
    insertProposal(value, {
      id: "hproposal_renderer_alpha01",
      revision: 3,
      marker: "c",
    });
    insertProposal(value, {
      id: "hproposal_renderer_beta001",
      revision: 5,
      marker: "d",
    });

    expect(value.adapter.read()).toEqual({
      settings: {
        revision: 1,
        recursiveSessionsEnabled: false,
        contextQuotaBytes: 64 * MIB,
        refinementMode: "off",
      },
      harnessRevision: 9,
    });
    expect(value.adapter.update({
      expectedHarnessRevision: 9,
      expectedSettingsRevision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "suggest",
    })).toEqual({
      settings: {
        revision: 2,
        recursiveSessionsEnabled: true,
        contextQuotaBytes: 8 * MIB,
        refinementMode: "suggest",
      },
      harnessRevision: 10,
    });
    expect(() => value.adapter.update({
      expectedHarnessRevision: 9,
      expectedSettingsRevision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "suggest",
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    value.database.close();
  });

  test("keeps Suggest enabled across the prepared proposal publication window", () => {
    const value = fixture();
    const enabled = value.adapter.update({
      expectedHarnessRevision: 1,
      expectedSettingsRevision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "suggest",
    });
    insertProposal(value, {
      id: "hproposal_renderer_pending01",
      revision: 1,
      marker: "8",
      state: "prepared",
    });

    expect(() => value.adapter.update({
      expectedHarnessRevision: enabled.harnessRevision,
      expectedSettingsRevision: enabled.settings.revision,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "off",
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(value.adapter.read().settings.refinementMode).toBe("suggest");

    value.database.query(`
      UPDATE harness_proposals SET
        state = 'recoveryRequired',
        recovery_reason = 'proposal_recovery_required',
        revision = revision + 1,
        updated_at = ?2
      WHERE proposal_id = ?1 AND state = 'prepared'
    `).run("hproposal_renderer_pending01", later);
    const recovered = value.adapter.read();
    expect(value.adapter.update({
      expectedHarnessRevision: recovered.harnessRevision,
      expectedSettingsRevision: recovered.settings.revision,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "off",
    }).settings.refinementMode).toBe("off");
    value.database.close();
  });

  test("allows Off after proposal activation while preserving the immutable proposal", () => {
    const value = fixture();
    value.adapter.update({
      expectedHarnessRevision: 1,
      expectedSettingsRevision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "suggest",
    });
    insertProposal(value, {
      id: "hproposal_renderer_active01",
      revision: 2,
      marker: "7",
      state: "active",
    });
    const before = value.adapter.read();

    const disabled = value.adapter.update({
      expectedHarnessRevision: before.harnessRevision,
      expectedSettingsRevision: before.settings.revision,
      recursiveSessionsEnabled: false,
      contextQuotaBytes: 8 * MIB,
      refinementMode: "off",
    });
    expect(disabled.settings.refinementMode).toBe("off");
    expect(value.adapter.list({ afterProposalId: null, limit: 32 }))
      .toEqual([{
        id: "hproposal_renderer_active01",
        revision: 2,
        title: "Proposal 7",
      }]);
    value.database.close();
  });

  test("pages only sorted renderer-safe identities and reads actor evidence", () => {
    const value = fixture();
    const archived = value.chats.create({
      paneId: "pane_renderer_archived01",
      repository: {
        id: repositoryId,
        name: "Renderer SQLite",
        workingDirectory: "/tmp/renderer-sqlite",
      },
      accountProfileId: null,
      now: new Date(later),
    });
    value.chats.remove(
      archived.id,
      archived.revision,
      new Date("2030-01-01T00:00:02.000Z"),
    );
    value.chats.create({
      paneId: "pane_renderer_child001",
      repository: {
        id: repositoryId,
        name: "Renderer SQLite",
        workingDirectory: "/tmp/renderer-sqlite",
      },
      accountProfileId: null,
      now: new Date(later),
    });
    value.actors.attachActorPane({
      bindingId: "hpanebinding_child0001",
      actorId: value.child.id,
      paneId: "pane_renderer_child001",
      attachedAt: later,
    });
    createChildTurn(value);
    insertProposal(value, {
      id: "hproposal_renderer_beta001",
      revision: 2,
      marker: "e",
    });
    insertProposal(value, {
      id: "hproposal_renderer_alpha01",
      revision: 1,
      marker: "f",
    });

    expect(value.adapter.listPaneIds({ afterPaneId: null, limit: 1 }))
      .toEqual(["pane_renderer_child001"]);
    expect(value.adapter.listPaneIds({
      afterPaneId: "pane_renderer_child001",
      limit: 2,
    })).toEqual(["pane_renderer_parent01"]);
    expect(value.adapter.list({ afterProposalId: null, limit: 1 }))
      .toEqual([{
        id: "hproposal_renderer_alpha01",
        revision: 1,
        title: "Proposal f",
      }]);
    expect(value.adapter.list({
      afterProposalId: "hproposal_renderer_alpha01",
      limit: 2,
    })).toEqual([{
      id: "hproposal_renderer_beta001",
      revision: 2,
      title: "Proposal e",
    }]);
    expect(value.adapter.readActorForPane("pane_renderer_parent01")?.id)
      .toBe(value.root.id);
    expect(value.adapter.listActorChildren({
      parentActorId: value.root.id,
      afterActorId: null,
      limit: 16,
    }).map(({ id }) => id)).toEqual([value.child.id]);
    expect(value.adapter.readPaneBindingForActor(value.child.id)?.paneId)
      .toBe("pane_renderer_child001");
    expect(value.adapter.readLatestActorTurnForActor(value.child.id)?.id)
      .toBe("hturn_renderer_child001");
    value.database.close();
  });

  test("advances a semantic witness exactly once and accepts one-step replay", () => {
    const value = fixture();
    expect(value.adapter.writeProjectionWitness({
      actorId: value.child.id,
      expectedRevision: null,
      projection: childProjection(null),
    })).toMatchObject({ actorId: value.child.id, revision: 1 });
    expect(value.adapter.writeProjectionWitness({
      actorId: value.child.id,
      expectedRevision: 1,
      projection: childProjection(null),
    }).revision).toBe(1);

    value.chats.create({
      paneId: "pane_renderer_child001",
      repository: {
        id: repositoryId,
        name: "Renderer SQLite",
        workingDirectory: "/tmp/renderer-sqlite",
      },
      accountProfileId: null,
      now: new Date(later),
    });
    value.actors.attachActorPane({
      bindingId: "hpanebinding_child0001",
      actorId: value.child.id,
      paneId: "pane_renderer_child001",
      attachedAt: later,
    });
    const advanced = value.adapter.writeProjectionWitness({
      actorId: value.child.id,
      expectedRevision: 1,
      projection: childProjection("pane_renderer_child001"),
    });
    expect(advanced.revision).toBe(2);
    expect(value.adapter.writeProjectionWitness({
      actorId: value.child.id,
      expectedRevision: 1,
      projection: childProjection("pane_renderer_child001"),
    })).toEqual(advanced);
    expect(() => value.adapter.writeProjectionWitness({
      actorId: value.child.id,
      expectedRevision: 3,
      projection: childProjection("pane_renderer_child001"),
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
    expect(value.adapter.readProjectionWitness(value.child.id)).toEqual(advanced);
    value.database.close();
  });

  test("synchronizes the canonical semantic witness transactionally and idempotently", () => {
    const value = fixture();
    expect(value.adapter.listActorIds({ afterActorId: null, limit: 1 }))
      .toEqual([value.child.id]);
    expect(value.adapter.listActorIds({
      afterActorId: value.child.id,
      limit: 2,
    })).toEqual([value.root.id]);

    const created = value.adapter.synchronizeProjectionWitness(value.child.id);
    expect(created).toMatchObject({ actorId: value.child.id, revision: 1 });
    expect(value.adapter.synchronizeProjectionWitness(value.child.id))
      .toEqual(created);

    value.chats.create({
      paneId: "pane_renderer_child001",
      repository: {
        id: repositoryId,
        name: "Renderer SQLite",
        workingDirectory: "/tmp/renderer-sqlite",
      },
      accountProfileId: null,
      now: new Date(later),
    });
    value.actors.attachActorPane({
      bindingId: "hpanebinding_child0001",
      actorId: value.child.id,
      paneId: "pane_renderer_child001",
      attachedAt: later,
    });
    const advanced = value.adapter.synchronizeProjectionWitness(value.child.id);
    expect(advanced).toMatchObject({ actorId: value.child.id, revision: 2 });
    expect(advanced.semanticDigest).not.toBe(created.semanticDigest);
    expect(value.adapter.synchronizeProjectionWitness(value.child.id))
      .toEqual(advanced);
    expect(() => value.adapter.synchronizeProjectionWitness(
      "hactor_renderer_missing01",
    )).toThrow(expect.objectContaining({ code: "not_found" }));
    value.database.close();
  });

  test("rejects a witness that does not match the durable actor projection", () => {
    const value = fixture();
    expect(() => value.adapter.writeProjectionWitness({
      actorId: value.child.id,
      expectedRevision: null,
      projection: { ...childProjection(null), state: "idle" },
    })).toThrow(expect.objectContaining({ code: "corrupt_state" }));
    expect(value.adapter.readProjectionWitness(value.child.id)).toBeNull();
    value.database.close();
  });

  test("fails closed on stored corruption and revision overflow", () => {
    const value = fixture();
    value.database.query(
      "UPDATE harness_settings SET updated_at = 'not-a-time' WHERE singleton = 1",
    ).run();
    expect(() => value.adapter.read()).toThrow(
      expect.objectContaining({ code: "corrupt_state" }),
    );
    value.database.query(
      "UPDATE harness_settings SET updated_at = ?1, revision = ?2 WHERE singleton = 1",
    ).run(at, Number.MAX_SAFE_INTEGER);
    insertProposal(value, {
      id: "hproposal_renderer_alpha01",
      revision: 1,
      marker: "9",
    });
    expect(() => value.adapter.read()).toThrow(
      expect.objectContaining({ code: "corrupt_state" }),
    );
    value.database.close();
  });

  test("semantic witness revision equals one plus actual semantic changes", () => {
    fc.assert(fc.property(
      fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
      (states) => {
        const value = fixture();
        value.chats.create({
          paneId: "pane_renderer_child001",
          repository: {
            id: repositoryId,
            name: "Renderer SQLite",
            workingDirectory: "/tmp/renderer-sqlite",
          },
          accountProfileId: null,
          now: new Date(later),
        });
        let opened = false;
        let revision = value.adapter.writeProjectionWitness({
          actorId: value.child.id,
          expectedRevision: null,
          projection: childProjection(null),
        }).revision;
        let bindingOrdinal = 0;
        for (const nextOpened of states) {
          if (nextOpened !== opened) {
            if (nextOpened) {
              bindingOrdinal += 1;
              value.actors.attachActorPane({
                bindingId: `hpanebinding_property${String(bindingOrdinal).padStart(4, "0")}`,
                actorId: value.child.id,
                paneId: "pane_renderer_child001",
                attachedAt: later,
              });
            } else {
              const binding = value.actors.readPaneBindingForActor(value.child.id);
              if (binding === null) throw new Error("property binding disappeared");
              value.actors.detachActorPane({
                bindingId: binding.id,
                expectedRevision: binding.revision,
                detachedAt: later,
              });
            }
          }
          const expected = revision;
          const next = value.adapter.writeProjectionWitness({
            actorId: value.child.id,
            expectedRevision: expected,
            projection: childProjection(
              nextOpened ? "pane_renderer_child001" : null,
            ),
          });
          expect(next.revision).toBe(
            nextOpened === opened ? revision : revision + 1,
          );
          revision = next.revision;
          opened = nextOpened;
        }
        value.database.close();
      },
    ), { numRuns: 30 });
  }, PROPERTY_TIMEOUT);
});
