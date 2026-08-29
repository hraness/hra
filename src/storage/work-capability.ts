import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  workAttemptIdSchema,
  workCapabilitySchema,
  workIdSchema,
  type WorkCapability,
} from "../domain/work";
import { positiveRevisionSchema, sessionIdSchema } from "../domain/values";

export const WORK_CAPABILITY_KEY_BYTES = 32;

const capabilityPrefix = "hrac1_";
const capabilityDomain = "hra.work.capability";
const capabilityVersion = 1;
const capabilityDigestBytes = 32;
const fenceSchema = positiveRevisionSchema.max(Number.MAX_SAFE_INTEGER);

const coordinatorContextSchema = z.object({
  scope: z.literal("coordinator"),
  workId: workIdSchema,
  sessionId: sessionIdSchema,
}).strict();

const memberContextSchema = z.object({
  scope: z.literal("member"),
  workId: workIdSchema,
  sessionId: sessionIdSchema,
}).strict();

const attemptContextSchema = z.object({
  scope: z.literal("attempt"),
  workId: workIdSchema,
  sessionId: sessionIdSchema,
  subjectId: workAttemptIdSchema,
  fence: fenceSchema,
}).strict();

export const workCapabilityContextSchema = z.discriminatedUnion("scope", [
  coordinatorContextSchema,
  memberContextSchema,
  attemptContextSchema,
]);
export type WorkCapabilityContext = z.infer<typeof workCapabilityContextSchema>;

const workCapabilityVerificationInputSchema = z.discriminatedUnion("scope", [
  coordinatorContextSchema.extend({ capability: workCapabilitySchema }),
  memberContextSchema.extend({ capability: workCapabilitySchema }),
  attemptContextSchema.extend({ capability: workCapabilitySchema }),
]);
export type WorkCapabilityVerificationInput = z.infer<
  typeof workCapabilityVerificationInputSchema
>;

const canonicalContext = (input: WorkCapabilityContext): string => JSON.stringify(
  input.scope === "attempt"
    ? [
      ["domain", capabilityDomain],
      ["version", capabilityVersion],
      ["scope", input.scope],
      ["workId", input.workId],
      ["sessionId", input.sessionId],
      ["subjectId", input.subjectId],
      ["fence", input.fence],
    ]
    : [
      ["domain", capabilityDomain],
      ["version", capabilityVersion],
      ["scope", input.scope],
      ["workId", input.workId],
      ["sessionId", input.sessionId],
    ],
);

export class WorkCapabilityCodec {
  readonly #key: Buffer;

  public constructor(key: Uint8Array) {
    if (!(key instanceof Uint8Array) || key.byteLength !== WORK_CAPABILITY_KEY_BYTES) {
      throw new TypeError(`Work capability keys must be exactly ${WORK_CAPABILITY_KEY_BYTES} bytes.`);
    }
    this.#key = Buffer.from(key);
  }

  public static generateKey(): Uint8Array {
    return randomBytes(WORK_CAPABILITY_KEY_BYTES);
  }

  public issue(input: WorkCapabilityContext): WorkCapability {
    const context = workCapabilityContextSchema.parse(input);
    return workCapabilitySchema.parse(
      `${capabilityPrefix}${this.#digest(context).toString("base64url")}`,
    );
  }

  public verify(input: unknown): boolean {
    try {
      const parsed = workCapabilityVerificationInputSchema.safeParse(input);
      if (!parsed.success) return false;

      const { capability, ...context } = parsed.data;
      const encoded = capability.slice(capabilityPrefix.length);
      const actual = Buffer.from(encoded, "base64url");
      if (
        actual.byteLength !== capabilityDigestBytes
        || actual.toString("base64url") !== encoded
      ) {
        return false;
      }

      const expected = this.#digest(workCapabilityContextSchema.parse(context));
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  #digest(input: WorkCapabilityContext): Buffer {
    return createHmac("sha256", this.#key)
      .update(canonicalContext(input), "utf8")
      .digest();
  }
}
