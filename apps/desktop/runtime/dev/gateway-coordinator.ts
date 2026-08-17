import type {
  DevCandidateId,
  DevStatusEnvelope,
} from "./status-protocol.ts";
import {
  createInitialDevStatus,
  MAX_DEV_CHANGE_COUNT,
  parseDevStatusEnvelope,
} from "./status-protocol.ts";
import type {
  DevChangeClassification,
  RepositoryRelativePath,
} from "./change-classifier.ts";
import type { DevSessionId } from "../dev-protocol.ts";

export interface StagedGatewayArtifact {
  readonly adopt: () => void;
  readonly candidateId: DevCandidateId;
  readonly discard: () => void;
}

export type GatewayCandidateBuilder = (
  sourceRevision: number,
) => Promise<StagedGatewayArtifact>;

export interface DevGatewayCoordinatorOptions {
  readonly authority: "launcher" | "uiOnly";
  readonly buildCandidate: GatewayCandidateBuilder;
  readonly debounceMs?: number;
  readonly initialColdFenceTarget?: "native" | "launcher";
  readonly onColdFence?: (target: "native" | "launcher") => void;
  readonly onStatus?: (status: DevStatusEnvelope) => void;
  readonly sessionId: DevSessionId;
}

export interface DevStatusMutationOutcome {
  readonly kind: "ok" | "conflict";
  readonly status: DevStatusEnvelope;
}

const DEFAULT_GATEWAY_BUILD_DEBOUNCE_MS = 120;

function boundedCount(paths: ReadonlySet<RepositoryRelativePath>): number {
  return Math.max(1, Math.min(MAX_DEV_CHANGE_COUNT, paths.size));
}

function combinedBoundedCount(
  left: ReadonlySet<RepositoryRelativePath>,
  right: ReadonlySet<RepositoryRelativePath>,
): number {
  return boundedCount(new Set([...left, ...right]));
}

function dominantRestartTarget(
  current: "native" | "launcher" | undefined,
  next: "native" | "launcher",
): "native" | "launcher" {
  return current === "launcher" || next === "launcher" ? "launcher" : "native";
}

export class DevGatewayCoordinator {
  readonly #buildCandidate: GatewayCandidateBuilder;
  readonly #debounceMs: number;
  readonly #onColdFence: ((target: "native" | "launcher") => void) | undefined;
  readonly #onStatus: ((status: DevStatusEnvelope) => void) | undefined;
  readonly #pendingGatewayPaths = new Set<RepositoryRelativePath>();
  readonly #restartPaths = new Set<RepositoryRelativePath>();
  #activeBuild: Promise<void> | undefined;
  #buildTimer: ReturnType<typeof setTimeout> | undefined;
  #coldFenceTarget: "native" | "launcher" | undefined;
  #desiredSourceRevision = 0;
  #disposed = false;
  #lastAcknowledgedCandidateId: DevCandidateId | undefined;
  #lastCancelledCandidateId: DevCandidateId | undefined;
  #stagedArtifact: StagedGatewayArtifact | undefined;
  #stagedChangeCount = 0;
  #status: DevStatusEnvelope;

  constructor(options: DevGatewayCoordinatorOptions) {
    const debounceMs = options.debounceMs ?? DEFAULT_GATEWAY_BUILD_DEBOUNCE_MS;
    if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) {
      throw new Error("HRA gateway build debounce must be a non-negative safe integer.");
    }
    this.#buildCandidate = options.buildCandidate;
    this.#debounceMs = debounceMs;
    this.#onColdFence = options.onColdFence;
    this.#onStatus = options.onStatus;
    this.#status = createInitialDevStatus(options.sessionId, options.authority);
    if (options.authority === "launcher" && options.initialColdFenceTarget !== undefined) {
      this.#coldFenceTarget = options.initialColdFenceTarget;
      this.#status = Object.freeze(parseDevStatusEnvelope({
        ...this.#status,
        revision: 1,
        state: "restartRequired",
        target: options.initialColdFenceTarget,
        changeCount: 1,
        candidateId: null,
      }));
    }
  }

  get status(): DevStatusEnvelope {
    return this.#status;
  }

  observe(
    path: RepositoryRelativePath,
    classification: DevChangeClassification,
  ): void {
    if (this.#disposed || classification.kind === "ignored" || classification.kind === "frontendLive") {
      return;
    }
    if (this.#status.authority !== "launcher") return;

    if (classification.kind === "restartRequired") {
      this.#observeRestartRequired(path, classification.target);
      return;
    }
    if (this.#coldFenceTarget !== undefined) {
      this.#restartPaths.add(path);
      this.#publishRestartRequired();
      return;
    }

    this.#desiredSourceRevision += 1;
    this.#pendingGatewayPaths.add(path);
    if (this.#status.state === "applying") return;
    if (this.#status.state === "staged") {
      this.#stagedArtifact?.discard();
      this.#stagedArtifact = undefined;
    }
    this.#publish({
      state: "building",
      target: "gateway",
      changeCount: boundedCount(this.#pendingGatewayPaths),
      candidateId: null,
    });
    this.#scheduleBuild(this.#debounceMs);
  }

  reserve(candidateId: DevCandidateId): DevStatusMutationOutcome {
    if (this.#status.authority !== "launcher") return this.#conflict();
    if (this.#status.state === "applying" && this.#status.candidateId === candidateId) {
      return this.#ok();
    }
    if (this.#status.state !== "staged" || this.#status.candidateId !== candidateId) {
      return this.#conflict();
    }
    if (this.#stagedArtifact?.candidateId !== candidateId) return this.#conflict();
    this.#lastAcknowledgedCandidateId = undefined;
    this.#lastCancelledCandidateId = undefined;
    this.#publish({
      state: "applying",
      target: "gateway",
      changeCount: this.#status.changeCount,
      candidateId,
    });
    return this.#ok();
  }

  acknowledge(candidateId: DevCandidateId): DevStatusMutationOutcome {
    if (this.#status.authority !== "launcher") return this.#conflict();
    if (this.#lastAcknowledgedCandidateId === candidateId) return this.#ok();
    if (this.#status.state !== "applying" || this.#status.candidateId !== candidateId) {
      return this.#conflict();
    }
    if (this.#stagedArtifact?.candidateId !== candidateId) return this.#conflict();
    try {
      this.#stagedArtifact.adopt();
    } catch {
      return this.#conflict();
    }
    this.#stagedArtifact = undefined;
    this.#lastAcknowledgedCandidateId = candidateId;
    this.#lastCancelledCandidateId = undefined;
    this.#finishReservation(candidateId, true);
    return this.#ok();
  }

  cancel(candidateId: DevCandidateId): DevStatusMutationOutcome {
    if (this.#status.authority !== "launcher") return this.#conflict();
    if (this.#lastCancelledCandidateId === candidateId) return this.#ok();
    if (this.#status.state !== "applying" || this.#status.candidateId !== candidateId) {
      return this.#conflict();
    }
    if (this.#stagedArtifact?.candidateId !== candidateId) return this.#conflict();
    this.#lastCancelledCandidateId = candidateId;
    this.#finishReservation(candidateId, false);
    return this.#ok();
  }

  async settle(): Promise<void> {
    if (this.#buildTimer !== undefined) {
      clearTimeout(this.#buildTimer);
      this.#buildTimer = undefined;
      this.#startBuild();
    }
    while (this.#activeBuild !== undefined) {
      await this.#activeBuild;
      if (
        this.#buildTimer !== undefined
        && this.#status.state !== "applying"
        && this.#coldFenceTarget === undefined
      ) {
        clearTimeout(this.#buildTimer);
        this.#buildTimer = undefined;
        this.#startBuild();
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#buildTimer !== undefined) clearTimeout(this.#buildTimer);
    this.#buildTimer = undefined;
    if (this.#status.state === "staged") {
      this.#stagedArtifact?.discard();
      this.#stagedArtifact = undefined;
    }
  }

  #observeRestartRequired(
    path: RepositoryRelativePath,
    target: "native" | "launcher",
  ): void {
    this.#restartPaths.add(path);
    this.#coldFenceTarget = dominantRestartTarget(this.#coldFenceTarget, target);
    this.#onColdFence?.(this.#coldFenceTarget);
    this.#desiredSourceRevision += 1;
    if (this.#buildTimer !== undefined) clearTimeout(this.#buildTimer);
    this.#buildTimer = undefined;
    if (this.#status.state !== "applying") {
      this.#stagedArtifact?.discard();
      this.#stagedArtifact = undefined;
      this.#publishRestartRequired();
    }
  }

  #publishRestartRequired(): void {
    if (this.#coldFenceTarget === undefined) return;
    this.#publish({
      state: "restartRequired",
      target: this.#coldFenceTarget,
      changeCount: combinedBoundedCount(this.#pendingGatewayPaths, this.#restartPaths),
      candidateId: null,
    });
  }

  #finishReservation(candidateId: DevCandidateId, applied: boolean): void {
    if (this.#coldFenceTarget !== undefined) {
      this.#stagedArtifact?.discard();
      this.#stagedArtifact = undefined;
      this.#publishRestartRequired();
      return;
    }
    if (this.#pendingGatewayPaths.size > 0) {
      this.#stagedArtifact?.discard();
      this.#stagedArtifact = undefined;
      this.#publish({
        state: "building",
        target: "gateway",
        changeCount: boundedCount(this.#pendingGatewayPaths),
        candidateId: null,
      });
      this.#scheduleBuild(0);
      return;
    }
    if (applied) {
      this.#publish({
        state: "current",
        target: "none",
        changeCount: 0,
        candidateId,
      });
      return;
    }
    this.#publish({
      state: "staged",
      target: "gateway",
      changeCount: this.#stagedChangeCount,
      candidateId,
    });
  }

  #scheduleBuild(delayMs: number): void {
    if (
      this.#disposed
      || this.#coldFenceTarget !== undefined
      || this.#status.state === "applying"
      || this.#activeBuild !== undefined
    ) return;
    if (this.#buildTimer !== undefined) clearTimeout(this.#buildTimer);
    this.#buildTimer = setTimeout(() => {
      this.#buildTimer = undefined;
      this.#startBuild();
    }, delayMs);
  }

  #startBuild(): void {
    if (
      this.#disposed
      || this.#activeBuild !== undefined
      || this.#coldFenceTarget !== undefined
      || this.#status.state === "applying"
      || this.#pendingGatewayPaths.size === 0
    ) return;
    const sourceRevision = this.#desiredSourceRevision;
    const changeCount = boundedCount(this.#pendingGatewayPaths);
    const run = this.#runBuild(sourceRevision, changeCount);
    this.#activeBuild = run;
    void run.finally(() => {
      if (this.#activeBuild === run) this.#activeBuild = undefined;
      if (
        !this.#disposed
        && this.#coldFenceTarget === undefined
        && this.#status.state === "building"
        && this.#desiredSourceRevision > sourceRevision
      ) this.#scheduleBuild(0);
    });
  }

  async #runBuild(sourceRevision: number, changeCount: number): Promise<void> {
    let artifact: StagedGatewayArtifact | undefined;
    try {
      artifact = await this.#buildCandidate(sourceRevision);
      if (
        this.#disposed
        || this.#coldFenceTarget !== undefined
        || this.#status.state === "applying"
        || this.#desiredSourceRevision !== sourceRevision
      ) {
        artifact.discard();
        return;
      }
      this.#stagedArtifact?.discard();
      this.#stagedArtifact = artifact;
      this.#stagedChangeCount = changeCount;
      this.#pendingGatewayPaths.clear();
      this.#publish({
        state: "staged",
        target: "gateway",
        changeCount,
        candidateId: artifact.candidateId,
      });
    } catch {
      artifact?.discard();
      if (
        this.#disposed
        || this.#coldFenceTarget !== undefined
        || this.#status.state === "applying"
        || this.#desiredSourceRevision !== sourceRevision
      ) return;
      this.#publish({
        state: "failed",
        target: "gateway",
        changeCount: boundedCount(this.#pendingGatewayPaths),
        candidateId: null,
      });
    }
  }

  #publish(
    next: Omit<DevStatusEnvelope, "authority" | "revision" | "schema" | "sessionId">,
  ): void {
    const revision = this.#status.revision + 1;
    if (!Number.isSafeInteger(revision)) {
      throw new Error("HRA development status revision was exhausted.");
    }
    this.#status = Object.freeze(parseDevStatusEnvelope({
      ...next,
      schema: this.#status.schema,
      sessionId: this.#status.sessionId,
      authority: this.#status.authority,
      revision,
    }));
    this.#onStatus?.(this.#status);
  }

  #ok(): DevStatusMutationOutcome {
    return { kind: "ok", status: this.#status };
  }

  #conflict(): DevStatusMutationOutcome {
    return { kind: "conflict", status: this.#status };
  }
}
