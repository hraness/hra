import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { Context, Deferred, Effect, FiberSet, Layer } from "effect";

import { ClaudeError } from "./errors.ts";
import type { ClaudeProcess, ClaudeProcessIdentity } from "./process.ts";
import { taskFailure, type ClaudeNativeObservation, type ClaudeTaskFailure, type TaskGroup } from "./session-model.ts";

export class ClaudeConnectionWork extends Context.Tag("@hraness/hra/ClaudeConnectionWork")<
  ClaudeConnectionWork,
  {
    readonly groups: Readonly<Record<TaskGroup, FiberSet.FiberSet<unknown, never>>>;
    readonly native: Set<ClaudeNativeObservation>;
    readonly writeOrder: Effect.Semaphore;
  }
>() {}

export type ClaudeProgram<A> = Effect.Effect<A, ClaudeTaskFailure, ClaudeConnectionWork>;

export interface ClaudeOwnedTask<A> {
  readonly program: ClaudeProgram<A>;
  /** A settlement observation of this exact task, never a cancellation proxy. */
  readonly promise: Promise<A>;
}


export const ClaudeConnectionWorkLive = Layer.scoped(ClaudeConnectionWork, Effect.gen(function* () {
  const admission = yield* FiberSet.make<unknown, never>();
  const writes = yield* FiberSet.make<unknown, never>();
  const stdout = yield* FiberSet.make<unknown, never>();
  const stderr = yield* FiberSet.make<unknown, never>();
  const exitWatch = yield* FiberSet.make<unknown, never>();
  const facts = yield* FiberSet.make<unknown, never>();
  const continuations = yield* FiberSet.make<unknown, never>();
  const capabilities = yield* FiberSet.make<unknown, never>();
  const control = yield* FiberSet.make<unknown, never>();
  const writeOrder = yield* Effect.makeSemaphore(1);
  return {
    groups: { admission, writes, stdout, stderr, "exit-watch": exitWatch, facts,
      "manager-continuations": continuations, capabilities, control },
    native: new Set<ClaudeNativeObservation>(),
    writeOrder,
  };
}));

export const attempt = <A>(run: () => A): Effect.Effect<A, ClaudeTaskFailure> =>
  Effect.try({ try: run, catch: taskFailure });

/** Preserve synchronous accessor faults and the original resolved-exit proof. */
export function processExitObservation(process: ClaudeProcess, resolved: () => void): Promise<number> {
  const promise = process.exited.then(code => { resolved(); return code; });
  void promise.catch(() => undefined);
  return promise;
}

/** A foreign operation is retained until its actual Promise settles. Bounded
 * observers never interrupt this wait or replace its native settlement handle. */
export function nativeCall<A>(run: () => A | PromiseLike<A>): ClaudeProgram<A> {
  return Effect.flatMap(ClaudeConnectionWork, work => Effect.async<A, ClaudeTaskFailure>(resume => {
    let promise: Promise<A>;
    try {
      promise = Promise.resolve(run());
    } catch (reason: unknown) {
      resume(Effect.fail(taskFailure(reason)));
      return;
    }
    const observation: ClaudeNativeObservation = { promise };
    work.native.add(observation);
    void promise.then(
      value => { work.native.delete(observation); resume(Effect.succeed(value)); },
      (reason: unknown) => { work.native.delete(observation); resume(Effect.fail(taskFailure(reason))); },
    );
  })).pipe(Effect.uninterruptible);
}

/** Native admission arbitration deliberately observes initialization first. */
export function nativeInitializationIdentity<A>(
  initialization: Promise<A>, process: ClaudeProcess,
  parse: (identity: ClaudeProcessIdentity) => ClaudeProcessIdentity,
): ClaudeProgram<[A, ClaudeProcessIdentity]> {
  return nativeCall(() => Promise.all([initialization, process.identity.then(parse)]));
}

export const forceNativeProcess = (process: ClaudeProcess): ClaudeProgram<void> =>
  attempt(() => { process.forceTerminate(); });

export const nativeProcessExit = (process: ClaudeProcess): ClaudeProgram<number> =>
  nativeCall(() => process.exited);

/** The original native microtask boundary, not an Effect scheduler yield. */
export const nativeRequestId = (): Effect.Effect<string, ClaudeTaskFailure> => attempt(() => randomUUID());

export const nativeMicrotask = (): ClaudeProgram<void> => nativeCall(() => Promise.resolve());

/** Releases the daemon's real serialized caller before a synthetic notice. */
export const nativeTurn = (): ClaudeProgram<void> => nativeCall(() => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, 0);
  timer.unref();
}));

export function observeWithin(promise: Promise<unknown>, milliseconds: number, requireResolution = false): ClaudeProgram<boolean> {
  return nativeCall(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      promise.then(() => true, () => !requireResolution),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
  });
}

export interface ClaudeCompletion<A> {
  readonly program: Effect.Effect<A, ClaudeTaskFailure>;
  readonly promise: Promise<A>;
  readonly succeed: (value: A) => void;
  readonly reject: (reason: unknown) => void;
}

/** Initialization has one settlement operation and two observation dialects.
 * Effect consumers use Deferred. The retained native observation preserves the
 * existing Promise.race/Promise.all reaction order at admission's identity join.
 * Neither observer is an independent scheduler or an alternative lifecycle. */
export function nativeCompletion<A>(deferred: Deferred.Deferred<A, ClaudeTaskFailure>): ClaudeCompletion<A> {
  let settled = false;
  let resolve!: (value: A) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return {
    program: Deferred.await(deferred),
    promise,
    succeed: value => { if (settled) return; settled = true; resolve(value); Deferred.unsafeDone(deferred, Effect.succeed(value)); },
    reject: reason => { if (settled) return; settled = true; reject(reason); Deferred.unsafeDone(deferred, Effect.fail(taskFailure(reason))); },
  };
}

export async function initializationObservation<A>(promise: Promise<A>, input: Readonly<{ signal: AbortSignal; timeoutMs: number }>): Promise<A> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60_000) {
    throw new ClaudeError("INVALID_INPUT", "Claude initialization timeout must be 1 to 60000 ms.");
  }
  input.signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onAbort = (): void => { rejectAbort(input.signal.reason); };
  let rejectAbort!: (reason: unknown) => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    input.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => reject(new ClaudeError("TIMEOUT", "Claude did not publish its initialization identity in time.")), input.timeoutMs);
    timer.unref();
  });
  try { return await Promise.race([promise, boundary]); } finally {
    input.signal.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class ClaudeCallbackContext {
  readonly #context = new AsyncLocalStorage<{ active: boolean }>();

  active(): boolean { return this.#context.getStore()?.active === true; }

  call<A>(run: () => A | Promise<A>): ClaudeProgram<A> {
    return nativeCall(() => {
      const callback = { active: true };
      return this.#context.run(callback, async () => {
        try { return await run(); } finally { callback.active = false; }
      });
    });
  }
}

/** for-await's abrupt completion awaits the exact return() operation. */
export function consumeNative<A>(source: AsyncIterable<A>, consume: (value: A) => ClaudeProgram<void>): ClaudeProgram<void> {
  return Effect.gen(function* () {
    const iterator = yield* attempt(() => source[Symbol.asyncIterator]());
    for (;;) {
      // A failed next() does not enter AsyncIteratorClose. An abrupt body does.
      const step = yield* nativeCall(() => iterator.next());
      if (step.done) return;
      const body = yield* Effect.exit(consume(step.value));
      if (body._tag === "Failure") {
        yield* Effect.exit(Effect.gen(function* () {
          const close = yield* attempt(() => iterator.return);
          if (close !== undefined) yield* nativeCall(() => close.call(iterator));
        }));
        return yield* Effect.failCause(body.cause);
      }
    }
  });
}
