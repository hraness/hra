import { createHash, randomUUID } from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- D4 extracts the provider port; this file is the Claude adapter and loads the pinned runtime.
import {
  CLAUDE_PIN,
  ClaudeError,
  ClaudeStreamClient,
  boundClaudeText,
  readClaudeAuthStatus,
  sanitizeClaudeText,
  spawnBunClaudeProcess,
  resolvePinnedClaudeRuntime,
  type ClaudeAuthStatusReader,
  type ClaudeCanUseTool,
  type ClaudeFact,
  type ClaudeInteractionDecision,
  type ClaudeProcess,
  type PinnedClaudeRuntime,
  type ResolvePinnedClaudeRuntimeOptions,
} from "../claude/index";
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
  authority: ProfileAuthority;
  readonly client: ClaudeStreamClient;
  closeState: "open" | "closing" | "failed";
  readonly connectionId: string;
  readonly providerThreadId: string;
  readonly profile: EffectiveClaudeRuntimeProfile;
  readonly projectRoot: string;
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

export type { ClaudeSessionFact } from "./claude-session-facts";

export type ClaudeRuntimeObserver = {
  fact(authority: ProfileAuthority, fact: ClaudeSessionFact): void | Promise<void>;
};

type PendingClaudeReview = {
  readonly review: ClaudeRuntimeStartReview;
  readonly runtime: PinnedClaudeRuntime;
  authority: ProfileAuthority;
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
  }

  pinnedVersion(): string {
    const runtime = this.#resolvedRuntime;
    if (runtime === undefined) {
      throw new ClaudeError("RUNTIME_MISMATCH", "No Claude Code runtime has been admitted yet.");
    }
    return runtime.version;
  }

  rebindProfileAuthority(input: {
    profileId: ProfileAuthority["id"];
    expectedGeneration: number;
    nextGeneration: number;
  }): void {
    this.#assertOpen();
    if (
      !Number.isSafeInteger(input.expectedGeneration)
      || input.expectedGeneration < 0
      || input.nextGeneration !== input.expectedGeneration + 1
    ) {
      throw new ClaudeError(
        "INVALID_INPUT",
        "A Claude authority rebind must advance exactly one safe generation.",
      );
    }
    const sessions = [...this.#sessions.values()].filter(
      (session) => session.authority.id === input.profileId,
    );
    const reviews = [...this.#reviews.values()].filter(
      (review) => review.authority.id === input.profileId,
    );
    for (const authority of [
      ...sessions.map((session) => session.authority),
      ...reviews.map((review) => review.authority),
    ]) {
      if (
        authority.generation !== input.expectedGeneration
        && authority.generation !== input.nextGeneration
      ) {
        throw new ClaudeError(
          "AUTHORITY_STALE",
          "A live Claude process belongs to an unexpected account generation.",
        );
      }
    }
    const next = (authority: ProfileAuthority): ProfileAuthority => ({
      ...authority,
      generation: input.nextGeneration,
    });
    for (const session of sessions) session.authority = next(session.authority);
    for (const review of reviews) review.authority = next(review.authority);
    const rebound = sessions[0]?.authority ?? reviews[0]?.authority;
    if (rebound !== undefined) this.#assertCurrent(rebound);
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
    const runtime = await this.#admitRuntime(configDir);
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
    const connectionId = randomUUID();
    const providerThreadId = randomUUID();
    const configDir = await this.#configDirFor(input.authority);
    this.#assertLaunchAuthority(input.authority, input.signal);
    this.#assertNoUnboundSessionChild();
    const process = this.#processFactory({
      configDir,
      projectRoot: pending.projectRoot,
      runtime: pending.runtime,
    });
    const client = new ClaudeStreamClient({
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
    try {
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
      try {
        await client.close();
        this.#unboundClients.delete(client);
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "Claude session launch authority failed and its child cleanup was incomplete.",
          { cause: error },
        );
      }
      throw error;
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
    this.#assertOpen();
    const pending = this.#consumeReview(input.review, "turn_start");
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== undefined) {
      throw new ClaudeError("INVALID_INPUT", "The Claude session already has an active turn.");
    }
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
    this.#assertOpen();
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) {
      throw new ClaudeError("INVALID_INPUT", "That Claude turn is no longer active.");
    }
    await session.client.steer(input.message, input.attachments ?? []);
    this.#appendUserMessage(session, input.activeTurnId, input.message, input.clientMessageId);
  }

  async interrupt(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    activeTurnId: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertOpen();
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) return;
    await session.client.interrupt();
  }

  async observeSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<CodexSessionObservation> {
    const session = this.#requireSession(input.authority, input.providerThreadId);
    return {
      connectionId: session.connectionId,
      projection: this.#projection(session),
      resumed: false,
    };
  }

  async readSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    detail: boolean;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection> {
    return this.#projection(this.#requireSession(input.authority, input.providerThreadId));
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
    void input.signal;
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
  }

  /** Widens the runtime-resolution failure into one actionable instruction. */
  async #admitRuntime(configDir: string): Promise<PinnedClaudeRuntime> {
    try {
      return await this.#resolveRuntime({ configDir } satisfies ResolvePinnedClaudeRuntimeOptions);
    } catch (error: unknown) {
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
    const { request, session, requestId } = this.#requirePending(input.authority, input.provider);
    const decision = decisionFor(input.kind, input.resolution, request);
    return { responseDigest: session.client.validateInteractionResolution(requestId, decision).responseDigest };
  }

  async resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    const { request, session, requestId } = this.#requirePending(input.authority, input.provider);
    if (this.#now() > input.deadlineAt) {
      throw new ClaudeError("DEADLINE_EXPIRED", "The Claude interaction deadline passed.");
    }
    await session.client.resolveInteraction(requestId, decisionFor(input.kind, input.resolution, request));
    this.#reportInteractionSettled(session, requestId);
    return { responseWritten: true };
  }

  async validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    const { session, requestId } = this.#requirePending(input.authority, input.provider);
    return {
      responseDigest: session.client.validateInteractionResolution(requestId, {
        kind: "deny",
        message: "HRA did not receive a decision in time",
      }).responseDigest,
    };
  }

  async timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    const { session, requestId } = this.#requirePending(input.authority, input.provider);
    await session.client.resolveInteraction(requestId, {
      kind: "deny",
      message: "HRA did not receive a decision in time",
    });
    this.#reportInteractionSettled(session, requestId);
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
    const runtime = await this.#admitRuntime(configDir);
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
    try {
      await session.client.close();
    } catch (error: unknown) {
      if (this.#sessions.get(providerThreadId) === session) session.closeState = "failed";
      throw error;
    }
    // Delete only the exact entry whose process was just proven joined. A
    // concurrent close shares the client's close task, while an impossible id
    // replacement cannot be deleted by the stale closer.
    if (this.#sessions.get(providerThreadId) === session) {
      this.#rememberClosedSession(providerThreadId, session.authority);
      this.#sessions.delete(providerThreadId);
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
      session.status = "idle";
      session.assistantItems.clear();
    }
    if (fact.type === "providerError" && fact.terminal) session.status = "terminal";
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
