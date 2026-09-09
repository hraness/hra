import { Deferred, Effect, Exit, Fiber, FiberId, FiberSet, ManagedRuntime } from "effect";

import { ClaudeError } from "./errors.ts";
import { failureReason, taskGroups, type ClaudeTaskFailure, type TaskGroup } from "./session-model.ts";
import { ClaudeCallbackContext, ClaudeConnectionWork, ClaudeConnectionWorkLive, nativeCompletion, type ClaudeOwnedTask, type ClaudeProgram, type ClaudeCompletion } from "./session-platform.ts";

export type { ClaudeTaskFailure, TaskGroup } from "./session-model.ts";
export type { ClaudeOwnedTask, ClaudeProgram } from "./session-platform.ts";

function ownedTask<A>(fiber: Fiber.RuntimeFiber<Exit.Exit<A, ClaudeTaskFailure>, never>): ClaudeOwnedTask<A> {
  const promise = new Promise<A>((resolve, reject) => {
    fiber.addObserver(result => {
      if (Exit.isFailure(result)) { reject(failureReason(result.cause)); return; }
      const exit = result.value;
      if (Exit.isSuccess(exit)) resolve(exit.value);
      else reject(failureReason(exit.cause));
    });
  });
  void promise.catch(() => undefined);
  return {
    promise,
    program: Effect.flatMap(Fiber.join(fiber), exit => Exit.isSuccess(exit)
      ? Effect.succeed(exit.value)
      : Effect.failCause(exit.cause)),
  };
}

/** One prepared interpreter spans acquisition, client lifetime and cleanup.
 * Internal programs compose fork/join; only public facades use run/start. */
export class ClaudeConnectionEffects {
  readonly #runtime = ManagedRuntime.make(ClaudeConnectionWorkLive);
  readonly #callbacks = new ClaudeCallbackContext();
  #disposed = false;

  constructor() {
    // Build the synchronous scoped services before a public operation can enter
    // its first callback; lazy runtime preparation must not defer admission.
    this.#runtime.runSync(ClaudeConnectionWork);
  }

  start<A>(group: TaskGroup, program: ClaudeProgram<A>): ClaudeOwnedTask<A> {
    if (this.#disposed) throw new ClaudeError("PROCESS_EXITED", "The Claude connection owner is closed");
    const run = this.#runtime.runSync(Effect.flatMap(ClaudeConnectionWork, work =>
      FiberSet.runtime(work.groups[group])<ClaudeConnectionWork>(),
    ));
    return ownedTask(run(Effect.exit(program.pipe(Effect.uninterruptible)), { immediate: true }));
  }

  async run<A>(group: TaskGroup, program: ClaudeProgram<A>): Promise<A> {
    return await this.start(group, program).promise;
  }

  /** Child fibers inherit this interpreter and its scope; no runtime re-entry. */
  fork<A>(group: TaskGroup, program: ClaudeProgram<A>): ClaudeProgram<ClaudeOwnedTask<A>> {
    return Effect.flatMap(ClaudeConnectionWork, work =>
      Effect.map(FiberSet.run(work.groups[group], Effect.exit(program.pipe(Effect.uninterruptible))), ownedTask),
    );
  }

  join(group: TaskGroup): ClaudeProgram<void> {
    return Effect.flatMap(ClaudeConnectionWork, work => FiberSet.awaitEmpty(work.groups[group]));
  }

  count(group: TaskGroup): number {
    return this.#runtime.runSync(Effect.flatMap(ClaudeConnectionWork, work => FiberSet.size(work.groups[group])));
  }

  initializationCompletion<A>(): ClaudeCompletion<A> {
    return nativeCompletion(Deferred.unsafeMake<A, ClaudeTaskFailure>(FiberId.none));
  }

  completion<A>(group: TaskGroup): Readonly<{
    task: ClaudeOwnedTask<A>;
    succeed: (value: A) => void;
    reject: (reason: unknown) => void;
  }> {
    const completion = this.initializationCompletion<A>();
    return { task: this.start(group, completion.program), succeed: completion.succeed, reject: completion.reject };
  }

  reserve<A>(group: TaskGroup): ClaudeProgram<Readonly<{
    task: ClaudeOwnedTask<A>;
    succeed: (value: A) => void;
    reject: (reason: unknown) => void;
  }>> {
    return Effect.gen(this, function* () {
      const completion = nativeCompletion(yield* Deferred.make<A, ClaudeTaskFailure>());
      const task = yield* this.fork(group, completion.program);
      return { task, succeed: completion.succeed, reject: completion.reject };
    });
  }

  callback<A>(run: () => A | Promise<A>): ClaudeProgram<A> { return this.#callbacks.call(run); }

  callbackActive(): boolean { return this.#callbacks.active(); }

  /** Standalone facade edge: its terminal client has already bounded and
   * proven native release. Join concurrently returning public calls before
   * disposing their shared scope, without adding this waiter to its own group. */
  async disposeWhenIdle(): Promise<void> {
    if (this.#disposed) return;
    await this.#runtime.runPromise(Effect.gen(function* () {
      const work = yield* ClaudeConnectionWork;
      for (const group of taskGroups) yield* FiberSet.awaitEmpty(work.groups[group]);
    }));
    await this.dispose();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    const pending = this.#runtime.runSync(Effect.gen(function* () {
      const work = yield* ClaudeConnectionWork;
      if (work.native.size > 0) return true;
      for (const group of taskGroups) if ((yield* FiberSet.size(work.groups[group])) > 0) return true;
      return false;
    }));
    if (pending) throw new ClaudeError("TIMEOUT", "Claude connection work has not settled; its owner must be retained.");
    this.#disposed = true;
    await this.#runtime.dispose();
  }
}
