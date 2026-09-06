import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { containsAbsolutePath, redactAbsolutePaths } from "./contracts";
import { randomKeyBytes } from "./crypto";
import {
  compactInteractionDetailOf,
  decryptCompactEvents,
  decryptDetailEvents,
  detailProjectionIsSafe,
  encryptCompactEvents,
  encryptDetailEvents,
  isProjectRelativePath,
  parseCompactSessionEvent,
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

  test("carries the fable-max preset in a turn summary", () => {
    // W3: adding a preset widens the compact projection format. The parser is
    // forward compatible for unknown *keys*, never for unknown enum values, so
    // a reader older than this build rejects the chunk below and a reader from
    // this build accepts it.
    const claudeTurn = [{
      fast: false,
      filesTouched: [],
      gitActions: [],
      kind: "turn_summary",
      model: "fable-max",
      runtimeMs: 2_259,
      sequence: 1,
      turnId: "turn_12345678",
    }] as const;
    expect(parseCompactSessionEvents(claudeTurn)).toEqual(claudeTurn);
    expect(parseCompactSessionEvents([{ ...claudeTurn[0], model: "fable" }])).toBeNull();
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

  test("fails closed when an untrusted compact event has throwing accessors", () => {
    const attack = Object.defineProperty({}, "kind", {
      enumerable: true,
      get(): never {
        throw new Error("getter must not escape");
      },
    });
    expect(parseCompactSessionEvent(attack)).toBeNull();
    expect(parseCompactSessionEvents([attack])).toBeNull();
  });

  test("never validates and then rereads stateful projected detail accessors", () => {
    let reads = 0;
    const deadlineAttack = Object.defineProperty({
      blocking: true,
      interactionId: "70000000-0000-4000-8000-000000000001",
      interactionKind: "user_input",
      kind: "interaction_state",
      revision: 1,
      sequence: 1,
      state: "pending",
      summary: "Codex asks for input",
    }, "deadlineAt", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? Date.now() + 60_000 : Number.NaN;
      },
    });
    expect(parseCompactSessionEvent(deadlineAttack)).toBeNull();
    expect(reads).toBe(0);

    const questionAttack = Object.defineProperty({
      id: "region",
      kind: "user_text",
      label: "Region",
      secret: false,
    }, "header", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "Deployment" : ["", "opt", "someone", "secret"].join("/");
      },
    });
    expect(parseCompactSessionEvents([{
      blocking: true,
      interactionId: "70000000-0000-4000-8000-000000000001",
      interactionKind: "user_input",
      kind: "interaction_state",
      questions: [questionAttack],
      revision: 1,
      sequence: 1,
      state: "pending",
      summary: "Codex asks for input",
    }])).toBeNull();
    expect(reads).toBe(0);
  });

  test("never inherits remote authority from a polluted object prototype", () => {
    const prototype = Object.prototype as Record<string, unknown>;
    Object.defineProperties(prototype, {
      detailVersion: { configurable: true, value: 2 },
      remotePolicy: {
        configurable: true,
        value: {
          actions: ["answer"],
          deadlineAt: Date.now() + 60_000,
          questions: [{
            allowsOther: false,
            header: "Region",
            id: "region",
            kind: "user_input",
            options: [{ description: "Primary", label: "East" }],
            question: "Which region?",
          }],
          reasonCodes: [],
          version: 2,
        },
      },
    });
    let parsed: ReturnType<typeof parseCompactSessionEvent> = null;
    try {
      const detailFree = {
        blocking: true,
        interactionId: "70000000-0000-4000-8000-000000000001",
        interactionKind: "user_input",
        kind: "interaction_state",
        revision: 1,
        sequence: 1,
        state: "pending",
        summary: "Codex asks for input",
      } as const;
      expect(compactInteractionDetailOf(detailFree)).toEqual({});
      parsed = parseCompactSessionEvent(detailFree);
      expect(parsed).not.toBeNull();
      expect(parsed && Object.hasOwn(parsed, "remotePolicy")).toBe(false);
      expect(parsed && parsed.kind === "interaction_state" ? parsed.remotePolicy : undefined)
        .toBeUndefined();
    } finally {
      delete prototype.detailVersion;
      delete prototype.remotePolicy;
    }
    expect(parsed).not.toBeNull();
    expect(parsed && "remotePolicy" in parsed).toBe(false);
  });

  test("carries bounded interaction detail and refuses a path or secret shaped one", () => {
    const base = {
      blocking: true,
      interactionId: "70000000-0000-4000-8000-000000000001",
      interactionKind: "command_approval",
      kind: "interaction_state",
      revision: 3,
      sequence: 1,
      state: "pending",
      summary: "Codex requests command approval",
    } as const;
    const detailed = {
      ...base,
      availableDecisions: ["once", "decline"],
      commandClass: "git commit",
      detailMarkdown: "- Runs: git commit\n- Directory: src/cloud",
      detailVersion: 1,
      headline: "Allow git commit",
      label: "Command approval",
    } as const;
    expect(parseCompactSessionEvents([detailed])).toEqual([detailed]);

    const questioned = {
      ...base,
      interactionKind: "user_input",
      questions: [
        { id: "where", label: "Where should it run", secret: false },
        { id: "token", label: "Provider token", secret: true },
      ],
    } as const;
    expect(parseCompactSessionEvents([questioned])).toEqual([questioned]);

    // An older reader ignores the whole block; a newer one that does not know
    // the revision must ignore it too rather than misread a field.
    expect(parseCompactSessionEvents([{ ...detailed, detailVersion: 3 }])).toEqual([base]);

    // Path-shaped and secret-shaped detail is refused outright: the emitter
    // redacts before it writes, so a value that reaches here unredacted is a
    // writer that cannot be trusted with the rest of the event either.
    const absoluteFixture = ["", "opt", "private", "repo"].join("/");
    const secretFixture = ["Bearer", "secret-token-value"].join(" ");
    for (const unsafe of [
      { detailMarkdown: `- Directory: ${absoluteFixture}` },
      { detailMarkdown: `- Reason: ${secretFixture}` },
      { headline: `Allow rm at ${absoluteFixture}` },
      { headline: secretFixture },
      { commandClass: absoluteFixture },
      { label: "Commandapproval" },
      { headline: "owned\u202etxt" },
    ]) expect(parseCompactSessionEvents([{ ...detailed, ...unsafe }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...questioned,
      questions: [{ id: "where", label: absoluteFixture, secret: false }],
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...questioned,
      questions: [{ id: absoluteFixture, label: "Where", secret: false }],
    }])).toBeNull();

    // The remote decision vocabulary is closed: session scope cannot be
    // written into a projection at all, and a decision must be a decision.
    for (const decisions of [["session"], ["cancel"], ["once", "once"], [], "once"]) {
      expect(parseCompactSessionEvents([{ ...detailed, availableDecisions: decisions }])).toBeNull();
    }

    // Every field is bounded and every list is capped.
    expect(parseCompactSessionEvents([{ ...detailed, detailMarkdown: "x".repeat(2_049) }])).toBeNull();
    expect(parseCompactSessionEvents([{ ...detailed, headline: "x".repeat(257) }])).toBeNull();
    expect(parseCompactSessionEvents([{ ...detailed, label: "x".repeat(65) }])).toBeNull();
    expect(parseCompactSessionEvents([{ ...detailed, commandClass: "x".repeat(129) }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...questioned,
      questions: Array.from({ length: 9 }, (_, index) => ({
        id: `q${String(index)}`,
        label: "Which",
        secret: false,
      })),
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...questioned,
      questions: [{ id: "a", label: "A", secret: false }, { id: "a", label: "B", secret: false }],
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...questioned,
      questions: [{ id: "a", label: "A" }],
    }])).toBeNull();

    // An older writer's detail-free event and a newer writer's detailed one
    // decode together, and an unknown key on either is still tolerated.
    expect(parseCompactSessionEvents([
      base,
      { ...detailed, hypotheticalFutureField: true, sequence: 2 },
    ])).toEqual([base, { ...detailed, sequence: 2 }]);
  });

  test("parses strict v2 remote policy and fails closed across version and coherence edges", () => {
    const base = {
      blocking: true,
      interactionId: "70000000-0000-4000-8000-000000000011",
      interactionKind: "command_approval",
      kind: "interaction_state",
      revision: 4,
      sequence: 1,
      state: "pending",
      summary: "Codex requests command approval",
    } as const;
    const remotePolicy = {
      actions: ["decline"],
      deadlineAt: 2_000_000_000_000,
      questions: [],
      reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
      version: 2,
    } as const;
    const detailed = {
      ...base,
      detailMarkdown: "- Runs: git commit\n- Directory: src/cloud",
      detailVersion: 2,
      headline: "Allow git commit",
      label: "Command approval",
      remotePolicy,
    } as const;
    expect(parseCompactSessionEvents([detailed])).toEqual([detailed]);

    // An unknown nested policy revision retains safe presentation but grants
    // no action. An unknown detail revision drops every detail field.
    expect(parseCompactSessionEvents([{
      ...detailed,
      remotePolicy: { future: "ignored", version: 1 },
    }])).toEqual([{
      ...base,
      detailMarkdown: detailed.detailMarkdown,
      detailVersion: 2,
      headline: detailed.headline,
      label: detailed.label,
    }]);
    expect(parseCompactSessionEvents([{
      ...detailed,
      detailVersion: 99,
      remotePolicy: { version: 99 },
    }])).toEqual([base]);

    for (const malformed of [
      { ...detailed, availableDecisions: ["once"] },
      { ...detailed, commandClass: "git commit" },
      { ...detailed, questions: [] },
      { ...detailed, remotePolicy: undefined },
      { ...detailed, remotePolicy: { ...remotePolicy, actions: ["answer", "decline"] } },
      { ...detailed, remotePolicy: { ...remotePolicy, actions: ["decline", "decline"] } },
      { ...detailed, remotePolicy: { ...remotePolicy, actions: ["cancel"] } },
      { ...detailed, remotePolicy: { ...remotePolicy, commandClass: "git commit" } },
      { ...detailed, remotePolicy: { ...remotePolicy, questions: [{ kind: "mcp_string" }] } },
      { ...detailed, remotePolicy: { ...remotePolicy, reasonCodes: ["FUTURE_REASON"] } },
      {
        ...detailed,
        remotePolicy: { ...remotePolicy, reasonCodes: ["USER_INPUT_METADATA_UNPROJECTABLE"] },
      },
      { ...detailed, remotePolicy: { ...remotePolicy, unexpected: true } },
      { ...detailed, remotePolicy: { ...remotePolicy, reasonCodes: [] } },
    ]) expect(parseCompactSessionEvents([malformed])).toBeNull();

    const userQuestion = {
      allowsOther: false,
      header: "Region",
      id: "region",
      kind: "user_input",
      options: [{ description: "Europe", label: "eu" }],
      question: "Which region?",
    } as const;
    const user = {
      ...base,
      detailVersion: 2,
      interactionKind: "user_input",
      remotePolicy: {
        actions: ["answer"],
        deadlineAt: remotePolicy.deadlineAt,
        questions: [userQuestion],
        reasonCodes: [],
        version: 2,
      },
    } as const;
    expect(parseCompactSessionEvents([user])).toEqual([user]);
    expect(parseCompactSessionEvents([{
      ...user,
      remotePolicy: {
        ...user.remotePolicy,
        questions: [{ ...userQuestion, options: [] }],
      },
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...user,
      remotePolicy: {
        ...user.remotePolicy,
        questions: [{ ...userQuestion, header: "one_time_code" }],
      },
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...user,
      remotePolicy: {
        ...user.remotePolicy,
        questions: [{ ...userQuestion, options: null }],
      },
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...user,
      remotePolicy: {
        ...user.remotePolicy,
        questions: [userQuestion, { ...userQuestion, id: "region-backup" }],
      },
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...user,
      remotePolicy: {
        ...user.remotePolicy,
        reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
      },
    }])).toBeNull();

    const mcpQuestion = {
      id: "region",
      kind: "mcp_string",
      label: "region",
      maxLength: 24,
      minLength: 2,
      required: true,
    } as const;
    const mcp = {
      ...base,
      detailVersion: 2,
      interactionKind: "mcp_elicitation",
      remotePolicy: {
        actions: [],
        deadlineAt: remotePolicy.deadlineAt,
        questions: [],
        reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
        version: 2,
      },
    } as const;
    expect(parseCompactSessionEvents([mcp])).toEqual([mcp]);
    expect(parseCompactSessionEvents([{
      ...mcp,
      remotePolicy: {
        ...mcp.remotePolicy,
        reasonCodes: [
          "MCP_MODE_UNSUPPORTED",
          "MCP_FIELDS_MISSING",
          "MCP_ANSWER_LOCAL_ONLY",
        ],
      },
    }])).not.toBeNull();
    expect(parseCompactSessionEvents([{
      ...mcp,
      remotePolicy: {
        actions: ["answer"],
        deadlineAt: remotePolicy.deadlineAt,
        questions: [mcpQuestion],
        reasonCodes: [],
        version: 2,
      },
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...mcp,
      remotePolicy: {
        actions: ["answer"],
        deadlineAt: remotePolicy.deadlineAt,
        questions: [mcpQuestion],
        reasonCodes: [],
        version: 1,
      },
    }])).toEqual([{
      ...base,
      detailVersion: 2,
      interactionKind: "mcp_elicitation",
    }]);

    const prepared = {
      ...base,
      detailVersion: 2,
      state: "response_prepared",
      remotePolicy: {
        actions: [],
        deadlineAt: remotePolicy.deadlineAt,
        questions: [],
        reasonCodes: ["INTERACTION_NOT_PENDING"],
        version: 2,
      },
    } as const;
    expect(parseCompactSessionEvents([prepared])).toEqual([prepared]);
    expect(parseCompactSessionEvents([{
      ...prepared,
      remotePolicy,
    }])).toBeNull();
    expect(parseCompactSessionEvents([{
      ...prepared,
      remotePolicy: {
        ...prepared.remotePolicy,
        reasonCodes: ["INTERACTION_NOT_PENDING", "COMMAND_APPROVAL_LOCAL_ONLY"],
      },
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
