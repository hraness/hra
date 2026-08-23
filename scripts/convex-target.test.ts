import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HRA_CONVEX_TEAM_ID,
  HRA_CONVEX_TEAM_SLUG,
  HRA_V0_CONVEX_DEPLOYMENT_ID,
  HRA_V0_CONVEX_PROJECT_ID,
  parseConvexTarget,
  parseConvexTargetArguments,
  readConvexAccessToken,
  verifyConvexDefaultTarget,
  verifyConvexTarget,
  type ConvexManagementFetch,
  type ConvexTarget,
} from "./convex-target";

const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: 1_234_567,
  teamId: HRA_CONVEX_TEAM_ID,
};

const targetArguments = [
  "--deployment",
  target.deploymentName,
  "--team-id",
  String(target.teamId),
  "--project-id",
  String(target.projectId),
  "--deployment-id",
  String(target.deploymentId),
  "--deployment-url",
  target.deploymentUrl,
] as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const makeConfig = async (mode = 0o600): Promise<Readonly<{
  configPath: string;
  token: string;
}>> => {
  const directory = await mkdtemp(join(tmpdir(), "hra-convex-target-test-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "config.json");
  const token = ["fixture", "access", "token"].join("-");
  await writeFile(configPath, JSON.stringify({ accessToken: token }), { mode });
  return { configPath, token };
};

describe("numeric Convex target guard", () => {
  test("reads both management identities with protected credentials and accepts only the exact prod target", async () => {
    const { configPath, token } = await makeConfig();
    const requests: Readonly<{ init: RequestInit; url: string }>[] = [];
    const fetcher: ConvexManagementFetch = async (input, init) => {
      const url = String(input);
      requests.push({ init, url });
      if (url.includes("/team_and_project")) {
        return new Response(JSON.stringify({
          project: "hra",
          projectId: target.projectId,
          team: HRA_CONVEX_TEAM_SLUG,
          teamId: target.teamId,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        deploymentType: "prod",
        deploymentUrl: target.deploymentUrl,
        id: target.deploymentId,
        isDefault: false,
        name: target.deploymentName,
        projectId: target.projectId,
      }), { status: 200 });
    };

    await verifyConvexTarget(target, { configPath, fetch: fetcher });

    expect(requests.map((request) => request.url).sort()).toEqual([
      `https://api.convex.dev/api/deployment/${target.deploymentName}/team_and_project`,
      `https://api.convex.dev/v1/deployments/${target.deploymentName}`,
    ].sort());
    for (const request of requests) {
      expect(new Headers(request.init.headers).get("Authorization")).toBe(`Bearer ${token}`);
      expect(request.init.method).toBe("GET");
      expect(request.init.redirect).toBe("error");
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test("rejects every wrong or missing provider team identity before mutation", async () => {
    const { configPath } = await makeConfig();
    const scenarios: readonly unknown[] = [
      {
        project: "hra",
        projectId: target.projectId,
        team: "wrong-team",
        teamId: target.teamId,
      },
      {
        project: "hra",
        projectId: target.projectId,
        teamId: target.teamId,
      },
      {
        project: "hra",
        projectId: target.projectId,
        team: HRA_CONVEX_TEAM_SLUG,
        teamId: target.teamId + 1,
      },
      {
        project: "hra",
        projectId: target.projectId,
        team: HRA_CONVEX_TEAM_SLUG,
      },
    ];

    for (const teamAndProject of scenarios) {
      let deploymentReadbackCalls = 0;
      const fetcher: ConvexManagementFetch = async (input) => {
        if (String(input).includes("/team_and_project")) {
          return new Response(JSON.stringify(teamAndProject), { status: 200 });
        }
        deploymentReadbackCalls += 1;
        return new Response(JSON.stringify({
          deploymentType: "prod",
          deploymentUrl: target.deploymentUrl,
          id: target.deploymentId,
          isDefault: false,
          name: target.deploymentName,
          projectId: target.projectId,
        }), { status: 200 });
      };
      await expect(verifyConvexTarget(target, { configPath, fetch: fetcher }))
        .rejects.toThrow("target_mismatch");
      expect(deploymentReadbackCalls).toBe(1);
    }
  });

  test("rejects a numeric mismatch, a non-prod deployment, and ambiguous provider output", async () => {
    const { configPath } = await makeConfig();
    const scenarios = [
      {
        deployment: {
          deploymentType: "prod",
          deploymentUrl: target.deploymentUrl,
          id: target.deploymentId + 1,
          isDefault: false,
          name: target.deploymentName,
          projectId: target.projectId,
        },
        expected: "target_mismatch",
      },
      {
        deployment: {
          deploymentType: "dev",
          deploymentUrl: target.deploymentUrl,
          id: target.deploymentId,
          isDefault: false,
          name: target.deploymentName,
          projectId: target.projectId,
        },
        expected: "target_mismatch",
      },
      { deployment: "{}\n{}", expected: "target_query_failed" },
    ] as const;

    for (const scenario of scenarios) {
      const fetcher: ConvexManagementFetch = async (input) => {
        if (String(input).includes("/team_and_project")) {
          return new Response(JSON.stringify({
            project: "hra",
            projectId: target.projectId,
            team: HRA_CONVEX_TEAM_SLUG,
            teamId: target.teamId,
          }), { status: 200 });
        }
        const body = typeof scenario.deployment === "string"
          ? scenario.deployment
          : JSON.stringify(scenario.deployment);
        return new Response(body, { status: 200 });
      };
      await expect(verifyConvexTarget(target, { configPath, fetch: fetcher }))
        .rejects.toThrow(scenario.expected);
    }
  });

  test("requires both deployment and project default authority for a production push", async () => {
    const { configPath } = await makeConfig();
    const requests: string[] = [];
    const makeFetcher = (
      isDefault: boolean,
      prodDeploymentName: string | null,
      projectTeamId: number = target.teamId,
    ): ConvexManagementFetch => async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/team_and_project")) {
        return new Response(JSON.stringify({
          project: "hra",
          projectId: target.projectId,
          team: HRA_CONVEX_TEAM_SLUG,
          teamId: target.teamId,
        }), { status: 200 });
      }
      if (url.includes(`/v1/projects/${target.projectId}`)) {
        return new Response(JSON.stringify({
          id: target.projectId,
          prodDeploymentName,
          teamId: projectTeamId,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        deploymentType: "prod",
        deploymentUrl: target.deploymentUrl,
        id: target.deploymentId,
        isDefault,
        name: target.deploymentName,
        projectId: target.projectId,
      }), { status: 200 });
    };

    await verifyConvexDefaultTarget(target, {
      configPath,
      fetch: makeFetcher(true, target.deploymentName),
    });
    expect(requests.sort()).toEqual([
      `https://api.convex.dev/api/deployment/${target.deploymentName}/team_and_project`,
      `https://api.convex.dev/v1/deployments/${target.deploymentName}`,
      `https://api.convex.dev/v1/projects/${target.projectId}`,
    ].sort());

    for (const [isDefault, prodDeploymentName, projectTeamId] of [
      [false, target.deploymentName, target.teamId],
      [true, null, target.teamId],
      [true, "other-otter-999", target.teamId],
      [true, target.deploymentName, target.teamId + 1],
    ] as const) {
      await expect(verifyConvexDefaultTarget(target, {
        configPath,
        fetch: makeFetcher(isDefault, prodDeploymentName, projectTeamId),
      })).rejects.toThrow("target_mismatch");
    }
  });

  test("requires a no-follow single-link 0600 bounded config file", async () => {
    const permissive = await makeConfig(0o644);
    await expect(readConvexAccessToken(permissive.configPath))
      .rejects.toThrow("target_credentials_refused");

    const protectedConfig = await makeConfig();
    const link = join(protectedConfig.configPath, "..", "config-link.json");
    await symlink(protectedConfig.configPath, link);
    await expect(readConvexAccessToken(link)).rejects.toThrow("target_credentials_refused");
  });

  test("accepts only a generated deployment name and all exact numeric flags", () => {
    expect(parseConvexTargetArguments([...targetArguments, "--operator-option"]))
      .toEqual({ otherArguments: ["--operator-option"], target });

    const withDeployment = (deployment: string): readonly string[] => [
      "--deployment",
      deployment,
      ...targetArguments.slice(2),
    ];
    expect(() => parseConvexTargetArguments(withDeployment("prod"))).toThrow("target_invalid");
    expect(() => parseConvexTargetArguments(withDeployment("local"))).toThrow("target_invalid");
    expect(() => parseConvexTargetArguments(withDeployment("team:project:prod")))
      .toThrow("target_invalid");
    expect(() => parseConvexTarget({
      ...target,
      teamId: HRA_CONVEX_TEAM_ID + 1,
    })).toThrow("target_invalid");
    expect(() => parseConvexTargetArguments([
      ...targetArguments.slice(0, 3),
      String(HRA_CONVEX_TEAM_ID + 1),
      ...targetArguments.slice(4),
    ])).toThrow("target_invalid");
    expect(() => parseConvexTargetArguments([
      ...targetArguments.slice(0, 5),
      String(HRA_V0_CONVEX_PROJECT_ID),
      ...targetArguments.slice(6),
    ])).toThrow("target_invalid");
    expect(() => parseConvexTargetArguments([
      ...targetArguments.slice(0, 7),
      String(HRA_V0_CONVEX_DEPLOYMENT_ID),
      ...targetArguments.slice(8),
    ])).toThrow("target_invalid");
  });
});
