import { expect, test } from "bun:test";

test("pane harness chrome is bounded to active subagent summaries", async () => {
  const paneSource = await Bun.file(
    new URL("../chat/ChatPane.tsx", import.meta.url),
  ).text();
  const compactSurfaceSource = await Bun.file(
    new URL("../chat/CompactChatSurface.tsx", import.meta.url),
  ).text();

  expect(paneSource).toContain("<ActiveSubagentStack");
  expect(paneSource).toContain("children={descendants?.children ?? []}");
  expect(paneSource).toContain("provider={turn?.providerSubagents");
  expect(compactSurfaceSource).toContain("const visible = visibleSubagents(children)");
  expect(compactSurfaceSource).toContain("{visible.map((child)");
  expect(compactSurfaceSource).toContain('data-subagent-source="hra"');
  expect(compactSurfaceSource).not.toMatch(
    /child\.canOpen|child\.canStop|HRAIcon name="open"/u,
  );
  expect(paneSource).not.toMatch(
    /harnessAttention|stopHarnessGoal|candidateId|treeRoot|history/iu,
  );
});
