import {
  dispatchBudget,
  dispatchBudgetNeedsRefresh,
  dispatchBudgetRefreshIsDue,
  dispatchBudgetRefreshRetryAt,
} from "../accounts/dispatch-budget";
import type { DispatchAccountSummary } from "../internal-contracts";
import {
  compareDispatchAccounts,
  type DispatchAccountPort,
} from "./local-capabilities";

export interface DispatchAccountReservation {
  readonly accountProfileId: string;
  readonly reservationId: string;
}

export interface RecoveredAccountReservation {
  readonly accountProfileId: string;
  readonly runId: string;
}

export interface DispatchAccountReservationSnapshot {
  readonly activeRuns: number;
  readonly availableCapacity: number;
  readonly capacity: number;
  readonly retainedRunIds: readonly string[];
  readonly state: "no_account" | "capacity_full" | "ready";
}

interface Reservation {
  readonly accountProfileId: string;
  runId: string | null;
}

/**
 * Process-wide account admission authority. Cloud and local task dispatch must
 * share one instance: a Codex account is a one-run lane regardless of which
 * control plane supplied the work.
 */
export class DispatchAccountReservationArbiter {
  readonly #accounts: DispatchAccountPort;
  readonly #lastUsed = new Map<string, number>();
  readonly #now: () => number;
  readonly #reservations = new Map<string, Reservation>();
  #budgetRefresh: Promise<void> | null = null;
  #budgetRefreshRetryAt: number | null = null;
  #nextReservation = 1;

  constructor(options: {
    readonly accounts: DispatchAccountPort;
    readonly now?: () => number;
    readonly recoveredReservations?: readonly RecoveredAccountReservation[];
  }) {
    this.#accounts = options.accounts;
    this.#now = options.now ?? (() => Date.now());
    const accounts = new Set<string>();
    const runs = new Set<string>();
    for (const recovered of options.recoveredReservations ?? []) {
      if (
        accounts.has(recovered.accountProfileId)
        || runs.has(recovered.runId)
      ) {
        throw new Error("Recovered account reservations are inconsistent");
      }
      accounts.add(recovered.accountProfileId);
      runs.add(recovered.runId);
      this.#reservations.set(`recovered:${recovered.runId}`, {
        accountProfileId: recovered.accountProfileId,
        runId: recovered.runId,
      });
    }
  }

  async acquire(): Promise<DispatchAccountReservation | null> {
    const available = await this.#availableAccounts();
    const reservedAccounts = new Set(
      [...this.#reservations.values()].map(({ accountProfileId }) => accountProfileId),
    );
    const now = this.#now();
    const account = available
      .filter(({ id }) => !reservedAccounts.has(id))
      .toSorted((left, right) =>
        compareDispatchAccounts(left, right, this.#lastUsed, now))[0];
    if (account === undefined) return null;
    const reservationId =
      `account_reservation_${String(this.#nextReservation).padStart(8, "0")}`;
    this.#nextReservation += 1;
    this.#reservations.set(reservationId, {
      accountProfileId: account.id,
      runId: null,
    });
    return { accountProfileId: account.id, reservationId };
  }

  bind(reservation: DispatchAccountReservation, runId: string): void {
    const current = this.#require(reservation);
    if (current.runId !== null && current.runId !== runId) {
      throw new Error("Account reservation belongs to another run");
    }
    const duplicate = [...this.#reservations.values()].some((candidate) =>
      candidate !== current && candidate.runId === runId);
    if (duplicate) throw new Error("Run already owns another account reservation");
    current.runId = runId;
  }

  release(reservation: DispatchAccountReservation): void {
    this.#require(reservation);
    this.#reservations.delete(reservation.reservationId);
    this.#lastUsed.set(reservation.accountProfileId, this.#now());
  }

  releaseRun(runId: string): DispatchAccountReservation | null {
    const entry = [...this.#reservations.entries()].find(
      ([, reservation]) => reservation.runId === runId,
    );
    if (entry === undefined) return null;
    const [reservationId, reservation] = entry;
    this.#reservations.delete(reservationId);
    this.#lastUsed.set(reservation.accountProfileId, this.#now());
    return {
      accountProfileId: reservation.accountProfileId,
      reservationId,
    };
  }

  owns(runId: string, accountProfileId: string): boolean {
    return [...this.#reservations.values()].some((reservation) =>
      reservation.runId === runId
      && reservation.accountProfileId === accountProfileId);
  }

  snapshot(): Promise<DispatchAccountReservationSnapshot> {
    return Promise.resolve(this.currentSnapshot());
  }

  currentSnapshot(): DispatchAccountReservationSnapshot {
    const available = this.#currentAvailableAccounts();
    const accountIds = new Set([
      ...available.map(({ id }) => id),
      ...[...this.#reservations.values()].map(({ accountProfileId }) =>
        accountProfileId),
    ]);
    const capacity = Math.min(32, accountIds.size);
    const activeRuns = this.#reservations.size;
    const availableCapacity = Math.max(0, capacity - activeRuns);
    return {
      activeRuns,
      availableCapacity,
      capacity,
      retainedRunIds: [...this.#reservations.values()]
        .flatMap(({ runId }) => runId === null ? [] : [runId])
        .sort(),
      state: available.length === 0
        ? "no_account"
        : availableCapacity === 0
        ? "capacity_full"
        : "ready",
    };
  }

  #require(reservation: DispatchAccountReservation): Reservation {
    const current = this.#reservations.get(reservation.reservationId);
    if (
      current === undefined
      || current.accountProfileId !== reservation.accountProfileId
    ) {
      throw new Error("Account reservation is not owned by this arbiter");
    }
    return current;
  }

  #availableAccounts(): Promise<readonly DispatchAccountSummary[]> {
    return Promise.resolve(this.#currentAvailableAccounts());
  }

  #currentAvailableAccounts(): readonly DispatchAccountSummary[] {
    const accounts = this.#accounts.dispatchAccounts();
    const now = this.#now();
    this.#scheduleBudgetRefresh(accounts, now);
    return accounts.filter((account) =>
      dispatchBudget(account.usage, now).kind === "known");
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
      this.#budgetRefresh !== null
      || (
        this.#budgetRefreshRetryAt !== null
        && !dispatchBudgetRefreshIsDue(now, this.#budgetRefreshRetryAt)
      )
    ) return;
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
