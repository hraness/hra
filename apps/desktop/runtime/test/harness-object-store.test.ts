import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HarnessImmutableObjectStore,
  harnessObjectDigest,
} from "../src/harness/object-store";
import {
  assertHarnessDirectoryIdentity,
  HarnessStoragePathError,
  prepareHarnessStorageLayout,
} from "../src/harness/storage-layout";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function fixture(): Promise<{
  readonly controlPlanePath: string;
  readonly root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "oprte-harness-objects-"));
  temporaryRoots.push(root);
  const applicationSupport = join(root, "OPRTE");
  await mkdir(applicationSupport, { mode: 0o700 });
  const controlPlanePath = join(applicationSupport, "control-plane.sqlite");
  await writeFile(controlPlanePath, "sqlite fixture", { mode: 0o600 });
  return { controlPlanePath, root };
}

function suffix(byte: number): () => Uint8Array {
  return () => new Uint8Array(12).fill(byte);
}

describe("harness storage layout", () => {
  test("derives and creates one private fixed tree from the control-plane path", async () => {
    const { controlPlanePath } = await fixture();
    const layout = prepareHarnessStorageLayout(controlPlanePath);
    expect(layout.root).toBe(join(
      controlPlanePath.slice(0, -"control-plane.sqlite".length),
      "harness",
      "v1",
    ));
    for (const path of [
      layout.root,
      layout.objects,
      layout.heap,
      layout.contextValues,
      layout.lanesRoot,
      layout.scratch,
    ]) {
      const metadata = await stat(path);
      expect(metadata.isDirectory()).toBeTrue();
      expect(metadata.mode & 0o777).toBe(0o700);
    }
    const lanesMetadata = await stat(layout.lanesRoot, { bigint: true });
    expect(layout.lanesRootIdentity).toEqual({
      device: lanesMetadata.dev,
      inode: lanesMetadata.ino,
      owner: Number(lanesMetadata.uid),
      path: layout.lanesRoot,
    });
    expect(() => assertHarnessDirectoryIdentity(layout.lanesRootIdentity))
      .not.toThrow();
  });

  test("retains a lanes-root identity that rejects path replacement", async () => {
    const { controlPlanePath } = await fixture();
    const layout = prepareHarnessStorageLayout(controlPlanePath);
    const displaced = join(layout.root, "displaced-worktrees");
    await rename(layout.lanesRoot, displaced);
    await symlink(displaced, layout.lanesRoot);

    expect(() => assertHarnessDirectoryIdentity(layout.lanesRootIdentity)).toThrow(
      expect.objectContaining({ code: "unsafe_directory" }),
    );
  });

  test("rejects redirected and group-readable owned roots", async () => {
    const first = await fixture();
    const outside = join(first.root, "outside");
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(first.root, "OPRTE", "harness"));
    expect(() => prepareHarnessStorageLayout(first.controlPlanePath)).toThrow(
      HarnessStoragePathError,
    );

    const second = await fixture();
    await chmod(join(second.root, "OPRTE"), 0o750);
    expect(() => prepareHarnessStorageLayout(second.controlPlanePath)).toThrow(
      expect.objectContaining({ code: "unsafe_directory" }),
    );
  });
});

describe("immutable harness object store", () => {
  test("publishes exact bytes once and verifies mode, link count, and digest", async () => {
    const { controlPlanePath } = await fixture();
    const layout = prepareHarnessStorageLayout(controlPlanePath);
    const store = new HarnessImmutableObjectStore({
      directory: layout.heap,
      randomSuffix: suffix(1),
    });
    const bytes = Buffer.from("ciphertext envelope fixture", "utf8");
    const digest = harnessObjectDigest(bytes);

    expect(store.publish(bytes)).toEqual({
      byteLength: bytes.byteLength,
      digest,
      state: "created",
    });
    expect(store.publish(bytes)).toEqual({
      byteLength: bytes.byteLength,
      digest,
      state: "existing",
    });
    expect(store.read(digest)).toEqual(Uint8Array.from(bytes));
    expect(await readdir(layout.heap)).toEqual([digest]);
    const metadata = await stat(join(layout.heap, digest));
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
  });

  test("recovers candidates from crashes before and after atomic publication", async () => {
    const { controlPlanePath } = await fixture();
    const layout = prepareHarnessStorageLayout(controlPlanePath);
    const bytes = Buffer.from("recoverable encrypted object", "utf8");
    const digest = harnessObjectDigest(bytes);
    const encodedSuffix = Buffer.from(new Uint8Array(12).fill(2))
      .toString("base64url");
    const candidate = join(
      layout.heap,
      `.candidate-v1-${digest}-${encodedSuffix}`,
    );
    // A crash during write may leave a private, single-link partial candidate.
    // It was never published and is safe to discard after identity validation.
    await writeFile(candidate, bytes.subarray(0, 7), { mode: 0o600 });

    const beforeLink = new HarnessImmutableObjectStore({
      directory: layout.heap,
      randomSuffix: suffix(3),
    });
    expect(await readdir(layout.heap)).toEqual([]);
    expect(beforeLink.publish(bytes).state).toBe("created");

    expect(beforeLink.remove(digest).state).toBe("removed");
    await writeFile(candidate, bytes, { mode: 0o600 });
    await link(candidate, join(layout.heap, digest));
    expect((await stat(candidate)).nlink).toBe(2);
    const afterLink = new HarnessImmutableObjectStore({
      directory: layout.heap,
      randomSuffix: suffix(4),
    });
    expect(await readdir(layout.heap)).toEqual([digest]);
    expect((await stat(join(layout.heap, digest))).nlink).toBe(1);
    expect(afterLink.read(digest)).toEqual(Uint8Array.from(bytes));
  });

  test("fails closed for symlinks, hard links, relaxed modes, and mutation", async () => {
    const symlinkFixture = await fixture();
    const symlinkLayout = prepareHarnessStorageLayout(
      symlinkFixture.controlPlanePath,
    );
    const bytes = Buffer.from("immutable ciphertext", "utf8");
    const digest = harnessObjectDigest(bytes);
    const outside = join(symlinkFixture.root, "outside-object");
    await writeFile(outside, bytes, { mode: 0o600 });
    await symlink(outside, join(symlinkLayout.heap, digest));
    expect(() => new HarnessImmutableObjectStore({
      directory: symlinkLayout.heap,
    }).publish(bytes)).toThrow(expect.objectContaining({ code: "unsafe_object" }));

    const hardLinkFixture = await fixture();
    const hardLinkLayout = prepareHarnessStorageLayout(
      hardLinkFixture.controlPlanePath,
    );
    const hardLinkOutside = join(hardLinkFixture.root, "outside-hard-link");
    await writeFile(hardLinkOutside, bytes, { mode: 0o600 });
    await link(hardLinkOutside, join(hardLinkLayout.heap, digest));
    const hardLinkStore = new HarnessImmutableObjectStore({
      directory: hardLinkLayout.heap,
    });
    expect(() => hardLinkStore.read(digest)).toThrow(
      expect.objectContaining({ code: "unsafe_object" }),
    );

    const mutationFixture = await fixture();
    const mutationLayout = prepareHarnessStorageLayout(
      mutationFixture.controlPlanePath,
    );
    const mutationStore = new HarnessImmutableObjectStore({
      directory: mutationLayout.heap,
    });
    mutationStore.publish(bytes);
    await chmod(join(mutationLayout.heap, digest), 0o644);
    expect(() => mutationStore.read(digest)).toThrow(
      expect.objectContaining({ code: "unsafe_object" }),
    );
    await chmod(join(mutationLayout.heap, digest), 0o600);
    await writeFile(join(mutationLayout.heap, digest), "mutated", {
      mode: 0o600,
    });
    expect(() => mutationStore.read(digest)).toThrow(
      expect.objectContaining({ code: "object_tampered" }),
    );
  });

  test("removes only a fully verified digest and makes absence observable", async () => {
    const { controlPlanePath } = await fixture();
    const layout = prepareHarnessStorageLayout(controlPlanePath);
    const store = new HarnessImmutableObjectStore({ directory: layout.heap });
    const bytes = Buffer.from("delete exact ciphertext", "utf8");
    const digest = store.publish(bytes).digest;
    expect(store.remove(digest)).toEqual({ digest, state: "removed" });
    expect(store.remove(digest)).toEqual({ digest, state: "missing" });
    expect(() => store.read(digest)).toThrow(
      expect.objectContaining({ code: "object_missing" }),
    );
    expect(() => store.remove("../outside")).toThrow(
      expect.objectContaining({ code: "invalid_digest" }),
    );
  });
});
