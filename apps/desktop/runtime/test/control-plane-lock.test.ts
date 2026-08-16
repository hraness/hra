import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  link,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireControlPlaneLifetimeLock,
  controlPlaneLifetimeLockPath,
} from "../src/state/control-plane-lock";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => {
      await rm(path, { recursive: true, force: true });
    }),
  );
});

async function fixture(): Promise<{
  readonly root: string;
  readonly stateRoot: string;
  readonly databasePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "oprte-lifetime-lock-"));
  temporaryDirectories.push(root);
  const applicationSupportRoot = join(root, "OPRTE");
  await mkdir(applicationSupportRoot, { recursive: true, mode: 0o700 });
  return {
    root,
    stateRoot: applicationSupportRoot,
    databasePath: join(applicationSupportRoot, "control-plane.sqlite"),
  };
}

describe("control-plane lifetime lock", () => {
  test("holds one canonical user-only descriptor lock and releases idempotently", async () => {
    const { databasePath } = await fixture();
    const first = acquireControlPlaneLifetimeLock(databasePath);
    expect(first.path).toBe(controlPlaneLifetimeLockPath(databasePath));
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);

    expect(() => acquireControlPlaneLifetimeLock(databasePath)).toThrow(
      expect.objectContaining({ code: "already_running" }),
    );

    first.release();
    first.release();
    const retry = acquireControlPlaneLifetimeLock(databasePath);
    retry.release();
  });

  test("binds the exact held state-root and control-plane identities", async () => {
    const { databasePath, stateRoot } = await fixture();
    const lock = acquireControlPlaneLifetimeLock(databasePath);
    try {
      await writeFile(databasePath, "sqlite", { mode: 0o600 });
      const [stateRootMetadata, controlPlaneMetadata] = await Promise.all([
        stat(stateRoot),
        stat(databasePath),
      ]);
      const authority = lock.bindControlPlane();
      expect(authority).toEqual({
        controlPlanePath: databasePath,
        stateRoot: {
          device: String(stateRootMetadata.dev),
          inode: String(stateRootMetadata.ino),
        },
        controlPlane: {
          device: String(controlPlaneMetadata.dev),
          inode: String(controlPlaneMetadata.ino),
        },
      });
      expect(lock.bindControlPlane()).toBe(authority);
      lock.release();
      expect(() => lock.bindControlPlane()).toThrow(
        expect.objectContaining({ code: "invalid_path" }),
      );
    } finally {
      lock.release();
    }
  });

  test("rejects a metadata-valid decoy published after lock acquisition", async () => {
    const { root, stateRoot, databasePath } = await fixture();
    const lock = acquireControlPlaneLifetimeLock(databasePath);
    const displaced = join(root, "displaced-state");
    try {
      await rename(stateRoot, displaced);
      await mkdir(stateRoot, { mode: 0o700 });
      await writeFile(databasePath, "decoy sqlite", { mode: 0o600 });
      expect(() => lock.bindControlPlane()).toThrow(
        expect.objectContaining({ code: "invalid_path" }),
      );
      expect(await Bun.file(join(displaced, ".control-plane.sqlite.lifetime.lock")).exists())
        .toBeTrue();
      expect(await Bun.file(databasePath).text()).toBe("decoy sqlite");
    } finally {
      lock.release();
    }
  });

  test("fails closed for symbolic links, hard links, and special files", async () => {
    const { root, databasePath } = await fixture();
    const lockPath = controlPlaneLifetimeLockPath(databasePath);
    const outside = join(root, "outside");
    await writeFile(outside, "outside", { mode: 0o600 });
    await symlink(outside, lockPath);
    expect(() => acquireControlPlaneLifetimeLock(databasePath)).toThrow(
      expect.objectContaining({ code: "invalid_path" }),
    );

    await rm(lockPath);
    await link(outside, lockPath);
    expect(() => acquireControlPlaneLifetimeLock(databasePath)).toThrow(
      expect.objectContaining({ code: "invalid_path" }),
    );

    await rm(lockPath);
    await mkdir(lockPath);
    expect(() => acquireControlPlaneLifetimeLock(databasePath)).toThrow(
      expect.objectContaining({ code: "invalid_path" }),
    );
  });

  test("excludes another process and is released by SIGKILL without stale-file deletion", async () => {
    const { databasePath } = await fixture();
    const moduleUrl = new URL(
      "../src/state/control-plane-lock.ts",
      import.meta.url,
    ).href;
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { acquireControlPlaneLifetimeLock } from ${JSON.stringify(moduleUrl)};
          const lock = acquireControlPlaneLifetimeLock(process.env.CONTROL_PLANE_PATH);
          globalThis.controlPlaneLifetimeLock = lock;
          console.log("control-plane-lock-held");
          await new Promise(() => undefined);
        `,
      ],
      {
        env: {
          ...process.env,
          CONTROL_PLANE_PATH: databasePath,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const reader = child.stdout.getReader();
    try {
      const ready = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => {
          throw new Error("Timed out waiting for the child lifetime lock");
        }),
      ]);
      if (
        ready.done ||
        !new TextDecoder().decode(ready.value).includes("control-plane-lock-held")
      ) {
        child.kill("SIGKILL");
        await child.exited;
        const stderr = await new Response(child.stderr).text();
        throw new Error(`Child lifetime lock failed before readiness: ${stderr}`);
      }

      expect(() => acquireControlPlaneLifetimeLock(databasePath)).toThrow(
        expect.objectContaining({ code: "already_running" }),
      );
      expect(await Bun.file(databasePath).exists()).toBeFalse();

      child.kill("SIGKILL");
      await child.exited;

      const retry = acquireControlPlaneLifetimeLock(databasePath);
      expect(await Bun.file(retry.path).exists()).toBeTrue();
      retry.release();
    } finally {
      reader.releaseLock();
      child.kill("SIGKILL");
      await child.exited;
    }
  }, 10_000);
});
