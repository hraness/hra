import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { StateSecurityScrubRequiredError, StateStore } from "../storage/state-store";
import type { HraFactsMemoryLifecyclePort } from "./facts-memory-lifecycle";
import { UnavailableCloudControl, UnavailableCodexRuntime } from "./ports";
import { CommandFailure, HraService } from "./service";

const roots: string[] = [];
const stores: StateStore[] = [];
const services: HraService[] = [];
const signal = new AbortController().signal;
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-local-composition-")));
  roots.push(root);
  const paths = resolveStatePaths({ rootDirectory: root });
  await initializeStatePaths(paths);
  const now = 1_900_000_000_000;
  const store = new StateStore(paths, { now: () => now, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  const trace: string[] = [];
  let constructed = 0;
  const createWorkStore = store.createWorkStore.bind(store);
  store.createWorkStore = (...args) => { constructed += 1; return createWorkStore(...args); };
  const listCloudSessionPage = store.listCloudSessionPage.bind(store);
  store.listCloudSessionPage = (input) => { trace.push("memory.reconcile"); return listCloudSessionPage(input); };
  const listProfiles = store.listProfiles.bind(store);
  store.listProfiles = () => { trace.push("command.list"); return listProfiles(); };
  const controls = {
    fence: async (): Promise<void> => {},
    sweep: async (): Promise<void> => {},
  };
  const factsMemory: HraFactsMemoryLifecyclePort = {
    cleanupSession: async () => { throw new Error("Unexpected memory cleanup."); },
    ensureSession: async () => { throw new Error("Unexpected memory creation."); },
    forkSession: async () => { throw new Error("Unexpected memory fork."); },
    readSession: () => { throw new Error("Unexpected memory read."); },
    resumeSession: async () => { throw new Error("Unexpected memory resume."); },
    transferSessionOwner: async () => { throw new Error("Unexpected memory transfer."); },
    sweepExpired: async (time) => {
      expect(time).toBe(now);
      trace.push("memory.sweep");
      await controls.sweep();
      return { attempted: 0, failed: 0, purged: 0 };
    },
  };
  const codex = new UnavailableCodexRuntime();
  codex.close = async () => { trace.push("runtime.close"); };
  const unexpectedProjectionRecovery = async (): Promise<never> => {
    throw new Error("A composition-only fixture accessed projection recovery.");
  };
  const cloud = new UnavailableCloudControl({
    isCompactProjectionRecoveryUnsettled: unexpectedProjectionRecovery,
    isCompactProjectionRecoveryUnsettledForProfile: unexpectedProjectionRecovery,
    supersedeCompactProjectionRecoveryForProviderDeletion: unexpectedProjectionRecovery,
    supersedeTerminalCompactProjectionRecoveries: unexpectedProjectionRecovery,
  });
  const input: ConstructorParameters<typeof HraService>[0] = {
    store, paths, codex, cloud, factsMemory,
    daemonAuthority: {
      assertCurrent: async () => { trace.push("fence"); await controls.fence(); },
      close: () => { trace.push("fence.close"); },
    },
    now: () => now,
    requestStop: () => { trace.push("requestStop"); },
  };
  const composition = HraService.createLocalComposition(input);
  services.push(composition.service);
  const snapshot = () => {
    const db = new Database(paths.database, { readonly: true, strict: true });
    try {
      return {
        version: db.query("PRAGMA user_version").get(),
        schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        rows: db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
          .map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
      };
    } finally { db.close(false); }
  };
  return { ...composition, input, store, trace, controls, snapshot, composition, constructed: () => constructed };
}

describe("local service composition", () => {
  test("creates one service per frozen composition and retains public constructor compatibility", async () => {
    const first = await fixture();
    const second = await fixture();
    expect(first.constructed()).toBe(1);
    expect(second.constructed()).toBe(1);
    expect(first.service).not.toBe(second.service);
    expect(first.executeAuthenticatedLocal).not.toBe(second.executeAuthenticatedLocal);
    expect(Object.isFrozen(first.composition)).toBe(true);
    expect(Object.keys(first.composition)).toEqual(["service", "executeAuthenticatedLocal"]);
    expect(Reflect.set(first.composition, "service", second.service)).toBe(false);
    expect(Reflect.set(first.composition, "executeAuthenticatedLocal", second.executeAuthenticatedLocal)).toBe(false);
    expect("executeAuthenticatedLocal" in first.service).toBe(false);
    const legacy = new HraService(second.input);
    services.push(legacy);
    expect(legacy).not.toBe(second.service);
    await expect(legacy.execute({ kind: "daemon.status" }, { signal })).resolves.toEqual({ running: true, pid: process.pid });
    await first.service.close();
    await expect(second.executeAuthenticatedLocal({ kind: "daemon.status" }, { signal })).resolves.toEqual({ running: true, pid: process.pid });
  });

  test("detached closure remains bound and cannot be intercepted by public execute substitution", async () => {
    const value = await fixture();
    const { executeAuthenticatedLocal } = value;
    let intercepted = 0;
    value.service.execute = async () => { intercepted += 1; throw new Error("Public execute was substituted."); };
    const before = value.snapshot();
    await expect(executeAuthenticatedLocal({ kind: "account.list" }, { signal })).resolves.toEqual({ accounts: [] });
    expect(intercepted).toBe(0);
    expect(value.snapshot()).toEqual(before);
    await expect(value.service.execute({ kind: "daemon.status" }, { signal })).rejects.toThrow("Public execute was substituted.");
    expect(intercepted).toBe(1);
  });

  for (const entry of ["generic", "authenticated"] as const) {
    const invoke = (value: Awaited<ReturnType<typeof fixture>>) => entry === "generic"
      ? value.service.execute.bind(value.service) : value.executeAuthenticatedLocal;

    test(`${entry} preserves lifecycle ordering and inert command results`, async () => {
      const value = await fixture();
      const before = value.snapshot();
      await expect(invoke(value)({ kind: "account.list" }, { signal })).resolves.toEqual({ accounts: [] });
      expect(value.trace).toEqual(["fence", "memory.reconcile", "memory.sweep", "command.list", "fence"]);
      expect(value.snapshot()).toEqual(before);
      value.trace.length = 0;
      await expect(invoke(value)({ kind: "daemon.status" }, { signal })).resolves.toEqual({ running: true, pid: process.pid });
      expect(value.trace).toEqual(["fence", "memory.sweep", "fence"]);
    });

    for (const failingFence of [1, 2]) {
      test(`${entry} preserves failure at fence ${String(failingFence)} and releases its operation`, async () => {
        const value = await fixture();
        const failure = new Error("Exact daemon fence failure.");
        let checks = 0;
        value.controls.fence = async () => { checks += 1; if (checks === failingFence) throw failure; };
        const before = value.snapshot();
        await expect(invoke(value)({ kind: "account.list" }, { signal })).rejects.toBe(failure);
        expect(checks).toBe(failingFence);
        expect(value.trace.filter((item) => item === "command.list")).toHaveLength(failingFence === 1 ? 0 : 1);
        expect(value.snapshot()).toEqual(before);
        value.controls.fence = async () => {};
        await expect(value.service.close()).resolves.toBeUndefined();
      });
    }

    test(`${entry} keeps daemon.stop refused and releases failed command admission`, async () => {
      const value = await fixture();
      await expect(invoke(value)({ kind: "daemon.stop" }, { signal })).rejects.toMatchObject({
        code: "INVALID_INPUT", message: "Daemon stop commands must be admitted by the exact local authority boundary.",
      });
      expect(value.trace).toEqual(["fence", "memory.reconcile", "memory.sweep"]);
      await expect(invoke(value)({ kind: "daemon.status" }, { signal })).resolves.toEqual({ running: true, pid: process.pid });
      await expect(value.service.close()).resolves.toBeUndefined();
    });

    test(`${entry} preserves housekeeping failure before command execution`, async () => {
      const value = await fixture();
      const failure = new Error("Exact memory housekeeping failure.");
      value.controls.sweep = async () => { throw failure; };
      await expect(invoke(value)({ kind: "account.list" }, { signal })).rejects.toBe(failure);
      expect(value.trace).toEqual(["fence", "memory.reconcile", "memory.sweep"]);
      value.controls.sweep = async () => {};
      await expect(value.service.close()).resolves.toBeUndefined();
    });

    test(`${entry} is drained by close and rejects new admission while closing`, async () => {
      const value = await fixture();
      const started = deferred();
      const release = deferred();
      value.controls.sweep = async () => { started.resolve(); await release.promise; };
      const running = invoke(value)({ kind: "daemon.status" }, { signal });
      await started.promise;
      let drained = false;
      const closing = value.service.close().then(() => { drained = true; });
      try {
        await expect(invoke(value)({ kind: "account.list" }, { signal })).rejects.toMatchObject({
          code: "UNAVAILABLE", message: "The daemon service is closing and no longer accepts operations.",
        });
        expect(value.trace.filter((item) => item === "fence")).toHaveLength(1);
        expect(value.trace).toContain("fence.close");
        expect(drained).toBe(false);
      } finally { release.resolve(); }
      await expect(running).resolves.toEqual({ running: true, pid: process.pid });
      await closing;
      expect(drained).toBe(true);
      await expect(value.executeAuthenticatedLocal({ kind: "daemon.status" }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(value.trace.filter((item) => item === "runtime.close")).toHaveLength(1);
    });

    for (const committed of [false, true]) {
      test(`${entry} sanitizes scrub failure committed=${committed} and defers stop`, async () => {
        const value = await fixture();
        const privateCause = "private-scrub-cause-must-not-escape";
        value.controls.sweep = async () => { throw new StateSecurityScrubRequiredError(committed, new Error(privateCause)); };
        const afterResponse: Array<() => void> = [];
        const error: unknown = await invoke(value)({ kind: "account.list" }, {
          signal, afterResponse: (callback) => { afterResponse.push(callback); },
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CommandFailure);
        expect(error).toMatchObject({ code: "UNAVAILABLE", details: { operationCommitted: committed },
          message: committed
            ? "The local transition committed, but its security scrub could not finish. HRA is stopping and will complete the scrub before the next startup."
            : "A required local security scrub could not finish. HRA is stopping and will retry it before the next startup.",
        });
        if (!(error instanceof Error)) throw new Error("Expected sanitized command failure.");
        expect(error.cause).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(privateCause);
        expect(value.trace).toEqual(["fence", "memory.reconcile", "memory.sweep"]);
        expect(afterResponse).toHaveLength(1);
        afterResponse[0]?.();
        expect(value.trace.filter((item) => item === "requestStop")).toHaveLength(1);
        value.controls.sweep = async () => {};
        await expect(value.service.close()).resolves.toBeUndefined();
      });
    }
  }
});
