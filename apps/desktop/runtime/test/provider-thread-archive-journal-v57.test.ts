import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { applyMigrations } from "../src/state/database";
import { ChatPaneStore } from "../src/state/chat-pane-store";
import {
  type AddProviderThreadArchiveCutMemberV57,
  PROVIDER_THREAD_ARCHIVE_MAX_ACTIVE_TARGETS_V57,
  PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57,
  PROVIDER_THREAD_ARCHIVE_MAX_CUTS_PER_ACCOUNT_V57,
  PROVIDER_THREAD_ARCHIVE_MAX_MEMBERS_PER_CUT_V57,
  ProviderThreadArchiveJournalV57,
  providerThreadArchiveAccountTombstonePreimageDigestV57,
  providerThreadArchiveCompleteInventoryDigestV57,
} from "../src/state/provider-thread-archive-journal-v57";
import { migrations } from "../src/state/migrations";

const ACCOUNT = "acct_archivejournal01";
const PANE = "pane_archivejournal01";
const SIBLING_PANE = "pane_archivejournal02";
const REPOSITORY = `repo_${"7".repeat(26)}`;
const NOW = new Date("2026-08-18T12:00:00.000Z");
const KEY = new Uint8Array(32).fill(57);
const WRONG_KEY = new Uint8Array(32).fill(58);
const THREAD = "thread_archivejournal01";
const RESTART = "restart_archivejournal01";
const BINDING = "attbinding_archivejournal01";
const SIBLING_BINDING = "attbinding_archivejournal02";
const TARGET = "archtarget_archivejournal01";
const ATTEMPT = "archattempt_archivejournal01";
const CUT = "archcut_archivejournal01";
const MEMBER = "archmember_archivejournal01";

test("migration 57 appends four keyed archive authority relations without rewriting v56", () => {
  const migration = migrations.find(({ version }) => version === 57);
  expect(migration?.name).toBe("keyed-provider-thread-archive-containment-journal");
  expect(migrations.find(({ version }) => version === 56)?.name)
    .toBe("durable-provider-thread-archive-intent");
  withFixture(({ database }) => {
    const tables = database.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'chat_provider_thread_archive_%_v57'
      ORDER BY name
    `).all();
    expect(tables).toEqual([
      { name: "chat_provider_thread_archive_attempts_v57" },
      { name: "chat_provider_thread_archive_cut_members_v57" },
      { name: "chat_provider_thread_archive_cuts_v57" },
      { name: "chat_provider_thread_archive_targets_v57" },
    ]);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_intents
    `).get()).toEqual({ count: 0 });
  });
});

test("canonical inventory ordering is locale-independent for mixed-case ids", () => {
  const member = (
    memberId: string,
    paneId: string,
  ): AddProviderThreadArchiveCutMemberV57 => ({
    memberId,
    cutId: "archcut_localejournal01",
    paneId,
    paneRevision: 1,
    paneCasDigest: digest("1"),
    threadId: "thread_localejournal01",
    restartThreadId: "restart_localejournal01",
    role: "sibling",
    targetId: null,
    attemptId: null,
    targetAttemptOrdinal: null,
    action: "detach_binding_only",
    binding: { kind: "none" },
    identityEvidenceDigest: digest("2"),
    identityRevisionDigest: digest("3"),
    now: NOW,
  });
  const upper = member("archmember_ALocale0001", "pane_ALocale0001");
  const lower = member("archmember_aLocale0001", "pane_aLocale0001");
  const expected = "72363c308e98bf382d12b9555123c2a68ebe21f5b54cb058c0893f31045dbbf4";
  expect(providerThreadArchiveCompleteInventoryDigestV57([lower, upper]))
    .toBe(expected);
  expect(providerThreadArchiveCompleteInventoryDigestV57([upper, lower]))
    .toBe(expected);
});

test("direct applied transition commits and deletes only after exact keyed evidence", () => {
  withFixture(({ database, journal }) => {
    expect(journal.prepareTarget(targetInput())).toMatchObject({
      targetId: TARGET,
      status: "open",
      currentAttempt: { attemptId: ATTEMPT, ordinal: 1, generation: 1, state: "prepared" },
    });
    expect(journal.prepareTarget(targetInput()).attempts).toHaveLength(1);
    expect(() => journal.prepareTarget({
      ...targetInput(),
      attempt: { ...targetInput().attempt, requestRevisionDigest: digest("f") },
    })).toThrow("identity was already used");
    expect(journal.admissionDescriptor(TARGET)).toMatchObject({
      accountProfileId: ACCOUNT,
      attemptOrdinal: 1,
      expectedGeneration: 1,
      paneId: PANE,
      purpose: "pane_archive",
      transitionId: TARGET,
      cutAuthority: null,
    });
    journal.markEffectStarted({
      attemptId: ATTEMPT,
      effectEvidenceDigest: digest("1"),
      effectRevisionDigest: digest("2"),
      now: at(1),
    });
    expect(() => journal.recordDirectApplied({
      attemptId: ATTEMPT,
      responseGeneration: 2,
      responseStreamPosition: 1,
      outcomeEvidenceDigest: digest("3"),
      outcomeRevisionDigest: digest("4"),
      now: at(2),
    })).toThrow("incoherent");
    journal.recordDirectApplied({
      attemptId: ATTEMPT,
      responseGeneration: 1,
      responseStreamPosition: 9,
      outcomeEvidenceDigest: digest("3"),
      outcomeRevisionDigest: digest("4"),
      now: at(2),
    });
    expect(() => database.query(`
      DELETE FROM chat_provider_thread_archive_targets_v57 WHERE target_id = ?1
    `).run(TARGET)).toThrow("open provider thread archive target");
    journal.markTargetCommitted({
      targetId: TARGET,
      commitEvidenceDigest: digest("5"),
      commitRevisionDigest: digest("6"),
      now: at(3),
    });
    expect(() => journal.admissionDescriptor(TARGET)).toThrow("needs no admission hold");
    journal.deleteCommittedTargetSafely(TARGET);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_targets_v57
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_attempts_v57
    `).get()).toEqual({ count: 0 });
  });
});

test("ambiguous transition seals canonical members, settles last, and reconciles applied", () => {
  withFixture(({ database, journal }) => {
    prepareEffect(journal);
    journal.createCut(cutInput());
    journal.bindAttemptToCut(ATTEMPT, CUT);
    journal.recordAmbiguous({
      attemptId: ATTEMPT,
      ambiguityEvidenceDigest: digest("7"),
      ambiguityRevisionDigest: digest("8"),
      now: at(3),
    });
    expect(journal.recoveryInventory().admissionDescriptors[0]).toMatchObject({
      attemptOrdinal: 1,
      expectedGeneration: 1,
      cutAuthority: { revision: 1 },
    });
    const successorProfileRevision = advanceAccountGeneration(database, 2);
    journal.recordFence({
      cutId: CUT,
      successorGeneration: 2,
      successorAccountProfileRevision: successorProfileRevision,
      fenceEvidenceDigest: digest("9"),
      fenceRevisionDigest: digest("a"),
      now: at(4),
    });
    journal.addCutMember(memberInput());
    journal.addCutMember({
      ...memberInput(),
      memberId: "archmember_archivejournal02",
      paneId: SIBLING_PANE,
      threadId: "thread_archivejournal02",
      restartThreadId: "restart_archivejournal02",
      role: "sibling",
      targetId: null,
      attemptId: null,
      targetAttemptOrdinal: null,
      action: "detach_binding_only",
      binding: {
        kind: "exact",
        bindingId: SIBLING_BINDING,
        bindingKeyDigest: digest("a"),
        bindingRevision: 1,
      },
      identityEvidenceDigest: digest("b"),
    });
    const sealed = sealInventory(journal, CUT, [
      memberInput(),
      {
        ...memberInput(),
        memberId: "archmember_archivejournal02",
        paneId: SIBLING_PANE,
        threadId: "thread_archivejournal02",
        restartThreadId: "restart_archivejournal02",
        role: "sibling",
        targetId: null,
        attemptId: null,
        targetAttemptOrdinal: null,
        action: "detach_binding_only",
        binding: {
          kind: "exact",
          bindingId: SIBLING_BINDING,
          bindingKeyDigest: digest("a"),
          bindingRevision: 1,
        },
        identityEvidenceDigest: digest("b"),
      },
    ], digest("c"), at(5));
    expect(sealed).toMatchObject({ state: "sealed", members: [{ state: "pending" }, { state: "pending" }] });
    expect(() => journal.markCutContained({
      cutId: CUT,
      containmentEvidenceDigest: digest("d"),
      containmentRevisionDigest: digest("e"),
      now: at(6),
    })).toThrow("unsettled");
    settle(journal, MEMBER, 6);
    settle(journal, "archmember_archivejournal02", 7);
    journal.markCutContained({
      cutId: CUT,
      containmentEvidenceDigest: digest("d"),
      containmentRevisionDigest: digest("e"),
      now: at(8),
    });
    journal.recordReconciledApplied({
      attemptId: ATTEMPT,
      responseGeneration: 2,
      responseStreamPosition: 11,
      outcomeEvidenceDigest: digest("f"),
      outcomeRevisionDigest: digest("0"),
      now: at(9),
    });
    expect(journal.reopenTarget(TARGET).currentAttempt.state).toBe("reconciled_applied");
    journal.markTargetCommitted({
      targetId: TARGET,
      commitEvidenceDigest: digest("1"),
      commitRevisionDigest: digest("2"),
      now: at(10),
    });
    journal.deleteCommittedTargetSafely(TARGET);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_cuts_v57
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_cut_members_v57
    `).get()).toEqual({ count: 0 });
  });
});

test("committed target cleanup follows cut topology across backdated and reversed identities", () => {
  withFixture(({ database, journal }) => {
    const cuts = [
      {
        cutId: "archcut_cleanup_topology_m01",
        memberId: "archmember_cleanup_topology01",
        attemptId: ATTEMPT,
        generation: 1,
        ordinal: 1,
        createdAt: at(30),
      },
      {
        cutId: "archcut_cleanup_topology_z02",
        memberId: "archmember_cleanup_topology02",
        attemptId: "archattempt_cleanup_topology02",
        generation: 2,
        ordinal: 2,
        createdAt: at(5),
      },
      {
        cutId: "archcut_cleanup_topology_a03",
        memberId: "archmember_cleanup_topology03",
        attemptId: "archattempt_cleanup_topology03",
        generation: 3,
        ordinal: 3,
        createdAt: at(5),
      },
    ] as const;
    journal.prepareTarget(targetInput());
    let accountProfileRevision = 1;
    let predecessorCutId: string | null = null;
    for (const [index, cut] of cuts.entries()) {
      journal.markEffectStarted({
        attemptId: cut.attemptId,
        effectEvidenceDigest: digest("1"),
        effectRevisionDigest: digest("2"),
        now: at(40 + index * 10),
      });
      journal.createCut({
        ...cutInput(),
        cutId: cut.cutId,
        accountProfileRevision,
        sourceGeneration: cut.generation,
        initiatingAttemptId: cut.attemptId,
        predecessorCutId,
        now: cut.createdAt,
      });
      journal.bindAttemptToCut(cut.attemptId, cut.cutId);
      journal.recordAmbiguous({
        attemptId: cut.attemptId,
        ambiguityEvidenceDigest: digest("3"),
        ambiguityRevisionDigest: digest("4"),
        now: at(41 + index * 10),
      });
      const successorProfileRevision = advanceAccountGeneration(
        database,
        cut.generation + 1,
      );
      journal.recordFence({
        cutId: cut.cutId,
        successorGeneration: cut.generation + 1,
        successorAccountProfileRevision: successorProfileRevision,
        fenceEvidenceDigest: digest("5"),
        fenceRevisionDigest: digest("6"),
        now: at(42 + index * 10),
      });
      const member = {
        ...memberInput(),
        memberId: cut.memberId,
        cutId: cut.cutId,
        attemptId: cut.attemptId,
        targetAttemptOrdinal: cut.ordinal,
        now: at(43 + index * 10),
      };
      journal.addCutMember(member);
      sealInventory(
        journal,
        cut.cutId,
        [member],
        digest("7"),
        at(44 + index * 10),
      );
      settle(journal, cut.memberId, 45 + index * 10);
      journal.markCutContained({
        cutId: cut.cutId,
        containmentEvidenceDigest: digest("8"),
        containmentRevisionDigest: digest("9"),
        now: at(46 + index * 10),
      });
      if (index === cuts.length - 1) {
        journal.recordReconciledApplied({
          attemptId: cut.attemptId,
          responseGeneration: cut.generation + 1,
          responseStreamPosition: 1,
          outcomeEvidenceDigest: digest("a"),
          outcomeRevisionDigest: digest("b"),
          now: at(47 + index * 10),
        });
      } else {
        journal.recordReconciledNotApplied({
          attemptId: cut.attemptId,
          outcomeEvidenceDigest: digest("a"),
          outcomeRevisionDigest: digest("b"),
          now: at(47 + index * 10),
        });
        const successor = cuts[index + 1]!;
        journal.appendSuccessorAttempt({
          targetId: TARGET,
          attemptId: successor.attemptId,
          generation: successor.generation,
          accountProfileRevision: successorProfileRevision,
          requestEvidenceDigest: digest("c"),
          requestRevisionDigest: digest("d"),
          now: at(48 + index * 10),
        });
      }
      accountProfileRevision = successorProfileRevision;
      predecessorCutId = cut.cutId;
    }
    journal.markTargetCommitted({
      targetId: TARGET,
      commitEvidenceDigest: digest("e"),
      commitRevisionDigest: digest("f"),
      now: at(80),
    });

    database.exec(`
      CREATE TEMP TRIGGER fail_topological_archive_cleanup
      BEFORE DELETE ON chat_provider_thread_archive_cuts_v57
      WHEN OLD.cut_id = 'archcut_cleanup_topology_z02'
      BEGIN
        SELECT RAISE(ABORT, 'injected topological cleanup failure');
      END;
    `);
    expect(() => journal.deleteCommittedTargetSafely(TARGET))
      .toThrow("injected topological cleanup failure");
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
    `).get()).toEqual({ targets: 1, attempts: 3, cuts: 3, members: 3 });

    database.exec("DROP TRIGGER fail_topological_archive_cleanup");
    journal.deleteCommittedTargetSafely(TARGET);
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
    `).get()).toEqual({ targets: 0, attempts: 0, cuts: 0, members: 0 });
  });
});

test("shared cut cleanup revisits complete predecessors in either target deletion order", () => {
  const runOrder = (order: readonly string[]): void => {
    withFixture(({ database, journal }) => {
      const rootCutId = "archcut_sharedcleanup_root01";
      const leafCutId = "archcut_sharedcleanup_leaf02";
      const successorAttemptId = "archattempt_sharedcleanup_a02";
      prepareEffect(journal);
      journal.createCut({
        ...cutInput(),
        cutId: rootCutId,
      });
      journal.bindAttemptToCut(ATTEMPT, rootCutId);
      journal.recordAmbiguous({
        attemptId: ATTEMPT,
        ambiguityEvidenceDigest: digest("1"),
        ambiguityRevisionDigest: digest("2"),
        now: at(3),
      });
      const generationTwoRevision = advanceAccountGeneration(database, 2);
      journal.recordFence({
        cutId: rootCutId,
        successorGeneration: 2,
        successorAccountProfileRevision: generationTwoRevision,
        fenceEvidenceDigest: digest("3"),
        fenceRevisionDigest: digest("4"),
        now: at(4),
      });
      const rootMember = {
        ...memberInput(),
        cutId: rootCutId,
        memberId: "archmember_sharedcleanup_root01",
      };
      journal.addCutMember(rootMember);
      sealInventory(journal, rootCutId, [rootMember], digest("5"), at(5));
      settle(journal, rootMember.memberId, 6);
      journal.markCutContained({
        cutId: rootCutId,
        containmentEvidenceDigest: digest("6"),
        containmentRevisionDigest: digest("7"),
        now: at(7),
      });
      journal.recordReconciledNotApplied({
        attemptId: ATTEMPT,
        outcomeEvidenceDigest: digest("8"),
        outcomeRevisionDigest: digest("9"),
        now: at(8),
      });
      journal.appendSuccessorAttempt({
        targetId: TARGET,
        attemptId: successorAttemptId,
        generation: 2,
        accountProfileRevision: generationTwoRevision,
        requestEvidenceDigest: digest("a"),
        requestRevisionDigest: digest("b"),
        now: at(9),
      });
      const secondTarget = {
        ...secondTargetInput(),
        accountProfileRevision: generationTwoRevision,
        attempt: {
          ...secondTargetInput().attempt,
          generation: 2,
          accountProfileRevision: generationTwoRevision,
        },
      };
      journal.prepareTarget(secondTarget);
      for (const attemptId of [successorAttemptId, secondTarget.attempt.attemptId]) {
        journal.markEffectStarted({
          attemptId,
          effectEvidenceDigest: digest("c"),
          effectRevisionDigest: digest("d"),
          now: at(10),
        });
      }
      journal.createCut({
        ...cutInput(),
        cutId: leafCutId,
        accountProfileRevision: generationTwoRevision,
        sourceGeneration: 2,
        initiatingAttemptId: successorAttemptId,
        predecessorCutId: rootCutId,
        now: at(11),
      });
      journal.bindAllAffectedTargets(leafCutId);
      for (const attemptId of [successorAttemptId, secondTarget.attempt.attemptId]) {
        journal.recordAmbiguous({
          attemptId,
          ambiguityEvidenceDigest: digest("e"),
          ambiguityRevisionDigest: digest("f"),
          now: at(12),
        });
      }
      const generationThreeRevision = advanceAccountGeneration(database, 3);
      journal.recordFence({
        cutId: leafCutId,
        successorGeneration: 3,
        successorAccountProfileRevision: generationThreeRevision,
        fenceEvidenceDigest: digest("1"),
        fenceRevisionDigest: digest("2"),
        now: at(13),
      });
      const leafMembers = [
        {
          ...memberInput(),
          cutId: leafCutId,
          memberId: "archmember_sharedcleanup_leafa02",
          attemptId: successorAttemptId,
          targetAttemptOrdinal: 2,
        },
        {
          ...secondTargetMemberInput(),
          cutId: leafCutId,
          memberId: "archmember_sharedcleanup_leafb01",
        },
      ] as const;
      for (const member of leafMembers) journal.addCutMember(member);
      sealInventory(journal, leafCutId, leafMembers, digest("3"), at(14));
      for (const member of leafMembers) settle(journal, member.memberId, 15);
      journal.markCutContained({
        cutId: leafCutId,
        containmentEvidenceDigest: digest("4"),
        containmentRevisionDigest: digest("5"),
        now: at(16),
      });
      for (const [index, attemptId] of [
        successorAttemptId,
        secondTarget.attempt.attemptId,
      ].entries()) {
        journal.recordReconciledApplied({
          attemptId,
          responseGeneration: 3,
          responseStreamPosition: index + 1,
          outcomeEvidenceDigest: digest("6"),
          outcomeRevisionDigest: digest("7"),
          now: at(17),
        });
      }
      const firstTargetId = order[0]!;
      const secondTargetId = order[1]!;
      journal.markTargetCommitted({
        targetId: firstTargetId,
        commitEvidenceDigest: digest("8"),
        commitRevisionDigest: digest("9"),
        now: at(18),
      });
      const pendingComponent = journal.terminalCleanupComponent(firstTargetId);
      expect(pendingComponent).toEqual({
        accountProfileId: ACCOUNT,
        targetIds: [TARGET, secondTarget.targetId].toSorted(),
        cutIds: [rootCutId, leafCutId].toSorted(),
        allTargetsCommitted: false,
      });
      expect(journal.terminalCleanupComponent(secondTargetId))
        .toEqual(pendingComponent);
      expect(journal.deleteCommittedTargetSafely(firstTargetId))
        .toEqual({ deletedTargetIds: [], deletedCutIds: [] });
      expect(database.query(`
        SELECT
          (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
      `).get()).toEqual({ targets: 2, cuts: 2, members: 3 });
      journal.markTargetCommitted({
        targetId: secondTargetId,
        commitEvidenceDigest: digest("8"),
        commitRevisionDigest: digest("9"),
        now: at(19),
      });
      const terminalComponent = journal.terminalCleanupComponent(secondTargetId);
      expect(terminalComponent).toEqual({
        ...pendingComponent,
        allTargetsCommitted: true,
      });
      expect(() => journal.deleteCommittedTargetSafely(secondTargetId, {
        ...terminalComponent,
        cutIds: [],
      })).toThrow("was not approved exactly");
      expect(database.query(`
        SELECT
          (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
      `).get()).toEqual({ targets: 2, attempts: 3, cuts: 2, members: 3 });

      if (firstTargetId === TARGET) {
        const recoveredDatabase = Database.deserialize(
          database.serialize(),
          { strict: true },
        );
        try {
          recoveredDatabase.exec("PRAGMA foreign_keys = ON");
          const recovered = new ProviderThreadArchiveJournalV57(
            recoveredDatabase,
            KEY,
          );
          expect(recovered.deleteAllTerminalAuthoritySafely()).toEqual({
            deletedTargetIds: terminalComponent.targetIds,
            deletedCutIds: terminalComponent.cutIds,
          });
          expect(recovered.deleteAllTerminalAuthoritySafely()).toEqual({
            deletedTargetIds: [],
            deletedCutIds: [],
          });
        } finally {
          recoveredDatabase.close();
        }
      }

      database.exec(`
        CREATE TEMP TRIGGER fail_shared_component_cleanup
        BEFORE DELETE ON chat_provider_thread_archive_cuts_v57
        WHEN OLD.cut_id = 'archcut_sharedcleanup_leaf02'
        BEGIN
          SELECT RAISE(ABORT, 'injected shared component cleanup failure');
        END;
      `);
      expect(() => journal.deleteCommittedTargetSafely(
        secondTargetId,
        terminalComponent,
      )).toThrow("injected shared component cleanup failure");
      expect(database.query(`
        SELECT
          (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
      `).get()).toEqual({ targets: 2, attempts: 3, cuts: 2, members: 3 });
      database.exec("DROP TRIGGER fail_shared_component_cleanup");
      expect(journal.deleteCommittedTargetSafely(
        secondTargetId,
        terminalComponent,
      )).toEqual({
        deletedTargetIds: terminalComponent.targetIds,
        deletedCutIds: terminalComponent.cutIds,
      });
      expect(database.query(`
        SELECT
          (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
      `).get()).toEqual({ targets: 0, cuts: 0, members: 0 });
    });
  };
  runOrder([TARGET, "archtarget_archivejournal02"]);
  runOrder(["archtarget_archivejournal02", TARGET]);
});

test("reconciled not-applied appends a strictly newer successor without changing old evidence", () => {
  withFixture(({ database, journal }) => {
    containedAmbiguity(database, journal);
    journal.recordReconciledNotApplied({
      attemptId: ATTEMPT,
      outcomeEvidenceDigest: digest("1"),
      outcomeRevisionDigest: digest("2"),
      now: at(9),
    });
    const old = database.query(`
      SELECT * FROM chat_provider_thread_archive_attempts_v57 WHERE attempt_id = ?1
    `).get(ATTEMPT);
    expect(() => journal.appendSuccessorAttempt({
      targetId: TARGET,
      attemptId: "archattempt_archivejournal02",
      generation: 1,
      accountProfileRevision: 2,
      requestEvidenceDigest: digest("3"),
      requestRevisionDigest: digest("4"),
      now: at(10),
    })).toThrow("must be exact");
    const successor = journal.appendSuccessorAttempt({
      targetId: TARGET,
      attemptId: "archattempt_archivejournal02",
      generation: 2,
      accountProfileRevision: 2,
      requestEvidenceDigest: digest("3"),
      requestRevisionDigest: digest("4"),
      now: at(10),
    });
    expect(successor.currentAttempt).toEqual({
      attemptId: "archattempt_archivejournal02",
      ordinal: 2,
      generation: 2,
      accountProfileRevision: 2,
      predecessorAttemptId: ATTEMPT,
      cutId: null,
      state: "prepared",
    });
    expect(database.query(`
      SELECT * FROM chat_provider_thread_archive_attempts_v57 WHERE attempt_id = ?1
    `).get(ATTEMPT)).toEqual(old);
    journal.markEffectStarted({
      attemptId: "archattempt_archivejournal02",
      effectEvidenceDigest: digest("5"),
      effectRevisionDigest: digest("6"),
      now: at(11),
    });
    const nextCut = {
      ...cutInput(),
      cutId: "archcut_archivejournal02",
      sourceGeneration: 2,
      accountProfileRevision: 2,
      initiatingAttemptId: "archattempt_archivejournal02",
      now: at(12),
    };
    expect(() => journal.createCut(nextCut)).toThrow("lineage is invalid");
    expect(journal.createCut({ ...nextCut, predecessorCutId: CUT })).toMatchObject({
      sourceGeneration: 2,
      state: "fence_started",
    });
  });
});

test("one cut freezes every same-generation target and preserves mixed outcomes", () => {
  withFixture(({ database, journal }) => {
    const secondTarget = secondTargetInput();
    prepareEffect(journal);
    journal.prepareTarget(secondTarget);
    expect(journal.createCut(cutInput())).toMatchObject({ targetCount: 2 });
    expect(journal.bindAllAffectedTargets(CUT)).toHaveLength(2);
    journal.recordAmbiguous({
      attemptId: ATTEMPT,
      ambiguityEvidenceDigest: digest("7"),
      ambiguityRevisionDigest: digest("8"),
      now: at(3),
    });
    const successorProfileRevision = advanceAccountGeneration(database, 2);
    journal.recordFence({
      cutId: CUT,
      successorGeneration: 2,
      successorAccountProfileRevision: successorProfileRevision,
      fenceEvidenceDigest: digest("9"),
      fenceRevisionDigest: digest("a"),
      now: at(4),
    });
    journal.addCutMember(memberInput());
    journal.addCutMember(secondTargetMemberInput());
    sealInventory(
      journal,
      CUT,
      [memberInput(), secondTargetMemberInput()],
      digest("b"),
      at(5),
    );
    settle(journal, MEMBER, 6);
    settle(journal, "archmember_archivejournal02", 7);
    journal.markCutContained({
      cutId: CUT,
      containmentEvidenceDigest: digest("c"),
      containmentRevisionDigest: digest("d"),
      now: at(8),
    });
    journal.recordReconciledApplied({
      attemptId: ATTEMPT,
      responseGeneration: 2,
      responseStreamPosition: 12,
      outcomeEvidenceDigest: digest("e"),
      outcomeRevisionDigest: digest("f"),
      now: at(9),
    });
    journal.recordReconciledNotApplied({
      attemptId: secondTarget.attempt.attemptId,
      outcomeEvidenceDigest: digest("0"),
      outcomeRevisionDigest: digest("1"),
      now: at(10),
    });
    const successor = journal.appendSuccessorAttempt({
      targetId: secondTarget.targetId,
      attemptId: "archattempt_archivejournal03",
      generation: 2,
      accountProfileRevision: successorProfileRevision,
      requestEvidenceDigest: digest("2"),
      requestRevisionDigest: digest("3"),
      now: at(11),
    });
    expect(successor.attempts.map(({ state }) => state)).toEqual([
      "reconciled_not_applied",
      "prepared",
    ]);
    expect(journal.reopenTarget(TARGET).currentAttempt.state).toBe("reconciled_applied");
  });
});

test("prepared crash evidence appends exact N plus one without rewriting attempt N", () => {
  withFixture(({ database, journal }) => {
    journal.prepareTarget(targetInput());
    journal.recordPreparedNotStarted({
      attemptId: ATTEMPT,
      outcomeEvidenceDigest: digest("4"),
      outcomeRevisionDigest: digest("5"),
      now: at(1),
    });
    const oldEvidence = database.query(
      "SELECT * FROM chat_provider_thread_archive_attempts_v57 WHERE attempt_id = ?1",
    ).get(ATTEMPT);
    const recovered = new ProviderThreadArchiveJournalV57(
      Database.deserialize(database.serialize(), { strict: true }),
      KEY,
    );
    expect(recovered.reopenTarget(TARGET).currentAttempt.state).toBe("abandoned_pre_effect");
    expect(() => journal.appendSuccessorAttempt({
      targetId: TARGET,
      attemptId: "archattempt_archivejournal02",
      generation: 3,
      accountProfileRevision: 1,
      requestEvidenceDigest: digest("6"),
      requestRevisionDigest: digest("7"),
      now: at(2),
    })).toThrow("must be exact");
    const successorProfileRevision = advanceAccountGeneration(database, 2);
    journal.appendSuccessorAttempt({
      targetId: TARGET,
      attemptId: "archattempt_archivejournal02",
      generation: 2,
      accountProfileRevision: successorProfileRevision,
      requestEvidenceDigest: digest("6"),
      requestRevisionDigest: digest("7"),
      now: at(2),
    });
    expect(database.query(
      "SELECT * FROM chat_provider_thread_archive_attempts_v57 WHERE attempt_id = ?1",
    ).get(ATTEMPT)).toEqual(oldEvidence);
    expect(journal.admissionDescriptor(TARGET)).toMatchObject({
      attemptOrdinal: 2,
      attemptPhase: "prepared",
      expectedGeneration: 2,
      successorGeneration: null,
    });
    journal.markEffectStarted({
      attemptId: "archattempt_archivejournal02",
      effectEvidenceDigest: digest("8"),
      effectRevisionDigest: digest("9"),
      now: at(3),
    });
    journal.recordDirectApplied({
      attemptId: "archattempt_archivejournal02",
      responseGeneration: 2,
      responseStreamPosition: 1,
      outcomeEvidenceDigest: digest("a"),
      outcomeRevisionDigest: digest("b"),
      now: at(4),
    });
    journal.markTargetCommitted({
      targetId: TARGET,
      commitEvidenceDigest: digest("c"),
      commitRevisionDigest: digest("d"),
      now: at(5),
    });
    journal.deleteCommittedTargetSafely(TARGET);
    expect(database.query(
      "SELECT COUNT(*) AS count FROM chat_provider_thread_archive_attempts_v57",
    ).get()).toEqual({ count: 0 });
  });
});

test("account removal contains every mixed-generation target before tombstone and local commit", () => {
  withFixture(({ database, journal }) => {
    const secondTarget = {
      ...secondTargetInput(),
      accountProfileRevision: 2,
      attempt: {
        ...secondTargetInput().attempt,
        generation: 2,
        accountProfileRevision: 2,
      },
    };
    prepareEffect(journal);
    journal.recordDirectApplied({
      attemptId: ATTEMPT,
      responseGeneration: 1,
      responseStreamPosition: 4,
      outcomeEvidenceDigest: digest("3"),
      outcomeRevisionDigest: digest("4"),
      now: at(2),
    });
    const generationTwoRevision = advanceAccountGeneration(database, 2);
    expect(generationTwoRevision).toBe(2);
    journal.prepareTarget(secondTarget);
    journal.recordPreparedNotStarted({
      attemptId: secondTarget.attempt.attemptId,
      outcomeEvidenceDigest: digest("5"),
      outcomeRevisionDigest: digest("6"),
      now: at(2),
    });
    const removalCut = "archcut_removaljournal01";
    expect(journal.createCut({
      ...cutInput(),
      cutId: removalCut,
      cause: "account_removal",
      initiatingAttemptId: null,
      sourceGeneration: 2,
      accountProfileRevision: generationTwoRevision,
    })).toMatchObject({ targetCount: 2 });
    expect(journal.bindAllAffectedTargets(removalCut)).toEqual([
      expect.objectContaining({ attemptId: ATTEMPT, generation: 1, cutId: removalCut }),
      expect.objectContaining({
        attemptId: secondTarget.attempt.attemptId,
        generation: 2,
        cutId: removalCut,
      }),
    ]);
    journal.recordFence({
      cutId: removalCut,
      successorGeneration: null,
      successorAccountProfileRevision: null,
      fenceEvidenceDigest: digest("7"),
      fenceRevisionDigest: digest("8"),
      now: at(3),
    });
    journal.addCutMember({ ...memberInput(), cutId: removalCut });
    journal.addCutMember({ ...secondTargetMemberInput(), cutId: removalCut });
    sealInventory(
      journal,
      removalCut,
      [
        { ...memberInput(), cutId: removalCut },
        { ...secondTargetMemberInput(), cutId: removalCut },
      ],
      digest("9"),
      at(4),
    );
    settle(journal, MEMBER, 5);
    settle(journal, "archmember_archivejournal02", 6);
    const awaiting = journal.markRemovalAwaitingTombstone({
      cutId: removalCut,
      containmentEvidenceDigest: digest("a"),
      containmentRevisionDigest: digest("b"),
      targets: [
        {
          targetId: TARGET,
          containmentEvidenceDigest: digest("c"),
          containmentRevisionDigest: digest("d"),
        },
        {
          targetId: secondTarget.targetId,
          containmentEvidenceDigest: digest("e"),
          containmentRevisionDigest: digest("f"),
        },
      ],
      now: at(7),
    });
    expect(awaiting).toMatchObject({
      state: "removal_awaiting_tombstone",
      successorGeneration: null,
    });
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE account_profile_id = ?1 AND status = 'open'
    `).get(ACCOUNT)).toEqual({ count: 0 });
    expect(database.query(`
      SELECT target.target_id, target.status, attempt.generation,
        attempt.state, attempt.cut_id
      FROM chat_provider_thread_archive_targets_v57 AS target
      JOIN chat_provider_thread_archive_attempts_v57 AS attempt
        ON attempt.attempt_id = target.current_attempt_id
      WHERE target.account_profile_id = ?1
      ORDER BY attempt.generation
    `).all(ACCOUNT)).toEqual([
      {
        target_id: TARGET,
        status: "account_contained",
        generation: 1,
        state: "account_contained",
        cut_id: removalCut,
      },
      {
        target_id: secondTarget.targetId,
        status: "account_contained",
        generation: 2,
        state: "account_contained",
        cut_id: removalCut,
      },
    ]);
    expect(journal.recoveryInventory()).toMatchObject({
      admissionDescriptors: [
        { attemptPhase: "account_contained" },
        { attemptPhase: "account_contained" },
      ],
      removalAdmissionDescriptors: [{ transitionId: removalCut }],
    });
    expect(() => journal.markTargetCommitted({
      targetId: TARGET,
      commitEvidenceDigest: digest("1"),
      commitRevisionDigest: digest("2"),
      now: at(8),
    })).toThrow("lacks an applied outcome");
    const removedAt = at(8).toISOString();
    expect(() => journal.markRemovalTombstoned({
      cutId: removalCut,
      tombstoneEvidenceDigest: digest("0"),
      tombstoneRevisionDigest: digest("1"),
      accountProfileRevision: generationTwoRevision,
      removedAt,
      localDataDeletedAt: null,
      profilePreimageDigest: digest("2"),
      now: at(8),
    })).toThrow("lacks its exact account tombstone");
    const tombstoneProfileRevision = tombstoneAccountProfile(database, removedAt);
    const profilePreimageDigest =
      providerThreadArchiveAccountTombstonePreimageDigestV57({
        accountProfileId: ACCOUNT,
        accountProfileRevision: tombstoneProfileRevision,
        processGeneration: 2,
        removedAt,
        localDataDeletedAt: null,
      });
    expect(() => journal.markRemovalTombstoned({
      cutId: removalCut,
      tombstoneEvidenceDigest: digest("0"),
      tombstoneRevisionDigest: digest("1"),
      accountProfileRevision: tombstoneProfileRevision,
      removedAt,
      localDataDeletedAt: null,
      profilePreimageDigest: digest("f"),
      now: at(8),
    })).toThrow("lacks its exact account tombstone");
    expect(journal.markRemovalTombstoned({
      cutId: removalCut,
      tombstoneEvidenceDigest: digest("0"),
      tombstoneRevisionDigest: digest("1"),
      accountProfileRevision: tombstoneProfileRevision,
      removedAt,
      localDataDeletedAt: null,
      profilePreimageDigest,
      now: at(8),
    }).state).toBe("contained");
    expect(database.query(`
      SELECT COUNT(*) AS count
      FROM chat_provider_thread_archive_targets_v57
      WHERE account_profile_id = ?1 AND status = 'open'
    `).get(ACCOUNT)).toEqual({ count: 0 });
    const tombstoned = database.serialize();
    for (const scenario of [
      {
        trigger: "chat_provider_thread_archive_target_account_evidence_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_targets_v57 SET account_containment_revision_digest = ?2 WHERE target_id = ?1",
        id: TARGET,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_attempt_account_evidence_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_attempts_v57 SET account_containment_revision_digest = ?2 WHERE attempt_id = ?1",
        id: ATTEMPT,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_cut_tombstone_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_cuts_v57 SET tombstone_revision_digest = ?2 WHERE cut_id = ?1",
        id: removalCut,
        open: "cut",
      },
    ] as const) {
      const clone = Database.deserialize(tombstoned, { strict: true });
      try {
        clone.exec("DROP TRIGGER " + scenario.trigger);
        clone.query(scenario.sql).run(scenario.id, digest("f"));
        const reopened = new ProviderThreadArchiveJournalV57(clone, KEY);
        const open = () => scenario.open === "target"
          ? reopened.reopenTarget(TARGET)
          : reopened.reopenCut(removalCut);
        expect(open).toThrow("receipt is invalid");
      } finally {
        clone.close();
      }
    }
    journal.markTargetCommitted({
      targetId: TARGET,
      commitEvidenceDigest: digest("2"),
      commitRevisionDigest: digest("3"),
      now: at(9),
    });
    expect(journal.deleteCommittedTargetSafely(TARGET)).toEqual({
      deletedTargetIds: [],
      deletedCutIds: [],
    });
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts
    `).get()).toEqual({ targets: 2, cuts: 1 });
    journal.markTargetCommitted({
      targetId: secondTarget.targetId,
      commitEvidenceDigest: digest("2"),
      commitRevisionDigest: digest("3"),
      now: at(10),
    });
    const terminalComponent = journal.terminalCleanupComponent(
      secondTarget.targetId,
    );
    expect(journal.deleteCommittedTargetSafely(
      secondTarget.targetId,
      terminalComponent,
    )).toEqual({
      deletedTargetIds: [TARGET, secondTarget.targetId].toSorted(),
      deletedCutIds: [removalCut],
    });
    expect(journal.recoveryTargets()).toEqual([]);
  });
});

test("account tombstone and journal containment compose in one outer transaction", () => {
  withFixture(({ database, journal }) => {
    journal.prepareTarget(targetInput());
    const cutId = "archcut_transactionremoval01";
    journal.createCut({
      ...cutInput(),
      cutId,
      cause: "account_removal",
      initiatingAttemptId: null,
    });
    journal.bindAllAffectedTargets(cutId);
    journal.recordFence({
      cutId,
      successorGeneration: null,
      successorAccountProfileRevision: null,
      fenceEvidenceDigest: digest("4"),
      fenceRevisionDigest: digest("5"),
      now: at(2),
    });
    const members = [{ ...memberInput(), cutId }];
    journal.addCutMember(members[0]!);
    sealInventory(journal, cutId, members, digest("6"), at(3));
    settle(journal, MEMBER, 4);
    journal.markRemovalAwaitingTombstone({
      cutId,
      containmentEvidenceDigest: digest("7"),
      containmentRevisionDigest: digest("8"),
      targets: [{
        targetId: TARGET,
        containmentEvidenceDigest: digest("9"),
        containmentRevisionDigest: digest("a"),
      }],
      now: at(5),
    });

    const removedAt = at(6).toISOString();
    const localDataDeletedAt = at(7).toISOString();
    const tombstoneAndContain = () => {
      const accountProfileRevision = tombstoneAccountProfile(
        database,
        removedAt,
        localDataDeletedAt,
      );
      return journal.markRemovalTombstoned({
        cutId,
        tombstoneEvidenceDigest: digest("b"),
        tombstoneRevisionDigest: digest("c"),
        accountProfileRevision,
        removedAt,
        localDataDeletedAt,
        profilePreimageDigest:
          providerThreadArchiveAccountTombstonePreimageDigestV57({
            accountProfileId: ACCOUNT,
            accountProfileRevision,
            processGeneration: 1,
            removedAt,
            localDataDeletedAt,
          }),
        now: at(7),
      });
    };
    const rollBack = database.transaction(() => {
      expect(tombstoneAndContain().state).toBe("contained");
      throw new Error("outer tombstone rollback");
    });
    expect(rollBack).toThrow("outer tombstone rollback");
    expect(database.query(`
      SELECT revision, removed_at, local_data_deleted_at
      FROM account_profiles WHERE profile_id = ?1
    `).get(ACCOUNT)).toEqual({
      revision: 1,
      removed_at: null,
      local_data_deleted_at: null,
    });
    expect(journal.reopenCut(cutId).state).toBe("removal_awaiting_tombstone");

    const commit = database.transaction(tombstoneAndContain);
    expect(commit()).toMatchObject({ state: "contained", successorGeneration: null });
    expect(database.query(`
      SELECT revision, removed_at, local_data_deleted_at
      FROM account_profiles WHERE profile_id = ?1
    `).get(ACCOUNT)).toEqual({
      revision: 2,
      removed_at: removedAt,
      local_data_deleted_at: localDataDeletedAt,
    });
    expect(journal.reopenCut(cutId)).toMatchObject({ state: "contained" });
  });
});

test("none attachment custody is authoritative and frozen comparison APIs fail closed", () => {
  withFixture(({ database, journal }) => {
    database.query(
      "DELETE FROM chat_provider_attachment_bindings WHERE binding_id = ?1",
    ).run(BINDING);
    const input = { ...targetInput(), binding: { kind: "none" as const } };
    journal.prepareTarget(input);
    journal.assertTargetPreimage(TARGET, {
      paneId: PANE,
      purpose: "pane_archive",
      paneRevision: 1,
      queueRevision: null,
      paneCasDigest: digest("1"),
      queueCasDigest: null,
      accountProfileId: ACCOUNT,
      accountProfileRevision: 1,
      threadId: THREAD,
      restartThreadId: RESTART,
      binding: { kind: "none" },
    });
    expect(() => journal.assertTargetPreimage(TARGET, {
      paneId: PANE,
      purpose: "pane_archive",
      paneRevision: 2,
      queueRevision: null,
      paneCasDigest: digest("1"),
      queueCasDigest: null,
      accountProfileId: ACCOUNT,
      accountProfileRevision: 1,
      threadId: THREAD,
      restartThreadId: RESTART,
      binding: { kind: "none" },
    })).toThrow("does not match");
    journal.markEffectStarted({
      attemptId: ATTEMPT,
      effectEvidenceDigest: digest("2"),
      effectRevisionDigest: digest("3"),
      now: at(1),
    });
    journal.createCut(cutInput());
    journal.bindAllAffectedTargets(CUT);
    const successorProfileRevision = advanceAccountGeneration(database, 2);
    journal.recordFence({
      cutId: CUT,
      successorGeneration: 2,
      successorAccountProfileRevision: successorProfileRevision,
      fenceEvidenceDigest: digest("4"),
      fenceRevisionDigest: digest("5"),
      now: at(2),
    });
    journal.addCutMember({ ...memberInput(), binding: { kind: "none" } });
    journal.assertMemberPreimage(MEMBER, {
      paneId: PANE,
      paneRevision: 1,
      paneCasDigest: digest("1"),
      threadId: THREAD,
      restartThreadId: RESTART,
      binding: { kind: "none" },
    });
    expect(() => journal.assertMemberPreimage(MEMBER, {
      paneId: PANE,
      paneRevision: 1,
      paneCasDigest: digest("1"),
      threadId: "wrong-thread",
      restartThreadId: RESTART,
      binding: { kind: "none" },
    })).toThrow("does not match");
  });
});

test("wrong receipt key and HMAC tampering fail closed on reopen", () => {
  withFixture(({ database, journal }) => {
    prepareEffect(journal);
    expect(() => new ProviderThreadArchiveJournalV57(database, WRONG_KEY).reopenTarget(TARGET))
      .toThrow("receipt is invalid");
    database.exec("DROP TRIGGER chat_provider_thread_archive_attempt_identity_immutable_v57");
    database.query(`
      UPDATE chat_provider_thread_archive_attempts_v57
      SET request_revision_digest = ?2 WHERE attempt_id = ?1
    `).run(ATTEMPT, digest("f"));
    expect(() => journal.reopenTarget(TARGET)).toThrow("attempt identity receipt is invalid");
  });
});

test("every target, attempt, cut, and member receipt phase rejects keyed tampering", () => {
  withFixture(({ database, journal }) => {
    containedAmbiguity(database, journal);
    journal.recordReconciledNotApplied({
      attemptId: ATTEMPT,
      outcomeEvidenceDigest: digest("1"),
      outcomeRevisionDigest: digest("2"),
      now: at(9),
    });
    const serialized = database.serialize();
    const scenarios = [
      {
        trigger: "chat_provider_thread_archive_target_identity_immutable_v57",
        sql: "UPDATE chat_provider_thread_archive_targets_v57 SET pane_cas_digest = ?2 WHERE target_id = ?1",
        id: TARGET,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_target_pointer_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_targets_v57 SET pointer_hmac = ?2 WHERE target_id = ?1",
        id: TARGET,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_attempt_identity_immutable_v57",
        sql: "UPDATE chat_provider_thread_archive_attempts_v57 SET request_revision_digest = ?2 WHERE attempt_id = ?1",
        id: ATTEMPT,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_attempt_cut_binding_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_attempts_v57 SET cut_binding_hmac = ?2 WHERE attempt_id = ?1",
        id: ATTEMPT,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_attempt_effect_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_attempts_v57 SET effect_revision_digest = ?2 WHERE attempt_id = ?1",
        id: ATTEMPT,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_attempt_ambiguity_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_attempts_v57 SET ambiguity_revision_digest = ?2 WHERE attempt_id = ?1",
        id: ATTEMPT,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_attempt_outcome_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_attempts_v57 SET outcome_revision_digest = ?2 WHERE attempt_id = ?1",
        id: ATTEMPT,
        open: "target",
      },
      {
        trigger: "chat_provider_thread_archive_cut_identity_immutable_v57",
        sql: "UPDATE chat_provider_thread_archive_cuts_v57 SET identity_revision_digest = ?2 WHERE cut_id = ?1",
        id: CUT,
        open: "cut",
      },
      {
        trigger: "chat_provider_thread_archive_cut_fence_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_cuts_v57 SET fence_revision_digest = ?2 WHERE cut_id = ?1",
        id: CUT,
        open: "cut",
      },
      {
        trigger: "chat_provider_thread_archive_cut_seal_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_cuts_v57 SET seal_revision_digest = ?2 WHERE cut_id = ?1",
        id: CUT,
        open: "cut",
      },
      {
        trigger: "chat_provider_thread_archive_cut_containment_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_cuts_v57 SET containment_revision_digest = ?2 WHERE cut_id = ?1",
        id: CUT,
        open: "cut",
      },
      {
        trigger: "chat_provider_thread_archive_member_identity_immutable_v57",
        sql: "UPDATE chat_provider_thread_archive_cut_members_v57 SET identity_revision_digest = ?2 WHERE member_id = ?1",
        id: MEMBER,
        open: "cut",
      },
      {
        trigger: "chat_provider_thread_archive_member_settlement_guard_v57",
        sql: "UPDATE chat_provider_thread_archive_cut_members_v57 SET settlement_revision_digest = ?2 WHERE member_id = ?1",
        id: MEMBER,
        open: "cut",
      },
    ] as const;
    for (const scenario of scenarios) {
      const clone = Database.deserialize(serialized, { strict: true });
      try {
        clone.exec("DROP TRIGGER " + scenario.trigger);
        clone.query(scenario.sql).run(scenario.id, digest("0"));
        const reopened = new ProviderThreadArchiveJournalV57(clone, KEY);
        const open = () => scenario.open === "target"
          ? reopened.reopenTarget(TARGET)
          : reopened.reopenCut(CUT);
        expect(open).toThrow("receipt is invalid");
      } finally {
        clone.close();
      }
    }
  });
});

test("SQL triggers reject stale target preimages, duplicate open panes, and invalid transitions", () => {
  withFixture(({ database, journal }) => {
    expect(() => journal.prepareTarget({ ...targetInput(), paneRevision: 2 }))
      .toThrow("preimage is stale");
    journal.prepareTarget(targetInput());
    expect(() => journal.prepareTarget({
      ...targetInput(),
      targetId: "archtarget_archivejournal02",
      attempt: { ...targetInput().attempt, attemptId: "archattempt_archivejournal02" },
    })).toThrow();
    expect(() => database.query(`
      UPDATE chat_provider_thread_archive_attempts_v57 SET state = 'direct_applied'
      WHERE attempt_id = ?1
    `).run(ATTEMPT)).toThrow();
    expect(() => database.query(`
      UPDATE chat_provider_thread_archive_targets_v57
      SET current_attempt_ordinal = 2,
        current_attempt_id = 'archattempt_archivejournal02', pointer_hmac = ?2
      WHERE target_id = ?1
    `).run(TARGET, digest("a"))).toThrow("pointer advance");
  });
});

test("targets and cuts bind the exact durable account generation revision", () => {
  withFixture(({ database, journal }) => {
    expect(() => journal.prepareTarget({
      ...targetInput(),
      attempt: { ...targetInput().attempt, generation: 2 },
    })).toThrow("exact active profile revision");
    expect(() => journal.prepareTarget({
      ...targetInput(),
      accountProfileRevision: 2,
    })).toThrow("lost its target profile revision");
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_provider_thread_archive_targets_v57
    `).get()).toEqual({ count: 0 });

    journal.prepareTarget(targetInput());
    expect(() => journal.createCut({
      ...cutInput(),
      cause: "account_removal",
      initiatingAttemptId: null,
      sourceGeneration: 2,
    })).toThrow("exact active profile revision");

    const profileRevision = advanceAccountGeneration(database, 2);
    expect(() => journal.createCut({
      ...cutInput(),
      accountProfileRevision: profileRevision,
    })).toThrow("exact active profile revision");
    expect(() => journal.prepareTarget({
      ...secondTargetInput(),
      attempt: { ...secondTargetInput().attempt, generation: 2 },
    })).toThrow("exact active profile revision");
    journal.prepareTarget({
      ...secondTargetInput(),
      accountProfileRevision: profileRevision,
      attempt: {
        ...secondTargetInput().attempt,
        generation: 2,
        accountProfileRevision: profileRevision,
      },
    });
    expect(journal.createCut({
      ...cutInput(),
      cutId: "archcut_generationjournal01",
      accountProfileRevision: profileRevision,
      sourceGeneration: 2,
      cause: "account_removal",
      initiatingAttemptId: null,
    })).toMatchObject({ sourceGeneration: 2, targetCount: 2 });
  });
});

test("reopen derives every attempt, cut, and member phase from receipt topology", () => {
  withFixture(({ database, journal }) => {
    journal.prepareTarget(targetInput());
    journal.prepareTarget(secondTargetInput());
    const base = database.serialize();
    const targetCases: StateTamperCase[] = [{
      table: "chat_provider_thread_archive_targets_v57",
      idColumn: "target_id",
      id: TARGET,
      ownerId: TARGET,
      state: "open",
      tamperedState: "account_contained",
      serialized: base,
    }];
    const attemptCases: StateTamperCase[] = [{
      table: "chat_provider_thread_archive_attempts_v57",
      idColumn: "attempt_id",
      id: ATTEMPT,
      ownerId: TARGET,
      state: "prepared",
      tamperedState: "effect_started",
      serialized: base,
    }];
    const cutCases: StateTamperCase[] = [];
    const memberCases: StateTamperCase[] = [];

    const directDatabase = Database.deserialize(base, { strict: true });
    try {
      const directJournal = new ProviderThreadArchiveJournalV57(directDatabase, KEY);
      directJournal.markEffectStarted({
        attemptId: ATTEMPT,
        effectEvidenceDigest: digest("1"),
        effectRevisionDigest: digest("2"),
        now: at(1),
      });
      directJournal.recordDirectApplied({
        attemptId: ATTEMPT,
        responseGeneration: 1,
        responseStreamPosition: 3,
        outcomeEvidenceDigest: digest("3"),
        outcomeRevisionDigest: digest("4"),
        now: at(2),
      });
      const directApplied = directDatabase.serialize();
      attemptCases.push({
        table: "chat_provider_thread_archive_attempts_v57",
        idColumn: "attempt_id",
        id: ATTEMPT,
        ownerId: TARGET,
        state: "direct_applied",
        tamperedState: "prepared",
        serialized: directApplied,
      });
      directJournal.markTargetCommitted({
        targetId: TARGET,
        commitEvidenceDigest: digest("5"),
        commitRevisionDigest: digest("6"),
        now: at(3),
      });
      targetCases.push({
        table: "chat_provider_thread_archive_targets_v57",
        idColumn: "target_id",
        id: TARGET,
        ownerId: TARGET,
        state: "committed",
        tamperedState: "open",
        serialized: directDatabase.serialize(),
      });
    } finally {
      directDatabase.close();
    }

    const abandonedDatabase = Database.deserialize(base, { strict: true });
    try {
      const abandonedJournal = new ProviderThreadArchiveJournalV57(
        abandonedDatabase,
        KEY,
      );
      abandonedJournal.recordPreparedNotStarted({
        attemptId: ATTEMPT,
        outcomeEvidenceDigest: digest("5"),
        outcomeRevisionDigest: digest("6"),
        now: at(1),
      });
      attemptCases.push({
        table: "chat_provider_thread_archive_attempts_v57",
        idColumn: "attempt_id",
        id: ATTEMPT,
        ownerId: TARGET,
        state: "abandoned_pre_effect",
        tamperedState: "prepared",
        serialized: abandonedDatabase.serialize(),
      });
    } finally {
      abandonedDatabase.close();
    }

    const removalDatabase = Database.deserialize(base, { strict: true });
    try {
      const removalJournal = new ProviderThreadArchiveJournalV57(
        removalDatabase,
        KEY,
      );
      const removalCutId = "archcut_topologyremoval01";
      removalJournal.markEffectStarted({
        attemptId: ATTEMPT,
        effectEvidenceDigest: digest("1"),
        effectRevisionDigest: digest("2"),
        now: at(1),
      });
      removalJournal.createCut({
        ...cutInput(),
        cutId: removalCutId,
        cause: "account_removal",
        initiatingAttemptId: null,
      });
      removalJournal.bindAllAffectedTargets(removalCutId);
      removalJournal.recordFence({
        cutId: removalCutId,
        successorGeneration: null,
        successorAccountProfileRevision: null,
        fenceEvidenceDigest: digest("7"),
        fenceRevisionDigest: digest("8"),
        now: at(2),
      });
      const removalMembers = [
        { ...memberInput(), cutId: removalCutId },
        { ...secondTargetMemberInput(), cutId: removalCutId },
      ];
      for (const member of removalMembers) removalJournal.addCutMember(member);
      sealInventory(
        removalJournal,
        removalCutId,
        removalMembers,
        digest("9"),
        at(3),
      );
      settle(removalJournal, MEMBER, 4);
      settle(removalJournal, "archmember_archivejournal02", 4);
      removalJournal.markRemovalAwaitingTombstone({
        cutId: removalCutId,
        containmentEvidenceDigest: digest("a"),
        containmentRevisionDigest: digest("b"),
        targets: [
          {
            targetId: TARGET,
            containmentEvidenceDigest: digest("c"),
            containmentRevisionDigest: digest("d"),
          },
          {
            targetId: secondTargetInput().targetId,
            containmentEvidenceDigest: digest("e"),
            containmentRevisionDigest: digest("f"),
          },
        ],
        now: at(5),
      });
      const awaiting = removalDatabase.serialize();
      expect(removalDatabase.query(`
        SELECT account_containment_prior_state
        FROM chat_provider_thread_archive_attempts_v57
        WHERE attempt_id = ?1
      `).get(ATTEMPT)).toEqual({
        account_containment_prior_state: "effect_started",
      });
      expect(removalJournal.reopenTarget(TARGET).currentAttempt.state)
        .toBe("account_contained");
      for (const priorState of [
        "ambiguous",
        "reconciled_applied",
        "reconciled_not_applied",
      ]) {
        expectAccountContainmentPriorStateTamperToFail(awaiting, priorState);
      }
      targetCases.push({
        table: "chat_provider_thread_archive_targets_v57",
        idColumn: "target_id",
        id: TARGET,
        ownerId: TARGET,
        state: "account_contained",
        tamperedState: "open",
        serialized: awaiting,
      });
      attemptCases.push({
        table: "chat_provider_thread_archive_attempts_v57",
        idColumn: "attempt_id",
        id: ATTEMPT,
        ownerId: TARGET,
        state: "account_contained",
        tamperedState: "prepared",
        serialized: awaiting,
      });
      cutCases.push({
        table: "chat_provider_thread_archive_cuts_v57",
        idColumn: "cut_id",
        id: removalCutId,
        ownerId: removalCutId,
        state: "removal_awaiting_tombstone",
        tamperedState: "sealed",
        serialized: awaiting,
      });
      const removedAt = at(6).toISOString();
      const profileRevision = tombstoneAccountProfile(removalDatabase, removedAt);
      removalJournal.markRemovalTombstoned({
        cutId: removalCutId,
        tombstoneEvidenceDigest: digest("1"),
        tombstoneRevisionDigest: digest("2"),
        accountProfileRevision: profileRevision,
        removedAt,
        localDataDeletedAt: null,
        profilePreimageDigest:
          providerThreadArchiveAccountTombstonePreimageDigestV57({
            accountProfileId: ACCOUNT,
            accountProfileRevision: profileRevision,
            processGeneration: 1,
            removedAt,
            localDataDeletedAt: null,
          }),
        now: at(6),
      });
      cutCases.push({
        table: "chat_provider_thread_archive_cuts_v57",
        idColumn: "cut_id",
        id: removalCutId,
        ownerId: removalCutId,
        state: "contained",
        tamperedState: "removal_awaiting_tombstone",
        serialized: removalDatabase.serialize(),
      });
    } finally {
      removalDatabase.close();
    }

    journal.markEffectStarted({
      attemptId: ATTEMPT,
      effectEvidenceDigest: digest("1"),
      effectRevisionDigest: digest("2"),
      now: at(1),
    });
    attemptCases.push({
      table: "chat_provider_thread_archive_attempts_v57",
      idColumn: "attempt_id",
      id: ATTEMPT,
      ownerId: TARGET,
      state: "effect_started",
      tamperedState: "prepared",
      serialized: database.serialize(),
    });
    journal.createCut(cutInput());
    journal.bindAllAffectedTargets(CUT);
    journal.recordAmbiguous({
      attemptId: ATTEMPT,
      ambiguityEvidenceDigest: digest("7"),
      ambiguityRevisionDigest: digest("8"),
      now: at(3),
    });
    const ambiguous = database.serialize();
    attemptCases.push({
      table: "chat_provider_thread_archive_attempts_v57",
      idColumn: "attempt_id",
      id: ATTEMPT,
      ownerId: TARGET,
      state: "ambiguous",
      tamperedState: "prepared",
      serialized: ambiguous,
    });
    cutCases.push({
      table: "chat_provider_thread_archive_cuts_v57",
      idColumn: "cut_id",
      id: CUT,
      ownerId: CUT,
      state: "fence_started",
      tamperedState: "fenced",
      serialized: ambiguous,
    });

    journal.recordFence({
      cutId: CUT,
      successorGeneration: 2,
      successorAccountProfileRevision: advanceAccountGeneration(database, 2),
      fenceEvidenceDigest: digest("9"),
      fenceRevisionDigest: digest("a"),
      now: at(4),
    });
    cutCases.push({
      table: "chat_provider_thread_archive_cuts_v57",
      idColumn: "cut_id",
      id: CUT,
      ownerId: CUT,
      state: "fenced",
      tamperedState: "fence_started",
      serialized: database.serialize(),
    });
    const members = [memberInput(), secondTargetMemberInput()];
    for (const member of members) journal.addCutMember(member);
    sealInventory(journal, CUT, members, digest("b"), at(5));
    const sealed = database.serialize();
    cutCases.push({
      table: "chat_provider_thread_archive_cuts_v57",
      idColumn: "cut_id",
      id: CUT,
      ownerId: CUT,
      state: "sealed",
      tamperedState: "fenced",
      serialized: sealed,
    });
    memberCases.push({
      table: "chat_provider_thread_archive_cut_members_v57",
      idColumn: "member_id",
      id: MEMBER,
      ownerId: CUT,
      state: "pending",
      tamperedState: "settled",
      serialized: sealed,
    });
    settle(journal, MEMBER, 6);
    settle(journal, "archmember_archivejournal02", 6);
    memberCases.push({
      table: "chat_provider_thread_archive_cut_members_v57",
      idColumn: "member_id",
      id: MEMBER,
      ownerId: CUT,
      state: "settled",
      tamperedState: "pending",
      serialized: database.serialize(),
    });
    journal.markCutContained({
      cutId: CUT,
      containmentEvidenceDigest: digest("c"),
      containmentRevisionDigest: digest("d"),
      now: at(7),
    });
    cutCases.push({
      table: "chat_provider_thread_archive_cuts_v57",
      idColumn: "cut_id",
      id: CUT,
      ownerId: CUT,
      state: "contained",
      tamperedState: "sealed",
      serialized: database.serialize(),
    });
    journal.recordReconciledApplied({
      attemptId: ATTEMPT,
      responseGeneration: 2,
      responseStreamPosition: 4,
      outcomeEvidenceDigest: digest("e"),
      outcomeRevisionDigest: digest("f"),
      now: at(8),
    });
    journal.recordReconciledNotApplied({
      attemptId: secondTargetInput().attempt.attemptId,
      outcomeEvidenceDigest: digest("0"),
      outcomeRevisionDigest: digest("1"),
      now: at(8),
    });
    const reconciled = database.serialize();
    attemptCases.push({
      table: "chat_provider_thread_archive_attempts_v57",
      idColumn: "attempt_id",
      id: ATTEMPT,
      ownerId: TARGET,
      state: "reconciled_applied",
      tamperedState: "ambiguous",
      serialized: reconciled,
    });
    attemptCases.push({
      table: "chat_provider_thread_archive_attempts_v57",
      idColumn: "attempt_id",
      id: secondTargetInput().attempt.attemptId,
      ownerId: secondTargetInput().targetId,
      state: "reconciled_not_applied",
      tamperedState: "prepared",
      serialized: reconciled,
    });

    expect(attemptCases.map(({ state }) => state).sort()).toEqual([
      "abandoned_pre_effect",
      "account_contained",
      "ambiguous",
      "direct_applied",
      "effect_started",
      "prepared",
      "reconciled_applied",
      "reconciled_not_applied",
    ]);
    expect(cutCases.map(({ state }) => state).sort()).toEqual([
      "contained",
      "contained",
      "fence_started",
      "fenced",
      "removal_awaiting_tombstone",
      "sealed",
    ]);
    expect(memberCases.map(({ state }) => state).sort()).toEqual([
      "pending",
      "settled",
    ]);
    expect(targetCases.map(({ state }) => state).sort()).toEqual([
      "account_contained",
      "committed",
      "open",
    ]);
    for (const scenario of [
      ...targetCases,
      ...attemptCases,
      ...cutCases,
      ...memberCases,
    ]) {
      expectStateOnlyTamperToFail(scenario);
    }
  });
});

test("crash reopen validates each durable cut phase without replaying an effect", () => {
  withFixture(({ database, journal }) => {
    prepareEffect(journal);
    const reopen = () => new ProviderThreadArchiveJournalV57(
      Database.deserialize(database.serialize(), { strict: true }),
      KEY,
    );
    let recovered = reopen();
    expect(recovered.reopenTarget(TARGET).currentAttempt.state).toBe("effect_started");
    journal.createCut(cutInput());
    recovered = reopen();
    expect(recovered.recoveryInventory()).toMatchObject({
      activeCuts: [{
        cutId: CUT,
        initiatingAttemptId: ATTEMPT,
        state: "fence_started",
      }],
      admissionDescriptors: [{ cutAuthority: null, attemptPhase: "effect_started" }],
    });
    journal.bindAttemptToCut(ATTEMPT, CUT);
    journal.recordAmbiguous({
      attemptId: ATTEMPT,
      ambiguityEvidenceDigest: digest("7"),
      ambiguityRevisionDigest: digest("8"),
      now: at(3),
    });
    recovered = reopen();
    expect(recovered.reopenCut(CUT).state).toBe("fence_started");
    journal.recordFence({
      cutId: CUT,
      successorGeneration: 2,
      successorAccountProfileRevision: advanceAccountGeneration(database, 2),
      fenceEvidenceDigest: digest("9"),
      fenceRevisionDigest: digest("a"),
      now: at(4),
    });
    journal.addCutMember(memberInput());
    expect(() => sealInventory(
      journal,
      CUT,
      [memberInput(), siblingMemberInput()],
      digest("b"),
      at(5),
    )).toThrow("do not equal the complete enumeration");
    journal.addCutMember(siblingMemberInput());
    sealInventory(
      journal,
      CUT,
      [memberInput(), siblingMemberInput()],
      digest("b"),
      at(5),
    );
    recovered = reopen();
    expect(recovered.reopenCut(CUT)).toMatchObject({
      state: "sealed",
      members: [{ state: "pending" }, { state: "pending" }],
    });
    settle(journal, MEMBER, 6);
    settle(journal, "archmember_archivejournal02", 6);
    journal.markCutContained({
      cutId: CUT,
      containmentEvidenceDigest: digest("c"),
      containmentRevisionDigest: digest("d"),
      now: at(7),
    });
    recovered = reopen();
    expect(recovered.reopenCut(CUT)).toMatchObject({
      state: "contained",
      members: [{ state: "settled" }, { state: "settled" }],
    });
  });
});

test("journal mutators compose with an owning SQLite transaction and roll back atomically", () => {
  withFixture(({ database, journal }) => {
    const prepareAndFail = database.transaction(() => {
      journal.prepareTarget(targetInput());
      database.query("UPDATE chat_panes SET revision = revision + 1 WHERE pane_id = ?1").run(PANE);
      throw new Error("outer rollback");
    });
    expect(prepareAndFail).toThrow("outer rollback");
    expect(database.query(
      "SELECT COUNT(*) AS count FROM chat_provider_thread_archive_targets_v57",
    ).get()).toEqual({ count: 0 });
    expect(database.query("SELECT revision FROM chat_panes WHERE pane_id = ?1").get(PANE))
      .toEqual({ revision: 1 });

    prepareEffect(journal);
    journal.createCut(cutInput());
    journal.bindAllAffectedTargets(CUT);
    journal.recordAmbiguous({
      attemptId: ATTEMPT,
      ambiguityEvidenceDigest: digest("7"),
      ambiguityRevisionDigest: digest("8"),
      now: at(3),
    });
    journal.recordFence({
      cutId: CUT,
      successorGeneration: 2,
      successorAccountProfileRevision: advanceAccountGeneration(database, 2),
      fenceEvidenceDigest: digest("9"),
      fenceRevisionDigest: digest("a"),
      now: at(4),
    });
    journal.addCutMember(memberInput());
    sealInventory(journal, CUT, [memberInput()], digest("b"), at(5));
    const settleAndFail = database.transaction(() => {
      settle(journal, MEMBER, 6);
      database.query("UPDATE chat_panes SET revision = revision + 1 WHERE pane_id = ?1").run(PANE);
      throw new Error("outer rollback");
    });
    expect(settleAndFail).toThrow("outer rollback");
    expect(journal.reopenCut(CUT)).toMatchObject({
      state: "sealed",
      members: [{ memberId: MEMBER, state: "pending" }],
    });
    expect(database.query("SELECT revision FROM chat_panes WHERE pane_id = ?1").get(PANE))
      .toEqual({ revision: 1 });
  });
});

test("account-removal cut has no invented target and is enumerated separately", () => {
  withFixture(({ journal }) => {
    const removal = journal.createCut({
      ...cutInput(),
      cutId: "archcut_removaljournal01",
      cause: "account_removal",
      initiatingAttemptId: null,
    });
    expect(removal).toMatchObject({ targetCount: 0, cause: "account_removal", state: "fence_started" });
    expect(journal.recoveryInventory()).toMatchObject({
      admissionDescriptors: [],
      removalCuts: [{ cutId: "archcut_removaljournal01" }],
    });
  });
});

test("zero-target removal cleanup requires exact tombstone authority and removes member residue atomically", () => {
  withFixture(({ database, journal }) => {
    const cutId = "archcut_removalcleanup01";
    const member = {
      ...siblingMemberInput(),
      cutId,
      memberId: "archmember_removalcleanup01",
    };
    journal.createCut({
      ...cutInput(),
      cutId,
      cause: "account_removal",
      initiatingAttemptId: null,
    });
    journal.recordFence({
      cutId,
      successorGeneration: null,
      successorAccountProfileRevision: null,
      fenceEvidenceDigest: digest("1"),
      fenceRevisionDigest: digest("2"),
      now: at(2),
    });
    journal.addCutMember(member);
    sealInventory(journal, cutId, [member], digest("3"), at(3));
    settle(journal, member.memberId, 4);
    journal.markRemovalAwaitingTombstone({
      cutId,
      containmentEvidenceDigest: digest("4"),
      containmentRevisionDigest: digest("5"),
      targets: [],
      now: at(5),
    });
    expect(() => journal.deleteContainedZeroTargetRemovalCutSafely(cutId))
      .toThrow("not a contained zero-target account removal");

    const removedAt = at(6).toISOString();
    const localDataDeletedAt = at(7).toISOString();
    const accountProfileRevision = tombstoneAccountProfile(
      database,
      removedAt,
      localDataDeletedAt,
    );
    const profilePreimageDigest =
      providerThreadArchiveAccountTombstonePreimageDigestV57({
        accountProfileId: ACCOUNT,
        accountProfileRevision,
        processGeneration: 1,
        removedAt,
        localDataDeletedAt,
      });
    expect(journal.markRemovalTombstoned({
      cutId,
      tombstoneEvidenceDigest: digest("6"),
      tombstoneRevisionDigest: digest("7"),
      accountProfileRevision,
      removedAt,
      localDataDeletedAt,
      profilePreimageDigest,
      now: at(8),
    })).toMatchObject({
      cause: "account_removal",
      state: "contained",
      targetCount: 0,
      members: [{ memberId: member.memberId, state: "settled" }],
    });

    const tamperedProfile = database.transaction(() => {
      database.query(`
        UPDATE account_profiles SET revision = revision + 1
        WHERE profile_id = ?1
      `).run(ACCOUNT);
      expect(() => journal.deleteContainedZeroTargetRemovalCutSafely(cutId))
        .toThrow("lacks its exact durable account tombstone");
      throw new Error("rollback tombstone authority drift");
    });
    expect(tamperedProfile).toThrow("rollback tombstone authority drift");

    const cleanupAndRollback = database.transaction(() => {
      journal.deleteContainedZeroTargetRemovalCutSafely(cutId);
      expect(database.query(`
        SELECT
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
          (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
            AS members
      `).get()).toEqual({ cuts: 0, members: 0 });
      throw new Error("rollback terminal removal cleanup");
    });
    expect(cleanupAndRollback).toThrow("rollback terminal removal cleanup");
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members
    `).get()).toEqual({ cuts: 1, members: 1 });

    journal.deleteContainedZeroTargetRemovalCutSafely(cutId);
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57)
          AS members
    `).get()).toEqual({ cuts: 0, members: 0 });
  });
});

test("terminal cleanup sweeps committed targets and zero-target removal residue atomically", () => {
  withFixture(({ database, journal }) => {
    const secondTarget = secondTargetInput();
    for (const target of [targetInput(), secondTarget]) {
      journal.prepareTarget(target);
      journal.markEffectStarted({
        attemptId: target.attempt.attemptId,
        effectEvidenceDigest: digest("1"),
        effectRevisionDigest: digest("2"),
        now: at(1),
      });
      journal.recordDirectApplied({
        attemptId: target.attempt.attemptId,
        responseGeneration: 1,
        responseStreamPosition: 1,
        outcomeEvidenceDigest: digest("3"),
        outcomeRevisionDigest: digest("4"),
        now: at(2),
      });
      journal.markTargetCommitted({
        targetId: target.targetId,
        commitEvidenceDigest: digest("5"),
        commitRevisionDigest: digest("6"),
        now: at(3),
      });
    }
    const cutId = "archcut_terminalsweep01";
    const member = {
      ...siblingMemberInput(),
      cutId,
      memberId: "archmember_terminalsweep01",
    };
    journal.createCut({
      ...cutInput(),
      cutId,
      cause: "account_removal",
      initiatingAttemptId: null,
      now: at(4),
    });
    journal.recordFence({
      cutId,
      successorGeneration: null,
      successorAccountProfileRevision: null,
      fenceEvidenceDigest: digest("7"),
      fenceRevisionDigest: digest("8"),
      now: at(5),
    });
    journal.addCutMember(member);
    sealInventory(journal, cutId, [member], digest("9"), at(6));
    settle(journal, member.memberId, 7);
    journal.markRemovalAwaitingTombstone({
      cutId,
      containmentEvidenceDigest: digest("a"),
      containmentRevisionDigest: digest("b"),
      targets: [],
      now: at(8),
    });
    const removedAt = at(9).toISOString();
    const localDataDeletedAt = at(10).toISOString();
    const accountProfileRevision = tombstoneAccountProfile(
      database,
      removedAt,
      localDataDeletedAt,
    );
    journal.markRemovalTombstoned({
      cutId,
      tombstoneEvidenceDigest: digest("c"),
      tombstoneRevisionDigest: digest("d"),
      accountProfileRevision,
      removedAt,
      localDataDeletedAt,
      profilePreimageDigest:
        providerThreadArchiveAccountTombstonePreimageDigestV57({
          accountProfileId: ACCOUNT,
          accountProfileRevision,
          processGeneration: 1,
          removedAt,
          localDataDeletedAt,
        }),
      now: at(11),
    });

    database.exec(`
      CREATE TEMP TRIGGER fail_terminal_authority_sweep
      BEFORE DELETE ON chat_provider_thread_archive_cuts_v57
      WHEN OLD.cut_id = 'archcut_terminalsweep01'
      BEGIN
        SELECT RAISE(ABORT, 'injected terminal sweep failure');
      END;
    `);
    expect(() => journal.deleteAllTerminalAuthoritySafely())
      .toThrow("injected terminal sweep failure");
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
    `).get()).toEqual({ targets: 2, attempts: 2, cuts: 1, members: 1 });

    database.exec("DROP TRIGGER fail_terminal_authority_sweep");
    expect(journal.deleteAllTerminalAuthoritySafely()).toEqual({
      deletedTargetIds: [TARGET, secondTarget.targetId].toSorted(),
      deletedCutIds: [cutId],
    });
    expect(journal.deleteAllTerminalAuthoritySafely()).toEqual({
      deletedTargetIds: [],
      deletedCutIds: [],
    });
    expect(database.query(`
      SELECT
        (SELECT COUNT(*) FROM chat_provider_thread_archive_targets_v57) AS targets,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_attempts_v57) AS attempts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cuts_v57) AS cuts,
        (SELECT COUNT(*) FROM chat_provider_thread_archive_cut_members_v57) AS members
    `).get()).toEqual({ targets: 0, attempts: 0, cuts: 0, members: 0 });
  });
});

test("published quotas are exact and max plus one fails closed", () => {
  expect(PROVIDER_THREAD_ARCHIVE_MAX_ACTIVE_TARGETS_V57).toBe(64);
  expect(PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57).toBe(8);
  expect(PROVIDER_THREAD_ARCHIVE_MAX_CUTS_PER_ACCOUNT_V57).toBe(8);
  expect(PROVIDER_THREAD_ARCHIVE_MAX_MEMBERS_PER_CUT_V57).toBe(64);
  withFixture(({ database, journal }) => {
    prepareEffect(journal);
    journal.createCut(cutInput());
    journal.bindAttemptToCut(ATTEMPT, CUT);
    journal.recordAmbiguous({
      attemptId: ATTEMPT,
      ambiguityEvidenceDigest: digest("7"),
      ambiguityRevisionDigest: digest("8"),
      now: at(3),
    });
    journal.recordFence({
      cutId: CUT,
      successorGeneration: 2,
      successorAccountProfileRevision: advanceAccountGeneration(database, 2),
      fenceEvidenceDigest: digest("9"),
      fenceRevisionDigest: digest("a"),
      now: at(4),
    });
    database.exec("DROP TRIGGER chat_provider_thread_archive_member_insert_guard_v57");
    for (let ordinal = 1; ordinal <= 64; ordinal += 1) {
      database.query(`
        INSERT INTO chat_provider_thread_archive_cut_members_v57 (
          member_id, cut_id, ordinal, pane_id, pane_revision, pane_cas_digest,
          thread_id, restart_thread_id, role, target_id, attempt_id,
          target_attempt_ordinal, action,
          binding_id, binding_key_digest, binding_revision,
          identity_evidence_digest, identity_revision_digest,
          identity_hmac, state, created_at
        ) VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7,
          'sibling', NULL, NULL, NULL, 'detach_binding_only',
          NULL, NULL, NULL, ?8, ?9, ?10, 'pending', ?11)
      `).run(
        `archmember_quota${String(ordinal).padStart(3, "0")}`,
        CUT,
        ordinal,
        `pane_quota${String(ordinal).padStart(5, "0")}`,
        digest("a"),
        `thread_quota${ordinal}`,
        `restart_quota${ordinal}`,
        digest("b"),
        digest("c"),
        digest("d"),
        NOW.toISOString(),
      );
    }
    expect(() => database.query(`
      INSERT INTO chat_provider_thread_archive_cut_members_v57 (
        member_id, cut_id, ordinal, pane_id, pane_revision, pane_cas_digest,
        thread_id, restart_thread_id, role, target_id, attempt_id,
        target_attempt_ordinal, action,
        binding_id, binding_key_digest, binding_revision,
        identity_evidence_digest, identity_revision_digest,
        identity_hmac, state, created_at
      ) VALUES ('archmember_quota065', ?1, 64, 'pane_quota00065',
        1, ?2, 'thread_quota65', 'restart_quota65',
        'sibling', NULL, NULL, NULL, 'detach_binding_only',
        NULL, NULL, NULL, ?2, ?2, ?2, 'pending', ?3)
    `).run(CUT, digest("e"), NOW.toISOString())).toThrow("member limit reached");
  });
});

test("attempt quota accepts eight immutable generations and rejects nine", () => {
  withFixture(({ database, journal }) => {
    journal.prepareTarget(targetInput());
    let currentAttemptId = ATTEMPT;
    for (let ordinal = 1; ordinal <= PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57; ordinal += 1) {
      journal.recordPreparedNotStarted({
        attemptId: currentAttemptId,
        outcomeEvidenceDigest: digest("1"),
        outcomeRevisionDigest: digest("2"),
        now: at(ordinal),
      });
      if (ordinal < PROVIDER_THREAD_ARCHIVE_MAX_ATTEMPTS_PER_TARGET_V57) {
        currentAttemptId = "archattempt_quota00" + (ordinal + 1);
        const profileRevision = advanceAccountGeneration(database, ordinal + 1);
        journal.appendSuccessorAttempt({
          targetId: TARGET,
          attemptId: currentAttemptId,
          generation: ordinal + 1,
          accountProfileRevision: profileRevision,
          requestEvidenceDigest: digest("3"),
          requestRevisionDigest: digest("4"),
          now: at(ordinal + 20),
        });
      }
    }
    expect(journal.reopenTarget(TARGET).attempts).toHaveLength(8);
    const ninthProfileRevision = advanceAccountGeneration(database, 9);
    expect(() => journal.appendSuccessorAttempt({
      targetId: TARGET,
      attemptId: "archattempt_quota009",
      generation: 9,
      accountProfileRevision: ninthProfileRevision,
      requestEvidenceDigest: digest("5"),
      requestRevisionDigest: digest("6"),
      now: at(40),
    })).toThrow("attempt limit reached");
  });
});

test("cut quota accepts eight retained cuts per account and rejects nine", () => {
  withFixture(({ database, journal }) => {
    database.exec("DROP INDEX chat_provider_thread_archive_one_active_cut_v57");
    database.exec("DROP TRIGGER chat_provider_thread_archive_cut_insert_guard_v57");
    for (let ordinal = 1; ordinal <= PROVIDER_THREAD_ARCHIVE_MAX_CUTS_PER_ACCOUNT_V57; ordinal += 1) {
      journal.createCut({
        cutId: "archcut_quota00" + ordinal,
        accountProfileId: ACCOUNT,
        accountProfileRevision: 1,
        sourceGeneration: 1,
        cause: "account_removal",
        initiatingAttemptId: null,
        predecessorCutId: null,
        identityEvidenceDigest: digest("7"),
        identityRevisionDigest: digest("8"),
        now: at(ordinal),
      });
    }
    expect(() => journal.createCut({
      cutId: "archcut_quota009",
      accountProfileId: ACCOUNT,
      accountProfileRevision: 1,
      sourceGeneration: 1,
      cause: "account_removal",
      initiatingAttemptId: null,
      predecessorCutId: null,
      identityEvidenceDigest: digest("7"),
      identityRevisionDigest: digest("8"),
      now: at(9),
    })).toThrow("cut limit reached");
  });
});

test("active target quota accepts sixty-four panes and rejects sixty-five", () => {
  withFixture(({ database, journal }) => {
    database.exec("DELETE FROM chat_provider_attachment_bindings");
    const panes = new ChatPaneStore(database);
    for (let ordinal = 1; ordinal <= PROVIDER_THREAD_ARCHIVE_MAX_ACTIVE_TARGETS_V57; ordinal += 1) {
      const paneId = ordinal === 1
        ? PANE
        : ordinal === 2
          ? SIBLING_PANE
          : "pane_targetquota" + String(ordinal).padStart(3, "0");
      const threadId = "thread_targetquota" + ordinal;
      const restartThreadId = "restart_targetquota" + ordinal;
      if (ordinal > 2) {
        panes.create({
          paneId,
          repository: {
            id: REPOSITORY,
            name: "Archive journal",
            workingDirectory: "/fixture/archive-journal",
          },
          accountProfileId: ACCOUNT,
          now: at(ordinal),
        });
      }
      database.query(
        "UPDATE chat_panes SET provider_account_profile_id = ?2, " +
        "provider_thread_id = ?3, provider_restart_thread_id = ?4 WHERE pane_id = ?1",
      ).run(paneId, ACCOUNT, threadId, restartThreadId);
      const prepare = () => journal.prepareTarget({
        ...targetInput(),
        targetId: "archtarget_quota" + String(ordinal).padStart(3, "0"),
        paneId,
        threadId,
        restartThreadId,
        binding: { kind: "none" },
        attempt: {
          attemptId: "archattempt_quota" + String(ordinal).padStart(3, "0"),
          generation: 1,
          accountProfileRevision: 1,
          requestEvidenceDigest: digest("9"),
          requestRevisionDigest: digest("a"),
        },
      });
      prepare();
    }
    expect(journal.recoveryTargets()).toHaveLength(64);
    database.exec("DROP INDEX chat_provider_thread_archive_one_open_target_v57");
    expect(() => journal.prepareTarget({
      ...targetInput(),
      targetId: "archtarget_quota065",
      threadId: "thread_targetquota1",
      restartThreadId: "restart_targetquota1",
      binding: { kind: "none" },
      attempt: {
        attemptId: "archattempt_quota065",
        generation: 1,
        accountProfileRevision: 1,
        requestEvidenceDigest: digest("b"),
        requestRevisionDigest: digest("c"),
      },
    })).toThrow("active target limit reached");
  });
});

interface Fixture {
  readonly database: Database;
  readonly journal: ProviderThreadArchiveJournalV57;
}

interface StateTamperCase {
  readonly table:
    | "chat_provider_thread_archive_targets_v57"
    | "chat_provider_thread_archive_attempts_v57"
    | "chat_provider_thread_archive_cuts_v57"
    | "chat_provider_thread_archive_cut_members_v57";
  readonly idColumn: "target_id" | "attempt_id" | "cut_id" | "member_id";
  readonly id: string;
  readonly ownerId: string;
  readonly state: string;
  readonly tamperedState: string;
  readonly serialized: Uint8Array;
}

function expectStateOnlyTamperToFail(scenario: StateTamperCase): void {
  const database = Database.deserialize(scenario.serialized, { strict: true });
  try {
    const phaseColumn = scenario.table === "chat_provider_thread_archive_targets_v57"
      ? "status"
      : "state";
    const observed = database.query<{ state: string }, [string]>(`
      SELECT ${phaseColumn} AS state FROM ${scenario.table}
      WHERE ${scenario.idColumn} = ?1
    `).get(scenario.id);
    expect(observed).toEqual({ state: scenario.state });
    const triggers = database.query<{ name: string }, [string]>(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = ?1
    `).all(scenario.table);
    for (const { name } of triggers) {
      database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    database.exec("PRAGMA ignore_check_constraints = ON");
    const updated = database.query(`
      UPDATE ${scenario.table} SET ${phaseColumn} = ?2
      WHERE ${scenario.idColumn} = ?1
    `).run(scenario.id, scenario.tamperedState);
    expect(updated.changes).toBe(1);
    const reopened = new ProviderThreadArchiveJournalV57(database, KEY);
    if (
      scenario.table === "chat_provider_thread_archive_targets_v57"
      || scenario.table === "chat_provider_thread_archive_attempts_v57"
    ) {
      expect(() => reopened.reopenTarget(scenario.ownerId)).toThrow();
      if (scenario.table === "chat_provider_thread_archive_attempts_v57") {
        expect(() => reopened.admissionDescriptor(scenario.ownerId)).toThrow();
      }
    } else {
      expect(() => reopened.reopenCut(scenario.ownerId)).toThrow();
    }
  } finally {
    database.close();
  }
}

function expectAccountContainmentPriorStateTamperToFail(
  serialized: Uint8Array,
  priorState: string,
): void {
  const database = Database.deserialize(serialized, { strict: true });
  try {
    const table = "chat_provider_thread_archive_attempts_v57";
    const triggers = database.query<{ name: string }, [string]>(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = ?1
    `).all(table);
    for (const { name } of triggers) {
      database.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
    }
    database.exec("PRAGMA ignore_check_constraints = ON");
    const updated = database.query(`
      UPDATE chat_provider_thread_archive_attempts_v57
      SET account_containment_prior_state = ?2
      WHERE attempt_id = ?1
    `).run(ATTEMPT, priorState);
    expect(updated.changes).toBe(1);
    const reopened = new ProviderThreadArchiveJournalV57(database, KEY);
    expect(() => reopened.reopenTarget(TARGET)).toThrow();
    expect(() => reopened.admissionDescriptor(TARGET)).toThrow();
  } finally {
    database.close();
  }
}

function withFixture(run: (fixture: Fixture) => void): void {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Archive journal', 'signed_in', 1, 1, ?2, ?2)
    `).run(ACCOUNT, NOW.toISOString());
    const panes = new ChatPaneStore(database);
    for (const [paneId, thread, restart, binding] of [
      [PANE, THREAD, RESTART, BINDING],
      [SIBLING_PANE, "thread_archivejournal02", "restart_archivejournal02", SIBLING_BINDING],
    ] as const) {
      panes.create({
        paneId,
        repository: {
          id: REPOSITORY,
          name: "Archive journal",
          workingDirectory: "/fixture/archive-journal",
        },
        accountProfileId: ACCOUNT,
        now: NOW,
      });
      database.query(`
        UPDATE chat_panes SET
          provider_account_profile_id = ?2,
          provider_thread_id = ?3,
          provider_restart_thread_id = ?4
        WHERE pane_id = ?1
      `).run(paneId, ACCOUNT, thread, restart);
      database.query(`
        INSERT INTO chat_provider_attachment_bindings (
          binding_id, binding_key_digest, pane_id, revision, state,
          acquired_at, updated_at
        ) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)
      `).run(binding, digest("a"), paneId, NOW.toISOString());
    }
    run({ database, journal: new ProviderThreadArchiveJournalV57(database, KEY) });
  } finally {
    database.close();
  }
}

function targetInput() {
  return {
    targetId: TARGET,
    paneId: PANE,
    purpose: "pane_archive" as const,
    paneRevision: 1,
    queueRevision: null,
    paneCasDigest: digest("1"),
    queueCasDigest: null,
    accountProfileId: ACCOUNT,
    accountProfileRevision: 1,
    threadId: THREAD,
    restartThreadId: RESTART,
    binding: {
      kind: "exact" as const,
      bindingId: BINDING,
      bindingKeyDigest: digest("a"),
      bindingRevision: 1,
    },
    attempt: {
      attemptId: ATTEMPT,
      generation: 1,
      accountProfileRevision: 1,
      requestEvidenceDigest: digest("2"),
      requestRevisionDigest: digest("3"),
    },
    now: NOW,
  };
}

function cutInput() {
  return {
    cutId: CUT,
    accountProfileId: ACCOUNT,
    accountProfileRevision: 1,
    sourceGeneration: 1,
    cause: "lost_response" as const,
    initiatingAttemptId: ATTEMPT,
    predecessorCutId: null,
    identityEvidenceDigest: digest("4"),
    identityRevisionDigest: digest("5"),
    now: at(2),
  };
}

function memberInput() {
  return {
    memberId: MEMBER,
    cutId: CUT,
    paneId: PANE,
    paneRevision: 1,
    paneCasDigest: digest("1"),
    threadId: THREAD,
    restartThreadId: RESTART,
    role: "target" as const,
    targetId: TARGET,
    attemptId: ATTEMPT,
    targetAttemptOrdinal: 1,
    action: "preserved_target" as const,
    binding: {
      kind: "exact" as const,
      bindingId: BINDING,
      bindingKeyDigest: digest("a"),
      bindingRevision: 1,
    },
    identityEvidenceDigest: digest("6"),
    identityRevisionDigest: digest("7"),
    now: at(5),
  };
}

function secondTargetInput() {
  return {
    ...targetInput(),
    targetId: "archtarget_archivejournal02",
    paneId: SIBLING_PANE,
    threadId: "thread_archivejournal02",
    restartThreadId: "restart_archivejournal02",
    binding: {
      kind: "exact" as const,
      bindingId: SIBLING_BINDING,
      bindingKeyDigest: digest("a"),
      bindingRevision: 1,
    },
    attempt: {
      attemptId: "archattempt_archivejournal02",
      generation: 1,
      accountProfileRevision: 1,
      requestEvidenceDigest: digest("8"),
      requestRevisionDigest: digest("9"),
    },
  };
}

function secondTargetMemberInput() {
  return {
    ...memberInput(),
    memberId: "archmember_archivejournal02",
    paneId: SIBLING_PANE,
    threadId: "thread_archivejournal02",
    restartThreadId: "restart_archivejournal02",
    targetId: "archtarget_archivejournal02",
    attemptId: "archattempt_archivejournal02",
    binding: {
      kind: "exact" as const,
      bindingId: SIBLING_BINDING,
      bindingKeyDigest: digest("a"),
      bindingRevision: 1,
    },
  };
}

function siblingMemberInput(): AddProviderThreadArchiveCutMemberV57 {
  return {
    ...memberInput(),
    memberId: "archmember_archivejournal02",
    paneId: SIBLING_PANE,
    threadId: "thread_archivejournal02",
    restartThreadId: "restart_archivejournal02",
    role: "sibling",
    targetId: null,
    attemptId: null,
    targetAttemptOrdinal: null,
    action: "detach_binding_only",
    binding: {
      kind: "exact",
      bindingId: SIBLING_BINDING,
      bindingKeyDigest: digest("a"),
      bindingRevision: 1,
    },
    identityEvidenceDigest: digest("b"),
  };
}

function sealInventory(
  journal: ProviderThreadArchiveJournalV57,
  cutId: string,
  members: readonly AddProviderThreadArchiveCutMemberV57[],
  sealRevisionDigest: string,
  now: Date,
) {
  return journal.sealCutInventory({
    cutId,
    expectedMemberCount: members.length,
    expectedInventoryDigest:
      providerThreadArchiveCompleteInventoryDigestV57(members),
    enumerationAuthorityDigest: digest("d"),
    sealRevisionDigest,
    now,
  });
}

function advanceAccountGeneration(database: Database, generation: number): number {
  const profile = database.query<
    { process_generation: number; revision: number },
    [string]
  >(`
    SELECT process_generation, revision FROM account_profiles
    WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null || generation !== profile.process_generation + 1) {
    throw new Error("Fixture account generation cannot advance");
  }
  const revision = profile.revision + 1;
  const updated = database.query(`
    UPDATE account_profiles SET process_generation = ?2,
      revision = ?3, updated_at = ?4
    WHERE profile_id = ?1 AND revision = ?5 AND removed_at IS NULL
  `).run(ACCOUNT, generation, revision, at(generation).toISOString(), profile.revision);
  if (updated.changes !== 1) throw new Error("Fixture account generation changed");
  return revision;
}

function tombstoneAccountProfile(
  database: Database,
  removedAt: string,
  localDataDeletedAt: string | null = null,
): number {
  const profile = database.query<{ revision: number }, [string]>(`
    SELECT revision FROM account_profiles WHERE profile_id = ?1
  `).get(ACCOUNT);
  if (profile === null) throw new Error("Fixture account profile is missing");
  const revision = profile.revision + 1;
  const updated = database.query(`
    UPDATE account_profiles SET removed_at = ?2, selected = 0,
      local_data_deleted_at = ?3,
      identity_label = NULL, plan_label = NULL, auth_state = 'signedOut',
      revision = ?4, updated_at = COALESCE(?3, ?2)
    WHERE profile_id = ?1 AND revision = ?5 AND removed_at IS NULL
  `).run(ACCOUNT, removedAt, localDataDeletedAt, revision, profile.revision);
  if (updated.changes !== 1) throw new Error("Fixture account tombstone changed");
  return revision;
}

function prepareEffect(journal: ProviderThreadArchiveJournalV57): void {
  journal.prepareTarget(targetInput());
  journal.markEffectStarted({
    attemptId: ATTEMPT,
    effectEvidenceDigest: digest("1"),
    effectRevisionDigest: digest("2"),
    now: at(1),
  });
}

function containedAmbiguity(
  database: Database,
  journal: ProviderThreadArchiveJournalV57,
): void {
  prepareEffect(journal);
  journal.createCut(cutInput());
  journal.bindAttemptToCut(ATTEMPT, CUT);
  journal.recordAmbiguous({
    attemptId: ATTEMPT,
    ambiguityEvidenceDigest: digest("7"),
    ambiguityRevisionDigest: digest("8"),
    now: at(3),
  });
  journal.recordFence({
    cutId: CUT,
    successorGeneration: 2,
    successorAccountProfileRevision: advanceAccountGeneration(database, 2),
    fenceEvidenceDigest: digest("9"),
    fenceRevisionDigest: digest("a"),
    now: at(4),
  });
  journal.addCutMember(memberInput());
  sealInventory(journal, CUT, [memberInput()], digest("b"), at(5));
  settle(journal, MEMBER, 6);
  journal.markCutContained({
    cutId: CUT,
    containmentEvidenceDigest: digest("c"),
    containmentRevisionDigest: digest("d"),
    now: at(7),
  });
}

function settle(journal: ProviderThreadArchiveJournalV57, memberId: string, offset: number): void {
  journal.settleMember({
    memberId,
    settlementEvidenceDigest: digest("e"),
    settlementRevisionDigest: digest("f"),
    now: at(offset),
  });
}

function digest(character: string): string {
  return character.repeat(64);
}

function at(offset: number): Date {
  return new Date(NOW.getTime() + offset * 1_000);
}
