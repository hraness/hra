import { expect, test } from "bun:test";

import {
  chatMessageContentSchema,
  chatMessageQueueProjectionSchema,
  runtimeChatDomainCommandSchema,
  runtimeChatMessageLedgerCommandSchema,
  runtimeChatMessageQueueChangedEventSchema,
  runtimeChatMessageQueueResultSchema,
  runtimeChatMessageUtf8ByteLimit,
  runtimeChatQueueUtf8ByteLimit,
  runtimeEventUtf8ByteLimit,
} from "./runtime";

const PANE = "pane_contractledger1";
const MESSAGE = "chatmsg_contractledger1";
const TURN = "chatturn_contractledger1";

test("message commands are strict, bounded, and are the live chat send authority", () => {
  const queued = runtimeChatMessageLedgerCommandSchema.parse({
    type: "chat.message.enqueue",
    paneId: PANE,
    expectedQueueRevision: 1,
    messageId: MESSAGE,
    content: { text: "queue me", attachmentRefs: [] },
    delivery: { kind: "queue" },
  });
  expect(queued.type).toBe("chat.message.enqueue");
  expect(runtimeChatDomainCommandSchema.safeParse(queued).success).toBe(true);

  expect(runtimeChatMessageLedgerCommandSchema.parse({
    ...queued,
    delivery: { kind: "steerHead", expectedTurnId: TURN },
  })).toMatchObject({
    delivery: { kind: "steerHead", expectedTurnId: TURN },
  });
  expect(() => runtimeChatMessageLedgerCommandSchema.parse({
    ...queued,
    providerTurnId: "provider-private",
  })).toThrow();
  expect(() => runtimeChatMessageLedgerCommandSchema.parse({
    ...queued,
    path: "/private/tmp/image.png",
  })).toThrow();

  for (const command of [
    {
      type: "chat.message.edit",
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: MESSAGE,
      expectedMessageRevision: 1,
      content: { text: "edited", attachmentRefs: [] },
    },
    {
      type: "chat.message.remove",
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: MESSAGE,
      expectedMessageRevision: 1,
    },
    {
      type: "chat.messageQueue.resume",
      paneId: PANE,
      expectedQueueRevision: 2,
    },
    {
      type: "chat.message.discardAmbiguous",
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: MESSAGE,
      expectedMessageRevision: 3,
    },
    {
      type: "chat.message.steerHead",
      paneId: PANE,
      expectedQueueRevision: 2,
      messageId: MESSAGE,
      expectedMessageRevision: 1,
      expectedTurnId: TURN,
    },
  ]) {
    expect(runtimeChatMessageLedgerCommandSchema.safeParse(command).success)
      .toBe(true);
  }
});

test("a valid message has nonblank Unicode text or opaque attachment references", () => {
  expect(chatMessageContentSchema.parse({
    text: "  exact markdown  ",
    attachmentRefs: [],
  }).text).toBe("  exact markdown  ");
  expect(chatMessageContentSchema.parse({
    text: "",
    attachmentRefs: ["attachment_contract001"],
  }).attachmentRefs).toEqual(["attachment_contract001"]);
  for (const invalid of [
    { text: " \n\t ", attachmentRefs: [] },
    { text: "", attachmentRefs: ["/private/tmp/image.png"] },
    {
      text: "",
      attachmentRefs: ["attachment_contract001", "attachment_contract001"],
    },
    { text: "x".repeat(runtimeChatMessageUtf8ByteLimit + 1), attachmentRefs: [] },
  ]) {
    expect(chatMessageContentSchema.safeParse(invalid).success).toBe(false);
  }
});

test("queue projections preserve complete FIFO text under their byte ceiling", () => {
  const exact = "x".repeat(runtimeChatMessageUtf8ByteLimit);
  const queue = chatMessageQueueProjectionSchema.parse({
    revision: 9,
    pauseReason: "runtimeRestart",
    blockedMessage: null,
    messages: Array.from({ length: 4 }, (_, index) => ({
      id: `chatmsg_contract${String(index).padStart(8, "0")}`,
      ordinal: index + 1,
      revision: 1,
      text: exact,
      attachmentRefs: [],
    })),
  });
  expect(queue.messages.reduce(
    (total, message) => total + Buffer.byteLength(message.text, "utf8"),
    0,
  )).toBe(runtimeChatQueueUtf8ByteLimit);
  expect(queue.messages.every((message) => message.text.length === exact.length))
    .toBe(true);

  expect(() => chatMessageQueueProjectionSchema.parse({
    ...queue,
    messages: [...queue.messages, {
      id: "chatmsg_contractoverflow",
      ordinal: 5,
      revision: 1,
      text: "x",
      attachmentRefs: [],
    }],
  })).toThrow();
  expect(() => chatMessageQueueProjectionSchema.parse({
    ...queue,
    messages: queue.messages.toReversed(),
  })).toThrow();
});

test("queue result and bounded invalidation expose only app-owned identities", () => {
  const queue = {
    revision: 2,
    pauseReason: null,
    blockedMessage: null,
    messages: [{
      id: MESSAGE,
      ordinal: 1,
      revision: 1,
      text: "private local text",
      attachmentRefs: ["attachment_contract001"],
    }],
  } as const;
  const result = runtimeChatMessageQueueResultSchema.parse({
    type: "chatMessageQueue",
    paneId: PANE,
    queue,
    disposition: "applied",
    messageId: MESSAGE,
  });
  const event = runtimeChatMessageQueueChangedEventSchema.parse({
    type: "chat.messageQueue.changed",
    paneId: PANE,
    revision: queue.revision,
  });
  const serialized = JSON.stringify({ result, event });
  expect(serialized).not.toMatch(/provider|model|effort|tier|\/private\//u);
  expect(serialized).toContain("private local text");
  expect(Buffer.byteLength(JSON.stringify(event), "utf8"))
    .toBeLessThanOrEqual(runtimeEventUtf8ByteLimit);
});
