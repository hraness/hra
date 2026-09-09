import { Deferred, Effect, Exit } from "effect";

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- This Claude daemon program composes the qualified provider connection programs and native ports.
import { ClaudeError } from "../claude/errors.ts";
import type { ClaudeStreamClient, ClaudeStreamInitialization } from "../claude/client.ts";
import type { ClaudeHostToolBindingLease } from "../claude/host-tool-bridge.ts";
import type { ClaudeProcess, ClaudeProcessIdentity } from "../claude/process.ts";
import type { ClaudeConnectionEffects } from "../claude/session-effects.ts";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- This Claude daemon program composes the qualified provider connection programs and native ports.
import { failureReason, taskFailure, type TaskGroup } from "../claude/session-model.ts";
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- This Claude daemon program composes the qualified provider connection programs and native ports.
import { attempt, forceNativeProcess, nativeCall, nativeInitializationIdentity, nativeMicrotask, nativeProcessExit, nativeTurn, observeWithin, type ClaudeOwnedTask, type ClaudeProgram } from "../claude/session-platform.ts";
import { ClaudeProcessExitUnprovenError } from "./ports.ts";

/** Exact custody, not a second work scheduler. Work lives in the connection's
 * named groups; these identities survive unsuccessful bounded cleanup. */
export interface ClaudeRuntimeConnection {
  readonly effects: ClaudeConnectionEffects;
  readonly providerThreadId: string;
  binding: ClaudeHostToolBindingLease | undefined;
  process: ClaudeProcess | undefined;
  client: ClaudeStreamClient | undefined;
  rawExit: ClaudeOwnedTask<number> | undefined;
  processExitProven: boolean;
  admitted: boolean;
  acquisitionSettled: boolean;
  cleanup: ClaudeOwnedTask<void> | undefined;
  bindingRevocation: ClaudeOwnedTask<void> | undefined;
  bindingCleanup: ClaudeOwnedTask<void> | undefined;
  admissionJoin: ClaudeOwnedTask<void> | undefined;
  retainedFailure: Readonly<{ reason: unknown }> | undefined;
}

export interface ClaudeRuntimeSessionWork {
  readonly client: ClaudeStreamClient;
  readonly connection: ClaudeRuntimeConnection;
  readonly hostToolBinding: ClaudeHostToolBindingLease | undefined;
  hostToolActivationTask: ClaudeOwnedTask<void> | undefined;
  hostToolRevocationTask: ClaudeOwnedTask<void> | undefined;
  hostToolState: "disabled" | "inactive" | "active" | "revoking" | "revoked";
}

/** Install the shared task before a native callback can synchronously reenter.
 * Child creation composes within the current interpreter. */
function sharedWork<A>(input: {
  readonly connection: ClaudeConnectionEffects;
  readonly group: TaskGroup;
  readonly get: () => ClaudeOwnedTask<A> | undefined;
  readonly set: (task: ClaudeOwnedTask<A> | undefined) => void;
  readonly program: () => ClaudeProgram<A>;
}): ClaudeProgram<A> {
  return Effect.gen(function* () {
    const existing = yield* attempt(input.get);
    if (existing !== undefined) return yield* existing.program;
    const start = yield* Deferred.make<void>();
    const task = yield* input.connection.fork(input.group,
      Effect.zipRight(Deferred.await(start), Effect.suspend(input.program)));
    yield* attempt(() => { input.set(task); });
    yield* Deferred.succeed(start, undefined);
    return yield* task.program.pipe(Effect.ensuring(Effect.sync(() => {
      if (input.get() === task) input.set(undefined);
    })));
  });
}

/** A bounded observer of a retained task. Timeout never interrupts the task
 * or clears its slot; retry observes the same native continuation. */
export function boundedClaudeWork(input: {
  readonly connection: ClaudeConnectionEffects;
  readonly get: () => ClaudeOwnedTask<void> | undefined;
  readonly set: (task: ClaudeOwnedTask<void> | undefined) => void;
  readonly program: () => ClaudeProgram<void>;
  readonly settlementMs: number;
  readonly message: string;
}): ClaudeProgram<void> {
  return Effect.gen(function* () {
    let task = input.get();
    if (task === undefined) {
      const start = yield* Deferred.make<void>();
      task = yield* input.connection.fork("control",
        Effect.zipRight(Deferred.await(start), Effect.suspend(input.program).pipe(
          Effect.catchAllCause(cause => Effect.zipRight(Effect.sync(() => {
            if (input.get() === task) input.set(undefined);
          }), Effect.failCause(cause))),
        )));
      input.set(task);
      yield* Deferred.succeed(start, undefined);
    }
    if (!(yield* observeWithin(task.promise, input.settlementMs))) {
      return yield* Effect.fail(taskFailure(new ClaudeError("TIMEOUT", input.message)));
    }
    const result = yield* Effect.exit(task.program);
    if (Exit.isFailure(result)) {
      if (input.get() === task) input.set(undefined);
      return yield* Effect.failCause(result.cause);
    }
  });
}

export function joinClaudeConnection(connection: ClaudeRuntimeConnection, settlementMs: number): ClaudeProgram<void> {
  return boundedClaudeWork({
    connection: connection.effects,
    get: () => connection.admissionJoin,
    set: task => { connection.admissionJoin = task; },
    program: () => Effect.gen(function* () {
      // Client cleanup invoked from admission cannot wait on admission itself.
      // This barrier is admitted only by the external manager close boundary.
      yield* connection.effects.join("admission");
      yield* connection.effects.join("writes");
      yield* connection.effects.join("capabilities");
      yield* connection.effects.join("manager-continuations");
    }),
    settlementMs,
    message: "Claude connection work has not settled; shutdown is incomplete and its exact owner is retained.",
  });
}

function revokeConnectionBinding(connection: ClaudeRuntimeConnection, revoke: () => Promise<void>): ClaudeProgram<void> {
  return sharedWork({
    connection: connection.effects, group: "capabilities",
    get: () => connection.bindingRevocation,
    set: task => { connection.bindingRevocation = task; },
    program: () => nativeCall(revoke),
  });
}

export function revokeUnboundClaudeBinding(input: {
  readonly connection: ClaudeRuntimeConnection;
  readonly binding: ClaudeHostToolBindingLease;
  readonly revoke: (bindingId: string) => Promise<void>;
  readonly released: () => void;
}): ClaudeProgram<void> {
  return Effect.gen(function* () {
    yield* revokeConnectionBinding(input.connection, () => input.revoke(input.binding.bindingId));
    yield* attempt(input.released);
    if (input.connection.binding === input.binding) input.connection.binding = undefined;
  });
}

export function closeUnboundClaudeClient(input: {
  readonly connection: ClaudeRuntimeConnection;
  readonly client: ClaudeStreamClient;
  readonly released: () => void;
}): ClaudeProgram<void> {
  return Effect.gen(function* () {
    yield* input.client.programs.close();
    input.connection.processExitProven = true;
    yield* attempt(input.released);
  });
}

export function closeUnboundClaudeProcess(connection: ClaudeRuntimeConnection, settlementMs: number): ClaudeProgram<void> {
  return Effect.gen(function* () {
    if (!(yield* closeRawProcess(connection, settlementMs))) {
      return yield* Effect.fail(taskFailure(new ClaudeProcessExitUnprovenError({
        cause: new ClaudeError("TIMEOUT", "Claude constructor-failure process exit remains unproven."),
      })));
    }
  });
}

export interface ClaudeAcquisitionPorts<Session> {
  readonly connection: ClaudeRuntimeConnection;
  readonly signal: AbortSignal;
  readonly initializationTimeoutMs: number;
  readonly rawProcessSettlementMs: number;
  readonly toolsRequired: boolean;
  readonly connectionId: () => string;
  readonly configDir: () => string | Promise<string>;
  readonly assertAuthority: () => void;
  readonly assertNoUnbound: (binding?: ClaudeHostToolBindingLease) => void;
  readonly provision: () => Promise<ClaudeHostToolBindingLease>;
  readonly retainBinding: (binding: ClaudeHostToolBindingLease) => void;
  readonly revokeBinding: (binding: ClaudeHostToolBindingLease) => Promise<void>;
  readonly releaseBinding: (binding: ClaudeHostToolBindingLease) => void;
  readonly spawn: (configDir: string, binding: ClaudeHostToolBindingLease | undefined) => ClaudeProcess;
  readonly construct: (process: ClaudeProcess, configDir: string, connectionId: string) => ClaudeStreamClient;
  readonly retainClient: (client: ClaudeStreamClient) => void;
  readonly releaseClient: (client: ClaudeStreamClient) => void;
  readonly parseIdentity: (identity: ClaudeProcessIdentity) => ClaudeProcessIdentity;
  readonly assertInitialization: (initialization: ClaudeStreamInitialization) => void;
  readonly assertBeforeCommit: (client: ClaudeStreamClient) => void;
  readonly commitIdentity: (identity: ClaudeProcessIdentity) => void | Promise<void>;
  readonly assertAfterCommit: (client: ClaudeStreamClient) => void;
  readonly publish: (input: {
    readonly client: ClaudeStreamClient;
    readonly binding: ClaudeHostToolBindingLease | undefined;
    readonly connectionId: string;
    readonly identity: ClaudeProcessIdentity;
  }) => Session;
  readonly finalize: () => void;
}

function closeRawProcess(connection: ClaudeRuntimeConnection, milliseconds: number): ClaudeProgram<boolean> {
  return Effect.gen(function* () {
    const process = connection.process;
    if (process === undefined) return true;
    // Signal failure never substitutes for observing this exact native exit.
    yield* Effect.exit(forceNativeProcess(process));
    if (connection.rawExit === undefined) {
      connection.rawExit = yield* connection.effects.fork("exit-watch", nativeProcessExit(process));
    }
    const proven = yield* observeWithin(connection.rawExit.promise, milliseconds, true);
    if (proven) connection.processExitProven = true;
    return proven;
  });
}

/** The whole acquisition continuation is admitted before its first native
 * call, including late leases and the cleanup of a failed constructor. */
export function acquireClaudeSession<Session>(ports: ClaudeAcquisitionPorts<Session>): ClaudeProgram<Session> {
  const connection = ports.connection;
  return Effect.gen(function* () {
    const acquired = yield* Effect.exit(Effect.gen(function* () {
      const connectionId = yield* attempt(ports.connectionId);
      const configDir = yield* nativeCall(ports.configDir);
      yield* attempt(ports.assertAuthority);
      yield* attempt(() => { ports.assertNoUnbound(); });
      if (ports.toolsRequired) {
        const binding = yield* nativeCall(ports.provision);
        connection.binding = binding;
        yield* attempt(() => { ports.retainBinding(binding); });
      }
      yield* attempt(ports.assertAuthority);
      yield* attempt(() => { ports.assertNoUnbound(connection.binding); });
      const process = yield* attempt(() => ports.spawn(configDir, connection.binding));
      connection.process = process;
      const client = yield* attempt(() => ports.construct(process, configDir, connectionId));
      connection.client = client;
      yield* attempt(() => { ports.retainClient(client); });
      // Borrowed construction is inert. Activation composes on this already
      // prepared owner; it cannot construct or invoke another interpreter.
      yield* client.programs.activate();
      const initializationHandle = yield* client.programs.initializationObservation({
        signal: ports.signal, timeoutMs: ports.initializationTimeoutMs,
      });
      // Keep native Promise.all's already-rejected and same-turn arbitration.
      const [initialization, identity] = yield* nativeInitializationIdentity(
        initializationHandle, process, ports.parseIdentity,
      );
      yield* attempt(() => { ports.assertInitialization(initialization); });
      yield* nativeMicrotask();
      yield* attempt(() => { ports.assertBeforeCommit(client); });
      yield* nativeCall(() => ports.commitIdentity(identity));
      yield* attempt(() => { ports.assertAfterCommit(client); });
      const session = yield* attempt(() => ports.publish({
        client, binding: connection.binding, connectionId, identity,
      }));
      connection.admitted = true;
      return session;
    }));
    if (Exit.isSuccess(acquired)) return acquired.value;
    const original = failureReason(acquired.cause);
    const failures: unknown[] = [];
    let processUnproven = false;
    if (connection.client !== undefined) {
      const client = connection.client;
      const cleanup = yield* Effect.exit(client.programs.close());
      if (Exit.isFailure(cleanup)) {
        processUnproven = true;
        failures.push(failureReason(cleanup.cause));
      } else {
        connection.processExitProven = true;
        yield* attempt(() => { ports.releaseClient(client); });
      }
    } else if (connection.process !== undefined) {
      processUnproven = !(yield* closeRawProcess(connection, ports.rawProcessSettlementMs));
    }
    if (connection.binding !== undefined) {
      const binding = connection.binding;
      const cleanup = yield* Effect.exit(revokeConnectionBinding(connection, () => ports.revokeBinding(binding)));
      if (Exit.isFailure(cleanup)) failures.push(failureReason(cleanup.cause));
      else {
        yield* attempt(() => { ports.releaseBinding(binding); });
        connection.binding = undefined;
      }
    }
    if (processUnproven) {
      const reason = new ClaudeProcessExitUnprovenError({
        cause: new AggregateError([original, ...failures], "Claude admission and cleanup both failed."),
      });
      connection.retainedFailure = { reason };
      return yield* Effect.fail(taskFailure(reason));
    }
    if (failures.length > 0) {
      const reason = new AggregateError(
        [original, ...failures], "Claude admission failed and its host-tool binding cleanup is unresolved.",
        { cause: original },
      );
      connection.retainedFailure = { reason };
      return yield* Effect.fail(taskFailure(reason));
    }
    return yield* Effect.fail(taskFailure(original));
  }).pipe(Effect.ensuring(Effect.sync(() => {
    connection.acquisitionSettled = true;
    ports.finalize();
  })));
}

export function revokeClaudeSessionTools(input: {
  readonly session: ClaudeRuntimeSessionWork;
  readonly revoke: (bindingId: string) => Promise<void>;
  readonly clearCalls: () => void;
}): ClaudeProgram<void> {
  return Effect.gen(function* () {
    const session = input.session;
    if (session.hostToolState === "revoked") return;
    return yield* sharedWork({
      connection: session.connection.effects, group: "capabilities",
      get: () => session.hostToolRevocationTask,
      set: task => { session.hostToolRevocationTask = task; },
      program: () => Effect.gen(function* () {
        session.hostToolState = "revoking";
        yield* attempt(input.clearCalls);
        const binding = session.hostToolBinding;
        if (binding !== undefined) yield* revokeConnectionBinding(session.connection, () => input.revoke(binding.bindingId));
        session.hostToolState = "revoked";
        session.connection.binding = undefined;
      }),
    });
  });
}

export function activateClaudeSessionTools(input: {
  readonly session: ClaudeRuntimeSessionWork;
  readonly signal: AbortSignal;
  readonly activate: (bindingId: string) => Promise<void>;
  readonly assertAuthority: () => void;
  readonly isCurrent: () => boolean;
  readonly revoke: () => ClaudeProgram<void>;
}): ClaudeProgram<void> {
  return Effect.gen(function* () {
    const session = input.session;
    if (session.hostToolState === "active") return;
    const binding = session.hostToolBinding;
    if (session.hostToolState === "disabled" || binding === undefined) {
      return yield* Effect.fail(taskFailure(new ClaudeError("AUTHORITY_STALE", "This legacy Claude session has no admitted host tools.")));
    }
    if (session.hostToolState === "revoked" || session.hostToolState === "revoking") {
      return yield* Effect.fail(taskFailure(new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding was revoked.")));
    }
    yield* sharedWork({
      connection: session.connection.effects, group: "capabilities",
      get: () => session.hostToolActivationTask,
      set: task => { session.hostToolActivationTask = task; },
      program: () => Effect.gen(function* () {
        yield* nativeCall(() => input.activate(binding.bindingId));
        if (input.signal.aborted) {
          yield* input.revoke();
          yield* attempt(() => { input.signal.throwIfAborted(); });
        }
        if (session.hostToolState !== "inactive" || !input.isCurrent()) {
          yield* input.revoke();
          return yield* Effect.fail(taskFailure(new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding activation became stale.")));
        }
        session.hostToolState = "active";
      }),
    });
    yield* attempt(input.assertAuthority);
  });
}

export function closeClaudeSession(input: {
  readonly session: ClaudeRuntimeSessionWork;
  readonly markClosing: () => void;
  readonly markFailed: () => void;
  readonly revoke: () => ClaudeProgram<void>;
  readonly released: () => void;
}): ClaudeProgram<void> {
  return Effect.gen(function* () {
    yield* attempt(input.markClosing);
    const [binding, process] = yield* Effect.all([
      Effect.exit(input.revoke()), Effect.exit(input.session.client.programs.close()),
    ], { concurrency: "unbounded" });
    const failures = [binding, process].flatMap(result => Exit.isFailure(result) ? [failureReason(result.cause)] : []);
    if (failures.length > 0) {
      yield* attempt(input.markFailed);
      if (Exit.isSuccess(binding) && Exit.isFailure(process)) return yield* Effect.failCause(process.cause);
      return yield* Effect.fail(taskFailure(new AggregateError(failures,
        "Claude session process or host-tool binding could not be joined; cleanup was incomplete.")));
    }
    input.session.connection.processExitProven = true;
    yield* attempt(input.released);
  });
}

/** Configuration checks precede a client operation on the same interpreter. */
export function withClaudeSessionConfig<A>(input: {
  readonly configDir: () => string | Promise<string>;
  readonly assert: (configDir: string) => void;
  readonly operation: () => ClaudeProgram<A>;
}): ClaudeProgram<A> {
  return Effect.gen(function* () {
    const configDir = yield* nativeCall(input.configDir);
    yield* attempt(() => { input.assert(configDir); });
    return yield* Effect.suspend(input.operation);
  });
}

/** Reserve response -> real later turn -> callback as one admitted program.
 * Diagnostic callback failure cannot replace the successful response result. */
export function resolveClaudeInteraction(input: {
  readonly connection: ClaudeConnectionEffects;
  readonly response: () => ClaudeProgram<unknown>;
  readonly report: () => ClaudeProgram<void>;
  readonly after: () => void;
}): ClaudeProgram<{ responseWritten: true }> {
  return Effect.gen(function* () {
    const written = yield* Deferred.make<boolean>();
    const notice = yield* input.connection.fork("manager-continuations", Effect.gen(function* () {
      if (!(yield* Deferred.await(written))) return;
      yield* nativeTurn();
      yield* Effect.exit(Effect.suspend(input.report));
    }));
    const response = yield* Effect.exit(Effect.suspend(input.response));
    yield* Deferred.succeed(written, Exit.isSuccess(response));
    if (Exit.isFailure(response)) {
      yield* notice.program;
      return yield* Effect.failCause(response.cause);
    }
    yield* attempt(input.after);
    return { responseWritten: true } as const;
  });
}

export function completeClaudeOperation<A, B>(operation: () => ClaudeProgram<A>, complete: (value: A) => B): ClaudeProgram<B> {
  return Effect.flatMap(Effect.suspend(operation), value => attempt(() => complete(value)));
}

export function admitClaudeFact(input: {
  readonly isAdmitted: () => boolean;
  readonly buffer: () => void;
  readonly consume: () => ClaudeProgram<void>;
}): ClaudeProgram<void> {
  return Effect.suspend(() => input.isAdmitted() ? input.consume() : attempt(input.buffer));
}

/** Domain projection stays in the adapter. This program owns revocation and
 * exact native observer settlement/precedence around those mutations. */
export function observeClaudeFact<Session>(input: {
  readonly select: () => Session | undefined;
  readonly prepare: (session: Session) => "disconnected" | "terminalError" | "ordinary";
  readonly revoke: (session: Session) => ClaudeProgram<void>;
  readonly finish: (session: Session) => void;
  readonly observer: (session: Session) => ClaudeProgram<void>;
}): ClaudeProgram<void> {
  return Effect.gen(function* () {
    const session = yield* attempt(input.select);
    if (session === undefined) return;
    const mode = yield* attempt(() => input.prepare(session));
    if (mode === "disconnected") {
      const revoked = yield* Effect.exit(input.revoke(session));
      yield* input.observer(session);
      if (Exit.isFailure(revoked)) {
        const reason = failureReason(revoked.cause);
        return yield* Effect.fail(taskFailure(reason instanceof Error ? reason
          : new ClaudeError("PROTOCOL_ERROR", "Claude host-tool revocation failed")));
      }
      return;
    }
    if (mode === "terminalError") yield* input.revoke(session);
    yield* attempt(() => { input.finish(session); });
    yield* input.observer(session);
  });
}

export function requireClaudeHostToolSession<Session, A>(input: {
  readonly select: () => Session;
  readonly isCurrent: (session: Session) => boolean;
  readonly closeStale: (session: Session) => ClaudeProgram<void>;
  readonly operation: (session: Session) => ClaudeProgram<A>;
}): ClaudeProgram<A> {
  return Effect.gen(function* () {
    const session = yield* attempt(input.select);
    if (!input.isCurrent(session)) {
      yield* input.closeStale(session);
      return yield* Effect.fail(taskFailure(new ClaudeError("AUTHORITY_STALE", "Claude host-tool account generation changed.")));
    }
    // The old async requireSession returned before caller-side admission.
    yield* nativeMicrotask();
    return yield* Effect.suspend(() => input.operation(session));
  });
}

export function callClaudeHostTool<Prepared, A>(input: {
  readonly connection: ClaudeConnectionEffects;
  readonly prepare: () => Prepared;
  readonly invoke: (prepared: Prepared) => A | Promise<A>;
  readonly failed?: (prepared: Prepared) => void;
  readonly complete?: (prepared: Prepared) => void;
}): ClaudeProgram<A> {
  return Effect.gen(function* () {
    const prepared = yield* attempt(input.prepare);
    const result = yield* Effect.exit(input.connection.callback(() => input.invoke(prepared)));
    if (Exit.isFailure(result)) {
      const failed = input.failed;
      if (failed !== undefined) yield* attempt(() => { failed(prepared); });
      return yield* Effect.failCause(result.cause);
    }
    const complete = input.complete;
    if (complete !== undefined) yield* attempt(() => { complete(prepared); });
    return result.value;
  });
}
