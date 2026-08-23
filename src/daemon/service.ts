import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  CodexError,
  IndeterminateCodexEffectError,
  resolvePinnedCodexRuntime,
  type CodexFact,
  type CodexPluginCatalog,
  type CodexPluginSummary,
} from "../codex/index";
import type { LocalCommand } from "../domain/contracts";
import type { InteractionRecord, InteractionResolution } from "../domain/interactions";
import { effectiveRuntimeProfileSchema } from "../domain/runtime-profile";
import { sessionEventPageSchema, type SessionEventBody, type SessionEventPage } from "../domain/session-events";
import {
  accountUsageCounterSamples,
  createStoredAccountUsageSnapshot,
  observedAccountTokenVelocity,
  providerUsagePayload,
  storedAccountUsageSnapshotSchema,
  type UsageVelocityWindow,
} from "../domain/usage-metrics";
import { profileIdSchema, sessionIdSchema } from "../domain/values";
import { initializeProfilePaths, profilePaths, type StatePaths } from "../storage/paths";
import {
  SelectionError,
  type MutationAttemptRecord,
  type MutationEffectEvidence,
  type ProfileRecord,
  type SessionRecord,
  type StateStore,
} from "../storage/state-store";
import { DaemonAuthoritySafetyError, type DaemonAuthorityFence } from "./daemon-lock";
import type { CloudControlPort, CodexAccountProjection, CodexRuntimePort, CodexSessionProjection, DesktopSwitchPort, ProfileAuthority, RuntimeStartReview } from "./ports";
import { SessionEventCursorCodec, SessionEventCursorError } from "./session-event-cursor";
import { SessionEventWaiterLimitError, SessionEventWaiters } from "./session-event-waiters";

export class CommandFailure extends Error {
  constructor(
    readonly code: "INVALID_INPUT" | "NOT_FOUND" | "AMBIGUOUS" | "CONFLICT" | "INTERACTION_REQUIRED" | "UNAVAILABLE" | "RECOVERY_REQUIRED" | "INTERNAL",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CommandFailure";
  }
}

class IndeterminateLocalCommitError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "IndeterminateLocalCommitError";
  }
}

const authorityFor = (paths: StatePaths, profile: ProfileRecord): ProfileAuthority => {
  const owned = profilePaths(paths, profile.id);
  return { id: profile.id, generation: profile.processGeneration, codexHome: owned.codexHome, desktopUserData: owned.desktopUserData };
};

const loginReceiptSchema = z.object({
  status: z.enum(["pending", "signed_in"]),
  account: z.object({ signedIn: z.boolean(), email: z.string().optional(), plan: z.string().optional() }).strict().optional(),
}).strict();
const logoutReceiptSchema = z.object({ loggedOut: z.literal(true) }).strict();
const sessionStartReceiptSchema = z.object({
  sessionId: sessionIdSchema,
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: effectiveRuntimeProfileSchema.optional(),
}).strict();
const turnStartReceiptSchema = z.object({
  turnId: z.string().min(1).max(200),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]).optional(),
  sourceId: z.string().min(1).max(200).optional(),
  effectiveRuntimeProfile: effectiveRuntimeProfileSchema.optional(),
}).strict();
const steeredReceiptSchema = z.object({ steered: z.literal(true), activeTurnId: z.string().min(1).max(200) }).strict();
const stoppedReceiptSchema = z.discriminatedUnion("stopped", [
  z.object({ stopped: z.literal(true), activeTurnId: z.string().min(1).max(200) }).strict(),
  z.object({ stopped: z.literal(false), activeTurnId: z.null() }).strict(),
]);
const renamedReceiptSchema = z.object({ renamed: z.literal(true) }).strict();

const digestText = (value: string): string => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Interaction resolution contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error("Interaction resolution is not canonical JSON.");
};
const QUEUE_PRE_EFFECT_RETRY_DELAYS_MS = [25, 100, 250] as const;

type LoginOutcome = { status: "pending" | "signed_in"; verificationUrl?: string; userCode?: string; account?: CodexAccountProjection };
type BoundSessionRecord = SessionRecord & { providerThreadId: string };
type RemoteSessionCommand = Extract<LocalCommand, { kind:
  | "session.send"
  | "session.queue"
  | "session.steer"
  | "session.stop"
  | "session.rename"
  | "session.preset"
  | "session.fast"
}>;
const restoreLoginReceipt = (value: unknown): LoginOutcome => {
  const parsed = loginReceiptSchema.parse(value);
  return {
    status: parsed.status,
    ...(parsed.account === undefined ? {} : {
      account: {
        signedIn: parsed.account.signedIn,
        ...(parsed.account.email === undefined ? {} : { email: parsed.account.email }),
        ...(parsed.account.plan === undefined ? {} : { plan: parsed.account.plan }),
      },
    }),
  };
};

export class HraService {
  readonly #store: StateStore;
  readonly #paths: StatePaths;
  readonly #codex: CodexRuntimePort;
  readonly #desktop: DesktopSwitchPort | undefined;
  readonly #cloud: CloudControlPort;
  readonly #daemonAuthority: Pick<DaemonAuthorityFence, "assertCurrent" | "close">;
  readonly #requestStop: () => void;
  readonly #eventCursors: SessionEventCursorCodec;
  readonly #eventWaiters: SessionEventWaiters;
  readonly #daemonGeneration: number;
  readonly #now: () => number;
  readonly #mutationTails = new Map<string, Promise<unknown>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #operations = new Set<Promise<void>>();
  readonly #projectionRecoveriesInFlight = new Set<string>();
  readonly #sessionFactEpochs = new Map<string, number>();
  readonly #sessionProviderConnections = new Map<string, string>();
  readonly #queuePreEffectRetryCounts = new Map<string, number>();
  readonly #queuePreEffectRetryScheduled = new Set<string>();
  #state: "open" | "closing" | "closed" = "open";
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    store: StateStore;
    paths: StatePaths;
    codex: CodexRuntimePort;
    cloud: CloudControlPort;
    daemonAuthority: Pick<DaemonAuthorityFence, "assertCurrent" | "close">;
    desktop?: DesktopSwitchPort;
    eventCursors?: SessionEventCursorCodec;
    eventWaiters?: SessionEventWaiters;
    daemonGeneration?: number;
    now?: () => number;
    requestStop: () => void;
  }) {
    this.#store = input.store;
    this.#paths = input.paths;
    this.#codex = input.codex;
    this.#cloud = input.cloud;
    this.#daemonAuthority = input.daemonAuthority;
    this.#eventCursors = input.eventCursors
      ?? new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
    this.#eventWaiters = input.eventWaiters ?? new SessionEventWaiters();
    this.#daemonGeneration = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      .parse(input.daemonGeneration ?? 0);
    this.#now = input.now ?? Date.now;
    this.#desktop = input.desktop;
    this.#requestStop = input.requestStop;
  }

  async execute(command: LocalCommand, context: { signal: AbortSignal; afterResponse?: (callback: () => void) => void }): Promise<unknown> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      const result = await this.#executeAdmitted(command, context);
      await this.#daemonAuthority.assertCurrent();
      return result;
    } finally {
      finish();
    }
  }

  async #executeAdmitted(command: LocalCommand, context: { signal: AbortSignal; afterResponse?: (callback: () => void) => void }): Promise<unknown> {
    try {
      switch (command.kind) {
        case "doctor": return await this.#doctor(command.offline, context.signal);
        case "daemon.status": return { running: true, pid: process.pid };
        case "daemon.stop": (context.afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop); return { stopping: true };
        case "account.list": return { accounts: this.#store.listProfiles().map((profile) => this.#publicProfile(profile)) };
        case "account.add": return await this.#addAccount(command.label);
        case "account.show": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#showAccount(profile.id, context.signal)); }
        case "account.login": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#login(profile.id, command.deviceCode, command.idempotencyKey, context.signal)); }
        case "account.logout": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#logout(profile.id, command.idempotencyKey, context.signal)); }
        case "account.usage": {
          if (command.account === undefined) return await this.#usage(undefined, command.refresh, context.signal);
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () => this.#usage(profile.id, command.refresh, context.signal));
        }
        case "account.switch": { const profile = this.#store.requireProfile(command.account); return await this.#serialize("desktop-switch", async () => this.#switchAccount(profile.id, command.idempotencyKey, context.signal)); }
        case "account.switch-recover": return await this.#serialize("desktop-switch", async () => this.#recoverDesktopSwitch(context.signal));
        case "plugin.list": {
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () =>
            await this.#listPlugins(profile.id, command.project, command.refresh, context.signal));
        }
        case "plugin.show": {
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () =>
            await this.#showPlugin(
              profile.id,
              command.plugin,
              command.project,
              command.refresh,
              context.signal,
            ));
        }
        case "project.list": return { projects: this.#store.listProjects() };
        case "project.add": return { project: await this.#store.createProject(command.label, command.path, this.#store.listProjects().length === 0) };
        case "project.use": return { project: this.#store.setDefaultProject(this.#store.requireProject(command.project).id) };
        case "session.list": {
          if (command.account === undefined) return await this.#listSessions(undefined, command.limit, context.signal);
          const profile = this.#store.requireProfile(command.account);
          return await this.#serialize(`account:${profile.id}`, async () => this.#listSessions(profile.id, command.limit, context.signal));
        }
        case "session.show": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#showSession(session.id, command.detail, context.signal), { allowDuringProjectionRecovery: true }); }
        case "session.status": return this.#sessionStatus(command.session);
        case "session.events": return await this.#sessionEvents(command, context.signal);
        case "session.interactions": {
          const session = this.#store.requireSession(command.session);
          return {
            interactions: this.#store.listInteractions({
              sessionId: session.id,
              pendingOnly: command.pending,
              limit: command.limit,
            }).map((interaction) => this.#publicInteraction(interaction)),
          };
        }
        case "session.start": { const profile = this.#store.requireProfile(command.account); return await this.#serialize(`account:${profile.id}`, async () => this.#startSession({ ...command, account: profile.id }, context.signal)); }
        case "session.send": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#send(session.id, command.message, command.idempotencyKey, context.signal)); }
        case "session.queue": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#queue(session.id, command.message, command.idempotencyKey)); }
        case "session.steer": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#steer(session.id, command.message, command.idempotencyKey, context.signal)); }
        case "session.stop": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#stop(session.id, command.idempotencyKey, context.signal)); }
        case "session.rename": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#rename(session.id, command.name, command.idempotencyKey, context.signal)); }
        case "session.recover": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#resolveSessionRecovery(session.id, "recover", context.signal)); }
        case "session.abandon": { const session = this.#store.requireSession(command.session); return await this.#serializeSessionAuthority(session, async () => this.#resolveSessionRecovery(session.id, "abandon", context.signal)); }
        case "session.note.get": { const session = this.#store.requireSession(command.session); return { sessionId: session.id, note: session.note, revision: session.revision }; }
        case "session.note.edit": throw new CommandFailure("INTERACTION_REQUIRED", "Open the editor through the local `hra session note edit` command.");
        case "session.note.set": return { session: await this.#updateSession(command.session, (session) => ({ note: command.note, expectedRevision: session.revision })) };
        case "session.note.clear": return { session: await this.#updateSession(command.session, (session) => ({ note: "", expectedRevision: session.revision })) };
        case "session.preset": return { session: await this.#updateSession(command.session, (session) => ({ preset: command.preset, expectedRevision: session.revision })) };
        case "session.fast": return { session: await this.#updateSession(command.session, (session) => ({ fastEnabled: command.enabled, expectedRevision: session.revision })) };
        case "session.project": {
          const project = this.#store.requireProject(command.project);
          const session = await this.#updateSession(command.session, (current) => ({ projectId: project.id, expectedRevision: current.revision }));
          this.#resetQueuePreEffectRetries(session.id);
          this.#scheduleIdleQueue(session);
          return { session };
        }
        case "turn.inspect": return await this.#inspectTurn(command.session, command.turn, context.signal);
        case "interaction.list": {
          const sessionId = command.session === undefined
            ? undefined
            : this.#store.requireSession(command.session).id;
          return {
            interactions: this.#store.listInteractions({
              ...(sessionId === undefined ? {} : { sessionId }),
              pendingOnly: command.pending,
              limit: command.limit,
            }).map((interaction) => this.#publicInteraction(interaction)),
          };
        }
        case "interaction.show": return {
          interaction: this.#publicInteraction(this.#store.requireInteraction(command.interaction)),
        };
        case "interaction.resolve": return await this.#resolveInteraction(command, context.signal);
        case "auth.login": {
          const result = await this.#fencedEffect(async () => await this.#cloud.auth({
            email: command.email,
            ...(command.code === undefined ? {} : { code: command.code }),
            ...(command.invite === undefined ? {} : { invite: command.invite }),
            signal: context.signal,
          }));
          if (
            result !== null
            && typeof result === "object"
            && "daemonRestartRequired" in result
            && result.daemonRestartRequired === true
          ) {
            (context.afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop);
          }
          return result;
        }
        case "auth.status": return await this.#fencedEffect(async () => await this.#cloud.status(context.signal));
        case "auth.logout": await this.#fencedEffect(async () => await this.#cloud.logout(context.signal)); return { signedOut: true };
        case "auth.delete": {
          const result = await this.#fencedEffect(async () => await this.#cloud.deleteAccount({
            acknowledgeErasure: command.acknowledgeErasure,
            signal: context.signal,
          }));
          if (
            result !== null
            && typeof result === "object"
            && "daemonRestartRequired" in result
            && result.daemonRestartRequired === true
          ) {
            (context.afterResponse ?? ((callback) => setTimeout(callback, 0)))(this.#requestStop);
          }
          return result;
        }
        case "device.list": return await this.#fencedEffect(async () => await this.#cloud.listDevices(context.signal));
        case "device.pair": return await this.#fencedEffect(async () => await this.#cloud.pairDevice(context.signal));
        case "device.approve": return await this.#fencedEffect(async () => await this.#cloud.approveDevice(command.device, context.signal));
        case "device.revoke": return await this.#fencedEffect(async () => await this.#cloud.revokeDevice(command.device, context.signal));
        case "sync.status": return await this.#fencedEffect(async () => await this.#cloud.status(context.signal));
        case "sync.now": return await this.#fencedEffect(async () => await this.#cloud.sync(context.signal));
        case "sync.projection-recover": {
          const session = this.#requireBoundSession(command.session);
          const profile = this.#store.requireProfile(session.profileId);
          return await this.#serializeSessionAuthority(session, async () => {
            this.#projectionRecoveriesInFlight.add(session.id);
            try {
              return await this.#recoverCompactProjection({
                acknowledgeGap: command.acknowledgeGap,
                idempotencyKey: command.idempotencyKey,
                processGeneration: profile.processGeneration,
                profileId: profile.id,
                providerThreadId: session.providerThreadId,
                sessionId: session.id,
              }, context.signal);
            } finally {
              this.#projectionRecoveriesInFlight.delete(session.id);
            }
          }, { allowDuringProjectionRecovery: true });
        }
      }
    } catch (error: unknown) {
      if (error instanceof CommandFailure) throw error;
      if (error instanceof SessionEventCursorError) {
        throw new CommandFailure("INVALID_INPUT", error.message);
      }
      if (error instanceof SessionEventWaiterLimitError) {
        throw new CommandFailure("UNAVAILABLE", error.message);
      }
      if (error instanceof SelectionError) throw new CommandFailure(error.code, error.message, { candidates: error.candidates });
      if (error instanceof Error && error.message === "IDEMPOTENCY_CONFLICT") throw new CommandFailure("CONFLICT", error.message);
      if (error instanceof Error && error.message === "UNSETTLED_MUTATION_AUTHORITY") throw new CommandFailure("RECOVERY_REQUIRED", "This mutation authority has an unsettled earlier effect and rejects new idempotency keys.");
      if (error instanceof Error && error.message === "SESSION_EVENT_CURSOR_AHEAD") {
        throw new CommandFailure("CONFLICT", "The session event cursor is ahead of the current stream.");
      }
      if (error instanceof Error && /unavailable|not configured/iu.test(error.message)) throw new CommandFailure("UNAVAILABLE", error.message);
      throw error;
    }
  }

  async executeRemote(
    command: RemoteSessionCommand,
    expectedAuthority: { sessionId: SessionRecord["id"]; profileId: ProfileRecord["id"]; processGeneration: number; providerThreadId: string },
    context: { signal: AbortSignal },
  ): Promise<unknown> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      const result = await this.#executeRemoteAdmitted(command, expectedAuthority, context);
      await this.#daemonAuthority.assertCurrent();
      return result;
    } finally {
      finish();
    }
  }

  async #executeRemoteAdmitted(
    command: RemoteSessionCommand,
    expectedAuthority: { sessionId: SessionRecord["id"]; profileId: ProfileRecord["id"]; processGeneration: number; providerThreadId: string },
    context: { signal: AbortSignal },
  ): Promise<unknown> {
    const expected = z
      .object({
        sessionId: sessionIdSchema,
        profileId: profileIdSchema,
        processGeneration: z.number().int().nonnegative(),
        providerThreadId: z.string().min(1).max(200),
      })
      .strict()
      .parse(expectedAuthority);
    if (command.session !== expected.sessionId) {
      throw new CommandFailure("CONFLICT", "The remote command selector does not match its exact session authority.");
    }
    return await this.#serializeSessionAuthority({ id: expected.sessionId, profileId: expected.profileId }, async () => {
      await this.#daemonAuthority.assertCurrent();
      const session = this.#store.requireSession(expected.sessionId);
      const profile = this.#store.requireProfileById(expected.profileId);
      if (
        session.profileId !== expected.profileId
        || session.providerThreadId !== expected.providerThreadId
        || profile.processGeneration !== expected.processGeneration
      ) {
        throw new CommandFailure("CONFLICT", "The remote command authority changed before dispatch.");
      }
      this.#assertSignedIn(profile);
      switch (command.kind) {
        case "session.send": return await this.#send(session.id, command.message, command.idempotencyKey, context.signal);
        case "session.queue": return await this.#queue(session.id, command.message, command.idempotencyKey);
        case "session.steer": return await this.#steer(session.id, command.message, command.idempotencyKey, context.signal);
        case "session.stop": return await this.#stop(session.id, command.idempotencyKey, context.signal);
        case "session.rename": return await this.#rename(session.id, command.name, command.idempotencyKey, context.signal);
        case "session.preset": return {
          session: this.#store.updateSessionMetadata({
            expectedRevision: session.revision,
            preset: command.preset,
            sessionId: session.id,
          }),
        };
        case "session.fast": return {
          session: this.#store.updateSessionMetadata({
            expectedRevision: session.revision,
            fastEnabled: command.enabled,
            sessionId: session.id,
          }),
        };
      }
    });
  }

  close(): Promise<void> {
    if (this.#closeTask !== undefined) return this.#closeTask;
    this.#state = "closing";
    this.#daemonAuthority.close();
    this.#closeTask = this.#closeAdmittedService();
    return this.#closeTask;
  }

  async recover(): Promise<void> {
    const finish = this.#beginOperation();
    try {
      await this.#daemonAuthority.assertCurrent();
      await this.#recoverAdmitted();
      await this.#daemonAuthority.assertCurrent();
    } finally {
      finish();
    }
  }

  async #recoverAdmitted(): Promise<void> {
    const recoveredMutations = this.#store.recoverEffectStartedMutations();
    if (recoveredMutations.unresolved.length > 0) {
      throw new Error(`Daemon recovery cannot resolve ${String(recoveredMutations.unresolved.length)} effect-started mutation authorities.`);
    }
    const recoveredQueue = this.#store.recoverDispatchingQueueEffects();
    if (recoveredQueue.unresolved.length > 0) {
      throw new Error(`Daemon recovery cannot resolve ${String(recoveredQueue.unresolved.length)} dispatching queue authorities.`);
    }
    const pendingSessions = new Set<string>();
    for (const queued of this.#store.listRecoverableQueue()) {
      const session = this.#store.requireSession(queued.sessionId);
      if (queued.state === "pending" && session.state === "idle") {
        pendingSessions.add(session.id);
      }
    }
    for (const sessionId of pendingSessions) {
      const session = this.#store.requireSession(sessionId);
      const profile = this.#store.requireProfile(session.profileId);
      if (profile.state === "signed_in") this.#scheduleQueueDispatch(session);
    }
  }

  async settled(): Promise<void> {
    while (this.#mutationTails.size > 0 || this.#background.size > 0) {
      await Promise.allSettled([...this.#mutationTails.values(), ...this.#background]);
    }
  }

  async observeCodexFact(authority: ProfileAuthority, fact: CodexFact): Promise<void> {
    const finish = this.#beginFactOperation();
    if (finish === null) return;
    try {
      await this.#observeCodexFactAdmitted(authority, fact);
    } finally {
      finish();
    }
  }

  async observeCodexAccount(
    authority: ProfileAuthority,
    account: CodexAccountProjection,
  ): Promise<void> {
    const finish = this.#beginFactOperation();
    if (finish === null) return;
    try {
      await this.#daemonAuthority.assertCurrent();
      let profile: ProfileRecord;
      try {
        profile = this.#store.requireProfileById(authority.id);
      } catch {
        return;
      }
      if (
        profile.processGeneration !== authority.generation
        || this.#profileHasProjectionRecoveryInFlight(profile.id)
      ) return;
      const recoveryUnsettled = await this.#cloud
        .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
      await this.#daemonAuthority.assertCurrent();
      if (recoveryUnsettled || this.#profileHasProjectionRecoveryInFlight(profile.id)) return;
      const apply = async (): Promise<void> => {
        const current = this.#store.requireProfileById(profile.id);
        if (
          current.processGeneration !== authority.generation
          || this.#profileHasProjectionRecoveryInFlight(profile.id)
        ) return;
        const blocked = await this.#cloud
          .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
        await this.#daemonAuthority.assertCurrent();
        if (blocked || this.#profileHasProjectionRecoveryInFlight(profile.id)) return;
        this.#store.setProfileState(
          current.id,
          current.processGeneration,
          account.signedIn ? "signed_in" : "signed_out",
          {
            ...(account.email === undefined ? {} : { email: account.email }),
            ...(account.plan === undefined ? {} : { plan: account.plan }),
          },
        );
      };
      if (this.#mutationTails.has(`account:${profile.id}`)) await apply();
      else await this.#serialize(`account:${profile.id}`, apply);
    } finally {
      finish();
    }
  }

  async #observeCodexFactAdmitted(authority: ProfileAuthority, fact: CodexFact): Promise<void> {
    await this.#daemonAuthority.assertCurrent();
    let profile: ProfileRecord;
    try {
      profile = this.#store.requireProfileById(authority.id);
    } catch {
      return;
    }
    if (profile.processGeneration !== authority.generation || profile.state === "removed") return;
    if (fact.type === "providerConnected") return;
    if (fact.type === "providerDisconnected") {
      this.#handleProviderDisconnected(authority, fact.connectionId, fact.reason);
      this.#store.advanceProfileGeneration(authority.id, authority.generation);
      return;
    }
    if (fact.type === "interactionRequested") {
      if (
        fact.provider.profileId !== authority.id
        || fact.provider.processGeneration !== authority.generation
        || fact.provider.connectionId !== fact.connectionId
      ) throw new Error("INTERACTION_FACT_AUTHORITY_MISMATCH");
      const session = fact.provider.threadId === null
        ? null
        : this.#store.findSessionByProviderThread(authority.id, fact.provider.threadId);
      if (session !== null) this.#ensureSessionProviderConnection(authority, session, fact.connectionId);
      const admitted = this.#store.admitInteraction({
        publicId: randomUUID(),
        sessionId: session?.id ?? null,
        authority: fact.provider,
        kind: fact.kind,
        blocking: fact.blocking,
        display: fact.display,
      });
      if (!admitted.replayed && admitted.record.sessionId !== null) {
        this.#appendSessionEvent(authority, admitted.record.sessionId, fact.connectionId, {
          type: "interaction_requested",
          interactionId: admitted.record.publicId,
          interactionKind: admitted.record.kind,
          revision: admitted.record.revision,
          blocking: admitted.record.blocking,
          summary: admitted.record.display.summary,
        });
      }
      return;
    }
    if (fact.type === "interactionResolved") {
      const current = this.#store.findInteractionByAuthority(fact.provider);
      if (
        current === null
        || current.state === "resolved"
        || current.state === "declined"
        || current.state === "canceled"
        || current.state === "expired"
        || current.state === "resolution_unknown"
      ) return;
      const settled = this.#store.settleInteraction({
        id: current.publicId,
        expectedRevision: current.revision,
        state: "resolved",
        authority: fact.provider,
        ...(current.responseDigest === null ? {} : { responseDigest: current.responseDigest }),
      });
      this.#appendInteractionState(settled);
      return;
    }
    if (fact.type === "protocolNotice") {
      if (fact.connectionId === undefined) return;
      for (const [sessionId, connectionId] of this.#sessionProviderConnections) {
        if (connectionId !== fact.connectionId) continue;
        const session = this.#store.requireSession(sessionId);
        if (session.profileId !== authority.id) continue;
        this.#appendSessionEvent(authority, session.id, connectionId, {
          type: "protocol_incompatible",
          method: fact.method,
          payloadDigest: digestText(fact.method),
        });
      }
      return;
    }
    if (!("threadId" in fact) || typeof fact.threadId !== "string") return;
    const session = this.#store.findSessionByProviderThread(authority.id, fact.threadId);
    if (session === null || session.state === "recovery_required" || session.state === "terminal") return;
    this.#ensureSessionProviderConnection(authority, session, fact.connectionId);
    const event = this.#eventBodyForCodexFact(fact, session);
    if (event !== null) {
      this.#appendSessionEvent(authority, session.id, fact.connectionId ?? null, event);
    }
    const recoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettled(session.id);
    await this.#daemonAuthority.assertCurrent();
    if (recoveryUnsettled || this.#projectionRecoveriesInFlight.has(session.id)) return;
    let dispatchQueue = false;
    if (this.#mutationTails.has(`session:${session.id}`)) {
      dispatchQueue = this.#applyCodexFact(authority, fact, session);
    } else {
      try {
        dispatchQueue = await this.#serializeSessionAuthority(session, () =>
          this.#applyCodexFact(authority, fact, session));
      } catch (error: unknown) {
        if (error instanceof CommandFailure && error.code === "RECOVERY_REQUIRED") return;
        throw error;
      }
    }
    if (dispatchQueue) {
      const task = this.#serializeSessionAuthority(session, async () => this.#dispatchNextQueue(session.id, authority));
      const tracked = task.then(
        () => undefined,
        () => undefined,
      );
      this.#background.add(tracked);
      void tracked.then(() => this.#background.delete(tracked));
    }
  }

  #appendSessionEvent(
    authority: ProfileAuthority,
    sessionId: SessionRecord["id"],
    connectionId: string | null | undefined,
    body: SessionEventBody,
  ): void {
    const parsedConnection = connectionId === null || connectionId === undefined
      ? null
      : z.string().uuid().parse(connectionId);
    this.#store.appendSessionEvent({
      sessionId,
      accountId: authority.id,
      providerGeneration: authority.generation,
      providerConnectionId: parsedConnection,
      body,
    });
    this.#eventWaiters.notify(sessionId);
  }

  #ensureSessionProviderConnection(
    authority: ProfileAuthority,
    session: SessionRecord,
    connectionId: string | undefined,
  ): void {
    if (connectionId === undefined) return;
    z.string().uuid().parse(connectionId);
    const previous = this.#sessionProviderConnections.get(session.id);
    if (previous === connectionId) return;
    if (previous !== undefined) {
      const position = this.#store.eventStreamPosition(session.id);
      this.#appendSessionEvent(authority, session.id, previous, {
        type: "gap",
        reason: "provider_restart",
        fromSequence: position.observedThroughSequence + 1,
        throughSequence: position.observedThroughSequence + 1,
      });
    }
    this.#sessionProviderConnections.set(session.id, connectionId);
    this.#appendSessionEvent(authority, session.id, connectionId, {
      type: "connection",
      state: previous === undefined ? "connected" : "resubscribed",
    });
  }

  #handleProviderDisconnected(
    authority: ProfileAuthority,
    connectionId: string,
    reason: "eof" | "process_exit" | "closed" | "protocol_fault",
  ): void {
    const terminal = this.#store.expireGenerationInteractions({
      profileId: authority.id,
      processGeneration: authority.generation,
      connectionId,
    });
    for (const interaction of terminal) this.#appendInteractionState(interaction);
    for (const [sessionId, activeConnectionId] of [...this.#sessionProviderConnections]) {
      if (activeConnectionId !== connectionId) continue;
      const session = this.#store.requireSession(sessionId);
      if (session.profileId !== authority.id) continue;
      this.#appendSessionEvent(authority, session.id, connectionId, {
        type: "connection",
        state: "disconnected",
        reason,
      });
      const position = this.#store.eventStreamPosition(session.id);
      this.#appendSessionEvent(authority, session.id, connectionId, {
        type: "gap",
        reason: reason === "protocol_fault" ? "protocol_incompatible" : "provider_disconnect",
        fromSequence: position.observedThroughSequence + 1,
        throughSequence: position.observedThroughSequence + 1,
      });
      this.#sessionProviderConnections.delete(session.id);
    }
  }

  #eventBodyForCodexFact(
    fact: Exclude<CodexFact, { type: "providerConnected" | "providerDisconnected" | "interactionRequested" | "interactionResolved" | "protocolNotice" }>
      & Readonly<{ threadId: string }>,
    session: SessionRecord,
  ): SessionEventBody | null {
    switch (fact.type) {
      case "turnStarted": return { type: "turn_started", turnId: fact.turn.id };
      case "turnCompleted": return {
        type: "turn_completed",
        turnId: fact.turn.id,
        status: fact.turn.status === "inProgress" ? "failed" : fact.turn.status,
      };
      case "threadStatusChanged": return {
        type: "session_status",
        status: fact.status.type === "notLoaded"
          ? "not_loaded"
          : fact.status.type === "systemError"
            ? "system_error"
            : fact.status.type,
        activeTurnId: fact.status.type === "active" ? session.activeTurnId ?? null : null,
      };
      case "itemStarted": return {
        type: "item_started",
        turnId: fact.turnId,
        itemId: fact.itemId,
        itemKind: fact.itemKind,
      };
      case "itemCompleted": return {
        type: "item_completed",
        turnId: fact.turnId,
        itemId: fact.itemId,
        itemKind: fact.itemKind,
        ...(fact.status === undefined ? {} : { status: fact.status }),
      };
      case "assistantDelta": return {
        type: "assistant_delta",
        turnId: fact.turnId,
        itemId: fact.itemId,
        text: fact.text,
      };
      case "reasoningSummaryDelta": return {
        type: "reasoning_summary_delta",
        turnId: fact.turnId,
        itemId: fact.itemId,
        summaryPart: fact.summaryIndex,
        text: fact.text,
      };
      case "toolProgress": return {
        type: "tool_progress",
        turnId: fact.turnId,
        itemId: fact.itemId,
        toolKind: fact.toolKind,
        ...(fact.status === undefined ? {} : { status: fact.status }),
        ...(fact.outputBytesObserved === undefined
          ? {}
          : { outputBytesObserved: fact.outputBytesObserved }),
        ...(fact.server === undefined ? {} : { server: fact.server }),
        ...(fact.tool === undefined ? {} : { tool: fact.tool }),
      };
      case "planUpdated": return {
        type: "plan_updated",
        turnId: fact.turnId,
        steps: [...fact.steps],
        ...(fact.explanation === undefined ? {} : { explanation: fact.explanation }),
      };
      case "diffUpdated": return {
        type: "diff_updated",
        turnId: fact.turnId,
        changedFiles: fact.changedFiles,
        patchBytesObserved: fact.patchBytesObserved,
      };
      case "tokenUsageUpdated": return {
        type: "token_usage",
        turnId: fact.turnId,
        inputTokens: fact.inputTokens,
        cachedInputTokens: fact.cachedInputTokens,
        outputTokens: fact.outputTokens,
        reasoningOutputTokens: fact.reasoningOutputTokens,
        totalTokens: fact.totalTokens,
        modelContextWindow: fact.modelContextWindow,
      };
      case "providerWarning": return {
        type: "warning",
        code: fact.code,
        message: fact.message,
      };
      case "providerError": return {
        type: "error",
        code: fact.code,
        message: fact.message,
        terminal: fact.terminal,
      };
      case "accountUpdated":
      case "loginCompleted":
      case "serverRequestResolved":
      case "threadNameUpdated":
        return null;
    }
  }

  #applyCodexFact(
    authority: ProfileAuthority,
    fact: CodexFact & Readonly<{ threadId: string }>,
    expected: SessionRecord,
  ): boolean {
    const current = this.#store.findSessionByProviderThread(authority.id, fact.threadId);
    if (
      current === null
      || current.id !== expected.id
      || current.state === "recovery_required"
      || current.state === "terminal"
      || this.#projectionRecoveriesInFlight.has(current.id)
    ) return false;
    this.#sessionFactEpochs.set(current.id, (this.#sessionFactEpochs.get(current.id) ?? 0) + 1);
    if (fact.type === "turnStarted") {
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, state: "active", activeTurnId: fact.turn.id });
      return false;
    }
    if (fact.type === "turnCompleted") {
      for (const interaction of this.#store.expireTurnInteractions({
        sessionId: current.id,
        profileId: authority.id,
        processGeneration: authority.generation,
        turnId: fact.turn.id,
      })) this.#appendInteractionState(interaction);
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, state: "idle", activeTurnId: null });
      return true;
    }
    if (fact.type === "threadStatusChanged") {
      if (fact.status.type === "systemError") {
        this.#quarantineSession(current.id);
        return false;
      }
      const state = fact.status.type === "active" ? "active" : "idle";
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, state, ...(state === "active" ? {} : { activeTurnId: null }) });
      return false;
    }
    if (fact.type === "threadNameUpdated" && fact.name !== null) {
      this.#store.reconcileSessionFromProvider({ sessionId: current.id, title: fact.name });
    }
    return false;
  }

  async #closeAdmittedService(): Promise<void> {
    let runtimeError: unknown;
    try {
      await this.#codex.close();
    } catch (error: unknown) {
      runtimeError = error;
    }
    await this.#drainOwnedWork();
    this.#state = "closed";
    if (runtimeError !== undefined) {
      throw runtimeError instanceof Error ? runtimeError : new Error("The Codex runtime closed with a non-Error failure.");
    }
  }

  async #drainOwnedWork(): Promise<void> {
    for (;;) {
      const owned = [
        ...this.#operations,
        ...this.#mutationTails.values(),
        ...this.#background,
      ];
      if (owned.length === 0) return;
      await Promise.allSettled(owned);
      await Promise.resolve();
    }
  }

  #beginOperation(): () => void {
    if (this.#state !== "open") {
      throw new CommandFailure("UNAVAILABLE", "The daemon service is closing and no longer accepts operations.");
    }
    return this.#trackOperation();
  }

  #beginFactOperation(): (() => void) | null {
    if (this.#state !== "open") return null;
    return this.#trackOperation();
  }

  #trackOperation(): () => void {
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    this.#operations.add(pending);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#operations.delete(pending);
      settle();
    };
  }

  async #fencedEffect<T>(operation: () => Promise<T>): Promise<T> {
    await this.#daemonAuthority.assertCurrent();
    const result = await operation();
    await this.#daemonAuthority.assertCurrent();
    return result;
  }

  async #doctor(offline: boolean, signal: AbortSignal): Promise<unknown> {
    const problems: string[] = [];
    const bunReady = Bun.version === "1.3.14";
    if (!bunReady) problems.push(`HRA requires Bun 1.3.14, but ${Bun.version} is running.`);
    let codex: { status: "ready"; version: string } | { status: "invalid"; diagnostic: string };
    try {
      const runtime = await resolvePinnedCodexRuntime();
      codex = { status: "ready", version: runtime.packageVersion };
    } catch (error: unknown) {
      const diagnostic = error instanceof Error ? error.message : "The pinned Codex runtime is unavailable.";
      codex = { status: "invalid", diagnostic };
      problems.push(diagnostic);
    }
    let cloud: unknown = { configured: false, skipped: offline };
    if (!offline) {
      try {
        cloud = await this.#fencedEffect(async () => await this.#cloud.status(signal));
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        const diagnostic = error instanceof Error ? error.message : "Cloud status is unavailable.";
        cloud = { configured: true, status: "unavailable", diagnostic };
        problems.push(diagnostic);
      }
    }
    const projectReady = this.#store.listProjects().length > 0;
    if (!projectReady) problems.push("No project directory is configured. Run `hra init --yes` or add a project.");
    let desktopRecovery: unknown = { status: "unavailable" };
    if (this.#desktop !== undefined) {
      try {
        desktopRecovery = await this.#fencedEffect(async () => await this.#desktop?.currentRecovery());
        if (
          desktopRecovery !== null &&
          typeof desktopRecovery === "object" &&
          "status" in desktopRecovery &&
          desktopRecovery.status === "recovery_required"
        ) {
          problems.push("A desktop switch is unresolved. Run `hra account switch-recover`.");
        }
      } catch (error: unknown) {
        if (error instanceof DaemonAuthoritySafetyError) throw error;
        const diagnostic = error instanceof Error ? error.message : "Desktop switch recovery state is unreadable.";
        desktopRecovery = { status: "invalid", diagnostic };
        problems.push(diagnostic);
      }
    }
    return {
      healthy: problems.length === 0,
      offline,
      runtime: { bun: Bun.version, requiredBun: "1.3.14", bunReady, codex, platform: process.platform, architecture: process.arch },
      state: { database: "ready", profiles: this.#store.listProfiles().length, projects: this.#store.listProjects().length, unsettledMutations: this.#store.listUnsettledMutations().length },
      cloud,
      desktop: { supportedPlatform: process.platform === "darwin", configured: this.#desktop !== undefined, recovery: desktopRecovery },
      problems,
    };
  }

  async #addAccount(label: string): Promise<unknown> {
    const profile = this.#store.createProfile(label);
    try {
      await initializeProfilePaths(this.#paths, profile.id);
      await this.#daemonAuthority.assertCurrent();
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      this.#store.removeProfile(profile.id);
      throw error;
    }
    return { account: this.#publicProfile(profile), next: `hra account login ${profile.id}` };
  }

  async #readPluginCatalog(
    profileId: ProfileRecord["id"],
    projectSelector: string | undefined,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<Readonly<{ catalog: CodexPluginCatalog; profile: ProfileRecord }>> {
    const profile = this.#store.requireProfile(profileId);
    this.#assertSignedIn(profile);
    const project = projectSelector === undefined
      ? undefined
      : this.#store.requireProject(projectSelector);
    const catalog = await this.#fencedEffect(async () => await this.#codex.listPlugins({
      authority: authorityFor(this.#paths, profile),
      ...(project === undefined ? {} : { projectRoot: project.rootPath }),
      forceRefetch: refresh,
      signal,
    }));
    return { catalog, profile: this.#store.requireProfile(profile.id) };
  }

  async #listPlugins(
    profileId: ProfileRecord["id"],
    projectSelector: string | undefined,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { catalog, profile } = await this.#readPluginCatalog(
      profileId,
      projectSelector,
      refresh,
      signal,
    );
    return { account: this.#publicProfile(profile), catalog };
  }

  async #showPlugin(
    profileId: ProfileRecord["id"],
    selector: string,
    projectSelector: string | undefined,
    refresh: boolean,
    signal: AbortSignal,
  ): Promise<unknown> {
    const { catalog, profile } = await this.#readPluginCatalog(
      profileId,
      projectSelector,
      refresh,
      signal,
    );
    const entries: Array<Readonly<{
      marketplace: CodexPluginCatalog["marketplaces"][number];
      plugin: CodexPluginSummary;
    }>> = [];
    for (const marketplace of catalog.marketplaces) {
      for (const plugin of marketplace.plugins) entries.push({ marketplace, plugin });
    }
    const exact = entries.filter((entry) => entry.plugin.id === selector);
    const normalized = selector.toLocaleLowerCase("en-US");
    const labels = exact.length > 0
      ? exact
      : entries.filter((entry) =>
        entry.plugin.name.toLocaleLowerCase("en-US") === normalized
        || entry.plugin.displayName?.toLocaleLowerCase("en-US") === normalized);
    if (labels.length !== 1) {
      throw new SelectionError(
        labels.length === 0 ? "NOT_FOUND" : "AMBIGUOUS",
        labels.map(({ plugin }) => ({
          id: plugin.id,
          label: plugin.displayName ?? plugin.name,
        })),
      );
    }
    const selected = labels[0];
    if (selected === undefined) throw new SelectionError("NOT_FOUND");
    return {
      account: this.#publicProfile(profile),
      marketplace: {
        name: selected.marketplace.name,
        displayName: selected.marketplace.displayName,
      },
      plugin: selected.plugin,
      lifecycle: catalog.lifecycle,
    };
  }

  async #showAccount(selector: string, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettledForProfile(profile.id);
    await this.#daemonAuthority.assertCurrent();
    const account = await this.#fencedEffect(async () => await this.#codex.readAccount({ authority: authorityFor(this.#paths, profile), signal }));
    if (projectionRecoveryUnsettled) {
      return {
        account: this.#publicProfile(profile),
        providerProjection: account,
        recovery: {
          cleared: false,
          diagnostic: "Compact-projection recovery preserves this account's exact local authority; provider state was read without changing local custody.",
          required: true,
        },
      };
    }
    if (profile.state === "recovery_required") {
      const unsettled = this.#store.listUnsettledMutations({ authorityId: profile.id })
        .filter((attempt) => attempt.authorityGeneration === profile.processGeneration && (attempt.kind === "account.login" || attempt.kind === "account.logout"));
      if (unsettled.length !== 1) {
        return { account: this.#publicProfile(profile), providerProjection: account, recovery: { required: true, cleared: false, diagnostic: "No single exact account recovery authority is available." } };
      }
      const attempt = unsettled[0];
      if (attempt?.evidence === undefined || (attempt.originalState ?? attempt.state) === "reconciled") {
        throw new CommandFailure("RECOVERY_REQUIRED", "The account recovery evidence is incomplete.");
      }
      const originalState = attempt.originalState ?? attempt.state;
      if (originalState !== "effect_started" && originalState !== "ambiguous") {
        throw new CommandFailure("RECOVERY_REQUIRED", "The account recovery state is not resolvable.");
      }
      if (attempt.kind === "account.login" && !account.signedIn) {
        return { account: this.#publicProfile(profile), providerProjection: account, recovery: { required: true, cleared: false, diagnostic: "The exact provider read does not prove that login completed." } };
      }
      const applied = attempt.kind === "account.login" || !account.signedIn;
      const reconciled = this.#store.resolveAccountMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: attempt.evidence.digest,
        resolution: applied ? "proven_applied" : "provider_state_reconciled",
        resolutionEvidence: { source: "account/read", signedIn: account.signedIn },
        ...(attempt.kind === "account.login"
          ? { receipt: { status: "signed_in", account } }
          : account.signedIn ? {} : { receipt: { loggedOut: true } }),
        provider: account,
      });
      return { account: this.#publicProfile(reconciled), providerProjection: account, idempotencyKey: attempt.idempotencyKey, recovery: { required: false, cleared: true, resolution: applied ? "proven_applied" : "provider_state_reconciled" } };
    }
    if (!this.#store.setProfileState(profile.id, profile.processGeneration, account.signedIn ? "signed_in" : "signed_out", {
      ...(account.email === undefined ? {} : { email: account.email }),
      ...(account.plan === undefined ? {} : { plan: account.plan }),
    })) {
      throw new CommandFailure("CONFLICT", "Account generation changed during reconciliation.");
    }
    return { account: this.#publicProfile(this.#store.requireProfile(profile.id)) };
  }

  async #login(selector: string, deviceCode: boolean, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const current = this.#store.requireProfile(selector);
    await this.#assertNoCompactProjectionRecoveryForProfile(current.id);
    if (current.state === "signed_in" && idempotencyKey === undefined) return { account: this.#publicProfile(current), login: { status: "signed_in" } };
    const key = idempotencyKey ?? randomUUID();
    const prior = this.#store.readMutation(key);
    if (prior !== null && (prior.kind !== "account.login" || prior.authorityId !== current.id)) {
      throw new CommandFailure("CONFLICT", "The idempotency key belongs to another mutation authority.");
    }
    if (prior === null && (current.state === "login_pending" || current.state === "recovery_required")) {
      throw new CommandFailure("RECOVERY_REQUIRED", "This account already has an unsettled login. Reuse its idempotency key or inspect the account before starting another login.");
    }
    const targetGeneration = prior?.authorityGeneration ?? current.processGeneration + 1;
    const canBegin = current.processGeneration + 1 === targetGeneration && (prior === null || prior.state === "prepared");
    if (current.processGeneration !== targetGeneration && !canBegin) {
      throw new CommandFailure("CONFLICT", "The login attempt belongs to a stale account generation.");
    }
    const authority = { ...current, processGeneration: targetGeneration };
    try {
      const result = await this.#effect({
        kind: "account.login",
        authorityId: current.id,
        authorityGeneration: targetGeneration,
        request: { deviceCode },
        idempotencyKey: key,
        beginEffect: (attemptId) => {
          this.#store.beginAccountMutationEffect({
            attemptId,
            profileId: current.id,
            profileGeneration: targetGeneration,
            evidence: { kind: "account.login", method: deviceCode ? "device_code" : "browser" },
          });
        },
        effect: async () => await this.#fencedEffect(async () => await this.#codex.login({ authority: authorityFor(this.#paths, authority), method: deviceCode ? "device_code" : "browser", signal })),
        receipt: (value) => loginReceiptSchema.parse({ status: value.status, ...(value.account === undefined ? {} : { account: value.account }) }),
        restore: restoreLoginReceipt,
      });
      if (result.status === "signed_in" && result.account !== undefined) {
        this.#store.setProfileState(current.id, targetGeneration, "signed_in", { ...(result.account.email === undefined ? {} : { email: result.account.email }), ...(result.account.plan === undefined ? {} : { plan: result.account.plan }) });
      }
      return { account: this.#publicProfile(this.#store.requireProfile(current.id)), login: result, idempotencyKey: key };
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      const observed = this.#store.requireProfile(current.id);
      const attempt = this.#store.readMutation(key);
      if (observed.processGeneration === targetGeneration) {
        if (attempt?.state === "effect_started" || attempt?.state === "ambiguous") {
          this.#quarantineProfile(observed);
        } else if (observed.state === "login_pending") {
          this.#store.setProfileState(current.id, targetGeneration, "signed_out");
        }
      }
      throw error;
    }
  }

  async #logout(selector: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(selector);
    await this.#assertNoCompactProjectionRecoveryForProfile(profile.id);
    const key = idempotencyKey ?? randomUUID();
    if (profile.state === "recovery_required") {
      throw new CommandFailure("RECOVERY_REQUIRED", "This account has an indeterminate logout. Run `hra account show` to reconcile its exact provider state before another logout.");
    }
    await this.#effect({
      kind: "account.logout",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: {},
      idempotencyKey: key,
      beginEffect: (attemptId) => {
        this.#store.beginAccountMutationEffect({
          attemptId,
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          evidence: { kind: "account.logout", baselineSignedIn: profile.state !== "signed_out" },
        });
      },
      effect: async () => {
        if (profile.state !== "signed_out") await this.#fencedEffect(async () => await this.#codex.logout({ authority: authorityFor(this.#paths, profile), signal }));
        return { loggedOut: true as const };
      },
      receipt: (value) => logoutReceiptSchema.parse(value),
      restore: (value) => logoutReceiptSchema.parse(value),
      onAmbiguous: () => this.#quarantineProfile(profile),
    });
    const current = this.#store.requireProfile(profile.id);
    if (current.state !== "signed_out" && !this.#store.setProfileState(profile.id, profile.processGeneration, "signed_out")) {
      this.#quarantineProfile(profile);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex logged out, but its local account state could not be committed. Run `hra account show` to reconcile it.");
    }
    return { account: this.#publicProfile(this.#store.requireProfile(profile.id)), idempotencyKey: key };
  }

  async #usage(selector: string | undefined, refresh: boolean, signal: AbortSignal): Promise<unknown> {
    if (selector === undefined && refresh) {
      const usage: unknown[] = [];
      for (const profile of this.#store.listProfiles()) {
        const value = await this.#serialize(`account:${profile.id}`, async () =>
          this.#usage(profile.id, true, signal)) as { usage: unknown[] };
        usage.push(...value.usage);
      }
      return { usage };
    }
    const profiles = selector === undefined ? this.#store.listProfiles() : [this.#store.requireProfile(selector)];
    const usage = [];
    for (const profile of profiles) {
      if (refresh) {
        this.#assertSignedIn(profile);
        const sourceSequence = this.#store.allocateNextUsageRevision(profile.id);
        let snapshot: Awaited<ReturnType<CodexRuntimePort["readUsage"]>>;
        try {
          snapshot = await this.#fencedEffect(async () =>
            await this.#codex.readUsage({ authority: authorityFor(this.#paths, profile), signal }));
        } catch (error: unknown) {
          if (!signal.aborted) {
            this.#store.recordUsagePollFailure(
              profile.id,
              sourceSequence,
              this.#now(),
              "account_usage_read_failed",
            );
          }
          throw error;
        }
        const receivedAt = this.#now();
        const previous = this.#store.latestUsage(profile.id);
        const stored = createStoredAccountUsageSnapshot({
          providerPayload: snapshot.payload,
          sourceSequence,
          observedAt: snapshot.observedAt,
          receivedAt,
          accountFingerprint: profile.providerEmail === undefined
            ? null
            : digestText(profile.providerEmail.trim().toLowerCase()),
          providerGeneration: profile.processGeneration,
          daemonGeneration: this.#daemonGeneration,
          previousPayload: previous?.payload ?? null,
        });
        this.#store.recordUsage(profile.id, sourceSequence, snapshot.observedAt, stored);
      }
      const latest = this.#store.latestUsage(profile.id);
      const latestFailure = this.#store.latestUsagePollFailure(profile.id);
      const now = this.#now();
      const samples = accountUsageCounterSamples(this.#store.usageRange({
        profileId: profile.id,
        fromObservedAt: Math.max(0, now - 30 * 60_000),
        throughObservedAt: now,
        limit: 2_000,
      }));
      const windows = ["1m", "5m", "15m"] satisfies readonly UsageVelocityWindow[];
      const velocity = Object.fromEntries(windows.map((window) => [
        window,
        observedAccountTokenVelocity({ samples, window, now }),
      ]));
      const parsedStored = latest === null
        ? null
        : storedAccountUsageSnapshotSchema.safeParse(latest.payload);
      usage.push({
        account: this.#publicProfile(profile),
        poll: latestFailure !== null
          && (latest === null || latestFailure.sourceRevision > latest.sourceRevision)
          ? { state: "failed", ...latestFailure }
          : latest === null
            ? { state: "never_observed" }
            : {
                observedAt: latest.observedAt,
                sourceRevision: latest.sourceRevision,
                state: "observed",
              },
        snapshot: latest === null ? null : {
          ...latest,
          payload: providerUsagePayload(latest.payload),
          ...(parsedStored?.success === true
            ? { observation: parsedStored.data.observation }
            : {}),
        },
        velocity,
      });
    }
    return { usage };
  }

  async #switchAccount(selector: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    if (this.#desktop === undefined) throw new CommandFailure("UNAVAILABLE", "Desktop account switching is available only on a supported macOS ChatGPT build.");
    const desktop = this.#desktop;
    const target = this.#store.requireProfile(selector);
    if (target.state !== "signed_in") throw new CommandFailure("CONFLICT", "The target account is not signed in.");
    const result = await this.#fencedEffect(async () => await desktop.switchAccount({ idempotencyKey, target: authorityFor(this.#paths, target), signal }));
    if (result.status === "recovery_required") {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        result.diagnostic ?? "Desktop account switch requires recovery.",
        { idempotencyKey: result.idempotencyKey, action: "hra account switch-recover" },
      );
    }
    return result;
  }

  async #recoverDesktopSwitch(signal: AbortSignal): Promise<unknown> {
    if (this.#desktop === undefined) {
      throw new CommandFailure("UNAVAILABLE", "Desktop account switching is available only on a supported macOS ChatGPT build.");
    }
    const desktop = this.#desktop;
    return await this.#fencedEffect(async () => await desktop.recoverSwitch({ signal }));
  }

  async #recoverCompactProjection(
    expected: Readonly<{
      acknowledgeGap: true;
      idempotencyKey: string;
      processGeneration: number;
      profileId: ProfileRecord["id"];
      providerThreadId: string;
      sessionId: SessionRecord["id"];
    }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    await this.#daemonAuthority.assertCurrent();
    const session = this.#requireBoundSession(expected.sessionId);
    const profile = this.#store.requireProfileById(expected.profileId);
    if (
      session.profileId !== expected.profileId
      || session.providerThreadId !== expected.providerThreadId
      || profile.processGeneration !== expected.processGeneration
    ) {
      throw new CommandFailure("CONFLICT", "The projection recovery authority changed before admission.");
    }
    this.#assertSignedIn(profile);
    if (session.state !== "idle" || session.activeTurnId !== undefined) {
      throw new CommandFailure("CONFLICT", "Projection recovery requires an idle session with no active turn.");
    }
    const unsettledMutations = this.#store.listUnsettledMutations({ sessionId: session.id });
    const unsettledQueueEffects = this.#store.listUnsettledQueueEffects(session.id);
    const unsettledQueueEntries = this.#store.listQueue(session.id)
      .filter((entry) => entry.state === "pending" || entry.state === "dispatching" || entry.state === "ambiguous");
    if (unsettledMutations.length > 0 || unsettledQueueEffects.length > 0 || unsettledQueueEntries.length > 0) {
      throw new CommandFailure("RECOVERY_REQUIRED", "Projection recovery rejects a session with unsettled mutation or queue authority.");
    }
    return await this.#fencedEffect(async () => await this.#cloud.recoverCompactProjection({
      acknowledgeGap: expected.acknowledgeGap,
      idempotencyKey: expected.idempotencyKey,
      sessionPublicId: session.id,
      signal,
    }));
  }

  #encodeEventCursor(input: {
    sessionId: SessionRecord["id"];
    streamEpoch: string;
    sequence: number;
  }): string {
    return this.#eventCursors.encode({
      version: 1,
      sessionId: input.sessionId,
      streamEpoch: input.streamEpoch,
      sequence: input.sequence,
    });
  }

  #sessionStatus(selector: string): unknown {
    const session = this.#store.requireSession(selector);
    const snapshot = this.#store.readSessionSnapshotWithEventPosition(session.id);
    const pending = this.#store.listInteractions({
      sessionId: session.id,
      pendingOnly: true,
      limit: 100,
    });
    return {
      version: 1,
      session: snapshot.session,
      eventStream: {
        cursor: this.#encodeEventCursor({
          sessionId: session.id,
          streamEpoch: snapshot.streamEpoch,
          sequence: snapshot.observedThroughSequence,
        }),
        retentionFloorCursor: this.#encodeEventCursor({
          sessionId: session.id,
          streamEpoch: snapshot.streamEpoch,
          sequence: Math.max(0, snapshot.floorSequence - 1),
        }),
        streamEpoch: snapshot.streamEpoch,
        floorSequence: snapshot.floorSequence,
        observedThroughSequence: snapshot.observedThroughSequence,
      },
      pendingInteractions: pending.map((interaction) => this.#publicInteraction(interaction)),
    };
  }

  async #sessionEvents(
    command: Extract<LocalCommand, { kind: "session.events" }>,
    signal: AbortSignal,
  ): Promise<SessionEventPage> {
    const session = this.#store.requireSession(command.session);
    let requestedSequence: number | null = null;
    if (command.cursor !== undefined) {
      const cursor = this.#eventCursors.decode(command.cursor);
      const current = this.#store.eventStreamPosition(session.id);
      if (cursor.sessionId !== session.id) {
        throw new CommandFailure("INVALID_INPUT", "The session event cursor belongs to another session.");
      }
      if (cursor.streamEpoch !== current.streamEpoch) {
        throw new CommandFailure("CONFLICT", "The session event cursor belongs to an earlier stream epoch.", {
          currentRetentionFloorCursor: this.#encodeEventCursor({
            sessionId: session.id,
            streamEpoch: current.streamEpoch,
            sequence: Math.max(0, current.floorSequence - 1),
          }),
        });
      }
      requestedSequence = cursor.sequence;
    }

    let listed = this.#store.listSessionEvents({
      sessionId: session.id,
      afterSequence: requestedSequence,
      limit: command.limit,
    });
    if (listed.events.length === 0 && command.waitMs > 0) {
      await this.#eventWaiters.wait({
        sessionId: session.id,
        expectedObservedThrough: listed.observedThroughSequence,
        waitMs: command.waitMs,
        signal,
        readObservedThrough: () =>
          this.#store.eventStreamPosition(session.id).observedThroughSequence,
      });
      listed = this.#store.listSessionEvents({
        sessionId: session.id,
        afterSequence: requestedSequence,
        limit: command.limit,
      });
    }
    const nextSequence = listed.events.at(-1)?.sequence
      ?? requestedSequence
      ?? Math.max(0, listed.floorSequence - 1);
    const page = {
      version: 1 as const,
      sessionId: session.id,
      requestedCursor: command.cursor ?? null,
      retentionFloorCursor: this.#encodeEventCursor({
        sessionId: session.id,
        streamEpoch: listed.streamEpoch,
        sequence: Math.max(0, listed.floorSequence - 1),
      }),
      observedThroughCursor: this.#encodeEventCursor({
        sessionId: session.id,
        streamEpoch: listed.streamEpoch,
        sequence: listed.observedThroughSequence,
      }),
      nextCursor: this.#encodeEventCursor({
        sessionId: session.id,
        streamEpoch: listed.streamEpoch,
        sequence: nextSequence,
      }),
      gap: listed.gapReason === null
        ? null
        : {
            reason: listed.gapReason,
            requestedSequence,
            retainedFromSequence: listed.floorSequence,
          },
      events: [...listed.events],
    };
    return sessionEventPageSchema.parse(page);
  }

  #publicInteraction(interaction: InteractionRecord): unknown {
    return {
      version: interaction.version,
      id: interaction.publicId,
      sessionId: interaction.sessionId,
      kind: interaction.kind,
      state: interaction.state,
      revision: interaction.revision,
      blocking: interaction.blocking,
      display: interaction.display,
      responseRecorded: interaction.responseDigest !== null,
      context: {
        turnId: interaction.authority.turnId,
        itemId: interaction.authority.itemId,
      },
      requestedAt: interaction.requestedAt,
      updatedAt: interaction.updatedAt,
      terminalAt: interaction.terminalAt,
    };
  }

  #appendInteractionState(interaction: InteractionRecord): void {
    if (interaction.sessionId === null) return;
    this.#store.appendSessionEvent({
      sessionId: interaction.sessionId,
      accountId: interaction.authority.profileId,
      providerGeneration: interaction.authority.processGeneration,
      providerConnectionId: interaction.authority.connectionId,
      body: {
        type: "interaction_state",
        interactionId: interaction.publicId,
        state: interaction.state,
        revision: interaction.revision,
      },
    });
    this.#eventWaiters.notify(interaction.sessionId);
  }

  #assertResolutionMatches(
    interaction: InteractionRecord,
    resolution: InteractionResolution,
  ): void {
    const expected = interaction.kind === "permission_approval"
      ? "permission_grant"
      : interaction.kind === "user_input"
        ? "user_answers"
        : interaction.kind === "mcp_elicitation"
          ? "mcp_submission"
          : "approval_decision";
    if (resolution.kind !== expected) {
      throw new CommandFailure(
        "INVALID_INPUT",
        `A ${interaction.kind} interaction requires a ${expected} resolution.`,
      );
    }
    if (
      resolution.kind === "approval_decision"
      && resolution.decision === "session"
      && (interaction.display.kind === "command_approval"
        || interaction.display.kind === "file_change_approval")
      && !interaction.display.allowsSessionApproval
    ) {
      throw new CommandFailure("INVALID_INPUT", "This provider request does not allow session approval.");
    }
    if (
      resolution.kind === "permission_grant"
      && interaction.display.kind === "permission_approval"
    ) {
      const requested = new Set(interaction.display.requested.map((permission) => permission.name));
      if (Object.keys(resolution.permissions).some((name) => !requested.has(name))) {
        throw new CommandFailure("INVALID_INPUT", "Granted permissions must be a subset of the request.");
      }
      if (resolution.scope === "session" && !interaction.display.allowsSessionScope) {
        throw new CommandFailure("INVALID_INPUT", "This provider request does not allow session permission scope.");
      }
    }
    if (resolution.kind === "user_answers" && interaction.display.kind === "user_input") {
      const questions = new Set(interaction.display.questions.map((question) => question.id));
      const answers = Object.keys(resolution.answers);
      if (answers.length !== questions.size || answers.some((id) => !questions.has(id))) {
        throw new CommandFailure("INVALID_INPUT", "User answers must match the provider's exact question IDs.");
      }
    }
  }

  async #resolveInteraction(
    command: Extract<LocalCommand, { kind: "interaction.resolve" }>,
    signal: AbortSignal,
  ): Promise<unknown> {
    return await this.#serialize(`interaction:${command.interaction}`, async () => {
      const current = this.#store.requireInteraction(command.interaction);
      if (current.revision !== command.expectedRevision || current.state !== "pending") {
        throw new CommandFailure(
          "CONFLICT",
          "The interaction revision or state changed before resolution.",
          { interaction: this.#publicInteraction(current) },
        );
      }
      this.#assertResolutionMatches(current, command.resolution);
      const responseDigest = digestText(canonicalJson(command.resolution));
      const prepared = this.#store.prepareInteractionResponse({
        id: current.publicId,
        expectedRevision: current.revision,
        responseDigest,
      });
      this.#appendInteractionState(prepared);
      const resolve = this.#codex.resolveInteraction?.bind(this.#codex);
      if (resolve === undefined) {
        const expired = this.#store.expireInteraction({
          id: prepared.publicId,
          expectedRevision: prepared.revision,
        });
        this.#appendInteractionState(expired);
        throw new CommandFailure(
          "UNAVAILABLE",
          "Interaction response routing is unavailable for this provider runtime.",
        );
      }
      const profile = this.#store.requireProfileById(prepared.authority.profileId);
      try {
        await this.#daemonAuthority.assertCurrent();
        await resolve.call(this.#codex, {
          authority: authorityFor(this.#paths, profile),
          provider: prepared.authority,
          kind: prepared.kind,
          resolution: command.resolution,
          signal,
        });
      } catch (error: unknown) {
        const terminal = error instanceof CodexError && error.code === "INDETERMINATE_EFFECT"
          ? this.#store.markInteractionResolutionUnknown({
              id: prepared.publicId,
              expectedRevision: prepared.revision,
              responseDigest,
            })
          : this.#store.expireInteraction({
              id: prepared.publicId,
              expectedRevision: prepared.revision,
            });
        this.#appendInteractionState(terminal);
        if (error instanceof CodexError && error.code === "INDETERMINATE_EFFECT") {
          throw new CommandFailure(
            "RECOVERY_REQUIRED",
            "The interaction response may have reached Codex; its resolution is unknown.",
            { interaction: this.#publicInteraction(terminal) },
          );
        }
        if (error instanceof CodexError && error.code === "INVALID_INPUT") {
          throw new CommandFailure("INVALID_INPUT", error.message);
        }
        throw new CommandFailure(
          "CONFLICT",
          "The interaction's exact provider connection is no longer available.",
          { interaction: this.#publicInteraction(terminal) },
        );
      }
      const written = this.#store.markInteractionResponseWritten({
        id: prepared.publicId,
        expectedRevision: prepared.revision,
        responseDigest,
      });
      if (written.state === "response_written") this.#appendInteractionState(written);
      return { interaction: this.#publicInteraction(written), responseWritten: true };
    });
  }

  async #listSessions(account: string | undefined, limit: number, signal: AbortSignal): Promise<unknown> {
    if (account === undefined) return { sessions: this.#store.listSessions(limit) };
    const profile = this.#store.requireProfile(account);
    this.#assertSignedIn(profile);
    if (await this.#cloud.isCompactProjectionRecoveryUnsettledForProfile(profile.id)) {
      await this.#daemonAuthority.assertCurrent();
      return {
        sessions: this.#store.listSessions(limit, profile.id),
        recovery: {
          diagnostic: "Provider reconciliation is paused while compact-projection recovery preserves exact local authority.",
          required: true,
        },
      };
    }
    const remote = await this.#fencedEffect(async () => await this.#codex.listSessions({ authority: authorityFor(this.#paths, profile), limit, signal }));
    const projects = this.#store.listProjects();
    const sessions = remote.map((projection) => {
      const projectId = projection.projectRoot === undefined ? undefined : projects.find((project) => project.rootPath === projection.projectRoot)?.id;
      return this.#store.upsertProviderSession({
        profileId: profile.id,
        providerThreadId: projection.providerThreadId,
        ...(projectId === undefined ? {} : { projectId }),
        title: projection.title,
        state: projection.status,
        ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
        ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
      });
    });
    return { sessions };
  }

  async #showSession(selector: string, detail: boolean, signal: AbortSignal): Promise<unknown> {
    const session = this.#store.requireSession(selector);
    if (session.providerThreadId === undefined) return { session, effectiveRuntimeProfile: this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null };
    const providerThreadId = session.providerThreadId;
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const projectionRecoveryUnsettled = await this.#cloud
      .isCompactProjectionRecoveryUnsettled(session.id);
    await this.#daemonAuthority.assertCurrent();
    const projection = await this.#fencedEffect(async () => await this.#codex.readSession({ authority: authorityFor(this.#paths, profile), providerThreadId, detail, signal }));
    if (projectionRecoveryUnsettled || this.#projectionRecoveriesInFlight.has(session.id)) {
      const runtimeProfile = this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null;
      const coherentSession = this.#store.requireSession(session.id);
      return {
        session: coherentSession,
        ...(projection.providerThreadId === providerThreadId ? { projection } : {}),
        effectiveRuntimeProfile: runtimeProfile,
        recovery: {
          cleared: false,
          diagnostic: projection.providerThreadId === providerThreadId
            ? "Compact-projection recovery preserves this session's exact local authority; provider state was read without changing local custody."
            : "Codex returned a different provider thread while compact-projection recovery preserves this session; local custody was left unchanged.",
          required: true,
        },
      };
    }
    if (projection.providerThreadId !== providerThreadId) {
      this.#quarantineSession(session.id);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex returned a projection for a different provider thread; the session remains quarantined.");
    }
    const coherentSession = this.#store.requireSession(session.id);
    const runtimeProfile = this.#store.latestSessionRuntimeProfile(session.id)?.profile ?? null;
    return coherentSession.state === "recovery_required"
      ? { session: coherentSession, projection, effectiveRuntimeProfile: runtimeProfile, recovery: { required: true, cleared: false } }
      : { session: coherentSession, projection, effectiveRuntimeProfile: runtimeProfile };
  }

  async #startSession(command: Extract<LocalCommand, { kind: "session.start" }>, signal: AbortSignal): Promise<unknown> {
    const profile = this.#store.requireProfile(command.account);
    this.#assertSignedIn(profile);
    const project = command.project === undefined ? this.#store.listProjects().find((candidate) => candidate.default) : this.#store.requireProject(command.project);
    if (project === undefined) throw new CommandFailure("INTERACTION_REQUIRED", "Add or select a project directory before starting a session.");
    const key = command.idempotencyKey ?? randomUUID();
    let localSessionId: SessionRecord["id"] | undefined;
    let clientMessageId: string | undefined;
    let review: RuntimeStartReview | undefined;
    let startedProjection: (CodexSessionProjection & { effectiveRuntimeProfile: z.infer<typeof effectiveRuntimeProfileSchema> }) | undefined;
    const outcome = await this.#effect<z.infer<typeof sessionStartReceiptSchema>>({
      kind: "session.start",
      authorityId: profile.id,
      authorityGeneration: profile.processGeneration,
      request: { projectId: project.id, preset: command.preset, fast: command.fast },
      idempotencyKey: key,
      beginEffect: async (attemptId) => {
        clientMessageId = attemptId;
        review = await this.#fencedEffect(async () => await this.#codex.reviewSessionStart({
          authority: authorityFor(this.#paths, profile),
          projectRoot: project.rootPath,
          preset: command.preset,
          fast: command.fast,
          signal,
        }));
        const local = this.#store.beginSessionStartEffect({
          attemptId,
          profileId: profile.id,
          profileGeneration: profile.processGeneration,
          projectId: project.id,
          preset: command.preset,
          fastEnabled: command.fast,
          evidence: {
            kind: "session.start",
            projectId: project.id,
            clientMessageId: null,
            messageDigest: null,
            runtimeProfile: review.effectiveRuntimeProfile,
          },
        });
        localSessionId = local.id;
      },
      effect: async () => {
        if (localSessionId === undefined || clientMessageId === undefined || review === undefined) throw new Error("Session start effect lost its durable placeholder or runtime-review binding.");
        const runtimeReview = review;
        const local = this.#store.requireSession(localSessionId);
        try {
          startedProjection = await this.#fencedEffect(async () => await this.#codex.startSession({ authority: authorityFor(this.#paths, profile), projectRoot: project.rootPath, review: runtimeReview, signal }));
        } catch (error: unknown) {
          await this.#daemonAuthority.assertCurrent();
          if (error instanceof IndeterminateCodexEffectError) {
            this.#quarantineSession(local.id);
            throw error;
          }
          if (!this.#store.deleteUnboundStartingSession(local.id, local.revision)) {
            this.#quarantineSession(local.id);
            throw new IndeterminateLocalCommitError("Codex rejected session creation, but its unused local placeholder could not be removed.", error);
          }
          throw error;
        }
        return { sessionId: local.id, sourceId: clientMessageId, effectiveRuntimeProfile: startedProjection.effectiveRuntimeProfile };
      },
      receipt: (value) => sessionStartReceiptSchema.parse(value),
      restore: (value) => sessionStartReceiptSchema.parse(value),
      commit: (attemptId, _value, receipt) => {
        if (localSessionId === undefined || startedProjection === undefined) throw new Error("Session start commit lost its exact provider projection.");
        const local = this.#store.requireSession(localSessionId);
        this.#store.completeSessionStartEffect({
          attemptId,
          sessionId: local.id,
          expectedSessionRevision: local.revision,
          providerThreadId: startedProjection.providerThreadId,
          state: startedProjection.status,
          ...(startedProjection.activeTurnId === undefined ? {} : { activeTurnId: startedProjection.activeTurnId }),
          ...(startedProjection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: startedProjection.providerUpdatedAt }),
          runtimeProfile: startedProjection.effectiveRuntimeProfile,
          receipt,
        });
      },
      onAmbiguous: () => {
        if (localSessionId !== undefined) this.#quarantineSession(localSessionId);
      },
    });
    return {
      session: this.#store.requireSession(outcome.sessionId),
      effectiveRuntimeProfile: outcome.effectiveRuntimeProfile
        ?? this.#store.latestSessionRuntimeProfile(outcome.sessionId)?.profile
        ?? null,
      idempotencyKey: key,
    };
  }

  async #send(selector: string, message: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const project = session.projectId === undefined ? undefined : this.#store.requireProject(session.projectId);
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let review: RuntimeStartReview | undefined;
    let dispatchSessionRevision: number | undefined;
    let dispatchFactEpoch: number | undefined;
    let startedResult: { turnId: string; status: "completed" | "interrupted" | "failed" | "inProgress"; effectiveRuntimeProfile: z.infer<typeof effectiveRuntimeProfileSchema> } | undefined;
    const result = await this.#effect<z.infer<typeof turnStartReceiptSchema>>({ kind: "session.send", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { message }, idempotencyKey: key, effect: async (attemptId) => {
      if (baseline === undefined || review === undefined) throw new Error("Session send lost its exact pre-effect provider baseline or runtime review.");
      const runtimeReview = review;
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) throw new CommandFailure("CONFLICT", "The session already has an active turn. Use `session steer` or `session queue`.");
      startedResult = await this.#fencedEffect(async () => await this.#codex.startTurn({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, ...(project === undefined ? {} : { projectRoot: project.rootPath }), review: runtimeReview, message, clientMessageId: attemptId, signal }));
      return { ...startedResult, sourceId: attemptId };
    }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) throw new CommandFailure("CONFLICT", "The session already has an active turn. Use `session steer` or `session queue`.");
      review = await this.#fencedEffect(async () => await this.#codex.reviewTurnStart({
        authority: authorityFor(this.#paths, profile),
        providerThreadId: session.providerThreadId,
        ...(project === undefined ? {} : { projectRoot: project.rootPath }),
        preset: session.preset,
        fast: session.fastEnabled,
        signal,
      }));
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.send",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          clientMessageId: attemptId,
          messageDigest: digestText(message),
          runtimeProfile: review.effectiveRuntimeProfile,
        },
      });
      dispatchSessionRevision = this.#store.requireSession(session.id).revision;
      dispatchFactEpoch = this.#sessionFactEpochs.get(session.id) ?? 0;
    }, receipt: (value) => turnStartReceiptSchema.parse(value), restore: (value) => turnStartReceiptSchema.parse(value), commit: (attemptId, _value, receipt) => {
      if (startedResult === undefined || dispatchSessionRevision === undefined || dispatchFactEpoch === undefined) throw new Error("Session turn commit lost its exact provider result, local revision, or fact epoch.");
      this.#store.completeSessionTurnEffect({
        attemptId,
        sessionId: session.id,
        expectedSessionRevision: dispatchSessionRevision,
        applyResponseState: (this.#sessionFactEpochs.get(session.id) ?? 0) === dispatchFactEpoch,
        turnId: startedResult.turnId,
        turnStatus: startedResult.status,
        runtimeProfile: startedResult.effectiveRuntimeProfile,
        receipt,
      });
    }, onAmbiguous: () => this.#quarantineSession(session.id) });
    const reconciled = this.#store.requireSession(session.id);
    if (reconciled.state === "idle") this.#scheduleQueueDispatch(reconciled);
    return { session: reconciled, turnId: result.turnId, effectiveRuntimeProfile: result.effectiveRuntimeProfile ?? null, idempotencyKey: key };
  }

  async #steer(selector: string, message: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let activeTurnId: string | undefined;
    const result = await this.#effect({ kind: "session.steer", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { message }, idempotencyKey: key, effect: async (attemptId) => {
      if (activeTurnId === undefined) throw new CommandFailure("CONFLICT", "The session has no active turn to steer.");
      const turnId = activeTurnId;
      await this.#fencedEffect(async () => await this.#codex.steer({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, activeTurnId: turnId, message, clientMessageId: attemptId, signal }));
      return { steered: true as const, activeTurnId: turnId };
    }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      activeTurnId = baseline.activeTurnId;
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.steer",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          activeTurnId: activeTurnId ?? null,
          clientMessageId: attemptId,
          messageDigest: digestText(message),
        },
      });
    }, receipt: (value) => steeredReceiptSchema.parse(value), restore: (value) => steeredReceiptSchema.parse(value), onAmbiguous: () => this.#quarantineSession(session.id) });
    return { steered: true, turnId: result.activeTurnId, idempotencyKey: key };
  }

  async #queue(selector: string, message: string, idempotencyKey: string | undefined): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const key = idempotencyKey ?? randomUUID();
    const queued = this.#store.enqueueIdempotent({ sessionId: session.id, profileGeneration: profile.processGeneration, message, idempotencyKey: key });
    const observed = this.#store.requireSession(session.id);
    if (queued.state === "pending" && observed.state === "idle") {
      this.#scheduleQueueDispatch(observed);
    }
    return { queued, idempotencyKey: key };
  }

  #scheduleQueueDispatch(session: SessionRecord): void {
    if (this.#state !== "open") return;
    const profile = this.#store.requireProfile(session.profileId);
    const task = this.#serializeSessionAuthority(session, async () => this.#dispatchNextQueue(session.id, authorityFor(this.#paths, profile)));
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #scheduleIdleQueue(session: SessionRecord): void {
    if (session.state === "idle") this.#scheduleQueueDispatch(session);
  }

  #resetQueuePreEffectRetries(sessionId: SessionRecord["id"]): void {
    for (const queued of this.#store.listQueue(sessionId)) {
      this.#queuePreEffectRetryCounts.delete(queued.id);
    }
  }

  #scheduleQueuePreEffectRetry(session: SessionRecord, queueId: string): void {
    if (this.#state !== "open" || this.#queuePreEffectRetryScheduled.has(queueId)) return;
    const retryCount = this.#queuePreEffectRetryCounts.get(queueId) ?? 0;
    const delayMs = QUEUE_PRE_EFFECT_RETRY_DELAYS_MS[retryCount];
    if (delayMs === undefined) return;
    this.#queuePreEffectRetryCounts.set(queueId, retryCount + 1);
    this.#queuePreEffectRetryScheduled.add(queueId);
    const task = (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      this.#queuePreEffectRetryScheduled.delete(queueId);
      if (this.#state !== "open") return;
      const queued = this.#store.requireQueue(queueId);
      const current = this.#store.requireSession(session.id);
      if (queued.state !== "pending" || current.state !== "idle") {
        if (queued.state !== "pending") this.#queuePreEffectRetryCounts.delete(queueId);
        return;
      }
      const profile = this.#store.requireProfile(current.profileId);
      if (profile.state !== "signed_in") return;
      await this.#serializeSessionAuthority(current, async () => this.#dispatchNextQueue(current.id, authorityFor(this.#paths, profile)));
      if (this.#store.requireQueue(queueId).state !== "pending") this.#queuePreEffectRetryCounts.delete(queueId);
    })();
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => this.#background.delete(tracked));
  }

  #isRetryableQueuePreEffectError(error: unknown): boolean {
    return !(error instanceof CommandFailure
      || error instanceof DaemonAuthoritySafetyError
      || error instanceof IndeterminateCodexEffectError
      || error instanceof IndeterminateLocalCommitError);
  }

  async #stop(selector: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    let activeTurnId: string | null = null;
    const result = await this.#effect({ kind: "session.stop", authorityId: session.id, authorityGeneration: profile.processGeneration, request: {}, idempotencyKey: key, effect: async () => {
      if (activeTurnId === null) return { stopped: false as const, activeTurnId: null };
      const turnId = activeTurnId;
      await this.#fencedEffect(async () => await this.#codex.interrupt({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, activeTurnId: turnId, signal }));
      return { stopped: true as const, activeTurnId: turnId };
    }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      activeTurnId = baseline.activeTurnId ?? null;
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.stop",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          activeTurnId,
        },
      });
    }, receipt: (value) => stoppedReceiptSchema.parse(value), restore: (value) => stoppedReceiptSchema.parse(value), onAmbiguous: () => this.#quarantineSession(session.id) });
    if (!result.stopped) return { stopped: false, reason: "idle", idempotencyKey: key };
    try {
      const observed = this.#store.requireSession(session.id);
      return { stopped: true, session: observed.state === "idle" && observed.activeTurnId === undefined ? observed : this.#store.reconcileSessionFromProvider({ sessionId: session.id, state: "idle", activeTurnId: null }), idempotencyKey: key };
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      this.#quarantineSession(session.id);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex stopped the turn, but its local session state could not be committed; the session is quarantined.", { cause: error instanceof Error ? error.name : "error" });
    }
  }

  async #rename(selector: string, name: string, idempotencyKey: string | undefined, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(selector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    const key = idempotencyKey ?? randomUUID();
    let baseline: CodexSessionProjection | undefined;
    await this.#effect({ kind: "session.rename", authorityId: session.id, authorityGeneration: profile.processGeneration, request: { name }, idempotencyKey: key, effect: async () => { await this.#fencedEffect(async () => await this.#codex.rename({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, name, signal })); return { renamed: true as const }; }, beginEffect: async (attemptId) => {
      baseline = await this.#readExactSessionProjection(session, profile, false, signal);
      this.#store.beginSessionMutationEffect({
        attemptId,
        sessionId: session.id,
        profileGeneration: profile.processGeneration,
        evidence: {
          kind: "session.rename",
          providerThreadId: session.providerThreadId,
          baseline: this.#providerBaseline(baseline),
          requestedName: name,
        },
      });
    }, receipt: (value) => renamedReceiptSchema.parse(value), restore: (value) => renamedReceiptSchema.parse(value), onAmbiguous: () => this.#quarantineSession(session.id) });
    try {
      const observed = this.#store.requireSession(session.id);
      return { session: observed.title === name ? observed : this.#store.reconcileSessionFromProvider({ sessionId: session.id, title: name }), idempotencyKey: key };
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      this.#quarantineSession(session.id);
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex renamed the session, but its local title could not be committed; the session is quarantined.", { cause: error instanceof Error ? error.name : "error" });
    }
  }

  async #resolveSessionRecovery(selector: string, action: "recover" | "abandon", signal: AbortSignal): Promise<unknown> {
    const session = this.#store.requireSession(selector);
    if (session.state !== "recovery_required") {
      throw new CommandFailure("CONFLICT", "The session does not currently require recovery.");
    }
    const unsettled = this.#store.listUnsettledMutations({ sessionId: session.id });
    const unsettledQueue = this.#store.listUnsettledQueueEffects(session.id);
    if (unsettled.length + unsettledQueue.length === 0) {
      if (action === "abandon") {
        const resolved = this.#store.resolveSessionStatusRecovery({
          sessionId: session.id,
          expectedRevision: session.revision,
          resolution: "abandoned",
        });
        this.#scheduleIdleQueue(resolved);
        return {
          session: resolved,
          recovery: {
            resolved: true,
            resolution: "abandoned",
            providerEffectRetried: false,
            providerStateDeleted: false,
          },
        };
      }
      if (session.providerThreadId === undefined) {
        throw new CommandFailure("RECOVERY_REQUIRED", "The status quarantine has no exact provider-thread binding. Run `hra session abandon` to release only the local authority.");
      }
      const profile = this.#store.requireProfile(session.profileId);
      this.#assertSignedIn(profile);
      const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
      const resolved = this.#store.resolveSessionStatusRecovery({
        sessionId: session.id,
        expectedRevision: session.revision,
        resolution: "provider_state_reconciled",
        provider: {
          providerThreadId: projection.providerThreadId,
          title: projection.title,
          status: projection.status,
          ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
          ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
        },
      });
      this.#scheduleIdleQueue(resolved);
      return {
        session: resolved,
        projection,
        recovery: {
          resolved: true,
          resolution: "provider_state_reconciled",
          providerEffectRetried: false,
        },
      };
    }
    if (unsettled.length + unsettledQueue.length !== 1) {
      throw new CommandFailure("RECOVERY_REQUIRED", "No single exact mutation authority is available for this session.");
    }
    if (unsettled.length === 0) {
      const queueEffect = unsettledQueue[0];
      if (queueEffect === undefined) throw new CommandFailure("RECOVERY_REQUIRED", "The queue recovery authority disappeared.");
      return await this.#resolveQueueRecovery(session, queueEffect, action, signal);
    }
    const attempt = unsettled[0];
    if (attempt?.evidence === undefined) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The mutation has no immutable pre-effect evidence and cannot be reconciled automatically.");
    }
    const originalState = attempt.originalState ?? attempt.state;
    if (originalState !== "effect_started" && originalState !== "ambiguous") {
      throw new CommandFailure("CONFLICT", "The mutation authority is already settled.");
    }

    if (session.providerThreadId === undefined) {
      if (attempt.kind !== "session.start" || attempt.sessionStartId !== session.id) {
        throw new CommandFailure("RECOVERY_REQUIRED", "The unbound session does not have an exact start-attempt binding.");
      }
      if (action !== "abandon") {
        throw new CommandFailure("RECOVERY_REQUIRED", "An unbound session start has no causal provider identifier. Inspect the account, then explicitly run `hra session abandon` if you accept releasing only the local authority.");
      }
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: attempt.evidence.digest,
        resolution: "abandoned",
        resolutionEvidence: { action: "user_abandon", providerEffectRetried: false, providerStateDeleted: false },
      });
      this.#scheduleIdleQueue(resolved);
      return { session: resolved, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } };
    }

    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    if (profile.processGeneration !== attempt.authorityGeneration) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The account generation changed after the uncertain session effect.");
    }
    const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
    const provider = {
      providerThreadId: projection.providerThreadId,
      title: projection.title,
      status: projection.status,
      ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
      ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
    } as const;
    if (action === "abandon") {
      const resolved = this.#store.resolveSessionMutation({
        attemptId: attempt.id,
        expectedOriginalState: originalState,
        expectedEvidenceDigest: attempt.evidence.digest,
        resolution: "abandoned",
        resolutionEvidence: { action: "user_abandon", providerEffectRetried: false, providerStateDeleted: false, observedProviderUpdatedAt: projection.providerUpdatedAt ?? null },
        provider,
      });
      this.#scheduleIdleQueue(resolved);
      return { session: resolved, projection, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } };
    }

    const proof = this.#proveSessionMutation(attempt, session.id, projection);
    if (proof === null) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The exact provider read does not contain kind-specific causal proof for the uncertain mutation. No effect was replayed.");
    }
    const resolved = this.#store.resolveSessionMutation({
      attemptId: attempt.id,
      expectedOriginalState: originalState,
      expectedEvidenceDigest: attempt.evidence.digest,
      resolution: "proven_applied",
      resolutionEvidence: proof.evidence,
      receipt: proof.receipt,
      provider,
    });
    this.#scheduleIdleQueue(resolved);
    return { session: resolved, projection, idempotencyKey: attempt.idempotencyKey, recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false } };
  }

  #proveSessionMutation(attempt: MutationAttemptRecord, sessionId: SessionRecord["id"], projection: CodexSessionProjection): { receipt: unknown; evidence: unknown } | null {
    const record = attempt.evidence;
    if (record === undefined) return null;
    const evidence: MutationEffectEvidence = record.evidence;
    if (evidence.kind !== attempt.kind) return null;
    if (evidence.kind === "session.start") {
      if (attempt.sessionStartId !== sessionId) return null;
      return { receipt: { sessionId, sourceId: attempt.id }, evidence: { kind: evidence.kind, providerThreadId: projection.providerThreadId, exactBinding: true } };
    }
    if (!("providerThreadId" in evidence) || projection.providerThreadId !== evidence.providerThreadId) return null;
    const strictlyNewer = evidence.baseline.providerUpdatedAt !== null
      && projection.providerUpdatedAt !== undefined
      && projection.providerUpdatedAt > evidence.baseline.providerUpdatedAt;
    if (!strictlyNewer) return null;
    if (evidence.kind === "session.send" || evidence.kind === "session.steer") {
      const matchingTurns = new Set((projection.messages ?? [])
        .filter((message) => message.role === "user" && message.clientId === evidence.clientMessageId && message.turnId !== undefined)
        .map((message) => message.turnId as string));
      if (matchingTurns.size !== 1) return null;
      const [turnId] = matchingTurns;
      if (turnId === undefined) return null;
      if (evidence.kind === "session.send") {
        return { receipt: { turnId, sourceId: attempt.id }, evidence: { kind: evidence.kind, clientMessageId: evidence.clientMessageId, turnId, providerUpdatedAt: projection.providerUpdatedAt } };
      }
      if (evidence.activeTurnId === null || turnId !== evidence.activeTurnId) return null;
      return { receipt: { steered: true, activeTurnId: evidence.activeTurnId }, evidence: { kind: evidence.kind, clientMessageId: evidence.clientMessageId, turnId, providerUpdatedAt: projection.providerUpdatedAt } };
    }
    if (evidence.kind === "session.stop") {
      if (evidence.activeTurnId === null || projection.activeTurnId === evidence.activeTurnId) return null;
      const observed = (projection.turnSummaries ?? []).find((turn) => turn.id === evidence.activeTurnId);
      const absentOrTerminal = observed === undefined || observed.status === "completed" || observed.status === "interrupted" || observed.status === "failed";
      if (!absentOrTerminal) return null;
      return { receipt: { stopped: true, activeTurnId: evidence.activeTurnId }, evidence: { kind: evidence.kind, activeTurnId: evidence.activeTurnId, observedStatus: observed?.status ?? "absent", providerUpdatedAt: projection.providerUpdatedAt } };
    }
    if (projection.title !== evidence.requestedName) return null;
    return { receipt: { renamed: true }, evidence: { kind: evidence.kind, requestedName: evidence.requestedName, providerUpdatedAt: projection.providerUpdatedAt } };
  }

  async #resolveQueueRecovery(
    session: SessionRecord,
    record: ReturnType<StateStore["readQueueEffect"]> extends infer T ? Exclude<T, null> : never,
    action: "recover" | "abandon",
    signal: AbortSignal,
  ): Promise<unknown> {
    if (session.providerThreadId === undefined) throw new CommandFailure("RECOVERY_REQUIRED", "The queued effect has no exact provider-thread binding.");
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    if (profile.processGeneration !== record.evidence.profileGeneration) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The account generation changed after the uncertain queued effect.");
    }
    const projection = await this.#readExactSessionProjection({ ...session, providerThreadId: session.providerThreadId }, profile, false, signal);
    const provider = {
      providerThreadId: projection.providerThreadId,
      title: projection.title,
      status: projection.status,
      ...(projection.activeTurnId === undefined ? {} : { activeTurnId: projection.activeTurnId }),
      ...(projection.providerUpdatedAt === undefined ? {} : { providerUpdatedAt: projection.providerUpdatedAt }),
    } as const;
    if (action === "abandon") {
      const resolved = this.#store.resolveQueueEffect({
        queueId: record.queueId,
        expectedEvidenceDigest: record.digest,
        resolution: "abandoned",
        resolutionEvidence: { action: "user_abandon", providerEffectRetried: false, providerStateDeleted: false, observedProviderUpdatedAt: projection.providerUpdatedAt ?? null },
        provider,
      });
      this.#scheduleIdleQueue(resolved);
      return { session: resolved, projection, queueId: record.queueId, recovery: { resolved: true, resolution: "abandoned", providerEffectRetried: false, providerStateDeleted: false } };
    }
    const baseline = record.evidence.baseline;
    const strictlyNewer = baseline.providerUpdatedAt !== null
      && projection.providerUpdatedAt !== undefined
      && projection.providerUpdatedAt > baseline.providerUpdatedAt;
    const matches = new Set((projection.messages ?? [])
      .filter((message) => message.role === "user" && message.clientId === record.evidence.clientMessageId && message.turnId !== undefined)
      .map((message) => message.turnId as string));
    const [turnId] = matches;
    if (!strictlyNewer || matches.size !== 1 || turnId === undefined) {
      throw new CommandFailure("RECOVERY_REQUIRED", "The exact provider read does not contain causal proof for the uncertain queued message. No effect was replayed.");
    }
    const receipt = { turnId, sourceId: record.queueId };
    const resolved = this.#store.resolveQueueEffect({
      queueId: record.queueId,
      expectedEvidenceDigest: record.digest,
      resolution: "proven_applied",
      resolutionEvidence: { kind: "queue.dispatch", clientMessageId: record.evidence.clientMessageId, turnId, providerUpdatedAt: projection.providerUpdatedAt },
      receipt,
      provider,
    });
    this.#scheduleIdleQueue(resolved);
    return { session: resolved, projection, queueId: record.queueId, recovery: { resolved: true, resolution: "proven_applied", providerEffectRetried: false } };
  }

  async #readExactSessionProjection(session: BoundSessionRecord, profile: ProfileRecord, detail: boolean, signal: AbortSignal): Promise<CodexSessionProjection> {
    const projection = await this.#fencedEffect(async () => await this.#codex.readSession({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, detail, signal }));
    if (projection.providerThreadId !== session.providerThreadId) {
      throw new CommandFailure("RECOVERY_REQUIRED", "Codex returned a projection for a different provider thread.");
    }
    return projection;
  }

  #providerBaseline(projection: CodexSessionProjection): Extract<MutationEffectEvidence, { kind: "session.send" }>["baseline"] {
    return {
      providerUpdatedAt: projection.providerUpdatedAt ?? null,
      status: projection.status,
      activeTurnId: projection.activeTurnId ?? null,
    };
  }

  async #inspectTurn(sessionSelector: string, turnId: string, signal: AbortSignal): Promise<unknown> {
    const session = this.#requireBoundSession(sessionSelector);
    const profile = this.#store.requireProfile(session.profileId);
    this.#assertSignedIn(profile);
    return await this.#fencedEffect(async () => await this.#codex.inspectTurn({ authority: authorityFor(this.#paths, profile), providerThreadId: session.providerThreadId, turnId, signal }));
  }

  #requireBoundSession(selector: string): BoundSessionRecord {
    const session = this.#store.requireSession(selector);
    if (session.providerThreadId === undefined) throw new CommandFailure("RECOVERY_REQUIRED", "The session has no proven provider binding.");
    if (session.state === "recovery_required") throw new CommandFailure("RECOVERY_REQUIRED", "The session requires recovery before another mutation.");
    if (session.state === "terminal") throw new CommandFailure("CONFLICT", "The session is terminal and cannot accept another mutation.");
    return { ...session, providerThreadId: session.providerThreadId };
  }

  #assertSignedIn(profile: ProfileRecord): void {
    if (profile.state === "recovery_required") {
      throw new CommandFailure("RECOVERY_REQUIRED", `Run \`hra account show ${profile.id}\` to reconcile this account before another provider operation.`);
    }
    if (profile.state !== "signed_in") {
      throw new CommandFailure("INTERACTION_REQUIRED", `Sign in to ${profile.label} with \`hra account login ${profile.id}\` before using its Codex runtime.`);
    }
  }

  #quarantineProfile(profile: Pick<ProfileRecord, "id" | "processGeneration" | "providerEmail" | "providerPlan">): ProfileRecord {
    const current = this.#store.requireProfile(profile.id);
    if (current.processGeneration !== profile.processGeneration) {
      throw new Error("Account generation changed before recovery quarantine.");
    }
    if (current.state !== "recovery_required" && !this.#store.setProfileState(profile.id, profile.processGeneration, "recovery_required", {
      ...(current.providerEmail === undefined ? {} : { email: current.providerEmail }),
      ...(current.providerPlan === undefined ? {} : { plan: current.providerPlan }),
    })) {
      throw new Error("Account could not be quarantined after an indeterminate provider effect.");
    }
    return this.#store.requireProfile(profile.id);
  }

  #quarantineSession(sessionId: SessionRecord["id"]): SessionRecord {
    const session = this.#store.quarantineSession(sessionId);
    if (session.state !== "recovery_required" && session.state !== "terminal") {
      throw new Error("Session quarantine did not reach a non-dispatchable state.");
    }
    return session;
  }

  #profileHasProjectionRecoveryInFlight(profileId: ProfileRecord["id"]): boolean {
    for (const sessionId of this.#projectionRecoveriesInFlight) {
      try {
        if (this.#store.requireSession(sessionId).profileId === profileId) return true;
      } catch {
        return true;
      }
    }
    return false;
  }

  async #updateSession(selector: string, fields: (session: SessionRecord) => Omit<Parameters<StateStore["updateSessionMetadata"]>[0], "sessionId">): Promise<SessionRecord> {
    const session = this.#store.requireSession(selector);
    return await this.#serializeSessionAuthority(session, () => {
      const current = this.#store.requireSession(session.id);
      return this.#store.updateSessionMetadata({ sessionId: current.id, ...fields(current) });
    });
  }

  #publicProfile(profile: ProfileRecord): unknown {
    return { id: profile.id, label: profile.label, state: profile.state, processGeneration: profile.processGeneration, providerEmail: profile.providerEmail, providerPlan: profile.providerPlan, updatedAt: profile.updatedAt };
  }

  async #dispatchNextQueue(sessionId: SessionRecord["id"], authority: ProfileAuthority): Promise<void> {
    const session = this.#store.requireSession(sessionId);
    if (session.state !== "idle" || session.providerThreadId === undefined) return;
    const boundSession: BoundSessionRecord = { ...session, providerThreadId: session.providerThreadId };
    const queued = this.#store.nextPendingQueue(session.id);
    if (queued === null) return;
    const project = session.projectId === undefined ? undefined : this.#store.requireProject(session.projectId);
    if (project === undefined) return;
    let evidence: ReturnType<StateStore["beginQueueEffect"]> | undefined;
    let providerApplied = false;
    try {
      const signal = new AbortController().signal;
      const profile = this.#store.requireProfile(session.profileId);
      const baseline = await this.#readExactSessionProjection(boundSession, profile, false, signal);
      if (baseline.status === "active" || baseline.activeTurnId !== undefined) return;
      const review = await this.#fencedEffect(async () => await this.#codex.reviewTurnStart({
        authority,
        providerThreadId: boundSession.providerThreadId,
        projectRoot: project.rootPath,
        preset: session.preset,
        fast: session.fastEnabled,
        signal,
      }));
      evidence = this.#store.beginQueueEffect({
        queueId: queued.id,
        sessionId: session.id,
        profileGeneration: authority.generation,
        evidence: {
          kind: "queue.dispatch",
          queueId: queued.id,
          sessionId: session.id,
          providerThreadId: boundSession.providerThreadId,
          profileGeneration: authority.generation,
          baseline: this.#providerBaseline(baseline),
          clientMessageId: queued.id,
          messageDigest: digestText(queued.message),
          runtimeProfile: review.effectiveRuntimeProfile,
        },
      });
      this.#queuePreEffectRetryCounts.delete(queued.id);
      const dispatchRevision = this.#store.requireSession(session.id).revision;
      const dispatchFactEpoch = this.#sessionFactEpochs.get(session.id) ?? 0;
      const result = await this.#fencedEffect(async () => await this.#codex.startTurn({ authority, providerThreadId: boundSession.providerThreadId, projectRoot: project.rootPath, review, message: queued.message, clientMessageId: queued.id, signal }));
      providerApplied = true;
      this.#store.completeQueueEffect({
        queueId: queued.id,
        expectedEvidenceDigest: evidence.digest,
        expectedSessionRevision: dispatchRevision,
        applyResponseState: (this.#sessionFactEpochs.get(session.id) ?? 0) === dispatchFactEpoch,
        turnId: result.turnId,
        turnStatus: result.status,
        runtimeProfile: result.effectiveRuntimeProfile,
        receipt: { turnId: result.turnId, sourceId: queued.id, status: result.status },
      });
      const observed = this.#store.requireSession(session.id);
      if (observed.state === "idle") this.#scheduleQueueDispatch(observed);
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      if (evidence === undefined) {
        if (this.#isRetryableQueuePreEffectError(error)) this.#scheduleQueuePreEffectRetry(session, queued.id);
        return;
      }
      this.#queuePreEffectRetryCounts.delete(queued.id);
      if (providerApplied || error instanceof IndeterminateCodexEffectError || error instanceof IndeterminateLocalCommitError) {
        this.#store.markQueueEffectAmbiguous(queued.id, evidence.digest);
        return;
      }
      if (!this.#store.failQueueEffect(queued.id)) return;
      const observed = this.#store.requireSession(session.id);
      if (observed.state === "idle") this.#scheduleQueueDispatch(observed);
    }
  }

  async #serialize<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      await this.#daemonAuthority.assertCurrent();
      return await operation();
    });
    this.#mutationTails.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#mutationTails.get(key) === current) this.#mutationTails.delete(key);
    }
  }

  async #serializeSessionAuthority<T>(
    session: Pick<SessionRecord, "id" | "profileId">,
    operation: () => Promise<T> | T,
    options: Readonly<{ allowDuringProjectionRecovery?: boolean }> = {},
  ): Promise<T> {
    return await this.#serialize(`account:${session.profileId}`, async () =>
      this.#serialize(`session:${session.id}`, async () => {
        if (options.allowDuringProjectionRecovery !== true) {
          const unsettled = await this.#cloud.isCompactProjectionRecoveryUnsettled(session.id);
          await this.#daemonAuthority.assertCurrent();
          if (unsettled) {
            throw new CommandFailure(
              "RECOVERY_REQUIRED",
              "This session has an unsettled compact-projection recovery. Retry that exact recovery before changing local or provider state.",
            );
          }
        }
        return await operation();
      }));
  }

  async #assertNoCompactProjectionRecoveryForProfile(profileId: ProfileRecord["id"]): Promise<void> {
    const unsettled = await this.#cloud.isCompactProjectionRecoveryUnsettledForProfile(profileId);
    await this.#daemonAuthority.assertCurrent();
    if (unsettled) {
      throw new CommandFailure(
        "RECOVERY_REQUIRED",
        "This account owns an unsettled compact-projection recovery. Retry that exact recovery before changing provider or account authority.",
      );
    }
  }

  async #effect<T>(input: { kind: string; authorityId: string; authorityGeneration: number; request: unknown; idempotencyKey: string | undefined; beginEffect?(attemptId: MutationAttemptRecord["id"]): Promise<void> | void; effect(attemptId: string): Promise<T>; receipt(result: T): unknown; restore(receipt: unknown): T; commit?(attemptId: MutationAttemptRecord["id"], result: T, receipt: unknown): Promise<void> | void; onAmbiguous?: (result: T | undefined) => void }): Promise<T> {
    const attempt = this.#store.prepareMutation(input);
    if (attempt.replay) {
      if (attempt.state === "applied") return input.restore(attempt.result);
      if (attempt.state === "reconciled") {
        if (attempt.result !== undefined) return input.restore(attempt.result);
        throw new CommandFailure("CONFLICT", `${input.kind} was explicitly resolved without replay and will never be dispatched under the same idempotency key.`, { idempotencyKey: input.idempotencyKey });
      }
      if (attempt.state === "effect_started" || attempt.state === "ambiguous") {
        throw new CommandFailure("RECOVERY_REQUIRED", `${input.kind} has an indeterminate earlier attempt and will not be replayed.`, { idempotencyKey: input.idempotencyKey });
      }
      if (attempt.state !== "prepared") throw new CommandFailure("CONFLICT", `${input.kind} already reached ${attempt.state}.`);
    }
    if (input.beginEffect === undefined) {
      if (!this.#store.transitionMutation(attempt.id, "prepared", "effect_started")) throw new CommandFailure("CONFLICT", "Mutation authority changed before effect dispatch.");
    } else {
      await input.beginEffect(attempt.id);
      await this.#daemonAuthority.assertCurrent();
    }
    let result: T;
    try {
      result = await input.effect(attempt.id);
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      const terminal = error instanceof IndeterminateCodexEffectError || error instanceof IndeterminateLocalCommitError ? "ambiguous" : "failed";
      if (terminal === "ambiguous") input.onAmbiguous?.(undefined);
      this.#store.transitionMutation(attempt.id, "effect_started", terminal, { code: error instanceof Error ? error.name : "error" });
      if (terminal === "ambiguous") throw new CommandFailure("RECOVERY_REQUIRED", `${input.kind} has an indeterminate provider or local commit outcome and will not be replayed.`, { idempotencyKey: input.idempotencyKey });
      throw error;
    }
    try {
      await this.#daemonAuthority.assertCurrent();
      const receipt = input.receipt(result);
      if (input.commit === undefined) {
        if (!this.#store.transitionMutation(attempt.id, "effect_started", "applied", receipt)) throw new Error("Mutation result authority changed before commit.");
      } else {
        await input.commit(attempt.id, result, receipt);
        await this.#daemonAuthority.assertCurrent();
      }
      return result;
    } catch (error: unknown) {
      await this.#daemonAuthority.assertCurrent();
      input.onAmbiguous?.(result);
      this.#store.transitionMutation(attempt.id, "effect_started", "ambiguous", { code: error instanceof Error ? error.name : "commit_error" });
      throw new CommandFailure("RECOVERY_REQUIRED", `${input.kind} completed externally but its durable receipt could not be committed; it will not be replayed.`, { idempotencyKey: input.idempotencyKey });
    }
  }
}
