import { expect, test } from "bun:test";

import { assertReleaseEnvironment, checkNpmReleaseEnvironment } from "./check-npm-release-environment";

test("requires a no-reviewer machine environment restricted to version tags", () => {
    const environment = {
      can_admins_bypass: false,
      deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
      name: "npm-release",
      protection_rules: [{ type: "branch_policy" }],
    };
    const policies = { branch_policies: [{ name: "v*", type: "tag" }], total_count: 1 };
    expect(() => assertReleaseEnvironment(environment, policies)).not.toThrow();
    expect(() => assertReleaseEnvironment(environment, {
      branch_policies: [{ name: "main", type: "branch" }],
      total_count: 1,
    })).toThrow("admit only version tags");
    expect(() => assertReleaseEnvironment({
      ...environment,
      protection_rules: [{ type: "branch_policy" }, { type: "required_reviewers" }],
    }, policies)).toThrow("unexpected protection rules");
    expect(() => assertReleaseEnvironment({ ...environment, can_admins_bypass: true }, policies)).toThrow();
  });

test("reads only exact npm environment metadata before OIDC capability", async () => {
  const source = { GITHUB_REPOSITORY: "hraness/oompa", GH_TOKEN: "synthetic-read-token" };
  const environment = { can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true, protected_branches: false }, name: "npm-release", protection_rules: [{ type: "branch_policy" }] };
  const policies = { branch_policies: [{ name: "v*", type: "tag" }], total_count: 1 };
  const urls: string[] = [];
  const request = async (url: string, init: RequestInit) => {
    urls.push(url);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json(url.includes("deployment-branch-policies") ? policies : environment);
  };
  await checkNpmReleaseEnvironment(source, request);
  expect(urls).toEqual(["https://api.github.com/repos/hraness/oompa/environments/npm-release", "https://api.github.com/repos/hraness/oompa/environments/npm-release/deployment-branch-policies?per_page=100"]);
  urls.length = 0;
  await expect(checkNpmReleaseEnvironment({ ...source, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-oidc" }, request)).rejects.toThrow("before OIDC");
  await expect(checkNpmReleaseEnvironment({ ...source, GITHUB_REPOSITORY: "wrong/repository" }, request)).rejects.toThrow("exact repository");
  expect(urls).toEqual([]);
  await expect(checkNpmReleaseEnvironment(source, async () => Response.json({}, { status: 404 }))).rejects.toThrow("exact provider metadata");
  await expect(checkNpmReleaseEnvironment(source, async () => Response.json({ ...environment, can_admins_bypass: true }))).rejects.toThrow();
});
