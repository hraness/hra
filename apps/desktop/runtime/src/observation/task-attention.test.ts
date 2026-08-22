import { describe, expect, test } from "bun:test";

import type { WorkspaceSummary } from "@hraness/agent-tasks-protocol";

import { CloudWorkspaceSummaryCache } from "../cloud/workspace-summary-cache";
import { readScopedTaskAttention } from "./task-attention";

function workspace(
  id: string,
  name: string,
  revision = 1,
): WorkspaceSummary {
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    keyPrefix: "HRA",
    revision,
    authority: {
      kind: "local",
      localWorkspaceId: id,
      ownerInstallationId: "install_attention0001",
    },
    counts: {
      all: { value: 1, capped: false },
      ready: { value: 0, capped: false },
      blocked: { value: 0, capped: false },
      deferred: { value: 0, capped: false },
      attention: { value: 1, capped: false },
      assigned: { value: 0, capped: false },
      review: { value: 0, capped: false },
    },
  };
}

describe("scoped task attention adapter", () => {
  test("discards a delayed cloud response after the human identity scope changes", async () => {
    const scopeA = { generation: 1, userId: "user-a" };
    const scopeB = { generation: 2, userId: "user-b" };
    let currentScope = scopeA;
    let resolveCloud!: (value: {
      ok: true;
      data: { workspaces: readonly WorkspaceSummary[]; cursor: null };
    }) => void;
    const cloudResult = new Promise<{
      ok: true;
      data: { workspaces: readonly WorkspaceSummary[]; cursor: null };
    }>((resolve) => { resolveCloud = resolve; });
    let replacements = 0;
    const local = workspace("wsp_local0000000000000000000000", "Local");
    const cloudA = workspace("wsp_clouda00000000000000000000", "Cloud A");

    const reading = readScopedTaskAttention({
      signal: new AbortController().signal,
      readLocal: () => [local],
      client: { listWorkspaces: async () => await cloudResult },
      scope: scopeA,
      isScopeCurrent: (scope) => scope === currentScope,
      readCached: (scope) => scope === scopeB
        ? [workspace("wsp_cloudb00000000000000000000", "Cloud B")]
        : [],
      beginFirstPageReplacement: () => ({ ordinal: 1 }),
      replaceFirstPage: () => {
        replacements += 1;
        return true;
      },
    });
    currentScope = scopeB;
    resolveCloud({ ok: true, data: { workspaces: [cloudA], cursor: null } });

    expect(await reading).toEqual({
      completeness: "cloud_unavailable",
      workspaces: [local],
    });
    expect(replacements).toBe(0);
  });

  test("reports local task authority failure without relabeling it as cloud failure", async () => {
    expect(await readScopedTaskAttention({
      signal: new AbortController().signal,
      readLocal: () => { throw new Error("local SQLite read failed"); },
      client: null,
      scope: null,
      isScopeCurrent: () => false,
      readCached: () => [],
      beginFirstPageReplacement: () => null,
      replaceFirstPage: () => false,
    })).toEqual({
      completeness: "task_authority_unavailable",
      workspaces: [],
    });
  });

  test("uses only the current scope cache after a cloud failure", async () => {
    const scope = { generation: 3, userId: "current" };
    const local = workspace("wsp_local0000000000000000000000", "Local");
    const cached = workspace("wsp_cached000000000000000000000", "Cached");
    expect(await readScopedTaskAttention({
      signal: new AbortController().signal,
      readLocal: () => [local],
      client: { listWorkspaces: () => Promise.reject(new Error("offline")) },
      scope,
      isScopeCurrent: (candidate) => candidate === scope,
      readCached: () => [cached],
      beginFirstPageReplacement: () => ({ ordinal: 1 }),
      replaceFirstPage: () => true,
    })).toEqual({
      completeness: "cloud_unavailable",
      workspaces: [cached, local],
    });
  });

  test("does not re-expose a workspace omitted by a successful first page", async () => {
    const scope = {
      credentialGeneration: 1,
      organizationId: "org_attention",
      userId: "user_attention",
    };
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: () => undefined,
    });
    cache.replaceScope(scope);
    const retained = workspace("wsp_retained0000000000000000000", "Retained", 1);
    const revoked = workspace("wsp_revoked00000000000000000000", "Revoked", 1);
    cache.remember(scope, retained);
    cache.remember(scope, revoked);
    const options = {
      signal: new AbortController().signal,
      readLocal: () => [],
      scope,
      isScopeCurrent: (candidate: typeof scope) => cache.isCurrent(candidate),
      readCached: (candidate: typeof scope) => cache.summaries(candidate),
      beginFirstPageReplacement: (candidate: typeof scope) =>
        cache.beginFirstPageReplacement(candidate),
      replaceFirstPage: (
        replacement: NonNullable<ReturnType<typeof cache.beginFirstPageReplacement>>,
        workspaces: readonly WorkspaceSummary[],
      ) => cache.replaceFirstPage(replacement, workspaces),
    };
    const retainedRevisionTwo = { ...retained, revision: 2 };
    const refreshed = await readScopedTaskAttention({
      ...options,
      client: {
        listWorkspaces: () => Promise.resolve({
          ok: true as const,
          data: { workspaces: [retainedRevisionTwo], cursor: null },
        }),
      },
    });
    expect(refreshed.workspaces).toEqual([retainedRevisionTwo]);

    const partial = await readScopedTaskAttention({
      ...options,
      client: { listWorkspaces: () => Promise.reject(new Error("offline")) },
    });
    expect(partial.completeness).toBe("cloud_unavailable");
    expect(partial.workspaces).toEqual([retainedRevisionTwo]);
    expect(partial.workspaces.some(({ id }) => id === revoked.id)).toBeFalse();
  });
});
