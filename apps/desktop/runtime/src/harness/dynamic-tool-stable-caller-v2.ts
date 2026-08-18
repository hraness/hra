import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

import {
  MAX_SESSION_HARNESS_HISTORY_ITEMS,
  MAX_SESSION_HARNESS_HISTORY_ITEM_UTF8_BYTES,
  MAX_SESSION_HARNESS_HISTORY_UTF8_BYTES,
} from "../sessions/session-service";
import {
  actorBudgetSchema,
  actorEpochSchema,
  actorSchema,
  actorTurnIdSchema,
  actorTurnSchema,
  type Actor,
  type ActorEpoch,
} from "./actor-domain";
import type {
  HarnessDynamicToolStableAdmission,
  HarnessDynamicToolStableCall,
  HarnessDynamicToolStableCallerPort,
} from "./dynamic-tool-service-v2";
import {
  contextSnapshotIdSchema,
  contextValueIdSchema,
  programRunIdSchema,
  recursiveBudgetSchema,
  type RecursiveBudget,
} from "./domain";
import {
  contextSnapshotRecordV2Schema,
  type ContextSnapshotRecordV2,
} from "./context-snapshot-authority-v2";
import {
  rlmRunRecordSchema,
  type RlmRunRecord,
} from "./rlm-run-authority-v2";
import { harnessFeatureSchema, type HarnessFeature } from "./semantic-gate";
import {
  digestRlmV2Program,
  parseRlmV2Caller,
  parseRlmV2Program,
  rlmV2CapabilitySchema,
  type RlmV2Caller,
  type RlmV2Capability,
  type RlmV2Program,
} from "./rlm-v2";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const nonnegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const privateIdSchema = z.string().min(1).max(512).refine(
  (value) => !value.includes("\0"),
  "private identity contains NUL",
);
const gatewayIdSchema = z.string().min(1).max(512).refine(
  (value) => !value.includes("\0"),
  "gateway identity contains NUL",
);
const canonicalStringArray = <Schema extends z.ZodTypeAny>(
  item: Schema,
  minimum: number,
  maximum: number,
) => z.array(item).min(minimum).max(maximum).refine(
  (values) => new Set(values).size === values.length,
  "accepted values must be unique",
).refine(
  (values) => values.every((value, index) =>
    index === 0 || values[index - 1]! < value
  ),
  "accepted values must use canonical lexical order",
);

const stableCallSchema = z.object({
  accountProfileId: z.string().min(1).max(512),
  accountGeneration: positiveSafeIntegerSchema,
  processGeneration: positiveSafeIntegerSchema,
  providerThreadId: privateIdSchema,
  providerTurnId: privateIdSchema,
  providerCallId: privateIdSchema,
  requestInstanceId: positiveSafeIntegerSchema,
  callDigest: digestSchema,
}).strict().refine(
  ({ accountGeneration, processGeneration }) =>
    accountGeneration === processGeneration,
  "account and process generations must match",
);

const sessionCallerSchema = z.object({
  generation: positiveSafeIntegerSchema,
  projectId: z.string().min(1).max(128),
  threadId: gatewayIdSchema,
  turnId: gatewayIdSchema,
  workspaceLaneId: gatewayIdSchema,
  workspaceMode: z.enum(["managed", "local", "readOnly"]),
  workspacePath: z.string().min(1).max(32_768).refine(
    (value) => !value.includes("\0"),
    "workspace path contains NUL",
  ),
}).strict();

const stableActorCallerSchema = z.object({
  epoch: actorEpochSchema,
  actor: actorSchema,
  turn: actorTurnSchema,
  completedThroughTurnId: actorTurnIdSchema.nullable(),
}).strict();

const completedHistoryItemSchema = z.object({
  ordinal: nonnegativeSafeIntegerSchema,
  turnId: gatewayIdSchema,
  itemClass: z.enum(["userMessage", "assistantMessage"]),
  text: z.string(),
}).strict();
const completedHistorySchema = z.object({
  coverage: z.enum(["complete", "partial", "unavailable"]),
  throughTurnId: gatewayIdSchema.nullable(),
  sourceGeneration: positiveSafeIntegerSchema,
  sourceStreamPosition: nonnegativeSafeIntegerSchema,
  coverageWitnessDigest: digestSchema,
  items: z.array(completedHistoryItemSchema)
    .max(MAX_SESSION_HARNESS_HISTORY_ITEMS),
}).strict();
const currentInputSchema = z.object({
  turnId: gatewayIdSchema,
  sourceGeneration: positiveSafeIntegerSchema,
  sourceStreamPosition: nonnegativeSafeIntegerSchema,
  coverageWitnessDigest: digestSchema,
  text: z.string(),
}).strict();
const contextAdmissionSchema = z.object({
  completedHistory: completedHistorySchema,
  currentInput: currentInputSchema,
}).strict();

const evidenceSettingsSchema = z.object({
  capabilities: canonicalStringArray(rlmV2CapabilitySchema, 0, 10),
  admittedFeatures: canonicalStringArray(harnessFeatureSchema, 1, 6).refine(
    (features) => features.includes("boundedPrograms"),
    "accepted features must include boundedPrograms",
  ),
  semanticWitnessDigests: canonicalStringArray(digestSchema, 1, 2),
  budget: recursiveBudgetSchema,
  releaseIdentityDigest: digestSchema,
}).strict();

const materializationResultSchema = z.object({
  completedPrefixSnapshotId: contextSnapshotIdSchema,
  currentUserInputValueId: contextValueIdSchema.nullable(),
  coverageWitnessDigest: digestSchema,
}).strict();

export const harnessDynamicToolCurrentInputProvenanceV2Schema =
  z.discriminatedUnion("purpose", [
    z.object({
      valueId: contextValueIdSchema,
      purpose: z.literal("currentInput"),
      sourceTurnId: z.null(),
    }).strict(),
    z.object({
      valueId: contextValueIdSchema,
      purpose: z.literal("actorTask"),
      sourceTurnId: actorTurnSchema.shape.id,
    }).strict(),
  ]);

export type HarnessDynamicToolCurrentInputProvenanceV2 = Readonly<
  z.infer<typeof harnessDynamicToolCurrentInputProvenanceV2Schema>
>;

const runIdentityInputSchema = z.object({
  epochId: actorEpochSchema.shape.id,
  actorId: actorSchema.shape.id,
  turnId: actorTurnSchema.shape.id,
  programDigest: digestSchema,
  providerCallId: privateIdSchema,
  stableAdmissionIdentityDigest: digestSchema,
}).strict();

type MaybePromise<Value> = Value | Promise<Value>;
type ParsedStableCall = z.infer<typeof stableCallSchema>;
type SessionCaller = z.infer<typeof sessionCallerSchema>;
type StableActorCaller = z.infer<typeof stableActorCallerSchema>;
type EvidenceSettings = z.infer<typeof evidenceSettingsSchema>;
type ContextAdmission = z.infer<typeof contextAdmissionSchema>;

export interface HarnessDynamicToolSessionPortV2 {
  resolveHarnessCaller(
    accountProfileId: string,
    generation: number,
    providerThreadId: string,
    providerTurnId: string,
  ): MaybePromise<unknown>;
  readHarnessContextAdmission(
    threadId: string,
    throughTurnId: string,
    expectedGeneration: number,
    signal: AbortSignal,
  ): MaybePromise<unknown>;
}

/**
 * Root resolution uses only gateway-owned identity. Nested resolution uses the
 * provider tuple only as a transient lookup into durable attempt authority.
 * Exactly one method must return a caller for any live request.
 */
export interface HarnessDynamicToolActorResolverPortV2 {
  resolveRootCaller(input: Readonly<{
    projectId: string;
    gatewayThreadId: string;
    gatewayTurnId: string;
  }>): MaybePromise<unknown>;
  resolveNestedCaller(input: Readonly<{
    accountProfileId: string;
    processGeneration: number;
    providerThreadId: string;
    providerTurnId: string;
  }>): MaybePromise<unknown>;
}

export interface HarnessDynamicToolCompletedPrefixItemV2 {
  readonly ordinal: number;
  readonly itemClass: "userMessage" | "assistantMessage";
  readonly text: string;
}

/** Provider generations, raw IDs, gateway IDs, and paths are absent. */
export interface HarnessDynamicToolContextMaterializationInputV2 {
  readonly runId: string;
  readonly epochId: string;
  readonly actorId: string;
  readonly turnId: string;
  readonly currentInputValueId: string;
  readonly currentInputProvenance: HarnessDynamicToolCurrentInputProvenanceV2;
  readonly completedThroughTurnId: string | null;
  readonly expiresAt: string;
  readonly programDigest: string;
  readonly stableAdmissionIdentityDigest: string;
  readonly coverageWitnessDigest: string;
  readonly completedPrefix: readonly HarnessDynamicToolCompletedPrefixItemV2[];
  readonly currentInput: string;
}

export interface HarnessDynamicToolContextMaterializationV2 {
  readonly completedPrefixSnapshotId: string;
  readonly currentUserInputValueId: string | null;
  readonly coverageWitnessDigest: string;
}

export interface HarnessDynamicToolContextMaterializerPortV2 {
  materialize(
    input: HarnessDynamicToolContextMaterializationInputV2,
  ): MaybePromise<unknown>;
}

export interface HarnessDynamicToolEvidenceSettingsV2 {
  readonly capabilities: readonly RlmV2Capability[];
  readonly admittedFeatures: readonly HarnessFeature[];
  readonly semanticWitnessDigests: readonly string[];
  readonly budget: RecursiveBudget;
  readonly releaseIdentityDigest: string;
}

export interface HarnessDynamicToolEvidenceSettingsPortV2 {
  readAcceptedSettings(input: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    requestInstanceId: number;
    accountProfileId: string;
    accountGeneration: number;
    processGeneration: number;
  }>): MaybePromise<unknown>;
}

export interface HarnessDynamicToolRunLookupPortV2 {
  readRun(runId: string): MaybePromise<unknown>;
  readContextSnapshot(snapshotId: string): MaybePromise<unknown>;
}

export interface HarnessDynamicToolStableCallerAuthorityV2Options {
  readonly sessions: HarnessDynamicToolSessionPortV2;
  readonly actors: HarnessDynamicToolActorResolverPortV2;
  readonly contexts: HarnessDynamicToolContextMaterializerPortV2;
  readonly evidence: HarnessDynamicToolEvidenceSettingsPortV2;
  readonly runs: HarnessDynamicToolRunLookupPortV2;
  readonly now?: () => number;
}

interface LiveCaller {
  readonly session: SessionCaller;
  readonly stable: StableActorCaller;
  readonly kind: "root" | "nested";
}

interface RunEvidence {
  readonly run: RlmRunRecord;
  readonly snapshot: ContextSnapshotRecordV2;
}

/**
 * Converts a private provider request into one durable RLM caller. The caller
 * and run identity contain only stable actor authority and accepted evidence.
 */
export class HarnessDynamicToolStableCallerAuthorityV2
implements HarnessDynamicToolStableCallerPort {
  readonly #sessions: HarnessDynamicToolSessionPortV2;
  readonly #actors: HarnessDynamicToolActorResolverPortV2;
  readonly #contexts: HarnessDynamicToolContextMaterializerPortV2;
  readonly #evidence: HarnessDynamicToolEvidenceSettingsPortV2;
  readonly #runs: HarnessDynamicToolRunLookupPortV2;
  readonly #now: () => number;

  constructor(options: HarnessDynamicToolStableCallerAuthorityV2Options) {
    this.#sessions = options.sessions;
    this.#actors = options.actors;
    this.#contexts = options.contexts;
    this.#evidence = options.evidence;
    this.#runs = options.runs;
    this.#now = options.now ?? Date.now;
  }

  async admit(input: Readonly<{
    call: HarnessDynamicToolStableCall;
    program: RlmV2Program;
    programDigest: string;
  }>): Promise<HarnessDynamicToolStableAdmission | null> {
    try {
      const call = stableCallSchema.parse(input.call);
      const program = parseRlmV2Program(input.program);
      const programDigest = digestSchema.parse(input.programDigest);
      if (digestRlmV2Program(program) !== programDigest) return null;

      const live = await this.#resolveLiveCaller(call);
      if (live === null) return null;
      const settings = await this.#readSettings(call, live);
      if (settings === null) return null;

      const stableAdmissionIdentityDigest =
        deriveHarnessDynamicToolStableCallIdentityDigest(call);
      const runId = deriveHarnessDynamicToolRunId({
        epochId: live.stable.epoch.id,
        actorId: live.stable.actor.id,
        turnId: live.stable.turn.id,
        programDigest,
        providerCallId: call.providerCallId,
        stableAdmissionIdentityDigest,
      });
      const existing = await this.#readRunEvidence(runId);
      if (existing !== null) {
        if (
          !runMatchesCaller(existing, live, settings, programDigest) ||
          !program.capabilities.every((capability) =>
            existing.run.capabilities.includes(capability)
          )
        ) return null;
        if (!await this.#remainsExact(call, live, settings)) return null;
        return admissionFromRun(existing.run);
      }

      const context = await this.#readContext(call, live);
      if (context === null) return null;
      const contextualSettings = grantExactContext(settings, context);
      if (
        contextualSettings === null ||
        !program.capabilities.every((capability) =>
          contextualSettings.capabilities.includes(capability)
        )
      ) return null;
      const materialized = materializationResultSchema.parse(
        await this.#contexts.materialize(materializationInput({
          runId,
          live,
          context,
          programDigest,
          stableAdmissionIdentityDigest,
        })),
      );
      if (
        materialized.coverageWitnessDigest !==
          context.completedHistory.coverageWitnessDigest ||
        (materialized.currentUserInputValueId !== null &&
          materialized.currentUserInputValueId !== live.stable.turn.inputValueId)
      ) return null;
      if (!await this.#remainsExact(call, live, settings)) return null;

      const raced = await this.#readRunEvidence(runId);
      if (raced !== null) {
        return runMatchesCaller(raced, live, settings, programDigest) &&
            exactJson(raced.run.capabilities) ===
              exactJson(contextualSettings.capabilities) &&
            exactJson(raced.run.admittedFeatures) ===
              exactJson(contextualSettings.admittedFeatures) &&
            exactJson(raced.run.semanticWitnessDigests) ===
              exactJson(contextualSettings.semanticWitnessDigests)
          ? admissionFromRun(raced.run)
          : null;
      }
      return admissionFromMaterialization({
        runId,
        live,
        settings: contextualSettings,
        materialized,
      });
    } catch {
      return null;
    }
  }

  async ownsRun(input: Readonly<{
    call: HarnessDynamicToolStableCall;
    runId: string;
  }>): Promise<boolean> {
    try {
      const call = stableCallSchema.parse(input.call);
      const runId = programRunIdSchema.parse(input.runId);
      const live = await this.#resolveLiveCaller(call);
      if (live === null) return false;
      const settings = await this.#readSettings(call, live);
      if (settings === null) return false;
      const evidence = await this.#readRunEvidence(runId);
      if (
        evidence === null ||
        !runIsInspectableByCurrentCaller(
          evidence,
          live,
          settings,
          this.#now(),
        )
      ) return false;
      return await this.#remainsCurrentOwner(call, live, settings, evidence);
    } catch {
      return false;
    }
  }

  async #resolveLiveCaller(call: ParsedStableCall): Promise<LiveCaller | null> {
    const sessionResult = sessionCallerSchema.safeParse(
      await this.#sessions.resolveHarnessCaller(
        call.accountProfileId,
        call.processGeneration,
        call.providerThreadId,
        call.providerTurnId,
      ),
    );
    if (
      !sessionResult.success ||
      sessionResult.data.generation !== call.processGeneration
    ) return null;
    const session = sessionResult.data;
    const [rootValue, nestedValue] = await Promise.all([
      this.#actors.resolveRootCaller(Object.freeze({
        projectId: session.projectId,
        gatewayThreadId: session.threadId,
        gatewayTurnId: session.turnId,
      })),
      this.#actors.resolveNestedCaller(Object.freeze({
        accountProfileId: call.accountProfileId,
        processGeneration: call.processGeneration,
        providerThreadId: call.providerThreadId,
        providerTurnId: call.providerTurnId,
      })),
    ]);
    if ((rootValue === null) === (nestedValue === null)) return null;
    const kind = rootValue === null ? "nested" : "root";
    const stableResult = stableActorCallerSchema.safeParse(
      rootValue === null ? nestedValue : rootValue,
    );
    if (!stableResult.success) return null;
    const stable = stableResult.data;
    if (!stableCallerIsLive(stable, session, kind, this.#now())) return null;
    return Object.freeze({ session, stable, kind });
  }

  async #readSettings(
    call: ParsedStableCall,
    live: LiveCaller,
  ): Promise<EvidenceSettings | null> {
    const parsed = evidenceSettingsSchema.safeParse(
      await this.#evidence.readAcceptedSettings(Object.freeze({
        epochId: live.stable.epoch.id,
        actorId: live.stable.actor.id,
        turnId: live.stable.turn.id,
        requestInstanceId: call.requestInstanceId,
        accountProfileId: call.accountProfileId,
        accountGeneration: call.accountGeneration,
        processGeneration: call.processGeneration,
      })),
    );
    if (!parsed.success) return null;
    return settingsFitCaller(parsed.data, live, this.#now())
      ? parsed.data
      : null;
  }

  async #readContext(
    call: ParsedStableCall,
    live: LiveCaller,
  ): Promise<ContextAdmission | null> {
    const parsed = contextAdmissionSchema.safeParse(
      await this.#sessions.readHarnessContextAdmission(
        live.session.threadId,
        live.session.turnId,
        call.processGeneration,
        new AbortController().signal,
      ),
    );
    if (!parsed.success) return null;
    return contextIsExact(parsed.data, live.session, call.processGeneration)
      ? parsed.data
      : null;
  }

  async #readRunEvidence(runId: string): Promise<RunEvidence | null> {
    const value = await this.#runs.readRun(runId);
    if (value === null) return null;
    const parsed = rlmRunRecordSchema.parse(value);
    if (parsed.id !== runId) return null;
    const snapshot = contextSnapshotRecordV2Schema.safeParse(
      await this.#runs.readContextSnapshot(parsed.completedPrefixSnapshotId),
    );
    return snapshot.success
      ? Object.freeze({ run: parsed, snapshot: snapshot.data })
      : null;
  }

  async #remainsExact(
    call: ParsedStableCall,
    prior: LiveCaller,
    priorSettings: EvidenceSettings,
  ): Promise<boolean> {
    const current = await this.#resolveLiveCaller(call);
    if (current === null || !sameLiveCaller(prior, current)) return false;
    const currentSettings = await this.#readSettings(call, current);
    return currentSettings !== null &&
      exactJson(currentSettings) === exactJson(priorSettings);
  }

  async #remainsCurrentOwner(
    call: ParsedStableCall,
    prior: LiveCaller,
    priorSettings: EvidenceSettings,
    evidence: RunEvidence,
  ): Promise<boolean> {
    const current = await this.#resolveLiveCaller(call);
    if (current === null || !sameLiveCaller(prior, current)) return false;
    const currentSettings = await this.#readSettings(call, current);
    return currentSettings !== null &&
      exactJson(currentSettings) === exactJson(priorSettings) &&
      runIsInspectableByCurrentCaller(
        evidence,
        current,
        currentSettings,
        this.#now(),
      );
  }
}

export function deriveHarnessDynamicToolRunId(inputValue: Readonly<{
  epochId: string;
  actorId: string;
  turnId: string;
  programDigest: string;
  providerCallId: string;
  stableAdmissionIdentityDigest: string;
}>): string {
  const input = runIdentityInputSchema.parse(inputValue);
  const hash = createHash("sha256")
    .update("oprte.harness.dynamic-tool-run.v2", "utf8");
  for (const identity of [
    input.epochId,
    input.actorId,
    input.turnId,
    input.programDigest,
    input.providerCallId,
    input.stableAdmissionIdentityDigest,
  ]) {
    hash.update("\0", "utf8").update(identity, "utf8");
  }
  return programRunIdSchema.parse(`rlmrun_${hash.digest("hex").slice(0, 48)}`);
}

function stableCallerIsLive(
  stable: StableActorCaller,
  session: SessionCaller,
  kind: LiveCaller["kind"],
  nowMs: number,
): boolean {
  const { epoch, actor, turn } = stable;
  if (
    epoch.id !== actor.epochId || epoch.id !== turn.epochId ||
    actor.id !== turn.actorId ||
    epoch.state !== "active" || actor.state !== "active" ||
    turn.state !== "running" || turn.desiredState !== "run" ||
    ((turn.ordinal === 1) !== (stable.completedThroughTurnId === null)) ||
    stable.completedThroughTurnId === turn.id ||
    Date.parse(actor.budget.deadline) <= nowMs ||
    !actorBudgetFitsEpoch(actor, epoch) ||
    workspaceLaneAuthority(session.workspaceMode, kind) !==
      actor.budget.laneAuthority ||
    !contextValueIdSchema.safeParse(turn.inputValueId).success
  ) return false;
  if (kind === "root") {
    return actor.parentActorId === null && actor.depth === 0 &&
      epoch.rootActorId === actor.id &&
      exactJson(actor.budget) === exactJson(epoch.budget);
  }
  return actor.parentActorId !== null && actor.depth > 0 &&
    epoch.rootActorId !== actor.id;
}

function actorBudgetFitsEpoch(actor: Actor, epoch: ActorEpoch): boolean {
  return actor.budget.maxActiveDescendants <=
      actor.budget.maxDurableDescendants &&
    actor.budget.maxDepth <= epoch.budget.maxDepth &&
    actor.budget.maxActiveDescendants <= epoch.budget.maxActiveDescendants &&
    actor.budget.maxDurableDescendants <= epoch.budget.maxDurableDescendants &&
    actor.budget.tokenBudget <= epoch.budget.tokenBudget &&
    actor.budget.byteBudget <= epoch.budget.byteBudget &&
    Date.parse(actor.budget.deadline) <= Date.parse(epoch.budget.deadline) &&
    (epoch.budget.laneAuthority !== "readOnlySnapshot" ||
      actor.budget.laneAuthority === "readOnlySnapshot");
}

function settingsFitCaller(
  settings: EvidenceSettings,
  live: LiveCaller,
  nowMs: number,
): boolean {
  const actorBudget = live.stable.actor.budget;
  const budget = settings.budget;
  const features = baseLocalFeatures(settings);
  const currentCapabilities = features === null
    ? null
    : baseLocalCapabilities(features, true);
  const predecessorCapabilities = features === null
    ? null
    : baseLocalCapabilities(features, false);
  return features !== null &&
    exactJson(settings.admittedFeatures) === exactJson(features) &&
    (
      exactJson(settings.capabilities) === exactJson(currentCapabilities) ||
      exactJson(settings.capabilities) === exactJson(predecessorCapabilities)
    ) &&
    settings.semanticWitnessDigests.length === 1 &&
    Date.parse(budget.deadline) > nowMs &&
    budget.depthRemaining === actorBudget.maxDepth - live.stable.actor.depth &&
    budget.activeDescendantLimit === actorBudget.maxActiveDescendants &&
    budget.durableDescendantLimit === actorBudget.maxDurableDescendants &&
    budget.tokenBudget === actorBudget.tokenBudget &&
    budget.heapByteLimit === actorBudget.byteBudget &&
    budget.deadline === actorBudget.deadline &&
    recursiveLaneAuthority(actorBudget.laneAuthority) === budget.laneAuthority &&
    workspaceRecursiveAuthority(live.session.workspaceMode, live.kind) ===
      budget.laneAuthority;
}

function baseLocalFeatures(
  settings: EvidenceSettings,
): readonly HarnessFeature[] | null {
  const suggest = settings.admittedFeatures.includes("instructionCandidates");
  const features: HarnessFeature[] = [
    "boundedPrograms",
    ...(suggest ? ["instructionCandidates" as const] : []),
    "recursiveAgents",
  ];
  return settings.admittedFeatures.some((feature) =>
    feature === "contextMaterialization" ||
    feature === "contextReferences" ||
    feature === "goals"
  )
    ? null
    : Object.freeze(features);
}

function baseLocalCapabilities(
  features: readonly HarnessFeature[],
  routingInspection: boolean,
): readonly RlmV2Capability[] {
  const capabilities: RlmV2Capability[] = [
    "agent.cancel",
    "agent.message",
    "agent.spawn",
    "agent.wait",
    ...(features.includes("instructionCandidates")
      ? ["harness.propose" as const]
      : []),
    "heap.read",
    "heap.write",
    ...(routingInspection ? ["routing.inspect" as const] : []),
  ];
  return Object.freeze(capabilities.toSorted());
}

function maximumContextualFeatures(
  settings: EvidenceSettings,
): readonly HarnessFeature[] {
  return Object.freeze([
    ...settings.admittedFeatures,
    "contextMaterialization" as const,
    "contextReferences" as const,
  ].toSorted());
}

function maximumContextualCapabilities(
  settings: EvidenceSettings,
): readonly RlmV2Capability[] {
  return Object.freeze([
    ...settings.capabilities,
    "context.materialize" as const,
    "context.read" as const,
  ].toSorted());
}

function grantExactContext(
  settings: EvidenceSettings,
  context: ContextAdmission,
): EvidenceSettings | null {
  const coverageWitnessDigest = context.completedHistory.coverageWitnessDigest;
  if (settings.semanticWitnessDigests.includes(coverageWitnessDigest)) return null;
  return evidenceSettingsSchema.parse({
    ...settings,
    capabilities: maximumContextualCapabilities(settings),
    admittedFeatures: maximumContextualFeatures(settings),
    semanticWitnessDigests: [
      ...settings.semanticWitnessDigests,
      coverageWitnessDigest,
    ].toSorted(),
  });
}

function runHasExactContextEvidence(
  evidence: RunEvidence,
  live: LiveCaller,
): boolean {
  const { run, snapshot } = evidence;
  const mandatoryFeatures: readonly HarnessFeature[] = [
    "boundedPrograms",
    "contextMaterialization",
    "contextReferences",
    "recursiveAgents",
  ];
  const mandatoryCapabilities: readonly RlmV2Capability[] = [
    "agent.cancel",
    "agent.message",
    "agent.spawn",
    "agent.wait",
    "context.materialize",
    "context.read",
    "heap.read",
    "heap.write",
  ];
  return snapshot.id === run.completedPrefixSnapshotId &&
    snapshot.epochId === run.epochId &&
    snapshot.actorId === run.actorId &&
    (run.turnId === live.stable.turn.id
      ? snapshot.completedThroughTurnId === live.stable.completedThroughTurnId
      : snapshot.completedThroughTurnId !== run.turnId) &&
    snapshot.expiresAt === run.deadline &&
    Date.parse(snapshot.createdAt) <= Date.parse(run.createdAt) &&
    run.semanticWitnessDigests.length === 2 &&
    run.semanticWitnessDigests.includes(snapshot.coverageWitnessDigest) &&
    mandatoryFeatures.every((feature) =>
      run.admittedFeatures.includes(feature)
    ) &&
    mandatoryCapabilities.every((capability) =>
      run.capabilities.includes(capability)
    ) &&
    (run.admittedFeatures.includes("instructionCandidates") ===
      run.capabilities.includes("harness.propose"));
}

function contextIsExact(
  context: ContextAdmission,
  session: SessionCaller,
  generation: number,
): boolean {
  const completed = context.completedHistory;
  const current = context.currentInput;
  if (
    completed.coverage !== "complete" ||
    completed.throughTurnId !== session.turnId ||
    current.turnId !== session.turnId ||
    completed.sourceGeneration !== generation ||
    current.sourceGeneration !== generation ||
    completed.sourceStreamPosition !== current.sourceStreamPosition ||
    completed.coverageWitnessDigest !== current.coverageWitnessDigest ||
    completed.items.some((item) => item.turnId === current.turnId) ||
    Buffer.byteLength(current.text, "utf8") >
      MAX_SESSION_HARNESS_HISTORY_ITEM_UTF8_BYTES
  ) return false;
  let priorOrdinal = -1;
  let totalBytes = 0;
  for (const item of completed.items) {
    if (item.ordinal <= priorOrdinal) return false;
    priorOrdinal = item.ordinal;
    const bytes = Buffer.byteLength(item.text, "utf8");
    if (bytes > MAX_SESSION_HARNESS_HISTORY_ITEM_UTF8_BYTES) return false;
    totalBytes += bytes;
    if (totalBytes > MAX_SESSION_HARNESS_HISTORY_UTF8_BYTES) return false;
  }
  return true;
}

function materializationInput(input: Readonly<{
  runId: string;
  live: LiveCaller;
  context: ContextAdmission;
  programDigest: string;
  stableAdmissionIdentityDigest: string;
}>): HarnessDynamicToolContextMaterializationInputV2 {
  const currentInputValueId = contextValueIdSchema.parse(
    input.live.stable.turn.inputValueId,
  );
  const currentInputProvenance =
    harnessDynamicToolCurrentInputProvenanceV2Schema.parse(
      input.live.kind === "root"
        ? {
            valueId: currentInputValueId,
            purpose: "currentInput",
            sourceTurnId: null,
          }
        : {
            valueId: currentInputValueId,
            purpose: "actorTask",
            sourceTurnId: input.live.stable.turn.id,
          },
    );
  return Object.freeze({
    runId: input.runId,
    epochId: input.live.stable.epoch.id,
    actorId: input.live.stable.actor.id,
    turnId: input.live.stable.turn.id,
    currentInputValueId,
    currentInputProvenance: Object.freeze(currentInputProvenance),
    completedThroughTurnId: input.live.stable.completedThroughTurnId,
    expiresAt: actorBudgetSchema.shape.deadline.parse(
      input.live.stable.actor.budget.deadline,
    ),
    programDigest: input.programDigest,
    stableAdmissionIdentityDigest: input.stableAdmissionIdentityDigest,
    coverageWitnessDigest:
      input.context.completedHistory.coverageWitnessDigest,
    completedPrefix: Object.freeze(input.context.completedHistory.items.map(
      ({ ordinal, itemClass, text }) => Object.freeze({
        ordinal,
        itemClass,
        text,
      }),
    )),
    currentInput: input.context.currentInput.text,
  });
}

function runMatchesCaller(
  evidence: RunEvidence,
  live: LiveCaller,
  settings: EvidenceSettings,
  programDigest?: string,
): boolean {
  const { run } = evidence;
  return run.epochId === live.stable.epoch.id &&
    run.actorId === live.stable.actor.id &&
    run.turnId === live.stable.turn.id &&
    (programDigest === undefined || run.programDigest === programDigest) &&
    exactJson(run.budget) === exactJson(settings.budget) &&
    runHasExactContextEvidence(evidence, live) &&
    run.capabilities.every((capability) =>
      maximumContextualCapabilities(settings).includes(capability)
    ) &&
    run.admittedFeatures.every((feature) =>
      maximumContextualFeatures(settings).includes(feature)
    );
}

/**
 * Inspection is authorized by the provider caller that is live now, while the
 * run keeps its immutable origin turn and evidence. A process restart may
 * legitimately replace the current capability witness or release identity;
 * it may not change actor/epoch custody, shrink an admitted capability, alter
 * the recursive budget, revive recovery-required work, or cross the deadline.
 */
function runIsInspectableByCurrentCaller(
  evidence: RunEvidence,
  live: LiveCaller,
  settings: EvidenceSettings,
  nowMs: number,
): boolean {
  const { run } = evidence;
  const sameOriginTurn = run.turnId === live.stable.turn.id;
  return run.epochId === live.stable.epoch.id &&
    run.actorId === live.stable.actor.id &&
    run.state !== "recoveryRequired" &&
    Date.parse(run.deadline) > nowMs &&
    runHasExactContextEvidence(evidence, live) &&
    (sameOriginTurn ||
      Date.parse(run.createdAt) <= Date.parse(live.stable.turn.createdAt)) &&
    run.capabilities.every((capability) =>
      maximumContextualCapabilities(settings).includes(capability)
    ) &&
    run.admittedFeatures.every((feature) =>
      maximumContextualFeatures(settings).includes(feature)
    ) &&
    exactJson(run.budget) === exactJson(settings.budget);
}

function admissionFromRun(
  run: RlmRunRecord,
): HarnessDynamicToolStableAdmission {
  return Object.freeze({
    runId: run.id,
    epochId: run.epochId,
    actorId: run.actorId,
    turnId: run.turnId,
    completedPrefixSnapshotId: run.completedPrefixSnapshotId,
    currentUserInputValueId: run.currentUserInputValueId,
    releaseIdentityDigest: run.releaseIdentityDigest,
    caller: parseRlmV2Caller({
      epochId: run.epochId,
      actorId: run.actorId,
      turnId: run.turnId,
      capabilities: run.capabilities,
      admittedFeatures: run.admittedFeatures,
      semanticWitnessDigests: run.semanticWitnessDigests,
      budget: run.budget,
    }),
  });
}

function admissionFromMaterialization(input: Readonly<{
  runId: string;
  live: LiveCaller;
  settings: EvidenceSettings;
  materialized: HarnessDynamicToolContextMaterializationV2;
}>): HarnessDynamicToolStableAdmission {
  return Object.freeze({
    runId: input.runId,
    epochId: input.live.stable.epoch.id,
    actorId: input.live.stable.actor.id,
    turnId: input.live.stable.turn.id,
    completedPrefixSnapshotId:
      input.materialized.completedPrefixSnapshotId,
    currentUserInputValueId: input.materialized.currentUserInputValueId,
    releaseIdentityDigest: input.settings.releaseIdentityDigest,
    caller: callerFromSettings(
      input.live.stable.epoch.id,
      input.live.stable.actor.id,
      input.live.stable.turn.id,
      input.settings,
    ),
  });
}

function callerFromSettings(
  epochId: string,
  actorId: string,
  turnId: string,
  settings: EvidenceSettings,
): RlmV2Caller {
  return parseRlmV2Caller({
    epochId,
    actorId,
    turnId,
    capabilities: settings.capabilities,
    admittedFeatures: settings.admittedFeatures,
    semanticWitnessDigests: settings.semanticWitnessDigests,
    budget: settings.budget,
  });
}

function sameLiveCaller(left: LiveCaller, right: LiveCaller): boolean {
  return left.kind === right.kind &&
    exactJson(left.session) === exactJson(right.session) &&
    left.stable.epoch.id === right.stable.epoch.id &&
    left.stable.epoch.projectId === right.stable.epoch.projectId &&
    left.stable.epoch.sourceSha === right.stable.epoch.sourceSha &&
    left.stable.epoch.rootActorId === right.stable.epoch.rootActorId &&
    exactJson(left.stable.epoch.budget) ===
      exactJson(right.stable.epoch.budget) &&
    left.stable.actor.id === right.stable.actor.id &&
    left.stable.actor.parentActorId === right.stable.actor.parentActorId &&
    left.stable.actor.depth === right.stable.actor.depth &&
    left.stable.turn.id === right.stable.turn.id &&
    left.stable.turn.ordinal === right.stable.turn.ordinal &&
    left.stable.turn.idempotencyKey === right.stable.turn.idempotencyKey &&
    left.stable.turn.inputValueId === right.stable.turn.inputValueId &&
    left.stable.completedThroughTurnId ===
      right.stable.completedThroughTurnId &&
    exactJson(left.stable.actor.budget) ===
      exactJson(right.stable.actor.budget);
}

export function deriveHarnessDynamicToolStableCallIdentityDigest(
  callValue: HarnessDynamicToolStableCall,
): string {
  const call = stableCallSchema.parse(callValue);
  return createHash("sha256")
    .update("oprte.harness.dynamic-tool-stable-call.v2", "utf8")
    .update("\0", "utf8")
    .update(call.providerCallId, "utf8")
    .update("\0", "utf8")
    .update(call.callDigest, "utf8")
    .digest("hex");
}

function workspaceLaneAuthority(
  mode: SessionCaller["workspaceMode"],
  kind: LiveCaller["kind"],
): Actor["budget"]["laneAuthority"] | null {
  if (mode === "managed" || (mode === "local" && kind === "root")) {
    return "managedWrite";
  }
  if (mode === "readOnly") return "readOnlySnapshot";
  return null;
}

function workspaceRecursiveAuthority(
  mode: SessionCaller["workspaceMode"],
  kind: LiveCaller["kind"],
): RecursiveBudget["laneAuthority"] | null {
  if (mode === "managed" || (mode === "local" && kind === "root")) {
    return "managedWrite";
  }
  if (mode === "readOnly") return "readOnly";
  return null;
}

function recursiveLaneAuthority(
  authority: Actor["budget"]["laneAuthority"],
): RecursiveBudget["laneAuthority"] {
  return authority === "readOnlySnapshot" ? "readOnly" : "managedWrite";
}

function exactJson(value: unknown): string {
  return JSON.stringify(value);
}
