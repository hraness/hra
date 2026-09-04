import { describe, expect, test } from "bun:test";

import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  executeHostedAdmission,
  manageHostedAdmission,
  parseAdmissionArguments,
} from "./manage-hosted-admission";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
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
const mutationId = "018bcfe5-6800-7000-8000-000000000930";

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

const verifier = (calls: ConvexTarget[]): ConvexTargetVerifier => async (value) => {
  calls.push(value);
  expect(value).toEqual(target);
};

describe("hosted auth admission operator", () => {
  test("parses status, freeze, and explicitly acknowledged resume", () => {
    expect(parseAdmissionArguments(["status", ...targetArguments])).toEqual({
      action: { kind: "status" },
      target,
    });
    expect(parseAdmissionArguments([
      "freeze",
      "--expected-generation", "0",
      "--mutation-id", mutationId,
      ...targetArguments,
    ])).toMatchObject({ action: { expectedGeneration: 0, kind: "freeze", mutationId } });
    expect(() => parseAdmissionArguments([
      "resume",
      "--expected-generation", "1",
      "--mutation-id", mutationId,
      ...targetArguments,
    ])).toThrow("usage_invalid");
    expect(parseAdmissionArguments([
      "resume",
      "--expected-generation", "1",
      "--mutation-id", mutationId,
      "--acknowledge-resume",
      ...targetArguments,
    ])).toMatchObject({ action: { expectedGeneration: 1, kind: "resume", mutationId } });
  });

  test("parses new-identity admission changes and requires the open acknowledgement", () => {
    expect(parseAdmissionArguments([
      "new-identities",
      "--new-identities", "invite_only",
      "--expected-generation", "2",
      "--mutation-id", mutationId,
      ...targetArguments,
    ])).toEqual({
      action: {
        expectedGeneration: 2,
        kind: "new-identities",
        mutationId,
        newIdentities: "invite_only",
      },
      target,
    });
    expect(parseAdmissionArguments([
      "new-identities",
      "--new-identities", "open",
      "--expected-generation", "2",
      "--mutation-id", mutationId,
      "--acknowledge-open-signup",
      ...targetArguments,
    ])).toMatchObject({ action: { kind: "new-identities", newIdentities: "open" } });

    for (const invalid of [
      // Opening sign-up without the explicit acknowledgement.
      ["new-identities", "--new-identities", "open", "--expected-generation", "2", "--mutation-id", mutationId],
      // An acknowledgement without the open value.
      ["new-identities", "--new-identities", "invite_only", "--expected-generation", "2", "--mutation-id", mutationId, "--acknowledge-open-signup"],
      // A value outside the closed union.
      ["new-identities", "--new-identities", "sometimes", "--expected-generation", "2", "--mutation-id", mutationId],
      // The action without its required value.
      ["new-identities", "--expected-generation", "2", "--mutation-id", mutationId],
      // The value on an action that does not take it.
      ["freeze", "--new-identities", "invite_only", "--expected-generation", "2", "--mutation-id", mutationId],
    ]) {
      expect(() => parseAdmissionArguments([...invalid, ...targetArguments]))
        .toThrow("usage_invalid");
    }
  });

  test("changes only new-identity admission under the shared generation fence", async () => {
    const requests: CommandRequest[] = [];
    const results = [
      { exitCode: 0, stderr: "", stdout: '{"generation":2,"state":"open","updatedAt":1}' },
      { exitCode: 0, stderr: "", stdout: '{"changed":true,"generation":3,"newIdentityAdmissions":"open","replay":false,"state":"open","updatedAt":2}' },
      { exitCode: 0, stderr: "", stdout: '{"generation":3,"newIdentityAdmissions":"open","state":"open","updatedAt":2}' },
    ];
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      return results.shift()!;
    };
    expect(await manageHostedAdmission({
      action: {
        expectedGeneration: 2,
        kind: "new-identities",
        mutationId,
        newIdentities: "open",
      },
      runner,
      target,
      verifyTarget: async () => undefined,
    })).toEqual({
      generation: 3,
      newIdentityAdmissions: "open",
      state: "open",
      updatedAt: 2,
    });
    expect(requests[1]?.arguments).toContain(JSON.stringify({
      expectedGeneration: 2,
      mutationId,
      newIdentityAdmissions: "open",
      state: "open",
    }));
  });

  test("refuses a new-identity change that the deployment already has", async () => {
    await expect(manageHostedAdmission({
      action: {
        expectedGeneration: 2,
        kind: "new-identities",
        mutationId,
        newIdentities: "open",
      },
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: '{"generation":2,"newIdentityAdmissions":"open","state":"open","updatedAt":1}',
      }),
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("transition_refused");
  });

  test("refuses a transition whose readback keeps the previous new-identity value", async () => {
    const results = [
      { exitCode: 0, stderr: "", stdout: '{"generation":2,"state":"open","updatedAt":1}' },
      { exitCode: 0, stderr: "", stdout: '{"changed":true,"generation":3,"newIdentityAdmissions":"invite_only","replay":false,"state":"open","updatedAt":2}' },
    ];
    await expect(manageHostedAdmission({
      action: {
        expectedGeneration: 2,
        kind: "new-identities",
        mutationId,
        newIdentities: "open",
      },
      runner: async () => results.shift()!,
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("transition_refused");
  });

  test("replays a lost new-identity response from durable state", async () => {
    const results = [
      { exitCode: 0, stderr: "", stdout: '{"generation":3,"newIdentityAdmissions":"open","state":"open","updatedAt":2}' },
      { exitCode: 0, stderr: "", stdout: '{"changed":true,"generation":3,"newIdentityAdmissions":"open","replay":true,"state":"open","updatedAt":2}' },
      { exitCode: 0, stderr: "", stdout: '{"generation":3,"newIdentityAdmissions":"open","state":"open","updatedAt":2}' },
    ];
    expect(await manageHostedAdmission({
      action: {
        expectedGeneration: 2,
        kind: "new-identities",
        mutationId,
        newIdentities: "open",
      },
      runner: async () => results.shift()!,
      target,
      verifyTarget: async () => undefined,
    })).toMatchObject({ generation: 3, newIdentityAdmissions: "open" });
  });

  test("freezes with exact target checks and strict postflight", async () => {
    const requests: CommandRequest[] = [];
    const results = [
      { exitCode: 0, stderr: "", stdout: '{"generation":0,"state":"open","updatedAt":1}' },
      { exitCode: 0, stderr: "", stdout: '{"changed":true,"generation":1,"replay":false,"state":"frozen","updatedAt":2}' },
      { exitCode: 0, stderr: "", stdout: '{"generation":1,"state":"frozen","updatedAt":2}' },
    ];
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      return results.shift()!;
    };
    const verifications: ConvexTarget[] = [];
    expect(await manageHostedAdmission({
      action: { expectedGeneration: 0, kind: "freeze", mutationId },
      environment: { CONVEX_DEPLOY_KEY: "secret", PATH: "/safe/bin" },
      runner,
      target,
      verifyTarget: verifier(verifications),
    })).toMatchObject({ generation: 1, state: "frozen" });
    expect(verifications).toHaveLength(4);
    expect(requests).toHaveLength(3);
    expect(requests[1]?.arguments).toContain(JSON.stringify({
      expectedGeneration: 0,
      mutationId,
      state: "frozen",
    }));
    expect(requests.every((request) => request.containment === "authority")).toBe(true);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("secret");
  });

  test("replays the same mutation after a lost response", async () => {
    const results = [
      { exitCode: 0, stderr: "", stdout: '{"generation":1,"state":"frozen","updatedAt":2}' },
      { exitCode: 0, stderr: "", stdout: '{"changed":true,"generation":1,"replay":true,"state":"frozen","updatedAt":2}' },
      { exitCode: 0, stderr: "", stdout: '{"generation":1,"state":"frozen","updatedAt":2}' },
    ];
    expect(await manageHostedAdmission({
      action: { expectedGeneration: 0, kind: "freeze", mutationId },
      runner: async () => results.shift()!,
      target,
      verifyTarget: async () => undefined,
    })).toMatchObject({ generation: 1, state: "frozen" });
  });

  test("performs target postflight when a committed transition response is lost or malformed", async () => {
    for (const transitionResult of [
      { exitCode: 1, stderr: "lost", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "{}\n{}" },
    ]) {
      const results = [
        { exitCode: 0, stderr: "", stdout: '{"generation":0,"state":"open","updatedAt":1}' },
        transitionResult,
      ];
      let verifications = 0;
      await expect(manageHostedAdmission({
        action: { expectedGeneration: 0, kind: "freeze", mutationId },
        runner: async () => results.shift()!,
        target,
        verifyTarget: async () => { verifications += 1; },
      })).rejects.toThrow(
        transitionResult.exitCode === 0 ? "provider_result_invalid" : "transition_refused",
      );
      expect(verifications).toBe(3);
    }
  });

  test("refuses stale generation, ambiguous provider output, and target mismatch", async () => {
    await expect(manageHostedAdmission({
      action: { expectedGeneration: 0, kind: "freeze", mutationId },
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: '{"generation":3,"state":"open","updatedAt":1}',
      }),
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("transition_refused");
    await expect(manageHostedAdmission({
      action: { expectedGeneration: 1, kind: "freeze", mutationId },
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: '{"generation":1,"state":"frozen","updatedAt":1}',
      }),
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("transition_refused");
    await expect(manageHostedAdmission({
      action: { kind: "status" },
      runner: async () => ({ exitCode: 0, stderr: "", stdout: "{}\n{}" }),
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("provider_result_invalid");
    await expect(manageHostedAdmission({
      action: { kind: "status" },
      runner: async () => ({ exitCode: 0, stderr: "", stdout: "{}" }),
      target,
      verifyTarget: async () => { throw new Error("wrong target"); },
    })).rejects.toThrow("wrong target");
    await expect(manageHostedAdmission({
      action: { kind: "status" },
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: '{"generation":9007199254740992,"state":"open","updatedAt":1}',
      }),
      target,
      verifyTarget: async () => undefined,
    })).rejects.toThrow("provider_result_invalid");
  });

  test("prints only bounded safe state and static failures", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedAdmission({
      arguments: ["status", ...targetArguments],
      runner: async () => ({
        exitCode: 0,
        stderr: "provider-secret",
        stdout: '{"generation":4,"state":"frozen","updatedAt":3}',
      }),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    })).toBe(0);
    expect(stdout).toEqual([
      '{"generation":4,"newIdentityAdmissions":"invite_only","state":"frozen","version":1}\n',
    ]);
    expect(stderr).toEqual([]);

    stdout.length = 0;
    expect(await executeHostedAdmission({
      arguments: ["status", ...targetArguments],
      runner: async () => ({ exitCode: 1, stderr: "provider-secret", stdout: "" }),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).not.toContain("provider-secret");
    expect(stderr.join("")).toContain("provider_result_invalid");
  });

  test("surfaces cleanup uncertainty without invoking target postflight", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let runnerCalls = 0;
    let verifications = 0;
    expect(await executeHostedAdmission({
      arguments: ["status", ...targetArguments],
      runner: async () => {
        runnerCalls += 1;
        throw new BoundedProcessCleanupUnprovenError(
          43_220,
          "hosted-admission-read-before",
        );
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => { verifications += 1; },
    })).toBe(75);
    expect(runnerCalls).toBe(1);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      code: "process_cleanup_unproven",
      phase: "hosted-admission-read-before",
      status: "recovery_required",
    });
  });

  test("preserves a blocked recovery journal without target postflight", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let verifications = 0;
    const recoveryPath = "/private/operator/process-recovery/authority-admission.json";
    expect(await executeHostedAdmission({
      arguments: ["status", ...targetArguments],
      runner: async () => {
        throw new BoundedProcessRecoveryJournalError(
          [recoveryPath],
          "authority_recovery_required",
        );
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => {
        verifications += 1;
        if (verifications === 2) throw new Error("postflight target identity changed");
      },
    })).toBe(75);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "process_recovery_journal_blocked",
      reason: "authority_recovery_required",
      recoveryPaths: [recoveryPath],
      schemaVersion: 1,
      status: "recovery_required",
    });
  });

  test("refuses an unavailable authority backend without invoking target postflight", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let runnerCalls = 0;
    let verifications = 0;
    expect(await executeHostedAdmission({
      arguments: ["status", ...targetArguments],
      runner: async () => {
        runnerCalls += 1;
        throw new BoundedProcessContainmentUnavailableError(
          "authority_backend_unavailable",
        );
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => { verifications += 1; },
    })).toBe(1);
    expect(runnerCalls).toBe(1);
    expect(verifications).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "authority_containment_unavailable",
      reason: "authority_backend_unavailable",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("process_cleanup_unproven");
  });
});
