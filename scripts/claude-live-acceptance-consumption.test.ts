import { describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { publicInteractionSchema } from "../src/domain/interactions";
import { SessionEventStreamRedactor, type SessionEventWrite } from "../src/daemon/streaming-redaction";
import { sessionEventPageSchema, type SessionEvent, type SessionEventBody } from "../src/domain/session-events";
import { createProfileId, createSessionId } from "../src/domain/values";
import { projectPublicProviderIdentifier } from "../src/public-provider-identifier";
import {
  verifyClaudeLiveAcceptanceConsumption,
  type ClaudeLiveAcceptanceConsumptionInput,
} from "./claude-live-acceptance-consumption";

// Synthetic event fixtures exercise public wire validation, not provider proof.
const alias = (raw: string) => projectPublicProviderIdentifier(raw, Buffer.alloc(32, 0x43));
const cursor = (sequence: number) =>
  `hra1.${Buffer.from(`synthetic:${String(sequence)}`).toString("base64url")}.${"A".repeat(43)}`;

function fixture() {
  const sessionId = createSessionId();
  const profileId = createProfileId();
  const connectionId = randomUUID();
  const epoch = randomUUID();
  const turnId = alias("synthetic-turn");
  const nonce = `claude-live-${"c".repeat(32)}`;
  const submissionId = `memsub_${randomUUID().replaceAll("-", "")}`;
  const receiptSha256 = "d".repeat(64);
  const prompt = `Remember the one nonce ${nonce}; return the actual receipt only.`;
  const echo = JSON.stringify({ submissionId, receiptSha256, nonce });
  const interaction = publicInteractionSchema.parse({
    version: 1, id: randomUUID(), sessionId, kind: "permission_approval", state: "pending",
    revision: 1, blocking: true, display: {
      kind: "permission_approval", summary: "Synthetic memory permission", reason: null,
      requested: [{ name: "mcp__hra__memory_remember" }], allowsSessionScope: false,
    },
    responseRecorded: false, context: { turnId, itemId: null },
    requestedAt: 1, deadlineAt: 1_000, updatedAt: 1, terminalAt: null,
  });
  const written = publicInteractionSchema.parse({ ...interaction,
    state: "response_written", revision: 3, responseRecorded: true, updatedAt: 3 });
  const bodies: SessionEventBody[] = [
    { type: "connection", state: "connected" },
    { type: "turn_started", turnId },
    { type: "interaction_requested", interactionId: interaction.id, interactionKind: "permission_approval",
      revision: 1, blocking: true, summary: "Synthetic memory permission" },
    { type: "interaction_state", interactionId: interaction.id, state: "response_prepared", revision: 2 },
    { type: "interaction_state", interactionId: interaction.id, state: "response_written", revision: 3 },
    { type: "assistant_delta", turnId, itemId: alias("assistant"), text: echo.slice(0, 70) },
    { type: "assistant_delta", turnId, itemId: alias("assistant"), text: echo.slice(70) },
    { type: "turn_completed", turnId, status: "completed" },
    // Fast completion can precede the committed send/user-event publication.
    { type: "user_message", turnId, actor: "human", text: prompt, omittedCharacters: 0 },
    { type: "session_status", status: "idle", activeTurnId: null },
  ];
  const event = (body: SessionEventBody, sequence: number): SessionEvent => ({
    version: 1, sessionId, streamEpoch: epoch, sequence, recordedAt: sequence,
    accountId: profileId, providerGeneration: 3, providerConnectionId: connectionId, body,
  });
  const events = bodies.map((body, index) => event(body, index + 1));
  const page = (entries: SessionEvent[], requested: string | null = null, through = entries.at(-1)?.sequence ?? 0) => ({
    version: 1 as const, sessionId, requestedCursor: requested,
    retentionFloorCursor: cursor(0), observedThroughCursor: cursor(through),
    nextCursor: cursor(entries.at(-1)?.sequence ?? (requested === null ? 0 : through)),
    gap: null, events: entries,
  });
  const controller = new AbortController();
  const input: ClaudeLiveAcceptanceConsumptionInput = {
    connectionId, interaction, written, nonce, profileGeneration: 3, profileId, prompt,
    receiptSha256, sessionId, signal: controller.signal, submissionId,
    readPage: async () => page(events),
  };
  return { input, events, event, page, echo, controller, turnId };
}

const refused = async (input: ClaudeLiveAcceptanceConsumptionInput): Promise<void> => {
  await expect(verifyClaudeLiveAcceptanceConsumption(input)).rejects.toMatchObject({
    code: "consumption_unproven", message: "claude_live_acceptance_consumption_unproven",
  });
};

describe("bounded Claude public-event consumption", () => {
  test("joins exact private receipt to one public turn and emits only its echo digest", async () => {
    const f = fixture();
    sessionEventPageSchema.parse(f.page(f.events));
    const evidence = await verifyClaudeLiveAcceptanceConsumption(f.input);
    expect(evidence).toEqual({ exactReceiptEcho: true,
      echoSha256: createHash("sha256").update(f.echo).digest("hex") });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(f.input.submissionId);
    expect(JSON.stringify(evidence)).not.toContain(f.turnId);
  });

  test("drains split pages with exact cursor and epoch continuity", async () => {
    const f = fixture();
    const seen: Array<string | undefined> = [];
    const pages = [f.page(f.events.slice(0, 4), null, 10), f.page(f.events.slice(4, 7), cursor(4), 10),
      f.page(f.events.slice(7), cursor(7), 10)];
    const result = await verifyClaudeLiveAcceptanceConsumption({ ...f.input, readPage: async (requested) => {
      seen.push(requested); return pages[seen.length - 1];
    } });
    expect(result?.exactReceiptEcho).toBe(true);
    expect(seen).toEqual([undefined, cursor(4), cursor(7)]);
  });

  test("consumes the exact receipt after production item lifecycle, redaction, and public ID projection", async () => {
    const f = fixture();
    const redactor = new SessionEventStreamRedactor({
      isCodexSession: () => false,
      projectPublicProviderIdentifier: alias,
    });
    const rawBodies: SessionEventBody[] = f.events.map(({ body }) => ({
      ...body,
      ...("turnId" in body ? { turnId: "synthetic-turn" } : {}),
      ...("itemId" in body ? { itemId: "assistant" } : {}),
    }));
    rawBodies.splice(5, 0, {
      type: "item_started", turnId: "synthetic-turn", itemId: "assistant", itemKind: "agentMessage",
    });
    rawBodies.splice(8, 0, {
      type: "item_completed", turnId: "synthetic-turn", itemId: "assistant",
      itemKind: "agentMessage", status: "completed",
    });
    const projected: SessionEventWrite[] = rawBodies.flatMap((body) => redactor.accept({
      sessionId: f.input.sessionId, accountId: f.input.profileId,
      providerGeneration: f.input.profileGeneration, providerConnectionId: f.input.connectionId, body,
    }));
    const events = projected.map((entry, index) => ({
      ...f.event(entry.body, index + 1), ...entry,
    }));
    expect(redactor.activeStreamCount).toBe(0);
    expect(events.filter(({ body }) => body.type === "assistant_delta")
      .map(({ body }) => body.type === "assistant_delta" ? body.text : "").join("")).toBe(f.echo);
    expect((await verifyClaudeLiveAcceptanceConsumption({
      ...f.input, readPage: async () => f.page(events),
    }))?.exactReceiptEcho).toBe(true);
  });

  test("accepts one semantically exact JSON document independent of spacing and key order", async () => {
    const f = fixture();
    Object.assign(f.events[5]!.body, { text: "  \n" });
    Object.assign(f.events[6]!.body, { text: JSON.stringify({ nonce: f.input.nonce,
      receiptSha256: f.input.receiptSha256, submissionId: f.input.submissionId }, null, 2) });
    expect(await verifyClaudeLiveAcceptanceConsumption(f.input)).toEqual({ exactReceiptEcho: true,
      echoSha256: createHash("sha256").update(f.echo).digest("hex") });
  });

  test.each(["extra_key", "duplicate_key", "prose", "fence", "two_documents", "wrong_nonce", "wrong_submission", "wrong_receipt", "oversized"])(
    "refuses completed JSON echo %s", async (kind) => {
      const f = fixture();
      let value = f.echo;
      if (kind === "extra_key") value = JSON.stringify({ ...JSON.parse(f.echo), extra: true });
      if (kind === "duplicate_key") value = f.echo.replace("{", `{"nonce":${JSON.stringify(f.input.nonce)},`);
      if (kind === "prose") value = `${f.echo} Done.`;
      if (kind === "fence") value = `\`\`\`json\n${f.echo}\n\`\`\``;
      if (kind === "two_documents") value += f.echo;
      if (kind === "wrong_nonce") value = value.replace(f.input.nonce, `claude-live-${"e".repeat(32)}`);
      if (kind === "wrong_submission") value = value.replace(f.input.submissionId, randomUUID());
      if (kind === "wrong_receipt") value = value.replace(f.input.receiptSha256, "e".repeat(64));
      if (kind === "oversized") value += " ".repeat(4_096);
      Object.assign(f.events[5]!.body, { text: "" });
      Object.assign(f.events[6]!.body, { text: value });
      await refused(f.input);
    },
  );

  test("returns null only for a valid drained incomplete prefix", async () => {
    const f = fixture();
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7]) {
      expect(await verifyClaudeLiveAcceptanceConsumption({ ...f.input,
        readPage: async () => f.page(f.events.slice(0, length)) })).toBeNull();
    }
  });

  test("clones caller authority before awaiting a foreign page", async () => {
    const f = fixture();
    const input = { ...f.input, readPage: async () => {
      input.nonce = `claude-live-${"e".repeat(32)}`;
      input.interaction.context.turnId = alias("changed-input");
      return f.page(f.events);
    } };
    expect((await verifyClaudeLiveAcceptanceConsumption(input))?.exactReceiptEcho).toBe(true);
  });

  const eventFailures: ReadonlyArray<readonly [string, (f: ReturnType<typeof fixture>) => void]> = [
    ["wrong profile", (f) => { f.events[2]!.accountId = createProfileId(); }],
    ["wrong generation", (f) => { f.events[2]!.providerGeneration += 1; }],
    ["wrong connection", (f) => { f.events[5]!.providerConnectionId = randomUUID(); }],
    ["missing connection", (f) => { f.events[5]!.providerConnectionId = null; }],
    ["changed epoch", (f) => { f.events[5]!.streamEpoch = randomUUID(); }],
    ["omitted first event", (f) => { f.events.shift(); }],
    ["duplicate sequence", (f) => { f.events[4]!.sequence = 4; }],
    ["wrong user text", (f) => { Object.assign(f.events[8]!.body, { text: "another prompt" }); }],
    ["omitted user text", (f) => { Object.assign(f.events[8]!.body, { omittedCharacters: 1 }); }],
    ["nonhuman user", (f) => { Object.assign(f.events[8]!.body, { actor: "autorespond" }); }],
    ["null user turn", (f) => { Object.assign(f.events[8]!.body, { turnId: null }); }],
    ["other turn", (f) => { Object.assign(f.events[5]!.body, { turnId: alias("other") }); }],
    ["raw turn", (f) => { Object.assign(f.events[5]!.body, { turnId: "raw-native-id" }); }],
    ["wrong partial echo", (f) => { Object.assign(f.events[5]!.body, { text: "not the receipt" }); }],
    ["second assistant item", (f) => { Object.assign(f.events[6]!.body, { itemId: alias("other-item") }); }],
    ["failed turn", (f) => { Object.assign(f.events[7]!.body, { status: "failed" }); }],
    ["interrupted turn", (f) => { Object.assign(f.events[7]!.body, { status: "interrupted" }); }],
    ["completion error", (f) => { Object.assign(f.events[7]!.body, { errorCode: "failed" }); }],
    ["wrong permission", (f) => { Object.assign(f.events[2]!.body, { interactionId: randomUUID() }); }],
    ["wrong permission kind", (f) => { Object.assign(f.events[2]!.body, { interactionKind: "command_approval" }); }],
    ["nonblocking permission", (f) => { Object.assign(f.events[2]!.body, { blocking: false }); }],
    ["wrong permission revision", (f) => { Object.assign(f.events[2]!.body, { revision: 2 }); }],
    ["wrong prepared revision", (f) => { Object.assign(f.events[3]!.body, { revision: 3 }); }],
    ["wrong written revision", (f) => { Object.assign(f.events[4]!.body, { revision: 4 }); }],
    ["unsettled permission", (f) => { Object.assign(f.events[4]!.body, { state: "resolution_unknown" }); }],
    ["terminal session", (f) => { Object.assign(f.events[9]!.body, { status: "terminal" }); }],
    ["other active turn", (f) => { Object.assign(f.events[9]!.body, { activeTurnId: alias("other") }); }],
    ["provider reconnect", (f) => { Object.assign(f.events[0]!.body, { state: "resubscribed" }); }],
    ["foreign event field", (f) => { Object.assign(f.events[0]!, { unknown: true }); }],
  ];
  test.each(eventFailures)("refuses %s", async (_name, mutate) => {
    const f = fixture(); mutate(f); await refused(f.input);
  });

  test.each(["user_message", "turn_started", "turn_completed", "interaction_requested", "assistant_delta"] as const)(
    "refuses an extra or late %s", async (type) => {
      const f = fixture();
      const source = f.events.find((event) => event.body.type === type)!;
      f.events.push({ ...source, sequence: f.events.length + 1 });
      await refused(f.input);
    },
  );

  test.each(["user_message", "turn_started", "interaction_requested", "response_prepared", "response_written"])(
    "refuses completed evidence missing %s", async (type) => {
      const f = fixture();
      const events = f.events.filter((event) => event.body.type !== type
        && !(event.body.type === "interaction_state" && event.body.state === type))
        .map((event, index) => ({ ...event, sequence: index + 1 }));
      await refused({ ...f.input, readPage: async () => f.page(events) });
    },
  );

  test("does not hide a wrong echo in an incomplete drained snapshot", async () => {
    const f = fixture(); Object.assign(f.events[5]!.body, { text: "wrong" });
    await refused({ ...f.input, readPage: async () => f.page(f.events.slice(0, 6)) });
  });

  test.each(["header_gap", "body_gap", "error", "warning", "provider_switch"])("refuses %s evidence", async (kind) => {
    const f = fixture();
    const page: Record<string, unknown> = f.page(f.events);
    if (kind === "header_gap") page.gap = { reason: "retention_count", requestedSequence: 0, retainedFromSequence: 1 };
    if (kind === "body_gap") f.events[0]!.body = { type: "gap", reason: "provider_disconnect", fromSequence: 1, throughSequence: 1 };
    if (kind === "error") f.events[0]!.body = { type: "error", code: "synthetic", message: "private", terminal: false };
    if (kind === "warning") f.events[0]!.body = { type: "warning", code: "synthetic", message: "private" };
    if (kind === "provider_switch") f.events[0]!.body = { type: "provider_switched", fromProvider: "claude", toProvider: "claude",
      fromPreset: "fable-max", toPreset: "fable-max", accountChanged: false,
      seedDigest: "a".repeat(64), transcriptDigest: "b".repeat(64), seedOmittedRecords: 0 };
    await refused({ ...f.input, readPage: async () => page });
  });

  test.each(["cursor", "floor", "epoch", "sequence", "cycle", "extra", "empty"])("refuses cross-page %s mismatch", async (kind) => {
    const f = fixture();
    const first = f.page(f.events.slice(0, 5), null, 10);
    const second: Record<string, unknown> = f.page(f.events.slice(5), cursor(5), 10);
    if (kind === "cursor") second.requestedCursor = cursor(4);
    if (kind === "floor") second.retentionFloorCursor = cursor(1);
    if (kind === "epoch") for (const event of f.events.slice(5)) event.streamEpoch = randomUUID();
    if (kind === "sequence") for (const event of f.events.slice(5)) event.sequence += 1;
    if (kind === "cycle") second.nextCursor = cursor(5);
    if (kind === "extra") second.extra = "private foreign data";
    if (kind === "empty") Object.assign(second, { events: [], nextCursor: cursor(5) });
    let calls = 0;
    await refused({ ...f.input, readPage: async () => ++calls === 1 ? first : second });
    expect(calls).toBe(2);
  });

  test("bounds pages even when every nonterminal page advances", async () => {
    const f = fixture(); let calls = 0;
    await refused({ ...f.input, readPage: async (requested) => {
      calls += 1;
      return f.page([f.event({ type: "connection", state: "connected" }, calls)], requested ?? null, 100);
    } });
    expect(calls).toBe(8);
  });

  test("bounds cumulative foreign bytes independently of page and event counts", async () => {
    const f = fixture(); let calls = 0;
    await refused({ ...f.input, readPage: async (requested) => {
      const offset = calls++ * 12;
      return f.page(Array.from({ length: 12 }, (_value, index) => f.event({
        type: "reasoning_summary_delta", turnId: f.turnId, itemId: alias("reasoning"),
        text: "x".repeat(32_000),
      }, offset + index + 1)), requested ?? null, 100);
    } });
    expect(calls).toBe(6);
  });

  test("aborts before reading and while a page promise is pending", async () => {
    const f = fixture(); let calls = 0;
    f.controller.abort();
    await refused({ ...f.input, readPage: async () => { calls += 1; return f.page(f.events); } });
    expect(calls).toBe(0);
    const running = fixture();
    await refused({ ...running.input, readPage: async () => {
      running.controller.abort(); return await new Promise<never>(() => undefined);
    } });
  });

  test("sanitizes foreign reader failures without retaining private error text", async () => {
    const f = fixture();
    await refused({ ...f.input, readPage: async () => { throw new Error("foreign secret details"); } });
  });

  test.each(["connection", "nonce", "uuid_submission", "prompt_receipt", "prompt_submission", "written", "scope", "extra"])(
    "refuses malformed or mismatched input %s before reading", async (kind) => {
      const f = fixture(); let calls = 0;
      const input = { ...f.input, readPage: async () => { calls += 1; return f.page(f.events); } };
      if (kind === "connection") input.connectionId = "not-a-uuid";
      if (kind === "nonce") input.nonce = "not-the-challenge";
      if (kind === "uuid_submission") input.submissionId = randomUUID();
      if (kind === "prompt_receipt") input.prompt += input.receiptSha256;
      if (kind === "prompt_submission") input.prompt += input.submissionId;
      if (kind === "written") input.written = { ...input.written, revision: 2 };
      if (kind === "scope") input.interaction = { ...input.interaction, sessionId: createSessionId() };
      if (kind === "extra") Object.assign(input, { privateExtra: true });
      await refused(input); expect(calls).toBe(0);
    },
  );
});
