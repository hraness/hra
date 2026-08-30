import { createHash } from "node:crypto";

import { z } from "zod";

import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "./values";

const digestParts = (domain: string, parts: readonly string[]): string => {
  const digest = createHash("sha256");
  digest.update(domain);
  for (const part of parts) {
    digest.update("\0");
    digest.update(part);
  }
  return digest.digest("hex");
};

const bindingDigestFor = (ownerId: string, sessionId: string): string =>
  digestParts("hra-facts-memory-binding-v1", [ownerId, sessionId]);

export const factsMemoryDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const factsMemoryHeadSchema = z.object({
  digest: factsMemoryDigestSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const factsMemoryBindingSchema = z.object({
  bindingDigest: factsMemoryDigestSchema,
  ownerId: profileIdSchema,
  sessionId: sessionIdSchema,
}).strict().superRefine((value, context) => {
  if (value.bindingDigest !== bindingDigestFor(value.ownerId, value.sessionId)) {
    context.addIssue({
      code: "custom",
      message: "Facts-memory binding digest does not match its owner and session.",
      path: ["bindingDigest"],
    });
  }
});

export const factsMemoryCheckpointSchema = z.object({
  bindingDigest: factsMemoryDigestSchema,
  head: factsMemoryHeadSchema,
  ownerId: profileIdSchema,
  sessionId: sessionIdSchema,
}).strict().superRefine((value, context) => {
  if (value.bindingDigest !== bindingDigestFor(value.ownerId, value.sessionId)) {
    context.addIssue({
      code: "custom",
      message: "Facts-memory checkpoint does not match its owner and session.",
      path: ["bindingDigest"],
    });
  }
});

export const factsMemoryStoreReceiptSchema = z.object({
  bindingDigest: factsMemoryDigestSchema,
  createdAt: unixMillisecondsSchema,
  handleHash: factsMemoryDigestSchema,
  head: factsMemoryHeadSchema,
  receiptDigest: factsMemoryDigestSchema,
  version: z.literal(1),
}).strict();

export const factsMemoryStoreInspectionSchema = z.object({
  bindingDigest: factsMemoryDigestSchema,
  createdAt: unixMillisecondsSchema,
  handleHash: factsMemoryDigestSchema,
  head: factsMemoryHeadSchema,
  initialHead: factsMemoryHeadSchema,
  inspectionDigest: factsMemoryDigestSchema,
  receiptDigest: factsMemoryDigestSchema,
  version: z.literal(1),
}).strict();

export const factsMemoryPurgeReceiptSchema = z.object({
  bindingDigest: factsMemoryDigestSchema,
  handleHash: factsMemoryDigestSchema.nullable(),
  purgeDigest: factsMemoryDigestSchema,
  purgedAt: unixMillisecondsSchema,
  version: z.literal(1),
}).strict();

export type FactsMemoryBinding = z.infer<typeof factsMemoryBindingSchema>;
export type FactsMemoryCheckpoint = z.infer<typeof factsMemoryCheckpointSchema>;
export type FactsMemoryHead = z.infer<typeof factsMemoryHeadSchema>;
export type FactsMemoryPurgeReceipt = z.infer<typeof factsMemoryPurgeReceiptSchema>;
export type FactsMemoryStoreInspection = z.infer<typeof factsMemoryStoreInspectionSchema>;
export type FactsMemoryStoreReceipt = z.infer<typeof factsMemoryStoreReceiptSchema>;

/** Host-fixed binding: neither an agent nor a model chooses a store, path, or authority. */
export const createFactsMemoryBinding = (input: {
  ownerId: string;
  sessionId: string;
}): FactsMemoryBinding => {
  const ownerId = profileIdSchema.parse(input.ownerId);
  const sessionId = sessionIdSchema.parse(input.sessionId);
  return factsMemoryBindingSchema.parse({
    bindingDigest: bindingDigestFor(ownerId, sessionId),
    ownerId,
    sessionId,
  });
};

export const digestFactsMemoryReceipt = (
  input: Omit<FactsMemoryStoreReceipt, "receiptDigest">,
): string => digestParts("hra-facts-memory-store-receipt-v1", [
  input.bindingDigest,
  input.handleHash,
  String(input.head.sequence),
  input.head.digest,
  String(input.createdAt),
]);

export const digestFactsMemoryPurgeReceipt = (
  input: Omit<FactsMemoryPurgeReceipt, "purgeDigest">,
): string => digestParts("hra-facts-memory-purge-receipt-v1", [
  input.bindingDigest,
  input.handleHash ?? "unknown-handle",
  String(input.purgedAt),
]);

export const digestFactsMemoryInspection = (
  input: Omit<FactsMemoryStoreInspection, "inspectionDigest">,
): string => digestParts("hra-facts-memory-store-inspection-v1", [
  input.bindingDigest,
  input.handleHash,
  String(input.createdAt),
  String(input.initialHead.sequence),
  input.initialHead.digest,
  input.receiptDigest,
  String(input.head.sequence),
  input.head.digest,
]);
