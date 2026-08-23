import { describe, expect, test } from "bun:test";

import { CodexAppServerClient } from "./client.ts";
import { CodexError } from "./errors.ts";
import type { CodexProcess } from "./process.ts";
import type { CodexFact, FencedCodexValue } from "./protocol.ts";

const CONNECTION_ID = "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b";

const commandApprovalParams = (reason = "Need network access") => ({
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-1",
  startedAtMs: 1,
  approvalId: null,
  environmentId: null,
  reason,
  networkApprovalContext: null,
  command: "git push origin main",
  cwd: "/workspace/project",
  commandActions: [],
  additionalPermissions: null,
  proposedExecpolicyAmendment: null,
  proposedNetworkPolicyAmendments: null,
  availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
});

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #items: Uint8Array[] = [];
  readonly #waiters: ((result: IteratorResult<Uint8Array>) => void)[] = [];
  #closed = false;

  push(value: string): void {
    const bytes = new TextEncoder().encode(value);
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#items.push(bytes);
    else waiter({ done: false, value: bytes });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        const item = this.#items.shift();
        if (item !== undefined) return { done: false, value: item };
        if (this.#closed) return { done: true, value: undefined };
        return await new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

class FakeProcess implements CodexProcess {
  readonly stdoutQueue = new ByteQueue();
  readonly stderrQueue = new ByteQueue();
  readonly stdout = this.stdoutQueue;
  readonly stderr = this.stderrQueue;
  readonly writes: unknown[] = [];
  readonly signals: ("SIGTERM" | "SIGKILL")[] = [];
  readonly exited: Promise<number>;
  #resolveExit!: (code: number) => void;

  constructor(
    readonly onWrite: (message: Record<string, unknown>, process: FakeProcess) => void,
    readonly shutdown: {
      readonly ignoreTerm?: boolean;
      readonly leaveStreamsOpenAfterKill?: boolean;
    } = {},
  ) {
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  write(bytes: Uint8Array): Promise<void> {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    this.writes.push(parsed);
    this.onWrite(parsed as Record<string, unknown>, this);
    return Promise.resolve();
  }

  respond(value: unknown): void {
    this.stdoutQueue.push(`${JSON.stringify(value)}\n`);
  }

  terminate(): void {
    this.signals.push("SIGTERM");
    if (this.shutdown.ignoreTerm === true) return;
    this.stdoutQueue.close();
    this.stderrQueue.close();
    this.#resolveExit(0);
  }

  forceTerminate(): void {
    this.signals.push("SIGKILL");
    if (this.shutdown.leaveStreamsOpenAfterKill !== true) {
      this.stdoutQueue.close();
      this.stderrQueue.close();
    }
    this.#resolveExit(137);
  }
}

function successfulFake(codexHome: string, userAgent = "codex-cli/0.149.0"): FakeProcess {
  return new FakeProcess((message, process) => {
    if (message.method === "initialize") {
      process.respond({
        id: message.id,
        result: {
          userAgent,
          codexHome,
          platformFamily: "unix",
          platformOs: "macos",
        },
      });
    } else if (message.method === "account/read") {
      process.respond({
        id: message.id,
        result: {
          account: { type: "chatgpt", email: "person@example.com", planType: "pro" },
          requiresOpenaiAuth: true,
        },
      });
    }
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("condition did not settle");
}

describe("CodexAppServerClient", () => {
  test("initializes once and fences returned identity", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 7 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => {
        facts.push(fact);
      },
    });
    await client.initialize();
    const result = await client.accountRead();
    expect(result.authority).toEqual({ profileId: "profile-a", processGeneration: 7 });
    expect(result.value.account).toEqual({
      type: "chatgpt",
      email: "person@example.com",
      planType: "pro",
    });
    expect((process.writes[1] as Record<string, unknown>).method).toBe("initialized");
    await Bun.sleep(1);
    expect(facts).toEqual([{
      authority: { profileId: "profile-a", processGeneration: 7 },
      value: { type: "providerConnected", connectionId: CONNECTION_ID },
    }]);
    await client.close();
  });

  test("rejects a CODEX_HOME mismatch before becoming ready", async () => {
    const process = successfulFake("/tmp/wrong-home");
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/expected-home",
      isAuthorityCurrent: () => true,
    });
    const error = await client.initialize().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "HOME_MISMATCH" });
  });

  test("accepts the pinned desktop user agent and rejects protocol version drift", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const pinned = new CodexAppServerClient({
      process: successfulFake(codexHome, "Codex Desktop/0.149.0 (Mac OS 26.5; arm64) dumb (hra; 0.1.0)"),
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await expect(pinned.initialize()).resolves.toMatchObject({ value: { platformOs: "macos" } });
    await pinned.close();

    const drifted = new CodexAppServerClient({
      process: successfulFake(codexHome, "Codex Desktop/0.149.1 (Mac OS 26.5; arm64)"),
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
    });
    await expect(drifted.initialize()).rejects.toMatchObject({ code: "RUNTIME_MISMATCH" });
  });

  test("treats private stdio EOF as a dead connection rather than a reconnect", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = successfulFake(codexHome);
    const facts: CodexFact[] = [];
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.stdoutQueue.close();
    await waitFor(() => client.state === "failed");
    await waitFor(() => facts.some((fact) => fact.type === "providerDisconnected"));
    expect(facts.filter((fact) => fact.type === "providerDisconnected")).toEqual([{
      type: "providerDisconnected",
      connectionId: CONNECTION_ID,
      reason: "eof",
    }]);
    await client.close();
  });

  test("refuses dispatch after the generation becomes stale", async () => {
    let current = true;
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 2 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => current,
    });
    await client.initialize();
    current = false;
    const error = await client.accountRead().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CodexError);
    expect(process.writes).toHaveLength(2);
    await client.close();
  });

  test("rejects unsupported legacy prompts instead of treating them as interactions", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    process.respond({ id: 900, method: "execCommandApproval", params: {} });
    await Bun.sleep(1);
    expect(process.writes.at(-1)).toEqual({
      id: 900,
      error: {
        code: -32_601,
        message: "HRA does not support this server request",
      },
    });
    await client.close();
  });

  test("admits a typed interaction and routes an exact response without granting through text", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: FencedCodexValue<CodexFact>[] = [];
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 4 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: (fact) => { facts.push(fact); },
    });
    await client.initialize();
    process.respond({
      id: 41,
      method: "item/commandExecution/requestApproval",
      params: commandApprovalParams(),
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionRequested"));
    const requested = facts.find((fact) => fact.value.type === "interactionRequested")?.value;
    if (requested?.type !== "interactionRequested") throw new Error("interaction was not admitted");
    expect(requested.provider).toMatchObject({
      connectionId: CONNECTION_ID,
      requestId: { type: "number", value: 41 },
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
    });
    expect(requested.display).toMatchObject({
      kind: "command_approval",
      commandClass: "git push",
      allowsSessionApproval: true,
    });
    await expect(client.resolveInteraction({
      provider: { ...requested.provider, requestDigest: "b".repeat(64) },
      kind: requested.kind,
      resolution: { kind: "approval_decision", decision: "once" },
    })).rejects.toMatchObject({ code: "AUTHORITY_STALE" });
    await client.resolveInteraction({
      provider: requested.provider,
      kind: requested.kind,
      resolution: { kind: "approval_decision", decision: "session" },
    });
    expect(process.writes.at(-1)).toEqual({ id: 41, result: { decision: "acceptForSession" } });

    process.respond({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 41 },
    });
    await waitFor(() => facts.some((fact) => fact.value.type === "interactionResolved"));
    await client.close();
  });

  test("keeps numeric and string server request ids distinct", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const facts: CodexFact[] = [];
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: ({ value }) => { facts.push(value); },
    });
    await client.initialize();
    process.respond({ id: 1, method: "item/commandExecution/requestApproval", params: commandApprovalParams("one") });
    process.respond({ id: "1", method: "item/commandExecution/requestApproval", params: { ...commandApprovalParams("two"), itemId: "item-2" } });
    await waitFor(() => facts.filter((fact) => fact.type === "interactionRequested").length === 2);
    expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) =>
      fact.provider.requestId)).toEqual([
      { type: "number", value: 1 },
      { type: "string", value: "1" },
    ]);
    await client.close();
  });

  test("does not block response reads while durable interaction admission is pending", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    let admissionStarted = false;
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
      onFact: async ({ value }) => {
        if (value.type !== "interactionRequested") return;
        admissionStarted = true;
        await admissionGate;
      },
    });
    await client.initialize();
    process.respond({ id: 50, method: "item/commandExecution/requestApproval", params: commandApprovalParams() });
    await waitFor(() => admissionStarted);
    const account = await client.accountRead();
    expect(account.value.account).toMatchObject({ type: "chatgpt", planType: "pro" });
    releaseAdmission();
    await client.close();
  });

  test("quarantines a mutated same-id replay while accepting canonical key reordering", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
      connectionId: CONNECTION_ID,
    });
    await client.initialize();
    const params = commandApprovalParams();
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params });
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params: Object.fromEntries(Object.entries(params).reverse()) });
    await Bun.sleep(2);
    expect(client.state).toBe("ready");
    process.respond({ id: 70, method: "item/commandExecution/requestApproval", params: commandApprovalParams("mutated") });
    await waitFor(() => client.state === "failed");
    expect(process.writes.at(-1)).toEqual({
      id: 70,
      error: { code: -32_609, message: "Conflicting server request replay" },
    });
    expect(process.signals).toContain("SIGTERM");
    await client.close();
  });

  test("binds feature and app discovery to the exact existing thread", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "model/list" || message.method === "experimentalFeature/list" || message.method === "permissionProfile/list" || message.method === "app/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null } });
      }
    });
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await client.discoverCapabilities({ cwd: "/workspace/project", threadId: "thread-1", includeExperimental: true });
    expect(process.writes.slice(2)).toEqual([
      { id: 2, method: "model/list", params: { includeHidden: true, limit: 100, cursor: null } },
      { id: 3, method: "experimentalFeature/list", params: { limit: 100, threadId: "thread-1", cursor: null } },
      { id: 4, method: "permissionProfile/list", params: { limit: 100, cwd: "/workspace/project", cursor: null } },
      { id: 5, method: "app/list", params: { limit: 100, forceRefetch: true, threadId: "thread-1", cursor: null } },
    ]);
    await client.close();
  });

  test("discovers plugins through the read-only pinned method and never sends a lifecycle effect", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "plugin/list") {
        target.respond({
          id: message.id,
          result: {
            marketplaces: [{
              name: "official",
              path: null,
              interface: null,
              plugins: [{
                id: "files@official",
                remotePluginId: null,
                version: null,
                localVersion: null,
                name: "files",
                shareContext: null,
                source: { type: "remote" },
                installed: false,
                installedAt: null,
                enabled: false,
                installPolicy: "AVAILABLE",
                installPolicySource: null,
                mustShowInstallationInterstitial: null,
                authPolicy: "ON_USE",
                availability: "AVAILABLE",
                disabledReason: null,
                eligiblePlanTypes: null,
                interface: null,
                keywords: [],
              }],
            }],
            marketplaceLoadErrors: [],
            featuredPluginIds: [],
          },
        });
      }
    });
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    expect((await client.listPlugins({ cwd: "/workspace/project", forceRefetch: true })).value)
      .toMatchObject({ marketplaces: [{ plugins: [{ id: "files@official" }] }] });
    expect(process.writes.slice(2)).toEqual([{
      id: 2,
      method: "plugin/list",
      params: { cwds: ["/workspace/project"], forceRefetch: true },
    }]);
    const methods = process.writes.map((frame) =>
      typeof frame === "object" && frame !== null && "method" in frame
        ? frame.method
        : undefined);
    expect(methods).not.toContain("plugin/install");
    expect(methods).not.toContain("plugin/enable");
    expect(methods).not.toContain("plugin/disable");
    expect(methods).not.toContain("mcpServer/oauth/login");
    await client.close();
  });

  test("sends exact pinned bounded turn and filtered item list parameters", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    let turnListCalls = 0;
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/turns/list") {
        turnListCalls += 1;
        const turn = { id: "turn", items: [], status: "completed", startedAt: 1, completedAt: 2, durationMs: 1_000 };
        target.respond({ id: message.id, result: { data: turnListCalls === 1 ? [] : [turn, { ...turn, id: "turn-2" }], nextCursor: "older", backwardsCursor: "newer" } });
      } else if (message.method === "thread/items/list") {
        target.respond({ id: message.id, result: { data: [], nextCursor: null, backwardsCursor: "back" } });
      }
    });
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await client.listThreadTurns({ threadId: "thread-1", cursor: "cursor", limit: 24, sortDirection: "desc", itemsView: "summary" });
    await client.listThreadItems({ threadId: "thread-1", turnId: "turn-1", cursor: null, limit: 64, sortDirection: "asc" });
    expect(process.writes.slice(2)).toEqual([
      { id: 2, method: "thread/turns/list", params: { threadId: "thread-1", cursor: "cursor", limit: 24, sortDirection: "desc", itemsView: "summary" } },
      { id: 3, method: "thread/items/list", params: { threadId: "thread-1", turnId: "turn-1", cursor: null, limit: 64, sortDirection: "asc" } },
    ]);
    await expect(client.listThreadTurns({ threadId: "thread-1", limit: 1 }))
      .rejects.toMatchObject({ code: "PROTOCOL_LIMIT" });
    await client.close();
  });

  test("fails closed on paginated history when experimental API was not negotiated", async () => {
    const process = successfulFake("/tmp/hra-control-plane/profile-a/codex-home");
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: "/tmp/hra-control-plane/profile-a/codex-home",
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    await expect(client.listThreadTurns({ threadId: "thread-1", limit: 24 })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(process.writes).toHaveLength(2);
    await client.close();
  });

  test("binds the exact named workspace profile and validates the effective thread response", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const thread = {
      id: "thread-1",
      sessionId: "thread-1",
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      cwd: "/workspace/project",
      name: null,
      turns: [],
    };
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/start") {
        target.respond({
          id: message.id,
          result: {
            thread,
            cwd: "/workspace/project",
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            reasoningEffort: "max",
            serviceTier: "default",
            approvalPolicy: "on-request",
            approvalsReviewer: "auto_review",
            sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
            activePermissionProfile: { id: ":workspace", extends: null },
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        });
      }
    });
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 1 },
      expectedCodexHome: codexHome,
      experimentalApi: true,
      isAuthorityCurrent: () => true,
    });
    await client.initialize();
    const result = await client.startThread({
      cwd: "/workspace/project",
      preset: { alias: "high", model: "gpt-5.6-sol", effort: "max", serviceTier: null, fast: false },
      policy: { review: "auto_review", permissionProfile: ":workspace", writableRoots: ["/workspace/project"] },
    });
    expect(result.value.activePermissionProfile?.id).toBe(":workspace");
    expect(process.writes.at(-1)).toEqual({
      id: 2,
      method: "thread/start",
      params: {
        model: "gpt-5.6-sol",
        serviceTier: null,
        cwd: "/workspace/project",
        permissions: ":workspace",
        runtimeWorkspaceRoots: ["/workspace/project"],
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        config: { model_reasoning_effort: "max" },
        ephemeral: false,
      },
    });
    await client.close();
  });

  test("classifies a thread response with a broader sandbox root as indeterminate", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess((message, target) => {
      if (message.method === "initialize") {
        target.respond({ id: message.id, result: { userAgent: "codex-cli/0.149.0", codexHome, platformFamily: "unix", platformOs: "macos" } });
      } else if (message.method === "thread/start") {
        target.respond({ id: message.id, result: {
          thread: { id: "thread-unsafe", sessionId: "thread-unsafe", preview: "", ephemeral: false, modelProvider: "openai", createdAt: 1, updatedAt: 1, status: { type: "idle" }, cwd: "/workspace/project", name: null, turns: [] },
          cwd: "/workspace/project",
          model: "gpt-5.6-sol",
          modelProvider: "openai",
          reasoningEffort: "max",
          serviceTier: "default",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandbox: { type: "workspaceWrite", writableRoots: ["/"], networkAccess: false },
          activePermissionProfile: { id: ":workspace", extends: null },
          runtimeWorkspaceRoots: ["/workspace/project"],
        } });
      }
    });
    const client = new CodexAppServerClient({ process, authority: { profileId: "profile-a", processGeneration: 1 }, expectedCodexHome: codexHome, experimentalApi: true, isAuthorityCurrent: () => true });
    await client.initialize();
    await expect(client.startThread({
      cwd: "/workspace/project",
      preset: { alias: "high", model: "gpt-5.6-sol", effort: "max", serviceTier: null, fast: false },
      policy: { review: "auto_review", permissionProfile: ":workspace", writableRoots: ["/workspace/project"] },
    })).rejects.toMatchObject({ code: "INDETERMINATE_EFFECT", operation: "thread/start" });
    await client.close();
  });

  test("bounds shutdown when TERM and stdout settlement are ignored", async () => {
    const codexHome = "/tmp/hra-control-plane/profile-a/codex-home";
    const process = new FakeProcess(
      (message, target) => {
        if (message.method === "initialize") {
          target.respond({
            id: message.id,
            result: {
              userAgent: "codex-cli/0.149.0",
              codexHome,
              platformFamily: "unix",
              platformOs: "macos",
            },
          });
        }
      },
      { ignoreTerm: true, leaveStreamsOpenAfterKill: true },
    );
    const diagnostics: string[] = [];
    const client = new CodexAppServerClient({
      process,
      authority: { profileId: "profile-a", processGeneration: 3 },
      expectedCodexHome: codexHome,
      isAuthorityCurrent: () => true,
      onSafeDiagnostic: (message) => diagnostics.push(message),
      shutdownTermGraceMs: 5,
      shutdownSettlementMs: 5,
    });
    await client.initialize();
    const mutation = client.renameThread("thread-1", "renamed").then(
      () => null,
      (caught: unknown) => caught,
    );
    await Bun.sleep(1);

    const closeOutcome = await Promise.race([
      Promise.all([client.close(), client.close()]).then(() => "closed" as const),
      Bun.sleep(500).then(() => "timed-out" as const),
    ]);
    const mutationError = await mutation;

    expect(closeOutcome).toBe("closed");
    expect(client.state).toBe("closed");
    expect(process.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(mutationError).toMatchObject({
      code: "INDETERMINATE_EFFECT",
      operation: "thread/name/set",
    });
    expect(diagnostics).toContain("Codex stdout did not settle after termination");
  });
});
