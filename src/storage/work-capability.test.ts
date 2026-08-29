import { describe, expect, test } from "bun:test";

import {
  workAttemptIdSchema,
  workCapabilitySchema,
  workIdSchema,
} from "../domain/work";
import { sessionIdSchema } from "../domain/values";
import {
  WORK_CAPABILITY_KEY_BYTES,
  WorkCapabilityCodec,
  type WorkCapabilityContext,
} from "./work-capability";

const workId = workIdSchema.parse(`work_${"1".repeat(32)}`);
const otherWorkId = workIdSchema.parse(`work_${"2".repeat(32)}`);
const sessionId = sessionIdSchema.parse(`sess_${"3".repeat(32)}`);
const otherSessionId = sessionIdSchema.parse(`sess_${"4".repeat(32)}`);
const subjectId = workAttemptIdSchema.parse(`watt_${"5".repeat(32)}`);
const otherSubjectId = workAttemptIdSchema.parse(`watt_${"6".repeat(32)}`);
const fixedKey = Uint8Array.from({ length: WORK_CAPABILITY_KEY_BYTES }, (_, index) => index);

const coordinator = {
  scope: "coordinator",
  workId,
  sessionId,
} as const satisfies WorkCapabilityContext;

const member = {
  scope: "member",
  workId,
  sessionId,
} as const satisfies WorkCapabilityContext;

const attempt = {
  scope: "attempt",
  workId,
  sessionId,
  subjectId,
  fence: 7,
} as const satisfies WorkCapabilityContext;

describe("work capability codec", () => {
  test("is deterministic across codec restarts and emits the closed token syntax", () => {
    const first = new WorkCapabilityCodec(fixedKey).issue(attempt);
    const restarted = new WorkCapabilityCodec(Uint8Array.from(fixedKey));

    expect(restarted.issue(attempt)).toBe(first);
    expect(first).toBe("hrac1_JVTRwP6KG3EByOmNyYivVLJ3IpWwqV4AqpnEhbg6Z2o");
    expect(workCapabilitySchema.parse(first)).toBe(first);
    expect(first).toHaveLength("hrac1_".length + 43);
    expect(restarted.verify({ ...attempt, capability: first })).toBe(true);
  });

  test("domain-separates coordinator, member, and attempt authority", () => {
    const codec = new WorkCapabilityCodec(fixedKey);
    const coordinatorCapability = codec.issue(coordinator);
    const memberCapability = codec.issue(member);
    const attemptCapability = codec.issue(attempt);

    expect(new Set([coordinatorCapability, memberCapability, attemptCapability]).size).toBe(3);
    expect(codec.verify({ ...coordinator, capability: memberCapability })).toBe(false);
    expect(codec.verify({ ...member, capability: attemptCapability })).toBe(false);
    expect(codec.verify({ ...attempt, capability: coordinatorCapability })).toBe(false);
  });

  test("binds every identity component and the attempt fence exactly", () => {
    const codec = new WorkCapabilityCodec(fixedKey);
    const capability = codec.issue(attempt);

    expect(codec.verify({ ...attempt, capability })).toBe(true);
    expect(codec.verify({ ...attempt, workId: otherWorkId, capability })).toBe(false);
    expect(codec.verify({ ...attempt, sessionId: otherSessionId, capability })).toBe(false);
    expect(codec.verify({ ...attempt, subjectId: otherSubjectId, capability })).toBe(false);
    expect(codec.verify({ ...attempt, fence: attempt.fence + 1, capability })).toBe(false);
  });

  test("rejects malformed and noncanonical tokens without throwing", () => {
    const codec = new WorkCapabilityCodec(fixedKey);
    const capability = codec.issue(coordinator);
    const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastCharacter = capability.at(-1);
    const lastIndex = lastCharacter === undefined ? -1 : base64urlAlphabet.indexOf(lastCharacter);
    if (lastIndex < 0 || lastIndex % 4 !== 0) {
      throw new Error("Expected a canonical 32-byte base64url digest.");
    }
    const replacement = base64urlAlphabet.at(lastIndex + 1);
    if (replacement === undefined) throw new Error("Missing noncanonical base64url replacement.");
    const noncanonical = `${capability.slice(0, -1)}${replacement}`;

    expect(
      Buffer.from(noncanonical.slice("hrac1_".length), "base64url")
        .equals(Buffer.from(capability.slice("hrac1_".length), "base64url")),
    ).toBe(true);
    expect(workCapabilitySchema.safeParse(noncanonical).success).toBe(false);

    const malformed: unknown[] = [
      { ...coordinator, capability: noncanonical },
      { ...coordinator, capability: `${capability}=` },
      { ...coordinator, capability: `hrac1_${"A".repeat(42)}` },
      { ...coordinator, capability: `hrac1_${"A".repeat(42)}+` },
      { ...coordinator, capability: capability.replace("hrac1_", "HRAC1_") },
      { ...coordinator, capability: 42 },
      { ...coordinator, extra: true, capability },
      { scope: "administrator", workId, sessionId, capability },
      null,
    ];
    for (const value of malformed) {
      expect(() => codec.verify(value)).not.toThrow();
      expect(codec.verify(value)).toBe(false);
    }
  });

  test("does not encode bound identities into the opaque capability", () => {
    const codec = new WorkCapabilityCodec(fixedKey);
    const capability = codec.issue(attempt);
    const decoded = Buffer.from(capability.slice("hrac1_".length), "base64url");
    const wire = capability + decoded.toString("utf8");

    expect(wire).not.toContain(workId);
    expect(wire).not.toContain(sessionId);
    expect(wire).not.toContain(subjectId);
    expect(decoded).toHaveLength(32);
  });

  test("validates and defensively copies the 32-byte secret key", () => {
    expect(() => new WorkCapabilityCodec(new Uint8Array(31))).toThrow(TypeError);
    expect(() => new WorkCapabilityCodec(new Uint8Array(33))).toThrow(TypeError);
    expect(() => new WorkCapabilityCodec("not-a-key" as unknown as Uint8Array)).toThrow(TypeError);

    const generated = WorkCapabilityCodec.generateKey();
    expect(generated).toBeInstanceOf(Uint8Array);
    expect(generated).toHaveLength(WORK_CAPABILITY_KEY_BYTES);
    expect(() => new WorkCapabilityCodec(generated)).not.toThrow();

    const callerOwnedKey = Uint8Array.from(fixedKey);
    const codec = new WorkCapabilityCodec(callerOwnedKey);
    const beforeMutation = codec.issue(member);
    const wrongKey = new WorkCapabilityCodec(new Uint8Array(WORK_CAPABILITY_KEY_BYTES));
    expect(wrongKey.verify({ ...member, capability: beforeMutation })).toBe(false);
    callerOwnedKey.fill(255);
    expect(codec.issue(member)).toBe(beforeMutation);
  });
});
