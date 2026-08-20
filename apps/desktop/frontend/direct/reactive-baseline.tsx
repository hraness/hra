import {
  Profiler,
  StrictMode,
  useEffect,
  useSyncExternalStore,
  type ProfilerOnRenderCallback,
} from "react";
import { createRoot } from "react-dom/client";

import "../src/index.css";

import App from "../src/App";
import { selectPane } from "../src/features/chat/model";
import {
  type RuntimeShell,
  useRuntimeShellSelector,
} from "../src/runtime";
import {
  createHRADirectShellFactory,
  type HRADirectRuntime,
} from "./runtime";
import { manyChatPaneId } from "./scenarios";

interface ReactCounters {
  commits: number;
  effectCleanups: number;
  effectSetups: number;
  mountCommits: number;
  nestedUpdateCommits: number;
  rootRenderAttempts: number;
  unrelatedSelectionRenders: number;
  updateCommits: number;
}

interface ActiveRuntime {
  readonly runtime: HRADirectRuntime;
  readonly shell: RuntimeShell;
}

interface BaselineCheckpoint {
  readonly react: ReactCounters;
  readonly transport: TransportCounters;
  readonly startedAtMs: number;
}

interface TransportCounters {
  readonly blockedNetworkRequests: number;
  readonly cancelledScriptedEvents: number;
  readonly deliveredScriptedEvents: number;
  readonly eventListeners: number;
  readonly invocationCount: number;
  readonly pendingSnapshotTransfers: number;
  readonly remainingScriptedEvents: number;
  readonly snapshotReads: number;
}

const counters: ReactCounters = {
  commits: 0,
  effectCleanups: 0,
  effectSetups: 0,
  mountCommits: 0,
  nestedUpdateCommits: 0,
  rootRenderAttempts: 0,
  unrelatedSelectionRenders: 0,
  updateCommits: 0,
};
let active: ActiveRuntime | null = null;
let checkpoint: BaselineCheckpoint | null = null;
const activeShellListeners = new Set<() => void>();
const targetPaneId = manyChatPaneId(1);
const unrelatedPaneId = manyChatPaneId(2);
const targetPaneTitle = "Reactive baseline pane";

function getActiveShellSnapshot(): RuntimeShell | null {
  return active?.shell ?? null;
}

function subscribeActiveShell(listener: () => void): () => void {
  activeShellListeners.add(listener);
  return () => activeShellListeners.delete(listener);
}

function setActiveRuntime(next: ActiveRuntime | null): void {
  if (active === next) return;
  active = next;
  for (const listener of [...activeShellListeners]) listener();
}

function commandType(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || !("command" in payload)) {
    return "transport.continuation";
  }
  const command = payload.command;
  if (typeof command !== "object" || command === null || !("type" in command)) {
    return "transport.unknown";
  }
  return typeof command.type === "string" ? command.type : "transport.unknown";
}

function activeRequestCount(): number {
  if (active === null) return 0;
  const sampled = active.runtime.session.probe.snapshot();
  return sampled.ok ? sampled.value.activity.active : 0;
}

function reactCounters(): ReactCounters {
  return { ...counters };
}

function transportCounters(runtime: HRADirectRuntime): TransportCounters {
  const sample = runtime.harness.getSnapshot();
  return {
    blockedNetworkRequests: sample.blockedNetworkRequests,
    cancelledScriptedEvents: sample.cancelledScriptedEvents,
    deliveredScriptedEvents: sample.deliveredScriptedEvents,
    eventListeners: sample.eventListeners,
    invocationCount: sample.invocations.length,
    pendingSnapshotTransfers: sample.pendingSnapshotTransfers,
    remainingScriptedEvents: sample.remainingScriptedEvents,
    snapshotReads: sample.snapshotReads,
  };
}

function counterDelta<Counter extends Readonly<Record<keyof Counter, number>>>(
  current: Counter,
  previous: Counter,
): Counter {
  return Object.fromEntries(
    Object.keys(current).map((key) => [
      key,
      current[key as keyof Counter] - previous[key as keyof Counter],
    ]),
  ) as Counter;
}

function shellFactory(): RuntimeShell {
  let runtime: HRADirectRuntime | null = null;
  const base = createHRADirectShellFactory(
    { kind: "scenario", scenario: "chat-many-panes" },
    (created) => {
      runtime = created;
    },
  )();
  if (runtime === null) throw new Error("The Direct runtime factory did not publish its runtime.");
  const openedRuntime: HRADirectRuntime = runtime;
  let disposed = false;
  const shell: RuntimeShell = Object.freeze({
    getSnapshot: () => base.getSnapshot(),
    getState: () => base.getState(),
    subscribe: (listener: Parameters<RuntimeShell["subscribe"]>[0]) =>
      base.subscribe(listener),
    connect: () => base.connect(),
    reconnect: () => base.reconnect(),
    dispatch: (command: Parameters<RuntimeShell["dispatch"]>[0]) =>
      base.dispatch(command),
    dispatchTask: (command: Parameters<RuntimeShell["dispatchTask"]>[0]) =>
      base.dispatchTask(command),
    addProject: () => base.addProject(),
    selectFolderAccess: () => base.selectFolderAccess(),
    retryTransport: () => base.retryTransport(),
    subscribeTaskInvalidations: (
      listener: Parameters<RuntimeShell["subscribeTaskInvalidations"]>[0],
    ) => base.subscribeTaskInvalidations(listener),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      openedRuntime.dispose();
      if (active?.runtime === openedRuntime) setActiveRuntime(null);
    },
  });
  setActiveRuntime({ runtime: openedRuntime, shell });
  return shell;
}

function selectUnrelatedPane(
  shellState: ReturnType<RuntimeShell["getSnapshot"]>,
) {
  return selectPane(shellState, unrelatedPaneId);
}

function UnrelatedPaneSelection({ shell }: { readonly shell: RuntimeShell }) {
  useRuntimeShellSelector(shell, selectUnrelatedPane);
  counters.unrelatedSelectionRenders += 1;
  return null;
}

function ActiveRuntimeSelectionProbe() {
  const shell = useSyncExternalStore(
    subscribeActiveShell,
    getActiveShellSnapshot,
    getActiveShellSnapshot,
  );
  return shell === null ? null : <UnrelatedPaneSelection shell={shell} />;
}

function StrictModeLifecycleProbe() {
  useEffect(() => {
    counters.effectSetups += 1;
    return () => {
      counters.effectCleanups += 1;
    };
  }, []);
  return null;
}

function MeasuredApp() {
  counters.rootRenderAttempts += 1;
  return (
    <App runtimeShellFactory={shellFactory} />
  );
}

const onRender: ProfilerOnRenderCallback = (_id, phase) => {
  counters.commits += 1;
  switch (phase) {
    case "mount":
      counters.mountCommits += 1;
      return;
    case "nested-update":
      counters.nestedUpdateCommits += 1;
      return;
    case "update":
      counters.updateCommits += 1;
      return;
  }
};

function snapshot() {
  const transport = active?.runtime.harness.getSnapshot();
  return {
    activeRequests: activeRequestCount(),
    commits: counters.commits,
    effectCleanups: counters.effectCleanups,
    effectSetups: counters.effectSetups,
    invocationCount: transport?.invocations.length ?? 0,
    ready: active !== null,
    rootRenderAttempts: counters.rootRenderAttempts,
    snapshotReads: transport?.snapshotReads ?? 0,
    unrelatedSelectionRenders: counters.unrelatedSelectionRenders,
  };
}

async function begin() {
  if (active === null) throw new Error("The Direct runtime is not active.");
  if (checkpoint !== null) throw new Error("The reactive baseline already started.");
  const targetPane = selectPane(active.shell.getState(), targetPaneId);
  const unrelatedPane = selectPane(active.shell.getState(), unrelatedPaneId);
  if (targetPane === null) throw new Error("The reactive baseline target pane is unavailable.");
  if (unrelatedPane === null) throw new Error("The reactive baseline sibling pane is unavailable.");
  checkpoint = {
    react: reactCounters(),
    transport: transportCounters(active.runtime),
    startedAtMs: performance.now(),
  };
  const response = await active.shell.dispatch({
    type: "chat.pane.rename",
    paneId: targetPane.id,
    expectedRevision: targetPane.revision,
    title: targetPaneTitle,
  });
  if (!response.ok) throw new Error(response.error.message);
  if (response.result.type !== "chatPane" || response.result.pane.title !== targetPaneTitle) {
    throw new Error("The reactive baseline rename returned the wrong pane projection.");
  }
  const settledState = active.shell.getState();
  const settledTarget = selectPane(settledState, targetPaneId);
  const settledUnrelated = selectPane(settledState, unrelatedPaneId);
  if (
    settledTarget?.title !== targetPaneTitle
    || settledTarget.revision !== targetPane.revision + 1
  ) {
    throw new Error("The reactive baseline rename did not settle its target pane exactly once.");
  }
  if (settledUnrelated !== unrelatedPane) {
    throw new Error("The reactive baseline rename replaced its unrelated sibling projection.");
  }
  await Promise.resolve();
  return snapshot();
}

function finish() {
  if (active === null || checkpoint === null) {
    throw new Error("The reactive baseline has not started.");
  }
  const transport = active.runtime.harness.getSnapshot();
  const currentTransport = transportCounters(active.runtime);
  const currentReact = reactCounters();
  const transportDelta = counterDelta(currentTransport, checkpoint.transport);
  const reactDelta = counterDelta(currentReact, checkpoint.react);
  if (reactDelta.unrelatedSelectionRenders !== 0) {
    throw new Error(
      "A pane-local RuntimeShell revision rerendered an unrelated selected pane.",
    );
  }
  const invocations = transport.invocations.slice(checkpoint.transport.invocationCount);
  const requestTypes: Record<string, number> = {};
  for (const invocation of invocations) {
    const key = `${invocation.command}:${commandType(invocation.payload)}`;
    requestTypes[key] = (requestTypes[key] ?? 0) + 1;
  }
  if (
    invocations.length !== 1 ||
    Object.keys(requestTypes).length !== 1 ||
    requestTypes["hra.runtime.dispatch:chat.pane.rename"] !== 1
  ) {
    throw new Error(
      `A pane-local rename escaped its atomic transport scope: ${JSON.stringify(requestTypes)}`,
    );
  }
  return {
    workload: {
      affectedPaneId: targetPaneId,
      preservedSiblingPaneId: unrelatedPaneId,
      source: "runtime-shell-pane-rename",
    },
    directBridge: {
      requestCount: invocations.length,
      requestTypes,
      counters: transportDelta,
      lifecycleTotals: currentTransport,
    },
    react: {
      counters: reactDelta,
      lifecycleTotals: currentReact,
      profilerCommits: reactDelta.commits,
      rootBoundaryRenderAttempts: reactDelta.rootRenderAttempts,
      unrelatedSelectionRenders: reactDelta.unrelatedSelectionRenders,
      strictMode: true,
    },
    elapsedMs: performance.now() - checkpoint.startedAtMs,
  };
}

Object.defineProperty(window, "__hraReactiveBaseline", {
  configurable: false,
  enumerable: false,
  writable: false,
  value: Object.freeze({ begin, finish, snapshot }),
});

const rootElement = document.querySelector("#root");
if (rootElement === null) throw new Error("The reactive baseline root is missing.");

createRoot(rootElement).render(
  <StrictMode>
    <Profiler id="hra-product" onRender={onRender}>
      <StrictModeLifecycleProbe />
      <MeasuredApp />
      <ActiveRuntimeSelectionProbe />
    </Profiler>
  </StrictMode>,
);

declare global {
  interface Window {
    readonly __hraReactiveBaseline?: Readonly<{
      begin: () => unknown;
      finish: () => unknown;
      snapshot: () => unknown;
    }>;
  }
}
