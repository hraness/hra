import {
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";

import type { PersistentActorContinuationIntentMetadata } from
  "./codex-persistent-actor-provider";
import type { HarnessContextKeyProvider } from "./key-custody";

/** Stable HMAC domain bytes shared with released OPRTE state. */
export const LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2 =
  "oprte.harness.actor-continuation-intent-hmac.v2";

export interface ActorContinuationIntentIdentityPortV2 {
  digest(input: Readonly<{
    epochId: string;
    metadata: PersistentActorContinuationIntentMetadata;
  }>): Promise<Readonly<{
    sourceIdentityDigest: string;
    effectIdentityDigest: string;
    metadataDigest: string;
  }>>;
}

/**
 * Binds the complete continuation identity and history checksum without
 * placing account, provider, client-message, or transcript-derived equality
 * handles in SQLite. The resulting HMAC is both the lookup key and evidence.
 */
export class HarnessActorContinuationIntentIdentityV2
  implements ActorContinuationIntentIdentityPortV2 {
  readonly #keys: HarnessContextKeyProvider;

  constructor(keys: HarnessContextKeyProvider) {
    this.#keys = keys;
  }

  async digest(
    input: Readonly<{
      epochId: string;
      metadata: PersistentActorContinuationIntentMetadata;
    }>,
  ): Promise<Readonly<{
    sourceIdentityDigest: string;
    effectIdentityDigest: string;
    metadataDigest: string;
  }>> {
    const { epochId, metadata } = input;
    return await this.#keys.withContextKey({
      epochId,
      ownerActorId: metadata.actorId,
      sourceTurnId: metadata.actorTurnId,
    }, (contextKey) => digestMetadata(contextKey, metadata));
  }
}

function digestMetadata(
  contextKeyValue: Uint8Array,
  metadata: PersistentActorContinuationIntentMetadata,
): Readonly<{
  sourceIdentityDigest: string;
  effectIdentityDigest: string;
  metadataDigest: string;
}> {
  const contextKey = Uint8Array.from(contextKeyValue);
  const salt = createHash("sha256")
    .update("OPRTE actor continuation intent salt v2", "utf8")
    .digest();
  const info = Buffer.from(
    "OPRTE actor continuation intent HMAC key v2",
    "utf8",
  );
  let digestKey: Buffer | null = null;
  try {
    digestKey = Buffer.from(hkdfSync(
      "sha256",
      contextKey,
      salt,
      info,
      32,
    ));
    const sourceIdentityDigest = createHmac("sha256", digestKey)
      .update(JSON.stringify([
        `${LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2}.source`,
        metadata.actorId,
        metadata.actorTurnId,
        metadata.sourceAccountProfileId,
        metadata.sourceProcessGeneration,
        metadata.sourceProviderThreadId,
        metadata.sourceProviderTurnId,
      ]))
      .digest("hex");
    const effectIdentityDigest = createHmac("sha256", digestKey)
      .update(JSON.stringify([
        `${LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2}.effect`,
        metadata.actorId,
        metadata.actorTurnId,
        metadata.clientUserMessageId,
        metadata.targetAccountProfileId,
        metadata.targetProcessGeneration,
        metadata.targetProviderThreadId,
      ]))
      .digest("hex");
    const metadataDigest = createHmac("sha256", digestKey)
      .update(JSON.stringify([
        LEGACY_OPRTE_ACTOR_CONTINUATION_INTENT_HMAC_DOMAIN_V2,
        metadata.actorId,
        metadata.actorTurnId,
        metadata.clientUserMessageId,
        metadata.historyDigest,
        metadata.historyItemCount,
        metadata.historyUtf8Bytes,
        metadata.sourceAccountProfileId,
        metadata.sourceProcessGeneration,
        metadata.sourceProviderThreadId,
        metadata.sourceProviderTurnId,
        metadata.targetAccountProfileId,
        metadata.targetProcessGeneration,
        metadata.targetProviderThreadId,
      ]))
      .digest("hex");
    return Object.freeze({
      sourceIdentityDigest,
      effectIdentityDigest,
      metadataDigest,
    });
  } finally {
    digestKey?.fill(0);
    contextKey.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}
