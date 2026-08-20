import type { Database } from "bun:sqlite";
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize } from "node:path";
import { z } from "@hra-internal/schema";

import {
  executionFolderAccessProjectionSchema,
  type ExecutionFolderAccessProjection,
} from "../../../contracts/runtime";

const maximumFolderPathUtf8Bytes = 4_096;
const maximumDisplayNameUtf8Bytes = 160;

const executionSettingsRowSchema = z.object({
  revision: z.number().int().positive().safe(),
  folder_path: z.string().min(1),
}).strict();

export class ChatExecutionFolderUnavailableError extends Error {
  constructor(message = "The shared chat folder is unavailable. Choose an accessible folder in HRA.") {
    super(message);
    this.name = "ChatExecutionFolderUnavailableError";
  }
}

export interface ChatExecutionSettingsSnapshot {
  readonly revision: number;
  /** Gateway-private canonical path. Never include this value in renderer contracts. */
  readonly folderPath: string;
  readonly projection: ExecutionFolderAccessProjection;
}

export interface ChatExecutionWorkspaceAdmission {
  readonly revision: number;
  readonly runtimeWorkspaceRoots: readonly [string];
  release(): void;
}

interface ExecutionSettingsBarrierWaiter {
  readonly kind: "reader" | "writer";
  readonly resolve: () => void;
}

/**
 * Device-local authority for the one filesystem root shared by every chat.
 * Only the pathless projection may cross the Native/renderer boundary.
 */
export class ChatExecutionSettingsStore {
  readonly #database: Database;
  readonly #defaultFolderPath: string;
  readonly #now: () => number;
  readonly #barrierQueue: ExecutionSettingsBarrierWaiter[] = [];
  #activeBarrierReaders = 0;
  #activeBarrierWriter = false;

  constructor(options: {
    readonly database: Database;
    readonly homeDirectory: string;
    readonly now?: () => number;
  }) {
    if (!isAbsolute(options.homeDirectory)) {
      throw new TypeError("The execution-settings home directory must be absolute.");
    }
    this.#database = options.database;
    const canonicalHome = canonicalExistingDirectory(options.homeDirectory);
    this.#defaultFolderPath = canonicalStoredDefaultFolder(
      join(canonicalHome, "Documents"),
    );
    this.#now = options.now ?? Date.now;
    this.#bootstrap();
  }

  read(): ChatExecutionSettingsSnapshot {
    const row = this.#readRow();
    const availability = storedFolderIdentityIsAccessible(row.folder_path)
      ? "ready"
      : "missing";
    return {
      revision: row.revision,
      folderPath: row.folder_path,
      projection: executionFolderAccessProjectionSchema.parse({
        revision: row.revision,
        displayName: displayNameForFolder(row.folder_path),
        availability,
      }),
    };
  }

  async select(folderPath: string): Promise<ChatExecutionSettingsSnapshot> {
    await this.#acquireBarrier("writer");
    try {
      // Resolve only after acquiring the writer barrier. A chooser result may
      // have been replaced while it waited behind an admitted turn.
      const canonicalFolderPath = canonicalAccessibleDirectory(folderPath);
      this.#database.transaction(() => {
        const current = this.#readRow();
        if (current.folder_path === canonicalFolderPath) return;
        const updated = this.#database.query(`
          UPDATE chat_execution_settings
          SET revision = revision + 1, folder_path = ?1, updated_at = ?2
          WHERE singleton = 1 AND revision = ?3
        `).run(canonicalFolderPath, this.#now(), current.revision);
        if (updated.changes !== 1) {
          throw new Error("The shared chat folder changed concurrently.");
        }
      })();
      return this.read();
    } finally {
      this.#releaseBarrier("writer");
    }
  }

  requireRuntimeWorkspaceRoots(): readonly [string] {
    return this.requireRuntimeWorkspaceSnapshot().runtimeWorkspaceRoots;
  }

  requireRuntimeWorkspaceSnapshot(): Readonly<{
    revision: number;
    runtimeWorkspaceRoots: readonly [string];
  }> {
    const snapshot = this.read();
    if (snapshot.projection.availability !== "ready") {
      throw new ChatExecutionFolderUnavailableError();
    }
    const runtimeWorkspaceRoots = Object.freeze<readonly [string]>([
      snapshot.folderPath,
    ]);
    return Object.freeze({
      revision: snapshot.revision,
      runtimeWorkspaceRoots,
    });
  }

  async acquireRuntimeWorkspaceAdmission(): Promise<ChatExecutionWorkspaceAdmission> {
    await this.#acquireBarrier("reader");
    let released = false;
    try {
      const snapshot = this.requireRuntimeWorkspaceSnapshot();
      return Object.freeze({
        revision: snapshot.revision,
        runtimeWorkspaceRoots: snapshot.runtimeWorkspaceRoots,
        release: () => {
          if (released) return;
          released = true;
          this.#releaseBarrier("reader");
        },
      });
    } catch (error: unknown) {
      this.#releaseBarrier("reader");
      throw error;
    }
  }

  #bootstrap(): void {
    this.#database.query(`
      INSERT INTO chat_execution_settings(
        singleton, revision, folder_path, updated_at
      ) VALUES (1, 1, ?1, ?2)
      ON CONFLICT(singleton) DO NOTHING
    `).run(this.#defaultFolderPath, this.#now());
    this.#readRow();
  }

  #readRow(): z.infer<typeof executionSettingsRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT revision, folder_path
      FROM chat_execution_settings
      WHERE singleton = 1
    `).get();
    const row = executionSettingsRowSchema.parse(value);
    parseStoredFolderPath(row.folder_path);
    return row;
  }

  #acquireBarrier(kind: ExecutionSettingsBarrierWaiter["kind"]): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#barrierQueue.push({ kind, resolve });
      this.#drainBarrier();
    });
  }

  #releaseBarrier(kind: ExecutionSettingsBarrierWaiter["kind"]): void {
    if (kind === "writer") {
      if (!this.#activeBarrierWriter) throw new Error("Execution writer barrier underflow.");
      this.#activeBarrierWriter = false;
    } else {
      if (this.#activeBarrierReaders <= 0) {
        throw new Error("Execution reader barrier underflow.");
      }
      this.#activeBarrierReaders -= 1;
    }
    this.#drainBarrier();
  }

  #drainBarrier(): void {
    if (this.#activeBarrierWriter) return;
    if (this.#activeBarrierReaders > 0) {
      // Readers that arrive before a queued writer share the current folder
      // generation. Once a writer is at the head, later readers wait behind
      // it so an old-root turn cannot starve a committed selection forever.
      while (this.#barrierQueue[0]?.kind === "reader") {
        const reader = this.#barrierQueue.shift();
        if (reader === undefined) break;
        this.#activeBarrierReaders += 1;
        reader.resolve();
      }
      return;
    }
    const first = this.#barrierQueue[0];
    if (first === undefined) return;
    if (first.kind === "writer") {
      this.#barrierQueue.shift();
      this.#activeBarrierWriter = true;
      first.resolve();
      return;
    }
    const readers: ExecutionSettingsBarrierWaiter[] = [];
    while (this.#barrierQueue[0]?.kind === "reader") {
      const reader = this.#barrierQueue.shift();
      if (reader !== undefined) readers.push(reader);
    }
    this.#activeBarrierReaders = readers.length;
    for (const reader of readers) reader.resolve();
  }
}

function parseStoredFolderPath(value: string): string {
  if (
    !isAbsolute(value)
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximumFolderPathUtf8Bytes
  ) {
    throw new TypeError("The shared chat folder path is invalid.");
  }
  const normalized = normalize(value);
  if (normalized !== value) {
    throw new TypeError("The shared chat folder path is not normalized.");
  }
  return value;
}

function canonicalAccessibleDirectory(value: string): string {
  const candidate = parseStoredFolderPath(value);
  let canonical: string;
  try {
    canonical = realpathSync.native(candidate);
  } catch {
    throw new ChatExecutionFolderUnavailableError(
      "The selected shared chat folder does not exist or cannot be resolved.",
    );
  }
  parseStoredFolderPath(canonical);
  if (!folderIsAccessible(canonical)) {
    throw new ChatExecutionFolderUnavailableError(
      "The selected shared chat folder is not readable and writable.",
    );
  }
  return canonical;
}

function canonicalExistingDirectory(value: string): string {
  const canonical = canonicalAccessibleDirectory(value);
  if (!statSync(canonical).isDirectory()) {
    throw new TypeError("The execution-settings home directory is not a directory.");
  }
  return canonical;
}

function canonicalStoredDefaultFolder(value: string): string {
  const candidate = parseStoredFolderPath(value);
  try {
    return parseStoredFolderPath(realpathSync.native(candidate));
  } catch {
    return candidate;
  }
}

function folderIsAccessible(folderPath: string): boolean {
  try {
    if (!statSync(folderPath).isDirectory()) return false;
    accessSync(folderPath, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The selected capability is the exact canonical directory identity stored at
 * selection time. Re-resolve it on every read so replacing that path with a
 * symlink cannot silently redirect every chat's full-access root.
 */
function storedFolderIdentityIsAccessible(folderPath: string): boolean {
  try {
    return realpathSync.native(folderPath) === folderPath &&
      folderIsAccessible(folderPath);
  } catch {
    return false;
  }
}

function displayNameForFolder(folderPath: string): string {
  const raw = [...basename(folderPath)].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? "�"
      : character;
  }).join("");
  const fallback = raw.length === 0 ? "Folder" : raw;
  let result = "";
  for (const character of fallback) {
    if (Buffer.byteLength(result + character, "utf8") > maximumDisplayNameUtf8Bytes) break;
    result += character;
  }
  return result.length === 0 ? "Folder" : result;
}
