import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import type { AccountRuntimeRouter } from "../accounts/runtime-router";
import {
  HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
  classifyHraRlmDynamicToolSpecDigest,
} from "../codex";
import { hraReleaseIdentity } from "../../release-identity";
import {
  actorIdSchema,
  actorTurnIdSchema,
  type Actor,
} from "./actor-domain";
import {
  HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
  HARNESS_MAX_MESSAGE_UTF8_BYTES,
  recursiveBudgetSchema,
} from "./domain";
import type { HarnessDynamicToolEvidenceSettingsPortV2 } from
  "./dynamic-tool-stable-caller-v2";
import {
  HARNESS_PINNED_CODEX_VERSION,
  type HarnessFeature,
} from "./semantic-gate";
import { HarnessSQLiteAuthorityV2 } from "./sqlite-authority-v2";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const accountProfileIdSchema = z.string().min(1).max(96);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const settingsRowSchema = z.object({
  recursive_sessions_enabled: z.literal(1),
  context_quota_bytes: z.number().int().min(1024 * 1024)
    .max(64 * 1024 * 1024),
  refinement_mode: z.enum(["off", "suggest"]),
}).strict();

const runtimeOwnerSchema = z.object({
  accountProfileId: accountProfileIdSchema,
  admissionGeneration: positiveSafeIntegerSchema,
  liveGeneration: positiveSafeIntegerSchema,
  toolsetDigest: digestSchema,
}).strict();

const rootOwnerRowSchema = z.object({
  account_profile_id: accountProfileIdSchema,
}).strict();

const nestedOwnerRowSchema = z.object({
  incarnation_id: z.string().min(16).max(96),
  account_profile_id: accountProfileIdSchema,
  process_generation: positiveSafeIntegerSchema,
  provider_thread_id: z.string().min(1).max(512),
  toolset_digest: digestSchema,
}).strict();

const capabilitySchema = z.object({
  caller: z.object({
    accountProfileId: accountProfileIdSchema,
    accountGeneration: positiveSafeIntegerSchema,
  }).strict(),
  runtimeBinarySha256: digestSchema,
  witness: z.object({
    binarySha256: digestSchema,
    processGeneration: positiveSafeIntegerSchema,
    evidenceObjectDigest: digestSchema,
  }).passthrough(),
}).passthrough();

type RuntimeRouterPort = Pick<
  AccountRuntimeRouter,
  "generation" | "readDynamicToolCapability"
>;

export class HarnessDynamicToolEvidenceSettingsV2Error extends Error {
  readonly code: "ambiguous_owner" | "corrupt_state" | "unavailable";

  constructor(
    code: HarnessDynamicToolEvidenceSettingsV2Error["code"],
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HarnessDynamicToolEvidenceSettingsV2Error";
    this.code = code;
  }
}

/**
 * Resolves the exact live account capability for one durable actor turn.
 * Account and process identities are lookup evidence only and never enter the
 * returned caller budget or release identity.
 */
export class HarnessDynamicToolEvidenceSettingsAuthorityV2
  implements HarnessDynamicToolEvidenceSettingsPortV2 {
  readonly #database: Database;
  readonly #actors: HarnessSQLiteAuthorityV2;
  readonly #runtimes: RuntimeRouterPort;
  readonly #now: () => number;

  constructor(input: Readonly<{
    database: Database;
    runtimes: RuntimeRouterPort;
    actors?: HarnessSQLiteAuthorityV2;
    now?: () => number;
  }>) {
    this.#database = input.database;
    this.#actors = input.actors ?? new HarnessSQLiteAuthorityV2(input.database);
    this.#runtimes = input.runtimes;
    this.#now = input.now ?? Date.now;
  }

  async readAcceptedSettings(inputValue: Readonly<{
    epochId: string;
    actorId: string;
    turnId: string;
    requestInstanceId: number;
    accountProfileId: string;
    accountGeneration: number;
    processGeneration: number;
  }>): Promise<unknown> {
    const input = z.object({
      epochId: z.string().min(16).max(96),
      actorId: actorIdSchema,
      turnId: actorTurnIdSchema,
      requestInstanceId: positiveSafeIntegerSchema,
      accountProfileId: accountProfileIdSchema,
      accountGeneration: positiveSafeIntegerSchema,
      processGeneration: positiveSafeIntegerSchema,
    }).strict().refine(
      ({ accountGeneration, processGeneration }) =>
        accountGeneration === processGeneration,
      "account and process generations must match",
    ).parse(inputValue);
    const epoch = this.#actors.readActorEpoch(input.epochId);
    const actor = this.#actors.readActor(input.actorId);
    const turn = this.#actors.readActorTurn(input.turnId);
    if (
      epoch === null || actor === null || turn === null ||
      actor.epochId !== epoch.id || turn.epochId !== epoch.id ||
      turn.actorId !== actor.id || epoch.state !== "active" ||
      actor.state !== "active" || turn.state !== "running" ||
      turn.desiredState !== "run" || Date.parse(actor.budget.deadline) <= this.#now()
    ) unavailable("durable actor admission is no longer live");

    const settings = this.#settings();
    const owner = this.#runtimeOwner(actor, turn.id);
    if (
      input.accountProfileId !== owner.accountProfileId ||
      input.accountGeneration !== owner.liveGeneration ||
      input.processGeneration !== owner.liveGeneration ||
      this.#runtimes.generation(owner.accountProfileId) !== owner.liveGeneration
    ) unavailable("the semantic request binding does not match its actor owner");
    const capability = capabilitySchema.safeParse(
      this.#runtimes.readDynamicToolCapability(
        owner.accountProfileId,
        owner.liveGeneration,
      ),
    );
    if (
      !capability.success ||
      capability.data.caller.accountProfileId !== owner.accountProfileId ||
      capability.data.caller.accountGeneration !== owner.liveGeneration ||
      capability.data.witness.processGeneration !== owner.liveGeneration ||
      capability.data.runtimeBinarySha256 !== capability.data.witness.binarySha256
    ) unavailable("the live Codex capability no longer matches its actor owner");

    // These are code-owned release laws, not inferred provider semantics.
    // Exact transcript coverage is deliberately absent here: the stable
    // caller adds its context capabilities only after a complete live read.
    const admittedFeatures: HarnessFeature[] = [
      "boundedPrograms",
      "recursiveAgents",
    ];
    if (settings.refinement_mode === "suggest") {
      admittedFeatures.push("instructionCandidates");
    }
    admittedFeatures.sort();
    const capabilities = [
      "agent.cancel",
      "agent.message",
      "agent.spawn",
      "agent.wait",
      ...(admittedFeatures.includes("instructionCandidates")
        ? ["harness.propose"]
        : []),
      "heap.read",
      "heap.write",
      ...(owner.toolsetDigest === HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256
        ? ["routing.inspect"]
        : []),
    ].toSorted();
    const releaseIdentityDigest = digestCanonical({
      domain: "oprte.harness.release-identity.v2",
      build: hraReleaseIdentity.build,
      codexBinarySha256: capability.data.runtimeBinarySha256,
      codexVersion: HARNESS_PINNED_CODEX_VERSION,
      dynamicToolSpecSha256: owner.toolsetDigest,
      version: hraReleaseIdentity.version,
    });
    // Preserve promise rejection semantics for the stable-caller port while
    // keeping every authority read above in one synchronous observation.
    await Promise.resolve();
    return Object.freeze({
      capabilities: Object.freeze(capabilities),
      admittedFeatures: Object.freeze(admittedFeatures),
      // This is the sole provider evidence admitted here. Signed semantic
      // inbox witnesses remain dormant and cannot widen current authority.
      semanticWitnessDigests: Object.freeze([
        capability.data.witness.evidenceObjectDigest,
      ]),
      budget: recursiveBudgetSchema.parse({
        depthRemaining: actor.budget.maxDepth - actor.depth,
        activeDescendantLimit: actor.budget.maxActiveDescendants,
        durableDescendantLimit: actor.budget.maxDurableDescendants,
        tokenBudget: actor.budget.tokenBudget,
        heapByteLimit: actor.budget.byteBudget,
        contextValueByteLimit: Math.min(
          HARNESS_MAX_CONTEXT_VALUE_UTF8_BYTES,
          actor.budget.byteBudget,
        ),
        messageByteLimit: HARNESS_MAX_MESSAGE_UTF8_BYTES,
        deadline: actor.budget.deadline,
        laneAuthority: actor.budget.laneAuthority === "readOnlySnapshot"
          ? "readOnly"
          : "managedWrite",
      }),
      releaseIdentityDigest,
    });
  }

  #settings(): z.infer<typeof settingsRowSchema> {
    const value: unknown = this.#database.query(`
      SELECT recursive_sessions_enabled, context_quota_bytes, refinement_mode
      FROM harness_settings WHERE singleton = 1
    `).get();
    try {
      return settingsRowSchema.parse(value);
    } catch (cause: unknown) {
      throw new HarnessDynamicToolEvidenceSettingsV2Error(
        "unavailable",
        "recursive harness settings are disabled or unavailable",
        cause,
      );
    }
  }

  #runtimeOwner(actor: Actor, turnId: string): z.infer<typeof runtimeOwnerSchema> {
    if (actor.parentActorId === null) {
      const rows: unknown[] = this.#database.query(`
        SELECT pane.provider_account_profile_id AS account_profile_id
        FROM harness_actor_pane_bindings AS binding
        JOIN chat_panes AS pane ON pane.pane_id = binding.pane_id
        WHERE binding.actor_id = ?1 AND binding.state = 'attached'
          AND pane.interaction_mode = 'chat'
          AND pane.active_turn_id IS NOT NULL
          AND pane.active_provider_turn_id IS NOT NULL
          AND pane.provider_account_profile_id IS NOT NULL
        ORDER BY binding.binding_id
        LIMIT 2
      `).all(actor.id);
      if (rows.length !== 1) ownerFailure(rows.length);
      const row = rootOwnerRowSchema.parse(rows[0]);
      const generation = this.#runtimes.generation(row.account_profile_id);
      return runtimeOwnerSchema.parse({
        accountProfileId: row.account_profile_id,
        admissionGeneration: generation,
        liveGeneration: generation,
        toolsetDigest: HRA_RLM_DYNAMIC_TOOL_SPEC_SHA256,
      });
    }

    const rows: unknown[] = this.#database.query(`
      SELECT incarnation.incarnation_id AS incarnation_id,
        incarnation.account_profile_id AS account_profile_id,
        incarnation.process_generation AS process_generation,
        incarnation.provider_thread_id AS provider_thread_id,
        incarnation.toolset_digest AS toolset_digest
      FROM harness_actor_turn_attempts AS attempt
      JOIN harness_actor_incarnations AS incarnation
        ON incarnation.incarnation_id = attempt.incarnation_id
      WHERE attempt.turn_id = ?1 AND attempt.state = 'running'
        AND incarnation.actor_id = ?2
        AND incarnation.state IN ('running', 'idle')
      ORDER BY attempt.ordinal
      LIMIT 2
    `).all(turnId, actor.id);
    if (rows.length !== 1) ownerFailure(rows.length);
    const row = nestedOwnerRowSchema.parse(rows[0]);
    if (
      classifyHraRlmDynamicToolSpecDigest(row.toolset_digest, "recovery") ===
        null
    ) unavailable("the nested actor tool contract is not recognized");
    const session = this.#actors.readActorSessionBinding(row.incarnation_id);
    if (
      session === null || session.state !== "bound" ||
      session.actorId !== actor.id ||
      session.accountProfileId !== row.account_profile_id ||
      session.admissionGeneration !== row.process_generation ||
      session.providerThreadId !== row.provider_thread_id ||
      session.liveGeneration < session.admissionGeneration
    ) unavailable("the nested actor has no exact live session binding");
    return runtimeOwnerSchema.parse({
      accountProfileId: row.account_profile_id,
      admissionGeneration: row.process_generation,
      liveGeneration: session.liveGeneration,
      toolsetDigest: row.toolset_digest,
    });
  }
}

function ownerFailure(count: number): never {
  throw new HarnessDynamicToolEvidenceSettingsV2Error(
    count > 1 ? "ambiguous_owner" : "unavailable",
    count > 1
      ? "multiple live runtimes claim one durable actor turn"
      : "the durable actor turn has no live runtime owner",
  );
}

function unavailable(message: string): never {
  throw new HarnessDynamicToolEvidenceSettingsV2Error("unavailable", message);
}

function digestCanonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" ||
      typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") throw new TypeError("value is not canonical JSON");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
