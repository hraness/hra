import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ClaudeProcess,
  ClaudeProcessIdentity,
  PinnedClaudeRuntime,
} from "../claude/index";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL } from "../claude/pin";
import { LiveBatcher } from "../cloud/live-uploader";
import type { SessionEvent } from "../domain/session-events";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { StateStore } from "../storage/state-store";
import { PinnedClaudeRuntimeManager } from "./claude-runtime-adapter";
import {
  UnavailableCloudControl,
  type CloudControlPort,
  type CodexAccountProjection,
  type CodexLoginOutcome,
  type CodexRuntimePort,
  type CompactProjectionRecoveryBlocker,
} from "./ports";
import { HraService } from "./service";

const signal = new AbortController().signal;

/**
 * The exact `system/init`, `assistant`, `control_request`, `rate_limit_event`,
 * and `result` lines captured on the pinned build
 * (`docs/providers/claude-fixtures/`), trimmed to the fields the pinned parser
 * reads. Nothing here shells out to a real `claude` binary.
 */
const FIXTURE_SESSION_ID = "726b1b3d-ed97-4b55-9904-e58fa7d7eb45";

const initLine = {
  claude_code_version: CLAUDE_PIN,
  cwd: "<redacted-abs-path>",
  model: CLAUDE_PIN_MODEL,
  permissionMode: "default",
  session_id: FIXTURE_SESSION_ID,
  subtype: "init",
  type: "system",
};

const assistantLine = (text: string, messageId: string) => ({
  message: {
    content: [{ text, type: "text" }],
    id: messageId,
    model: CLAUDE_PIN_MODEL,
    role: "assistant",
    type: "message",
  },
  parent_tool_use_id: null,
  session_id: FIXTURE_SESSION_ID,
  type: "assistant",
});

const approvalRequestLine = (requestId: string) => ({
  request: {
    description: "Fetch HTTP status line from example.com",
    display_name: "Bash",
    input: {
      command: "curl -sI https://example.com | head -n 1",
      description: "Fetch HTTP status line from example.com",
    },
    subtype: "can_use_tool",
    tool_name: "Bash",
    tool_use_id: "toolu_01DS65QaNoiWEyuRBSzMgdvT",
  },
  request_id: requestId,
  type: "control_request",
});

const questionRequestLine = (requestId: string) => ({
  request: {
    display_name: "AskUserQuestion",
    input: {
      questions: [{
        header: "Indent",
        multiSelect: false,
        options: [
          { description: "Indent with tab characters", label: "tabs" },
          { description: "Indent with space characters", label: "spaces" },
        ],
        question: "Tabs or spaces?",
      }],
    },
    requires_user_interaction: true,
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_01KwcabGeec89hY4gzV1wBgf",
  },
  request_id: requestId,
  type: "control_request",
});

const subagentStartedLine = {
  description: "Read README first line",
  is_backgrounded: false,
  session_id: FIXTURE_SESSION_ID,
  spawn_depth: 1,
  subagent_type: "Explore",
  subtype: "task_started",
  task_id: "a5fb5e66c43a1adcd",
  task_type: "local_agent",
  tool_use_id: "toolu_01RNa8dUfBrdgn5ocMFVqkSN",
  type: "system",
};

const resultLine = (resultText: string) => ({
  duration_ms: 2_374,
  is_error: false,
  num_turns: 1,
  result: resultText,
  session_id: FIXTURE_SESSION_ID,
  stop_reason: "end_turn",
  subtype: "success",
  terminal_reason: "completed",
  type: "result",
  usage: {
    cache_read_input_tokens: 10_123,
    input_tokens: 2,
    output_tokens: 4,
  },
});

const pinnedRuntime: PinnedClaudeRuntime = {
  argv: ["/opt/hra/bin/claude", "--print"],
  effort: CLAUDE_PIN_EFFORT,
  executablePath: "/opt/hra/bin/claude",
  model: CLAUDE_PIN_MODEL,
  version: CLAUDE_PIN,
};

class FakeClaudeProcess implements ClaudeProcess {
  readonly identity: Promise<ClaudeProcessIdentity> = Promise.resolve(Object.freeze({
    pid: 8_123,
    pidDomain: "darwin",
    procStart: "Fri Sep  4 12:00:00 2026",
  }));
  readonly written: string[] = [];
  readonly exited: Promise<number>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() { /* silent */ },
  };
  terminated = false;
  #push: ((chunk: Uint8Array) => void) | undefined;
  #finish: (() => void) | undefined;
  #resolveExit: ((code: number) => void) | undefined;

  constructor() {
    this.exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    const queue: Uint8Array[] = [];
    let waiter: (() => void) | undefined;
    let done = false;
    this.#push = (chunk) => { queue.push(chunk); waiter?.(); waiter = undefined; };
    this.#finish = () => { done = true; waiter?.(); waiter = undefined; };
    this.stdout = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = queue.shift();
          if (chunk !== undefined) { yield chunk; continue; }
          if (done) return;
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      },
    };
  }

  emit(...lines: readonly unknown[]): void {
    this.#push?.(new TextEncoder().encode(
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    ));
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(new TextDecoder().decode(bytes));
  }

  terminate(): void {
    this.terminated = true;
    this.#finish?.();
    this.#resolveExit?.(0);
  }

  forceTerminate(): void { this.terminate(); }
}

/** The Codex seam a Claude-only fixture still needs for account sign-in. */
class SignInOnlyCodex implements CodexRuntimePort {
  readonly provider = "codex" as const;
  discardRuntimeReview(): void {}
  #unsupported(): never {
    throw new Error("This fixture drives the Claude provider only.");
  }
  async login(): Promise<CodexLoginOutcome> {
    return { account: { email: "person@example.com", signedIn: true }, status: "signed_in" };
  }
  async readAccount(): Promise<CodexAccountProjection> {
    return { email: "person@example.com", signedIn: true };
  }
  async logout(): Promise<void> {}
  async close(): Promise<void> {}
  cancelLogin(): Promise<never> { return Promise.reject(this.#unsupported()); }
  readUsage(): Promise<never> { return Promise.reject(this.#unsupported()); }
  consumeRateLimitReset(): Promise<never> { return Promise.reject(this.#unsupported()); }
  listPlugins(): Promise<never> { return Promise.reject(this.#unsupported()); }
  listSessions(): Promise<never> { return Promise.reject(this.#unsupported()); }
  reviewSessionStart(): Promise<never> { return Promise.reject(this.#unsupported()); }
  startSession(): Promise<never> { return Promise.reject(this.#unsupported()); }
  observeSession(): Promise<never> { return Promise.reject(this.#unsupported()); }
  readSession(): Promise<never> { return Promise.reject(this.#unsupported()); }
  endSession(): Promise<void> { return Promise.resolve(); }
  reviewTurnStart(): Promise<never> { return Promise.reject(this.#unsupported()); }
  startTurn(): Promise<never> { return Promise.reject(this.#unsupported()); }
  steer(): Promise<never> { return Promise.reject(this.#unsupported()); }
  interrupt(): Promise<never> { return Promise.reject(this.#unsupported()); }
  rename(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectTurn(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unsupported()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

class OfflineCloud extends UnavailableCloudControl {
  constructor() {
    super({
      isCompactProjectionRecoveryUnsettled: async () => false,
      isCompactProjectionRecoveryUnsettledForProfile: async () => false,
      supersedeCompactProjectionRecoveryForProviderDeletion: async () => ({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: async () => ({ superseded: 0 }),
    } satisfies CompactProjectionRecoveryBlocker as CompactProjectionRecoveryBlocker);
  }
}

const stores: StateStore[] = [];
const roots: string[] = [];
const services: HraService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => { await service.close(); }));
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })));
});

type ClaudeFixture = Readonly<{
  service: HraService;
  store: StateStore;
  cloud: CloudControlPort;
  documents: string;
  processes: FakeClaudeProcess[];
}>;

async function claudeFixture(
  options: Readonly<{
    claudeSignedIn?: boolean;
    resolveRuntime?: () => Promise<PinnedClaudeRuntime>;
  }> = {},
): Promise<ClaudeFixture> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hra-claude-")));
  roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await initializeStatePaths(paths);
  const store = new StateStore(paths);
  stores.push(store);
  // These tests drive every approval by hand.
  store.setDefaultApprovalMode("manual");
  const processes: FakeClaudeProcess[] = [];
  const reference: { current?: HraService } = {};
  const claude = new PinnedClaudeRuntimeManager({
    configHome: "isolated",
    configDirFor: () => join(home, "claude-config"),
    isCurrent: (authority) => {
      try {
        const profile = store.requireProfile(authority.id);
        return profile.processGeneration === authority.generation && profile.state !== "removed";
      } catch {
        return false;
      }
    },
    observer: {
      fact: async (authority, fact) => {
        await reference.current?.observeClaudeFact(authority, fact);
      },
    },
    processFactory: (launch) => {
      const process = new FakeClaudeProcess();
      processes.push(process);
      const providerThreadId = launch.argv.at(-1);
      if (providerThreadId === undefined) throw new Error("Expected a session-bound Claude argv.");
      queueMicrotask(() => { process.emit({ ...initLine, session_id: providerThreadId }); });
      return process;
    },
    readAuthStatus: async () => ({ signedIn: options.claudeSignedIn ?? true }),
    resolveRuntime: options.resolveRuntime ?? (async () => pinnedRuntime),
  });
  const cloud = new OfflineCloud();
  const service = new HraService({
    claude,
    cloud,
    codex: new SignInOnlyCodex(),
    daemonAuthority: { assertCurrent: async () => {}, close: () => {} },
    paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
  });
  reference.current = service;
  services.push(service);
  return { cloud, documents, processes, service, store };
}

async function authenticatedClaudeAccount(
  value: ClaudeFixture,
  label: string,
): Promise<`acct_${string}`> {
  const added = await value.service.execute(
    { kind: "account.add", label },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { kind: "project.add", label: `${label} project`, path: value.documents },
    { signal },
  );
  return added.account.id;
}

const settle = async (): Promise<void> => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
  await new Promise((resolve) => { setTimeout(resolve, 2); });
};

const eventBodies = async (
  value: ClaudeFixture,
  sessionId: `sess_${string}`,
): Promise<readonly Record<string, unknown>[]> => {
  const page = await value.service.execute(
    { kind: "session.events", limit: 200, session: sessionId, waitMs: 0 },
    { signal },
  ) as { events: readonly { body: Record<string, unknown> }[] };
  return page.events.map((event) => event.body);
};

describe("Claude sessions on the local authority", () => {
  test("does not rotate a profile underneath an unsettled Claude login launch", async () => {
    const value = await claudeFixture({ claudeSignedIn: false });
    const account = await authenticatedClaudeAccount(value, "Claude login generation fence");
    const loginKey = crypto.randomUUID();
    const prepared = await value.service.execute({
      account,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal }) as { login: { attemptId: string; providerGeneration: number } };
    const before = value.store.requireProfileById(account);

    await expect(value.service.execute({
      account,
      deviceCode: true,
      idempotencyKey: crypto.randomUUID(),
      kind: "account.login",
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.store.requireProfileById(account).processGeneration).toBe(before.processGeneration);
    expect(value.store.readMutation(loginKey)).toMatchObject({
      id: prepared.login.attemptId,
      state: "effect_started",
    });

    await value.service.observeCodexFact({
      codexHome: "unused-codex-home",
      desktopUserData: "unused-desktop-home",
      generation: before.processGeneration,
      id: before.id,
    }, {
      connectionId: "21000000-0000-4000-8000-000000000002",
      reason: "eof",
      type: "providerDisconnected",
    });
    expect(value.store.requireProfileById(account).processGeneration).toBe(before.processGeneration);
    expect(value.store.readMutation(loginKey)).toMatchObject({ state: "effect_started" });
  });

  test("keeps an idle Claude session owned and usable across a Codex login generation change", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude survives Codex login");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();

    const before = value.store.requireProfileById(account);
    expect(before.state).toBe("signed_out");
    await value.service.execute({
      account,
      deviceCode: false,
      idempotencyKey: crypto.randomUUID(),
      kind: "account.login",
    }, { signal });

    const after = value.store.requireProfileById(account);
    expect(after).toMatchObject({
      processGeneration: before.processGeneration + 1,
      state: "signed_in",
    });
    expect(value.processes).toEqual([process]);
    expect(process.terminated).toBe(false);
    const afterLoginBodies = await eventBodies(value, started.session.id);
    expect(afterLoginBodies).not.toContainEqual(
      expect.objectContaining({ type: "gap", reason: "provider_disconnect" }),
    );
    expect(afterLoginBodies).not.toContainEqual(
      expect.objectContaining({ type: "connection", state: "disconnected" }),
    );

    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Keep working after the Codex login",
      session: started.session.id,
    }, { signal });
    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(process.written.join("\n")).toContain("Keep working after the Codex login");
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);
    expect(process.terminated).toBe(false);
  });

  test("refuses a Codex login before rotating an in-flight Claude authority", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude blocks Codex login");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Keep this turn in flight",
      session: started.session.id,
    }, { signal });
    const before = value.store.requireProfileById(account);

    const refusal = await value.service.execute({
      account,
      deviceCode: false,
      idempotencyKey: crypto.randomUUID(),
      kind: "account.login",
    }, { signal }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({ code: "CONFLICT" });
    expect(value.store.requireProfileById(account)).toMatchObject({
      processGeneration: before.processGeneration,
      state: before.state,
    });
    expect(process.terminated).toBe(false);
    expect(await eventBodies(value, started.session.id)).not.toContainEqual(
      expect.objectContaining({ type: "gap", reason: "provider_disconnect" }),
    );

    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);
    process.emit(resultLine("Stopped cleanly"));
    await settle();
    await expect(value.service.execute({
      account,
      deviceCode: false,
      idempotencyKey: crypto.randomUUID(),
      kind: "account.login",
    }, { signal })).resolves.toMatchObject({
      account: { processGeneration: before.processGeneration + 1 },
    });
    expect(process.terminated).toBe(false);
  });

  test("keeps an idle Claude session usable when the sibling Codex runtime disconnects", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude survives Codex disconnect");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    process.emit(initLine);
    await settle();
    const before = value.store.requireProfileById(account);

    await value.service.observeCodexFact({
      codexHome: "unused-codex-home",
      desktopUserData: "unused-desktop-home",
      generation: before.processGeneration,
      id: before.id,
    }, {
      connectionId: "21000000-0000-4000-8000-000000000001",
      reason: "eof",
      type: "providerDisconnected",
    });

    expect(value.store.requireProfileById(account).processGeneration)
      .toBe(before.processGeneration + 1);
    expect(process.terminated).toBe(false);
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Continue after the Codex disconnect",
      session: started.session.id,
    }, { signal });
    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(process.written.join("\n")).toContain("Continue after the Codex disconnect");
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);
  });

  test("runs one whole session: start, turn, deltas, approval, steer, completion", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude");
    expect(value.store.requireProfileById(account).state).toBe("signed_out");

    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as {
      session: { id: `sess_${string}`; provider: string; preset: string };
      effectiveRuntimeProfile: Record<string, unknown>;
    };
    const sessionId = started.session.id;
    expect(started.session.provider).toBe("claude");
    expect(started.session.preset).toBe("fable-max");

    // The durable session-start evidence carries the Claude document.
    expect(started.effectiveRuntimeProfile).toMatchObject({
      claudeVersion: CLAUDE_PIN,
      configHome: "isolated",
      inputFormat: "stream-json",
      model: CLAUDE_PIN_MODEL,
      outputFormat: "stream-json",
      permissionMode: "default",
      preset: "fable-max",
      reasoningEffort: "max",
    });
    expect(value.store.latestSessionRuntimeProfile(sessionId)).toMatchObject({
      profile: { claudeVersion: CLAUDE_PIN, preset: "fable-max" },
      revision: 1,
      sourceKind: "session_start",
    });

    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    const sent = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Check the status line for example.com",
      session: sessionId,
    }, { signal }) as { turnId: string; effectiveRuntimeProfile: Record<string, unknown> | null };
    expect(sent.effectiveRuntimeProfile).toMatchObject({ preset: "fable-max" });
    // The turn's exact reviewed profile is bound durably too.
    expect(value.store.runtimeProfileForTurn(sessionId, sent.turnId)).toMatchObject({
      claudeVersion: CLAUDE_PIN,
      preset: "fable-max",
    });
    expect(process.written.join("")).toContain("Check the status line for example.com");

    process.emit(assistantLine("Checking the status line", "msg_1"));
    await settle();

    const requestId = "7036d017-a860-42d1-b7a6-0951dcae5f6a";
    process.emit(approvalRequestLine(requestId));
    await settle();

    const pending = await value.service.execute(
      { kind: "interaction.list", limit: 10, pending: true, session: sessionId },
      { signal },
    ) as { interactions: readonly { id: string; kind: string; revision: number }[] };
    expect(pending.interactions).toHaveLength(1);
    const interaction = pending.interactions[0];
    if (interaction === undefined) throw new Error("Expected one pending interaction.");
    expect(interaction.kind).toBe("command_approval");

    await value.service.execute({
      expectedRevision: interaction.revision,
      interaction: interaction.id,
      kind: "interaction.resolve",
      resolution: { decision: "once", kind: "approval_decision" },
    }, { signal });
    // The approval left the daemon as one `control_response` on the pinned
    // process's own stdin, echoing the request's exact input.
    const control = process.written.find((line) => line.includes("control_response"));
    expect(control).toBeDefined();
    expect(control).toContain(requestId);
    expect(control).toContain("\"behavior\":\"allow\"");
    expect(control).not.toContain("permission_suggestions");
    // Claude sends no resolution notification, so the bridge publishes the
    // equivalent fact just after the write and the durable row settles.
    await settle();

    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.steer",
      message: "Only the first line, please",
      session: sessionId,
    }, { signal });
    expect(process.written.join("")).toContain("Only the first line, please");

    process.emit(assistantLine("HTTP/2 200", "msg_2"));
    process.emit(resultLine("HTTP/2 200"));
    await settle();

    const bodies = await eventBodies(value, sessionId);
    const types = bodies.map((body) => body.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("assistant_delta");
    expect(types).toContain("interaction_requested");
    expect(types).toContain("interaction_state");
    // The approval settled terminally even though Claude sends no resolution
    // notification of its own.
    expect(bodies.filter((body) => body.type === "interaction_state").at(-1))
      .toMatchObject({ state: "resolved" });
    expect(types).toContain("token_usage");
    expect(types).toContain("turn_completed");
    expect(bodies.filter((body) => body.type === "assistant_delta").map((body) => body.text))
      .toEqual(["Checking the status line", "HTTP/2 200"]);
    // Provider turn ids never leave the daemon in the clear.
    const completed = bodies.find((body) => body.type === "turn_completed");
    expect(completed).toMatchObject({ status: "completed" });
    expect(completed?.turnId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(JSON.stringify(bodies)).not.toContain(sent.turnId);
    expect(bodies.find((body) => body.type === "token_usage")).toMatchObject({
      cachedInputTokens: 10_123,
      inputTokens: 2,
      outputTokens: 4,
    });

    // The session state classifier ran on the same events.
    const status = await value.service.execute(
      { kind: "session.state", session: sessionId },
      { signal },
    ) as { state: string };
    expect(typeof status.state).toBe("string");

    // The turn boundary reconciled local state and the projection carries the
    // turn summary and the whole transcript.
    const shown = await value.service.execute(
      { detail: true, kind: "session.show", session: sessionId },
      { signal },
    ) as {
      session: { state: string; activeTurnId?: string };
      projection: {
        messages: readonly { role: string; text: string }[];
        turnSummaries: readonly { id: string; status: string; runtimeMs?: number }[];
      };
    };
    expect(shown.session.state).toBe("idle");
    expect(shown.session.activeTurnId).toBeUndefined();
    expect(shown.projection.messages.map((message) => message.role))
      .toEqual(["user", "assistant", "user", "assistant"]);
    expect(shown.projection.turnSummaries).toEqual([
      expect.objectContaining({ id: sent.turnId, runtimeMs: 2_374, status: "completed" }),
    ]);
  });

  test("answers a Claude question and projects its subagents as durable events", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude question");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const sessionId = started.session.id;
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Set up the formatter",
      session: sessionId,
    }, { signal });

    process.emit(subagentStartedLine);
    const requestId = "4d400f2f-1589-4784-b096-00448644856f";
    process.emit(questionRequestLine(requestId));
    await settle();

    const pending = await value.service.execute(
      { kind: "interaction.list", limit: 10, pending: true, session: sessionId },
      { signal },
    ) as { interactions: readonly { id: string; kind: string; revision: number }[] };
    const question = pending.interactions[0];
    if (question === undefined) throw new Error("Expected the pending question.");
    expect(question.kind).toBe("user_input");

    await value.service.execute({
      expectedRevision: question.revision,
      interaction: question.id,
      kind: "interaction.resolve",
      resolution: { answers: { q0: { answers: ["spaces"] } }, kind: "user_answers" },
    }, { signal });
    const control = process.written.find((line) => line.includes("control_response"));
    expect(control).toBeDefined();
    expect(control).toContain("\"Tabs or spaces?\":\"spaces\"");

    // Claude sends no resolution notification, so the bridge publishes the
    // equivalent fact out of band and the durable row settles just after.
    await settle();
    const bodies = await eventBodies(value, sessionId);
    const subagent = bodies.find((body) => body.type === "subagent_activity");
    expect(subagent).toMatchObject({ depth: 1, kind: "started", role: "Explore" });
    // The provider's own task id never leaves the daemon in the clear.
    expect(subagent?.agentId).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(JSON.stringify(bodies)).not.toContain("a5fb5e66c43a1adcd");
    expect(bodies.find((body) => body.type === "interaction_requested"))
      .toMatchObject({ interactionKind: "user_input" });
    expect(bodies.filter((body) => body.type === "interaction_state").at(-1))
      .toMatchObject({ state: "resolved" });
  });

  test("stops an in-flight Claude turn through the same interrupt path", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude stop");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Start a long job",
      session: started.session.id,
    }, { signal });

    const stopped = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.stop",
      session: started.session.id,
    }, { signal }) as { stopped: boolean };
    expect(stopped.stopped).toBe(true);
    expect(process.written.some((line) => line.includes("interrupt"))).toBe(true);

    process.emit(resultLine("stopped"));
    await settle();
    const bodies = await eventBodies(value, started.session.id);
    expect(bodies.find((body) => body.type === "turn_completed")).toMatchObject({
      status: "interrupted",
    });
  });

  test("refuses the Claude provider with the pinned version when no binary is admitted", async () => {
    const value = await claudeFixture({
      resolveRuntime: async () => {
        throw new Error("the pinned Claude Code executable is not installed");
      },
    });
    const account = await authenticatedClaudeAccount(value, "No binary");
    await expect(value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toThrow(
      `Install Claude Code ${CLAUDE_PIN} exactly`,
    );
    // The refusal left no half-started durable session behind.
    expect(value.store.listSessions(50, undefined, true)).toHaveLength(0);
  });

  test("refuses Codex-only capabilities on a Claude session by name", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude capabilities");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.rename",
      name: "Renamed",
      session: started.session.id,
    }, { signal })).rejects.toThrow("The claude provider does not support renaming");
  });

  test("feeds the live uploader exactly as a Codex session does", async () => {
    const value = await claudeFixture();
    const account = await authenticatedClaudeAccount(value, "Claude live");
    const started = await value.service.execute({
      account,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const process = value.processes[0];
    if (process === undefined) throw new Error("Expected one pinned Claude process.");
    const sent = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Say hello",
      session: started.session.id,
    }, { signal }) as { turnId: string };
    process.emit(assistantLine("Hello there", "msg_live"));
    process.emit(resultLine("Hello there"));
    await settle();

    // The uploader is fed the daemon's own ledger rows. It has no provider
    // knowledge at all, so this is the proof that a Claude session reaches the
    // hosted `detail` stream through the identical path.
    const listed = value.store.listSessionEvents({
      afterSequence: null,
      limit: 200,
      sessionId: started.session.id,
    });
    const batcher = new LiveBatcher({ includeThinking: false });
    for (const event of listed.events as readonly SessionEvent[]) batcher.observe(event);
    const batch = batcher.drain();
    expect(batch.flush).toBe(true);
    // A `turn_completed` closes every open stream and forces the flush rather
    // than shipping a body of its own, exactly as it does for Codex.
    expect(batch.bodies.map((body) => body.type as string)).toContain("turn_started");
    const delta = batch.bodies.find((body) => body.type === "assistant_delta");
    expect(delta).toMatchObject({ text: "Hello there" });
    expect(JSON.stringify(batch.bodies)).not.toContain(sent.turnId);
    expect(batch.bodies.some((body) => body.type === "session_state")).toBe(true);
  });
});
