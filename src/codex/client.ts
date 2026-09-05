import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import {
  attachmentMessageText,
  type PreparedAttachment,
} from "../domain/attachments.ts";
import { HRA_VERSION } from "../version.ts";
import type {
  InteractionKind,
  InteractionResolution,
  LiveInteractionApprovalAuthority,
  ProviderInteractionAuthority,
} from "../domain/interactions.ts";
import {
  CodexError,
  CodexRemoteError,
  IndeterminateCodexEffectError,
} from "./errors.ts";
import { JsonLineDecoder } from "./jsonl.ts";
import { record, safeInteger, string } from "./parse.ts";
import type { CodexProcess } from "./process.ts";
import {
  HRA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS,
  OPERATIONS,
  PINNED_CODEX_VERSION,
  assertPinnedCodexNotificationMatrix,
  assertPinnedCodexServerRequestMatrix,
  boundedIdentifier,
  boundedPageLimit,
  boundedText,
  codexServerRequestDisposition,
  compileCodexInteractionResponse,
  digestCodexJson,
  parseAccountRead,
  parseAccountUsage,
  parseAppPage,
  parseBrokeredCodexServerRequest,
  parseConversationAutomationToolCall,
  parseCredentialStores,
  parseFact,
  parseFeaturePage,
  parseInitialize,
  parseManagedLogin,
  parseManagedLoginCancel,
  parseModelPage,
  parsePermissionProfilePage,
  parsePluginCatalog,
  parseProviderRequestId,
  parseRateLimits,
  parseRateLimitResetCreditConsumption,
  parseThreadMutation,
  parseThreadStart,
  parseThreadMetadataRead,
  parseThreadItemsPage,
  parseThreadPage,
  parseThreadRead,
  parseThreadUnsubscribe,
  parseThreadTurnsPage,
  parseTurnStart,
  providerRequestIdKey,
  rawProviderRequestId,
  resolvePreset,
  serializeDynamicToolPublicResult,
  validateAuthority,
  type AccountRateLimits,
  type AccountReadResult,
  type AccountUsage,
  type BrokeredCodexServerRequestMethod,
  type CodexApp,
  type CodexAuthority,
  type CodexCapabilitySnapshot,
  type ConversationAutomationToolCall,
  type CodexFact,
  type CodexFeature,
  type CodexMethod,
  type CodexModel,
  type CodexOperationDescriptor,
  type CodexThread,
  type DynamicToolPublicResult,
  type FencedCodexValue,
  type ManagedLoginResult,
  type Page,
  type ParsedBrokeredCodexServerRequest,
  type PermissionProfile,
  type CodexPluginCatalog,
  type PresetAlias,
  type RateLimitResetCreditConsumption,
  type ResolvedPreset,
  type ThreadPage,
  type ThreadStartResult,
  type ThreadUnsubscribeResult,
  type ThreadItemPage,
  type TurnPage,
  type TurnStartResult,
} from "./protocol.ts";

type ClientState =
  | "new"
  | "initializing"
  | "preflighting"
  | "ready"
  | "closing"
  | "closed"
  | "failed";

const STANDARD_MCP_FORM_INPUT_EXTENSION = "openai/standard-form-input";
const INTERACTION_DEADLINE_ERROR = Object.freeze({
  code: -32_008,
  message: "HRA interaction deadline expired",
});
const PRE_READY_FACT_LIMIT = 128;
const PRE_READY_FACT_BYTES = 1 * 1024 * 1024;
const INBOUND_DYNAMIC_REQUEST_LIMIT = 128;
const DYNAMIC_REQUEST_LEDGER_LIMIT = 4_096;
const CAPABILITY_DISCOVERY_MAX_DEADLINE_MS = 40_000;

interface PendingRequest {
  readonly id: number;
  readonly descriptor: CodexOperationDescriptor;
  readonly bypassAccountAuthorityBarrier: boolean;
  readonly parseAndResolve: (value: unknown, authority: CodexAuthority) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
  dispatched: boolean;
  responseReceived: boolean;
}

type ServerRequestState = "pending" | "writing" | "responded" | "resolved" | "resolution_unknown";

interface PendingServerRequest {
  readonly admission: ParsedBrokeredCodexServerRequest;
  readonly deadlineAt: number;
  admitted: boolean;
  admissionTask?: Promise<void>;
  state: ServerRequestState;
  responseDigest?: string;
  responseFrame?: Readonly<
    { id: number | string; result: unknown }
    | { id: number | string; error: Readonly<{ code: number; message: string }> }
  >;
}

interface PendingFrameWrite {
  readonly bytes: Uint8Array;
  readonly bypassAccountAuthorityBarrier: boolean;
  readonly beforeWrite?: () => void;
  readonly beforeWriteAsync?: () => Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
}

interface AccountAuthorityWriteBarrier {
  readonly task: Promise<void>;
}

class CodexFrameRejectedBeforeWriteError extends Error {
  constructor(readonly rejection: CodexError) {
    super(rejection.message, { cause: rejection });
    this.name = "CodexFrameRejectedBeforeWriteError";
  }
}

export interface CodexAppServerClientOptions {
  readonly process: CodexProcess;
  readonly authority: CodexAuthority;
  readonly expectedCodexHome: string;
  readonly credentialStorePreflight: Readonly<{
    readonly cliAuth: "file";
    readonly cwd: string;
    readonly mcpOauth: "file";
  }>;
  readonly experimentalApi?: boolean;
  readonly isAuthorityCurrent: (authority: CodexAuthority) => boolean | Promise<boolean>;
  /**
   * Synchronous edge raised before an account-change notification enters the
   * asynchronous fact tail. Runtime owners use it to close admission until an
   * authoritative account read has settled.
   */
  readonly onAccountAuthoritySignal?: (
    authority: CodexAuthority,
  ) => void | Promise<void>;
  readonly onFact?: (fact: FencedCodexValue<CodexFact>) => void | Promise<void>;
  /** Local-only host service for the one conversation-bound dynamic tool. */
  readonly onConversationAutomationToolCall?: (
    call: ConversationAutomationToolCall,
  ) => DynamicToolPublicResult | Promise<DynamicToolPublicResult>;
  /** Invoked only after the corresponding success response is fully written. */
  readonly onConversationAutomationToolResponseWritten?: (
    call: ConversationAutomationToolCall,
  ) => void | Promise<void>;
  readonly onSafeDiagnostic?: (message: string) => void;
  readonly maxJsonLineBytes?: number;
  readonly shutdownTermGraceMs?: number;
  readonly shutdownSettlementMs?: number;
  readonly now?: () => number;
  /** Deterministic tests only. Production uses the hard 40-second ceiling. */
  readonly capabilityDiscoveryDeadlineMs?: number;
  /** Deterministic tests only. Production always accepts the generated UUID. */
  readonly connectionId?: string;
}

export interface DiscoverCapabilitiesOptions {
  readonly cwd?: string;
  readonly threadId?: string;
  readonly includeExperimental?: boolean;
  readonly signal?: AbortSignal;
}

export interface ThreadListOptions {
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly cwd?: string;
  readonly archived?: boolean;
  readonly searchTerm?: string;
}

export interface ThreadTurnsListOptions {
  readonly threadId: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sortDirection?: "asc" | "desc";
  readonly itemsView?: "notLoaded" | "summary" | "full";
}

export interface ThreadItemsListOptions {
  readonly threadId: string;
  readonly turnId?: string;
  readonly cursor?: string | null;
  readonly limit?: number;
  readonly sortDirection?: "asc" | "desc";
}

export interface ThreadPolicy {
  readonly review: "user" | "auto_review";
  readonly permissionProfile: ":workspace";
  readonly writableRoots: readonly string[];
}

export interface StartThreadInput {
  readonly cwd: string;
  readonly preset: ResolvedPreset;
  readonly policy: ThreadPolicy;
}

export interface ResumeThreadInput extends StartThreadInput {
  readonly threadId: string;
}

export interface StartTurnInput {
  readonly threadId: string;
  readonly clientMessageId: string;
  readonly text: string;
  readonly attachments?: readonly PreparedAttachment[];
  readonly preset: ResolvedPreset;
  readonly cwd?: string;
  readonly policy?: ThreadPolicy;
}

/*
 * The `turn/start` and `turn/steer` input array.
 *
 * The pinned app-server accepts `UserInput` variants `text`, `image`,
 * `localImage`, `audio`, `localAudio`, `skill`, and `mention`. HRA emits
 * exactly two of them: one `text` item, and one `localImage` item per image
 * attachment naming its mode-0600 blob in the local content-addressed store.
 * There is no file content item, so a text-ish attachment is folded into the
 * text item as a fenced block with a header naming the file.
 *
 * With no attachment this returns the exact single-element array HRA sent
 * before attachments existed, so every existing turn is byte-identical.
 */
export const codexTurnInput = (
  text: string,
  attachments: readonly PreparedAttachment[] = [],
): readonly Readonly<Record<string, unknown>>[] => [
  { type: "text", text: boundedText(attachmentMessageText(text, attachments), "message") },
  ...attachments.flatMap((attachment) => attachment.kind === "image"
    ? [{ type: "localImage", path: canonicalAbsolute(attachment.path, "attachment path") }]
    : []),
];

export class CodexAppServerClient {
  readonly #process: CodexProcess;
  readonly #authority: CodexAuthority;
  readonly #expectedCodexHome: string;
  readonly #credentialStorePreflight: CodexAppServerClientOptions["credentialStorePreflight"];
  readonly #experimentalApi: boolean;
  readonly #isAuthorityCurrent: CodexAppServerClientOptions["isAuthorityCurrent"];
  readonly #onAccountAuthoritySignal:
    | CodexAppServerClientOptions["onAccountAuthoritySignal"]
    | undefined;
  readonly #onFact: NonNullable<CodexAppServerClientOptions["onFact"]>;
  readonly #onConversationAutomationToolCall:
    | CodexAppServerClientOptions["onConversationAutomationToolCall"]
    | undefined;
  readonly #onConversationAutomationToolResponseWritten:
    | CodexAppServerClientOptions["onConversationAutomationToolResponseWritten"]
    | undefined;
  readonly #onSafeDiagnostic: NonNullable<CodexAppServerClientOptions["onSafeDiagnostic"]>;
  readonly #decoder: JsonLineDecoder;
  readonly #connectionId: string;
  readonly #shutdownTermGraceMs: number;
  readonly #shutdownSettlementMs: number;
  readonly #capabilityDiscoveryDeadlineMs: number;
  readonly #now: () => number;
  readonly #encoder = new TextEncoder();
  readonly #pending = new Map<number, PendingRequest>();
  readonly #serverRequests = new Map<string, PendingServerRequest>();
  readonly #dynamicRequestDigests = new Map<string, string>();
  readonly #inboundDynamicRequests = new Set<Promise<void>>();
  readonly #inboundServerRequests = new Set<Promise<void>>();
  readonly #inboundResponseSettlements = new Set<Promise<void>>();
  #factTail: Promise<void> = Promise.resolve();
  #writeTail: Promise<void> = Promise.resolve();
  readonly #writeQueue: PendingFrameWrite[] = [];
  #writeDrainActive = false;
  #writeBarrierWake: (() => void) | null = null;
  #accountAuthorityWriteBarrier: AccountAuthorityWriteBarrier | null = null;
  #disconnectEmitted = false;
  #connectionAnnounced = false;
  #preReadyFactBytes = 0;
  readonly #preReadyFacts: CodexFact[] = [];
  #preReadyInboundCount = 0;
  #state: ClientState = "new";
  #nextRequestId = 1;
  #readTask: Promise<void> | null = null;
  #closeTask: Promise<void> | null = null;

  constructor(options: CodexAppServerClientOptions) {
    assertPinnedCodexNotificationMatrix();
    assertPinnedCodexServerRequestMatrix();
    this.#process = options.process;
    this.#authority = validateAuthority(options.authority);
    if (!isAbsolute(options.expectedCodexHome)) {
      throw new CodexError("INVALID_INPUT", "expected CODEX_HOME must be absolute");
    }
    if (!Object.hasOwn(options, "credentialStorePreflight")) {
      throw new CodexError("INVALID_INPUT", "credential-store preflight is required");
    }
    this.#expectedCodexHome = resolve(options.expectedCodexHome);
    this.#credentialStorePreflight = {
      cliAuth: options.credentialStorePreflight.cliAuth,
      cwd: canonicalAbsolute(options.credentialStorePreflight.cwd, "credential-store preflight cwd"),
      mcpOauth: options.credentialStorePreflight.mcpOauth,
    };
    this.#experimentalApi = options.experimentalApi ?? false;
    this.#isAuthorityCurrent = options.isAuthorityCurrent;
    this.#onAccountAuthoritySignal = options.onAccountAuthoritySignal;
    this.#onFact = options.onFact ?? (() => undefined);
    if (
      (options.onConversationAutomationToolCall === undefined)
      !== (options.onConversationAutomationToolResponseWritten === undefined)
    ) {
      throw new CodexError(
        "INVALID_INPUT",
        "conversation automation requires paired call and response-written callbacks",
      );
    }
    this.#onConversationAutomationToolCall = options.onConversationAutomationToolCall;
    this.#onConversationAutomationToolResponseWritten =
      options.onConversationAutomationToolResponseWritten;
    this.#onSafeDiagnostic = options.onSafeDiagnostic ?? (() => undefined);
    this.#decoder = new JsonLineDecoder(
      options.maxJsonLineBytes === undefined
        ? {}
        : { maxLineBytes: options.maxJsonLineBytes },
    );
    this.#connectionId = options.connectionId ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(this.#connectionId)) {
      throw new CodexError("INVALID_INPUT", "Codex connection id must be a UUID");
    }
    this.#shutdownTermGraceMs = boundedShutdownDuration(
      options.shutdownTermGraceMs ?? 2_000,
      "Codex TERM grace",
    );
    this.#shutdownSettlementMs = boundedShutdownDuration(
      options.shutdownSettlementMs ?? 1_000,
      "Codex shutdown settlement",
    );
    this.#capabilityDiscoveryDeadlineMs = boundedCapabilityDiscoveryDeadline(
      options.capabilityDiscoveryDeadlineMs ?? CAPABILITY_DISCOVERY_MAX_DEADLINE_MS,
    );
    this.#now = options.now ?? Date.now;
  }

  get authority(): CodexAuthority {
    return this.#authority;
  }

  get state(): ClientState {
    return this.#state;
  }

  get connectionId(): string {
    return this.#connectionId;
  }

  #requireState(expected: ClientState, message: string): void {
    if (this.#state !== expected) throw new CodexError("PROCESS_EXITED", message);
  }

  async initialize(): Promise<FencedCodexValue<{ readonly userAgent: string; readonly platformOs: string }>> {
    if (this.#state !== "new") {
      throw new CodexError("PROTOCOL_ERROR", "Codex app-server can only be initialized once");
    }
    this.#state = "initializing";
    this.#readTask = this.#readLoop();
    void this.#drainStderr();
    void this.#watchExit();

    try {
      const initialized = await this.#request(
        OPERATIONS.initialize,
        {
          clientInfo: {
            name: "hra",
            title: "HRA",
            version: HRA_VERSION,
          },
          capabilities: {
            experimentalApi: this.#experimentalApi,
            extensions: { [STANDARD_MCP_FORM_INPUT_EXTENSION]: {} },
          },
        },
        parseInitialize,
        "initializing",
      );
      const versionToken = new RegExp(
        `(?:^|/)${PINNED_CODEX_VERSION.replaceAll(".", "\\.")}(?:[ (]|$)`,
        "u",
      );
      if (!versionToken.test(initialized.value.userAgent)) {
        throw new CodexError(
          "RUNTIME_MISMATCH",
          "Codex app-server identity does not match the pinned protocol schema",
        );
      }
      if (resolve(initialized.value.codexHome) !== this.#expectedCodexHome) {
        throw new CodexError(
          "HOME_MISMATCH",
          "Codex initialized against a different CODEX_HOME",
        );
      }
      await this.#writeFrame({ method: "initialized" });
      await this.#assertAuthority();
      this.#requireState("initializing", "Codex stopped during initialization");
      this.#state = "preflighting";
      await this.#assertCredentialStores(
        this.#credentialStorePreflight.cwd,
        "preflighting",
      );
      await this.#activateProvenConnection();
      return {
        authority: this.#authority,
        value: {
          userAgent: initialized.value.userAgent,
          platformOs: initialized.value.platformOs,
        },
      };
    } catch (error: unknown) {
      this.#preReadyFacts.length = 0;
      this.#preReadyFactBytes = 0;
      this.#state = "failed";
      this.#wakeWriteBarrier();
      try {
        this.#process.terminate();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "Codex initialization failed and process termination could not be requested.",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async accountRead(refreshToken = false): Promise<FencedCodexValue<AccountReadResult>> {
    return this.#closedRequest("account/read", { refreshToken }, parseAccountRead);
  }

  /** Runtime-owner-only read used to settle an account-authority barrier. */
  async refreshAccountAuthority(): Promise<FencedCodexValue<AccountReadResult>> {
    return this.#closedRequest(
      "account/read",
      { refreshToken: true },
      parseAccountRead,
      undefined,
      true,
    );
  }

  /** Rechecks project-layer effective custody before a project-scoped effect. */
  async assertCredentialStores(cwd: string, signal?: AbortSignal): Promise<void> {
    await this.#assertCredentialStores(cwd, "ready", signal);
  }

  async #assertCredentialStores(
    cwd: string,
    requestState: "preflighting" | "ready",
    signal?: AbortSignal,
  ): Promise<void> {
    const stores = await this.#request(
      OPERATIONS["config/read"],
      {
        includeLayers: false,
        cwd: canonicalAbsolute(cwd, "credential-store preflight cwd"),
      },
      parseCredentialStores,
      requestState,
      signal,
    );
    if (
      stores.value.cliAuth !== this.#credentialStorePreflight.cliAuth
      || stores.value.mcpOauth !== this.#credentialStorePreflight.mcpOauth
    ) {
      throw new CodexError(
        "RUNTIME_MISMATCH",
        "Codex did not apply the required file-backed credential stores",
      );
    }
  }

  async startManagedLogin(mode: "browser" | "device-code"): Promise<FencedCodexValue<ManagedLoginResult>> {
    const params =
      mode === "browser"
        ? { type: "chatgpt", useHostedLoginSuccessPage: true, appBrand: "chatgpt" }
        : { type: "chatgptDeviceCode" };
    return this.#closedRequest("account/login/start", params, parseManagedLogin);
  }

  async cancelManagedLogin(loginId: string): Promise<FencedCodexValue<{ readonly status: "canceled" | "notFound" }>> {
    return this.#closedRequest(
      "account/login/cancel",
      { loginId: boundedIdentifier(loginId, "login id") },
      parseManagedLoginCancel,
    );
  }

  async logout(): Promise<FencedCodexValue<Readonly<Record<string, never>>>> {
    return this.#closedRequest("account/logout", {}, parseEmptyResult);
  }

  async accountUsage(): Promise<FencedCodexValue<AccountUsage>> {
    return this.#closedRequest("account/usage/read", {}, parseAccountUsage);
  }

  async accountRateLimits(): Promise<FencedCodexValue<AccountRateLimits>> {
    return this.#closedRequest("account/rateLimits/read", {}, parseRateLimits);
  }

  async consumeRateLimitResetCredit(
    idempotencyKey: string,
  ): Promise<FencedCodexValue<RateLimitResetCreditConsumption>> {
    return this.#closedRequest(
      "account/rateLimitResetCredit/consume",
      { idempotencyKey: persistedUuid(idempotencyKey, "rate-limit reset idempotency key") },
      parseRateLimitResetCreditConsumption,
    );
  }

  async discoverCapabilities(
    options: DiscoverCapabilitiesOptions = {},
  ): Promise<FencedCodexValue<CodexCapabilitySnapshot>> {
    const aggregate = new AbortController();
    const abortForCaller = () => {
      aggregate.abort(options.signal?.reason ?? new DOMException(
        "Capability discovery was aborted",
        "AbortError",
      ));
    };
    options.signal?.addEventListener("abort", abortForCaller, { once: true });
    if (options.signal?.aborted === true) abortForCaller();
    const deadline = setTimeout(() => {
      aggregate.abort(new CodexError("TIMEOUT", "capability discovery timed out"));
    }, this.#capabilityDiscoveryDeadlineMs);
    deadline.unref();

    const discovery = (async () => {
      const models = await this.#allPages<CodexModel>("model/list", parseModelPage, {
        includeHidden: true,
        limit: 100,
      }, aggregate.signal);
      const features = await this.#allPages<CodexFeature>(
        "experimentalFeature/list",
        parseFeaturePage,
        {
          limit: 100,
          ...(options.threadId === undefined
            ? {}
            : { threadId: boundedIdentifier(options.threadId, "thread id") }),
        },
        aggregate.signal,
      );
      let permissionProfiles: readonly PermissionProfile[] | null = null;
      let apps: readonly CodexApp[] | null = null;
      if (options.includeExperimental === true) {
        if (!this.#experimentalApi) {
          throw new CodexError(
            "UNSUPPORTED_CAPABILITY",
            "experimental capability discovery was not enabled at initialization",
          );
        }
        permissionProfiles = await this.#allPages<PermissionProfile>(
          "permissionProfile/list",
          parsePermissionProfilePage,
          {
            limit: 100,
            ...(options.cwd === undefined ? {} : { cwd: canonicalAbsolute(options.cwd, "cwd") }),
          },
          aggregate.signal,
        );
        apps = await this.#allPages<CodexApp>("app/list", parseAppPage, {
          limit: 100,
          forceRefetch: true,
          ...(options.threadId === undefined
            ? {}
            : { threadId: boundedIdentifier(options.threadId, "thread id") }),
        }, aggregate.signal);
      }
      await this.#assertAuthority();
      throwIfAborted(aggregate.signal);
      return {
        authority: this.#authority,
        value: {
          models,
          features,
          permissionProfiles,
          apps,
          pluginLifecycle: "unsupported-under-development" as const,
        },
      };
    })();

    try {
      return await raceWithAbort(discovery, aggregate.signal);
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abortForCaller);
    }
  }

  async listPlugins(options: { readonly cwd?: string; readonly forceRefetch?: boolean } = {}): Promise<
    FencedCodexValue<CodexPluginCatalog>
  > {
    const catalog = await this.#closedRequest(
      "plugin/list",
      {
        ...(options.cwd === undefined
          ? {}
          : { cwds: [canonicalAbsolute(options.cwd, "plugin discovery cwd")] }),
        forceRefetch: options.forceRefetch ?? false,
      },
      parsePluginCatalog,
    );
    const pluginCount = catalog.value.marketplaces.reduce(
      (total, marketplace) => total + marketplace.plugins.length,
      0,
    );
    if (pluginCount > 5_000) {
      throw new CodexError("PROTOCOL_LIMIT", "plugin/list exceeded its aggregate item limit");
    }
    return catalog;
  }

  resolvePreset(
    capabilities: FencedCodexValue<CodexCapabilitySnapshot>,
    alias: PresetAlias,
    fast: boolean,
  ): ResolvedPreset {
    if (!sameAuthority(capabilities.authority, this.#authority)) {
      throw new CodexError("AUTHORITY_STALE", "capabilities belong to another process generation");
    }
    return resolvePreset(capabilities.value, alias, fast);
  }

  async listThreads(options: ThreadListOptions = {}): Promise<FencedCodexValue<ThreadPage>> {
    const params: Record<string, unknown> = {
      cursor: options.cursor ?? null,
      limit: boundedPageLimit(options.limit),
      sortKey: "recency_at",
      sortDirection: "desc",
      sourceKinds: [],
      archived: options.archived ?? false,
    };
    if (options.cwd !== undefined) params.cwd = canonicalAbsolute(options.cwd, "cwd");
    if (options.searchTerm !== undefined) {
      params.searchTerm = boundedText(options.searchTerm, "search term", 1_024);
    }
    return this.#closedRequest("thread/list", params, parseThreadPage);
  }

  async readThread(threadId: string, includeTurns = true): Promise<FencedCodexValue<CodexThread>> {
    return this.#closedRequest(
      "thread/read",
      { threadId: boundedIdentifier(threadId, "thread id"), includeTurns },
      includeTurns ? parseThreadRead : parseThreadMetadataRead,
    );
  }

  /** Exact pinned (`CODEX_PIN`) experimental shape. Callers must keep pages bounded. */
  async listThreadTurns(options: ThreadTurnsListOptions): Promise<FencedCodexValue<TurnPage>> {
    const limit = boundedPageLimit(options.limit);
    return this.#closedRequest(
      "thread/turns/list",
      {
        threadId: boundedIdentifier(options.threadId, "thread id"),
        cursor: options.cursor ?? null,
        limit,
        sortDirection: options.sortDirection ?? "desc",
        itemsView: options.itemsView ?? "summary",
      },
      (value) => {
        const page = parseThreadTurnsPage(value);
        if (page.data.length > limit) {
          throw new CodexError("PROTOCOL_LIMIT", "thread/turns/list exceeded its requested page limit");
        }
        return page;
      },
    );
  }

  /** Exact pinned (`CODEX_PIN`) experimental shape. A turn filter avoids whole-thread hydration. */
  async listThreadItems(options: ThreadItemsListOptions): Promise<FencedCodexValue<ThreadItemPage>> {
    const limit = boundedPageLimit(options.limit);
    return this.#closedRequest(
      "thread/items/list",
      {
        threadId: boundedIdentifier(options.threadId, "thread id"),
        ...(options.turnId === undefined
          ? {}
          : { turnId: boundedIdentifier(options.turnId, "turn id") }),
        cursor: options.cursor ?? null,
        limit,
        sortDirection: options.sortDirection ?? "asc",
      },
      (value) => {
        const page = parseThreadItemsPage(value);
        if (page.data.length > limit) {
          throw new CodexError("PROTOCOL_LIMIT", "thread/items/list exceeded its requested page limit");
        }
        return page;
      },
    );
  }

  async startThread(input: StartThreadInput): Promise<FencedCodexValue<ThreadStartResult>> {
    if (
      !this.#experimentalApi
      || this.#onConversationAutomationToolCall === undefined
      || this.#onConversationAutomationToolResponseWritten === undefined
    ) {
      throw new CodexError(
        "UNSUPPORTED_CAPABILITY",
        "Conversation-bound scheduled tasks require the reviewed dynamic-tool host service",
      );
    }
    const cwd = canonicalAbsolute(input.cwd, "cwd");
    const policy = compileThreadPolicy(input.policy);
    return this.#closedRequest(
      "thread/start",
      {
        model: input.preset.model,
        serviceTier: input.preset.serviceTier,
        cwd,
        permissions: input.policy.permissionProfile,
        runtimeWorkspaceRoots: policy.runtimeWorkspaceRoots,
        approvalPolicy: "on-request",
        approvalsReviewer: input.policy.review,
        config: { model_reasoning_effort: input.preset.effort },
        ephemeral: false,
        historyMode: "paginated",
        dynamicTools: HRA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS,
      },
      (value) => validateThreadStartResult(parseThreadStart(value), input, policy.runtimeWorkspaceRoots, cwd),
    );
  }

  async resumeThread(threadId: string): Promise<FencedCodexValue<CodexThread>> {
    return this.#closedRequest(
      "thread/resume",
      { threadId: boundedIdentifier(threadId, "thread id") },
      parseThreadMutation,
    );
  }

  /**
   * Resume an existing thread while replacing its next-turn policy with the
   * same reviewed authority HRA applies at native thread creation. The pinned
   * resume contract cannot add dynamic tools retroactively, so this method
   * deliberately sends only fields the provider documents for resume.
   */
  async resumeThreadWithPolicy(
    input: ResumeThreadInput,
  ): Promise<FencedCodexValue<ThreadStartResult>> {
    const cwd = canonicalAbsolute(input.cwd, "cwd");
    const policy = compileThreadPolicy(input.policy);
    return this.#closedRequest(
      "thread/resume",
      {
        threadId: boundedIdentifier(input.threadId, "thread id"),
        model: input.preset.model,
        serviceTier: input.preset.serviceTier,
        cwd,
        permissions: input.policy.permissionProfile,
        runtimeWorkspaceRoots: policy.runtimeWorkspaceRoots,
        approvalPolicy: "on-request",
        approvalsReviewer: input.policy.review,
        config: { model_reasoning_effort: input.preset.effort },
        excludeTurns: true,
      },
      (value) => validateThreadStartResult(
        parseThreadStart(value),
        input,
        policy.runtimeWorkspaceRoots,
        cwd,
      ),
    );
  }

  async unsubscribeThread(threadId: string): Promise<FencedCodexValue<ThreadUnsubscribeResult>> {
    return this.#closedRequest(
      "thread/unsubscribe",
      { threadId: boundedIdentifier(threadId, "thread id") },
      parseThreadUnsubscribe,
    );
  }

  async renameThread(threadId: string, name: string): Promise<FencedCodexValue<Readonly<Record<string, never>>>> {
    return this.#closedRequest(
      "thread/name/set",
      {
        threadId: boundedIdentifier(threadId, "thread id"),
        name: boundedText(name, "thread name", 1_024),
      },
      parseEmptyResult,
    );
  }

  async startTurn(input: StartTurnInput): Promise<FencedCodexValue<TurnStartResult>> {
    const params: Record<string, unknown> = {
      threadId: boundedIdentifier(input.threadId, "thread id"),
      clientUserMessageId: boundedIdentifier(input.clientMessageId, "client message id"),
      input: codexTurnInput(input.text, input.attachments ?? []),
      model: input.preset.model,
      effort: input.preset.effort,
      serviceTier: input.preset.serviceTier,
    };
    if (input.cwd !== undefined) params.cwd = canonicalAbsolute(input.cwd, "cwd");
    if (input.policy !== undefined) {
      const policy = compileThreadPolicy(input.policy);
      params.approvalPolicy = "on-request";
      params.approvalsReviewer = input.policy.review;
      params.permissions = input.policy.permissionProfile;
      params.runtimeWorkspaceRoots = policy.runtimeWorkspaceRoots;
    }
    return this.#closedRequest("turn/start", params, parseTurnStart);
  }

  async steerTurn(input: {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly clientMessageId: string;
    readonly text: string;
    readonly attachments?: readonly PreparedAttachment[];
  }): Promise<FencedCodexValue<{ readonly turnId: string }>> {
    return this.#closedRequest(
      "turn/steer",
      {
        threadId: boundedIdentifier(input.threadId, "thread id"),
        expectedTurnId: boundedIdentifier(input.expectedTurnId, "expected turn id"),
        clientUserMessageId: boundedIdentifier(input.clientMessageId, "client message id"),
        input: codexTurnInput(input.text, input.attachments ?? []),
      },
      (value) => ({
        turnId: boundedIdentifier(record(value, "turn/steer result").turnId as string, "turn id"),
      }),
    );
  }

  async interruptTurn(
    threadId: string,
    turnId: string,
  ): Promise<FencedCodexValue<Readonly<Record<string, never>>>> {
    return this.#closedRequest(
      "turn/interrupt",
      {
        threadId: boundedIdentifier(threadId, "thread id"),
        turnId: boundedIdentifier(turnId, "turn id"),
      },
      parseEmptyResult,
    );
  }

  async validateInteractionResolution(input: {
    readonly provider: ProviderInteractionAuthority;
    readonly kind: InteractionKind;
    readonly resolution: InteractionResolution;
  }): Promise<{ readonly responseDigest: string }> {
    const { responseDigest } = await this.#compileInteractionResolution(input);
    return { responseDigest };
  }

  async inspectInteractionAuthority(input: {
    readonly provider: ProviderInteractionAuthority;
    readonly kind: InteractionKind;
  }): Promise<LiveInteractionApprovalAuthority> {
    const pending = await this.#requirePendingServerRequest(input.provider);
    const authority = pending.admission.privateApprovalAuthority;
    if (
      pending.state !== "pending"
      || pending.admission.kind !== input.kind
      || authority === null
      || authority.kind !== input.kind
    ) {
      throw new CodexError(
        "UNSUPPORTED_CAPABILITY",
        "This provider request has no complete live approval authority to inspect.",
      );
    }
    return authority;
  }

  async resolveInteraction(input: {
    readonly provider: ProviderInteractionAuthority;
    readonly kind: InteractionKind;
    readonly resolution: InteractionResolution;
    readonly deadlineAt: number;
  }): Promise<{ readonly responseWritten: true }> {
    const { pending, responseDigest, result } = await this.#compileInteractionResolution(input);
    if (
      !Number.isSafeInteger(input.deadlineAt)
      || input.deadlineAt < 0
      || input.deadlineAt !== pending.deadlineAt
    ) {
      throw new CodexError(
        "AUTHORITY_STALE",
        "the interaction deadline does not match the admitted provider request",
      );
    }
    if (pending.state === "responded") return { responseWritten: true };
    if (pending.state === "writing" || pending.state === "resolution_unknown") {
      throw new CodexError(
        "INDETERMINATE_EFFECT",
        "the provider response may already have been written; wait for reconciliation",
      );
    }
    if (pending.state !== "pending") {
      throw new CodexError(
        "AUTHORITY_STALE",
        "the provider request was resolved before the response could be reserved",
      );
    }
    const responseFrame = {
      id: rawProviderRequestId(input.provider.requestId),
      result,
    } as const;
    pending.responseDigest = responseDigest;
    pending.responseFrame = responseFrame;
    pending.state = "writing";
    try {
      await this.#writeFrame(responseFrame, {
        beforeWrite: () => {
          const exactPending = this.#serverRequests.get(
            providerRequestIdKey(input.provider.requestId),
          );
          if (
            this.#state !== "ready"
            || exactPending !== pending
            || pending.state !== "writing"
            || pending.responseFrame !== responseFrame
            || pending.responseDigest !== responseDigest
          ) {
            throw new CodexError(
              "AUTHORITY_STALE",
              "the provider request was resolved before the response write began",
            );
          }
          if (this.#now() >= pending.deadlineAt) {
            throw new CodexError(
              "DEADLINE_EXPIRED",
              "the interaction deadline elapsed before the response write began",
            );
          }
        },
      });
      pending.state = "responded";
      return { responseWritten: true };
    } catch (error) {
      if (error instanceof CodexFrameRejectedBeforeWriteError) {
        if (pending.state === "writing") pending.state = "pending";
        delete pending.responseDigest;
        delete pending.responseFrame;
        throw error.rejection;
      }
      pending.state = "resolution_unknown";
      this.#quarantineConnection("Codex interaction response write became indeterminate");
      throw new CodexError(
        "INDETERMINATE_EFFECT",
        "the provider response may have reached Codex; reconcile before another attempt",
        { cause: error },
      );
    }
  }

  async validateInteractionTimeout(input: {
    readonly provider: ProviderInteractionAuthority;
  }): Promise<{ readonly responseDigest: string }> {
    const { responseDigest } = await this.#compileInteractionTimeout(input.provider);
    return { responseDigest };
  }

  async timeoutInteraction(input: {
    readonly provider: ProviderInteractionAuthority;
  }): Promise<{ readonly responseWritten: true }> {
    const { pending, responseDigest } = await this.#compileInteractionTimeout(input.provider);
    if (pending.state === "responded") return { responseWritten: true };
    if (pending.state === "writing" || pending.state === "resolution_unknown") {
      throw new CodexError(
        "INDETERMINATE_EFFECT",
        "the provider response may already have been written; wait for reconciliation",
      );
    }
    if (pending.state !== "pending") {
      throw new CodexError(
        "AUTHORITY_STALE",
        "the provider request was resolved before the timeout could be reserved",
      );
    }
    const responseFrame = {
      id: rawProviderRequestId(input.provider.requestId),
      error: INTERACTION_DEADLINE_ERROR,
    } as const;
    pending.responseDigest = responseDigest;
    pending.responseFrame = responseFrame;
    pending.state = "writing";
    try {
      await this.#writeFrame(responseFrame, {
        beforeWrite: () => {
          const exactPending = this.#serverRequests.get(
            providerRequestIdKey(input.provider.requestId),
          );
          if (
            this.#state !== "ready"
            || exactPending !== pending
            || pending.state !== "writing"
            || pending.responseFrame !== responseFrame
            || pending.responseDigest !== responseDigest
          ) {
            throw new CodexError(
              "AUTHORITY_STALE",
              "the provider request was resolved before the timeout write began",
            );
          }
        },
      });
      pending.state = "responded";
      return { responseWritten: true };
    } catch (error) {
      if (error instanceof CodexFrameRejectedBeforeWriteError) {
        if (pending.state === "writing") pending.state = "pending";
        delete pending.responseDigest;
        delete pending.responseFrame;
        throw error.rejection;
      }
      pending.state = "resolution_unknown";
      this.#quarantineConnection("Codex interaction deadline response write became indeterminate");
      throw new CodexError(
        "INDETERMINATE_EFFECT",
        "the provider timeout response may have reached Codex; reconcile before another attempt",
        { cause: error },
      );
    }
  }

  async #compileInteractionTimeout(provider: ProviderInteractionAuthority): Promise<{
    readonly pending: PendingServerRequest;
    readonly responseDigest: string;
  }> {
    const pending = await this.#requirePendingServerRequest(provider);
    const responseDigest = digestCodexJson(INTERACTION_DEADLINE_ERROR);
    if (pending.state === "responded" && pending.responseDigest !== responseDigest) {
      throw new CodexError("AUTHORITY_STALE", "the provider request already has a different response");
    }
    return { pending, responseDigest };
  }

  async #compileInteractionResolution(input: {
    readonly provider: ProviderInteractionAuthority;
    readonly kind: InteractionKind;
    readonly resolution: InteractionResolution;
  }): Promise<{
    readonly pending: PendingServerRequest;
    readonly responseDigest: string;
    readonly result: unknown;
  }> {
    const provider = input.provider;
    const pending = await this.#requirePendingServerRequest(provider);
    if (pending.admission.kind !== input.kind) {
      throw new CodexError("INVALID_INPUT", "the interaction kind does not match the provider request");
    }
    const result = compileCodexInteractionResponse({
      method: provider.method as BrokeredCodexServerRequestMethod,
      kind: input.kind,
      privateParams: pending.admission.privateParams,
      resolution: input.resolution,
    });
    const responseDigest = digestCodexJson(result);
    if (pending.state === "responded") {
      if (pending.responseDigest !== responseDigest) {
        throw new CodexError("AUTHORITY_STALE", "the provider request already has a different response");
      }
      return { pending, responseDigest, result };
    }
    return { pending, responseDigest, result };
  }

  async #requirePendingServerRequest(
    provider: ProviderInteractionAuthority,
  ): Promise<PendingServerRequest> {
    if (this.#state !== "ready") {
      throw new CodexError("AUTHORITY_STALE", "the Codex provider connection is no longer live");
    }
    await this.#assertAuthority();
    if (
      provider.profileId !== this.#authority.profileId
      || provider.processGeneration !== this.#authority.processGeneration
      || provider.connectionId !== this.#connectionId
      || codexServerRequestDisposition(provider.method) !== "brokered_interaction"
    ) {
      throw new CodexError("AUTHORITY_STALE", "the interaction belongs to another provider authority");
    }
    const key = providerRequestIdKey(provider.requestId);
    const pending = this.#serverRequests.get(key);
    if (pending === undefined || !sameProviderInteractionAuthority(pending.admission.provider, provider)) {
      throw new CodexError("AUTHORITY_STALE", "the provider request identity is stale or has changed");
    }
    if (!pending.admitted) {
      throw new CodexError("AUTHORITY_STALE", "the provider request has not completed durable admission");
    }
    if (pending.state === "resolved") {
      throw new CodexError("AUTHORITY_STALE", "the provider request is already resolved");
    }
    if (pending.state === "writing" || pending.state === "resolution_unknown") {
      throw new CodexError(
        "INDETERMINATE_EFFECT",
        "the provider response may already have been written; wait for reconciliation",
      );
    }
    return pending;
  }

  async close(): Promise<void> {
    if (this.#closeTask === null) {
      const task = this.#close();
      this.#closeTask = task;
      try {
        await task;
      } catch (error: unknown) {
        // A failed close retains process custody. Let the exact owner retry the
        // TERM/KILL/exit proof instead of caching a falsely completed release.
        if (this.#closeTask === task) this.#closeTask = null;
        throw error;
      }
      return;
    }
    await this.#closeTask;
  }

  async #close(): Promise<void> {
    if (this.#state === "closed") return;
    this.#state = "closing";
    this.#wakeWriteBarrier();
    this.#failPending(new CodexError("PROCESS_EXITED", "Codex is shutting down"));
    this.#emitDisconnected("closed");

    let terminated = false;
    try {
      this.#process.terminate();
      terminated = await resolvesWithin(this.#process.exited, this.#shutdownTermGraceMs);
    } catch {
      this.#onSafeDiagnostic("Codex TERM failed; forcing process termination");
    }
    if (!terminated) {
      try {
        this.#process.forceTerminate();
      } catch {
        this.#onSafeDiagnostic("Codex force termination failed");
      }
    }

    const inboundDynamicRequests = Promise.all([...this.#inboundDynamicRequests]);
    const inboundServerRequests = Promise.all([...this.#inboundServerRequests]);
    const inboundResponseSettlements = Promise.all([...this.#inboundResponseSettlements]);
    const [
      exitSettled,
      readSettled,
      factsSettled,
      writesSettled,
      inboundSettled,
      serverRequestsSettled,
      responsesSettled,
    ] = await Promise.all([
      resolvesWithin(this.#process.exited, this.#shutdownSettlementMs),
      this.#readTask === null
        ? Promise.resolve(true)
        : settlesWithin(this.#readTask, this.#shutdownSettlementMs),
      settlesWithin(this.#factTail, this.#shutdownSettlementMs),
      settlesWithin(this.#writeTail, this.#shutdownSettlementMs),
      settlesWithin(inboundDynamicRequests, this.#shutdownSettlementMs),
      settlesWithin(inboundServerRequests, this.#shutdownSettlementMs),
      settlesWithin(inboundResponseSettlements, this.#shutdownSettlementMs),
    ]);
    if (!exitSettled) this.#onSafeDiagnostic("Codex process exit did not settle after termination");
    if (!readSettled) this.#onSafeDiagnostic("Codex stdout did not settle after termination");
    if (!factsSettled) this.#onSafeDiagnostic("HRA fact delivery did not settle after Codex termination");
    if (!writesSettled) this.#onSafeDiagnostic("Codex writes did not settle after termination");
    if (!inboundSettled) {
      this.#onSafeDiagnostic("HRA dynamic-tool handling did not settle after Codex termination");
    }
    if (!serverRequestsSettled) {
      this.#onSafeDiagnostic("Codex server-request handling did not settle after termination");
    }
    if (!responsesSettled) {
      this.#onSafeDiagnostic("Codex response settlement did not finish after termination");
    }
    if (!exitSettled) {
      throw new CodexError(
        "PROCESS_EXITED",
        "Codex process exit could not be proven after force termination",
      );
    }
    this.#state = "closed";
  }

  async #closedRequest<T>(
    method: Exclude<CodexMethod, "initialize">,
    params: unknown,
    parse: (value: unknown) => T,
    signal?: AbortSignal,
    bypassAccountAuthorityBarrier = false,
  ): Promise<FencedCodexValue<T>> {
    if (this.#state !== "ready") {
      throw new CodexError("PROTOCOL_ERROR", "Codex app-server is not ready");
    }
    const descriptor = OPERATIONS[method];
    if (descriptor.experimental && !this.#experimentalApi) {
      throw new CodexError(
        "UNSUPPORTED_CAPABILITY",
        `${method} requires the pinned experimental API capability`,
      );
    }
    return this.#request(
      descriptor,
      params,
      parse,
      "ready",
      signal,
      bypassAccountAuthorityBarrier,
    );
  }

  async #request<T>(
    descriptor: CodexOperationDescriptor,
    params: unknown,
    parse: (value: unknown) => T,
    requestState: "initializing" | "preflighting" | "ready",
    signal?: AbortSignal,
    bypassAccountAuthorityBarrier = false,
  ): Promise<FencedCodexValue<T>> {
    if (this.#state !== requestState) {
      throw new CodexError(
        "PROTOCOL_ERROR",
        requestState === "ready"
          ? "Codex app-server is not ready"
          : "Codex app-server initialization phase changed",
      );
    }
    if (signal !== undefined && descriptor.effect !== "read") {
      throw new CodexError(
        "PROTOCOL_ERROR",
        "only read-only Codex requests may be canceled after dispatch",
      );
    }
    throwIfAborted(signal);
    await this.#assertAuthority();
    throwIfAborted(signal);
    if (this.#state !== requestState) {
      throw new CodexError("PROCESS_EXITED", "Codex is shutting down");
    }
    const id = this.#allocateRequestId();
    let exactPending: PendingRequest | undefined;
    const promise = new Promise<FencedCodexValue<T>>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        const pending = this.#takePending(id);
        if (pending === undefined) return;
        if (descriptor.lostResponse === "reconcile" && pending.dispatched) {
          rejectPromise(new IndeterminateCodexEffectError(descriptor.method, id));
        } else {
          rejectPromise(new CodexError("TIMEOUT", `${descriptor.method} timed out`));
        }
      }, descriptor.deadlineMs);
      const onAbort = signal === undefined
        ? undefined
        : () => {
          const pending = this.#takePending(id);
          if (pending !== undefined) pending.reject(abortReason(signal));
        };
      exactPending = {
        id,
        descriptor,
        bypassAccountAuthorityBarrier,
        parseAndResolve: (value, authority) => {
          resolvePromise({ authority, value: parse(value) });
        },
        reject: rejectPromise,
        timeout,
        ...(signal === undefined ? {} : { signal }),
        ...(onAbort === undefined ? {} : { onAbort }),
        dispatched: false,
        responseReceived: false,
      };
      this.#pending.set(id, exactPending);
      if (signal !== undefined && onAbort !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });

    try {
      const write = this.#writeFrame(
        { id, method: descriptor.method, params },
        {
          // The authoritative read is what resolves an account-change
          // barrier. It must be able to pass queued writes that the same
          // barrier is holding, or the read and write tails deadlock.
          bypassAccountAuthorityBarrier,
          beforeWrite: () => {
            throwIfAborted(signal);
            if (exactPending === undefined || this.#pending.get(id) !== exactPending) {
              throw new CodexError("TIMEOUT", `${descriptor.method} expired before dispatch`);
            }
            exactPending.dispatched = true;
          },
        },
      );
      await Promise.race([write, promise]);
    } catch (error) {
      const pending = this.#takePending(id);
      if (pending !== undefined) {
        pending.reject(
          descriptor.lostResponse === "reconcile" && pending.dispatched
            ? new IndeterminateCodexEffectError(descriptor.method, id, error)
            : error,
        );
      }
    }
    return promise;
  }

  async #allPages<T>(
    method: "model/list" | "experimentalFeature/list" | "permissionProfile/list" | "app/list",
    parse: (value: unknown) => Page<T>,
    baseParams: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<readonly T[]> {
    const output: T[] = [];
    let nextCursor: string | null = null;
    const seen = new Set<string>();
    const pageLimit = method === "app/list" ? 50 : 20;
    for (let page = 0; page < pageLimit; page += 1) {
      const pageParams = method === "app/list" && page > 0 && baseParams.forceRefetch === true
        ? { ...baseParams, forceRefetch: false, cursor: nextCursor }
        : { ...baseParams, cursor: nextCursor };
      const result: FencedCodexValue<Page<T>> = await this.#closedRequest<Page<T>>(
        method,
        pageParams,
        parse,
        signal,
      );
      output.push(...result.value.data);
      if (output.length > 5_000) {
        throw new CodexError("PROTOCOL_LIMIT", `${method} exceeded its item limit`);
      }
      nextCursor = result.value.nextCursor;
      if (nextCursor === null) return output;
      if (seen.has(nextCursor)) {
        throw new CodexError("PROTOCOL_ERROR", `${method} repeated a cursor`);
      }
      seen.add(nextCursor);
    }
    throw new CodexError("PROTOCOL_LIMIT", `${method} exceeded its page limit`);
  }

  async #activateProvenConnection(): Promise<void> {
    this.#requireState("preflighting", "Codex stopped during credential-store preflight");
    await this.#assertAuthority();
    this.#requireState("preflighting", "Codex stopped during credential-store preflight");

    // This is one run-to-completion activation commit. The read loop cannot
    // append another pre-ready fact between the snapshot and the ready state,
    // and no observer task can begin before ready is visible.
    const bufferedFacts = this.#preReadyFacts.splice(0);
    this.#preReadyFactBytes = 0;
    this.#preReadyInboundCount = 0;
    this.#state = "ready";
    this.#connectionAnnounced = true;
    void this.#enqueueFact({
      type: "providerConnected",
      connectionId: this.#connectionId,
    });
    for (const fact of bufferedFacts) {
      this.#enqueueBufferedFact(fact);
    }
  }

  #enqueueBufferedFact(fact: CodexFact): void {
    if (fact.type === "serverRequestResolved") {
      void this.#enqueueFact({
        type: "protocolNotice",
        method: "serverRequest/resolved",
        connectionId: this.#connectionId,
      });
      return;
    }
    void this.#enqueueFact({ ...fact, connectionId: this.#connectionId });
  }

  async #handlePreReadyMessage(
    message: Record<string, unknown>,
    method: string,
  ): Promise<void> {
    if (message.id !== undefined) {
      const requestId = parseProviderRequestId(message.id);
      await this.#writeFrame({
        id: rawProviderRequestId(requestId),
        error: {
          code: -32_001,
          message: "HRA has not activated this provider connection",
        },
      });
      return;
    }
    const fact = parseFact(method, message.params ?? {});
    const bytes = this.#encoder.encode(JSON.stringify(fact)).byteLength;
    if (bytes > PRE_READY_FACT_BYTES - this.#preReadyFactBytes) {
      throw new CodexError(
        "PROTOCOL_LIMIT",
        "Codex emitted too much data before credential-store preflight completed",
      );
    }
    this.#preReadyFactBytes += bytes;
    this.#preReadyFacts.push(fact);
  }

  async #handleParsedFact(fact: CodexFact): Promise<void> {
    const accountAuthoritySignaled = this.#signalAccountAuthority(fact);
    if (!(await this.#authorityIsCurrent())) return;
    if (fact.type === "serverRequestResolved") {
      await this.#handleServerRequestResolved(fact);
      return;
    }
    void this.#enqueueFact(
      { ...fact, connectionId: this.#connectionId },
      accountAuthoritySignaled,
    );
  }

  async #readLoop(): Promise<void> {
    try {
      for await (const chunk of this.#process.stdout) {
        for (const message of this.#decoder.push(chunk)) await this.#handleMessage(message);
      }
      for (const message of this.#decoder.finish()) await this.#handleMessage(message);
      if (this.#state !== "closing" && this.#state !== "closed") {
        const error = new CodexError("PROCESS_EXITED", "Codex stdout reached EOF");
        this.#state = "failed";
        this.#wakeWriteBarrier();
        this.#failPending(error);
        this.#emitDisconnected("eof");
      }
    } catch (error) {
      this.#failPending(error);
      if (this.#state !== "closing" && this.#state !== "closed") {
        this.#state = "failed";
        this.#wakeWriteBarrier();
        this.#emitDisconnected("protocol_fault");
      }
    }
  }

  async #drainStderr(): Promise<void> {
    try {
      for await (const chunk of this.#process.stderr) {
        this.#onSafeDiagnostic(`Codex wrote ${String(chunk.byteLength)} bytes to stderr`);
      }
    } catch {
      this.#onSafeDiagnostic("Codex stderr closed unexpectedly");
    }
  }

  async #watchExit(): Promise<void> {
    const exitCode = await this.#process.exited.catch(() => -1);
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#state = "failed";
    this.#wakeWriteBarrier();
    this.#failPending(
      new CodexError("PROCESS_EXITED", `Codex exited with status ${String(exitCode)}`),
    );
    this.#emitDisconnected("process_exit");
  }

  async #handleMessage(value: unknown): Promise<void> {
    const message = record(value, "JSON-RPC message");
    const preReady = this.#state === "initializing" || this.#state === "preflighting";
    if (preReady) this.#countPreReadyInboundFrame();
    if (message.id !== undefined && message.method === undefined) {
      await this.#handleResponse(message, preReady);
      return;
    }
    const method = string(message.method, "JSON-RPC method", { min: 1, max: 512 });
    if (preReady) {
      await this.#handlePreReadyMessage(message, method);
      return;
    }
    if (this.#state !== "ready") return;
    if (message.id !== undefined) {
      if (method === "item/tool/call") {
        if (this.#inboundDynamicRequests.size >= INBOUND_DYNAMIC_REQUEST_LIMIT) {
          this.#quarantineConnection("Codex exceeded the bounded dynamic-tool request limit");
          return;
        }
        this.#trackInboundDynamicRequest(
          this.#handleConversationAutomationToolCall(
            message.id,
            message.params ?? {},
          ),
        );
        return;
      }
      if (this.#inboundServerRequests.size >= INBOUND_DYNAMIC_REQUEST_LIMIT) {
        this.#quarantineConnection("Codex exceeded the bounded server-request handling limit");
        return;
      }
      this.#trackInboundServerRequest(
        this.#handleServerRequest(message.id, method, message.params ?? {}),
      );
      return;
    }
    const fact = parseFact(method, message.params ?? {});
    await this.#handleParsedFact(fact);
  }

  #countPreReadyInboundFrame(): void {
    this.#preReadyInboundCount += 1;
    if (this.#preReadyInboundCount > PRE_READY_FACT_LIMIT) {
      throw new CodexError(
        "PROTOCOL_LIMIT",
        "Codex emitted too many messages before credential-store preflight completed",
      );
    }
  }

  async #handleResponse(
    message: Record<string, unknown>,
    preReady: boolean,
  ): Promise<void> {
    const id = safeInteger(message.id, "JSON-RPC response id");
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      if (preReady) {
        throw new CodexError(
          "PROTOCOL_ERROR",
          "Codex emitted an unexpected response during initialization",
        );
      }
      return;
    }
    if (!pending.dispatched) {
      this.#quarantineConnection("Codex emitted a response before HRA dispatched its request");
      return;
    }
    if (pending.responseReceived) return;
    pending.responseReceived = true;
    const deferForAccountAuthority = !pending.bypassAccountAuthorityBarrier
      && this.#accountAuthorityWriteBarrier !== null;
    const settlement = this.#settleResponse(message, pending, id);
    if (deferForAccountAuthority) {
      this.#trackInboundResponseSettlement(settlement);
      return;
    }
    await settlement;
  }

  async #settleResponse(
    message: Record<string, unknown>,
    pending: PendingRequest,
    id: number,
  ): Promise<void> {
    if (!pending.bypassAccountAuthorityBarrier) {
      while (this.#accountAuthorityWriteBarrier !== null) {
        const accepted = await this.#awaitAccountAuthorityForResponse(pending, id);
        if (!accepted) return;
      }
    }
    let authorityIsCurrent = false;
    try {
      authorityIsCurrent = await this.#authorityIsCurrent();
    } catch (error: unknown) {
      this.#rejectResponseForAuthority(pending, id, error);
      return;
    }
    if (!authorityIsCurrent) {
      this.#rejectResponseForAuthority(pending, id);
      return;
    }
    if (!pending.bypassAccountAuthorityBarrier) {
      while (this.#accountAuthorityWriteBarrier !== null) {
        const accepted = await this.#awaitAccountAuthorityForResponse(pending, id);
        if (!accepted) return;
      }
    }
    if (this.#takePending(id) !== pending) return;
    if (message.error !== undefined) {
      const remote = record(message.error, "JSON-RPC error");
      pending.reject(new CodexRemoteError(safeInteger(remote.code, "JSON-RPC error code"), "request failed"));
      return;
    }
    if (!("result" in message)) {
      const missing = new CodexError("PROTOCOL_ERROR", "JSON-RPC response omitted result");
      pending.reject(pending.descriptor.lostResponse === "reconcile"
        ? new IndeterminateCodexEffectError(pending.descriptor.method, id, missing)
        : missing);
      return;
    }
    try {
      pending.parseAndResolve(message.result, this.#authority);
    } catch (error) {
      pending.reject(pending.descriptor.lostResponse === "reconcile"
        ? new IndeterminateCodexEffectError(pending.descriptor.method, id, error)
        : error);
    }
  }

  async #awaitAccountAuthorityForResponse(
    pending: PendingRequest,
    id: number,
  ): Promise<boolean> {
    for (;;) {
      const barrier = this.#accountAuthorityWriteBarrier;
      if (barrier === null) return true;
      try {
        await barrier.task;
      } catch (error: unknown) {
        this.#rejectResponseForAuthority(pending, id, error);
        return false;
      }
      if (this.#accountAuthorityWriteBarrier === barrier) {
        this.#accountAuthorityWriteBarrier = null;
      }
    }
  }

  #rejectResponseForAuthority(
    pending: PendingRequest,
    id: number,
    cause?: unknown,
  ): void {
    if (this.#takePending(id) !== pending) return;
    const stale = cause === undefined
      ? new CodexError(
          "AUTHORITY_STALE",
          "Codex response was not admitted under refreshed account authority",
        )
      : new CodexError(
          "AUTHORITY_STALE",
          "Codex response was not admitted under refreshed account authority",
          { cause },
        );
    pending.reject(
      pending.descriptor.lostResponse === "reconcile" && pending.dispatched
        ? new IndeterminateCodexEffectError(pending.descriptor.method, id, stale)
        : stale,
    );
  }

  #trackInboundResponseSettlement(task: Promise<void>): void {
    const tracked = task.then(
      () => undefined,
      (error: unknown) => {
        if (this.#state !== "ready") return;
        this.#onSafeDiagnostic(
          error instanceof Error
            ? `Codex response settlement failed: ${error.name}`
            : "Codex response settlement failed",
        );
      },
    );
    this.#inboundResponseSettlements.add(tracked);
    void tracked.then(() => {
      this.#inboundResponseSettlements.delete(tracked);
    });
  }

  async #handleConversationAutomationToolCall(
    idValue: unknown,
    params: unknown,
  ): Promise<void> {
    const requestId = parseProviderRequestId(idValue);
    const requestKey = providerRequestIdKey(requestId);
    if (this.#serverRequests.has(requestKey)) {
      this.#quarantineConnection("Codex reused a brokered request id for a dynamic tool");
      return;
    }
    const handler = this.#onConversationAutomationToolCall;
    const afterWrite = this.#onConversationAutomationToolResponseWritten;
    if (
      !this.#experimentalApi
      || handler === undefined
      || afterWrite === undefined
    ) {
      if (!(await this.#conversationAutomationAuthorityIsCurrent())) return;
      await this.#writeConversationAutomationFrame({
        id: rawProviderRequestId(requestId),
        error: { code: -32_601, message: "HRA did not advertise this host service" },
      });
      void this.#enqueueFact({
        type: "protocolNotice",
        method: "item/tool/call",
        connectionId: this.#connectionId,
      });
      return;
    }

    let call: ConversationAutomationToolCall;
    try {
      call = parseConversationAutomationToolCall({
        authority: this.#authority,
        connectionId: this.#connectionId,
        requestId,
        params,
      });
    } catch (error: unknown) {
      const unsupported = error instanceof CodexError
        && error.code === "UNSUPPORTED_CAPABILITY";
      if (!(await this.#conversationAutomationAuthorityIsCurrent())) return;
      await this.#writeConversationAutomationFrame({
        id: rawProviderRequestId(requestId),
        error: unsupported
          ? { code: -32_601, message: "HRA did not advertise this dynamic tool" }
          : { code: -32_602, message: "Invalid dynamic tool call params" },
      });
      this.#onSafeDiagnostic(unsupported
        ? "Codex requested an unadvertised dynamic tool"
        : "Codex sent invalid params for item/tool/call");
      void this.#enqueueFact({
        type: "protocolNotice",
        method: "item/tool/call",
        connectionId: this.#connectionId,
      });
      return;
    }

    const existingDigest = this.#dynamicRequestDigests.get(requestKey);
    if (existingDigest !== undefined && existingDigest !== call.requestDigest) {
      this.#quarantineConnection("Codex changed a dynamic-tool request under an existing id");
      return;
    }
    if (existingDigest === undefined) {
      if (this.#dynamicRequestDigests.size >= DYNAMIC_REQUEST_LEDGER_LIMIT) {
        this.#quarantineConnection("Codex exceeded the bounded dynamic-tool request ledger");
        return;
      }
      this.#dynamicRequestDigests.set(requestKey, call.requestDigest);
    }

    let text: string;
    try {
      if (!(await this.#conversationAutomationAuthorityIsCurrent())) return;
      const publicResult = await handler(call);
      if (!(await this.#conversationAutomationAuthorityIsCurrent())) return;
      text = serializeDynamicToolPublicResult(publicResult);
    } catch {
      if (!(await this.#conversationAutomationAuthorityIsCurrent())) return;
      this.#onSafeDiagnostic("HRA conversation automation host handler failed");
      await this.#writeConversationAutomationFrame({
        id: rawProviderRequestId(requestId),
        result: {
          contentItems: [{
            type: "inputText",
            text: "HRA could not complete this conversation-bound scheduled task request.",
          }],
          success: false,
        },
      });
      return;
    }

    await this.#writeConversationAutomationFrame({
      id: rawProviderRequestId(requestId),
      result: {
        contentItems: [{ type: "inputText", text }],
        success: true,
      },
    });
    if (!(await this.#conversationAutomationAuthorityIsCurrent())) return;
    try {
      await afterWrite(call);
    } catch {
      this.#onSafeDiagnostic("HRA conversation automation post-response hook failed");
    }
  }

  #trackInboundDynamicRequest(task: Promise<void>): void {
    const tracked = task.then(
      () => undefined,
      () => {
        if (this.#state !== "ready") return;
        try {
          this.#quarantineConnection("HRA dynamic-tool request handling failed");
        } catch {
          this.#onSafeDiagnostic("HRA could not terminate a failed dynamic-tool connection");
        }
      },
    );
    this.#inboundDynamicRequests.add(tracked);
    void tracked.then(() => {
      this.#inboundDynamicRequests.delete(tracked);
    });
  }

  #trackInboundServerRequest(task: Promise<void>): void {
    const tracked = task.then(
      () => undefined,
      () => {
        if (this.#state !== "ready") return;
        try {
          this.#quarantineConnection("Codex server-request handling failed");
        } catch {
          this.#onSafeDiagnostic("HRA could not terminate a failed server-request connection");
        }
      },
    );
    this.#inboundServerRequests.add(tracked);
    void tracked.then(() => {
      this.#inboundServerRequests.delete(tracked);
    });
  }

  async #conversationAutomationAuthorityIsCurrent(): Promise<boolean> {
    let current = false;
    try {
      current = await this.#authorityIsCurrent();
    } catch {
      current = false;
    }
    if (this.#state === "ready" && current) return true;
    if (this.#state === "ready") {
      this.#quarantineConnection("HRA dynamic-tool request belongs to stale authority");
    }
    return false;
  }

  async #writeConversationAutomationFrame(value: unknown): Promise<void> {
    await this.#writeFrame(value, {
      beforeWriteAsync: async () => {
        if (!(await this.#conversationAutomationAuthorityIsCurrent())) {
          throw new CodexError("AUTHORITY_STALE", "Codex process generation is stale");
        }
      },
      beforeWrite: () => {
        if (this.#state !== "ready") {
          throw new CodexError("AUTHORITY_STALE", "Codex provider connection is no longer live");
        }
      },
    });
  }

  async #handleServerRequest(idValue: unknown, method: string, params: unknown): Promise<void> {
    const requestedAt = this.#now();
    const requestId = parseProviderRequestId(idValue);
    const key = providerRequestIdKey(requestId);
    if (this.#dynamicRequestDigests.has(key)) {
      await this.#writeFrame({
        id: rawProviderRequestId(requestId),
        error: { code: -32_609, message: "Conflicting server request replay" },
      });
      this.#quarantineConnection("Codex reused a dynamic-tool request id for another service");
      return;
    }
    const disposition = codexServerRequestDisposition(method);
    if (disposition !== "brokered_interaction") {
      await this.#writeFrame({
        id: rawProviderRequestId(requestId),
        error: {
          code: disposition === null ? -32_601 : -32_601,
          message: disposition === "internal_host_service"
            ? "HRA did not advertise this host service"
            : "HRA does not support this server request",
        },
      });
      void this.#enqueueFact({ type: "protocolNotice", method, connectionId: this.#connectionId });
      return;
    }

    let admission: ParsedBrokeredCodexServerRequest;
    try {
      admission = parseBrokeredCodexServerRequest({
        authority: this.#authority,
        connectionId: this.#connectionId,
        requestId,
        method: method as BrokeredCodexServerRequestMethod,
        params,
      });
    } catch (error: unknown) {
      const unsupportedCapability = error instanceof CodexError
        && error.code === "UNSUPPORTED_CAPABILITY";
      await this.#writeFrame({
        id: rawProviderRequestId(requestId),
        error: unsupportedCapability
          ? {
              code: -32_601,
              message: "HRA cannot broker this server request capability",
              data: { code: "UNSUPPORTED_CAPABILITY" },
            }
          : { code: -32_602, message: "Invalid server request params" },
      });
      this.#onSafeDiagnostic(unsupportedCapability
        ? `Codex requested an unsupported capability for ${method}`
        : `Codex sent invalid params for ${method}`);
      void this.#enqueueFact({ type: "protocolNotice", method, connectionId: this.#connectionId });
      return;
    }
    const existing = this.#serverRequests.get(key);
    if (existing !== undefined) {
      if (!sameProviderInteractionAuthority(existing.admission.provider, admission.provider)) {
        await this.#writeFrame({
          id: rawProviderRequestId(requestId),
          error: { code: -32_609, message: "Conflicting server request replay" },
        });
        this.#quarantineConnection("Codex changed a server request under an existing id");
        return;
      }
      if (existing.state === "responded" && existing.responseFrame !== undefined) {
        const responseFrame = existing.responseFrame;
        try {
          await this.#writeFrame(responseFrame, {
            beforeWrite: () => {
              if (
                this.#state !== "ready"
                || this.#serverRequests.get(key) !== existing
                || existing.state !== "responded"
                || existing.responseFrame !== responseFrame
              ) {
                throw new CodexError(
                  "AUTHORITY_STALE",
                  "the cached interaction response became stale before replay",
                );
              }
            },
          });
        } catch (error: unknown) {
          if (
            error instanceof CodexFrameRejectedBeforeWriteError
            && error.rejection.code === "AUTHORITY_STALE"
          ) return;
          throw error;
        }
      } else if (existing.state === "resolved") {
        await this.#writeFrame({
          id: rawProviderRequestId(requestId),
          error: { code: -32_609, message: "Server request is already resolved" },
        });
      }
      return;
    }
    if (this.#serverRequests.size >= 4_096) {
      await this.#writeFrame({
        id: rawProviderRequestId(requestId),
        error: { code: -32_000, message: "Too many server requests" },
      });
      this.#quarantineConnection("Codex exceeded the bounded server-request ledger");
      return;
    }
    const deadlineAt = Math.min(
      Number.MAX_SAFE_INTEGER,
      requestedAt + admission.timeoutMs,
    );
    const pending: PendingServerRequest = {
      admission,
      deadlineAt,
      admitted: false,
      state: "pending",
    };
    this.#serverRequests.set(key, pending);
    const task = this.#enqueueFact({
      type: "interactionRequested",
      provider: admission.provider,
      kind: admission.kind,
      blocking: admission.blocking,
      display: admission.display,
      timeoutMs: admission.timeoutMs,
      requestedAt,
      deadlineAt,
      connectionId: this.#connectionId,
    });
    pending.admissionTask = task;
    void task.then(
      () => { pending.admitted = true; },
      async () => {
        if (this.#serverRequests.get(key) !== pending) return;
        this.#serverRequests.delete(key);
        if (pending.state !== "pending") return;
        await this.#writeFrame({
          id: rawProviderRequestId(requestId),
          error: { code: -32_000, message: "HRA could not durably admit this interaction" },
        }).catch(() => undefined);
      },
    );
  }

  async #handleServerRequestResolved(fact: Extract<CodexFact, { readonly type: "serverRequestResolved" }>): Promise<void> {
    const pending = this.#serverRequests.get(providerRequestIdKey(fact.requestId));
    if (pending === undefined) {
      void this.#enqueueFact({
        type: "protocolNotice",
        method: "serverRequest/resolved",
        connectionId: this.#connectionId,
      });
      return;
    }
    if (pending.admission.provider.threadId !== fact.threadId) {
      this.#quarantineConnection("Codex resolved a request under a different thread");
      return;
    }
    pending.state = "resolved";
    const emitResolved = (): void => {
      if (!pending.admitted || this.#serverRequests.get(providerRequestIdKey(fact.requestId)) !== pending) return;
      void this.#enqueueFact({
        type: "interactionResolved",
        provider: pending.admission.provider,
        kind: pending.admission.kind,
        connectionId: this.#connectionId,
      });
    };
    if (pending.admissionTask === undefined) emitResolved();
    else void pending.admissionTask.then(emitResolved, () => undefined);
  }

  #enqueueFact(fact: CodexFact, accountAuthoritySignaled = false): Promise<void> {
    if (!accountAuthoritySignaled) this.#signalAccountAuthority(fact);
    const task = this.#factTail.then(async () => {
      if (!(await this.#authorityIsCurrent())) return;
      await this.#onFact({ authority: this.#authority, value: fact });
    });
    this.#factTail = task.catch((error: unknown) => {
      this.#onSafeDiagnostic(
        error instanceof Error
          ? `HRA fact observer failed: ${error.name}`
          : "HRA fact observer failed",
      );
    });
    return task;
  }

  #signalAccountAuthority(fact: CodexFact): boolean {
    if (
      fact.type !== "accountUpdated"
      && (fact.type !== "loginCompleted" || !fact.success)
    ) return false;
    // This callback is deliberately invoked in the same run-to-completion
    // turn that parses a ready notification, before any authority lookup or
    // fact-tail await. Runtime owners can therefore close both external
    // admission and this client's outbound write boundary immediately.
    const task = this.#onAccountAuthoritySignal?.(this.#authority);
    if (task !== undefined) {
      const barrier: AccountAuthorityWriteBarrier = {
        task: Promise.resolve(task),
      };
      // The adapter also observes this rejection. The local handler prevents
      // an unhandled-rejection report when no outbound write is waiting yet.
      void barrier.task.catch(() => undefined);
      this.#accountAuthorityWriteBarrier = barrier;
      this.#wakeWriteBarrier();
    }
    return true;
  }

  #emitDisconnected(reason: "eof" | "process_exit" | "closed" | "protocol_fault"): void {
    if (!this.#connectionAnnounced || this.#disconnectEmitted) return;
    this.#disconnectEmitted = true;
    void this.#enqueueFact({
      type: "providerDisconnected",
      connectionId: this.#connectionId,
      reason,
    });
  }

  #quarantineConnection(message: string): void {
    if (this.#state === "closing" || this.#state === "closed" || this.#state === "failed") return;
    this.#state = "failed";
    this.#wakeWriteBarrier();
    this.#onSafeDiagnostic(message);
    this.#failPending(new CodexError("PROTOCOL_ERROR", "Codex provider connection was quarantined"));
    this.#emitDisconnected("protocol_fault");
    this.#process.terminate();
  }

  async #writeFrame(
    value: unknown,
    options: Readonly<{
      bypassAccountAuthorityBarrier?: boolean;
      beforeWrite?: () => void;
      beforeWriteAsync?: () => Promise<void>;
    }> = {},
  ): Promise<void> {
    const serialized = JSON.stringify(value);
    if (serialized.length > 4 * 1024 * 1024) {
      throw new CodexError("PROTOCOL_LIMIT", "outbound Codex frame exceeded its byte limit");
    }
    const bytes = this.#encoder.encode(`${serialized}\n`);
    let resolveWrite!: () => void;
    let rejectWrite!: (reason?: unknown) => void;
    const write = new Promise<void>((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
    const settled = write.catch(() => undefined);
    this.#writeTail = Promise.all([this.#writeTail, settled]).then(() => undefined);
    this.#writeQueue.push({
      bytes,
      bypassAccountAuthorityBarrier:
        options.bypassAccountAuthorityBarrier ?? false,
      ...(options.beforeWrite === undefined ? {} : { beforeWrite: options.beforeWrite }),
      ...(options.beforeWriteAsync === undefined
        ? {}
        : { beforeWriteAsync: options.beforeWriteAsync }),
      resolve: resolveWrite,
      reject: rejectWrite,
    });
    this.#wakeWriteBarrier();
    this.#startWriteDrain();
    await write;
  }

  #startWriteDrain(): void {
    if (this.#writeDrainActive) return;
    this.#writeDrainActive = true;
    void this.#drainWriteQueue();
  }

  async #drainWriteQueue(): Promise<void> {
    try {
      while (this.#writeQueue.length > 0) {
        let index = 0;
        let rejectedBarrier: AccountAuthorityWriteBarrier | null = null;
        if (
          !this.#writeStateIsTerminal()
          && this.#accountAuthorityWriteBarrier !== null
          && this.#writeQueue[0]?.bypassAccountAuthorityBarrier !== true
        ) {
          index = this.#writeQueue.findIndex(
            (entry) => entry.bypassAccountAuthorityBarrier,
          );
          if (index < 0) {
            rejectedBarrier = await this.#waitForAccountAuthorityOrPriorityWrite();
            if (rejectedBarrier === null) continue;
            index = 0;
          }
        }
        const entry = this.#writeQueue.splice(index, 1)[0];
        if (entry === undefined) continue;
        try {
          const written = await this.#performFrameWrite(entry, rejectedBarrier);
          if (!written) {
            this.#writeQueue.unshift(entry);
            continue;
          }
          entry.resolve();
        } catch (error: unknown) {
          entry.reject(error);
        }
      }
    } finally {
      this.#writeDrainActive = false;
      if (this.#writeQueue.length > 0) this.#startWriteDrain();
    }
  }

  async #waitForAccountAuthorityOrPriorityWrite(): Promise<AccountAuthorityWriteBarrier | null> {
    const barrier = this.#accountAuthorityWriteBarrier;
    if (barrier === null) return null;
    let wake!: () => void;
    const priorityWrite = new Promise<void>((resolve) => { wake = resolve; });
    this.#writeBarrierWake = wake;
    let winner: "barrier" | "priority";
    try {
      winner = await Promise.race([
        barrier.task.then(
          () => "barrier" as const,
          () => "barrier" as const,
        ),
        priorityWrite.then(() => "priority" as const),
      ]);
    } finally {
      if (this.#writeBarrierWake === wake) this.#writeBarrierWake = null;
    }
    if (winner === "priority") return null;
    if (this.#accountAuthorityWriteBarrier === barrier) {
      try {
        await barrier.task;
        if (this.#accountAuthorityWriteBarrier === barrier) {
          this.#accountAuthorityWriteBarrier = null;
        }
      } catch {
        // Keep a rejected barrier installed. Each non-bypass write will be
        // rejected before dispatch while the owning runtime retires the
        // client; an account/read remains available only to break a refresh
        // deadlock.
        return barrier;
      }
    }
    return null;
  }

  async #performFrameWrite(
    entry: PendingFrameWrite,
    rejectedBarrier: AccountAuthorityWriteBarrier | null,
  ): Promise<boolean> {
    try {
      if (this.#writeStateIsTerminal()) {
        throw new CodexError("PROCESS_EXITED", "Codex is shutting down");
      }
      if (rejectedBarrier !== null && !entry.bypassAccountAuthorityBarrier) {
        try {
          await rejectedBarrier.task;
        } catch (error: unknown) {
          throw new CodexError(
            "AUTHORITY_STALE",
            "Codex account authority refresh failed before the provider write",
            { cause: error },
          );
        }
      }
      if (entry.beforeWriteAsync !== undefined) await entry.beforeWriteAsync();
      if (this.#writeStateIsTerminal()) {
        throw new CodexError("PROCESS_EXITED", "Codex is shutting down");
      }
      if (!entry.bypassAccountAuthorityBarrier) {
        // A signal can arrive while an asynchronous pre-write authority check
        // is pending. Yield this normal frame back to the queue instead of
        // waiting in-place, so the barrier's refresh read can leapfrog it.
        if (this.#accountAuthorityWriteBarrier !== null) return false;
      }
      entry.beforeWrite?.();
    } catch (error: unknown) {
      if (error instanceof CodexError) {
        throw new CodexFrameRejectedBeforeWriteError(error);
      }
      throw error;
    }
    await this.#process.write(entry.bytes);
    return true;
  }

  #writeStateIsTerminal(): boolean {
    return this.#state === "closing"
      || this.#state === "closed"
      || this.#state === "failed";
  }

  #wakeWriteBarrier(): void {
    const wake = this.#writeBarrierWake;
    this.#writeBarrierWake = null;
    wake?.();
  }

  #allocateRequestId(): number {
    if (this.#nextRequestId >= Number.MAX_SAFE_INTEGER) {
      if (this.#pending.size > 0) {
        throw new CodexError("PROTOCOL_LIMIT", "Codex request id space is exhausted");
      }
      this.#nextRequestId = 1;
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return id;
  }

  #takePending(id: number): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    return pending;
  }

  async #assertAuthority(): Promise<void> {
    if (!(await this.#authorityIsCurrent())) {
      throw new CodexError("AUTHORITY_STALE", "Codex process generation is stale");
    }
  }

  async #authorityIsCurrent(): Promise<boolean> {
    return await this.#isAuthorityCurrent(this.#authority);
  }

  #failPending(cause: unknown): void {
    for (const id of [...this.#pending.keys()]) {
      const pending = this.#takePending(id);
      if (pending === undefined) continue;
      pending.reject(
        pending.descriptor.lostResponse === "reconcile" && pending.dispatched
          ? new IndeterminateCodexEffectError(pending.descriptor.method, pending.id, cause)
          : cause,
      );
    }
  }
}

function parseEmptyResult(value: unknown): Readonly<Record<string, never>> {
  const root = record(value, "empty result");
  if (Object.keys(root).length !== 0) {
    throw new CodexError("PROTOCOL_ERROR", "empty result contained unexpected fields");
  }
  return Object.freeze({});
}

function persistedUuid(value: string, label: string): string {
  if (
    typeof value !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) {
    throw new CodexError("INVALID_INPUT", `${label} must be a UUID`);
  }
  return value;
}

function canonicalAbsolute(value: string, label: string): string {
  if (!isAbsolute(value)) throw new CodexError("INVALID_INPUT", `${label} must be absolute`);
  const canonical = resolve(value);
  if (canonical !== value) {
    throw new CodexError("INVALID_INPUT", `${label} must already be normalized`);
  }
  return canonical;
}

function boundedCapabilityDiscoveryDeadline(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > CAPABILITY_DISCOVERY_MAX_DEADLINE_MS
  ) {
    throw new CodexError(
      "INVALID_INPUT",
      `capability discovery deadline must be an integer between 1 and ${String(CAPABILITY_DISCOVERY_MAX_DEADLINE_MS)} milliseconds`,
    );
  }
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The Codex read was aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => {
      settle(() => rejectPromise(abortReason(signal)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        settle(() => resolvePromise(value));
      },
      (error: unknown) => {
        settle(() => rejectPromise(error));
      },
    );
    if (signal.aborted) onAbort();
  });
}

function compileThreadPolicy(policy: ThreadPolicy): {
  readonly runtimeWorkspaceRoots: readonly string[];
} {
  if (policy.writableRoots.length < 1 || policy.writableRoots.length > 32) {
    throw new CodexError("INVALID_INPUT", "writable roots must contain between 1 and 32 paths");
  }
  const roots = policy.writableRoots.map((root) => canonicalAbsolute(root, "writable root"));
  if (new Set(roots).size !== roots.length) {
    throw new CodexError("INVALID_INPUT", "writable roots must be unique");
  }
  return {
    runtimeWorkspaceRoots: roots,
  };
}

function validateThreadStartResult(
  value: ThreadStartResult,
  input: StartThreadInput,
  runtimeWorkspaceRoots: readonly string[],
  cwd: string,
): ThreadStartResult {
  const expectedServiceTier = input.preset.serviceTier;
  const serviceTierMatches = expectedServiceTier === null
    ? value.serviceTier === null || value.serviceTier === "default"
    : value.serviceTier === expectedServiceTier;
  const rootsMatch = value.runtimeWorkspaceRoots.length === runtimeWorkspaceRoots.length
    && value.runtimeWorkspaceRoots.every((root, index) => root === runtimeWorkspaceRoots[index]);
  const sandboxRootsMatch = value.sandbox.type === "workspaceWrite"
    && (value.sandbox.writableRoots.length === 0
      || (value.sandbox.writableRoots.length === runtimeWorkspaceRoots.length
        && value.sandbox.writableRoots.every((root, index) => root === runtimeWorkspaceRoots[index])));
  if (
    value.cwd !== cwd
    || value.thread.cwd !== cwd
    || value.thread.ephemeral
    || value.thread.historyMode !== "paginated"
    || value.model !== input.preset.model
    || value.reasoningEffort !== input.preset.effort
    || !serviceTierMatches
    || value.approvalPolicy !== "on-request"
    || value.approvalsReviewer !== input.policy.review
    || value.activePermissionProfile?.id !== input.policy.permissionProfile
    || !rootsMatch
    || !sandboxRootsMatch
  ) {
    throw new CodexError(
      "PROTOCOL_ERROR",
      "Codex did not apply the requested model, permissions, or workspace policy to the thread",
    );
  }
  return value;
}

function sameAuthority(left: CodexAuthority, right: CodexAuthority): boolean {
  return (
    left.profileId === right.profileId &&
    left.processGeneration === right.processGeneration
  );
}

function sameProviderInteractionAuthority(
  left: ProviderInteractionAuthority,
  right: ProviderInteractionAuthority,
): boolean {
  return left.profileId === right.profileId
    && left.processGeneration === right.processGeneration
    && left.connectionId === right.connectionId
    && providerRequestIdKey(left.requestId) === providerRequestIdKey(right.requestId)
    && left.method === right.method
    && left.requestDigest === right.requestDigest
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.itemId === right.itemId
    && left.approvalId === right.approvalId;
}

function boundedShutdownDuration(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) {
    throw new CodexError("INVALID_INPUT", `${label} must be between 1 and 30000 milliseconds`);
  }
  return value;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => true as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolvesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(
        () => true as const,
        () => false as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
