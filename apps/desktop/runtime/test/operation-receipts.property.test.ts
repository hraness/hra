import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertProperty, fc } from "@hra-internal/test";
import type {
  ChatPaneProjection,
  RuntimeDispatchResponse,
  RuntimeDomainCommand,
} from "../../contracts/runtime";
import { runtimeProtocolVersion } from "../../contracts/runtime";
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

test("every successful chat receipt is compact and contains no chat content", () => {
  const database = receiptDatabase();
  try {
    const store = new OperationReceiptStore(database, fingerprintKey);
    const paneId = "pane_receiptprivacy01";
    const messageId = "chatmsg_receiptprivacy01";
    const attachmentId = "attachment_receiptprivacy01";
    const privateNeedles = [
      "private pane title",
      "private repository",
      "private response markdown",
      "private verified reasoning",
      "private queued prompt",
      attachmentId,
    ];
    const pane: ChatPaneProjection = {
      id: paneId,
      paletteIndex: 3,
      revision: 9,
      title: "private pane title",
      repository: {
        id: `repo_${"a".repeat(26)}`,
        name: "private repository",
      },
      accountProfileId: "acct_receiptprivacy1",
      interactionMode: "chat",
      state: "ready",
      activity: { ordinal: 3, kind: "responseCompleted" },
      workspace: {
        mode: "managedWorktree",
        state: "ready",
        revision: 1,
        recoveryKind: null,
      },
      turn: {
        id: "chatturn_receiptprivacy1",
        status: "completed",
        startedAt: "2026-08-18T12:00:00.000Z",
        completedAt: "2026-08-18T12:00:01.000Z",
        continuationCount: 0,
        responseMarkdown: {
          tail: "private response markdown",
          totalUtf8Bytes: 25,
          truncatedPrefix: false,
        },
        reasoningSummary: {
          tail: "private verified reasoning",
          totalUtf8Bytes: 26,
          truncatedPrefix: false,
        },
        reasoningSummaryVerified: true,
        tools: [],
        providerSubagents: { agents: [], overflowCount: 0 },
        routing: {
          policyVersion: 1,
          classificationReason: "conservativeDefault",
          workClass: "standard",
          requestedProfile: "solMax",
          selectedProfile: "solMax",
          profileFallbackReason: null,
          requestedServiceTier: "standard",
          selectedServiceTier: "standard",
          serviceTierFallbackReason: null,
        },
      },
      attention: null,
      recoverablePrompt: false,
      canStartFreshContext: false,
      messageQueue: {
        revision: 7,
        pauseReason: null,
        blockedMessage: null,
        messages: [{
          id: messageId,
          ordinal: 1,
          revision: 2,
          text: "private queued prompt",
          attachmentRefs: [attachmentId],
        }],
      },
      attachments: { drafts: [], referenced: [] },
      harness: null,
    };
    const paneCases: readonly RuntimeDomainCommand[] = [
      {
        type: "chat.pane.rename",
        paneId,
        expectedRevision: 8,
        title: "private pane title",
      },
      {
        type: "chat.turn.stop",
        paneId,
        expectedRevision: 8,
        turnId: pane.turn!.id,
      },
    ];
    const queueCases: readonly RuntimeDomainCommand[] = [
      {
        type: "chat.message.enqueue",
        paneId,
        expectedQueueRevision: 6,
        messageId,
        content: {
          text: "private queued prompt",
          attachmentRefs: [attachmentId],
        },
        delivery: { kind: "queue" },
      },
      {
        type: "chat.message.edit",
        paneId,
        expectedQueueRevision: 6,
        messageId,
        expectedMessageRevision: 1,
        content: {
          text: "private queued prompt",
          attachmentRefs: [attachmentId],
        },
      },
      {
        type: "chat.message.remove",
        paneId,
        expectedQueueRevision: 6,
        messageId,
        expectedMessageRevision: 1,
      },
    ];

    let ordinal = 0;
    for (const command of paneCases) {
      ordinal += 1;
      const operationId = `op_receiptpane${String(ordinal).padStart(16, "0")}`;
      expect(store.begin(operationId, command)).toEqual({ state: "new" });
      store.complete({
        version: runtimeProtocolVersion,
        operationId,
        ok: true,
        result: {
          type: "chatPane",
          pane,
          disposition: "applied",
          appliedRevision: pane.revision,
        },
      });
    }
    for (const command of queueCases) {
      ordinal += 1;
      const operationId = `op_receiptqueue${String(ordinal).padStart(16, "0")}`;
      expect(store.begin(operationId, command)).toEqual({ state: "new" });
      store.complete({
        version: runtimeProtocolVersion,
        operationId,
        ok: true,
        result: {
          type: "chatMessageQueue",
          paneId,
          queue: pane.messageQueue,
          disposition: "applied",
          messageId,
        },
      });
    }

    const rows = database.query<{ response_json: string }, []>(`
      SELECT response_json FROM operation_receipts
      WHERE command_type LIKE 'chat.%' ORDER BY operation_id
    `).all();
    expect(rows).toHaveLength(paneCases.length + queueCases.length);
    for (const { response_json: responseJson } of rows) {
      expect(Buffer.byteLength(responseJson, "utf8")).toBeLessThan(320);
      for (const needle of privateNeedles) expect(responseJson).not.toContain(needle);
      expect(responseJson).not.toContain("messageQueue");
      expect(responseJson).not.toContain("reasoningSummary");
      expect(responseJson).not.toContain("responseMarkdown");
    }
  } finally {
    database.close();
  }
});
