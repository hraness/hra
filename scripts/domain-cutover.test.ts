import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildVercelEnvironment,
  DomainCutoverError,
  executeCutoverPlan,
  executeDomainCutover,
  parseArguments,
  parseCutoverPlan,
  VercelCutoverProvider,
  type AliasReadback,
  type CutoverEndpoint,
  type CutoverPlan,
  type CutoverProvider,
  type DeploymentReadback,
  type ManagedAlias,
  type ProjectReadback,
  type VercelCommandRequest,
  type VercelCommandRunner,
} from "./domain-cutover";

const oldProjectId = "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
const newProjectId = "prj_8ciIt9t9foE3utG45frRN7cxckjS";
const oldRepositoryId = 1_334_876_494;
const newRepositoryId = 1_343_008_607;
const teamId = "team_UAd1iD2XogJlbFg4h14mRaPM";
const canonicalAlias = "hra.sh";
const fallbackAlias = "hra-weld.vercel.app";
const newStagingAlias = "try-hra.vercel.app";

const oldEndpoint: CutoverEndpoint = {
  deploymentId: "dpl_ArchiveAccepted1234567890",
  deploymentUrl: "hra-v0-accepted-hraness.vercel.app",
  generation: 0,
  projectId: oldProjectId,
  repositoryId: oldRepositoryId,
  sourceCommit: "1111111111111111111111111111111111111111",
  version: "0.1.14",
};

const newEndpoint: CutoverEndpoint = {
  deploymentId: "dpl_NewAccepted1234567890123",
  deploymentUrl: "hra-new-accepted-hraness.vercel.app",
  generation: 1,
  projectId: newProjectId,
  repositoryId: newRepositoryId,
  sourceCommit: "2222222222222222222222222222222222222222",
  version: "0.1.0",
};

const forwardPlan: CutoverPlan = {
  direction: "forward",
  mode: "domain",
  schemaVersion: 1,
  source: oldEndpoint,
  target: newEndpoint,
};

const reversePlan: CutoverPlan = {
  direction: "reverse",
  mode: "domain",
  schemaVersion: 1,
  source: newEndpoint,
  target: oldEndpoint,
};

const baselineEndpoint: CutoverEndpoint = {
  ...oldEndpoint,
  deploymentId: "dpl_BaselineAccepted123456789",
  deploymentUrl: "hra-baseline-hraness.vercel.app",
  generation: null,
  sourceCommit: "6221f79b745f154882080936b961ff431569f33e",
};

const archivePlan: CutoverPlan = {
  direction: "archive",
  mode: "traffic-only",
  schemaVersion: 1,
  source: baselineEndpoint,
  target: oldEndpoint,
};

const deploymentFor = (endpoint: CutoverEndpoint): DeploymentReadback => ({
  gitSource: {
    ref: "main",
    repoId: endpoint.repositoryId,
    sha: endpoint.sourceCommit,
    type: "github",
  },
  id: endpoint.deploymentId,
  projectId: endpoint.projectId,
  readyState: "READY",
  url: endpoint.deploymentUrl,
});

const aliasFor = (
  endpoint: CutoverEndpoint,
  aliasName: ManagedAlias = canonicalAlias,
): AliasReadback => ({
  alias: aliasName,
  deployment: { id: endpoint.deploymentId, url: endpoint.deploymentUrl },
  deploymentId: endpoint.deploymentId,
  projectId: endpoint.projectId,
});

const projectFor = (
  projectId: typeof oldProjectId | typeof newProjectId,
): ProjectReadback => ({
  accountId: teamId,
  autoAssignCustomDomains: false,
  id: projectId,
});

const markerFor = (endpoint: CutoverEndpoint): unknown => {
  const shared = {
    generation: endpoint.generation,
    product: "HRA",
    repository: {
      id: endpoint.repositoryId,
      path: endpoint.projectId === oldProjectId ? "hraness/hra-v0" : "hraness/hra",
    },
    schemaVersion: 2,
    source: { commit: endpoint.sourceCommit },
  };
  return endpoint.generation === 0
    ? {
        ...shared,
        publication: {
          build: 15,
          dmgSha256: "7ff49500de3d1fc768c17454ef7642c51f6662dfa5bf0e2ba183a85bb67fcd03",
          publicationCommit: "6221f79b745f154882080936b961ff431569f33e",
          releaseId: 374_980_441,
          sourceCommit: "7b39c459827b2acf45aa2d911c94fdb5d4f37860",
          tag: "v0.1.14",
          tagObject: "37ed37afb39cacfd6a51044cf7f3c1b873571aa3",
          version: endpoint.version,
        },
      }
    : { ...shared, version: endpoint.version };
};

const domainPage = (
  names: readonly string[],
  next: number | null = null,
  prev: number | null = null,
): unknown => ({
  domains: names.map((name) => ({ name })),
  pagination: { count: names.length, next, prev },
});

type MoveBehavior = "ambiguous" | "commit" | "commit-and-throw" | "move-and-source-alias" | "noop";

class FakeCutoverProvider implements CutoverProvider {
  readonly aliasEndpoints: Record<ManagedAlias, CutoverEndpoint>;
  driftAfterAliasRead: Readonly<{
    aliasName: ManagedAlias;
    endpoint: CutoverEndpoint;
    remainingMatches?: number;
    triggerAlias: ManagedAlias;
    triggerEndpoint: CutoverEndpoint;
  }> | undefined;
  driftAfterMarkerRead: Readonly<{
    aliasName: ManagedAlias;
    endpoint: CutoverEndpoint;
    remainingMatches?: number;
    triggerAlias: ManagedAlias;
    triggerEndpoint: CutoverEndpoint;
  }> | undefined;
  readonly markerBrokenAliases = new Set<ManagedAlias>();
  markerBrokenForTargetAlias: ManagedAlias | undefined;
  markerOverrideForTargetAlias: Readonly<{ alias: ManagedAlias; value: unknown }> | undefined;
  moveBehavior: MoveBehavior = "commit";
  owner: "ambiguous" | "source" | "target" = "source";
  ownerReadOverride: "ambiguous" | "source" | "target" | undefined;
  ownerReadOverrideDomainReads = 0;
  readonly ownerReadOverrides: Array<"ambiguous" | "source" | "target"> = [];
  ownerAfterTargetAliasSet: Readonly<{
    alias: ManagedAlias;
    owner: "ambiguous" | "source" | "target";
  }> | undefined;
  reverseMoveAliasPerturbation: Readonly<{
    aliasName: ManagedAlias;
    endpoint: CutoverEndpoint;
  }> | undefined;
  reverseMoveCommitAndThrow = false;
  reverseMoveStaleDomainReads = 0;
  sourceAliasSetFailure: ManagedAlias | undefined;
  staleOwnerDomainReads = 0;
  targetAliasSetFailure: ManagedAlias | undefined;
  readonly operations: string[] = [];
  readonly plan: CutoverPlan;
  readonly projectReadbacks: Record<string, unknown> = {
    [newProjectId]: projectFor(newProjectId),
    [oldProjectId]: projectFor(oldProjectId),
  };

  constructor(plan: CutoverPlan) {
    this.plan = plan;
    const acceptedArchive = plan.direction === "forward" ? plan.source : plan.target;
    const acceptedNew = plan.direction === "forward" ? plan.target : plan.source;
    this.aliasEndpoints = {
      [canonicalAlias]: plan.source,
      [fallbackAlias]: plan.direction === "archive" ? plan.source : acceptedArchive,
      [newStagingAlias]: plan.direction === "archive" ? plan.target : acceptedNew,
    };
  }

  get aliasEndpoint(): CutoverEndpoint {
    return this.aliasEndpoints[canonicalAlias];
  }

  get fallbackAliasEndpoint(): CutoverEndpoint {
    return this.aliasEndpoints[fallbackAlias];
  }

  async readAlias(aliasName: ManagedAlias): Promise<AliasReadback> {
    const endpoint = this.aliasEndpoints[aliasName];
    this.operations.push(`read-alias:${aliasName}:${endpoint.deploymentId}`);
    const value = aliasFor(endpoint, aliasName);
    const drift = this.driftAfterAliasRead;
    if (
      drift !== undefined
      && drift.triggerAlias === aliasName
      && drift.triggerEndpoint === endpoint
    ) {
      const remainingMatches = drift.remainingMatches ?? 1;
      if (remainingMatches === 1) {
        this.driftAfterAliasRead = undefined;
        this.aliasEndpoints[drift.aliasName] = drift.endpoint;
        this.operations.push(
          `drift-alias:${drift.aliasName}:${drift.endpoint.deploymentUrl}`,
        );
      } else {
        this.driftAfterAliasRead = { ...drift, remainingMatches: remainingMatches - 1 };
      }
    }
    return value;
  }

  async readDeployment(deploymentId: string): Promise<DeploymentReadback> {
    this.operations.push(`read-deployment:${deploymentId}`);
    const endpoint = [this.plan.source, this.plan.target]
      .find((candidate) => candidate.deploymentId === deploymentId);
    if (endpoint === undefined) throw new Error("unknown deployment");
    return deploymentFor(endpoint);
  }

  async readDomainNames(projectId: string): Promise<readonly string[]> {
    this.operations.push(`read-domains:${projectId}`);
    if (this.ownerReadOverrideDomainReads === 0 && this.ownerReadOverrides.length > 0) {
      this.ownerReadOverride = this.ownerReadOverrides.shift();
      this.ownerReadOverrideDomainReads = 2;
    }
    const owner = this.ownerReadOverride
      ?? (this.staleOwnerDomainReads > 0 ? "target" : this.owner);
    if (this.ownerReadOverrideDomainReads > 0) {
      this.ownerReadOverrideDomainReads -= 1;
      if (this.ownerReadOverrideDomainReads === 0) this.ownerReadOverride = undefined;
    } else if (this.staleOwnerDomainReads > 0) this.staleOwnerDomainReads -= 1;
    if (owner === "ambiguous") return ["hra.sh"];
    const sourceProjectId = this.plan.direction === "archive"
      ? oldProjectId
      : this.plan.source.projectId;
    const targetProjectId = this.plan.direction === "archive"
      ? newProjectId
      : this.plan.target.projectId;
    if (owner === "source") {
      return projectId === sourceProjectId ? ["hra.sh"] : [];
    }
    return projectId === targetProjectId ? ["hra.sh"] : [];
  }

  async readMarker(aliasName: ManagedAlias): Promise<unknown> {
    const endpoint = this.aliasEndpoints[aliasName];
    this.operations.push(`read-marker:${aliasName}:${endpoint.deploymentId}`);
    let value: unknown;
    if (
      this.markerOverrideForTargetAlias?.alias === aliasName
      && endpoint === this.plan.target
    ) value = this.markerOverrideForTargetAlias.value;
    else if (
      this.markerBrokenAliases.has(aliasName)
      || (this.markerBrokenForTargetAlias === aliasName && endpoint === this.plan.target)
    ) {
      value = { ...markerFor(endpoint) as object, source: { commit: "0".repeat(40) } };
    } else value = markerFor(endpoint);
    const drift = this.driftAfterMarkerRead;
    if (
      drift !== undefined
      && drift.triggerAlias === aliasName
      && drift.triggerEndpoint === endpoint
    ) {
      const remainingMatches = drift.remainingMatches ?? 1;
      if (remainingMatches === 1) {
        this.driftAfterMarkerRead = undefined;
        this.aliasEndpoints[drift.aliasName] = drift.endpoint;
        this.operations.push(
          `drift-alias:${drift.aliasName}:${drift.endpoint.deploymentUrl}`,
        );
      } else {
        this.driftAfterMarkerRead = { ...drift, remainingMatches: remainingMatches - 1 };
      }
    }
    return value;
  }

  async readProject(projectId: string): Promise<ProjectReadback> {
    this.operations.push(`read-project:${projectId}`);
    const value = this.projectReadbacks[projectId];
    if (value === undefined) throw new Error("unknown project");
    return value as ProjectReadback;
  }

  async setAlias(deploymentUrl: string, aliasName: ManagedAlias): Promise<void> {
    this.operations.push(`set-alias:${aliasName}:${deploymentUrl}`);
    const endpoint = [this.plan.source, this.plan.target]
      .find((candidate) => candidate.deploymentUrl === deploymentUrl);
    if (endpoint === undefined) throw new Error("unknown alias target");
    if (this.sourceAliasSetFailure === aliasName && endpoint === this.plan.source) {
      throw new Error("alias restoration failed");
    }
    if (this.targetAliasSetFailure === aliasName && endpoint === this.plan.target) {
      this.targetAliasSetFailure = undefined;
      this.aliasEndpoints[aliasName] = endpoint;
      throw new Error("ambiguous alias mutation");
    }
    this.aliasEndpoints[aliasName] = endpoint;
    if (
      endpoint === this.plan.target
      && this.ownerAfterTargetAliasSet?.alias === aliasName
    ) this.owner = this.ownerAfterTargetAliasSet.owner;
  }

  async moveDomain(sourceProjectId: string, targetProjectId: string): Promise<void> {
    this.operations.push(`move:${sourceProjectId}->${targetProjectId}`);
    if (
      sourceProjectId === this.plan.target.projectId
      && targetProjectId === this.plan.source.projectId
    ) {
      this.owner = "source";
      this.staleOwnerDomainReads = this.reverseMoveStaleDomainReads;
      const perturbation = this.reverseMoveAliasPerturbation;
      if (perturbation !== undefined) {
        this.aliasEndpoints[perturbation.aliasName] = perturbation.endpoint;
        this.operations.push(
          `perturb-alias:${perturbation.aliasName}:${perturbation.endpoint.deploymentUrl}`,
        );
      }
      if (this.reverseMoveCommitAndThrow) throw new Error("lost reverse move response");
      return;
    }
    if (this.moveBehavior === "commit" || this.moveBehavior === "commit-and-throw") {
      this.owner = "target";
    }
    if (this.moveBehavior === "ambiguous") this.owner = "ambiguous";
    if (this.moveBehavior === "move-and-source-alias") {
      this.owner = "target";
      this.aliasEndpoints[canonicalAlias] = this.plan.source;
    }
    if (this.moveBehavior === "commit-and-throw") throw new Error("lost move response");
  }
}

const placeAtTarget = (provider: FakeCutoverProvider): void => {
  provider.aliasEndpoints[canonicalAlias] = provider.plan.target;
  if (provider.plan.direction === "archive") {
    provider.aliasEndpoints[fallbackAlias] = provider.plan.target;
    provider.owner = "source";
  } else {
    provider.owner = "target";
  }
};

const immediateClock = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

describe("domain cutover runbook", () => {
  test("pins numeric identities and traffic-first moves in both directions", async () => {
    const runbook = await readFile(
      join(import.meta.dir, "..", "docs", "domain-cutover.md"),
      "utf8",
    );

    expect(runbook).toContain("prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr");
    expect(runbook).toContain("prj_8ciIt9t9foE3utG45frRN7cxckjS");
    expect(runbook).toContain("team_UAd1iD2XogJlbFg4h14mRaPM");
    expect(runbook).toContain("dpl_AmtYwx5XmgziAxGtNFMMKLGMnXUw");
    expect(runbook).toContain("hra-1o6bv6wbl-hraness.vercel.app");
    expect(runbook).toContain("<deployment-id>");
    expect(runbook).toContain("<bare-automatic-hostname>.vercel.app");
    expect(runbook).toContain("hosted:domain-cutover");
    expect(runbook).toContain("/v4/aliases/hra.sh");
    expect(runbook).toContain("deploymentId");
    expect(runbook).toContain("source.commit");
    expect(runbook).toContain(
      "/v1/projects/prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr/domains/hra.sh/move",
    );
    expect(runbook).toContain(
      "/v1/projects/prj_8ciIt9t9foE3utG45frRN7cxckjS/domains/hra.sh/move",
    );
    expect(runbook).toContain("https://www.hra.sh");
    expect(runbook).toContain(".well-known/hra.json");
    expect(runbook).toContain("autoAssignCustomDomains=false");
    expect(runbook).toContain("{id,accountId,autoAssignCustomDomains}");
    expect(runbook).toContain("--prod --skip-domain");
    expect(runbook).toContain("vercel curl / --deployment <deployment-id>");
    expect(runbook).toContain("publication.version");
    expect(runbook).toContain("top-level `version`");
    expect(runbook).not.toContain("vercel curl / --deployment <deployment-id> --scope");
    expect(runbook).toContain("/v4/aliases/hra-weld.vercel.app");
    expect(runbook).toContain("/v4/aliases/try-hra.vercel.app");
    expect(runbook).toContain("https://try-hra.vercel.app");
    expect(runbook).not.toContain("--protection-bypass");
  });

  test("does not prescribe detach-first or force-based movement", async () => {
    const runbook = await readFile(
      join(import.meta.dir, "..", "docs", "domain-cutover.md"),
      "utf8",
    );
    const commands = runbook.split("\n").filter((line) => line.startsWith("vercel "));

    expect(commands.some((line) => line.includes("domains rm"))).toBe(false);
    expect(commands.some((line) => line.includes("domains add"))).toBe(false);
    expect(commands.some((line) => line.includes("--force"))).toBe(false);
    expect(runbook).toContain("60 seconds");
    expect(runbook).toContain("automatic restoration");
    expect(runbook).toContain("alias target, domain source");
    expect(runbook).toContain("alias source, domain target");
  });
});

describe("domain cutover operator", () => {
  test("requires both fixed projects to disable automatic domains before switching traffic", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    const outcome = await executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });

    expect(outcome).toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("target");
    const aliasMutation = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    const domainMutation = provider.operations.indexOf(`move:${oldProjectId}->${newProjectId}`);
    expect(aliasMutation).toBeGreaterThan(-1);
    expect(domainMutation).toBeGreaterThan(aliasMutation);
    expect(provider.operations.indexOf(
      `read-marker:${newStagingAlias}:${newEndpoint.deploymentId}`,
    )).toBeLessThan(aliasMutation);
    expect(provider.operations.slice(0, 2)).toEqual([
      `read-project:${oldProjectId}`,
      `read-project:${newProjectId}`,
    ]);
    expect(provider.operations.slice(2, 4).sort()).toEqual([
      `read-deployment:${newEndpoint.deploymentId}`,
      `read-deployment:${oldEndpoint.deploymentId}`,
    ].sort());
    expect(provider.operations.filter((operation) => operation === (
      `read-marker:${newStagingAlias}:${newEndpoint.deploymentId}`
    ))).toHaveLength(2);
    expect(provider.operations.at(-1)).toBe(`read-domains:${newProjectId}`);
  });

  for (const scenario of [
    { description: "archive", plan: archivePlan },
    { description: "forward", plan: forwardPlan },
    { description: "reverse", plan: reversePlan },
  ] as const) {
    test(`accepts an already-committed ${scenario.description} plan without mutations`, async () => {
      const provider = new FakeCutoverProvider(scenario.plan);
      placeAtTarget(provider);

      const outcome = await executeCutoverPlan(scenario.plan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      });

      expect(outcome).toEqual({ changed: false, replayed: true });
      expect(provider.operations.some((operation) => (
        operation.startsWith("set-alias:") || operation.startsWith("move:")
      ))).toBe(false);
      expect(provider.operations).toContain(`read-domains:${oldProjectId}`);
      expect(provider.operations).toContain(`read-domains:${newProjectId}`);
      expect(provider.operations).toContain(
        `read-marker:${canonicalAlias}:${scenario.plan.target.deploymentId}`,
      );
      if (scenario.plan.mode === "domain") {
        expect(provider.operations).toContain(
          `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
        );
        expect(provider.operations).toContain(
          `read-marker:${newStagingAlias}:${newEndpoint.deploymentId}`,
        );
      } else {
        expect(provider.operations).toContain(
          `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
        );
      }
    });
  }

  for (const scenario of [
    {
      canonical: baselineEndpoint,
      description: "fallback changed first",
      fallback: oldEndpoint,
    },
    {
      canonical: oldEndpoint,
      description: "canonical changed without fallback",
      fallback: baselineEndpoint,
    },
  ] as const) {
    test(`restores an archive mutation-boundary partial state when ${scenario.description}`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.aliasEndpoints[canonicalAlias] = scenario.canonical;
      provider.aliasEndpoints[fallbackAlias] = scenario.fallback;

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_reverted" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.owner).toBe("source");
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  for (const owner of ["target", "ambiguous"] as const) {
    test(`refuses an archive source state when domain ownership is ${owner}`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.owner = owner;

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_ambiguous" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.operations.some((operation) => (
        operation.startsWith("set-alias:") || operation.startsWith("move:")
      ))).toBe(false);
    });

    test(`restores archive target traffic but escalates ${owner} domain ownership`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      placeAtTarget(provider);
      provider.owner = owner;

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_ambiguous" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  for (const owner of ["target", "ambiguous"] as const) {
    test(`stops archive before canonical mutation when ownership becomes ${owner}`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.ownerAfterTargetAliasSet = { alias: fallbackAlias, owner };

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_ambiguous" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.operations).not.toContain(
        `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
      );
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  for (const plan of [forwardPlan, reversePlan] as const) {
    test(`classifies ${plan.direction} target traffic with every ownership state`, async () => {
      for (const owner of ["source", "target", "ambiguous"] as const) {
        const provider = new FakeCutoverProvider(plan);
        provider.aliasEndpoints[canonicalAlias] = plan.target;
        provider.owner = owner;

        if (owner === "target") {
          await expect(executeCutoverPlan(plan, provider, {
            clock: immediateClock(),
            convergenceTimeoutMs: 2,
          })).resolves.toEqual({ changed: false, replayed: true });
          expect(provider.aliasEndpoint).toBe(plan.target);
          expect(provider.operations.some((operation) => (
            operation.startsWith("set-alias:") || operation.startsWith("move:")
          ))).toBe(false);
        } else {
          await expect(executeCutoverPlan(plan, provider, {
            clock: immediateClock(),
            convergenceTimeoutMs: 2,
          })).rejects.toMatchObject({
            code: owner === "source" ? "cutover_reverted" : "cutover_ambiguous",
          });
          expect(provider.aliasEndpoint).toBe(plan.source);
          expect(provider.owner).toBe(owner);
        }
      }
    });
  }

  for (const aliasName of [fallbackAlias, newStagingAlias] as const) {
    test(`never accepts target replay with a broken ${aliasName} marker`, async () => {
      const provider = new FakeCutoverProvider(forwardPlan);
      placeAtTarget(provider);
      provider.markerBrokenAliases.add(aliasName);

      await expect(executeCutoverPlan(forwardPlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "compensation_failed" });

      expect(provider.aliasEndpoint).toBe(oldEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
      expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
      expect(provider.owner).toBe("target");
      expect(provider.operations).toContain(
        `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
      );
      expect(provider.operations).toContain(
        `set-alias:${newStagingAlias}:${newEndpoint.deploymentUrl}`,
      );
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  test("recovers a lost domain-move response and makes the next retry read-only", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "commit-and-throw";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).resolves.toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("target");

    provider.operations.length = 0;
    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).resolves.toEqual({ changed: false, replayed: true });
    expect(provider.operations.some((operation) => (
      operation.startsWith("set-alias:") || operation.startsWith("move:")
    ))).toBe(false);
  });

  test("restores a lost canonical-alias response and lets the retry start from exact source", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.targetAliasSetFailure = canonicalAlias;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.owner).toBe("source");

    provider.operations.length = 0;
    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).resolves.toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("target");
  });

  const unsafeProjectReadbacks = [
    {
      description: "old project reports true",
      projectId: oldProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: true, id: oldProjectId },
    },
    {
      description: "new project reports true",
      projectId: newProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: true, id: newProjectId },
    },
    {
      description: "old project omits autoAssignCustomDomains",
      projectId: oldProjectId,
      value: { accountId: teamId, id: oldProjectId },
    },
    {
      description: "new project omits autoAssignCustomDomains",
      projectId: newProjectId,
      value: { accountId: teamId, id: newProjectId },
    },
    {
      description: "old-project query returns the new project identity",
      projectId: oldProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: false, id: newProjectId },
    },
    {
      description: "new-project query returns the old project identity",
      projectId: newProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: false, id: oldProjectId },
    },
    {
      description: "old project omits the numeric team identity",
      projectId: oldProjectId,
      value: { autoAssignCustomDomains: false, id: oldProjectId },
    },
    {
      description: "new project omits the numeric team identity",
      projectId: newProjectId,
      value: { autoAssignCustomDomains: false, id: newProjectId },
    },
    {
      description: "old project reports another numeric team identity",
      projectId: oldProjectId,
      value: {
        accountId: "team_AAAAAAAAAAAAAAAAAAAAAAAA",
        autoAssignCustomDomains: false,
        id: oldProjectId,
      },
    },
    {
      description: "new project reports another numeric team identity",
      projectId: newProjectId,
      value: {
        accountId: "team_AAAAAAAAAAAAAAAAAAAAAAAA",
        autoAssignCustomDomains: false,
        id: newProjectId,
      },
    },
  ] as const;

  for (const scenario of unsafeProjectReadbacks) {
    test(`refuses before deployment or traffic reads when ${scenario.description}`, async () => {
      const provider = new FakeCutoverProvider(forwardPlan);
      provider.projectReadbacks[scenario.projectId] = scenario.value;

      await expect(executeCutoverPlan(forwardPlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "automatic_domain_assignment_unsafe" });
      expect(provider.operations).toEqual([
        `read-project:${oldProjectId}`,
        `read-project:${newProjectId}`,
      ]);
    });
  }

  test("automatically restores the proven source when target marker does not converge", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.markerBrokenForTargetAlias = canonicalAlias;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
    expect(provider.operations).not.toContain(`move:${oldProjectId}->${newProjectId}`);
    expect(provider.operations).toContain(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
  });

  for (const scenario of [
    {
      aliasName: fallbackAlias,
      description: "Q fallback points at the N project",
      initial: newEndpoint,
      restored: oldEndpoint,
    },
    {
      aliasName: newStagingAlias,
      description: "N staging points at the Q project",
      initial: oldEndpoint,
      restored: newEndpoint,
    },
    {
      aliasName: fallbackAlias,
      description: "Q fallback points at an unknown old-project deployment",
      initial: {
        ...oldEndpoint,
        deploymentId: "dpl_UnknownAccepted1234567890",
        deploymentUrl: "hra-unknown-hraness.vercel.app",
      },
      restored: oldEndpoint,
    },
  ] as const) {
    test(`repairs and refuses a partial source when ${scenario.description}`, async () => {
      const provider = new FakeCutoverProvider(forwardPlan);
      provider.aliasEndpoints[scenario.aliasName] = scenario.initial;

      await expect(executeCutoverPlan(forwardPlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_reverted" });

      expect(provider.aliasEndpoint).toBe(oldEndpoint);
      expect(provider.aliasEndpoints[scenario.aliasName]).toBe(scenario.restored);
      expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
      expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
      expect(provider.owner).toBe("source");
      expect(provider.operations).toContain(
        `set-alias:${scenario.aliasName}:${scenario.restored.deploymentUrl}`,
      );
      expect(provider.operations).not.toContain(
        `set-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
      );
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  test("restores traffic when the domain move remains on its source", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "noop";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
  });

  test("reverses exact target metadata if traffic has already returned to source", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "move-and-source-alias";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
    expect(provider.operations).toContain(`move:${newProjectId}->${oldProjectId}`);
  });

  test("restores traffic then stops on duplicate or missing ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "ambiguous";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_ambiguous" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("ambiguous");
  });

  test("restores every alias before escalating partial traffic with ambiguous ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.aliasEndpoints[newStagingAlias] = oldEndpoint;
    provider.owner = "ambiguous";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_ambiguous" });

    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.operations).toContain(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(provider.operations).toContain(
      `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(provider.operations).toContain(
      `set-alias:${newStagingAlias}:${newEndpoint.deploymentUrl}`,
    );
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
  });

  test("restores and proves exact source traffic before reporting ambiguous ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.owner = "ambiguous";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_ambiguous" });

    for (const [aliasName, endpoint] of [
      [canonicalAlias, oldEndpoint],
      [fallbackAlias, oldEndpoint],
      [newStagingAlias, newEndpoint],
    ] as const) {
      const mutation = `set-alias:${aliasName}:${endpoint.deploymentUrl}`;
      const proof = `read-marker:${aliasName}:${endpoint.deploymentId}`;
      expect(provider.operations).toContain(mutation);
      expect(provider.operations.lastIndexOf(proof)).toBeGreaterThan(
        provider.operations.indexOf(mutation),
      );
    }
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
  });

  test("refuses ownership reversal if restored traffic drifts after an early proof", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.driftAfterMarkerRead = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
      triggerAlias: canonicalAlias,
      triggerEndpoint: oldEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "compensation_failed" });

    expect(provider.operations).toContain(
      `drift-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    expect(provider.owner).toBe("target");
  });

  test("restores traffic again when it drifts after the aggregate pre-move proof", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.driftAfterMarkerRead = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
      remainingMatches: 2,
      triggerAlias: canonicalAlias,
      triggerEndpoint: oldEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const drift = provider.operations.indexOf(
      `drift-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    const finalRestore = provider.operations.lastIndexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(drift).toBeGreaterThan(-1);
    expect(reverseMove).toBeGreaterThan(drift);
    expect(finalRestore).toBeGreaterThan(reverseMove);
    for (const [aliasName, endpoint] of [
      [canonicalAlias, oldEndpoint],
      [fallbackAlias, oldEndpoint],
      [newStagingAlias, newEndpoint],
    ] as const) {
      const proof = `read-marker:${aliasName}:${endpoint.deploymentId}`;
      expect(provider.operations.slice(reverseMove + 1).filter((operation) => (
        operation === proof
      ))).toHaveLength(3);
    }
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("reconciles a delayed domain alias write during the final full-state proof", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.driftAfterAliasRead = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
      remainingMatches: 4,
      triggerAlias: canonicalAlias,
      triggerEndpoint: oldEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    const drift = provider.operations.indexOf(
      `drift-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
      reverseMove,
    );
    const repair = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
      drift,
    );
    expect(reverseMove).toBeGreaterThan(-1);
    expect(drift).toBeGreaterThan(reverseMove);
    expect(repair).toBeGreaterThan(drift);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("reconciles a delayed archive alias write during the final full-state proof", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.aliasEndpoints[canonicalAlias] = oldEndpoint;
    provider.driftAfterAliasRead = {
      aliasName: canonicalAlias,
      endpoint: oldEndpoint,
      remainingMatches: 2,
      triggerAlias: canonicalAlias,
      triggerEndpoint: baselineEndpoint,
    };

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const drift = provider.operations.indexOf(
      `drift-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    const repair = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${baselineEndpoint.deploymentUrl}`,
      drift,
    );
    expect(drift).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(drift);
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
    expect(provider.owner).toBe("source");
  });

  test("repairs alias perturbation caused by the reverse ownership move", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.reverseMoveAliasPerturbation = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    const perturbation = provider.operations.indexOf(
      `perturb-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    const finalRestore = provider.operations.lastIndexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(perturbation).toBeGreaterThan(reverseMove);
    expect(finalRestore).toBeGreaterThan(perturbation);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("converges after a lost reverse-move response and stale ownership readback", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.reverseMoveCommitAndThrow = true;
    provider.reverseMoveStaleDomainReads = 2;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    expect(provider.operations.filter((operation) => (
      operation === `move:${newProjectId}->${oldProjectId}`
    ))).toHaveLength(1);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("gives stale post-move ownership a fresh window after pre-move convergence", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.ownerReadOverrides.push("target", "ambiguous", "target");
    provider.reverseMoveCommitAndThrow = true;
    provider.reverseMoveStaleDomainReads = 2;
    const clock = immediateClock();

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock,
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    expect(provider.operations.filter((operation) => (
      operation === `move:${newProjectId}->${oldProjectId}`
    ))).toHaveLength(1);
    expect(clock.now()).toBe(4);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("proves canonical, Q, and N restoration before reversing exact target ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.aliasEndpoints[newStagingAlias] = oldEndpoint;
    provider.owner = "target";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    expect(reverseMove).toBeGreaterThan(-1);
    for (const mutation of [
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
      `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
      `set-alias:${newStagingAlias}:${newEndpoint.deploymentUrl}`,
    ]) {
      expect(provider.operations.indexOf(mutation)).toBeLessThan(reverseMove);
    }
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("reverses N to Q while preserving both fixed staging aliases", async () => {
    const provider = new FakeCutoverProvider(reversePlan);

    const outcome = await executeCutoverPlan(reversePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });
    expect(outcome).toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("target");
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.operations).toContain(`move:${newProjectId}->${oldProjectId}`);
  });

  test("compensates an ambiguous reverse move back to N and new-project ownership", async () => {
    const provider = new FakeCutoverProvider(reversePlan);
    provider.moveBehavior = "move-and-source-alias";

    await expect(executeCutoverPlan(reversePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("source");
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.operations).toContain(`move:${oldProjectId}->${newProjectId}`);
  });

  test("updates the archive deployment without moving project ownership", async () => {
    const provider = new FakeCutoverProvider(archivePlan);

    const outcome = await executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });
    expect(outcome).toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    const fallbackMutation = provider.operations.indexOf(
      `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
    );
    const canonicalMutation = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(fallbackMutation).toBeGreaterThan(-1);
    expect(canonicalMutation).toBeGreaterThan(fallbackMutation);
    expect(provider.operations.slice(fallbackMutation, canonicalMutation)).toContain(
      `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
    );
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
  });

  test("restores both aliases to P if the fallback Q marker is not exact", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.markerBrokenForTargetAlias = fallbackAlias;

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.operations).not.toContain(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
  });

  test("refuses generation-zero markers with a wrong schema or top-level-only version", async () => {
    for (const value of [
      { ...markerFor(oldEndpoint) as object, schemaVersion: 1 },
      {
        generation: 0,
        product: "HRA",
        repository: {
          id: oldEndpoint.repositoryId,
          path: "hraness/hra-v0",
        },
        schemaVersion: 2,
        source: { commit: oldEndpoint.sourceCommit },
        version: oldEndpoint.version,
      },
    ]) {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.markerOverrideForTargetAlias = { alias: fallbackAlias, value };

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_reverted" });
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    }
  });

  test("refuses a generation-one marker whose version exists only under publication", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    const marker = markerFor(newEndpoint) as Record<string, unknown>;
    const { version, ...withoutVersion } = marker;
    provider.markerOverrideForTargetAlias = {
      alias: canonicalAlias,
      value: { ...withoutVersion, publication: { version } },
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
  });

  test("restores both aliases to P if hra.sh fails after fallback Q is proven", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.targetAliasSetFailure = canonicalAlias;

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.operations).toContain(
      `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
    );
  });

  test("reports compensation failure if either exact P alias cannot be restored", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.markerBrokenForTargetAlias = fallbackAlias;
    provider.sourceAliasSetFailure = fallbackAlias;

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "compensation_failed" });
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
  });

  test("parses only the three fixed numeric identity transitions and bare URLs", () => {
    expect(parseCutoverPlan(JSON.stringify(forwardPlan))).toEqual(forwardPlan);
    expect(() => parseCutoverPlan(JSON.stringify({
      ...forwardPlan,
      target: { ...newEndpoint, projectId: oldProjectId },
    }))).toThrow("input_invalid");
    expect(() => parseCutoverPlan(JSON.stringify({
      ...forwardPlan,
      target: { ...newEndpoint, deploymentUrl: `https://${newEndpoint.deploymentUrl}` },
    }))).toThrow("input_invalid");
    expect(() => parseCutoverPlan(JSON.stringify({
      ...forwardPlan,
      target: { ...newEndpoint, deploymentUrl: `${newEndpoint.deploymentUrl}.vercel.app` },
    }))).toThrow("input_invalid");
    expect(() => parseArguments(["--vercel-cli", "/safe/vercel"])).toThrow("usage_invalid");
    expect(parseArguments([
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
      "--plan-fd",
      "3",
    ])).toEqual({ execute: true, planFd: 3, vercelCli: "/safe/vercel" });
  });

  test("emits changed and replayed outcomes for a fresh archive and its exact retry", async () => {
    const aliases: Record<ManagedAlias, CutoverEndpoint> = {
      [canonicalAlias]: baselineEndpoint,
      [fallbackAlias]: baselineEndpoint,
      [newStagingAlias]: newEndpoint,
    };
    const runner: VercelCommandRunner = async (request) => {
      const [command, path] = request.arguments;
      if (command === "--version") {
        return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
      }
      if (command === "alias" && path === "set") {
        const deploymentUrl = request.arguments[2];
        const aliasName = request.arguments[3] as ManagedAlias;
        const endpoint = [baselineEndpoint, oldEndpoint, newEndpoint]
          .find((candidate) => candidate.deploymentUrl === deploymentUrl);
        if (endpoint === undefined) return { exitCode: 1, stderr: "", stdout: "" };
        aliases[aliasName] = endpoint;
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command !== "api") return { exitCode: 1, stderr: "", stdout: "" };
      if (path === `/v9/projects/${oldProjectId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(projectFor(oldProjectId)),
        };
      }
      if (path === `/v9/projects/${newProjectId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(projectFor(newProjectId)),
        };
      }
      if (path === `/v13/deployments/${baselineEndpoint.deploymentId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(deploymentFor(baselineEndpoint)),
        };
      }
      if (path === `/v13/deployments/${oldEndpoint.deploymentId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(deploymentFor(oldEndpoint)),
        };
      }
      if (path === `/v9/projects/${oldProjectId}/domains?limit=20`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage([canonicalAlias])),
        };
      }
      if (path === `/v9/projects/${newProjectId}/domains?limit=20`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(domainPage([])) };
      }
      for (const aliasName of [canonicalAlias, fallbackAlias, newStagingAlias] as const) {
        if (path === `/v4/aliases/${aliasName}`) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(aliasFor(aliases[aliasName], aliasName)),
          };
        }
      }
      return { exitCode: 1, stderr: "", stdout: "" };
    };
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      return new Response(JSON.stringify(markerFor(aliases[url.hostname as ManagedAlias])), {
        status: 200,
      });
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
      write: ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as NodeJS.WriteStream["write"],
    });
    const execute = async (): Promise<number> => await executeDomainCutover({
      arguments: ["--execute", "--vercel-cli", "/safe/vercel"],
      environment: { HOME: "/safe/home", PATH: "/safe/bin" },
      fetcher,
      inputDocument: JSON.stringify(archivePlan),
      runner,
      stderr: output(stderr),
      stdout: output(stdout),
    });

    expect(await execute()).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.at(-1) ?? "null")).toEqual({
      changed: true,
      direction: "archive",
      replayed: false,
      schemaVersion: 1,
      status: "committed",
      targetDeploymentId: oldEndpoint.deploymentId,
      targetProjectId: oldProjectId,
    });

    expect(await execute()).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.at(-1) ?? "null")).toEqual({
      changed: false,
      direction: "archive",
      replayed: true,
      schemaVersion: 1,
      status: "committed",
      targetDeploymentId: oldEndpoint.deploymentId,
      targetProjectId: oldProjectId,
    });
  });

  test("uses exact Vercel API paths, pinned CLI version, and sanitized environment", async () => {
    const requests: VercelCommandRequest[] = [];
    const markerRequests: string[] = [];
    const runner: VercelCommandRunner = async (request) => {
      requests.push(request);
      const path = request.arguments[1];
      if (request.arguments[0] === "--version") {
        return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
      }
      if (path === "/v4/aliases/hra.sh") {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(aliasFor(oldEndpoint)) };
      }
      if (path === `/v4/aliases/${fallbackAlias}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(aliasFor(oldEndpoint, fallbackAlias)),
        };
      }
      if (path === `/v4/aliases/${newStagingAlias}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(aliasFor(newEndpoint, newStagingAlias)),
        };
      }
      if (path === `/v13/deployments/${oldEndpoint.deploymentId}`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(deploymentFor(oldEndpoint)) };
      }
      if (path === `/v9/projects/${oldProjectId}`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(projectFor(oldProjectId)) };
      }
      if (path === `/v9/projects/${oldProjectId}/domains?limit=20`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage(["other.example"], 1_612_264_332_000)),
        };
      }
      if (path === `/v9/projects/${oldProjectId}/domains?limit=20&until=1612264332000`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage([canonicalAlias], null, 1_612_264_332_001)),
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const provider = new VercelCutoverProvider({
      environment: {
        HOME: "/safe/home",
        PATH: "/safe/bin",
        VERCEL_TOKEN: "must-not-propagate",
      },
      fetcher: async (input) => {
        markerRequests.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return new Response(JSON.stringify(markerFor(oldEndpoint)), { status: 200 });
      },
      runner,
      vercelCli: "/safe/vercel",
    });

    await provider.verifyVersion();
    expect(await provider.readAlias(canonicalAlias)).toEqual(aliasFor(oldEndpoint));
    expect(await provider.readAlias(fallbackAlias)).toEqual(aliasFor(oldEndpoint, fallbackAlias));
    expect(await provider.readAlias(newStagingAlias)).toEqual(
      aliasFor(newEndpoint, newStagingAlias),
    );
    expect(await provider.readDeployment(oldEndpoint.deploymentId)).toEqual(
      deploymentFor(oldEndpoint),
    );
    expect(await provider.readProject(oldProjectId)).toEqual(projectFor(oldProjectId));
    expect(await provider.readDomainNames(oldProjectId)).toEqual(["other.example", "hra.sh"]);
    expect(await provider.readMarker(canonicalAlias)).toEqual(markerFor(oldEndpoint));
    expect(await provider.readMarker(fallbackAlias)).toEqual(markerFor(oldEndpoint));
    await provider.setAlias(oldEndpoint.deploymentUrl, canonicalAlias);
    await provider.setAlias(oldEndpoint.deploymentUrl, fallbackAlias);
    await provider.moveDomain(oldProjectId, newProjectId);
    await expect(provider.readAlias("other.vercel.app" as ManagedAlias)).rejects.toMatchObject({
      code: "alias_readback_invalid",
    });
    await expect(
      provider.setAlias(oldEndpoint.deploymentUrl, "other.vercel.app" as ManagedAlias),
    ).rejects.toMatchObject({ code: "usage_invalid" });

    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      "/v4/aliases/hra.sh",
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v4/aliases/${newStagingAlias}`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "alias",
      "set",
      oldEndpoint.deploymentUrl,
      fallbackAlias,
      "--scope",
      "hraness",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v9/projects/${oldProjectId}`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v9/projects/${oldProjectId}/domains?limit=20`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v9/projects/${oldProjectId}/domains?limit=20&until=1612264332000`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v1/projects/${oldProjectId}/domains/hra.sh/move`,
      "--scope",
      "hraness",
      "-X",
      "POST",
      "-F",
      `projectId=${newProjectId}`,
      "--silent",
    ]);
    expect(requests.every((request) => request.environment.VERCEL_TOKEN === undefined)).toBe(true);
    expect(markerRequests.some((request) => request.startsWith(
      `https://${fallbackAlias}/.well-known/hra.json?cutover=`,
    ))).toBe(true);
    expect(buildVercelEnvironment({ HOME: "/safe/home", VERCEL_TOKEN: "no" }))
      .toEqual({ HOME: "/safe/home", NO_COLOR: "1", TERM: "dumb" });
  });

  test("refuses a domain page that omits terminal pagination proof", async () => {
    const provider = new VercelCutoverProvider({
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ domains: [{ name: canonicalAlias }] }),
      }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("refuses a repeated domain cursor instead of accepting an incomplete list", async () => {
    const requests: VercelCommandRequest[] = [];
    const provider = new VercelCutoverProvider({
      runner: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage(["not-hra.example"], 42)),
        };
      },
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
    expect(requests.map((request) => request.arguments[1])).toEqual([
      `/v9/projects/${oldProjectId}/domains?limit=20`,
      `/v9/projects/${oldProjectId}/domains?limit=20&until=42`,
    ]);
  });

  test("refuses a domain page whose item count does not match pagination", async () => {
    const provider = new VercelCutoverProvider({
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          domains: [{ name: canonicalAlias }],
          pagination: { count: 0, next: null, prev: null },
        }),
      }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("refuses an empty nonterminal domain page", async () => {
    const provider = new VercelCutoverProvider({
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(domainPage([], 42)),
      }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("refuses ownership evidence that exceeds the bounded domain-page cap", async () => {
    let pages = 0;
    const provider = new VercelCutoverProvider({
      runner: async () => {
        pages += 1;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage([`domain-${pages}.example`], pages)),
        };
      },
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
    expect(pages).toBe(64);
  });

  test("caps a chunked marker body even when content-length is absent", async () => {
    const provider = new VercelCutoverProvider({
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20 * 1_024));
          controller.enqueue(new Uint8Array(20 * 1_024));
          controller.close();
        },
      }), { status: 200 }),
      runner: async () => ({ exitCode: 0, stderr: "", stdout: "54.18.0\n" }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readMarker(canonicalAlias)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("surfaces stable refusal codes", () => {
    expect(new DomainCutoverError("compensation_failed")).toMatchObject({
      code: "compensation_failed",
      message: "compensation_failed",
    });
  });
});
