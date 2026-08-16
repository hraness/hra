import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";
import { randomBytes } from "node:crypto";
import {
  accountProfileIdSchema,
  revisionSchema,
  runtimeAccountProfileLimit,
  runtimeRetainedAccountLocalDataLimit,
  type AccountSummary,
} from "../../../contracts/runtime";

const authStateSchema = z.enum([
  "signedOut",
  "signingIn",
  "signingOut",
  "signedIn",
  "expired",
  "unknown",
]);
const labelSchema = z.string().min(1).max(80);
const identityLabelSchema = z.string().min(1).max(160).nullable();
const planLabelSchema = z.string().min(1).max(80).nullable();
const processGenerationSchema = z.number().int().safe().nonnegative();
const timestampSchema = z.string().datetime();

const accountProfileRowSchema = z
  .object({
    profile_id: accountProfileIdSchema,
    revision: revisionSchema,
    label: labelSchema,
    selected: z.union([z.literal(0), z.literal(1)]),
    identity_label: identityLabelSchema,
    plan_label: planLabelSchema,
    auth_state: authStateSchema,
    process_generation: processGenerationSchema,
    created_at: timestampSchema,
    updated_at: timestampSchema,
    removed_at: timestampSchema.nullable(),
    local_data_deleted_at: timestampSchema.nullable(),
  })
  .strict();

const countRowSchema = z.object({ count: z.number().int().safe().nonnegative() }).strict();
const mutableColumnSchema = z.enum([
  "identity_label",
  "auth_state",
  "plan_label",
]);

type AccountAuthState = AccountSummary["authState"];
type MutableColumn = z.infer<typeof mutableColumnSchema>;
type MutableValue = string | null;

export interface StoredAccountProfile {
  readonly id: string;
  readonly revision: number;
  readonly label: string;
  readonly selected: boolean;
  readonly identityLabel: string | null;
  readonly planLabel: string | null;
  readonly authState: AccountAuthState;
  readonly processGeneration: number;
  readonly localDataState: "present" | "deleted";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly removedAt: string | null;
  readonly localDataDeletedAt: string | null;
}

export interface AccountProcessGenerationUpdate {
  readonly advanced: boolean;
  readonly profile: StoredAccountProfile;
}

export interface AccountSelectionResult {
  readonly selected: StoredAccountProfile;
  readonly deselected: StoredAccountProfile | null;
}

export interface StoredAccountRemovalPreview {
  readonly accountProfileId: string;
  readonly accountRevision: number;
  readonly label: string;
  readonly threadCount: number;
  readonly workspaceLaneCount: number;
  readonly localDataState: "present" | "deleted";
}

export interface AccountTombstoneResult {
  readonly removed: StoredAccountProfile;
  readonly selectedReplacement: StoredAccountProfile | null;
}

export interface AccountProfileStoreOptions {
  readonly idFactory?: () => string;
}

export class AccountProfileNotFound extends Error {
  readonly accountProfileId: string;

  constructor(accountProfileId: string) {
    super(`Active account profile not found: ${accountProfileId}`);
    this.name = "AccountProfileNotFound";
    this.accountProfileId = accountProfileId;
  }
}

export class AccountProfileStaleRevision extends Error {
  readonly accountProfileId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(accountProfileId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Stale account profile revision for ${accountProfileId}: expected ${String(expectedRevision)}, current ${String(actualRevision)}`,
    );
    this.name = "AccountProfileStaleRevision";
    this.accountProfileId = accountProfileId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class AccountProfileGenerationRegression extends Error {
  constructor(accountProfileId: string, currentGeneration: number, nextGeneration: number) {
    super(
      `Account profile ${accountProfileId} process generation cannot regress from ${String(currentGeneration)} to ${String(nextGeneration)}`,
    );
    this.name = "AccountProfileGenerationRegression";
  }
}

export class AccountProfileCapacityExceeded extends Error {
  readonly capacity: "active" | "recoverable" | "retainedLocalData";

  constructor(capacity: "active" | "recoverable" | "retainedLocalData") {
    super(
      capacity === "active"
        ? "The active account profile capacity is full."
        : capacity === "recoverable"
        ? "The recoverable account profile capacity is full."
        : "The retained account local-data capacity is full.",
    );
    this.name = "AccountProfileCapacityExceeded";
    this.capacity = capacity;
  }
}

export class AccountProfileStore {
  readonly #database: Database;
  readonly #idFactory: () => string;

  constructor(database: Database, options: AccountProfileStoreOptions = {}) {
    this.#database = database;
    this.#idFactory = options.idFactory ?? createAccountProfileId;
  }

  create(label: string, now = new Date()): StoredAccountProfile {
    const validatedLabel = labelSchema.parse(label);
    const accountProfileId = accountProfileIdSchema.parse(this.#idFactory());
    const createdAt = toTimestamp(now);

    return this.#database.transaction(() => {
      this.#requireCapacity(
        "recoverable",
        `SELECT COUNT(*) AS count FROM account_profile_capacity_quarantine`,
        1,
      );
      this.#requireCapacity(
        "active",
        `SELECT COUNT(*) AS count FROM account_profiles WHERE removed_at IS NULL`,
        runtimeAccountProfileLimit,
      );
      // A failed profile-directory effect must be tombstoned rather than
      // forgotten. Capping the combined live/retained set preserves that
      // recovery slot across concurrent creates and removals.
      this.#requireCapacity(
        "recoverable",
        `SELECT COUNT(*) AS count FROM account_profiles
         WHERE removed_at IS NULL
            OR (removed_at IS NOT NULL AND local_data_deleted_at IS NULL)`,
        runtimeAccountProfileLimit,
      );
      const selected = this.#selected() === null ? 1 : 0;
      this.#database
        .query(
          `INSERT INTO account_profiles
            (profile_id, label, auth_state, process_generation, created_at, updated_at,
             revision, selected)
           VALUES (?1, ?2, 'unknown', 0, ?3, ?3, 1, ?4)`,
        )
        .run(accountProfileId, validatedLabel, createdAt, selected);
      return this.#requireAny(accountProfileId);
    }).immediate();
  }

  list(): readonly StoredAccountProfile[] {
    const value: unknown = this.#database
      .query(`${accountSelect} WHERE removed_at IS NULL ORDER BY selected DESC, created_at, profile_id`)
      .all();
    return z.array(accountProfileRowSchema)
      .max(runtimeAccountProfileLimit)
      .parse(value)
      .map(fromRow);
  }

  listAll(): readonly StoredAccountProfile[] {
    const value: unknown = this.#database
      .query(`${accountSelect} ORDER BY created_at, profile_id`)
      .all();
    return z.array(accountProfileRowSchema).parse(value).map(fromRow);
  }

  listRetainedLocalData(): readonly StoredAccountProfile[] {
    const value: unknown = this.#database
      .query(
        `${accountSelect} WHERE removed_at IS NOT NULL AND local_data_deleted_at IS NULL
         ORDER BY removed_at, profile_id`,
      )
      .all();
    return z.array(accountProfileRowSchema)
      .max(runtimeRetainedAccountLocalDataLimit)
      .parse(value)
      .map(fromRow);
  }

  hasRetainedLocalDataCapacity(): boolean {
    return this.#count(
      `SELECT COUNT(*) AS count FROM account_profiles
       WHERE removed_at IS NOT NULL AND local_data_deleted_at IS NULL`,
    ) < runtimeRetainedAccountLocalDataLimit;
  }

  find(accountProfileId: string): StoredAccountProfile | null {
    const id = accountProfileIdSchema.parse(accountProfileId);
    return this.#read(`${accountSelect} WHERE profile_id = ?1 AND removed_at IS NULL`, id);
  }

  findAny(accountProfileId: string): StoredAccountProfile | null {
    const id = accountProfileIdSchema.parse(accountProfileId);
    return this.#read(`${accountSelect} WHERE profile_id = ?1`, id);
  }

  select(accountProfileId: string, now = new Date()): AccountSelectionResult {
    const id = accountProfileIdSchema.parse(accountProfileId);
    const updatedAt = toTimestamp(now);
    return this.#database.transaction(() => {
      const target = this.#requireActive(id);
      if (target.selected) return { selected: target, deselected: null };

      const current = this.#selected();
      let deselected: StoredAccountProfile | null = null;
      if (current !== null) {
        this.#database
          .query(
            `UPDATE account_profiles
             SET selected = 0, revision = revision + 1, updated_at = ?2
             WHERE profile_id = ?1 AND selected = 1 AND removed_at IS NULL`,
          )
          .run(current.id, updatedAt);
        deselected = this.#requireActive(current.id);
      }

      const result = this.#database
        .query(
          `UPDATE account_profiles
           SET selected = 1, revision = revision + 1, updated_at = ?2
           WHERE profile_id = ?1 AND selected = 0 AND removed_at IS NULL`,
        )
        .run(id, updatedAt);
      if (result.changes !== 1) throw new Error("Account selection changed concurrently");
      return { selected: this.#requireActive(id), deselected };
    })();
  }

  updateIdentityLabel(
    accountProfileId: string,
    identityLabel: string | null,
    now = new Date(),
  ): StoredAccountProfile {
    return this.#updateActiveColumn(
      accountProfileId,
      "identity_label",
      identityLabelSchema.parse(identityLabel),
      now,
    );
  }

  updateAuthState(
    accountProfileId: string,
    authState: AccountAuthState,
    now = new Date(),
  ): StoredAccountProfile {
    return this.#updateActiveColumn(
      accountProfileId,
      "auth_state",
      authStateSchema.parse(authState),
      now,
    );
  }

  updatePlanLabel(
    accountProfileId: string,
    planLabel: string | null,
    now = new Date(),
  ): StoredAccountProfile {
    return this.#updateActiveColumn(
      accountProfileId,
      "plan_label",
      planLabelSchema.parse(planLabel),
      now,
    );
  }

  updateProcessGeneration(
    accountProfileId: string,
    processGeneration: number,
    now = new Date(),
  ): AccountProcessGenerationUpdate {
    const id = accountProfileIdSchema.parse(accountProfileId);
    const generation = processGenerationSchema.parse(processGeneration);
    const updatedAt = toTimestamp(now);
    return this.#database.transaction(() => {
      const result = this.#database
        .query(
          `UPDATE account_profiles
           SET process_generation = ?2,
               revision = revision + 1,
               updated_at = ?3
           WHERE profile_id = ?1 AND process_generation < ?2 AND removed_at IS NULL`,
        )
        .run(id, generation, updatedAt);
      if (result.changes === 1) {
        return { advanced: true, profile: this.#requireActive(id) };
      }

      const current = this.#requireActive(id);
      if (generation === current.processGeneration) {
        return { advanced: false, profile: current };
      }
      if (generation < current.processGeneration) {
        throw new AccountProfileGenerationRegression(id, current.processGeneration, generation);
      }
      throw new Error("Account generation changed concurrently");
    })();
  }

  bumpRevision(accountProfileId: string, now = new Date()): StoredAccountProfile {
    const id = accountProfileIdSchema.parse(accountProfileId);
    const updatedAt = toTimestamp(now);
    return this.#database.transaction(() => {
      const current = this.#requireActive(id);
      const result = this.#database
        .query(
          `UPDATE account_profiles
           SET revision = revision + 1, updated_at = ?2
           WHERE profile_id = ?1 AND revision = ?3 AND removed_at IS NULL`,
        )
        .run(id, updatedAt, current.revision);
      if (result.changes !== 1) throw new Error("Account revision changed concurrently");
      return this.#requireActive(id);
    })();
  }

  removalPreview(accountProfileId: string): StoredAccountRemovalPreview {
    const id = accountProfileIdSchema.parse(accountProfileId);
    const profile = this.#requireActive(id);
    const threadCount = this.#count(
      `SELECT COUNT(*) AS count FROM thread_bindings WHERE account_profile_id = ?1`,
      id,
    );
    const workspaceLaneCount = this.#count(
      `SELECT COUNT(*) AS count FROM (
         SELECT lane_id FROM workspace_leases WHERE account_profile_id = ?1
         UNION
         SELECT lane_id FROM thread_bindings WHERE account_profile_id = ?1
       )`,
      id,
    );
    return {
      accountProfileId: profile.id,
      accountRevision: profile.revision,
      label: profile.label,
      threadCount,
      workspaceLaneCount,
      localDataState: profile.localDataState,
    };
  }

  tombstone(
    accountProfileId: string,
    expectedRevision: number,
    now = new Date(),
  ): AccountTombstoneResult {
    const id = accountProfileIdSchema.parse(accountProfileId);
    const expected = revisionSchema.parse(expectedRevision);
    const removedAt = toTimestamp(now);

    return this.#database.transaction(() => {
      const current = this.#requireActive(id);
      if (current.revision !== expected) {
        throw new AccountProfileStaleRevision(id, expected, current.revision);
      }
      this.#requireCapacity(
        "retainedLocalData",
        `SELECT COUNT(*) AS count FROM account_profiles
         WHERE removed_at IS NOT NULL AND local_data_deleted_at IS NULL`,
        runtimeRetainedAccountLocalDataLimit,
      );
      const result = this.#database
        .query(
          `UPDATE account_profiles
           SET removed_at = ?2,
               selected = 0,
               identity_label = NULL,
               plan_label = NULL,
               auth_state = 'signedOut',
               revision = revision + 1,
               updated_at = ?2
           WHERE profile_id = ?1 AND revision = ?3 AND removed_at IS NULL`,
        )
        .run(id, removedAt, expected);
      if (result.changes !== 1) throw new Error("Account removal changed concurrently");

      let selectedReplacement = this.#selected();
      if (selectedReplacement === null) {
        const replacement = this.#firstActive();
        if (replacement !== null) {
          const replacementResult = this.#database
            .query(
              `UPDATE account_profiles
               SET selected = 1, revision = revision + 1, updated_at = ?2
               WHERE profile_id = ?1 AND selected = 0 AND removed_at IS NULL`,
            )
            .run(replacement.id, removedAt);
          if (replacementResult.changes !== 1) {
            throw new Error("Replacement account selection changed concurrently");
          }
          selectedReplacement = this.#requireActive(replacement.id);
        }
      }

      return { removed: this.#requireAny(id), selectedReplacement };
    }).immediate();
  }

  markLocalDataDeleted(
    accountProfileId: string,
    expectedRevision: number,
    now = new Date(),
  ): StoredAccountProfile {
    const id = accountProfileIdSchema.parse(accountProfileId);
    const expected = revisionSchema.parse(expectedRevision);
    const deletedAt = toTimestamp(now);
    return this.#database.transaction(() => {
      const current = this.#requireAny(id);
      if (current.revision !== expected) {
        throw new AccountProfileStaleRevision(id, expected, current.revision);
      }
      if (current.removedAt === null) {
        throw new Error(`Account profile ${id} must be removed before deleting its local data`);
      }
      if (current.localDataDeletedAt !== null) return current;
      const result = this.#database
        .query(
          `UPDATE account_profiles
           SET local_data_deleted_at = ?2,
               identity_label = NULL,
               plan_label = NULL,
               auth_state = 'signedOut',
               revision = revision + 1,
               updated_at = ?2
           WHERE profile_id = ?1 AND revision = ?3`,
        )
        .run(id, deletedAt, expected);
      if (result.changes !== 1) throw new Error("Account local data state changed concurrently");
      return this.#requireAny(id);
    })();
  }

  #updateActiveColumn(
    accountProfileId: string,
    column: MutableColumn,
    value: MutableValue,
    now: Date,
  ): StoredAccountProfile {
    const id = accountProfileIdSchema.parse(accountProfileId);
    const validatedColumn = mutableColumnSchema.parse(column);
    const updatedAt = toTimestamp(now);
    return this.#database.transaction(() => {
      const current = this.#requireActive(id);
      if (mutableValue(current, validatedColumn) === value) return current;
      const result = this.#database
        .query(
          `UPDATE account_profiles
           SET ${validatedColumn} = ?2, revision = revision + 1, updated_at = ?3
           WHERE profile_id = ?1 AND revision = ?4 AND removed_at IS NULL`,
        )
        .run(id, value, updatedAt, current.revision);
      if (result.changes !== 1) throw new Error("Account profile changed concurrently");
      return this.#requireActive(id);
    })();
  }

  #selected(): StoredAccountProfile | null {
    return this.#read(
      `${accountSelect} WHERE selected = 1 AND removed_at IS NULL ORDER BY created_at, profile_id LIMIT 1`,
    );
  }

  #firstActive(): StoredAccountProfile | null {
    return this.#read(
      `${accountSelect} WHERE removed_at IS NULL ORDER BY created_at, profile_id LIMIT 1`,
    );
  }

  #requireActive(accountProfileId: string): StoredAccountProfile {
    const profile = this.find(accountProfileId);
    if (profile === null) throw new AccountProfileNotFound(accountProfileId);
    return profile;
  }

  #requireAny(accountProfileId: string): StoredAccountProfile {
    const profile = this.findAny(accountProfileId);
    if (profile === null) throw new AccountProfileNotFound(accountProfileId);
    return profile;
  }

  #read(sql: string, ...bindings: readonly (string | number | null)[]): StoredAccountProfile | null {
    const value: unknown = this.#database.query(sql).get(...bindings);
    return value === null ? null : fromRow(accountProfileRowSchema.parse(value));
  }

  #count(sql: string, ...bindings: readonly (string | number | null)[]): number {
    const value: unknown = this.#database.query(sql).get(...bindings);
    if (value === null) throw new Error("Count query returned no row");
    return countRowSchema.parse(value).count;
  }

  #requireCapacity(
    capacity: AccountProfileCapacityExceeded["capacity"],
    sql: string,
    limit: number,
  ): void {
    if (this.#count(sql) >= limit) {
      throw new AccountProfileCapacityExceeded(capacity);
    }
  }
}

const accountSelect = `SELECT
  profile_id, revision, label, selected, identity_label, plan_label, auth_state,
  process_generation, created_at, updated_at, removed_at, local_data_deleted_at
FROM runtime_visible_account_profiles`;

function fromRow(row: z.infer<typeof accountProfileRowSchema>): StoredAccountProfile {
  return {
    id: row.profile_id,
    revision: row.revision,
    label: row.label,
    selected: row.selected === 1,
    identityLabel: row.identity_label,
    planLabel: row.plan_label,
    authState: row.auth_state,
    processGeneration: row.process_generation,
    localDataState: row.local_data_deleted_at === null ? "present" : "deleted",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
    localDataDeletedAt: row.local_data_deleted_at,
  };
}

function mutableValue(profile: StoredAccountProfile, column: MutableColumn): MutableValue {
  switch (column) {
    case "identity_label":
      return profile.identityLabel;
    case "auth_state":
      return profile.authState;
    case "plan_label":
      return profile.planLabel;
  }
}

function createAccountProfileId(): string {
  return `acct_${randomBytes(18).toString("base64url")}`;
}

function toTimestamp(now: Date): string {
  return timestampSchema.parse(now.toISOString());
}
