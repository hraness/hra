import type { OrganizationView } from "@hraness/agent-tasks-protocol";

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
  clear(input: { readonly expectedGeneration: number }): Promise<boolean>;
}

export interface HumanRefreshDriver {
  refresh(input: {
    readonly refreshToken: string;
    readonly workosOrganizationId?: string;
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
    left.workosOrganizationId === right.workosOrganizationId
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

  async settled(): Promise<void> {
    while (this.#activeOperations > 0) {
      await new Promise<void>((resolve) => {
        this.#settleWaiters.add(resolve);
      });
    }
  }

  #completeOperation(): void {
    this.#activeOperations -= 1;
    if (this.#activeOperations !== 0) return;
    const waiters = [...this.#settleWaiters];
    this.#settleWaiters.clear();
    for (const resolve of waiters) resolve();
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
    try {
      await this.#store.clear({
        expectedGeneration: snapshot.generation,
      });
    } catch {
      // A failed clear is deliberately not surfaced with custody details.
    }
  }

  async #performRefresh(
    stale: HumanAuthenticationSnapshot,
    targetOrganization?: OrganizationView,
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
      const workosOrganizationId =
        targetOrganization?.workosOrganizationId ??
        current.authentication.workosOrganizationId;
      refreshed = await this.#refresh.refresh({
        refreshToken: current.authentication.refreshToken,
        ...(workosOrganizationId === undefined
          ? {}
          : { workosOrganizationId }),
      });
    } catch {
      await this.#clearStale(current);
      return sessionFailure("AUTH_REFRESH_INDETERMINATE");
    }
    if (!refreshed.ok) {
      await this.#clearStale(current);
      return sessionFailure(
        refreshed.outcome === "indeterminate"
          ? "AUTH_REFRESH_INDETERMINATE"
          : "AUTHENTICATION_FAILED",
      );
    }

    const nextAuthentication = refreshedHumanAuthentication(
      current.authentication,
      refreshed.data,
      targetOrganization,
    );
    if (!nextAuthentication.ok) {
      await this.#clearStale(current);
      return sessionFailure("AUTHENTICATION_FAILED");
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
      await this.#clearStale(current);
      return sessionFailure("AUTH_REFRESH_INDETERMINATE");
    }
    if (replaced !== null) {
      if (
        replaced.generation <= current.generation ||
        !samePrincipal(replaced.authentication, next.authentication)
      ) {
        return sessionFailure("AUTHENTICATION_FAILED");
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
    targetOrganization?: OrganizationView,
  ): Promise<InternalRefresh> {
    const key = JSON.stringify([
      stale.generation,
      stale.authentication.apiUrl,
      stale.authentication.user.id,
      stale.authentication.workosOrganizationId ?? null,
      targetOrganization?.id ?? null,
      targetOrganization?.workosOrganizationId ?? null,
    ]);
    const existing = this.#refreshInFlight;
    if (existing !== null) {
      if (existing.key === key) return await existing.promise;
      await existing.promise;
      return await this.#refreshOnce(stale, targetOrganization);
    }
    const refresh = this.#performRefresh(stale, targetOrganization);
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
    ) => Promise<HumanOperationResult<Value, Failure>>,
  ): Promise<HumanSessionResult<Value, Failure>> {
    if (this.#admissionClosed) {
      return {
        ok: false,
        kind: "session",
        error: sessionFailure("SERVICE_UNAVAILABLE").error,
      };
    }
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
      result = await operation(snapshot.authentication.accessToken);
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
