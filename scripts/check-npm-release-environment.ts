import { z } from "zod";

import { readBoundedJsonResponse } from "./bounded-json-response";
import { publicRepository } from "./release-distribution-policy";

const releaseEnvironmentSchema = z.object({
  can_admins_bypass: z.literal(false),
  deployment_branch_policy: z.object({
    custom_branch_policies: z.literal(true),
    protected_branches: z.literal(false),
  }),
  name: z.literal("npm-release"),
  protection_rules: z.array(z.object({ type: z.string() })).max(10),
});
const releaseEnvironmentPoliciesSchema = z.object({
  branch_policies: z.array(z.object({ name: z.string(), type: z.string() })).max(100),
  total_count: z.number().int().nonnegative(),
});

export function assertReleaseEnvironment(environmentValue: unknown, policiesValue: unknown): void {
  const environment = releaseEnvironmentSchema.parse(environmentValue);
  if (JSON.stringify(environment.protection_rules.map((rule) => rule.type)) !== JSON.stringify(["branch_policy"])) {
    throw new Error("npm-release environment has unexpected protection rules.");
  }
  const policies = releaseEnvironmentPoliciesSchema.parse(policiesValue);
  const [policy] = policies.branch_policies;
  if (
    policies.total_count !== 1
    || policies.branch_policies.length !== 1
    || policy === undefined
    || policy.name !== "v*"
    || policy.type !== "tag"
  ) throw new Error("npm-release environment must admit only version tags.");
}

export async function checkNpmReleaseEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  if (source.GITHUB_REPOSITORY !== publicRepository || !source.GH_TOKEN) {
    throw new Error("npm environment admission requires the exact repository and read-only workflow token.");
  }
  if (source.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== undefined || source.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined) {
    throw new Error("npm environment admission must run before OIDC capability.");
  }
  const endpoint = `https://api.github.com/repos/${publicRepository}/environments/npm-release`;
  const read = async (url: string): Promise<unknown> => {
    const response = await request(url, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${source.GH_TOKEN}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 200) throw new Error("npm environment admission did not return exact provider metadata.");
    return readBoundedJsonResponse(response, "npm environment admission", 512 * 1024);
  };
  assertReleaseEnvironment(await read(endpoint), await read(`${endpoint}/deployment-branch-policies?per_page=100`));
}

if (import.meta.main) {
  await checkNpmReleaseEnvironment(process.env);
  console.log("npm environment is restricted to version tags without reviewers or administrator bypass.");
}
