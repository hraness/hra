import { describe, expect, test } from "bun:test";

import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
} from "./bounded-process";
import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  executeHostedStatus,
  parseHostedStatusArguments,
  parseHostedReleaseAttestation,
  readHostedStatus,
} from "./hosted-status";
import {
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
  teamId: HRA_CONVEX_TEAM_ID,
};

const targetArguments = [
  "--deployment", target.deploymentName,
  "--team-id", String(target.teamId),
  "--project-id", String(target.projectId),
  "--deployment-id", String(target.deploymentId),
  "--deployment-url", target.deploymentUrl,
] as const;
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const statusArguments = ["--source-commit", sourceCommit, ...targetArguments] as const;

const requiredEnvironmentNames = [
  "SITE_URL",
  "JWT_PRIVATE_KEY",
  "JWKS",
  "HRA_AUTH_HMAC_SECRET",
  "HRA_RESEND_API_KEY",
  "HRA_AUTH_EMAIL_REPLY_TO",
] as const;

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

const statusRunner = (
  results: readonly Readonly<{ exitCode: number; stderr: string; stdout: string }>[],
  requests: CommandRequest[] = [],
): CommandRunner => {
  let index = 0;
  return async (request) => {
    requests.push(request);
    const result = results[index];
    index += 1;
    if (result === undefined) throw new Error("unexpected command");
    return result;
  };
};

const exactTargetVerifier = (calls: ConvexTarget[]): ConvexTargetVerifier => async (value) => {
  calls.push(value);
  expect(value).toEqual(target);
};

const readyBootstrap = JSON.stringify({
  occupiedTableCount: 3,
  serviceControlCount: 1,
  state: "ready",
});

const acceptedBootstrap = JSON.stringify({
  occupiedTableCount: 18,
  serviceControlCount: 1,
  state: "accepted",
});

describe("hosted preflight status operator", () => {
  test("reports an accepted deployment with open admission as live", async () => {
    for (const scenario of [
      {
        admission: '{"generation":2,"newIdentityAdmissions":"open","state":"open","updatedAt":1}',
        expected: {
          admission: { generation: 2, newIdentityAdmissions: "open", state: "open" },
          nextAction: "operate_hosted_sync",
          status: "live",
        },
        exitCode: 0,
      },
      {
        // A deployment that predates the control reports no value: invite_only.
        admission: '{"generation":1,"state":"frozen","updatedAt":1}',
        expected: {
          admission: { generation: 1, newIdentityAdmissions: "invite_only", state: "frozen" },
          nextAction: "resume_admissions",
          status: "preflight_incomplete",
        },
        exitCode: 1,
      },
    ] as const) {
      const runner = statusRunner([
        { exitCode: 0, stderr: "", stdout: `${requiredEnvironmentNames.join("\n")}\n` },
        { exitCode: 0, stderr: "", stdout: `${acceptedBootstrap}\n` },
        { exitCode: 0, stderr: "", stdout: `${scenario.admission}\n` },
      ]);
      const stdout: string[] = [];
      const exitCode = await executeHostedStatus({
        arguments: [...targetArguments, "--source-commit", sourceCommit, "--require-passed"],
        readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
        runner,
        stderr: { write: () => true },
        stdout: { write: (chunk) => { stdout.push(String(chunk)); return true; } },
        verifyTarget: exactTargetVerifier([]),
      });
      expect(exitCode).toBe(scenario.exitCode);
      expect(JSON.parse(stdout.join(""))).toEqual({
        ...scenario.expected,
        bootstrap: { occupiedTableCount: 18, state: "accepted" },
        environment: { requiredNamesPresent: true, missingRequiredNames: [] },
        releaseAttestation: { state: "current" },
        version: 1,
      });
    }
  });

  test("requires exactly one complete fixed Convex target tuple", () => {
    expect(parseHostedStatusArguments(statusArguments)).toEqual({
      requirePassed: false,
      sourceCommit,
      target,
    });
    expect(() => parseHostedStatusArguments([
      ...statusArguments,
      "--deployment", target.deploymentName,
    ])).toThrow("usage_invalid");
    expect(() => parseHostedStatusArguments([
      "status",
      ...statusArguments,
    ])).toThrow("usage_invalid");
    expect(() => parseHostedStatusArguments(targetArguments)).toThrow("usage_invalid");
  });

  test("reports only bounded preflight facts after authority-contained reads", async () => {
    const requests: CommandRequest[] = [];
    const verifications: ConvexTarget[] = [];
    const trace: string[] = [];
    const runner = statusRunner([
      {
        exitCode: 0,
        stderr: "provider-secret",
        stdout: `CONVEX_SITE_URL\nUNRELATED_PROVIDER_NAME\n${requiredEnvironmentNames.join("\n")}\n`,
      },
      { exitCode: 0, stderr: "provider-secret", stdout: `${readyBootstrap}\n` },
      { exitCode: 0, stderr: "provider-secret", stdout: '{"generation":0,"state":"open","updatedAt":1}\n' },
    ], requests);
    const status = await readHostedStatus({
      environment: {
        CONVEX_DEPLOY_KEY: "provider-secret",
        HOME: "/safe/operator",
        PATH: "/safe/bin",
      },
      readAttestation: async (value) => {
        expect(value).toEqual(target);
        return { runtimeSourceCommit: sourceCommit, state: "bound" };
      },
      runner: async (request) => {
        trace.push(request.phase);
        return await runner(request);
      },
      sourceCommit,
      target,
      verifyTarget: async (value) => {
        trace.push("verify");
        await exactTargetVerifier(verifications)(value);
      },
    });

    expect(status).toEqual({
      admission: {
        generation: 0,
        newIdentityAdmissions: "invite_only",
        state: "open",
      },
      bootstrap: { occupiedTableCount: 3, state: "ready" },
      environment: { requiredNamesPresent: true, missingRequiredNames: [] },
      nextAction: "run_live_acceptance",
      releaseAttestation: { state: "current" },
      status: "preflight_passed",
    });
    expect(verifications).toHaveLength(8);
    expect(trace).toEqual([
      "verify", "verify",
      "verify", "hosted-status-environment-read", "verify",
      "verify", "hosted-status-bootstrap-read", "verify",
      "verify", "hosted-status-admission-read", "verify",
    ]);
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.containment === "authority")).toBe(true);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
    expect(requests[0]?.arguments.slice(1)).toEqual([
      "env", "list", "--names-only", "--deployment", target.deploymentName,
    ]);
    expect(requests[1]?.arguments.slice(1)).toEqual([
      "run", "quota:hostedBootstrapStatus", "{}", "--deployment", target.deploymentName,
    ]);
    expect(requests[2]?.arguments.slice(1)).toEqual([
      "run", "admissionControl:status", "{}", "--deployment", target.deploymentName,
    ]);
    expect(JSON.stringify(requests)).not.toContain("provider-secret");
  });

  test("writes a machine-readable incomplete observation as a successful read", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ state: "unbound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "provider-secret", stdout: "SITE_URL\nUNRELATED_PROVIDER_NAME\n" },
        {
          exitCode: 0,
          stderr: "provider-secret",
          stdout: '{"occupiedTableCount":0,"serviceControlCount":0,"state":"uninitialized"}\n',
        },
      ]),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      admission: { state: "uninitialized" },
      bootstrap: { occupiedTableCount: 0, state: "uninitialized" },
      environment: {
        requiredNamesPresent: false,
        missingRequiredNames: requiredEnvironmentNames.slice(1),
      },
      nextAction: "inspect_release_attestation",
      releaseAttestation: { state: "unbound" },
      status: "preflight_incomplete",
      version: 1,
    });
    expect(stdout.join("")).not.toContain("UNRELATED_PROVIDER_NAME");
    expect(stdout.join("")).not.toContain("CONVEX_SITE_URL");
    expect(stdout.join("")).not.toContain("provider-secret");
  });

  test("never passes a bound runtime attested to a different source commit", async () => {
    const status = await readHostedStatus({
      readAttestation: async () => ({
        runtimeSourceCommit: "fedcba98765432100123456789abcdef01234567",
        state: "bound",
      }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
        { exitCode: 0, stderr: "", stdout: readyBootstrap },
        { exitCode: 0, stderr: "", stdout: '{"generation":0,"state":"open","updatedAt":1}' },
      ]),
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    });

    expect(status).toMatchObject({
      nextAction: "inspect_release_attestation",
      releaseAttestation: { state: "other" },
      status: "preflight_incomplete",
    });
  });

  test("makes a valid non-passed observation fail only when explicitly requested", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: [...statusArguments, "--require-passed"],
      readAttestation: async () => ({ state: "unbound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: requiredEnvironmentNames.join("\n") },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"occupiedTableCount":0,"serviceControlCount":0,"state":"uninitialized"}',
        },
      ]),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({ status: "preflight_incomplete" });
  });

  test("refuses malformed observations without exposing provider output", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: async () => ({
        exitCode: 0,
        stderr: "provider-secret",
        stdout: "SITE_URL=provider-secret\n",
      }),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "environment_status_invalid",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("provider-secret");
  });

  test("does not infer an unbound runtime from a malformed release response", () => {
    expect(() => parseHostedReleaseAttestation({ bound: false })).toThrow(
      "release_attestation_invalid",
    );
    expect(parseHostedReleaseAttestation({
      bound: false,
      schemaIdentity: "hra-release-attestation-v1",
      schemaVersion: 1,
    })).toEqual({ state: "unbound" });
  });

  test("preserves authority custody uncertainty as recovery-required", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: async () => {
        throw new BoundedProcessCleanupUnprovenError(42_001, "hosted-status-environment-read");
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    });

    expect(exitCode).toBe(75);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      code: "process_cleanup_unproven",
      phase: "hosted-status-environment-read",
      status: "recovery_required",
    });
  });

  test("refuses before target postflight when authority containment is unavailable", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let verifications = 0;
    const exitCode = await executeHostedStatus({
      arguments: statusArguments,
      readAttestation: async () => ({ runtimeSourceCommit: sourceCommit, state: "bound" }),
      runner: async () => {
        throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => { verifications += 1; },
    });

    expect(exitCode).toBe(1);
    expect(verifications).toBe(3);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "authority_containment_unavailable",
      reason: "authority_backend_unavailable",
      schemaVersion: 1,
      status: "refused",
    });
  });

  test("uses the named bounded bootstrap projection rather than an inline provider program", async () => {
    const requests: CommandRequest[] = [];
    await readHostedStatus({
      readAttestation: async () => ({ state: "unbound" }),
      runner: statusRunner([
        { exitCode: 0, stderr: "", stdout: "" },
        {
          exitCode: 0,
          stderr: "",
          stdout: '{"occupiedTableCount":0,"serviceControlCount":0,"state":"uninitialized"}',
        },
      ], requests),
      sourceCommit,
      target,
      verifyTarget: async () => undefined,
    });
    expect(requests.map((request) => request.arguments)).not.toContainEqual(
      expect.arrayContaining(["--inline-query"]),
    );
    expect(requests[1]?.arguments).toContain("quota:hostedBootstrapStatus");
  });
});
