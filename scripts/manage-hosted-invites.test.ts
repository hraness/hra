import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  digestInviteCapability,
  invitePublicIdFromCapabilityDigest,
} from "../src/cloud/inviteAuthority";

import type { CapabilitySink } from "./bootstrap-hosted-sync";
import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  ConvexTargetError,
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  HRA_V0_CONVEX_DEPLOYMENT_ID,
  HRA_V0_CONVEX_PROJECT_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  executeHostedInviteOperator,
  parseHostedInviteArguments,
} from "./manage-hosted-invites";

const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID,
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

const capability = `hra_invite_identity_v1_${"S".repeat(43)}`;
const capabilityDigest = await digestInviteCapability(capability, "identity");
const publicId = invitePublicIdFromCapabilityDigest(capabilityDigest);
const authority = { capability, capabilityDigest, publicId } as const;
const issued = {
  expiresAt: 1_800_086_400_000,
  publicId,
  purpose: "identity",
  replay: false,
  state: "issued",
} as const;
const status = {
  bound: false,
  consumedAt: null,
  createdAt: 1_800_000_000_000,
  expired: false,
  expiresAt: issued.expiresAt,
  publicId,
  purpose: "identity",
  state: "issued",
  updatedAt: 1_800_000_000_000,
} as const;
const revoked = {
  ...status,
  expiresAt: 1_800_172_800_000,
  replay: false,
  state: "revoked",
  updatedAt: 1_800_000_001_000,
} as const;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "hra-hosted-invite-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

const makeVerifier = (observed: ConvexTarget[]): ConvexTargetVerifier => async (value) => {
  observed.push(value);
  expect(value).toEqual(target);
};

type FakeSink = Readonly<{
  aborts: () => number;
  commits: () => readonly string[];
  sink: CapabilitySink;
}>;

const makeFakeSink = (): FakeSink => {
  let aborts = 0;
  const commits: string[] = [];
  return {
    aborts: () => aborts,
    commits: () => commits,
    sink: {
      async abort() { aborts += 1; },
      async commit(value) { commits.push(value); },
    },
  };
};

describe("hosted friend-beta invitation operator", () => {
  test("parses only one checked operation and refuses HRA v0 numeric identities", () => {
    expect(parseHostedInviteArguments([
      "issue",
      ...targetArguments,
      "--invite-output",
      "/private/operator/friend.invite",
    ])).toEqual({
      operation: {
        inviteOutput: "/private/operator/friend.invite",
        kind: "issue",
      },
      target,
    });
    expect(parseHostedInviteArguments([
      "recover",
      ...targetArguments,
      "--invite-file",
      "/private/operator/friend.invite",
    ])).toEqual({
      operation: {
        inviteFile: "/private/operator/friend.invite",
        kind: "recover",
      },
      target,
    });
    expect(parseHostedInviteArguments([
      "status",
      ...targetArguments,
      "--public-id",
      publicId,
    ])).toEqual({ operation: { kind: "status", publicId }, target });
    expect(parseHostedInviteArguments([
      "revoke",
      ...targetArguments,
      "--public-id",
      publicId,
    ])).toEqual({ operation: { kind: "revoke", publicId }, target });

    expect(() => parseHostedInviteArguments([
      "issue",
      ...targetArguments,
      "--invite-output",
      `/private/operator/${capability}`,
    ])).toThrow("usage_invalid");
    expect(() => parseHostedInviteArguments([
      "status",
      ...targetArguments,
      "--public-id",
      capability,
    ])).toThrow("usage_invalid");
    expect(() => parseHostedInviteArguments([
      "status",
      ...targetArguments.slice(0, 4),
      "--project-id",
      String(HRA_V0_CONVEX_PROJECT_ID),
      ...targetArguments.slice(6),
      "--public-id",
      publicId,
    ])).toThrow("usage_invalid");
    expect(() => parseHostedInviteArguments([
      "status",
      ...targetArguments.slice(0, 6),
      "--deployment-id",
      String(HRA_V0_CONVEX_DEPLOYMENT_ID),
      ...targetArguments.slice(8),
      "--public-id",
      publicId,
    ])).toThrow("usage_invalid");
  });

  test("issues one identity invite into an exclusive durable protected file without disclosure", async () => {
    const directory = await makeTemporaryDirectory();
    const output = join(directory, "friend.invite");
    const requests: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      return {
        exitCode: 0,
        stderr: `provider-debug ${capability}`,
        stdout: `${JSON.stringify(issued)}\n`,
      };
    };
    const verifications: ConvexTarget[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];

    expect(await executeHostedInviteOperator({
      arguments: ["issue", ...targetArguments, "--invite-output", output],
      authorityFactory: async () => authority,
      environment: {
        CONVEX_DEPLOY_KEY: capability,
        HOME: "/safe/operator",
        HRA_AUTH_HMAC_SECRET: capability,
        PATH: "/safe/bin",
        TMPDIR: `/safe/${capability}`,
      },
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: makeVerifier(verifications),
    })).toBe(0);

    expect(verifications).toHaveLength(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.arguments.slice(1)).toEqual([
      "run",
      "authInvites:recordIssue",
      JSON.stringify({
        capabilityDigest,
        lifetimeMs: 86_400_000,
        publicId,
        purpose: "identity",
      }),
      "--deployment",
      target.deploymentName,
    ]);
    expect(requests[0]).toMatchObject({
      outputMaximumBytes: 65_536,
      stdin: "",
      timeoutMs: 60_000,
    });
    expect(Object.keys(requests[0]?.environment ?? {}).sort()).toEqual([
      "HOME",
      "NO_COLOR",
      "PATH",
      "TERM",
    ]);
    expect(Object.values(requests[0]?.environment ?? {})).not.toContain(capability);
    expect(JSON.stringify(requests)).not.toContain(capability);
    expect(JSON.stringify(requests)).not.toContain("quota:genesisHardAuthority");

    expect(await readFile(output, "utf8")).toBe(`${capability}\n`);
    const observed = await lstat(output);
    expect(observed.isFile()).toBe(true);
    expect(observed.nlink).toBe(1);
    expect(observed.mode & 0o777).toBe(0o600);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      invite: {
        expiresAt: issued.expiresAt,
        publicId,
        purpose: "identity",
        replay: false,
        state: "issued",
      },
      operation: "issue",
    });
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(capability);
  });

  test("recovers an indeterminate issuance from protected local custody", async () => {
    const directory = await makeTemporaryDirectory();
    const inviteFile = join(directory, "indeterminate.invite");
    await writeFile(inviteFile, `${capability}\n`, { mode: 0o600 });
    const requests: CommandRequest[] = [];
    const verifications: ConvexTarget[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const results = [
      null,
      { malformed: true },
      status,
    ] as const;

    expect(await executeHostedInviteOperator({
      arguments: ["recover", ...targetArguments, "--invite-file", inviteFile],
      environment: { HRA_AUTH_HMAC_SECRET: capability, PATH: "/safe/bin" },
      runner: async (request) => {
        requests.push(request);
        const result = results[requests.length - 1];
        if (result === undefined) throw new Error("unexpected recovery call");
        return {
          exitCode: 0,
          stderr: capability,
          stdout: `${JSON.stringify(result)}\n`,
        };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: makeVerifier(verifications),
    })).toBe(0);

    expect(verifications).toHaveLength(4);
    expect(requests.map((request) => request.arguments.slice(1))).toEqual([
      [
        "run",
        "authInvites:status",
        JSON.stringify({ publicId }),
        "--deployment",
        target.deploymentName,
      ],
      [
        "run",
        "authInvites:recordIssue",
        JSON.stringify({
          capabilityDigest,
          lifetimeMs: 86_400_000,
          publicId,
          purpose: "identity",
        }),
        "--deployment",
        target.deploymentName,
      ],
      [
        "run",
        "authInvites:status",
        JSON.stringify({ publicId }),
        "--deployment",
        target.deploymentName,
      ],
    ]);
    expect(JSON.stringify(requests)).not.toContain(capability);
    expect(JSON.parse(stdout.join(""))).toEqual({
      invite: status,
      operation: "recover",
    });
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(capability);
  });

  test("reconciles an already terminal invite without replaying issuance", async () => {
    const directory = await makeTemporaryDirectory();
    const inviteFile = join(directory, "terminal.invite");
    await writeFile(inviteFile, `${capability}\n`, { mode: 0o600 });
    const requests: CommandRequest[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const terminal = {
      ...status,
      expiresAt: revoked.expiresAt,
      state: "revoked",
      updatedAt: revoked.updatedAt,
    } as const;

    expect(await executeHostedInviteOperator({
      arguments: ["recover", ...targetArguments, "--invite-file", inviteFile],
      runner: async (request) => {
        requests.push(request);
        return { exitCode: 0, stderr: capability, stdout: JSON.stringify(terminal) };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    })).toBe(0);

    expect(requests.map((request) => request.arguments[2])).toEqual([
      "authInvites:status",
    ]);
    expect(JSON.parse(stdout.join(""))).toEqual({
      invite: terminal,
      operation: "recover",
    });
    expect(stderr).toEqual([]);
  });

  test("refuses weak or linked recovery custody before provider access", async () => {
    const directory = await makeTemporaryDirectory();
    const inviteFile = join(directory, "weak.invite");
    const linkedFile = join(directory, "linked.invite");
    const sharedDirectory = await makeTemporaryDirectory();
    const sharedFile = join(sharedDirectory, "shared.invite");
    await writeFile(inviteFile, `${capability}\n`, { mode: 0o600 });
    await symlink(inviteFile, linkedFile);
    await chmod(inviteFile, 0o644);
    await writeFile(sharedFile, `${capability}\n`, { mode: 0o600 });
    await chmod(sharedDirectory, 0o755);

    for (const candidate of [inviteFile, linkedFile, sharedFile]) {
      let runnerCalls = 0;
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(await executeHostedInviteOperator({
        arguments: ["recover", ...targetArguments, "--invite-file", candidate],
        runner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stderr: capability, stdout: JSON.stringify(issued) };
        },
        stderr: outputWriter(stderr),
        stdout: outputWriter(stdout),
        verifyTarget: async () => undefined,
      })).toBe(1);
      expect(runnerCalls).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        "Hosted invite operator refused (invite_input_refused).\n",
      ]);
    }
  });

  test("refuses existing files and symlinks before invitation issuance", async () => {
    const directory = await makeTemporaryDirectory();
    const existing = join(directory, "existing.invite");
    const linked = join(directory, "linked.invite");
    await writeFile(existing, "do-not-replace\n", { mode: 0o600 });
    await symlink(existing, linked);
    for (const output of [existing, linked]) {
      let runnerCalls = 0;
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(await executeHostedInviteOperator({
        arguments: ["issue", ...targetArguments, "--invite-output", output],
        runner: async () => {
          runnerCalls += 1;
          return { exitCode: 0, stderr: "", stdout: `${JSON.stringify(issued)}\n` };
        },
        stderr: outputWriter(stderr),
        stdout: outputWriter(stdout),
        verifyTarget: async () => undefined,
      })).toBe(1);
      expect(runnerCalls).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        "Hosted invite operator refused (invite_output_refused).\n",
      ]);
    }
    expect(await readFile(existing, "utf8")).toBe("do-not-replace\n");
  });

  test("reads bounded status by safe public identity", async () => {
    const requests: CommandRequest[] = [];
    const verifications: ConvexTarget[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedInviteOperator({
      arguments: ["status", ...targetArguments, "--public-id", publicId],
      runner: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: capability,
          stdout: `${JSON.stringify(status)}\n`,
        };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: makeVerifier(verifications),
    })).toBe(0);
    expect(verifications).toHaveLength(2);
    expect(requests.map((request) => request.arguments.slice(1))).toEqual([[
      "run",
      "authInvites:status",
      JSON.stringify({ publicId }),
      "--deployment",
      target.deploymentName,
    ]]);
    expect(JSON.parse(stdout.join(""))).toEqual({ invite: status, operation: "status" });
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(capability);
  });

  test("checks identity status before bounded revocation and returns only public state", async () => {
    const requests: CommandRequest[] = [];
    const results = [status, revoked];
    const verifications: ConvexTarget[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedInviteOperator({
      arguments: ["revoke", ...targetArguments, "--public-id", publicId],
      runner: async (request) => {
        requests.push(request);
        const result = results.shift();
        if (result === undefined) throw new Error("unexpected operator call");
        return { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(result)}\n` };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: makeVerifier(verifications),
    })).toBe(0);
    expect(verifications).toHaveLength(3);
    expect(requests.map((request) => request.arguments[2])).toEqual([
      "authInvites:status",
      "authInvites:revoke",
    ]);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
    expect(JSON.parse(stdout.join(""))).toEqual({ invite: revoked, operation: "revoke" });
    expect(stderr).toEqual([]);
    expect(`${stdout.join("")} ${stderr.join("")}`).not.toContain(capability);
  });

  test("refuses target mismatch before provider or output mutation", async () => {
    const directory = await makeTemporaryDirectory();
    const output = join(directory, "never-created.invite");
    let runnerCalls = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedInviteOperator({
      arguments: ["issue", ...targetArguments, "--invite-output", output],
      runner: async () => {
        runnerCalls += 1;
        return { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(issued)}\n` };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => {
        throw new ConvexTargetError("target_mismatch");
      },
    })).toBe(1);
    expect(runnerCalls).toBe(0);
    await expect(lstat(output)).rejects.toThrow();
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Hosted invite operator refused (convex_target_refused).\n",
    ]);
    expect(stderr.join("")).not.toContain(target.deploymentUrl);
    expect(stderr.join("")).not.toContain(capability);
  });

  test("preserves committed recovery custody when postflight target identity changes", async () => {
    const directory = await makeTemporaryDirectory();
    const output = join(directory, "postflight-refused.invite");
    let verificationCalls = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedInviteOperator({
      arguments: ["issue", ...targetArguments, "--invite-output", output],
      authorityFactory: async () => authority,
      runner: async () => ({
        exitCode: 0,
        stderr: capability,
        stdout: `${JSON.stringify(issued)}\n`,
      }),
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => {
        verificationCalls += 1;
        if (verificationCalls === 2) {
          throw new ConvexTargetError("target_mismatch");
        }
      },
    })).toBe(1);
    expect(verificationCalls).toBe(2);
    expect(await readFile(output, "utf8")).toBe(`${capability}\n`);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Hosted invite operator refused (convex_target_refused).\n",
    ]);
    expect(stderr.join("")).not.toContain(capability);
  });

  test("turns ambiguous provider results and failures into static nondisclosing refusals", async () => {
    const fakeSink = makeFakeSink();
    const issueStdout: string[] = [];
    const issueStderr: string[] = [];
    expect(await executeHostedInviteOperator({
      arguments: [
        "issue",
        ...targetArguments,
        "--invite-output",
        "/private/operator/ambiguous.invite",
      ],
      authorityFactory: async () => authority,
      reserve: async () => fakeSink.sink,
      runner: async () => ({
        exitCode: 0,
        stderr: capability,
        stdout: `${JSON.stringify(issued)}\n{}`,
      }),
      stderr: outputWriter(issueStderr),
      stdout: outputWriter(issueStdout),
      verifyTarget: async () => undefined,
    })).toBe(1);
    expect(fakeSink.commits()).toEqual([capability]);
    expect(fakeSink.aborts()).toBe(0);
    expect(issueStdout).toEqual([]);
    expect(issueStderr).toEqual([
      "Hosted invite operator refused (invite_result_invalid).\n",
    ]);

    const statusStdout: string[] = [];
    const statusStderr: string[] = [];
    expect(await executeHostedInviteOperator({
      arguments: ["status", ...targetArguments, "--public-id", publicId],
      runner: async () => ({
        exitCode: 0,
        stderr: capability,
        stdout: `${JSON.stringify({ ...status, publicId: `invite_${"Q".repeat(32)}` })}\n`,
      }),
      stderr: outputWriter(statusStderr),
      stdout: outputWriter(statusStdout),
      verifyTarget: async () => undefined,
    })).toBe(1);
    expect(statusStdout).toEqual([]);
    expect(statusStderr).toEqual([
      "Hosted invite operator refused (invite_status_result_invalid).\n",
    ]);

    let revokeCalls = 0;
    const revokeStdout: string[] = [];
    const revokeStderr: string[] = [];
    expect(await executeHostedInviteOperator({
      arguments: ["revoke", ...targetArguments, "--public-id", publicId],
      runner: async () => {
        revokeCalls += 1;
        return revokeCalls === 1
          ? { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(status)}\n` }
          : { exitCode: 1, stderr: capability, stdout: capability };
      },
      stderr: outputWriter(revokeStderr),
      stdout: outputWriter(revokeStdout),
      verifyTarget: async () => undefined,
    })).toBe(1);
    expect(revokeCalls).toBe(2);
    expect(revokeStdout).toEqual([]);
    expect(revokeStderr).toEqual([
      "Hosted invite operator refused (invite_revoke_failed).\n",
    ]);
    expect(`${issueStderr.join("")} ${statusStderr.join("")} ${revokeStderr.join("")}`)
      .not.toContain(capability);
  });

  test("refuses a revocation response that leaves an invitation live", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let calls = 0;
    expect(await executeHostedInviteOperator({
      arguments: ["revoke", ...targetArguments, "--public-id", publicId],
      runner: async () => {
        calls += 1;
        return {
          exitCode: 0,
          stderr: capability,
          stdout: `${JSON.stringify(calls === 1 ? status : { ...status, replay: false })}\n`,
        };
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => undefined,
    })).toBe(1);
    expect(calls).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      "Hosted invite operator refused (invite_revoke_result_invalid).\n",
    ]);
    expect(stderr.join("")).not.toContain(capability);
  });
});
