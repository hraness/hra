import { createHash, randomUUID } from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- D4 extracts the provider port; this file is the Claude adapter and loads the pinned runtime.
import {
  CLAUDE_PIN,
  CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT,
  ClaudeError,
  ClaudeStreamClient,
  boundClaudeText,
  readClaudeAuthStatus,
  sanitizeClaudeText,
  spawnBunClaudeProcess,
  resolvePinnedClaudeRuntime,
  withClaudeHostToolRuntime,
  type ClaudeAuthStatusReader,
  type ClaudeCanUseTool,
  type ClaudeFact,
  type ClaudeHostToolBindingAuthority,
  type ClaudeHostToolBindingLease,
  type ClaudeHostToolCall,
  type ClaudeHostToolPublicResult,
  type ClaudeHostToolResponseWritten,
  type ClaudeInteractionDecision,
  type ClaudeProcess,
  type PinnedClaudeRuntime,
  type ResolvePinnedClaudeRuntimeOptions,
} from "../claude/index";
import type { HraHostToolCall } from "../codex/protocol";
import type { PreparedAttachment } from "../domain/attachments";
import type {
  InteractionKind,
  InteractionResolution,
  LiveInteractionApprovalAuthority,
  ProviderInteractionAuthority,
} from "../domain/interactions";
import {
  assertPresetSupportedByProvider,
  type Preset,
} from "../domain/presets";
import {
  effectiveClaudeRuntimeProfileSchema,
  type EffectiveClaudeRuntimeProfile,
} from "../domain/runtime-profile";
import type { ClaudeSessionFact } from "./claude-session-facts";
import type {
  ClaudeRuntimePort,
  ClaudeRuntimeStartReview,
  CodexAccountProjection,
  CodexProjectedMessage,
  CodexSessionObservation,
  CodexSessionProjection,
  CodexTurnSummary,
  ProfileAuthority,
} from "./ports";

/** Bounds on the in-memory transcript one Claude session projects. */
const PROJECTED_MESSAGE_LIMIT = 256;
const PROJECTED_TURN_LIMIT = 128;
const PROJECTED_MESSAGE_BYTES = 16 * 1024;
const PROJECTED_TITLE_BYTES = 120;
const CLOSED_SESSION_PROOF_LIMIT = 1_024;
const HOST_TOOL_CALL_LIMIT = 256;

const encoder = new TextEncoder();

const optionalClientShutdownDuration = (
  value: number | undefined,
  label: string,
): number | undefined => {
  if (
    value !== undefined
    && (!Number.isSafeInteger(value) || value < 1 || value > 30_000)
  ) {
    throw new ClaudeError("INVALID_INPUT", `${label} must be between 1 and 30000 milliseconds`);
  }
  return value;
};

/** Sanitizes and bounds one provider string, reporting what it dropped. */
const projectedText = (value: string): Pick<CodexProjectedMessage, "text" | "omission"> => {
  const safe = sanitizeClaudeText(value, true);
  const originalUtf8Bytes = encoder.encode(safe).byteLength;
  const text = boundClaudeText(safe, PROJECTED_MESSAGE_BYTES);
  const returnedUtf8Bytes = encoder.encode(text).byteLength;
  return originalUtf8Bytes === returnedUtf8Bytes
    ? { text }
    : {
        omission: {
          omittedUtf8Bytes: originalUtf8Bytes - returnedUtf8Bytes,
          originalUtf8Bytes,
          returnedUtf8Bytes,
        },
        text,
      };
};

/** One live Claude session: its process, its client, and its projection. */
type RunningSession = {
  readonly authority: ProfileAuthority;
  readonly client: ClaudeStreamClient;
  closeState: "open" | "closing" | "failed";
  readonly connectionId: string;
  readonly providerThreadId: string;
  readonly profile: EffectiveClaudeRuntimeProfile;
  readonly projectRoot: string;
  readonly hostToolBinding: ClaudeHostToolBindingLease;
  readonly hostToolCalls: Map<string, RetainedHostToolCall>;
  readonly hostToolCallTombstones: Map<string, string>;
  hostToolActivationTask: Promise<void> | undefined;
  hostToolRevocationTask: Promise<void> | undefined;
  hostToolState: "inactive" | "active" | "revoking" | "revoked";
  status: "active" | "idle" | "terminal";
  activeTurnId: string | undefined;
  title: string;
  updatedAt: number;
  /**
   * The bounded local transcript. Claude Code publishes no thread-read
   * method, so HRA is the only record of what this session said: the
   * projection every reader sees (`hra session show`, the compact cloud
   * projection, and the recovery baseline) is assembled here from the same
   * facts the event stream carries.
   */
  readonly messages: CodexProjectedMessage[];
  readonly turnSummaries: CodexTurnSummary[];
  /** Raw assistant text per open item id, flushed into `messages` on delta. */
  readonly assistantItems: Map<string, number>;
  droppedMessages: number;
  droppedTurns: number;
  truncatedMessages: number;
};

type RetainedHostToolCall = Readonly<{
  bindingId: string;
  call: HraHostToolCall;
  requestDigest: string;
}>;

export type { ClaudeSessionFact } from "./claude-session-facts";

export type ClaudeRuntimeObserver = {
  hraHostTool?(
    authority: ProfileAuthority,
    call: HraHostToolCall,
  ): ClaudeHostToolPublicResult | Promise<ClaudeHostToolPublicResult>;
  hraHostToolResponseWritten?(
    authority: ProfileAuthority,
    call: HraHostToolCall,
  ): void | Promise<void>;
  fact(authority: ProfileAuthority, fact: ClaudeSessionFact): void | Promise<void>;
};

export type ClaudeRuntimeHostToolConfiguration = Readonly<{
  bindingAuthority: Pick<
    ClaudeHostToolBindingAuthority,
    "activate" | "provision" | "revoke"
  >;
  callbackSocketPath: string;
  privateRoot: string;
}>;

type PendingClaudeReview = {
  readonly review: ClaudeRuntimeStartReview;
  readonly runtime: PinnedClaudeRuntime;
  readonly authority: ProfileAuthority;
  readonly projectRoot: string;
  readonly providerThreadId?: string;
};

export type ClaudeProcessFactory = (input: {
  readonly runtime: PinnedClaudeRuntime;
  readonly configDir: string;
  readonly projectRoot: string;
}) => ClaudeProcess;

const METHOD = "claude/control_request/can_use_tool";

const requestDigestOf = (requestId: string, request: ClaudeCanUseTool): string =>
  createHash("sha256")
    .update("hra:claude-interaction-authority:v1\0", "utf8")
    .update(JSON.stringify({ requestId, toolUseId: request.toolUseId }), "utf8")
    .digest("hex");

const decisionFor = (
  kind: InteractionKind,
  resolution: InteractionResolution,
  request: ClaudeCanUseTool,
): ClaudeInteractionDecision => {
  if (resolution.kind === "approval_decision") {
    // Claude's control response can only ever grant this one tool use, so a
    // `session`-scoped approval is refused rather than silently narrowed.
    if (resolution.decision === "once") return { kind: "allow" };
    if (resolution.decision === "session") {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        "Claude approvals are granted for one tool use only; session scope is not available.",
      );
    }
    return { kind: "deny", message: "Permission request denied" };
  }
  if (resolution.kind === "user_answers") {
    if (kind !== "user_input") {
      throw new ClaudeError("INVALID_INPUT", "Only a Claude question accepts answers.");
    }
    const answers: Record<string, string> = {};
    for (const [id, value] of Object.entries(resolution.answers)) {
      const first = value.answers[0];
      if (value.answers.length !== 1 || first === undefined) {
        throw new ClaudeError("INVALID_INPUT", "A Claude question takes exactly one answer.");
      }
      answers[id] = first;
    }
    return { answers, kind: "answer" };
  }
  if (resolution.kind === "permission_grant") {
    if (resolution.scope !== null) {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        "Claude permissions are granted for one tool use only; persistent scope is not available.",
      );
    }
    void request;
    return { kind: "allow" };
  }
  throw new ClaudeError("INVALID_INPUT", "Claude has no MCP elicitation to submit.");
};

/**
 * The Claude Code implementation of the provider-neutral session seam. It
 * owns one pinned `claude` process per session under an isolated
 * `CLAUDE_CONFIG_DIR`, and it translates only through `src/claude`'s fact
 * vocabulary: no Claude wire shape leaves this file.
 */
export class PinnedClaudeRuntimeManager implements ClaudeRuntimePort {
  readonly provider = "claude" as const;
  readonly #isCurrent: (authority: ProfileAuthority) => boolean;
  readonly #observer: ClaudeRuntimeObserver;
  readonly #configDirFor: (authority: ProfileAuthority) => string | Promise<string>;
  readonly #readAuthStatus: ClaudeAuthStatusReader;
  readonly #resolveRuntime: typeof resolvePinnedClaudeRuntime;
  readonly #processFactory: ClaudeProcessFactory;
  readonly #now: () => number;
  readonly #clientShutdownTermGraceMs: number | undefined;
  readonly #clientShutdownSettlementMs: number | undefined;
  readonly #hostTools: ClaudeRuntimeHostToolConfiguration;
  readonly #sessions = new Map<string, RunningSession>();
  /**
   * Children launched but never admitted as sessions. They are never exposed
   * for reuse, but remain owned until their exact clients prove process exit
   * and output drain. This closes the post-spawn authority-change boundary.
   */
  readonly #unboundClients = new Set<ClaudeStreamClient>();
  /** Same-daemon idempotency only; a restart deliberately has no exit proof. */
  readonly #closedSessionProofs = new Map<string, ProfileAuthority>();
  readonly #reviews = new Map<string, PendingClaudeReview>();
  #resolvedRuntime: PinnedClaudeRuntime | undefined;
  #state: "open" | "closed" = "open";

  constructor(input: {
    isCurrent: (authority: ProfileAuthority) => boolean;
    observer: ClaudeRuntimeObserver;
    /** The isolated, absolute `CLAUDE_CONFIG_DIR` for one HRA account. */
    configDirFor: (authority: ProfileAuthority) => string | Promise<string>;
    readAuthStatus?: ClaudeAuthStatusReader;
    resolveRuntime?: typeof resolvePinnedClaudeRuntime;
    processFactory?: ClaudeProcessFactory;
    /** Testable bounds forwarded to the exact child client; production uses its defaults. */
    clientShutdownTermGraceMs?: number;
    clientShutdownSettlementMs?: number;
    now?: () => number;
    hostTools: ClaudeRuntimeHostToolConfiguration;
  }) {
    this.#isCurrent = input.isCurrent;
    this.#observer = input.observer;
    this.#configDirFor = input.configDirFor;
    this.#readAuthStatus = input.readAuthStatus ?? readClaudeAuthStatus;
    this.#resolveRuntime = input.resolveRuntime ?? resolvePinnedClaudeRuntime;
    this.#processFactory = input.processFactory
      ?? ((launch) => spawnBunClaudeProcess({
        argv: launch.runtime.argv,
        configDir: launch.configDir,
        projectRoot: launch.projectRoot,
      }));
    this.#clientShutdownTermGraceMs = optionalClientShutdownDuration(
      input.clientShutdownTermGraceMs,
      "Claude TERM grace",
    );
    this.#clientShutdownSettlementMs = optionalClientShutdownDuration(
      input.clientShutdownSettlementMs,
      "Claude shutdown settlement",
    );
    this.#now = input.now ?? Date.now;
    this.#hostTools = input.hostTools;
  }

  pinnedVersion(): string {
    const runtime = this.#resolvedRuntime;
    if (runtime === undefined) {
      throw new ClaudeError("RUNTIME_MISMATCH", "No Claude Code runtime has been admitted yet.");
    }
    return runtime.version;
  }

  async readAccount(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<CodexAccountProjection> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    // Claude's own non-interactive status command reads the isolated home and
    // projects only this boolean. HRA never opens a credential file or copies
    // any identity-bearing status fields into its account model.
    const configDir = await this.#configDirFor(input.authority);
    this.#assertLaunchAuthority(input.authority, input.signal);
    const runtime = await this.#admitRuntime(configDir, input.signal);
    this.#assertLaunchAuthority(input.authority, input.signal);
    this.#resolvedRuntime = runtime;
    const account = await this.#readAuthStatus({
      configDir,
      runtime,
      signal: input.signal,
    });
    this.#assertLaunchAuthority(input.authority, input.signal);
    return { signedIn: account.signedIn };
  }

  async reviewSessionStart(input: {
    authority: ProfileAuthority;
    projectRoot?: string;
    preset: Preset;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<ClaudeRuntimeStartReview> {
    return await this.#review({ ...input, kind: "session_start" });
  }

  discardRuntimeReview(review: ClaudeRuntimeStartReview): void {
    const pending = this.#reviews.get(review.reviewId);
    if (pending?.review === review) this.#reviews.delete(review.reviewId);
  }

  async reviewTurnStart(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot?: string;
    preset: Preset;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<ClaudeRuntimeStartReview> {
    return await this.#review({ ...input, kind: "turn_start" });
  }

  async startSession(input: {
    authority: ProfileAuthority;
    projectRoot?: string;
    review: ClaudeRuntimeStartReview;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    this.#assertNoUnboundSessionChild();
    const pending = this.#consumeReview(input.review, "session_start");
    if (
      pending.authority.id !== input.authority.id
      || pending.authority.generation !== input.authority.generation
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude runtime review belongs to another authority.");
    }
    const connectionId = randomUUID();
    const providerThreadId = randomUUID();
    const configDir = await this.#configDirFor(input.authority);
    this.#assertLaunchAuthority(input.authority, input.signal);
    this.#assertNoUnboundSessionChild();
    let binding: ClaudeHostToolBindingLease | undefined;
    let client: ClaudeStreamClient | undefined;
    try {
      binding = await this.#hostTools.bindingAuthority.provision({
        callbackSocketPath: this.#hostTools.callbackSocketPath,
        identity: {
          processGeneration: input.authority.generation,
          profileId: input.authority.id,
          provider: "claude",
          providerThreadId,
        },
        privateRoot: this.#hostTools.privateRoot,
      });
      this.#assertLaunchAuthority(input.authority, input.signal);
      this.#assertNoUnboundSessionChild();
      const process = this.#processFactory({
        configDir,
        projectRoot: pending.projectRoot,
        runtime: withClaudeHostToolRuntime(pending.runtime, {
          mcpConfigPath: binding.mcpConfigPath,
        }),
      });
      client = new ClaudeStreamClient({
        configDir,
        onFact: (fact) => this.#onFact(providerThreadId, connectionId, fact),
        process,
        ...(this.#clientShutdownTermGraceMs === undefined
          ? {}
          : { shutdownTermGraceMs: this.#clientShutdownTermGraceMs }),
        ...(this.#clientShutdownSettlementMs === undefined
          ? {}
          : { shutdownSettlementMs: this.#clientShutdownSettlementMs }),
      });
      // Own the child before the first post-spawn authority check. If that check
      // fails and bounded cleanup cannot yet join the process, manager shutdown
      // must still be able to retry this exact client rather than losing custody.
      this.#unboundClients.add(client);
      this.#assertLaunchAuthority(input.authority, input.signal);
      const session: RunningSession = {
        activeTurnId: undefined,
        assistantItems: new Map(),
        authority: input.authority,
        client,
        closeState: "open",
        connectionId,
        droppedMessages: 0,
        droppedTurns: 0,
        hostToolActivationTask: undefined,
        hostToolBinding: binding,
        hostToolCalls: new Map(),
        hostToolCallTombstones: new Map(),
        hostToolRevocationTask: undefined,
        hostToolState: "inactive",
        messages: [],
        profile: pending.review.effectiveRuntimeProfile,
        projectRoot: pending.projectRoot,
        providerThreadId,
        status: "idle",
        title: "Untitled session",
        truncatedMessages: 0,
        turnSummaries: [],
        updatedAt: this.#now(),
      };
      this.#assertLaunchAuthority(input.authority, input.signal);
      this.#closedSessionProofs.delete(providerThreadId);
      this.#sessions.set(providerThreadId, session);
      this.#unboundClients.delete(client);
      return {
        effectiveRuntimeProfile: session.profile,
        providerThreadId,
        providerUpdatedAt: session.updatedAt,
        status: "idle",
        title: session.title,
        projectRoot: session.projectRoot,
      };
    } catch (error: unknown) {
      const cleanupClient = client;
      const cleanupBinding = binding;
      const cleanup = await Promise.allSettled([
        ...(cleanupClient === undefined
          ? []
          : [cleanupClient.close().then(() => { this.#unboundClients.delete(cleanupClient); })]),
        ...(cleanupBinding === undefined
          ? []
          : [this.#hostTools.bindingAuthority.revoke(cleanupBinding.bindingId)]),
      ]);
      const cleanupFailures = cleanup.flatMap((settlement) =>
        settlement.status === "rejected" ? [settlement.reason as unknown] : []);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Claude session launch authority failed and its child cleanup was incomplete; host-tool cleanup may also be incomplete.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async activateSessionHostTools(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.hostToolState === "active") return;
    if (session.hostToolState === "revoked" || session.hostToolState === "revoking") {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding was revoked.");
    }
    const existingTask = session.hostToolActivationTask;
    if (existingTask !== undefined) {
      await existingTask;
      this.#assertLaunchAuthority(input.authority, input.signal);
      return;
    }
    const task = (async () => {
      await this.#hostTools.bindingAuthority.activate(session.hostToolBinding.bindingId);
      if (input.signal.aborted) {
        await this.#revokeSessionHostTools(session);
        input.signal.throwIfAborted();
      }
      if (
        session.closeState !== "open"
        || session.hostToolState !== "inactive"
        || this.#sessions.get(session.providerThreadId) !== session
        || !this.#isCurrent(session.authority)
      ) {
        await this.#revokeSessionHostTools(session);
        throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding activation became stale.");
      }
      session.hostToolState = "active";
    })();
    session.hostToolActivationTask = task;
    try {
      await task;
      this.#assertLaunchAuthority(input.authority, input.signal);
    } finally {
      if (session.hostToolActivationTask === task) session.hostToolActivationTask = undefined;
    }
  }

  async startTurn(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot?: string;
    review: ClaudeRuntimeStartReview;
    message: string;
    attachments?: readonly PreparedAttachment[];
    clientMessageId: string;
    signal: AbortSignal;
  }): Promise<{
    turnId: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile;
  }> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.hostToolState !== "active") {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host tools are not active for this session.");
    }
    const pending = this.#consumeReview(input.review, "turn_start");
    if (
      pending.authority.id !== session.authority.id
      || pending.authority.generation !== session.authority.generation
      || pending.providerThreadId !== session.providerThreadId
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude turn review belongs to another session.");
    }
    if (session.activeTurnId !== undefined) {
      throw new ClaudeError("INVALID_INPUT", "The Claude session already has an active turn.");
    }
    await this.#assertSessionConfig(session, input.signal);
    // HRA mints the turn id: Claude's own `result` line is the only turn
    // boundary it publishes, and it carries no id of its own.
    const turnId = randomUUID();
    const startAttachments = input.attachments ?? [];
    await session.client.startTurn({
      ...(startAttachments.length === 0 ? {} : { attachments: startAttachments }),
      message: input.message,
      turnId,
    });
    this.#appendUserMessage(session, turnId, input.message, input.clientMessageId);
    session.activeTurnId = turnId;
    session.status = "active";
    session.updatedAt = this.#now();
    input.signal.throwIfAborted();
    return {
      effectiveRuntimeProfile: pending.review.effectiveRuntimeProfile,
      status: "inProgress",
      turnId,
    };
  }

  async steer(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    activeTurnId: string;
    message: string;
    attachments?: readonly PreparedAttachment[];
    clientMessageId: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) {
      throw new ClaudeError("INVALID_INPUT", "That Claude turn is no longer active.");
    }
    await this.#assertSessionConfig(session, input.signal);
    await session.client.steer(input.message, input.attachments ?? []);
    this.#appendUserMessage(session, input.activeTurnId, input.message, input.clientMessageId);
    input.signal.throwIfAborted();
  }

  async interrupt(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    activeTurnId: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) return;
    await this.#assertSessionConfig(session, input.signal);
    await session.client.interrupt();
    input.signal.throwIfAborted();
  }

  async observeSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<CodexSessionObservation> {
    input.signal.throwIfAborted();
    const session = this.#requireSession(input.authority, input.providerThreadId);
    const observation = {
      connectionId: session.connectionId,
      projection: this.#projection(session),
      resumed: false,
    };
    input.signal.throwIfAborted();
    return observation;
  }

  async readSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    detail: boolean;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection> {
    input.signal.throwIfAborted();
    const projection = this.#projection(this.#requireSession(input.authority, input.providerThreadId));
    input.signal.throwIfAborted();
    return projection;
  }

  /**
   * Stop the pinned Claude Code process that served one session and forget it.
   * A Claude session is one live process, so leaving a switched-away session
   * running would leak it. An unknown thread is not proof of release: this
   * manager may have restarted while an older foreground child survived.
   */
  async endSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const session = this.#sessions.get(input.providerThreadId);
    if (session === undefined) {
      const proof = this.#closedSessionProofs.get(input.providerThreadId);
      if (proof !== undefined && this.#sameAuthority(proof, input.authority)) return;
      throw new ClaudeError(
        "PROCESS_EXITED",
        "That Claude session is unknown on this daemon, so its process cleanup cannot be proven.",
      );
    }
    if (
      session.authority.id !== input.authority.id
      || session.authority.generation !== input.authority.generation
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude session belongs to another authority.");
    }
    this.#assertCurrent(input.authority);
    await this.#closeSession(input.providerThreadId, session);
    input.signal.throwIfAborted();
  }

  async handleSessionHostToolCall(call: ClaudeHostToolCall): Promise<ClaudeHostToolPublicResult> {
    const session = await this.#requireHostToolSession(call);
    const key = this.#hostToolCallKey(call.callId);
    const existing = session.hostToolCalls.get(key);
    if (existing !== undefined) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        existing.requestDigest === call.requestDigest
          ? "Claude host-tool call is already pending."
          : "Claude host-tool call id was reused.",
      );
    }
    const completedDigest = session.hostToolCallTombstones.get(key);
    if (completedDigest !== undefined) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        completedDigest === call.requestDigest
          ? "Claude host-tool call was already completed."
          : "Claude host-tool call id was reused.",
      );
    }
    if (
      session.hostToolCalls.size + session.hostToolCallTombstones.size
      >= CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT
    ) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool call history is exhausted.");
    }
    if (session.activeTurnId === undefined) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call has no active turn.");
    }
    if (session.hostToolCalls.size >= HOST_TOOL_CALL_LIMIT) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool call retention exceeded its limit.");
    }
    const normalized = this.#normalizeHostToolCall(session, session.activeTurnId, call);
    session.hostToolCalls.set(key, {
      bindingId: call.bindingId,
      call: normalized,
      requestDigest: call.requestDigest,
    });
    try {
      if (this.#observer.hraHostTool === undefined) {
        throw new ClaudeError("UNSUPPORTED_CAPABILITY", "The HRA host-tool service is unavailable.");
      }
      return await this.#observer.hraHostTool(session.authority, normalized);
    } catch (error: unknown) {
      session.hostToolCalls.delete(key);
      this.#rememberHostToolCall(session, key, call.requestDigest);
      throw error;
    }
  }

  async handleSessionHostToolResponseWritten(
    receipt: ClaudeHostToolResponseWritten,
  ): Promise<void> {
    const session = await this.#requireHostToolSession(receipt);
    const key = this.#hostToolCallKey(receipt.callId);
    const retained = session.hostToolCalls.get(key);
    if (
      retained === undefined
      || retained.bindingId !== receipt.bindingId
      || retained.requestDigest !== receipt.requestDigest
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool response receipt is stale.");
    }
    await this.#observer.hraHostToolResponseWritten?.(session.authority, retained.call);
    session.hostToolCalls.delete(key);
    this.#rememberHostToolCall(session, key, receipt.requestDigest);
  }

  async #requireHostToolSession(call: ClaudeHostToolCall): Promise<RunningSession> {
    const session = this.#sessions.get(call.providerThreadId);
    if (
      session === undefined
      || session.closeState !== "open"
      || session.hostToolBinding.bindingId !== call.bindingId
      || session.authority.id !== call.profileId
      || session.authority.generation !== call.processGeneration
      || session.hostToolState !== "active"
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call authority is stale.");
    }
    if (!this.#isCurrent(session.authority)) {
      await this.#closeSession(session.providerThreadId, session);
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool account generation changed.");
    }
    return session;
  }

  #normalizeHostToolCall(
    session: RunningSession,
    turnId: string,
    call: ClaudeHostToolCall,
  ): HraHostToolCall {
    const base = {
      authority: {
        processGeneration: session.authority.generation,
        profileId: session.authority.id,
      },
      callId: call.callId,
      connectionId: session.connectionId,
      requestDigest: call.requestDigest,
      requestId: { type: "string" as const, value: call.callId },
      threadId: session.providerThreadId,
      turnId,
    };
    return call.request.tool === "automation_update"
      ? {
          ...base,
          input: call.request.input,
          operation: call.request.input,
          tool: call.request.tool,
        }
      : { ...base, ...call.request };
  }

  #hostToolCallKey(callId: string): string {
    return createHash("sha256")
      .update("hra:claude-runtime-host-call:v1\0", "utf8")
      .update(callId, "utf8")
      .digest("hex");
  }

  #rememberHostToolCall(session: RunningSession, key: string, requestDigest: string): void {
    session.hostToolCallTombstones.set(key, requestDigest);
  }

  /** Widens the runtime-resolution failure into one actionable instruction. */
  async #admitRuntime(configDir: string, signal: AbortSignal): Promise<PinnedClaudeRuntime> {
    signal.throwIfAborted();
    try {
      const runtime = await this.#resolveRuntime({
        configDir,
        signal,
      } satisfies ResolvePinnedClaudeRuntimeOptions);
      signal.throwIfAborted();
      return runtime;
    } catch (error: unknown) {
      signal.throwIfAborted();
      const detail = error instanceof ClaudeError ? error.message : "it could not be admitted";
      throw new ClaudeError(
        "RUNTIME_MISMATCH",
        `HRA cannot start a Claude Code session on this machine: ${detail}. `
        + `Install Claude Code ${CLAUDE_PIN} exactly, put \`claude\` on this daemon's PATH, `
        + "then sign in inside the account's isolated Claude profile and retry.",
        { cause: error },
      );
    }
  }

  async inspectInteractionAuthority(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    signal: AbortSignal;
  }): Promise<LiveInteractionApprovalAuthority> {
    input.signal.throwIfAborted();
    const { request } = this.#requirePending(input.authority, input.provider);
    if (input.kind === "command_approval") {
      return {
        additionalPermissions: null,
        availableDecisions: ["once", "decline"],
        command: typeof request.input.command === "string" ? request.input.command : "",
        commandActions: null,
        environmentId: null,
        kind: "command_approval",
        networkApprovalContext: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        reason: request.description,
        workingDirectory: null,
      };
    }
    if (input.kind === "permission_approval") {
      const session = this.#requireSession(input.authority, input.provider.threadId ?? "");
      return {
        environmentId: null,
        kind: "permission_approval",
        permissions: [request.toolName],
        reason: request.description,
        workingDirectory: session.projectRoot,
      };
    }
    throw new ClaudeError(
      "UNSUPPORTED_CAPABILITY",
      "Only Claude command and permission approvals expose live approval authority.",
    );
  }

  async validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    input.signal.throwIfAborted();
    const { request, session, requestId } = this.#requirePending(input.authority, input.provider);
    const decision = decisionFor(input.kind, input.resolution, request);
    const response = {
      responseDigest: session.client.validateInteractionResolution(requestId, decision).responseDigest,
    };
    input.signal.throwIfAborted();
    return response;
  }

  async resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    input.signal.throwIfAborted();
    const { request, session, requestId } = this.#requirePending(input.authority, input.provider);
    if (this.#now() > input.deadlineAt) {
      throw new ClaudeError("DEADLINE_EXPIRED", "The Claude interaction deadline passed.");
    }
    await this.#assertSessionConfig(session, input.signal);
    await session.client.resolveInteraction(requestId, decisionFor(input.kind, input.resolution, request));
    this.#reportInteractionSettled(session, requestId);
    input.signal.throwIfAborted();
    return { responseWritten: true };
  }

  async validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    input.signal.throwIfAborted();
    const { session, requestId } = this.#requirePending(input.authority, input.provider);
    const response = {
      responseDigest: session.client.validateInteractionResolution(requestId, {
        kind: "deny",
        message: "HRA did not receive a decision in time",
      }).responseDigest,
    };
    input.signal.throwIfAborted();
    return response;
  }

  async timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    input.signal.throwIfAborted();
    const { session, requestId } = this.#requirePending(input.authority, input.provider);
    await this.#assertSessionConfig(session, input.signal);
    await session.client.resolveInteraction(requestId, {
      kind: "deny",
      message: "HRA did not receive a decision in time",
    });
    this.#reportInteractionSettled(session, requestId);
    input.signal.throwIfAborted();
    return { responseWritten: true };
  }

  /**
   * Claude publishes no resolution notification of its own: one control
   * response is the whole exchange. The bridge therefore reports the request
   * as no longer pending, which is the same fact a provider-side cancellation
   * produces, so the daemon can settle its durable interaction row.
   *
   * Codex delivers its equivalent on the notification stream, outside the
   * resolving call. This one is published the same way: the caller still
   * holds that interaction's serialization while it awaits the write, so the
   * fact is handed over after that call returns, never inside it.
   */
  #reportInteractionSettled(session: RunningSession, requestId: string): void {
    const timer = setTimeout(() => {
      void Promise.resolve(this.#onFact(session.providerThreadId, session.connectionId, {
        requestId,
        type: "interactionCanceled",
      })).catch(() => {
        // The daemon's own fact path records and escalates its failures; a
        // settle notice must never reject into the runtime as an unowned task.
      });
    }, 0);
    timer.unref();
  }

  async close(): Promise<void> {
    this.#state = "closed";
    this.#reviews.clear();
    const settlements = await Promise.allSettled(
      [
        ...[...this.#sessions.entries()].map(async ([providerThreadId, session]) => {
          await this.#closeSession(providerThreadId, session);
        }),
        ...[...this.#unboundClients].map(async (client) => {
          await client.close();
          this.#unboundClients.delete(client);
        }),
      ],
    );
    const failures = settlements.flatMap((settlement) =>
      settlement.status === "rejected" ? [settlement.reason as unknown] : []);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Claude session children could not be joined during shutdown.",
      );
    }
  }

  /** True only for a current-generation process and active host-tool binding owned by this daemon. */
  hasLiveSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean {
    const session = this.#sessions.get(input.providerThreadId);
    return this.#state === "open"
      && session !== undefined
      && session.closeState === "open"
      && session.authority.id === input.authority.id
      && session.authority.generation === input.authority.generation
      && session.status !== "terminal"
      && session.hostToolState === "active"
      && this.#isCurrent(input.authority);
  }

  /** True until every process, binding, and unconsumed launch review releases this generation. */
  hasRetainedProfileAuthority(input: { authority: ProfileAuthority }): boolean {
    return [...this.#sessions.values()].some((session) =>
      this.#sameAuthority(session.authority, input.authority))
      || [...this.#reviews.values()].some((review) =>
        this.#sameAuthority(review.authority, input.authority));
  }

  /** Revokes and joins every process bound to one superseded profile generation. */
  async retireProfileAuthority(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    for (const [reviewId, pending] of this.#reviews) {
      if (
        pending.authority.id === input.authority.id
        && pending.authority.generation === input.authority.generation
      ) this.#reviews.delete(reviewId);
    }
    const stale = [...this.#sessions.entries()].filter(([, session]) =>
      session.authority.id === input.authority.id
      && session.authority.generation === input.authority.generation);
    const settlements = await Promise.allSettled(stale.map(
      async ([providerThreadId, session]) => await this.#closeSession(providerThreadId, session),
    ));
    const failures = settlements.flatMap((settlement) =>
      settlement.status === "rejected" ? [settlement.reason as unknown] : []);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Claude sessions could not be retired from their exact authority.",
      );
    }
    input.signal.throwIfAborted();
  }

  /** The provider authority one pending `can_use_tool` request binds. */
  interactionAuthority(
    providerThreadId: string,
    requestId: string,
  ): ProviderInteractionAuthority {
    const session = this.#sessions.get(providerThreadId);
    const pending = session?.client.pendingInteraction(requestId);
    if (session === undefined || pending === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude control request is no longer pending.");
    }
    return {
      approvalId: pending.request.toolUseId,
      connectionId: session.connectionId,
      itemId: pending.request.toolUseId,
      method: METHOD,
      processGeneration: session.authority.generation,
      profileId: session.authority.id,
      requestDigest: requestDigestOf(requestId, pending.request),
      requestId: { type: "string", value: requestId },
      threadId: session.providerThreadId,
      turnId: session.activeTurnId ?? null,
    };
  }

  async #review(input: {
    authority: ProfileAuthority;
    kind: "session_start" | "turn_start";
    projectRoot?: string;
    providerThreadId?: string;
    preset: Preset;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<ClaudeRuntimeStartReview> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    if (input.kind === "session_start") this.#assertNoUnboundSessionChild();
    // Refuse another provider's preset before touching the runtime at all.
    assertPresetSupportedByProvider("claude", input.preset);
    if (input.fast) {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        "Claude Code has no HRA fast mode; start the session without `--fast`.",
      );
    }
    const projectRoot = input.projectRoot;
    if (projectRoot === undefined) {
      throw new ClaudeError("INVALID_INPUT", "A Claude session requires a project directory.");
    }
    const configDir = await this.#configDirFor(input.authority);
    this.#assertLaunchAuthority(input.authority, input.signal);
    if (input.kind === "session_start") this.#assertNoUnboundSessionChild();
    const runtime = await this.#admitRuntime(configDir, input.signal);
    this.#assertLaunchAuthority(input.authority, input.signal);
    if (input.kind === "session_start") this.#assertNoUnboundSessionChild();
    this.#resolvedRuntime = runtime;
    const profile = effectiveClaudeRuntimeProfileSchema.parse({
      claudeVersion: runtime.version,
      inputFormat: "stream-json",
      isolatedConfigDir: true,
      model: runtime.model,
      observedAt: this.#now(),
      outputFormat: "stream-json",
      permissionMode: "default",
      preset: input.preset,
      processGeneration: input.authority.generation,
      profileId: input.authority.id,
      reasoningEffort: runtime.effort,
    });
    const review: ClaudeRuntimeStartReview = {
      effectiveRuntimeProfile: profile,
      kind: input.kind,
      reviewId: randomUUID(),
    };
    this.#reviews.set(review.reviewId, {
      authority: input.authority,
      projectRoot,
      review,
      runtime,
      ...(input.providerThreadId === undefined ? {} : { providerThreadId: input.providerThreadId }),
    });
    return review;
  }

  #assertLaunchAuthority(authority: ProfileAuthority, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.#assertOpen();
    this.#assertCurrent(authority);
  }

  async #assertSessionConfig(session: RunningSession, signal: AbortSignal): Promise<void> {
    this.#assertLaunchAuthority(session.authority, signal);
    const configDir = await this.#configDirFor(session.authority);
    this.#assertLaunchAuthority(session.authority, signal);
    if (configDir !== session.client.configDir) {
      throw new ClaudeError(
        "CONFIG_DIR_MISMATCH",
        "Claude's isolated config authority changed before provider use.",
      );
    }
  }

  #assertNoUnboundSessionChild(): void {
    if (this.#unboundClients.size > 0) {
      throw new ClaudeError(
        "PROCESS_EXITED",
        "A prior Claude session child is still unjoined; no new session review or launch is allowed until shutdown joins it.",
      );
    }
  }

  #consumeReview(
    review: ClaudeRuntimeStartReview,
    kind: "session_start" | "turn_start",
  ): PendingClaudeReview {
    const pending = this.#reviews.get(review.reviewId);
    this.#reviews.delete(review.reviewId);
    if (pending === undefined || pending.review.kind !== kind) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude runtime review is no longer usable.");
    }
    if (
      JSON.stringify(pending.review.effectiveRuntimeProfile)
      !== JSON.stringify(review.effectiveRuntimeProfile)
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude runtime review was modified.");
    }
    return pending;
  }

  #requireSession(authority: ProfileAuthority, providerThreadId: string): RunningSession {
    const session = this.#sessions.get(providerThreadId);
    if (session === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude session is not running on this daemon.");
    }
    if (
      session.authority.id !== authority.id
      || session.authority.generation !== authority.generation
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude session belongs to another authority.");
    }
    this.#assertCurrent(authority);
    if (session.closeState !== "open") {
      throw new ClaudeError(
        "PROCESS_EXITED",
        "That Claude session's process cleanup is unresolved on this daemon.",
      );
    }
    return session;
  }

  async #closeSession(providerThreadId: string, session: RunningSession): Promise<void> {
    if (this.#sessions.get(providerThreadId) === session) session.closeState = "closing";
    const settlements = await Promise.allSettled([
      this.#revokeSessionHostTools(session),
      session.client.close(),
    ]);
    const failures = settlements.flatMap((settlement) =>
      settlement.status === "rejected" ? [settlement.reason as unknown] : []);
    if (failures.length > 0) {
      if (this.#sessions.get(providerThreadId) === session) session.closeState = "failed";
      throw new AggregateError(
        failures,
        "Claude session process or host-tool binding could not be joined; cleanup was incomplete.",
      );
    }
    // Delete only the exact entry whose process was just proven joined. A
    // concurrent close shares the client's close task, while an impossible id
    // replacement cannot be deleted by the stale closer.
    if (this.#sessions.get(providerThreadId) === session) {
      this.#rememberClosedSession(providerThreadId, session.authority);
      this.#sessions.delete(providerThreadId);
    }
  }

  async #revokeSessionHostTools(session: RunningSession): Promise<void> {
    if (session.hostToolState === "revoked") return;
    const existing = session.hostToolRevocationTask;
    if (existing !== undefined) {
      await existing;
      return;
    }
    session.hostToolState = "revoking";
    session.hostToolCalls.clear();
    session.hostToolCallTombstones.clear();
    const task = this.#hostTools.bindingAuthority.revoke(session.hostToolBinding.bindingId);
    session.hostToolRevocationTask = task;
    try {
      await task;
      session.hostToolState = "revoked";
    } catch (error: unknown) {
      session.hostToolState = "revoking";
      throw error;
    } finally {
      if (session.hostToolRevocationTask === task) session.hostToolRevocationTask = undefined;
    }
  }

  #rememberClosedSession(providerThreadId: string, authority: ProfileAuthority): void {
    this.#closedSessionProofs.delete(providerThreadId);
    this.#closedSessionProofs.set(providerThreadId, { ...authority });
    while (this.#closedSessionProofs.size > CLOSED_SESSION_PROOF_LIMIT) {
      const oldest = this.#closedSessionProofs.keys().next();
      if (oldest.done === true) return;
      this.#closedSessionProofs.delete(oldest.value);
    }
  }

  #sameAuthority(left: ProfileAuthority, right: ProfileAuthority): boolean {
    return left.id === right.id
      && left.generation === right.generation
      && left.codexHome === right.codexHome
      && left.desktopUserData === right.desktopUserData;
  }

  #requirePending(
    authority: ProfileAuthority,
    provider: ProviderInteractionAuthority,
  ): Readonly<{ request: ClaudeCanUseTool; requestId: string; session: RunningSession }> {
    if (provider.method !== METHOD || provider.requestId.type !== "string") {
      throw new ClaudeError("PROTOCOL_ERROR", "That authority does not name a Claude tool request.");
    }
    const session = this.#requireSession(authority, provider.threadId ?? "");
    if (session.connectionId !== provider.connectionId) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude provider connection was replaced.");
    }
    const requestId = provider.requestId.value;
    const pending = session.client.pendingInteraction(requestId);
    if (pending === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude control request is no longer pending.");
    }
    if (requestDigestOf(requestId, pending.request) !== provider.requestDigest) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude control request no longer matches.");
    }
    return { request: pending.request, requestId, session };
  }

  #projection(session: RunningSession, detail = true): CodexSessionProjection {
    const base: CodexSessionProjection = {
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: session.updatedAt,
      projectRoot: session.projectRoot,
      status: session.status,
      title: session.title,
      ...(session.activeTurnId === undefined ? {} : { activeTurnId: session.activeTurnId }),
    };
    if (!detail) return base;
    return {
      ...base,
      messages: [...session.messages],
      omission: {
        hasMoreOlderTurns: session.droppedTurns > 0,
        // Every turn HRA started is proven by its own `user` line and its
        // `result`, so nothing is ever unread or incomplete here.
        incompleteTurnIds: [],
        omittedMessages: session.droppedMessages,
        returnedTurns: session.turnSummaries.length,
        truncatedMessages: session.truncatedMessages,
        turnLimit: PROJECTED_TURN_LIMIT,
        unreadItemTurnIds: [],
      },
      turnSummaries: [...session.turnSummaries],
    };
  }

  /** Records one human or steering line, and names the session on its first. */
  #appendUserMessage(
    session: RunningSession,
    turnId: string,
    message: string,
    clientMessageId: string,
  ): void {
    if (session.messages.length === 0) {
      session.title = boundClaudeText(
        sanitizeClaudeText(message),
        PROJECTED_TITLE_BYTES,
      ) || "Untitled session";
    }
    this.#pushMessage(session, {
      clientId: clientMessageId,
      role: "user",
      turnId,
      ...projectedText(message),
    });
  }

  /** Folds one assistant delta into that item's single projected message. */
  #appendAssistantDelta(
    session: RunningSession,
    turnId: string,
    itemId: string,
    text: string,
  ): void {
    const index = session.assistantItems.get(itemId);
    const existing = index === undefined ? undefined : session.messages[index];
    if (index === undefined || existing === undefined || existing.role !== "assistant") {
      this.#pushMessage(session, { role: "assistant", turnId, ...projectedText(text) });
      session.assistantItems.set(itemId, session.messages.length - 1);
      return;
    }
    const projected = projectedText(`${existing.text}${text}`);
    if (projected.omission !== undefined && existing.omission === undefined) {
      session.truncatedMessages += 1;
    }
    session.messages[index] = { role: "assistant", turnId, ...projected };
  }

  #pushMessage(session: RunningSession, message: CodexProjectedMessage): void {
    if (message.omission !== undefined) session.truncatedMessages += 1;
    session.messages.push(message);
    while (session.messages.length > PROJECTED_MESSAGE_LIMIT) {
      session.messages.shift();
      session.droppedMessages += 1;
      for (const [itemId, index] of [...session.assistantItems]) {
        if (index === 0) session.assistantItems.delete(itemId);
        else session.assistantItems.set(itemId, index - 1);
      }
    }
  }

  #recordTurnSummary(
    session: RunningSession,
    summary: Extract<ClaudeFact, { type: "turnSummary" }>,
  ): void {
    const completedAt = this.#now();
    session.turnSummaries.push({
      actions: [],
      completedAt,
      files: [],
      id: summary.turnId,
      omittedActions: 0,
      omittedFiles: 0,
      runtimeMs: summary.runtimeMs,
      startedAt: Math.max(0, completedAt - summary.runtimeMs),
      status: summary.status,
    });
    while (session.turnSummaries.length > PROJECTED_TURN_LIMIT) {
      session.turnSummaries.shift();
      session.droppedTurns += 1;
    }
  }

  async #onFact(
    providerThreadId: string,
    connectionId: string,
    fact: ClaudeFact,
  ): Promise<void> {
    const session = this.#sessions.get(providerThreadId);
    if (session === undefined) return;
    if (fact.type === "assistantDelta") {
      this.#appendAssistantDelta(session, fact.turnId, fact.itemId, fact.text);
    }
    if (fact.type === "turnSummary") this.#recordTurnSummary(session, fact);
    if (fact.type === "turnCompleted") {
      session.activeTurnId = undefined;
      if (session.status !== "terminal") session.status = "idle";
      session.assistantItems.clear();
    }
    if (fact.type === "providerError" && fact.terminal) {
      session.status = "terminal";
      await this.#revokeSessionHostTools(session);
    }
    session.updatedAt = this.#now();
    await this.#observer.fact(session.authority, { ...fact, connectionId, providerThreadId });
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new ClaudeError("PROCESS_EXITED", "The Claude runtime manager is closed.");
    }
  }

  #assertCurrent(authority: ProfileAuthority): void {
    if (!this.#isCurrent(authority)) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude account authority changed.");
    }
  }
}
