import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  chatMessageAttachmentIdSchema,
  chatMessageQueueProjectionSchema,
} from "../../contracts/runtime";
import {
  CHAT_MESSAGE_MAX_ACTIVE_PER_PANE,
} from "../src/state/chat-message-ledger";
import { ChatPaneStore, ChatPaneStoreError } from "../src/state/chat-pane-store";
import { applyMigrations } from "../src/state/database";

const ACCOUNT = "acct_ledgerprimary1";
const PANE = "pane_ledgerprimary1";
const TURN = "chatturn_ledger001";
const NOW = new Date("2026-08-18T12:00:00.000Z");
const READY_ATTACHMENT = "attachment_ledgerimage01";

test("message ledger persists complete FIFO text under independent queue and row CAS", () => {
  withStore((store, database) => {
    const pane = createPane(store);
    expect(store.messageQueue(PANE)).toEqual({
      revision: 1,
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    });

    const first = store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_ledgerfirst1",
      content: { text: "  preserve exact editable text  ", attachmentRefs: [] },
      now: NOW,
    });
    expect(first).toEqual({
      revision: 2,
      pauseReason: null,
      blockedMessage: null,
      messages: [{
        id: "chatmsg_ledgerfirst1",
        ordinal: 1,
        revision: 1,
        text: "  preserve exact editable text  ",
        attachmentRefs: [],
      }],
    });
    const second = store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: "chatmsg_ledgersecond1",
      content: { text: "second", attachmentRefs: [] },
      now: later(1),
    });
    expect(second.messages.map(({ ordinal }) => ordinal)).toEqual([1, 2]);
    expect(store.require(PANE).projection.revision).toBe(pane.revision);

    const edited = store.editQueuedMessage({
      paneId: PANE,
      expectedQueueRevision: 3,
      messageId: "chatmsg_ledgerfirst1",
      expectedMessageRevision: 1,
      content: { text: "edited in place", attachmentRefs: [] },
      now: later(2),
    });
    expect(edited.revision).toBe(4);
    expect(edited.messages[0]).toMatchObject({
      id: "chatmsg_ledgerfirst1",
      ordinal: 1,
      revision: 2,
      text: "edited in place",
    });
    expect(() => store.editQueuedMessage({
      paneId: PANE,
      expectedQueueRevision: 3,
      messageId: "chatmsg_ledgerfirst1",
      expectedMessageRevision: 1,
      content: { text: "stale", attachmentRefs: [] },
      now: later(3),
    })).toThrow(expect.objectContaining({ code: "revision_conflict" }));

    const removed = store.removeQueuedMessage({
      paneId: PANE,
      expectedQueueRevision: 4,
      messageId: "chatmsg_ledgersecond1",
      expectedMessageRevision: 1,
      now: later(4),
    });
    expect(removed).toMatchObject({
      revision: 5,
      messages: [{ id: "chatmsg_ledgerfirst1", ordinal: 1 }],
    });
    expect(database.query(`
      SELECT state, revision FROM chat_message_ledger
      WHERE message_id = 'chatmsg_ledgersecond1'
    `).get()).toEqual({ state: "cancelled", revision: 2 });

    const reopened = new ChatPaneStore(database);
    expect(reopened.messageQueue(PANE)).toEqual(removed);
    expect(() => reopened.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: removed.revision,
      messageId: "chatmsg_ledgersecond1",
      content: { text: "ID reuse", attachmentRefs: [] },
      now: later(5),
    })).toThrow(expect.objectContaining({ code: "conflict" }));
  });
});

test("attachments remain opaque, ready-only, unique, and path-free", () => {
  withStore((store, database) => {
    createPane(store);
    expect(() => store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_attachmentdeny1",
      content: { text: "", attachmentRefs: [READY_ATTACHMENT] },
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(store.messageQueue(PANE)).toEqual({
      revision: 1,
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_ledger
    `).get()).toEqual({ count: 0 });

    insertReadyAttachment(database, {
      attachmentId: READY_ATTACHMENT,
      paneId: PANE,
      uploadId: "upload_ledgerimage01",
    });
    const queue = store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_attachmentok01",
      content: { text: "", attachmentRefs: [READY_ATTACHMENT] },
      now: NOW,
    });
    expect(queue.messages[0]?.ordinal).toBe(1);
    expect(queue.messages[0]?.attachmentRefs).toEqual([READY_ATTACHMENT]);
    expect(database.query(`
      SELECT message_id, pane_id, position, attachment_id
      FROM chat_message_attachment_refs
    `).get()).toEqual({
      message_id: "chatmsg_attachmentok01",
      pane_id: PANE,
      position: 0,
      attachment_id: READY_ATTACHMENT,
    });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_draft_leases
      WHERE attachment_id = ?1
    `).get(READY_ATTACHMENT)).toEqual({ count: 0 });
    expect(JSON.stringify(queue)).not.toContain("/");
    expect(() => chatMessageAttachmentIdSchema.parse("/private/tmp/image.png"))
      .toThrow();
    expect(() => chatMessageQueueProjectionSchema.parse({
      revision: 2,
      pauseReason: null,
      blockedMessage: null,
      messages: [{
        ...queue.messages[0],
        attachmentRefs: [READY_ATTACHMENT, READY_ATTACHMENT],
      }],
    })).toThrow();

    const reopened = new ChatPaneStore(database);
    expect(reopened.messageQueue(PANE)).toEqual(queue);
    expect(() => reopened.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: queue.revision,
      messageId: "chatmsg_attachmentreuse",
      content: { text: "reuse", attachmentRefs: [READY_ATTACHMENT] },
      now: later(1),
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));

    const otherPaneId = "pane_attachmentother1";
    reopened.create({
      paneId: otherPaneId,
      repository: {
        id: `repo_${"6".repeat(26)}`,
        name: "Other attachment repository",
        workingDirectory: "/fixture/other-attachment",
      },
      accountProfileId: ACCOUNT,
      now: later(2),
    });
    insertReadyAttachment(database, {
      attachmentId: "attachment_otherpane01",
      paneId: otherPaneId,
      uploadId: "upload_otherpane0001",
    });
    expect(() => reopened.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: queue.revision,
      messageId: "chatmsg_attachmentcross1",
      content: { text: "cross pane", attachmentRefs: ["attachment_otherpane01"] },
      now: later(3),
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));

    insertReadyAttachment(database, {
      attachmentId: "attachment_expired001",
      paneId: PANE,
      uploadId: "upload_expired000001",
      expiresAt: new Date(NOW.getTime() - 1_000),
    });
    expect(() => reopened.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: queue.revision,
      messageId: "chatmsg_attachmentexpired",
      content: { text: "expired", attachmentRefs: ["attachment_expired001"] },
      now: later(4),
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(reopened.messageQueue(PANE)).toEqual(queue);

    const addedAttachment = "attachment_ledgerimage02";
    insertReadyAttachment(database, {
      attachmentId: addedAttachment,
      paneId: PANE,
      uploadId: "upload_ledgerimage02",
    });
    const edited = reopened.editQueuedMessage({
      paneId: PANE,
      expectedQueueRevision: queue.revision,
      messageId: "chatmsg_attachmentok01",
      expectedMessageRevision: 1,
      content: {
        text: "edited",
        attachmentRefs: [READY_ATTACHMENT, addedAttachment],
      },
      now: later(5),
    });
    expect(edited.messages[0]?.attachmentRefs).toEqual([
      READY_ATTACHMENT,
      addedAttachment,
    ]);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_draft_leases
      WHERE attachment_id = ?1
    `).get(addedAttachment)).toEqual({ count: 0 });

    database.query(`
      UPDATE chat_attachments SET state = 'corrupt', revision = revision + 1,
        updated_at = ?2 WHERE attachment_id = ?1
    `).run(READY_ATTACHMENT, later(6).toISOString());
    expect(() => reopened.messageQueue(PANE)).toThrow(
      expect.objectContaining({ code: "invalid_state" }),
    );

    const ledgerColumns = database.query<{ name: string }, []>(`
      SELECT name FROM pragma_table_info('chat_message_ledger')
      UNION ALL SELECT name FROM pragma_table_info('chat_attachments')
      UNION ALL SELECT name FROM pragma_table_info('chat_message_attachment_refs')
    `).all().map(({ name }) => name);
    expect(ledgerColumns.some((name) => /path|filename|provider/iu.test(name)))
      .toBe(false);
  });
});

test("attachment turn leases follow prepared, terminal, and ambiguous cuts", () => {
  withStore((store, database) => {
    createPane(store);
    insertReadyAttachment(database, {
      attachmentId: READY_ATTACHMENT,
      paneId: PANE,
      uploadId: "upload_ledgerlease001",
    });
    store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_attachmentlease1",
      content: { text: "", attachmentRefs: [READY_ATTACHMENT] },
      now: NOW,
    });
    const claimed = store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: "chatmsg_attachmentlease1",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "start",
      now: later(1),
    }).claim;
    expect(attachmentLease(database)).toEqual({ state: "active", released_at: null });

    const returned = store.returnClaimedMessageToQueue({
      paneId: PANE,
      messageId: claimed.messageId,
      expectedMessageRevision: claimed.revision,
      turnId: TURN,
      kind: "start",
      now: later(2),
    });
    expect(attachmentLease(database).state).toBe("released");
    const reclaimed = store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: returned.revision,
      messageId: claimed.messageId,
      expectedMessageRevision: claimed.revision + 1,
      turnId: TURN,
      kind: "start",
      now: later(3),
    }).claim;
    expect(attachmentLease(database)).toEqual({ state: "active", released_at: null });
    store.markMessageEffectStarted({
      paneId: PANE,
      messageId: reclaimed.messageId,
      expectedMessageRevision: reclaimed.revision,
      turnId: TURN,
      kind: "start",
      now: later(4),
    });
    store.markMessageEffectAmbiguous({
      paneId: PANE,
      messageId: reclaimed.messageId,
      expectedMessageRevision: reclaimed.revision + 1,
      turnId: TURN,
      kind: "start",
      now: later(5),
    });
    expect(attachmentLease(database)).toEqual({ state: "ambiguous", released_at: null });
  });

  withStore((store, database) => {
    createPane(store);
    insertReadyAttachment(database, {
      attachmentId: READY_ATTACHMENT,
      paneId: PANE,
      uploadId: "upload_ledgerterminal1",
    });
    store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_attachmentdone01",
      content: { text: "send", attachmentRefs: [READY_ATTACHMENT] },
      now: NOW,
    });
    const claim = store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: "chatmsg_attachmentdone01",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "start",
      now: later(1),
    }).claim;
    store.markMessageEffectStarted({
      paneId: PANE,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision,
      turnId: TURN,
      kind: "start",
      now: later(2),
    });
    store.acknowledgeMessageEffect({
      paneId: PANE,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision + 1,
      turnId: TURN,
      kind: "start",
      now: later(3),
    });
    store.completeClaimedMessage({
      paneId: PANE,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision + 2,
      turnId: TURN,
      kind: "start",
      now: later(4),
    });
    expect(attachmentLease(database).state).toBe("released");
  });
});

test("only the FIFO head can be claimed and start cuts settle monotonically", () => {
  withStore((store, database) => {
    createPane(store);
    enqueue(store, 1, "chatmsg_claimfirst01", "first");
    enqueue(store, 2, "chatmsg_claimsecond1", "second");
    expect(() => store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 3,
      messageId: "chatmsg_claimsecond1",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "start",
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "conflict" }));

    const claimed = store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 3,
      messageId: "chatmsg_claimfirst01",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "start",
      now: NOW,
    });
    expect(claimed).toMatchObject({
      claim: {
        messageId: "chatmsg_claimfirst01",
        ordinal: 1,
        revision: 2,
        turnId: TURN,
        kind: "start",
        content: { text: "first", attachmentRefs: [] },
      },
      queue: {
        revision: 4,
        messages: [{ id: "chatmsg_claimsecond1", ordinal: 2 }],
      },
    });
    expect(() => store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 4,
      messageId: "chatmsg_claimsecond1",
      expectedMessageRevision: 1,
      turnId: "chatturn_ledger002",
      kind: "start",
      now: later(1),
    })).toThrow();

    expect(store.markMessageEffectStarted({
      paneId: PANE,
      messageId: "chatmsg_claimfirst01",
      expectedMessageRevision: 2,
      turnId: TURN,
      kind: "start",
      now: later(2),
    }).revision).toBe(5);
    expect(store.acknowledgeMessageEffect({
      paneId: PANE,
      messageId: "chatmsg_claimfirst01",
      expectedMessageRevision: 3,
      turnId: TURN,
      kind: "start",
      now: later(3),
    }).revision).toBe(6);
    expect(store.completeClaimedMessage({
      paneId: PANE,
      messageId: "chatmsg_claimfirst01",
      expectedMessageRevision: 4,
      turnId: TURN,
      kind: "start",
      now: later(4),
    }).revision).toBe(7);
    expect(database.query(`
      SELECT state, revision, claimed_turn_id FROM chat_message_ledger
      WHERE message_id = 'chatmsg_claimfirst01'
    `).get()).toEqual({
      state: "completed",
      revision: 5,
      claimed_turn_id: TURN,
    });
  });
});

test("steer preparation is fenced to the exact active turn and can return to FIFO", () => {
  withStore((store) => {
    const pane = createPane(store);
    const begun = store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active provider turn",
      now: NOW,
    });
    expect(begun.kind).toBe("begun");
    enqueue(store, 1, "chatmsg_steerprepared1", "steer this");
    expect(() => store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: "chatmsg_steerprepared1",
      expectedMessageRevision: 1,
      turnId: "chatturn_wrong0001",
      kind: "steer",
      now: NOW,
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));

    const prepared = store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: "chatmsg_steerprepared1",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "steer",
      now: NOW,
    });
    expect(prepared.queue.messages).toEqual([]);
    const returned = store.returnClaimedMessageToQueue({
      paneId: PANE,
      messageId: "chatmsg_steerprepared1",
      expectedMessageRevision: 2,
      turnId: TURN,
      kind: "steer",
      now: later(1),
    });
    expect(returned).toMatchObject({
      revision: 4,
      messages: [{
        id: "chatmsg_steerprepared1",
        ordinal: 1,
        revision: 3,
      }],
    });
  });
});

test("composer Cmd+Enter can atomically enqueue and prepare only its own FIFO head", () => {
  withStore((store) => {
    const pane = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active",
      now: NOW,
    });
    const prepared = store.enqueueMessageAndPrepareSteer({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_composersteer1",
      content: { text: "steer now", attachmentRefs: [] },
      turnId: TURN,
      now: NOW,
    });
    expect(prepared).toMatchObject({
      claim: {
        messageId: "chatmsg_composersteer1",
        kind: "steer",
        revision: 2,
      },
      queue: { revision: 3, messages: [] },
    });
  });

  withStore((store, database) => {
    const pane = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active",
      now: NOW,
    });
    enqueue(store, 1, "chatmsg_olderqueued001", "older");
    insertReadyAttachment(database, {
      attachmentId: READY_ATTACHMENT,
      paneId: PANE,
      uploadId: "upload_composerrollback",
    });
    const olderHeadError = captureStoreError(() =>
      store.enqueueMessageAndPrepareSteer({
        paneId: PANE,
        expectedQueueRevision: 2,
        messageId: "chatmsg_composerlater1",
        content: { text: "later", attachmentRefs: [READY_ATTACHMENT] },
        turnId: TURN,
        now: later(1),
      }),
    );
    expect(olderHeadError.code).toBe("conflict");
    expect(olderHeadError.message).toContain("older message");
    expect(store.messageQueue(PANE)).toMatchObject({
      revision: 2,
      messages: [{ id: "chatmsg_olderqueued001" }],
    });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_ledger
      WHERE message_id = 'chatmsg_composerlater1'
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_draft_leases
      WHERE attachment_id = ?1
    `).get(READY_ATTACHMENT)).toEqual({ count: 1 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs
      WHERE attachment_id = ?1
    `).get(READY_ATTACHMENT)).toEqual({ count: 0 });
  });

  withStore((store) => {
    const pane = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active",
      now: NOW,
    });
    store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: {
        code: "turn_failed",
        message: "settled before steer admission",
        retryable: true,
      },
      clearBinding: true,
      now: later(1),
    });
    const terminalError = captureStoreError(() =>
      store.enqueueMessageAndPrepareSteer({
        paneId: PANE,
        expectedQueueRevision: 1,
        messageId: "chatmsg_composerterminal",
        content: { text: "do not queue", attachmentRefs: [] },
        turnId: TURN,
        now: later(2),
      }),
    );
    expect(terminalError.code).toBe("conflict");
    expect(terminalError.message).toContain("active chat turn changed");
    expect(store.messageQueue(PANE)).toEqual({
      revision: 1,
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    });
  });

  withStore((store) => {
    const pane = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active",
      now: NOW,
    });
    const paused = store.pauseMessageQueue({
      paneId: PANE,
      reason: "stop",
      now: later(1),
    });
    const pausedError = captureStoreError(() =>
      store.enqueueMessageAndPrepareSteer({
        paneId: PANE,
        expectedQueueRevision: paused.revision,
        messageId: "chatmsg_composerpaused1",
        content: { text: "do not queue", attachmentRefs: [] },
        turnId: TURN,
        now: later(2),
      }),
    );
    expect(pausedError.code).toBe("conflict");
    expect(pausedError.message).toContain("queue is paused");
    expect(store.messageQueue(PANE)).toEqual(paused);
  });
});

test("atomic steer compensation cancels its row and restores exact attachment drafts", () => {
  withStore((store, database) => {
    const pane = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active",
      now: NOW,
    });
    const expiresAt = later(3_600);
    insertReadyAttachment(database, {
      attachmentId: READY_ATTACHMENT,
      paneId: PANE,
      uploadId: "upload_compensaterace1",
      expiresAt,
    });
    const prepared = store.enqueueMessageAndPrepareSteer({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_compensaterace1",
      content: { text: "steer with image", attachmentRefs: [READY_ATTACHMENT] },
      turnId: TURN,
      now: NOW,
    });

    const compensated = store.cancelPreparedSteerMessage({
      paneId: PANE,
      messageId: prepared.claim.messageId,
      expectedMessageRevision: prepared.claim.revision,
      turnId: TURN,
      kind: "steer",
      now: later(1),
    });
    expect(compensated.attachmentsRestored).toBe(true);
    expect(compensated.queue).toEqual({
      revision: 4,
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    });
    expect(database.query(`
      SELECT state, revision FROM chat_message_ledger
      WHERE message_id = 'chatmsg_compensaterace1'
    `).get()).toEqual({ state: "cancelled", revision: 3 });
    expect(database.query(`
      SELECT expires_at FROM chat_attachment_draft_leases
      WHERE attachment_id = ?1
    `).get(READY_ATTACHMENT)).toEqual({ expires_at: expiresAt.toISOString() });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs
      WHERE message_id = 'chatmsg_compensaterace1'
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_turn_leases
      WHERE message_id = 'chatmsg_compensaterace1'
    `).get()).toEqual({ count: 0 });

    const reopened = new ChatPaneStore(database);
    const retried = reopened.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: compensated.queue.revision,
      messageId: "chatmsg_compensateretry",
      content: { text: "retry unchanged", attachmentRefs: [READY_ATTACHMENT] },
      now: later(2),
    });
    expect(retried.messages[0]?.attachmentRefs).toEqual([READY_ATTACHMENT]);
  });
});

test("expired atomic-steer attachment compensation is explicit and terminal", () => {
  withStore((store, database) => {
    const pane = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active",
      now: NOW,
    });
    insertReadyAttachment(database, {
      attachmentId: READY_ATTACHMENT,
      paneId: PANE,
      uploadId: "upload_compensateexpired",
      expiresAt: later(1),
    });
    const prepared = store.enqueueMessageAndPrepareSteer({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_compensateexpired",
      content: { text: "expires", attachmentRefs: [READY_ATTACHMENT] },
      turnId: TURN,
      now: NOW,
    });
    const compensated = store.cancelPreparedSteerMessage({
      paneId: PANE,
      messageId: prepared.claim.messageId,
      expectedMessageRevision: prepared.claim.revision,
      turnId: TURN,
      kind: "steer",
      now: later(2),
    });
    expect(compensated.attachmentsRestored).toBe(false);
    expect(database.query(`
      SELECT state FROM chat_message_ledger
      WHERE message_id = 'chatmsg_compensateexpired'
    `).get()).toEqual({ state: "cancelled" });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_draft_leases
      WHERE attachment_id = ?1
    `).get(READY_ATTACHMENT)).toEqual({ count: 0 });
  });
});

test("restart returns prepared rows, fences effect-started rows, and pauses draining", () => {
  withStore((store, database) => {
    createPane(store);
    enqueue(store, 1, "chatmsg_restartprepared", "prepared");
    store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: "chatmsg_restartprepared",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "start",
      now: NOW,
    });
    const reopened = new ChatPaneStore(database);
    expect(reopened.messageQueue(PANE)).toMatchObject({ revision: 3, messages: [] });
    const recovered = reopened.reconcileMessageQueueAfterRestart(PANE, later(1));
    expect(recovered).toMatchObject({
      revision: 4,
      pauseReason: "runtimeRestart",
      messages: [{ id: "chatmsg_restartprepared", revision: 3 }],
    });
    const resumed = reopened.resumeMessageQueue({
      paneId: PANE,
      expectedQueueRevision: recovered.revision,
      now: later(2),
    });
    const reclaimed = reopened.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: resumed.revision,
      messageId: "chatmsg_restartprepared",
      expectedMessageRevision: 3,
      turnId: TURN,
      kind: "start",
      now: later(3),
    });
    reopened.markMessageEffectStarted({
      paneId: PANE,
      messageId: reclaimed.claim.messageId,
      expectedMessageRevision: reclaimed.claim.revision,
      turnId: TURN,
      kind: "start",
      now: later(4),
    });
    const ambiguous = reopened.reconcileMessageQueueAfterRestart(PANE, later(5));
    expect(ambiguous).toMatchObject({
      pauseReason: "ambiguousEffect",
      blockedMessage: {
        id: "chatmsg_restartprepared",
        text: "prepared",
        deliveryOutcome: "deliveryOutcomeUnknown",
      },
      messages: [],
    });
    expect(() => reopened.resumeMessageQueue({
      paneId: PANE,
      expectedQueueRevision: ambiguous.revision,
      now: later(6),
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));
    expect(database.query(`
      SELECT state FROM chat_message_ledger
      WHERE message_id = 'chatmsg_restartprepared'
    `).get()).toEqual({ state: "ambiguous" });
  });
});

test("an ambiguous message stays immutable until terminal discard releases containment", () => {
  withStore((store, database) => {
    const pane = createPane(store);
    store.beginTurn({
      paneId: PANE,
      expectedRevision: pane.revision,
      turnId: TURN,
      prompt: "active",
      now: NOW,
    });
    enqueue(store, 1, "chatmsg_ambiguousdiscard", "delivery unknown");
    const claim = store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: "chatmsg_ambiguousdiscard",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "steer",
      now: later(1),
    }).claim;
    store.markMessageEffectStarted({
      paneId: PANE,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision,
      turnId: TURN,
      kind: "steer",
      now: later(2),
    });
    const ambiguous = store.markMessageEffectAmbiguous({
      paneId: PANE,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision + 1,
      turnId: TURN,
      kind: "steer",
      now: later(3),
    });
    expect(ambiguous.blockedMessage).toMatchObject({
      id: claim.messageId,
      revision: claim.revision + 2,
      text: "delivery unknown",
      deliveryOutcome: "deliveryOutcomeUnknown",
    });
    expect(() => store.discardAmbiguousMessage({
      paneId: PANE,
      expectedQueueRevision: ambiguous.revision,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision + 2,
      now: later(4),
    })).toThrow(expect.objectContaining({ code: "invalid_state" }));

    const terminal = store.enterAttention({
      paneId: PANE,
      turnId: TURN,
      attention: {
        code: "turn_failed",
        message: "The provider effect was contained.",
        retryable: true,
      },
      clearBinding: true,
      now: later(5),
    });
    if (terminal === null) throw new Error("Expected the exact turn to terminalize");
    const discarded = store.discardAmbiguousMessage({
      paneId: PANE,
      expectedQueueRevision: ambiguous.revision,
      messageId: claim.messageId,
      expectedMessageRevision: claim.revision + 2,
      now: later(6),
    });
    expect(discarded).toEqual({
      revision: ambiguous.revision + 1,
      pauseReason: null,
      blockedMessage: null,
      messages: [],
    });
    expect(database.query(`
      SELECT state, revision FROM chat_message_ledger
      WHERE message_id = ?1
    `).get(claim.messageId)).toEqual({
      state: "ambiguous",
      revision: claim.revision + 2,
    });
    expect(() => database.query(`
      UPDATE chat_message_ledger SET state = 'cancelled', revision = revision + 1
      WHERE message_id = ?1
    `).run(claim.messageId)).toThrow("transition");
    expect(() => database.query(`
      UPDATE chat_message_ambiguous_resolutions SET resolution = 'discarded'
      WHERE message_id = ?1
    `).run(claim.messageId)).toThrow("immutable");

    store.remove(PANE, terminal.revision, later(7));
    database.query(`
      DELETE FROM chat_message_ledger WHERE message_id = ?1
    `).run(claim.messageId);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_ambiguous_resolutions
      WHERE message_id = ?1
    `).get(claim.messageId)).toEqual({ count: 0 });
  });
});

test("pane close atomically cancels unclaimed and prepared-no-effect rows", () => {
  withStore((store, database) => {
    const pane = createPane(store);
    insertReadyAttachment(database, {
      attachmentId: READY_ATTACHMENT,
      paneId: PANE,
      uploadId: "upload_ledgerclose001",
    });
    store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: 1,
      messageId: "chatmsg_closeprepared1",
      content: { text: "prepared", attachmentRefs: [READY_ATTACHMENT] },
      now: NOW,
    });
    enqueue(store, 2, "chatmsg_closequeued001", "queued");
    store.claimHeadMessage({
      paneId: PANE,
      expectedQueueRevision: 3,
      messageId: "chatmsg_closeprepared1",
      expectedMessageRevision: 1,
      turnId: TURN,
      kind: "start",
      now: NOW,
    });
    store.remove(PANE, pane.revision, later(1));
    expect(database.query(`
      SELECT message_id, state FROM chat_message_ledger
      WHERE pane_id = ?1 ORDER BY ordinal
    `).all(PANE)).toEqual([
      { message_id: "chatmsg_closeprepared1", state: "cancelled" },
      { message_id: "chatmsg_closequeued001", state: "cancelled" },
    ]);
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_message_attachment_refs
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachment_turn_leases
    `).get()).toEqual({ count: 0 });
    expect(database.query(`
      SELECT COUNT(*) AS count FROM chat_attachments
    `).get()).toEqual({ count: 1 });
    expect(store.get(PANE)).toBeNull();
  });
});

test("pane close rejects every effect-started, acknowledged, or ambiguous row", () => {
  for (const lifecycle of ["effectStarted", "acknowledged", "ambiguous"] as const) {
    withStore((store) => {
      const pane = createPane(store);
      enqueue(store, 1, "chatmsg_closeeffect001", "effect");
      const claim = store.claimHeadMessage({
        paneId: PANE,
        expectedQueueRevision: 2,
        messageId: "chatmsg_closeeffect001",
        expectedMessageRevision: 1,
        turnId: TURN,
        kind: "start",
        now: NOW,
      }).claim;
      store.markMessageEffectStarted({
        paneId: PANE,
        messageId: claim.messageId,
        expectedMessageRevision: claim.revision,
        turnId: TURN,
        kind: "start",
        now: later(1),
      });
      if (lifecycle === "acknowledged") {
        store.acknowledgeMessageEffect({
          paneId: PANE,
          messageId: claim.messageId,
          expectedMessageRevision: claim.revision + 1,
          turnId: TURN,
          kind: "start",
          now: later(2),
        });
      } else if (lifecycle === "ambiguous") {
        store.markMessageEffectAmbiguous({
          paneId: PANE,
          messageId: claim.messageId,
          expectedMessageRevision: claim.revision + 1,
          turnId: TURN,
          kind: "start",
          now: later(2),
        });
      }
      expect(() => store.remove(PANE, pane.revision, later(3))).toThrow(
        expect.objectContaining({ code: "invalid_state" }),
      );
      expect(store.get(PANE)).not.toBeNull();
    });
  }
});

test("active-row count and complete UTF-8 text stay bounded", () => {
  withStore((store) => {
    createPane(store);
    let revision = 1;
    for (let index = 0; index < CHAT_MESSAGE_MAX_ACTIVE_PER_PANE; index += 1) {
      revision = store.enqueueMessage({
        paneId: PANE,
        expectedQueueRevision: revision,
        messageId: `chatmsg_bound${String(index).padStart(8, "0")}`,
        content: { text: "x", attachmentRefs: [] },
        now: later(index),
      }).revision;
    }
    expect(() => store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: revision,
      messageId: "chatmsg_boundoverflow",
      content: { text: "x", attachmentRefs: [] },
      now: later(40),
    })).toThrow(expect.objectContaining({ code: "limit" }));
  });

  withStore((store) => {
    createPane(store);
    const chunk = "x".repeat(128 * 1024);
    let revision = 1;
    for (let index = 0; index < 4; index += 1) {
      revision = store.enqueueMessage({
        paneId: PANE,
        expectedQueueRevision: revision,
        messageId: `chatmsg_bytes${String(index).padStart(8, "0")}`,
        content: { text: chunk, attachmentRefs: [] },
        now: later(index),
      }).revision;
    }
    expect(() => store.enqueueMessage({
      paneId: PANE,
      expectedQueueRevision: revision,
      messageId: "chatmsg_bytesoverflow",
      content: { text: "x", attachmentRefs: [] },
      now: later(5),
    })).toThrow(expect.objectContaining({ code: "limit" }));
  });
});

test("complete queued text has an explicit database-wide 8 MiB ceiling", () => {
  withStore((store) => {
    const chunk = "x".repeat(128 * 1024);
    for (let paneIndex = 0; paneIndex < 16; paneIndex += 1) {
      const paneId = `pane_global${String(paneIndex).padStart(8, "0")}`;
      store.create({
        paneId,
        repository: {
          id: `repo_${"5".repeat(26)}`,
          name: "Global bound repository",
          workingDirectory: "/fixture/global",
        },
        accountProfileId: ACCOUNT,
        now: later(paneIndex),
      });
      let revision = 1;
      for (let messageIndex = 0; messageIndex < 4; messageIndex += 1) {
        revision = store.enqueueMessage({
          paneId,
          expectedQueueRevision: revision,
          messageId: `chatmsg_global${String(paneIndex).padStart(4, "0")}${String(messageIndex).padStart(4, "0")}`,
          content: { text: chunk, attachmentRefs: [] },
          now: later(paneIndex * 4 + messageIndex),
        }).revision;
      }
    }
    const overflowPane = "pane_globaloverflow";
    store.create({
      paneId: overflowPane,
      repository: {
        id: `repo_${"5".repeat(26)}`,
        name: "Global bound repository",
        workingDirectory: "/fixture/global",
      },
      accountProfileId: ACCOUNT,
      now: later(100),
    });
    expect(() => store.enqueueMessage({
      paneId: overflowPane,
      expectedQueueRevision: 1,
      messageId: "chatmsg_globaloverflow",
      content: { text: "x", attachmentRefs: [] },
      now: later(101),
    })).toThrow(expect.objectContaining({ code: "limit" }));
  });
});

test("FIFO head lookup uses the dedicated partial index", () => {
  withStore((_store, database) => {
    const plan = database.query<{ detail: string }, [string]>(`
      EXPLAIN QUERY PLAN
      SELECT * FROM chat_message_ledger
        INDEXED BY chat_message_ledger_queued_head_idx
      WHERE pane_id = ?1 AND state = 'queued'
      ORDER BY ordinal, message_id
      LIMIT 1
    `).all(PANE).map(({ detail }) => detail).join("\n");
    expect(plan).toContain("chat_message_ledger_queued_head_idx");

    const refPlan = database.query<{ detail: string }, [string, string]>(`
      EXPLAIN QUERY PLAN
      SELECT message_id FROM chat_message_attachment_refs
        INDEXED BY chat_message_attachment_refs_attachment_idx
      WHERE attachment_id = ?1 AND pane_id = ?2
    `).all(READY_ATTACHMENT, PANE).map(({ detail }) => detail).join("\n");
    expect(refPlan).toContain("chat_message_attachment_refs_attachment_idx");

    const draftGcPlan = database.query<{ detail: string }, [string]>(`
      EXPLAIN QUERY PLAN
      SELECT attachment_id FROM chat_attachment_draft_leases
        INDEXED BY chat_attachment_draft_leases_expiry_idx
      WHERE expires_at <= ?1
      ORDER BY expires_at, pane_id, attachment_id
    `).all(NOW.toISOString()).map(({ detail }) => detail).join("\n");
    expect(draftGcPlan).toContain("chat_attachment_draft_leases_expiry_idx");

    const columns = database.query<{ name: string }, []>(`
      SELECT name FROM pragma_table_info('chat_message_ledger') ORDER BY cid
    `).all().map(({ name }) => name);
    expect(columns.some((name) => /path|provider|model|effort|tier/iu.test(name)))
      .toBe(false);
  });
});

function withStore(
  run: (store: ChatPaneStore, database: Database) => void,
): void {
  const database = new Database(":memory:", { strict: true });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Ledger account', 'signed_in', 1, 1, ?2, ?2)
    `).run(ACCOUNT, NOW.toISOString());
    run(new ChatPaneStore(database), database);
  } finally {
    database.close();
  }
}

function createPane(store: ChatPaneStore) {
  return store.create({
    paneId: PANE,
    repository: {
      id: `repo_${"7".repeat(26)}`,
      name: "Ledger repository",
      workingDirectory: "/fixture/ledger",
    },
    accountProfileId: ACCOUNT,
    now: NOW,
  });
}

function enqueue(
  store: ChatPaneStore,
  expectedQueueRevision: number,
  messageId: string,
  text: string,
) {
  return store.enqueueMessage({
    paneId: PANE,
    expectedQueueRevision,
    messageId,
    content: { text, attachmentRefs: [] },
    now: later(expectedQueueRevision),
  });
}

function insertReadyAttachment(
  database: Database,
  input: Readonly<{
    attachmentId: string;
    paneId: string;
    uploadId: string;
    expiresAt?: Date;
  }>,
): void {
  const digest = "a".repeat(64);
  database.query(`
    INSERT INTO chat_attachments (
      attachment_id, upload_id, pane_id, revision, state,
      expected_input_bytes, received_input_bytes, next_chunk_ordinal,
      input_sha256, source_media_type, width, height, pixel_count,
      canonical_bytes, canonical_sha256, preview_bytes, preview_sha256,
      ready_at, created_at, updated_at
    ) VALUES (
      ?1, ?2, ?3, 1, 'ready',
      100, 100, 1,
      ?4, 'image/png', 10, 10, 100,
      100, ?4, 50, ?4,
      ?5, ?5, ?5
    )
  `).run(
    input.attachmentId,
    input.uploadId,
    input.paneId,
    digest,
    NOW.toISOString(),
  );
  database.query(`
    INSERT INTO chat_attachment_draft_leases (
      attachment_id, pane_id, expires_at, created_at
    ) VALUES (?1, ?2, ?3, ?4)
  `).run(
    input.attachmentId,
    input.paneId,
    (input.expiresAt ?? later(3_600)).toISOString(),
    NOW.toISOString(),
  );
}

function attachmentLease(database: Database): {
  state: string;
  released_at: string | null;
} {
  const row = database.query<{
    state: string;
    released_at: string | null;
  }, []>(`
    SELECT state, released_at FROM chat_attachment_turn_leases
    WHERE attachment_id = '${READY_ATTACHMENT}'
  `).get();
  if (row === null) throw new Error("attachment lease is missing");
  return row;
}

function captureStoreError(run: () => unknown): ChatPaneStoreError {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  if (!(caught instanceof ChatPaneStoreError)) {
    throw new Error("expected a ChatPaneStoreError");
  }
  return caught;
}

function later(seconds: number): Date {
  return new Date(NOW.getTime() + seconds * 1_000);
}
