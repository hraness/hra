import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  executeHostedConvexReplacement,
  parseHostedConvexReplacementArguments,
  replaceHostedConvexTarget,
} from "./replace-hosted-convex-target";
import {
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  type ConvexTarget,
} from "./convex-target";

const roots: string[] = [];
const replacementId = "018f6c9a-24d7-7a12-a45f-06d1e3c5b7a9";
const replacementReference = "hra-replace-018f6c9a24d77a12a45f06d1e3c5b7a9";

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

const targetArguments = [
  "--deployment", previousTarget.deploymentName,
  "--team-id", String(previousTarget.teamId),
  "--project-id", String(previousTarget.projectId),
  "--deployment-id", String(previousTarget.deploymentId),
  "--deployment-url", previousTarget.deploymentUrl,
] as const;

const makeRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-convex-replacement-test-")));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

const operationArguments = (
  action: "create" | "status" | "switch",
  evidencePath: string,
): readonly string[] => [
  action,
  "--evidence-path", evidencePath,
  "--replacement-id", replacementId,
  ...(action === "status" ? [] : ["--execute"]),
  ...targetArguments,
];

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

type ManagementDocument = Readonly<{
  kind: string;
  previousTarget?: ConvexTarget;
  reference?: string;
  target?: ConvexTarget;
}>;

const managementDocument = (request: CommandRequest): ManagementDocument =>
  JSON.parse(request.stdin) as ManagementDocument;

const success = (value: unknown): Readonly<{ exitCode: number; stderr: string; stdout: string }> => ({
  exitCode: 0,
  stderr: "provider-secret",
  stdout: `${JSON.stringify(value)}\n`,
});

const replacementRunner = (requests: CommandRequest[]): CommandRunner => async (request) => {
  requests.push(request);
  const document = managementDocument(request);
  switch (document.kind) {
    case "create_nondefault":
      expect(document).toEqual({
        kind: "create_nondefault",
        previousTarget,
        reference: replacementReference,
      });
      return success({ kind: "created", target: replacementTarget });
    case "reconcile_create":
      return success({ kind: "created", target: replacementTarget });
    case "demote_default":
    case "reconcile_demotion":
      return success({ kind: "demoted", target: replacementTarget });
    case "promote_default":
    case "reconcile_promotion":
      return success({ kind: "switched", target: replacementTarget });
    case "verify_default":
      return success({ kind: "verified_default", target: document.target });
    case "verify_switch_preconditions":
      return success({ kind: "verified_switch_preconditions", target: replacementTarget });
    case "verify_demoted":
      return success({ kind: "verified_demoted", target: replacementTarget });
    default:
      throw new Error(`unexpected management request: ${document.kind}`);
  }
};

const makeArguments = (
  action: "create" | "status" | "switch",
  evidencePath: string,
) => parseHostedConvexReplacementArguments(operationArguments(action, evidencePath));

const createReceipt = async (
  evidencePath: string,
  requests: CommandRequest[],
) => await replaceHostedConvexTarget({
  arguments: makeArguments("create", evidencePath),
  environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
  runner: replacementRunner(requests),
});

const completeReplacement = async (
  evidencePath: string,
  requests: CommandRequest[],
): Promise<void> => {
  await createReceipt(evidencePath, requests);
  await replaceHostedConvexTarget({
    arguments: makeArguments("switch", evidencePath),
    environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
    runner: replacementRunner(requests),
  });
};

describe("fresh hosted Convex target replacement", () => {
  test("requires a closed command shape and an explicit execution acknowledgment", async () => {
    const root = await makeRoot();
    const evidencePath = join(root, "replacement.json");
    expect(makeArguments("create", evidencePath)).toMatchObject({
      action: "create",
      evidencePath,
      execute: true,
      previousTarget,
      replacementId,
    });
    expect(makeArguments("status", evidencePath)).toMatchObject({ action: "status", execute: false });
    expect(() => parseHostedConvexReplacementArguments([
      ...operationArguments("status", evidencePath),
      "--execute",
    ])).toThrow("usage_invalid");
    expect(() => parseHostedConvexReplacementArguments([
      "create",
      "--evidence-path", evidencePath,
      "--replacement-id", replacementId,
      ...targetArguments,
    ])).toThrow("usage_invalid");
  });

  test("creates a receipted non-default target, then verifies it remotely before reporting it", async () => {
    const root = await makeRoot();
    const evidencePath = join(root, "replacement.json");
    const requests: CommandRequest[] = [];
    await expect(createReceipt(evidencePath, requests)).resolves.toMatchObject({
      state: "created_receipted",
      target: replacementTarget,
    });
    expect(requests.map((request) => managementDocument(request).kind)).toEqual([
      "verify_default",
      "create_nondefault",
    ]);
    expect(requests.every((request) => request.containment === "authority")).toBe(true);
    expect(requests.every((request) => request.stdin.length > 0)).toBe(true);
    expect(Object.keys(requests[0]?.environment ?? {}).sort()).toEqual([
      "NO_COLOR",
      "PATH",
      "TERM",
    ]);
    expect(JSON.stringify(requests)).not.toContain("provider-secret");
    expect((await readdir(root)).sort()).toEqual([
      "replacement.json.create",
      "replacement.json.create.dispatch",
      "replacement.json.create.intent",
    ]);

    const statusRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("status", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: replacementRunner(statusRequests),
    })).resolves.toMatchObject({ state: "created_receipted", target: replacementTarget });
    expect(statusRequests.map((request) => managementDocument(request))).toEqual([{
      kind: "verify_switch_preconditions",
      previousTarget,
      target: replacementTarget,
    }]);
  });

  test("never reports complete from evidence alone and verifies the final default remotely", async () => {
    const root = await makeRoot();
    const evidencePath = join(root, "replacement.json");
    const requests: CommandRequest[] = [];
    await completeReplacement(evidencePath, requests);
    expect(requests.map((request) => managementDocument(request).kind)).toEqual([
      "verify_default",
      "create_nondefault",
      "verify_switch_preconditions",
      "verify_switch_preconditions",
      "demote_default",
      "verify_demoted",
      "promote_default",
    ]);

    const statusRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("status", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: replacementRunner(statusRequests),
    })).resolves.toMatchObject({ state: "complete", target: replacementTarget });
    expect(statusRequests.map((request) => managementDocument(request))).toEqual([{
      kind: "verify_default",
      target: replacementTarget,
    }]);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedConvexReplacement({
      arguments: operationArguments("status", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: async () => ({ exitCode: 1, stderr: "provider-secret", stdout: "" }),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
    });
    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "provider_result_invalid",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("provider-secret");
  });

  test("never promotes after an indeterminate demotion and resumes only from a demotion readback", async () => {
    const root = await makeRoot();
    const evidencePath = join(root, "replacement.json");
    await createReceipt(evidencePath, []);
    const firstRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("switch", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: async (request) => {
        firstRequests.push(request);
        const document = managementDocument(request);
        if (document.kind === "verify_switch_preconditions") {
          return success({ kind: "verified_switch_preconditions", target: replacementTarget });
        }
        if (document.kind === "demote_default") {
          return { exitCode: 1, stderr: "provider-secret", stdout: "" };
        }
        throw new Error(`unexpected management request: ${document.kind}`);
      },
    })).rejects.toThrow("demote_indeterminate");
    expect(firstRequests.map((request) => managementDocument(request).kind)).toEqual([
      "verify_switch_preconditions",
      "verify_switch_preconditions",
      "demote_default",
    ]);
    expect((await readdir(root)).sort()).toContain("replacement.json.switch.demote.dispatch");
    expect((await readdir(root)).sort()).not.toContain("replacement.json.switch.demote");

    const statusRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("status", evidencePath),
      runner: replacementRunner(statusRequests),
    })).resolves.toEqual({ state: "switch_demote_dispatched_reconciliation_required" });
    expect(statusRequests).toEqual([]);

    const reconciliationRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("switch", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: replacementRunner(reconciliationRequests),
    })).resolves.toMatchObject({ state: "complete", target: replacementTarget });
    expect(reconciliationRequests.map((request) => managementDocument(request).kind)).toEqual([
      "reconcile_demotion",
      "verify_demoted",
      "promote_default",
    ]);
  });

  test("reconciles an indeterminate promotion without attempting another demotion", async () => {
    const root = await makeRoot();
    const evidencePath = join(root, "replacement.json");
    await createReceipt(evidencePath, []);
    const firstRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("switch", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: async (request) => {
        firstRequests.push(request);
        const document = managementDocument(request);
        if (document.kind === "verify_switch_preconditions") {
          return success({ kind: "verified_switch_preconditions", target: replacementTarget });
        }
        if (document.kind === "demote_default") {
          return success({ kind: "demoted", target: replacementTarget });
        }
        if (document.kind === "verify_demoted") {
          return success({ kind: "verified_demoted", target: replacementTarget });
        }
        if (document.kind === "promote_default") {
          return { exitCode: 1, stderr: "provider-secret", stdout: "" };
        }
        throw new Error(`unexpected management request: ${document.kind}`);
      },
    })).rejects.toThrow("promote_indeterminate");
    expect(firstRequests.map((request) => managementDocument(request).kind)).toEqual([
      "verify_switch_preconditions",
      "verify_switch_preconditions",
      "demote_default",
      "verify_demoted",
      "promote_default",
    ]);
    expect((await readdir(root)).sort()).toContain("replacement.json.switch.promote.dispatch");

    const statusRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("status", evidencePath),
      runner: replacementRunner(statusRequests),
    })).resolves.toEqual({ state: "switch_promote_dispatched_reconciliation_required" });
    expect(statusRequests).toEqual([]);

    const reconciliationRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("switch", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: replacementRunner(reconciliationRequests),
    })).resolves.toMatchObject({ state: "complete", target: replacementTarget });
    expect(reconciliationRequests.map((request) => managementDocument(request).kind)).toEqual([
      "reconcile_promotion",
    ]);
  });

  test("does not retry an indeterminate create and makes status local-only until reconciliation", async () => {
    const root = await makeRoot();
    const evidencePath = join(root, "replacement.json");
    const firstRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("create", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: async (request) => {
        firstRequests.push(request);
        const document = managementDocument(request);
        if (document.kind === "verify_default") {
          return success({ kind: "verified_default", target: previousTarget });
        }
        if (document.kind === "create_nondefault") {
          return { exitCode: 1, stderr: "provider-secret", stdout: "" };
        }
        throw new Error(`unexpected management request: ${document.kind}`);
      },
    })).rejects.toThrow("create_indeterminate");
    expect(firstRequests.map((request) => managementDocument(request).kind)).toEqual([
      "verify_default",
      "create_nondefault",
    ]);

    const statusRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("status", evidencePath),
      runner: replacementRunner(statusRequests),
    })).resolves.toEqual({ state: "create_dispatched_reconciliation_required" });
    expect(statusRequests).toEqual([]);

    const reconciliationRequests: CommandRequest[] = [];
    await expect(replaceHostedConvexTarget({
      arguments: makeArguments("create", evidencePath),
      environment: { CONVEX_DEPLOY_KEY: "provider-secret", PATH: "/safe/bin" },
      runner: replacementRunner(reconciliationRequests),
    })).resolves.toMatchObject({ state: "created_receipted", target: replacementTarget });
    expect(reconciliationRequests.map((request) => managementDocument(request).kind)).toEqual([
      "reconcile_create",
    ]);
  });
});
