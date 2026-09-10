import { canonicalSha256 } from "@hraness/oh";
import { parseOhMemoryPageRecordV1 } from "@hraness/oh/memory";
import { join, relative, resolve } from "node:path";

import type { ProjectMemorySerialExecutor } from "../daemon/project-memory-serial.ts";
import { deriveProjectMemoryCanonicalIdentity } from "../domain/project-memory.ts";
import { memoryPageUserKey } from "../domain/memory-page.ts";
import type { OhSqliteFactsMemoryEngine } from "../storage/oh-facts-memory-engine.ts";
import type { StatePaths } from "../storage/paths.ts";
import type {
  ProjectMemoryAuthorityRecord,
  ProjectMemoryHeadRef,
  SessionRecord,
  StateStore,
} from "../storage/state-store.ts";
import {
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  isOpaqueIdentifier,
} from "./contracts.ts";
import {
  memorySummaryFitsEncryptedEnvelope,
  memorySummaryLimits,
  parseMemorySummaryPayload,
  type MemorySummaryHead,
  type MemorySummaryPayload,
  type MemorySummaryPeerIdentity,
  type MemorySummaryRecentRecord,
  type MemorySummarySpace,
} from "./payloads.ts";

const maximumCanonicalRecords = 8_192;

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw signal.reason ?? new Error("Memory summary was aborted.");
};

const safeLabel = (value: string, fallback: string, maximum = 200): string => {
  const label = value.trim();
  return label.length >= 1
    && label.length <= maximum
    && !containsAbsolutePath(label)
    && !containsUnsafeTerminalScalar(label)
    ? label
    : fallback;
};

const summaryHead = (head: ProjectMemoryHeadRef): MemorySummaryHead => ({
  digest: head.headDigest,
  operationSha256: head.operationSha256,
  sequence: head.sequence,
});

const sameSummaryHead = (left: MemorySummaryHead, right: MemorySummaryHead): boolean =>
  left.sequence === right.sequence
  && left.operationSha256 === right.operationSha256
  && left.digest === right.digest;

const canonicalDirectory = (paths: StatePaths, projectId: string): string => {
  const root = resolve(paths.projectMemory);
  const digest = canonicalSha256({ projectId, v: 1 });
  const directory = resolve(join(root, digest));
  if (relative(root, directory) !== digest) throw new Error("MEMORY_PROJECT_PATH_ESCAPE");
  return directory;
};

type SnapshotSummary = Readonly<{
  recentRecords: readonly MemorySummaryRecentRecord[];
  recordCount: number;
}>;

type SummarySelection = Readonly<{
  peerActions: number;
  peerPolicies: number;
  spaces: number;
}>;

const selectedSummary = (
  source: MemorySummaryPayload,
  selection: SummarySelection,
): MemorySummaryPayload => ({
  coverage: {
    peerActions: selection.peerActions < source.peerActions.length
      ? "bounded"
      : source.coverage.peerActions,
    peerPolicies: selection.peerPolicies < source.peerPolicies.length
      ? "bounded"
      : source.coverage.peerPolicies,
    spaces: selection.spaces < source.spaces.length ? "bounded" : source.coverage.spaces,
  },
  observedAt: source.observedAt,
  peerActions: source.peerActions.slice(0, selection.peerActions),
  peerPolicies: source.peerPolicies.slice(0, selection.peerPolicies),
  spaces: source.spaces.slice(0, selection.spaces).map((space) => ({
    ...space,
    recentRecords: [],
  })),
  version: 1,
});

const summaryWithRecentRecordPrefix = (
  source: MemorySummaryPayload,
  selected: MemorySummaryPayload,
  limit: number,
): MemorySummaryPayload => {
  const counts = selected.spaces.map(() => 0);
  let remaining = limit;
  // Round-robin by canonical-space order. One noisy space therefore cannot
  // consume the entire byte budget before another space gets one recent key.
  for (
    let recordIndex = 0;
    recordIndex < memorySummaryLimits.recentRecordsPerSpace && remaining > 0;
    recordIndex += 1
  ) {
    for (let spaceIndex = 0; spaceIndex < selected.spaces.length && remaining > 0; spaceIndex += 1) {
      if (source.spaces[spaceIndex]?.recentRecords[recordIndex] === undefined) continue;
      counts[spaceIndex] = (counts[spaceIndex] ?? 0) + 1;
      remaining -= 1;
    }
  }
  return {
    ...selected,
    spaces: selected.spaces.map((space, index) => ({
      ...space,
      recentRecords: source.spaces[index]?.recentRecords.slice(0, counts[index]) ?? [],
    })),
  };
};

const largestFittingRecentRecordPrefix = (
  source: MemorySummaryPayload,
  selected: MemorySummaryPayload,
): MemorySummaryPayload => {
  const maximum = source.spaces.slice(0, selected.spaces.length)
    .reduce((count, space) => count + space.recentRecords.length, 0);
  let lower = 0;
  let upper = maximum;
  let result = selected;
  while (lower <= upper) {
    const candidateCount = Math.floor((lower + upper) / 2);
    const candidate = summaryWithRecentRecordPrefix(source, selected, candidateCount);
    if (memorySummaryFitsEncryptedEnvelope(candidate)) {
      result = candidate;
      lower = candidateCount + 1;
    } else {
      upper = candidateCount - 1;
    }
  }
  return result;
};

/**
 * Keep the projection useful when valid maximum-length labels make the
 * count-bounded payload exceed its encrypted wire allowance. Selection is
 * deterministic: canonical spaces, newest policies, and newest actions are
 * already ordered by their sources; proportional prefixes keep at least one
 * item from each non-empty section, then spare bytes favor space authority,
 * policy, action, and finally round-robin recent-record metadata.
 */
const fitMemorySummaryProjection = (source: MemorySummaryPayload): MemorySummaryPayload => {
  if (memorySummaryFitsEncryptedEnvelope(source)) return source;

  const maximum: SummarySelection = {
    peerActions: source.peerActions.length,
    peerPolicies: source.peerPolicies.length,
    spaces: source.spaces.length,
  };
  const withoutRecentRecords = selectedSummary(source, maximum);
  if (memorySummaryFitsEncryptedEnvelope(withoutRecentRecords)) {
    return largestFittingRecentRecordPrefix(source, withoutRecentRecords);
  }

  const scale = Math.max(maximum.peerActions, maximum.peerPolicies, maximum.spaces);
  const atScale = (step: number): SummarySelection => {
    const count = (length: number): number => length === 0
      ? 0
      : Math.max(1, Math.floor(length * step / scale));
    return {
      peerActions: count(maximum.peerActions),
      peerPolicies: count(maximum.peerPolicies),
      spaces: count(maximum.spaces),
    };
  };

  let selection: SummarySelection = { peerActions: 0, peerPolicies: 0, spaces: 0 };
  let lower = 1;
  let upper = scale;
  while (lower <= upper) {
    const step = Math.floor((lower + upper) / 2);
    const candidateSelection = atScale(step);
    if (memorySummaryFitsEncryptedEnvelope(selectedSummary(source, candidateSelection))) {
      selection = candidateSelection;
      lower = step + 1;
    } else {
      upper = step - 1;
    }
  }

  const maximize = (field: keyof SummarySelection): void => {
    let fieldLower = selection[field];
    let fieldUpper = maximum[field];
    while (fieldLower <= fieldUpper) {
      const count = Math.floor((fieldLower + fieldUpper) / 2);
      const candidate = { ...selection, [field]: count };
      if (memorySummaryFitsEncryptedEnvelope(selectedSummary(source, candidate))) {
        selection = candidate;
        fieldLower = count + 1;
      } else {
        fieldUpper = count - 1;
      }
    }
  };
  maximize("spaces");
  maximize("peerPolicies");
  maximize("peerActions");

  const bounded = largestFittingRecentRecordPrefix(source, selectedSummary(source, selection));
  const parsed = parseMemorySummaryPayload(bounded);
  if (parsed === null || !memorySummaryFitsEncryptedEnvelope(parsed)) {
    throw new Error("MEMORY_SUMMARY_PROJECTION_WIRE_LIMIT_INVALID");
  }
  return parsed;
};

export class OompaMemorySummarySource {
  readonly #engine: Pick<OhSqliteFactsMemoryEngine, "inspectCanonicalMemorySnapshot">;
  readonly #identityNamespace: string;
  readonly #now: () => number;
  readonly #paths: StatePaths;
  readonly #projectSerial: ProjectMemorySerialExecutor;
  readonly #store: StateStore;

  constructor(options: Readonly<{
    engine: Pick<OhSqliteFactsMemoryEngine, "inspectCanonicalMemorySnapshot">;
    identityNamespace: string;
    now?: () => number;
    paths: StatePaths;
    projectSerial: ProjectMemorySerialExecutor;
    store: StateStore;
  }>) {
    if (!/^[a-f0-9]{24}$/u.test(options.identityNamespace)) {
      throw new TypeError("MEMORY_SUMMARY_IDENTITY_NAMESPACE_INVALID");
    }
    this.#engine = options.engine;
    this.#identityNamespace = options.identityNamespace;
    this.#now = options.now ?? Date.now;
    this.#paths = options.paths;
    this.#projectSerial = options.projectSerial;
    this.#store = options.store;
  }

  async read(input: Readonly<{
    devicePublicId: string;
    signal: AbortSignal;
  }>): Promise<MemorySummaryPayload> {
    throwIfAborted(input.signal);
    if (!isOpaqueIdentifier(input.devicePublicId)) {
      throw new TypeError("MEMORY_SUMMARY_DEVICE_AUTHORITY_INVALID");
    }
    const observedAt = this.#now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new TypeError("MEMORY_SUMMARY_OBSERVATION_TIME_INVALID");
    }
    const deviceNamespace = canonicalSha256({
      cloudIdentityNamespace: this.#identityNamespace,
      devicePublicId: input.devicePublicId,
      kind: "memory_summary_device",
      v: 1,
    });
    const projects = this.#store.listProjects();
    const portable = projects.flatMap((project) => {
      const authority = this.#store.readProjectMemoryAuthority(project.id);
      return authority?.identityContract === 2
        ? [{ canonicalSpaceId: authority.canonicalSpaceId, project }]
        : [];
    }).sort((left, right) => left.canonicalSpaceId.localeCompare(right.canonicalSpaceId));
    const selectedPortable = portable.slice(0, memorySummaryLimits.spaces);

    const spaces: MemorySummarySpace[] = [];
    for (const { project } of selectedPortable) {
      throwIfAborted(input.signal);
      const space = await this.#projectSerial.run(project.id, async () => {
        throwIfAborted(input.signal);
        const authority = this.#store.readProjectMemoryAuthority(project.id);
        if (authority === null || authority.identityContract !== 2) return null;
        return await this.#space(project.label, authority, observedAt, input.signal);
      });
      if (space !== null) spaces.push(space);
    }

    throwIfAborted(input.signal);
    const projectLabels = new Map(projects.map((project) => [project.id, project.label]));
    const sessions = new Map<string, SessionRecord>();
    const session = (id: string): SessionRecord | null => {
      const cached = sessions.get(id);
      if (cached !== undefined) return cached;
      try {
        const found = this.#store.requireSession(id);
        sessions.set(id, found);
        return found;
      } catch {
        return null;
      }
    };
    const peerIdentity = (record: SessionRecord): MemorySummaryPeerIdentity => ({
      label: safeLabel(record.title, "Session"),
      ref: canonicalSha256({
        deviceNamespace,
        kind: "peer_session",
        sessionId: record.id,
        v: 1,
      }),
    });

    const peerPolicyRecords = this.#store.listPeerSessionPolicies(memorySummaryLimits.peerPolicies);
    // Keep the exact-count observation adjacent to the synchronous list read.
    // The intervening canonical-space awaits must not let an older count make
    // a newly capped policy list claim complete coverage.
    const peerPolicyCount = this.#store.countPeerSessionPolicies();
    const peerPolicies = peerPolicyRecords
      .flatMap((policy) => {
        const record = session(policy.sessionId);
        if (record?.projectId === undefined) return [];
        const projectLabel = projectLabels.get(record.projectId);
        if (projectLabel === undefined) return [];
        return [{
          mode: policy.mode,
          projectLabel: safeLabel(projectLabel, "Project"),
          session: peerIdentity(record),
          updatedAt: Math.min(policy.updatedAt, observedAt),
        }];
      });
    const recentPeerActions = this.#store.listRecentPeerSessionActions(
      memorySummaryLimits.peerActions,
    );
    const peerActions = recentPeerActions
      .flatMap((action) => {
        const actor = session(action.actorSessionId);
        const target = session(action.targetSessionId);
        if (actor === null || target === null || actor.id === target.id) return [];
        const updatedAt = Math.min(action.updatedAt, observedAt);
        return [{
          actor: peerIdentity(actor),
          createdAt: Math.min(action.createdAt, updatedAt),
          delivery: action.delivery,
          state: action.state,
          target: peerIdentity(target),
          updatedAt,
        }];
      });

    throwIfAborted(input.signal);
    const payload = parseMemorySummaryPayload({
      coverage: {
        peerActions: recentPeerActions.length === memorySummaryLimits.peerActions
          ? "bounded"
          : "complete",
        peerPolicies: peerPolicyCount > memorySummaryLimits.peerPolicies
          ? "bounded"
          : "complete",
        spaces: portable.length > memorySummaryLimits.spaces ? "bounded" : "complete",
      },
      observedAt,
      peerActions,
      peerPolicies,
      spaces,
      version: 1,
    });
    if (payload === null) throw new Error("MEMORY_SUMMARY_PROJECTION_INVALID");
    return fitMemorySummaryProjection(payload);
  }

  async #space(
    projectLabelValue: string,
    authority: ProjectMemoryAuthorityRecord,
    observedAt: number,
    signal: AbortSignal,
  ): Promise<MemorySummarySpace> {
    const attachment = this.#store.readCanonicalMemoryHostedAttachment(authority.projectId);
    const createIntent = this.#store.readUnresolvedCanonicalMemoryHostedCreateIntent(
      authority.projectId,
    );
    const syncIntent = this.#store.readUnresolvedCanonicalMemorySyncIntent(authority.projectId);
    const head = summaryHead(authority.head);
    const remoteHead = attachment === null ? null : summaryHead(attachment.remote.head);
    let enrollment: MemorySummarySpace["enrollment"] = attachment === null
      ? createIntent === null ? "not_enrolled" : "unavailable"
      : attachment.state === "attached" || attachment.state === "detached"
        ? attachment.state
        : "unavailable";
    let syncStatus: MemorySummarySpace["syncStatus"] = authority.syncState;
    if (authority.syncState === "conflict" || attachment?.state === "conflict") {
      syncStatus = "conflict";
    } else if (authority.syncState === "error" || attachment?.state === "error") {
      syncStatus = "error";
    } else if (createIntent !== null || syncIntent !== null) {
      syncStatus = "syncing";
    } else if (attachment === null) {
      syncStatus = "local_only";
    } else if (attachment.state === "attached" && authority.syncState === "local_only") {
      syncStatus = "syncing";
    }

    let snapshot: SnapshotSummary | null;
    if (authority.physicalState === "reserved") {
      snapshot = { recentRecords: [], recordCount: 0 };
    } else if (authority.physicalState === "rejected") {
      snapshot = null;
    } else {
      try {
        snapshot = await this.#snapshot(authority, observedAt, signal);
      } catch {
        throwIfAborted(signal);
        snapshot = null;
      }
    }
    if (snapshot === null) {
      enrollment = "unavailable";
      syncStatus = "error";
    } else if (
      syncStatus === "settled"
      && (remoteHead === null || !sameSummaryHead(head, remoteHead))
    ) {
      enrollment = "unavailable";
      syncStatus = "error";
    }

    return {
      bindingDigest: authority.bindingDigest,
      canonicalSpaceId: authority.canonicalSpaceId,
      enrollment,
      head,
      lastExchangeAt: authority.lastExchangeAt === undefined
        ? null
        : Math.min(authority.lastExchangeAt, observedAt),
      projectLabel: safeLabel(projectLabelValue, "Project"),
      recentRecords: snapshot?.recentRecords ?? [],
      recordCount: snapshot?.recordCount ?? null,
      remoteHead,
      syncStatus,
    };
  }

  async #snapshot(
    authority: ProjectMemoryAuthorityRecord,
    observedAt: number,
    signal: AbortSignal,
  ): Promise<SnapshotSummary> {
    const identity = deriveProjectMemoryCanonicalIdentity({
      canonicalSpaceId: authority.canonicalSpaceId,
      identityContract: authority.identityContract,
      projectId: authority.projectId,
    });
    const inspected = await this.#engine.inspectCanonicalMemorySnapshot({
      directory: canonicalDirectory(this.#paths, authority.projectId),
      expectedHead: {
        digest: authority.head.headDigest,
        operationSha256: authority.head.operationSha256,
        sequence: authority.head.sequence,
      },
      realmId: identity.canonicalRealmId,
      requireExisting: true,
      requireVacant: false,
      spaceId: identity.canonicalSpaceId,
    }, maximumCanonicalRecords);
    throwIfAborted(signal);
    if (inspected.bindingSha256 !== authority.bindingDigest) {
      throw new Error("MEMORY_SUMMARY_CANONICAL_BINDING_MISMATCH");
    }
    const pages = inspected.records.map((record) => {
      const page = parseOhMemoryPageRecordV1(record);
      if (page === null) throw new Error("MEMORY_SUMMARY_CANONICAL_RECORD_INVALID");
      const key = memoryPageUserKey(page.key);
      if (key === null) throw new Error("MEMORY_SUMMARY_CANONICAL_KEY_INVALID");
      const updatedAt = Date.parse(page.value.updatedAt);
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new Error("MEMORY_SUMMARY_CANONICAL_TIMESTAMP_INVALID");
      }
      return { key, updatedAt: Math.min(updatedAt, observedAt) };
    });
    const recentRecords = pages
      .filter((page) => safeLabel(page.key, "", 512) !== "")
      .sort((left, right) => right.updatedAt - left.updatedAt
        || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .slice(0, memorySummaryLimits.recentRecordsPerSpace)
      .map((page): MemorySummaryRecentRecord => ({
        key: page.key,
        kind: "memory_page",
        updatedAt: page.updatedAt,
      }));
    return { recentRecords, recordCount: pages.length };
  }
}
