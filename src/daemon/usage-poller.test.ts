import { describe, expect, spyOn, test } from "bun:test";

import {
  AccountUsagePoller,
  sleepForUsagePolling,
  USAGE_POLL_BACKOFF_MAX_MS,
  USAGE_POLL_INITIAL_STAGGER_MAX_MS,
  usagePollInitialStagger,
  usagePollInterval,
} from "./usage-poller";

describe("AccountUsagePoller", () => {
  test("derives stable bounded account-specific intervals and startup stagger", () => {
    expect(usagePollInterval("acct-a")).toBe(usagePollInterval("acct-a"));
    expect(usagePollInterval("acct-a")).toBeWithin(50_000, 70_001);
    expect(usagePollInitialStagger("acct-a")).toBeWithin(0, 20_001);
  });

  test("polls due accounts in deterministic due-time order and reschedules success", async () => {
    let now = 1_000;
    const polled: string[] = [];
    const accounts = ["account-b", "account-a"];
    const poller = new AccountUsagePoller({
      listAccountIds: () => accounts,
      poll: async (accountId) => { polled.push(accountId); },
      now: () => now,
    });
    expect(await poller.tick()).toBeGreaterThanOrEqual(1);
    const first = [...accounts].sort((left, right) => usagePollInitialStagger(left) - usagePollInitialStagger(right) || left.localeCompare(right))[0];
    if (first === undefined) throw new Error("The fixture must contain one account.");
    now += usagePollInitialStagger(first) + 1;
    expect(await poller.tick()).toBe(0);
    expect(polled).toEqual([first]);
  });

  test("backs failures off exponentially with a hard cap and reports each failure", async () => {
    let now = 0;
    const failures: number[] = [];
    const accountId = "account-a";
    const poller = new AccountUsagePoller({
      listAccountIds: () => [accountId],
      poll: async () => { throw new Error("offline"); },
      onFailure: (_account, _error, count) => { failures.push(count); },
      now: () => now,
    });
    await poller.tick();
    now = usagePollInitialStagger(accountId);
    for (let count = 0; count < 8; count += 1) {
      expect(await poller.tick()).toBe(0);
      now += Math.min(usagePollInterval(accountId) * Math.min(2 ** (count + 1), 16), USAGE_POLL_BACKOFF_MAX_MS);
    }
    expect(failures).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("removes deleted accounts from scheduling without polling them", async () => {
    let ids: readonly string[] = ["gone"];
    const polled: string[] = [];
    const poller = new AccountUsagePoller({
      listAccountIds: () => ids,
      poll: async (id) => { polled.push(id); },
      now: () => 0,
    });
    await poller.tick();
    ids = [];
    expect(await poller.tick()).toBe(1_000);
    expect(polled).toEqual([]);
  });

  test("removes its abort listener after a normal sleep", async () => {
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    try {
      await sleepForUsagePolling(1, controller.signal);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    } finally {
      add.mockRestore();
      remove.mockRestore();
    }
  });

  test("keeps polling and reports a diagnostic when the account list read throws", async () => {
    let now = 0;
    let listFailures = 2;
    const diagnostics: number[] = [];
    const polled: string[] = [];
    const sleeps: number[] = [];
    const poller = new AccountUsagePoller({
      listAccountIds: () => {
        if (listFailures > 0) {
          listFailures -= 1;
          throw new Error("store busy");
        }
        return ["account-a"];
      },
      poll: async (accountId) => { polled.push(accountId); },
      onTickFailure: (_error, failures) => { diagnostics.push(failures); },
      now: () => now,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        now += Math.max(milliseconds, USAGE_POLL_INITIAL_STAGGER_MAX_MS + 1);
        await Bun.sleep(0);
      },
    });
    poller.start();
    try {
      for (let attempt = 0; attempt < 200 && polled.length === 0; attempt += 1) await Bun.sleep(1);
      expect(diagnostics).toEqual([1, 2]);
      expect(sleeps.slice(0, 2)).toEqual([2_000, 4_000]);
      expect(polled[0]).toBe("account-a");
    } finally {
      await poller.close();
    }
  });

  test("a throwing diagnostic hook does not stop the poll loop", async () => {
    let now = 0;
    let listFailures = 1;
    const polled: string[] = [];
    const poller = new AccountUsagePoller({
      listAccountIds: () => {
        if (listFailures > 0) {
          listFailures -= 1;
          throw new Error("store busy");
        }
        return ["account-a"];
      },
      poll: async (accountId) => { polled.push(accountId); },
      onTickFailure: () => { throw new Error("diagnostic sink offline"); },
      now: () => now,
      sleep: async (milliseconds) => {
        now += Math.max(milliseconds, USAGE_POLL_INITIAL_STAGGER_MAX_MS + 1);
        await Bun.sleep(0);
      },
    });
    poller.start();
    try {
      for (let attempt = 0; attempt < 200 && polled.length === 0; attempt += 1) await Bun.sleep(1);
      expect(polled[0]).toBe("account-a");
    } finally {
      await poller.close();
    }
  });
});
