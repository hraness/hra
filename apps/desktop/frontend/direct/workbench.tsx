import {
  SCENARIO_QUERY_KEY,
  type ActiveDirect,
  type QueryError,
} from "@hraness/direct";
import {
  Button,
  LinkButton,
  SearchField,
  SegmentedControl,
  type SegmentedItem,
} from "@hra-internal/design-kit/react";
import {
  useCallback,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import App from "../src/App";
import {
  createHRADirectShellFactory,
  type HRADirectRuntime,
} from "./runtime";
import {
  getHRAScenarioMetadata,
  hraDirectDefinition,
  type HRADirectRoute,
  type HRADirectViewport,
} from "./scenarios";
import type { HRADirectWorld } from "./world";

type ActivationResult =
  | { readonly ok: true; readonly value: ActiveDirect<HRADirectWorld, HRADirectRoute> }
  | { readonly ok: false; readonly error: QueryError };

const viewportItems = [
  { id: "compact", label: "compact" },
  { id: "wide", label: "wide" },
] satisfies readonly SegmentedItem<HRADirectViewport>[];

function activationFor(search: string): ActivationResult {
  return hraDirectDefinition.activate(search);
}

function currentSearch(): string {
  return typeof globalThis.location === "undefined" ? "" : globalThis.location.search;
}

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

function ProbeStatus({ runtime }: { readonly runtime: HRADirectRuntime | null }) {
  const storeSnapshot = useSyncExternalStore(
    runtime?.session.store.subscribe ?? (() => () => undefined),
    runtime?.session.store.getSnapshot ?? (() => null),
    runtime?.session.store.getSnapshot ?? (() => null),
  );
  if (storeSnapshot === null) return <span>shell pending</span>;
  return (
    <span>
      {storeSnapshot.activity.active === 0 ? "quiescent" : `${storeSnapshot.activity.active} active`}
      {` · ${runtime?.harness.getSnapshot().snapshotReads ?? 0} snapshots`}
    </span>
  );
}

function IsolatedApp({
  activationSource,
  onRuntime,
}: {
  readonly activationSource: string;
  readonly onRuntime: (runtime: HRADirectRuntime) => void;
}) {
  const runtimeShellFactory = useMemo(
    () => createHRADirectShellFactory({
      kind: "query",
      source: activationSource,
    }, onRuntime),
    [activationSource, onRuntime],
  );
  return <App runtimeShellFactory={runtimeShellFactory} />;
}

function Frame({
  activation,
  children,
  runtime,
}: {
  readonly activation: ActiveDirect<HRADirectWorld, HRADirectRoute>;
  readonly children: ReactNode;
  readonly runtime: HRADirectRuntime | null;
}) {
  const [viewport, setViewport] = useState<HRADirectViewport>(
    getHRAScenarioMetadata(activation.scenario)?.viewport ?? "wide",
  );
  const [query, setQuery] = useState("");
  const onlyFrame = frameOnly();
  const dimensions = viewport === "wide"
    ? { width: 1_120, height: 720 }
    : { width: 720, height: 640 };

  if (onlyFrame) {
    return (
      <div
        aria-label={`Direct ready: ${activation.scenario}`}
        className="direct-frame-only"
        data-direct-scenario={activation.scenario}
      >
        {children}
      </div>
    );
  }

  const normalized = query.trim().toLowerCase();
  const scenarios = hraDirectDefinition.scenarios.list().filter((scenario) => (
    normalized.length === 0
    || scenario.id.includes(normalized)
    || scenario.title.toLowerCase().includes(normalized)
    || scenario.description?.toLowerCase().includes(normalized)
  ));
  const selected = hraDirectDefinition.scenarios.get(activation.scenario);

  return (
    <div
      aria-label={`Direct ready: ${activation.scenario}`}
      className="direct-workbench"
      data-direct-scenario={activation.scenario}
    >
      <aside className="direct-sidebar">
        <header>
          <p>HRA · Direct</p>
          <h1>HRA UI lab</h1>
          <span>Real renderer. Deterministic native seam. Zero credentials.</span>
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
                <small>{getHRAScenarioMetadata(scenario.id)?.group ?? "Gateway"}</small>
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
            <span>{activation.scenario} · protocol fixture v{activation.world.version}</span>
          </div>
          <div className="direct-probe"><ProbeStatus runtime={runtime} /></div>
          <div className="direct-actions">
            <SegmentedControl
              aria-label="Preview viewport"
              items={viewportItems}
              onChange={setViewport}
              size="compact"
              value={viewport}
            />
            <LinkButton href={scenarioUrl(activation.scenario, true)} size="compact" target="_blank">
              open frame
            </LinkButton>
            <Button onPress={() => globalThis.location?.reload()} size="compact" variant="secondary">
              reset
            </Button>
          </div>
        </header>
        <div className="direct-scroll">
          <div
            className="direct-desktop"
            style={{ height: dimensions.height, width: dimensions.width }}
          >
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}

export function HRADirectWorkbench() {
  const [activationSource] = useState(currentSearch);
  const [activationResult] = useState(() => activationFor(activationSource));
  const [runtime, setRuntime] = useState<HRADirectRuntime | null>(null);
  const onRuntime = useCallback((next: HRADirectRuntime) => setRuntime(next), []);

  if (!activationResult.ok) {
    return (
      <main className="direct-error" role="alert">
        <p>HRA · Direct</p>
        <h1>Activation failed</h1>
        <code>{activationResult.error.message}</code>
      </main>
    );
  }

  const activation = activationResult.value;
  return (
    <Frame activation={activation} runtime={runtime}>
      <IsolatedApp
        activationSource={activationSource}
        onRuntime={onRuntime}
      />
    </Frame>
  );
}
