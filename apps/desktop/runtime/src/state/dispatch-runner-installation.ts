import type { Database } from "bun:sqlite";
import {
  runnerBootIdSchema,
  runnerHeartbeatRequestSchema,
  runnerIdSchema,
  runnerInstallationIdSchema,
  type RunnerHeartbeatRequest,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";
import { createHash } from "node:crypto";

const rowSchema = z.object({
  runner_public_id: runnerIdSchema,
  installation_id: runnerInstallationIdSchema,
  boot_id: runnerBootIdSchema,
  boot_generation: z.number().int().positive(),
  accepted_heartbeat_sequence: z.number().int().nonnegative(),
}).strict();

const pendingHeartbeatRowSchema = z.object({
  installation_id: runnerInstallationIdSchema,
  boot_id: runnerBootIdSchema,
  boot_generation: z.number().int().positive(),
  heartbeat_sequence: z.number().int().positive(),
  request_json: z.string().min(2).max(524_288),
}).strict();

export interface DispatchRunnerBoot {
  readonly runnerId: string;
  readonly installationId: string;
  readonly bootId: string;
  readonly bootGeneration: number;
  readonly initialHeartbeatSequence: number;
}

export interface DispatchIdentityRandom {
  bytes(length: number): Uint8Array;
}

/**
 * Convex runner public IDs are globally unique across workspaces. Preserve one
 * installation identity while deriving a stable runner identity for each
 * cloud authority binding, so a prior taskctl workspace cannot capture a
 * promoted HRA workspace's heartbeat.
 */
export function scopedDispatchRunnerId(
  installationIdValue: string,
  authorityScopeValue: string,
): string {
  const installationId = runnerInstallationIdSchema.parse(installationIdValue);
  const authorityScope = z.string().min(1).max(256).parse(authorityScopeValue);
  return runnerIdSchema.parse(
    `runner_${
      createHash("sha256")
        .update("hraness-kitchen-runner-scope-v1\0", "utf8")
        .update(installationId, "utf8")
        .update("\0", "utf8")
        .update(authorityScope, "utf8")
        .digest("hex")
        .slice(0, 48)
    }`,
  );
}

const systemRandom: DispatchIdentityRandom = {
  bytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },
};

export class DispatchRunnerInstallationStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  startBoot(options: {
    readonly now?: Date;
    readonly random?: DispatchIdentityRandom;
  } = {}): DispatchRunnerBoot {
    return this.#database.transaction(() => {
      const current = this.#read();
      if (current !== null && current.accepted_heartbeat_sequence === 0) {
        return bootFromRow(current);
      }
      const now = (options.now ?? new Date()).toISOString();
      const random = options.random ?? systemRandom;
      if (current === null) {
        const runnerId = opaqueId("runner", random.bytes(24));
        const installationId = opaqueId("install", random.bytes(24));
        const bootId = opaqueId("boot", random.bytes(24));
        this.#database.query(`
          INSERT INTO dispatch_runner_installation (
            singleton, runner_public_id, installation_id, boot_id,
            boot_generation, accepted_heartbeat_sequence, created_at, updated_at
          ) VALUES (1, ?1, ?2, ?3, 1, 0, ?4, ?4)
        `).run(runnerId, installationId, bootId, now);
      } else {
        if (current.boot_generation >= Number.MAX_SAFE_INTEGER) {
          throw new RangeError("Dispatch runner boot generation is exhausted");
        }
        this.#database.query(`
          DELETE FROM dispatch_runner_pending_heartbeats
          WHERE installation_id = ?1
        `).run(current.installation_id);
        this.#database.query(`
          UPDATE dispatch_runner_installation SET
            boot_id = ?1,
            boot_generation = ?2,
            accepted_heartbeat_sequence = 0,
            updated_at = ?3
          WHERE singleton = 1 AND boot_generation = ?4
        `).run(
          opaqueId("boot", random.bytes(24)),
          current.boot_generation + 1,
          now,
          current.boot_generation,
        );
      }
      const created = this.#read();
      if (created === null) throw new Error("Dispatch runner installation was not persisted");
      return bootFromRow(created);
    })();
  }

  acknowledgeHeartbeat(input: {
    readonly bootId: string;
    readonly bootGeneration: number;
    readonly sequence: number;
    readonly now?: Date;
  }): void {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
      throw new TypeError("Heartbeat sequence must be positive");
    }
    this.#database.transaction(() => {
      const updated = this.#database.query(`
        UPDATE dispatch_runner_installation SET
          accepted_heartbeat_sequence = ?1,
          updated_at = ?2
        WHERE singleton = 1
          AND boot_id = ?3
          AND boot_generation = ?4
          AND accepted_heartbeat_sequence IN (?5, ?6)
      `).run(
        input.sequence,
        (input.now ?? new Date()).toISOString(),
        input.bootId,
        input.bootGeneration,
        input.sequence - 1,
        input.sequence,
      );
      if (updated.changes !== 1) {
        throw new Error(
          "Heartbeat acknowledgment does not match the active runner boot",
        );
      }
      this.#database.query(`
        DELETE FROM dispatch_runner_pending_heartbeats
        WHERE installation_id = (
          SELECT installation_id
          FROM dispatch_runner_installation
          WHERE singleton = 1
        )
          AND boot_id = ?1
          AND boot_generation = ?2
          AND heartbeat_sequence = ?3
      `).run(input.bootId, input.bootGeneration, input.sequence);
    })();
  }

  pendingHeartbeat(inputValue: Readonly<{
    runnerId: string;
    installationId: string;
    bootId: string;
    bootGeneration: number;
    sequence: number;
  }>): RunnerHeartbeatRequest | null {
    const input = z.object({
      runnerId: runnerIdSchema,
      installationId: runnerInstallationIdSchema,
      bootId: runnerBootIdSchema,
      bootGeneration: z.number().int().positive(),
      sequence: z.number().int().positive(),
    }).strict().parse(inputValue);
    const current = this.#read();
    if (
      current === null ||
      current.installation_id !== input.installationId ||
      current.boot_id !== input.bootId ||
      current.boot_generation !== input.bootGeneration ||
      current.accepted_heartbeat_sequence + 1 !== input.sequence
    ) {
      throw new Error(
        "Pending heartbeat lookup does not match the active runner boot",
      );
    }
    const pending = this.#pending(input.runnerId);
    if (pending === null) return null;
    const request = runnerHeartbeatRequestSchema.parse(
      JSON.parse(pending.request_json) as unknown,
    );
    if (
      pending.installation_id !== input.installationId ||
      pending.boot_id !== input.bootId ||
      pending.boot_generation !== input.bootGeneration ||
      pending.heartbeat_sequence !== input.sequence ||
      request.runnerId !== input.runnerId ||
      request.installationId !== input.installationId ||
      request.bootId !== input.bootId ||
      request.bootGeneration !== input.bootGeneration ||
      request.sequence !== input.sequence
    ) {
      throw new Error(
        "Pending heartbeat does not match the active runner identity",
      );
    }
    return request;
  }

  prepareHeartbeat(
    requestValue: RunnerHeartbeatRequest,
    now: Date = new Date(),
  ): RunnerHeartbeatRequest {
    const request = runnerHeartbeatRequestSchema.parse(requestValue);
    return this.#database.transaction(() => {
      const current = this.#read();
      if (
        current === null ||
        current.installation_id !== request.installationId ||
        current.boot_id !== request.bootId ||
        current.boot_generation !== request.bootGeneration ||
        current.accepted_heartbeat_sequence + 1 !== request.sequence
      ) {
        throw new Error(
          "Prepared heartbeat does not match the active runner boot",
        );
      }
      const requestJson = JSON.stringify(request);
      const existing = this.#pending(request.runnerId);
      if (existing !== null) {
        const replay = runnerHeartbeatRequestSchema.parse(
          JSON.parse(existing.request_json) as unknown,
        );
        if (JSON.stringify(replay) !== requestJson) {
          throw new Error(
            "Prepared heartbeat conflicts with the durable pending request",
          );
        }
        return replay;
      }
      this.#database.query(`
        INSERT INTO dispatch_runner_pending_heartbeats (
          runner_public_id, installation_id, boot_id, boot_generation,
          heartbeat_sequence, request_json, prepared_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `).run(
        request.runnerId,
        request.installationId,
        request.bootId,
        request.bootGeneration,
        request.sequence,
        requestJson,
        now.toISOString(),
      );
      return request;
    })();
  }

  #read(): z.infer<typeof rowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT runner_public_id, installation_id, boot_id, boot_generation,
        accepted_heartbeat_sequence
      FROM dispatch_runner_installation WHERE singleton = 1
    `).get();
    return value === null ? null : rowSchema.parse(value);
  }

  #pending(
    runnerId: string,
  ): z.infer<typeof pendingHeartbeatRowSchema> | null {
    const value: unknown = this.#database.query(`
      SELECT installation_id, boot_id, boot_generation, heartbeat_sequence,
        request_json
      FROM dispatch_runner_pending_heartbeats
      WHERE runner_public_id = ?1
    `).get(runnerId);
    return pendingHeartbeatRowSchema.nullable().parse(value);
  }
}

function opaqueId(prefix: "runner" | "install" | "boot", bytes: Uint8Array): string {
  if (bytes.length < 16 || bytes.length > 48) {
    throw new RangeError("Dispatch identity entropy must contain 16 to 48 bytes");
  }
  const value = `${prefix}_${[...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  switch (prefix) {
    case "runner":
      return runnerIdSchema.parse(value);
    case "install":
      return runnerInstallationIdSchema.parse(value);
    case "boot":
      return runnerBootIdSchema.parse(value);
  }
}

function bootFromRow(row: z.infer<typeof rowSchema>): DispatchRunnerBoot {
  return {
    runnerId: row.runner_public_id,
    installationId: row.installation_id,
    bootId: row.boot_id,
    bootGeneration: row.boot_generation,
    initialHeartbeatSequence: row.accepted_heartbeat_sequence + 1,
  };
}
