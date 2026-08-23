import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readSync } from "node:fs";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { Writable as WritableStream } from "node:stream";
import { createInterface } from "node:readline/promises";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  canonicalCloudDeploymentUrl,
  DEFAULT_CLOUD_DEPLOYMENT_URL,
} from "../src/cloud/identity-custody";
import { publicInteractionSchema, type PublicInteraction } from "../src/domain/interactions";
import { sessionEventPageSchema, type SessionEvent } from "../src/domain/session-events";
import type {
  LiveAcceptanceCliResult,
  LiveAcceptanceDevice,
  LiveAcceptanceDeviceName,
  LiveAcceptanceRun,
} from "./live-acceptance";

const protectedOperatorInputFd = 4;
const operatorOutputFd = 5;
const scenarioConfigurationMaximumBytes = 8 * 1024;
const operatorFrameMaximumBytes = 64 * 1024;
const accountLoginDeadlineMs = 10 * 60 * 1_000;
const turnDeadlineMs = 15 * 60 * 1_000;
const remoteCommandDeadlineMs = 10 * 60 * 1_000;
const presenceOfflineBoundaryMs = 45_000;
const presenceObservationMarginMs = 2_000;
const defaultPollIntervalMs = 1_000;

const canonicalCandidateUrlSchema = z.literal(DEFAULT_CLOUD_DEPLOYMENT_URL).refine((value) => {
  try {
    return canonicalCloudDeploymentUrl(value) === value;
  } catch {
    return false;
  }
}, "The live release gate must target the exact compiled candidate cloud authority.");

export const liveAcceptanceScenarioConfigurationSchema = z.object({
  cloudDeploymentUrl: canonicalCandidateUrlSchema,
  operator: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("terminal") }).strict(),
    z.object({ kind: z.literal("jsonl") }).strict(),
  ]),
  version: z.literal(1),
}).strict();

export type LiveAcceptanceScenarioConfiguration = z.infer<
  typeof liveAcceptanceScenarioConfigurationSchema
>;

export type LiveAcceptanceOperatorRequest = Readonly<{
  context?: unknown;
  kind:
    | "device_a_auth_code"
    | "device_a_auth_invite"
    | "device_b_auth_code"
    | "device_b_auth_email"
    | "permission_grant"
    | "user_answers";
  prompt: string;
}>;

export interface LiveAcceptanceScenarioOperator {
  acknowledgeDeviceLogin(input: Readonly<{
    accountLabel: string;
    userCode: string;
    verificationUrl: string;
  }>, signal: AbortSignal): Promise<void>;
  progress(step: string): void;
  protectedDocument(
    request: LiveAcceptanceOperatorRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}

type ScenarioRun = Pick<
  LiveAcceptanceRun,
  "bindExpectedRevokedPeer" | "cleanup" | "device" | "runId"
>;

type ScenarioTiming = Readonly<{
  accountLoginDeadlineMs?: number;
  now?: () => number;
  pollIntervalMs?: number;
  presenceObservationMarginMs?: number;
  remoteCommandDeadlineMs?: number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number) => Promise<void>;
  turnDeadlineMs?: number;
}>;

export type LiveAcceptanceEvidence = Readonly<{
  accountIds: readonly [string, string];
  cloudTargetDigest: string;
  completedAt: number;
  devicePublicIds: readonly [string, string];
  eventKinds: Readonly<Record<string, readonly string[]>>;
  markerDigests: readonly [string, string, string];
  packageVersion: string;
  pluginLifecycleEffectsRejected: readonly ["auth", "disable", "enable", "install"];
  pluginInstallRejected: true;
  presence: readonly ["online", "offline", "online"];
  providerIdentitiesDistinct: true;
  remoteCommand: Readonly<{ resultCode: "APPLIED"; state: "applied" }>;
  runId: string;
  sessionIds: readonly [string, string];
  sourceRevision: string;
  startedAt: number;
  status: "passed";
  version: 1;
}>;

export type LiveAcceptanceScenarioAttestation = Readonly<{
  cloudTargetDigest: string;
  packageVersion: string;
  sourceRevision: string;
}>;

const scenarioAttestationSchema = z.object({
  cloudTargetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  packageVersion: z.string().min(1).max(128),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
}).strict();

const evidenceDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const evidenceIdSchema = z.string().min(1).max(200);
const evidenceTimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const liveAcceptanceEvidenceSchema: z.ZodType<LiveAcceptanceEvidence> = z.object({
  accountIds: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  cloudTargetDigest: evidenceDigestSchema,
  completedAt: evidenceTimestampSchema,
  devicePublicIds: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  eventKinds: z.record(
    evidenceIdSchema,
    z.array(z.string().min(1).max(128)).min(1).max(32),
  ),
  markerDigests: z.tuple([evidenceDigestSchema, evidenceDigestSchema, evidenceDigestSchema]),
  packageVersion: z.string().min(1).max(128),
  pluginLifecycleEffectsRejected: z.tuple([
    z.literal("auth"),
    z.literal("disable"),
    z.literal("enable"),
    z.literal("install"),
  ]),
  pluginInstallRejected: z.literal(true),
  presence: z.tuple([z.literal("online"), z.literal("offline"), z.literal("online")]),
  providerIdentitiesDistinct: z.literal(true),
  remoteCommand: z.object({
    resultCode: z.literal("APPLIED"),
    state: z.literal("applied"),
  }).strict(),
  runId: z.string().uuid(),
  sessionIds: z.tuple([evidenceIdSchema, evidenceIdSchema]),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
  startedAt: evidenceTimestampSchema,
  status: z.literal("passed"),
  version: z.literal(1),
}).strict().superRefine((evidence, context) => {
  const distinctPairs = [
    evidence.accountIds,
    evidence.devicePublicIds,
    evidence.sessionIds,
  ];
  if (
    evidence.completedAt < evidence.startedAt
    || distinctPairs.some(([left, right]) => left === right)
    || Object.keys(evidence.eventKinds).length !== 2
    || evidence.sessionIds.some((sessionId) => !(sessionId in evidence.eventKinds))
  ) context.addIssue({ code: "custom", message: "Live acceptance evidence is incoherent." });
});

class ScenarioFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ScenarioFailure";
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const record = (value: unknown, label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ScenarioFailure(`${label}_invalid`);
  }
  return value as Record<string, unknown>;
};

const requiredString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new ScenarioFailure(`${label}_invalid`);
  }
  return value;
};

const safeDeviceUserCode = (value: unknown): string => {
  const code = requiredString(value, "device_user_code");
  if (!/^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,2}$/u.test(code)) {
    throw new ScenarioFailure("device_user_code_invalid");
  }
  return code;
};

const safeDeviceVerificationUrl = (value: unknown): string => {
  const source = requiredString(value, "device_verification_url");
  if (/\p{Cc}|\p{Cf}/u.test(source)) {
    throw new ScenarioFailure("device_verification_url_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new ScenarioFailure("device_verification_url_invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.hostname === ""
  ) throw new ScenarioFailure("device_verification_url_invalid");
  return parsed.href;
};

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw new ScenarioFailure("operator_interrupted");
};

const abortable = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => settle(false, new ScenarioFailure("operator_interrupted"));
    const settle = (ok: boolean, value: unknown): void => {
      signal.removeEventListener("abort", abort);
      if (ok) resolvePromise(value as T);
      else rejectPromise(value);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else void operation().then(
      (value) => settle(true, value),
      (error: unknown) => settle(false, error),
    );
  });
};

const cancellableDevice = (
  device: LiveAcceptanceDevice,
  signal: AbortSignal,
): LiveAcceptanceDevice => ({
  device: device.device,
  execute: async (argv, options) => await abortable(
    async () => await device.execute(argv, options),
    signal,
  ),
  projectDirectory: device.projectDirectory,
  resume: async () => await abortable(async () => await device.resume(), signal),
  suspend: async () => await abortable(async () => await device.suspend(), signal),
});

type JsonCliEnvelope = Readonly<{
  command?: string;
  data?: unknown;
  error?: unknown;
  ok: boolean;
  version: 1;
}>;

const parseJsonCliEnvelope = (result: LiveAcceptanceCliResult): JsonCliEnvelope => {
  if (result.stderr !== "") throw new ScenarioFailure("cli_json_stderr_nonempty");
  const source = result.stdout.trim();
  if (source.length === 0 || source.includes("\n")) {
    throw new ScenarioFailure("cli_json_frame_invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ScenarioFailure("cli_json_invalid");
  }
  const root = record(value, "cli_envelope");
  if (root.version !== 1 || typeof root.ok !== "boolean") {
    throw new ScenarioFailure("cli_envelope_invalid");
  }
  return root as JsonCliEnvelope;
};

const executeJson = async (
  device: LiveAcceptanceDevice,
  argv: readonly string[],
  options?: Readonly<{ protectedDocument?: unknown }>,
): Promise<unknown> => {
  if (!argv.includes("--json")) throw new ScenarioFailure("json_flag_missing");
  const result = await device.execute(argv, options);
  const envelope = parseJsonCliEnvelope(result);
  if (result.exitCode !== 0 || !envelope.ok || envelope.data === undefined) {
    throw new ScenarioFailure(`cli_${argv[0] ?? "unknown"}_failed`);
  }
  const expectedCommand = argv[0] === "interaction"
    && ["answer", "decide", "grant", "submit"].includes(argv[1] ?? "")
    ? "interaction.resolve"
    : `${argv[0] ?? ""}.${argv[1] ?? ""}`;
  if (envelope.command !== expectedCommand) {
    throw new ScenarioFailure("cli_command_mismatch");
  }
  return envelope.data;
};

const executeJsonFailure = async (
  device: LiveAcceptanceDevice,
  argv: readonly string[],
  expected: Readonly<{ code: "INVALID_INPUT" | "UNAVAILABLE"; exitCode?: number }>,
): Promise<void> => {
  if (!argv.includes("--json")) throw new ScenarioFailure("json_flag_missing");
  const result = await device.execute(argv);
  const envelope = parseJsonCliEnvelope(result);
  const error = envelope.error === undefined ? null : record(envelope.error, "cli_error");
  if (
    result.exitCode === 0
    || envelope.ok
    || error?.code !== expected.code
    || (expected.exitCode !== undefined && result.exitCode !== expected.exitCode)
  ) {
    throw new ScenarioFailure(`cli_${argv[0] ?? "unknown"}_unexpected_success`);
  }
};

const pollUntil = async <T>(input: Readonly<{
  deadlineMs: number;
  now: () => number;
  operation: () => Promise<T | null>;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
}>): Promise<T> => {
  const deadline = input.now() + input.deadlineMs;
  for (;;) {
    throwIfAborted(input.signal);
    const result = await abortable(input.operation, input.signal);
    if (result !== null) return result;
    if (input.now() >= deadline) throw new ScenarioFailure("poll_deadline_exceeded");
    await abortable(async () => await input.sleep(input.pollIntervalMs), input.signal);
  }
};

type ProtectedAuthKind = Extract<
  LiveAcceptanceOperatorRequest["kind"],
  `${string}_auth_${string}`
>;

const protectedAuthDocumentSchema = z.object({
  email: z.string().email().min(3).max(320),
}).passthrough();

const protectedAuth = async (
  device: LiveAcceptanceDevice,
  operator: LiveAcceptanceScenarioOperator,
  kind: ProtectedAuthKind,
  prompt: string,
  signal: AbortSignal,
  expectedEmailDigest?: string,
): Promise<Readonly<{ data: unknown; emailDigest: string }>> => {
  const document = await operator.protectedDocument({ kind, prompt }, signal);
  const parsed = protectedAuthDocumentSchema.parse(document);
  const emailDigest = sha256(parsed.email.trim().toLowerCase());
  if (expectedEmailDigest !== undefined && emailDigest !== expectedEmailDigest) {
    throw new ScenarioFailure("protected_auth_identity_changed");
  }
  const data = await executeJson(
    device,
    ["auth", "login", "--input-fd", String(protectedOperatorInputFd), "--json"],
    { protectedDocument: document },
  );
  return { data, emailDigest };
};

const accountSchema = z.object({
  id: z.string().min(1).max(200),
  providerEmail: z.string().email().optional(),
  providerPlan: z.string().min(1).max(200).optional(),
  state: z.enum(["signed_out", "login_pending", "signed_in", "recovery_required", "removed"]),
}).passthrough();

const addAccount = async (
  device: LiveAcceptanceDevice,
  label: string,
): Promise<string> => {
  const data = record(await executeJson(
    device,
    ["account", "add", label, "--json"],
  ), "account_add");
  return accountSchema.parse(data.account).id;
};

const loginAccount = async (input: Readonly<{
  accountId: string;
  accountLabel: string;
  deadlineMs: number;
  device: LiveAcceptanceDevice;
  now: () => number;
  operator: LiveAcceptanceScenarioOperator;
  pollIntervalMs: number;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
}>): Promise<z.infer<typeof accountSchema>> => {
  const started = record(await executeJson(input.device, [
    "account",
    "login",
    input.accountId,
    "--device-code",
    "--json",
  ]), "account_login");
  const login = record(started.login, "account_login_handoff");
  if (login.status !== "pending") throw new ScenarioFailure("device_login_not_pending");
  await input.operator.acknowledgeDeviceLogin({
    accountLabel: input.accountLabel,
    userCode: safeDeviceUserCode(login.userCode),
    verificationUrl: safeDeviceVerificationUrl(login.verificationUrl),
  }, input.signal);
  return await pollUntil({
    deadlineMs: input.deadlineMs,
    now: input.now,
    operation: async () => {
      const shown = record(await executeJson(
        input.device,
        ["account", "show", input.accountId, "--json"],
      ), "account_show");
      const account = accountSchema.parse(shown.account);
      if (account.state === "recovery_required" || account.state === "removed") {
        throw new ScenarioFailure("account_login_recovery_required");
      }
      return account.state === "signed_in" ? account : null;
    },
    pollIntervalMs: input.pollIntervalMs,
    signal: input.signal,
    sleep: input.sleep,
  });
};

const pairSchema = z.object({
  device: z.object({
    publicId: z.string().min(1).max(200),
    status: z.enum(["pending", "active", "revoked"]),
  }).passthrough(),
  paired: z.boolean(),
}).passthrough();

const deviceListScenarioSchema = z.object({
  currentDevicePublicId: z.string().min(1).max(200),
  devices: z.array(z.object({
    current: z.boolean(),
    online: z.boolean(),
    publicId: z.string().min(1).max(200),
    status: z.enum(["pending", "active", "revoked"]),
  }).passthrough()).min(1).max(1_024),
}).passthrough();

const projectSchema = z.object({
  id: z.string().min(1).max(200),
}).passthrough();

const addProject = async (device: LiveAcceptanceDevice): Promise<string> => {
  const data = record(await executeJson(device, [
    "project",
    "add",
    "--path",
    device.projectDirectory,
    "--name",
    `Acceptance ${device.device.toUpperCase()}`,
    "--json",
  ]), "project_add");
  return projectSchema.parse(data.project).id;
};

const startSession = async (
  device: LiveAcceptanceDevice,
  accountId: string,
  projectId: string,
): Promise<string> => {
  const data = record(await executeJson(device, [
    "session",
    "start",
    accountId,
    "--project",
    projectId,
    "--preset",
    "high",
    "--json",
  ]), "session_start");
  const session = record(data.session, "session_start_session");
  return requiredString(session.id, "session_id");
};

const sendSessionTurn = async (
  device: LiveAcceptanceDevice,
  sessionId: string,
  message: string,
): Promise<string> => {
  const data = record(await executeJson(device, [
    "session",
    "send",
    sessionId,
    message,
    "--json",
  ]), "session_send");
  const session = record(data.session, "session_send_session");
  if (session.id !== sessionId) throw new ScenarioFailure("session_send_identity_changed");
  return requiredString(data.turnId, "session_turn_id");
};

const assertObservedUsage = (value: unknown, accountId: string): Readonly<{
  observedAt: number;
  sourceRevision: number;
}> => {
  const parsed = z.object({
    usage: z.array(z.object({
      account: z.object({ id: z.literal(accountId) }).passthrough(),
      poll: z.object({
        observedAt: z.number().int().nonnegative(),
        sourceRevision: z.number().int().positive(),
        state: z.literal("observed"),
      }).passthrough(),
      snapshot: z.object({
        observedAt: z.number().int().nonnegative(),
        sourceRevision: z.number().int().positive(),
      }).passthrough(),
    }).passthrough()).length(1),
  }).passthrough().parse(value);
  const observation = parsed.usage[0];
  if (
    observation === undefined
    || observation.poll.sourceRevision !== observation.snapshot.sourceRevision
  ) throw new ScenarioFailure("account_usage_observation_invalid");
  return {
    observedAt: observation.snapshot.observedAt,
    sourceRevision: observation.snapshot.sourceRevision,
  };
};

const assertLocalAssistantMarker = (
  value: unknown,
  turnId: string,
  marker: string,
): void => {
  const shown = z.object({
    projection: z.object({
      messages: z.array(z.object({
        role: z.enum(["assistant", "user"]),
        text: z.string().max(64_000),
        turnId: z.string().min(1).max(512),
      }).passthrough()).max(100),
    }).passthrough(),
  }).passthrough().parse(value);
  const assistant = shown.projection.messages.filter((message) =>
    message.role === "assistant" && message.turnId === turnId);
  if (
    assistant.length === 0
    || assistant.reduce(
      (count, message) => count + markerOccurrences(message.text, marker),
      0,
    ) !== 1
  ) throw new ScenarioFailure("session_marker_missing");
};

const remoteProjectionEventSchema = z.object({
  kind: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
  text: z.string().max(64_000).optional(),
  turnId: z.string().min(1).max(512).optional(),
}).passthrough();

const remoteProjectionSchema = z.object({
  compactHasRecoveryGap: z.literal(false),
  complete: z.literal(true),
  executionDevicePublicId: z.string().min(1).max(200),
  events: z.array(remoteProjectionEventSchema).max(10_000),
  publicId: z.string().min(1).max(200),
  recoveryGap: z.undefined().optional(),
}).passthrough();

const remoteProjectionEvents = (value: unknown): readonly z.infer<
  typeof remoteProjectionEventSchema
>[] => {
  const projection = remoteProjectionSchema.parse(value);
  if (projection.events.some((event, index) =>
    index > 0 && event.sequence <= (projection.events[index - 1]?.sequence ?? -1))) {
    throw new ScenarioFailure("remote_projection_unordered");
  }
  return projection.events;
};

const assertRemoteProjectionIdentity = (
  value: unknown,
  sessionId: string,
  targetDevicePublicId: string,
): void => {
  const projection = remoteProjectionSchema.parse(value);
  if (
    projection.publicId !== sessionId
    || projection.executionDevicePublicId !== targetDevicePublicId
  ) throw new ScenarioFailure("remote_projection_identity_changed");
  remoteProjectionEvents(projection);
};

const assertRemoteAssistantMarker = (
  value: unknown,
  marker: string,
  sessionId: string,
  targetDevicePublicId: string,
  turnId?: string,
): void => {
  assertRemoteProjectionIdentity(value, sessionId, targetDevicePublicId);
  const assistant = remoteProjectionEvents(value).filter((event) =>
    event.kind === "assistant_message"
    && (turnId === undefined || event.turnId === turnId));
  if (
    assistant.reduce(
      (count, event) => count + markerOccurrences(event.text ?? "", marker),
      0,
    ) !== 1
  ) throw new ScenarioFailure("remote_assistant_marker_missing");
};

const remoteCommandTurnSettled = (
  value: unknown,
  marker: string,
  sessionId: string,
  targetDevicePublicId: string,
): boolean => {
  assertRemoteProjectionIdentity(value, sessionId, targetDevicePublicId);
  const events = remoteProjectionEvents(value);
  const submitted = events.filter((event) =>
    event.kind === "user_message" && markerOccurrences(event.text ?? "", marker) === 1);
  if (submitted.length === 0) return false;
  if (submitted.length !== 1 || submitted[0]?.turnId === undefined) {
    throw new ScenarioFailure("remote_command_submission_missing");
  }
  const turnId = submitted[0].turnId;
  const assistant = events.filter((event) =>
    event.kind === "assistant_message" && event.turnId === turnId);
  const markerCount = assistant.reduce(
    (count, event) => count + markerOccurrences(event.text ?? "", marker),
    0,
  );
  if (markerCount === 0) return false;
  if (markerCount !== 1) throw new ScenarioFailure("remote_assistant_marker_missing");
  const summaries = events.filter((event) =>
    event.kind === "turn_summary" && event.turnId === turnId);
  if (summaries.length === 0) return false;
  if (summaries.length !== 1) throw new ScenarioFailure("remote_turn_terminal_ambiguous");
  const summary = summaries[0];
  if (summary === undefined) throw new ScenarioFailure("remote_turn_terminal_ambiguous");
  const assistantLastSequence = Math.max(...assistant.map((event) => event.sequence));
  if (
    submitted[0].sequence >= assistantLastSequence
    || assistantLastSequence >= summary.sequence
  ) throw new ScenarioFailure("remote_turn_terminal_unordered");
  return true;
};

const remoteCommandBindingSchema = z.object({
  commandPublicId: z.string().min(1).max(200),
  kind: z.literal("send"),
  sessionPublicId: z.string().min(1).max(200),
  state: z.enum([
    "pending",
    "prepared",
    "effect_started",
    "applied",
    "failed",
    "ambiguous",
    "cancelled",
    "expired",
  ]),
  targetDevicePublicId: z.string().min(1).max(200),
}).passthrough();

const containsPathBearingKey = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(containsPathBearingKey);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) =>
    /cwd|path|root/iu.test(key) || containsPathBearingKey(nested));
};

const assertPluginCatalog = (value: unknown, accountId: string): void => {
  const parsed = z.object({
    account: z.object({ id: z.literal(accountId), state: z.literal("signed_in") }).passthrough(),
    catalog: z.object({
      lifecycle: z.object({
        discovery: z.literal("available"),
        enablement: z.literal("no_separate_pinned_method"),
        install: z.literal("blocked_compound_upstream_effect"),
        oauth: z.literal("separate_foreground_only"),
      }).strict(),
      marketplaceLoadErrorCount: z.number().int().nonnegative().max(100),
      marketplaces: z.array(z.object({
        plugins: z.array(z.object({ id: z.string().min(1).max(512) }).passthrough()).max(5_000),
      }).passthrough()).max(100),
    }).passthrough(),
  }).passthrough().parse(value);
  if (containsPathBearingKey(parsed.catalog)) {
    throw new ScenarioFailure("plugin_catalog_path_exposed");
  }
};

const pendingInteraction = async (
  device: LiveAcceptanceDevice,
  sessionId: string,
  turnId: string,
  kind: "permission_approval" | "user_input",
): Promise<PublicInteraction | null> => {
  const data = record(await executeJson(device, [
    "interaction",
    "list",
    sessionId,
    "--pending",
    "--limit",
    "20",
    "--json",
  ]), "interaction_list");
  const values = z.array(publicInteractionSchema).max(20).parse(data.interactions);
  const candidates = values.filter((interaction) =>
    interaction.kind === kind && interaction.sessionId === sessionId);
  if (candidates.length === 0) return null;
  const interaction = candidates[0];
  if (
    candidates.length !== 1
    || interaction === undefined
    || interaction.context.turnId !== turnId
    || interaction.state !== "pending"
    || !interaction.blocking
    || interaction.responseRecorded
    || interaction.terminalAt !== null
  ) throw new ScenarioFailure("interaction_authority_changed");
  return interaction;
};

const interactionResolutionResultSchema = z.object({
  interaction: publicInteractionSchema,
  responseWritten: z.literal(true),
}).strict();

const assertInteractionResponseWritten = (
  value: unknown,
  pending: PublicInteraction,
): PublicInteraction => {
  const result = interactionResolutionResultSchema.parse(value);
  const written = result.interaction;
  if (
    written.id !== pending.id
    || written.sessionId !== pending.sessionId
    || written.kind !== pending.kind
    || written.context.turnId !== pending.context.turnId
    || written.context.itemId !== pending.context.itemId
    || written.state !== "response_written"
    || written.revision !== pending.revision + 2
    || !written.blocking
    || !written.responseRecorded
    || written.terminalAt !== null
  ) throw new ScenarioFailure("interaction_response_unproven");
  return written;
};

const resolveUserInput = async (
  device: LiveAcceptanceDevice,
  interaction: PublicInteraction,
  operator: LiveAcceptanceScenarioOperator,
  signal: AbortSignal,
): Promise<PublicInteraction> => {
  if (interaction.display.kind !== "user_input") throw new ScenarioFailure("user_input_invalid");
  const context = {
    questions: interaction.display.questions.map((question) => ({
      allowsOther: question.allowsOther,
      id: question.id,
      options: question.options,
      question: question.question,
      secret: question.secret,
    })),
  };
  const result = await executeJson(device, [
    "interaction",
    "answer",
    interaction.id,
    "--revision",
    String(interaction.revision),
    "--input-fd",
    String(protectedOperatorInputFd),
    "--json",
  ], {
    protectedDocument: await operator.protectedDocument({
      context,
      kind: "user_answers",
      prompt: "Provide exactly {answers:{<question-id>:{answers:[...]}}} for the displayed question IDs.",
    }, signal),
  });
  return assertInteractionResponseWritten(result, interaction);
};

const resolvePermission = async (
  device: LiveAcceptanceDevice,
  interaction: PublicInteraction,
  operator: LiveAcceptanceScenarioOperator,
  signal: AbortSignal,
): Promise<PublicInteraction> => {
  if (interaction.display.kind !== "permission_approval") {
    throw new ScenarioFailure("permission_interaction_invalid");
  }
  const requested = interaction.display.requested.map((permission) => permission.name);
  if (requested.length === 0) throw new ScenarioFailure("permission_interaction_empty");
  const result = await executeJson(device, [
    "interaction",
    "grant",
    interaction.id,
    "--revision",
    String(interaction.revision),
    "--scope",
    "turn",
    "--input-fd",
    String(protectedOperatorInputFd),
    "--json",
  ], {
    protectedDocument: await operator.protectedDocument({
      context: { requested },
      kind: "permission_grant",
      prompt: "Provide exactly {permissions:[...]} using a non-empty subset of the displayed names.",
    }, signal),
  });
  return assertInteractionResponseWritten(result, interaction);
};

type SessionEvidence = Readonly<{
  eventKinds: readonly string[];
}>;

const markerOccurrences = (source: string, marker: string): number => {
  let count = 0;
  let offset = 0;
  for (;;) {
    const next = source.indexOf(marker, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + marker.length;
  }
};

const collectSettledSessionEvidence = async (input: Readonly<{
  accountId: string;
  deadlineMs: number;
  device: LiveAcceptanceDevice;
  marker: string;
  now: () => number;
  pollIntervalMs: number;
  interaction: Readonly<{
    id: string;
    kind: "permission_approval" | "user_input";
    pendingRevision: number;
    writtenRevision: number;
  }>;
  sessionId: string;
  signal: AbortSignal;
  sleep: (milliseconds: number) => Promise<void>;
  turnId: string;
}>): Promise<SessionEvidence> => {
  const observed = new Map<number, SessionEvent>();
  let cursor: string | undefined;
  let lastSequence = 0;
  let sawNonTerminalPoll = false;
  return await pollUntil({
    deadlineMs: input.deadlineMs,
    now: input.now,
    operation: async () => {
      const requestedCursor = cursor;
      const argv = [
        "session",
        "events",
        input.sessionId,
        "--limit",
        "200",
        "--wait-ms",
        "1000",
        ...(requestedCursor === undefined ? [] : ["--cursor", requestedCursor]),
        "--json",
      ];
      const page = sessionEventPageSchema.parse(await executeJson(input.device, argv));
      if (
        page.sessionId !== input.sessionId
        || page.requestedCursor !== (requestedCursor ?? null)
        || page.gap !== null
      ) {
        throw new ScenarioFailure("session_event_cursor_invalid");
      }
      for (const event of page.events) {
        if (
          event.sequence !== lastSequence + 1
          || event.sessionId !== input.sessionId
          || event.accountId !== input.accountId
          || event.body.type === "gap"
          || event.body.type === "error"
          || event.body.type === "protocol_incompatible"
        ) {
          throw new ScenarioFailure("session_events_unordered");
        }
        lastSequence = event.sequence;
        observed.set(event.sequence, event);
      }
      cursor = page.nextCursor;
      const events = [...observed.values()].sort((left, right) => left.sequence - right.sequence);
      const turnEvents = events.filter((event) =>
        "turnId" in event.body && event.body.turnId === input.turnId);
      const terminalEvents = turnEvents.filter((event) => event.body.type === "turn_completed");
      if (terminalEvents.length === 0) {
        sawNonTerminalPoll = true;
        return null;
      }
      const terminalEvent = terminalEvents[0];
      if (
        terminalEvents.length !== 1
        || terminalEvent === undefined
        || terminalEvent.body.type !== "turn_completed"
        || terminalEvent.body.status !== "completed"
        || terminalEvent.sequence !== turnEvents.at(-1)?.sequence
      ) throw new ScenarioFailure("session_terminal_invalid");
      const turnStarts = turnEvents.filter((event) => event.body.type === "turn_started");
      if (
        turnStarts.length !== 1
        || turnStarts[0]?.sequence !== turnEvents[0]?.sequence
      ) throw new ScenarioFailure("session_turn_start_invalid");

      const interactionRequested = events.filter((event) => {
        const body = event.body;
        return body.type === "interaction_requested"
          && body.interactionId === input.interaction.id;
      });
      const interactionPrepared = events.filter((event) => {
        const body = event.body;
        return body.type === "interaction_state"
          && body.interactionId === input.interaction.id
          && body.state === "response_prepared";
      });
      const interactionWritten = events.filter((event) => {
        const body = event.body;
        return body.type === "interaction_state"
          && body.interactionId === input.interaction.id
          && body.state === "response_written";
      });
      const requestedBody = interactionRequested[0]?.body;
      const preparedBody = interactionPrepared[0]?.body;
      const writtenBody = interactionWritten[0]?.body;
      const turnStart = turnStarts[0];
      const requestedEvent = interactionRequested[0];
      const preparedEvent = interactionPrepared[0];
      const writtenEvent = interactionWritten[0];
      if (
        interactionRequested.length !== 1
        || interactionPrepared.length !== 1
        || interactionWritten.length !== 1
        || requestedBody?.type !== "interaction_requested"
        || requestedBody.interactionKind !== input.interaction.kind
        || !requestedBody.blocking
        || requestedBody.revision !== input.interaction.pendingRevision
        || preparedBody?.type !== "interaction_state"
        || preparedBody.revision !== input.interaction.pendingRevision + 1
        || writtenBody?.type !== "interaction_state"
        || writtenBody.revision !== input.interaction.writtenRevision
        || turnStart === undefined
        || requestedEvent === undefined
        || preparedEvent === undefined
        || writtenEvent === undefined
      ) throw new ScenarioFailure("session_interaction_evidence_incomplete");
      if (
        turnStart.sequence >= requestedEvent.sequence
        || requestedEvent.sequence >= preparedEvent.sequence
        || preparedEvent.sequence >= writtenEvent.sequence
        || writtenEvent.sequence >= terminalEvent.sequence
      ) throw new ScenarioFailure("session_interaction_evidence_incomplete");

      const authority = turnEvents[0];
      const authorityEvents = [
        ...turnEvents,
        ...interactionRequested,
        ...interactionPrepared,
        ...interactionWritten,
      ];
      if (
        authority === undefined
        || authority.providerConnectionId === null
        || authorityEvents.some((event) =>
          event.streamEpoch !== authority.streamEpoch
          || event.providerGeneration !== authority.providerGeneration
          || event.providerConnectionId !== authority.providerConnectionId)
      ) throw new ScenarioFailure("session_event_authority_changed");

      const reasoning = turnEvents.some((event) =>
        event.body.type === "reasoning_summary_delta" && event.body.text.length > 0);
      const commandStarts = turnEvents.filter((event) =>
        event.body.type === "item_started" && event.body.itemKind === "commandExecution");
      const commandItem = commandStarts.find((started) => {
        if (started.body.type !== "item_started") return false;
        const commandItemId = started.body.itemId;
        const progress = turnEvents.find((event) => {
          const body = event.body;
          return body.type === "tool_progress"
            && body.itemId === commandItemId
            && body.toolKind === "command"
            && (body.outputBytesObserved ?? 0) > 0;
        });
        const completed = turnEvents.find((event) => {
          const body = event.body;
          return body.type === "item_completed"
            && body.itemId === commandItemId
            && body.itemKind === "commandExecution"
            && body.status === "completed";
        });
        return progress !== undefined
          && completed !== undefined
          && started.sequence < progress.sequence
          && progress.sequence < completed.sequence
          && completed.sequence < terminalEvent.sequence;
      });
      const assistantText = turnEvents
        .filter((event): event is SessionEvent & { body: Extract<SessionEvent["body"], { type: "assistant_delta" }> } =>
          event.body.type === "assistant_delta")
        .map((event) => event.body.text)
        .join("");
      if (
        !sawNonTerminalPoll
        || !reasoning
        || commandItem === undefined
        || markerOccurrences(assistantText, input.marker) !== 1
      ) {
        throw new ScenarioFailure("session_stream_evidence_incomplete");
      }
      const eventKinds = [...new Set(authorityEvents.map((event) => event.body.type))].sort();
      return { eventKinds };
    },
    pollIntervalMs: input.pollIntervalMs,
    signal: input.signal,
    sleep: input.sleep,
  });
};

const assertDeviceAListAuthority = (
  list: z.infer<typeof deviceListScenarioSchema>,
  deviceAPublicId: string,
  deviceBPublicId: string,
): z.infer<typeof deviceListScenarioSchema>["devices"][number] => {
  if (deviceAPublicId === deviceBPublicId) {
    throw new ScenarioFailure("device_identity_ambiguous");
  }
  const current = list.devices.filter((device) => device.current);
  const distinctPublicIds = new Set(list.devices.map((device) => device.publicId));
  const deviceA = list.devices.filter((device) => device.publicId === deviceAPublicId);
  const deviceB = list.devices.filter((device) => device.publicId === deviceBPublicId);
  const currentDevice = current[0];
  const deviceARow = deviceA[0];
  const deviceBRow = deviceB[0];
  if (
    list.currentDevicePublicId !== deviceAPublicId
    || list.devices.length !== 2
    || distinctPublicIds.size !== list.devices.length
    || current.length !== 1
    || currentDevice === undefined
    || currentDevice.publicId !== deviceAPublicId
    || currentDevice.status !== "active"
    || deviceA.length !== 1
    || deviceARow?.current !== true
    || deviceB.length !== 1
    || deviceBRow?.current !== false
  ) throw new ScenarioFailure("device_list_authority_changed");
  return deviceBRow;
};

export async function runLiveAcceptanceScenario(
  run: ScenarioRun,
  operator: LiveAcceptanceScenarioOperator,
  attestationInput: LiveAcceptanceScenarioAttestation,
  timing: ScenarioTiming = {},
): Promise<LiveAcceptanceEvidence> {
  const attestation = scenarioAttestationSchema.parse(attestationInput);
  const now = timing.now ?? Date.now;
  const sleep = timing.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const pollIntervalMs = timing.pollIntervalMs ?? defaultPollIntervalMs;
  const signal = timing.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  const startedAt = now();
  const deviceA = cancellableDevice(run.device("a"), signal);
  const deviceB = cancellableDevice(run.device("b"), signal);

  operator.progress("projects");
  const [projectA] = await Promise.all([addProject(deviceA), addProject(deviceB)]);

  operator.progress("device_a_auth");
  const identityA = await protectedAuth(
    deviceA,
    operator,
    "device_a_auth_invite",
    "Provide exactly {email,invite} for the one-time candidate identity invite.",
    signal,
  );
  await protectedAuth(
    deviceA,
    operator,
    "device_a_auth_code",
    "Provide exactly {email,code} for device A's email verification.",
    signal,
    identityA.emailDigest,
  );
  const pairA = pairSchema.parse(await executeJson(deviceA, ["device", "pair", "--json"]));
  if (!pairA.paired || pairA.device.status !== "active") {
    throw new ScenarioFailure("device_a_pairing_failed");
  }

  operator.progress("codex_accounts");
  const accountA = await addAccount(deviceA, "Acceptance Primary");
  const signedInA = await loginAccount({
    accountId: accountA,
    accountLabel: "Acceptance Primary",
    deadlineMs: timing.accountLoginDeadlineMs ?? accountLoginDeadlineMs,
    device: deviceA,
    now,
    operator,
    pollIntervalMs,
    signal,
    sleep,
  });
  const accountB = await addAccount(deviceA, "Acceptance Secondary");
  const signedInB = await loginAccount({
    accountId: accountB,
    accountLabel: "Acceptance Secondary",
    deadlineMs: timing.accountLoginDeadlineMs ?? accountLoginDeadlineMs,
    device: deviceA,
    now,
    operator,
    pollIntervalMs,
    signal,
    sleep,
  });
  const providerEmailA = requiredString(signedInA.providerEmail, "primary_provider_email");
  const providerEmailB = requiredString(signedInB.providerEmail, "secondary_provider_email");
  if (providerEmailA.trim().toLowerCase() === providerEmailB.trim().toLowerCase()) {
    throw new ScenarioFailure("provider_identities_not_distinct");
  }
  const [usageA, usageB] = await Promise.all([
    executeJson(deviceA, ["account", "usage", accountA, "--refresh", "--json"]),
    executeJson(deviceA, ["account", "usage", accountB, "--refresh", "--json"]),
  ]);
  assertObservedUsage(usageA, accountA);
  assertObservedUsage(usageB, accountB);

  operator.progress("device_b_pending");
  await protectedAuth(
    deviceB,
    operator,
    "device_b_auth_email",
    "Provide exactly {email} for the same candidate identity on device B.",
    signal,
    identityA.emailDigest,
  );
  await protectedAuth(
    deviceB,
    operator,
    "device_b_auth_code",
    "Provide exactly {email,code} for device B's email verification.",
    signal,
    identityA.emailDigest,
  );
  const pendingPairB = pairSchema.parse(await executeJson(deviceB, ["device", "pair", "--json"]));
  const deviceBPublicId = pendingPairB.device.publicId;
  await run.bindExpectedRevokedPeer(deviceBPublicId);
  throwIfAborted(signal);
  if (pendingPairB.paired || pendingPairB.device.status !== "pending") {
    throw new ScenarioFailure("device_b_not_pending");
  }
  const listedPending = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  if (assertDeviceAListAuthority(
    listedPending,
    pairA.device.publicId,
    deviceBPublicId,
  ).status !== "pending") {
    throw new ScenarioFailure("device_b_pending_not_visible");
  }
  await executeJsonFailure(deviceB, ["sync", "now", "--json"], { code: "UNAVAILABLE" });
  await executeJsonFailure(
    deviceB,
    ["remote", "list", "--limit", "10", "--json"],
    { code: "UNAVAILABLE" },
  );
  await executeJsonFailure(deviceB, [
    "remote",
    "send",
    `missing-${randomUUID()}`,
    "pending devices cannot submit remote commands",
    "--json",
  ], { code: "UNAVAILABLE" });

  operator.progress("device_b_approval");
  const approved = record(await executeJson(
    deviceA,
    ["device", "approve", deviceBPublicId, "--json"],
  ), "device_approve");
  const approvedDevice = record(approved.device, "approved_device");
  if (approvedDevice.publicId !== deviceBPublicId || approvedDevice.status !== "active") {
    throw new ScenarioFailure("device_b_approval_failed");
  }
  const activePairB = pairSchema.parse(await executeJson(deviceB, ["device", "pair", "--json"]));
  if (!activePairB.paired || activePairB.device.publicId !== deviceBPublicId || activePairB.device.status !== "active") {
    throw new ScenarioFailure("device_b_pairing_failed");
  }

  operator.progress("sessions_and_interactions");
  const sessionA = await startSession(deviceA, accountA, projectA);
  const sessionB = await startSession(deviceA, accountB, projectA);
  const markerA = `hra-live-user-input-${randomUUID()}`;
  const markerB = `hra-live-permission-${randomUUID()}`;
  const turnA = await sendSessionTurn(
    deviceA,
    sessionA,
    `Acceptance marker ${markerA}. Call request_user_input with one non-secret question whose ID is acceptance_choice. Wait for the answer, run /bin/echo hra-live-tool-progress with the shell tool, briefly summarize your reasoning, then reply with the marker exactly once.`,
  );
  const userInput = await pollUntil({
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    now,
    operation: async () => await pendingInteraction(deviceA, sessionA, turnA, "user_input"),
    pollIntervalMs,
    signal,
    sleep,
  });
  const writtenUserInput = await resolveUserInput(deviceA, userInput, operator, signal);
  const sessionEvidencePromiseA = collectSettledSessionEvidence({
    accountId: accountA,
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    device: deviceA,
    interaction: {
      id: userInput.id,
      kind: "user_input",
      pendingRevision: userInput.revision,
      writtenRevision: writtenUserInput.revision,
    },
    marker: markerA,
    now,
    pollIntervalMs,
    sessionId: sessionA,
    signal,
    sleep,
    turnId: turnA,
  });
  void sessionEvidencePromiseA.catch(() => undefined);

  const turnB = await sendSessionTurn(
    deviceA,
    sessionB,
    `Acceptance marker ${markerB}. Use the explicit permission-request mechanism to request the smallest additional permission before running /bin/echo hra-live-tool-progress. Wait for the grant, run that command with the shell tool, briefly summarize your reasoning, then reply with the marker exactly once.`,
  );
  const permission = await pollUntil({
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    now,
    operation: async () => await pendingInteraction(
      deviceA,
      sessionB,
      turnB,
      "permission_approval",
    ),
    pollIntervalMs,
    signal,
    sleep,
  });
  const writtenPermission = await resolvePermission(deviceA, permission, operator, signal);
  const sessionEvidencePromiseB = collectSettledSessionEvidence({
    accountId: accountB,
    deadlineMs: timing.turnDeadlineMs ?? turnDeadlineMs,
    device: deviceA,
    interaction: {
      id: permission.id,
      kind: "permission_approval",
      pendingRevision: permission.revision,
      writtenRevision: writtenPermission.revision,
    },
    marker: markerB,
    now,
    pollIntervalMs,
    sessionId: sessionB,
    signal,
    sleep,
    turnId: turnB,
  });
  void sessionEvidencePromiseB.catch(() => undefined);

  const [sessionEvidenceA, sessionEvidenceB] = await Promise.all([
    sessionEvidencePromiseA,
    sessionEvidencePromiseB,
  ]);
  const [shownA, shownB] = await Promise.all([
    executeJson(deviceA, ["session", "show", sessionA, "--detail", "--json"]),
    executeJson(deviceA, ["session", "show", sessionB, "--detail", "--json"]),
  ]);
  assertLocalAssistantMarker(shownA, turnA, markerA);
  assertLocalAssistantMarker(shownB, turnB, markerB);

  const pluginCatalog = await executeJson(deviceA, [
    "plugin",
    "list",
    accountA,
    "--project",
    projectA,
    "--refresh",
    "--json",
  ]);
  assertPluginCatalog(pluginCatalog, accountA);
  for (const action of ["auth", "disable", "enable", "install"] as const) {
    await executeJsonFailure(
      deviceA,
      ["plugin", action, "acceptance-probe", "--json"],
      { code: "INVALID_INPUT", exitCode: 2 },
    );
  }

  operator.progress("sync_and_remote");
  await executeJson(deviceA, ["sync", "now", "--json"]);
  await executeJson(deviceB, ["sync", "now", "--json"]);
  const remoteHeads = record(await executeJson(
    deviceB,
    ["remote", "list", "--limit", "50", "--json"],
  ), "remote_list");
  const heads = z.array(z.object({
    executionDevicePublicId: z.string().min(1).max(200),
    publicId: z.string().min(1).max(200),
  }).passthrough()).max(50).parse(remoteHeads.sessions);
  const exactHeads = [sessionA, sessionB].map((sessionId) =>
    heads.filter((head) => head.publicId === sessionId));
  if (exactHeads.some((matches) =>
    matches.length !== 1 || matches[0]?.executionDevicePublicId !== pairA.device.publicId)) {
    throw new ScenarioFailure("remote_sessions_missing");
  }
  const remoteProjection = await executeJson(
    deviceB,
    ["remote", "show", sessionA, "--json"],
  );
  assertRemoteAssistantMarker(
    remoteProjection,
    markerA,
    sessionA,
    pairA.device.publicId,
    turnA,
  );
  const remoteMarker = `hra-live-remote-${randomUUID()}`;
  const remoteReceipt = remoteCommandBindingSchema.parse(await executeJson(deviceB, [
    "remote",
    "send",
    sessionA,
    `Reply with ${remoteMarker} exactly once.`,
    "--json",
  ]));
  const commandPublicId = remoteReceipt.commandPublicId;
  if (
    remoteReceipt.state !== "pending"
    || remoteReceipt.sessionPublicId !== sessionA
    || remoteReceipt.targetDevicePublicId !== pairA.device.publicId
  ) throw new ScenarioFailure("remote_receipt_invalid");
  const terminalRemote = await pollUntil({
    deadlineMs: timing.remoteCommandDeadlineMs ?? remoteCommandDeadlineMs,
    now,
    operation: async () => {
      const status = remoteCommandBindingSchema.parse(await executeJson(
        deviceB,
        ["remote", "command", commandPublicId, "--json"],
      ));
      if (
        status.commandPublicId !== commandPublicId
        || status.sessionPublicId !== sessionA
        || status.targetDevicePublicId !== pairA.device.publicId
      ) throw new ScenarioFailure("remote_command_binding_changed");
      if (status.state === "failed" || status.state === "ambiguous" || status.state === "expired" || status.state === "cancelled") {
        throw new ScenarioFailure("remote_command_failed");
      }
      return status.state === "applied" ? status : null;
    },
    pollIntervalMs,
    signal,
    sleep,
  });
  if (
    terminalRemote.resultCode !== "APPLIED"
    || terminalRemote.state !== "applied"
  ) throw new ScenarioFailure("remote_result_invalid");
  await pollUntil({
    deadlineMs: timing.remoteCommandDeadlineMs ?? remoteCommandDeadlineMs,
    now,
    operation: async () => {
      await executeJson(deviceA, ["sync", "now", "--json"]);
      await executeJson(deviceB, ["sync", "now", "--json"]);
      const remoteAfter = await executeJson(
        deviceB,
        ["remote", "show", sessionA, "--json"],
      );
      return remoteCommandTurnSettled(
        remoteAfter,
        remoteMarker,
        sessionA,
        pairA.device.publicId,
      ) ? true : null;
    },
    pollIntervalMs,
    signal,
    sleep,
  });

  operator.progress("presence_and_revocation");
  const onlineBefore = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  if (!assertDeviceAListAuthority(
    onlineBefore,
    pairA.device.publicId,
    deviceBPublicId,
  ).online) {
    throw new ScenarioFailure("device_b_not_online_before_suspend");
  }
  await deviceB.suspend();
  await abortable(async () => await sleep(presenceOfflineBoundaryMs + (
    timing.presenceObservationMarginMs ?? presenceObservationMarginMs
  )), signal);
  const offline = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  if (assertDeviceAListAuthority(
    offline,
    pairA.device.publicId,
    deviceBPublicId,
  ).online) {
    throw new ScenarioFailure("device_b_offline_boundary_failed");
  }
  await deviceB.resume();
  await pollUntil({
    deadlineMs: 60_000,
    now,
    operation: async () => {
      const list = deviceListScenarioSchema.parse(await executeJson(
        deviceA,
        ["device", "list", "--json"],
      ));
      return assertDeviceAListAuthority(
        list,
        pairA.device.publicId,
        deviceBPublicId,
      ).online ? true : null;
    },
    pollIntervalMs,
    signal,
    sleep,
  });
  const revoked = record(await executeJson(
    deviceA,
    ["device", "revoke", deviceBPublicId, "--json"],
  ), "device_revoke");
  const revokedDevice = record(revoked.device, "revoked_device");
  if (revokedDevice.publicId !== deviceBPublicId || revokedDevice.status !== "revoked") {
    throw new ScenarioFailure("device_b_revocation_failed");
  }
  await executeJsonFailure(deviceB, ["sync", "now", "--json"], { code: "UNAVAILABLE" });
  await executeJsonFailure(
    deviceB,
    ["remote", "show", sessionA, "--json"],
    { code: "UNAVAILABLE" },
  );
  await executeJsonFailure(deviceB, [
    "remote",
    "send",
    sessionA,
    "revoked devices cannot submit remote commands",
    "--json",
  ], { code: "UNAVAILABLE" });
  await abortable(async () => await sleep(presenceOfflineBoundaryMs + (
    timing.presenceObservationMarginMs ?? presenceObservationMarginMs
  )), signal);
  const revokedOffline = deviceListScenarioSchema.parse(await executeJson(
    deviceA,
    ["device", "list", "--json"],
  ));
  const provenRevoked = assertDeviceAListAuthority(
    revokedOffline,
    pairA.device.publicId,
    deviceBPublicId,
  );
  if (provenRevoked.status !== "revoked" || provenRevoked.online) {
    throw new ScenarioFailure("device_b_revoked_presence_unproven");
  }

  const evidence = liveAcceptanceEvidenceSchema.parse({
    accountIds: [accountA, accountB],
    cloudTargetDigest: attestation.cloudTargetDigest,
    completedAt: now(),
    devicePublicIds: [pairA.device.publicId, deviceBPublicId],
    eventKinds: {
      [sessionA]: sessionEvidenceA.eventKinds,
      [sessionB]: sessionEvidenceB.eventKinds,
    },
    markerDigests: [sha256(markerA), sha256(markerB), sha256(remoteMarker)],
    packageVersion: attestation.packageVersion,
    pluginLifecycleEffectsRejected: ["auth", "disable", "enable", "install"],
    pluginInstallRejected: true,
    presence: ["online", "offline", "online"],
    providerIdentitiesDistinct: true,
    remoteCommand: { resultCode: "APPLIED", state: "applied" },
    runId: run.runId,
    sessionIds: [sessionA, sessionB],
    sourceRevision: attestation.sourceRevision,
    startedAt,
    status: "passed",
    version: 1,
  });
  operator.progress("cleanup");
  await run.cleanup({ signal });
  return evidence;
}

export function readLiveAcceptanceScenarioConfigurationFromFd(
  fd: number,
): LiveAcceptanceScenarioConfiguration {
  if (!Number.isSafeInteger(fd) || fd < 3 || fd > 255 || isatty(fd)) {
    throw new ScenarioFailure("scenario_descriptor_invalid");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const remaining = scenarioConfigurationMaximumBytes + 1 - total;
      if (remaining <= 0) throw new ScenarioFailure("scenario_descriptor_invalid");
      const chunk = Buffer.allocUnsafe(Math.min(4 * 1024, remaining));
      const count = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (count === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > scenarioConfigurationMaximumBytes) {
        throw new ScenarioFailure("scenario_descriptor_invalid");
      }
    }
    if (total === 0) throw new ScenarioFailure("scenario_descriptor_invalid");
    const bytes = Buffer.concat(chunks, total);
    try {
      return liveAcceptanceScenarioConfigurationSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
      );
    } finally {
      bytes.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("scenario_descriptor_invalid");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

const hiddenTerminalDocument = async (
  prompt: string,
  signal: AbortSignal,
): Promise<unknown> => {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new ScenarioFailure("terminal_operator_unavailable");
  }
  const sink = new WritableStream({
    write(_chunk, _encoding, callback) { callback(); },
  });
  const terminal = createInterface({
    historySize: 0,
    input: process.stdin,
    output: sink,
    terminal: true,
  });
  process.stderr.write(`${prompt}\nProtected JSON (hidden): `);
  try {
    const source = await abortable(
      async () => await terminal.question("", { signal }),
      signal,
    );
    const bytes = Buffer.from(source, "utf8");
    try {
      if (bytes.byteLength === 0 || bytes.byteLength > operatorFrameMaximumBytes) {
        throw new ScenarioFailure("operator_response_invalid");
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } finally {
      bytes.fill(0);
    }
  } catch (error: unknown) {
    if (error instanceof ScenarioFailure) throw error;
    throw new ScenarioFailure("operator_response_invalid");
  } finally {
    terminal.close();
    sink.destroy();
    process.stderr.write("\n");
  }
};

export class TerminalLiveAcceptanceOperator implements LiveAcceptanceScenarioOperator {
  async acknowledgeDeviceLogin(input: Readonly<{
    accountLabel: string;
    userCode: string;
    verificationUrl: string;
  }>, signal: AbortSignal): Promise<void> {
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      throw new ScenarioFailure("terminal_operator_unavailable");
    }
    process.stderr.write([
      `Complete Codex device login for ${input.accountLabel}.`,
      `URL: ${input.verificationUrl}`,
      `Code: ${input.userCode}`,
      "Press Enter only after the provider confirms completion: ",
    ].join("\n"));
    const terminal = createInterface({
      historySize: 0,
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    try {
      await abortable(async () => await terminal.question("", { signal }), signal);
    } finally {
      terminal.close();
    }
  }

  progress(step: string): void {
    process.stderr.write(`hra live acceptance: ${step}\n`);
  }

  async protectedDocument(
    request: LiveAcceptanceOperatorRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const context = request.context === undefined
      ? ""
      : `\nContext: ${JSON.stringify(request.context)}`;
    return await hiddenTerminalDocument(`${request.prompt}${context}`, signal);
  }
}

const operatorResponseSchema = z.union([
  z.object({
    document: z.unknown(),
    requestId: z.string().uuid(),
    type: z.literal("protected_input"),
    version: z.literal(1),
  }).strict(),
  z.object({
    acknowledged: z.literal(true),
    requestId: z.string().uuid(),
    type: z.literal("device_login"),
    version: z.literal(1),
  }).strict(),
]);

class JsonlFrameReader {
  readonly #stream: Readable;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #iterator: AsyncIterator<unknown>;

  constructor(fd: number) {
    if (isatty(fd)) throw new ScenarioFailure("operator_descriptor_invalid");
    // IPC ownership makes a pending pipe read cancellable on Linux; fs.ReadStream does not.
    this.#stream = new Socket({ fd, readable: true, writable: false });
    this.#iterator = this.#stream[Symbol.asyncIterator]();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer.fill(0);
    this.#buffer = Buffer.alloc(0);
    this.#stream.destroy();
    const returned = this.#iterator.return?.();
    if (returned !== undefined) void returned.catch(() => undefined);
  }

  async read(signal: AbortSignal): Promise<unknown> {
    try {
      for (;;) {
        if (this.#closed) throw new ScenarioFailure("operator_closed");
        const newline = this.#buffer.indexOf(0x0a);
        if (newline >= 0) {
          const line = this.#buffer.subarray(0, newline);
          this.#buffer = this.#buffer.subarray(newline + 1);
          if (line.byteLength === 0) throw new ScenarioFailure("operator_response_invalid");
          try {
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as unknown;
          } catch {
            throw new ScenarioFailure("operator_response_invalid");
          } finally {
            line.fill(0);
          }
        }
        const next = await abortable(async () => await this.#iterator.next(), signal);
        if (next.done) throw new ScenarioFailure("operator_closed");
        const chunk = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value as Uint8Array);
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        if (this.#buffer.byteLength > operatorFrameMaximumBytes) {
          throw new ScenarioFailure("operator_response_invalid");
        }
      }
    } catch (error: unknown) {
      if (signal.aborted) this.close();
      throw error;
    }
  }
}

const writeFrame = async (
  stream: Writable,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> => {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame, "utf8") > operatorFrameMaximumBytes) {
    throw new ScenarioFailure("operator_request_invalid");
  }
  const write = async (): Promise<void> => {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      stream.write(frame, (error) => {
        if (error === undefined || error === null) resolvePromise();
        else rejectPromise(error);
      });
    });
  };
  if (signal === undefined) await write();
  else await abortable(write, signal);
};

export class JsonlLiveAcceptanceOperator implements LiveAcceptanceScenarioOperator {
  readonly #input: JsonlFrameReader;
  readonly #output: Writable;

  constructor() {
    if (isatty(protectedOperatorInputFd) || isatty(operatorOutputFd)) {
      throw new ScenarioFailure("operator_descriptor_invalid");
    }
    this.#input = new JsonlFrameReader(protectedOperatorInputFd);
    this.#output = createWriteStream("/dev/null", {
      autoClose: true,
      fd: operatorOutputFd,
    });
  }

  #closeAfterAbort(signal: AbortSignal): void {
    if (!signal.aborted) return;
    this.#input.close();
    this.#output.destroy();
  }

  async acknowledgeDeviceLogin(input: Readonly<{
    accountLabel: string;
    userCode: string;
    verificationUrl: string;
  }>, signal: AbortSignal): Promise<void> {
    const requestId = randomUUID();
    try {
      await writeFrame(this.#output, {
        ...input,
        requestId,
        type: "device_login_required",
        version: 1,
      }, signal);
      const response = operatorResponseSchema.parse(await this.#input.read(signal));
      if (
        response.type !== "device_login"
        || response.requestId !== requestId
      ) throw new ScenarioFailure("operator_response_invalid");
    } catch (error: unknown) {
      this.#closeAfterAbort(signal);
      throw error;
    }
  }

  progress(step: string): void {
    void writeFrame(this.#output, {
      step,
      type: "progress",
      version: 1,
    }).catch(() => undefined);
  }

  async protectedDocument(
    request: LiveAcceptanceOperatorRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const requestId = randomUUID();
    try {
      await writeFrame(this.#output, {
        ...(request.context === undefined ? {} : { context: request.context }),
        kind: request.kind,
        prompt: request.prompt,
        requestId,
        type: "protected_input_required",
        version: 1,
      }, signal);
      const response = operatorResponseSchema.parse(await this.#input.read(signal));
      if (response.type !== "protected_input" || response.requestId !== requestId) {
        throw new ScenarioFailure("operator_response_invalid");
      }
      return response.document;
    } catch (error: unknown) {
      this.#closeAfterAbort(signal);
      throw error;
    }
  }
}

export function createLiveAcceptanceScenarioOperator(
  configuration: LiveAcceptanceScenarioConfiguration,
): LiveAcceptanceScenarioOperator {
  return configuration.operator.kind === "terminal"
    ? new TerminalLiveAcceptanceOperator()
    : new JsonlLiveAcceptanceOperator();
}

export const liveAcceptanceScenarioFixedOperatorFds = {
  input: protectedOperatorInputFd,
  output: operatorOutputFd,
} as const;

export const liveAcceptanceScenarioPresenceOfflineBoundaryMs = presenceOfflineBoundaryMs;

export const liveAcceptanceScenarioDeviceNames = ["a", "b"] as const satisfies readonly LiveAcceptanceDeviceName[];
