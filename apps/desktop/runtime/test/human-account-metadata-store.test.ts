import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  GenerationalSecretCustody,
  HRA_HUMAN_KEYCHAIN_SERVICE,
  SecretStoreAccessDeniedError,
  secretCustodyJournalSchema,
  type SecretStore,
} from "@hraness/hra-human-client";

import {
  HRA_HUMAN_KEYCHAIN_NAME,
  LegacyHumanAccountMetadataError,
  humanAccountMetadataSchema,
  reconcileHumanAccountMetadata,
} from "../src/cloud";
import { applyMigrations } from "../src/state/database";
import { HumanAccountMetadataStore } from "../src/state/human-account-metadata-store";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  return {
    database,
    store: new HumanAccountMetadataStore({
      database,
      now: () => 1_800_000_000_000,
    }),
  };
}

const descriptor = {
  service: HRA_HUMAN_KEYCHAIN_SERVICE,
  name: HRA_HUMAN_KEYCHAIN_NAME,
} as const;

describe("SQLite human account metadata", () => {
  test("provides atomic revision CAS for the token-free profile", async () => {
    const { database, store } = fixture();
    try {
      expect(await store.readAccountMetadata()).toBeNull();
      const initial = humanAccountMetadataSchema.parse({
        version: 1,
        revision: 0,
        credentialGeneration: 3,
        profile: {
          version: 2,
          apiUrl: "https://oprte.example.test",
          secretStore: "keychain",
          user: {
            id: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            email: "builder@example.test",
            name: "Builder",
          },
          organization: {
            id: "org_local",
            name: "Local",
            role: "owner",
            status: "active",
          },
        },
      });
      const insertResults = await Promise.all([
        store.compareAndSwapAccountMetadata({
          expectedRevision: null,
          next: initial,
        }),
        store.compareAndSwapAccountMetadata({
          expectedRevision: null,
          next: initial,
        }),
      ]);
      expect(insertResults.filter(Boolean)).toHaveLength(1);
      expect(await store.readAccountMetadata()).toEqual(initial);

      const next = humanAccountMetadataSchema.parse({
        ...initial,
        revision: 1,
        credentialGeneration: 4,
      });
      expect(await store.compareAndSwapAccountMetadata({
        expectedRevision: 0,
        next,
      })).toBeTrue();
      expect(await store.compareAndSwapAccountMetadata({
        expectedRevision: 0,
        next,
      })).toBeFalse();
      expect(await store.readAccountMetadata()).toEqual(next);

      const serialized = database
        .query<{ metadata_json: string }, []>(
          "SELECT metadata_json FROM human_account_metadata WHERE singleton = 1",
        )
        .get()?.metadata_json ?? "";
      expect(serialized).not.toContain("accessToken");
      expect(serialized).not.toContain("refreshToken");
    } finally {
      database.close();
    }
  });

  test("projects legacy token-free metadata only as an explicit-recovery reference", async () => {
    const { database, store } = fixture();
    try {
      const legacy = {
        version: 1,
        revision: 0,
        credentialGeneration: 4,
        profile: {
          version: 1,
          apiUrl: "https://oprte.example.test",
          secretStore: "keychain",
          user: {
            id: "legacy_user",
            email: "legacy@example.test",
            name: "Legacy user",
          },
          organization: {
            id: "legacy_org",
            name: "Legacy organization",
            role: "owner",
            status: "active",
          },
        },
      };
      database.query(`
        INSERT INTO human_account_metadata(
          singleton, revision, credential_generation, metadata_json, updated_at
        ) VALUES (1, ?1, ?2, ?3, ?4)
      `).run(0, 4, JSON.stringify(legacy), 1_700_000_000_000);

      expect(await store.readAccountMetadata()).toEqual({
        state: "legacy_profile",
        revision: 0,
        credentialGeneration: 4,
      });
      expect(reconcileHumanAccountMetadata(store, null)).rejects
        .toBeInstanceOf(LegacyHumanAccountMetadataError);
      expect(await reconcileHumanAccountMetadata(store, null, {
        replaceLegacyProfile: true,
      })).toEqual({
        version: 1,
        revision: 1,
        credentialGeneration: 4,
        profile: null,
      });
      expect(await store.readAccountMetadata()).toMatchObject({
        revision: 1,
        profile: null,
      });
    } finally {
      database.close();
    }
  });

  test("stores the exact custody journal and rejects stale or mismatched CAS", async () => {
    const { database, store } = fixture();
    try {
      expect(await store.read(descriptor)).toBeNull();
      const initial = secretCustodyJournalSchema.parse({
        version: 1,
        revision: 0,
        latestGeneration: 1,
        service: descriptor.service,
        name: descriptor.name,
        pending: {
          pointer: {
            generation: 1,
            slot: "human_slot_one_0001",
          },
          replacesGeneration: null,
        },
      });
      expect(await store.compareAndSwap({
        descriptor,
        expectedRevision: null,
        next: initial,
      })).toBeTrue();
      expect(await store.read(descriptor)).toEqual(initial);

      const committed = secretCustodyJournalSchema.parse({
        version: 1,
        revision: 1,
        latestGeneration: 1,
        service: descriptor.service,
        name: descriptor.name,
        committed: {
          generation: 1,
          slot: "human_slot_one_0001",
        },
      });
      expect(await store.compareAndSwap({
        descriptor,
        expectedRevision: 0,
        next: committed,
      })).toBeTrue();
      expect(await store.compareAndSwap({
        descriptor,
        expectedRevision: 0,
        next: committed,
      })).toBeFalse();
      expect(await store.compareAndSwap({
        descriptor: { ...descriptor, name: "another" },
        expectedRevision: null,
        next: committed,
      })).toBeFalse();
      expect(await store.read(descriptor)).toEqual(committed);
    } finally {
      database.close();
    }
  });

  test("atomically moves exact legacy pointers into immutable outside-journal evidence", async () => {
    const { database, store } = fixture();
    try {
      const initial = secretCustodyJournalSchema.parse({
        version: 1,
        revision: 0,
        latestGeneration: 2,
        service: descriptor.service,
        name: descriptor.name,
        committed: { generation: 2, slot: "legacy_committed_0002" },
        deleting: [{ generation: 1, slot: "legacy_deleting_0001" }],
      });
      expect(await store.compareAndSwap({
        descriptor,
        expectedRevision: null,
        next: initial,
      })).toBeTrue();
      const retired = secretCustodyJournalSchema.parse({
        version: 1,
        revision: 1,
        latestGeneration: 2,
        service: descriptor.service,
        name: descriptor.name,
      });
      expect(await store.compareAndSwapWithQuarantine({
        descriptor,
        expectedRevision: 0,
        next: retired,
        quarantined: [
          {
            kind: "committed",
            pointer: initial.committed!,
            sourceRevision: 0,
            reason: "legacy_identity_access_denied",
          },
          {
            kind: "deleting",
            pointer: initial.deleting![0]!,
            sourceRevision: 0,
            reason: "legacy_identity_access_denied",
          },
        ],
      })).toBeTrue();
      expect(await store.read(descriptor)).toEqual(retired);
      expect(await store.isQuarantinedSlot({
        descriptor,
        slot: "legacy_committed_0002",
      })).toBeTrue();
      expect(await store.isQuarantinedSlot({
        descriptor,
        slot: "fresh_credential_0003",
      })).toBeFalse();
      expect(database.query(`
        SELECT pointer_kind, generation, slot, source_revision, reason,
          quarantined_at
        FROM human_custody_pointer_quarantine
        ORDER BY generation
      `).all()).toEqual([
        {
          pointer_kind: "deleting",
          generation: 1,
          slot: "legacy_deleting_0001",
          source_revision: 0,
          reason: "legacy_identity_access_denied",
          quarantined_at: 1_800_000_000_000,
        },
        {
          pointer_kind: "committed",
          generation: 2,
          slot: "legacy_committed_0002",
          source_revision: 0,
          reason: "legacy_identity_access_denied",
          quarantined_at: 1_800_000_000_000,
        },
      ]);
      expect(() => database.query(`
        UPDATE human_custody_pointer_quarantine
        SET reason = 'legacy_identity_access_denied'
      `).run()).toThrow("custody quarantine evidence is immutable");
      expect(() => database.query(`
        DELETE FROM human_custody_pointer_quarantine
      `).run()).toThrow("custody quarantine evidence is immutable");
    } finally {
      database.close();
    }
  });

  test("atomically promotes a valid pending successor before quarantining its denied predecessor", async () => {
    const { database, store } = fixture();
    try {
      const committedSlot = "denied_committed_01";
      const pendingSlot = "valid_pending_0002";
      const missingDeletingSlot = "missing_deleting01";
      const initial = secretCustodyJournalSchema.parse({
        version: 1,
        revision: 0,
        latestGeneration: 2,
        service: descriptor.service,
        name: descriptor.name,
        committed: { generation: 1, slot: committedSlot },
        pending: {
          pointer: { generation: 2, slot: pendingSlot },
          replacesGeneration: 1,
        },
        deleting: [{ generation: 0, slot: missingDeletingSlot }],
      });
      expect(await store.compareAndSwap({
        descriptor,
        expectedRevision: null,
        next: initial,
      })).toBeTrue();
      const values = new Map<string, string>([[
        `${descriptor.name}:slot:${pendingSlot}`,
        JSON.stringify({
          version: 1,
          generation: 2,
          value: "valid pending successor",
        }),
      ]]);
      let deletes = 0;
      const secrets: SecretStore = {
        get: (input) => input.name.endsWith(committedSlot)
          ? Promise.reject(new SecretStoreAccessDeniedError())
          : Promise.resolve(values.get(input.name) ?? null),
        set: () => Promise.reject(new Error("must not write")),
        delete: () => {
          deletes += 1;
          return Promise.reject(new Error("must not delete"));
        },
      };
      const custody = new GenerationalSecretCustody({
        descriptor,
        metadata: store,
        secrets,
        nextSlot: () => "unused_recovery01",
      });

      expect(await custody.quarantineLegacyIdentityPointers()).toEqual({
        state: "quarantined",
        quarantinedPointerCount: 2,
      });
      expect(await store.read(descriptor)).toEqual({
        version: 1,
        revision: 1,
        latestGeneration: 2,
        service: descriptor.service,
        name: descriptor.name,
        committed: { generation: 2, slot: pendingSlot },
      });
      expect(deletes).toBe(0);

      const restarted = new GenerationalSecretCustody({
        descriptor,
        metadata: new HumanAccountMetadataStore({ database }),
        secrets,
        nextSlot: () => "unused_restart_01",
      });
      expect(await restarted.read()).toEqual({
        generation: 2,
        value: "valid pending successor",
      });
      expect(database.query(`
        SELECT reason FROM human_custody_pointer_quarantine ORDER BY generation
      `).all()).toEqual([
        { reason: "missing_pointer_abandoned" },
        { reason: "legacy_identity_access_denied" },
      ]);
    } finally {
      database.close();
    }
  });
});
