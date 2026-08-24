import { describe, expect, test } from "bun:test";

import { renderFailure, renderProtectedInteractionDetail, renderSuccess, safeDiagnostic, type Output } from "./render";
import type { ProtectedInteractionDetailDocument, PublicInteraction } from "../domain/interactions";
import type { SessionEventPage } from "../domain/session-events";

const capture = (): { output: Output; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      writeStdout: (value) => { stdout.push(value); },
      writeStderr: (value) => { stderr.push(value); },
    },
  };
};

const command = { kind: "session.show", session: "session-1", detail: false } as const;
const data = {
  session: { id: "session-1", title: "Local title", state: "idle" },
  effectiveRuntimeProfile: {
    profileId: "acct_00000000000000000000000000000000",
    processGeneration: 3,
    observedAt: 2_000,
    preset: "high",
    model: "gpt-5.6-sol",
    reasoningEffort: "max",
    serviceTier: null,
    fast: false,
    approvalPolicy: "on-request",
    reviewMode: "auto_review",
    permissionProfile: ":workspace",
    computerUse: true,
    pluginCapability: true,
    enabledApps: [{ id: "app.files", name: "Files", pluginDisplayNames: ["Files plugin"] }],
  },
  projection: {
    providerThreadId: "thread-1",
    title: "Fix bounded history",
    status: "idle",
    projectRoot: "/workspace/project",
    messages: [
      { role: "user", text: "please fix it", turnId: "turn-1" },
      { role: "assistant", text: "fixed\nverified", turnId: "turn-1", omission: { originalUtf8Bytes: 18, returnedUtf8Bytes: 14, omittedUtf8Bytes: 4 } },
    ],
    turnSummaries: [
      { id: "turn-1", status: "completed", runtimeMs: 1_234, files: ["src/index.ts"], actions: ["git status", "bun test"], omittedFiles: 0, omittedActions: 0 },
    ],
    omission: { hasMoreOlderTurns: true, returnedTurns: 1, turnLimit: 24, omittedMessages: 2, truncatedMessages: 1, unreadItemTurnIds: [], incompleteTurnIds: [] },
  },
};

describe("CLI rendering", () => {
  test("renders pending-login cancellation as a fresh-start handoff", () => {
    const canceled = capture();
    renderSuccess({ kind: "account.login-cancel", account: "personal" }, {
      status: "canceled",
      providerStatus: "not_found",
    }, false, canceled.output);
    expect(canceled.stdout.join("")).toBe("Canceled the pending login (not_found). You can start a fresh login now.\n");
    const settled = capture();
    renderSuccess({ kind: "account.login-cancel", account: "personal" }, {
      status: "already_settled",
    }, false, settled.output);
    expect(settled.stdout.join("")).toBe("No login is pending for this account.\n");
  });

  test("generic account-login rendering strips provider handoff secrets in every mode", () => {
    const command = {
      account: "personal",
      deviceCode: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000101",
      kind: "account.login" as const,
    };
    const secret = "RENDER-LOGIN-SECRET";
    const attacked = {
      account: {
        id: `acct_${"1".repeat(32)}`,
        label: "Personal",
        processGeneration: 1,
        state: "login_pending",
        updatedAt: 1,
      },
      idempotencyKey: command.idempotencyKey,
      login: {
        loginId: secret,
        next: secret,
        status: "pending",
        userCode: secret,
        verificationUrl: `https://example.test/?secret=${secret}`,
        unexpected: secret,
      },
      unexpected: secret,
    };
    for (const json of [false, true]) {
      const target = capture();
      renderSuccess(command, attacked, json, target.output);
      const rendered = `${target.stdout.join("")}${target.stderr.join("")}`;
      expect(rendered).not.toContain(secret);
      if (json) {
        expect(JSON.parse(rendered)).toMatchObject({
          data: { login: { status: "pending" } },
        });
      }
    }
  });

  test("renders a same-key signed-out login settlement as terminal", () => {
    const target = capture();
    renderSuccess({
      account: `acct_${"1".repeat(32)}`,
      deviceCode: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000101",
      kind: "account.login",
    }, {
      account: {
        id: `acct_${"1".repeat(32)}`,
        label: "Personal",
        processGeneration: 1,
        state: "signed_out",
        updatedAt: 2,
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000101",
      login: { status: "settled" },
    }, false, target.output);
    expect(target.stdout.join("")).toContain("settled");
    expect(target.stdout.join("")).toContain("signed out");
  });

  test("renders session show as an ergonomic transcript and bounded turn summaries", () => {
    const target = capture();
    renderSuccess(command, data, false, target.output);
    expect(target.stdout.join("")).toBe([
      "Fix bounded history",
      "State: idle",
      "Project: /workspace/project",
      "",
      "Runtime",
      "  account: acct_00000000000000000000000000000000 generation 3",
      "  preset: high",
      "  model: gpt-5.6-sol",
      "  reasoning effort: max",
      "  service tier: default",
      "  Fast: disabled",
      "  review: auto_review",
      "  permission profile: :workspace",
      "  computer use: enabled",
      "  plugin capability: enabled",
      "  enabled apps: Files (Files plugin)",
      "  observed at: 2000",
      "History: showing 1 recent turns; older turns omitted",
      "History: 2 messages omitted",
      "",
      "Messages",
      "You  turn-1",
      "  please fix it",
      "",
      "Codex  turn-1",
      "  fixed",
      "  verified",
      "  … [4 UTF-8 bytes omitted]",
      "",
      "Turns",
      "turn-1  completed  1.2s",
      "  files: src/index.ts",
      "  actions: git status, bun test",
      "",
    ].join("\n"));
    expect(target.stderr).toEqual([]);
    expect(target.stdout.join("")).not.toContain("providerThreadId");
  });

  test("keeps JSON output versioned and structurally exact", () => {
    const target = capture();
    renderSuccess(command, data, true, target.output);
    expect(JSON.parse(target.stdout.join(""))).toEqual({
      ok: true,
      version: 1,
      command: "session.show",
      data,
    });
    expect(target.stderr).toEqual([]);
  });

  test("escapes OSC, BEL, and bidi controls in both human and JSON output", () => {
    const attack = "\u001b]0;owned\u0007\u202etxt";
    const attacked = {
      ...data,
      projection: {
        ...data.projection,
        title: attack,
        messages: [{ role: "assistant", text: `${attack}\nvisible`, turnId: attack }],
        turnSummaries: [{ id: attack, status: "completed", runtimeMs: 1, files: [attack], actions: ["git status"], omittedFiles: 0, omittedActions: 0 }],
      },
    };
    const human = capture();
    renderSuccess(command, attacked, false, human.output);
    const humanText = human.stdout.join("");
    expect(humanText).not.toContain("\u001b");
    expect(humanText).not.toContain("\u0007");
    expect(humanText).not.toContain("\u202e");
    expect(humanText).toContain("\\u{001b}");
    expect(humanText).toContain("\\u{0007}");
    expect(humanText).toContain("\\u{202e}");

    const json = capture();
    renderSuccess(command, attacked, true, json.output);
    const jsonText = json.stdout.join("");
    expect(jsonText).not.toContain("\u001b");
    expect(jsonText).not.toContain("\u0007");
    expect(jsonText).not.toContain("\u202e");
    expect(jsonText).toContain("\\u202e");
    expect(JSON.parse(jsonText)).toEqual({ ok: true, version: 1, command: command.kind, data: attacked });
  });

  test("renders desktop switch recovery outcomes without exposing evidence internals", () => {
    const target = capture();
    renderSuccess(
      { kind: "account.switch-recover" },
      {
        status: "recovery_required",
        switchGeneration: 7,
        diagnostic: "PROCESS_SET_CHANGED",
        observationDigest: "a".repeat(64),
      },
      false,
      target.output,
    );
    expect(target.stdout).toEqual([
      "Desktop switch 7 still requires recovery: PROCESS_SET_CHANGED.\n",
    ]);
    expect(target.stdout.join("")).not.toContain("observationDigest");
    expect(target.stderr).toEqual([]);
  });

  test("renders plugin discovery as read-only and withholds path-bearing load diagnostics", () => {
    const sentinel = "/workspace/private/marketplace.json";
    const list = capture();
    renderSuccess(
      { account: "work", kind: "plugin.list", refresh: false },
      {
        catalog: {
          featuredPluginIds: ["files@official"],
          lifecycle: {
            discovery: "available",
            enablement: "no_separate_pinned_method",
            install: "blocked_compound_upstream_effect",
            oauth: "separate_foreground_only",
          },
          marketplaceLoadErrorCount: 2,
          marketplaceLoadErrors: [{ message: `failed at ${sentinel}` }],
          marketplaces: [{
            displayName: "Official",
            name: "official",
            path: sentinel,
            plugins: [{
              authPolicy: "ON_USE",
              displayName: "Files",
              enabled: false,
              id: "files@official",
              installed: false,
              name: "files",
            }],
          }],
        },
      },
      false,
      list.output,
    );
    const listText = list.stdout.join("");
    expect(listText).toContain("Files");
    expect(listText).toContain("Marketplace load errors: 2");
    expect(listText).toContain("details withheld");
    expect(listText).toContain("Lifecycle: discovery only.");
    expect(listText).toContain("HRA blocks that compound effect.");
    expect(listText).not.toContain(sentinel);
    expect(listText).not.toContain("failed at");
    expect(listText).not.toContain("hra plugin install");

    const attack = "\u001b]0;owned\u0007\u202etxt";
    const show = capture();
    renderSuccess(
      { account: "work", kind: "plugin.show", plugin: "files@official", refresh: false },
      {
        lifecycle: {
          discovery: "available",
          enablement: "no_separate_pinned_method",
          install: "blocked_compound_upstream_effect",
          oauth: "separate_foreground_only",
        },
        marketplace: { displayName: "Official", name: "official", path: sentinel },
        plugin: {
          authPolicy: "ON_USE",
          availability: "AVAILABLE",
          capabilities: ["search"],
          disabledReason: null,
          displayName: `Files${attack}`,
          enabled: false,
          id: "files@official",
          installPolicy: "AVAILABLE",
          installed: false,
          localPath: sentinel,
          name: "files",
          shortDescription: `Search connected files${attack}`,
        },
      },
      false,
      show.output,
    );
    const showText = show.stdout.join("");
    expect(showText).toContain("Files\\u{001b}]0;owned\\u{0007}\\u{202e}txt");
    expect(showText).toContain("Lifecycle: discovery only.");
    expect(showText).not.toContain("\u001b");
    expect(showText).not.toContain("\u0007");
    expect(showText).not.toContain("\u202e");
    expect(showText).not.toContain(sentinel);
  });

  test("renders session status and coalesced safe event progress", () => {
    const status = capture();
    renderSuccess(
      { kind: "session.status", session: "release" },
      {
        session: {
          id: "sess_00000000000000000000000000000000",
          title: "Release",
          state: "active",
          activeTurnId: "turn-1",
          revision: 4,
        },
        eventStream: {
          floorSequence: 2,
          observedThroughSequence: 9,
        },
        pendingInteractions: [{
          version: 1,
          id: "a0000000-0000-4000-8000-000000000009",
          sessionId: "sess_00000000000000000000000000000000",
          kind: "command_approval",
          state: "pending",
          revision: 2,
          blocking: true,
          display: {
            kind: "command_approval",
            summary: "Run release verification",
            reason: null,
            commandClass: "test",
            workingDirectory: null,
            availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
          },
          responseRecorded: false,
          context: { turnId: "turn-1", itemId: "item-1" },
          requestedAt: 1_000,
          deadlineAt: 61_000,
          updatedAt: 1_000,
          terminalAt: null,
        }],
      },
      false,
      status.output,
    );
    expect(status.stdout.join("")).toBe([
      "Release",
      "State: active",
      "Active turn: turn-1",
      "Revision: 4",
      "Events: through 9, retained from 2",
      "",
      "Pending interactions",
      "STATE    KIND              SUMMARY                   DEADLINE                  REVISION  ID",
      "pending  command_approval  Run release verification  1970-01-01T00:01:01.000Z  2         a0000000-0000-4000-8000-000000000009",
      "",
    ].join("\n"));

    const sessionId = "sess_00000000000000000000000000000000" as const;
    const accountId = "acct_00000000000000000000000000000000" as const;
    const streamEpoch = "90000000-0000-4000-8000-000000000001";
    const base = {
      version: 1 as const,
      sessionId,
      streamEpoch,
      recordedAt: 1_000,
      accountId,
      providerGeneration: 1,
      providerConnectionId: null,
    };
    const page: SessionEventPage = {
      version: 1,
      sessionId,
      requestedCursor: "old",
      retentionFloorCursor: "floor",
      observedThroughCursor: "next",
      nextCursor: "next",
      gap: { reason: "retention_count", requestedSequence: 1, retainedFromSequence: 2 },
      events: [
        { ...base, sequence: 2, body: { type: "assistant_delta", turnId: "turn-1", itemId: "item-1", text: "done " } },
        { ...base, sequence: 3, body: { type: "assistant_delta", turnId: "turn-1", itemId: "item-1", text: "and verified" } },
        { ...base, sequence: 4, body: { type: "tool_progress", turnId: "turn-1", itemId: "tool-1", toolKind: "command", status: "started", outputBytesObserved: 0 } },
        { ...base, sequence: 5, body: { type: "tool_progress", turnId: "turn-1", itemId: "tool-1", toolKind: "command", status: "completed", outputBytesObserved: 120 } },
      ],
    };
    const events = capture();
    renderSuccess(
      { kind: "session.events", session: "release", limit: 200, waitMs: 0 },
      page,
      false,
      events.output,
    );
    expect(events.stdout.join("")).toContain("Event gap: retention_count");
    expect(events.stdout.join("")).toContain("Codex\n  done and verified");
    expect(events.stdout.join("").match(/Codex/gu)).toHaveLength(1);
    expect(events.stdout.join("")).toContain("Tool: command, completed, 120 bytes observed");
    expect(events.stdout.join("")).not.toContain("started");
  });

  test("renders public interaction lists and details without private callback authority", () => {
    const record: PublicInteraction = {
      version: 1,
      id: "a0000000-0000-4000-8000-000000000001",
      sessionId: "sess_00000000000000000000000000000000",
      kind: "user_input",
      state: "pending",
      revision: 2,
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Choose a release channel",
        blocking: true,
        questions: [{
          id: "release-channel",
          header: "Channel",
          question: "Where should this go?",
          options: [{ label: "Beta", description: "Share with beta testers." }],
          allowsOther: true,
          secret: true,
        }],
      },
      responseRecorded: false,
      context: { turnId: "turn-visible", itemId: "item-visible" },
      requestedAt: 1_000,
      deadlineAt: Date.now() + 60_000,
      updatedAt: 1_001,
      terminalAt: null,
    };
    const list = capture();
    renderSuccess(
      { kind: "interaction.list", pending: true, limit: 100 },
      { interactions: [record] },
      false,
      list.output,
    );
    const listText = list.stdout.join("");
    expect(listText).toContain("Choose a release channel");
    expect(listText).toContain(record.id);
    expect(listText).not.toContain("private-request");
    expect(listText).not.toContain("requestDigest");

    const show = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      { interaction: record },
      false,
      show.output,
    );
    const showText = show.stdout.join("");
    expect(showText).toContain("Channel (protected input)");
    expect(showText).toContain("ID: release-channel");
    expect(showText).toContain("Where should this go?");
    expect(showText).toContain("Deadline:");
    expect(showText).toContain("Remaining:");
    expect(showText).toContain(
      'Protected answer document: {"answers":{"release-channel":{"answers":["<answer>"]}}}',
    );
    expect(showText).not.toContain("thread-private");

    const json = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      { interaction: record },
      true,
      json.output,
    );
    const payload = JSON.parse(json.stdout.join("")) as { data: { interaction: Record<string, unknown> } };
    expect(payload.data.interaction).not.toHaveProperty("authority");
    expect(payload.data.interaction).not.toHaveProperty("responseDigest");
    expect(payload.data.interaction).toMatchObject({
      id: record.id,
      revision: 2,
      state: "pending",
    });

    const permission: PublicInteraction = {
      ...record,
      id: "a0000000-0000-4000-8000-000000000002",
      kind: "permission_approval",
      display: {
        allowsSessionScope: true,
        kind: "permission_approval",
        reason: "Needed for the requested task",
        requested: [{ name: "network" }, { name: "fileSystem" }],
        summary: "Allow requested permissions",
      },
    };
    const permissionShow = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: permission.id },
      { interaction: permission },
      false,
      permissionShow.output,
    );
    expect(permissionShow.stdout.join("")).toContain(
      'Protected grant document: {"permissions":["network","fileSystem"]}',
    );
  });

  test("renders private approval authority only through the explicit protected renderer", () => {
    const privateCommand = "git reset --hard RENDER-PRIVATE-AUTHORITY";
    const document: ProtectedInteractionDetailDocument = {
      type: "hra_protected_interaction_detail",
      version: 1,
      binding: {
        interactionId: "40000000-0000-4000-8000-000000000001",
        revision: 2,
        kind: "command_approval",
        sessionId: null,
        profileId: `acct_${"1".repeat(32)}`,
        processGeneration: 7,
        connectionId: "40000000-0000-4000-8000-000000000002",
      },
      authority: {
        kind: "command_approval",
        command: privateCommand,
        reason: "Apply the exact command",
        availableDecisions: ["accept", "decline", "cancel"],
        workingDirectory: "/private/workspace",
        environmentId: null,
        commandActions: [{ type: "unknown", command: privateCommand }],
        networkApprovalContext: null,
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    };
    const protectedRendered = renderProtectedInteractionDetail(document);
    expect(protectedRendered).toContain(privateCommand);
    expect(protectedRendered).toContain("/private/workspace");

    for (const json of [false, true]) {
      const rendered = capture();
      renderSuccess({
        kind: "interaction.inspect",
        interaction: document.binding.interactionId,
        expectedRevision: document.binding.revision,
      }, document, json, rendered.output);
      const generic = `${rendered.stdout.join("")}${rendered.stderr.join("")}`;
      expect(generic).not.toContain(privateCommand);
      expect(generic).not.toContain("/private/workspace");
    }
  });

  test("renders interaction continuations with the resolved immutable session ID and preserves cursors in JSON", () => {
    const sessionId = "sess_00000000000000000000000000000000";
    const cursor = "hra1.eyJ0eXBlIjoiaW50ZXJhY3Rpb24ifQ.signature";
    const data = { sessionId, interactions: [], nextCursor: cursor };
    const human = capture();
    renderSuccess(
      { kind: "session.interactions", session: "mutable-label", pending: true, limit: 37 },
      data,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toContain(
      `Continue: hra session interactions ${sessionId} --pending --limit 37 --cursor ${cursor}\n`,
    );
    expect(human.stdout.join("")).not.toContain("mutable-label");

    const status = capture();
    renderSuccess(
      { kind: "session.status", session: "mutable-label" },
      {
        session: { id: sessionId, state: "idle" },
        eventStream: {},
        pendingInteractions: [],
        pendingInteractionsNextCursor: cursor,
      },
      false,
      status.output,
    );
    expect(status.stdout.join("")).toContain(
      `Continue pending interactions: hra session interactions ${sessionId} --pending --limit 100 --cursor ${cursor}\n`,
    );
    expect(status.stdout.join("")).not.toContain("mutable-label");
    const statusJson = capture();
    renderSuccess(
      { kind: "session.status", session: "mutable-label" },
      {
        session: { id: sessionId, state: "idle" },
        eventStream: {},
        pendingInteractions: [],
        pendingInteractionsNextCursor: cursor,
      },
      true,
      statusJson.output,
    );
    expect(JSON.parse(statusJson.stdout.join(""))).toMatchObject({
      data: { pendingInteractionsNextCursor: cursor },
    });

    const global = capture();
    renderSuccess(
      { kind: "interaction.list", pending: false, limit: 100 },
      { sessionId: null, interactions: [], nextCursor: cursor },
      false,
      global.output,
    );
    expect(global.stdout.join("")).toContain(
      `Continue: hra interaction list --limit 100 --cursor ${cursor}\n`,
    );

    const json = capture();
    renderSuccess(
      { kind: "interaction.list", session: "mutable-label", pending: true, limit: 37 },
      data,
      true,
      json.output,
    );
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      data: { interactions: [], nextCursor: cursor, sessionId },
    });
  });

  test("renders session-list continuations with the resolved account ID and preserves cursors in JSON", () => {
    const accountId = "acct_00000000000000000000000000000000";
    const cursor = "hra1.eyJ0eXBlIjoic2Vzc2lvbl9saXN0In0.signature";
    const listing = {
      accountId,
      sessions: [{
        id: "sess_00000000000000000000000000000000",
        title: "Older imported thread",
        state: "idle",
        preset: "high",
        fastEnabled: false,
      }],
      nextCursor: cursor,
    };
    const human = capture();
    renderSuccess(
      { kind: "session.list", account: "mutable-label", limit: 37, cursor: "earlier" },
      listing,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toContain("Older imported thread");
    expect(human.stdout.join("")).toContain(
      `Continue: hra session list --account ${accountId} --limit 37 --cursor ${cursor}\n`,
    );
    expect(human.stdout.join("")).not.toContain("mutable-label");

    const json = capture();
    renderSuccess(
      { kind: "session.list", account: "mutable-label", limit: 37 },
      listing,
      true,
      json.output,
    );
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      data: { accountId, nextCursor: cursor, sessions: listing.sessions },
    });

    const malformed = capture();
    renderSuccess(
      { kind: "session.list", account: "mutable-label", limit: 37 },
      { ...listing, nextCursor: "provider-cursor-must-not-render" },
      false,
      malformed.output,
    );
    expect(malformed.stdout.join("")).not.toContain("Continue:");
    expect(malformed.stdout.join("")).not.toContain("provider-cursor-must-not-render");
  });

  test("renders brokered MCP form input as protected", () => {
    const record: PublicInteraction = {
      version: 1,
      id: "b0000000-0000-4000-8000-000000000001",
      sessionId: null,
      kind: "mcp_elicitation",
      state: "pending",
      revision: 1,
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Authorize the server",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
        fields: [
          {
            name: "email",
            type: "string",
            required: true,
            minLength: 3,
            maxLength: 320,
            format: "email",
          },
          {
            name: "channel",
            type: "single_select",
            required: false,
            choices: ["stable", "fast"],
          },
        ],
      },
      responseRecorded: false,
      context: { turnId: null, itemId: null },
      requestedAt: 1,
      deadlineAt: Date.now() + 60_000,
      updatedAt: 1,
      terminalAt: null,
    };
    const target = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      record,
      false,
      target.output,
    );
    expect(target.stdout.join("")).toContain("Input: protected");
    expect(target.stdout.join("")).toContain("email: string, required, 3..320 characters, format email");
    expect(target.stdout.join("")).toContain("channel: single select, optional, choices stable, fast");
    expect(target.stdout.join("")).toContain('{"content":{...}}');
    expect(target.stdout.join("")).not.toContain("SENTINEL");
    const json = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      record,
      true,
      json.output,
    );
    expect(json.stdout.join("")).not.toContain("SENTINEL");
    const payload = JSON.parse(json.stdout.join("")) as {
      data: { interaction: { display: { fields?: unknown; url: unknown; mayContainSecrets: unknown } } };
    };
    expect(payload).toMatchObject({
      data: {
        interaction: {
          display: {
            url: null,
            mayContainSecrets: true,
          },
        },
      },
    });
    if (record.display.kind !== "mcp_elicitation") throw new Error("Expected MCP display.");
    expect(payload.data.interaction.display.fields).toEqual(record.display.fields);
  });

  test("serializes undefined output as JSON null instead of throwing", () => {
    const target = capture();
    renderSuccess({ kind: "daemon.stop" }, undefined, false, target.output);
    expect(target.stdout).toEqual(["null\n"]);
  });

  test("bounds and redacts error diagnostics in human and JSON output", () => {
    const secret = "token=do-not-print";
    const attack = `provider failed at /private/runtime ${secret}\u001b]52;c;attack\u0007`;
    for (const json of [false, true]) {
      const target = capture();
      renderFailure({
        code: "UNAVAILABLE",
        message: attack,
        details: { diagnostic: attack },
      }, json, target.output);
      const rendered = [...target.stdout, ...target.stderr].join("");
      expect(rendered).not.toContain("do-not-print");
      expect(rendered).not.toContain("/private/runtime");
      expect(rendered).not.toContain("\u001b");
      expect(rendered).not.toContain("\u0007");
      expect(rendered).toContain("[redacted]");
    }
    expect(safeDiagnostic("provider failed at /private/runtime")).toContain("[local-path]");

    const internal = capture();
    renderFailure({ code: "INTERNAL", message: attack, details: { secret: attack } }, true, internal.output);
    const payload = JSON.parse(internal.stdout.join("")) as { error: Record<string, unknown> };
    expect(payload.error).toEqual({
      code: "INTERNAL",
      message: "HRA could not complete the request safely.",
    });
  });

  test("redacts complete credential grammars before diagnostic bounding", () => {
    const amazonKey = "AKIA".concat("ABCDEFGHIJKLMNOP");
    const secrets = [
      ["Authorization: Basic dTpw", "dTpw"],
      ["Basic dTpw", "dTpw"],
      ["HTTP_AUTHORIZATION=Basic dTpw", "dTpw"],
      ["client_secret=topsecret123", "topsecret123"],
      ["AWS_SECRET_ACCESS_KEY=AWSOPAQUESECRET123", "AWSOPAQUESECRET123"],
      ["OPENAI_API_KEY=opaque123", "opaque123"],
      ["MY_PASSWORD=myPasswordSecret123", "myPasswordSecret123"],
      ["clientSecret=camelClientSecret123", "camelClientSecret123"],
      ["apiKey=camelApiKey123", "camelApiKey123"],
      ["accessToken=camelAccessToken123", "camelAccessToken123"],
      ["refreshToken=camelRefreshToken123", "camelRefreshToken123"],
      ["secretAccessKey=camelSecretAccessKey123", "camelSecretAccessKey123"],
      ["api key=spaced123", "spaced123"],
      ["provider sk-proj-ABCDEFGH123456 failed", "sk-proj-ABCDEFGH123456"],
      ["github_pat_ABCDEFGH123456", "github_pat_ABCDEFGH123456"],
      ["xoxb-12345678-secret", "xoxb-12345678-secret"],
      [amazonKey, amazonKey],
    ] as const;
    for (const [source, secret] of secrets) {
      const rendered = safeDiagnostic(source);
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain(secret);
    }
    for (const source of [
      "access_token=Bearer SUPERSECRET123",
      "password=`secret tail`",
      'password="secret tail',
      "password=alpha,beta;gamma",
    ]) {
      expect(safeDiagnostic(source)).toBe("[redacted]");
    }
    for (const source of [
      "pass\u001bword=hunter2",
      "github_\u001bpat_ABCDEFGH123456",
      "sk-\u200bproj-ABCDEFGH123456",
      "Bearer\u001b]0;owned\u0007 abc123",
      "pass\ufe0fword=VARIATIONSECRET123",
      "pass\u034fword=CGJSECRET456",
    ]) {
      expect(safeDiagnostic(source)).toBe("[redacted]");
    }
    for (const source of [
      "password\u00a0=\u00a0hunter2",
      "password\u2009=\u2009hunter2",
      "password\u202f=\u202fhunter2",
    ]) {
      expect(safeDiagnostic(source)).toBe("[redacted]");
    }
    for (const source of [
      '{"client_secret":"jsonClientSecret123","access_token":"jsonAccessToken456"}',
      "{'apiKey':'singleQuotedSecret123'}",
      "{`refreshToken`:`backtickSecret456`}",
    ]) {
      const rendered = safeDiagnostic(source);
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain("Secret123");
      expect(rendered).not.toContain("Token456");
      expect(rendered).not.toContain("Secret456");
    }
    for (const source of [
      '{\n  "client_secret":\n  "prettyJsonSecret123"\n}',
      "password=\n multilineSecret456",
    ]) {
      const rendered = safeDiagnostic(source);
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain("prettyJsonSecret123");
      expect(rendered).not.toContain("multilineSecret456");
    }
    const cutoffJwt = `prefix ${"x".repeat(2_025)} eyJ${"A".repeat(80)}`;
    const renderedJwt = safeDiagnostic(cutoffJwt);
    expect(renderedJwt).toContain("[redacted]");
    expect(renderedJwt).not.toContain(`eyJ${"A".repeat(8)}`);
  });

  test("redacts values associated with sensitive structured diagnostic keys", () => {
    for (const json of [false, true]) {
      const target = capture();
      renderFailure({
        code: "UNAVAILABLE",
        message: "provider failed",
        details: {
          client_secret: "hunter2",
          nested: {
            apiKey: "opaque123",
            entries: [{ Authorization: "Basic dTpw" }],
          },
          "pass\u001bword": "controlBypass456",
          "config.apiKey": "flattenedApiSecret789",
          "auth/token": "flattenedTokenSecret123",
          "credentials:client_secret": "flattenedClientSecret456",
          $password: "sigilPasswordSecret123",
          "config\\apiKey": "backslashApiSecret456",
          "credentials password": "spacedPasswordSecret789",
        },
      }, json, target.output);
      const rendered = [...target.stdout, ...target.stderr].join("");
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain("hunter2");
      expect(rendered).not.toContain("opaque123");
      expect(rendered).not.toContain("dTpw");
      expect(rendered).not.toContain("controlBypass456");
      expect(rendered).not.toContain("flattenedApiSecret789");
      expect(rendered).not.toContain("flattenedTokenSecret123");
      expect(rendered).not.toContain("flattenedClientSecret456");
      expect(rendered).not.toContain("sigilPasswordSecret123");
      expect(rendered).not.toContain("backslashApiSecret456");
      expect(rendered).not.toContain("spacedPasswordSecret789");
    }
  });

  test("renders source-ordered account usage-history pages and safe continuations", () => {
    const command = {
      kind: "account.usage-history" as const,
      account: "work",
      limit: 2,
    };
    const data = {
      account: {
        id: `acct_${"1".repeat(32)}`,
        label: "Work",
      },
      range: {
        fromObservedAt: 1_700_000_000_000,
        throughObservedAt: 1_700_000_300_000,
      },
      entries: [
        {
          state: "observed",
          sourceRevision: 7,
          observedAt: 1_700_000_060_000,
          receivedAt: 1_700_000_061_000,
          lifetimeTokens: 12_345,
          gapBefore: false,
        },
        {
          state: "failed",
          sourceRevision: 8,
          observedAt: 1_700_000_120_000,
          reasonCode: "account_usage_read_failed",
        },
      ],
      nextCursor: "hrau1.abc.def",
    };
    const human = capture();
    renderSuccess(command, data, false, human.output);
    const rendered = human.stdout.join("");
    expect(rendered).toContain("Usage history for Work");
    expect(rendered).toContain("12,345");
    expect(rendered).toContain("account_usage_read_failed");
    expect(rendered).toContain("Continue: hra account usage-history acct_");
    expect(rendered).toContain("--cursor hrau1.abc.def");

    const json = capture();
    renderSuccess(command, data, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      ok: true,
      command: "account.usage-history",
      data: {
        entries: [
          { sourceRevision: 7, state: "observed" },
          { sourceRevision: 8, state: "failed" },
        ],
        nextCursor: "hrau1.abc.def",
      },
    });

    const attacked = capture();
    renderSuccess(command, {
      ...data,
      providerPayload: { access_token: "PRIVATE-USAGE-SENTINEL" },
    }, true, attacked.output);
    expect(attacked.stdout.join("")).not.toContain("PRIVATE-USAGE-SENTINEL");
    expect(JSON.parse(attacked.stdout.join(""))).toMatchObject({
      data: { account: null, entries: [], nextCursor: null, range: null },
    });
  });

  test("renders historical usage health and velocity without dumping provider payloads", () => {
    const target = capture();
    renderSuccess(
      { account: "work", kind: "account.usage", refresh: false },
      {
        refresh: {
          accountLimit: 32,
          concurrency: 4,
          outcomes: [
            { accountId: "acct_00000000000000000000000000000000", state: "refreshed" },
            {
              accountId: "acct_11111111111111111111111111111111",
              accountState: "signed_out",
              reason: "not_signed_in",
              state: "skipped",
            },
          ],
        },
        usage: [{
          account: { id: "acct_00000000000000000000000000000000", label: "Work" },
          poll: { observedAt: 1_700_000_000_000, sourceRevision: 4, state: "observed" },
          snapshot: {
            observedAt: 1_700_000_000_000,
            payload: {
              privateProviderField: "must-not-render",
              rateLimits: { primary: { usedPercent: 27.5 } },
              usage: { summary: { lifetimeTokens: 12_345 } },
            },
          },
          velocity: {
            "1m": { available: true, tokensPerMinute: 42.25 },
            "5m": { available: false, reason: "insufficient_history" },
            "15m": { available: false, reason: "stale_gap" },
          },
        }],
      },
      false,
      target.output,
    );
    const rendered = target.stdout.join("");
    expect(rendered).toContain("Work\n");
    expect(rendered).toContain("lifetime tokens: 12,345");
    expect(rendered).toContain("primary limit used: 27.5%");
    expect(rendered).toContain("1m 42.3 tokens/min");
    expect(rendered).toContain("Refresh outcomes");
    expect(rendered).toContain("acct_00000000000000000000000000000000: refreshed");
    expect(rendered).toContain("acct_11111111111111111111111111111111: skipped (signed_out)");
    expect(rendered).toContain("5m unavailable (insufficient_history)");
    expect(rendered).not.toContain("must-not-render");
  });

  test("fails closed instead of dumping malformed interaction or event payloads", () => {
    const sentinel = "SECRET_SENTINEL";
    const interaction = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: "c0000000-0000-4000-8000-000000000001" },
      { interaction: { rawProviderRequest: sentinel } },
      false,
      interaction.output,
    );
    expect(interaction.stdout).toEqual(["Interaction data is unavailable.\n"]);
    expect(interaction.stdout.join("")).not.toContain(sentinel);

    const interactionJson = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: "c0000000-0000-4000-8000-000000000001" },
      { interaction: { rawProviderRequest: sentinel } },
      true,
      interactionJson.output,
    );
    expect(JSON.parse(interactionJson.stdout.join(""))).toMatchObject({
      data: { interaction: null },
    });
    expect(interactionJson.stdout.join("")).not.toContain(sentinel);

    const events = capture();
    renderSuccess(
      { kind: "session.events", session: "release", limit: 200, waitMs: 0 },
      { rawProviderEvent: sentinel },
      false,
      events.output,
    );
    expect(events.stdout).toEqual(["Event page data is unavailable.\n"]);
    expect(events.stdout.join("")).not.toContain(sentinel);
  });
});
