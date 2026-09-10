import { constants } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  OOMPA_HOST_TOOL_MANIFEST_VERSION,
  parseOompaHostToolRequest,
  type OompaHostToolRequest,
} from "../domain/host-tools.ts";
import { ClaudeError } from "./errors.ts";
import {
  ClaudeHostToolMcpServer,
  CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT,
  digestClaudeHostToolInvocation,
  type ClaudeHostToolInvocation,
  type ClaudeHostToolInvocationOutcome,
  type ClaudeHostToolInvocationReceipt,
  type ClaudeHostToolMcpHandler,
} from "./host-tool-protocol.ts";
import { ClaudeJsonLineDecoder } from "./jsonl.ts";

export const CLAUDE_HOST_TOOL_BINDING_VERSION = 1 as const;
export const CLAUDE_HOST_TOOL_CALLBACK_VERSION = 1 as const;
export const CLAUDE_HOST_TOOL_MCP_SERVER_NAME = "hra" as const;

export const CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT = fileURLToPath(
  new URL("./host-tool-bridge-main.ts", import.meta.url),
);

const BINDING_BYTES = 8 * 1_024;
// JSON strings can expand to six wire bytes per accepted input byte (for
// example a control scalar becomes `\\u00xx`), plus the callback envelope.
const CALLBACK_REQUEST_BYTES = (6 * 512 * 1_024) + 8 * 1_024;
const CALLBACK_RESPONSE_BYTES = (6 * 64 * 1_024) + 8 * 1_024;
const PUBLIC_RESULT_BYTES = 64 * 1_024;
const CALLBACK_TIMEOUT_MS = 40_000;
const CALL_LEDGER_LIMIT = 256;

type UnknownRecord = Record<string, unknown>;

export type ClaudeHostToolBindingIdentity = Readonly<{
  provider: "claude";
  providerThreadId: string;
  profileId: string;
  processGeneration: number;
}>;

export type ClaudeHostToolBindingLease = Readonly<{
  bindingId: string;
  bindingPath: string;
  directory: string;
  mcpConfigPath: string;
}>;

export type ClaudeHostToolCall = ClaudeHostToolBindingIdentity & ClaudeHostToolInvocation & Readonly<{
  bindingId: string;
}>;

export type ClaudeHostToolResponseWritten = ClaudeHostToolCall;

export type ClaudeHostToolPublicResult = string | Readonly<Record<string, unknown>>;

export interface ClaudeHostToolCallbackHandler {
  call(call: ClaudeHostToolCall): Promise<ClaudeHostToolPublicResult>;
  responseWritten(receipt: ClaudeHostToolResponseWritten): Promise<void>;
}

export type ClaudeHostToolBindingMaterial = Readonly<{
  bindingId: string;
  callbackSocketPath: string;
  capability: string;
  version: typeof CLAUDE_HOST_TOOL_BINDING_VERSION;
}>;

type BindingMaterial = ClaudeHostToolBindingMaterial;

type CallbackCall = Readonly<{
  bindingId: string;
  callId: string;
  capability: string;
  input: unknown;
  kind: "call";
  requestDigest: string;
  tool: string;
  version: typeof CLAUDE_HOST_TOOL_CALLBACK_VERSION;
}>;

type CallbackResponseWritten = Readonly<{
  bindingId: string;
  callId: string;
  capability: string;
  kind: "response_written";
  requestDigest: string;
  version: typeof CLAUDE_HOST_TOOL_CALLBACK_VERSION;
}>;

export type ClaudeHostToolCallbackRequest = CallbackCall | CallbackResponseWritten;

export type ClaudeHostToolCallbackResponse =
  | Readonly<{
      callId: string;
      kind: "call_result";
      ok: boolean;
      requestDigest: string;
      text: string;
      version: typeof CLAUDE_HOST_TOOL_CALLBACK_VERSION;
    }>
  | Readonly<{
      callId: string;
      kind: "response_written_result";
      ok: boolean;
      requestDigest: string;
      version: typeof CLAUDE_HOST_TOOL_CALLBACK_VERSION;
    }>;

type BindingCallRecord = {
  request: OompaHostToolRequest | null;
  requestDigest: string;
  responseWritten: boolean;
  responseWrittenTask: Promise<void> | null;
  resultTask: Promise<Extract<ClaudeHostToolCallbackResponse, { kind: "call_result" }>> | null;
};

type BindingRecord = {
  readonly capabilityDigest: Buffer;
  readonly directory: string;
  identity: ClaudeHostToolBindingIdentity;
  readonly calls: Map<string, BindingCallRecord>;
  readonly completedCalls: Map<string, string>;
  readonly bindingPath: string;
  readonly mcpConfigPath: string;
  active: boolean;
};

type BindingRevocation = {
  readonly directory: string;
  task: Promise<void> | undefined;
};

const record = (value: unknown, label: string): UnknownRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ClaudeError("PROTOCOL_ERROR", `${label} must be an object`);
  }
  return value as UnknownRecord;
};

const exactKeys = (
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
): void => {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) throw new ClaudeError("PROTOCOL_ERROR", `${label} does not match the closed contract`);
};

const boundedString = (
  value: unknown,
  label: string,
  maximum = 512,
): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > maximum
    || /\p{Cc}|\p{Cs}/u.test(value)
  ) throw new ClaudeError("PROTOCOL_ERROR", `${label} must be a bounded string`);
  return value;
};

const boundedPublicText = (value: unknown, label: string, maximum: number): string => {
  if (
    typeof value !== "string"
    || new TextEncoder().encode(value).byteLength > maximum
    || value.includes("\0")
    || /\p{Cs}/u.test(value)
  ) throw new ClaudeError("PROTOCOL_ERROR", `${label} must be bounded text`);
  return value;
};

const exactDigest = (value: unknown, label: string): string => {
  const digest = boundedString(value, label, 64);
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new ClaudeError("PROTOCOL_ERROR", `${label} must be a SHA-256 digest`);
  }
  return digest;
};

const bindingId = (value: unknown): string => {
  const id = boundedString(value, "Claude host-tool binding id", 64);
  if (!/^clhb_[0-9a-f]{32}$/u.test(id)) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude host-tool binding id is invalid");
  }
  return id;
};

const capability = (value: unknown): string => {
  const token = boundedString(value, "Claude host-tool capability", 64);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude host-tool capability is invalid");
  }
  return token;
};

const absolutePath = (value: unknown, label: string): string => {
  const path = boundedString(value, label, 4_096);
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ClaudeError("INVALID_INPUT", `${label} must be absolute`);
  }
  return path;
};

const assertPrivateStat = (
  stat: Readonly<{ mode: number; uid: number; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?(): boolean }>,
  expected: "directory" | "file",
): void => {
  if (
    (expected === "directory" ? !stat.isDirectory() : !stat.isFile())
    || stat.isSymbolicLink?.() === true
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", "Claude host-tool material is not private");
  }
};

const writePrivateFile = async (path: string, text: string): Promise<void> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.chmod(0o600);
    assertPrivateStat(await handle.stat(), "file");
  } finally {
    await handle?.close();
  }
};

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("JSON contains an unsupported scalar");
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
};

const publicResultText = (value: ClaudeHostToolPublicResult): string => {
  const text = typeof value === "string" ? value : canonicalJson(value);
  if (
    new TextEncoder().encode(text).byteLength > PUBLIC_RESULT_BYTES
    || text.includes("\0")
    || /\p{Cs}/u.test(text)
  ) {
    throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool result exceeded its byte limit");
  }
  return text;
};

const capabilityDigest = (value: string): Buffer => createHash("sha256")
  .update("hra:claude-host-tool-capability:v1\0", "utf8")
  .update(value, "utf8")
  .digest();

const validateIdentity = (value: ClaudeHostToolBindingIdentity): ClaudeHostToolBindingIdentity => {
  const provider: unknown = value.provider;
  if (provider !== "claude") {
    throw new ClaudeError("INVALID_INPUT", "Claude host-tool binding provider must be claude");
  }
  const providerThreadId = boundedString(value.providerThreadId, "Claude provider thread id");
  const profileId = boundedString(value.profileId, "Claude profile id");
  if (!Number.isSafeInteger(value.processGeneration) || value.processGeneration < 0) {
    throw new ClaudeError("INVALID_INPUT", "Claude process generation must be nonnegative");
  }
  return {
    processGeneration: value.processGeneration,
    profileId,
    provider: "claude",
    providerThreadId,
  };
};

const sameIdentity = (
  actual: ClaudeHostToolBindingIdentity,
  expected: ClaudeHostToolBindingIdentity,
): boolean => actual.providerThreadId === expected.providerThreadId
  && actual.profileId === expected.profileId
  && actual.processGeneration === expected.processGeneration;

const validatePrivateRoot = async (root: string): Promise<string> => {
  const absolute = absolutePath(root, "Claude host-tool binding root");
  const stat = await lstat(absolute).catch(() => null);
  if (stat === null) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", "Claude host-tool binding root is unavailable");
  }
  assertPrivateStat(stat, "directory");
  const canonical = await realpath(absolute);
  if (canonical !== resolve(absolute)) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", "Claude host-tool binding root is not canonical");
  }
  return canonical;
};

const validatePrivateDescendantPath = async (
  root: string,
  pathValue: string,
  label: string,
): Promise<string> => {
  const absolute = absolutePath(pathValue, label);
  if (resolve(absolute) !== absolute) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", `${label} is not canonical`);
  }
  const descendant = relative(root, absolute);
  if (descendant.length === 0 || descendant === ".." || descendant.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(descendant)) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", `${label} must be beneath the private root`);
  }
  const parent = dirname(absolute);
  const parentStat = await lstat(parent).catch(() => null);
  if (parentStat === null) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", `${label} parent is unavailable`);
  }
  assertPrivateStat(parentStat, "directory");
  if (await realpath(parent) !== resolve(parent)) {
    throw new ClaudeError("CONFIG_DIR_MISMATCH", `${label} parent is not canonical`);
  }
  return absolute;
};

/**
 * Owns short-lived, per-session callback capabilities and their private files.
 * It establishes application attribution inside the current user account; a
 * hostile process running as that same OS user remains inside the trust base.
 */
export class ClaudeHostToolBindingAuthority {
  readonly #bridgeCommand: string;
  readonly #bridgeArguments: readonly string[];
  readonly #newBindingId: () => string;
  readonly #newCapability: () => string;
  readonly #removeDirectory: (path: string) => Promise<void>;
  readonly #bindings = new Map<string, BindingRecord>();
  readonly #provisionCustody = new Set<Promise<void>>();
  readonly #provisioningIds = new Set<string>();
  readonly #revocations = new Map<string, BindingRevocation>();
  #closed = false;

  constructor(input: {
    bridgeCommand?: string;
    bridgeArguments?: readonly string[];
    /** Deterministic tests only. */
    newBindingId?: () => string;
    /** Deterministic tests only. */
    newCapability?: () => string;
    /** Fault injection for exact cleanup tests. */
    removeDirectory?: (path: string) => Promise<void>;
  } = {}) {
    this.#bridgeCommand = absolutePath(
      input.bridgeCommand ?? process.execPath,
      "Claude host-tool bridge command",
    );
    this.#bridgeArguments = input.bridgeArguments ?? [CLAUDE_HOST_TOOL_BRIDGE_ENTRYPOINT];
    if (
      this.#bridgeArguments.length > 16
      || this.#bridgeArguments.some((argument) =>
        typeof argument !== "string"
        || new TextEncoder().encode(argument).byteLength > 4_096
        || argument.includes("\0"))
    ) throw new ClaudeError("INVALID_INPUT", "Claude host-tool bridge arguments are invalid");
    this.#newBindingId = input.newBindingId
      ?? (() => `clhb_${randomBytes(16).toString("hex")}`);
    this.#newCapability = input.newCapability
      ?? (() => randomBytes(32).toString("base64url"));
    this.#removeDirectory = input.removeDirectory
      ?? (async (path) => await rm(path, { force: true, maxRetries: 0, recursive: true }));
  }

  async provision(input: {
    privateRoot: string;
    callbackSocketPath: string;
    identity: ClaudeHostToolBindingIdentity;
  }): Promise<ClaudeHostToolBindingLease> {
    this.#assertOpen();
    let releaseCustody!: () => void;
    const custody = new Promise<void>((resolvePromise) => {
      releaseCustody = resolvePromise;
    });
    this.#provisionCustody.add(custody);
    try {
      const root = await validatePrivateRoot(input.privateRoot);
      const callbackSocketPath = await validatePrivateDescendantPath(
        root,
        input.callbackSocketPath,
        "Claude host-tool callback socket path",
      );
      const identity = validateIdentity(input.identity);
      this.#assertOpen();
      const id = bindingId(this.#newBindingId());
      if (
        this.#bindings.has(id)
        || this.#provisioningIds.has(id)
        || this.#revocations.has(id)
      ) {
        throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding id was reused");
      }
      this.#provisioningIds.add(id);
      try {
        const token = capability(this.#newCapability());
        const directory = await mkdtemp(join(root, ".oompa-claude-host-tools-"));
        try {
          await chmod(directory, 0o700);
          assertPrivateStat(await lstat(directory), "directory");
          const bindingPath = join(directory, "binding.json");
          const mcpConfigPath = join(directory, "mcp.json");
          const material: BindingMaterial = {
            bindingId: id,
            callbackSocketPath,
            capability: token,
            version: CLAUDE_HOST_TOOL_BINDING_VERSION,
          };
          await writePrivateFile(bindingPath, `${JSON.stringify(material)}\n`);
          await writePrivateFile(mcpConfigPath, `${JSON.stringify({
            mcpServers: {
              [CLAUDE_HOST_TOOL_MCP_SERVER_NAME]: {
                args: [...this.#bridgeArguments, "--binding", bindingPath],
                command: this.#bridgeCommand,
                type: "stdio",
              },
            },
          })}\n`);
          // `close()` may have run while the two files were being written.
          this.#assertOpen();
          this.#bindings.set(id, {
            active: false,
            bindingPath,
            calls: new Map(),
            completedCalls: new Map(),
            capabilityDigest: capabilityDigest(token),
            directory,
            identity,
            mcpConfigPath,
          });
          return { bindingId: id, bindingPath, directory, mcpConfigPath };
        } catch (error: unknown) {
          try {
            await this.#removeDirectory(directory);
          } catch (cleanupError: unknown) {
            this.#revocations.set(id, { directory, task: undefined });
            throw new AggregateError(
              [error, cleanupError],
              "Claude host-tool provisioning failed and its private-directory cleanup was incomplete.",
              { cause: error },
            );
          }
          throw error;
        }
      } finally {
        this.#provisioningIds.delete(id);
      }
    } finally {
      releaseCustody();
      this.#provisionCustody.delete(custody);
    }
  }

  /** Activates a provisioned binding only after its provider thread commits. */
  async activate(idValue: string): Promise<void> {
    this.#assertOpen();
    const id = bindingId(idValue);
    const binding = this.#bindings.get(id);
    if (binding === undefined) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding is unavailable");
    }
    if (binding.active) return;
    try {
      assertPrivateStat(await lstat(binding.directory), "directory");
      assertPrivateStat(await lstat(binding.bindingPath), "file");
      assertPrivateStat(await lstat(binding.mcpConfigPath), "file");
      if (await realpath(binding.directory) !== resolve(binding.directory)) {
        throw new ClaudeError("CONFIG_DIR_MISMATCH", "Claude host-tool binding directory is not canonical");
      }
    } catch (error: unknown) {
      if (error instanceof ClaudeError) throw error;
      throw new ClaudeError("CONFIG_DIR_MISMATCH", "Claude host-tool material is unavailable", {
        cause: error,
      });
    }
    if (!this.#isCurrent(id, binding)) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding was revoked");
    }
    binding.active = true;
  }

  /**
   * Re-keys one idle live binding after the profile-generation commit. The
   * capability and MCP process stay fixed, while every callback after this
   * synchronous boundary is attributed to the new durable generation.
   */
  rebind(
    idValue: string,
    input: Readonly<{
      expectedIdentity: ClaudeHostToolBindingIdentity;
      nextIdentity: ClaudeHostToolBindingIdentity;
    }>,
  ): void {
    this.#assertOpen();
    const id = bindingId(idValue);
    const expected = validateIdentity(input.expectedIdentity);
    const next = validateIdentity(input.nextIdentity);
    if (
      expected.providerThreadId !== next.providerThreadId
      || expected.profileId !== next.profileId
      || next.processGeneration !== expected.processGeneration + 1
    ) {
      throw new ClaudeError(
        "INVALID_INPUT",
        "Claude host-tool authority rebind must advance one generation for the same session",
      );
    }
    const binding = this.#bindings.get(id);
    if (binding === undefined || !sameIdentity(binding.identity, expected)) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding authority changed");
    }
    // Generation rotation is admitted only while the session is idle. Drop
    // bounded call history anyway so no receipt minted under the old identity
    // can settle after the new identity becomes visible.
    binding.calls.clear();
    binding.completedCalls.clear();
    binding.identity = next;
  }

  async revoke(idValue: string): Promise<void> {
    const id = bindingId(idValue);
    const existing = this.#bindings.get(id);
    if (existing !== undefined) {
      // Invalidate in memory before any asynchronous filesystem cleanup. The
      // revocation record remains until the exact directory removal settles,
      // so a concurrent or later caller joins/retries rather than observing a
      // false successful cleanup.
      existing.active = false;
      this.#bindings.delete(id);
      existing.calls.clear();
      existing.completedCalls.clear();
      this.#revocations.set(id, { directory: existing.directory, task: undefined });
    }
    const revocation = this.#revocations.get(id);
    if (revocation === undefined) return;
    if (revocation.task !== undefined) {
      await revocation.task;
      return;
    }
    const task = this.#removeDirectory(revocation.directory);
    revocation.task = task;
    try {
      await task;
      if (this.#revocations.get(id) === revocation) this.#revocations.delete(id);
    } catch (error: unknown) {
      if (revocation.task === task) revocation.task = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const [id, binding] of this.#bindings) {
        binding.active = false;
        binding.calls.clear();
        binding.completedCalls.clear();
        this.#revocations.set(id, { directory: binding.directory, task: undefined });
      }
      this.#bindings.clear();
    }
    // A provision that started before `closed` was set owns filesystem state
    // until it either commits a binding or transfers failed removal into a
    // retryable revocation tombstone.
    await Promise.all([...this.#provisionCustody]);
    const settlements = await Promise.allSettled(
      [...this.#revocations.keys()].map(async (id) => await this.revoke(id)),
    );
    const failures = settlements.flatMap((settlement) =>
      settlement.status === "rejected" ? [settlement.reason as unknown] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Claude host-tool binding cleanup was incomplete.");
    }
  }

  /** Parses, authenticates, and dispatches one narrow callback-socket frame. */
  async handleCallback(
    value: unknown,
    handler: ClaudeHostToolCallbackHandler,
  ): Promise<ClaudeHostToolCallbackResponse> {
    const request = parseClaudeHostToolCallbackRequest(value);
    const binding = this.#authenticate(request.bindingId, request.capability);
    if (request.kind === "response_written") {
      const call = binding.calls.get(request.callId);
      const completedDigest = binding.completedCalls.get(this.#completedCallKey(request.callId));
      if (call === undefined && completedDigest === request.requestDigest) {
        return {
          callId: request.callId,
          kind: "response_written_result",
          ok: true,
          requestDigest: request.requestDigest,
          version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
        };
      }
      if (call === undefined || call.requestDigest !== request.requestDigest) {
        throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call authority is stale");
      }
      const resultTask = call.resultTask;
      if (resultTask === null) {
        throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call has no completed response");
      }
      const completedResult = await resultTask;
      if (completedResult.ok && !call.responseWritten) {
        const callRequest = call.request;
        if (callRequest === null) {
          throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool response was already released");
        }
        if (call.responseWrittenTask === null) {
          call.responseWrittenTask = handler.responseWritten({
            ...binding.identity,
            bindingId: request.bindingId,
            callId: request.callId,
            request: callRequest,
            requestDigest: request.requestDigest,
          }).then(() => {
            if (!this.#isActive(request.bindingId, binding)) {
              throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding was revoked");
            }
            call.responseWritten = true;
            call.request = null;
          });
        }
        try {
          await call.responseWrittenTask;
        } catch (error: unknown) {
          call.responseWrittenTask = null;
          throw error instanceof Error
            ? error
            : new ClaudeError("PROTOCOL_ERROR", "Claude host-tool response receipt failed");
        }
      }
      if (!this.#isActive(request.bindingId, binding)) {
        throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding was revoked");
      }
      binding.completedCalls.set(this.#completedCallKey(request.callId), request.requestDigest);
      binding.calls.delete(request.callId);
      return {
        callId: request.callId,
        kind: "response_written_result",
        ok: true,
        requestDigest: request.requestDigest,
        version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
      };
    }

    let parsed: OompaHostToolRequest;
    try {
      parsed = parseOompaHostToolRequest(request.tool, request.input);
    } catch {
      throw new ClaudeError("PROTOCOL_ERROR", "Claude host-tool callback input is invalid");
    }
    if (digestClaudeHostToolInvocation(request.callId, parsed) !== request.requestDigest) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool callback digest does not match");
    }
    const existing = binding.calls.get(request.callId);
    if (existing !== undefined && existing.requestDigest !== request.requestDigest) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call id was reused");
    }
    if (existing !== undefined) {
      if (existing.resultTask === null) {
        throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call has no result authority");
      }
      return await existing.resultTask;
    }
    if (binding.completedCalls.has(this.#completedCallKey(request.callId))) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call id was already completed");
    }
    if (
      binding.calls.size + binding.completedCalls.size
      >= CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT
    ) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool call history is exhausted");
    }
    if (binding.calls.size >= CALL_LEDGER_LIMIT) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool call ledger exceeded its limit");
    }
    const callRecord: BindingCallRecord = {
      request: parsed,
      requestDigest: request.requestDigest,
      responseWritten: false,
      responseWrittenTask: null,
      resultTask: null,
    };
    binding.calls.set(request.callId, callRecord);
    const resultTask: NonNullable<BindingCallRecord["resultTask"]> = (async () => {
      try {
        const result = await handler.call({
          ...binding.identity,
          bindingId: request.bindingId,
          callId: request.callId,
          request: parsed,
          requestDigest: request.requestDigest,
        });
        if (!this.#isActive(request.bindingId, binding)) {
          throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding was revoked");
        }
        return {
          callId: request.callId,
          kind: "call_result" as const,
          ok: true,
          requestDigest: request.requestDigest,
          text: publicResultText(result),
          version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
        };
      } catch {
        return {
          callId: request.callId,
          kind: "call_result" as const,
          ok: false,
          requestDigest: request.requestDigest,
          text: "Oompa could not complete this host-tool request.",
          version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
        };
      }
    })();
    callRecord.resultTask = resultTask;
    return await resultTask;
  }

  #authenticate(id: string, token: string): BindingRecord {
    const existing = this.#bindings.get(id);
    const presented = capabilityDigest(token);
    if (
      existing === undefined
      || !existing.active
      || presented.byteLength !== existing.capabilityDigest.byteLength
      || !timingSafeEqual(presented, existing.capabilityDigest)
    ) throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding is unavailable");
    return existing;
  }

  #isActive(id: string, binding: BindingRecord): boolean {
    return binding.active && this.#bindings.get(id) === binding;
  }

  #isCurrent(id: string, binding: BindingRecord): boolean {
    return this.#bindings.get(id) === binding;
  }

  #completedCallKey(callId: string): string {
    return createHash("sha256").update("hra:claude-completed-call:v1\0", "utf8")
      .update(callId, "utf8").digest("hex");
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool authority is closed");
    }
  }
}

export async function readClaudeHostToolBinding(pathValue: string): Promise<BindingMaterial> {
  const path = absolutePath(pathValue, "Claude host-tool binding path");
  let handle: FileHandle | undefined;
  try {
    const parent = dirname(path);
    assertPrivateStat(await lstat(parent), "directory");
    if (await realpath(parent) !== resolve(parent)) {
      throw new ClaudeError("CONFIG_DIR_MISMATCH", "Claude host-tool binding directory is not canonical");
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    assertPrivateStat(stat, "file");
    if (stat.size < 2 || stat.size > BINDING_BYTES) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool binding exceeded its byte limit");
    }
    const value = JSON.parse(await handle.readFile({ encoding: "utf8" })) as unknown;
    const parsed = record(value, "Claude host-tool binding");
    exactKeys(
      parsed,
      new Set(["bindingId", "callbackSocketPath", "capability", "version"]),
      ["bindingId", "callbackSocketPath", "capability", "version"],
      "Claude host-tool binding",
    );
    if (parsed.version !== CLAUDE_HOST_TOOL_BINDING_VERSION) {
      throw new ClaudeError("PROTOCOL_ERROR", "Claude host-tool binding version is unsupported");
    }
    return {
      bindingId: bindingId(parsed.bindingId),
      callbackSocketPath: absolutePath(parsed.callbackSocketPath, "Claude host-tool callback socket path"),
      capability: capability(parsed.capability),
      version: CLAUDE_HOST_TOOL_BINDING_VERSION,
    };
  } catch (error: unknown) {
    if (error instanceof ClaudeError) throw error;
    throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding is unavailable", {
      cause: error,
    });
  } finally {
    await handle?.close();
  }
}

export function parseClaudeHostToolCallbackRequest(value: unknown): ClaudeHostToolCallbackRequest {
  const request = record(value, "Claude host-tool callback request");
  const kind = boundedString(request.kind, "Claude host-tool callback kind", 64);
  const common = {
    bindingId: bindingId(request.bindingId),
    callId: boundedString(request.callId, "Claude host-tool call id"),
    capability: capability(request.capability),
    requestDigest: exactDigest(request.requestDigest, "Claude host-tool request digest"),
    version: request.version,
  };
  if (common.version !== CLAUDE_HOST_TOOL_CALLBACK_VERSION) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude host-tool callback version is unsupported");
  }
  if (kind === "call") {
    exactKeys(
      request,
      new Set(["bindingId", "callId", "capability", "input", "kind", "requestDigest", "tool", "version"]),
      ["bindingId", "callId", "capability", "input", "kind", "requestDigest", "tool", "version"],
      "Claude host-tool callback call",
    );
    return {
      ...common,
      input: request.input,
      kind: "call",
      tool: boundedString(request.tool, "Claude host-tool name", 128),
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    };
  }
  if (kind === "response_written") {
    exactKeys(
      request,
      new Set(["bindingId", "callId", "capability", "kind", "requestDigest", "version"]),
      ["bindingId", "callId", "capability", "kind", "requestDigest", "version"],
      "Claude host-tool callback response receipt",
    );
    return {
      ...common,
      kind: "response_written",
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    };
  }
  throw new ClaudeError("PROTOCOL_ERROR", "Claude host-tool callback kind is unsupported");
}

const parseCallbackResponse = (
  value: unknown,
  expected: ClaudeHostToolInvocationReceipt,
  kind: ClaudeHostToolCallbackResponse["kind"],
): ClaudeHostToolCallbackResponse => {
  const response = record(value, "Claude host-tool callback response");
  const expectedKeys = kind === "call_result"
    ? new Set(["callId", "kind", "ok", "requestDigest", "text", "version"])
    : new Set(["callId", "kind", "ok", "requestDigest", "version"]);
  exactKeys(response, expectedKeys, [...expectedKeys], "Claude host-tool callback response");
  if (
    response.version !== CLAUDE_HOST_TOOL_CALLBACK_VERSION
    || response.kind !== kind
    || boundedString(response.callId, "Claude host-tool response call id") !== expected.callId
    || exactDigest(response.requestDigest, "Claude host-tool response digest") !== expected.requestDigest
    || typeof response.ok !== "boolean"
  ) throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool callback response does not match");
  if (kind === "call_result") {
    return {
      callId: expected.callId,
      kind,
      ok: response.ok,
      requestDigest: expected.requestDigest,
      text: boundedPublicText(response.text, "Claude host-tool response text", PUBLIC_RESULT_BYTES),
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    };
  }
  return {
    callId: expected.callId,
    kind,
    ok: response.ok,
    requestDigest: expected.requestDigest,
    version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
  };
};

const socketRequest = async (
  socketPath: string,
  value: ClaudeHostToolCallbackRequest,
  maximumBytes: number,
  timeoutMs = CALLBACK_TIMEOUT_MS,
): Promise<unknown> => await new Promise<unknown>((resolvePromise, rejectPromise) => {
  const line = `${JSON.stringify(value)}\n`;
  if (new TextEncoder().encode(line).byteLength > CALLBACK_REQUEST_BYTES) {
    rejectPromise(new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool callback request is too large"));
    return;
  }
  const socket = createConnection({ path: socketPath });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const settle = (outcome: Readonly<{ value?: unknown; error?: Error }>): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    if (outcome.error !== undefined) rejectPromise(outcome.error);
    else resolvePromise(outcome.value);
  };
  const timer = setTimeout(() => {
    settle({ error: new ClaudeError("TIMEOUT", "Claude host-tool callback timed out") });
  }, timeoutMs);
  timer.unref();
  socket.on("connect", () => {
    socket.write(line);
  });
  socket.on("data", (chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) {
      settle({ error: new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool callback response is too large") });
      return;
    }
    chunks.push(chunk);
    const complete = Buffer.concat(chunks);
    const newline = complete.indexOf(0x0a);
    if (newline < 0) return;
    if (complete.subarray(newline + 1).some((byte) => byte !== 0x0a && byte !== 0x0d)) {
      settle({ error: new ClaudeError("PROTOCOL_ERROR", "Claude host-tool callback returned extra frames") });
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        complete.subarray(0, newline),
      );
      settle({ value: JSON.parse(text) as unknown });
    } catch (error: unknown) {
      settle({ error: new ClaudeError("PROTOCOL_ERROR", "Claude host-tool callback returned invalid JSON", { cause: error }) });
    }
  });
  socket.on("error", () => {
    settle({ error: new ClaudeError("AUTHORITY_STALE", "Claude host-tool callback is unavailable") });
  });
  socket.on("end", () => {
    if (!settled) settle({ error: new ClaudeError("PROTOCOL_ERROR", "Claude host-tool callback ended without a response") });
  });
});

export type ClaudeHostToolSocketExchange = (
  socketPath: string,
  value: ClaudeHostToolCallbackRequest,
  maximumBytes: number,
) => Promise<unknown>;

export class ClaudeHostToolSocketClient implements ClaudeHostToolMcpHandler {
  readonly #material: BindingMaterial;
  readonly #exchange: ClaudeHostToolSocketExchange;

  constructor(
    material: BindingMaterial,
    /** Deterministic tests only. Production uses one bounded local-socket exchange per frame. */
    exchange: ClaudeHostToolSocketExchange = socketRequest,
  ) {
    this.#material = material;
    this.#exchange = exchange;
  }

  async invoke(call: ClaudeHostToolInvocation): Promise<ClaudeHostToolInvocationOutcome> {
    const raw = await this.#exchange(this.#material.callbackSocketPath, {
      bindingId: this.#material.bindingId,
      callId: call.callId,
      capability: this.#material.capability,
      input: call.request.input,
      kind: "call",
      requestDigest: call.requestDigest,
      tool: call.request.tool,
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    }, CALLBACK_RESPONSE_BYTES);
    const response = parseCallbackResponse(raw, call, "call_result");
    if (response.kind !== "call_result") {
      throw new ClaudeError("PROTOCOL_ERROR", "Claude host-tool callback returned the wrong response");
    }
    return response.ok ? { ok: true, text: response.text } : { ok: false, text: response.text };
  }

  async responseWritten(receipt: ClaudeHostToolInvocationReceipt): Promise<void> {
    const raw = await this.#exchange(this.#material.callbackSocketPath, {
      bindingId: this.#material.bindingId,
      callId: receipt.callId,
      capability: this.#material.capability,
      kind: "response_written",
      requestDigest: receipt.requestDigest,
      version: CLAUDE_HOST_TOOL_CALLBACK_VERSION,
    }, CALLBACK_RESPONSE_BYTES);
    const response = parseCallbackResponse(raw, receipt, "response_written_result");
    if (response.kind !== "response_written_result" || !response.ok) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool response receipt was refused");
    }
  }
}

/** Runs the MCP JSONL loop while keeping stdout exclusively protocol data. */
export async function runClaudeHostToolStdio(input: {
  source: AsyncIterable<Uint8Array>;
  write: (line: string) => void | Promise<void>;
  handler: ClaudeHostToolMcpHandler;
  onSafeDiagnostic?: (message: string) => void;
}): Promise<void> {
  const decoder = new ClaudeJsonLineDecoder({
    maxBufferedBytes: CALLBACK_REQUEST_BYTES + 64 * 1_024,
    maxLineBytes: CALLBACK_REQUEST_BYTES,
  });
  const server = new ClaudeHostToolMcpServer({ handler: input.handler });
  const dispatch = async (value: unknown): Promise<void> => {
    const result = await server.handle(value);
    if (result === null) return;
    await input.write(`${JSON.stringify(result.response)}\n`);
    if (result.afterWrite !== undefined) {
      try {
        await result.afterWrite();
      } catch {
        input.onSafeDiagnostic?.("Claude host-tool response receipt failed");
      }
    }
  };
  try {
    for await (const chunk of input.source) {
      for (const value of decoder.push(chunk)) await dispatch(value);
    }
    for (const value of decoder.finish()) await dispatch(value);
  } finally {
    server.close();
  }
}

/** Shared manifest version appears in the MCP config tests without duplicating it. */
export const CLAUDE_HOST_TOOL_MCP_MANIFEST_VERSION = OOMPA_HOST_TOOL_MANIFEST_VERSION;
