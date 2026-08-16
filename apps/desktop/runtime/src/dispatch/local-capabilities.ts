import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { DispatchStore } from "../state/dispatch-store";
import type { WorkspaceBroker } from "../workspaces/workspace-broker";
import type {
  DispatchCapabilityPort,
  DispatchCapabilitySnapshot,
  DispatchSlotDisposition,
  LocalDispatchSlot,
} from "./runner";
import type { DispatchRepositoryMapping } from "./pairing";
import {
  dispatchBudget,
  dispatchBudgetNeedsRefresh,
  dispatchBudgetRefreshIsDue,
  dispatchBudgetRefreshRetryAt,
  type DispatchBudget,
} from "../accounts/dispatch-budget";
import type { DispatchAccountSummary } from "../internal-contracts";
import type {
  DispatchAccountReservationArbiter,
} from "./account-reservations";

export interface DispatchAccountPort {
  dispatchAccounts(): readonly DispatchAccountSummary[];
  refreshDispatchAccounts?(): Promise<readonly DispatchAccountSummary[]>;
}

interface Reservation {
  readonly slot: LocalDispatchSlot;
  runId: string | null;
}

export interface RecoveredDispatchReservation {
  readonly accountProfileId: string;
  readonly repositoryPublicId: string;
  readonly runId: string;
}

export class LocalDispatchCapabilities implements DispatchCapabilityPort {
  readonly #accountReservations: DispatchAccountReservationArbiter | null;
  readonly #accounts: DispatchAccountPort;
  readonly #repositories: ReadonlyMap<string, string>;
  readonly #reservations = new Map<string, Reservation>();
  readonly #releasedRunIds = new Set<string>();
  readonly #lastUsed = new Map<string, number>();
  readonly #onRunReleased: (runId: string) => void;
  readonly #now: () => number;
  #budgetRefresh: Promise<void> | null = null;
  #budgetRefreshRetryAt: number | null = null;
  #nextReservation = 1;

  constructor(options: {
    readonly accountReservations?: DispatchAccountReservationArbiter;
    readonly accounts: DispatchAccountPort;
    readonly onRunReleased?: (runId: string) => void;
    readonly now?: () => number;
    readonly recoveredReservations?: readonly RecoveredDispatchReservation[];
    readonly repositories: readonly DispatchRepositoryMapping[];
  }) {
    this.#accountReservations = options.accountReservations ?? null;
    this.#accounts = options.accounts;
    this.#onRunReleased = options.onRunReleased ?? (() => undefined);
    this.#now = options.now ?? (() => Date.now());
    this.#repositories = new Map(
      options.repositories.map((mapping) => [mapping.repositoryId, mapping.repositoryPath]),
    );
    const recoveredAccounts = new Set<string>();
    const recoveredRuns = new Set<string>();
    for (const recovered of options.recoveredReservations ?? []) {
      const repositoryPath = this.#repositories.get(recovered.repositoryPublicId) ?? "";
      if (
        recoveredAccounts.has(recovered.accountProfileId) ||
        recoveredRuns.has(recovered.runId)
      ) {
        throw new Error("Recovered dispatch capacity is inconsistent with local setup");
      }
      recoveredAccounts.add(recovered.accountProfileId);
      recoveredRuns.add(recovered.runId);
      const reservationId = `recovered:${recovered.runId}`;
      if (
        this.#accountReservations !== null
        && !this.#accountReservations.owns(
          recovered.runId,
          recovered.accountProfileId,
        )
      ) {
        throw new Error("Recovered dispatch account capacity is not reserved");
      }
      this.#reservations.set(reservationId, {
        runId: recovered.runId,
        slot: {
          accountProfileId: recovered.accountProfileId,
          repositoryId: recovered.repositoryPublicId,
          repositoryPath,
          reservationId,
        },
      });
    }
  }

  async snapshot(): Promise<DispatchCapabilitySnapshot> {
    if (this.#accountReservations !== null) {
      const accounts = await this.#accountReservations.snapshot();
      const repositoryIds = [...this.#repositories.keys()].sort();
      if (accounts.state === "no_account") {
        return {
          reportedState: "degraded",
          blockReason: "no_account",
          capacity: accounts.capacity,
          activeRuns: accounts.activeRuns,
          retainedRunIds: accounts.retainedRunIds,
          repositoryIds,
        };
      }
      if (repositoryIds.length === 0) {
        return {
          reportedState: "degraded",
          blockReason: "no_repository",
          capacity: accounts.capacity,
          activeRuns: accounts.activeRuns,
          retainedRunIds: accounts.retainedRunIds,
          repositoryIds,
        };
      }
      return {
        reportedState: accounts.state === "capacity_full" ? "busy" : "ready",
        capacity: accounts.capacity,
        activeRuns: accounts.activeRuns,
        retainedRunIds: accounts.retainedRunIds,
        repositoryIds,
      };
    }
    const connectedAccounts = await this.#availableAccounts();
    const accountCount = Math.min(32, new Set([
      ...connectedAccounts.map(({ id }) => id),
      ...[...this.#reservations.values()].map(({ slot }) => slot.accountProfileId),
    ]).size);
    const repositoryIds = [...this.#repositories.keys()].sort();
    const retainedRunIds = [...this.#reservations.values()]
      .flatMap(({ runId }) => runId === null ? [] : [runId])
      .sort();
    if (connectedAccounts.length === 0) {
      return {
        reportedState: "degraded",
        blockReason: "no_account",
        capacity: accountCount,
        activeRuns: this.#reservations.size,
        retainedRunIds,
        repositoryIds,
      };
    }
    if (repositoryIds.length === 0) {
      return {
        reportedState: "degraded",
        blockReason: "no_repository",
        capacity: accountCount,
        activeRuns: this.#reservations.size,
        retainedRunIds,
        repositoryIds,
      };
    }
    return {
      reportedState: this.#reservations.size >= accountCount ? "busy" : "ready",
      capacity: accountCount,
      activeRuns: this.#reservations.size,
      retainedRunIds,
      repositoryIds,
    };
  }

  async acquire(candidate: {
    readonly repositoryId: string;
  }): Promise<LocalDispatchSlot | null> {
    const repositoryPath = this.#repositories.get(candidate.repositoryId);
    if (repositoryPath === undefined) return null;
    if (this.#accountReservations !== null) {
      const account = await this.#accountReservations.acquire();
      if (account === null) return null;
      const slot = {
        accountProfileId: account.accountProfileId,
        repositoryId: candidate.repositoryId,
        repositoryPath,
        reservationId: account.reservationId,
      };
      this.#reservations.set(slot.reservationId, { slot, runId: null });
      return slot;
    }
    // Refresh can yield. Read reservations only afterwards so simultaneous
    // callers cannot both select the same account from a stale pre-await view.
    const availableAccounts = await this.#availableAccounts();
    const reservedAccounts = new Set(
      [...this.#reservations.values()].map(({ slot }) => slot.accountProfileId),
    );
    const now = this.#now();
    const account = availableAccounts
      .filter(({ id }) => !reservedAccounts.has(id))
      .toSorted((left, right) => compareDispatchAccounts(
        left,
        right,
        this.#lastUsed,
        now,
      ))[0];
    if (account === undefined) return null;
    const reservationId = `reservation_${String(this.#nextReservation).padStart(8, "0")}`;
    this.#nextReservation += 1;
    const slot = {
      accountProfileId: account.id,
      repositoryId: candidate.repositoryId,
      repositoryPath,
      reservationId,
    };
    this.#reservations.set(reservationId, { slot, runId: null });
    return slot;
  }

  settle(slot: LocalDispatchSlot, disposition: DispatchSlotDisposition): Promise<void> {
    const reservation = this.#reservations.get(slot.reservationId);
    if (
      reservation === undefined &&
      disposition.kind !== "claim_failed" &&
      this.#releasedRunIds.has(disposition.runId)
    ) {
      return Promise.resolve();
    }
    if (
      reservation === undefined ||
      reservation.slot.accountProfileId !== slot.accountProfileId ||
      reservation.slot.repositoryId !== slot.repositoryId ||
      reservation.slot.repositoryPath !== slot.repositoryPath
    ) {
      throw new Error("Dispatch slot is not reserved by this capability provider");
    }
    if (
      disposition.kind !== "claim_failed" &&
      reservation.runId !== null &&
      reservation.runId !== disposition.runId
    ) {
      throw new Error("Dispatch disposition does not match the reserved run");
    }
    if (
      disposition.kind !== "claim_failed" &&
      this.#releasedRunIds.has(disposition.runId)
    ) {
      this.#reservations.delete(slot.reservationId);
      if (this.#accountReservations !== null) {
        this.#accountReservations.release({
          accountProfileId: slot.accountProfileId,
          reservationId: slot.reservationId,
        });
      }
      this.#lastUsed.set(slot.accountProfileId, this.#now());
      return Promise.resolve();
    }
    if (disposition.kind === "running" || disposition.kind === "ambiguous") {
      reservation.runId = disposition.runId;
      this.#accountReservations?.bind(
        {
          accountProfileId: slot.accountProfileId,
          reservationId: slot.reservationId,
        },
        disposition.runId,
      );
      return Promise.resolve();
    }
    if (disposition.kind !== "claim_failed") this.#rememberReleased(disposition.runId);
    this.#reservations.delete(slot.reservationId);
    if (this.#accountReservations !== null) {
      this.#accountReservations.release({
        accountProfileId: slot.accountProfileId,
        reservationId: slot.reservationId,
      });
    }
    this.#lastUsed.set(slot.accountProfileId, this.#now());
    return Promise.resolve();
  }

  releaseRun(runId: string): LocalDispatchSlot | null {
    this.#rememberReleased(runId);
    const entry = [...this.#reservations.entries()].find(([, reservation]) => (
      reservation.runId === runId
    ));
    if (entry === undefined) return null;
    const [reservationId, reservation] = entry;
    this.#reservations.delete(reservationId);
    if (this.#accountReservations !== null) {
      this.#accountReservations.releaseRun(runId);
    }
    this.#lastUsed.set(reservation.slot.accountProfileId, this.#now());
    return reservation.slot;
  }

  #rememberReleased(runId: string): void {
    if (this.#releasedRunIds.has(runId)) return;
    this.#onRunReleased(runId);
    this.#releasedRunIds.add(runId);
    if (this.#releasedRunIds.size > 128) {
      const oldest = this.#releasedRunIds.values().next();
      if (!oldest.done) this.#releasedRunIds.delete(oldest.value);
    }
  }

  #availableAccounts(): Promise<readonly DispatchAccountSummary[]> {
    const accounts = this.#accounts.dispatchAccounts();
    const now = this.#now();
    this.#scheduleBudgetRefresh(accounts, now);
    // Dispatch only with a fresh, quantified budget. Unknown or stale values
    // cannot prove either availability or the greatest-remaining choice.
    return Promise.resolve(
      accounts.filter((account) => dispatchBudget(account.usage, now).kind === "known"),
    );
  }

  #scheduleBudgetRefresh(
    accounts: readonly DispatchAccountSummary[],
    now: number,
  ): void {
    const refresh = this.#accounts.refreshDispatchAccounts?.bind(this.#accounts);
    if (refresh === undefined) return;
    if (!accounts.some((account) => dispatchBudgetNeedsRefresh(account.usage, now))) {
      this.#budgetRefreshRetryAt = null;
      return;
    }
    if (
      this.#budgetRefresh !== null ||
      (this.#budgetRefreshRetryAt !== null &&
        !dispatchBudgetRefreshIsDue(now, this.#budgetRefreshRetryAt))
    ) return;

    // Never put provider I/O on the heartbeat or claim path. Until a refresh
    // completes with a fresh quantified budget, this account remains excluded.
    const task = Promise.resolve()
      .then(async () => await refresh())
      .then(
        (refreshed) => {
          const completedAt = this.#now();
          this.#budgetRefreshRetryAt = refreshed.some((account) =>
            dispatchBudgetNeedsRefresh(account.usage, completedAt))
            ? dispatchBudgetRefreshRetryAt(completedAt)
            : null;
        },
        () => {
          this.#budgetRefreshRetryAt = dispatchBudgetRefreshRetryAt(this.#now());
        },
      )
      .finally(() => {
        if (this.#budgetRefresh === task) this.#budgetRefresh = null;
      });
    this.#budgetRefresh = task;
  }
}

const budgetOrder = {
  known: 0,
  unknown: 1,
  stale: 2,
  exhausted: 3,
} as const satisfies Record<DispatchBudget["kind"], number>;

export function compareDispatchAccounts(
  left: DispatchAccountSummary,
  right: DispatchAccountSummary,
  lastUsed: ReadonlyMap<string, number>,
  now: number,
): number {
  const leftBudget = dispatchBudget(left.usage, now);
  const rightBudget = dispatchBudget(right.usage, now);
  const kindDifference = budgetOrder[leftBudget.kind] - budgetOrder[rightBudget.kind];
  if (kindDifference !== 0) return kindDifference;
  if (leftBudget.kind === "known" && rightBudget.kind === "known") {
    const remainingDifference = rightBudget.remainingPercent - leftBudget.remainingPercent;
    if (remainingDifference !== 0) return remainingDifference;
  }
  if (left.selected !== right.selected) return left.selected ? -1 : 1;
  const lastUsedDifference = (lastUsed.get(left.id) ?? 0) - (lastUsed.get(right.id) ?? 0);
  if (lastUsedDifference !== 0) return lastUsedDifference;
  return left.id.localeCompare(right.id);
}

export async function configureDispatchRepositories(options: {
  readonly database: Database;
  readonly broker: WorkspaceBroker;
  readonly store: DispatchStore;
  readonly mappings: readonly DispatchRepositoryMapping[];
  readonly now?: Date;
}): Promise<readonly DispatchRepositoryMapping[]> {
  const configured: DispatchRepositoryMapping[] = [];
  for (const mapping of options.mappings) {
    const inspected = await options.broker.inspectRepository(mapping.repositoryPath);
    const now = (options.now ?? new Date()).toISOString();
    const projectId = projectIdFor(inspected.canonicalRepositoryPath);
    options.database.query(`
      INSERT INTO projects (
        project_id, canonical_repository_path, canonical_git_common_dir,
        display_name, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT(project_id) DO UPDATE SET
        canonical_repository_path = excluded.canonical_repository_path,
        canonical_git_common_dir = excluded.canonical_git_common_dir,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `).run(
      projectId,
      inspected.canonicalRepositoryPath,
      inspected.canonicalGitCommonDir,
      basename(inspected.canonicalRepositoryPath),
      now,
    );
    options.store.bindRepository({
      repositoryPublicId: mapping.repositoryId,
      projectId,
      canonicalRepositoryPath: inspected.canonicalRepositoryPath,
      canonicalGitCommonDir: inspected.canonicalGitCommonDir,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    configured.push({
      repositoryId: mapping.repositoryId,
      repositoryPath: inspected.canonicalRepositoryPath,
    });
  }
  return configured;
}

function projectIdFor(path: string): string {
  return `proj_${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
}
