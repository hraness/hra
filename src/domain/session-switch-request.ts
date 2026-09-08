import { z } from "zod";

import { presetV1Schema, providerV1Schema } from "./presets";

// This exact field order is retained in private48/combined49 request digests.
// A current caller-authored contract must never be inferred into those bytes.
export const sessionSwitchRawRequestV1Schema = z.object({
  session: z.string().min(1).max(200),
  provider: providerV1Schema,
  account: z.string().min(1).max(200).nullable(),
  preset: presetV1Schema.nullable(),
}).strict();

// null records that the caller omitted a contract; it is not a resolved default.
// The writer separately proves the supported route and active contract before IO.
export const sessionSwitchRawRequestV2Schema = z.object({
  version: z.literal(2),
  ...sessionSwitchRawRequestV1Schema.shape,
  presetContract: z.union([z.literal(1), z.literal(2)]).nullable(),
}).strict();

export const sessionSwitchRawRequestSchema = z.union([
  sessionSwitchRawRequestV1Schema,
  sessionSwitchRawRequestV2Schema,
]);

export type SessionSwitchRawRequest =
  | Readonly<z.infer<typeof sessionSwitchRawRequestV1Schema> & { version?: never; presetContract?: never }>
  | Readonly<z.infer<typeof sessionSwitchRawRequestV2Schema>>;
