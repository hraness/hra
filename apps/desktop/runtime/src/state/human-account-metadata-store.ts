import type { Database } from "bun:sqlite";
import {
  secretCustodyDescriptorSchema,
  secretCustodyJournalSchema,
  secretCustodyQuarantinePointerSchema,
  secretSlotSchema,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyQuarantinePointer,
} from "@hraness/hra-human-client";
import { z } from "@hra-internal/schema";

import {
  humanAccountMetadataSchema,
  type HumanAccountMetadata,
  type HumanAccountMetadataPort,
} from "../cloud/keychain-custody";

const custodyRowSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    journal_json: z.string().min(2),
  })
  .strict();

const accountRowSchema = z
  .object({
    revision: z.number().int().nonnegative().safe(),
    metadata_json: z.string().min(2),
  })
  .strict();

const quarantinePointerRowSchema = z
  .object({
    pointer_kind: z.enum(["committed", "pending", "deleting"]),
    generation: z.number().int().nonnegative().safe(),
    slot: secretSlotSchema,
  })
  .strict();

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

/**
 * Token-free SQLite half of human credential custody. Keychain writes and
 * SQLite CAS operations cannot share one transaction; the custody journal
 * makes each interrupted boundary deterministic on the next startup.
 */
export class HumanAccountMetadataStore implements HumanAccountMetadataPort {
  readonly #database: Database;
  readonly #now: () => number;

  constructor(options: {
    readonly database: Database;
    readonly now?: () => number;
  }) {
    this.#database = options.database;
    this.#now = options.now ?? Date.now;
  }

  read(descriptorValue: SecretCustodyDescriptor): Promise<unknown> {
    const descriptor = secretCustodyDescriptorSchema.parse(descriptorValue);
    const value: unknown = this.#database.query(`
      SELECT revision, journal_json
      FROM human_custody_metadata
      WHERE service = ?1 AND name = ?2
    `).get(descriptor.service, descriptor.name);
    const row = custodyRowSchema.nullable().parse(value);
    if (row === null) return Promise.resolve(null);
    const journal = secretCustodyJournalSchema.parse(
      parseJson(row.journal_json, "Human custody journal"),
    );
    if (
      journal.revision !== row.revision ||
      journal.service !== descriptor.service ||
      journal.name !== descriptor.name
    ) {
      throw new Error("Human custody journal does not match its SQLite key.");
    }
    return Promise.resolve(journal);
  }

  compareAndSwap(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly expectedRevision: number | null;
    readonly next: SecretCustodyJournal;
  }): Promise<boolean> {
    const descriptor = secretCustodyDescriptorSchema.parse(input.descriptor);
    const next = secretCustodyJournalSchema.parse(input.next);
    if (
      next.service !== descriptor.service ||
      next.name !== descriptor.name ||
      next.revision !== (input.expectedRevision ?? -1) + 1
    ) {
      return Promise.resolve(false);
    }
    const serialized = JSON.stringify(next);
    const now = this.#now();
    const changed = this.#database.transaction(() => {
      if (input.expectedRevision === null) {
        const inserted = this.#database.query(`
          INSERT INTO human_custody_metadata(
            service, name, revision, latest_generation, journal_json, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6)
          ON CONFLICT(service, name) DO NOTHING
        `).run(
          descriptor.service,
          descriptor.name,
          next.revision,
          next.latestGeneration,
          serialized,
          now,
        );
        return inserted.changes === 1;
      }
      const updated = this.#database.query(`
        UPDATE human_custody_metadata
        SET revision = ?3, latest_generation = ?4,
          journal_json = ?5, updated_at = ?6
        WHERE service = ?1 AND name = ?2 AND revision = ?7
      `).run(
        descriptor.service,
        descriptor.name,
        next.revision,
        next.latestGeneration,
        serialized,
        now,
        input.expectedRevision,
      );
      return updated.changes === 1;
    })();
    return Promise.resolve(changed);
  }

  compareAndSwapWithQuarantine(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly expectedRevision: number;
    readonly next: SecretCustodyJournal;
    readonly quarantined: readonly SecretCustodyQuarantinePointer[];
  }): Promise<boolean> {
    const descriptor = secretCustodyDescriptorSchema.parse(input.descriptor);
    const next = secretCustodyJournalSchema.parse(input.next);
    const quarantined = z.array(secretCustodyQuarantinePointerSchema)
      .min(1)
      .max(66)
      .parse(input.quarantined);
    if (
      next.service !== descriptor.service ||
      next.name !== descriptor.name ||
      next.revision !== input.expectedRevision + 1
    ) {
      return Promise.resolve(false);
    }
    const changed = this.#database.transaction(() => {
      const value: unknown = this.#database.query(`
        SELECT revision, journal_json
        FROM human_custody_metadata
        WHERE service = ?1 AND name = ?2
      `).get(descriptor.service, descriptor.name);
      const row = custodyRowSchema.nullable().parse(value);
      if (row === null || row.revision !== input.expectedRevision) return false;
      const current = secretCustodyJournalSchema.parse(
        parseJson(row.journal_json, "Human custody journal"),
      );
      if (
        current.service !== descriptor.service ||
        current.name !== descriptor.name
      ) {
        return false;
      }
      const currentPointers = new Map<string, {
        readonly generation: number;
        readonly kind: "committed" | "pending" | "deleting";
        readonly slot: string;
      }>();
      const add = (
        kind: "committed" | "pending" | "deleting",
        pointer: { readonly generation: number; readonly slot: string },
      ): void => {
        currentPointers.set(`${pointer.generation}:${pointer.slot}`, {
          kind,
          ...pointer,
        });
      };
      if (current.committed !== undefined) add("committed", current.committed);
      if (current.pending !== undefined) add("pending", current.pending.pointer);
      for (const pointer of current.deleting ?? []) add("deleting", pointer);

      const quarantineKeys = new Set<string>();
      for (const evidence of quarantined) {
        const key = `${evidence.pointer.generation}:${evidence.pointer.slot}`;
        const observed = currentPointers.get(key);
        if (
          quarantineKeys.has(key) ||
          evidence.sourceRevision !== current.revision ||
          observed?.kind !== evidence.kind
        ) {
          return false;
        }
        quarantineKeys.add(key);
      }
      const remainingDeleting = (current.deleting ?? []).filter((pointer) =>
        !quarantineKeys.has(`${pointer.generation}:${pointer.slot}`)
      );
      const committedQuarantined = current.committed !== undefined &&
        quarantineKeys.has(
          `${current.committed.generation}:${current.committed.slot}`,
        );
      const pendingQuarantined = current.pending !== undefined &&
        quarantineKeys.has(
          `${current.pending.pointer.generation}:${current.pending.pointer.slot}`,
        );
      const promotePending = current.pending !== undefined &&
        !pendingQuarantined &&
        (current.committed === undefined || committedQuarantined);
      const expectedCommitted = promotePending
        ? current.pending?.pointer
        : current.committed === undefined || committedQuarantined
          ? undefined
          : current.committed;
      const expected = secretCustodyJournalSchema.safeParse({
        version: 1,
        revision: current.revision + 1,
        latestGeneration: current.latestGeneration,
        service: current.service,
        name: current.name,
        ...(expectedCommitted === undefined
          ? {}
          : { committed: expectedCommitted }),
        ...(current.pending === undefined || pendingQuarantined || promotePending
          ? {}
          : { pending: current.pending }),
        ...(remainingDeleting.length === 0
          ? {}
          : { deleting: remainingDeleting }),
      });
      if (
        !expected.success ||
        JSON.stringify(expected.data) !== JSON.stringify(next)
      ) {
        return false;
      }
      const updated = this.#database.query(`
        UPDATE human_custody_metadata
        SET revision = ?3, latest_generation = ?4,
          journal_json = ?5, updated_at = ?6
        WHERE service = ?1 AND name = ?2 AND revision = ?7
      `).run(
        descriptor.service,
        descriptor.name,
        next.revision,
        next.latestGeneration,
        JSON.stringify(next),
        this.#now(),
        input.expectedRevision,
      );
      if (updated.changes !== 1) return false;
      const quarantinedAt = this.#now();
      for (const evidence of quarantined) {
        this.#database.query(`
          INSERT INTO human_custody_pointer_quarantine(
            service, name, pointer_kind, generation, slot, source_revision,
            reason, quarantined_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        `).run(
          descriptor.service,
          descriptor.name,
          evidence.kind,
          evidence.pointer.generation,
          evidence.pointer.slot,
          evidence.sourceRevision,
          evidence.reason,
          quarantinedAt,
        );
      }
      return true;
    })();
    return Promise.resolve(changed);
  }

  isQuarantinedSlot(input: {
    readonly descriptor: SecretCustodyDescriptor;
    readonly slot: string;
  }): Promise<boolean> {
    const descriptor = secretCustodyDescriptorSchema.parse(input.descriptor);
    const slot = secretSlotSchema.parse(input.slot);
    const value: unknown = this.#database.query(`
      SELECT pointer_kind, generation, slot
      FROM human_custody_pointer_quarantine
      WHERE service = ?1 AND name = ?2 AND slot = ?3
    `).get(descriptor.service, descriptor.name, slot);
    return Promise.resolve(
      quarantinePointerRowSchema.nullable().parse(value) !== null,
    );
  }

  readAccountMetadata(): Promise<unknown> {
    const value: unknown = this.#database.query(`
      SELECT revision, metadata_json
      FROM human_account_metadata
      WHERE singleton = 1
    `).get();
    const row = accountRowSchema.nullable().parse(value);
    if (row === null) return Promise.resolve(null);
    const metadata = humanAccountMetadataSchema.parse(
      parseJson(row.metadata_json, "Human account metadata"),
    );
    if (metadata.revision !== row.revision) {
      throw new Error("Human account metadata revision does not match SQLite.");
    }
    return Promise.resolve(metadata);
  }

  compareAndSwapAccountMetadata(input: {
    readonly expectedRevision: number | null;
    readonly next: HumanAccountMetadata;
  }): Promise<boolean> {
    const next = humanAccountMetadataSchema.parse(input.next);
    if (next.revision !== (input.expectedRevision ?? -1) + 1) {
      return Promise.resolve(false);
    }
    const serialized = JSON.stringify(next);
    const now = this.#now();
    const changed = this.#database.transaction(() => {
      if (input.expectedRevision === null) {
        const inserted = this.#database.query(`
          INSERT INTO human_account_metadata(
            singleton, revision, credential_generation, metadata_json,
            updated_at
          )
          VALUES (1, ?1, ?2, ?3, ?4)
          ON CONFLICT(singleton) DO NOTHING
        `).run(
          next.revision,
          next.credentialGeneration,
          serialized,
          now,
        );
        return inserted.changes === 1;
      }
      const updated = this.#database.query(`
        UPDATE human_account_metadata
        SET revision = ?1, credential_generation = ?2,
          metadata_json = ?3, updated_at = ?4
        WHERE singleton = 1 AND revision = ?5
      `).run(
        next.revision,
        next.credentialGeneration,
        serialized,
        now,
        input.expectedRevision,
      );
      return updated.changes === 1;
    })();
    return Promise.resolve(changed);
  }
}
