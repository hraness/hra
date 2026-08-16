import { describe, expect, test } from "bun:test";
import { DispatchAccountReservationArbiter } from "../src/dispatch/account-reservations";
import { LocalDispatchCapabilities } from "../src/dispatch/local-capabilities";
import { dispatchBudgetRefreshRetryMs } from "../src/accounts/dispatch-budget";
import type { DispatchAccountSummary } from "../src/internal-contracts";

const now = Date.parse("2026-07-21T12:00:00.000Z");

async function flushBudgetRefresh(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function account(
  id: string,
  selected = false,
  usedPercents: readonly number[] | null = [0],
): DispatchAccountSummary {
  return {
    id,
    revision: 1,
    label: id,
    selected,
    identityLabel: null,
    planLabel: null,
    usageRemainingPercent: usedPercents === null
      ? null
      : 100 - Math.max(...usedPercents),
    authState: "signedIn",
    login: { state: "idle" },
    usage: usedPercents === null
      ? { state: "unavailable" }
      : {
          state: "ready",
          updatedAt: new Date(now).toISOString(),
          tokens: { state: "unavailable" },
          limits: usedPercents.map((usedPercent, index) => ({
            id: `bucket-${index}`,
            name: `Bucket ${index}`,
            primary: { usedPercent, windowDurationMinutes: 300, resetsAt: null },
            secondary: null,
            individual: null,
            unlimited: false,
            reached: false,
          })),
        },
    runtime: { state: "stopped", generation: 1 },
  };
}

describe("local dispatch capacity", () => {
  test("shares two account lanes across cloud and local admission and restores them", async () => {
    const accounts = {
      dispatchAccounts: () => [
        account("acct_shared_first01", true),
        account("acct_shared_second1"),
      ],
    };
    const reservations = new DispatchAccountReservationArbiter({
      accounts,
      now: () => now,
    });
    const cloud = new LocalDispatchCapabilities({
      accountReservations: reservations,
      accounts,
      repositories: [{
        repositoryId: "repo_cloud000001",
        repositoryPath: "/private/cloud",
      }],
      now: () => now,
    });
    const local = new LocalDispatchCapabilities({
      accountReservations: reservations,
      accounts,
      repositories: [{
        repositoryId: "repo_local000001",
        repositoryPath: "/private/local",
      }],
      now: () => now,
    });
    const [cloudSlot, localSlot] = await Promise.all([
      cloud.acquire({ repositoryId: "repo_cloud000001" }),
      local.acquire({ repositoryId: "repo_local000001" }),
    ]);
    if (cloudSlot === null || localSlot === null) {
      throw new Error("Expected both shared account lanes");
    }
    expect(new Set([
      cloudSlot.accountProfileId,
      localSlot.accountProfileId,
    ]).size).toBe(2);
    expect(await local.acquire({ repositoryId: "repo_local000001" }))
      .toBeNull();
    await Promise.all([
      cloud.settle(cloudSlot, {
        kind: "running",
        runId: "run_shared_cloud01",
      }),
      local.settle(localSlot, {
        kind: "running",
        runId: "run_shared_local001",
      }),
    ]);
    expect(reservations.currentSnapshot()).toMatchObject({
      activeRuns: 2,
      availableCapacity: 0,
      state: "capacity_full",
      retainedRunIds: [
        "run_shared_cloud01",
        "run_shared_local001",
      ],
    });

    const restarted = new DispatchAccountReservationArbiter({
      accounts,
      now: () => now,
      recoveredReservations: [
        {
          accountProfileId: cloudSlot.accountProfileId,
          runId: "run_shared_cloud01",
        },
        {
          accountProfileId: localSlot.accountProfileId,
          runId: "run_shared_local001",
        },
      ],
    });
    expect(restarted.currentSnapshot()).toMatchObject({
      activeRuns: 2,
      availableCapacity: 0,
      state: "capacity_full",
    });
    restarted.releaseRun("run_shared_local001");
    expect(restarted.currentSnapshot()).toMatchObject({
      activeRuns: 1,
      availableCapacity: 1,
      state: "ready",
    });
  });

  test("advertises only mapped repositories and one slot per signed-in account", async () => {
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => [account("acct_first0001", true), account("acct_second001")],
      },
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
      now: () => now,
    });
    expect(await capabilities.snapshot()).toEqual({
      reportedState: "ready",
      capacity: 2,
      activeRuns: 0,
      retainedRunIds: [],
      repositoryIds: ["repo_primary0001"],
    });
    const first = await capabilities.acquire({ repositoryId: "repo_primary0001" });
    const second = await capabilities.acquire({ repositoryId: "repo_primary0001" });
    expect(first?.accountProfileId).toBe("acct_first0001");
    expect(second?.accountProfileId).toBe("acct_second001");
    expect(await capabilities.acquire({ repositoryId: "repo_primary0001" })).toBeNull();
    expect(await capabilities.snapshot()).toMatchObject({ reportedState: "busy", activeRuns: 2 });
  });

  test("chooses the account with the largest conservative remaining budget", async () => {
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => [
          account("acct_selected001", true, [10, 96]),
          account("acct_roomiest001", false, [35, 40]),
          account("acct_middle0001", false, [50]),
        ],
      },
      now: () => now,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect((await capabilities.acquire({ repositoryId: "repo_primary0001" }))?.accountProfileId)
      .toBe("acct_roomiest001");
  });

  test("uses selected, least-recently-used, and profile ID only as deterministic budget ties", async () => {
    let clock = now;
    const accounts = [
      account("acct_zed0000001", false, [25]),
      account("acct_selected001", true, [25]),
      account("acct_alpha00001", false, [25]),
    ];
    const capabilities = new LocalDispatchCapabilities({
      accounts: { dispatchAccounts: () => accounts },
      now: () => clock,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });
    const selected = await capabilities.acquire({ repositoryId: "repo_primary0001" });
    if (selected === null) throw new Error("expected selected account");
    expect(selected.accountProfileId).toBe("acct_selected001");
    await capabilities.settle(selected, { kind: "running", runId: "run_selected001" });
    clock += 1;
    const next = await capabilities.acquire({ repositoryId: "repo_primary0001" });
    expect(next?.accountProfileId).toBe("acct_alpha00001");
  });

  test("refreshes stale budgets and excludes accounts known to be exhausted from capacity", async () => {
    let refreshes = 0;
    const staleBase = account("acct_stale00001", true, [1]);
    if (staleBase.usage.state !== "ready") throw new Error("expected ready budget fixture");
    const stale = {
      ...staleBase,
      usage: {
        ...staleBase.usage,
        updatedAt: "2026-07-21T11:00:00.000Z",
      },
    } satisfies DispatchAccountSummary;
    const exhausted = {
      ...account("acct_empty00001", false, [100]),
      usage: {
        ...account("acct_empty00001", false, [100]).usage,
        state: "ready" as const,
        updatedAt: new Date(now).toISOString(),
        limits: [{
          id: "codex",
          name: "Codex",
          primary: { usedPercent: 100, windowDurationMinutes: 300, resetsAt: null },
          secondary: null,
          individual: null,
          unlimited: false,
          reached: true,
        }],
        tokens: { state: "unavailable" as const },
      },
    } satisfies DispatchAccountSummary;
    const refreshed = account("acct_stale00001", true, [20]);
    let accounts: readonly DispatchAccountSummary[] = [stale, exhausted];
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => accounts,
        refreshDispatchAccounts: () => {
          refreshes += 1;
          accounts = [refreshed, exhausted];
          return Promise.resolve(accounts);
        },
      },
      now: () => now,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0, reportedState: "degraded" });
    await flushBudgetRefresh();
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 1, reportedState: "ready" });
    expect((await capabilities.acquire({ repositoryId: "repo_primary0001" }))?.accountProfileId)
      .toBe("acct_stale00001");
    expect(refreshes).toBe(1);
  });

  test("fails closed and retries a failed budget refresh only at its exact deadline", async () => {
    let clock = now;
    let refreshes = 0;
    const staleBase = account("acct_stale00001", true, [1]);
    if (staleBase.usage.state !== "ready") throw new Error("expected ready budget fixture");
    const stale = {
      ...staleBase,
      usage: {
        ...staleBase.usage,
        updatedAt: "2026-07-21T11:00:00.000Z",
      },
    } satisfies DispatchAccountSummary;
    const failed = {
      ...stale,
      usage: { state: "failed" as const, message: "Usage limits could not be refreshed." },
    } satisfies DispatchAccountSummary;
    let accounts: readonly DispatchAccountSummary[] = [stale];
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => accounts,
        refreshDispatchAccounts: () => {
          refreshes += 1;
          accounts = [failed];
          return Promise.resolve(accounts);
        },
      },
      now: () => clock,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect(await capabilities.snapshot()).toEqual({
      reportedState: "degraded",
      blockReason: "no_account",
      capacity: 0,
      activeRuns: 0,
      retainedRunIds: [],
      repositoryIds: ["repo_primary0001"],
    });
    await flushBudgetRefresh();
    expect(refreshes).toBe(1);

    expect(await capabilities.acquire({ repositoryId: "repo_primary0001" })).toBeNull();
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    expect(refreshes).toBe(1);

    clock = now + dispatchBudgetRefreshRetryMs - 1;
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    await flushBudgetRefresh();
    expect(refreshes).toBe(1);

    clock += 1;
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    await flushBudgetRefresh();
    expect(refreshes).toBe(2);
  });

  test("clears retry backoff after a successful budget refresh", async () => {
    let clock = now;
    let refreshes = 0;
    const staleBase = account("acct_recovery0001", true, [10]);
    if (staleBase.usage.state !== "ready") throw new Error("expected ready budget fixture");
    const stale = {
      ...staleBase,
      usage: { ...staleBase.usage, updatedAt: "2026-07-21T11:00:00.000Z" },
    } satisfies DispatchAccountSummary;
    const failed = {
      ...stale,
      usage: { state: "failed" as const, message: "Usage limits could not be refreshed." },
    } satisfies DispatchAccountSummary;
    const refreshed = account("acct_recovery0001", true, [20]);
    let accounts: readonly DispatchAccountSummary[] = [stale];
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => accounts,
        refreshDispatchAccounts: () => {
          refreshes += 1;
          accounts = refreshes === 1 ? [failed] : [refreshed];
          return Promise.resolve(accounts);
        },
      },
      now: () => clock,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    await flushBudgetRefresh();
    clock += dispatchBudgetRefreshRetryMs;
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    await flushBudgetRefresh();
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 1, reportedState: "ready" });
    expect(refreshes).toBe(2);

    accounts = [stale];
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    await flushBudgetRefresh();
    expect(refreshes).toBe(3);
  });

  test("coalesces refresh under an invalid clock and recovers when time becomes valid", async () => {
    let clock = Number.NaN;
    let refreshes = 0;
    const stale = account("acct_clock000001", true, null);
    const failed = {
      ...stale,
      usage: { state: "failed" as const, message: "Usage limits could not be refreshed." },
    } satisfies DispatchAccountSummary;
    let accounts: readonly DispatchAccountSummary[] = [stale];
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => accounts,
        refreshDispatchAccounts: () => {
          refreshes += 1;
          accounts = [failed];
          return Promise.resolve(accounts);
        },
      },
      now: () => clock,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    await flushBudgetRefresh();
    expect(refreshes).toBe(1);
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    expect(await capabilities.acquire({ repositoryId: "repo_primary0001" })).toBeNull();
    await flushBudgetRefresh();
    expect(refreshes).toBe(1);

    clock = now;
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    await flushBudgetRefresh();
    expect(refreshes).toBe(2);
  });

  test("does not block heartbeat or claim reads on an in-flight provider refresh", async () => {
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshes = 0;
    const staleBase = account("acct_single00001", true, [10]);
    if (staleBase.usage.state !== "ready") throw new Error("expected ready budget fixture");
    const stale = {
      ...staleBase,
      usage: { ...staleBase.usage, updatedAt: "2026-07-21T11:00:00.000Z" },
    } satisfies DispatchAccountSummary;
    const refreshed = account("acct_single00001", true, [10]);
    let accounts: readonly DispatchAccountSummary[] = [stale];
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => accounts,
        refreshDispatchAccounts: async () => {
          refreshes += 1;
          await refreshGate;
          accounts = [refreshed];
          return accounts;
        },
      },
      now: () => now,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0, reportedState: "degraded" });
    expect(refreshes).toBe(1);
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0 });
    expect(await capabilities.acquire({ repositoryId: "repo_primary0001" })).toBeNull();
    expect(refreshes).toBe(1);

    releaseRefresh?.();
    await flushBudgetRefresh();
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 1, reportedState: "ready" });
  });

  test("atomically reserves one account across simultaneous acquisitions", async () => {
    const onlyAccount = account("acct_single00001", true, [10]);
    const capabilities = new LocalDispatchCapabilities({
      accounts: { dispatchAccounts: () => [onlyAccount] },
      now: () => now,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    const slots = await Promise.all([
      capabilities.acquire({ repositoryId: "repo_primary0001" }),
      capabilities.acquire({ repositoryId: "repo_primary0001" }),
    ]);

    expect(slots.filter((candidate) => candidate !== null)).toHaveLength(1);
    expect(slots.filter((candidate) => candidate === null)).toHaveLength(1);
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 1, activeRuns: 1 });
  });

  test("refreshes an exhausted window after its reset boundary instead of fencing it forever", async () => {
    let refreshes = 0;
    const expired = account("acct_reset000001", true, [100]);
    if (expired.usage.state !== "ready") throw new Error("expected ready budget fixture");
    const staleReached = {
      ...expired,
      usage: {
        ...expired.usage,
        limits: expired.usage.limits.map((limit) => ({
          ...limit,
          reached: true,
          primary: limit.primary === null
            ? null
            : { ...limit.primary, resetsAt: new Date(now - 1).toISOString() },
        })),
      },
    } satisfies DispatchAccountSummary;
    const refreshed = account("acct_reset000001", true, [5]);
    let accounts: readonly DispatchAccountSummary[] = [staleReached];
    const capabilities = new LocalDispatchCapabilities({
      accounts: {
        dispatchAccounts: () => accounts,
        refreshDispatchAccounts: () => {
          refreshes += 1;
          accounts = [refreshed];
          return Promise.resolve(accounts);
        },
      },
      now: () => now,
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect(await capabilities.snapshot()).toMatchObject({ capacity: 0, reportedState: "degraded" });
    await flushBudgetRefresh();
    expect(await capabilities.snapshot()).toMatchObject({ capacity: 1, reportedState: "ready" });
    expect(refreshes).toBe(1);
  });

  test("retains running and ambiguous slots until an explicit local revocation", async () => {
    const released: string[] = [];
    const capabilities = new LocalDispatchCapabilities({
      accounts: { dispatchAccounts: () => [account("acct_first0001")] },
      now: () => now,
      onRunReleased: (runId) => { released.push(runId); },
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });
    const slot = await capabilities.acquire({ repositoryId: "repo_primary0001" });
    if (slot === null) throw new Error("expected a local dispatch slot");
    await capabilities.settle(slot, { kind: "running", runId: "run_primary0001" });
    expect(await capabilities.snapshot()).toMatchObject({ reportedState: "busy", activeRuns: 1 });
    expect(capabilities.releaseRun("run_primary0001")).toEqual(slot);
    expect(capabilities.settle(slot, {
      kind: "terminal",
      runId: "run_primary0001",
    })).resolves.toBeUndefined();
    expect(released).toEqual(["run_primary0001"]);
    expect(await capabilities.snapshot()).toMatchObject({ reportedState: "ready", activeRuns: 0 });
  });

  test("does not rebind a run whose terminal acknowledgement won before slot settlement", async () => {
    const released: string[] = [];
    const accounts = {
      dispatchAccounts: () => [account("acct_first0001")],
    };
    const accountReservations = new DispatchAccountReservationArbiter({
      accounts,
      now: () => now,
    });
    const capabilities = new LocalDispatchCapabilities({
      accountReservations,
      accounts,
      now: () => now,
      onRunReleased: (runId) => { released.push(runId); },
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });
    const slot = await capabilities.acquire({ repositoryId: "repo_primary0001" });
    if (slot === null) throw new Error("expected a local dispatch slot");
    expect(accountReservations.currentSnapshot()).toMatchObject({
      activeRuns: 1,
      availableCapacity: 0,
    });

    expect(capabilities.releaseRun("run_late_terminal01")).toBeNull();
    await capabilities.settle(slot, { kind: "running", runId: "run_late_terminal01" });

    expect(released).toEqual(["run_late_terminal01"]);
    expect(accountReservations.currentSnapshot()).toMatchObject({
      activeRuns: 0,
      availableCapacity: 1,
      retainedRunIds: [],
    });
    expect(await capabilities.snapshot()).toMatchObject({
      reportedState: "ready",
      activeRuns: 0,
      retainedRunIds: [],
    });
  });

  test("restores unresolved account reservations before advertising restart capacity", async () => {
    const capabilities = new LocalDispatchCapabilities({
      accounts: { dispatchAccounts: () => [account("acct_first0001")] },
      now: () => now,
      recoveredReservations: [{
        accountProfileId: "acct_first0001",
        repositoryPublicId: "repo_primary0001",
        runId: "run_recovered0001",
      }],
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });

    expect(await capabilities.snapshot()).toMatchObject({ reportedState: "busy", activeRuns: 1 });
    expect(await capabilities.acquire({ repositoryId: "repo_primary0001" })).toBeNull();
    expect(capabilities.releaseRun("run_recovered0001")).toMatchObject({
      accountProfileId: "acct_first0001",
      repositoryId: "repo_primary0001",
    });
    expect(await capabilities.snapshot()).toMatchObject({ reportedState: "ready", activeRuns: 0 });
  });

  test("keeps a disconnected recovered account fenced without emitting an invalid heartbeat", async () => {
    const capabilities = new LocalDispatchCapabilities({
      accounts: { dispatchAccounts: () => [] },
      recoveredReservations: [{
        accountProfileId: "acct_disconnected1",
        repositoryPublicId: "repo_removed0001",
        runId: "run_ambiguous0001",
      }],
      repositories: [],
    });

    expect(await capabilities.snapshot()).toEqual({
      reportedState: "degraded",
      blockReason: "no_account",
      capacity: 1,
      activeRuns: 1,
      retainedRunIds: ["run_ambiguous0001"],
      repositoryIds: [],
    });
  });

  test("reports typed blocking reasons instead of claiming readiness", async () => {
    const noAccount = new LocalDispatchCapabilities({
      accounts: { dispatchAccounts: () => [] },
      repositories: [{ repositoryId: "repo_primary0001", repositoryPath: "/private/repo" }],
    });
    expect(await noAccount.snapshot()).toMatchObject({
      reportedState: "degraded",
      blockReason: "no_account",
    });
    const noRepository = new LocalDispatchCapabilities({
      accounts: { dispatchAccounts: () => [account("acct_first0001")] },
      now: () => now,
      repositories: [],
    });
    expect(await noRepository.snapshot()).toMatchObject({
      reportedState: "degraded",
      blockReason: "no_repository",
    });
  });
});
