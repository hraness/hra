import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  HRA_HUMAN_KEYCHAIN_SERVICE,
  HRA_RUNNER_KEYCHAIN_SERVICE,
} from "@hraness/hra-human-client";

import {
  parseInstallationHandoffJournal,
  readKeychainTargets,
} from "../installation-handoff";

const tree = {
  bytes: 1,
  directories: 0,
  digest: "a".repeat(64),
  entries: 1,
  files: 1,
  symlinks: 0,
};

function receipt(
  priorHraIdentity?: Readonly<{
    build: "8" | "9" | "10";
    version: "0.1.7" | "0.1.8" | "0.1.9";
  }>,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    createdAt: 1,
    operationId: `handoff_${"a".repeat(24)}`,
    phase: "committed",
    candidateCommit: "b".repeat(40),
    hadPriorHra: priorHraIdentity !== undefined,
    state: {
      accountHomes: 0,
      chatWorktreeLanes: 0,
      database: {
        databaseSha256: "c".repeat(64),
        migrationVersion: 37,
        quickCheck: "ok",
        rows: { account_profiles: 1 },
      },
      dispatchWorktreeLanes: 0,
      harnessWorktreeLanes: 0,
      localTaskWorktreeLanes: 0,
      sessionEntries: 0,
      tree,
    },
    predecessor: {
      identity: {
        build: "5",
        bundleIdentifier: "kitchen.hraness",
        executable: "oprte",
        version: "0.1.4",
      },
      tree,
    },
    candidate: {
      identity: {
        build: "11",
        bundleIdentifier: "kitchen.hraness",
        executable: "hra",
        version: "0.1.10",
      },
      tree,
    },
    ...(priorHraIdentity === undefined ? {} : {
      priorHra: {
        identity: {
          build: priorHraIdentity.build,
          bundleIdentifier: "kitchen.hraness",
          executable: "hra",
          version: priorHraIdentity.version,
        },
        tree,
      },
    }),
    keychainDescriptors: ["service\u0000name"],
  };
}

describe("installation handoff receipt schema", () => {
  test("accepts only the exact v0.1.10 build-11 evidence shape", () => {
    expect(parseInstallationHandoffJournal(receipt())).toMatchObject({
      phase: "committed",
      candidateCommit: "b".repeat(40),
    });
  });

  test("retains exact v0.1.7, v0.1.8, and immutable v0.1.9 prior-HRA rollback evidence", () => {
    for (const priorHraIdentity of [
      { build: "8", version: "0.1.7" },
      { build: "9", version: "0.1.8" },
      { build: "10", version: "0.1.9" },
    ] as const) {
      expect(parseInstallationHandoffJournal(receipt(priorHraIdentity)))
        .toMatchObject({
          hadPriorHra: true,
          priorHra: { identity: priorHraIdentity },
        });
    }
  });

  test("rejects the v0.1.10 candidate as prior-HRA rollback evidence", () => {
    const mutation = receipt();
    mutation["hadPriorHra"] = true;
    mutation["priorHra"] = {
      identity: {
        build: "11",
        bundleIdentifier: "kitchen.hraness",
        executable: "hra",
        version: "0.1.10",
      },
      tree,
    };
    expect(() => parseInstallationHandoffJournal(mutation)).toThrow(
      "Handoff receipt is invalid",
    );
  });

  test("rejects unknown, stale, and inconsistent nested evidence", () => {
    const mutations: Record<string, unknown>[] = [];

    const missingCandidate = receipt();
    delete missingCandidate["candidate"];
    mutations.push(missingCandidate);

    const oldCommitField = receipt();
    oldCommitField["expectedCommit"] = oldCommitField["candidateCommit"];
    mutations.push(oldCommitField);

    const nestedExtra = receipt();
    const candidate = nestedExtra["candidate"] as Record<string, unknown>;
    candidate["tree"] = { ...(candidate["tree"] as object), ignored: true };
    mutations.push(nestedExtra);

    const priorMismatch = receipt();
    priorMismatch["hadPriorHra"] = true;
    mutations.push(priorMismatch);

    const unsortedDescriptors = receipt();
    unsortedDescriptors["keychainDescriptors"] = ["z\u0000z", "a\u0000a"];
    mutations.push(unsortedDescriptors);

    for (const mutation of mutations) {
      expect(() => parseInstallationHandoffJournal(mutation)).toThrow(
        "Handoff receipt is invalid",
      );
    }
  });

  test("rejects prototype-sensitive keys in nested receipt evidence", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const mutation = receipt();
      const candidate = mutation["candidate"] as Record<string, unknown>;
      const candidateTree = candidate["tree"] as Record<string, unknown>;
      candidate["tree"] = Object.fromEntries([
        ...Object.entries(candidateTree),
        [key, []],
      ]);
      expect(Object.hasOwn(candidate["tree"] as object, key)).toBeTrue();
      expect(() => parseInstallationHandoffJournal(mutation)).toThrow(
        "Handoff receipt is invalid",
      );
    }
  });
});

function custodyDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.run(`
    CREATE TABLE human_custody_metadata(
      service TEXT NOT NULL,
      name TEXT NOT NULL,
      journal_json TEXT NOT NULL
    ) STRICT
  `);
  database.run(`
    CREATE TABLE human_custody_pointer_quarantine(
      service TEXT NOT NULL,
      name TEXT NOT NULL,
      pointer_kind TEXT NOT NULL,
      generation INTEGER NOT NULL,
      slot TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      reason TEXT NOT NULL
    ) STRICT
  `);
  return database;
}

function journal(service = HRA_HUMAN_KEYCHAIN_SERVICE): string {
  return JSON.stringify({
    version: 1,
    revision: 1,
    latestGeneration: 1,
    service,
    name: "primary",
    committed: { generation: 1, slot: "generation_slot_1" },
  });
}

describe("installation Keychain inventory schema", () => {
  test("reuses the custody schema for committed and quarantined pointers", () => {
    const database = custodyDatabase();
    try {
      database.query(`
        INSERT INTO human_custody_metadata(service, name, journal_json)
        VALUES (?1, ?2, ?3)
      `).run(HRA_HUMAN_KEYCHAIN_SERVICE, "primary", journal());
      database.query(`
        INSERT INTO human_custody_pointer_quarantine(
          service, name, pointer_kind, generation, slot, source_revision, reason
        ) VALUES (?1, ?2, 'deleting', 2, 'quarantine_slot_2', 1, 'invalid_pointer_preserved')
      `).run(HRA_HUMAN_KEYCHAIN_SERVICE, "primary");
      expect(readKeychainTargets(database)).toContainEqual({
        service: HRA_HUMAN_KEYCHAIN_SERVICE,
        name: "primary:slot:generation_slot_1",
      });
      expect(readKeychainTargets(database)).toContainEqual({
        service: HRA_HUMAN_KEYCHAIN_SERVICE,
        name: "primary:slot:quarantine_slot_2",
      });
    } finally {
      database.close();
    }
  });

  test("rejects malformed nested journals instead of silently skipping pointers", () => {
    const database = custodyDatabase();
    try {
      const malformed = JSON.stringify({
        version: 1,
        revision: 1,
        latestGeneration: 1,
        service: HRA_RUNNER_KEYCHAIN_SERVICE,
        name: "workspace",
        committed: { generation: 1, slot: "short" },
      });
      database.query(`
        INSERT INTO human_custody_metadata(service, name, journal_json)
        VALUES (?1, ?2, ?3)
      `).run(HRA_RUNNER_KEYCHAIN_SERVICE, "workspace", malformed);
      expect(() => readKeychainTargets(database)).toThrow();
    } finally {
      database.close();
    }
  });

  test("rejects row/journal identity drift and unknown custody services", () => {
    for (const [service, value] of [
      [HRA_RUNNER_KEYCHAIN_SERVICE, journal(HRA_HUMAN_KEYCHAIN_SERVICE)],
      ["kitchen.hraness.unreviewed.v1", journal("kitchen.hraness.unreviewed.v1")],
    ] as const) {
      const database = custodyDatabase();
      try {
        database.query(`
          INSERT INTO human_custody_metadata(service, name, journal_json)
          VALUES (?1, 'primary', ?2)
        `).run(service, value);
        expect(() => readKeychainTargets(database)).toThrow();
      } finally {
        database.close();
      }
    }
  });
});
