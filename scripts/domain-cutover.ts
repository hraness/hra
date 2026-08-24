import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { isatty } from "node:tty";

import { z } from "zod";

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
  const expectedGeneration = endpoint.projectId === oldProjectId ? 0 : 1;
  if (endpoint.repositoryId !== expectedRepository) {
    context.addIssue({ code: "custom", message: "repository_project_mismatch" });
  }
  if (endpoint.generation !== null && endpoint.generation !== expectedGeneration) {
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

const markerRepositorySchema = z.object({
  id: z.number().int().positive(),
  path: z.string().min(1).max(200),
}).strict();
const markerSourceSchema = z.object({ commit: commitSchema }).strict();
const markerSchema = z.discriminatedUnion("generation", [
  z.object({
    generation: z.literal(0),
    product: z.literal("HRA"),
    publication: z.object({ version: versionSchema }).passthrough(),
    repository: markerRepositorySchema,
    schemaVersion: z.literal(2),
    source: markerSourceSchema,
  }).strict(),
  z.object({
    generation: z.literal(1),
    product: z.literal("HRA"),
    repository: markerRepositorySchema,
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

type StateClassification = Readonly<{
  owner: DomainOwner;
  state: CutoverState;
  traffic: TrafficState;
}>;

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
    ? parsed.data.generation === 0
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
  const [sourceNames, targetNames] = await Promise.all([
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
  } catch {
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
    const [canonical, fallback, staging] = await Promise.all([
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
  const [canonical, fallback] = await Promise.all([
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
): Promise<StateClassification> => {
  const ownerExpectation = stateExpectation(plan, "source").owner;
  try {
    const [traffic, owner] = await Promise.all([
      readTrafficState(provider, plan),
      readOwnerSafely(
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
  } catch {
    return { owner: "ambiguous", state: "ambiguous", traffic: "ambiguous" };
  }
};

const classifyCutoverState = async (
  provider: CutoverProvider,
  plan: CutoverPlan,
  clock: CutoverClock,
  timeoutMs: number,
): Promise<StateClassification> => {
  const deadline = clock.now() + timeoutMs;
  let latest: StateClassification = {
    owner: "ambiguous",
    state: "ambiguous",
    traffic: "ambiguous",
  };
  do {
    latest = await readStateClassification(provider, plan);
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
  const aliases = await Promise.all(
    expectation.aliases.map(async ({ aliasName, endpoint }) => {
      const [aliasValue, markerValue] = await Promise.all([
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
  const [traffic, owner] = await Promise.all([
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
    } catch {
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
): Promise<boolean> => {
  const deadline = clock.now() + timeoutMs;
  do {
    try {
      if (await readExactState(provider, expectation)) return true;
    } catch {
      // A provider or public read can be transient inside the bounded window.
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
      const [aliasValue, markerValue] = await Promise.all([
        provider.readAlias(aliasName),
        endpoint.generation === null ? Promise.resolve(null) : provider.readMarker(aliasName),
      ]);
      if (
        aliasMatches(aliasValue, endpoint, aliasName)
        && markerMatches(markerValue, endpoint)
      ) {
        return true;
      }
    } catch {
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
  } catch {
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
    } catch {
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
  } catch {
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

  const projects = await Promise.all([
    provider.readProject(oldProjectId),
    provider.readProject(newProjectId),
  ]).catch(() => {
    throw new DomainCutoverError("automatic_domain_assignment_unsafe");
  });
  const expectedProjects = [oldProjectId, newProjectId] as const;
  if (projects.some((project, index) => {
    const parsed = projectReadbackSchema.safeParse(project);
    return !parsed.success
      || parsed.data.id !== expectedProjects[index]
      || parsed.data.autoAssignCustomDomains;
  })) throw new DomainCutoverError("automatic_domain_assignment_unsafe");

  const [sourceDeployment, targetDeployment] = await Promise.all([
    provider.readDeployment(plan.source.deploymentId),
    provider.readDeployment(plan.target.deploymentId),
  ]).catch(() => {
    throw new DomainCutoverError("deployment_readback_invalid");
  });
  if (
    !deploymentMatches(sourceDeployment, plan.source)
    || !deploymentMatches(targetDeployment, plan.target)
  ) throw new DomainCutoverError("deployment_readback_invalid");

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
    } catch {
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
  } catch {
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
  } catch {
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
  environment: Readonly<Record<string, string>>;
  executable: string;
}>;

export type VercelCommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

export type VercelCommandRunner = (
  request: VercelCommandRequest,
) => Promise<VercelCommandResult>;

const appendBounded = (
  chunks: Buffer[],
  chunk: Buffer,
  state: { bytes: number; overflow: boolean },
): void => {
  state.bytes += chunk.byteLength;
  if (state.bytes <= outputMaximumBytes) chunks.push(chunk);
  else state.overflow = true;
};

export const runVercelCommand: VercelCommandRunner = async (request) =>
  await new Promise<VercelCommandResult>((resolvePromise) => {
    const child = spawn(request.executable, [...request.arguments], {
      env: request.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { bytes: 0, overflow: false };
    const stderrState = { bytes: 0, overflow: false };
    let finished = false;
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: stdoutState.overflow || stderrState.overflow ? 1 : exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, commandTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      appendBounded(stdoutChunks, chunk, stdoutState);
      if (stdoutState.overflow) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      appendBounded(stderrChunks, chunk, stderrState);
      if (stderrState.overflow) child.kill("SIGKILL");
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
  });

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
  runner?: VercelCommandRunner;
  vercelCli: string;
}>;

export class VercelCutoverProvider implements CutoverProvider {
  readonly #environment: Readonly<Record<string, string>>;
  readonly #fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #runner: VercelCommandRunner;
  readonly #vercelCli: string;

  constructor(options: VercelProviderOptions) {
    if (!isAbsolute(options.vercelCli)) throw new DomainCutoverError("usage_invalid");
    this.#environment = buildVercelEnvironment(options.environment ?? process.env);
    this.#fetcher = options.fetcher ?? fetch;
    this.#runner = options.runner ?? runVercelCommand;
    this.#vercelCli = options.vercelCli;
  }

  async #invoke(arguments_: readonly string[]): Promise<string> {
    const result = await this.#runner({
      arguments: arguments_,
      environment: this.#environment,
      executable: this.#vercelCli,
    });
    if (result.exitCode !== 0) throw new DomainCutoverError("command_failed");
    return result.stdout;
  }

  async verifyVersion(): Promise<void> {
    const version = (await this.#invoke(["--version"])).trim();
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
      ])));
      if (parsed.alias !== aliasName) throw new DomainCutoverError("alias_readback_invalid");
      return parsed;
    } catch (error: unknown) {
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
      ])));
    } catch (error: unknown) {
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
      ])));
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
    if (!managedAliasSchema.safeParse(aliasName).success) {
      throw new DomainCutoverError("command_output_invalid");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await this.#fetcher(
        `https://${aliasName}/.well-known/hra.json?cutover=${crypto.randomUUID()}`,
        {
          cache: "no-store",
          headers: { "cache-control": "no-cache" },
          redirect: "error",
          signal: controller.signal,
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
            controller.abort();
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
    } finally {
      clearTimeout(timeout);
    }
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
      ])));
      if (parsed.id !== projectId) {
        throw new DomainCutoverError("automatic_domain_assignment_unsafe");
      }
      return parsed;
    } catch {
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
    await this.#invoke(["alias", "set", deploymentUrl, aliasName, "--scope", team]);
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
    ]);
  }
}

type ParsedArguments = Readonly<{ execute: true; planFd: number; vercelCli: string }>;

export function parseArguments(arguments_: readonly string[]): ParsedArguments {
  let execute = false;
  let planFd = 0;
  let vercelCli: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--execute" && !execute) {
      execute = true;
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
    throw new DomainCutoverError("usage_invalid");
  }
  if (!execute || vercelCli === undefined) throw new DomainCutoverError("usage_invalid");
  return { execute: true, planFd, vercelCli };
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
  try {
    const arguments_ = parseArguments(options.arguments);
    const plan = parseCutoverPlan(options.inputDocument);
    const provider = new VercelCutoverProvider({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      vercelCli: arguments_.vercelCli,
    });
    await provider.verifyVersion();
    const outcome = await executeCutoverPlan(plan, provider);
    options.stdout.write(`${JSON.stringify({
      changed: outcome.changed,
      direction: plan.direction,
      replayed: outcome.replayed,
      schemaVersion: 1,
      status: "committed",
      targetDeploymentId: plan.target.deploymentId,
      targetProjectId: plan.target.projectId,
    })}\n`);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof DomainCutoverError ? error.code : "input_invalid";
    options.stderr.write(`${JSON.stringify({ code, schemaVersion: 1, status: "refused" })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 1;
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    const inputDocument = await readPlanInput(arguments_.planFd);
    exitCode = await executeDomainCutover({
      arguments: process.argv.slice(2),
      inputDocument,
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const code = error instanceof DomainCutoverError ? error.code : "input_invalid";
    process.stderr.write(`${JSON.stringify({ code, schemaVersion: 1, status: "refused" })}\n`);
  }
  process.exitCode = exitCode;
}
