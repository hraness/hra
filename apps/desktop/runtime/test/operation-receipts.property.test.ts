import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertProperty, fc } from "@hra-internal/test";
import type {
  RuntimeDispatchResponse,
  RuntimeDomainCommand,
} from "../../contracts/runtime";
import {
  OperationReceiptStore,
  fingerprintRuntimeCommand,
} from "../src/state/operation-receipts";

const fingerprintKey = new Uint8Array(32).fill(0x42);

test("receipt fingerprints canonicalize command key order while binding exact content", () => {
  assertProperty(
    fc.property(
      fc.string({ minLength: 1, maxLength: 80 }),
      (label) => {
        const forward: RuntimeDomainCommand = { type: "account.create", label };
        const reverse = { label, type: "account.create" } as const satisfies RuntimeDomainCommand;

        const canonical = fingerprintRuntimeCommand(forward, fingerprintKey);
        expect(fingerprintRuntimeCommand(reverse, fingerprintKey)).toBe(canonical);

        const changed: RuntimeDomainCommand = { type: "account.create", label: `${label}!` };
        expect(fingerprintRuntimeCommand(changed, fingerprintKey)).not.toBe(canonical);
      },
    ),
  );
});

function receiptDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  database.exec(`
    CREATE TABLE operation_receipts (
      operation_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      command_fingerprint TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'ambiguous')),
      outcome_code TEXT,
      entity_id TEXT,
      response_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;
  `);
  return database;
}

test("recovery reveals can neither be completed nor replayed through durable receipts", () => {
  const database = receiptDatabase();
  try {
    const store = new OperationReceiptStore(database, fingerprintKey);
    const command = {
      type: "sessionSync.recovery.reveal",
      expectedRevision: 1,
    } as const satisfies RuntimeDomainCommand;
    expect(store.begin("operation_reveal", command)).toEqual({ state: "new" });
    const sensitiveResponse = {
      version: 3,
      operationId: "operation_reveal",
      ok: true,
      result: {
        type: "sessionSyncRecoveryKit",
        revealId: `syncreveal_${"a".repeat(32)}`,
        recoveryKit: "sensitive-pkcs8-root-key-material".repeat(3),
        expiresAt: 1_000,
      },
    } as const satisfies RuntimeDispatchResponse;
    expect(() => store.complete(sensitiveResponse)).toThrow(
      "cannot be persisted",
    );
    expect(database.query(`
      SELECT state, response_json FROM operation_receipts
      WHERE operation_id = 'operation_reveal'
    `).get()).toEqual({ state: "started", response_json: null });

    database.query(`
      UPDATE operation_receipts
      SET state = 'succeeded', response_json = ?1
      WHERE operation_id = 'operation_reveal'
    `).run(JSON.stringify(sensitiveResponse));
    database.query(`
      INSERT INTO operation_receipts(
        operation_id, command_type, command_fingerprint, state,
        response_json, created_at
      ) VALUES ('operation_normal', 'account.refresh', ?1, 'failed', '{}', ?2)
    `).run("f".repeat(64), new Date().toISOString());

    expect(store.purgeTransientSecretReceipts()).toBe(1);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM operation_receipts
      WHERE command_type = 'sessionSync.recovery.reveal'
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM operation_receipts
      WHERE operation_id = 'operation_normal'
    `).get()).toEqual({ count: 1 });
  } finally {
    database.close();
  }
});
