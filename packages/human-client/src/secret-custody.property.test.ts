import { expect, test } from "bun:test";
import { assertAsyncProperty, fc } from "@hra-internal/test";

import {
  GenerationalSecretCustody,
  SecretStoreAccessDeniedError,
  type SecretCustodyDescriptor,
  type SecretCustodyJournal,
  type SecretCustodyMetadataStore,
  type SecretCustodyQuarantinePointer,
  type SecretStore,
} from "./secret-custody";

const descriptor: SecretCustodyDescriptor = {
  service: "com.example.hra.identity-transition",
  name: "primary",
};

function slot(generation: number): string {
  return `legacy_slot_${generation.toString().padStart(8, "0")}`;
}

class PropertyMetadata implements SecretCustodyMetadataStore {
  journal: SecretCustodyJournal;
  readonly quarantined: SecretCustodyQuarantinePointer[] = [];

  constructor(journal: SecretCustodyJournal) {
    this.journal = journal;
  }

  read(): Promise<unknown> {
    return Promise.resolve(this.journal);
  }

  compareAndSwap(input: {
    readonly expectedRevision: number | null;
    readonly next: SecretCustodyJournal;
  }): Promise<boolean> {
    if (this.journal.revision !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.journal = input.next;
    return Promise.resolve(true);
  }

  compareAndSwapWithQuarantine(input: {
    readonly expectedRevision: number;
    readonly next: SecretCustodyJournal;
    readonly quarantined: readonly SecretCustodyQuarantinePointer[];
  }): Promise<boolean> {
    if (this.journal.revision !== input.expectedRevision) {
      return Promise.resolve(false);
    }
    this.journal = input.next;
    this.quarantined.push(...input.quarantined);
    return Promise.resolve(true);
  }

  isQuarantinedSlot(input: { readonly slot: string }): Promise<boolean> {
    return Promise.resolve(
      this.quarantined.some(({ pointer }) => pointer.slot === input.slot),
    );
  }
}

test("property: explicit identity recovery preserves every inaccessible item and never reuses its slot", async () => {
  await assertAsyncProperty(
    fc.asyncProperty(
      fc.integer({ min: 0, max: 12 }),
      async (deletingCount) => {
        const committedGeneration = deletingCount;
        const committedSlot = slot(committedGeneration);
        const oldSlots = new Set([
          committedSlot,
          ...Array.from({ length: deletingCount }, (_, index) => slot(index)),
        ]);
        const journal: SecretCustodyJournal = {
          version: 1,
          revision: 7,
          latestGeneration: committedGeneration,
          service: descriptor.service,
          name: descriptor.name,
          committed: {
            generation: committedGeneration,
            slot: committedSlot,
          },
          ...(deletingCount === 0
            ? {}
            : {
                deleting: Array.from(
                  { length: deletingCount },
                  (_, generation) => ({ generation, slot: slot(generation) }),
                ),
              }),
        };
        const metadata = new PropertyMetadata(journal);
        const values = new Map(
          [...oldSlots].map((name) => [
            `${descriptor.service}:${descriptor.name}:slot:${name}`,
            `opaque-legacy-item-${name}`,
          ]),
        );
        let oldDeleteAttempts = 0;
        const secrets: SecretStore = {
          get(input) {
            const key = `${input.service}:${input.name}`;
            if ([...oldSlots].some((name) => input.name.endsWith(`:${name}`))) {
              return Promise.reject(new SecretStoreAccessDeniedError());
            }
            return Promise.resolve(values.get(key) ?? null);
          },
          set(input) {
            values.set(`${input.service}:${input.name}`, input.value);
            return Promise.resolve();
          },
          delete(input) {
            if ([...oldSlots].some((name) => input.name.endsWith(`:${name}`))) {
              oldDeleteAttempts += 1;
              return Promise.reject(new Error("legacy ACL denied"));
            }
            return Promise.resolve(
              values.delete(`${input.service}:${input.name}`),
            );
          },
        };
        const freshSlot = `fresh_slot_${deletingCount.toString().padStart(9, "0")}`;
        const candidates = [committedSlot, freshSlot];
        const custody = new GenerationalSecretCustody({
          descriptor,
          metadata,
          secrets,
          nextSlot: () => candidates.shift() ?? "unused_fresh_slot_0000",
        });

        expect(await custody.inspectLegacyIdentityReconnect()).toEqual({
          state: "required",
          inaccessiblePointerCount: oldSlots.size,
        });
        expect(await custody.quarantineLegacyIdentityPointers()).toEqual({
          state: "quarantined",
          quarantinedPointerCount: oldSlots.size,
        });
        expect(metadata.journal.committed).toBeUndefined();
        expect(metadata.journal.pending).toBeUndefined();
        expect(metadata.journal.deleting).toBeUndefined();
        expect(metadata.journal.latestGeneration).toBe(committedGeneration);
        expect(metadata.quarantined.map(({ pointer }) => pointer.slot).toSorted())
          .toEqual([...oldSlots].toSorted());
        expect(oldDeleteAttempts).toBe(0);
        for (const name of oldSlots) {
          expect(values.has(
            `${descriptor.service}:${descriptor.name}:slot:${name}`,
          )).toBeTrue();
        }

        const written = await custody.write("fresh-credential-after-reconnect");
        expect(written).toEqual({
          generation: committedGeneration + 1,
          slot: freshSlot,
        });
        expect(oldDeleteAttempts).toBe(0);
        const restarted = new GenerationalSecretCustody({
          descriptor,
          metadata,
          secrets,
          nextSlot: () => "restart_fresh_slot_0000",
        });
        expect(await restarted.read()).toEqual({
          generation: committedGeneration + 1,
          value: "fresh-credential-after-reconnect",
        });
      },
    ),
    { numRuns: 50 },
  );
});
