import {
  createHash,
  createHmac,
  hkdfSync,
} from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
} from "./actor-domain";
import type { HarnessContextKeyProvider } from "./key-custody";

/** Stable HMAC domain bytes shared with released OPRTE state. */
export const LEGACY_OPRTE_ACTOR_TOKEN_USAGE_IDENTITY_HMAC_DOMAIN_V2 =
  "oprte.harness.actor-token-usage-identity-hmac.v2";

const providerIdentitySchema = z.string().min(1).max(512)
  .refine((value) => !value.includes("\0"), "provider identity contains NUL");

const actorTokenUsageIdentityInputSchema = z.object({
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  accountProfileId: z.string().min(1).max(96),
  processGeneration: z.number().int().positive().safe(),
  providerThreadId: providerIdentitySchema,
  providerTurnId: providerIdentitySchema,
}).strict();

export type ActorTokenUsageIdentityInput = z.infer<
  typeof actorTokenUsageIdentityInputSchema
>;

export interface ActorTokenUsageIdentityPortV2 {
  digest(input: ActorTokenUsageIdentityInput): Promise<string>;
}

/**
 * Makes provider lineage usable as equality evidence without placing raw or
 * dictionary-testable provider identifiers in the control-plane ledger.
 * The installation key is narrowed to the owning actor and then narrowed
 * again to this one HMAC purpose. Every borrowed key buffer is overwritten.
 */
export class HarnessActorTokenUsageIdentityV2
  implements ActorTokenUsageIdentityPortV2 {
  readonly #keys: HarnessContextKeyProvider;

  constructor(keys: HarnessContextKeyProvider) {
    this.#keys = keys;
  }

  async digest(inputValue: ActorTokenUsageIdentityInput): Promise<string> {
    const input = actorTokenUsageIdentityInputSchema.parse(inputValue);
    return await this.#keys.withContextKey({
      epochId: input.epochId,
      ownerActorId: input.actorId,
      sourceTurnId: null,
    }, (contextKey) => digestProviderIdentity(contextKey, input));
  }
}

function digestProviderIdentity(
  contextKeyValue: Uint8Array,
  input: ActorTokenUsageIdentityInput,
): string {
  const contextKey = Uint8Array.from(contextKeyValue);
  const salt = createHash("sha256")
    .update("OPRTE actor token usage identity salt v2", "utf8")
    .digest();
  const info = Buffer.from(
    "OPRTE actor token usage identity HMAC key v2",
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
    const envelope = JSON.stringify([
      LEGACY_OPRTE_ACTOR_TOKEN_USAGE_IDENTITY_HMAC_DOMAIN_V2,
      input.accountProfileId,
      input.processGeneration,
      input.providerThreadId,
      input.providerTurnId,
    ]);
    return createHmac("sha256", digestKey).update(envelope).digest("hex");
  } finally {
    digestKey?.fill(0);
    contextKey.fill(0);
    salt.fill(0);
    info.fill(0);
  }
}
