import { createHash } from "node:crypto";

import { z } from "@hra-internal/schema";

export const HARNESS_PINNED_CODEX_VERSION = "0.144.6" as const;
export const HARNESS_SEMANTIC_PROVIDER_ID = "openai.codex-app-server" as const;
export const HARNESS_SEMANTIC_WITNESS_MAX_AGE_MS = 10 * 60 * 1_000;
export const MAX_HARNESS_SEMANTIC_EVIDENCE_BYTES = 1024 * 1_024;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const accountProfileIdSchema = z.string().min(1).max(96)
  .regex(/^acct_[A-Za-z0-9_-]+$/u);

export const harnessFeatureRequestBindingSchema = z.object({
  requestInstanceId: positiveSafeIntegerSchema,
  accountProfileId: accountProfileIdSchema,
  accountGeneration: positiveSafeIntegerSchema,
  processGeneration: positiveSafeIntegerSchema,
}).strict().refine(
  ({ accountGeneration, processGeneration }) =>
    accountGeneration === processGeneration,
  { message: "Account and process generations must match" },
);

export type HarnessFeatureRequestBinding = z.infer<
  typeof harnessFeatureRequestBindingSchema
>;

export const harnessSemanticIdSchema = z.enum([
  "history.completedCoverage",
  "history.compactionCoverage",
  "program.exactCallerBinding",
  "program.dynamicToolRegistration",
  "program.dynamicToolLifecycle",
  "thread.start",
  "thread.fork",
  "thread.resume",
  "thread.childMetadata",
  "turn.concurrentChildren",
  "turn.lostResponseReconciliation",
  "agent.nonblockingHandle",
  "agent.laterMessage",
  "agent.waitAnyAll",
  "agent.recursiveChild",
  "goal.persistence",
  "overlay.developerInstructions",
]);

export type HarnessSemanticId = z.infer<typeof harnessSemanticIdSchema>;

export const harnessSemanticWitnessSchema = z.object({
  version: z.literal(1),
  providerId: z.literal(HARNESS_SEMANTIC_PROVIDER_ID),
  semantic: harnessSemanticIdSchema,
  codexVersion: z.literal(HARNESS_PINNED_CODEX_VERSION),
  state: z.enum(["proven", "unsupported", "inconclusive"]),
  probeId: z.string().min(1).max(96).regex(/^[a-z0-9][a-z0-9._-]*$/u),
  probeDigest: sha256Schema,
  observedAt: z.string().length(24).datetime(),
  accountProfileId: accountProfileIdSchema,
  accountGeneration: positiveSafeIntegerSchema,
  binarySha256: sha256Schema,
  processGeneration: positiveSafeIntegerSchema,
  evidenceObjectDigest: sha256Schema,
}).strict();

export type HarnessSemanticWitness = z.infer<typeof harnessSemanticWitnessSchema>;

const harnessSemanticEvidencePayloadSchema = harnessSemanticWitnessSchema.omit({
  evidenceObjectDigest: true,
});

export const harnessSemanticRuntimeBindingSchema = z.object({
  requestInstanceId: positiveSafeIntegerSchema,
  providerId: z.literal(HARNESS_SEMANTIC_PROVIDER_ID),
  codexVersion: z.literal(HARNESS_PINNED_CODEX_VERSION),
  accountProfileId: accountProfileIdSchema,
  accountGeneration: positiveSafeIntegerSchema,
  binarySha256: sha256Schema,
  processGeneration: positiveSafeIntegerSchema,
  nowMs: z.number().int().nonnegative().safe(),
}).strict().refine(
  ({ accountGeneration, processGeneration }) =>
    accountGeneration === processGeneration,
  { message: "Account and process generations must match" },
);

export type HarnessSemanticRuntimeBinding = z.infer<
  typeof harnessSemanticRuntimeBindingSchema
>;

export interface HarnessSemanticEvidenceReadback {
  readonly digest: string;
  readonly bytes: Uint8Array;
}

/**
 * Trusted composition boundary. An implementation must authenticate immutable
 * probe provenance before returning bytes; a generic object store is not a
 * valid implementation of this port.
 */
export interface HarnessSemanticEvidenceCustody {
  readVerifiedEvidenceObject(input: Readonly<{
    digest: string;
    providerId: typeof HARNESS_SEMANTIC_PROVIDER_ID;
    codexVersion: typeof HARNESS_PINNED_CODEX_VERSION;
    semantic: HarnessSemanticId;
    probeId: string;
    accountProfileId: string;
    accountGeneration: number;
    binarySha256: string;
    processGeneration: number;
    nowMs: number;
  }>): Promise<HarnessSemanticEvidenceReadback | null>;
}

const verifiedSemanticWitnessBrand: unique symbol = Symbol(
  "VerifiedHarnessSemanticWitness",
);
const verifiedSemanticWitnesses = new WeakSet<object>();

export interface VerifiedHarnessSemanticWitness {
  readonly [verifiedSemanticWitnessBrand]: true;
  readonly witness: HarnessSemanticWitness;
}

/**
 * Mints an opaque witness only after exact immutable evidence readback and
 * runtime binding. Missing custody, stale evidence, another binary, or another
 * process generation all fail closed.
 */
export async function verifyHarnessSemanticWitness(
  witnessValue: unknown,
  runtimeValue: unknown,
  custody: HarnessSemanticEvidenceCustody,
): Promise<VerifiedHarnessSemanticWitness | null> {
  const witness = harnessSemanticWitnessSchema.safeParse(witnessValue);
  const runtime = harnessSemanticRuntimeBindingSchema.safeParse(runtimeValue);
  if (!witness.success || !runtime.success) return null;
  if (!witnessMatchesRuntime(witness.data, runtime.data)) return null;

  let readback: HarnessSemanticEvidenceReadback | null;
  try {
    readback = await custody.readVerifiedEvidenceObject({
      digest: witness.data.evidenceObjectDigest,
      providerId: witness.data.providerId,
      codexVersion: witness.data.codexVersion,
      semantic: witness.data.semantic,
      probeId: witness.data.probeId,
      accountProfileId: witness.data.accountProfileId,
      accountGeneration: witness.data.accountGeneration,
      binarySha256: witness.data.binarySha256,
      processGeneration: witness.data.processGeneration,
      nowMs: runtime.data.nowMs,
    });
  } catch {
    return null;
  }
  if (
    readback === null ||
    readback.digest !== witness.data.evidenceObjectDigest ||
    !(readback.bytes instanceof Uint8Array) ||
    readback.bytes.byteLength === 0 ||
    readback.bytes.byteLength > MAX_HARNESS_SEMANTIC_EVIDENCE_BYTES ||
    sha256Bytes(readback.bytes) !== witness.data.evidenceObjectDigest
  ) {
    return null;
  }

  let evidenceValue: unknown;
  try {
    evidenceValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(readback.bytes),
    ) as unknown;
  } catch {
    return null;
  }
  const evidence = harnessSemanticEvidencePayloadSchema.safeParse(evidenceValue);
  if (!evidence.success) return null;
  if (
    sha256Canonical(evidence.data) !==
      sha256Canonical(withoutEvidenceDigest(witness.data))
  ) {
    return null;
  }

  const verified = Object.freeze({
    [verifiedSemanticWitnessBrand]: true as const,
    witness: Object.freeze(witness.data),
  });
  verifiedSemanticWitnesses.add(verified);
  return verified;
}

/** The runtime binding is mandatory. A unary syntactic-brand check is false. */
export function isVerifiedHarnessSemanticWitness(
  value: unknown,
  runtimeValue?: unknown,
): value is VerifiedHarnessSemanticWitness {
  const runtime = harnessSemanticRuntimeBindingSchema.safeParse(runtimeValue);
  if (!runtime.success || typeof value !== "object" || value === null) return false;
  if (
    !verifiedSemanticWitnesses.has(value) ||
    !(verifiedSemanticWitnessBrand in value) ||
    (value as { readonly [verifiedSemanticWitnessBrand]?: unknown })[
      verifiedSemanticWitnessBrand
    ] !== true
  ) {
    return false;
  }
  const witness = harnessSemanticWitnessSchema.safeParse(
    (value as { readonly witness?: unknown }).witness,
  );
  return witness.success && witnessMatchesRuntime(witness.data, runtime.data);
}

export const harnessFeatureSchema = z.enum([
  "contextReferences",
  "contextMaterialization",
  "boundedPrograms",
  "recursiveAgents",
  "goals",
  "instructionCandidates",
]);

export type HarnessFeature = z.infer<typeof harnessFeatureSchema>;

const requiredSemantics: Readonly<Record<
  HarnessFeature,
  readonly HarnessSemanticId[]
>> = Object.freeze({
  contextReferences: ["history.completedCoverage"],
  contextMaterialization: [
    "history.completedCoverage",
    "history.compactionCoverage",
  ],
  boundedPrograms: [
    "program.exactCallerBinding",
    "program.dynamicToolRegistration",
    "program.dynamicToolLifecycle",
  ],
  recursiveAgents: [
    "program.exactCallerBinding",
    "program.dynamicToolRegistration",
    "program.dynamicToolLifecycle",
    "thread.start",
    "thread.fork",
    "thread.resume",
    "thread.childMetadata",
    "turn.concurrentChildren",
    "turn.lostResponseReconciliation",
    "agent.nonblockingHandle",
    "agent.laterMessage",
    "agent.waitAnyAll",
    "agent.recursiveChild",
  ],
  goals: [
    "program.exactCallerBinding",
    "program.dynamicToolRegistration",
    "goal.persistence",
  ],
  instructionCandidates: ["overlay.developerInstructions"],
});

export type HarnessFeatureDecision = Readonly<
  | { enabled: true; feature: HarnessFeature; witnessDigests: readonly string[] }
  | {
      enabled: false;
      feature: HarnessFeature;
      reason: "runtime_binding_unavailable";
    }
  | {
      enabled: false;
      feature: HarnessFeature;
      reason: "missing_witness" | "unsupported" | "conflicting_witness";
      semantics: readonly HarnessSemanticId[];
    }
>;

export interface HarnessSemanticWitnessPort {
  listWitnesses(
    binding: HarnessFeatureRequestBinding,
  ): Promise<readonly unknown[]>;
}

export interface HarnessSemanticRuntimeBindingPort {
  resolveBinding(
    binding: HarnessFeatureRequestBinding,
  ): Promise<HarnessSemanticRuntimeBinding | null>;
}

export interface HarnessFeatureGatePort {
  decide(
    feature: HarnessFeature,
    binding: HarnessFeatureRequestBinding,
  ): Promise<HarnessFeatureDecision>;
}

export class SemanticHarnessFeatureGate implements HarnessFeatureGatePort {
  readonly #evidence: HarnessSemanticEvidenceCustody;
  readonly #runtime: HarnessSemanticRuntimeBindingPort;
  readonly #witnesses: HarnessSemanticWitnessPort;

  constructor(options: Readonly<{
    evidence: HarnessSemanticEvidenceCustody;
    runtime: HarnessSemanticRuntimeBindingPort;
    witnesses: HarnessSemanticWitnessPort;
  }>) {
    this.#evidence = options.evidence;
    this.#runtime = options.runtime;
    this.#witnesses = options.witnesses;
  }

  async decide(
    featureValue: HarnessFeature,
    bindingValue: HarnessFeatureRequestBinding,
  ): Promise<HarnessFeatureDecision> {
    const decisions = await this.decideMany([featureValue], bindingValue);
    return decisions[0]!;
  }

  /**
   * Decides a related feature set from one runtime generation and one witness
   * inventory. Renderer settings may request recursive agents and instruction
   * candidates together; reading those authorities independently could mix a
   * restart boundary and incorrectly enable an incoherent pair.
   */
  async decideMany(
    featureValues: readonly HarnessFeature[],
    bindingValue: HarnessFeatureRequestBinding,
  ): Promise<readonly HarnessFeatureDecision[]> {
    const features = [...new Set(featureValues.map((value) =>
      harnessFeatureSchema.parse(value)
    ))];
    const binding = harnessFeatureRequestBindingSchema.safeParse(bindingValue);
    if (!binding.success) return unavailableFeatureDecisions(features);
    let runtimeValue: HarnessSemanticRuntimeBinding | null;
    try {
      runtimeValue = await this.#runtime.resolveBinding(binding.data);
    } catch {
      return unavailableFeatureDecisions(features);
    }
    const runtime = parseExactRuntimeBinding(runtimeValue, binding.data);
    if (runtime === null) return unavailableFeatureDecisions(features);
    let candidates: readonly unknown[];
    try {
      candidates = await this.#witnesses.listWitnesses(binding.data);
    } catch {
      return unavailableFeatureDecisions(features);
    }
    const verified = await Promise.all(candidates.map(async (candidate) =>
      await verifyHarnessSemanticWitness(candidate, runtime, this.#evidence)
    ));
    const witnesses = verified.flatMap((witness) =>
      witness === null ? [] : [witness]
    );
    return features.map((feature) =>
      decideHarnessFeature(feature, witnesses, runtime)
    );
  }
}

/**
 * Enables a feature only from one unambiguous proven witness per required
 * semantic. A later conflicting observation disables admission rather than
 * letting arrival order choose the truth.
 */
export function decideHarnessFeature(
  featureValue: HarnessFeature,
  witnessValues: readonly unknown[],
  runtimeValue?: unknown,
): HarnessFeatureDecision {
  const feature = harnessFeatureSchema.parse(featureValue);
  const runtime = harnessSemanticRuntimeBindingSchema.safeParse(runtimeValue);
  const witnesses = runtime.success
    ? witnessValues.flatMap((value) =>
      isVerifiedHarnessSemanticWitness(value, runtime.data)
        ? [value.witness]
        : []
    )
    : [];
  const missing: HarnessSemanticId[] = [];
  const unsupported: HarnessSemanticId[] = [];
  const conflicting: HarnessSemanticId[] = [];
  const witnessDigests: string[] = [];

  for (const semantic of requiredSemantics[feature]) {
    const matching = witnesses.filter((witness) => witness.semantic === semantic);
    if (matching.length === 0) {
      missing.push(semantic);
      continue;
    }
    const unique = new Map(matching.map((witness) => [
      witness.evidenceObjectDigest,
      witness,
    ]));
    const states = new Set([...unique.values()].map(({ state }) => state));
    if (states.size !== 1 || unique.size !== 1) {
      conflicting.push(semantic);
      continue;
    }
    if (!states.has("proven")) {
      unsupported.push(semantic);
      continue;
    }
    witnessDigests.push(...matching.map(({ evidenceObjectDigest }) =>
      evidenceObjectDigest
    ));
  }

  if (conflicting.length > 0) {
    return {
      enabled: false,
      feature,
      reason: "conflicting_witness",
      semantics: conflicting,
    };
  }
  if (unsupported.length > 0) {
    return {
      enabled: false,
      feature,
      reason: "unsupported",
      semantics: unsupported,
    };
  }
  if (missing.length > 0) {
    return {
      enabled: false,
      feature,
      reason: "missing_witness",
      semantics: missing,
    };
  }
  return {
    enabled: true,
    feature,
    witnessDigests: [...new Set(witnessDigests)].sort(),
  };
}

export function requiredHarnessSemantics(
  featureValue: HarnessFeature,
): readonly HarnessSemanticId[] {
  return requiredSemantics[harnessFeatureSchema.parse(featureValue)];
}

function parseExactRuntimeBinding(
  runtimeValue: HarnessSemanticRuntimeBinding | null,
  request: HarnessFeatureRequestBinding,
): HarnessSemanticRuntimeBinding | null {
  const parsed = harnessSemanticRuntimeBindingSchema.safeParse(runtimeValue);
  if (!parsed.success) return null;
  const runtime = Object.freeze(parsed.data);
  return runtime.requestInstanceId === request.requestInstanceId &&
      runtime.accountProfileId === request.accountProfileId &&
      runtime.accountGeneration === request.accountGeneration &&
      runtime.processGeneration === request.processGeneration
    ? runtime
    : null;
}

function unavailableFeatureDecisions(
  features: readonly HarnessFeature[],
): readonly HarnessFeatureDecision[] {
  return features.map((feature) => Object.freeze({
    enabled: false as const,
    feature,
    reason: "runtime_binding_unavailable" as const,
  }));
}

function witnessMatchesRuntime(
  witness: HarnessSemanticWitness,
  runtime: HarnessSemanticRuntimeBinding,
): boolean {
  const observedAtMs = Date.parse(witness.observedAt);
  return witness.providerId === runtime.providerId &&
    witness.codexVersion === runtime.codexVersion &&
    witness.accountProfileId === runtime.accountProfileId &&
    witness.accountGeneration === runtime.accountGeneration &&
    witness.binarySha256 === runtime.binarySha256 &&
    witness.processGeneration === runtime.processGeneration &&
    Number.isFinite(observedAtMs) &&
    observedAtMs <= runtime.nowMs &&
    runtime.nowMs - observedAtMs <= HARNESS_SEMANTIC_WITNESS_MAX_AGE_MS;
}

/** Canonical immutable payload bytes committed by one witness digest. */
export function harnessSemanticEvidencePayloadBytes(
  witnessValue: unknown,
): Uint8Array {
  const witness = harnessSemanticWitnessSchema.parse(witnessValue);
  return new TextEncoder().encode(
    JSON.stringify(canonicalizeJson(withoutEvidenceDigest(witness))),
  );
}

function withoutEvidenceDigest(
  witness: HarnessSemanticWitness,
): z.infer<typeof harnessSemanticEvidencePayloadSchema> {
  const { evidenceObjectDigest, ...payload } = witness;
  void evidenceObjectDigest;
  return payload;
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}
