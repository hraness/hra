import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  runtimeProtocolVersion,
  type ChatPaneProjection,
  type RuntimeChatDomainCommand,
  type RuntimeDispatchResponse,
} from "../../../../contracts/runtime";
import type { RuntimeShell } from "../../runtime";
import { emptyRuntimeSnapshot } from "../../runtime/test-fixtures";
import {
  ChatPaneView,
  dispatchRetainedPromptRetry,
  paneAcceptsUserInteraction,
  type PaneRetryMutationPort,
} from "./ChatPane";

function pane(
  interactionMode: ChatPaneProjection["interactionMode"],
  overrides: Partial<ChatPaneProjection> = {},
): ChatPaneProjection {
  return {
    id: "pane_observerview01",
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
  expect(html).toContain("Rename Research actor");
  expect(html).not.toContain('aria-label="Model routing"');
  expect(html).not.toContain("Fast mode");
  const source = await Bun.file(new URL("./ChatPane.tsx", import.meta.url)).text();
  expect(source).toContain('pane.interactionMode !== "chat" ? null : <footer className="chat-pane__composer">');
  expect(source).toContain("{!canMessage ? null : <form");
  expect(source).toContain('label={`Message $' + '{pane.title}`}');
  expect(source).toContain('aria-label={`Rename $' + '{pane.title}`}');
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

test("ordinary panes show HRA's bounded dispatch route for their latest turn", () => {
  const routed = pane("chat", {
    turn: {
      id: "chatturn_autoroute001",
      status: "completed",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      continuationCount: 0,
      responseMarkdown: { tail: "Done", totalUtf8Bytes: 4, truncatedPrefix: false },
      reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      tools: [],
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

  expect(html).toContain("Route · Sol Max · Standard");
  expect(html).toContain(
    '<span class="hra-visually-hidden pane-route-description">HRA requested Luna Max at Fast and selected Sol Max at Standard for dispatch. Luna configuration was unavailable on the selected subscription and Fast service was unavailable on the selected subscription, so HRA used its fallback before dispatch.</span>',
  );
  expect(html).not.toContain("boundedLeafCue");
  expect(html).not.toContain("lunaUnavailable");
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
    tools: [],
    routing: resolvedStandardRoute,
  };
  const chat = pane("chat", { state: "streaming", turn: activeTurn });
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
  expect(chatHtml).not.toContain("Close Research actor");
  expect(chatHtml).toContain("More actions for Research actor");
  expect(observerHtml).not.toContain("Stop Research actor");
  expect(observerHtml).not.toContain("Close Research actor");
});

test("private prompt retry stays icon-only, exact-turn bound, and separately addressable", async () => {
  const source = await Bun.file(new URL("./ChatPane.tsx", import.meta.url)).text();
  expect(source).toContain("paneCanRetryRetainedPrompt(pane)");
  expect(source).toContain("priorFailedTurnId");
  expect(source).toContain("retryTurnCommand({");
  expect(source).toContain('`Retry failed message for $' + '{pane.title}`');
  expect(source).toContain('controlClassName="pane-retry"');
  expect(source).toContain('name="refresh"');
  expect(source).toContain('pendingAction === "retry"');
  expect(source).toContain('pane-retry__icon--pending');
  expect(source).toContain('onPress={() => void retryRetainedPrompt()}');
  expect(source).not.toContain("prompt: pane.activePrompt");
});

test("the Retry icon controller keeps one fresh ID across a benign revision refresh", async () => {
  const failedTurn = {
    id: "chatturn_retryview0001",
    status: "failed" as const,
    startedAt: "2026-08-03T12:00:00.000Z",
    completedAt: "2026-08-03T12:00:01.000Z",
    continuationCount: 0,
    responseMarkdown: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
    reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
    tools: [],
    routing: resolvedStandardRoute,
  };
  let current = pane("chat", {
    revision: 4,
    state: "attention",
    turn: failedTurn,
    attention: { code: "turn_failed", message: "Retry.", retryable: true },
    recoverablePrompt: true,
  });
  const commands: RuntimeChatDomainCommand[] = [];
  const response = (value: RuntimeDispatchResponse): Promise<RuntimeDispatchResponse> =>
    Promise.resolve(value);
  const port: PaneRetryMutationPort = {
    dispatch: (command) => {
      if (command.type !== "chat.turn.retry") {
        throw new Error("Expected only a retained-prompt retry command.");
      }
      commands.push(command);
      if (commands.length === 1) {
        current = { ...current, revision: current.revision + 1 };
        return response({
          version: runtimeProtocolVersion,
          operationId: "op_retryview000000000000000001",
          ok: false,
          error: {
            code: "revision_conflict",
            message: "The pane revision changed.",
            retryable: true,
            action: "retry",
          },
        });
      }
      const started: ChatPaneProjection = {
        ...current,
        revision: current.revision + 1,
        state: "starting",
        turn: {
          ...failedTurn,
          id: "chatturn_retryview0002",
          status: "starting",
          completedAt: null,
        },
        attention: null,
        recoverablePrompt: false,
      };
      return response({
        version: runtimeProtocolVersion,
        operationId: "op_retryview000000000000000002",
        ok: true,
        result: { type: "chatPane", pane: started },
      });
    },
    getState: () => ({
      state: "ready",
      snapshot: {
        ...emptyRuntimeSnapshot(),
        chat: { revision: 1, panes: [current] },
      },
    }),
  };

  const result = await dispatchRetainedPromptRetry(
    port,
    current,
    "chatturn_retryview0002",
  );
  expect(result).toMatchObject({ state: "starting", recoverablePrompt: false });
  expect(commands).toEqual([
    {
      type: "chat.turn.retry",
      paneId: current.id,
      expectedRevision: 4,
      priorFailedTurnId: failedTurn.id,
      turnId: "chatturn_retryview0002",
    },
    {
      type: "chat.turn.retry",
      paneId: current.id,
      expectedRevision: 5,
      priorFailedTurnId: failedTurn.id,
      turnId: "chatturn_retryview0002",
    },
  ]);
  expect(commands.every((command) => !Object.hasOwn(command, "prompt"))).toBeTrue();
});

test("a revision refresh cannot redirect Retry to a lost private-prompt capability", async () => {
  const failed = pane("chat", {
    revision: 4,
    state: "attention",
    turn: {
      id: "chatturn_retryview0001",
      status: "failed",
      startedAt: "2026-08-03T12:00:00.000Z",
      completedAt: "2026-08-03T12:00:01.000Z",
      continuationCount: 0,
      responseMarkdown: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      reasoningSummary: { tail: "", totalUtf8Bytes: 0, truncatedPrefix: false },
      tools: [],
      routing: resolvedStandardRoute,
    },
    attention: { code: "turn_failed", message: "Retry.", retryable: true },
    recoverablePrompt: true,
  });
  const changed: ChatPaneProjection = {
    ...failed,
    revision: 5,
    recoverablePrompt: false,
  };
  let dispatches = 0;
  const port: PaneRetryMutationPort = {
    dispatch: () => {
      dispatches += 1;
      return Promise.resolve({
        version: runtimeProtocolVersion,
        operationId: "op_retryview000000000000000003",
        ok: false,
        error: {
          code: "revision_conflict",
          message: "The pane revision changed.",
          retryable: true,
          action: "retry",
        },
      });
    },
    getState: () => ({
      state: "ready",
      snapshot: {
        ...emptyRuntimeSnapshot(),
        chat: { revision: 1, panes: [changed] },
      },
    }),
  };
  let rejected: unknown;
  try {
    await dispatchRetainedPromptRetry(port, failed, "chatturn_retryview0002");
  } catch (reason: unknown) {
    rejected = reason;
  }
  expect(rejected).toMatchObject({
    name: "PaneCommandError",
    message: "The failed turn changed before the retry could finish.",
  });
  expect(dispatches).toBe(1);
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
