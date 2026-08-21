import {
  humanAuthenticationSnapshotSchema,
  refreshedHumanAuthentication,
  type HumanAuthentication,
  type HumanAuthenticationSnapshot,
} from "./human-auth";

export interface HumanAuthenticationStore {
  /**
   * Secret-bearing custody read. Implementations must not project this value
   * into logs, SQLite metadata, renderer messages, or diagnostics.
   */
  read(): Promise<unknown>;
  /**
   * Return the actual committed snapshot. Its generation may exceed
   * `next.generation` when custody skips an abandoned high-water generation.
   * `null` means the expected generation lost the race.
   */
  compareAndSwap(input: {
    readonly expectedGeneration: number;
    readonly next: HumanAuthenticationSnapshot;
  }): Promise<HumanAuthenticationSnapshot | null>;
  /**
   * Remove one exact generation from live admission while preserving its
   * secret-store bytes and durable recovery evidence.
   */
  preserveForRecovery(input: {
    readonly expectedGeneration: number;
  }): Promise<boolean>;
  clear(input: { readonly expectedGeneration: number }): Promise<boolean>;
}

export interface HumanRefreshDriver {
  refresh(input: {
    readonly refreshToken: string;
  }): Promise<
    | { readonly ok: true; readonly data: unknown }
    | {
        readonly ok: false;
        readonly outcome: "authentication_failed" | "indeterminate";
      }
  >;
}

export interface HumanOperationFailure {
  readonly code: string;
}

export type HumanOperationResult<Value, Failure extends HumanOperationFailure> =
  | { readonly ok: true; readonly data: Value }
  | { readonly ok: false; readonly error: Failure };

export interface HumanSessionFailure {
  readonly code:
    | "AUTHENTICATION_FAILED"
    | "AUTH_REFRESH_INDETERMINATE"
    | "SERVICE_UNAVAILABLE"
    | "SIGNED_OUT";
  readonly message: string;
}

export type HumanSessionResult<
  Value,
  Failure extends HumanOperationFailure,
> =
  | { readonly ok: true; readonly data: Value }
  | {
      readonly ok: false;
      readonly kind: "operation";
      readonly error: Failure;
    }
  | {
      readonly ok: false;
      readonly kind: "session";
      readonly error: HumanSessionFailure;
    };

export interface HumanSessionTransition {
  execute<Value, Failure extends HumanOperationFailure>(
    operation: (
      accessToken: string,
      authority: HumanAuthenticationSnapshot,
    ) => Promise<HumanOperationResult<Value, Failure>>,
  ): Promise<HumanSessionResult<Value, Failure>>;
}

export type HumanSessionTransitionResult<Value> =
  | { readonly ok: true; readonly data: Value }
  | {
      readonly ok: false;
      readonly error: HumanSessionFailure;
    };

export interface HumanSessionCoordinatorOptions {
  readonly store: HumanAuthenticationStore;
  readonly refresh: HumanRefreshDriver;
  readonly isAuthenticationFailure?: (
    failure: HumanOperationFailure,
  ) => boolean;
}

type InternalRefresh =
  | {
      readonly ok: true;
      readonly snapshot: HumanAuthenticationSnapshot;
    }
  | { readonly ok: false; readonly error: HumanSessionFailure };

class HumanSessionLoadError extends Error {
  readonly failure: HumanSessionFailure;

  constructor(failure: HumanSessionFailure) {
    super(failure.message);
    this.name = "HumanSessionLoadError";
    this.failure = failure;
  }
}

function sessionFailure(
  code: HumanSessionFailure["code"],
): InternalRefresh & { readonly ok: false } {
  const message =
    code === "SIGNED_OUT"
      ? "no human account is signed in"
      : code === "AUTH_REFRESH_INDETERMINATE"
        ? "the authentication refresh outcome is unknown; sign in again"
        : code === "SERVICE_UNAVAILABLE"
          ? "human authentication is temporarily unavailable"
          : "human authentication failed; sign in again";
  return { ok: false, error: { code, message } };
}

function samePrincipal(
  left: HumanAuthentication,
  right: HumanAuthentication,
): boolean {
  return (
    left.apiUrl === right.apiUrl &&
    left.user.id === right.user.id &&
    left.organization.id === right.organization.id &&
    left.workspace?.id === right.workspace?.id
  );
}

export class HumanSessionCoordinator {
  readonly #store: HumanAuthenticationStore;
  readonly #refresh: HumanRefreshDriver;
  readonly #isAuthenticationFailure: (
    failure: HumanOperationFailure,
  ) => boolean;
  #refreshInFlight: Readonly<{
    key: string;
    promise: Promise<InternalRefresh>;
  }> | null = null;
  #activeOperations = 0;
  #admissionClosed = false;
  #transitionInProgress = false;
  readonly #operationSettleWaiters = new Set<() => void>();
  readonly #settleWaiters = new Set<() => void>();

  constructor(options: HumanSessionCoordinatorOptions) {
    this.#store = options.store;
    this.#refresh = options.refresh;
    this.#isAuthenticationFailure =
      options.isAuthenticationFailure ??
      ((failure) => failure.code === "AUTHENTICATION_FAILED");
  }

  closeAdmission(): void {
    this.#admissionClosed = true;
  }

  /**
   * Reopen a recovery-contained coordinator only after its owner has committed
   * a fresh credential. Active bearer work and refresh settlement make that
   * transition unsafe, so the caller must wait and try again.
   */
  reopenAdmission(): boolean {
    if (
      this.#activeOperations !== 0 || this.#refreshInFlight !== null ||
      this.#transitionInProgress
    ) {
      return false;
    }
    this.#admissionClosed = false;
    return true;
  }

  async settled(): Promise<void> {
    while (this.#activeOperations > 0 || this.#transitionInProgress) {
      await new Promise<void>((resolve) => {
        this.#settleWaiters.add(resolve);
      });
    }
  }

  async #operationsSettled(): Promise<void> {
    while (this.#activeOperations > 0) {
      await new Promise<void>((resolve) => {
        this.#operationSettleWaiters.add(resolve);
      });
    }
  }

  #notifySettlement(): void {
    if (this.#activeOperations === 0) {
      const operationWaiters = [...this.#operationSettleWaiters];
      this.#operationSettleWaiters.clear();
      for (const resolve of operationWaiters) resolve();
    }
    if (this.#activeOperations !== 0 || this.#transitionInProgress) return;
    const waiters = [...this.#settleWaiters];
    this.#settleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  #completeOperation(): void {
    this.#activeOperations -= 1;
    this.#notifySettlement();
  }

  async #readSnapshot(): Promise<HumanAuthenticationSnapshot | null> {
    let value: unknown;
    try {
      value = await this.#store.read();
    } catch {
      throw new HumanSessionLoadError(
        sessionFailure("SERVICE_UNAVAILABLE").error,
      );
    }
    if (value === null) return null;
    const parsed = humanAuthenticationSnapshotSchema.safeParse(value);
    if (!parsed.success) {
      throw new HumanSessionLoadError(
        sessionFailure("AUTHENTICATION_FAILED").error,
      );
    }
    return parsed.data;
  }

  async #clearStale(
    snapshot: HumanAuthenticationSnapshot,
  ): Promise<void> {
    let cleared = false;
    try {
      cleared = await this.#store.clear({
        expectedGeneration: snapshot.generation,
      });
    } catch {
      // Resolve whether the clear committed or lost to a newer writer below.
    }
    if (cleared) return;

    try {
      const winner = await this.#readSnapshot();
      if (
        winner === null ||
        winner.generation > snapshot.generation
      ) {
        return;
      }
    } catch {
      // Admission closes below when the current generation cannot be proven.
    }
    // The server definitively rejected this generation. It can never remain
    // eligible for another bearer operation when its exact clear is false or
    // indeterminate.
    this.#admissionClosed = true;
  }

  async #preserveStale(
    snapshot: HumanAuthenticationSnapshot,
  ): Promise<void> {
    let preserved = false;
    try {
      preserved = await this.#store.preserveForRecovery({
        expectedGeneration: snapshot.generation,
      });
    } catch {
      // Resolve the live winner below. The preservation call may have lost its
      // response after either committing or losing the exact-generation CAS.
    }
    if (preserved) {
      this.#admissionClosed = true;
      return;
    }

    try {
      const winner = await this.#readSnapshot();
      if (winner !== null && winner.generation > snapshot.generation) {
        // A newer valid credential owns admission. It may represent an
        // authorized organization/workspace selection and must not be killed
        // by an older refresh whose outcome became indeterminate.
        return;
      }
    } catch {
      // Admission closes below when the current generation cannot be proven.
    }
    this.#admissionClosed = true;
  }

  async #performRefresh(
    stale: HumanAuthenticationSnapshot,
  ): Promise<InternalRefresh> {
    let current: HumanAuthenticationSnapshot | null;
    try {
      current = await this.#readSnapshot();
    } catch {
      return sessionFailure("SERVICE_UNAVAILABLE");
    }
    if (current === null) return sessionFailure("SIGNED_OUT");
    if (current.generation > stale.generation) {
      return samePrincipal(current.authentication, stale.authentication)
        ? { ok: true, snapshot: current }
        : sessionFailure("AUTHENTICATION_FAILED");
    }
    if (
      current.generation !== stale.generation ||
      !samePrincipal(current.authentication, stale.authentication)
    ) {
      return sessionFailure("AUTHENTICATION_FAILED");
    }

    let refreshed: Awaited<ReturnType<HumanRefreshDriver["refresh"]>>;
    try {
      refreshed = await this.#refresh.refresh({
        refreshToken: current.authentication.refreshToken,
      });
    } catch {
      await this.#preserveStale(current);
      return sessionFailure("AUTH_REFRESH_INDETERMINATE");
    }
    if (!refreshed.ok) {
      if (refreshed.outcome === "indeterminate") {
        await this.#preserveStale(current);
        return sessionFailure("AUTH_REFRESH_INDETERMINATE");
      }
      await this.#clearStale(current);
      return sessionFailure("AUTHENTICATION_FAILED");
    }

    const nextAuthentication = refreshedHumanAuthentication(
      current.authentication,
      refreshed.data,
    );
    if (!nextAuthentication.ok) {
      await this.#preserveStale(current);
      return sessionFailure("AUTH_REFRESH_INDETERMINATE");
    }
    const next = humanAuthenticationSnapshotSchema.parse({
      generation: current.generation + 1,
      authentication: nextAuthentication.authentication,
    });
    let replaced: HumanAuthenticationSnapshot | null;
    try {
      const replacement = await this.#store.compareAndSwap({
        expectedGeneration: current.generation,
        next,
      });
      replaced = replacement === null
        ? null
        : humanAuthenticationSnapshotSchema.parse(replacement);
    } catch {
      let winner: HumanAuthenticationSnapshot | null = null;
      try {
        winner = await this.#readSnapshot();
      } catch {
        // The provider may already have consumed the rotating refresh token.
      }
      if (
        winner !== null &&
        winner.generation > current.generation &&
        samePrincipal(winner.authentication, current.authentication)
      ) {
        return { ok: true, snapshot: winner };
      }
      await this.#preserveStale(current);
      return sessionFailure("AUTH_REFRESH_INDETERMINATE");
    }
    if (replaced !== null) {
      if (
        replaced.generation <= current.generation ||
        !samePrincipal(replaced.authentication, next.authentication)
      ) {
        await this.#preserveStale(replaced);
        return sessionFailure("AUTH_REFRESH_INDETERMINATE");
      }
      return { ok: true, snapshot: replaced };
    }

    let winner: HumanAuthenticationSnapshot | null;
    try {
      winner = await this.#readSnapshot();
    } catch {
      return sessionFailure("SERVICE_UNAVAILABLE");
    }
    if (
      winner !== null &&
      winner.generation > current.generation &&
      samePrincipal(winner.authentication, current.authentication)
    ) {
      return { ok: true, snapshot: winner };
    }
    return sessionFailure("AUTHENTICATION_FAILED");
  }

  async #refreshOnce(
    stale: HumanAuthenticationSnapshot,
  ): Promise<InternalRefresh> {
    const key = JSON.stringify([
      stale.generation,
      stale.authentication.apiUrl,
      stale.authentication.user.id,
      stale.authentication.organization.id,
      stale.authentication.workspace?.id ?? null,
    ]);
    const existing = this.#refreshInFlight;
    if (existing !== null) {
      if (existing.key === key) return await existing.promise;
      await existing.promise;
      return await this.#refreshOnce(stale);
    }
    const refresh = this.#performRefresh(stale);
    this.#refreshInFlight = { key, promise: refresh };
    try {
      return await refresh;
    } finally {
      if (this.#refreshInFlight?.promise === refresh) {
        this.#refreshInFlight = null;
      }
    }
  }

  /**
   * Execute any typed human route. Missing custody returns before invoking the
   * operation, and an authentication failure is retried exactly once after a
   * process-local single-flight refresh.
   */
  async execute<Value, Failure extends HumanOperationFailure>(
    operation: (
      accessToken: string,
      authority: HumanAuthenticationSnapshot,
    ) => Promise<HumanOperationResult<Value, Failure>>,
  ): Promise<HumanSessionResult<Value, Failure>> {
    if (this.#admissionClosed || this.#transitionInProgress) {
      return {
        ok: false,
        kind: "session",
        error: sessionFailure("SERVICE_UNAVAILABLE").error,
      };
    }
    return await this.#executeAdmitted(operation);
  }

  /**
   * Pause ordinary bearer admission, drain work admitted before the pause, and
   * keep that pause held while one credential-rotating transition performs its
   * network attempt and durable local commit. Terminal or recovery admission
   * closure during the transition is never undone when the lease releases.
   */
  async withExclusiveTransition<Value>(
    transition: (
      session: HumanSessionTransition,
    ) => Promise<Value>,
  ): Promise<HumanSessionTransitionResult<Value>> {
    if (this.#admissionClosed || this.#transitionInProgress) {
      return {
        ok: false,
        error: sessionFailure("SERVICE_UNAVAILABLE").error,
      };
    }
    this.#transitionInProgress = true;
    try {
      await this.#operationsSettled();
      if (this.#admissionClosed) {
        return {
          ok: false,
          error: sessionFailure("SERVICE_UNAVAILABLE").error,
        };
      }
      const session: HumanSessionTransition = {
        execute: async <OperationValue, Failure extends HumanOperationFailure>(
          operation: (
            accessToken: string,
            authority: HumanAuthenticationSnapshot,
          ) => Promise<HumanOperationResult<OperationValue, Failure>>,
        ): Promise<HumanSessionResult<OperationValue, Failure>> => {
          if (this.#admissionClosed) {
            return {
              ok: false,
              kind: "session",
              error: sessionFailure("SERVICE_UNAVAILABLE").error,
            };
          }
          return await this.#executeAdmitted(operation);
        },
      };
      return { ok: true, data: await transition(session) };
    } finally {
      this.#transitionInProgress = false;
      this.#notifySettlement();
    }
  }

  async #executeAdmitted<Value, Failure extends HumanOperationFailure>(
    operation: (
      accessToken: string,
      authority: HumanAuthenticationSnapshot,
    ) => Promise<HumanOperationResult<Value, Failure>>,
  ): Promise<HumanSessionResult<Value, Failure>> {
    this.#activeOperations += 1;
    try {
    let snapshot: HumanAuthenticationSnapshot | null;
    try {
      snapshot = await this.#readSnapshot();
    } catch (error) {
      const failure = error instanceof HumanSessionLoadError
        ? error.failure
        : sessionFailure("SERVICE_UNAVAILABLE").error;
      return { ok: false, kind: "session", error: failure };
    }
    if (snapshot === null) {
      return {
        ok: false,
        kind: "session",
        error: sessionFailure("SIGNED_OUT").error,
      };
    }

    let result: HumanOperationResult<Value, Failure>;
    try {
      result = await operation(
        snapshot.authentication.accessToken,
        snapshot,
      );
    } catch {
      return {
        ok: false,
        kind: "session",
        error: sessionFailure("SERVICE_UNAVAILABLE").error,
      };
    }
    if (result.ok) return result;
    if (!this.#isAuthenticationFailure(result.error)) {
      return { ok: false, kind: "operation", error: result.error };
    }

    const refreshed = await this.#refreshOnce(snapshot);
    if (!refreshed.ok) {
      return { ok: false, kind: "session", error: refreshed.error };
    }
    try {
      const replay = await operation(
        refreshed.snapshot.authentication.accessToken,
        refreshed.snapshot,
      );
      if (replay.ok) return replay;
      if (!this.#isAuthenticationFailure(replay.error)) {
        return { ok: false, kind: "operation", error: replay.error };
      }
      await this.#clearStale(refreshed.snapshot);
      return {
        ok: false,
        kind: "session",
        error: sessionFailure("AUTHENTICATION_FAILED").error,
      };
    } catch {
      return {
        ok: false,
        kind: "session",
        error: sessionFailure("SERVICE_UNAVAILABLE").error,
      };
    }
    } finally {
      this.#completeOperation();
    }
  }
}
