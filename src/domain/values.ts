import { randomUUID } from "node:crypto";

import { z } from "zod";

const encoder = new TextEncoder();

export const utf8Bytes = (value: string): number => encoder.encode(value).byteLength;

export const boundedText = (name: string, maximumBytes: number) =>
  z
    .string()
    .trim()
    .min(1, `${name} must not be empty.`)
    .refine((value) => utf8Bytes(value) <= maximumBytes, {
      message: `${name} must be at most ${maximumBytes} UTF-8 bytes.`,
    });

export const labelSchema = boundedText("Label", 160);
export const titleSchema = boundedText("Title", 320);
export const noteSchema = z.string().refine((value) => utf8Bytes(value) <= 16_384, {
  message: "Note must be at most 16384 UTF-8 bytes.",
});
export const messageSchema = boundedText("Message", 262_144);

export const profileIdSchema = z.string().regex(/^acct_[0-9a-f]{32}$/u);
export const projectIdSchema = z.string().regex(/^proj_[0-9a-f]{32}$/u);
export const sessionIdSchema = z.string().regex(/^sess_[0-9a-f]{32}$/u);
export const queueIdSchema = z.string().regex(/^queue_[0-9a-f]{32}$/u);
export const attemptIdSchema = z.string().regex(/^attempt_[0-9a-f]{32}$/u);

export type ProfileId = z.infer<typeof profileIdSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type QueueId = z.infer<typeof queueIdSchema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;

const createId = <Prefix extends string>(prefix: Prefix): `${Prefix}_${string}` =>
  `${prefix}_${randomUUID().replaceAll("-", "")}`;

export const createProfileId = (): ProfileId => profileIdSchema.parse(createId("acct"));
export const createProjectId = (): ProjectId => projectIdSchema.parse(createId("proj"));
export const createSessionId = (): SessionId => sessionIdSchema.parse(createId("sess"));
export const createQueueId = (): QueueId => queueIdSchema.parse(createId("queue"));
export const createAttemptId = (): AttemptId => attemptIdSchema.parse(createId("attempt"));

export const unixMillisecondsSchema = z.number().int().nonnegative().finite();
export const positiveRevisionSchema = z.number().int().positive().finite();

export const canonicalLabelKey = (value: string): string =>
  value.normalize("NFKC").toLocaleLowerCase("en-US");

export function selectByIdOrLabel<T extends { id: string; label: string }>(
  values: readonly T[],
  selector: string,
): { kind: "found"; value: T } | { kind: "missing" } | { kind: "ambiguous"; values: readonly T[] } {
  const exactId = values.find((value) => value.id === selector);
  if (exactId !== undefined) {
    return { kind: "found", value: exactId };
  }
  const normalized = canonicalLabelKey(selector);
  const matches = values.filter(
    (value) => canonicalLabelKey(value.label) === normalized,
  );
  if (matches.length === 1) {
    const only = matches[0];
    if (only === undefined) throw new Error("Selection cardinality changed unexpectedly.");
    return { kind: "found", value: only };
  }
  return matches.length === 0 ? { kind: "missing" } : { kind: "ambiguous", values: matches };
}
