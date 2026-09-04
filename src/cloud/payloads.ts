import {
  cloudLimits,
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  hasExactKeys,
  isOpaqueIdentifier,
  isRecord,
  type CommandKind,
  type DeviceCommandKind,
  type EncryptedEnvelope,
} from "./contracts";
import { decryptBytes, encryptBytes } from "./crypto";
import { isModelPreset, type ModelPreset } from "./projection";
import {
  parseUsageEncryptedEnvelope,
  parseUsageProjection,
  type UsageProjection,
} from "./usage";

// Interaction identifiers are provider-brokered UUIDs (see
// `src/domain/interactions.ts`, `z.string().uuid()`) that are not necessarily
// UUIDv7, so this checks the generic RFC 4122 shape rather than reusing the
// stricter `isUuidV7` idempotency-key check.
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function isInteractionId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isRemoteInteractionAnswerMap(
  value: unknown,
): value is Readonly<Record<string, Readonly<{ answers: readonly string[] }>>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 20) return false;
  return entries.every(([questionId, answer]) =>
    questionId.length >= 1
    && questionId.length <= 512
    && isRecord(answer)
    && hasExactKeys(answer, ["answers"])
    && Array.isArray(answer.answers)
    && answer.answers.length <= 20
    && answer.answers.every((entry) =>
      typeof entry === "string"
      && entry.length <= 16_384
      && !containsAbsolutePath(entry)
      && !containsUnsafeTerminalScalar(entry, true)));
}

export type ResolveInteractionDecisionPayload = Readonly<{
  decision: "once" | "decline" | "cancel";
  interactionId: string;
  kind: "resolve_interaction";
  revision: number;
}>;

export type ResolveInteractionAnswersPayload = Readonly<{
  answers: Readonly<Record<string, Readonly<{ answers: readonly string[] }>>>;
  interactionId: string;
  kind: "resolve_interaction";
  revision: number;
}>;

export type RemoteCommandPayload =
  | Readonly<{ kind: "send" | "queue" | "steer" | "send_or_steer"; message: string }>
  | Readonly<{ kind: "stop" }>
  | Readonly<{ kind: "set_model"; preset: ModelPreset }>
  | Readonly<{ enabled: boolean; kind: "set_fast" }>
  | ResolveInteractionDecisionPayload
  | ResolveInteractionAnswersPayload
  | Readonly<{
      kind: "set_approval_mode";
      mode: "auto:all" | "auto:workspace" | "manual";
      scope: "session" | "default";
    }>
  | Readonly<{ enabled: boolean; kind: "set_show_thinking"; scope: "session" | "default" }>
  | Readonly<{ kind: "set_default_preset"; preset: ModelPreset }>
  | Readonly<{ archived: boolean; kind: "archive_session" }>
  | Readonly<{ kind: "rename_session"; name: string | null }>
  | Readonly<{ key: string; kind: "set_gateway_key" }>;

/**
 * Device command payloads. Addressing is by cloud public id only: a project is
 * named by the `publicId` the device registry already projects, never by a
 * filesystem path, and `containsAbsolutePath` refuses one anyway.
 *
 * `account_login_status` deliberately carries no account: a device relays at
 * most one login at a time, so the poll asks "what is happening on this
 * machine", which also keeps the polled account out of the projection.
 */
export type DeviceCommandPayload =
  | Readonly<{
      accountPublicId: string;
      kind: "session_start";
      preset: "low" | "high" | "ultra";
      projectPublicId: string;
      prompt: string;
      provider: "codex" | "claude";
    }>
  | Readonly<{ accountPublicId: string; kind: "account_login_start" }>
  | Readonly<{ kind: "account_login_status" }>
  | Readonly<{ kind: "usage_refresh" }>;

export type DeviceCommandLoginStatus =
  | "idle"
  | "pending"
  | "relay_unavailable"
  | "signed_in"
  | "failed";

/**
 * What the daemon settles back to the requesting browser. `account_login_start`
 * returns a relayed provider login URL: it is encrypted under the account key
 * like every other payload, carries its own short expiry, and the hosted row
 * releases it exactly once (`deviceCommands:consumeResult`).
 */
export type DeviceCommandResultPayload =
  | Readonly<{ kind: "session_start"; sessionPublicId: string }>
  | Readonly<{ expiresAt: number; kind: "account_login_start"; loginUrl: string }>
  | Readonly<{
      instruction: string;
      kind: "account_login_status";
      status: DeviceCommandLoginStatus;
    }>
  | Readonly<{ accountsRefreshed: number; kind: "usage_refresh" }>;

export const deviceCommandLimits = Object.freeze({
  instructionCharacters: 512,
  loginUrlCharacters: 2_048,
  promptCharacters: 16_000,
} as const);

// The relay is a provider login URL and nothing else: https only, no
// credentials in the authority, no embedded fragment, and bounded.
export function isRelayedLoginUrl(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 12
    || value.length > deviceCommandLimits.loginUrlCharacters
    || containsUnsafeTerminalScalar(value)
  ) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.hostname.length > 0
    && parsed.href === value;
}

export function parseDeviceCommandPayload(value: unknown): DeviceCommandPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "session_start"
    && hasExactKeys(value, [
      "accountPublicId",
      "kind",
      "preset",
      "projectPublicId",
      "prompt",
      "provider",
    ])
    && isOpaqueIdentifier(value.accountPublicId)
    && isOpaqueIdentifier(value.projectPublicId)
    && (value.preset === "low" || value.preset === "high" || value.preset === "ultra")
    && (value.provider === "codex" || value.provider === "claude")
    && typeof value.prompt === "string"
    && value.prompt.length >= 1
    && value.prompt.length <= deviceCommandLimits.promptCharacters
    && !containsAbsolutePath(value.prompt)
    && !containsUnsafeTerminalScalar(value.prompt, true)
  ) {
    return {
      accountPublicId: value.accountPublicId,
      kind: value.kind,
      preset: value.preset,
      projectPublicId: value.projectPublicId,
      prompt: value.prompt,
      provider: value.provider,
    };
  }
  if (
    value.kind === "account_login_start"
    && hasExactKeys(value, ["accountPublicId", "kind"])
    && isOpaqueIdentifier(value.accountPublicId)
  ) return { accountPublicId: value.accountPublicId, kind: value.kind };
  if (
    (value.kind === "account_login_status" || value.kind === "usage_refresh")
    && hasExactKeys(value, ["kind"])
  ) return { kind: value.kind };
  return null;
}

export function deviceCommandPayloadKind(payload: DeviceCommandPayload): DeviceCommandKind {
  return payload.kind;
}

export function parseDeviceCommandResultPayload(
  value: unknown,
): DeviceCommandResultPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "session_start"
    && hasExactKeys(value, ["kind", "sessionPublicId"])
    && isOpaqueIdentifier(value.sessionPublicId)
  ) return { kind: value.kind, sessionPublicId: value.sessionPublicId };
  if (
    value.kind === "account_login_start"
    && hasExactKeys(value, ["expiresAt", "kind", "loginUrl"])
    && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) > 0
    && isRelayedLoginUrl(value.loginUrl)
  ) {
    return {
      expiresAt: value.expiresAt as number,
      kind: value.kind,
      loginUrl: value.loginUrl,
    };
  }
  if (
    value.kind === "account_login_status"
    && hasExactKeys(value, ["instruction", "kind", "status"])
    && typeof value.instruction === "string"
    && value.instruction.length >= 1
    && value.instruction.length <= deviceCommandLimits.instructionCharacters
    && !containsAbsolutePath(value.instruction)
    && !containsUnsafeTerminalScalar(value.instruction)
    && (value.status === "idle"
      || value.status === "pending"
      || value.status === "relay_unavailable"
      || value.status === "signed_in"
      || value.status === "failed")
  ) {
    return { instruction: value.instruction, kind: value.kind, status: value.status };
  }
  if (
    value.kind === "usage_refresh"
    && hasExactKeys(value, ["accountsRefreshed", "kind"])
    && Number.isSafeInteger(value.accountsRefreshed)
    && (value.accountsRefreshed as number) >= 0
    && (value.accountsRefreshed as number) <= deviceRegistryLimits.accounts
  ) {
    return { accountsRefreshed: value.accountsRefreshed as number, kind: value.kind };
  }
  return null;
}

export type SessionMetadataPayload = Readonly<{
  archived?: boolean;
  name: string | null;
  note: string | null;
}>;

export type DeviceRegistryAccount = Readonly<{
  label: string;
  provider: "codex" | "claude";
  publicId: string;
  status: "login_pending" | "recovery_required" | "signed_in" | "signed_out";
}>;

export type DeviceRegistryProject = Readonly<{ label: string; publicId: string }>;

export type DeviceRegistryScheduledTask = Readonly<{
  cadence: string;
  id: string;
  kind: "codex_automation" | "hra_conversation";
  label: string;
  nextRunAt: number | null;
  sessionPublicId: string | null;
}>;

/**
 * One device's settings projection: what the web settings screen needs to
 * render machines, accounts, projects, scheduled tasks, and the daemon's
 * current defaults without decrypting any session. Every human-readable
 * field is a label; filesystem paths are refused by the parser, so a project
 * root or an automation working directory can never reach the projection.
 */
export type DeviceRegistryPayload = Readonly<{
  accounts: readonly DeviceRegistryAccount[];
  // Additive optional switches (W3 device commands). A registry written before
  // device commands existed carries neither key; absent means the conservative
  // reading, which is also the shipped default: the machine executes device
  // commands, and it will not relay an account login.
  accountLinkingAllowed?: boolean;
  daemonVersion: string;
  defaultApprovalMode: "auto:all" | "auto:workspace" | "manual";
  defaultPreset: ModelPreset;
  deviceCommandsAllowed?: boolean;
  heartbeatAt: number;
  machineLabel: string;
  projects: readonly DeviceRegistryProject[];
  proseAutorespondConfigured: boolean;
  scheduledTasks: readonly DeviceRegistryScheduledTask[];
  showThinkingDefault: boolean;
  version: 1;
}>;

export const deviceRegistryLimits = Object.freeze({
  accounts: 100,
  cadenceCharacters: 512,
  labelCharacters: 200,
  projects: 200,
  scheduledTaskIdCharacters: 200,
  scheduledTasks: 200,
  versionCharacters: 64,
} as const);

export type CloudPayloadAuthority = Readonly<{
  entityPublicId: string;
  keyVersion: number;
  kind:
    | "command"
    | "device_command"
    | "device_command_result"
    | "device_registry"
    | "session_metadata"
    | "usage";
  userPublicId: string;
}>;

export function parseRemoteCommandPayload(value: unknown): RemoteCommandPayload | null {
  if (!isRecord(value)) return null;
  if (
    (value.kind === "send" || value.kind === "queue" || value.kind === "steer"
      || value.kind === "send_or_steer")
    && hasExactKeys(value, ["kind", "message"])
    && typeof value.message === "string"
    && value.message.length >= 1
    && value.message.length <= 64_000
    && !containsAbsolutePath(value.message)
    && !containsUnsafeTerminalScalar(value.message, true)
  ) return { kind: value.kind, message: value.message };
  if (value.kind === "stop" && hasExactKeys(value, ["kind"])) return { kind: value.kind };
  if (
    value.kind === "set_model"
    && hasExactKeys(value, ["kind", "preset"])
    && isModelPreset(value.preset)
  ) return { kind: value.kind, preset: value.preset };
  if (
    value.kind === "set_fast"
    && hasExactKeys(value, ["enabled", "kind"])
    && typeof value.enabled === "boolean"
  ) return { enabled: value.enabled, kind: value.kind };
  if (
    value.kind === "resolve_interaction"
    && isInteractionId(value.interactionId)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) > 0
  ) {
    if (
      hasExactKeys(value, ["decision", "interactionId", "kind", "revision"])
      && (value.decision === "once" || value.decision === "decline" || value.decision === "cancel")
    ) {
      return {
        decision: value.decision,
        interactionId: value.interactionId,
        kind: value.kind,
        revision: value.revision as number,
      };
    }
    if (
      hasExactKeys(value, ["answers", "interactionId", "kind", "revision"])
      && isRemoteInteractionAnswerMap(value.answers)
    ) {
      return {
        answers: value.answers,
        interactionId: value.interactionId,
        kind: value.kind,
        revision: value.revision as number,
      };
    }
  }
  if (
    value.kind === "set_approval_mode"
    && hasExactKeys(value, ["kind", "mode", "scope"])
    && (value.mode === "auto:all" || value.mode === "auto:workspace" || value.mode === "manual")
    && (value.scope === "session" || value.scope === "default")
  ) return { kind: value.kind, mode: value.mode, scope: value.scope };
  if (
    value.kind === "set_show_thinking"
    && hasExactKeys(value, ["enabled", "kind", "scope"])
    && typeof value.enabled === "boolean"
    && (value.scope === "session" || value.scope === "default")
  ) return { enabled: value.enabled, kind: value.kind, scope: value.scope };
  if (
    value.kind === "set_default_preset"
    && hasExactKeys(value, ["kind", "preset"])
    && isModelPreset(value.preset)
  ) return { kind: value.kind, preset: value.preset };
  if (
    value.kind === "archive_session"
    && hasExactKeys(value, ["archived", "kind"])
    && typeof value.archived === "boolean"
  ) return { archived: value.archived, kind: value.kind };
  if (
    value.kind === "rename_session"
    && hasExactKeys(value, ["kind", "name"])
    && (value.name === null || isRemoteSessionName(value.name))
  ) return { kind: value.kind, name: value.name };
  // The gateway key itself never enters a journal entry, an evidence row, a
  // log line, or a result: only its shape is checked here, and the daemon
  // hands it straight to local secret custody.
  if (
    value.kind === "set_gateway_key"
    && hasExactKeys(value, ["key", "kind"])
    && isGatewayKeyShape(value.key)
  ) return { key: value.key, kind: value.kind };
  return null;
}

function isRemoteSessionName(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 160
    && !containsAbsolutePath(value)
    && !containsUnsafeTerminalScalar(value);
}

const gatewayKeyPattern = /^[\x21-\x7e]{8,512}$/u;

function isGatewayKeyShape(value: unknown): value is string {
  return typeof value === "string" && gatewayKeyPattern.test(value);
}

export function commandPayloadKind(payload: RemoteCommandPayload): CommandKind {
  return payload.kind;
}

export function parseSessionMetadataPayload(value: unknown): SessionMetadataPayload | null {
  if (!isRecord(value)) return null;
  // `archived` is an additive optional key: a payload written before session
  // archive existed still parses, and an absent key means "not archived".
  const archived = Object.hasOwn(value, "archived");
  if (
    !hasExactKeys(value, archived ? ["archived", "name", "note"] : ["name", "note"])
    || (archived && typeof value.archived !== "boolean")
  ) return null;
  if (
    value.name !== null
    && (typeof value.name !== "string"
      || value.name.length < 1
      || value.name.length > 160
      || containsAbsolutePath(value.name)
      || containsUnsafeTerminalScalar(value.name))
  ) return null;
  if (
    value.note !== null
    && (typeof value.note !== "string"
      || value.note.length > 8_000
      || containsAbsolutePath(value.note)
      || containsUnsafeTerminalScalar(value.note, true))
  ) return null;
  return {
    ...(archived ? { archived: value.archived as boolean } : {}),
    name: value.name,
    note: value.note,
  };
}

/**
 * A registry label is display text only. Absolute paths, `~/` prefixes, and
 * control scalars are refused rather than redacted, so a caller that tries to
 * project a project root or an automation working directory fails closed.
 */
function isRegistryLabel(
  value: unknown,
  maximum: number = deviceRegistryLimits.labelCharacters,
): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !containsAbsolutePath(value)
    && !containsUnsafeTerminalScalar(value);
}

function isRegistryTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseRegistryAccounts(value: unknown): readonly DeviceRegistryAccount[] | null {
  if (!Array.isArray(value) || value.length > deviceRegistryLimits.accounts) return null;
  const accounts: DeviceRegistryAccount[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["label", "provider", "publicId", "status"])
      || !isRegistryLabel(entry.label)
      || (entry.provider !== "codex" && entry.provider !== "claude")
      || !isOpaqueIdentifier(entry.publicId)
      || (entry.status !== "login_pending"
        && entry.status !== "recovery_required"
        && entry.status !== "signed_in"
        && entry.status !== "signed_out")
    ) return null;
    accounts.push({
      label: entry.label,
      provider: entry.provider,
      publicId: entry.publicId,
      status: entry.status,
    });
  }
  return accounts;
}

function parseRegistryProjects(value: unknown): readonly DeviceRegistryProject[] | null {
  if (!Array.isArray(value) || value.length > deviceRegistryLimits.projects) return null;
  const projects: DeviceRegistryProject[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["label", "publicId"])
      || !isRegistryLabel(entry.label)
      || !isOpaqueIdentifier(entry.publicId)
    ) return null;
    projects.push({ label: entry.label, publicId: entry.publicId });
  }
  return projects;
}

function parseRegistryScheduledTasks(
  value: unknown,
): readonly DeviceRegistryScheduledTask[] | null {
  if (!Array.isArray(value) || value.length > deviceRegistryLimits.scheduledTasks) return null;
  const tasks: DeviceRegistryScheduledTask[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["cadence", "id", "kind", "label", "nextRunAt", "sessionPublicId"])
      || !isRegistryLabel(entry.cadence, deviceRegistryLimits.cadenceCharacters)
      || !isRegistryLabel(entry.id, deviceRegistryLimits.scheduledTaskIdCharacters)
      || (entry.kind !== "codex_automation" && entry.kind !== "hra_conversation")
      || !isRegistryLabel(entry.label)
      || (entry.nextRunAt !== null && !isRegistryTimestamp(entry.nextRunAt))
      || (entry.sessionPublicId !== null && !isOpaqueIdentifier(entry.sessionPublicId))
    ) return null;
    tasks.push({
      cadence: entry.cadence,
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      nextRunAt: entry.nextRunAt,
      sessionPublicId: entry.sessionPublicId,
    });
  }
  return tasks;
}

export function parseDeviceRegistryPayload(value: unknown): DeviceRegistryPayload | null {
  if (!isRecord(value)) return null;
  const hasAccountLinking = Object.hasOwn(value, "accountLinkingAllowed");
  const hasDeviceCommands = Object.hasOwn(value, "deviceCommandsAllowed");
  if (
    (hasAccountLinking && typeof value.accountLinkingAllowed !== "boolean")
    || (hasDeviceCommands && typeof value.deviceCommandsAllowed !== "boolean")
  ) return null;
  if (
    !hasExactKeys(value, [
      ...(hasAccountLinking ? ["accountLinkingAllowed"] : []),
      ...(hasDeviceCommands ? ["deviceCommandsAllowed"] : []),
      "accounts",
      "daemonVersion",
      "defaultApprovalMode",
      "defaultPreset",
      "heartbeatAt",
      "machineLabel",
      "projects",
      "proseAutorespondConfigured",
      "scheduledTasks",
      "showThinkingDefault",
      "version",
    ])
    || value.version !== 1
    || !isRegistryLabel(value.machineLabel)
    || !isRegistryLabel(value.daemonVersion, deviceRegistryLimits.versionCharacters)
    || !isRegistryTimestamp(value.heartbeatAt)
    || (value.defaultApprovalMode !== "auto:all"
      && value.defaultApprovalMode !== "auto:workspace"
      && value.defaultApprovalMode !== "manual")
    || typeof value.showThinkingDefault !== "boolean"
    || !isModelPreset(value.defaultPreset)
    || typeof value.proseAutorespondConfigured !== "boolean"
  ) return null;
  const accounts = parseRegistryAccounts(value.accounts);
  const projects = parseRegistryProjects(value.projects);
  const scheduledTasks = parseRegistryScheduledTasks(value.scheduledTasks);
  if (accounts === null || projects === null || scheduledTasks === null) return null;
  return {
    accounts,
    ...(hasAccountLinking
      ? { accountLinkingAllowed: value.accountLinkingAllowed as boolean }
      : {}),
    daemonVersion: value.daemonVersion,
    defaultApprovalMode: value.defaultApprovalMode,
    defaultPreset: value.defaultPreset,
    ...(hasDeviceCommands
      ? { deviceCommandsAllowed: value.deviceCommandsAllowed as boolean }
      : {}),
    heartbeatAt: value.heartbeatAt,
    machineLabel: value.machineLabel,
    projects,
    proseAutorespondConfigured: value.proseAutorespondConfigured,
    scheduledTasks,
    showThinkingDefault: value.showThinkingDefault,
    version: 1,
  };
}

export function cloudPayloadAad(authority: CloudPayloadAuthority): Uint8Array {
  if (
    !isOpaqueIdentifier(authority.entityPublicId)
    || !isOpaqueIdentifier(authority.userPublicId)
    || !Number.isSafeInteger(authority.keyVersion)
    || authority.keyVersion < 1
  ) throw new Error("Invalid cloud payload authority.");
  return new TextEncoder().encode([
    "hra-control-plane-cloud-payload:v1",
    authority.kind,
    authority.userPublicId,
    authority.entityPublicId,
    String(authority.keyVersion),
  ].join("\n"));
}

async function encryptJson(
  value: unknown,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  return await encryptBytes(
    new TextEncoder().encode(JSON.stringify(value)),
    key,
    authority.keyVersion,
    cloudPayloadAad(authority),
  );
}

async function decryptJson(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<unknown> {
  if (envelope.keyVersion !== authority.keyVersion) throw new Error("Cloud payload key mismatch.");
  const plaintext = await decryptBytes(envelope, key, cloudPayloadAad(authority));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
}

export async function encryptRemoteCommand(
  payload: RemoteCommandPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "command" || parseRemoteCommandPayload(payload) === null) {
    throw new Error("Invalid remote command payload.");
  }
  return await encryptJson(payload, key, authority);
}

export async function decryptRemoteCommand(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<RemoteCommandPayload> {
  if (authority.kind !== "command") throw new Error("Invalid remote command authority.");
  const parsed = parseRemoteCommandPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid remote command payload.");
  return parsed;
}

export async function encryptDeviceCommand(
  payload: DeviceCommandPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "device_command" || parseDeviceCommandPayload(payload) === null) {
    throw new Error("Invalid device command payload.");
  }
  return await encryptJson(payload, key, authority);
}

export async function decryptDeviceCommand(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<DeviceCommandPayload> {
  if (authority.kind !== "device_command") throw new Error("Invalid device command authority.");
  const parsed = parseDeviceCommandPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid device command payload.");
  return parsed;
}

export async function encryptDeviceCommandResult(
  payload: DeviceCommandResultPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (
    authority.kind !== "device_command_result"
    || parseDeviceCommandResultPayload(payload) === null
  ) throw new Error("Invalid device command result.");
  return await encryptJson(payload, key, authority);
}

export async function decryptDeviceCommandResult(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<DeviceCommandResultPayload> {
  if (authority.kind !== "device_command_result") {
    throw new Error("Invalid device command result authority.");
  }
  const parsed = parseDeviceCommandResultPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid device command result.");
  return parsed;
}

export async function encryptSessionMetadata(
  payload: SessionMetadataPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "session_metadata" || parseSessionMetadataPayload(payload) === null) {
    throw new Error("Invalid session metadata payload.");
  }
  return await encryptJson(payload, key, authority);
}

export async function decryptSessionMetadata(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<SessionMetadataPayload> {
  if (authority.kind !== "session_metadata") throw new Error("Invalid session metadata authority.");
  const parsed = parseSessionMetadataPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid session metadata payload.");
  return parsed;
}

export async function encryptDeviceRegistry(
  payload: DeviceRegistryPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "device_registry" || parseDeviceRegistryPayload(payload) === null) {
    throw new Error("Invalid device registry payload.");
  }
  const envelope = await encryptJson(payload, key, authority);
  if (envelope.ciphertext.length > cloudLimits.registryCiphertextCharacters) {
    throw new Error("Encrypted device registry exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptDeviceRegistry(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<DeviceRegistryPayload> {
  if (authority.kind !== "device_registry") throw new Error("Invalid device registry authority.");
  const parsed = parseDeviceRegistryPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid device registry payload.");
  return parsed;
}

export async function encryptUsageProjection(
  payload: UsageProjection,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "usage" || parseUsageProjection(payload) === null) {
    throw new Error("Invalid usage projection.");
  }
  const envelope = await encryptJson(payload, key, authority);
  if (parseUsageEncryptedEnvelope(envelope) === null) {
    throw new Error("Encrypted usage projection exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptUsageProjection(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<UsageProjection> {
  if (
    authority.kind !== "usage"
    || parseUsageEncryptedEnvelope(envelope) === null
  ) throw new Error("Invalid usage authority.");
  const parsed = parseUsageProjection(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid usage projection.");
  return parsed;
}
