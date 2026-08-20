import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  runtimeProtocolVersion,
  type ChatPaneProjection,
  type RuntimeChatMessageLedgerCommand,
  type RuntimeDispatchResponse,
} from "../../../../contracts/runtime";
import type { RuntimeShell } from "../../runtime";
import { emptyRuntimeSnapshot } from "../../runtime/test-fixtures";
import {
  ChatPaneView,
  composerSubmissionAction,
  dispatchMessageQueueMutation,
  freezeComposerRequest,
  paneAcceptsUserInteraction,
  paneTitleKeyAction,
  scheduleOffRequiresCommand,
  settleComposerRequest,
} from "./ChatPane";

function pane(
  interactionMode: ChatPaneProjection["interactionMode"],
  overrides: Partial<ChatPaneProjection> = {},
): ChatPaneProjection {
  return {
    id: "pane_observerview01",
    paletteIndex: 0,
    revision: 1,
    title: "Research actor",
    repository: { id: "repo_observerview00000000000000", name: "example" },
    accountProfileId: "acct_observerview01",
    interactionMode,
    state: "ready",
    activity: { ordinal: 0, kind: "idle" },
    workspace: interactionMode === "chat"
      ? {
          mode: "managedWorktree",
          state: "ready",
          revision: 1,
          recoveryKind: null,
        }
      : null,
    turn: null,
    attention: null,
    recoverablePrompt: false,
    canStartFreshContext: false,
    schedule: null,
    messageQueue: { revision: 1, pauseReason: null, blockedMessage: null, messages: [] },
    attachments: { drafts: [], referenced: [] },
    harness: null,
    ...overrides,
  };
}

const resolvedStandardRoute = {
  policyVersion: 1,
  classificationReason: "conservativeDefault",
  workClass: "standard",
  requestedProfile: "solMax",
  selectedProfile: "solMax",
  profileFallbackReason: null,
  requestedServiceTier: "standard",
  selectedServiceTier: "standard",
  serviceTierFallbackReason: null,
} as const;

function shellFor(projectedPane: ChatPaneProjection): RuntimeShell {
  return {
    getSnapshot: () => ({
      state: "ready" as const,
      snapshot: {
        ...emptyRuntimeSnapshot(),
        chat: { revision: 1, panes: [projectedPane] },
      },
    }),
    subscribe: () => () => undefined,
  } as unknown as RuntimeShell;
}

test("harness observer panes retain transcript and rename chrome without user controls", () => {
  const observer = pane("harnessObserver");
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 6,
    pane: observer,
    shell: shellFor(observer),
  }));

  expect(paneAcceptsUserInteraction(observer)).toBeFalse();
  expect(html).toContain('data-pane-interaction-mode="harnessObserver"');
  expect(html).toContain(
    "Chat pane: Research actor, repository example, owner This Mac, state Ready, cell 7",
  );
  expect(html).toContain("Transcript for Research actor");
  expect(html).toContain('class="pane-title"');
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("Message Codex");
  expect(html).not.toContain("Automatic subscription");
  expect(html).not.toContain("Sol reasoning effort");
  expect(html).not.toContain("Model routing");
  expect(html).not.toContain("Choose project for Research actor");
  expect(html).not.toContain("Close Research actor");
});

test("workspace recovery exposes one compact retry action and no message composer", () => {
  const waiting = pane("chat", {
    workspace: {
      mode: "managedWorktree",
      state: "waitingCapacity",
      revision: 2,
      recoveryKind: "capacityUnavailable",
    },
  });
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 6,
    pane: waiting,
    shell: shellFor(waiting),
  }));

  expect(html).toContain("Workspace is waiting for capacity.");
  expect(html).toContain("Recover isolated workspace for Research actor");
  expect(html).not.toContain("<textarea");
  expect(html).not.toContain("Message Codex");
});

test("ordinary chat panes preserve interaction chrome and fail closed before hydration", async () => {
  const chat = pane("chat");
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 6,
    pane: chat,
    shell: shellFor(chat),
  }));

  expect(paneAcceptsUserInteraction(chat)).toBeTrue();
  expect(html).toContain('data-pane-interaction-mode="chat"');
  expect(html).not.toContain("No response yet.");
  expect(html).not.toContain("<textarea");
  expect(html).toContain("Choose project for Research actor");
  expect(html).toContain("More actions for Research actor");
  expect(html).not.toContain('aria-label="Model routing"');
  expect(html).not.toContain("Fast mode");
  const source = await Bun.file(new URL("./ChatPane.tsx", import.meta.url)).text();
  expect(source).toContain('pane.interactionMode !== "chat" ? null : <footer className="chat-pane__composer">');
  expect(source).toContain("{!showComposerForm ? null : <form");
  expect(source).toContain(
    'label={scheduling ? `Schedule $' + '{pane.title}` : `Message $' + '{pane.title}`}',
  );
  expect(source).toContain('<MenuItem id="rename" textValue="Rename pane">');
  expect(source).not.toContain('label="Codex subscription"');
  expect(source).not.toContain('Automatic subscription');
  expect(source).not.toContain("placeholder=");
  expect(source).not.toContain("accountProfileId:");
  expect(source).toContain('className="hra-visually-hidden"');
  expect(source).not.toContain('className="example-visually-hidden"');
  expect(source).not.toContain('aria-label="Model routing"');
  expect(source).not.toContain("ModelRoutingToggle");
  expect(source).not.toContain("FastModeToggle");
  expect(source).toContain("recoverPaneWorkspaceCommand");
});

test("scheduled panes show one concise next-run status without RRULE details", () => {
  const scheduled = pane("chat", {
    schedule: {
      revision: 1,
      rrule: "DTSTART;TZID=America/Puerto_Rico:20260824T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO",
      timeZone: "America/Puerto_Rico",
      nextRunAt: "2026-08-24T13:00:00.000Z",
    },
  });
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: scheduled,
    shell: shellFor(scheduled),
    surface: { attachments: [], nowUnixMilliseconds: Date.parse("2026-08-24T12:00:00.000Z") },
  }));

  expect(html).toContain('data-pane-scheduled="true"');
  expect(html).toContain("Scheduled · in 1h");
  expect(html).not.toContain("FREQ=WEEKLY");
});

test("scheduled panes retain the turn-off control when their workspace is unavailable", () => {
  const scheduled = pane("chat", {
    state: "attention",
    attention: {
      code: "runtime_unavailable",
      message: "The isolated workspace needs recovery.",
      retryable: true,
    },
    workspace: {
      mode: "managedWorktree",
      state: "recoveryRequired",
      revision: 2,
      recoveryKind: "unknown",
    },
    schedule: {
      revision: 1,
      rrule: "DTSTART;TZID=America/Puerto_Rico:20260824T090000\nRRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO",
      timeZone: "America/Puerto_Rico",
      nextRunAt: "2026-08-24T13:00:00.000Z",
    },
  });
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: scheduled,
    shell: shellFor(scheduled),
  }));

  expect(html).toContain('aria-label="Turn off scheduling"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain("<textarea");
  expect(html).toContain("disabled");
});

test("schedule off dispatches after a submitted configure even before projection", () => {
  const projectedSchedule = pane("chat", {
    schedule: {
      revision: 1,
      rrule: "DTSTART;TZID=America/Puerto_Rico:20260824T090000\nRRULE:FREQ=DAILY;INTERVAL=1",
      timeZone: "America/Puerto_Rico",
      nextRunAt: "2026-08-24T13:00:00.000Z",
    },
  }).schedule;
  expect(scheduleOffRequiresCommand(null, false)).toBeFalse();
  expect(scheduleOffRequiresCommand(null, true)).toBeTrue();
  expect(scheduleOffRequiresCommand(projectedSchedule, false)).toBeTrue();
});

test("fresh-context quarantine renders the explicit action and orphan quarantine stays blocked", () => {
  const attention = {
    code: "runtime_unavailable" as const,
    message: "Prior provider context is quarantined.",
    retryable: false,
  };
  const queue = {
    revision: 3,
    pauseReason: "attention" as const,
    blockedMessage: null,
    messages: [],
  };
  const resettable = pane("chat", {
    state: "attention",
    attention,
    canStartFreshContext: true,
    messageQueue: queue,
  });
  const resettableHtml = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: resettable,
    shell: shellFor(resettable),
  }));
  expect(resettableHtml).toContain(">Start fresh<");
  expect(resettableHtml).not.toContain(">Resume<");

  const orphan = { ...resettable, canStartFreshContext: false };
  const orphanHtml = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: orphan,
    shell: shellFor(orphan),
  }));
  expect(orphanHtml).not.toContain(">Start fresh<");
  expect(orphanHtml).not.toContain(">Resume<");
  expect(orphanHtml).toContain("Prior provider context is quarantined.");
});

test("ordinary panes keep HRA's internal dispatch route out of compact chat chrome", () => {
  const routed = pane("chat", {
    turn: {
      id: "chatturn_autoroute001",
      status: "completed",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      continuationCount: 0,
      responseMarkdown: { tail: "Done", totalUtf8Bytes: 4, truncatedPrefix: false },
      reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      reasoningSummaryVerified: false,
      tools: [],
      providerSubagents: { agents: [], overflowCount: 0 },
      routing: {
        policyVersion: 1,
        classificationReason: "boundedLeafCue",
        workClass: "boundedLeaf",
        requestedProfile: "lunaMax",
        selectedProfile: "solMax",
        profileFallbackReason: "lunaUnavailable",
        requestedServiceTier: "fast",
        selectedServiceTier: "standard",
        serviceTierFallbackReason: "fastUnavailable",
      },
    },
  });
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: routed,
    shell: shellFor(routed),
  }));

  expect(html).toContain("Done");
  expect(html).not.toContain("Route ·");
  expect(html).not.toContain("HRA requested Luna Max");
  expect(html).not.toContain("boundedLeafCue");
  expect(html).not.toContain("lunaUnavailable");
});

test("active sanctioned thinking and answers share Markdown while tools stay invisible", () => {
  const working = pane("chat", {
    state: "streaming",
    activity: { ordinal: 3, kind: "toolStarted" },
    turn: {
      id: "chatturn_markdownview01",
      status: "streaming",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: null,
      continuationCount: 0,
      responseMarkdown: {
        tail: "## Answer\n\n**Streaming** now.",
        totalUtf8Bytes: 29,
        truncatedPrefix: false,
      },
      reasoningSummary: {
        tail: "Checking `current state`.",
        totalUtf8Bytes: 25,
        truncatedPrefix: false,
      },
      reasoningSummaryVerified: false,
      tools: [{ id: "chattool_hiddenview01", category: "filesystem", status: "running" }],
      providerSubagents: { agents: [], overflowCount: 0 },
      routing: resolvedStandardRoute,
    },
  });
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: working,
    shell: shellFor(working),
  }));

  expect(html).toContain('aria-label="Thinking"');
  expect(html).toContain('data-markdown-kind="reasoning"');
  expect(html).toContain('data-streamdown="inline-code">current state</code>');
  expect(html).toContain('data-markdown-kind="response"');
  expect(html).toContain('data-streamdown="strong">Streaming</span>');
  expect(html).not.toContain("Latest tool");
  expect(html).not.toContain("pane-tool");
  expect(html).not.toContain("hiddenview01");
});

test("terminal turns withhold reasoning until a completion receipt exists", () => {
  const completed = pane("chat", {
    turn: {
      id: "chatturn_terminalsummary",
      status: "completed",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:04.000Z",
      continuationCount: 0,
      responseMarkdown: { tail: "Answer", totalUtf8Bytes: 6, truncatedPrefix: false },
      reasoningSummary: {
        tail: "This incomplete terminal tail must stay hidden.",
        totalUtf8Bytes: 46,
        truncatedPrefix: false,
      },
      reasoningSummaryVerified: false,
      tools: [],
      providerSubagents: { agents: [], overflowCount: 0 },
      routing: resolvedStandardRoute,
    },
  });
  const html = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: completed,
    shell: shellFor(completed),
  }));

  expect(html).toContain("Answer");
  expect(html).not.toContain("incomplete terminal tail");
  expect(html).not.toContain('aria-label="Thinking"');

  const verified = pane("chat", {
    ...completed,
    turn: completed.turn === null ? null : {
      ...completed.turn,
      reasoningSummaryVerified: true,
    },
  });
  const verifiedHtml = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: verified,
    shell: shellFor(verified),
  }));
  expect(verifiedHtml).toContain("incomplete terminal tail");
});

test("only an active ordinary root chat exposes the compact Stop action", () => {
  const activeTurn = {
    id: "chatturn_observerview01",
    status: "streaming" as const,
    startedAt: "2026-08-03T12:00:00.000Z",
    completedAt: null,
    continuationCount: 0,
    responseMarkdown: { tail: "Working", totalUtf8Bytes: 7, truncatedPrefix: false },
    reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
    reasoningSummaryVerified: false,
    tools: [],
    providerSubagents: { agents: [], overflowCount: 0 },
    routing: resolvedStandardRoute,
  };
  const chat = pane("chat", {
    state: "streaming",
    turn: activeTurn,
    messageQueue: {
      revision: 4,
      pauseReason: "ambiguousEffect",
      blockedMessage: {
        id: "chatmsg_unknownactive01",
        ordinal: 1,
        revision: 2,
        text: "Possibly delivered",
        attachmentRefs: [],
        deliveryOutcome: "deliveryOutcomeUnknown",
      },
      messages: [],
    },
  });
  const chatHtml = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 0,
    pane: chat,
    shell: shellFor(chat),
  }));
  const observer = pane("harnessObserver", {
    state: "streaming",
    turn: { ...activeTurn, routing: null },
  });
  const observerHtml = renderToStaticMarkup(createElement(ChatPaneView, {
    gridPosition: 1,
    pane: observer,
    shell: shellFor(observer),
  }));

  expect(chatHtml).toContain('aria-label="Stop Research actor"');
  expect(chatHtml).toContain('aria-label="Discard message with unknown delivery outcome"');
  expect(chatHtml).toContain('class="pane-queue-discard" disabled=""');
  expect(chatHtml).not.toContain("Close Research actor");
  expect(chatHtml).toContain("More actions for Research actor");
  expect(observerHtml).not.toContain("Stop Research actor");
  expect(observerHtml).not.toContain("Close Research actor");
});

test("failed private prompts cannot bypass the durable queue", async () => {
  const source = await Bun.file(new URL("./ChatPane.tsx", import.meta.url)).text();
  expect(source).toContain("enqueueMessageCommand({");
  expect(source).not.toContain("chat.turn.start");
  expect(source).not.toContain("chat.turn.retry");
  expect(source).not.toContain('controlClassName="pane-retry"');
});

test("composer retries freeze exact delivery and rotate after a proved not-applied outcome", () => {
  const ids = ["chatmsg_rotatedretry001", "chatmsg_freshretry00001"];
  const createId = () => {
    const next = ids.shift();
    if (next === undefined) throw new Error("Unexpected message ID allocation.");
    return next;
  };
  const initial = freezeComposerRequest({
    existing: null,
    currentMessageId: "chatmsg_originalretry01",
    contentSignature: '{"text":"same","attachmentRefs":[]}',
    steerModifier: true,
    delivery: { kind: "steerHead", expectedTurnId: "chatturn_retrydelivery1" },
    createMessageId: createId,
  });
  const afterTerminalHydration = freezeComposerRequest({
    existing: initial.frozen,
    currentMessageId: initial.currentMessageId,
    contentSignature: initial.frozen.contentSignature,
    steerModifier: true,
    delivery: { kind: "queue" },
    createMessageId: createId,
  });
  expect(afterTerminalHydration).toEqual(initial);

  const notApplied = settleComposerRequest("notApplied", createId);
  expect(notApplied).toEqual({
    clearDraft: false,
    nextMessageId: "chatmsg_rotatedretry001",
  });
  const fresh = freezeComposerRequest({
    existing: null,
    currentMessageId: notApplied.nextMessageId,
    contentSignature: initial.frozen.contentSignature,
    steerModifier: true,
    delivery: { kind: "queue" },
    createMessageId: createId,
  });
  expect(fresh.frozen).toMatchObject({
    messageId: "chatmsg_rotatedretry001",
    delivery: { kind: "queue" },
  });
});

test("composer and title shortcuts preserve IME composition and steer only the FIFO head", () => {
  const base = {
    key: "Enter",
    shiftKey: false,
    metaKey: true,
    ctrlKey: false,
    active: true,
    hasQueuedHead: true,
  };
  expect(composerSubmissionAction({ ...base, isComposing: true })).toBe("none");
  expect(composerSubmissionAction({ ...base, isComposing: false }))
    .toBe("steerQueuedHead");
  expect(composerSubmissionAction({
    ...base,
    isComposing: false,
    metaKey: false,
  })).toBe("sendComposer");
  expect(paneTitleKeyAction({ isComposing: true, key: "Enter" })).toBeNull();
  expect(paneTitleKeyAction({ isComposing: true, key: "Escape" })).toBeNull();
  expect(paneTitleKeyAction({ isComposing: false, key: "Enter" })).toBe("commit");
  expect(paneTitleKeyAction({ isComposing: false, key: "Escape" })).toBe("cancel");
});

test("queue mutation dispatch accepts only the exact pane queue result", async () => {
  const command: RuntimeChatMessageLedgerCommand = {
    type: "chat.message.remove",
    paneId: "pane_observerview01",
    expectedQueueRevision: 3,
    messageId: "chatmsg_queueview0001",
    expectedMessageRevision: 2,
  };
  const queue: ChatPaneProjection["messageQueue"] = {
    revision: 4,
    pauseReason: null,
    blockedMessage: null,
    messages: [],
  };
  const response = {
    version: runtimeProtocolVersion,
    operationId: "op_queueview000000000000000001",
    ok: true,
    result: {
      type: "chatMessageQueue",
      paneId: command.paneId,
      queue,
      disposition: "applied",
      messageId: command.messageId,
    },
  } satisfies RuntimeDispatchResponse;
  expect(await dispatchMessageQueueMutation({
    dispatch: () => Promise.resolve(response),
  }, command)).toEqual(response.result);
  let rejection: unknown = null;
  try {
    await dispatchMessageQueueMutation({
      dispatch: () => Promise.resolve({
        ...response,
        result: { ...response.result, paneId: "pane_otherqueue01" },
      }),
    }, command);
  } catch (reason: unknown) {
    rejection = reason;
  }
  if (!(rejection instanceof Error)) throw new Error("Queue mismatch did not reject.");
  expect(rejection.message).toContain("wrong message queue result");
});

test("only the explicitly activated pane exposes a live transcript", () => {
  const chat = pane("chat");
  const background = renderToStaticMarkup(createElement(ChatPaneView, {
    announcementActive: false,
    gridPosition: 6,
    pane: chat,
    shell: shellFor(chat),
  }));
  const active = renderToStaticMarkup(createElement(ChatPaneView, {
    announcementActive: true,
    gridPosition: 6,
    pane: chat,
    shell: shellFor(chat),
  }));

  expect(background).not.toContain('role="log"');
  expect(background).not.toContain('aria-live=');
  expect(active).toContain('role="log"');
  expect(active).toContain('aria-live="polite"');
  expect(active.match(/aria-live=/gu)).toHaveLength(1);
});

test("local interaction and title failures remain live and field-associated", async () => {
  const source = await Bun.file(new URL("./ChatPane.tsx", import.meta.url)).text();

  expect(source).toContain('const composerErrorId = `chat-pane-composer-error-$' + '{pane.id}`;');
  expect(source).toContain('"aria-describedby": composerError === null ? undefined : composerErrorId');
  expect(source).toContain('"aria-invalid": localError === null ? undefined : true');
  expect(source.match(/id=\{composerErrorId\}/gu)).toHaveLength(2);
  expect(source.match(/role="alert"/gu)).toHaveLength(3);
  expect(source).toContain("aria-describedby\": errorId");
});
