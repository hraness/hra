import { describe, expect, test } from "bun:test";

import { publicProviderIdentifierSchema } from "../public-provider-identifier";
import {
  WORK_OPERATION_CONTRACTS,
  WORK_OPERATION_KINDS,
  WORK_PROTOCOL,
  WORK_PROTOCOL_VERSION,
  WORK_EFFECT_RESOLUTION_LIMIT,
  WORK_EVENT_STREAM_LINE_MAX_BYTES,
  WORK_STREAM_FAILURE_MAX_BYTES,
  WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
  WORK_TASK_HISTORY_MEMBERSHIP_LIMIT,
  WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT,
  WORK_TASK_HISTORY_VERSION_LIMIT,
  workAttemptReportRecordSchema,
  workEventBodySchema,
  workOperationResultSchema,
  workOperationSchema,
  workSignalDeliveryStateSchema,
  workSignalRecordSchema,
  workTaskHistoryItemSchema,
} from "./work";
import {
  WORK_PROTOCOL_CONTRACT_DIGEST,
  WORK_PROTOCOL_DOCUMENT_MAX_BYTES,
  WORK_PROTOCOL_TOPICS,
  WORK_PROTOCOL_TYPE_NAMES,
  describeWorkProtocol,
  workAgentProtocolErrorSchema,
  workAgentProtocolResponseSchema,
  workProtocolDocumentSchema,
  type WorkProtocolQuery,
} from "./work-protocol";
import { terminalSafeJson } from "./terminal-json";

type TypeUse = string | Readonly<{
  const?: string | number | boolean | null;
  ref?: string;
  nullable?: true;
  list?: Readonly<{ min: number; max: number; unique?: true }>;
}>;

type Shape = Readonly<{
  required: Readonly<Record<string, TypeUse>>;
  optional: Readonly<Record<string, TypeUse>>;
  rules: readonly string[];
}>;

type TypeDefinition =
  | Readonly<{
      kind: "scalar";
      wire: string;
      format?: string;
      maximum?: number;
      maxBytes?: number;
      minBytes?: number;
      pattern?: string;
    }>
  | Readonly<{ kind: "enum"; values: readonly unknown[] }>
  | Readonly<{
      kind: "object";
      required: Shape["required"];
      optional: Shape["optional"];
      rules: readonly string[];
    }>
  | Readonly<{
      kind: "union";
      discriminator: string;
      variants: Readonly<Record<string, Shape>>;
    }>;

const sortedKeys = (value: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(value).sort();

const resultOf = (query: WorkProtocolQuery): Readonly<Record<string, unknown>> =>
  describeWorkProtocol(query).result as Readonly<Record<string, unknown>>;

const definitionOf = (name: typeof WORK_PROTOCOL_TYPE_NAMES[number]): TypeDefinition =>
  resultOf({ kind: "type", name }).definition as TypeDefinition;

describe("queryable HRA work protocol", () => {
  test("serves deterministic, independently bounded shards under one digest", () => {
    const queries: WorkProtocolQuery[] = [
      { kind: "index" },
      ...WORK_OPERATION_KINDS.map((operation): WorkProtocolQuery => ({ kind: "operation", operation })),
      ...WORK_PROTOCOL_TYPE_NAMES.map((name): WorkProtocolQuery => ({ kind: "type", name })),
      ...WORK_PROTOCOL_TOPICS.map((topic): WorkProtocolQuery => ({ kind: "topic", topic })),
    ];

    for (const query of queries) {
      const first = describeWorkProtocol(query);
      const second = describeWorkProtocol(query);
      expect(workProtocolDocumentSchema.parse(first)).toEqual(first);
      expect(second).toEqual(first);
      expect(first.contractDigest).toBe(WORK_PROTOCOL_CONTRACT_DIGEST);
      expect(Buffer.byteLength(`${terminalSafeJson({
        ok: true,
        version: 1,
        command: "work.protocol",
        data: first,
      })}\n`, "utf8"))
        .toBeLessThanOrEqual(WORK_PROTOCOL_DOCUMENT_MAX_BYTES);
    }
    expect(WORK_PROTOCOL_CONTRACT_DIGEST).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("keeps the bootstrap compact while advertising every command and selector", () => {
    const result = resultOf({ kind: "index" }) as Readonly<{
      commands: Readonly<Record<string, unknown>>;
      query: Readonly<{ operationKinds: readonly string[]; topics: readonly string[] }>;
      recoveryDirectives: readonly string[];
      effectUnknownRecovery: string;
      applyFailureRequestId: string;
      applyErrorRequiredFields: readonly string[];
      responseByteLimit: number;
      responseByteLimitScope: string;
    }>;
    expect(Object.keys(result.commands)).toEqual([
      "work.protocol",
      "work.apply",
      "work.snapshot",
      "work.task",
      "work.poll",
      "work.events",
      "work.watch",
    ]);
    expect(result.query.operationKinds).toEqual([...WORK_OPERATION_KINDS]);
    expect(result.query.topics).toEqual([...WORK_PROTOCOL_TOPICS]);
    expect(result.recoveryDirectives).toEqual([
      "none",
      "replay_exact_request",
      "retry_same_request",
      "refresh_state_then_new_request",
    ]);
    expect(result.effectUnknownRecovery).toBe("replay_exact_request");
    expect(result.applyFailureRequestId).toBe("nullable_only_pre_admission");
    expect(result.applyErrorRequiredFields).toEqual([
      "code",
      "message",
      "retryable",
      "recovery",
      "exitCode",
    ]);
    expect(result.responseByteLimit).toBe(WORK_PROTOCOL_DOCUMENT_MAX_BYTES);
    expect(result.responseByteLimitScope).toBe(
      "exact terminal-safe compact readSuccess envelope plus LF",
    );

    const poll = result.commands["work.poll"] as Readonly<{
      options: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
    }>;
    expect(poll.options["--limit"]?.default).toBe(20);
    expect(poll.options["--wait-ms"]?.default).toBe(0);
    const events = result.commands["work.events"] as Readonly<{
      options: Readonly<Record<string, unknown>>;
      rules: readonly string[];
    }>;
    expect(Object.keys(events.options)).toEqual([
      "--cursor",
      "--limit",
      "--wait-ms",
      "--json",
      "--jsonl",
      "--follow",
    ]);
    expect(events.rules).toContain("jsonl-and-follow-may-be-combined");
    const task = result.commands["work.task"] as Readonly<{
      options: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      result: string;
    }>;
    expect(task.options["--history-limit"]).toEqual({
      type: "integer",
      minimum: 1,
      maximum: WORK_TASK_HISTORY_ITEM_LIMIT,
      defaultWhenHistoryMode: WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
    });
    expect(task.options["--history-cursor"]).toEqual({ type: "TaskHistoryCursor" });
    expect(task.result).toBe("TaskDetail|TaskHistoryPage");
  });

  test("keeps all eighteen operation fields in parity with the executable schemas", () => {
    expect(WORK_OPERATION_KINDS).toHaveLength(18);
    expect(WORK_OPERATION_CONTRACTS).toHaveLength(WORK_OPERATION_KINDS.length);
    for (const executable of WORK_OPERATION_CONTRACTS) {
      const result = resultOf({ kind: "operation", operation: executable.kind }) as Readonly<{
        contract: Readonly<{ kind: string; input: Shape; output: Shape }>;
        references: readonly string[];
      }>;
      expect(result.contract.kind).toBe(executable.kind);
      expect(sortedKeys(result.contract.input.required)).toEqual([...executable.required].sort());
      expect(sortedKeys(result.contract.input.optional)).toEqual([...executable.optional].sort());
      expect(sortedKeys(result.contract.output.required)).toEqual([...executable.result].sort());
      expect(sortedKeys(result.contract.output.optional)).toEqual([]);
      expect(result.references.every((reference) =>
        (WORK_PROTOCOL_TYPE_NAMES as readonly string[]).includes(reference))).toBe(true);
      expect(result.contract.input.required.kind).toEqual({ const: executable.kind });

      const inputOption = workOperationSchema.options.find((option) =>
        option.shape.kind.value === executable.kind);
      const outputOption = workOperationResultSchema.options.find((option) =>
        option.shape.kind.value === executable.kind);
      if (inputOption === undefined || outputOption === undefined) {
        throw new Error(`Missing executable schema for ${executable.kind}.`);
      }
      const inputShape = (inputOption as unknown as Readonly<{
        shape: Readonly<Record<string, Readonly<{ isOptional(): boolean }>>>;
      }>).shape;
      const executableInput = Object.entries(inputShape);
      expect(sortedKeys(result.contract.input.required)).toEqual(executableInput
        .filter(([, schema]) => !schema.isOptional())
        .map(([field]) => field)
        .sort());
      expect(sortedKeys(result.contract.input.optional)).toEqual(executableInput
        .filter(([, schema]) => schema.isOptional())
        .map(([field]) => field)
        .sort());
      expect(sortedKeys(result.contract.output.required)).toEqual(
        Object.keys(outputOption.shape).sort(),
      );
    }

    const release = resultOf({ kind: "operation", operation: "work.release" }) as Readonly<{
      contract: Readonly<{ input: Shape }>;
    }>;
    expect(release.contract.input.required.acknowledgeDataLoss).toEqual({ const: true });
    const dispatch = resultOf({ kind: "operation", operation: "attempt.dispatch" }) as Readonly<{
      contract: Readonly<{ input: Shape }>;
    }>;
    expect(dispatch.contract.input.required.mode).toEqual({ const: "send" });
    const signal = resultOf({ kind: "operation", operation: "signal.send" }) as Readonly<{
      contract: Readonly<{ input: Shape }>;
    }>;
    expect(signal.contract.input.required.mode).toBe("SignalMode");
    const reconcile = resultOf({ kind: "operation", operation: "attempt.reconcile" }) as Readonly<{
      contract: Readonly<{ input: Shape }>;
    }>;
    expect(reconcile.contract.input.required.outcome).toBe("ReconcileOutcome");
  });

  test("publishes closed review and reconciliation variants sufficient for synthesis", () => {
    const review = definitionOf("ReviewInput");
    expect(review.kind).toBe("union");
    if (review.kind !== "union") throw new Error("Expected ReviewInput union.");
    expect(review.discriminator).toBe("decision");
    expect(Object.keys(review.variants)).toEqual(["accept", "revise", "reject"]);
    expect(sortedKeys(review.variants.revise?.required ?? {})).toEqual(["evidence", "feedback"]);

    const reconcile = definitionOf("ReconcileOutcome");
    expect(reconcile.kind).toBe("union");
    if (reconcile.kind !== "union") throw new Error("Expected ReconcileOutcome union.");
    expect(reconcile.discriminator).toBe("kind");
    expect(Object.keys(reconcile.variants)).toEqual([
      "completed",
      "failed",
      "no_effect",
      "still_unknown",
    ]);
    expect(sortedKeys(reconcile.variants.completed?.required ?? {}))
      .toEqual(["evidence", "result", "summary"]);
    for (const variant of ["failed", "no_effect", "still_unknown"] as const) {
      expect(sortedKeys(reconcile.variants[variant]?.required ?? {}))
        .toEqual(["evidence", "summary"]);
    }
  });

  test("keeps signal field names and delivery enum in exact wire parity", () => {
    const signal = workSignalRecordSchema.parse({
      id: `sig_${"1".repeat(32)}`,
      senderSessionId: `sess_${"2".repeat(32)}`,
      targetSessionId: `sess_${"3".repeat(32)}`,
      accountGeneration: 1,
      taskId: null,
      replyToSignalId: null,
      mode: "queue",
      deliveryState: "pending",
      deliveryReceipt: null,
      body: "coordinate",
      revision: 1,
      createdAt: 1,
      acknowledgedAt: null,
    });
    const signalDefinition = definitionOf("SignalRecord");
    expect(signalDefinition.kind).toBe("object");
    if (signalDefinition.kind !== "object") throw new Error("Expected SignalRecord object.");
    expect(sortedKeys(signalDefinition.required)).toEqual(sortedKeys(signal));
    expect(signalDefinition.required.deliveryState).toBe("SignalDeliveryState");
    expect(signalDefinition.required).not.toHaveProperty("status");

    const deliveryState = definitionOf("SignalDeliveryState");
    expect(deliveryState.kind).toBe("enum");
    if (deliveryState.kind !== "enum") throw new Error("Expected SignalDeliveryState enum.");
    expect(deliveryState.values).toEqual(workSignalDeliveryStateSchema.options);
    expect(deliveryState.values).not.toContain("acknowledged");
  });

  test("publishes attempt-report idempotency keys as stable public correlation identity", () => {
    const report = workAttemptReportRecordSchema.parse({
      idempotencyKey: "018f1f64-6c17-7d35-8f8e-b24a1d3a5211",
      taskId: `task_${"1".repeat(32)}`,
      attemptId: `watt_${"2".repeat(32)}`,
      reportKind: "checkpoint",
      report: { kind: "checkpoint", summary: "Correlate this exact public report.", evidence: [] },
      reportDigest: "3".repeat(64),
      createdAt: 1,
    });
    const definition = definitionOf("AttemptReportRecord");
    expect(definition.kind).toBe("object");
    if (definition.kind !== "object") throw new Error("Expected AttemptReportRecord object.");
    expect(sortedKeys(definition.required)).toEqual(sortedKeys(report));
    expect(definition.required.idempotencyKey).toBe("IdempotencyKey");
    expect(definition.rules).toContain(
      "attempt-report.idempotency-key-is-stable-public-identity",
    );
  });

  test("publishes the exact opaque provider identifier accepted by evidence and receipts", () => {
    const value = publicProviderIdentifierSchema.parse(`opaque_v2_${"a".repeat(64)}`);
    const definition = definitionOf("ProviderId");
    expect(definition).toMatchObject({
      kind: "scalar",
      format: "opaque_v2_<64-lower-hex>",
    });
    if (definition.kind !== "scalar") throw new Error("Expected ProviderId scalar.");
    expect(definition.pattern).toBe("^opaque_v2_[0-9a-f]{64}$");
    expect(definition.minBytes).toBe(Buffer.byteLength(value, "utf8"));
    expect(definition.maxBytes).toBe(Buffer.byteLength(value, "utf8"));
  });

  test("keeps every event variant and field in executable schema parity", () => {
    const eventBody = definitionOf("EventBody");
    expect(eventBody.kind).toBe("union");
    if (eventBody.kind !== "union") throw new Error("Expected EventBody union.");
    expect(eventBody.discriminator).toBe("type");

    const executableTypes = workEventBodySchema.options.map((option) =>
      option.shape.type.value);
    expect(Object.keys(eventBody.variants)).toEqual(executableTypes);
    for (const option of workEventBodySchema.options) {
      const type = option.shape.type.value;
      const variant = eventBody.variants[type];
      if (variant === undefined) throw new Error(`Missing event contract for ${type}.`);
      expect(sortedKeys(variant.required)).toEqual(
        Object.keys(option.shape).filter((field) => field !== "type").sort(),
      );
      expect(variant.optional).toEqual({});
    }
  });

  test("publishes bounded point-in-time task history without adding a command", () => {
    const reviewItem = workTaskHistoryItemSchema.parse({
      kind: "review",
      taskId: `task_${"1".repeat(32)}`,
      value: {
        id: `review_${"2".repeat(32)}`,
        submissionId: `sub_${"3".repeat(32)}`,
        reviewerSessionId: `sess_${"4".repeat(32)}`,
        decision: "revise",
        summary: "The public review remains bound to its task.",
        evidence: [],
        createdAt: 1,
      },
    });
    const item = definitionOf("TaskHistoryItem");
    expect(item.kind).toBe("union");
    if (item.kind !== "union") throw new Error("Expected TaskHistoryItem union.");
    expect(item.discriminator).toBe("kind");
    expect(Object.keys(item.variants)).toEqual([
      "attempt",
      "attempt_report",
      "submission",
      "review",
      "signal",
    ]);
    expect(sortedKeys(item.variants.review?.required ?? {})).toEqual(
      sortedKeys(Object.fromEntries(
        Object.keys(reviewItem).filter((key) => key !== "kind").map((key) => [key, true]),
      )),
    );
    expect(item.variants.review?.required).toEqual({
      taskId: "TaskId",
      value: "ReviewRecord",
    });

    const page = definitionOf("TaskHistoryPage");
    expect(page.kind).toBe("object");
    if (page.kind !== "object") throw new Error("Expected TaskHistoryPage object.");
    expect(page.required.kind).toEqual({ const: "history" });
    expect(page.required.nextCursor).toEqual({ ref: "TaskHistoryCursor", nullable: true });
    expect(page.required.items).toEqual({
      ref: "TaskHistoryItem",
      list: { min: 0, max: WORK_TASK_HISTORY_ITEM_LIMIT },
    });
    expect(page.required.offset).toBe("TaskHistoryTotalCount");
    expect(page.required.totalItems).toBe("TaskHistoryTotalCount");
    expect(page.required.remainingItems).toBe("TaskHistoryTotalCount");
    expect(page.rules).toContain("task-history.fixed-point-in-time-public-projection");
    expect(page.rules).toContain("task-history.immutable-membership-ordinal-desc");

    const total = definitionOf("TaskHistoryTotalCount");
    expect(total).toMatchObject({
      kind: "scalar",
      format: "task-history-total-count",
      maximum: WORK_TASK_HISTORY_TOTAL_ITEM_LIMIT,
    });
    expect(definitionOf("TaskHistoryMembershipCount")).toMatchObject({
      kind: "scalar",
      maximum: WORK_TASK_HISTORY_MEMBERSHIP_LIMIT,
    });
    expect(definitionOf("TaskHistoryVersionCount")).toMatchObject({
      kind: "scalar",
      maximum: WORK_TASK_HISTORY_VERSION_LIMIT,
    });

    const discarded = definitionOf("DiscardedRecordCounts");
    expect(discarded.kind).toBe("object");
    if (discarded.kind !== "object") throw new Error("Expected discarded counts object.");
    expect(discarded.required).toEqual({
      routes: "RouteRecordCount",
      members: "MemberCount",
      tasks: "TaskCount",
      dependencies: "DependencyRecordCount",
      attempts: "TaskAttemptRecordCount",
      reports: "EventBoundedRecordCount",
      submissions: "TaskAttemptRecordCount",
      reviews: "EventBoundedRecordCount",
      signals: "EventBoundedRecordCount",
      receipts: "SignalReceiptRecordCount",
      events: "EventBoundedRecordCount",
      intents: "EventBoundedRecordCount",
      effects: "EventBoundedRecordCount",
      unresolvedSignalEffects: "EventBoundedRecordCount",
      effectResolutions: "EffectResolutionRecordCount",
      historyIndex: "TaskHistoryMembershipCount",
      historyVersions: "TaskHistoryVersionCount",
    });
    expect(definitionOf("EffectResolutionRecordCount")).toMatchObject({
      kind: "scalar",
      maximum: WORK_EFFECT_RESOLUTION_LIMIT,
    });

    const limits = resultOf({ kind: "topic", topic: "limits" }) as Readonly<{
      value: Readonly<Record<string, unknown>>;
    }>;
    expect(limits.value.taskHistoryMembershipPerWork).toBe(WORK_TASK_HISTORY_MEMBERSHIP_LIMIT);
    expect(limits.value.taskHistoryVersionsPerWork).toBe(WORK_TASK_HISTORY_VERSION_LIMIT);
    expect(limits.value.effectResolutionsPerWork).toBe(WORK_EFFECT_RESOLUTION_LIMIT);
    expect(limits.value.eventStreamLineBytes).toBe(WORK_EVENT_STREAM_LINE_MAX_BYTES);
    expect(limits.value.streamFailureBytes).toBe(WORK_STREAM_FAILURE_MAX_BYTES);

    const semantics = resultOf({ kind: "topic", topic: "semantics" }) as Readonly<{
      value: Readonly<Record<string, unknown>>;
    }>;
    expect(semantics.value.idempotency).toBe(
      "same UUIDv7 plus canonical-equivalent closed operation preserves the durable decision and stable identities/capabilities, performs no new mutation or event, and reprojects mutable public records and workRevision from current state; replay is not byte-identical; retained work.release tombstone replay is the exact stored-result exception",
    );
    expect(semantics.value.sensitivity).toEqual({
      capability: "bearer authority; never log or expose",
      attemptReportIdempotencyKey: "stable public correlation identity; not authority and not a bearer secret",
    });
    expect(semantics.value.readWireCaps).toContain("exact terminal-safe compact readSuccess envelope");
    expect(semantics.value.release).toContain("logical destructive purge");
    expect(semantics.value.release).toContain("no promise of immediate physical WAL or storage-media sanitization");
    expect(semantics.value.taskHistory).toEqual({
      cut: "the first page signs the work event sequence, membership high-water ordinal, task revision, projection time, and next offset",
      projection: "every page returns each included identity's newest append-only public record version at or before the signed event sequence",
      isolation: "later identities and later record transitions are excluded while the signed stream epoch remains retained",
      ordering: "immutable history membership ordinal descending; continuation preserves membership, order, counts, task revision, projection time, and observed-through cursor",
      progress: "a nonterminal page returns at least one item and a distinct next cursor; the full wire-response byte cap may shorten the requested page",
    });
  });

  test("advertises exact apply/read/JSONL envelopes and safe recovery semantics", () => {
    const envelopes = resultOf({ kind: "topic", topic: "envelopes" }) as Readonly<{
      value: Readonly<Record<string, unknown>>;
    }>;
    expect(envelopes.value).toMatchObject({
      applyRequest: {
        closed: true,
        required: {
          protocol: { const: WORK_PROTOCOL },
          version: { const: WORK_PROTOCOL_VERSION },
          requestId: "RequestId",
        },
      },
      applySuccess: { closed: true },
      applyFailure: { closed: true },
      readSuccess: { closed: true },
      readFailure: { closed: true },
      stream: {
        stdout: "WorkEventStreamLine JSON Lines only",
        frameBytes: "limits.eventStreamLineBytes",
        failureBytes: "limits.streamFailureBytes",
        gracefulExitCode: 0,
      },
    });

    const events = resultOf({ kind: "topic", topic: "events" }) as Readonly<{
      value: Readonly<Record<string, unknown>>;
    }>;
    expect(events.value.frameCommit).toContain("before writing any");
    expect(events.value.frameCommit).toContain("only after all frames are written");

    const errors = resultOf({ kind: "topic", topic: "errors" }) as Readonly<{
      value: Readonly<{ invariants: readonly string[] }>;
    }>;
    expect(errors.value.invariants).toContain(
      "effect_unknown always means replay the canonical-equivalent closed operation with the same idempotencyKey; JSON member order is immaterial",
    );

    expect(workAgentProtocolErrorSchema.safeParse({
      code: "effect_unknown",
      message: "Replay exactly.",
      retryable: true,
      recovery: "replay_exact_request",
      exitCode: 7,
    }).success).toBe(true);
    expect(workAgentProtocolErrorSchema.safeParse({
      code: "effect_unknown",
      message: "Unsafe recovery.",
      retryable: true,
      recovery: "retry_same_request",
      exitCode: 5,
    }).success).toBe(false);
    expect(workAgentProtocolErrorSchema.safeParse({
      code: "limit_exceeded",
      message: "Permanent per-work capacity.",
      retryable: true,
      recovery: "retry_same_request",
      exitCode: 5,
    }).success).toBe(false);
  });

  test("allows nullable correlation only before admission and never on success", () => {
    const preAdmission = {
      protocol: WORK_PROTOCOL,
      version: WORK_PROTOCOL_VERSION,
      requestId: null,
      ok: false,
      error: {
        code: "invalid_request",
        message: "Malformed input.",
        retryable: false,
        recovery: "none",
        exitCode: 2,
      },
    } as const;
    expect(workAgentProtocolResponseSchema.safeParse(preAdmission).success).toBe(true);
    expect(workAgentProtocolResponseSchema.safeParse({
      ...preAdmission,
      error: {
        code: "conflict",
        message: "Stale state.",
        retryable: false,
        recovery: "refresh_state_then_new_request",
        exitCode: 1,
      },
    }).success).toBe(false);
    expect(workAgentProtocolResponseSchema.safeParse({
      protocol: WORK_PROTOCOL,
      version: WORK_PROTOCOL_VERSION,
      requestId: null,
      ok: true,
      result: {},
    }).success).toBe(false);
  });
});
