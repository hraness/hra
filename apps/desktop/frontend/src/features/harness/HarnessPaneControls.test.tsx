import { expect, test } from "bun:test";

test("pane harness chrome is bounded to descendants with Open and Stop icon buttons", async () => {
  const source = await Bun.file(
    new URL("../chat/ChatPane.tsx", import.meta.url),
  ).text();

  expect(source).toContain("descendants.children.map((child)");
  expect(source).toContain("<HRAIcon name=\"open\" />");
  expect(source).toContain("<HRAIcon name=\"stop\" />");
  expect(source).toContain("!child.canOpen");
  expect(source).toContain("!child.canStop");
  expect(source).not.toMatch(/harnessAttention|stopHarnessGoal|candidateId|treeRoot|history/iu);
});
