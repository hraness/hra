import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertProperty, fc } from "@hra-internal/test";

import { ChatPaneStore } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";

const ACCOUNT = "acct_ledgerproperty1";
const PANE = "pane_ledgerproperty1";
const NOW = new Date("2026-08-18T12:00:00.000Z");
const MIGRATED_SCHEMA = migratedSchemaSnapshot();

test("arbitrary edits and removals preserve FIFO ordinals, exact text, and both CAS clocks", () => {
  assertProperty(
    fc.property(
      fc.array(
        fc.record({
          text: fc.array(
            fc.constantFrom("a", "Z", " ", "\n", "é", "界", "🙂", "\\"),
            { maxLength: 32 },
          ).map((value) => `${value.join("")}x`),
          action: fc.constantFrom("keep", "edit", "remove"),
          edited: fc.array(
            fc.constantFrom("b", "Y", " ", "\n", "é", "界", "🙂", "\""),
            { maxLength: 32 },
          ).map((value) => `${value.join("")}y`),
        }),
        { minLength: 1, maxLength: 20 },
      ),
      fc.boolean(),
      (steps, reopenMidway) => {
        const database = databaseFixture();
        try {
          let store = new ChatPaneStore(database);
          store.create({
            paneId: PANE,
            repository: {
              id: `repo_${"6".repeat(26)}`,
              name: "Property repository",
              workingDirectory: "/fixture/property",
            },
            accountProfileId: ACCOUNT,
            now: NOW,
          });
          let queueRevision = 1;
          const expected = steps.map((step, index) => ({
            id: `chatmsg_property${String(index).padStart(8, "0")}`,
            ordinal: index + 1,
            revision: 1,
            text: step.text,
            attachmentRefs: [] as string[],
          }));
          for (const message of expected) {
            queueRevision = store.enqueueMessage({
              paneId: PANE,
              expectedQueueRevision: queueRevision,
              messageId: message.id,
              content: { text: message.text, attachmentRefs: [] },
              now: NOW,
            }).revision;
          }
          if (reopenMidway) store = new ChatPaneStore(database);

          for (let index = 0; index < steps.length; index += 1) {
            const step = steps[index]!;
            const message = expected.find(({ ordinal }) => ordinal === index + 1);
            if (message === undefined || step.action === "keep") continue;
            const before = store.messageQueue(PANE);
            expect(() => store.editQueuedMessage({
              paneId: PANE,
              expectedQueueRevision: queueRevision - 1,
              messageId: message.id,
              expectedMessageRevision: message.revision,
              content: { text: "stale", attachmentRefs: [] },
              now: NOW,
            })).toThrow(expect.objectContaining({ code: "revision_conflict" }));
            expect(store.messageQueue(PANE)).toEqual(before);

            if (step.action === "edit") {
              message.text = step.edited;
              message.revision += 1;
              queueRevision = store.editQueuedMessage({
                paneId: PANE,
                expectedQueueRevision: queueRevision,
                messageId: message.id,
                expectedMessageRevision: message.revision - 1,
                content: { text: message.text, attachmentRefs: [] },
                now: NOW,
              }).revision;
            } else {
              queueRevision = store.removeQueuedMessage({
                paneId: PANE,
                expectedQueueRevision: queueRevision,
                messageId: message.id,
                expectedMessageRevision: message.revision,
                now: NOW,
              }).revision;
              expected.splice(expected.indexOf(message), 1);
            }
          }

          const reopened = new ChatPaneStore(database).messageQueue(PANE);
          expect(reopened.revision).toBe(queueRevision);
          expect(reopened.messages).toEqual(expected);
          expect(reopened.messages.map(({ ordinal }) => ordinal)).toEqual(
            reopened.messages.map(({ ordinal }) => ordinal).toSorted((a, b) => a - b),
          );
        } finally {
          database.close();
        }
      },
    ),
    { numRuns: 50 },
  );
}, 20_000);

function databaseFixture(): Database {
  const database = Database.deserialize(MIGRATED_SCHEMA, { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Property account', 'signed_in', 1, 1, ?2, ?2)
  `).run(ACCOUNT, NOW.toISOString());
  return database;
}

function migratedSchemaSnapshot(): Uint8Array {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    return database.serialize();
  } finally {
    database.close();
  }
}
