import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { z } from "@hra-internal/schema";

import {
  chatPaneIdSchema,
  chatTurnIdSchema,
} from "../../../contracts/runtime";
import {
  actorEpochIdSchema,
  actorIdSchema,
  actorTurnIdSchema,
  actorTurnSchema,
} from "./actor-domain";
import type {
  HarnessContextOperationValuePortV2,
} from "./context-value-ports-v2";
import {
  HARNESS_DEFAULT_HEAP_UTF8_BYTES,
  HARNESS_MAX_ACTIVE_DESCENDANTS,
  HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
  HARNESS_MAX_DURABLE_DESCENDANTS,
  HARNESS_MAX_MESSAGE_UTF8_BYTES,
  HARNESS_MAX_RECURSION_DEPTH,
  contextValueIdSchema,
  recursiveBudgetSchema,
  type RecursiveBudget,
} from "./domain";
import {
  deriveRootActorId,
  deriveRootActorTurnId,
  deriveRootEpochId,
} from "./root-actor-authority-v2";
import {
  HarnessRootProjectResolverV2Error,
  deriveHarnessProjectIdV2,
  type HarnessRootProjectResolverPortV2,
} from "./root-project-resolver-v2";
import type {
  HarnessRootPreProviderFailureV2,
  HarnessRootPreparationInputV2,
  HarnessRootTurnAdmissionInputV2,
} from "./root-session-lifecycle-v2";

const MIB = 1024 * 1024;
const V1_ROOT_TOKEN_BUDGET = 100_000;
// Stable for every turn in one v1 epoch while remaining a bounded authority.
const V1_ROOT_EPOCH_DEADLINE = "2038-01-01T00:00:00.000Z";

const canonicalTimestampSchema = z.string().length(24).datetime().refine(
  (value) => new Date(Date.parse(value)).toISOString() === value,
  "timestamp must use canonical UTC milliseconds",
);
const durableRepositoryIdSchema = z.string().min(1).max(128).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "repository identity must be trimmed and NUL-free",
);
const canonicalWorkingDirectorySchema = z.string().min(1).max(4_096).refine(
  (value) =>
    isAbsolute(value) && resolve(value) === value && !value.includes("\0"),
  "working directory must be an absolute canonical NUL-free path",
);
const titleSchema = z.string().min(1).max(160).refine(
  (value) => value === value.trim() && !value.includes("\0"),
  "root title must be trimmed and NUL-free",
);
const promptSchema = z.string().min(1).refine(
  (value) => !value.includes("\0"),
  "root prompt contains NUL",
);
const contextQuotaSchema = z.number().int().min(MIB).max(64 * MIB).refine(
  (value) => value % MIB === 0,
  "context quota must use whole MiB increments",
);
const sourceShaSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);

const admissionInputSchema = z.object({
  repositoryId: durableRepositoryIdSchema,
  canonicalWorkingDirectory: canonicalWorkingDirectorySchema,
  paneId: chatPaneIdSchema,
  chatTurnId: chatTurnIdSchema,
  title: titleSchema,
  prompt: promptSchema,
  createdAt: canonicalTimestampSchema,
  contextQuotaBytes: contextQuotaSchema
    .default(HARNESS_DEFAULT_HEAP_UTF8_BYTES),
  budget: recursiveBudgetSchema.optional(),
}).strict();

const projectResolutionSchema = z.object({
  repositoryId: durableRepositoryIdSchema,
  projectId: z.string().regex(/^proj_[a-f0-9]{24}$/u),
  canonicalWorkingDirectory: canonicalWorkingDirectorySchema,
  canonicalGitCommonDir: canonicalWorkingDirectorySchema,
  sourceSha: sourceShaSchema,
}).strict();

const preparedRootSchema = z.object({
  epoch: z.object({ id: actorEpochIdSchema }).passthrough(),
  actor: z.object({ id: actorIdSchema }).passthrough(),
  plannedTurnId: actorTurnIdSchema,
}).passthrough();

const admittedRootSchema = z.object({
  epoch: z.object({ id: actorEpochIdSchema }).passthrough(),
  actor: z.object({ id: actorIdSchema }).passthrough(),
  turn: z.object({
    id: actorTurnIdSchema,
    inputValueId: contextValueIdSchema,
    state: z.literal("running"),
  }).passthrough(),
}).passthrough();

const contextValueRecordSchema = z.object({
  epochId: actorEpochIdSchema,
  ownerActorId: actorIdSchema,
  sourceTurnId: actorTurnIdSchema.nullable(),
  valueId: contextValueIdSchema,
  kind: z.literal("text"),
  purpose: z.literal("currentInput"),
  nameDigest: z.null(),
  utf8Bytes: z.number().int().positive().max(
    HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
  ),
  quotaLimitBytes: contextQuotaSchema,
}).strict();
const putResultSchema = z.object({ value: contextValueRecordSchema }).strict();
const openResultSchema = z.object({
  plaintext: promptSchema,
  value: contextValueRecordSchema,
}).strict();

const preProviderSettlementInputSchema = z.object({
  turnId: actorTurnIdSchema,
  paneId: chatPaneIdSchema,
  failure: z.enum(["provider_start_ambiguous", "provider_unavailable"]),
  settledAt: canonicalTimestampSchema.optional(),
}).strict();

/**
 * Small structural seam implemented by HarnessRootSessionLifecycleV2. Keeping
 * provider start outside this port makes returning from `admit` the explicit
 * boundary after which a caller may attempt provider effects.
 */
export interface HarnessRootChatLifecyclePortV2 {
  prepareRoot(input: HarnessRootPreparationInputV2): Promise<unknown>;
  admitRootTurn(input: HarnessRootTurnAdmissionInputV2): Promise<unknown>;
  settleBeforeProvider(input: Readonly<{
    turnId: string;
    paneId: string;
    failure: HarnessRootPreProviderFailureV2;
    settledAt?: string;
  }>): Promise<unknown>;
}

export interface HarnessRootChatAdmissionResultV2 {
  readonly projectId: string;
  readonly sourceSha: string;
  readonly paneId: string;
  readonly chatTurnId: string;
  readonly epochId: string;
  readonly actorId: string;
  readonly turnId: string;
  readonly currentInputOperationId: string;
  readonly currentInputValueId: string;
  readonly readyForProvider: true;
}

export class HarnessRootChatAdmissionV2Error extends Error {
  readonly code:
    | "corrupt_dependency"
    | "identity_conflict"
    | "invalid_budget";

  constructor(
    code: HarnessRootChatAdmissionV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessRootChatAdmissionV2Error";
    this.code = code;
  }
}

/**
 * Owns the complete provider-neutral root admission prefix: exact repository
 * HEAD, stable root preparation, immutable encrypted current input, and root
 * turn admission. No account, process, provider thread, or provider turn value
 * can enter this boundary.
 */
export class HarnessRootChatAdmissionV2 {
  readonly #projects: HarnessRootProjectResolverPortV2;
  readonly #roots: HarnessRootChatLifecyclePortV2;
  readonly #values: HarnessContextOperationValuePortV2;

  constructor(options: Readonly<{
    projects: HarnessRootProjectResolverPortV2;
    roots: HarnessRootChatLifecyclePortV2;
    values: HarnessContextOperationValuePortV2;
  }>) {
    this.#projects = options.projects;
    this.#roots = options.roots;
    this.#values = options.values;
  }

  async admit(inputValue: unknown): Promise<HarnessRootChatAdmissionResultV2> {
    const input = admissionInputSchema.parse(inputValue);
    const budget = input.budget ?? defaultHarnessRootBudgetV1(
      input.createdAt,
      input.contextQuotaBytes,
    );
    assertBudgetAndPrompt(
      input.createdAt,
      input.prompt,
      budget,
      input.contextQuotaBytes,
    );

    const project = await this.#resolveProject(input);
    const rootInput = Object.freeze({
      projectId: project.projectId,
      sourceSha: project.sourceSha,
      paneId: input.paneId,
      chatTurnId: input.chatTurnId,
      title: input.title,
      budget,
      createdAt: input.createdAt,
    });
    const prepared = await this.#prepare(rootInput);
    const expectedEpochId = deriveRootEpochId({
      projectId: project.projectId,
      sourceSha: project.sourceSha,
      paneId: input.paneId,
    });
    const expectedActorId = deriveRootActorId(expectedEpochId);
    const expectedTurnId = deriveRootActorTurnId(
      expectedEpochId,
      input.chatTurnId,
    );
    if (
      prepared.epoch.id !== expectedEpochId ||
      prepared.actor.id !== expectedActorId ||
      prepared.plannedTurnId !== expectedTurnId
    ) {
      conflict("root preparation returned another stable identity");
    }

    const currentInputOperationId = deriveCurrentInputOperationId(
      expectedTurnId,
    );
    const currentInputValueId = deriveCurrentInputValueId(expectedTurnId);
    const valueIdentity = Object.freeze({
      epochId: expectedEpochId,
      ownerActorId: expectedActorId,
      sourceTurnId: null,
      valueId: currentInputValueId,
      kind: "text" as const,
      purpose: "currentInput" as const,
    });
    const put = await this.#putCurrentInput({
      operationId: currentInputOperationId,
      ...valueIdentity,
      plaintext: input.prompt,
      quotaLimitBytes: input.contextQuotaBytes,
      name: null,
    });
    assertContextValue(
      put.value,
      valueIdentity,
      input.prompt,
      input.contextQuotaBytes,
    );
    const opened = await this.#openCurrentInput(valueIdentity);
    assertContextValue(
      opened.value,
      valueIdentity,
      input.prompt,
      input.contextQuotaBytes,
    );
    if (opened.plaintext !== input.prompt) {
      conflict("replayed current input does not match the chat prompt");
    }

    const admitted = await this.#admit({
      ...rootInput,
      inputValueId: currentInputValueId,
    });
    if (
      admitted.epoch.id !== expectedEpochId ||
      admitted.actor.id !== expectedActorId ||
      admitted.turn.id !== expectedTurnId ||
      admitted.turn.inputValueId !== currentInputValueId
    ) {
      conflict("root admission returned another stable identity");
    }
    return Object.freeze({
      projectId: project.projectId,
      sourceSha: project.sourceSha,
      paneId: input.paneId,
      chatTurnId: input.chatTurnId,
      epochId: expectedEpochId,
      actorId: expectedActorId,
      turnId: expectedTurnId,
      currentInputOperationId,
      currentInputValueId,
      readyForProvider: true,
    });
  }

  async settleBeforeProvider(inputValue: unknown): Promise<Readonly<{
    turnId: string;
    state: "ambiguous" | "failed";
    outcomeCode: string;
  }>> {
    const input = preProviderSettlementInputSchema.parse(inputValue);
    const expected = input.failure === "provider_start_ambiguous"
      ? {
          state: "ambiguous" as const,
          outcomeCode: "codex_provider_start_ambiguous",
        }
      : {
          state: "failed" as const,
          outcomeCode: "codex_provider_unavailable_before_start",
        };
    let settled: z.infer<typeof actorTurnSchema>;
    try {
      settled = actorTurnSchema.parse(await this.#roots.settleBeforeProvider({
        turnId: input.turnId,
        paneId: input.paneId,
        failure: input.failure,
        ...(input.settledAt === undefined
          ? {}
          : { settledAt: input.settledAt }),
      }));
    } catch (cause: unknown) {
      throw corruptDependency("pre-provider root settlement failed", cause);
    }
    if (
      settled.id !== input.turnId || settled.state !== expected.state ||
      settled.outcomeCode !== expected.outcomeCode
    ) conflict("pre-provider root settlement returned another outcome");
    return Object.freeze({ turnId: settled.id, ...expected });
  }

  async #resolveProject(
    input: z.infer<typeof admissionInputSchema>,
  ): Promise<z.infer<typeof projectResolutionSchema>> {
    let project: z.infer<typeof projectResolutionSchema>;
    try {
      project = projectResolutionSchema.parse(
        await this.#projects.resolveExactProject({
          repositoryId: input.repositoryId,
          canonicalWorkingDirectory: input.canonicalWorkingDirectory,
          createdAt: input.createdAt,
        }),
      );
    } catch (cause: unknown) {
      if (
        cause instanceof HarnessRootProjectResolverV2Error &&
        cause.code === "identity_conflict"
      ) conflict(cause.message);
      throw corruptDependency("exact root project resolution failed", cause);
    }
    if (
      project.repositoryId !== input.repositoryId ||
      project.canonicalWorkingDirectory !== input.canonicalWorkingDirectory ||
      project.projectId !== deriveHarnessProjectIdV2(
        input.canonicalWorkingDirectory,
      )
    ) conflict("root project resolver echoed another repository identity");
    return project;
  }

  async #prepare(
    input: HarnessRootPreparationInputV2,
  ): Promise<z.infer<typeof preparedRootSchema>> {
    try {
      return preparedRootSchema.parse(await this.#roots.prepareRoot(input));
    } catch (cause: unknown) {
      throw corruptDependency("root preparation failed", cause);
    }
  }

  async #putCurrentInput(
    input: Parameters<HarnessContextOperationValuePortV2["putExact"]>[0],
  ): Promise<z.infer<typeof putResultSchema>> {
    try {
      return putResultSchema.parse(await this.#values.putExact(input));
    } catch (cause: unknown) {
      throw corruptDependency("current input publication failed", cause);
    }
  }

  async #openCurrentInput(
    input: Parameters<HarnessContextOperationValuePortV2["openExact"]>[0],
  ): Promise<z.infer<typeof openResultSchema>> {
    try {
      return openResultSchema.parse(await this.#values.openExact(input));
    } catch (cause: unknown) {
      throw corruptDependency("current input replay verification failed", cause);
    }
  }

  async #admit(
    input: HarnessRootTurnAdmissionInputV2,
  ): Promise<z.infer<typeof admittedRootSchema>> {
    try {
      return admittedRootSchema.parse(await this.#roots.admitRootTurn(input));
    } catch (cause: unknown) {
      throw corruptDependency("root turn admission failed", cause);
    }
  }
}

export function defaultHarnessRootBudgetV1(
  createdAtValue: string,
  contextQuotaBytesValue = HARNESS_DEFAULT_HEAP_UTF8_BYTES,
): RecursiveBudget {
  const createdAt = canonicalTimestampSchema.parse(createdAtValue);
  const contextQuotaBytes = contextQuotaSchema.parse(contextQuotaBytesValue);
  if (Date.parse(createdAt) >= Date.parse(V1_ROOT_EPOCH_DEADLINE)) {
    throw new HarnessRootChatAdmissionV2Error(
      "invalid_budget",
      "v1 root admission time exceeds the bounded epoch deadline",
    );
  }
  return recursiveBudgetSchema.parse({
    depthRemaining: HARNESS_MAX_RECURSION_DEPTH,
    activeDescendantLimit: HARNESS_MAX_ACTIVE_DESCENDANTS,
    durableDescendantLimit: HARNESS_MAX_DURABLE_DESCENDANTS,
    tokenBudget: V1_ROOT_TOKEN_BUDGET,
    deadline: V1_ROOT_EPOCH_DEADLINE,
    heapByteLimit: contextQuotaBytes,
    contextValueByteLimit: Math.min(
      HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
      contextQuotaBytes,
    ),
    messageByteLimit: HARNESS_MAX_MESSAGE_UTF8_BYTES,
    laneAuthority: "managedWrite",
  });
}

function assertBudgetAndPrompt(
  createdAt: string,
  prompt: string,
  budget: RecursiveBudget,
  contextQuotaBytes: number,
): void {
  const parsed = recursiveBudgetSchema.parse(budget);
  if (Date.parse(parsed.deadline) <= Date.parse(createdAt)) {
    throw new HarnessRootChatAdmissionV2Error(
      "invalid_budget",
      "root budget deadline must follow admission time",
    );
  }
  if (parsed.contextValueByteLimit > contextQuotaBytes) {
    throw new HarnessRootChatAdmissionV2Error(
      "invalid_budget",
      "root context-value budget exceeds its storage quota",
    );
  }
  if (parsed.heapByteLimit !== contextQuotaBytes) {
    throw new HarnessRootChatAdmissionV2Error(
      "invalid_budget",
      "root heap budget must equal its storage quota",
    );
  }
  if (Buffer.byteLength(prompt, "utf8") > parsed.contextValueByteLimit) {
    throw new HarnessRootChatAdmissionV2Error(
      "invalid_budget",
      "root prompt exceeds its context-value budget",
    );
  }
}

function assertContextValue(
  actual: z.infer<typeof contextValueRecordSchema>,
  expected: Readonly<{
    epochId: string;
    ownerActorId: string;
    sourceTurnId: null;
    valueId: string;
    kind: "text";
    purpose: "currentInput";
  }>,
  prompt: string,
  contextQuotaBytes: number,
): void {
  if (
    actual.epochId !== expected.epochId ||
    actual.ownerActorId !== expected.ownerActorId ||
    actual.sourceTurnId !== null || actual.valueId !== expected.valueId ||
    actual.kind !== expected.kind || actual.purpose !== expected.purpose ||
    actual.nameDigest !== null ||
    actual.utf8Bytes !== Buffer.byteLength(prompt, "utf8") ||
    actual.quotaLimitBytes !== contextQuotaBytes
  ) conflict("current input storage returned another immutable identity");
}

function deriveCurrentInputOperationId(turnId: string): string {
  return `rootinputop_${digest("oprte.harness.root-current-input-operation.v2", [
    turnId,
  ]).slice(0, 48)}`;
}

function deriveCurrentInputValueId(turnId: string): string {
  return contextValueIdSchema.parse(
    `ctxval_${digest("oprte.harness.root-current-input-value.v2", [
      turnId,
    ]).slice(0, 48)}`,
  );
}

function digest(domain: string, identities: readonly string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const identity of identities) {
    hash.update("\0", "utf8").update(identity, "utf8");
  }
  return hash.digest("hex");
}

function corruptDependency(
  message: string,
  cause: unknown,
): HarnessRootChatAdmissionV2Error {
  return new HarnessRootChatAdmissionV2Error(
    "corrupt_dependency",
    message,
    cause,
  );
}

function conflict(message: string): never {
  throw new HarnessRootChatAdmissionV2Error("identity_conflict", message);
}
