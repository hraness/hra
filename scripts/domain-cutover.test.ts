import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildVercelEnvironment,
  DomainCutoverError,
  executeCutoverPlan,
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

const markerFor = (endpoint: CutoverEndpoint): unknown => ({
  generation: endpoint.generation,
  product: "HRA",
  repository: {
    id: endpoint.repositoryId,
    path: endpoint.projectId === oldProjectId ? "hraness/hra-v0" : "hraness/hra",
  },
  schemaVersion: 2,
  source: { commit: endpoint.sourceCommit },
  version: endpoint.version,
});

type MoveBehavior = "ambiguous" | "commit" | "move-and-source-alias" | "noop";

class FakeCutoverProvider implements CutoverProvider {
  readonly aliasEndpoints: Record<ManagedAlias, CutoverEndpoint>;
  markerBrokenForTargetAlias: ManagedAlias | undefined;
  moveBehavior: MoveBehavior = "commit";
  owner: "ambiguous" | "source" | "target" = "source";
  sourceAliasSetFailure: ManagedAlias | undefined;
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
    return aliasFor(endpoint, aliasName);
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
    if (this.owner === "ambiguous") return ["hra.sh"];
    if (this.owner === "source") {
      return projectId === this.plan.source.projectId ? ["hra.sh"] : [];
    }
    return projectId === this.plan.target.projectId ? ["hra.sh"] : [];
  }

  async readMarker(aliasName: ManagedAlias): Promise<unknown> {
    const endpoint = this.aliasEndpoints[aliasName];
    this.operations.push(`read-marker:${aliasName}:${endpoint.deploymentId}`);
    if (this.markerBrokenForTargetAlias === aliasName && endpoint === this.plan.target) {
      return { ...markerFor(endpoint) as object, source: { commit: "0".repeat(40) } };
    }
    return markerFor(endpoint);
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
  }

  async moveDomain(sourceProjectId: string, targetProjectId: string): Promise<void> {
    this.operations.push(`move:${sourceProjectId}->${targetProjectId}`);
    if (
      sourceProjectId === this.plan.target.projectId
      && targetProjectId === this.plan.source.projectId
    ) {
      this.owner = "source";
      return;
    }
    if (this.moveBehavior === "commit") this.owner = "target";
    if (this.moveBehavior === "ambiguous") this.owner = "ambiguous";
    if (this.moveBehavior === "move-and-source-alias") {
      this.owner = "target";
      this.aliasEndpoints[canonicalAlias] = this.plan.source;
    }
  }
}

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
    await executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });

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
    expect(provider.operations.at(-1)).toBe(
      `read-marker:${newStagingAlias}:${newEndpoint.deploymentId}`,
    );
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

  test("refuses forward traffic if the fixed new staging alias is not exact N", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[newStagingAlias] = oldEndpoint;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "source_not_authoritative" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBe(false);
  });

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

  test("reverses N to Q while preserving both fixed staging aliases", async () => {
    const provider = new FakeCutoverProvider(reversePlan);

    await executeCutoverPlan(reversePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });
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

    await executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });
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
      if (path === `/v9/projects/${oldProjectId}/domains`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ domains: [{ name: "hra.sh" }] }) };
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
    expect(await provider.readDomainNames(oldProjectId)).toEqual(["hra.sh"]);
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
