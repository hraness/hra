import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LegacySecretReader } from "../src/storage/legacy-secret-migration";
import { resolveStatePaths } from "../src/storage/paths";
import { DaemonAuthorityBusyError, DaemonLock } from "../src/daemon/daemon-lock";
import {
  executeLegacySecretMigrationOperator,
  parseLegacySecretMigrationArguments,
} from "./migrate-legacy-secrets";

class RecordingLegacyReader implements LegacySecretReader {
  calls = 0;
  value: string | null;

  constructor(value: string | null) {
    this.value = value;
  }

  async get(): Promise<string | null> {
    this.calls += 1;
    return this.value;
  }
}

class GatedLegacyReader implements LegacySecretReader {
  calls = 0;
  readonly entered: Promise<void>;
  readonly #value: string;
  readonly #gate: Promise<void>;
  #enter!: () => void;
  #release!: () => void;

  constructor(value: string) {
    this.#value = value;
    this.entered = new Promise<void>((resolve) => { this.#enter = resolve; });
    this.#gate = new Promise<void>((resolve) => { this.#release = resolve; });
  }

  release(): void {
    this.#release();
  }

  async get(): Promise<string> {
    this.calls += 1;
    this.#enter();
    await this.#gate;
    return this.#value;
  }
}

const output = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write: ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as NodeJS.WriteStream["write"],
});

describe("legacy secret migration operator", () => {
  test("wires the exact repository-only command and daemon-fallback boundary", async () => {
    const packageDocument = JSON.parse(await readFile(
      join(import.meta.dir, "..", "package.json"),
      "utf8",
    )) as { scripts?: Record<string, unknown> };
    const runbook = await readFile(
      join(import.meta.dir, "..", "docs", "hosted-sync.md"),
      "utf8",
    );

    expect(packageDocument.scripts?.["operator:migrate-legacy-secrets"])
      .toBe("bun ./scripts/migrate-legacy-secrets.ts");
    expect(runbook).toContain("bun run operator:migrate-legacy-secrets preflight");
    expect(runbook).toContain("bun run operator:migrate-legacy-secrets --execute");
    expect(runbook).toContain("repository-operator migration for staged prerelease state");
    expect(runbook).toContain("not an installed-product feature, a daemon fallback");
  });

  test("requires one explicit read-only or mutating operation", () => {
    expect(parseLegacySecretMigrationArguments(["preflight"])).toBe("preflight");
    expect(parseLegacySecretMigrationArguments(["--execute"])).toBe("execute");
    expect(() => parseLegacySecretMigrationArguments([])).toThrow("usage_invalid");
    expect(() => parseLegacySecretMigrationArguments(["execute"])).toThrow("usage_invalid");
    expect(() => parseLegacySecretMigrationArguments(["preflight", "--execute"]))
      .toThrow("usage_invalid");
  });

  test("preflight performs zero Keychain or file mutations and emits a closed action", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-migration-operator-")));
    const paths = resolveStatePaths({ rootDirectory: root });
    const metadataRoot = join(root, "secret-metadata");
    const nonce = "88888888-8888-4888-8888-888888888888";
    const value = "operator-private-value";
    const digest = createHash("sha256").update(value).digest("hex");
    const pointerPath = join(metadataRoot, "cloud-auth.json");
    await mkdir(metadataRoot, { mode: 0o700 });
    await writeFile(
      pointerPath,
      JSON.stringify({ version: 1, generation: 0, nonce, digest }),
      { mode: 0o600 },
    );
    const legacy = new RecordingLegacyReader(value);
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      expect(await executeLegacySecretMigrationOperator({
        arguments: ["preflight"],
        legacyReader: legacy,
        paths,
        platform: "darwin",
        stderr: output(stderr),
        stdout: output(stdout),
      })).toBe(0);
      expect(legacy.calls).toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout).toEqual([
        `${JSON.stringify({
          copiesPending: 1,
          copiesPresent: 0,
          copiesRequired: 1,
          nextAction: "execute_migration",
          schemaVersion: 1,
          status: "ready",
        })}\n`,
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("execute copies and proves the value without rendering secret metadata", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-migration-operator-")));
    const paths = resolveStatePaths({ rootDirectory: root });
    const metadataRoot = join(root, "secret-metadata");
    const nonce = "99999999-9999-4999-8999-999999999999";
    const value = "never-render-this-value";
    const digest = createHash("sha256").update(value).digest("hex");
    const account = `cloud-auth.0.${nonce}`;
    await mkdir(metadataRoot, { mode: 0o700 });
    await writeFile(
      join(metadataRoot, "cloud-auth.json"),
      JSON.stringify({ version: 1, generation: 0, nonce, digest }),
      { mode: 0o600 },
    );
    const legacy = new RecordingLegacyReader(value);
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      expect(await executeLegacySecretMigrationOperator({
        arguments: ["--execute"],
        legacyReader: legacy,
        paths,
        platform: "darwin",
        stderr: output(stderr),
        stdout: output(stdout),
      })).toBe(0);
      expect(legacy.calls).toBe(1);
      expect(stderr).toEqual([]);
      expect(stdout).toEqual([
        `${JSON.stringify({
          copiesPresent: 1,
          copiesRequired: 1,
          legacyEntriesRetained: true,
          schemaVersion: 1,
          status: "migrated",
        })}\n`,
      ]);
      const rendered = [...stdout, ...stderr].join("");
      for (const forbidden of [root, value, digest, nonce, account]) {
        expect(rendered).not.toContain(forbidden);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a missing Keychain value returns only a stable refusal code", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-migration-operator-")));
    const paths = resolveStatePaths({ rootDirectory: root });
    const metadataRoot = join(root, "secret-metadata");
    const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const value = "missing-private-value";
    const digest = createHash("sha256").update(value).digest("hex");
    await mkdir(metadataRoot, { mode: 0o700 });
    await writeFile(
      join(metadataRoot, "cloud-auth.json"),
      JSON.stringify({ version: 1, generation: 0, nonce, digest }),
      { mode: 0o600 },
    );
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      expect(await executeLegacySecretMigrationOperator({
        arguments: ["--execute"],
        legacyReader: new RecordingLegacyReader(null),
        paths,
        platform: "darwin",
        stderr: output(stderr),
        stdout: output(stdout),
      })).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        `${JSON.stringify({
          code: "legacy_value_missing",
          schemaVersion: 1,
          status: "refused",
        })}\n`,
      ]);
      const rendered = stderr.join("");
      for (const forbidden of [root, value, digest, nonce, "cloud-auth.0"]) {
        expect(rendered).not.toContain(forbidden);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("execute refuses before Keychain access while a live daemon owns authority", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-migration-operator-")));
    const paths = resolveStatePaths({ rootDirectory: root });
    const metadataRoot = join(root, "secret-metadata");
    const value = "daemon-owned-value";
    await mkdir(metadataRoot, { mode: 0o700 });
    await writeFile(join(metadataRoot, "cloud-auth.json"), JSON.stringify({
      version: 1,
      generation: 0,
      nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      digest: createHash("sha256").update(value).digest("hex"),
    }), { mode: 0o600 });
    const daemon = await DaemonLock.acquire(paths);
    const legacy = new RecordingLegacyReader(value);
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      expect(await executeLegacySecretMigrationOperator({
        arguments: ["--execute"],
        legacyReader: legacy,
        paths,
        platform: "darwin",
        stderr: output(stderr),
        stdout: output(stdout),
      })).toBe(1);
      expect(legacy.calls).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        `${JSON.stringify({ code: "daemon_running", schemaVersion: 1, status: "refused" })}\n`,
      ]);
    } finally {
      await daemon.release();
      await rm(root, { force: true, recursive: true });
    }
  });

  test("holds daemon lifecycle authority across the Keychain read and every copy", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-migration-operator-")));
    const paths = resolveStatePaths({ rootDirectory: root });
    const metadataRoot = join(root, "secret-metadata");
    const value = "authority-fenced-value";
    await mkdir(metadataRoot, { mode: 0o700 });
    await writeFile(join(metadataRoot, "cloud-auth.json"), JSON.stringify({
      version: 1,
      generation: 0,
      nonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      digest: createHash("sha256").update(value).digest("hex"),
    }), { mode: 0o600 });
    const legacy = new GatedLegacyReader(value);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const execution = executeLegacySecretMigrationOperator({
      arguments: ["--execute"],
      legacyReader: legacy,
      paths,
      platform: "darwin",
      stderr: output(stderr),
      stdout: output(stdout),
    });
    try {
      await legacy.entered;
      await expect(DaemonLock.acquire(paths)).rejects.toBeInstanceOf(
        DaemonAuthorityBusyError,
      );
      legacy.release();
      expect(await execution).toBe(0);
      expect(legacy.calls).toBe(1);
      expect(stderr).toEqual([]);
      const nextDaemon = await DaemonLock.acquire(paths);
      await nextDaemon.release();
    } finally {
      legacy.release();
      await execution.catch(() => 1);
      await rm(root, { force: true, recursive: true });
    }
  });
});
