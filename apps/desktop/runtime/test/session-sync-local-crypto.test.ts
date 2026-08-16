import { describe, expect, test } from "bun:test";
import {
  allocateSessionSyncNonce,
  createSessionSyncNonceState,
  positiveSyncUint64Schema,
  sessionPublicIdSchema,
  syncSha256DigestSchema,
  syncVaultCoordinateSchema,
} from "@hraness/agent-tasks-protocol";

import {
  localSessionSyncIntentSchema,
  openLocalSessionSyncIntent,
  openLocalSessionSyncIntentFromKeyring,
  resealLocalSessionSyncIntent,
  sealLocalSessionSyncIntent,
  selectLocalSessionSyncRootKey,
  type LocalSessionSyncIntent,
} from "../src/cloud/session-sync-local-crypto";

function opaque(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(32)}`;
}

const vault = syncVaultCoordinateSchema.parse({
  tenantId: opaque("synctenant", "t"),
  organizationId: opaque("syncorg", "o"),
  ownerUserId: opaque("syncuser", "u"),
  vaultId: opaque("syncvault", "v"),
  vaultGeneration: "1",
});
const sessionId = sessionPublicIdSchema.parse(
  opaque("syncsession", "s"),
);

function epoch(value: number) {
  return positiveSyncUint64Schema.parse(String(value));
}

const intent: LocalSessionSyncIntent = {
  version: 1,
  sessionId,
  sourceRevision: epoch(7),
  eventKind: "activity",
  title: "Compile the desktop app",
  repositoryDisplayName: "Example",
  modelEffort: "max",
  state: "working",
  deleted: false,
};

function nonce(sequence: number, keyEpoch = 3) {
  return allocateSessionSyncNonce(
    createSessionSyncNonceState(epoch(keyEpoch), epoch(sequence)),
  ).allocation;
}

describe("local encrypted session-sync outbox", () => {
  test("round trips only an authenticated observation summary", async () => {
    const root = new Uint8Array(32).fill(0x4c);
    const sealed = await sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(3),
      rootKey: root,
      nonce: nonce(1),
    });

    expect(JSON.stringify(sealed)).not.toContain(intent.title);
    expect(JSON.stringify(sealed)).not.toContain("Example");
    expect(sealed.nonceSequence).toBe(epoch(1));
    expect(await openLocalSessionSyncIntent({
      envelope: sealed,
      expectedVault: vault,
      rootKey: root,
    })).toEqual(intent);
  });

  test("binds vault, session, revision, event, nonce, and key epoch as authenticated coordinates", async () => {
    const root = new Uint8Array(32).fill(0x2a);
    const sealed = await sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(3),
      rootKey: root,
      nonce: nonce(4),
    });
    const foreignVault = syncVaultCoordinateSchema.parse({
      ...vault,
      vaultId: opaque("syncvault", "x"),
    });

    expect(openLocalSessionSyncIntent({
      envelope: sealed,
      expectedVault: foreignVault,
      rootKey: root,
    })).rejects.toThrow("another vault");
    expect(openLocalSessionSyncIntent({
      envelope: { ...sealed, sourceRevision: epoch(8) },
      expectedVault: vault,
      rootKey: root,
    })).rejects.toThrow("authentication failed");
    expect(openLocalSessionSyncIntent({
      envelope: { ...sealed, eventKind: "terminal" },
      expectedVault: vault,
      rootKey: root,
    })).rejects.toThrow("authentication failed");
    expect(openLocalSessionSyncIntent({
      envelope: sealed,
      expectedVault: vault,
      rootKey: new Uint8Array(32).fill(0x2b),
    })).rejects.toThrow("authentication failed");
  });

  test("rejects digest changes and key-epoch/nonce-epoch mismatches", async () => {
    const root = new Uint8Array(32).fill(0x19);
    const sealed = await sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(3),
      rootKey: root,
      nonce: nonce(9),
    });

    expect(openLocalSessionSyncIntent({
      envelope: {
        ...sealed,
        ciphertextDigest: syncSha256DigestSchema.parse(
          `sha256_${"0".repeat(64)}`,
        ),
      },
      expectedVault: vault,
      rootKey: root,
    })).rejects.toThrow("digest does not match");
    expect(sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(4),
      rootKey: root,
      nonce: nonce(10, 3),
    })).rejects.toThrow("another key epoch");
  });

  test("rejects nonce substitution and reuse outside the fixed sequence domain", async () => {
    const root = new Uint8Array(32).fill(0x37);
    const first = nonce(1);
    const second = nonce(2);
    const sealed = await sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(3),
      rootKey: root,
      nonce: first,
    });

    expect(sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(3),
      rootKey: root,
      nonce: { ...second, nonce: first.nonce },
    })).rejects.toThrow("outside its sequence domain");
    expect(openLocalSessionSyncIntent({
      envelope: { ...sealed, nonce: second.nonce },
      expectedVault: vault,
      rootKey: root,
    })).rejects.toThrow("outside its sequence domain");
  });

  test("strictly excludes prompts, transcripts, paths, provider IDs, and raw reasoning", () => {
    for (const forbidden of [
      "prompt",
      "history",
      "messages",
      "toolCalls",
      "rawReasoning",
      "providerSessionId",
      "repositoryPath",
    ] as const) {
      expect(() => localSessionSyncIntentSchema.parse({
        ...intent,
        [forbidden]: "sensitive payload",
      })).toThrow();
    }
    expect(() => localSessionSyncIntentSchema.parse({
      ...intent,
      title: "unsafe\u0000title",
    })).toThrow("control character");
  });

  test("fresh contiguous nonces produce distinct ciphertext for the same summary", async () => {
    const root = new Uint8Array(32).fill(0x7d);
    const state = createSessionSyncNonceState(epoch(3), epoch(1));
    const first = allocateSessionSyncNonce(state);
    if (first.nextState === null) throw new Error("missing next nonce state");
    const second = allocateSessionSyncNonce(first.nextState);
    const [left, right] = await Promise.all([
      sealLocalSessionSyncIntent({
        intent,
        vault,
        keyEpoch: epoch(3),
        rootKey: root,
        nonce: first.allocation,
      }),
      sealLocalSessionSyncIntent({
        intent,
        vault,
        keyEpoch: epoch(3),
        rootKey: root,
        nonce: second.allocation,
      }),
    ]);

    expect(left.nonce).not.toBe(right.nonce);
    expect(left.ciphertext).not.toBe(right.ciphertext);
    expect(left.ciphertextDigest).not.toBe(right.ciphertextDigest);
  });

  test("authenticates a prepared old-root intent before resealing under a fresh epoch", async () => {
    const root1 = new Uint8Array(32).fill(0x11);
    const root2 = new Uint8Array(32).fill(0x22);
    const root3 = new Uint8Array(32).fill(0x33);
    const sealed = await sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(1),
      rootKey: root1,
      nonce: nonce(7, 1),
    });
    const sourceKeyring = {
      vault,
      currentRootKeyEpoch: epoch(2),
      rootKeys: [
        { keyEpoch: epoch(1), rootKey: root1 },
        { keyEpoch: epoch(2), rootKey: root2 },
      ],
    } as const;
    expect(await openLocalSessionSyncIntentFromKeyring({
      envelope: sealed,
      expectedVault: vault,
      keyring: sourceKeyring,
    })).toEqual(intent);

    const resealed = await resealLocalSessionSyncIntent({
      envelope: sealed,
      expectedVault: vault,
      sourceKeyring,
      targetKeyEpoch: epoch(3),
      targetRootKey: root3,
      targetNonce: nonce(1, 3),
    });
    expect(resealed.keyEpoch).toBe(epoch(3));
    expect(resealed.ciphertext).not.toBe(sealed.ciphertext);
    expect(await openLocalSessionSyncIntent({
      envelope: resealed,
      expectedVault: vault,
      rootKey: root3,
    })).toEqual(intent);
    expect(openLocalSessionSyncIntent({
      envelope: resealed,
      expectedVault: vault,
      rootKey: root1,
    })).rejects.toThrow("authentication failed");
    expect(await openLocalSessionSyncIntent({
      envelope: sealed,
      expectedVault: vault,
      rootKey: root1,
    })).toEqual(intent);
  });

  test("fails reseal closed on tampering, rollback, root reuse, missing history, or wrong vault generation", async () => {
    const root1 = new Uint8Array(32).fill(0x51);
    const root2 = new Uint8Array(32).fill(0x52);
    const sealed = await sealLocalSessionSyncIntent({
      intent,
      vault,
      keyEpoch: epoch(1),
      rootKey: root1,
      nonce: nonce(1, 1),
    });
    const keyring = {
      vault,
      currentRootKeyEpoch: epoch(1),
      rootKeys: [{ keyEpoch: epoch(1), rootKey: root1 }],
    } as const;
    const foreignGeneration = syncVaultCoordinateSchema.parse({
      ...vault,
      vaultGeneration: epoch(2),
    });
    expect(resealLocalSessionSyncIntent({
      envelope: { ...sealed, sourceRevision: epoch(8) },
      expectedVault: vault,
      sourceKeyring: keyring,
      targetKeyEpoch: epoch(2),
      targetRootKey: root2,
      targetNonce: nonce(1, 2),
    })).rejects.toThrow("authentication failed");
    expect(resealLocalSessionSyncIntent({
      envelope: sealed,
      expectedVault: vault,
      sourceKeyring: keyring,
      targetKeyEpoch: epoch(1),
      targetRootKey: root2,
      targetNonce: nonce(2, 1),
    })).rejects.toThrow("must advance");
    expect(resealLocalSessionSyncIntent({
      envelope: sealed,
      expectedVault: vault,
      sourceKeyring: keyring,
      targetKeyEpoch: epoch(2),
      targetRootKey: root1,
      targetNonce: nonce(1, 2),
    })).rejects.toThrow("fresh root key");
    expect(() => selectLocalSessionSyncRootKey({
      keyring: { ...keyring, rootKeys: [{ keyEpoch: epoch(2), rootKey: root2 }] },
      expectedVault: vault,
      keyEpoch: epoch(1),
    })).toThrow();
    expect(() => selectLocalSessionSyncRootKey({
      keyring,
      expectedVault: foreignGeneration,
      keyEpoch: epoch(1),
    })).toThrow("another vault");
    expect(() => selectLocalSessionSyncRootKey({
      keyring: {
        vault,
        currentRootKeyEpoch: epoch(9),
        rootKeys: Array.from({ length: 9 }, (_, index) => ({
          keyEpoch: epoch(index + 1),
          rootKey: new Uint8Array(32).fill(index + 1),
        })),
      },
      expectedVault: vault,
      keyEpoch: epoch(1),
    })).toThrow("direct cache bound");
  });
});
