import {
  createDirectSession,
  type DirectSession,
  type DirectSessionActivation,
  type DirectSessionContext,
} from "@hraness/direct/testing";
import { installDirectBrowser } from "@hraness/direct/web";

import { createRuntimeBridge } from "../src/runtime-bridge";
import { createRuntimeShell, type RuntimeShell } from "../src/runtime";
import {
  hraDirectDefinition,
  type HRADirectRoute,
} from "./scenarios";
import {
  createHRADirectSessionTransport,
  type HRADirectTransportHarness,
} from "./transport";
import type { HRADirectWorld } from "./world";

export interface HRADirectRuntimeHarness {
  readonly shell: RuntimeShell;
  readonly transport: HRADirectTransportHarness;
}

export type HRADirectSession = DirectSession<
  HRADirectWorld,
  HRADirectRoute,
  HRADirectRuntimeHarness
>;

export interface HRADirectRuntime {
  readonly dispose: () => undefined;
  readonly harness: HRADirectTransportHarness;
  readonly session: HRADirectSession;
  readonly shell: RuntimeShell;
}

export interface HRADirectBrowserOptions {
  readonly reset?: () => undefined;
  readonly target?: object;
}

function createRuntimeHarness(
  context: DirectSessionContext<HRADirectWorld, HRADirectRoute>,
): HRADirectRuntimeHarness {
  const transport = createHRADirectSessionTransport(context);
  const bridge = createRuntimeBridge(transport.transport, {
    createOperationId: () => {
      const logicalId = context.clock.nextOperationId("bridge");
      return `op_${String(logicalId).replaceAll("-", "")}`;
    },
  });
  const shell = createRuntimeShell(bridge);
  context.onDispose((): undefined => {
    shell.dispose();
    return undefined;
  });
  return Object.freeze({ shell, transport });
}

/** Open the canonical definition-owned session used by the desktop workbench. */
export function createHRADirectSession(
  activation: DirectSessionActivation,
) {
  return createDirectSession({
    definition: hraDirectDefinition,
    activation,
    create: createRuntimeHarness,
    observe: ({ transport }) => ({
      violations: [
        {
          name: "blockedNetworkRequests",
          read: () => transport.getSnapshot().blockedNetworkRequests,
        },
        {
          name: "eventScriptFailures",
          read: () => transport.getSnapshot().eventScriptFailures.length,
        },
      ],
      readRemainingWork: () => ({
        cancelledScriptedEvents: transport.getSnapshot().cancelledScriptedEvents,
        disposed: transport.getSnapshot().disposed,
        pendingSnapshotTransfers: transport.getSnapshot().pendingSnapshotTransfers,
        scriptedEvents: transport.getSnapshot().remainingScriptedEvents,
        snapshotReads: transport.getSnapshot().snapshotReads,
      }),
    }),
  });
}

function managedShell(base: RuntimeShell, session: HRADirectSession): RuntimeShell {
  const shell: RuntimeShell = {
    getSnapshot: () => base.getSnapshot(),
    getState: () => base.getState(),
    subscribe: (listener) => base.subscribe(listener),
    connect: () => base.connect(),
    reconnect: () => base.reconnect(),
    dispatch: (command) => base.dispatch(command),
    dispatchTask: (command) => base.dispatchTask(command),
    addProject: () => base.addProject(),
    retryTransport: () => base.retryTransport(),
    subscribeTaskInvalidations: (listener) => base.subscribeTaskInvalidations(listener),
    dispose: () => session.dispose(),
  };
  return Object.freeze(shell);
}

/** Convenience wrapper for product tests and the Strict Mode shell factory. */
export function createHRADirectRuntime(
  activation: DirectSessionActivation,
): HRADirectRuntime {
  const opened = createHRADirectSession(activation);
  if (!opened.ok) throw new Error(opened.error.message, { cause: opened.error });
  const session = opened.value;
  return Object.freeze({
    dispose: session.dispose,
    harness: session.harness.transport,
    session,
    shell: managedShell(session.harness.shell, session),
  });
}

/**
 * Install both browser boundaries before the product receives a shell it can
 * connect. A failed installation closes the whole runtime rather than leaving
 * an uncontained deterministic transport alive.
 */
export function installHRADirectBrowser(
  runtime: HRADirectRuntime,
  options: HRADirectBrowserOptions = {},
): void {
  const installed = installDirectBrowser({
    session: runtime.session,
    reset: options.reset ?? (() => {
      globalThis.location?.reload();
      return undefined;
    }),
    firewall: { onBlocked: runtime.harness.recordBlockedNetworkRequest },
    ...(options.target === undefined ? {} : { target: options.target }),
  });
  if (installed.ok) return;
  runtime.dispose();
  throw new Error(installed.error.message, { cause: installed.error });
}

export function createHRADirectShellFactory(
  activation: DirectSessionActivation,
  onRuntime: (runtime: HRADirectRuntime) => void = () => undefined,
  browserOptions: HRADirectBrowserOptions = {},
): () => RuntimeShell {
  return () => {
    const runtime = createHRADirectRuntime(activation);
    try {
      installHRADirectBrowser(runtime, browserOptions);
      onRuntime(runtime);
    } catch (reason) {
      runtime.dispose();
      throw reason;
    }
    return runtime.shell;
  };
}
