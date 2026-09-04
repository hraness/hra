import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { CODEX_PIN } from "../codex/pin";
import type { LocalCommand } from "../domain/contracts";
import { localCommandSchema } from "../domain/contracts";
import { ACCOUNT_USAGE_HISTORY_PAGE_LIMIT } from "../domain/usage-metrics";
import { createCloudUuidV7, isUuidV7 } from "../domain/uuid-v7";
import { parseAuthCredentials } from "../cloud/authCredentials";
import {
  WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
} from "../domain/work";
import { workProtocolQuerySchema } from "../domain/work-protocol";
import {
  SESSION_TASK_MAX_INTERVAL_MINUTES,
  SESSION_TASK_MIN_INTERVAL_MINUTES,
} from "../domain/session-tasks";

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

export type ProtectedInteractionInspectCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "interaction.inspect" }>;
  handoffFile?: string;
  json: boolean;
  kind: "interaction.inspect-protected";
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

export type SessionEventWatchCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "session.events" }>;
  jsonl: boolean;
  kind: "session.events.watch";
}>;

export type WorkApplyCliInvocation = Readonly<{
  input: ProtectedInputSource;
  json: true;
  kind: "work.apply-input";
}>;

export type WorkEventFollowCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "work.events" }>;
  jsonl: true;
  kind: "work.events.follow";
}>;

export type AccountLoginCliInvocation = Readonly<{
  command: Extract<LocalCommand, { kind: "account.login" }> & Readonly<{
    idempotencyKey: string;
  }>;
  handoffFile?: string;
  json: boolean;
  kind: "account.login-handoff";
  replayCommand: string;
}>;

export type InteractionResolveCommand = Extract<LocalCommand, { kind: "interaction.resolve" }>;

export type CliInvocation =
  | { group?: string; json: boolean; kind: "help"; leaf?: string }
  | { json: boolean; kind: "version" }
  | { kind: "status"; json: boolean }
  | { kind: "init"; yes: boolean; json: boolean }
  | { kind: "daemon.start"; json: boolean }
  | { kind: "daemon.run" }
  | { kind: "remote"; command: RemoteCliCommand; idempotencyKey?: string; json: boolean }
  | ProtectedAuthLoginCliInvocation
  | ProtectedInteractionCliInvocation
  | ProtectedInteractionInspectCliInvocation
  | AccountLoginCliInvocation
  | SessionEventFollowCliInvocation
  | SessionEventWatchCliInvocation
  | WorkApplyCliInvocation
  | WorkEventFollowCliInvocation
  | InteractionRequiredInvocation
  | ProjectionRecoveryCliInvocation
  | GatewayKeySetCliInvocation
  | { kind: "command"; command: LocalCommand; json: boolean };

/*
 * `hra autorespond gateway set` never accepts the key as an argument. The
 * parser only names the descriptor to read; the value is read once, sent to
 * the daemon, and never rendered.
 */
export type GatewayKeySetCliInvocation = Readonly<{
  input: ProtectedInputSource;
  json: boolean;
  kind: "autorespond.gateway-set";
}>;

export type RemoteCliCommand =
  | Readonly<{ kind: "remote.list"; limit: number }>
  | Readonly<{ kind: "remote.show"; session: string }>
  | Readonly<{ commandPublicId: string; kind: "remote.command" }>
  | Readonly<{ kind: "remote.send" | "remote.queue" | "remote.steer"; message: string; orSteer?: boolean; session: string }>
  | Readonly<{
      decision: "once" | "decline" | "cancel";
      interaction: string;
      kind: "remote.resolve";
      revision: number;
      session: string;
    }>
  | Readonly<{ kind: "remote.stop"; session: string }>
  | Readonly<{ kind: "remote.preset"; preset: "low" | "high" | "ultra" | "fable-max"; session: string }>
  | Readonly<{ enabled: boolean; kind: "remote.fast"; session: string }>;

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export const usage = `HRA

Usage:
  hra
  hra help [<group> [<command>]]
  hra status [--json]
  hra init [--yes] [--json]
  hra doctor [--offline] [--json]
  hra daemon start|status|stop|run
  hra account add|list|show|login|login-cancel|logout|usage|usage-history|switch|switch-recover
  hra plugin list <account> [--project <project>] [--refresh]
  hra plugin show <account> <plugin> [--project <project>] [--refresh]
  hra project add|list|use
  hra session list|show|status|watch|start|send|queue|steer|stop
  hra session task list|show|create|edit|delete
  hra session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
  hra session watch <session> [--cursor <cursor>] [--jsonl]
  hra session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]
  hra session rename|recover|abandon|archive|unarchive|note|preset|fast|project
  hra work protocol|apply|snapshot|task|poll|events|watch
  hra interaction list|show|inspect|decide|grant|answer|submit
  hra remote list|show|command|send|queue|steer|stop|resolve|preset|fast|allow|deny|policy
  hra turn inspect
  hra auth login --input-stdin|--input-fd <fd>
  hra auth status|logout
  hra auth delete --acknowledge-erasure
  hra device list|pair|approve|revoke|key-loss
  hra sync status|now
  hra sync projection recover <local-session> --acknowledge-gap

Output:
  --json                    Emit one versioned JSON result for supported commands.
  --jsonl                   Watch session events as versioned JSON Lines.
  --follow                  Follow session or work events as JSON Lines.

Interactive:
  Run bare \`hra\` in a TTY to start the persistent agent-and-human shell.

Mutation safety:
  --idempotency-key <uuid>  Reuse after a lost response; changed reuse fails closed.

Recommended profiles:
  low         Luna Max        (codex)
  high        Sol Max         (codex)
  ultra       Sol Ultra       (codex)
  fable-max   Claude Fable    (claude)

Run \`hra <group> --help\` or \`hra help <group> [<command>]\` for command examples.`;

const groupUsage = {
  status: `HRA status

Usage:
  hra status [--json]

Examples:
  hra status
  hra status --json`,
  init: `HRA init

Usage:
  hra init [--yes] [--json]

Examples:
  hra init
  hra init --yes --json`,
  doctor: `HRA doctor

Usage:
  hra doctor [--offline] [--json]

Examples:
  hra doctor --offline
  hra doctor --json`,
  daemon: `HRA daemon

Usage:
  hra daemon start [--json]
  hra daemon status|stop [--json]
  hra daemon run

Examples:
  hra daemon start
  hra daemon status --json`,
  account: `HRA account

Usage:
  hra account add <label>
  hra account login <profile> [--device-code] [--handoff-file <absolute-path>] [--idempotency-key <uuid>]
  hra account login-cancel <profile>
  hra account logout <profile>
  hra account list
  hra account show <profile>
  hra account usage [profile] [--refresh]
  hra account usage-history <profile> [--from <UTC-RFC3339>] [--through <UTC-RFC3339>] [--limit <1..100>] [--cursor <cursor>]
  hra account switch <profile>
  hra account switch-recover

Examples:
  hra account add personal
  hra account login personal --device-code --handoff-file /private/path/login.json
  hra account login-cancel personal
  hra account usage personal --refresh
  hra account usage-history personal --from 2026-08-23T12:00:00Z --json`,
  plugin: `HRA plugin

Usage:
  hra plugin list <account> [--project <project>] [--refresh]
  hra plugin show <account> <plugin> [--project <project>] [--refresh]

Plugin commands are discovery-only. Installation, enablement, and OAuth stay in Codex.

Examples:
  hra plugin list personal --refresh
  hra plugin show personal github --project jungle`,
  project: `HRA project

Usage:
  hra project add --path <directory> [--name <name>]
  hra project list
  hra project use <project>

Examples:
  hra project add --path . --name jungle
  hra project use jungle`,
  session: `HRA session
Session tasks always return to the selected conversation. They never create a standalone task or a new conversation.

Usage:
  hra session list [--account <profile>] [--archived] [--limit <1..100>] [--cursor <cursor>]
  hra session show <session> [--detail]
  hra session status <session> [--json]
  hra session state <session> [--json]
  hra autorespond on|workspace|off|default|status [--session <session>] [--json]
  hra autorespond gateway set [--from-fd <fd>] [--json]
  hra autorespond gateway clear [--json]
  hra session watch <session> [--cursor <cursor>] [--jsonl]
  hra session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
  hra session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]
  hra session start <account> [--project <project>] [--provider <codex|claude>] [--preset <low|high|ultra|fable-max>] [--fast]
  hra session send|queue|steer <session> <message>
  hra session stop|recover|abandon <session>
  hra session archive|unarchive <session>
  hra session rename <session> <name>
  hra session note get|edit|clear <session>
  hra session note set <session> <note>
  hra session preset <session> <low|high|ultra|fable-max>
  hra session fast <session> <on|off>
  hra session project <session> <project>
  hra session task list <session>
  hra session task show <session> <task-id>
  hra session task create <session> --name <name> --every-minutes <15..10080> [--paused] [--idempotency-key <uuid>] -- <prompt>
  hra session task edit <session> <task-id> --revision <n> [--name <name>] [--every-minutes <15..10080>] [--pause|--resume] [--idempotency-key <uuid>] [-- <replacement-prompt>]
  hra session task delete <session> <task-id> --revision <n> [--idempotency-key <uuid>]

Examples:
  hra session start personal --project jungle --preset high
  hra session start personal --provider claude --preset fable-max
  hra session watch my-session
  hra session watch my-session --jsonl
  hra session events my-session --wait-ms 30000 --jsonl
  hra session send my-session -- "run --help exactly"
  hra session task create my-session --name daily-review --every-minutes 1440 -- "review the release queue"`,
  work: `HRA work

Usage:
  hra work protocol [--operation <kind>|--type <name>|--topic <topic>]
  hra work apply --input-stdin|--input-fd <fd>
  hra work snapshot <work> [--actor <session>]
  hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]
  hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]
  hra work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]
  hra work watch <work> [--cursor <cursor>]

Work commands are agent-only and always emit compact JSON. Mutation documents are strict, bounded, and carry their own idempotency key. Watch emits JSON Lines.

Examples:
  hra work protocol
  hra work apply --input-stdin < request.json
  hra work poll work_0123456789abcdef0123456789abcdef --wait-ms 30000
  hra work watch work_0123456789abcdef0123456789abcdef`,
  interaction: `HRA interaction

Usage:
  hra interaction list [session] [--pending] [--limit <1..100>] [--cursor <cursor>]
  hra interaction show <interaction-id>
  hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]
  hra interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>
  hra interaction grant|answer <interaction-id> --revision <n> --input-stdin|--input-fd <fd>
  hra interaction submit <interaction-id> --revision <n> --action <accept|decline|cancel> [--input-stdin|--input-fd <fd>]

Protected values are accepted only through stdin or an explicit file descriptor.
Use \`interaction inspect\` to read complete live command or permission authority through a protected terminal or caller-owned file.
File-change callbacks without exact affected paths or change detail are rejected before admission.
Permission approvals accept an exact grant or decline; their provider callback does not represent cancel.
Permission grant document: {"permissions":["<requested-name>"]}
Question answer document: {"answers":{"<question-id>":{"answers":["<answer>"]}}}

Examples:
  hra interaction decide <id> --revision 1 --decision once
  hra interaction answer <id> --revision 1 --input-stdin`,
  remote: `HRA remote

Usage:
  hra remote list [--limit <1..100>]
  hra remote show <cloud-session>
  hra remote command <uuidv7>
  hra remote send|queue|steer <cloud-session> <message>
  hra remote stop <cloud-session>
  hra remote resolve <cloud-session> --interaction <uuid> --revision <n> --decision <once|decline|cancel>
  hra remote preset <cloud-session> <low|high|ultra|fable-max>
  hra remote fast <cloud-session> <on|off>
  hra remote allow|deny <device-commands|account-linking>
  hra remote policy

Examples:
  hra remote list
  hra remote send synced-session -- "continue the migration"
  hra remote deny device-commands
  hra remote allow account-linking
  hra remote command <uuidv7>`,
  turn: `HRA turn

Usage:
  hra turn inspect <session> <turn> [--json]

Example:
  hra turn inspect my-session turn_123 --json`,
  auth: `HRA auth

Usage:
  hra auth login --input-stdin|--input-fd <fd>
  hra auth status|logout
  hra auth delete --acknowledge-erasure

Examples:
  hra auth login --input-stdin
  hra auth status --json`,
  device: `HRA device

Usage:
  hra device list
  hra device pair
  hra device key-loss --acknowledge-no-key-holders
  hra device approve <device-id-or-prefix> --fingerprint <value> [--idempotency-key <uuidv7>] [--json]
  hra device revoke <device-id-or-prefix> [--idempotency-key <uuidv7>] [--json]

Examples:
  hra device pair
  hra device key-loss --acknowledge-no-key-holders
  hra device approve <pending-device-prefix> --fingerprint <value>`,
  sync: `HRA sync

Usage:
  hra sync status|now
  hra sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]

Examples:
  hra sync status
  hra sync projection recover my-session --acknowledge-gap`,
} as const satisfies Readonly<Record<string, string>>;

export const helpGroupNames: readonly string[] = Object.keys(groupUsage);

export type ResolvedUsage = Readonly<{ group?: string; leaf?: string; usage: string }>;

const helpSectionSeparator = "\n\n";
const usageSectionHeading = "Usage:";
const exampleSectionHeadings: ReadonlySet<string> = new Set(["Examples:", "Example:"]);

const commandLineNamesLeaf = (line: string, group: string, leaf: string): boolean => {
  const tokens = line.trim().split(/\s+/u);
  return tokens[0] === "hra"
    && tokens[1] === group
    && (tokens[2]?.split("|").includes(leaf) ?? false);
};

// Leaf help is carved from the group text until the command descriptor replaces both.
// It keeps the leaf's usage and example lines and every shared note section of the group.
const leafUsage = (group: string, groupText: string, leaf: string): string | undefined => {
  const sections = groupText.split(helpSectionSeparator);
  const usageSection = sections.find((section) => section.startsWith(`${usageSectionHeading}\n`));
  if (usageSection === undefined) return undefined;
  const usageLines = usageSection.split("\n").slice(1)
    .filter((line) => commandLineNamesLeaf(line, group, leaf));
  if (usageLines.length === 0) return undefined;
  const parts = [`HRA ${group} ${leaf}`, [usageSectionHeading, ...usageLines].join("\n")];
  for (const section of sections.slice(1)) {
    const [heading = "", ...lines] = section.split("\n");
    if (heading === usageSectionHeading) continue;
    if (exampleSectionHeadings.has(heading)) {
      const examples = lines.filter((line) => commandLineNamesLeaf(line, group, leaf));
      if (examples.length > 0) parts.push([heading, ...examples].join("\n"));
      continue;
    }
    parts.push(section);
  }
  return parts.join(helpSectionSeparator);
};

export function resolveUsage(group: string | undefined, leaf?: string): ResolvedUsage {
  if (group === undefined) return { usage };
  const selected: string | undefined = (
    groupUsage as Readonly<Partial<Record<string, string>>>
  )[group];
  if (selected === undefined) return { usage };
  if (leaf === undefined) return { group, usage: selected };
  const leafText = leafUsage(group, selected, leaf);
  return leafText === undefined
    ? { group, usage: selected }
    : { group, leaf, usage: leafText };
}

export function usageForGroup(group: string | undefined, leaf?: string): string {
  return resolveUsage(group, leaf).usage;
}

const outputModeCommandArguments = (argv: readonly string[]): readonly string[] => {
  const delimiter = argv.indexOf("--");
  const regular = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const commandArguments: string[] = [];
  for (let index = 0; index < regular.length; index += 1) {
    const value = regular[index];
    if (value === undefined) continue;
    if (value === "--idempotency-key") {
      index += 1;
      continue;
    }
    if (
      value === "--json"
      || value === "--jsonl"
      || value === "--help"
      || value === "-h"
      || value === "--version"
      || value === "-v"
    ) continue;
    commandArguments.push(value);
  }
  return commandArguments;
};

export function requestsJsonOutput(argv: readonly string[]): boolean {
  const delimiter = argv.indexOf("--");
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const command = outputModeCommandArguments(argv)[0];
  return options.includes("--json") || command === "work";
}

export function requestsJsonlOutput(argv: readonly string[]): boolean {
  const delimiter = argv.indexOf("--");
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  const commandArguments = outputModeCommandArguments(argv);
  return options.includes("--jsonl")
    || options.includes("--follow")
    || (commandArguments[0] === "work" && commandArguments[1] === "watch");
}

export function requestsWorkApplyProtocol(argv: readonly string[]): boolean {
  const commandArguments = outputModeCommandArguments(argv);
  return commandArguments[0] === "work" && commandArguments[1] === "apply";
}

type Cursor = { values: string[]; literalDelimiter: boolean };
const literalPrefix = "\u0000";
const uuidV7KeyLifetimeMs = 7 * 24 * 60 * 60 * 1_000;
const uuidV7KeyFutureSkewMs = 5 * 60 * 1_000;
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
  "session.task.create",
  "session.task.edit",
  "session.task.delete",
  "device.approve",
  "device.revoke",
]);
const literal = (value: string): string => `${literalPrefix}${value}`;
const decode = (value: string): string => value.startsWith(literalPrefix) ? value.slice(literalPrefix.length) : value;
const isOption = (value: string): boolean => !value.startsWith(literalPrefix) && value.startsWith("--");

const deviceKeyFingerprintPattern = /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/u;

const isCurrentUuidV7 = (value: string, now = Date.now()): boolean => {
  if (!isUuidV7(value) || !Number.isSafeInteger(now) || now < 0) return false;
  const timestamp = Number.parseInt(`${value.slice(0, 8)}${value.slice(9, 13)}`, 16);
  return Number.isSafeInteger(timestamp)
    && timestamp >= now - uuidV7KeyLifetimeMs
    && timestamp <= now + uuidV7KeyFutureSkewMs;
};

const take = (cursor: Cursor, label: string): string => {
  const value = cursor.values.shift();
  if (value === undefined || isOption(value)) throw new CliUsageError(`Missing ${label}.`);
  return decode(value);
};

const takeBeforeLiteralDelimiter = (cursor: Cursor, label: string): string => {
  const value = cursor.values.shift();
  if (value === undefined || isOption(value) || value.startsWith(literalPrefix)) {
    throw new CliUsageError(`Missing ${label}.`);
  }
  return value;
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

const utcRfc3339Milliseconds = (value: string | undefined, label: string): number | undefined => {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/u.exec(value);
  if (match === null) {
    throw new CliUsageError(`${label} must be a UTC RFC3339 timestamp such as 2026-08-23T12:00:00Z.`);
  }
  const milliseconds = Date.parse(value);
  const fraction = (match[2] ?? "0").padEnd(3, "0");
  const canonical = `${match[1]}.${fraction}Z`;
  if (
    !Number.isSafeInteger(milliseconds)
    || milliseconds < 0
    || new Date(milliseconds).toISOString() !== canonical
  ) {
    throw new CliUsageError(`${label} must be a valid nonnegative UTC RFC3339 timestamp.`);
  }
  return milliseconds;
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
  if (unknown !== undefined) throw new CliUsageError("Unknown option. Run `hra --help` for the supported command shape.");
  return cursor.values.splice(0).map(decode).join(" ");
};

const taskPrompt = (
  cursor: Cursor,
  label: "prompt" | "replacement prompt",
  required: boolean,
): string | undefined => {
  if (!cursor.literalDelimiter) {
    if (required || cursor.values.length > 0) {
      throw new CliUsageError(`Session task ${label} must follow the literal \`--\` delimiter.`);
    }
    return undefined;
  }
  if (cursor.values.length === 0) {
    throw new CliUsageError(`Missing session task ${label} after \`--\`.`);
  }
  if (cursor.values.some((value) => !value.startsWith(literalPrefix))) {
    throw new CliUsageError(`Session task ${label} must follow the literal \`--\` delimiter.`);
  }
  return cursor.values.splice(0).map(decode).join(" ");
};

const finish = (cursor: Cursor): void => {
  const unexpected = cursor.values[0];
  if (unexpected !== undefined) throw new CliUsageError("Unexpected argument. Run `hra --help` for the supported command shape.");
};

const finishWithoutTaskPrompt = (cursor: Cursor): void => {
  finish(cursor);
  if (cursor.literalDelimiter) {
    throw new CliUsageError("This session task command does not accept a prompt delimiter.");
  }
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

export const accountLoginReplayCommand = (
  command: Extract<LocalCommand, { kind: "account.login" }> & Readonly<{
    idempotencyKey: string;
  }>,
  handoffFile: string | undefined,
  json: boolean,
): string => [
  "hra account login",
  shellArgument(command.account),
  ...(command.deviceCode ? ["--device-code"] : []),
  "--idempotency-key",
  command.idempotencyKey,
  ...(handoffFile === undefined ? [] : ["--handoff-file", shellArgument(handoffFile)]),
  ...(json ? ["--json"] : []),
].join(" ");

export const accountLoginCancelCommand = (account: string): string =>
  `hra account login-cancel ${shellArgument(account)}`;

export const deviceMutationReplayCommand = (
  command: Extract<LocalCommand, { kind: "device.approve" | "device.revoke" }>,
  json: boolean,
): string => [
  `hra device ${command.kind === "device.approve" ? "approve" : "revoke"}`,
  shellArgument(command.device),
  ...(command.kind === "device.approve" ? ["--fingerprint", command.fingerprint] : []),
  "--idempotency-key",
  command.idempotencyKey,
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

const parseAccount = (
  cursor: Cursor,
  idempotencyKey: string | undefined,
  json: boolean,
): LocalCommand | AccountLoginCliInvocation => {
  const action = take(cursor, "account action");
  switch (action) {
    case "list": finish(cursor); return { kind: "account.list" };
    case "add": { const label = remainder(cursor, "account label"); return command({ kind: "account.add", label }); }
    case "show": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.show", account }; }
    case "login": {
      const deviceCode = flag(cursor, "--device-code");
      const handoffFile = option(cursor, "--handoff-file");
      const account = take(cursor, "account");
      finish(cursor);
      if (handoffFile !== undefined && (!isAbsolute(handoffFile) || resolve(handoffFile) !== handoffFile)) {
        throw new CliUsageError("--handoff-file must be an absolute normalized path to an existing protected file.");
      }
      const parsed = command({
        kind: "account.login",
        account,
        deviceCode,
        idempotencyKey: idempotencyKey ?? randomUUID(),
      });
      if (parsed.kind !== "account.login" || parsed.idempotencyKey === undefined) {
        throw new CliUsageError("Account login command is invalid.");
      }
      const exact = { ...parsed, idempotencyKey: parsed.idempotencyKey };
      return {
        command: exact,
        ...(handoffFile === undefined ? {} : { handoffFile }),
        json,
        kind: "account.login-handoff",
        replayCommand: accountLoginReplayCommand(
          exact,
          handoffFile ?? "/absolute/path/to/empty-protected-login.json",
          json,
        ),
      };
    }
    case "login-cancel": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.login-cancel", account }; }
    case "logout": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.logout", account }; }
    case "usage": { const refresh = flag(cursor, "--refresh"); const account = takeOptional(cursor); finish(cursor); return command({ kind: "account.usage", account, refresh }); }
    case "usage-history": {
      const fromObservedAt = utcRfc3339Milliseconds(option(cursor, "--from"), "Usage history --from");
      const throughObservedAt = utcRfc3339Milliseconds(option(cursor, "--through"), "Usage history --through");
      const limit = boundedDecimal(
        option(cursor, "--limit"),
        "usage history limit",
        1,
        ACCOUNT_USAGE_HISTORY_PAGE_LIMIT,
        50,
      );
      const historyCursor = option(cursor, "--cursor");
      const account = take(cursor, "account");
      finish(cursor);
      return command({
        kind: "account.usage-history",
        account,
        limit,
        ...(fromObservedAt === undefined ? {} : { fromObservedAt }),
        ...(throughObservedAt === undefined ? {} : { throughObservedAt }),
        ...(historyCursor === undefined ? {} : { cursor: historyCursor }),
      });
    }
    case "switch": { const account = take(cursor, "account"); finish(cursor); return { kind: "account.switch", account, idempotencyKey: randomUUID() }; }
    case "switch-recover": finish(cursor); return { kind: "account.switch-recover" };
    default: throw new CliUsageError("Unknown account action. Run `hra account --help` for supported actions.");
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
  if (
    action === "install"
    || action === "enable"
    || action === "disable"
    || action === "oauth"
    || action === "authorize"
  ) {
    throw new CliUsageError(
      `Pinned Codex ${CODEX_PIN} has no safe separated plugin lifecycle effect. Use \`plugin list\` or \`plugin show\` to inspect the exact boundary.`,
    );
  }
  throw new CliUsageError("Unknown plugin action. Run `hra plugin --help` for supported actions.");
};

const parseProject = (cursor: Cursor, cwd: string): LocalCommand => {
  const action = take(cursor, "project action");
  switch (action) {
    case "list": finish(cursor); return { kind: "project.list" };
    case "add": { const requestedPath = option(cursor, "--path") ?? take(cursor, "project directory"); const label = option(cursor, "--name") ?? takeOptional(cursor) ?? requestedPath.split("/").filter(Boolean).at(-1) ?? "Project"; finish(cursor); return command({ kind: "project.add", label, path: resolve(cwd, requestedPath) }); }
    case "use": { const project = take(cursor, "project"); finish(cursor); return { kind: "project.use", project }; }
    default: throw new CliUsageError("Unknown project action. Run `hra project --help` for supported actions.");
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
    default: throw new CliUsageError("Unknown note action. Run `hra session --help` for supported actions.");
  }
};

const parseSessionTask = (
  cursor: Cursor,
  idempotencyKey: string | undefined,
): LocalCommand => {
  const action = takeBeforeLiteralDelimiter(cursor, "task action");
  const session = takeBeforeLiteralDelimiter(cursor, "session");
  if (action === "list") {
    finishWithoutTaskPrompt(cursor);
    return { kind: "session.task.list", session };
  }
  if (action === "show") {
    const task = takeBeforeLiteralDelimiter(cursor, "task ID");
    finishWithoutTaskPrompt(cursor);
    return command({ kind: "session.task.show", session, task });
  }
  if (action === "create") {
    const name = option(cursor, "--name");
    const everyMinutes = boundedDecimal(
      option(cursor, "--every-minutes"),
      "Session task --every-minutes",
      SESSION_TASK_MIN_INTERVAL_MINUTES,
      SESSION_TASK_MAX_INTERVAL_MINUTES,
    );
    const paused = flag(cursor, "--paused");
    const prompt = taskPrompt(cursor, "prompt", true);
    return command({
      everyMinutes,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      kind: "session.task.create",
      name,
      paused,
      prompt,
      session,
    });
  }
  if (action === "edit") {
    const task = takeBeforeLiteralDelimiter(cursor, "task ID");
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Session task --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const name = option(cursor, "--name");
    const rawEveryMinutes = option(cursor, "--every-minutes");
    const everyMinutes = rawEveryMinutes === undefined
      ? undefined
      : boundedDecimal(
        rawEveryMinutes,
        "Session task --every-minutes",
        SESSION_TASK_MIN_INTERVAL_MINUTES,
        SESSION_TASK_MAX_INTERVAL_MINUTES,
      );
    const pause = flag(cursor, "--pause");
    const resume = flag(cursor, "--resume");
    if (pause && resume) {
      throw new CliUsageError("Session task --pause and --resume are mutually exclusive.");
    }
    const prompt = taskPrompt(cursor, "replacement prompt", false);
    return command({
      expectedRevision,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      kind: "session.task.edit",
      ...(name === undefined ? {} : { name }),
      ...(everyMinutes === undefined ? {} : { everyMinutes }),
      ...(prompt === undefined ? {} : { prompt }),
      ...(pause ? { status: "paused" } : resume ? { status: "active" } : {}),
      session,
      task,
    });
  }
  if (action === "delete") {
    const task = takeBeforeLiteralDelimiter(cursor, "task ID");
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "Session task --revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    finishWithoutTaskPrompt(cursor);
    return command({
      expectedRevision,
      idempotencyKey: idempotencyKey ?? randomUUID(),
      kind: "session.task.delete",
      session,
      task,
    });
  }
  throw new CliUsageError("Unknown session task action. Run `hra session --help` for supported actions.");
};

const parseSession = (
  cursor: Cursor,
  jsonl: boolean,
  idempotencyKey: string | undefined,
): LocalCommand | SessionEventFollowCliInvocation | SessionEventWatchCliInvocation => {
  const action = take(cursor, "session action");
  switch (action) {
    case "list": {
      const account = option(cursor, "--account");
      const archived = flag(cursor, "--archived");
      const limit = boundedDecimal(option(cursor, "--limit"), "session limit", 1, 100, 50);
      const sessionCursor = option(cursor, "--cursor");
      finish(cursor);
      return command({ kind: "session.list", account, archived, limit, cursor: sessionCursor });
    }
    case "show": { const detail = flag(cursor, "--detail"); const session = take(cursor, "session"); finish(cursor); return { kind: "session.show", session, detail }; }
    case "status": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.status", session }; }
    case "state": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.state", session }; }
    case "events": {
      const followFlag = flag(cursor, "--follow");
      const follow = followFlag || jsonl;
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
    case "watch": {
      const eventCursor = option(cursor, "--cursor");
      const session = take(cursor, "session");
      finish(cursor);
      const parsed = command({
        kind: "session.events",
        session,
        cursor: eventCursor,
        limit: 200,
        waitMs: 30_000,
      });
      if (parsed.kind !== "session.events") throw new CliUsageError("Session watch command is invalid.");
      return { command: parsed, jsonl, kind: "session.events.watch" };
    }
    case "interactions": {
      const pending = flag(cursor, "--pending");
      const limit = boundedDecimal(option(cursor, "--limit"), "interaction limit", 1, 100, 100);
      const interactionCursor = option(cursor, "--cursor");
      const session = take(cursor, "session");
      finish(cursor);
      return command({ kind: "session.interactions", session, pending, limit, cursor: interactionCursor });
    }
    case "start": {
      const project = option(cursor, "--project");
      const provider = option(cursor, "--provider") ?? "codex";
      if (provider !== "codex" && provider !== "claude") {
        throw new CliUsageError("Provider must be `codex` or `claude`.");
      }
      // The provider chooses the default preset, so an unchanged `hra session
      // start` keeps its exact Codex behaviour.
      const preset = option(cursor, "--preset") ?? (provider === "claude" ? "fable-max" : "high");
      const fast = flag(cursor, "--fast");
      const account = take(cursor, "account");
      finish(cursor);
      return command({ kind: "session.start", account, project, provider, preset, fast });
    }
    case "send": { const session = take(cursor, "session"); return command({ kind: "session.send", session, message: remainder(cursor, "message") }); }
    case "queue": { const session = take(cursor, "session"); return command({ kind: "session.queue", session, message: remainder(cursor, "message") }); }
    case "steer": { const session = take(cursor, "session"); return command({ kind: "session.steer", session, message: remainder(cursor, "message") }); }
    case "stop": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.stop", session }; }
    case "rename": { const session = take(cursor, "session"); return command({ kind: "session.rename", session, name: remainder(cursor, "name") }); }
    case "archive": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.archive", session, archived: true }; }
    case "unarchive": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.archive", session, archived: false }; }
    case "recover": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.recover", session }; }
    case "abandon": { const session = take(cursor, "session"); finish(cursor); return { kind: "session.abandon", session }; }
    case "note": return parseSessionNote(cursor);
    case "preset": { const session = take(cursor, "session"); const preset = take(cursor, "preset"); finish(cursor); return command({ kind: "session.preset", session, preset }); }
    case "fast": { const session = take(cursor, "session"); const value = take(cursor, "on or off"); finish(cursor); if (value !== "on" && value !== "off") throw new CliUsageError("Fast must be `on` or `off`."); return { kind: "session.fast", session, enabled: value === "on" }; }
    case "project": { const session = take(cursor, "session"); const project = take(cursor, "project"); finish(cursor); return { kind: "session.project", session, project }; }
    case "task": return parseSessionTask(cursor, idempotencyKey);
    default: throw new CliUsageError("Unknown session action. Run `hra session --help` for supported actions.");
  }
};

const parseWork = (
  cursor: Cursor,
  jsonl: boolean,
): LocalCommand | WorkApplyCliInvocation | WorkEventFollowCliInvocation => {
  const action = take(cursor, "work action");
  switch (action) {
    case "protocol":
      if (jsonl) throw new CliUsageError("work protocol emits one JSON document, not JSON Lines.");
      {
        const operation = option(cursor, "--operation");
        const typeName = option(cursor, "--type");
        const topic = option(cursor, "--topic");
        const selectors = [operation, typeName, topic].filter((value) => value !== undefined);
        if (selectors.length > 1) {
          throw new CliUsageError("Use at most one work protocol selector: --operation, --type, or --topic.");
        }
        const query = operation !== undefined
          ? { kind: "operation" as const, operation }
          : typeName !== undefined
            ? { kind: "type" as const, name: typeName }
            : topic !== undefined
              ? { kind: "topic" as const, topic }
              : { kind: "index" as const };
        const parsedQuery = workProtocolQuerySchema.safeParse(query);
        if (!parsedQuery.success) {
          throw new CliUsageError(parsedQuery.error.issues[0]?.message ?? "Invalid work protocol selector.");
        }
        finish(cursor);
        return { kind: "work.protocol", query: parsedQuery.data };
      }
    case "apply": {
      if (jsonl) throw new CliUsageError("work apply emits one JSON document, not JSON Lines.");
      const input = protectedInput(cursor, true);
      finish(cursor);
      if (input === undefined) throw new CliUsageError("Work apply requires --input-stdin or --input-fd.");
      return { input, json: true, kind: "work.apply-input" };
    }
    case "snapshot": {
      if (jsonl) throw new CliUsageError("work snapshot emits one JSON document, not JSON Lines.");
      const actor = option(cursor, "--actor");
      const work = take(cursor, "work");
      finish(cursor);
      return command({ kind: "work.snapshot", work, actor });
    }
    case "task": {
      if (jsonl) throw new CliUsageError("work task emits one JSON document, not JSON Lines.");
      const rawHistoryLimit = option(cursor, "--history-limit");
      const historyCursor = option(cursor, "--history-cursor");
      const task = take(cursor, "task");
      finish(cursor);
      if (rawHistoryLimit === undefined && historyCursor === undefined) {
        return command({ kind: "work.task", task });
      }
      const historyLimit = boundedDecimal(
        rawHistoryLimit,
        "work task history limit",
        1,
        WORK_TASK_HISTORY_ITEM_LIMIT,
        WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
      );
      return command({
        kind: "work.task",
        task,
        historyLimit,
        ...(historyCursor === undefined ? {} : { historyCursor }),
      });
    }
    case "poll": {
      if (jsonl) throw new CliUsageError("work poll emits one JSON document, not JSON Lines.");
      const actor = option(cursor, "--actor");
      const pollCursor = option(cursor, "--cursor");
      const actionCursor = option(cursor, "--action-cursor");
      const limit = boundedDecimal(option(cursor, "--limit"), "work poll limit", 1, 50, 20);
      const waitMs = boundedDecimal(option(cursor, "--wait-ms"), "work poll wait", 0, 30_000, 0);
      if (actionCursor !== undefined && waitMs !== 0) {
        throw new CliUsageError("A continued work action page requires --wait-ms 0.");
      }
      const work = take(cursor, "work");
      finish(cursor);
      return command({
        kind: "work.poll",
        work,
        actor,
        cursor: pollCursor,
        actionCursor,
        limit,
        waitMs,
      });
    }
    case "events":
    case "watch": {
      if (
        action === "watch"
        && ["--limit", "--wait-ms", "--follow"].some((optionName) =>
          cursor.values.includes(optionName))
      ) {
        throw new CliUsageError("work watch supports only <work>, --cursor, and --jsonl.");
      }
      const eventCursor = option(cursor, "--cursor");
      const followFlag = flag(cursor, "--follow");
      const follow = action === "watch" || jsonl || followFlag;
      const limit = boundedDecimal(option(cursor, "--limit"), "work event limit", 1, 200, 200);
      const waitMs = boundedDecimal(
        option(cursor, "--wait-ms"),
        "work event wait",
        0,
        30_000,
        follow ? 30_000 : 0,
      );
      if (follow && waitMs === 0) {
        throw new CliUsageError("Following work events requires --wait-ms from 1 to 30000.");
      }
      const work = take(cursor, "work");
      finish(cursor);
      const parsed = command({
        kind: "work.events",
        work,
        cursor: eventCursor,
        limit,
        waitMs,
      });
      if (parsed.kind !== "work.events") throw new CliUsageError("Work event command is invalid.");
      return follow
        ? { command: parsed, jsonl: true, kind: "work.events.follow" }
        : parsed;
    }
    default:
      throw new CliUsageError("Unknown work action. Run `hra work --help` for supported actions.");
  }
};

type ParsedInteraction =
  | Readonly<{ command: LocalCommand; kind: "command" }>
  | ProtectedInteractionCliInvocation
  | ProtectedInteractionInspectCliInvocation;

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
    const interactionCursor = option(cursor, "--cursor");
    const session = takeOptional(cursor);
    finish(cursor);
    return { command: command({ kind: "interaction.list", session, pending, limit, cursor: interactionCursor }), kind: "command" };
  }
  if (action === "show") {
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    return { command: command({ kind: "interaction.show", interaction }), kind: "command" };
  }

  if (action === "inspect") {
    const expectedRevision = boundedDecimal(
      option(cursor, "--revision"),
      "interaction revision",
      1,
      Number.MAX_SAFE_INTEGER,
    );
    const handoffFile = option(cursor, "--handoff-file");
    const interaction = take(cursor, "interaction ID");
    finish(cursor);
    if (handoffFile !== undefined && (!isAbsolute(handoffFile) || resolve(handoffFile) !== handoffFile)) {
      throw new CliUsageError("--handoff-file must be an absolute normalized path to an existing protected file.");
    }
    const parsed = command({
      kind: "interaction.inspect",
      interaction,
      expectedRevision,
    });
    if (parsed.kind !== "interaction.inspect") {
      throw new CliUsageError("Protected interaction inspection is invalid.");
    }
    return {
      command: parsed,
      ...(handoffFile === undefined ? {} : { handoffFile }),
      json,
      kind: "interaction.inspect-protected",
    };
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
  throw new CliUsageError("Unknown interaction action. Run `hra interaction --help` for supported actions.");
};

/**
 * `hra remote allow|deny <switch>` and `hra remote policy`. These are local
 * daemon commands, so they are peeled off before the cloud remote parser sees
 * the cursor; `null` means this is an ordinary remote action.
 */
const parseRemotePolicy = (cursor: Cursor): LocalCommand | null => {
  const action = cursor.values[0];
  if (action !== "allow" && action !== "deny" && action !== "policy") return null;
  cursor.values.shift();
  if (action === "policy") {
    finish(cursor);
    return { kind: "remote.policy-status" };
  }
  const target = take(cursor, "remote switch");
  finish(cursor);
  if (target !== "device-commands" && target !== "account-linking") {
    throw new CliUsageError(
      "Unknown remote switch. Use `device-commands` or `account-linking`.",
    );
  }
  return { allowed: action === "allow", kind: "remote.policy-set", switch: target };
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
      const orSteer = action === "send" && flag(cursor, "--or-steer");
      const session = take(cursor, "session");
      const message = remainder(cursor, "message");
      if (message.length > 64_000) throw new CliUsageError("Remote message is too long.");
      return orSteer
        ? { kind: "remote.send", session, message, orSteer: true }
        : { kind: `remote.${action}`, session, message };
    }
    case "resolve": {
      const interaction = option(cursor, "--interaction");
      const revisionValue = option(cursor, "--revision");
      const decision = option(cursor, "--decision");
      const session = take(cursor, "session");
      finish(cursor);
      if (interaction === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(interaction)) {
        throw new CliUsageError("Remote resolve requires --interaction <uuid>.");
      }
      const revision = Number(revisionValue);
      if (revisionValue === undefined || !/^[1-9]\d{0,15}$/u.test(revisionValue) || !Number.isSafeInteger(revision)) {
        throw new CliUsageError("Remote resolve requires --revision <positive integer>.");
      }
      if (decision !== "once" && decision !== "decline" && decision !== "cancel") {
        throw new CliUsageError("Remote resolve requires --decision once|decline|cancel.");
      }
      return { decision, interaction, kind: "remote.resolve", revision, session };
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
      if (preset !== "low" && preset !== "high" && preset !== "ultra" && preset !== "fable-max") {
        throw new CliUsageError("Preset must be `low`, `high`, `ultra`, or `fable-max`.");
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
    default: throw new CliUsageError("Unknown remote action. Run `hra remote --help` for supported actions.");
  }
};

export function parseCli(argv: readonly string[], cwd = process.cwd()): CliInvocation {
  const delimiter = argv.indexOf("--");
  const regular = delimiter < 0 ? [...argv] : argv.slice(0, delimiter);
  const literalTail = delimiter < 0 ? [] : argv.slice(delimiter + 1).map(literal);
  const cursor: Cursor = { literalDelimiter: delimiter >= 0, values: regular };
  const json = flag(cursor, "--json");
  const jsonl = flag(cursor, "--jsonl");
  if (json && jsonl) {
    throw new CliUsageError("--json and --jsonl are mutually exclusive output modes.");
  }
  const idempotencyKey = option(cursor, "--idempotency-key");
  const helpFlag = flag(cursor, "--help") || flag(cursor, "-h");
  const helpAlias = !helpFlag && cursor.values[0] === "help";
  if (helpFlag || helpAlias || (cursor.values.length === 0 && literalTail.length === 0)) {
    const [group, leaf] = helpAlias ? cursor.values.slice(1, 3) : cursor.values.slice(0, 2);
    return {
      kind: "help",
      json,
      ...(group === undefined ? {} : { group }),
      ...(leaf === undefined ? {} : { leaf }),
    };
  }
  if (flag(cursor, "--version") || flag(cursor, "-v")) { finish(cursor); return { json, kind: "version" }; }
  cursor.values.push(...literalTail);
  const group = take(cursor, "command");
  if (jsonl && group !== "session" && group !== "work") {
    throw new CliUsageError(
      "--jsonl is supported only by `hra session events` and `hra session watch`, or by `hra work events` and `hra work watch`.",
    );
  }
  if (group === "status") {
    finish(cursor);
    if (idempotencyKey !== undefined) {
      throw new CliUsageError("--idempotency-key is not supported by status.");
    }
    return { kind: "status", json };
  }
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
    throw new CliUsageError("Unknown daemon action. Run `hra daemon --help` for supported actions.");
  }
  if (group === "remote") {
    // The two policy switches are local daemon state, not a hosted command, so
    // they route to the daemon like `autorespond` rather than through the cloud
    // remote invocation. Nothing hosted can set them.
    const policy = parseRemotePolicy(cursor);
    if (policy !== null) {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by remote policy commands.");
      }
      return { kind: "command", command: policy, json };
    }
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
  if (group === "autorespond") {
    const action = take(cursor, "autorespond action");
    if (action === "gateway") {
      const gatewayAction = take(cursor, "autorespond gateway action");
      const descriptor = option(cursor, "--from-fd");
      finish(cursor);
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by autorespond.");
      }
      if (gatewayAction === "clear") {
        if (descriptor !== undefined) {
          throw new CliUsageError("--from-fd is not supported by `autorespond gateway clear`.");
        }
        return { kind: "command", command: { kind: "autorespond.gateway-clear" }, json };
      }
      if (gatewayAction !== "set") {
        throw new CliUsageError("Unknown autorespond gateway action. Use `set` or `clear`.");
      }
      if (descriptor === undefined) {
        return { input: { kind: "stdin" }, json, kind: "autorespond.gateway-set" };
      }
      const fd = boundedDecimal(descriptor, "gateway key file descriptor", 0, 1_048_575);
      if (fd === 1 || fd === 2) {
        throw new CliUsageError("The gateway key cannot be read from stdout or stderr.");
      }
      return { input: { fd, kind: "fd" }, json, kind: "autorespond.gateway-set" };
    }
    const session = option(cursor, "--session");
    finish(cursor);
    if (idempotencyKey !== undefined) throw new CliUsageError("--idempotency-key is not supported by autorespond.");
    if (action === "status") {
      return { kind: "command", command: { kind: "autorespond.status", ...(session === undefined ? {} : { session }) }, json };
    }
    const mode = action === "on"
      ? "auto:all"
      : action === "workspace"
        ? "auto:workspace"
        : action === "off"
          ? "manual"
          : action === "default"
            ? null
            : undefined;
    if (mode === undefined) {
      throw new CliUsageError("Unknown autorespond action. Use `on`, `workspace`, `off`, `default`, `status`, or `gateway`.");
    }
    if (mode === null && session === undefined) {
      throw new CliUsageError("`autorespond default` clears a session override; pass --session <session>.");
    }
    return { kind: "command", command: { kind: "autorespond.set", mode, ...(session === undefined ? {} : { session }) }, json };
  }
  let parsed: LocalCommand;
  if (group === "account") {
    const account = parseAccount(cursor, idempotencyKey, json);
    if (account.kind === "account.login-handoff") return account;
    parsed = account;
  }
  else if (group === "plugin") parsed = parsePlugin(cursor);
  else if (group === "project") parsed = parseProject(cursor, cwd);
  else if (group === "session") {
    const sessionCommand = parseSession(cursor, jsonl, idempotencyKey);
    if (sessionCommand.kind === "session.events.follow") {
      if (json) {
        throw new CliUsageError("Event following is already JSON Lines and cannot be combined with --json.");
      }
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by session.events.");
      }
      return sessionCommand;
    }
    if (sessionCommand.kind === "session.events.watch") {
      if (json) {
        throw new CliUsageError("Session watch does not support --json. Use --jsonl for machine output.");
      }
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by session.watch.");
      }
      return sessionCommand;
    }
    if (jsonl) {
      throw new CliUsageError("--jsonl is supported only by `hra session events` and `hra session watch`.");
    }
    parsed = sessionCommand;
  }
  else if (group === "work") {
    if (idempotencyKey !== undefined) {
      throw new CliUsageError("Work mutations carry one idempotencyKey inside the strict input document.");
    }
    const workCommand = parseWork(cursor, jsonl);
    if (workCommand.kind === "work.apply-input" || workCommand.kind === "work.events.follow") {
      if (json && workCommand.kind === "work.events.follow") {
        throw new CliUsageError("Work event following is already JSON Lines and cannot be combined with --json.");
      }
      return workCommand;
    }
    return { kind: "command", command: workCommand, json: true };
  }
  else if (group === "turn") { const action = take(cursor, "turn action"); if (action !== "inspect") throw new CliUsageError("Unknown turn action. Run `hra turn --help` for supported actions."); const session = take(cursor, "session"); const turn = take(cursor, "turn"); finish(cursor); parsed = { kind: "turn.inspect", session, turn }; }
  else if (group === "interaction") {
    const interaction = parseInteraction(cursor, json);
    if (interaction.kind === "interaction.inspect-protected") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by interaction.inspect.");
      }
      return interaction;
    }
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
      throw new CliUsageError("Unknown auth action. Run `hra auth --help` for supported actions.");
    }
  }
  else if (group === "device") {
    const action = take(cursor, "device action");
    if (action === "list" || action === "pair") {
      finish(cursor);
      parsed = { kind: `device.${action}` };
    } else if (action === "key-loss") {
      if (idempotencyKey !== undefined) {
        throw new CliUsageError("--idempotency-key is not supported by device key-loss.");
      }
      const acknowledgeNoKeyHolders = flag(cursor, "--acknowledge-no-key-holders");
      finish(cursor);
      if (!acknowledgeNoKeyHolders) {
        throw new CliUsageError("Account-key loss acknowledgement requires --acknowledge-no-key-holders.");
      }
      parsed = {
        acknowledgeNoKeyHolders: true,
        kind: "device.key-loss",
      };
    } else if (action === "approve" || action === "revoke") {
      const device = take(cursor, "device");
      // Approval binds to the key fingerprint the operator was shown, so an
      // enrolling device cannot substitute another key pair behind its ID.
      const fingerprint = action === "approve" ? option(cursor, "--fingerprint") : undefined;
      finish(cursor);
      if (action === "approve" && fingerprint === undefined) {
        throw new CliUsageError("Device approval requires --fingerprint <value> from hra device list.");
      }
      if (fingerprint !== undefined && !deviceKeyFingerprintPattern.test(fingerprint)) {
        throw new CliUsageError("Device approval --fingerprint must be eight lower-case hex groups of four separated by hyphens.");
      }
      const deviceMutationKey = idempotencyKey ?? createCloudUuidV7();
      if (!isCurrentUuidV7(deviceMutationKey)) {
        throw new CliUsageError("Device mutation --idempotency-key must be a current UUIDv7.");
      }
      parsed = action === "approve" && fingerprint !== undefined
        ? { device, fingerprint, idempotencyKey: deviceMutationKey, kind: "device.approve" }
        : { device, idempotencyKey: deviceMutationKey, kind: "device.revoke" };
    } else {
      throw new CliUsageError("Unknown device action. Run `hra device --help` for supported actions.");
    }
  }
  else if (group === "sync") {
    const action = take(cursor, "sync action");
    if (action === "status" || action === "now") {
      finish(cursor);
      parsed = { kind: `sync.${action}` };
    } else if (action === "projection") {
      const projectionAction = take(cursor, "projection action");
      if (projectionAction !== "recover") {
        throw new CliUsageError("Unknown projection action. Run `hra sync --help` for supported actions.");
      }
      const acknowledgeGap = flag(cursor, "--acknowledge-gap");
      const session = take(cursor, "local session");
      finish(cursor);
      const recoveryKey = idempotencyKey ?? createCloudUuidV7();
      if (
        (idempotencyKey === undefined && !isCurrentUuidV7(recoveryKey))
        || (idempotencyKey !== undefined && !isUuidV7(recoveryKey))
      ) {
        throw new CliUsageError("Projection recovery --idempotency-key must be a canonical UUIDv7.");
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
      throw new CliUsageError("Unknown sync action. Run `hra sync --help` for supported actions.");
    }
  }
  else throw new CliUsageError("Unknown command. Run `hra --help` for supported commands.");
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
