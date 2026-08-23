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
  type VercelCommandRequest,
  type VercelCommandRunner,
} from "./domain-cutover";

const oldProjectId = "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
const newProjectId = "prj_8ciIt9t9foE3utG45frRN7cxckjS";
const oldRepositoryId = 1_334_876_494;
const newRepositoryId = 1_343_008_607;

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

const aliasFor = (endpoint: CutoverEndpoint): AliasReadback => ({
  alias: "hra.sh",
  deployment: { id: endpoint.deploymentId, url: endpoint.deploymentUrl },
  deploymentId: endpoint.deploymentId,
  projectId: endpoint.projectId,
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
  aliasEndpoint: CutoverEndpoint;
  markerBrokenForTarget = false;
  moveBehavior: MoveBehavior = "commit";
  owner: "ambiguous" | "source" | "target" = "source";
  readonly operations: string[] = [];
  readonly plan: CutoverPlan;

  constructor(plan: CutoverPlan) {
    this.plan = plan;
    this.aliasEndpoint = plan.source;
  }

  async readAlias(): Promise<AliasReadback> {
    this.operations.push(`read-alias:${this.aliasEndpoint.deploymentId}`);
    return aliasFor(this.aliasEndpoint);
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

  async readMarker(): Promise<unknown> {
    this.operations.push(`read-marker:${this.aliasEndpoint.deploymentId}`);
    if (this.markerBrokenForTarget && this.aliasEndpoint === this.plan.target) {
      return { ...markerFor(this.aliasEndpoint) as object, source: { commit: "0".repeat(40) } };
    }
    return markerFor(this.aliasEndpoint);
  }

  async setAlias(deploymentUrl: string): Promise<void> {
    this.operations.push(`set-alias:${deploymentUrl}`);
    const endpoint = [this.plan.source, this.plan.target]
      .find((candidate) => candidate.deploymentUrl === deploymentUrl);
    if (endpoint === undefined) throw new Error("unknown alias target");
    this.aliasEndpoint = endpoint;
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
      this.aliasEndpoint = this.plan.source;
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
  test("switches traffic before ownership and accepts only exact target readback", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    await executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });

    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("target");
    const aliasMutation = provider.operations.indexOf(`set-alias:${newEndpoint.deploymentUrl}`);
    const domainMutation = provider.operations.indexOf(`move:${oldProjectId}->${newProjectId}`);
    expect(aliasMutation).toBeGreaterThan(-1);
    expect(domainMutation).toBeGreaterThan(aliasMutation);
    expect(provider.operations.slice(0, 2).sort()).toEqual([
      `read-deployment:${newEndpoint.deploymentId}`,
      `read-deployment:${oldEndpoint.deploymentId}`,
    ].sort());
    expect(provider.operations.at(-1)).toBe(`read-marker:${newEndpoint.deploymentId}`);
  });

  test("automatically restores the proven source when target marker does not converge", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.markerBrokenForTarget = true;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
    expect(provider.operations).not.toContain(`move:${oldProjectId}->${newProjectId}`);
    expect(provider.operations).toContain(`set-alias:${oldEndpoint.deploymentUrl}`);
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

  test("updates the archive deployment without moving project ownership", async () => {
    const baseline: CutoverEndpoint = {
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
      source: baseline,
      target: oldEndpoint,
    };
    const provider = new FakeCutoverProvider(archivePlan);

    await executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
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
    const runner: VercelCommandRunner = async (request) => {
      requests.push(request);
      const path = request.arguments[1];
      if (request.arguments[0] === "--version") {
        return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
      }
      if (path === "/v4/aliases/hra.sh") {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(aliasFor(oldEndpoint)) };
      }
      if (path === `/v13/deployments/${oldEndpoint.deploymentId}`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(deploymentFor(oldEndpoint)) };
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
      fetcher: async () => new Response(JSON.stringify(markerFor(oldEndpoint)), { status: 200 }),
      runner,
      vercelCli: "/safe/vercel",
    });

    await provider.verifyVersion();
    expect(await provider.readAlias()).toEqual(aliasFor(oldEndpoint));
    expect(await provider.readDeployment(oldEndpoint.deploymentId)).toEqual(
      deploymentFor(oldEndpoint),
    );
    expect(await provider.readDomainNames(oldProjectId)).toEqual(["hra.sh"]);
    expect(await provider.readMarker()).toEqual(markerFor(oldEndpoint));
    await provider.setAlias(oldEndpoint.deploymentUrl);
    await provider.moveDomain(oldProjectId, newProjectId);

    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      "/v4/aliases/hra.sh",
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

    await expect(provider.readMarker()).rejects.toMatchObject({
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
