import { z } from "@hra-internal/schema";

import { attentionProjectionSchema, localObservationVersion } from "./attention";
import { localPaneListProjectionSchema } from "./panes";

export const localObservationRequestByteLimit = 1_024;
export const localObservationResponseByteLimit = 256 * 1_024;
export const localObservationTimeoutMilliseconds = 5_000;
// AF_UNIX paths are short on supported macOS releases. These opaque fixed
// names leave room for long user homes and the source-development app root.
export const localObservationDirectoryName = ".hra-o1";
export const localObservationSocketFileName = "s";
export const localObservationCapabilityFileName = "c";

export const localObservationCapabilitySchema = z.string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u, "invalid local observation capability");

export const localObservationRequestSchema = z.object({
  version: z.literal(localObservationVersion),
  capability: localObservationCapabilitySchema,
  operation: z.enum(["attention.list", "panes.list"]),
}).strict();

export const localObservationSuccessResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attention"),
    projection: attentionProjectionSchema,
  }).strict(),
  z.object({
    type: z.literal("panes"),
    projection: localPaneListProjectionSchema,
  }).strict(),
]);

export const localObservationResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(localObservationVersion),
    ok: z.literal(true),
    result: localObservationSuccessResultSchema,
  }).strict(),
  z.object({
    version: z.literal(localObservationVersion),
    ok: z.literal(false),
    error: z.object({
      code: z.enum([
        "invalid_request",
        "unauthorized",
        "runtime_unavailable",
        "observation_unavailable",
      ]),
    }).strict(),
  }).strict(),
]);

export type LocalObservationRequest = z.infer<typeof localObservationRequestSchema>;
export type LocalObservationResponse = z.infer<typeof localObservationResponseSchema>;

export function parseLocalObservationRequest(value: unknown): LocalObservationRequest {
  return localObservationRequestSchema.parse(value);
}

export function parseLocalObservationResponse(value: unknown): LocalObservationResponse {
  return localObservationResponseSchema.parse(value);
}
