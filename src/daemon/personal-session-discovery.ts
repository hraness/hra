import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { containsUnsafeTerminalScalar, redactAbsolutePaths } from "../domain/text-safety";
import type { Provider } from "../domain/presets";
import { redactCompleteSensitiveText } from "../sensitive-text";

export type PersonalSessionLiveness = "live" | "not_live" | "unknown";

/** Exact, storage-safe identity retained privately for a discovered Claude process. */
export type PersonalClaudeSourceProcessIdentity = Readonly<{
  pid: number;
  pidDomain: "darwin" | "linux";
  procStart: string;
}>;

/** The only provider metadata that may leave personal-home discovery. */
export type DiscoveredPersonalSession = Readonly<{
  provider: Provider;
  providerThreadId: string;
  title: string;
  projectRoot?: string;
  /** Provider activity time normalized to epoch milliseconds. */
  updatedAt?: number;
  liveness: PersonalSessionLiveness;
  /** Private exact source identity; never part of public session projections. */
  sourceProcessIdentity?: PersonalClaudeSourceProcessIdentity | null;
  /** False for a Claude row emitted only to fence retained-candidate reprobes. */
  admissionEligible?: boolean;
  /** Private age-gate waiver for a present Codex Desktop heartbeat target. */
  scheduledTaskTarget?: true;
}>;

export type PersonalSessionDiscoveryInput = Readonly<{
  provider: Provider;
  /** Exact personal Codex thread ids named by bounded Desktop automations. */
  codexScheduledThreadIds?: readonly string[];
  limit?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}>;

export interface PersonalSessionDiscoveryPort {
  discover(input: PersonalSessionDiscoveryInput): Promise<readonly DiscoveredPersonalSession[]>;
}

export type CodexPersonalSessionPageRequest = Readonly<{
  cursor?: string;
  limit: number;
  deadlineAt: number;
  signal: AbortSignal;
}>;

/** A closure can bind this source to the read-only app-server for the personal Codex home. */
export type CodexPersonalSessionPageSource = (
  input: CodexPersonalSessionPageRequest,
) => Promise<unknown>;

export type CodexPersonalSessionReadRequest = Readonly<{
  providerThreadId: string;
  deadlineAt: number;
  signal: AbortSignal;
}>;

/** Exact metadata-only read. It must not resume or subscribe to the thread. */
export type CodexPersonalSessionReadSource = (
  input: CodexPersonalSessionReadRequest,
) => Promise<unknown>;

export type ClaudeRegistryReadRequest = Readonly<{
  deadlineAt: number;
  maxFiles: number;
  maxFileBytes: number;
  signal: AbortSignal;
}>;

export type ClaudeRegistrySnapshot = Readonly<{
  records: readonly unknown[];
  /** True only when the source reached directory EOF without truncation or read failure. */
  complete: boolean;
}>;

/** Returns unknown records because every registry value is parsed again at this boundary. */
export type ClaudeRegistrySource = (input: ClaudeRegistryReadRequest) => Promise<unknown>;

export type ClaudeProcessIdentity = Readonly<{
  pid: number;
  pidDomain: string;
  procStart: number | string;
}>;

export type ClaudeProcessLivenessProbe = (
  identity: ClaudeProcessIdentity,
  input: Readonly<{ deadlineAt: number; signal: AbortSignal }>,
) => Promise<PersonalSessionLiveness>;

export type PersonalSessionDiscoveryOptions = Readonly<{
  codexListPage?: CodexPersonalSessionPageSource;
  codexReadSession?: CodexPersonalSessionReadSource;
  claudeRegistry?: ClaudeRegistrySource;
  claudeProcessLiveness?: ClaudeProcessLivenessProbe;
  pinnedClaudeVersion?: string;
  inferCodexLiveness?: (
    input: Readonly<{
      status: "active" | "idle" | "terminal";
      activeTurnId?: string;
      updatedAt?: number;
      now: number;
    }>,
  ) => PersonalSessionLiveness;
  now?: () => number;
}>;

export type ReadonlyCommandProcess = Readonly<{
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  exited: Promise<number>;
  terminate(): void;
  forceTerminate(): void;
}>;

export type ReadonlyCommandSpawnInput = Readonly<{
  argv: readonly [string, ...string[]];
  environment: Readonly<Record<string, string>>;
}>;

export type ReadonlyCommandSpawner = (
  input: ReadonlyCommandSpawnInput,
) => ReadonlyCommandProcess;

export type LocalProcessInspectionResult =
  | Readonly<{ status: "found"; procStart: number | string }>
  | Readonly<{ status: "not_found" | "unknown" }>;

export type LocalProcessInspector = (
  identity: ClaudeProcessIdentity,
  input: Readonly<{ deadlineAt: number; signal: AbortSignal }>,
) => Promise<LocalProcessInspectionResult>;

export type PidExistence = "exists" | "not_found" | "inaccessible" | "unknown";
export type PidExistenceProbe = (pid: number) => PidExistence;

export type LocalClaudeProcessLivenessOptions = Readonly<{
  currentPidDomain?: string | null;
  inspectProcess?: LocalProcessInspector;
  pidExists?: PidExistenceProbe;
  psPath?: string;
  spawn?: ReadonlyCommandSpawner;
  now?: () => number;
}>;

export type PersonalClaudeDiscoveryAdapterOptions = Readonly<{
  configDir: string;
  pinnedVersion: string;
}> & LocalClaudeProcessLivenessOptions;

export type PersonalClaudeDiscoveryAdapters = Readonly<{
  pinnedClaudeVersion: string;
  claudeRegistry: ClaudeRegistrySource;
  claudeProcessLiveness: ClaudeProcessLivenessProbe;
}>;

export const PERSONAL_SESSION_DISCOVERY_MAX_RESULTS = 200;
export const PERSONAL_SESSION_DISCOVERY_DEFAULT_DEADLINE_MS = 3_000;
export const PERSONAL_SESSION_DISCOVERY_MAX_DEADLINE_MS = 10_000;
export const PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS = 15 * 60 * 1_000;
export const CLAUDE_REGISTRY_MAX_FILE_BYTES = 32 * 1_024;
export const CLAUDE_REGISTRY_MAX_RECORDS = 200;

const DEFAULT_RESULT_LIMIT = 100;
const CODEX_PAGE_LIMIT = 50;
const CODEX_MAX_PAGES = 4;
const CODEX_SCHEDULED_EXACT_READ_MAX = 50;
const CODEX_RECENT_LIVENESS_WINDOW_MS = 10 * 60 * 1_000;
const CODEX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PROVIDER_ID_MAX_BYTES = 200;
const TITLE_MAX_BYTES = 320;
const PROJECT_ROOT_MAX_BYTES = 8 * 1_024;
const CURSOR_MAX_BYTES = 4 * 1_024;
const CLAUDE_VERSION_MAX_BYTES = 64;
const PID_DOMAIN_MAX_BYTES = 64;
const PROC_START_MAX_BYTES = 128;
const CLAUDE_REGISTRY_MAX_DIRECTORY_ENTRIES = CLAUDE_REGISTRY_MAX_RECORDS * 4;
const PS_STDOUT_MAX_BYTES = 256;
const COMMAND_TERMINATION_GRACE_MS = 100;
const ABSOLUTE_PATH_MAX_BYTES = 8 * 1_024;
const exactClaudeVersionPattern = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/u;
const textEncoder = new TextEncoder();

type ParsedCodexPage = Readonly<{
  sessions: readonly ParsedCodexSession[];
  nextCursor: string | null;
}>;

type ParsedCodexSession = Readonly<{
  providerThreadId: string;
  title: string;
  projectRoot?: string;
  updatedAt?: number;
  status: "active" | "idle" | "terminal";
  activeTurnId?: string;
}>;

type ParsedClaudeSession = Readonly<{
  providerThreadId: string;
  title: string;
  projectRoot?: string;
  updatedAt?: number;
  matchesPinnedVersion: boolean;
  identity?: ClaudeProcessIdentity;
  sourceProcessIdentity: PersonalClaudeSourceProcessIdentity | null;
}>;

type ClaudeCandidateAccumulator = {
  hasRecentExactPin: boolean;
  title: string;
  projectRoot: string | undefined;
  projectRootConflicted: boolean;
  updatedAt: number | undefined;
  liveness: PersonalSessionLiveness | undefined;
  sourceProcessIdentity: PersonalClaudeSourceProcessIdentity | null | undefined;
};

export class BoundedPersonalSessionDiscovery implements PersonalSessionDiscoveryPort {
  readonly #options: PersonalSessionDiscoveryOptions;
  readonly #now: () => number;

  constructor(options: PersonalSessionDiscoveryOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async discover(
    input: PersonalSessionDiscoveryInput,
  ): Promise<readonly DiscoveredPersonalSession[]> {
    const callerSignal = input.signal;
    callerSignal?.throwIfAborted();
    const limit = boundedResultLimit(input.limit);
    if (limit === 0) return Object.freeze([]);
    const controller = new AbortController();
    const forwardAbort = (): void => {
      if (callerSignal !== undefined) controller.abort(signalReason(callerSignal));
    };
    callerSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (callerSignal?.aborted === true) forwardAbort();
    const deadlineAt = this.#now() + boundedDeadlineMs(input.deadlineMs);
    try {
      const candidates = input.provider === "codex"
        ? await this.#discoverCodex(
            limit,
            deadlineAt,
            controller,
            input.codexScheduledThreadIds ?? [],
          )
        : await this.#discoverClaude(deadlineAt, controller);
      callerSignal?.throwIfAborted();
      return Object.freeze(sortCandidates(candidates).slice(0, limit));
    } finally {
      callerSignal?.removeEventListener("abort", forwardAbort);
      controller.abort(new Error("Personal session discovery settled."));
    }
  }

  async #discoverCodex(
    limit: number,
    deadlineAt: number,
    controller: AbortController,
    scheduledThreadIds: readonly string[],
  ): Promise<readonly DiscoveredPersonalSession[]> {
    const source = this.#options.codexListPage;
    const exactSource = this.#options.codexReadSession;
    if (source === undefined && exactSource === undefined) return [];
    const candidates = new Map<string, DiscoveredPersonalSession>();
    const scheduledIds = new Set<string>();
    for (const rawId of scheduledThreadIds) {
      const providerThreadId = safeProviderId(rawId);
      if (providerThreadId === null) continue;
      scheduledIds.add(providerThreadId);
      if (scheduledIds.size >= Math.min(limit, CODEX_SCHEDULED_EXACT_READ_MAX)) break;
    }

    // Recency-sorted pages cannot reliably reach an old automation target.
    // Read each bounded target directly through metadata-only thread/read;
    // controller resume remains reserved for the later durable claim.
    if (exactSource !== undefined && scheduledIds.size > 0) {
      const startedAt = this.#now();
      const remainingMs = Math.max(1, deadlineAt - startedAt);
      // A scheduled target can be arbitrarily old, but it must never consume
      // the whole discovery deadline and suppress ordinary recent sessions.
      // Start the entire bounded target batch together, then reserve the final
      // third of the budget for the recency-sorted page source.
      const recentReserveMs = source === undefined
        ? 0
        : Math.max(1, Math.floor(remainingMs / 3));
      const scheduledDeadlineAt = deadlineAt - recentReserveMs;
      const scheduledController = new AbortController();
      const forwardScheduledAbort = (): void => {
        scheduledController.abort(signalReason(controller.signal));
      };
      controller.signal.addEventListener("abort", forwardScheduledAbort, { once: true });
      if (controller.signal.aborted) forwardScheduledAbort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onScheduledAbort: (() => void) | undefined;
      let acceptResults = true;
      const completedCandidates: DiscoveredPersonalSession[] = [];
      try {
        const reads = [...scheduledIds].map(async (providerThreadId) => {
          try {
            const raw = await exactSource({
              providerThreadId,
              deadlineAt: scheduledDeadlineAt,
              signal: scheduledController.signal,
            });
            const session = parseCodexSession(raw);
            if (
              !acceptResults
              || session === null
              || session.providerThreadId !== providerThreadId
              || session.status === "terminal"
              || session.updatedAt === undefined
            ) return null;
            const liveness = (this.#options.inferCodexLiveness ?? inferCodexLiveness)({
              status: session.status,
              ...(session.activeTurnId === undefined
                ? {}
                : { activeTurnId: session.activeTurnId }),
              updatedAt: session.updatedAt,
              now: this.#now(),
            });
            const candidate = freezeCandidate({
              provider: "codex",
              providerThreadId,
              title: session.title,
              ...(session.projectRoot === undefined
                ? {}
                : { projectRoot: session.projectRoot }),
              updatedAt: session.updatedAt,
              liveness: validLiveness(liveness),
              scheduledTaskTarget: true,
            });
            completedCandidates.push(candidate);
            return;
          } catch {
            // An exact target read is only an eligibility hint. Its failure
            // must not suppress independently verified recent candidates.
            return;
          }
        });
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            scheduledController.abort(
              new Error("Scheduled-target discovery reached its reserved deadline."),
            );
            resolve(null);
          }, Math.max(1, scheduledDeadlineAt - this.#now()));
        });
        const aborted = new Promise<null>((resolve) => {
          onScheduledAbort = () => resolve(null);
          scheduledController.signal.addEventListener(
            "abort",
            onScheduledAbort,
            { once: true },
          );
        });
        await Promise.race([Promise.all(reads), timeout, aborted]);
        acceptResults = false;
        for (const candidate of completedCandidates) {
          candidates.set(candidate.providerThreadId, candidate);
        }
      } finally {
        acceptResults = false;
        if (timer !== undefined) clearTimeout(timer);
        if (onScheduledAbort !== undefined) {
          scheduledController.signal.removeEventListener("abort", onScheduledAbort);
        }
        controller.signal.removeEventListener("abort", forwardScheduledAbort);
        scheduledController.abort(new Error("Scheduled-target discovery settled."));
      }
    }

    if (source === undefined) return [...candidates.values()];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < CODEX_MAX_PAGES && candidates.size < limit; pageIndex += 1) {
      if (controller.signal.aborted) break;
      const remainingMs = deadlineAt - this.#now();
      if (remainingMs <= 0) break;
      let raw: unknown;
      try {
        raw = await settleBeforeDeadline(
          source({
            ...(cursor === undefined ? {} : { cursor }),
            limit: Math.min(CODEX_PAGE_LIMIT, limit - candidates.size),
            deadlineAt,
            signal: controller.signal,
          }),
          remainingMs,
          controller,
        );
      } catch {
        break;
      }
      const page = parseCodexPage(raw);
      if (page === null) break;
      for (const session of page.sessions) {
        const scheduledTaskTarget = scheduledIds.has(session.providerThreadId);
        if (
          session.status === "terminal"
          || (
            !scheduledTaskTarget
            && !withinDiscoveryRecency(session.updatedAt, this.#now())
          )
          || session.updatedAt === undefined
        ) continue;
        const liveness = (this.#options.inferCodexLiveness ?? inferCodexLiveness)({
          status: session.status,
          ...(session.activeTurnId === undefined ? {} : { activeTurnId: session.activeTurnId }),
          updatedAt: session.updatedAt,
          now: this.#now(),
        });
        candidates.set(session.providerThreadId, freezeCandidate({
          provider: "codex",
          providerThreadId: session.providerThreadId,
          title: session.title,
          ...(session.projectRoot === undefined ? {} : { projectRoot: session.projectRoot }),
          updatedAt: session.updatedAt,
          liveness: validLiveness(liveness),
          ...(scheduledTaskTarget ? { scheduledTaskTarget: true } : {}),
        }));
        if (candidates.size >= limit) break;
      }
      if (page.nextCursor === null || seenCursors.has(page.nextCursor)) break;
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return [...candidates.values()];
  }

  async #discoverClaude(
    deadlineAt: number,
    controller: AbortController,
  ): Promise<readonly DiscoveredPersonalSession[]> {
    const expectedVersion = safeBoundedString(
      this.#options.pinnedClaudeVersion,
      CLAUDE_VERSION_MAX_BYTES,
    );
    if (expectedVersion === null || !exactClaudeVersionPattern.test(expectedVersion)) return [];
    const candidates = new Map<string, ClaudeCandidateAccumulator>();

    const registry = this.#options.claudeRegistry;
    if (registry === undefined || deadlineAt <= this.#now()) {
      throw new Error("A complete Claude registry snapshot is unavailable.");
    }
    const rawRegistry = await settleBeforeDeadline(
      registry({
        deadlineAt,
        maxFiles: CLAUDE_REGISTRY_MAX_RECORDS,
        maxFileBytes: CLAUDE_REGISTRY_MAX_FILE_BYTES,
        signal: controller.signal,
      }),
      deadlineAt - this.#now(),
      controller,
    );
    const snapshot = normalizeClaudeRegistrySnapshot(rawRegistry);
    if (!snapshot.complete) {
      throw new Error("The Claude registry snapshot is incomplete.");
    }
    for (let index = 0; index < snapshot.records.length; index += 1) {
      if (controller.signal.aborted || deadlineAt <= this.#now()) {
        throw new Error("The Claude registry snapshot was not inspected completely.");
      }
      const session = parseClaudeSession(snapshot.records[index], "Claude session", expectedVersion);
      if (session === null) {
        throw new Error("The Claude registry snapshot contains an invalid record.");
      }
      let liveness: PersonalSessionLiveness = "unknown";
      if (session.identity !== undefined && this.#options.claudeProcessLiveness !== undefined) {
        try {
          liveness = validLiveness(await settleBeforeDeadline(
            this.#options.claudeProcessLiveness(session.identity, {
              deadlineAt,
              signal: controller.signal,
            }),
            deadlineAt - this.#now(),
            controller,
          ));
        } catch {
          liveness = "unknown";
        }
      }
      const recentExactPin = session.matchesPinnedVersion
        && withinDiscoveryRecency(session.updatedAt, this.#now());
      const authorityEligible = recentExactPin && session.sourceProcessIdentity !== null;
      const contribution = liveness === "live"
        ? "live"
        : authorityEligible
          ? liveness
          : "unknown";
      const existing: ClaudeCandidateAccumulator = candidates.get(session.providerThreadId) ?? {
        hasRecentExactPin: false,
        projectRootConflicted: false,
        title: session.title,
        projectRoot: undefined,
        updatedAt: session.updatedAt,
        liveness: undefined,
        sourceProcessIdentity: undefined,
      };
      existing.liveness = mergeClaudeLiveness(existing.liveness, contribution);
      existing.sourceProcessIdentity = mergeClaudeSourceProcessIdentity(
        existing.sourceProcessIdentity,
        authorityEligible ? session.sourceProcessIdentity : null,
      );
      if (
        !recentExactPin
        && !existing.hasRecentExactPin
        && session.updatedAt !== undefined
      ) {
        existing.updatedAt = existing.updatedAt === undefined
          ? session.updatedAt
          : Math.max(existing.updatedAt, session.updatedAt);
      }
      if (recentExactPin) {
        if (!existing.hasRecentExactPin) {
          existing.title = session.title;
          existing.projectRoot = session.projectRoot;
          existing.updatedAt = session.updatedAt;
        } else {
          if (existing.projectRoot !== session.projectRoot) {
            existing.projectRoot = undefined;
            existing.projectRootConflicted = true;
          }
          if (existing.updatedAt === undefined) {
            existing.updatedAt = session.updatedAt;
          } else if (session.updatedAt !== undefined) {
            existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt);
          }
        }
        existing.hasRecentExactPin = true;
      }
      candidates.set(session.providerThreadId, existing);
      if (abortRequested(controller.signal) && index + 1 < snapshot.records.length) {
        throw new Error("The Claude registry snapshot was not inspected completely.");
      }
    }
    const output: DiscoveredPersonalSession[] = [];
    for (const [providerThreadId, candidate] of candidates) {
      if (!candidate.hasRecentExactPin || candidate.updatedAt === undefined) {
        output.push(freezeCandidate({
          provider: "claude",
          providerThreadId,
          title: candidate.title,
          ...(candidate.updatedAt === undefined ? {} : { updatedAt: candidate.updatedAt }),
          liveness: candidate.liveness === "live" ? "live" : "unknown",
          sourceProcessIdentity: null,
          admissionEligible: false,
        }));
        continue;
      }
      const sourceProcessIdentity = candidate.sourceProcessIdentity ?? null;
      const mergedLiveness = candidate.liveness ?? "unknown";
      const liveness = mergedLiveness === "live"
        ? "live"
        : sourceProcessIdentity !== null
          ? mergedLiveness
          : "unknown";
      output.push(freezeCandidate({
        provider: "claude",
        providerThreadId,
        title: candidate.title,
        ...(
          candidate.projectRoot === undefined || candidate.projectRootConflicted
            ? {}
            : { projectRoot: candidate.projectRoot }
        ),
        updatedAt: candidate.updatedAt,
        liveness,
        sourceProcessIdentity,
        admissionEligible: true,
      }));
    }
    return output;
  }
}

/**
 * Compose the registry and process-liveness adapters for one explicitly
 * supplied personal Claude configuration directory. No Claude command is used
 * for discovery: the CLI has no reviewed read-only session-list operation.
 */
export function createPersonalClaudeDiscoveryAdapters(
  options: PersonalClaudeDiscoveryAdapterOptions,
): PersonalClaudeDiscoveryAdapters {
  if (!safeAbsolutePath(options.configDir)) {
    throw new Error("The personal Claude configuration directory must be absolute.");
  }
  if (!exactClaudeVersionPattern.test(options.pinnedVersion)) {
    throw new Error("The pinned Claude version is invalid.");
  }
  return Object.freeze({
    pinnedClaudeVersion: options.pinnedVersion,
    claudeRegistry: createClaudeRegistrySource(join(options.configDir, "sessions"), options.now),
    claudeProcessLiveness: createLocalClaudeProcessLivenessProbe({
      ...(options.currentPidDomain === undefined
        ? {}
        : { currentPidDomain: options.currentPidDomain }),
      ...(options.inspectProcess === undefined ? {} : { inspectProcess: options.inspectProcess }),
      ...(options.pidExists === undefined ? {} : { pidExists: options.pidExists }),
      ...(options.psPath === undefined ? {} : { psPath: options.psPath }),
      ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  });
}

/**
 * Compare a Claude registry identity with the local process table. A matching
 * host start token is conservatively treated as live; a missing process or a
 * token mismatch is not live. Unsupported domain, inaccessible metadata,
 * cancellation, and inspection failure stay unknown.
 */
export function createLocalClaudeProcessLivenessProbe(
  options: LocalClaudeProcessLivenessOptions = {},
): ClaudeProcessLivenessProbe {
  const currentPidDomain = options.currentPidDomain === undefined
    ? pidDomainForPlatform(process.platform)
    : options.currentPidDomain;
  const inspect = options.inspectProcess ?? createPsLocalProcessInspector(options);
  return async (identity, input) => {
    if (currentPidDomain === null || identity.pidDomain !== currentPidDomain) return "unknown";
    if (input.signal.aborted) return "unknown";
    let inspection: LocalProcessInspectionResult;
    try {
      inspection = await inspect(identity, input);
    } catch {
      return "unknown";
    }
    switch (inspection.status) {
      case "found":
        return inspection.procStart === identity.procStart ? "live" : "not_live";
      case "not_found":
        return "not_live";
      case "unknown":
        return "unknown";
    }
  };
}

/** A non-shell `ps` process inspector, fenced first by a PID-existence probe. */
export function createPsLocalProcessInspector(
  options: Omit<LocalClaudeProcessLivenessOptions, "inspectProcess"> = {},
): LocalProcessInspector {
  const currentPidDomain = options.currentPidDomain === undefined
    ? pidDomainForPlatform(process.platform)
    : options.currentPidDomain;
  const psPath = options.psPath ?? "/bin/ps";
  const spawn = options.spawn ?? spawnReadonlyBunCommand;
  const pidExists = options.pidExists ?? probeLocalPidExistence;
  const now = options.now ?? Date.now;
  return async (identity, input) => {
    if (
      currentPidDomain === null
      || identity.pidDomain !== currentPidDomain
      || typeof identity.procStart !== "string"
      || !isAbsolute(psPath)
    ) return Object.freeze({ status: "unknown" } as const);
    const before = pidExists(identity.pid);
    if (before === "not_found") return Object.freeze({ status: "not_found" } as const);
    if (before !== "exists") return Object.freeze({ status: "unknown" } as const);
    let result: Readonly<{ exitCode: number; stdout: string }>;
    try {
      result = await runBoundedReadonlyCommand({
        argv: [psPath, "-p", String(identity.pid), "-o", "lstart="],
        environment: Object.freeze({
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          // Claude records `procStart` from `ps lstart` in UTC.
          TZ: "UTC",
        }),
        maxStdoutBytes: PS_STDOUT_MAX_BYTES,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
        spawn,
        now,
      });
    } catch {
      return Object.freeze({ status: "unknown" } as const);
    }
    if (result.exitCode !== 0) {
      return pidExists(identity.pid) === "not_found"
        ? Object.freeze({ status: "not_found" } as const)
        : Object.freeze({ status: "unknown" } as const);
    }
    const lines = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length !== 1 || textEncoder.encode(lines[0] ?? "").byteLength > PROC_START_MAX_BYTES) {
      return Object.freeze({ status: "unknown" } as const);
    }
    return Object.freeze({ status: "found", procStart: lines[0] ?? "" } as const);
  };
}

export const probeLocalPidExistence: PidExistenceProbe = (pid) => {
  try {
    process.kill(pid, 0);
    return "exists";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "not_found";
    if (code === "EPERM" || code === "EACCES") return "inaccessible";
    return "unknown";
  }
};

export function spawnReadonlyBunCommand(input: ReadonlyCommandSpawnInput): ReadonlyCommandProcess {
  const child = Bun.spawn([...input.argv], {
    env: { ...input.environment },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return Object.freeze({
    exited: child.exited,
    stdout: readableStreamBytes(child.stdout),
    stderr: readableStreamBytes(child.stderr),
    terminate(): void {
      child.kill("SIGTERM");
    },
    forceTerminate(): void {
      child.kill("SIGKILL");
    },
  });
}

/**
 * Read the scalar allowlist from a Claude registry directory. Entries that are
 * not canonical `<pid>.json` candidates are ignored unless their decimal stem
 * is ambiguous or outside the safe PID range. A filename/content PID mismatch,
 * PID-named symlink, non-file, oversized or malformed document makes the whole
 * bounded snapshot incomplete, because it could hide a conflicting live
 * controller. Sibling key files and advertised socket paths are never opened
 * or returned.
 */
export function createClaudeRegistrySource(
  registryDirectory: string,
  now: () => number = Date.now,
): ClaudeRegistrySource {
  return async (input) => {
    const records: Readonly<Record<string, unknown>>[] = [];
    const maxFiles = boundedRegistryFileLimit(input.maxFiles);
    const snapshot = (complete: boolean): ClaudeRegistrySnapshot => Object.freeze({
      records: Object.freeze(records),
      complete,
    });
    if (maxFiles === 0 || input.signal.aborted || input.deadlineAt <= now()) {
      return snapshot(false);
    }
    let directory;
    try {
      directory = await opendir(registryDirectory);
    } catch {
      return snapshot(false);
    }
    let examined = 0;
    let pidNamedRecords = 0;
    let reachedEof = false;
    let complete = true;
    try {
      for (;;) {
        if (abortRequested(input.signal) || input.deadlineAt <= now()) {
          complete = false;
          break;
        }
        const entry = await directory.read();
        if (entry === null) {
          reachedEof = true;
          break;
        }
        examined += 1;
        if (examined > CLAUDE_REGISTRY_MAX_DIRECTORY_ENTRIES) {
          complete = false;
          break;
        }
        const pidFilename = /^(\d+)\.json$/u.exec(entry.name);
        if (pidFilename === null) continue;
        pidNamedRecords += 1;
        if (pidNamedRecords > maxFiles) {
          complete = false;
          break;
        }
        const filenamePidText = pidFilename[1];
        const filenamePid = filenamePidText === undefined
          ? Number.NaN
          : Number(filenamePidText);
        if (
          !Number.isSafeInteger(filenamePid)
          || filenamePid <= 0
          || String(filenamePid) !== filenamePidText
        ) {
          complete = false;
          break;
        }
        if (!entry.isFile()) {
          complete = false;
          break;
        }
        // Recheck immediately before the final untrusted path open. The open
        // itself is nonblocking because this Dirent can be stale after a swap.
        if (abortRequested(input.signal) || input.deadlineAt <= now()) {
          complete = false;
          break;
        }
        const document = await readBoundedJsonFile(
          join(registryDirectory, entry.name),
          Math.min(input.maxFileBytes, CLAUDE_REGISTRY_MAX_FILE_BYTES),
        );
        const scalars = selectClaudeRegistryScalars(document);
        if (scalars === null || scalars.pid !== filenamePid) {
          complete = false;
          break;
        }
        records.push(scalars);
      }
    } catch {
      // A disappearing registry is normal, but it makes this snapshot unproven.
      complete = false;
    } finally {
      try {
        await directory.close();
      } catch {
        // The async iterator closes the directory after natural exhaustion.
      }
    }
    return snapshot(
      complete
      && reachedEof
      && !input.signal.aborted,
    );
  };
}

export const inferCodexLiveness = (
  input: Readonly<{
    status: "active" | "idle" | "terminal";
    activeTurnId?: string;
    updatedAt?: number;
    now: number;
  }>,
): PersonalSessionLiveness => {
  if (input.status === "terminal") return "not_live";
  if (input.status === "active" || input.activeTurnId !== undefined) return "live";
  if (
    input.updatedAt !== undefined
    && input.updatedAt <= input.now + CODEX_CLOCK_SKEW_MS
  ) {
    return input.now - input.updatedAt <= CODEX_RECENT_LIVENESS_WINDOW_MS
      ? "live"
      : "not_live";
  }
  return "unknown";
};

function withinDiscoveryRecency(updatedAt: number | undefined, now: number): boolean {
  return updatedAt !== undefined
    && updatedAt <= now + CODEX_CLOCK_SKEW_MS
    && now - updatedAt <= PERSONAL_SESSION_DISCOVERY_RECENCY_WINDOW_MS;
}

function normalizeClaudeRegistrySnapshot(value: unknown): ClaudeRegistrySnapshot {
  if (Array.isArray(value)) {
    return Object.freeze({
      records: Object.freeze(value.slice(0, CLAUDE_REGISTRY_MAX_RECORDS)),
      // Legacy/injected arrays cannot prove that their producer reached EOF.
      complete: false,
    });
  }
  if (!isRecord(value) || !Array.isArray(value.records)) {
    return Object.freeze({ records: Object.freeze([]), complete: false });
  }
  const withinBound = value.records.length <= CLAUDE_REGISTRY_MAX_RECORDS;
  return Object.freeze({
    records: Object.freeze(value.records.slice(0, CLAUDE_REGISTRY_MAX_RECORDS)),
    complete: value.complete === true && withinBound,
  });
}

function parseCodexPage(value: unknown): ParsedCodexPage | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null;
  if (value.sessions.length > CODEX_PAGE_LIMIT) return null;
  const rawNextCursor = value.nextCursor;
  let nextCursor: string | null = null;
  if (rawNextCursor !== null && rawNextCursor !== undefined) {
    const parsedCursor = safeBoundedString(rawNextCursor, CURSOR_MAX_BYTES);
    if (parsedCursor === null || parsedCursor.length === 0) return null;
    nextCursor = parsedCursor;
  }
  const sessions: ParsedCodexSession[] = [];
  for (const item of value.sessions) {
    const session = parseCodexSession(item);
    if (session !== null) sessions.push(session);
  }
  return Object.freeze({
    sessions: Object.freeze(sessions),
    nextCursor,
  });
}

function parseCodexSession(value: unknown): ParsedCodexSession | null {
  if (!isRecord(value)) return null;
  const providerThreadId = safeProviderId(value.providerThreadId);
  if (providerThreadId === null) return null;
  const status = value.status;
  if (status !== "active" && status !== "idle" && status !== "terminal") return null;
  let activeTurnId: string | undefined;
  if (value.activeTurnId !== undefined) {
    const parsedActiveTurnId = safeProviderId(value.activeTurnId);
    if (parsedActiveTurnId === null) return null;
    activeTurnId = parsedActiveTurnId;
  }
  const projectRoot = safeProjectRoot(value.projectRoot);
  const updatedAt = normalizedTimestamp(value.providerUpdatedAt);
  return Object.freeze({
    providerThreadId,
    title: safeTitle(value.title, "Codex session"),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    status,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
  });
}

function parseClaudeSession(
  value: unknown,
  fallbackTitle: string,
  expectedVersion: string,
): ParsedClaudeSession | null {
  if (!isRecord(value)) return null;
  const providerThreadId = safeProviderId(value.sessionId);
  if (providerThreadId === null) return null;
  const projectRoot = safeProjectRoot(value.cwd);
  const updatedAt = normalizedTimestamp(value.updatedAt ?? value.statusUpdatedAt);
  const identity = parseClaudeProcessIdentity(value);
  const sourceProcessIdentity = storageSafeClaudeProcessIdentity(identity);
  return Object.freeze({
    providerThreadId,
    title: safeTitle(value.name, fallbackTitle),
    ...(projectRoot === undefined ? {} : { projectRoot }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    matchesPinnedVersion: value.version === expectedVersion,
    ...(identity === undefined ? {} : { identity }),
    sourceProcessIdentity,
  });
}

function parseClaudeProcessIdentity(value: Readonly<Record<string, unknown>>): ClaudeProcessIdentity | undefined {
  const pid = value.pid;
  const pidDomain = safeBoundedString(value.pidDomain, PID_DOMAIN_MAX_BYTES);
  const procStart = value.procStart;
  if (
    typeof pid !== "number"
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || pidDomain === null
    || pidDomain.length === 0
  ) return undefined;
  if (
    !(
      (typeof procStart === "number" && Number.isSafeInteger(procStart) && procStart >= 0)
      || (
        typeof procStart === "string"
        && procStart.length > 0
        && textEncoder.encode(procStart).byteLength <= PROC_START_MAX_BYTES
        && !containsUnsafeTerminalScalar(procStart)
      )
    )
  ) return undefined;
  return Object.freeze({ pid, pidDomain, procStart });
}

function storageSafeClaudeProcessIdentity(
  identity: ClaudeProcessIdentity | undefined,
): PersonalClaudeSourceProcessIdentity | null {
  if (
    identity === undefined
    || (identity.pidDomain !== "darwin" && identity.pidDomain !== "linux")
    || typeof identity.procStart !== "string"
    || !/^[\x20-\x7e]+$/u.test(identity.procStart)
  ) return null;
  return Object.freeze({
    pid: identity.pid,
    pidDomain: identity.pidDomain,
    procStart: identity.procStart,
  });
}

function selectClaudeRegistryScalars(value: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(value)) return null;
  const sessionId = safeProviderId(value.sessionId);
  const version = safeBoundedString(value.version, CLAUDE_VERSION_MAX_BYTES);
  if (
    sessionId === null
    || version === null
    || version.length === 0
    || parseClaudeProcessIdentity(value) === undefined
  ) return null;
  const output: Record<string, unknown> = {};
  for (const key of [
    "sessionId",
    "name",
    "cwd",
    "updatedAt",
    "statusUpdatedAt",
    "version",
    "pid",
    "pidDomain",
    "procStart",
  ] as const) {
    const scalar = value[key];
    if (typeof scalar === "string" || typeof scalar === "number") output[key] = scalar;
  }
  return Object.freeze(output);
}

async function readBoundedJsonFile(
  path: string,
  maxBytes: number,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) return null;
    const bytes = new Uint8Array(maxBytes + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const result = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (result.bytesRead === 0) break;
      filled += result.bytesRead;
    }
    if (filled > maxBytes) return null;
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, filled))) as unknown;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function runBoundedReadonlyCommand(input: Readonly<{
  argv: readonly [string, ...string[]];
  environment: Readonly<Record<string, string>>;
  maxStdoutBytes: number;
  deadlineAt: number;
  signal: AbortSignal;
  spawn: ReadonlyCommandSpawner;
  now: () => number;
}>): Promise<Readonly<{ exitCode: number; stdout: string }>> {
  input.signal.throwIfAborted();
  const remainingMs = input.deadlineAt - input.now();
  if (remainingMs <= 0) throw new Error("The read-only command reached its deadline.");
  const child = input.spawn({ argv: input.argv, environment: input.environment });
  let rejectCancellation: ((reason: Error) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationReason: Error | undefined;
  const cancel = (reason: Error): void => {
    if (cancellationReason !== undefined) return;
    cancellationReason = reason;
    try {
      child.terminate();
    } catch {
      // Force termination below remains available even if SIGTERM fails.
    }
    rejectCancellation?.(reason);
  };
  const onAbort = (): void => cancel(signalReason(input.signal));
  input.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => cancel(new Error("The read-only command reached its deadline.")),
    remainingMs,
  );
  const stdoutTask = collectBoundedUtf8(child.stdout, input.maxStdoutBytes)
    .catch((error: unknown) => {
      const bounded = error instanceof Error ? error : new Error("The command output was invalid.");
      cancel(bounded);
      throw bounded;
    });
  const stderrTask = drainBytes(child.stderr);
  const completion = Promise.all([child.exited, stdoutTask, stderrTask]);
  try {
    const [exitCode, stdout] = await Promise.race([completion, cancellation]);
    if (cancellationReason !== undefined) throw cancellationReason;
    return Object.freeze({ exitCode, stdout });
  } catch (error) {
    await terminateReadonlyCommand(child);
    void completion.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }
}

async function collectBoundedUtf8(
  chunks: AsyncIterable<Uint8Array>,
  maximumBytes: number,
): Promise<string> {
  const retained: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new Error("The command emitted an invalid byte stream.");
    total += chunk.byteLength;
    if (total > maximumBytes) throw new Error("The command exceeded its stdout byte bound.");
    if (chunk.byteLength > 0) retained.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of retained) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("The command emitted invalid UTF-8.");
  }
}

async function drainBytes(chunks: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) throw new Error("The command emitted an invalid byte stream.");
    // Deliberately retain no bytes while keeping the child pipe drained.
  }
}

async function terminateReadonlyCommand(child: ReadonlyCommandProcess): Promise<void> {
  try {
    child.terminate();
  } catch {
    // Continue to the force-termination path.
  }
  if (await resolvesWithin(child.exited, COMMAND_TERMINATION_GRACE_MS)) return;
  try {
    child.forceTerminate();
  } catch {
    return;
  }
  await resolvesWithin(child.exited, COMMAND_TERMINATION_GRACE_MS);
}

async function resolvesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function* readableStreamBytes(
  stream: ReadableStream<Uint8Array> | number | undefined,
): AsyncIterable<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      if (result.value.byteLength > 0) yield result.value;
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}

function signalReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("The command was aborted.");
}

function pidDomainForPlatform(platform: NodeJS.Platform): string | null {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  return null;
}

async function settleBeforeDeadline<T>(
  promise: Promise<T>,
  remainingMs: number,
  controller: AbortController,
): Promise<T> {
  controller.signal.throwIfAborted();
  if (remainingMs <= 0) throw new Error("Personal session discovery reached its deadline.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const onAbortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signalReason(controller.signal));
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Personal session discovery reached its deadline.");
      controller.abort(error);
      reject(error);
    }, remainingMs);
  });
  try {
    return await Promise.race([promise, deadline, onAbortPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort);
  }
}

function safeTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const redacted = redactCompleteSensitiveText(redactAbsolutePaths(value), "[protected]");
  let output = "";
  let used = 0;
  for (const scalar of redacted.trim()) {
    const safeScalar = containsUnsafeTerminalScalar(scalar) ? "�" : scalar;
    const bytes = textEncoder.encode(safeScalar).byteLength;
    if (used + bytes > TITLE_MAX_BYTES) break;
    output += safeScalar;
    used += bytes;
  }
  return output.trim() || fallback;
}

function safeProjectRoot(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || textEncoder.encode(value).byteLength > PROJECT_ROOT_MAX_BYTES
    || containsUnsafeTerminalScalar(value)
  ) return undefined;
  return value;
}

function safeAbsolutePath(value: string): boolean {
  return isAbsolute(value)
    && textEncoder.encode(value).byteLength <= ABSOLUTE_PATH_MAX_BYTES
    && !containsUnsafeTerminalScalar(value);
}

function safeProviderId(value: unknown): string | null {
  const id = safeBoundedString(value, PROVIDER_ID_MAX_BYTES);
  return id === null || id.length === 0 ? null : id;
}

function safeBoundedString(value: unknown, maxBytes: number): string | null {
  if (
    typeof value !== "string"
    || textEncoder.encode(value).byteLength > maxBytes
    || containsUnsafeTerminalScalar(value)
  ) return null;
  return value;
}

function normalizedTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== "string" || value.length > 128 || containsUnsafeTerminalScalar(value)) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function validLiveness(value: unknown): PersonalSessionLiveness {
  return value === "live" || value === "not_live" ? value : "unknown";
}

function mergeClaudeLiveness(
  previous: PersonalSessionLiveness | undefined,
  current: PersonalSessionLiveness,
): PersonalSessionLiveness {
  if (previous === undefined) return current;
  if (previous === "live" || current === "live") return "live";
  if (previous === "unknown" || current === "unknown") return "unknown";
  return "not_live";
}

function mergeClaudeSourceProcessIdentity(
  previous: PersonalClaudeSourceProcessIdentity | null | undefined,
  current: PersonalClaudeSourceProcessIdentity | null,
): PersonalClaudeSourceProcessIdentity | null {
  if (previous === undefined) return current;
  if (previous === null || current === null) return null;
  return previous.pid === current.pid
    && previous.pidDomain === current.pidDomain
    && previous.procStart === current.procStart
    ? previous
    : null;
}

function boundedResultLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RESULT_LIMIT;
  return Math.max(0, Math.min(PERSONAL_SESSION_DISCOVERY_MAX_RESULTS, Math.floor(value)));
}

function boundedRegistryFileLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(CLAUDE_REGISTRY_MAX_RECORDS, Math.floor(value)));
}

function boundedDeadlineMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return PERSONAL_SESSION_DISCOVERY_DEFAULT_DEADLINE_MS;
  }
  return Math.max(1, Math.min(PERSONAL_SESSION_DISCOVERY_MAX_DEADLINE_MS, Math.floor(value)));
}

function freezeCandidate(candidate: DiscoveredPersonalSession): DiscoveredPersonalSession {
  return Object.freeze(candidate);
}

function sortCandidates(
  candidates: readonly DiscoveredPersonalSession[],
): DiscoveredPersonalSession[] {
  return [...candidates].sort((left, right) => {
    const byScheduledTarget = Number(right.scheduledTaskTarget === true)
      - Number(left.scheduledTaskTarget === true);
    if (byScheduledTarget !== 0) return byScheduledTarget;
    const byUpdated = (right.updatedAt ?? -1) - (left.updatedAt ?? -1);
    if (byUpdated !== 0) return byUpdated;
    return left.providerThreadId < right.providerThreadId
      ? -1
      : left.providerThreadId > right.providerThreadId
        ? 1
        : 0;
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | null {
  if (!isRecord(error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function abortRequested(signal: AbortSignal): boolean {
  return signal.aborted;
}
