import { createHash, randomUUID } from "node:crypto";

import {
  OOMPA_HOST_TOOL_MANIFEST,
  OOMPA_HOST_TOOL_MANIFEST_VERSION,
  OOMPA_HOST_TOOL_PUBLIC_RESULT_MAX_BYTES,
  parseOompaHostToolRequest,
  type OompaHostToolRequest,
} from "../domain/host-tools.ts";
import { ClaudeError } from "./errors.ts";
import { CLAUDE_PIN, CLAUDE_PIN_MCP_PROTOCOL_VERSION } from "./pin.ts";

export type ClaudeMcpRequestId = string | number;

export type ClaudeMcpResponse = Readonly<{
  jsonrpc: "2.0";
  id: ClaudeMcpRequestId | null;
  result?: Readonly<Record<string, unknown>>;
  error?: Readonly<{ code: number; message: string }>;
}>;

export type ClaudeHostToolInvocation = Readonly<{
  callId: string;
  requestDigest: string;
  request: OompaHostToolRequest;
}>;

export type ClaudeHostToolInvocationReceipt = Readonly<{
  callId: string;
  requestDigest: string;
}>;

export type ClaudeHostToolInvocationOutcome =
  | Readonly<{ ok: true; text: string }>
  | Readonly<{ ok: false; text: string }>;

export interface ClaudeHostToolMcpHandler {
  invoke(call: ClaudeHostToolInvocation): Promise<ClaudeHostToolInvocationOutcome>;
  responseWritten(receipt: ClaudeHostToolInvocationReceipt): Promise<void>;
}

export type ClaudeMcpDispatch = Readonly<{
  response: ClaudeMcpResponse;
  afterWrite?: () => Promise<void>;
}>;

type UnknownRecord = Record<string, unknown>;

const MCP_REQUEST_LEDGER_LIMIT = 256;
export const CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT = 4_096;
const MCP_IDENTIFIER_BYTES = 512;

class McpProtocolFault extends Error {
  constructor(
    readonly code: -32_600 | -32_601 | -32_602,
    message: string,
  ) {
    super(message);
    this.name = "McpProtocolFault";
  }
}

const record = (value: unknown, label: string): UnknownRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new McpProtocolFault(-32_600, `${label} must be an object`);
  }
  return value as UnknownRecord;
};

const exactKeys = (
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  required: readonly string[],
  label: string,
  code: -32_600 | -32_602 = -32_602,
): void => {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key))
    || required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new McpProtocolFault(code, `${label} does not match the closed contract`);
  }
};

const boundedString = (value: unknown, label: string, maximum = MCP_IDENTIFIER_BYTES): string => {
  if (
    typeof value !== "string"
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > maximum
    || /\p{Cc}|\p{Cs}/u.test(value)
  ) {
    throw new McpProtocolFault(-32_602, `${label} must be a bounded string`);
  }
  return value;
};

const requestId = (value: unknown): ClaudeMcpRequestId => {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return boundedString(value, "MCP request id");
};

const requestKey = (value: ClaudeMcpRequestId): string =>
  typeof value === "number" ? `number:${String(value)}` : `string:${value}`;

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

export const digestClaudeHostToolInvocation = (
  callId: string,
  request: OompaHostToolRequest,
): string => createHash("sha256")
  .update("hra:claude-host-tool-call:v1\0", "utf8")
  .update(canonicalJson({ callId, input: request.input, tool: request.tool }), "utf8")
  .digest("hex");

const mcpError = (
  id: ClaudeMcpRequestId | null,
  code: -32_600 | -32_601 | -32_602 | -32_603,
  message: string,
): ClaudeMcpDispatch => ({
  response: { error: { code, message }, id, jsonrpc: "2.0" },
});

const mcpResult = (
  id: ClaudeMcpRequestId,
  result: Readonly<Record<string, unknown>>,
  afterWrite?: () => Promise<void>,
): ClaudeMcpDispatch => ({
  ...(afterWrite === undefined ? {} : { afterWrite }),
  response: { id, jsonrpc: "2.0", result },
});

const validateInitialize = (paramsValue: unknown): void => {
  const params = record(paramsValue, "MCP initialize params");
  exactKeys(
    params,
    new Set(["protocolVersion", "capabilities", "clientInfo"]),
    ["protocolVersion", "capabilities", "clientInfo"],
    "MCP initialize params",
  );
  if (boundedString(params.protocolVersion, "MCP protocol version", 64)
    !== CLAUDE_PIN_MCP_PROTOCOL_VERSION) {
    throw new McpProtocolFault(-32_602, "MCP protocol version does not match the pinned Claude CLI");
  }
  const capabilities = record(params.capabilities, "MCP client capabilities");
  if (new TextEncoder().encode(canonicalJson(capabilities)).byteLength > 64 * 1_024) {
    throw new McpProtocolFault(-32_602, "MCP client capabilities exceed their byte limit");
  }
  const client = record(params.clientInfo, "MCP client info");
  exactKeys(
    client,
    new Set(["name", "title", "version", "description", "websiteUrl"]),
    ["name", "version"],
    "MCP client info",
  );
  if (
    boundedString(client.name, "MCP client name", 128) !== "claude-code"
    || boundedString(client.version, "MCP client version", 64) !== CLAUDE_PIN
  ) {
    throw new McpProtocolFault(-32_602, "MCP client does not match the pinned Claude CLI");
  }
  for (const field of ["title", "description", "websiteUrl"] as const) {
    if (client[field] !== undefined) boundedString(client[field], `MCP client ${field}`, 1_024);
  }
};

const parseHostToolCall = (paramsValue: unknown): OompaHostToolRequest => {
  const params = record(paramsValue, "MCP tools/call params");
  exactKeys(params, new Set(["name", "arguments"]), ["name"], "MCP tools/call params");
  const name = boundedString(params.name, "MCP tool name", 128);
  try {
    return parseOompaHostToolRequest(name, params.arguments ?? {});
  } catch {
    throw new McpProtocolFault(-32_602, "MCP tool arguments do not match an advertised Oompa tool");
  }
};

const parseEmptyParams = (value: unknown, label: string): void => {
  if (value === undefined) return;
  const params = record(value, label);
  exactKeys(params, new Set(), [], label);
};

const normalizeOutcome = (
  outcome: ClaudeHostToolInvocationOutcome,
): ClaudeHostToolInvocationOutcome => {
  if (
    typeof outcome.ok !== "boolean"
    || typeof outcome.text !== "string"
    || new TextEncoder().encode(outcome.text).byteLength > OOMPA_HOST_TOOL_PUBLIC_RESULT_MAX_BYTES
    || outcome.text.includes("\0")
    || /\p{Cs}/u.test(outcome.text)
  ) return { ok: false, text: "Oompa refused an invalid host-tool result." };
  return outcome;
};

const toolResult = (outcome: ClaudeHostToolInvocationOutcome): Readonly<Record<string, unknown>> => {
  return {
    content: [{ type: "text", text: outcome.text }],
    isError: !outcome.ok,
  };
};

type LedgerEntry = Readonly<{
  requestDigest: string;
  dispatchTask: Promise<ClaudeMcpDispatch>;
  lifecycle: { reclaimable: boolean };
}>;

/**
 * The exact, closed MCP server surface admitted for Claude Code 2.1.260.
 * It exposes only the shared eight-tool Oompa manifest. Provider identity is
 * supplied later by the private binding transport, never by model arguments.
 */
export class ClaudeHostToolMcpServer {
  readonly #handler: ClaudeHostToolMcpHandler;
  readonly #newCallId: () => string;
  readonly #ledger = new Map<string, LedgerEntry>();
  /** Compact, session-lifetime fence for entries whose replay bodies were reclaimed. */
  readonly #tombstones = new Map<string, string>();
  #state: "new" | "initializing" | "ready" | "closed" = "new";

  constructor(input: {
    handler: ClaudeHostToolMcpHandler;
    /** Deterministic tests only. Production uses cryptographically random UUIDs. */
    newCallId?: () => string;
  }) {
    this.#handler = input.handler;
    this.#newCallId = input.newCallId ?? randomUUID;
  }

  async handle(value: unknown): Promise<ClaudeMcpDispatch | null> {
    let rawId: ClaudeMcpRequestId | null = null;
    try {
      const message = record(value, "MCP message");
      // JSON-RPC notifications never receive responses, including malformed
      // notifications. Parse them in their own fail-silent branch so an
      // irrelevant cancellation cannot accidentally produce an error frame.
      if (message.id === undefined) {
        try {
          if (message.jsonrpc !== "2.0") return null;
          const method = boundedString(message.method, "MCP method", 128);
          exactKeys(
            message,
            new Set(["jsonrpc", "method", "params"]),
            ["jsonrpc", "method"],
            "MCP message",
            -32_600,
          );
          return this.#notification(method, message.params);
        } catch {
          return null;
        }
      }
      rawId = requestId(message.id);
      if (message.jsonrpc !== "2.0") {
        throw new McpProtocolFault(-32_600, "MCP message must use JSON-RPC 2.0");
      }
      const method = boundedString(message.method, "MCP method", 128);
      exactKeys(
        message,
        new Set(["jsonrpc", "id", "method", "params"]),
        ["jsonrpc", "id", "method"],
        "MCP message",
        -32_600,
      );
      return await this.#request(rawId, method, message.params);
    } catch (error: unknown) {
      if (error instanceof McpProtocolFault) return mcpError(rawId, error.code, error.message);
      return mcpError(rawId, -32_603, "Oompa could not process this MCP request");
    }
  }

  close(): void {
    this.#state = "closed";
    this.#ledger.clear();
    this.#tombstones.clear();
  }

  #notification(method: string, params: unknown): null {
    if (method === "notifications/cancelled") return null;
    if (method !== "notifications/initialized") {
      return null;
    }
    parseEmptyParams(params, "MCP initialized params");
    if (this.#state !== "initializing") {
      throw new McpProtocolFault(-32_600, "MCP initialized notification is out of order");
    }
    this.#state = "ready";
    return null;
  }

  async #request(
    id: ClaudeMcpRequestId,
    method: string,
    params: unknown,
  ): Promise<ClaudeMcpDispatch> {
    const digest = createHash("sha256")
      .update("hra:claude-mcp-session-request:v1\0", "utf8")
      .update(canonicalJson({
        method,
        params: params ?? null,
        paramsPresent: params !== undefined,
      }), "utf8")
      .digest("hex");
    const key = requestKey(id);
    const existing = this.#ledger.get(key);
    if (existing !== undefined) {
      if (existing.requestDigest !== digest) {
        throw new McpProtocolFault(-32_600, "MCP request id was reused for a different request");
      }
      return await existing.dispatchTask;
    }
    const tombstoneKey = createHash("sha256").update(key, "utf8").digest("hex");
    const tombstoneDigest = this.#tombstones.get(tombstoneKey);
    if (tombstoneDigest !== undefined) {
      throw new McpProtocolFault(
        -32_600,
        tombstoneDigest === digest
          ? "MCP request id replay is no longer available"
          : "MCP request id was reused for a different request",
      );
    }
    if (
      this.#ledger.size + this.#tombstones.size
      >= CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT
    ) {
      throw new McpProtocolFault(
        -32_600,
        "MCP session request history is exhausted",
      );
    }
    this.#reclaimLedgerEntry();
    if (this.#ledger.size >= MCP_REQUEST_LEDGER_LIMIT) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude exceeded the active host-tool request ledger");
    }
    const lifecycle = { reclaimable: false };
    const dispatchTask = this.#dispatchRequest(id, method, params, () => {
      lifecycle.reclaimable = true;
    }).catch((error: unknown) => {
      lifecycle.reclaimable = true;
      if (error instanceof McpProtocolFault) return mcpError(id, error.code, error.message);
      return mcpError(id, -32_603, "Oompa could not process this MCP request");
    });
    this.#ledger.set(key, { dispatchTask, lifecycle, requestDigest: digest });
    return await dispatchTask;
  }

  async #dispatchRequest(
    id: ClaudeMcpRequestId,
    method: string,
    params: unknown,
    release: () => void,
  ): Promise<ClaudeMcpDispatch> {
    if (method === "initialize") {
      if (this.#state !== "new") {
        throw new McpProtocolFault(-32_600, "MCP initialize request is out of order");
      }
      validateInitialize(params);
      this.#state = "initializing";
      release();
      return mcpResult(id, {
        capabilities: { tools: { listChanged: false } },
        protocolVersion: CLAUDE_PIN_MCP_PROTOCOL_VERSION,
        serverInfo: {
          name: "oompa",
          title: "Oompa session host tools",
          version: String(OOMPA_HOST_TOOL_MANIFEST_VERSION),
        },
      });
    }
    if (this.#state !== "ready") {
      throw new McpProtocolFault(-32_600, "MCP server is not initialized");
    }
    if (method === "ping") {
      parseEmptyParams(params, "MCP ping params");
      release();
      return mcpResult(id, {});
    }
    if (method === "tools/list") {
      parseEmptyParams(params, "MCP tools/list params");
      release();
      return mcpResult(id, {
        tools: OOMPA_HOST_TOOL_MANIFEST.tools.map((tool) => ({
          description: tool.description,
          inputSchema: tool.inputSchema,
          name: tool.name,
        })),
      });
    }
    if (method !== "tools/call") {
      throw new McpProtocolFault(-32_601, "MCP method is not supported");
    }
    return await this.#call(id, params, release);
  }

  async #call(
    id: ClaudeMcpRequestId,
    params: unknown,
    release: () => void,
  ): Promise<ClaudeMcpDispatch> {
    const request = parseHostToolCall(params);
    const callId = boundedString(this.#newCallId(), "Oompa host-tool call id");
    const call: ClaudeHostToolInvocation = {
      callId,
      request,
      requestDigest: digestClaudeHostToolInvocation(callId, request),
    };
    let outcome: ClaudeHostToolInvocationOutcome;
    try {
      outcome = normalizeOutcome(await this.#handler.invoke(call));
    } catch {
      outcome = { ok: false, text: "Oompa could not complete this host-tool request." };
    }
    let notified = false;
    const receipt: ClaudeHostToolInvocationReceipt = {
      callId: call.callId,
      requestDigest: call.requestDigest,
    };
    return mcpResult(id, toolResult(outcome), async () => {
      if (notified) return;
      await this.#handler.responseWritten(receipt);
      notified = true;
      release();
    });
  }

  #reclaimLedgerEntry(): void {
    if (this.#ledger.size < MCP_REQUEST_LEDGER_LIMIT) return;
    for (const [key, entry] of this.#ledger) {
      if (!entry.lifecycle.reclaimable) continue;
      this.#ledger.delete(key);
      this.#tombstones.set(
        createHash("sha256").update(key, "utf8").digest("hex"),
        entry.requestDigest,
      );
      return;
    }
  }
}
