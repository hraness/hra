import { describe, expect, test } from "bun:test";

import {
  ConvexManagementChildError,
  executeConvexManagementChild,
  type ManagementFetcher,
} from "./convex-management-child";
import {
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  HRA_CONVEX_TEAM_SLUG,
  type ConvexTarget,
} from "./convex-target";

const previousTarget: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
};

const replacementTarget: ConvexTarget = {
  deploymentId: 7_654_322,
  deploymentName: "patient-lynx-322",
  deploymentUrl: "https://patient-lynx-322.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
};

const replacementReference = "hra-replace-018f6c9a24d77a12a45f06d1e3c5b7a9";

type RecordedRequest = Readonly<{ init: RequestInit; url: URL }>;
type DeploymentState = Readonly<{
  id: number;
  isDefault: boolean;
  name: string;
  url: string;
}>;

type ManagementFixture = Readonly<{
  calls: RecordedRequest[];
  fetcher: ManagementFetcher;
  state: Map<string, DeploymentState>;
}>;

const json = (value: unknown, status = 200): Response => new Response(
  JSON.stringify(value),
  { headers: { "Content-Type": "application/json" }, status },
);

const replacementDeployment = (isDefault = false): DeploymentState => ({
  id: replacementTarget.deploymentId,
  isDefault,
  name: replacementTarget.deploymentName,
  url: replacementTarget.deploymentUrl,
});

const fixture = (options: Readonly<{
  includeReplacement?: boolean;
  referenceName?: string | null;
  replacementDefault?: boolean;
}> = {}): ManagementFixture => {
  const state = new Map<string, DeploymentState>([
    [previousTarget.deploymentName, {
      id: previousTarget.deploymentId,
      isDefault: true,
      name: previousTarget.deploymentName,
      url: previousTarget.deploymentUrl,
    }],
  ]);
  if (options.includeReplacement) {
    state.set(replacementTarget.deploymentName, replacementDeployment(options.replacementDefault));
  }
  const calls: RecordedRequest[] = [];
  const fetcher: ManagementFetcher = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ init, url });
    const deploymentPath = /^\/v1\/deployments\/([^/]+)$/u.exec(url.pathname);
    const teamAndProjectPath = /^\/api\/deployment\/([^/]+)\/team_and_project$/u.exec(
      url.pathname,
    );
    if (teamAndProjectPath !== null && init.method === "GET") {
      const deployment = state.get(decodeURIComponent(teamAndProjectPath[1] ?? ""));
      return deployment === undefined
        ? json({ error: "missing" }, 404)
        : json({
          project: "hra",
          projectId: HRA_CONVEX_PROJECT_ID,
          team: HRA_CONVEX_TEAM_SLUG,
          teamId: HRA_CONVEX_TEAM_ID,
        });
    }
    if (url.pathname === `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}` && init.method === "GET") {
      const currentDefault = [...state.values()].find((deployment) => deployment.isDefault);
      return json({
        id: HRA_CONVEX_PROJECT_ID,
        prodDeploymentName: currentDefault?.name ?? null,
        slug: "hra",
        teamId: HRA_CONVEX_TEAM_ID,
      });
    }
    if (
      url.pathname
        === `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}/create_deployment`
      && init.method === "POST"
    ) {
      state.set(replacementTarget.deploymentName, replacementDeployment(false));
      return json({ kind: "cloud", name: replacementTarget.deploymentName });
    }
    if (
      url.pathname
        === `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}/deployment`
      && init.method === "GET"
    ) {
      if (url.searchParams.get("reference") !== replacementReference) return json({}, 404);
      const name = options.referenceName === undefined
        ? replacementTarget.deploymentName
        : options.referenceName;
      return name === null ? json({}, 404) : json({ name });
    }
    if (deploymentPath !== null && init.method === "GET") {
      const deployment = state.get(decodeURIComponent(deploymentPath[1] ?? ""));
      return deployment === undefined
        ? json({ error: "missing" }, 404)
        : json({
          deploymentType: "prod",
          deploymentUrl: deployment.url,
          id: deployment.id,
          isDefault: deployment.isDefault,
          name: deployment.name,
          projectId: HRA_CONVEX_PROJECT_ID,
        });
    }
    if (deploymentPath !== null && init.method === "PATCH") {
      const name = decodeURIComponent(deploymentPath[1] ?? "");
      const deployment = state.get(name);
      const desired = init.body === JSON.stringify({ isDefault: true })
        ? true
        : init.body === JSON.stringify({ isDefault: false })
          ? false
          : undefined;
      if (deployment === undefined || desired === undefined) {
        return json({ error: "invalid" }, 400);
      }
      if (desired) {
        if ([...state.values()].some((value) => value.isDefault && value.name !== name)) {
          return json({ error: "existing-default" }, 400);
        }
        for (const [key, value] of state) state.set(key, { ...value, isDefault: key === name });
      } else {
        state.set(name, { ...deployment, isDefault: false });
      }
      return json({});
    }
    return json({ error: "unexpected" }, 404);
  };
  return { calls, fetcher, state };
};

const execute = async (
  document: Readonly<Record<string, unknown>>,
  fetcher: ManagementFetcher,
): Promise<Awaited<ReturnType<typeof executeConvexManagementChild>>> => await executeConvexManagementChild(
  JSON.stringify(document),
  { fetcher, readAccessToken: async () => "test-access-token" },
);

describe("Convex target replacement management child", () => {
  test("creates one distinct non-default deployment and reconciles it by its exact reference", async () => {
    const management = fixture();
    await expect(execute({
      kind: "create_nondefault",
      previousTarget,
      reference: replacementReference,
    }, management.fetcher)).resolves.toEqual({ kind: "created", target: replacementTarget });

    const creation = management.calls.find((request) => request.init.method === "POST");
    expect(creation?.url.pathname).toBe(
      `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}/create_deployment`,
    );
    expect(creation?.init.body).toBe(JSON.stringify({
      isDefault: false,
      reference: replacementReference,
      region: null,
      type: "prod",
    }));
    expect(management.calls.some((request) => request.init.method === "PATCH")).toBe(false);
    const reconciliation = management.calls.find((request) => (
      request.url.pathname
        === `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}/deployment`
    ));
    expect(reconciliation?.url.searchParams.get("reference")).toBe(replacementReference);
    expect(management.state.get(previousTarget.deploymentName)?.isDefault).toBe(true);
    expect(management.state.get(replacementTarget.deploymentName)?.isDefault).toBe(false);
  });

  test("refuses a create response whose provider reference resolves to another deployment", async () => {
    const management = fixture({ referenceName: "rogue-lynx-999" });
    await expect(execute({
      kind: "create_nondefault",
      previousTarget,
      reference: replacementReference,
    }, management.fetcher)).rejects.toMatchObject({ code: "target_refused" });
    expect(management.calls.some((request) => request.init.method === "PATCH")).toBe(false);
  });

  test("demotes before promotion, then reads back both final default roles", async () => {
    const management = fixture({ includeReplacement: true });
    await expect(execute({
      kind: "demote_default",
      previousTarget,
      target: replacementTarget,
    }, management.fetcher)).resolves.toEqual({ kind: "demoted", target: replacementTarget });

    const demotion = management.calls.find((request) => request.init.method === "PATCH");
    expect(demotion?.url.pathname).toBe(`/v1/deployments/${previousTarget.deploymentName}`);
    expect(demotion?.init.body).toBe(JSON.stringify({ isDefault: false }));
    expect(management.state.get(previousTarget.deploymentName)?.isDefault).toBe(false);
    expect(management.state.get(replacementTarget.deploymentName)?.isDefault).toBe(false);

    await expect(execute({
      kind: "promote_default",
      previousTarget,
      target: replacementTarget,
    }, management.fetcher)).resolves.toEqual({ kind: "switched", target: replacementTarget });

    const patches = management.calls.filter((request) => request.init.method === "PATCH");
    expect(patches[1]?.url.pathname).toBe(`/v1/deployments/${replacementTarget.deploymentName}`);
    expect(patches[1]?.init.body).toBe(JSON.stringify({ isDefault: true }));
    expect(management.state.get(previousTarget.deploymentName)?.isDefault).toBe(false);
    expect(management.state.get(replacementTarget.deploymentName)?.isDefault).toBe(true);
  });

  test("never patches when the replacement has already become default", async () => {
    const management = fixture({ includeReplacement: true, replacementDefault: true });
    await expect(execute({
      kind: "demote_default",
      previousTarget,
      target: replacementTarget,
    }, management.fetcher)).rejects.toMatchObject({ code: "target_refused" });
    expect(management.calls.some((request) => request.init.method === "PATCH")).toBe(false);
  });

  test("keeps access material out of provider errors", async () => {
    const management = fixture();
    const refusing: ManagementFetcher = async () => json({ detail: "test-access-token" }, 500);
    await expect(execute({ kind: "verify_default", target: previousTarget }, refusing))
      .rejects.toBeInstanceOf(ConvexManagementChildError);
    try {
      await execute({ kind: "verify_default", target: previousTarget }, refusing);
    } catch (error: unknown) {
      expect(String(error)).not.toContain("test-access-token");
      expect(JSON.stringify(error)).not.toContain("test-access-token");
    }
    expect(management.calls).toHaveLength(0);
  });
});
