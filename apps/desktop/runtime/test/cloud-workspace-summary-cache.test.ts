import { describe, expect, test } from "bun:test";
import {
  type PortableInvalidation,
  type WorkspaceSummary,
} from "@hraness/agent-tasks-protocol";

import {
  CloudWorkspaceSummaryCache,
  type CloudWorkspaceSummaryScope,
} from "../src/cloud/workspace-summary-cache";

const SCOPE_A: CloudWorkspaceSummaryScope = {
  credentialGeneration: 3,
  organizationId: "org_alpha",
  userId: "user_alpha",
};
const SCOPE_B: CloudWorkspaceSummaryScope = {
  credentialGeneration: 4,
  organizationId: "org_beta",
  userId: "user_alpha",
};

function workspace(
  suffix: string,
  name: string,
  revision: number,
): WorkspaceSummary {
  const id = `wsp_${suffix.padStart(26, "0")}`;
  return {
    id,
    name,
    slug: name.toLowerCase().replaceAll(" ", "-"),
    keyPrefix: "KIT",
    revision,
    authority: {
      kind: "cloud",
      cloudWorkspaceId: id,
    },
    counts: {
      all: { capped: false, value: 0 },
      ready: { capped: false, value: 0 },
      blocked: { capped: false, value: 0 },
      deferred: { capped: false, value: 0 },
      attention: { capped: false, value: 0 },
      assigned: { capped: false, value: 0 },
      review: { capped: false, value: 0 },
    },
  };
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) throw new Error("deferred is unavailable");
      resolvePromise(value);
    },
  };
}

function success(workspaces: WorkspaceSummary[]) {
  return {
    ok: true as const,
    data: {
      workspaces,
      cursor: null,
    },
  };
}

describe("cloud workspace summary cache", () => {
  test("closed admission joins a detached refresh and rejects later refreshes", async () => {
    const scope = SCOPE_A;
    let refreshEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      refreshEntered = resolve;
    });
    let releaseRefresh = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let calls = 0;
    const client = {
      listWorkspaces: async () => {
        calls += 1;
        refreshEntered();
        await released;
        return success([workspace("joined", "Joined cloud", 1)]);
      },
    };
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: () => undefined,
    });
    cache.replaceScope(scope);
    const refresh = cache.refresh(scope, client);
    await entered;
    cache.closeAdmission();
    const settlement = cache.settled();
    expect(await Promise.race([
      settlement.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5)),
    ])).toBe("blocked");

    releaseRefresh();
    await Promise.all([refresh, settlement]);
    expect(calls).toBe(1);
    await cache.refresh(scope, client);
    expect(calls).toBe(1);
  });

  test("settlement joins every refresh admitted across scope replacement", async () => {
    const first = deferred<ReturnType<typeof success>>();
    const second = deferred<ReturnType<typeof success>>();
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: () => undefined,
    });
    cache.replaceScope(SCOPE_A);
    const firstRefresh = cache.refresh(SCOPE_A, {
      listWorkspaces: () => first.promise,
    });
    cache.replaceScope(SCOPE_B);
    const secondRefresh = cache.refresh(SCOPE_B, {
      listWorkspaces: () => second.promise,
    });

    cache.closeAdmission();
    const settlement = cache.settled();
    first.resolve(success([workspace("first", "First scope", 1)]));
    await firstRefresh;
    expect(await Promise.race([
      settlement.then(() => "settled" as const),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 5)
      ),
    ])).toBe("blocked");

    second.resolve(success([workspace("second", "Second scope", 2)]));
    await Promise.all([secondRefresh, settlement]);
    expect(cache.summaries(SCOPE_B).map(({ name }) => name)).toEqual([
      "Second scope",
    ]);
  });

  test("a delayed cloud refresh leaves cached and local composition synchronous", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: () => undefined,
    });
    cache.replaceScope(SCOPE_A);
    const cached = workspace("1", "Cached cloud", 2);
    cache.remember(SCOPE_A, cached);
    const local = workspace("2", "Local workspace", 1);
    const client = {
      listWorkspaces: () => pending.promise,
    };
    const immediate = cache.listAndRefresh({
      client,
      local: [local],
      scope: SCOPE_A,
    });
    expect(immediate.map(({ name }) => name)).toEqual([
      "Local workspace",
      "Cached cloud",
    ]);

    pending.resolve(success([cached]));
    await cache.refresh(SCOPE_A, client);
  });

  test("a stale prior-generation completion cannot repopulate the replacement scope", async () => {
    const prior = deferred<ReturnType<typeof success>>();
    const next = deferred<ReturnType<typeof success>>();
    const invalidations: PortableInvalidation[] = [];
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: (invalidation) => invalidations.push(invalidation),
    });
    cache.replaceScope(SCOPE_A);
    const priorRefresh = cache.refresh(SCOPE_A, {
      listWorkspaces: () => prior.promise,
    });

    cache.replaceScope(SCOPE_B);
    const replacementRefresh = cache.refresh(SCOPE_B, {
      listWorkspaces: () => next.promise,
    });
    prior.resolve(success([workspace("3", "Stale cloud", 7)]));
    await priorRefresh;
    expect(cache.summaries(SCOPE_B)).toEqual([]);
    expect(invalidations).toEqual([]);

    next.resolve(success([workspace("4", "Current cloud", 8)]));
    await replacementRefresh;
    expect(cache.summaries(SCOPE_B).map(({ name }) => name)).toEqual([
      "Current cloud",
    ]);
  });

  test("organization or credential replacement clears cached routing authority", () => {
    const invalidations: PortableInvalidation[] = [];
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: (invalidation) => invalidations.push(invalidation),
    });
    const cloud = workspace("5", "Scoped cloud", 4);
    cache.replaceScope(SCOPE_A);
    expect(cache.remember(SCOPE_A, cloud)).toBeTrue();
    expect(cache.has(SCOPE_A, cloud.id)).toBeTrue();

    cache.replaceScope({
      ...SCOPE_A,
      organizationId: "org_replacement",
    });
    expect(cache.has(SCOPE_A, cloud.id)).toBeFalse();
    expect(cache.summaries(SCOPE_A)).toEqual([]);
    expect(invalidations).toEqual([{
      workspaceId: cloud.id,
      projectionRevision: cloud.revision + 1,
      scope: "workspace",
    }]);

    const organizationScope = {
      ...SCOPE_A,
      organizationId: "org_replacement",
    };
    expect(cache.summaries(organizationScope)).toEqual([]);
    expect(cache.remember(SCOPE_A, cloud)).toBeFalse();
    cache.remember(organizationScope, cloud);
    cache.replaceScope({
      ...organizationScope,
      credentialGeneration: organizationScope.credentialGeneration + 1,
    });
    expect(cache.has(organizationScope, cloud.id)).toBeFalse();
    expect(invalidations).toHaveLength(2);
  });

  test("shutdown fences an in-flight completion without publishing after disposal", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const invalidations: PortableInvalidation[] = [];
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: (invalidation) => invalidations.push(invalidation),
    });
    cache.replaceScope(SCOPE_A);
    const refresh = cache.refresh(SCOPE_A, {
      listWorkspaces: () => pending.promise,
    });

    cache.replaceScope(null, { invalidatePrevious: false });
    pending.resolve(success([workspace("7", "Late cloud", 10)]));
    await refresh;

    expect(cache.isCurrent(SCOPE_A)).toBeFalse();
    expect(cache.summaries(SCOPE_A)).toEqual([]);
    expect(invalidations).toEqual([]);
  });

  test("one coalesced success publishes one invalidation and its reload sees the cache", async () => {
    const pending = deferred<ReturnType<typeof success>>();
    const current = workspace("6", "Fresh cloud", 9);
    let reloads = 0;
    let requests = 0;
    const cache = new CloudWorkspaceSummaryCache({
      onInvalidated: (invalidation) => {
        expect(invalidation).toEqual({
          workspaceId: current.id,
          projectionRevision: current.revision,
          scope: "workspace",
        });
        reloads += 1;
        expect(cache.summaries(SCOPE_A)).toEqual([current]);
      },
    });
    cache.replaceScope(SCOPE_A);
    const client = {
      listWorkspaces: () => {
        requests += 1;
        return pending.promise;
      },
    };

    const first = cache.refresh(SCOPE_A, client);
    const coalesced = cache.refresh(SCOPE_A, client);
    expect(first).toBe(coalesced);
    expect(requests).toBe(1);
    pending.resolve(success([current]));
    await Promise.all([first, coalesced]);

    expect(reloads).toBe(1);
    expect(requests).toBe(1);
  });
});
