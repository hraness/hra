import { describe, expect, test } from "bun:test";

import { renderSuccess, type Output } from "./render";
import type { InteractionRecord } from "../domain/interactions";
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
        floorSequence: 2,
        observedThroughSequence: 9,
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

  test("renders interaction lists and details without private callback authority", () => {
    const record: InteractionRecord = {
      version: 1,
      publicId: "a0000000-0000-4000-8000-000000000001",
      sessionId: "sess_00000000000000000000000000000000",
      authority: {
        profileId: "acct_00000000000000000000000000000000",
        processGeneration: 3,
        connectionId: "a0000000-0000-4000-8000-000000000002",
        requestId: { type: "string", value: "private-request" },
        method: "item/tool/requestUserInput",
        requestDigest: "a".repeat(64),
        threadId: "thread-private",
        turnId: "turn-private",
        itemId: "item-private",
        approvalId: null,
      },
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
      responseDigest: null,
      requestedAt: 1_000,
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
    expect(listText).toContain(record.publicId);
    expect(listText).not.toContain("private-request");
    expect(listText).not.toContain("requestDigest");

    const show = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.publicId },
      { interaction: record },
      false,
      show.output,
    );
    const showText = show.stdout.join("");
    expect(showText).toContain("Channel (protected input)");
    expect(showText).toContain("Where should this go?");
    expect(showText).not.toContain("thread-private");
    expect(showText).not.toContain(record.authority.requestDigest);

    const json = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.publicId },
      { interaction: record },
      true,
      json.output,
    );
    const payload = JSON.parse(json.stdout.join("")) as { data: { interaction: Record<string, unknown> } };
    expect(payload.data.interaction).not.toHaveProperty("authority");
    expect(payload.data.interaction).not.toHaveProperty("responseDigest");
    expect(payload.data.interaction).toMatchObject({
      publicId: record.publicId,
      revision: 2,
      state: "pending",
    });
  });

  test("redacts secret-bearing MCP URLs from human interaction output", () => {
    const record: InteractionRecord = {
      version: 1,
      publicId: "b0000000-0000-4000-8000-000000000001",
      sessionId: null,
      authority: {
        profileId: "acct_00000000000000000000000000000000",
        processGeneration: 1,
        connectionId: "b0000000-0000-4000-8000-000000000002",
        requestId: { type: "number", value: 1 },
        method: "mcpServer/elicitation/request",
        requestDigest: "b".repeat(64),
        threadId: null,
        turnId: null,
        itemId: null,
        approvalId: null,
      },
      kind: "mcp_elicitation",
      state: "pending",
      revision: 1,
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Authorize the server",
        serverName: "example",
        mode: "url",
        url: "https://example.com/authorize?secret=SENTINEL",
        mayContainSecrets: true,
      },
      responseDigest: null,
      requestedAt: 1,
      updatedAt: 1,
      terminalAt: null,
    };
    const target = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.publicId },
      record,
      false,
      target.output,
    );
    expect(target.stdout.join("")).toContain("URL: protected");
    expect(target.stdout.join("")).not.toContain("SENTINEL");
    const json = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.publicId },
      record,
      true,
      json.output,
    );
    expect(json.stdout.join("")).not.toContain("SENTINEL");
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      data: { interaction: { display: { url: null, mayContainSecrets: true } } },
    });
  });

  test("serializes undefined output as JSON null instead of throwing", () => {
    const target = capture();
    renderSuccess({ kind: "daemon.stop" }, undefined, false, target.output);
    expect(target.stdout).toEqual(["null\n"]);
  });

  test("renders historical usage health and velocity without dumping provider payloads", () => {
    const target = capture();
    renderSuccess(
      { account: "work", kind: "account.usage", refresh: false },
      {
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
