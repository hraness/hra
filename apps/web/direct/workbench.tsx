import {
  SCENARIO_QUERY_KEY,
} from "@hraness/direct";
import {
  Button,
  LinkButton,
  SearchField,
  SegmentedControl,
  ThemeMenuButton,
} from "@hra-internal/design-kit/react";
import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  AgentTasksDirectSurface,
  type AgentTasksDirectSession,
} from "./runtime";
import { mountAgentTasksDirect } from "./mount";
import {
  agentTasksDirectDefinition,
  agentTasksScenarioMetadata,
  type AgentTasksDirectViewport,
} from "./scenarios";

function frameOnly(): boolean {
  return typeof globalThis.location !== "undefined"
    && new URLSearchParams(globalThis.location.search).get("directFrame") === "1";
}

function scenarioUrl(id: string, onlyFrame = false): string {
  if (typeof globalThis.location === "undefined") return `/?${SCENARIO_QUERY_KEY}=${id}`;
  const url = new URL("/", globalThis.location.origin);
  url.searchParams.set(SCENARIO_QUERY_KEY, id);
  if (onlyFrame) url.searchParams.set("directFrame", "1");
  return url.toString();
}

function ProbeStatus({ session }: Readonly<{ session: AgentTasksDirectSession }>) {
  const snapshot = useSyncExternalStore(
    session.store.subscribe,
    session.store.getSnapshot,
    session.store.getSnapshot,
  );
  return (
    <span>
      {snapshot.activity.active === 0 ? "quiescent" : `${snapshot.activity.active} active`}
      {` · ${session.harness.getSnapshot().requests} requests`}
    </span>
  );
}

function Frame({
  children,
  session,
}: Readonly<{
  children: ReactNode;
  session: AgentTasksDirectSession;
}>) {
  const { activation } = session;
  const [viewport, setViewport] = useState<AgentTasksDirectViewport>(
    agentTasksScenarioMetadata[activation.scenario]?.viewport ?? "wide",
  );
  const [query, setQuery] = useState("");
  const onlyFrame = frameOnly();
  const dimensions = viewport === "wide"
    ? { width: 1_440, height: 1_000 }
    : viewport === "stacked"
      ? { width: 820, height: 1_000 }
      : { width: 390, height: 844 };
  if (onlyFrame) {
    return (
      <div
        aria-label={`Direct ready: ${activation.scenario}`}
        className="direct-frame-only"
        data-agent-tasks-direct={activation.scenario}
      >
        {children}
      </div>
    );
  }

  const normalized = query.trim().toLowerCase();
  const scenarios = agentTasksDirectDefinition.scenarios.list().filter((scenario) => (
    normalized.length === 0
    || scenario.id.includes(normalized)
    || scenario.title.toLowerCase().includes(normalized)
    || scenario.description?.toLowerCase().includes(normalized)
  ));
  const selected = agentTasksDirectDefinition.scenarios.get(activation.scenario);

  return (
    <div
      aria-label={`Direct ready: ${activation.scenario}`}
      className="direct-workbench"
      data-agent-tasks-direct={activation.scenario}
    >
      <aside className="direct-sidebar">
        <header>
          <p>HRA · Direct</p>
          <h1>Agent Tasks lab</h1>
          <span>Real task UI. Deterministic workspace port. Zero provider credentials.</span>
        </header>
        <SearchField
          className="direct-search"
          label="Search scenarios"
          onChange={setQuery}
          placeholder="Search scenarios"
          size="compact"
          value={query}
        />
        <nav aria-label="Direct scenarios">
          {scenarios.map((scenario) => {
            const active = scenario.id === activation.scenario;
            return (
              <a
                aria-current={active ? "page" : undefined}
                data-active={active || undefined}
                href={scenarioUrl(scenario.id)}
                key={scenario.id}
              >
                <small>{agentTasksScenarioMetadata[scenario.id]?.group ?? "Queues"}</small>
                <strong>{scenario.title}</strong>
                <span>{scenario.description}</span>
              </a>
            );
          })}
        </nav>
      </aside>
      <main className="direct-stage">
        <header className="direct-toolbar">
          <div>
            <strong>{selected?.title ?? activation.scenario}</strong>
            <span>{activation.scenario} · Agent Tasks world v{activation.world.version}</span>
          </div>
          <div className="direct-probe"><ProbeStatus session={session} /></div>
          <div className="direct-actions">
            <SegmentedControl
              aria-label="Preview viewport"
              className="direct-viewport"
              items={(["compact", "stacked", "wide"] as const).map((candidate) => ({
                id: candidate,
                label: candidate,
              }))}
              onChange={setViewport}
              size="compact"
              value={viewport}
            />
            <LinkButton href={scenarioUrl(activation.scenario, true)} size="compact" target="_blank" variant="quiet">open frame</LinkButton>
            <Button onPress={() => globalThis.location?.reload()} size="compact" variant="quiet">reset</Button>
            <ThemeMenuButton />
          </div>
        </header>
        <div className="direct-scroll">
          <div className="direct-desktop" style={dimensions}>{children}</div>
        </div>
      </main>
    </div>
  );
}

function ActiveWorkbench({ session }: Readonly<{ session: AgentTasksDirectSession }>) {
  return (
    <Frame session={session}>
      <AgentTasksDirectSurface session={session} />
    </Frame>
  );
}

export function AgentTasksDirectWorkbench({
  source,
}: Readonly<{
  source: string;
}>) {
  const [state, setState] = useState<
    | Readonly<{ kind: "starting" }>
    | Readonly<{ kind: "error"; message: string; source: string }>
    | Readonly<{ kind: "active"; session: AgentTasksDirectSession; source: string }>
  >({ kind: "starting" });

  useLayoutEffect(() => {
    let current = true;
    const mounted = mountAgentTasksDirect({ kind: "query", source });
    queueMicrotask(() => {
      if (!current) return;
      setState(mounted.ok
        ? { kind: "active", session: mounted.value.session, source }
        : { kind: "error", message: mounted.error.message, source });
    });
    return () => {
      current = false;
      if (mounted.ok) mounted.value.dispose();
    };
  }, [source]);

  if (state.kind === "error" && state.source === source) {
    return (
      <main className="direct-error" role="alert">
        <p>HRA · Direct</p>
        <h1>Activation failed</h1>
        <code>{state.message}</code>
      </main>
    );
  }
  if (state.kind !== "active" || state.source !== source) {
    return <main aria-label="Direct starting" className="direct-error" />;
  }
  return <ActiveWorkbench session={state.session} />;
}
