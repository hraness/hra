import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { LocalCommand } from "../domain/contracts";
import { localCommandSchema } from "../domain/contracts";
import { isUuidV7 } from "../cloud/contracts";
import { parseAuthCredentials } from "../cloud/authCredentials";
import { createCloudUuidV7 } from "../cloud/local-control";

type InteractionRequiredInvocation = Readonly<{
  error: Readonly<{
    code: "INTERACTION_REQUIRED";
    details: Readonly<{
      acknowledgementRequired: "--acknowledge-gap";
      idempotencyKey: string;
      nextCommand: string;
    }>;
    message: string;
  }>;
  json: boolean;
  kind: "interaction-required";
}>;

export type ProjectionRecoveryCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "sync.projection-recover" }>;
  json: boolean;
  kind: "sync.projection-recover";
  replayCommand: string;
}>;

export type ProtectedInputSource =
  | Readonly<{ kind: "stdin" }>
  | Readonly<{ fd: number; kind: "fd" }>;

export type ProtectedInteractionCliInvocation = Readonly<{
  expectedRevision: number;
  input: ProtectedInputSource;
  interaction: string;
  json: boolean;
  kind: "interaction.resolve-protected";
  resolution:
    | Readonly<{ kind: "permission_grant"; scope: "turn" | "session" | null }>
    | Readonly<{ kind: "user_answers" }>
    | Readonly<{ action: "accept"; kind: "mcp_submission" }>;
}>;

export type ProtectedAuthLoginCliInvocation = Readonly<{
  input: ProtectedInputSource;
  json: boolean;
  kind: "auth.login-protected";
}>;

export type SessionEventFollowCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "session.events" }>;
  jsonl: true;
  kind: "session.events.follow";
}>;

export type InteractionResolveCommand = Extract<LocalCommand, { kind: "interaction.resolve" }>;

export type CliInvocation =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "init"; yes: boolean; json: boolean }
  | { kind: "daemon.start"; json: boolean }
  | { kind: "daemon.run" }
  | { kind: "remote"; command: RemoteCliCommand; idempotencyKey?: string; json: boolean }
  | ProtectedAuthLoginCliInvocation
  | ProtectedInteractionCliInvocation
  | SessionEventFollowCliInvocation
  | InteractionRequiredInvocation
  | ProjectionRecoveryCliInvocation
  | { kind: "command"; command: LocalCommand; json: boolean };

export type RemoteCliCommand =
  | Readonly<{ kind: "remote.list"; limit: number }>
  | Readonly<{ kind: "remote.show"; session: string }>
  | Readonly<{ commandPublicId: string; kind: "remote.command" }>
  | Readonly<{ kind: "remote.send" | "remote.queue" | "remote.steer"; message: string; session: string }>
  | Readonly<{ kind: "remote.stop"; session: string }>
  | Readonly<{ kind: "remote.preset"; preset: "low" | "high" | "ultra"; session: string }>
  | Readonly<{ enabled: boolean; kind: "remote.fast"; session: string }>;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const usage = `HRA

Usage:
  hra init [--yes] [--json]
  hra doctor [--offline] [--json]
  hra daemon start|status|stop|run
  hra account add|list|show|login|logout|usage|switch|switch-recover
  hra plugin list <account> [--project <project>] [--refresh]
  hra plugin show <account> <plugin> [--project <project>] [--refresh]
  hra project add|list|use
  hra session list|show|status|start|send|queue|steer|stop
  hra session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--follow]
  hra session interactions <session> [--pending] [--limit <1..100>]
  hra session rename|recover|abandon|note|preset|fast|project
  hra interaction list|show|decide|grant|answer|submit
  hra remote list|show|command|send|queue|steer|stop|preset|fast
  hra turn inspect
  hra auth login --input-stdin|--input-fd <fd>
  hra auth status|logout
  hra auth delete --acknowledge-erasure
  hra device list|pair|approve|revoke
  hra sync status|now
  hra sync projection recover <local-session> --acknowledge-gap

Mutation safety:
  --idempotency-key <uuid>  Reuse after a lost response; changed reuse fails closed.

Recommended profiles:
  low     Luna Max
  high    Sol Max
  ultra   Sol Ultra

Run ‘hra <group> --help’ for command examples.`;

export function requestsJsonOutput(argv: readonly string[]): boolean {
  const delimiter = argv.indexOf("--");
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  return options.includes("--json");
}

type Cursor = { values: string[] };
const literalPrefix = "\u0000";
const projectionRecoveryKeyLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const projectionRecoveryKeyFutureSkewMs = 5 * 60 * 1_000;
const idempotentCommandKinds = new Set<LocalCommand["kind"]>([
  "account.login",
  "account.logout",
  "account.switch",
  "session.start",
  "session.send",
  "session.queue",
  "session.steer",
  "session.stop",
  "session.rename",
]);
const literal = (value: string): string => `${literalPrefix}${value}`;
const decode = (value: string): string => value.startsWith(literalPrefix) ? value.slice(literalPrefix.length) : value;
const isOption = (value: string): boolean => !value.startsWith(literalPrefix) && value.startsWith("--");

const isCurrentProjectionRecoveryKey = (value: string, now = Date.now()): boolean => {
  if (!isUuidV7(value) || !Number.isSafeInteger(now) || now < 0) return false;
  const timestamp = Number.parseInt(`${value.slice(0, 8)}${value.slice(9, 13)}`, 16);
  return Number.isSafeInteger(timestamp)
    && timestamp >= now - projectionRecoveryKeyLifetimeMs
    && timestamp <= now + projectionRecoveryKeyFutureSkewMs;
};

const take = (cursor: Cursor, label: string): string => {
  const value = cursor.values.shift();
  if (value === undefined || isOption(value)) throw new CliUsageError(`Missing ${label}.`);
  return decode(value);
};

const takeOptional = (cursor: Cursor): string | undefined => {
  const value = cursor.values[0];
  if (value === undefined || isOption(value)) return undefined;
  cursor.values.shift();
  return decode(value);
};

const flag = (cursor: Cursor, name: string): boolean => {
  const index = cursor.values.indexOf(name);
  if (index < 0) return false;
  cursor.values.splice(index, 1);
  return true;
};

const option = (cursor: Cursor, name: string): string | undefined => {
  const index = cursor.values.indexOf(name);
  if (index < 0) return undefined;
  const value = cursor.values[index + 1];
  if (value === undefined || isOption(value)) throw new CliUsageError(`Missing value for ${name}.`);
  cursor.values.splice(index, 2);
  return decode(value);
};

const boundedDecimal = (
  value: string | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number => {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CliUsageError(`Missing ${label}.`);
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new CliUsageError(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliUsageError(`${label} must be an integer from ${String(minimum)} to ${String(maximum)}.`);
  }
  return parsed;
};

const protectedInput = (cursor: Cursor, required: boolean): ProtectedInputSource | undefined => {
  const stdin = flag(cursor, "--input-stdin");
  const descriptor = option(cursor, "--input-fd");
  if (stdin && descriptor !== undefined) {
    throw new CliUsageError("Use exactly one protected input source: --input-stdin or --input-fd.");
  }
  if (stdin) return { kind: "stdin" };
  if (descriptor !== undefined) {
    const fd = boundedDecimal(descriptor, "input file descriptor", 0, 1_048_575);
    if (fd === 1 || fd === 2) throw new CliUsageError("Protected input cannot read from stdout or stderr.");
    return { fd, kind: "fd" };
  }
  if (required) {
    throw new CliUsageError("This interaction requires --input-stdin or --input-fd. Secret values are not accepted as arguments.");
  }
  return undefined;
};

const remainder = (cursor: Cursor, label: string): string => {
  if (cursor.values.length === 0) throw new CliUsageError(`Missing ${label}.`);
  const unknown = cursor.values.find(isOption);
  if (unknown !== undefined) throw new CliUsageError(`Unknown option: ${unknown}`);
  return cursor.values.splice(0).map(decode).join(" ");
};

const finish = (cursor: Cursor): void => {
  const unexpected = cursor.values[0];
  if (unexpected !== undefined) throw new CliUsageError(`Unexpected argument: ${unexpected}`);
};

const shellArgument = (value: string): string => {
  if (/^[A-Za-z0-9_./:@+-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
};

export const projectionRecoveryReplayCommand = (
  session: string,
  idempotencyKey: string,
  json: boolean,
): string => [
  "hra sync projection recover",
  shellArgument(session),
  "--acknowledge-gap",
  "--idempotency-key",
  idempotencyKey,
  ...(json ? ["--json"] : []),
].join(" ");

const command = (value: unknown): LocalCommand => {
  const parsed = localCommandSchema.safeParse(value);
  if (!parsed.success) throw new CliUsageError(parsed.error.issues[0]?.message ?? "Invalid command.");
  return parsed.data;
};

const exactProtectedField = (document: unknown, field: string): unknown => {
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new CliUsageError(`Protected interaction input must be a JSON object containing only ${field}.`);
  }
  const record = document as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== field) {
    throw new CliUsageError(`Protected interaction input must contain exactly one ${field} field.`);
  }
  return record[field];
};

export const completeProtectedInteraction = (
  invocation: ProtectedInteractionCliInvocation,
  document: unknown,
): InteractionResolveCommand => {
  const resolution = invocation.resolution.kind === "permission_grant"
    ? {
      kind: "permission_grant" as const,
      permissions: exactProtectedField(document, "permissions"),
      scope: invocation.resolution.scope,
    }
    : invocation.resolution.kind === "user_answers"
      ? {
        kind: "user_answers" as const,
        answers: exactProtectedField(document, "answers"),
      }
      : {
        action: invocation.resolution.action,
        content: exactProtectedField(document, "content"),
        kind: "mcp_submission" as const,
      };
  const parsed = command({
    kind: "interaction.resolve",
    interaction: invocation.interaction,
    expectedRevision: invocation.expectedRevision,
    resolution,
  });
  if (parsed.kind !== "interaction.resolve") throw new CliUsageError("Protected interaction command is invalid.");
  return parsed;
};

export const completeProtectedAuthLogin = (
  invocation: ProtectedAuthLoginCliInvocation,
  document: unknown,
): Extract<LocalCommand, { kind: "auth.login" }> => {
  const credentials = parseAuthCredentials(document);
  if (credentials.kind === "rejected") {
    throw new CliUsageError(
      "Protected auth input must be exactly {email}, {email, invite}, or {email, code} with canonical values.",
    );
  }
  const parsed = command({
    kind: "auth.login",
    email: credentials.email,
    ...(credentials.kind === "verify_code"
      ? { code: credentials.code }
      : credentials.invite === undefined
        ? {}
        : { invite: credentials.invite }),
  });
  if (parsed.kind !== "auth.login") throw new CliUsageError("Protected auth command is invalid.");
  return parsed;
};

const parseAccount = (cursor: Cursor): LocalCommand => {
  const action = take(cursor, "account action");
  switch (action) {
    case "list": finish(cursor); return { kind: "account.list" };
    case "add": { const label = remainder(cursor, "account label"); return command({ kind: "account.add", label }); }
    case "show": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.show", account }; }
    case "login": { const deviceCode = flag(cursor, "--device-code"); const account = take(cursor, "account"); finish(cursor); return { kind: "account.login", account, deviceCode }; }
    case "logout": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.logout", account }; }
    case "usage": { const refresh = flag(cursor, "--refresh"); const account = takeOptional(cursor); finish(cursor); return command({ kind: "account.usage", account, refresh }); }
    case "switch": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.switch", account, idempotencyKey: randomUUID() }; }
    case "switch-recover": finish(cursor); return { kind: "account.switch-recover" };
    default: throw new CliUsageError(`Unknown account action: ${action}`);
  }
};

const parsePlugin = (cursor: Cursor): LocalCommand => {
  const action = take(cursor, "plugin action");
  const refresh = flag(cursor, "--refresh");
  const project = option(cursor, "--project");
  if (action === "list") {
    const account = take(cursor, "account");
    finish(cursor);
    return command({ kind: "plugin.list", account, project, refresh });
  }
  if (action === "show") {
    const account = take(cursor, "account");
    const plugin = take(cursor, "plugin");
    finish(cursor);
    return command({ kind: "plugin.show", account, plugin, project, refresh });
  }
  if (action === "install" || action === "enable" || action === "disable") {
    throw new CliUsageError(
      "Pinned Codex 0.149.0 has no safe separated plugin lifecycle effect. Use `plugin list` or `plugin show` to inspect the exact boundary.",
    );
  }
  throw new CliUsageError(`Unknown plugin action: ${action}`);
};

const parseProject = (cursor: Cursor, cwd: string): LocalCommand => {
  const action = take(cursor, "project action");
  switch (action) {
    case "list": finish(cursor); return { kind: "project.list" };
    case "add": { const requestedPath = option(cursor, "--path") ?? take(cursor, "project directory"); const label = option(cursor, "--name") ?? takeOptional(cursor) ?? requestedPath.split("/").filter(Boolean).at(-1) ?? "Project"; finish(cursor); return command({ kind: "project.add", label, path: resolve(cwd, requestedPath) }); }
    case "use": { const project = take(cursor, "project"); finish(cursor); return { kind: "project.use", project }; }
    default: throw new CliUsageError(`Unknown project action: ${action}`);
  }
};

const parseSessionNote = (cursor: Cursor): LocalCommand => {
  const action = take(cursor, "note action");
  const session = take(cursor, "session");
  switch (action) {
    case "get": finish(cursor); return { kind: "session.note.get", session };
    case "edit": finish(cursor); return { kind: "session.note.edit", session };
    case "set": return command({ kind: "session.note.set", session, note: remainder(cursor, "note") });
    case "clear": finish(cursor); return { kind: "session.note.clear", session };
    default: throw new CliUsageError(`Unknown note action: ${action}`);
  }
};

const parseSession = (cursor: Cursor): LocalCommand | SessionEventFollowCliInvocation => {
  const action = take(cursor, "session action");
  switch (action) {
    case "list": { const account = option(cursor, "--account"); const limit = Number(option(cursor, "--limit") ?? "50"); finish(cursor); return command({ kind: "session.list", account, limit }); }
    case "show": { const detail = flag(cursor, "--detail"); const session = take(cursor, "session"); finish(cursor); return { kind: "session.show", session, detail }; }
    case "status": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.status", session }; }
    case "events": {
      const follow = flag(cursor, "--follow");
      const eventCursor = option(cursor, "--cursor");
      const limit = boundedDecimal(option(cursor, "--limit"), "event limit", 1, 200, 200);
      const waitMs = boundedDecimal(
        option(cursor, "--wait-ms"),
        "event wait",
        0,
        30_000,
        follow ? 30_000 : 0,
      );
      if (follow && waitMs === 0) {
        throw new CliUsageError("Following events requires --wait-ms from 1 to 30000.");
      }
      const session = take(cursor, "session");
      finish(cursor);
      const parsed = command({
        kind: "session.events",
        session,
        cursor: eventCursor,
        limit,
        waitMs,
      });
      if (parsed.kind !== "session.events") throw new CliUsageError("Session event command is invalid.");
      return follow
        ? { command: parsed, jsonl: true, kind: "session.events.follow" }
        : parsed;
    }
    case "interactions": {
      const pending = flag(cursor, "--pending");
      const limit = boundedDecimal(option(cursor, "--limit"), "interaction limit", 1, 100, 100);
      const session = take(cursor, "session");
      finish(cursor);
      return command({ kind: "session.interactions", session, pending, limit });
    }
    case "start": { const project = option(cursor, "--project"); const preset = option(cursor, "--preset") ?? "high"; const fast = flag(cursor, "--fast"); const account = take(cursor, "account"); finish(cursor); return command({ kind: "session.start", account, project, preset, fast }); }
    case "send": { const session = take(cursor, "session"); return command({ kind: "session.send", session, message: remainder(cursor, "message") }); }
    case "queue": { const session = take(cursor, "session"); return command({ kind: "session.queue", session, message: remainder(cursor, "message") }); }
    case "steer": { const session = take(cursor, "session"); return command({ kind: "session.steer", session, message: remainder(cursor, "message") }); }
    case "stop": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.stop", session }; }
    case "rename": { const session = take(cursor, "session"); return command({ kind: "session.rename", session, name: remainder(cursor, "name") }); }
    case "recover": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.recover", session }; }
    case "abandon": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.abandon", session }; }
    case "note": return parseSessionNote(cursor);
    case "preset": { const session = take(cursor, "session"); const preset = take(cursor, "preset"); finish(cursor); return command({ kind: "session.preset", session, preset }); }
    case "fast": { const session = take(cursor, "session"); const value = take(cursor, "on or off"); finish(cursor); if (value !== "on" && value !== "off") throw new CliUsageError("Fast must be `on` or `off`."); return { kind: "session.fast", session, enabled: value === "on" }; }
    case "project": { const session = take(cursor, "session"); const project = take(cursor, "project"); finish(cursor); return { kind: "session.project", session, project }; }
    default: throw new CliUsageError(`Unknown session action: ${action}`);
  }
};

type ParsedInteraction =
  | Readonly<{ command: LocalCommand; kind: "command" }>
  | ProtectedInteractionCliInvocation;

const exactInteractionId = (value: string): string => {
  const parsed = command({ kind: "interaction.show", interaction: value });
  if (parsed.kind !== "interaction.show") throw new CliUsageError("Interaction ID is invalid.");
  return parsed.interaction;
};

const parseInteraction = (cursor: Cursor, json: boolean): ParsedInteraction => {
  const action = take(cursor, "interaction action");
  if (action === "list") {
    const pending = flag(cursor, "--pending");
    const limit = boundedDecimal(option(cursor, "--limit"), "interaction limit", 1, 100, 100);
    const session = takeOptional(cursor);
    finish(cursor);
    return { command: command({ kind: "interaction.list", session, pending, limit }), kind: "command" };
  }
  if (action === "show") {
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    return { command: command({ kind: "interaction.show", interaction }), kind: "command" };
  }

  const expectedRevision = boundedDecimal(
    option(cursor, "--revision"),
    "interaction revision",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  if (action === "decide") {
    const decision = option(cursor, "--decision");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    if (decision !== "once" && decision !== "session" && decision !== "decline" && decision !== "cancel") {
      throw new CliUsageError("Interaction decision must be once, session, decline, or cancel.");
    }
    return {
      command: command({
        kind: "interaction.resolve",
        interaction,
        expectedRevision,
        resolution: { kind: "approval_decision", decision },
      }),
      kind: "command",
    };
  }
  if (action === "grant") {
    const scopeValue = option(cursor, "--scope");
    if (scopeValue !== undefined && scopeValue !== "turn" && scopeValue !== "session") {
      throw new CliUsageError("Permission scope must be turn or session.");
    }
    const input = protectedInput(cursor, true);
    if (input === undefined) throw new CliUsageError("Protected permission input is required.");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    return {
      expectedRevision,
      input,
      interaction: exactInteractionId(interaction),
      json,
      kind: "interaction.resolve-protected",
      resolution: { kind: "permission_grant", scope: scopeValue ?? null },
    };
  }
  if (action === "answer") {
    const input = protectedInput(cursor, true);
    if (input === undefined) throw new CliUsageError("Protected answer input is required.");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    return {
      expectedRevision,
      input,
      interaction: exactInteractionId(interaction),
      json,
      kind: "interaction.resolve-protected",
      resolution: { kind: "user_answers" },
    };
  }
  if (action === "submit") {
    const actionValue = option(cursor, "--action");
    if (actionValue !== "accept" && actionValue !== "decline" && actionValue !== "cancel") {
      throw new CliUsageError("MCP submission action must be accept, decline, or cancel.");
    }
    const input = protectedInput(cursor, false);
    if (input !== undefined && actionValue !== "accept") {
      throw new CliUsageError("Protected MCP content is accepted only with --action accept.");
    }
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    const exactInteraction = exactInteractionId(interaction);
    if (input === undefined) {
      return {
        command: command({
          kind: "interaction.resolve",
          interaction: exactInteraction,
          expectedRevision,
          resolution: { kind: "mcp_submission", action: actionValue },
        }),
        kind: "command",
      };
    }
    return {
      expectedRevision,
      input,
      interaction: exactInteraction,
      json,
      kind: "interaction.resolve-protected",
      resolution: { action: "accept", kind: "mcp_submission" },
    };
  }
  throw new CliUsageError(`Unknown interaction action: ${action}`);
};

const parseRemote = (cursor: Cursor): RemoteCliCommand => {
  const action = take(cursor, "remote action");
  switch (action) {
    case "list": {
      const limit = Number(option(cursor, "--limit") ?? "50");
      finish(cursor);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new CliUsageError("Remote session limit must be an integer from 1 to 100.");
      }
      return { kind: "remote.list", limit };
    }
    case "show": {
      const session = take(cursor, "session");
      finish(cursor);
      return { kind: "remote.show", session };
    }
    case "command": {
      const commandPublicId = take(cursor, "command public ID");
      finish(cursor);
      if (!isUuidV7(commandPublicId)) {
        throw new CliUsageError("Remote command public ID must be a UUIDv7.");
      }
      return { commandPublicId, kind: "remote.command" };
    }
    case "send":
    case "queue":
    case "steer": {
      const session = take(cursor, "session");
      const message = remainder(cursor, "message");
      if (message.length > 64_000) throw new CliUsageError("Remote message is too long.");
      return { kind: `remote.${action}`, session, message };
    }
    case "stop": {
      const session = take(cursor, "session");
      finish(cursor);
      return { kind: "remote.stop", session };
    }
    case "preset": {
      const session = take(cursor, "session");
      const preset = take(cursor, "preset");
      finish(cursor);
      if (preset !== "low" && preset !== "high" && preset !== "ultra") {
        throw new CliUsageError("Preset must be `low`, `high`, or `ultra`.");
      }
      return { kind: "remote.preset", session, preset };
    }
    case "fast": {
      const session = take(cursor, "session");
      const value = take(cursor, "on or off");
      finish(cursor);
      if (value !== "on" && value !== "off") throw new CliUsageError("Fast must be `on` or `off`.");
      return { enabled: value === "on", kind: "remote.fast", session };
    }
    default: throw new CliUsageError(`Unknown remote action: ${action}`);
  }
};

export function parseCli(argv: readonly string[], cwd = process.cwd()): CliInvocation {
  const delimiter = argv.indexOf("--");
  const regular = delimiter < 0 ? [...argv] : argv.slice(0, delimiter);
  const literalTail = delimiter < 0 ? [] : argv.slice(delimiter + 1).map(literal);
  const cursor: Cursor = { values: regular };
  const json = flag(cursor, "--json");
  const idempotencyKey = option(cursor, "--idempotency-key");
  if (flag(cursor, "--help") || flag(cursor, "-h") || (cursor.values.length === 0 && literalTail.length === 0)) return { kind: "help" };
  if (flag(cursor, "--version") || flag(cursor, "-v")) { finish(cursor); return { kind: "version" }; }
  cursor.values.push(...literalTail);
  const group = take(cursor, "command");
  if (group === "init") { const yes = flag(cursor, "--yes"); finish(cursor); return { kind: "init", yes, json }; }
  if (group === "doctor") { const offline = flag(cursor, "--offline"); finish(cursor); return { kind: "command", command: { kind: "doctor", offline }, json }; }
  if (group === "daemon") {
    const action = take(cursor, "daemon action");
    finish(cursor);
    if (action === "start") return { kind: "daemon.start", json };
    if (action === "run") {
      if (json) throw new CliUsageError("--json is not supported by the foreground daemon process.");
      return { kind: "daemon.run" };
    }
    if (action === "status" || action === "stop") return { kind: "command", command: { kind: `daemon.${action}` }, json };
    throw new CliUsageError(`Unknown daemon action: ${action}`);
  }
  if (group === "remote") {
    const remote = parseRemote(cursor);
    if (
      idempotencyKey !== undefined
      && (remote.kind === "remote.list"
        || remote.kind === "remote.show"
        || remote.kind === "remote.command")
    ) throw new CliUsageError(`--idempotency-key is not supported by ${remote.kind}.`);
    const mutates = remote.kind !== "remote.list"
      && remote.kind !== "remote.show"
      && remote.kind !== "remote.command";
    return {
      kind: "remote",
      command: remote,
      ...(mutates && idempotencyKey !== undefined ? { idempotencyKey } : {}),
      json,
    };
  }
  let parsed: LocalCommand;
  if (group === "account") parsed = parseAccount(cursor);
  else if (group === "plugin") parsed = parsePlugin(cursor);
  else if (group === "project") parsed = parseProject(cursor, cwd);
  else if (group === "session") {
    const sessionCommand = parseSession(cursor);
    if (sessionCommand.kind === "session.events.follow") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by session.events.");
      }
      return sessionCommand;
    }
    parsed = sessionCommand;
  }
  else if (group === "turn") { const action = take(cursor, "turn action"); if (action !== "inspect") throw new CliUsageError(`Unknown turn action: ${action}`); const session = take(cursor, "session"); const turn = take(cursor, "turn"); finish(cursor); parsed = { kind: "turn.inspect", session, turn }; }
  else if (group === "interaction") {
    const interaction = parseInteraction(cursor, json);
    if (interaction.kind === "interaction.resolve-protected") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by interaction.resolve.");
      }
      return interaction;
    }
    parsed = interaction.command;
  }
  else if (group === "auth") {
    const action = take(cursor, "auth action");
    if (action === "login") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by auth.login.");
      }
      const input = protectedInput(cursor, true);
      finish(cursor);
      if (input === undefined) throw new CliUsageError("Protected auth input is required.");
      return { input, json, kind: "auth.login-protected" };
    }
    if (action === "delete") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by auth.delete; HRA durably owns deletion recovery.");
      }
      const acknowledgeErasure = flag(cursor, "--acknowledge-erasure");
      finish(cursor);
      if (!acknowledgeErasure) {
        throw new CliUsageError("Account deletion requires --acknowledge-erasure.");
      }
      parsed = { acknowledgeErasure: true, kind: "auth.delete" };
    } else if (action === "status" || action === "logout") {
      finish(cursor);
      parsed = { kind: `auth.${action}` };
    } else {
      throw new CliUsageError(`Unknown auth action: ${action}`);
    }
  }
  else if (group === "device") { const action = take(cursor, "device action"); if (action === "list" || action === "pair") { finish(cursor); parsed = { kind: `device.${action}` }; } else if (action === "approve" || action === "revoke") { const device = take(cursor, "device"); finish(cursor); parsed = { kind: `device.${action}`, device }; } else throw new CliUsageError(`Unknown device action: ${action}`); }
  else if (group === "sync") {
    const action = take(cursor, "sync action");
    if (action === "status" || action === "now") {
      finish(cursor);
      parsed = { kind: `sync.${action}` };
    } else if (action === "projection") {
      const projectionAction = take(cursor, "projection action");
      if (projectionAction !== "recover") {
        throw new CliUsageError(`Unknown projection action: ${projectionAction}`);
      }
      const acknowledgeGap = flag(cursor, "--acknowledge-gap");
      const session = take(cursor, "local session");
      finish(cursor);
      const recoveryKey = idempotencyKey ?? createCloudUuidV7();
      if (!isCurrentProjectionRecoveryKey(recoveryKey)) {
        throw new CliUsageError("Projection recovery --idempotency-key must be a current UUIDv7.");
      }
      const recoveryCommand = command({
        acknowledgeGap: true,
        idempotencyKey: recoveryKey,
        kind: "sync.projection-recover",
        session,
      });
      if (recoveryCommand.kind !== "sync.projection-recover") {
        throw new CliUsageError("Projection recovery command is invalid.");
      }
      const replayCommand = projectionRecoveryReplayCommand(
        recoveryCommand.session,
        recoveryCommand.idempotencyKey,
        json,
      );
      if (!acknowledgeGap) {
        return {
          error: {
            code: "INTERACTION_REQUIRED",
            details: {
              acknowledgementRequired: "--acknowledge-gap",
              idempotencyKey: recoveryCommand.idempotencyKey,
              nextCommand: replayCommand,
            },
            message: "Projection recovery can preserve an unsynced transcript gap. Review the warning, then run the exact next command to acknowledge that gap.",
          },
          json,
          kind: "interaction-required",
        };
      }
      return {
        command: recoveryCommand,
        json,
        kind: "sync.projection-recover",
        replayCommand,
      };
    } else {
      throw new CliUsageError(`Unknown sync action: ${action}`);
    }
  }
  else throw new CliUsageError(`Unknown command: ${group}`);
  if (idempotencyKey !== undefined && !idempotentCommandKinds.has(parsed.kind)) {
    throw new CliUsageError(`--idempotency-key is not supported by ${parsed.kind}.`);
  }
  if (idempotentCommandKinds.has(parsed.kind)) {
    const generated = "idempotencyKey" in parsed && typeof parsed.idempotencyKey === "string"
      ? parsed.idempotencyKey
      : randomUUID();
    parsed = command({ ...parsed, idempotencyKey: idempotencyKey ?? generated });
  }
  return { kind: "command", command: parsed, json };
}
