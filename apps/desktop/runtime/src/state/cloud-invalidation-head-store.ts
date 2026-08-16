import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

const headRowSchema = z
  .object({
    account_user_id: z.string().min(1).max(256),
    credential_generation: z.number().int().nonnegative().safe(),
    projection_head: z.number().int().nonnegative().safe(),
  })
  .strict();

/**
 * Token-free resume point for a cloud workspace invalidation stream. A row
 * owned by another human principal is never reused.
 */
export class CloudInvalidationHeadStore {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  read(workspaceId: string, accountUserId: string): number {
    const value: unknown = this.#database.query(`
      SELECT account_user_id, credential_generation, projection_head
      FROM cloud_invalidation_heads
      WHERE workspace_id = ?1
    `).get(workspaceId);
    const row = headRowSchema.nullable().parse(value);
    return row === null || row.account_user_id !== accountUserId
      ? 0
      : row.projection_head;
  }

  advance(input: {
    readonly workspaceId: string;
    readonly accountUserId: string;
    readonly credentialGeneration: number;
    readonly projectionHead: number;
    readonly now?: number;
  }): void {
    const now = input.now ?? Date.now();
    for (const value of [
      input.credentialGeneration,
      input.projectionHead,
      now,
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("Cloud invalidation head values must be nonnegative.");
      }
    }
    this.#database.query(`
      INSERT INTO cloud_invalidation_heads(
        workspace_id, account_user_id, credential_generation,
        projection_head, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(workspace_id) DO UPDATE SET
        account_user_id = excluded.account_user_id,
        credential_generation = excluded.credential_generation,
        projection_head = CASE
          WHEN cloud_invalidation_heads.account_user_id =
            excluded.account_user_id
          THEN max(
            cloud_invalidation_heads.projection_head,
            excluded.projection_head
          )
          ELSE excluded.projection_head
        END,
        updated_at = excluded.updated_at
    `).run(
      input.workspaceId,
      input.accountUserId,
      input.credentialGeneration,
      input.projectionHead,
      now,
    );
  }
}
