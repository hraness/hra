import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ChatExecutionFolderUnavailableError,
  ChatExecutionSettingsStore,
} from "../src/state/chat-execution-settings";
import { applyMigrations } from "../src/state/database";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): Readonly<{
  database: Database;
  home: string;
  documents: string;
  store: ChatExecutionSettingsStore;
}> {
  const home = realpathSync.native(
    mkdtempSync(join(tmpdir(), "hra-execution-settings-")),
  );
  temporaryRoots.push(home);
  const documents = join(home, "Documents");
  mkdirSync(documents);
  const database = new Database(":memory:", { strict: true });
  applyMigrations(database);
  return {
    database,
    home,
    documents,
    store: new ChatExecutionSettingsStore({
      database,
      homeDirectory: home,
      now: () => 1_755_600_000_000,
    }),
  };
}

test("global execution settings default every chat to macOS Documents without projecting its path", () => {
  const { database, documents, store } = fixture();
  try {
    const snapshot = store.read();
    expect(snapshot).toMatchObject({
      revision: 1,
      folderPath: documents,
      projection: {
        revision: 1,
        displayName: "Documents",
        availability: "ready",
      },
    });
    expect(Object.keys(snapshot.projection).toSorted()).toEqual([
      "availability",
      "displayName",
      "revision",
    ]);
    expect(store.requireRuntimeWorkspaceRoots()).toEqual([documents]);
  } finally {
    database.close();
  }
});

test("folder selection canonicalizes once, persists globally, and increments revisions", async () => {
  const { database, home, store } = fixture();
  try {
    const selected = join(home, "Shared Chats");
    mkdirSync(selected);
    const canonicalSelected = realpathSync.native(selected);
    expect(await store.select(selected)).toMatchObject({
      revision: 2,
      folderPath: canonicalSelected,
      projection: {
        revision: 2,
        displayName: "Shared Chats",
        availability: "ready",
      },
    });
    expect((await store.select(selected)).revision).toBe(2);
    expect(new ChatExecutionSettingsStore({
      database,
      homeDirectory: home,
    }).read()).toMatchObject({ revision: 2, folderPath: canonicalSelected });
  } finally {
    database.close();
  }
});

test("a disappeared global folder is pathlessly reported and fails chat admission closed", async () => {
  const { database, home, documents, store } = fixture();
  try {
    renameSync(documents, join(home, "Documents moved"));
    expect(store.read().projection).toEqual({
      revision: 1,
      displayName: "Documents",
      availability: "missing",
    });
    expect(() => store.requireRuntimeWorkspaceRoots()).toThrow(
      ChatExecutionFolderUnavailableError,
    );
    expect(await store.select(join(home, "absent")).then(
      () => null,
      (error: unknown) => error,
    )).toBeInstanceOf(ChatExecutionFolderUnavailableError);
  } finally {
    database.close();
  }
});

test("folder selection cannot commit across an admitted old-root provider turn", async () => {
  const { database, home, documents, store } = fixture();
  try {
    const selected = join(home, "New Shared Root");
    mkdirSync(selected);
    const admission = await store.acquireRuntimeWorkspaceAdmission();
    expect(admission).toMatchObject({
      revision: 1,
      runtimeWorkspaceRoots: [documents],
    });
    let selectionSettled = false;
    const selection = store.select(selected).finally(() => {
      selectionSettled = true;
    });
    await Promise.resolve();
    expect(selectionSettled).toBe(false);
    expect(store.read().revision).toBe(1);

    admission.release();
    expect(await selection).toMatchObject({
      revision: 2,
      folderPath: realpathSync.native(selected),
    });
    expect(selectionSettled).toBe(true);
  } finally {
    database.close();
  }
});

test("replacing the selected directory with a symlink preserves revision and fails closed", () => {
  const { database, home, documents, store } = fixture();
  try {
    const moved = join(home, "Original Documents");
    const replacement = join(home, "Replacement Documents");
    mkdirSync(replacement);
    renameSync(documents, moved);
    symlinkSync(replacement, documents, "dir");

    expect(store.read()).toMatchObject({
      revision: 1,
      folderPath: documents,
      projection: {
        revision: 1,
        displayName: "Documents",
        availability: "missing",
      },
    });
    expect(() => store.requireRuntimeWorkspaceRoots()).toThrow(
      ChatExecutionFolderUnavailableError,
    );
    expect(store.read().revision).toBe(1);
  } finally {
    database.close();
  }
});
