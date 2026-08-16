import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
} from "./actor-domain";
import {
  contextSnapshotIdSchema,
  contextValueIdSchema,
} from "./domain";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const operationIdSchema = z.string().min(16).max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_-]{15,127}$/u);
const materializationIdsInputSchema = z.object({
  epochId: actorEpochIdSchema,
  actorId: actorIdSchema,
  completedThroughTurnId: actorTurnIdSchema.nullable(),
  expiresAt: timestampSchema,
  coverageWitnessDigest: digestSchema,
  prefixContentDigest: digestSchema,
}).strict();

export interface HarnessDynamicToolContextMaterializationIdsV2 {
  readonly operationId: string;
  readonly completedPrefixValueId: string;
  readonly completedPrefixSnapshotId: string;
}

export function deriveHarnessDynamicToolContextMaterializationIds(
  inputValue: z.input<typeof materializationIdsInputSchema>,
): HarnessDynamicToolContextMaterializationIdsV2 {
  const input = materializationIdsInputSchema.parse(inputValue);
  const stableParts = [
    input.epochId,
    input.actorId,
    input.completedThroughTurnId === null
      ? "completed-through:null"
      : `completed-through:${input.completedThroughTurnId}`,
    input.coverageWitnessDigest,
    input.prefixContentDigest,
  ] as const;
  const completedPrefixValueId = contextValueIdSchema.parse(
    `ctxval_${identityDigest(
      "oprte.harness.dynamic-tool-completed-prefix-value.v2",
      stableParts,
    ).slice(0, 48)}`,
  );
  return Object.freeze({
    operationId: operationIdSchema.parse(
      `hctxprefix_${identityDigest(
        "oprte.harness.dynamic-tool-completed-prefix-publication.v2",
        [...stableParts, input.expiresAt],
      ).slice(0, 48)}`,
    ),
    completedPrefixValueId,
    completedPrefixSnapshotId: contextSnapshotIdSchema.parse(
      `ctxsnap_${identityDigest(
        "oprte.harness.dynamic-tool-completed-prefix-snapshot.v2",
        [...stableParts, completedPrefixValueId],
      ).slice(0, 48)}`,
    ),
  });
}

export function digestHarnessDynamicToolCompletedPrefixV2(
  plaintext: string,
): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function identityDigest(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const part of parts) {
    hash.update("\0", "utf8").update(part, "utf8");
  }
  return hash.digest("hex");
}
