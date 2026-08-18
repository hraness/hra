import { expect, test } from "bun:test";
import { fc } from "@hra-internal/test";

import { parseInstallationHandoffJournal } from "../installation-handoff";

const validReceipt = {
  schemaVersion: 1,
  createdAt: 1,
  operationId: `handoff_${"a".repeat(24)}`,
  phase: "created",
  candidateCommit: "b".repeat(40),
  hadPriorHra: false,
  state: {
    accountHomes: 0,
    chatWorktreeLanes: 0,
    database: {
      databaseSha256: "c".repeat(64),
      migrationVersion: 37,
      quickCheck: "ok",
      rows: {},
    },
    dispatchWorktreeLanes: 0,
    harnessWorktreeLanes: 0,
    localTaskWorktreeLanes: 0,
    sessionEntries: 0,
    tree: {
      bytes: 0,
      directories: 0,
      digest: "d".repeat(64),
      entries: 0,
      files: 0,
      symlinks: 0,
    },
  },
  predecessor: {
    identity: {
      build: "5",
      bundleIdentifier: "kitchen.hraness",
      executable: "oprte",
      version: "0.1.4",
    },
    tree: {
      bytes: 0,
      directories: 0,
      digest: "e".repeat(64),
      entries: 0,
      files: 0,
      symlinks: 0,
    },
  },
  candidate: {
    identity: {
      build: "11",
      bundleIdentifier: "kitchen.hraness",
      executable: "hra",
      version: "0.1.10",
    },
    tree: {
      bytes: 0,
      directories: 0,
      digest: "f".repeat(64),
      entries: 0,
      files: 0,
      symlinks: 0,
    },
  },
  keychainDescriptors: [] as string[],
} as const;

test("arbitrary caller commit spellings cannot steer receipt provenance", () => {
  fc.assert(fc.property(
    fc.string().filter(value => !/^[0-9a-f]{40}$/u.test(value)),
    candidateCommit => {
      expect(() => parseInstallationHandoffJournal({
        ...validReceipt,
        candidateCommit,
      })).toThrow();
    },
  ));
});

test("arbitrary nested receipt fields fail the strict schema", () => {
  fc.assert(fc.property(
    fc.string({ minLength: 1, maxLength: 40 }).filter(key => ![
      "bytes",
      "directories",
      "digest",
      "entries",
      "files",
      "symlinks",
    ].includes(key)),
    fc.jsonValue(),
    (key, value) => {
      const candidate = validReceipt.candidate;
      expect(() => parseInstallationHandoffJournal({
        ...validReceipt,
        candidate: {
          ...candidate,
          tree: { ...candidate.tree, [key]: value },
        },
      })).toThrow();
    },
  ));
});
