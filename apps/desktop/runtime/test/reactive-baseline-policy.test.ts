import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const baselinePath = fileURLToPath(new URL("../reactive-baseline.ts", import.meta.url));
const rendererBaselinePath = fileURLToPath(new URL(
  "../../frontend/direct/reactive-baseline.tsx",
  import.meta.url,
));

test("reactive baseline delegates browser process ownership to Playwright", async () => {
  const source = await readFile(baselinePath, "utf8");

  for (const forbidden of [
    "process.kill(",
    "browser.pid",
    "/bin/ps",
    "/usr/bin/pgrep",
    "browser-launcher",
  ]) {
    expect(source).not.toContain(forbidden);
  }

  expect(source).toContain('chromium.launchPersistentContext("", {');
  expect(source).toContain("executablePath: systemChromePath");
  expect(source).toContain('process.exit(signal === "SIGINT" ? 130 : 143)');

  const launch = source.indexOf("const contextLaunch = chromium.launchPersistentContext");
  const registerCloser = source.indexOf("closeContext = trackResourceCloser", launch);
  const acquireContext = source.indexOf("context = await contextLaunch", registerCloser);
  expect(launch).toBeGreaterThanOrEqual(0);
  expect(registerCloser).toBeGreaterThan(launch);
  expect(acquireContext).toBeGreaterThan(registerCloser);
});

test("reactive baseline does not substitute one selector probe for all-component instrumentation", async () => {
  const source = await readFile(baselinePath, "utf8");

  expect(source).toContain(
    '"renderer.react_component_render_count": unsupported(',
  );
  expect(source).toContain(
    '"renderer.react_unrelated_selector_probe_render_count": projectStage(',
  );
  expect(source).toContain('component: "UnrelatedPaneSelection"');
  expect(source).toContain('selector: "selectPane(unrelatedPaneId)"');
  expect(source).toContain(
    'environment: "development-only Direct baseline probe"',
  );
});

test("reactive baseline measures the current pane surface and a pane-local update", async () => {
  const [runnerSource, rendererSource] = await Promise.all([
    readFile(baselinePath, "utf8"),
    readFile(rendererBaselinePath, "utf8"),
  ]);

  expect(runnerSource).toContain('const BASELINE_SCHEMA = "hra.reactive-baseline/v7"');
  expect(runnerSource).toContain(
    'const repositoryRoot = resolve(desktopRoot, "../..");',
  );
  expect(runnerSource).toContain('join(temporaryRoot, "hra-gateway")');
  expect(runnerSource).toContain('cwd: "/tmp/hra-reactive-baseline"');
  expect(runnerSource).toContain('"__hraReactiveBaseline"');
  expect(runnerSource).toContain('"__hraReactiveBaselineQuiet"');
  expect(runnerSource).toContain('"hra-reactive-baseline-"');
  expect(runnerSource).not.toMatch(
    /oprte(?:\.reactive-baseline|ReactiveBaseline|-reactive-baseline|-gateway)/u,
  );
  expect(rendererSource).toContain('window, "__hraReactiveBaseline"');
  expect(runnerSource).toContain('page.locator(".chat-pane").first()');
  expect(runnerSource).not.toContain("[data-task-key]");
  expect(runnerSource).not.toContain('new Database(":memory:"');
  expect(runnerSource).toContain('"PRAGMA journal_mode = WAL"');
  expect(runnerSource).toContain('"PRAGMA synchronous = FULL"');
  expect(runnerSource).toContain(
    'elapsedMeasurement: "owned file-backed SQLite WAL with synchronous FULL"',
  );
  expect(rendererSource).toContain('scenario: "chat-many-panes"');
  expect(rendererSource).toContain('type: "chat.pane.rename"');
  expect(rendererSource).toContain("selectPane(shellState, unrelatedPaneId)");
  expect(rendererSource).toContain("settledUnrelated !== unrelatedPane");
  expect(rendererSource).not.toContain("createOPRTETaskTransportFixtureActivation");
  expect(rendererSource).not.toContain("emitTaskStateInvalidation");
});
