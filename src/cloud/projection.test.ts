import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { containsAbsolutePath, redactAbsolutePaths } from "./contracts";
import { randomKeyBytes } from "./crypto";
import {
  decryptCompactEvents,
  decryptDetailEvents,
  detailProjectionIsSafe,
  encryptCompactEvents,
  encryptDetailEvents,
  isProjectRelativePath,
  parseCompactSessionEvents,
  parseDetailSessionEvents,
} from "./projection";
import { expectPromiseToReject } from "./testAssertions";

const events = [
  { kind: "user_message", sequence: 1, text: "fix it", turnId: "turn_12345678" },
  { kind: "assistant_message", sequence: 2, text: "done", turnId: "turn_12345678" },
  {
    fast: true,
    filesTouched: ["src/example.ts"],
    gitActions: [{ commit: "abcdef0", kind: "commit" }],
    kind: "turn_summary",
    model: "high",
    runtimeMs: 1_234,
    sequence: 3,
    turnId: "turn_12345678",
  },
] as const;

describe("encrypted session projections", () => {
  test("allows only project-relative bounded file names", () => {
    expect(isProjectRelativePath("src/example.ts")).toBe(true);
    const absoluteFixture = ["", "Users", "name", "repo", "file"].join("/");
    const windowsFixture = ["C:", "Users", "alice", "secret"].join("/");
    for (const path of [
      absoluteFixture,
      "../secret",
      "src/../secret",
      "~/secret",
      "C:\\secret",
      windowsFixture,
      `file://${absoluteFixture}`,
    ]) {
      expect(isProjectRelativePath(path)).toBe(false);
    }
  });

  test("redacts punctuation-delimited local paths without touching web URLs or relative paths", () => {
    const privatePath = ["", "Users", "alice", "private", "secret.ts"].join("/");
    const windowsSlashPath = ["C:", "Users", "alice", "private", "secret.ts"].join("/");
    const windowsBackslashPath = ["C:", "Users", "alice", "private", "secret.ts"].join("\\");
    const uncPath = ["", "", "server", "share", "private", "secret.ts"].join("\\");
    const candidates = [
      `\`${privatePath}\``,
      `[${privatePath}]`,
      `{~/private/secret.ts}`,
      `(${windowsSlashPath})`,
      `{${windowsBackslashPath}}`,
      `<${uncPath}>`,
      `file://${privatePath}`,
      `FILE://${privatePath}`,
      `/${privatePath}`,
      `//${privatePath}`,
    ];
    for (const candidate of candidates) {
      expect(containsAbsolutePath(candidate)).toBe(true);
      const redacted = redactAbsolutePaths(candidate);
      expect(redacted).not.toContain("alice");
      expect(redacted).not.toContain("private");
      expect(containsAbsolutePath(redacted)).toBe(false);
    }
    const webUrl = `https://example.com${privatePath}`;
    expect(redactAbsolutePaths(`${webUrl} src/example.ts`))
      .toBe(`${webUrl} src/example.ts`);
    fc.assert(fc.property(
      fc.constantFrom("`", "[", "{", "(", "<", ":", ";", "!", " "),
      fc.constantFrom("`", "]", "}", ")", ">", ",", ";", "!", " "),
      (prefix, suffix) => {
        const redacted = redactAbsolutePaths(`${prefix}${privatePath}${suffix}`);
        return !redacted.includes("alice") && !containsAbsolutePath(redacted);
      },
    ));
  });

  test("requires contiguous closed compact events", () => {
    expect(parseCompactSessionEvents(events)).toEqual(events);
    expect(parseCompactSessionEvents([events[0], { ...events[1], sequence: 3 }])).toBeNull();
    // A newer writer's unknown optional field is accepted and dropped rather
    // than rejecting the whole event: this is what makes the parser forward
    // compatible with a later revision (see the mixed-version test below).
    expect(parseCompactSessionEvents([{ ...events[0], rawReasoning: "hidden" }])).toEqual([events[0]]);
    expect(parseCompactSessionEvents([{
      ...events[0],
      ...Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`unknown${String(index)}`, index])),
    }])).toBeNull();
    for (const attack of ["\u001b]52;c;owned\u0007", "owned\u202etxt"]) {
      expect(parseCompactSessionEvents([{ ...events[0], text: attack }])).toBeNull();
      expect(parseCompactSessionEvents([{ ...events[2], filesTouched: [`src/${attack}.ts`] }])).toBeNull();
      expect(parseCompactSessionEvents([{ ...events[2], gitActions: [{ kind: "status", label: attack }] }])).toBeNull();
    }
    const secretFixtures = [
      ["Bearer", "secret-token-value"].join(" "),
      ["sk", "secret_token_value_123456789"].join("_"),
      ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
    ];
    for (const secret of secretFixtures) {
      expect(parseCompactSessionEvents([{ ...events[0], text: secret }])).toBeNull();
      expect(parseCompactSessionEvents([{
        ...events[2],
        gitActions: [{ kind: "status", label: secret }],
      }])).toBeNull();
    }
  });

  test("admits only the bounded observation-only interaction shape", () => {
    const interaction = {
      blocking: true,
      interactionId: "70000000-0000-4000-8000-000000000001",
      interactionKind: "permission_approval",
      kind: "interaction_state",
      revision: 3,
      sequence: 1,
      state: "pending",
      summary: "Allow the requested additional permissions",
    } as const;
    expect(parseCompactSessionEvents([interaction])).toEqual([interaction]);
    // A newer writer's unknown field is dropped, not leaked: the parsed
    // event only ever carries the named, validated fields above.
    for (const privateField of [
      { providerRequestId: "request-private" },
      { permissions: { workspace: { roots: ["private"] } } },
      { fields: [{ name: "token" }] },
      { answers: { password: "secret" } },
      { responseDigest: "a".repeat(64) },
    ]) {
      expect(parseCompactSessionEvents([{ ...interaction, ...privateField }])).toEqual([interaction]);
    }
    expect(parseCompactSessionEvents([{
      ...interaction,
      summary: `Open ${["", "Users", "person", "private"].join("/")}`,
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...interaction,
      summary: ["Bearer", "secret-token-value"].join(" "),
    }])).toBeNull();
  });

  test("versions the user_message actor and mixes old and new chunk shapes", () => {
    const humanMessage = { kind: "user_message", sequence: 1, text: "fix it", turnId: "turn_12345678" } as const;
    // An old (v1) chunk carries no actor at all.
    expect(parseCompactSessionEvents([humanMessage])).toEqual([humanMessage]);
    const autorespondMessage = {
      actor: "autorespond",
      kind: "user_message",
      sequence: 1,
      text: "The human has approved. Proceed accordingly.",
      turnId: "turn_12345678",
    } as const;
    expect(parseCompactSessionEvents([autorespondMessage])).toEqual([autorespondMessage]);
    expect(parseCompactSessionEvents([{ ...humanMessage, actor: "robot" }])).toBeNull();
    // assistant_message never carries actor; an unknown extra key on it is a
    // forward-compatible addition and is silently dropped.
    const assistantWithFutureField = {
      ...events[1],
      confidence: 0.9,
    };
    expect(parseCompactSessionEvents([assistantWithFutureField])).toEqual([events[1]]);
    // Mixed-version decode: one old-shape chunk (no actor) followed by one
    // new-shape chunk (an unknown extra key), decoded together as one page.
    const mixed = [
      humanMessage,
      { ...events[1], sequence: 2, hypotheticalFutureField: true },
    ];
    expect(parseCompactSessionEvents(mixed)).toEqual([humanMessage, { ...events[1], sequence: 2 }]);
  });

  test("round trips only under the full session authority tuple", async () => {
    const key = randomKeyBytes();
    const authority = {
      firstSequence: 1,
      keyVersion: 1,
      lastSequence: 3,
      sessionPublicId: "session_12345678",
      sourceBootId: "boot_12345678",
      sourceDevicePublicId: "device_12345678",
      sourceFence: 1,
      stream: "compact",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptCompactEvents(events, key, authority);
    expect(JSON.stringify(envelope)).not.toContain("fix it");
    expect(await decryptCompactEvents(envelope, key, authority)).toEqual(events);
    await expectPromiseToReject(
      decryptCompactEvents(envelope, key, { ...authority, sourceFence: 2 }),
    );
  });

  test("detail projections reject secrets and prohibited raw fields", () => {
    expect(detailProjectionIsSafe({ event: "tool", summary: "read a bounded file" })).toBe(true);
    expect(detailProjectionIsSafe({ raw_reasoning: "private" })).toBe(false);
    expect(detailProjectionIsSafe({ tool_output: "arbitrary" })).toBe(false);
    expect(detailProjectionIsSafe({ text: "Bearer secret-token-value" })).toBe(false);
  });

  test("detail projections reject provider-specific secret token prefixes", () => {
    expect(detailProjectionIsSafe({ text: `sk-ant-${"a".repeat(16)}` })).toBe(false);
    expect(detailProjectionIsSafe({ text: `ghp_${"a".repeat(16)}` })).toBe(false);
    expect(detailProjectionIsSafe({ text: `AKIA${"A".repeat(16)}` })).toBe(false);
  });

  const detailEvents = [
    { at: 1_700_000_000_000, sequence: 1, turnId: "turn_12345678", type: "turn_started" },
    { sequence: 2, text: "Working on it", turnId: "turn_12345678", type: "assistant_delta" },
    {
      sequence: 3,
      text: "Considering approach",
      turnId: "turn_12345678",
      type: "reasoning_summary_delta",
    },
    {
      agentId: "agent_12345678",
      depth: 1,
      kind: "started",
      nickname: "researcher",
      role: "explore",
      sequence: 4,
      turnId: "turn_12345678",
      type: "subagent_activity",
    },
    {
      attention: true,
      lastActivityAt: 1_700_000_000_500,
      reason: "Turn asked for approval",
      revision: 1,
      sequence: 5,
      state: "needs_approval",
      type: "session_state",
      verbatimRequired: false,
    },
  ] as const;

  test("parses the closed detail wire event union and requires contiguous sequences", () => {
    expect(parseDetailSessionEvents(detailEvents)).toEqual(detailEvents);
    expect(parseDetailSessionEvents([
      detailEvents[0],
      { ...detailEvents[1], sequence: 9 },
    ])).toBeNull();
    expect(parseDetailSessionEvents([{ ...detailEvents[4], state: "not_a_state" }])).toBeNull();
    expect(parseDetailSessionEvents([{ ...detailEvents[3], kind: "not_a_kind" }])).toBeNull();
    expect(parseDetailSessionEvents([{ ...detailEvents[1], text: "Bearer secret-token-value" }]))
      .toBeNull();
    // A forward-compatible unknown field is accepted and dropped.
    expect(parseDetailSessionEvents([{ ...detailEvents[0], future: true }]))
      .toEqual([detailEvents[0]]);
  });

  test("round trips detail chunks only under the full session authority tuple", async () => {
    const key = randomKeyBytes();
    const authority = {
      firstSequence: 1,
      keyVersion: 1,
      lastSequence: 5,
      sessionPublicId: "session_12345678",
      sourceBootId: "boot_12345678",
      sourceDevicePublicId: "device_12345678",
      sourceFence: 1,
      stream: "detail",
      userPublicId: "user_12345678",
    } as const;
    const envelope = await encryptDetailEvents(detailEvents, key, authority);
    expect(JSON.stringify(envelope)).not.toContain("Working on it");
    expect(await decryptDetailEvents(envelope, key, authority)).toEqual(detailEvents);
    await expectPromiseToReject(
      decryptDetailEvents(envelope, key, { ...authority, sourceFence: 2 }),
    );
  });
});
