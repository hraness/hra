import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  inspectOpenFileQuiescence,
  type InstallationHandoffPaths,
} from "../installation-handoff";
import { acquireControlPlaneLifetimeLock } from "../src/state/control-plane-lock";

type ExternalHolder = Bun.Subprocess<"ignore", "pipe", "pipe">;

const externalHolderReadinessByteLimit = 64;
const externalHolderReadinessTimeoutMs = 5_000;
const externalHolderTerminationTimeoutMs = 1_000;

let fixtureRoot = "";
let paths: InstallationHandoffPaths;

beforeAll(async () => {
  if (process.platform !== "darwin") {
    throw new Error("The installation handoff lsof suite requires macOS.");
  }
  fixtureRoot = await realpath(
    await mkdtemp(join(tmpdir(), "hra-installation-handoff-lsof-test-")),
  );
  const applicationsDirectory = join(fixtureRoot, "Applications");
  const stateRoot = join(fixtureRoot, "state");
  const controlPlanePath = join(stateRoot, "control-plane.sqlite");
  await mkdir(applicationsDirectory, { mode: 0o700 });
  await mkdir(stateRoot, { mode: 0o700 });
  await chmod(stateRoot, 0o700);
  const database = new Database(controlPlanePath, { create: true });
  database.exec("CREATE TABLE handoff_lsof_fixture (id INTEGER PRIMARY KEY)");
  database.close();
  await chmod(controlPlanePath, 0o600);
  paths = {
    applicationsDirectory,
    candidateApp: join(fixtureRoot, "candidate", "HRA.app"),
    canonicalApp: join(applicationsDirectory, "HRA.app"),
    predecessorApp: join(applicationsDirectory, "OPRTE.app"),
    stateRoot,
    controlPlanePath,
    nativeInstanceLockPath: join(dirname(stateRoot), ".native-instance.lock"),
    updateHazardPath: join(dirname(stateRoot), ".update-hazard.json"),
    updateHazardTemporaryPath: join(dirname(stateRoot), ".update-hazard.json.tmp"),
    sparkleCacheRoots: [],
  };
});

afterAll(async () => {
  if (fixtureRoot !== "") {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

describe("installation handoff macOS open-file authority", () => {
  test("exempts only its bound main database descriptor", async () => {
    const lock = acquireControlPlaneLifetimeLock(paths.controlPlanePath);
    try {
      expect(lock.bindControlPlane().controlPlanePath).toBe(paths.controlPlanePath);
      expect(await inspectOpenFileQuiescence(paths)).toBeTrue();

      const walPath = `${paths.controlPlanePath}-wal`;
      const wal = await open(walPath, "w", 0o600);
      try {
        expect(await inspectOpenFileQuiescence(paths)).toBeFalse();
      } finally {
        await wal.close();
        await rm(walPath, { force: true });
      }
    } finally {
      lock.release();
    }
  });

  test("rejects a second process holding the control-plane database", async () => {
    const lock = acquireControlPlaneLifetimeLock(paths.controlPlanePath);
    lock.bindControlPlane();
    let holder: ExternalHolder | null = null;
    try {
      holder = await startExternalHolder(paths.controlPlanePath);
      expect(await inspectOpenFileQuiescence(paths)).toBeFalse();
    } finally {
      if (holder !== null) await stopExternalHolder(holder);
      lock.release();
    }
  });

  test("rejects a holder anywhere below an installed bundle root", async () => {
    const heldPath = join(paths.canonicalApp, "Contents", "Resources", "held.txt");
    await mkdir(dirname(heldPath), { mode: 0o700, recursive: true });
    await writeFile(heldPath, "bundle holder fixture\n", { mode: 0o600 });
    let holder: ExternalHolder | null = null;
    try {
      holder = await startExternalHolder(heldPath);
      expect(await inspectOpenFileQuiescence(paths)).toBeFalse();
    } finally {
      if (holder !== null) await stopExternalHolder(holder);
      await rm(paths.canonicalApp, { force: true, recursive: true });
    }
  });
});

async function startExternalHolder(
  path: string,
): Promise<ExternalHolder> {
  const child = Bun.spawn([
    process.execPath,
    "-e",
    `
      import { openSync } from "node:fs";
      const path = process.env.HRA_TEST_HOLDER_PATH;
      if (path === undefined) process.exit(2);
      openSync(path, "r");
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1_000);
    `,
  ], {
    env: { HRA_TEST_HOLDER_PATH: path },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  await waitForExternalHolderReadiness(child);
  return child;
}

async function waitForExternalHolderReadiness(
  child: ExternalHolder,
): Promise<void> {
  const reader = child.stdout.getReader();
  const readiness = (async () => {
    const decoder = new TextDecoder();
    let bytes = 0;
    let output = "";
    while (true) {
      const next = await reader.read();
      if (next.done) {
        throw new Error("External holder exited before readiness.");
      }
      bytes += next.value.byteLength;
      if (bytes > externalHolderReadinessByteLimit) {
        throw new Error("External holder readiness exceeded its byte limit.");
      }
      output += decoder.decode(next.value, { stream: true });
      if (output.includes("\n")) {
        if (output !== "ready\n") {
          throw new Error("External holder emitted malformed readiness.");
        }
        return;
      }
    }
  })();
  void readiness.catch(() => undefined);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("External holder readiness timed out.")),
      externalHolderReadinessTimeoutMs,
    );
  });
  try {
    await Promise.race([readiness, deadline]);
  } catch (reason: unknown) {
    const failures = [asError(reason)];
    try {
      await stopExternalHolder(child);
    } catch (cleanupReason: unknown) {
      failures.push(asError(cleanupReason));
    }
    try {
      await reader.cancel();
    } catch {
      // A completed or failed read may already have released its stream state.
    }
    await readiness.catch(() => undefined);
    throw failures.length === 1
      ? asError(failures[0])
      : new AggregateError(failures, "External holder readiness cleanup failed.");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    reader.releaseLock();
  }
}

async function stopExternalHolder(child: ExternalHolder): Promise<void> {
  if (child.exitCode !== null) {
    await child.exited;
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch (reason: unknown) {
    if (child.exitCode === null) throw reason;
  }
  if (await externalHolderExitedWithin(child)) return;

  try {
    child.kill("SIGKILL");
  } catch (reason: unknown) {
    if (child.exitCode === null) throw reason;
  }
  if (!await externalHolderExitedWithin(child)) {
    throw new Error("External holder did not exit after SIGKILL.");
  }
}

async function externalHolderExitedWithin(
  child: ExternalHolder,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(
      () => resolve(false),
      externalHolderTerminationTimeoutMs,
    );
  });
  return await Promise.race([
    child.exited.then(() => true),
    deadline,
  ]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}
