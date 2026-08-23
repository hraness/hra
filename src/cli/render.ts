import type { LocalCommand } from "../domain/contracts";
import {
  publicInteractionSchema,
  type PublicInteraction,
} from "../domain/interactions";
import {
  sessionEventPageSchema,
  type SessionEvent,
  type SessionEventPage,
} from "../domain/session-events";

export type Output = {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
  writeStdoutAsync?(value: string, signal: AbortSignal): Promise<void>;
};

const unsafeTerminalScalar = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export const terminalSafe = (value: string, preserveLineFeeds = false): string => {
  let output = "";
  for (const scalar of value) {
    if (scalar === "\n" && preserveLineFeeds) {
      output += scalar;
    } else if (unsafeTerminalScalar.test(scalar)) {
      output += `\\u{${scalar.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}}`;
    } else {
      output += scalar;
    }
  }
  return output;
};

const jsonEscapeScalar = (scalar: string): string => {
  const codePoint = scalar.codePointAt(0);
  if (codePoint === undefined) return "\\ufffd";
  if (codePoint <= 0xFFFF) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  const adjusted = codePoint - 0x10000;
  const high = 0xD800 + (adjusted >> 10);
  const low = 0xDC00 + (adjusted & 0x3FF);
  return `\\u${high.toString(16)}\\u${low.toString(16)}`;
};

export const safeJson = (value: unknown, space?: number): string => {
  const candidate: unknown = JSON.stringify(value, null, space);
  const serialized = typeof candidate === "string" ? candidate : "null";
  let output = "";
  for (const scalar of serialized) {
    output += scalar === "\n"
      ? scalar
      : unsafeTerminalScalar.test(scalar)
        ? jsonEscapeScalar(scalar)
        : scalar;
  }
  return output;
};

const diagnosticMaximumBytes = 2_048;
const diagnosticMaximumDepth = 4;
const diagnosticMaximumEntries = 64;
const privateKeyDiagnostic = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu;
const bearerDiagnostic = /\bBearer\s+[^\s,;]+/giu;
const assignedSecretDiagnostic = /\b(token|secret|password|invite|otp|authorization|cookie|api[-_ ]?key)(\s*[:=]\s*)[^\s,;]+/giu;
const jwtDiagnostic = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const unixAbsolutePathDiagnostic = /(^|[\s(=[{])\/(?:[^/\s)'"`]+\/)+[^/\s)'"`]*/gu;
const windowsAbsolutePathDiagnostic = /\b[A-Za-z]:\\(?:[^\\\s)'"`]+\\)*[^\\\s)'"`]*/gu;

const boundedDiagnostic = (value: string): string => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= diagnosticMaximumBytes) return value;
  return `${new TextDecoder().decode(encoded.subarray(0, diagnosticMaximumBytes))}[truncated]`;
};

export const safeDiagnostic = (value: string): string => {
  if (privateKeyDiagnostic.test(value)) return "[redacted private key diagnostic]";
  const bounded = boundedDiagnostic(value)
    .replace(bearerDiagnostic, "Bearer [redacted]")
    .replace(assignedSecretDiagnostic, (_match, label: string, separator: string) =>
      `${label}${separator}[redacted]`)
    .replace(jwtDiagnostic, "[redacted-token]")
    .replace(unixAbsolutePathDiagnostic, (_match, prefix: string) => `${prefix}[local-path]`)
    .replace(windowsAbsolutePathDiagnostic, "[local-path]");
  return terminalSafe(bounded);
};

const safeDiagnosticDetails = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeDiagnostic(value);
  if (depth >= diagnosticMaximumDepth) return "[detail omitted]";
  if (Array.isArray(value)) {
    return value.slice(0, diagnosticMaximumEntries).map((entry) => safeDiagnosticDetails(entry, depth + 1));
  }
  if (typeof value !== "object") return "[detail omitted]";
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, diagnosticMaximumEntries)
      .map(([key, entry]) => [safeDiagnostic(key), safeDiagnosticDetails(entry, depth + 1)]),
  );
};

const line = (value: unknown): string => {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return terminalSafe(String(value));
  if (typeof value === "object") return safeJson(value);
  if (typeof value === "symbol") return terminalSafe(value.description ?? "symbol");
  return "unsupported";
};

const table = (rows: readonly Record<string, unknown>[], columns: readonly string[]): string => {
  if (rows.length === 0) return "No results.";
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => line(row[column]).length)));
  const format = (row: Record<string, unknown>) => columns.map((column, index) => line(row[column]).padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [format(Object.fromEntries(columns.map((column) => [column, column.toUpperCase()]))), ...rows.map(format)].join("\n");
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const duration = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${String(Math.round(value))}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${String(minutes)}m ${String(seconds)}s`;
};

const indented = (value: string): string =>
  terminalSafe(value, true).split("\n").map((part) => `  ${part}`).join("\n");

const renderMessage = (value: unknown): string | null => {
  const message = object(value);
  if (message === null) return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (typeof message.text !== "string") return null;
  const omission = object(message.omission);
  const omitted = omission === null || typeof omission.omittedUtf8Bytes !== "number"
    ? ""
    : `\n  … [${String(omission.omittedUtf8Bytes)} UTF-8 bytes omitted]`;
  const turn = typeof message.turnId === "string" ? `  ${line(message.turnId)}` : "";
  return `${message.role === "user" ? "You" : "Codex"}${turn}\n${indented(message.text)}${omitted}`;
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const renderTurnSummary = (value: unknown): string | null => {
  const turn = object(value);
  if (turn === null || typeof turn.id !== "string" || typeof turn.status !== "string") return null;
  const files = stringArray(turn.files);
  const actions = stringArray(turn.actions);
  const rows = [`${line(turn.id)}  ${line(turn.status)}  ${duration(turn.runtimeMs)}`];
  if (files.length > 0) rows.push(`  files: ${files.map(line).join(", ")}`);
  if (actions.length > 0) rows.push(`  actions: ${actions.map(line).join(", ")}`);
  if (typeof turn.omittedFiles === "number" && turn.omittedFiles > 0) {
    rows.push(`  files omitted: ${String(turn.omittedFiles)}`);
  }
  if (typeof turn.omittedActions === "number" && turn.omittedActions > 0) {
    rows.push(`  actions omitted: ${String(turn.omittedActions)}`);
  }
  return rows.join("\n");
};

const renderEffectiveRuntimeProfile = (value: unknown): readonly string[] => {
  const profile = object(value);
  if (profile === null) return [];
  const apps = Array.isArray(profile.enabledApps)
    ? profile.enabledApps.map(object).filter((app): app is Record<string, unknown> => app !== null)
    : [];
  const appNames = apps.map((app) => {
    const name = typeof app.name === "string" ? line(app.name) : line(app.id);
    const plugins = stringArray(app.pluginDisplayNames);
    return plugins.length === 0 ? name : `${name} (${plugins.map(line).join(", ")})`;
  });
  return [
    "Runtime",
    `  account: ${line(profile.profileId)} generation ${line(profile.processGeneration)}`,
    `  preset: ${line(profile.preset)}`,
    `  model: ${line(profile.model)}`,
    `  reasoning effort: ${line(profile.reasoningEffort)}`,
    `  service tier: ${profile.serviceTier === null ? "default" : line(profile.serviceTier)}`,
    `  Fast: ${profile.fast === true ? "enabled" : "disabled"}`,
    `  review: ${line(profile.reviewMode)}`,
    `  permission profile: ${line(profile.permissionProfile)}`,
    `  computer use: ${profile.computerUse === true ? "enabled" : "unavailable"}`,
    `  plugin capability: ${profile.pluginCapability === true ? "enabled" : "unavailable"}`,
    `  enabled apps: ${appNames.length === 0 ? "none" : appNames.join(", ")}`,
    `  observed at: ${line(profile.observedAt)}`,
  ];
};

const renderSession = (data: unknown): string => {
  const root = object(data);
  const session = object(root?.session);
  const projection = object(root?.projection);
  const selected = projection ?? session;
  if (selected === null) return safeJson(data, 2);

  const title = typeof selected.title === "string" ? line(selected.title) : "Session";
  const status = typeof selected.status === "string"
    ? line(selected.status)
    : typeof selected.state === "string"
      ? line(selected.state)
      : "unknown";
  const rows = [title, `State: ${status}`];
  if (typeof selected.projectRoot === "string") rows.push(`Project: ${line(selected.projectRoot)}`);
  const runtimeRows = renderEffectiveRuntimeProfile(root?.effectiveRuntimeProfile);
  if (runtimeRows.length > 0) rows.push("", ...runtimeRows);

  const omission = object(selected.omission);
  if (omission?.hasMoreOlderTurns === true) {
    const returned = typeof omission.returnedTurns === "number"
      ? `showing ${String(omission.returnedTurns)} recent turns; `
      : "";
    rows.push(`History: ${returned}older turns omitted`);
  }
  if (typeof omission?.omittedMessages === "number" && omission.omittedMessages > 0) {
    rows.push(`History: ${String(omission.omittedMessages)} messages omitted`);
  }

  const messages = Array.isArray(selected.messages)
    ? selected.messages.map(renderMessage).filter((message): message is string => message !== null)
    : [];
  rows.push("", "Messages", messages.length === 0 ? "No messages in the recent window." : messages.join("\n\n"));

  const summaries = Array.isArray(selected.turnSummaries)
    ? selected.turnSummaries.map(renderTurnSummary).filter((turn): turn is string => turn !== null)
    : [];
  rows.push("", "Turns", summaries.length === 0 ? "No turns in the recent window." : summaries.join("\n\n"));
  return rows.join("\n");
};

export type CoalescedSessionEvent =
  | Readonly<{
    event: SessionEvent;
    itemId: string;
    kind: "assistant" | "reasoning";
    text: string;
    turnId: string;
  }>
  | Readonly<{ event: SessionEvent; kind: "event" }>;

export const coalesceSessionEvents = (events: readonly SessionEvent[]): readonly CoalescedSessionEvent[] => {
  const coalesced: CoalescedSessionEvent[] = [];
  for (const event of events) {
    const body = event.body;
    if (body.type === "assistant_delta" || body.type === "reasoning_summary_delta") {
      const kind = body.type === "assistant_delta" ? "assistant" : "reasoning";
      const previous = coalesced.at(-1);
      if (
        previous?.kind === kind
        && previous.itemId === body.itemId
        && previous.turnId === body.turnId
      ) {
        coalesced[coalesced.length - 1] = { ...previous, event, text: previous.text + body.text };
      } else {
        coalesced.push({ event, itemId: body.itemId, kind, text: body.text, turnId: body.turnId });
      }
      continue;
    }
    const previous = coalesced.at(-1);
    if (
      previous?.kind === "event"
      && previous.event.body.type === "tool_progress"
      && body.type === "tool_progress"
      && previous.event.body.itemId === body.itemId
      && previous.event.body.turnId === body.turnId
    ) {
      coalesced[coalesced.length - 1] = { event, kind: "event" };
      continue;
    }
    if (
      previous?.kind === "event"
      && previous.event.body.type === "token_usage"
      && body.type === "token_usage"
    ) {
      coalesced[coalesced.length - 1] = { event, kind: "event" };
      continue;
    }
    coalesced.push({ event, kind: "event" });
  }
  return coalesced;
};

const eventBytes = (value: number | undefined): string =>
  value === undefined ? "" : `, ${String(value)} bytes observed`;

const renderSingleEvent = (event: SessionEvent): string => {
  const body = event.body;
  switch (body.type) {
    case "connection": return `Connection: ${line(body.state)}${body.reason === undefined ? "" : ` (${line(body.reason)})`}`;
    case "gap": return `Gap: ${line(body.reason)} from ${String(body.fromSequence)} through ${String(body.throughSequence)}`;
    case "session_status": return `Session: ${line(body.status)}${body.activeTurnId === null ? "" : `, active turn ${line(body.activeTurnId)}`}`;
    case "turn_started": return `Turn started: ${line(body.turnId)}`;
    case "turn_completed": return `Turn ${line(body.turnId)}: ${line(body.status)}${body.errorCode === undefined ? "" : ` (${line(body.errorCode)})`}`;
    case "item_started": return `Item started: ${line(body.itemKind)} ${line(body.itemId)}`;
    case "item_completed": return `Item completed: ${line(body.itemKind)} ${line(body.itemId)}${body.status === undefined ? "" : ` (${line(body.status)})`}`;
    case "assistant_delta": return `Codex\n${indented(body.text)}`;
    case "reasoning_summary_delta": return `Reasoning summary\n${indented(body.text)}`;
    case "tool_progress": {
      const target = body.server === undefined && body.tool === undefined
        ? ""
        : ` ${line(body.server ?? "local")}/${line(body.tool ?? body.toolKind)}`;
      return `Tool: ${line(body.toolKind)}${target}${body.status === undefined ? "" : `, ${line(body.status)}`}${eventBytes(body.outputBytesObserved)}`;
    }
    case "file_change": {
      const paths = body.paths.map((path) => `${line(path.kind)} ${line(path.path)}`);
      if (body.omittedPaths > 0) paths.push(`${String(body.omittedPaths)} paths omitted`);
      return [`Files: ${line(body.status)}`, ...paths.map((path) => `  ${path}`)].join("\n");
    }
    case "plan_updated": return [
      "Plan updated",
      ...body.steps.map((step) => `  ${line(step.status)}  ${line(step.text)}`),
      ...(body.explanation === undefined ? [] : [`  ${line(body.explanation)}`]),
    ].join("\n");
    case "diff_updated": return `Diff: ${String(body.changedFiles)} files, ${String(body.patchBytesObserved)} bytes observed`;
    case "token_usage": return `Tokens: ${body.totalTokens === null ? "unknown" : String(body.totalTokens)} total${body.modelContextWindow === null ? "" : ` of ${String(body.modelContextWindow)}`}`;
    case "interaction_requested": return [
      `Interaction required: ${line(body.interactionKind)} ${line(body.interactionId)}`,
      `  revision ${String(body.revision)}${body.blocking ? ", blocking" : ""}`,
      `  ${line(body.summary)}`,
    ].join("\n");
    case "interaction_state": return `Interaction ${line(body.interactionId)}: ${line(body.state)}, revision ${String(body.revision)}`;
    case "warning": return `Warning ${line(body.code)}: ${line(body.message)}`;
    case "error": return `Error ${line(body.code)}${body.terminal ? " (terminal)" : ""}: ${line(body.message)}`;
    case "protocol_incompatible": return `Protocol notice: unsupported ${line(body.method)} (${line(body.payloadDigest)})`;
  }
};

export const renderSessionEventPageHuman = (page: SessionEventPage): string => {
  const rows: string[] = [];
  if (page.gap !== null) {
    rows.push(
      `Event gap: ${line(page.gap.reason)}. Retained events begin at sequence ${String(page.gap.retainedFromSequence)}.`,
    );
  }
  for (const entry of coalesceSessionEvents(page.events)) {
    if (entry.kind === "assistant" || entry.kind === "reasoning") {
      rows.push(`${entry.kind === "assistant" ? "Codex" : "Reasoning summary"}\n${indented(entry.text)}`);
    } else {
      rows.push(renderSingleEvent(entry.event));
    }
  }
  return rows.length === 0 ? "No new events." : rows.join("\n\n");
};

const sessionEventPage = (data: unknown): SessionEventPage | null => {
  const direct = sessionEventPageSchema.safeParse(data);
  if (direct.success) return direct.data;
  const root = object(data);
  const nested = sessionEventPageSchema.safeParse(root?.page);
  return nested.success ? nested.data : null;
};

const interactionRecords = (data: unknown): readonly PublicInteraction[] => {
  const root = object(data);
  const source = Array.isArray(data)
    ? data
    : Array.isArray(root?.interactions)
      ? root.interactions
      : [];
  return source.flatMap((value) => {
    const parsed = publicInteractionSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
};

const interactionRecord = (data: unknown): PublicInteraction | null => {
  const direct = publicInteractionSchema.safeParse(data);
  if (direct.success) return direct.data;
  const root = object(data);
  const nested = publicInteractionSchema.safeParse(root?.interaction);
  if (nested.success) return nested.data;
  const recorded = publicInteractionSchema.safeParse(root?.record);
  return recorded.success ? recorded.data : null;
};

const publicInteractionData = (command: LocalCommand, data: unknown): unknown => {
  if (command.kind === "interaction.show") {
    const record = interactionRecord(data);
    return { interaction: record };
  }
  if (command.kind === "interaction.resolve") {
    const root = object(data);
    return {
      interaction: interactionRecord(data),
      responseWritten: root?.responseWritten === true,
    };
  }
  if (command.kind === "interaction.list" || command.kind === "session.interactions") {
    return { interactions: interactionRecords(data) };
  }
  if (command.kind === "session.status") {
    const root = object(data);
    if (root === null) return data;
    return {
      ...root,
      pendingInteractions: interactionRecords(root.pendingInteractions),
    };
  }
  if (command.kind === "session.events") return sessionEventPage(data);
  return data;
};

const renderInteractionList = (data: unknown): string => {
  const records = interactionRecords(data);
  return table(records.map((record) => ({
    state: record.state,
    kind: record.kind,
    summary: record.display.summary,
    deadline: instant(record.deadlineAt),
    revision: record.revision,
    id: record.id,
  })), ["state", "kind", "summary", "deadline", "revision", "id"]);
};

const renderInteraction = (record: PublicInteraction): string => {
  const rows = [
    `Interaction ${line(record.id)}`,
    `State: ${line(record.state)}`,
    `Type: ${line(record.kind)}`,
    `Revision: ${String(record.revision)}`,
    `Blocking: ${record.blocking ? "yes" : "no"}`,
    `Session: ${line(record.sessionId)}`,
    `Summary: ${line(record.display.summary)}`,
  ];
  if (record.state === "pending") {
    const remainingMs = record.deadlineAt - Date.now();
    rows.push(
      `Deadline: ${instant(record.deadlineAt)}`,
      remainingMs <= 0
        ? "Remaining: deadline reached; waiting for deterministic expiry"
        : `Remaining: ${duration(remainingMs)}`,
    );
  }
  const display = record.display;
  switch (display.kind) {
    case "command_approval":
      rows.push(`Command class: ${line(display.commandClass)}`);
      if (display.reason !== null) rows.push(`Reason: ${line(display.reason)}`);
      if (display.workingDirectory !== null) rows.push(`Directory: ${line(display.workingDirectory)}`);
      break;
    case "file_change_approval":
      if (display.reason !== null) rows.push(`Reason: ${line(display.reason)}`);
      if (display.grantRoot !== null) rows.push(`Grant root: ${line(display.grantRoot)}`);
      break;
    case "permission_approval":
      if (display.reason !== null) rows.push(`Reason: ${line(display.reason)}`);
      rows.push(`Permissions: ${display.requested.length === 0 ? "none" : display.requested.map((permission) => line(permission.name)).join(", ")}`);
      if (display.requested.length === 0) {
        rows.push("No permission category can be granted. Decline or cancel this interaction.");
      } else {
        rows.push(`Protected grant document: ${line(JSON.stringify({
          permissions: display.requested.map((permission) => permission.name),
        }))}`);
      }
      break;
    case "user_input":
      for (const question of display.questions) {
        rows.push(
          "",
          `${line(question.header)}${question.secret ? " (protected input)" : ""}`,
          `  ID: ${line(question.id)}`,
          `  ${line(question.question)}`,
        );
        if (question.options !== null) {
          rows.push(...question.options.map((option) => `  ${line(option.label)}: ${line(option.description)}`));
        }
      }
      rows.push("", `Protected answer document: ${line(JSON.stringify({
        answers: Object.fromEntries(display.questions.map((question) => [
          question.id,
          { answers: ["<answer>"] },
        ])),
      }))}`);
      break;
    case "mcp_elicitation":
      rows.push(`Server: ${line(display.serverName)}`, `Mode: ${line(display.mode)}`);
      rows.push("Input: protected");
      if (display.mode === "form") {
        const fields = display.fields ?? [];
        rows.push(`Fields: ${fields.length === 0 ? "none" : String(fields.length)}`);
        for (const field of fields) {
          const requirement = field.required ? "required" : "optional";
          if (field.type === "string") {
            const format = field.format === null ? "" : `, format ${line(field.format)}`;
            rows.push(`  ${line(field.name)}: string, ${requirement}, ${String(field.minLength)}..${String(field.maxLength)} characters${format}`);
          } else if (field.type === "number" || field.type === "integer") {
            const minimum = field.minimum === null ? "unbounded" : String(field.minimum);
            const maximum = field.maximum === null ? "unbounded" : String(field.maximum);
            rows.push(`  ${line(field.name)}: ${field.type}, ${requirement}, ${minimum}..${maximum}`);
          } else if (field.type === "boolean") {
            rows.push(`  ${line(field.name)}: boolean, ${requirement}`);
          } else if (field.type === "single_select") {
            rows.push(`  ${line(field.name)}: single select, ${requirement}, choices ${field.choices.map(line).join(", ")}`);
          } else {
            const multiSelect = field as Extract<typeof field, { readonly type: "multi_select" }>;
            rows.push(`  ${line(multiSelect.name)}: multi select, ${requirement}, ${String(multiSelect.minItems)}..${String(multiSelect.maxItems)} choices from ${multiSelect.choices.map(line).join(", ")}`);
          }
        }
        rows.push("Submit one protected JSON document shaped as {\"content\":{...}}.");
      }
      break;
  }
  return rows.join("\n");
};

const renderSessionStatus = (data: unknown): string => {
  const root = object(data);
  const session = object(root?.session) ?? root;
  if (session === null) return safeJson(data, 2);
  const rows = [
    typeof session.title === "string" ? line(session.title) : `Session ${line(session.id)}`,
    `State: ${line(session.state ?? session.status)}`,
  ];
  if (session.activeTurnId !== undefined) rows.push(`Active turn: ${line(session.activeTurnId)}`);
  if (typeof session.revision === "number") rows.push(`Revision: ${String(session.revision)}`);
  const eventStream = object(root?.eventStream) ?? root;
  if (typeof eventStream?.observedThroughSequence === "number" && typeof eventStream.floorSequence === "number") {
    rows.push(`Events: through ${String(eventStream.observedThroughSequence)}, retained from ${String(eventStream.floorSequence)}`);
  }
  const pendingInteractions = interactionRecords(root?.pendingInteractions);
  if (pendingInteractions.length > 0) {
    rows.push("", "Pending interactions", renderInteractionList(pendingInteractions));
  }
  return rows.join("\n");
};

const pluginLifecycleNotice =
  "Lifecycle: discovery only. Pinned Codex 0.149.0 combines install, enablement, and browser-capable OAuth, so HRA blocks that compound effect.";

const renderPluginList = (data: unknown): string => {
  const root = object(data);
  const catalog = object(root?.catalog);
  const marketplaces = Array.isArray(catalog?.marketplaces)
    ? catalog.marketplaces.map(object).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const rows: Record<string, unknown>[] = [];
  for (const marketplace of marketplaces) {
    const plugins = Array.isArray(marketplace.plugins)
      ? marketplace.plugins.map(object).filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    for (const plugin of plugins) {
      rows.push({
        enabled: plugin.enabled,
        installed: plugin.installed,
        auth: plugin.authPolicy,
        name: plugin.displayName ?? plugin.name,
        marketplace: marketplace.displayName ?? marketplace.name,
        id: plugin.id,
      });
    }
  }
  const errorCount = typeof catalog?.marketplaceLoadErrorCount === "number"
    ? catalog.marketplaceLoadErrorCount
    : 0;
  return [
    table(rows, ["enabled", "installed", "auth", "name", "marketplace", "id"]),
    ...(errorCount === 0 ? [] : [`Marketplace load errors: ${String(errorCount)} (details withheld because upstream diagnostics may contain local paths).`]),
    pluginLifecycleNotice,
  ].join("\n\n");
};

const renderPlugin = (data: unknown): string => {
  const root = object(data);
  const plugin = object(root?.plugin);
  const marketplace = object(root?.marketplace);
  if (plugin === null) return safeJson(data, 2);
  const rows = [
    line(plugin.displayName ?? plugin.name ?? plugin.id),
    `ID: ${line(plugin.id)}`,
    `Marketplace: ${line(marketplace?.displayName ?? marketplace?.name)}`,
    `Installed: ${plugin.installed === true ? "yes" : "no"}`,
    `Enabled: ${plugin.enabled === true ? "yes" : "no"}`,
    `Availability: ${line(plugin.availability)}`,
    `Install policy: ${line(plugin.installPolicy)}`,
    `Authorization policy: ${line(plugin.authPolicy)}`,
  ];
  if (typeof plugin.shortDescription === "string") {
    rows.push("", indented(plugin.shortDescription));
  }
  const capabilities = stringArray(plugin.capabilities);
  if (capabilities.length > 0) rows.push(`Capabilities: ${capabilities.map(line).join(", ")}`);
  if (plugin.disabledReason !== null && plugin.disabledReason !== undefined) {
    rows.push(`Unavailable because: ${line(plugin.disabledReason)}`);
  }
  rows.push("", pluginLifecycleNotice);
  return rows.join("\n");
};

const instant = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "unknown time";
  try {
    return new Date(value).toISOString();
  } catch {
    return "unknown time";
  }
};

const usageVelocity = (value: unknown): string => {
  const velocity = object(value);
  if (velocity?.available === true && typeof velocity.tokensPerMinute === "number") {
    const rate = velocity.tokensPerMinute;
    return `${rate.toLocaleString("en-US", { maximumFractionDigits: rate < 10 ? 2 : 1 })} tokens/min`;
  }
  return typeof velocity?.reason === "string"
    ? `unavailable (${line(velocity.reason)})`
    : "unavailable";
};

const usageLifetimeTokens = (payload: unknown): number | null => {
  const root = object(payload);
  const usage = object(root?.usage);
  const summary = object(usage?.summary);
  return typeof summary?.lifetimeTokens === "number" ? summary.lifetimeTokens : null;
};

const usagePercent = (payload: unknown): number | null => {
  const root = object(payload);
  const primary = object(root?.primary) ?? object(object(root?.rateLimits)?.primary);
  return typeof primary?.usedPercent === "number" ? primary.usedPercent : null;
};

const renderAccountUsage = (data: unknown): string => {
  const root = object(data);
  const usage = !Array.isArray(root?.usage) || root.usage.length === 0
    ? "No account usage observations."
    : root.usage.map((value): string => {
      const entry = object(value);
      const account = object(entry?.account);
      const poll = object(entry?.poll);
      const snapshot = object(entry?.snapshot);
      const velocity = object(entry?.velocity);
      const payload = snapshot?.payload;
      const label = typeof account?.label === "string"
        ? account.label
        : typeof account?.id === "string"
          ? account.id
          : "Unknown account";
      const rows = [line(label)];
      if (poll?.state === "failed") {
        rows.push(`  poll: failed at ${instant(poll.observedAt)} (${line(poll.reasonCode)})`);
      } else if (poll?.state === "observed") {
        rows.push(`  observed: ${instant(poll.observedAt)}`);
      } else {
        rows.push("  observed: never");
      }
      const lifetimeTokens = usageLifetimeTokens(payload);
      if (lifetimeTokens !== null) rows.push(`  lifetime tokens: ${lifetimeTokens.toLocaleString("en-US")}`);
      const usedPercent = usagePercent(payload);
      if (usedPercent !== null) rows.push(`  primary limit used: ${usedPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`);
      rows.push(
        `  velocity: 1m ${usageVelocity(velocity?.["1m"])}; 5m ${usageVelocity(velocity?.["5m"])}; 15m ${usageVelocity(velocity?.["15m"])}`,
      );
      return rows.join("\n");
    }).join("\n\n");
  const refresh = object(root?.refresh);
  if (!Array.isArray(refresh?.outcomes)) return usage;
  const outcomes = refresh.outcomes.map((value): string => {
    const outcome = object(value);
    if (outcome === null) return "unknown account: failed (invalid response)";
    const accountId = line(outcome.accountId);
    if (outcome.state === "refreshed") return `${accountId}: refreshed`;
    if (outcome.state === "skipped") {
      return `${accountId}: skipped (${line(outcome.accountState)})`;
    }
    return `${accountId}: failed (${line(outcome.code)})`;
  });
  return [usage, "", "Refresh outcomes", ...outcomes.map((outcome) => `  ${outcome}`)].join("\n");
};

export function renderSuccess(command: LocalCommand, data: unknown, json: boolean, output: Output): void {
  if (json) {
    output.writeStdout(`${safeJson({
      ok: true,
      version: 1,
      command: command.kind,
      data: publicInteractionData(command, data),
    })}\n`);
    return;
  }
  const value = data as Record<string, unknown>;
  if (command.kind === "account.list" && Array.isArray(value.accounts)) {
    output.writeStdout(`${table(value.accounts as Record<string, unknown>[], ["label", "state", "providerPlan", "id"])}\n`);
  } else if (command.kind === "project.list" && Array.isArray(value.projects)) {
    output.writeStdout(`${table(value.projects as Record<string, unknown>[], ["label", "rootPath", "default", "id"])}\n`);
  } else if (command.kind === "session.list" && Array.isArray(value.sessions)) {
    output.writeStdout(`${table(value.sessions as Record<string, unknown>[], ["title", "state", "preset", "fastEnabled", "id"])}\n`);
  } else if (command.kind === "session.show") {
    output.writeStdout(`${renderSession(data)}\n`);
  } else if (command.kind === "session.status") {
    output.writeStdout(`${renderSessionStatus(data)}\n`);
  } else if (command.kind === "session.events") {
    const page = sessionEventPage(data);
    output.writeStdout(`${page === null ? "Event page data is unavailable." : renderSessionEventPageHuman(page)}\n`);
  } else if (command.kind === "session.interactions" || command.kind === "interaction.list") {
    output.writeStdout(`${renderInteractionList(data)}\n`);
  } else if (command.kind === "interaction.show" || command.kind === "interaction.resolve") {
    const interaction = interactionRecord(data);
    output.writeStdout(`${interaction === null ? "Interaction data is unavailable." : renderInteraction(interaction)}\n`);
  } else if (command.kind === "session.note.get") {
    output.writeStdout(`${line(value.note)}\n`);
  } else if (command.kind === "daemon.status") {
    output.writeStdout(value.running === true ? `HRA daemon is running (pid ${line(value.pid)}).\n` : "HRA daemon is stopped.\n");
  } else if (command.kind === "account.login-cancel") {
    if (value.status === "signed_in") {
      output.writeStdout("The account completed sign-in before cancellation.\n");
    } else if (value.status === "already_settled") {
      output.writeStdout("No login is pending for this account.\n");
    } else {
      output.writeStdout(`Canceled the pending login (${line(value.providerStatus)}). You can start a fresh login now.\n`);
    }
  } else if (command.kind === "account.switch-recover") {
    if (value.status === "none") {
      output.writeStdout("No desktop switch requires recovery.\n");
    } else if (value.status === "in_progress") {
      output.writeStdout(`Desktop switch ${line(value.switchGeneration)} is still in progress.\n`);
    } else if (value.status === "resolved_applied") {
      output.writeStdout(`Desktop switch ${line(value.switchGeneration)} is resolved as applied.\n`);
    } else if (value.status === "resolved_not_applied") {
      output.writeStdout(`Desktop switch ${line(value.switchGeneration)} is resolved as not applied.\n`);
    } else {
      output.writeStdout(`Desktop switch ${line(value.switchGeneration)} still requires recovery: ${line(value.diagnostic)}.\n`);
    }
  } else if (command.kind === "account.usage") {
    output.writeStdout(`${renderAccountUsage(data)}\n`);
  } else if (command.kind === "plugin.list") {
    output.writeStdout(`${renderPluginList(data)}\n`);
  } else if (command.kind === "plugin.show") {
    output.writeStdout(`${renderPlugin(data)}\n`);
  } else {
    output.writeStdout(`${safeJson(data, 2)}\n`);
  }
}

export function renderFailure(error: { code: string; message: string; details?: unknown }, json: boolean, output: Output): number {
  const safeError = {
    code: error.code,
    message: error.code === "INTERNAL"
      ? "HRA could not complete the request safely."
      : safeDiagnostic(error.message),
    ...(error.code === "INTERNAL" || error.details === undefined
      ? {}
      : { details: safeDiagnosticDetails(error.details) }),
  };
  if (json) {
    output.writeStdout(`${safeJson({ ok: false, version: 1, error: safeError })}\n`);
  } else {
    output.writeStderr(`hra: ${safeError.message}\n`);
    if (safeError.details !== undefined) output.writeStderr(`${safeJson(safeError.details, 2)}\n`);
  }
  return error.code === "INVALID_INPUT" ? 2 : error.code === "NOT_FOUND" ? 4 : error.code === "INTERACTION_REQUIRED" ? 6 : error.code === "RECOVERY_REQUIRED" ? 7 : error.code === "UNAVAILABLE" ? 5 : 1;
}
