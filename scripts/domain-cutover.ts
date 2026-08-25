import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { isatty } from "node:tty";

import { z } from "zod";

import { createBoundedAuthorityFetch } from "./bounded-authority-fetch";
import {
  BoundedProcessInvocationGuard,
  type BoundedProcessContainment,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
  retainBoundedProcessRecoveryPath,
  rethrowBoundedProcessCleanupUnproven as rethrowLocalProcessCleanupUnproven,
  requireBoundedProcessCleanup,
  runBoundedProcess,
} from "./bounded-process";
import {
  renderAuthorityContainmentUnavailable,
  rethrowAuthorityContainmentUnavailable,
} from "./authority-containment";

import {
  canonicalDigest,
  cutoverEvidenceSchema,
  cutoverReservationSchema,
  parseCutoverEvidenceFile,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type CutoverEvidence,
} from "./release-evidence";

const rethrowBoundedProcessCleanupUnproven = (error: unknown): void => {
  rethrowAuthorityContainmentUnavailable(error);
  rethrowLocalProcessCleanupUnproven(error);
};

const oldProjectId = "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
const newProjectId = "prj_8ciIt9t9foE3utG45frRN7cxckjS";
const oldRepositoryId = 1_334_876_494;
const newRepositoryId = 1_343_008_607;
const team = "hraness";
const teamId = "team_UAd1iD2XogJlbFg4h14mRaPM";
const canonicalAlias = "hra.sh";
const fallbackAlias = "hra-weld.vercel.app";
const newStagingAlias = "try-hra.vercel.app";
const supportedVercelVersion = "54.18.0";
const commandTimeoutMs = 30_000;
const commandTerminationGraceMs = 1_000;
const convergenceTimeoutMs = 60_000;
const domainPageLimit = 20;
const maximumDomainPages = 64;
const outputMaximumBytes = 128 * 1_024;
const inputMaximumBytes = 32 * 1_024;

const projectIdSchema = z.enum([oldProjectId, newProjectId]);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]{20,80}$/u);
const deploymentUrlSchema = z.string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u)
  .refine((value) => value.indexOf(".vercel.app") === value.length - ".vercel.app".length);
const versionSchema = z.string().regex(/^0\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u);

const endpointSchema = z.object({
  deploymentId: deploymentIdSchema,
  deploymentUrl: deploymentUrlSchema,
  generation: z.union([z.literal(0), z.literal(1), z.null()]),
  projectId: projectIdSchema,
  repositoryId: z.union([z.literal(oldRepositoryId), z.literal(newRepositoryId)]),
  sourceCommit: commitSchema,
  version: versionSchema,
}).strict().superRefine((endpoint, context) => {
  const expectedRepository = endpoint.projectId === oldProjectId
    ? oldRepositoryId
    : newRepositoryId;
  if (endpoint.repositoryId !== expectedRepository) {
    context.addIssue({ code: "custom", message: "repository_project_mismatch" });
  }
  if (
    endpoint.generation !== null
    && endpoint.projectId === newProjectId
    && endpoint.generation !== 1
  ) {
    context.addIssue({ code: "custom", message: "generation_project_mismatch" });
  }
});

const cutoverPlanSchema = z.object({
  direction: z.enum(["archive", "forward", "reverse"]),
  mode: z.enum(["domain", "traffic-only"]),
  schemaVersion: z.literal(1),
  source: endpointSchema,
  target: endpointSchema,
}).strict().superRefine((plan, context) => {
  const expected = plan.direction === "archive"
    ? { mode: "traffic-only", source: oldProjectId, target: oldProjectId }
    : plan.direction === "forward"
      ? { mode: "domain", source: oldProjectId, target: newProjectId }
      : { mode: "domain", source: newProjectId, target: oldProjectId };
  if (
    plan.mode !== expected.mode
    || plan.source.projectId !== expected.source
    || plan.target.projectId !== expected.target
    || plan.source.deploymentId === plan.target.deploymentId
  ) context.addIssue({ code: "custom", message: "direction_identity_mismatch" });
  if (plan.direction === "archive" && plan.source.generation !== null) {
    context.addIssue({ code: "custom", message: "archive_source_marker_must_be_absent" });
  }
  if (plan.target.generation === null || (plan.mode === "domain" && plan.source.generation === null)) {
    context.addIssue({ code: "custom", message: "required_marker_missing" });
  }
});

export type CutoverEndpoint = z.infer<typeof endpointSchema>;
export type CutoverPlan = z.infer<typeof cutoverPlanSchema>;
export type CutoverOutcome = Readonly<{
  changed: boolean;
  replayed: boolean;
}>;

const managedAliasSchema = z.enum([canonicalAlias, fallbackAlias, newStagingAlias]);

const aliasReadbackSchema = z.object({
  alias: managedAliasSchema,
  deployment: z.object({
    id: deploymentIdSchema,
    url: deploymentUrlSchema,
  }),
  deploymentId: deploymentIdSchema,
  projectId: projectIdSchema,
});

const deploymentReadbackSchema = z.object({
  gitSource: z.object({
    ref: z.literal("main"),
    repoId: z.number().int().positive(),
    sha: commitSchema,
    type: z.literal("github"),
  }),
  id: deploymentIdSchema,
  projectId: projectIdSchema,
  readyState: z.literal("READY"),
  url: deploymentUrlSchema,
});

const projectReadbackSchema = z.object({
  accountId: z.literal(teamId),
  autoAssignCustomDomains: z.boolean(),
  id: projectIdSchema,
});

const paginationCursorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const domainsReadbackSchema = z.object({
  domains: z.array(z.object({ name: z.string().min(1).max(253) })).max(domainPageLimit),
  pagination: z.object({
    count: z.number().int().nonnegative().max(domainPageLimit),
    next: paginationCursorSchema.nullable(),
    prev: paginationCursorSchema.nullable(),
  }).strict(),
}).strict().superRefine((page, context) => {
  if (page.pagination.count !== page.domains.length) {
    context.addIssue({ code: "custom", message: "pagination_count_mismatch" });
  }
  if (page.domains.length === 0 && page.pagination.next !== null) {
    context.addIssue({ code: "custom", message: "empty_page_has_next" });
  }
});

const markerSourceSchema = z.object({ commit: commitSchema }).strict();
const markerSchema = z.union([
  z.object({
    generation: z.union([z.literal(0), z.literal(1)]),
    product: z.literal("HRA"),
    publication: z.object({ version: versionSchema }).passthrough(),
    repository: z.object({
      id: z.literal(oldRepositoryId),
      path: z.literal("hraness/hra-v0"),
    }).strict(),
    schemaVersion: z.literal(2),
    source: markerSourceSchema,
  }).strict(),
  z.object({
    generation: z.literal(1),
    product: z.literal("HRA"),
    repository: z.object({
      id: z.literal(newRepositoryId),
      path: z.literal("hraness/hra"),
    }).strict(),
    schemaVersion: z.literal(2),
    source: markerSourceSchema,
    version: versionSchema,
  }).strict(),
]);

export type AliasReadback = z.infer<typeof aliasReadbackSchema>;
export type DeploymentReadback = z.infer<typeof deploymentReadbackSchema>;
export type ManagedAlias = z.infer<typeof managedAliasSchema>;
export type ProjectReadback = z.infer<typeof projectReadbackSchema>;

type DomainOwner = "ambiguous" | "source" | "target";
type CutoverState = "ambiguous" | "partial" | "source" | "target";
type TrafficState = "ambiguous" | "partial" | "source" | "target";

export type CutoverPreflightOutcome = Readonly<{
  nextAction: "execute_plan" | "replay_plan_for_receipt" | "stop_and_investigate";
  observedOwner: DomainOwner;
  observedState: CutoverState;
  observedTraffic: TrafficState;
  reason:
    | "ambiguous_state"
    | "exact_source"
    | "exact_target"
    | "partial_state"
    | "source_not_authoritative"
    | "target_not_authoritative";
  status: "already_committed" | "blocked" | "ready";
}>;

type StateClassification = Readonly<{
  owner: DomainOwner;
  state: CutoverState;
  traffic: TrafficState;
}>;

type ProviderReadFailureMode = "ambiguous" | "refuse";

type AliasExpectation = Readonly<{
  aliasName: ManagedAlias;
  endpoint: CutoverEndpoint;
}>;

type OwnerExpectation = Readonly<{
  expected: Exclude<DomainOwner, "ambiguous">;
  sourceProjectId: typeof oldProjectId | typeof newProjectId;
  targetProjectId: typeof oldProjectId | typeof newProjectId;
}>;

type ExactStateExpectation = Readonly<{
  aliases: readonly AliasExpectation[];
  owner: OwnerExpectation;
}>;

export interface CutoverProvider {
  moveDomain(sourceProjectId: string, targetProjectId: string): Promise<void>;
  readAlias(aliasName: ManagedAlias): Promise<AliasReadback>;
  readDeployment(deploymentId: string): Promise<DeploymentReadback>;
  /** Return the complete domain-name set only after proving terminal pagination. */
  readDomainNames(projectId: string): Promise<readonly string[]>;
  readMarker(aliasName: ManagedAlias): Promise<unknown>;
  readProject(projectId: string): Promise<ProjectReadback>;
  setAlias(deploymentUrl: string, aliasName: ManagedAlias): Promise<void>;
}

type CutoverFailureCode =
  | "alias_readback_invalid"
  | "automatic_domain_assignment_unsafe"
  | "command_failed"
  | "command_output_invalid"
  | "compensation_failed"
  | "cutover_ambiguous"
  | "cutover_reverted"
  | "deployment_readback_invalid"
  | "input_invalid"
  | "input_not_protected"
  | "input_timed_out"
  | "input_too_large"
  | "source_not_authoritative"
  | "usage_invalid"
  | "vercel_version_unsupported";

export class DomainCutoverError extends Error {
  readonly code: CutoverFailureCode;

  constructor(code: CutoverFailureCode) {
    super(code);
    this.name = "DomainCutoverError";
    this.code = code;
  }
}

type CutoverClock = Readonly<{
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

const defaultClock: CutoverClock = {
  now: Date.now,
  sleep: async (milliseconds) => {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  },
};

const settleProviderOperations = async <const Values extends readonly unknown[]>(
  operations: { readonly [Index in keyof Values]: Promise<Values[Index]> },
): Promise<Values> => {
  const results = await Promise.allSettled(operations);
  const cleanupFailure = results.find((result): result is PromiseRejectedResult =>
    result.status === "rejected"
    && isBoundedProcessCleanupUnprovenError(result.reason));
  if (cleanupFailure !== undefined) throw cleanupFailure.reason;
  const journalFailure = results.find((result): result is PromiseRejectedResult =>
    result.status === "rejected"
    && isBoundedProcessRecoveryJournalError(result.reason));
  if (journalFailure !== undefined) throw journalFailure.reason;
  const failure = results.find((result): result is PromiseRejectedResult =>
    result.status === "rejected");
  if (failure !== undefined) throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as Values;
};

const aliasMatches = (
  value: AliasReadback,
  endpoint: CutoverEndpoint,
  aliasName: ManagedAlias,
): boolean => value.alias === aliasName
  && value.projectId === endpoint.projectId
  && value.deploymentId === endpoint.deploymentId
  && value.deployment.id === endpoint.deploymentId
  && value.deployment.url === endpoint.deploymentUrl;

const deploymentMatches = (
  value: DeploymentReadback,
  endpoint: CutoverEndpoint,
): boolean => value.id === endpoint.deploymentId
  && value.projectId === endpoint.projectId
  && value.url === endpoint.deploymentUrl
  && value.gitSource.repoId === endpoint.repositoryId
  && value.gitSource.sha === endpoint.sourceCommit;

const markerMatches = (value: unknown, endpoint: CutoverEndpoint): boolean => {
  if (endpoint.generation === null) return true;
  const parsed = markerSchema.safeParse(value);
  const expectedPath = endpoint.projectId === oldProjectId ? "hraness/hra-v0" : "hraness/hra";
  const markerVersion = parsed.success
    ? "publication" in parsed.data
      ? parsed.data.publication.version
      : parsed.data.version
    : null;
  return parsed.success
    && parsed.data.generation === endpoint.generation
    && parsed.data.repository.id === endpoint.repositoryId
    && parsed.data.repository.path === expectedPath
    && parsed.data.source.commit === endpoint.sourceCommit
    && markerVersion === endpoint.version;
};

const readOwner = async (
  provider: CutoverProvider,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<DomainOwner> => {
  const [sourceNames, targetNames] = await settleProviderOperations([
    provider.readDomainNames(sourceProjectId),
    provider.readDomainNames(targetProjectId),
  ]);
  const sourceCount = sourceNames.filter((name) => name === canonicalAlias).length;
  const targetCount = targetNames.filter((name) => name === canonicalAlias).length;
  if (sourceCount === 1 && targetCount === 0) return "source";
  if (sourceCount === 0 && targetCount === 1) return "target";
  return "ambiguous";
};

const readOwnerSafely = async (
  provider: CutoverProvider,
  sourceProjectId: string,
  targetProjectId: string,
): Promise<DomainOwner> => {
  try {
    return await readOwner(provider, sourceProjectId, targetProjectId);
  } catch (error: unknown) {
    rethrowBoundedProcessCleanupUnproven(error);
    return "ambiguous";
  }
};

const acceptedArchiveEndpoint = (plan: CutoverPlan): CutoverEndpoint =>
  plan.direction === "forward" ? plan.source : plan.target;

const acceptedNewEndpoint = (plan: CutoverPlan): CutoverEndpoint =>
  plan.direction === "forward" ? plan.target : plan.source;

const stateExpectation = (
  plan: CutoverPlan,
  state: "source" | "target",
): ExactStateExpectation => {
  if (plan.direction === "archive") {
    const endpoint = state === "source" ? plan.source : plan.target;
    return {
      aliases: [
        { aliasName: canonicalAlias, endpoint },
        { aliasName: fallbackAlias, endpoint },
      ],
      owner: {
        expected: "source",
        sourceProjectId: oldProjectId,
        targetProjectId: newProjectId,
      },
    };
  }
  return {
    aliases: [
      {
        aliasName: canonicalAlias,
        endpoint: state === "source" ? plan.source : plan.target,
      },
      { aliasName: fallbackAlias, endpoint: acceptedArchiveEndpoint(plan) },
      { aliasName: newStagingAlias, endpoint: acceptedNewEndpoint(plan) },
    ],
    owner: {
      expected: state,
      sourceProjectId: plan.source.projectId,
      targetProjectId: plan.target.projectId,
    },
  };
};

const readTrafficState = async (
  provider: CutoverProvider,
  plan: CutoverPlan,
): Promise<TrafficState> => {
  if (plan.direction !== "archive") {
    const [canonical, fallback, staging] = await settleProviderOperations([
      provider.readAlias(canonicalAlias),
      provider.readAlias(fallbackAlias),
      provider.readAlias(newStagingAlias),
    ]);
    const canonicalState = aliasMatches(canonical, plan.source, canonicalAlias)
      ? "source"
      : aliasMatches(canonical, plan.target, canonicalAlias)
        ? "target"
        : "ambiguous";
    const fallbackExpected = acceptedArchiveEndpoint(plan);
    const stagingExpected = acceptedNewEndpoint(plan);
    const fallbackExact = aliasMatches(fallback, fallbackExpected, fallbackAlias);
    const stagingExact = aliasMatches(staging, stagingExpected, newStagingAlias);
    if (canonicalState === "ambiguous") return "ambiguous";
    if (fallbackExact && stagingExact) return canonicalState;
    const fallbackKnown = aliasMatches(fallback, plan.source, fallbackAlias)
      || aliasMatches(fallback, plan.target, fallbackAlias);
    const stagingKnown = aliasMatches(staging, plan.source, newStagingAlias)
      || aliasMatches(staging, plan.target, newStagingAlias);
    return fallbackKnown && stagingKnown ? "partial" : "ambiguous";
  }
  const [canonical, fallback] = await settleProviderOperations([
    provider.readAlias(canonicalAlias),
    provider.readAlias(fallbackAlias),
  ]);
  const canonicalState = aliasMatches(canonical, plan.source, canonicalAlias)
    ? "source"
    : aliasMatches(canonical, plan.target, canonicalAlias)
      ? "target"
      : "ambiguous";
  const fallbackState = aliasMatches(fallback, plan.source, fallbackAlias)
    ? "source"
    : aliasMatches(fallback, plan.target, fallbackAlias)
      ? "target"
      : "ambiguous";
  if (canonicalState === "ambiguous" || fallbackState === "ambiguous") return "ambiguous";
  return canonicalState === fallbackState ? canonicalState : "partial";
};

const readStateClassification = async (
  provider: CutoverProvider,
  plan: CutoverPlan,
  failureMode: ProviderReadFailureMode = "ambiguous",
): Promise<StateClassification> => {
  const ownerExpectation = stateExpectation(plan, "source").owner;
  const read = async (): Promise<StateClassification> => {
    const [traffic, owner] = await settleProviderOperations([
      readTrafficState(provider, plan),
      failureMode === "refuse"
        ? readOwner(
            provider,
            ownerExpectation.sourceProjectId,
            ownerExpectation.targetProjectId,
          )
        : readOwnerSafely(
            provider,
            ownerExpectation.sourceProjectId,
            ownerExpectation.targetProjectId,
          ),
    ]);
    if (traffic === "ambiguous" || owner === "ambiguous") {
      return { owner, state: "ambiguous", traffic };
    }
    if (plan.direction === "archive") {
      return owner === "source"
        ? { owner, state: traffic, traffic }
        : { owner, state: "ambiguous", traffic };
    }
    if (traffic === "partial") return { owner, state: "partial", traffic };
    return traffic === owner
      ? { owner, state: traffic, traffic }
      : { owner, state: "partial", traffic };
  };
  if (failureMode === "refuse") return await read();
  try {
    return await read();
  } catch (error: unknown) {
    rethrowBoundedProcessCleanupUnproven(error);
    return { owner: "ambiguous", state: "ambiguous", traffic: "ambiguous" };
  }
};

const classifyCutoverState = async (
  provider: CutoverProvider,
  plan: CutoverPlan,
  clock: CutoverClock,
  timeoutMs: number,
  failureMode: ProviderReadFailureMode = "ambiguous",
): Promise<StateClassification> => {
  const deadline = clock.now() + timeoutMs;
  let latest: StateClassification = {
    owner: "ambiguous",
    state: "ambiguous",
    traffic: "ambiguous",
  };
  do {
    latest = await readStateClassification(provider, plan, failureMode);
    if (latest.state !== "ambiguous") return latest;
    if (clock.now() >= deadline) break;
    await clock.sleep(Math.min(1_000, Math.max(1, deadline - clock.now())));
  } while (clock.now() <= deadline);
  return latest;
};

const readExactTraffic = async (
  provider: CutoverProvider,
  expectation: ExactStateExpectation,
): Promise<boolean> => {
  const aliases = await settleProviderOperations(
    expectation.aliases.map(async ({ aliasName, endpoint }) => {
      const [aliasValue, markerValue] = await settleProviderOperations([
        provider.readAlias(aliasName),
        endpoint.generation === null
          ? Promise.resolve(null)
          : provider.readMarker(aliasName),
      ]);
      return aliasMatches(aliasValue, endpoint, aliasName)
        && markerMatches(markerValue, endpoint);
    }),
  );
  return aliases.every(Boolean);
};

const readExactState = async (
  provider: CutoverProvider,
  expectation: ExactStateExpectation,
): Promise<boolean> => {
  const [traffic, owner] = await settleProviderOperations([
    readExactTraffic(provider, expectation),
    readOwner(
      provider,
      expectation.owner.sourceProjectId,
      expectation.owner.targetProjectId,
    ),
  ]);
  return traffic && owner === expectation.owner.expected;
};

const probeExactTraffic = async (
  provider: CutoverProvider,
  expectation: ExactStateExpectation,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = clock.now() + timeoutMs;
  do {
    try {
      if (await readExactTraffic(provider, expectation)) return true;
    } catch (error: unknown) {
      rethrowBoundedProcessCleanupUnproven(error);
      // A provider or public read can be transient inside the bounded window.
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(Math.min(1_000, Math.max(1, deadline - clock.now())));
  } while (clock.now() <= deadline);
  return false;
};

const probeExactState = async (
  provider: CutoverProvider,
  expectation: ExactStateExpectation,
  clock: CutoverClock,
  timeoutMs: number,
  failureMode: ProviderReadFailureMode = "ambiguous",
): Promise<boolean> => {
  const deadline = clock.now() + timeoutMs;
  do {
    if (failureMode === "refuse") {
      if (await readExactState(provider, expectation)) return true;
    } else {
      try {
        if (await readExactState(provider, expectation)) return true;
      } catch (error: unknown) {
        rethrowBoundedProcessCleanupUnproven(error);
        // A provider or public read can be transient inside the bounded window.
      }
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(Math.min(1_000, Math.max(1, deadline - clock.now())));
  } while (clock.now() <= deadline);
  return false;
};

const probeEndpoint = async (
  provider: CutoverProvider,
  endpoint: CutoverEndpoint,
  aliasName: ManagedAlias,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = clock.now() + timeoutMs;
  do {
    try {
      const [aliasValue, markerValue] = await settleProviderOperations([
        provider.readAlias(aliasName),
        endpoint.generation === null ? Promise.resolve(null) : provider.readMarker(aliasName),
      ]);
      if (
        aliasMatches(aliasValue, endpoint, aliasName)
        && markerMatches(markerValue, endpoint)
      ) {
        return true;
      }
    } catch (error: unknown) {
      rethrowBoundedProcessCleanupUnproven(error);
      // A provider or public read can be transient inside the bounded window.
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(Math.min(1_000, Math.max(1, deadline - clock.now())));
  } while (clock.now() <= deadline);
  return false;
};

const restoreTraffic = async (
  provider: CutoverProvider,
  source: CutoverEndpoint,
  aliasName: ManagedAlias,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<void> => {
  try {
    await provider.setAlias(source.deploymentUrl, aliasName);
  } catch (error: unknown) {
    rethrowBoundedProcessCleanupUnproven(error);
    // Alias mutation failures are ambiguous, so the exact readback still decides.
  }
  if (!await probeEndpoint(provider, source, aliasName, clock, timeoutMs)) {
    throw new DomainCutoverError("compensation_failed");
  }
};

const restoreExactTraffic = async (
  provider: CutoverProvider,
  expectation: ExactStateExpectation,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<void> => {
  const results = await Promise.allSettled(
    expectation.aliases.map(async ({ aliasName, endpoint }) =>
      await restoreTraffic(provider, endpoint, aliasName, clock, timeoutMs)),
  );
  const cleanupFailure = results.find((result): result is PromiseRejectedResult =>
    result.status === "rejected"
    && isBoundedProcessCleanupUnprovenError(result.reason));
  if (cleanupFailure !== undefined) throw cleanupFailure.reason;
  const journalFailure = results.find((result): result is PromiseRejectedResult =>
    result.status === "rejected"
    && isBoundedProcessRecoveryJournalError(result.reason));
  if (journalFailure !== undefined) throw journalFailure.reason;
  if (results.some((result) => result.status === "rejected")) {
    throw new DomainCutoverError("compensation_failed");
  }
};

const reconcileExactSource = async (
  provider: CutoverProvider,
  expectation: ExactStateExpectation,
  proof: "state" | "traffic",
  clock: CutoverClock,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = clock.now() + timeoutMs;
  const readProof = async (): Promise<boolean> => proof === "state"
    ? await readExactState(provider, expectation)
    : await readExactTraffic(provider, expectation);
  do {
    try {
      const remainingMs = Math.max(0, deadline - clock.now());
      await restoreExactTraffic(provider, expectation, clock, remainingMs);
      if (await readProof() && await readProof()) return true;
    } catch (error: unknown) {
      rethrowBoundedProcessCleanupUnproven(error);
      // Reconcile again while the single bounded window remains.
    }
    if (clock.now() >= deadline) break;
    await clock.sleep(Math.min(1_000, Math.max(1, deadline - clock.now())));
  } while (clock.now() <= deadline);
  return false;
};

const restoreArchiveTraffic = async (
  provider: CutoverProvider,
  plan: CutoverPlan,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<never> => {
  const source = stateExpectation(plan, "source");
  if (!await reconcileExactSource(provider, source, "state", clock, timeoutMs)) {
    const finalOwner = await readOwnerSafely(provider, oldProjectId, newProjectId);
    if (finalOwner !== "source") throw new DomainCutoverError("cutover_ambiguous");
    throw new DomainCutoverError("compensation_failed");
  }
  throw new DomainCutoverError("cutover_reverted");
};

const reverseMetadataIfExact = async (
  provider: CutoverProvider,
  plan: CutoverPlan,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<"ambiguous" | "restored"> => {
  const preMoveDeadline = clock.now() + timeoutMs;
  let owner: DomainOwner = "ambiguous";
  do {
    owner = await readOwnerSafely(
      provider,
      plan.source.projectId,
      plan.target.projectId,
    );
    if (owner !== "ambiguous") break;
    if (clock.now() >= preMoveDeadline) return "ambiguous";
    await clock.sleep(Math.min(1_000, Math.max(1, preMoveDeadline - clock.now())));
  } while (clock.now() <= preMoveDeadline);
  if (owner === "source") return "restored";
  if (owner !== "target") return "ambiguous";
  try {
    await provider.moveDomain(plan.target.projectId, plan.source.projectId);
  } catch (error: unknown) {
    rethrowBoundedProcessCleanupUnproven(error);
    // Readback below determines whether the reverse request committed.
  }
  const postMoveDeadline = clock.now() + timeoutMs;
  do {
    owner = await readOwnerSafely(
      provider,
      plan.source.projectId,
      plan.target.projectId,
    );
    if (owner === "source") return "restored";
    if (clock.now() >= postMoveDeadline) break;
    await clock.sleep(Math.min(1_000, Math.max(1, postMoveDeadline - clock.now())));
  } while (clock.now() <= postMoveDeadline);
  return "ambiguous";
};

const compensateDomainMove = async (
  provider: CutoverProvider,
  plan: CutoverPlan,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<never> => {
  const source = stateExpectation(plan, "source");
  await restoreExactTraffic(provider, source, clock, timeoutMs);
  if (!await probeExactTraffic(provider, source, clock, timeoutMs)) {
    throw new DomainCutoverError("compensation_failed");
  }
  const metadata = await reverseMetadataIfExact(provider, plan, clock, timeoutMs);
  if (metadata !== "restored") {
    if (!await reconcileExactSource(provider, source, "traffic", clock, timeoutMs)) {
      throw new DomainCutoverError("compensation_failed");
    }
    throw new DomainCutoverError("cutover_ambiguous");
  }
  if (!await reconcileExactSource(provider, source, "state", clock, timeoutMs)) {
    const owner = await readOwnerSafely(
      provider,
      plan.source.projectId,
      plan.target.projectId,
    );
    if (owner !== "source") throw new DomainCutoverError("cutover_ambiguous");
    throw new DomainCutoverError("compensation_failed");
  }
  throw new DomainCutoverError("cutover_reverted");
};

const verifyCutoverIdentityAuthority = async (
  plan: CutoverPlan,
  provider: CutoverProvider,
): Promise<void> => {
  const projects = await settleProviderOperations([
    provider.readProject(oldProjectId),
    provider.readProject(newProjectId),
  ]).catch((error: unknown) => {
    rethrowBoundedProcessCleanupUnproven(error);
    throw new DomainCutoverError("automatic_domain_assignment_unsafe");
  });
  const expectedProjects = [oldProjectId, newProjectId] as const;
  if (projects.some((project, index) => {
    const parsed = projectReadbackSchema.safeParse(project);
    return !parsed.success
      || parsed.data.id !== expectedProjects[index]
      || parsed.data.autoAssignCustomDomains;
  })) throw new DomainCutoverError("automatic_domain_assignment_unsafe");

  const [sourceDeployment, targetDeployment] = await settleProviderOperations([
    provider.readDeployment(plan.source.deploymentId),
    provider.readDeployment(plan.target.deploymentId),
  ]).catch((error: unknown) => {
    rethrowBoundedProcessCleanupUnproven(error);
    throw new DomainCutoverError("deployment_readback_invalid");
  });
  if (
    !deploymentMatches(sourceDeployment, plan.source)
    || !deploymentMatches(targetDeployment, plan.target)
  ) throw new DomainCutoverError("deployment_readback_invalid");
};

const refuseProviderRead = (error: unknown, fallback: CutoverFailureCode): never => {
  rethrowBoundedProcessCleanupUnproven(error);
  if (error instanceof DomainCutoverError) throw error;
  throw new DomainCutoverError(fallback);
};

const preflightReadProvider = (provider: CutoverProvider): CutoverProvider => ({
  async moveDomain(): Promise<void> {
    throw new DomainCutoverError("usage_invalid");
  },
  async readAlias(aliasName): Promise<AliasReadback> {
    try {
      return await provider.readAlias(aliasName);
    } catch (error: unknown) {
      return refuseProviderRead(error, "alias_readback_invalid");
    }
  },
  async readDeployment(deploymentId): Promise<DeploymentReadback> {
    try {
      return await provider.readDeployment(deploymentId);
    } catch (error: unknown) {
      return refuseProviderRead(error, "deployment_readback_invalid");
    }
  },
  async readDomainNames(projectId): Promise<readonly string[]> {
    try {
      return await provider.readDomainNames(projectId);
    } catch (error: unknown) {
      return refuseProviderRead(error, "command_output_invalid");
    }
  },
  async readMarker(aliasName): Promise<unknown> {
    try {
      return await provider.readMarker(aliasName);
    } catch (error: unknown) {
      return refuseProviderRead(error, "command_output_invalid");
    }
  },
  async readProject(projectId): Promise<ProjectReadback> {
    try {
      return await provider.readProject(projectId);
    } catch (error: unknown) {
      return refuseProviderRead(error, "automatic_domain_assignment_unsafe");
    }
  },
  async setAlias(): Promise<void> {
    throw new DomainCutoverError("usage_invalid");
  },
});

export async function preflightCutoverPlan(
  planInput: CutoverPlan,
  provider: CutoverProvider,
  options: Readonly<{
    clock?: CutoverClock;
    convergenceTimeoutMs?: number;
  }> = {},
): Promise<CutoverPreflightOutcome> {
  const plan = cutoverPlanSchema.parse(planInput);
  const clock = options.clock ?? defaultClock;
  const timeoutMs = options.convergenceTimeoutMs ?? convergenceTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > convergenceTimeoutMs) {
    throw new DomainCutoverError("usage_invalid");
  }

  const readProvider = preflightReadProvider(provider);
  await verifyCutoverIdentityAuthority(plan, readProvider);
  const classification = await classifyCutoverState(
    readProvider,
    plan,
    clock,
    timeoutMs,
    "refuse",
  );
  const outcome = (
    status: CutoverPreflightOutcome["status"],
    reason: CutoverPreflightOutcome["reason"],
    nextAction: CutoverPreflightOutcome["nextAction"],
  ): CutoverPreflightOutcome => ({
    nextAction,
    observedOwner: classification.owner,
    observedState: classification.state,
    observedTraffic: classification.traffic,
    reason,
    status,
  });

  if (classification.state === "source") {
    return await probeExactState(
      readProvider,
      stateExpectation(plan, "source"),
      clock,
      timeoutMs,
      "refuse",
    )
      ? outcome("ready", "exact_source", "execute_plan")
      : outcome("blocked", "source_not_authoritative", "stop_and_investigate");
  }
  if (classification.state === "target") {
    return await probeExactState(
      readProvider,
      stateExpectation(plan, "target"),
      clock,
      timeoutMs,
      "refuse",
    )
      ? outcome("already_committed", "exact_target", "replay_plan_for_receipt")
      : outcome("blocked", "target_not_authoritative", "stop_and_investigate");
  }
  return classification.state === "partial"
    ? outcome("blocked", "partial_state", "stop_and_investigate")
    : outcome("blocked", "ambiguous_state", "stop_and_investigate");
}

export async function executeCutoverPlan(
  planInput: CutoverPlan,
  provider: CutoverProvider,
  options: Readonly<{
    clock?: CutoverClock;
    convergenceTimeoutMs?: number;
  }> = {},
): Promise<CutoverOutcome> {
  const plan = cutoverPlanSchema.parse(planInput);
  const clock = options.clock ?? defaultClock;
  const timeoutMs = options.convergenceTimeoutMs ?? convergenceTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > convergenceTimeoutMs) {
    throw new DomainCutoverError("usage_invalid");
  }

  await verifyCutoverIdentityAuthority(plan, provider);

  const classification = await classifyCutoverState(provider, plan, clock, timeoutMs);
  if (classification.state === "target") {
    if (await probeExactState(provider, stateExpectation(plan, "target"), clock, timeoutMs)) {
      return { changed: false, replayed: true };
    }
    if (plan.direction === "archive") {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    return await compensateDomainMove(provider, plan, clock, timeoutMs);
  }
  if (classification.state === "partial") {
    if (plan.direction === "archive") {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    return await compensateDomainMove(provider, plan, clock, timeoutMs);
  }
  if (classification.state === "ambiguous") {
    if (classification.traffic === "source" && plan.direction === "archive") {
      throw new DomainCutoverError("cutover_ambiguous");
    }
    if (plan.direction === "archive") {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    return await compensateDomainMove(provider, plan, clock, timeoutMs);
  }
  if (!await probeExactState(provider, stateExpectation(plan, "source"), clock, timeoutMs)) {
    if (plan.direction === "archive") {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    return await compensateDomainMove(provider, plan, clock, timeoutMs);
  }

  if (plan.direction === "archive") {
    try {
      await provider.setAlias(plan.target.deploymentUrl, fallbackAlias);
    } catch (error: unknown) {
      rethrowBoundedProcessCleanupUnproven(error);
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    if (!await probeEndpoint(provider, plan.target, fallbackAlias, clock, timeoutMs)) {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    if (await readOwnerSafely(provider, oldProjectId, newProjectId) !== "source") {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
  }

  try {
    await provider.setAlias(plan.target.deploymentUrl, canonicalAlias);
  } catch (error: unknown) {
    rethrowBoundedProcessCleanupUnproven(error);
    if (plan.direction === "archive") {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    return await compensateDomainMove(provider, plan, clock, timeoutMs);
  }
  if (!await probeEndpoint(provider, plan.target, canonicalAlias, clock, timeoutMs)) {
    if (plan.direction === "archive") {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    return await compensateDomainMove(provider, plan, clock, timeoutMs);
  }
  if (plan.mode === "traffic-only") {
    if (!await probeExactState(provider, stateExpectation(plan, "target"), clock, timeoutMs)) {
      return await restoreArchiveTraffic(provider, plan, clock, timeoutMs);
    }
    return { changed: true, replayed: false };
  }

  try {
    await provider.moveDomain(plan.source.projectId, plan.target.projectId);
  } catch (error: unknown) {
    rethrowBoundedProcessCleanupUnproven(error);
    // Exact alias and ownership readback below resolve an ambiguous API result.
  }

  if (!await probeExactState(provider, stateExpectation(plan, "target"), clock, timeoutMs)) {
    return await compensateDomainMove(provider, plan, clock, timeoutMs);
  }
  return { changed: true, replayed: false };
}

export function parseCutoverPlan(document: string): CutoverPlan {
  if (Buffer.byteLength(document, "utf8") > inputMaximumBytes) {
    throw new DomainCutoverError("input_too_large");
  }
  try {
    return cutoverPlanSchema.parse(JSON.parse(document) as unknown);
  } catch (error: unknown) {
    if (error instanceof DomainCutoverError) throw error;
    throw new DomainCutoverError("input_invalid");
  }
}

export type VercelCommandRequest = Readonly<{
  arguments: readonly string[];
  containment: BoundedProcessContainment;
  environment: Readonly<Record<string, string>>;
  executable: string;
  phase: string;
}>;

export type VercelCommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

export type VercelCommandRunner = (
  request: VercelCommandRequest,
) => Promise<VercelCommandResult>;

export const runVercelCommand: VercelCommandRunner = async (request) => {
  const result = requireBoundedProcessCleanup(await runBoundedProcess({
    arguments: request.arguments,
    containment: request.containment,
    cwd: process.cwd(),
    environment: request.environment,
    executable: request.executable,
    outputMaximumBytes,
    phase: request.phase,
    terminationGraceMs: commandTerminationGraceMs,
    timeoutMs: commandTimeoutMs,
  }));
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString("utf8"),
    stdout: result.stdout.toString("utf8"),
  };
};

const childEnvironmentNames = [
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SystemRoot",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
] as const;

export const buildVercelEnvironment = (
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = { NO_COLOR: "1", TERM: "dumb" };
  for (const name of childEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const parseProviderJson = (document: string): unknown => {
  if (
    document.trim().length === 0
    || Buffer.byteLength(document, "utf8") > outputMaximumBytes
  ) throw new DomainCutoverError("command_output_invalid");
  try {
    return JSON.parse(document) as unknown;
  } catch {
    throw new DomainCutoverError("command_output_invalid");
  }
};

type VercelProviderOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  guard?: BoundedProcessInvocationGuard;
  markerTimeoutMs?: number;
  runner?: VercelCommandRunner;
  vercelCli: string;
}>;

export class VercelCutoverProvider implements CutoverProvider {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #guard: BoundedProcessInvocationGuard;
  readonly #runner: VercelCommandRunner;
  readonly #vercelCli: string;

  constructor(options: VercelProviderOptions) {
    if (!isAbsolute(options.vercelCli)) throw new DomainCutoverError("usage_invalid");
    const markerTimeoutMs = options.markerTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(markerTimeoutMs) || markerTimeoutMs < 1 || markerTimeoutMs > 5_000) {
      throw new DomainCutoverError("usage_invalid");
    }
    this.#environment = buildVercelEnvironment(options.environment ?? process.env);
    this.#guard = options.guard ?? new BoundedProcessInvocationGuard();
    this.#fetcher = createBoundedAuthorityFetch(
      options.fetcher ?? fetch,
      markerTimeoutMs,
      "vercel_marker_timeout",
    );
    this.#runner = options.runner ?? runVercelCommand;
    this.#vercelCli = options.vercelCli;
  }

  async #invoke(arguments_: readonly string[], phase: string): Promise<string> {
    const result = await this.#guard.observe(async () => await this.#runner({
      arguments: arguments_,
      containment: "authority",
      environment: this.#environment,
      executable: this.#vercelCli,
      phase,
    }));
    if (result.exitCode !== 0) throw new DomainCutoverError("command_failed");
    return result.stdout;
  }

  async verifyVersion(): Promise<void> {
    const version = (await this.#invoke(["--version"], "vercel-version-read")).trim();
    if (version !== supportedVercelVersion) {
      throw new DomainCutoverError("vercel_version_unsupported");
    }
  }

  async readAlias(aliasName: ManagedAlias): Promise<AliasReadback> {
    if (!managedAliasSchema.safeParse(aliasName).success) {
      throw new DomainCutoverError("alias_readback_invalid");
    }
    try {
      const parsed = aliasReadbackSchema.parse(parseProviderJson(await this.#invoke([
        "api",
        `/v4/aliases/${aliasName}`,
        "--scope",
        team,
        "--raw",
      ], "vercel-alias-read")));
      if (parsed.alias !== aliasName) throw new DomainCutoverError("alias_readback_invalid");
      return parsed;
    } catch (error: unknown) {
      rethrowBoundedProcessCleanupUnproven(error);
      if (error instanceof DomainCutoverError && error.code === "command_failed") throw error;
      throw new DomainCutoverError("alias_readback_invalid");
    }
  }

  async readDeployment(deploymentId: string): Promise<DeploymentReadback> {
    if (!deploymentIdSchema.safeParse(deploymentId).success) {
      throw new DomainCutoverError("deployment_readback_invalid");
    }
    try {
      return deploymentReadbackSchema.parse(parseProviderJson(await this.#invoke([
        "api",
        `/v13/deployments/${deploymentId}`,
        "--scope",
        team,
        "--raw",
      ], "vercel-deployment-read")));
    } catch (error: unknown) {
      rethrowBoundedProcessCleanupUnproven(error);
      if (error instanceof DomainCutoverError && error.code === "command_failed") throw error;
      throw new DomainCutoverError("deployment_readback_invalid");
    }
  }

  async readDomainNames(projectId: string): Promise<readonly string[]> {
    if (!projectIdSchema.safeParse(projectId).success) {
      throw new DomainCutoverError("command_output_invalid");
    }
    const names: string[] = [];
    const seenCursors = new Set<number>();
    let until: number | null = null;
    for (let pageIndex = 0; pageIndex < maximumDomainPages; pageIndex += 1) {
      const cursor = until === null ? "" : `&until=${until}`;
      const parsed = domainsReadbackSchema.safeParse(parseProviderJson(await this.#invoke([
        "api",
        `/v9/projects/${projectId}/domains?limit=${domainPageLimit}${cursor}`,
        "--scope",
        team,
        "--raw",
      ], "vercel-domain-list-read")));
      if (!parsed.success) throw new DomainCutoverError("command_output_invalid");
      names.push(...parsed.data.domains.map((domain) => domain.name));
      const next = parsed.data.pagination.next;
      if (next === null) return names;
      if (seenCursors.has(next)) throw new DomainCutoverError("command_output_invalid");
      seenCursors.add(next);
      until = next;
    }
    throw new DomainCutoverError("command_output_invalid");
  }

  async readMarker(aliasName: ManagedAlias): Promise<unknown> {
    this.#guard.assertMayProceed();
    if (!managedAliasSchema.safeParse(aliasName).success) {
      throw new DomainCutoverError("command_output_invalid");
    }
    const response = await this.#fetcher(
      `https://${aliasName}/.well-known/hra.json?cutover=${crypto.randomUUID()}`,
      {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
        redirect: "error",
      },
    );
    const length = response.headers.get("content-length");
    if (
      response.status !== 200
      || response.body === null
      || (length !== null && (!/^[0-9]+$/u.test(length) || Number(length) > inputMaximumBytes))
    ) throw new DomainCutoverError("command_output_invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      let result = await reader.read();
      while (!result.done) {
        bytes += result.value.byteLength;
        if (bytes > inputMaximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DomainCutoverError("command_output_invalid");
        }
        chunks.push(result.value);
        result = await reader.read();
      }
    } catch (error: unknown) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof DomainCutoverError) throw error;
      throw new DomainCutoverError("command_output_invalid");
    }
    const document = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
      .toString("utf8");
    return parseProviderJson(document);
  }

  async readProject(projectId: string): Promise<ProjectReadback> {
    if (!projectIdSchema.safeParse(projectId).success) {
      throw new DomainCutoverError("automatic_domain_assignment_unsafe");
    }
    try {
      const parsed = projectReadbackSchema.parse(parseProviderJson(await this.#invoke([
        "api",
        `/v9/projects/${projectId}`,
        "--scope",
        team,
        "--raw",
      ], "vercel-project-read")));
      if (parsed.id !== projectId) {
        throw new DomainCutoverError("automatic_domain_assignment_unsafe");
      }
      return parsed;
    } catch (error: unknown) {
      rethrowBoundedProcessCleanupUnproven(error);
      throw new DomainCutoverError("automatic_domain_assignment_unsafe");
    }
  }

  async setAlias(deploymentUrl: string, aliasName: ManagedAlias): Promise<void> {
    if (
      !deploymentUrlSchema.safeParse(deploymentUrl).success
      || !managedAliasSchema.safeParse(aliasName).success
    ) {
      throw new DomainCutoverError("usage_invalid");
    }
    await this.#invoke(
      ["alias", "set", deploymentUrl, aliasName, "--scope", team],
      "vercel-alias-set",
    );
  }

  async moveDomain(sourceProjectId: string, targetProjectId: string): Promise<void> {
    if (
      !projectIdSchema.safeParse(sourceProjectId).success
      || !projectIdSchema.safeParse(targetProjectId).success
      || sourceProjectId === targetProjectId
    ) throw new DomainCutoverError("usage_invalid");
    await this.#invoke([
      "api",
      `/v1/projects/${sourceProjectId}/domains/${canonicalAlias}/move`,
      "--scope",
      team,
      "-X",
      "POST",
      "-F",
      `projectId=${targetProjectId}`,
      "--silent",
    ], "vercel-domain-move");
  }
}

type ParsedArguments = Readonly<{
  evidencePath?: string;
  operation: "execute" | "preflight";
  planFd: number;
  previousEvidencePath?: string;
  sequence?: 1 | 2 | 3;
  vercelCli: string;
}>;

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  let operation: ParsedArguments["operation"] | undefined;
  let evidencePath: string | undefined;
  let planFd = 0;
  let previousEvidencePath: string | undefined;
  let sequence: 1 | 2 | 3 | undefined;
  let vercelCli: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--execute" && operation === undefined) {
      operation = "execute";
      continue;
    }
    if (argument === "preflight" && operation === undefined) {
      operation = "preflight";
      continue;
    }
    if (argument === "--plan-fd" && planFd === 0) {
      const value = arguments_[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw new DomainCutoverError("usage_invalid");
      }
      planFd = Number(value);
      if (!Number.isSafeInteger(planFd) || planFd < 3 || planFd > 255) {
        throw new DomainCutoverError("usage_invalid");
      }
      index += 1;
      continue;
    }
    if (argument === "--vercel-cli" && vercelCli === undefined) {
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value) || value.length > 4_096) {
        throw new DomainCutoverError("usage_invalid");
      }
      vercelCli = value;
      index += 1;
      continue;
    }
    if (argument === "--evidence-path" && evidencePath === undefined) {
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value) || value.length > 4_096) {
        throw new DomainCutoverError("usage_invalid");
      }
      evidencePath = value;
      index += 1;
      continue;
    }
    if (argument === "--previous-evidence" && previousEvidencePath === undefined) {
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value) || value.length > 4_096) {
        throw new DomainCutoverError("usage_invalid");
      }
      previousEvidencePath = value;
      index += 1;
      continue;
    }
    if (argument === "--sequence" && sequence === undefined) {
      const value = arguments_[index + 1];
      if (value !== "1" && value !== "2" && value !== "3") {
        throw new DomainCutoverError("usage_invalid");
      }
      sequence = Number(value) as 1 | 2 | 3;
      index += 1;
      continue;
    }
    throw new DomainCutoverError("usage_invalid");
  }
  if (operation === undefined || vercelCli === undefined) {
    throw new DomainCutoverError("usage_invalid");
  }
  const evidenceConfigured = evidencePath !== undefined
    || previousEvidencePath !== undefined
    || sequence !== undefined;
  if (
    operation === "preflight" && evidenceConfigured
    || evidenceConfigured && (evidencePath === undefined || sequence === undefined)
    || sequence === 1 && previousEvidencePath !== undefined
    || (sequence === 2 || sequence === 3) && previousEvidencePath === undefined
  ) throw new DomainCutoverError("usage_invalid");
  return {
    ...(evidencePath === undefined ? {} : { evidencePath }),
    operation,
    planFd,
    ...(previousEvidencePath === undefined ? {} : { previousEvidencePath }),
    ...(sequence === undefined ? {} : { sequence }),
    vercelCli,
  };
}

export async function readPlanInput(fd: number, timeoutMs = 15_000): Promise<string> {
  if (isatty(fd)) throw new DomainCutoverError("input_not_protected");
  return await new Promise<string>((resolvePromise, reject) => {
    const stream = createReadStream("", { autoClose: fd !== 0, fd });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: DomainCutoverError): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      else reject(error);
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish(new DomainCutoverError("input_timed_out"));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > inputMaximumBytes) {
        stream.destroy();
        finish(new DomainCutoverError("input_too_large"));
      } else chunks.push(chunk);
    });
    stream.once("error", () => finish(new DomainCutoverError("input_invalid")));
    stream.once("end", () => finish());
  });
}

const newEndpointForPlan = (plan: CutoverPlan): CutoverEndpoint =>
  plan.direction === "forward" ? plan.target : plan.source;

const validateCutoverEvidenceChain = (
  plan: CutoverPlan,
  sequence: 1 | 2 | 3,
  previousPath: string | undefined,
): Readonly<{ previous: CutoverEvidence | null; sourceCommit: string }> => {
  if (plan.direction === "archive") throw new DomainCutoverError("usage_invalid");
  const expectedDirection = sequence === 2 ? "reverse" : "forward";
  if (plan.direction !== expectedDirection) throw new DomainCutoverError("usage_invalid");
  const previous = previousPath === undefined ? null : parseCutoverEvidenceFile(previousPath);
  if (
    (sequence === 1 && previous !== null)
    || (sequence > 1 && (previous === null || previous.sequence !== sequence - 1))
  ) throw new DomainCutoverError("input_invalid");
  const sourceCommit = newEndpointForPlan(plan).sourceCommit;
  if (previous !== null && previous.sourceCommit !== sourceCommit) {
    throw new DomainCutoverError("input_invalid");
  }
  return { previous, sourceCommit };
};

const reserveCutoverEvidence = (
  plan: CutoverPlan,
  arguments_: ParsedArguments,
): Readonly<{
  evidencePath: string;
  planDigest: string;
  previous: CutoverEvidence | null;
  sequence: 1 | 2 | 3;
  sourceCommit: string;
}> | null => {
  if (arguments_.evidencePath === undefined || arguments_.sequence === undefined) return null;
  const chain = validateCutoverEvidenceChain(
    plan,
    arguments_.sequence,
    arguments_.previousEvidencePath,
  );
  const planDigest = canonicalDigest(plan);
  const reservation = cutoverReservationSchema.parse(withSelfDigest({
    direction: plan.direction as "forward" | "reverse",
    kind: "domain-cutover-reservation" as const,
    planDigest,
    previousDigest: chain.previous?.selfDigest ?? null,
    schemaVersion: 1 as const,
    sequence: arguments_.sequence,
    sourceCommit: chain.sourceCommit,
  }));
  const reservationPath = `${arguments_.evidencePath}.reservation`;
  try {
    const existing = readProtectedJson(reservationPath, cutoverReservationSchema, {
      recoverInterruptedPublication: true,
    });
    if (canonicalDigest(existing) !== canonicalDigest(reservation)) {
      throw new DomainCutoverError("input_invalid");
    }
  } catch (error: unknown) {
    if (error instanceof DomainCutoverError) throw error;
    if (error instanceof Error && error.message !== "evidence_not_found") throw error;
    writeProtectedJsonNoReplace(reservationPath, reservation, cutoverReservationSchema);
  }
  return {
    evidencePath: arguments_.evidencePath,
    planDigest,
    previous: chain.previous,
    sequence: arguments_.sequence,
    sourceCommit: chain.sourceCommit,
  };
};

const existingCutoverEvidence = (
  reservation: NonNullable<ReturnType<typeof reserveCutoverEvidence>>,
  plan: CutoverPlan,
): CutoverEvidence | null => {
  try {
    const evidence = parseCutoverEvidenceFile(reservation.evidencePath, {
      recoverInterruptedPublication: true,
    });
    if (
      evidence.direction !== plan.direction
      || evidence.planDigest !== reservation.planDigest
      || evidence.previousDigest !== (reservation.previous?.selfDigest ?? null)
      || evidence.sequence !== reservation.sequence
      || evidence.sourceCommit !== reservation.sourceCommit
    ) throw new DomainCutoverError("input_invalid");
    return evidence;
  } catch (error: unknown) {
    if (error instanceof DomainCutoverError) throw error;
    if (error instanceof Error && error.message === "evidence_not_found") return null;
    throw error;
  }
};

const cutoverAuthorityDigest = (
  plan: CutoverPlan,
  authority: CutoverPreflightOutcome,
): string => {
  if (
    authority.status !== "already_committed"
    || authority.nextAction !== "replay_plan_for_receipt"
    || authority.reason !== "exact_target"
  ) throw new DomainCutoverError("cutover_ambiguous");
  return canonicalDigest({
    authority,
    canonicalAlias,
    fallbackAlias,
    stagingAlias: newStagingAlias,
    target: plan.target,
  });
};

const finalizeCutoverEvidence = (
  reservation: NonNullable<ReturnType<typeof reserveCutoverEvidence>>,
  plan: CutoverPlan,
  outcome: CutoverOutcome,
  authority: CutoverPreflightOutcome,
): CutoverEvidence => {
  const finalAuthorityDigest = cutoverAuthorityDigest(plan, authority);
  const evidence = cutoverEvidenceSchema.parse(withSelfDigest({
    changed: outcome.changed,
    direction: plan.direction as "forward" | "reverse",
    finalAuthorityDigest,
    kind: "domain-cutover" as const,
    planDigest: reservation.planDigest,
    previousDigest: reservation.previous?.selfDigest ?? null,
    replayed: outcome.replayed,
    schemaVersion: 1 as const,
    sequence: reservation.sequence,
    sourceCommit: reservation.sourceCommit,
  }));
  writeProtectedJsonNoReplace(
    reservation.evidencePath,
    evidence,
    cutoverEvidenceSchema,
    { allowExactReplay: true },
  );
  return evidence;
};

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  inputDocument: string;
  runner?: VercelCommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
}>;

export async function executeDomainCutover(options: ExecuteOptions): Promise<number> {
  let evidenceRecoveryPaths: readonly string[] = [];
  try {
    const arguments_ = parseArguments(options.arguments);
    const plan = parseCutoverPlan(options.inputDocument);
    const guard = new BoundedProcessInvocationGuard();
    const provider = new VercelCutoverProvider({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      guard,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      vercelCli: arguments_.vercelCli,
    });
    await provider.verifyVersion();
    if (arguments_.operation === "preflight") {
      const outcome = await preflightCutoverPlan(plan, provider);
      options.stdout.write(`${JSON.stringify({
        direction: plan.direction,
        mode: plan.mode,
        nextAction: outcome.nextAction,
        observedOwner: outcome.observedOwner,
        observedState: outcome.observedState,
        observedTraffic: outcome.observedTraffic,
        reason: outcome.reason,
        schemaVersion: 1,
        sourceDeploymentId: plan.source.deploymentId,
        sourceProjectId: plan.source.projectId,
        status: outcome.status,
        targetDeploymentId: plan.target.deploymentId,
        targetProjectId: plan.target.projectId,
      })}\n`);
      return outcome.status === "blocked" ? 1 : 0;
    }
    const reservation = reserveCutoverEvidence(plan, arguments_);
    if (reservation !== null) {
      evidenceRecoveryPaths = [
        reservation.evidencePath,
        `${reservation.evidencePath}.reservation`,
      ];
      for (const path of evidenceRecoveryPaths) guard.retainRecoveryPath(path);
      const existing = existingCutoverEvidence(reservation, plan);
      if (existing !== null) {
        const authority = await preflightCutoverPlan(plan, provider);
        if (cutoverAuthorityDigest(plan, authority) !== existing.finalAuthorityDigest) {
          throw new DomainCutoverError("cutover_ambiguous");
        }
        options.stdout.write(`${JSON.stringify({
          changed: existing.changed,
          direction: plan.direction,
          evidenceDigest: existing.selfDigest,
          evidencePath: reservation.evidencePath,
          replayed: true,
          schemaVersion: 1,
          status: "committed",
          targetDeploymentId: plan.target.deploymentId,
          targetProjectId: plan.target.projectId,
        })}\n`);
        return 0;
      }
    }
    const outcome = await executeCutoverPlan(plan, provider);
    const evidence = reservation === null
      ? undefined
      : finalizeCutoverEvidence(
          reservation,
          plan,
          outcome,
          await preflightCutoverPlan(plan, provider),
        );
    options.stdout.write(`${JSON.stringify({
      changed: outcome.changed,
      direction: plan.direction,
      ...(evidence === undefined ? {} : {
        evidenceDigest: evidence.selfDigest,
        evidencePath: reservation?.evidencePath,
      }),
      replayed: outcome.replayed,
      schemaVersion: 1,
      status: "committed",
      targetDeploymentId: plan.target.deploymentId,
      targetProjectId: plan.target.projectId,
    })}\n`);
    return 0;
  } catch (caught: unknown) {
    let error = caught;
    if (isBoundedProcessCleanupUnprovenError(error)) {
      for (const path of evidenceRecoveryPaths) error.retainRecoveryPath(path);
    } else if (isBoundedProcessRecoveryJournalError(error) && evidenceRecoveryPaths.length > 0) {
      for (const path of evidenceRecoveryPaths) {
        error = retainBoundedProcessRecoveryPath(error, path);
      }
    }
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      options.stderr.write(authorityUnavailable);
      return 1;
    }
    const cleanup = isBoundedProcessCleanupUnprovenError(error) ? error : undefined;
    const journal = isBoundedProcessRecoveryJournalError(error) ? error : undefined;
    const code = error instanceof DomainCutoverError
      ? error.code
      : cleanup === undefined && journal === undefined
        ? "input_invalid"
        : cleanup !== undefined
          ? "process_cleanup_unproven"
          : "process_recovery_journal_blocked";
    options.stderr.write(`${JSON.stringify({
      code,
      ...(cleanup === undefined ? {} : {
        phase: cleanup.phase,
        processGroupId: cleanup.processGroupId,
        processes: cleanup.processes,
        recoveryPaths: cleanup.recoveryPaths,
      }),
      ...(journal === undefined ? {} : {
        reason: journal.reason,
        recoveryPaths: journal.recoveryPaths,
      }),
      schemaVersion: 1,
      status: cleanup === undefined && journal === undefined ? "refused" : "recovery_required",
    })}\n`);
    return cleanup === undefined && journal === undefined ? 1 : 75;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    try {
      await recoverBoundedProcessJournal();
    } catch (error: unknown) {
      let retained = error;
      if (arguments_.evidencePath !== undefined) {
        retained = retainBoundedProcessRecoveryPath(retained, arguments_.evidencePath);
        retained = retainBoundedProcessRecoveryPath(
          retained,
          `${arguments_.evidencePath}.reservation`,
        );
      }
      throw retained;
    }
    const inputDocument = await readPlanInput(arguments_.planFd);
    exitCode = await executeDomainCutover({
      arguments: process.argv.slice(2),
      inputDocument,
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      process.stderr.write(authorityUnavailable);
      exitCode = 1;
    } else {
      const cleanup = isBoundedProcessCleanupUnprovenError(error) ? error : undefined;
      const journal = isBoundedProcessRecoveryJournalError(error) ? error : undefined;
      const code = error instanceof DomainCutoverError
        ? error.code
        : cleanup === undefined && journal === undefined
          ? "input_invalid"
          : cleanup !== undefined
            ? "process_cleanup_unproven"
            : "process_recovery_journal_blocked";
      process.stderr.write(`${JSON.stringify({
        code,
        ...(cleanup === undefined ? {} : {
          phase: cleanup.phase,
          processGroupId: cleanup.processGroupId,
          processes: cleanup.processes,
          recoveryPaths: cleanup.recoveryPaths,
        }),
        ...(journal === undefined ? {} : {
          reason: journal.reason,
          recoveryPaths: journal.recoveryPaths,
        }),
        schemaVersion: 1,
        status: cleanup === undefined && journal === undefined ? "refused" : "recovery_required",
      })}\n`);
      if (cleanup === undefined && journal === undefined) exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}
