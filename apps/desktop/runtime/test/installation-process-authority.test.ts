import { describe, expect, test } from "bun:test";

import {
  parseProcessInventory,
  quitInstalledApplicationRoots,
  type InstallationProcess,
} from "../installation-process-authority";

const root: InstallationProcess = {
  birth: "Sun Aug 17 08:00:00 2026",
  command: "/Applications/HRA.app/Contents/MacOS/hra",
  parentPid: 1,
  pid: 100,
};
const gateway: InstallationProcess = {
  birth: "Sun Aug 17 08:00:01 2026",
  command: "/Applications/HRA.app/Contents/Resources/runtime/bin/oprte-gateway",
  parentPid: 100,
  pid: 101,
};

describe("installation process authority", () => {
  test("parses PID, parent, birth, and exact command", () => {
    expect(parseProcessInventory(
      " 100 1 Sun Aug 17 08:00:00 2026 /Applications/HRA.app/Contents/MacOS/hra\n",
    )).toEqual([root]);
  });

  test("requests termination only from the native root and waits for children", async () => {
    let inventory: readonly InstallationProcess[] = [root, gateway];
    const requested: number[] = [];
    await quitInstalledApplicationRoots([
      { executable: "hra", root: "/Applications/HRA.app" },
    ], {
      inventory: () => Promise.resolve(inventory),
      now: (() => {
        let value = 0;
        return () => value += 100;
      })(),
      requestAppKitTermination(process) {
        requested.push(process.pid);
        return Promise.resolve("requested");
      },
      wait() {
        inventory = [];
        return Promise.resolve();
      },
    });
    expect(requested).toEqual([root.pid]);
  });

  test("terminates two native roots independently without waiting on the other bundle", async () => {
    const predecessor: InstallationProcess = {
      birth: "Sun Aug 17 08:00:02 2026",
      command: "/Applications/OPRTE.app/Contents/MacOS/oprte",
      parentPid: 1,
      pid: 200,
    };
    let inventory: readonly InstallationProcess[] = [root, predecessor];
    const requested: number[] = [];
    await quitInstalledApplicationRoots([
      { executable: "hra", root: "/Applications/HRA.app" },
      { executable: "oprte", root: "/Applications/OPRTE.app" },
    ], {
      inventory: () => Promise.resolve(inventory),
      now: (() => {
        let value = 0;
        return () => value += 100;
      })(),
      requestAppKitTermination(process) {
        requested.push(process.pid);
        inventory = inventory.filter(entry => entry.pid !== process.pid);
        return Promise.resolve("requested");
      },
      wait: () => Promise.resolve(),
    });
    expect(requested).toEqual([root.pid, predecessor.pid]);
  });

  test("fails closed on an orphan helper without signalling it", () => {
    const requested: number[] = [];
    expect(quitInstalledApplicationRoots([
      { executable: "hra", root: "/Applications/HRA.app" },
    ], {
      inventory: () => Promise.resolve([gateway]),
      now: () => 0,
      requestAppKitTermination(process) {
        requested.push(process.pid);
        return Promise.resolve("requested");
      },
      wait: () => Promise.resolve(),
    })).rejects.toThrow("orphaned");
    expect(requested).toEqual([]);
  });

  test("fails closed when a root PID is reused", () => {
    let calls = 0;
    expect(quitInstalledApplicationRoots([
      { executable: "hra", root: "/Applications/HRA.app" },
    ], {
      inventory() {
        calls += 1;
        return Promise.resolve(calls === 1
          ? [root]
          : [{ ...root, birth: "Sun Aug 17 09:00:00 2026" }]);
      },
      now: () => 0,
      requestAppKitTermination: () => Promise.resolve("requested"),
      wait: () => Promise.resolve(),
    })).rejects.toThrow("reused before termination");
  });

  test("refuses PID reuse discovered at the AppKit termination boundary", () => {
    let terminationCalls = 0;
    expect(quitInstalledApplicationRoots([
      { executable: "hra", root: "/Applications/HRA.app" },
    ], {
      inventory: () => Promise.resolve([root]),
      now: () => 0,
      requestAppKitTermination() {
        terminationCalls += 1;
        return Promise.resolve("identity_mismatch");
      },
      wait: () => Promise.resolve(),
    })).rejects.toThrow("AppKit application identity changed");
    expect(terminationCalls).toBe(1);
  });
});
