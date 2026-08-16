import { expect, test } from "bun:test";

test("the hosted React adapter owns each source-client pair in its effect", async () => {
  const source = await Bun.file(
    new URL("./convex-task-workspace-adapter.tsx", import.meta.url),
  ).text();

  expect(source).toContain("createHostedTaskWorkspaceSource");
  expect(source).toContain("createTaskWorkspaceClient");
  expect(source).toContain("createTaskWorkspaceClientHost");
  expect(source).toContain("TaskWorkspaceClientView");
  expect(source).toContain("const host = useMemo(");

  const effectStart = source.indexOf("useEffect(() => {");
  const effectEnd = source.indexOf("}, [convex, host, workspaceId]);");
  expect(effectStart).toBeGreaterThan(-1);
  expect(effectEnd).toBeGreaterThan(effectStart);
  const effect = source.slice(effectStart, effectEnd);
  expect(effect).toContain("createHostedTaskWorkspaceSource");
  expect(effect).toContain("createTaskWorkspaceClient");
  expect(effect).toContain("host.install(client)");
  expect(effect).toContain("uninstall()");
  expect(effect).toContain("source.dispose()");

  expect(source).toContain("<TaskWorkspaceClientView client={host.client} />");
  expect(source).not.toContain("useSyncExternalStore");
  expect(source).not.toContain("presentationStore");
  expect(source).not.toContain("source.retry");
  expect(source).not.toContain("presentation={");
  expect(source).not.toContain("useQuery");
  expect(source).not.toContain("ConvexTaskPageSubscription");
  expect(source).not.toContain("TaskWorkspaceActions");
});
