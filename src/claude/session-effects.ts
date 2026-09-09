import { Deferred, Effect, Exit, Fiber, FiberId, FiberSet, ManagedRuntime, type Cause } from "effect";

import { ClaudeError } from "./errors.ts";
import { failureReason, taskFailure, taskGroups, type ClaudeTaskFailure, type TaskGroup } from "./session-model.ts";
import { ClaudeCallbackContext, ClaudeConnectionWork, ClaudeConnectionWorkLive, nativeCompletion, nativeSettlementWithin, type ClaudeOwnedTask, type ClaudeProgram, type ClaudeCompletion } from "./session-platform.ts";

export type { ClaudeTaskFailure, TaskGroup } from "./session-model.ts";
export type { ClaudeOwnedTask, ClaudeProgram } from "./session-platform.ts";

function ownedTask<A>(fiber: Fiber.RuntimeFiber<Exit.Exit<A, ClaudeTaskFailure>>): ClaudeOwnedTask<A> {
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
  #retiring = false;
  #retirementTask: Promise<void> | undefined;
  #disposalTask: Promise<void> | undefined;

  constructor() {
    // Build the synchronous scoped services before a public operation can enter
    // its first callback; lazy runtime preparation must not defer admission.
    this.#runtime.runSync(ClaudeConnectionWork);
  }

  start<A>(group: TaskGroup, program: ClaudeProgram<A>): ClaudeOwnedTask<A> {
    if (this.#retiring) throw new ClaudeError("PROCESS_EXITED", "The Claude connection owner is closed");
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

  initializationCompletion<A>(): ClaudeCompletion<A> {
    return nativeCompletion(Deferred.unsafeMake<A, ClaudeTaskFailure>(FiberId.none));
  }

  reserve<A>(group: TaskGroup): ClaudeProgram<Readonly<{
    task: ClaudeOwnedTask<A>;
    succeed: (value: A) => void;
    reject: (reason: unknown) => void;
    failCause: (cause: Cause.Cause<ClaudeTaskFailure>) => void;
  }>> {
    return Effect.gen(this, function* () {
      const deferred = yield* Deferred.make<A, ClaudeTaskFailure>();
      const task = yield* this.fork(group, Deferred.await(deferred));
      return {
        task,
        succeed: value => { Deferred.unsafeDone(deferred, Effect.succeed(value)); },
        reject: reason => { Deferred.unsafeDone(deferred, Effect.fail(taskFailure(reason))); },
        failCause: cause => { Deferred.unsafeDone(deferred, Effect.failCause(cause)); },
      };
    });
  }

  callback<A>(run: () => A | Promise<A>): ClaudeProgram<A> { return this.#callbacks.call(run); }

  callbackActive(): boolean { return this.#callbacks.active(); }

  /** Outer retirement starts only after terminal resource cleanup. Existing
   * programs may finish and fork their admitted children; new public work is
   * fenced immediately. This waiter never enrolls in a group it must join. */
  disposeWhenIdle(): Promise<void> {
    if (this.#retirementTask !== undefined) return this.#retirementTask;
    if (this.#disposalTask !== undefined) return this.#disposalTask;
    this.#retiring = true;
    this.#retirementTask = this.#drainAndDispose();
    return this.#retirementTask;
  }

  /** Manager close observes the exact retirement without entering a retiring
   * interpreter or enrolling an observation in the scope being disposed. */
  async observeDisposal(milliseconds: number): Promise<void> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 30_000) {
      throw new ClaudeError("INVALID_INPUT", "Claude connection shutdown settlement must be 1 to 30000 ms.");
    }
    const task = this.#retirementTask ?? this.#disposalTask;
    if (task === undefined) throw new ClaudeError("INVALID_INPUT", "The Claude connection owner has not begun retirement.");
    if (!(await nativeSettlementWithin(task, milliseconds))) {
      throw new ClaudeError("TIMEOUT", "Claude connection work has not settled; its owner must be retained.");
    }
    await task;
  }

  async #drainAndDispose(): Promise<void> {
    for (;;) {
      await this.#runtime.runPromise(Effect.gen(function* () {
        const work = yield* ClaudeConnectionWork;
        for (const group of taskGroups) yield* FiberSet.awaitEmpty(work.groups[group]);
      }));
      if (this.#disposalTask !== undefined) return await this.#disposalTask;
      // A later group can fork into one already traversed. Repeat only for
      // actual grouped work; a native-only residual must not cause a spin.
      if (this.#pendingWork().groups) continue;
      return await this.#disposeIdle();
    }
  }

  #pendingWork(): Readonly<{ groups: boolean; native: boolean }> {
    return this.#runtime.runSync(Effect.gen(function* () {
      const work = yield* ClaudeConnectionWork;
      let groups = false;
      for (const group of taskGroups) if ((yield* FiberSet.size(work.groups[group])) > 0) groups = true;
      return { groups, native: work.native.size > 0 };
    }));
  }

  dispose(): Promise<void> {
    if (this.#retirementTask !== undefined) return this.#retirementTask;
    return this.#disposeIdle();
  }

  #disposeIdle(): Promise<void> {
    if (this.#disposalTask !== undefined) return this.#disposalTask;
    try {
      const pending = this.#pendingWork();
      if (pending.groups || pending.native) {
        throw new ClaudeError("TIMEOUT", "Claude connection work has not settled; its owner must be retained.");
      }
      this.#retiring = true;
      // Publish the shared task before finalizers can reenter an outer edge.
      this.#disposalTask = Promise.resolve().then(() => this.#runtime.dispose());
      return this.#disposalTask;
    } catch (reason: unknown) {
      return Promise.reject(reason);
    }
  }
}
