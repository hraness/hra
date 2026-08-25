import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getDocumentSize } from "convex/values";

import {
  digestInviteCapability,
  identityInviteLifetimeMs,
  invitePublicIdFromCapabilityDigest,
} from "../src/cloud/inviteAuthority";

import {
  bootstrapHostedSync,
  executeHostedBootstrap,
  parseBootstrapArguments,
  readProtectedInviteCapability,
  recoverHostedBootstrap,
  reserveCapabilityFile,
  type CapabilitySink,
} from "./bootstrap-hosted-sync";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
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

const exactTargetVerifier: ConvexTargetVerifier = async (value) => {
  expect(value).toEqual(target);
};

const capability = `hra_invite_identity_v1_${"S".repeat(43)}`;
const capabilityDigest = await digestInviteCapability(capability, "identity");
const publicId = invitePublicIdFromCapabilityDigest(capabilityDigest);
const authority = { capability, capabilityDigest, publicId } as const;
const bootstrapAt = 1_799_913_600_000;
const expiresAt = bootstrapAt + identityInviteLifetimeMs;
const bootstrapInvite = {
  _creationTime: bootstrapAt,
  _id: "bootstrap_invite_row_1",
  admissionExpiresAt: expiresAt,
  capabilityDigest,
  createdAt: bootstrapAt,
  expiresAt,
  publicId,
  purpose: "identity",
  requestedLifetimeMs: identityInviteLifetimeMs,
  state: "issued",
  updatedAt: bootstrapAt,
} as const;
const inviteLogicalBytes = getDocumentSize(bootstrapInvite);
const hostedAuthority = {
  _creationTime: bootstrapAt,
  _id: "authority_row_1",
  enforcement: "hard",
  identities: 0,
  key: "global",
  logicalBytes: inviteLogicalBytes,
  records: 1,
  serviceLogicalBytes: inviteLogicalBytes,
  serviceRecords: 1,
  updatedAt: bootstrapAt,
  userLogicalBytes: 0,
  userRecords: 0,
} as const;
const hostedControl = {
  _creationTime: bootstrapAt,
  _id: "control_row_1",
  authAdmissionGeneration: 0,
  authAdmissions: "open",
  bootstrapCompletedAt: bootstrapAt,
  bootstrapInviteCapabilityDigest: capabilityDigest,
  bootstrapInviteLifetimeMs: identityInviteLifetimeMs,
  bootstrapInvitePublicId: publicId,
  key: "global",
  updatedAt: bootstrapAt,
} as const;
const emptyAuthority = {
  control: [],
  invites: [],
  maintenance: [],
  quota: [],
} as const;
const authorityReadback = {
  control: [hostedControl],
  invites: [bootstrapInvite],
  quota: [hostedAuthority],
} as const;
const genesisResult = {
  enforcement: "hard",
  invite: {
    expiresAt,
    publicId,
    purpose: "identity",
    state: "issued",
  },
  replay: false,
} as const;
const publicInviteResult = {
  expiresAt,
  publicId,
  purpose: "identity",
  replay: false,
  state: "issued",
} as const;
const authorityQuery = "return {quota:await ctx.db.query(\"storageUsageService\").take(2),control:await ctx.db.query(\"serviceControl\").take(2),invites:await ctx.db.query(\"authInvites\").take(2)};";
const preGenesisQuery = "return {quota:await ctx.db.query(\"storageUsageService\").take(2),control:await ctx.db.query(\"serviceControl\").take(2),maintenance:await ctx.db.query(\"maintenanceState\").take(2),invites:await ctx.db.query(\"authInvites\").take(2)};";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const makeTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "hra-hosted-bootstrap-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

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
      async abort() {
        aborts += 1;
      },
      async commit(value) {
        commits.push(value);
      },
    },
  };
};

const sequenceRunner = (
  results: readonly Readonly<{ exitCode: number; stderr: string; stdout: string }>[],
  requests: CommandRequest[] = [],
): Readonly<{ requests: CommandRequest[]; runner: CommandRunner }> => {
  let index = 0;
  return {
    requests,
    runner: async (request) => {
      requests.push(request);
      const result = results[index];
      index += 1;
      if (result === undefined) throw new Error("unexpected command");
      return result;
    },
  };
};

describe("fresh hosted bootstrap", () => {
  test("atomically creates exact authority and first invite without exposing capability custody", async () => {
    const { requests, runner } = sequenceRunner([
      { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(emptyAuthority)}\n` },
      { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(genesisResult)}\n` },
      { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(authorityReadback)}\n` },
    ]);
    const fakeSink = makeFakeSink();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let verifications = 0;

    const exitCode = await executeHostedBootstrap({
      arguments: [...targetArguments, "--invite-output", "/protected/new-invite"],
      authorityFactory: async () => authority,
      environment: {
        CONVEX_DEPLOY_KEY: capability,
        HOME: "/safe/operator",
        PATH: "/safe/bin",
        TMPDIR: `/safe/${capability}`,
      },
      reserve: async () => fakeSink.sink,
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async (value) => {
        await exactTargetVerifier(value);
        verifications += 1;
      },
    });

    expect(exitCode).toBe(0);
    expect(fakeSink.commits()).toEqual([capability]);
    expect(fakeSink.aborts()).toBe(0);
    expect(verifications).toBe(3);
    expect(requests.map((request) => request.arguments.slice(1))).toEqual([
      [
        "run",
        "--inline-query",
        preGenesisQuery,
        "--deployment",
        target.deploymentName,
      ],
      [
        "run",
        "quota:genesisHostedAuthority",
        JSON.stringify({
          capabilityDigest,
          lifetimeMs: identityInviteLifetimeMs,
          publicId,
        }),
        "--deployment",
        target.deploymentName,
      ],
      [
        "run",
        "--inline-query",
        authorityQuery,
        "--deployment",
        target.deploymentName,
      ],
    ]);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
    expect(requests.every((request) => request.containment === "authority")).toBe(true);
    expect(requests.every((request) => request.outputMaximumBytes === 64 * 1_024))
      .toBe(true);
    expect(requests.every((request) => request.timeoutMs === 60_000)).toBe(true);
    expect(requests.every((request) => request.environment.TMPDIR === undefined)).toBe(true);
    const observable = JSON.stringify({
      arguments: requests.map((request) => request.arguments),
      environments: requests.map((request) => request.environment),
      stderr,
      stdout,
    });
    expect(observable).not.toContain(capability);
    expect(JSON.parse(stdout.join(""))).toEqual({
      invite: publicInviteResult,
      operation: "bootstrap",
    });
    expect(stderr).toEqual([]);
  });

  test("refuses dirty authority before reserving output or mutating", async () => {
    const { requests, runner } = sequenceRunner([{
      exitCode: 0,
      stderr: capability,
      stdout: JSON.stringify({ ...emptyAuthority, quota: [hostedAuthority] }),
    }]);
    let reserved = false;

    await expect(bootstrapHostedSync({
      inviteOutput: "/protected/new-invite",
      reserve: async () => {
        reserved = true;
        return makeFakeSink().sink;
      },
      runner,
      target,
      verifyTarget: exactTargetVerifier,
    })).rejects.toThrow("authority_dirty");
    expect(requests).toHaveLength(1);
    expect(reserved).toBe(false);
  });

  test("reconciles a lost or malformed mutation response only through exact readback", async () => {
    for (const mutation of [
      { exitCode: 1, stderr: "transport lost", stdout: "" },
      { exitCode: 0, stderr: "", stdout: "{malformed" },
    ]) {
      const { runner } = sequenceRunner([
        { exitCode: 0, stderr: "", stdout: JSON.stringify(emptyAuthority) },
        mutation,
        { exitCode: 0, stderr: "", stdout: JSON.stringify(authorityReadback) },
      ]);
      const fakeSink = makeFakeSink();
      const result = await bootstrapHostedSync({
        authorityFactory: async () => authority,
        inviteOutput: "/protected/new-invite",
        reserve: async () => fakeSink.sink,
        runner,
        target,
        verifyTarget: exactTargetVerifier,
      });
      expect(result).toEqual({
        invite: { ...publicInviteResult, replay: true },
        operation: "bootstrap",
      });
      expect(fakeSink.commits()).toEqual([capability]);
      expect(fakeSink.aborts()).toBe(0);
    }
  });

  test("keeps committed custody and refuses empty, conflicting, or undercharged readback", async () => {
    const scenarios = [
      {
        expected: "genesis_failed",
        mutation: { exitCode: 1, stderr: "lost", stdout: "" },
        readback: { control: [], invites: [], quota: [] },
      },
      {
        expected: "genesis_result_invalid",
        mutation: { exitCode: 0, stderr: "", stdout: "{malformed" },
        readback: { control: [], invites: [], quota: [] },
      },
      {
        expected: "bootstrap_authority_conflict",
        mutation: { exitCode: 1, stderr: "refused", stdout: "" },
        readback: {
          ...authorityReadback,
          quota: [{
            ...hostedAuthority,
            logicalBytes: inviteLogicalBytes - 1,
            serviceLogicalBytes: inviteLogicalBytes - 1,
          }],
        },
      },
      {
        expected: "bootstrap_authority_conflict",
        mutation: { exitCode: 1, stderr: "refused", stdout: "" },
        readback: {
          ...authorityReadback,
          control: [{ ...hostedControl, bootstrapInviteCapabilityDigest: "f".repeat(64) }],
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      const { runner } = sequenceRunner([
        { exitCode: 0, stderr: "", stdout: JSON.stringify(emptyAuthority) },
        scenario.mutation,
        { exitCode: 0, stderr: "", stdout: JSON.stringify(scenario.readback) },
      ]);
      const fakeSink = makeFakeSink();
      await expect(bootstrapHostedSync({
        authorityFactory: async () => authority,
        inviteOutput: "/protected/new-invite",
        reserve: async () => fakeSink.sink,
        runner,
        target,
        verifyTarget: exactTargetVerifier,
      })).rejects.toThrow(scenario.expected);
      expect(fakeSink.commits()).toEqual([capability]);
      expect(fakeSink.aborts()).toBe(0);
    }
  });
});

describe("bootstrap recovery", () => {
  test("replays only the exact atomic bootstrap authority from the protected file", async () => {
    const { requests, runner } = sequenceRunner([
      {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ ...genesisResult, replay: true }),
      },
      { exitCode: 0, stderr: "", stdout: JSON.stringify(authorityReadback) },
    ]);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeHostedBootstrap({
      arguments: [
        "recover",
        ...targetArguments,
        "--invite-file",
        "/protected/bootstrap-invite",
      ],
      readCapability: async (value) => {
        expect(value).toBe("/protected/bootstrap-invite");
        return capability;
      },
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: exactTargetVerifier,
    });

    expect(exitCode).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.arguments).toContain("quota:genesisHostedAuthority");
    expect(requests[0]?.arguments).not.toContain("authInvites:recordIssue");
    expect(JSON.parse(stdout.join(""))).toEqual({
      invite: { ...publicInviteResult, replay: true },
      operation: "recover",
    });
    expect(JSON.stringify({ requests, stderr, stdout })).not.toContain(capability);
  });

  test("recovers a crash before mutation and reconciles a crash after mutation", async () => {
    for (const mutation of [
      { exitCode: 0, stderr: "", stdout: JSON.stringify(genesisResult) },
      { exitCode: 1, stderr: "transport lost", stdout: "" },
    ]) {
      const { runner } = sequenceRunner([
        mutation,
        { exitCode: 0, stderr: "", stdout: JSON.stringify(authorityReadback) },
      ]);
      const result = await recoverHostedBootstrap({
        inviteFile: "/protected/bootstrap-invite",
        readCapability: async () => capability,
        runner,
        target,
        verifyTarget: exactTargetVerifier,
      });
      expect(result.operation).toBe("recover");
      expect(result.invite.replay).toBe(mutation.exitCode !== 0);
    }
  });

  test("refuses a concurrent winner with a different full bootstrap binding", async () => {
    const otherDigest = "f".repeat(64);
    const { runner } = sequenceRunner([
      { exitCode: 1, stderr: "refused", stdout: "" },
      {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ...authorityReadback,
          control: [{
            ...hostedControl,
            bootstrapInviteCapabilityDigest: otherDigest,
            bootstrapInvitePublicId: invitePublicIdFromCapabilityDigest(otherDigest),
          }],
        }),
      },
    ]);
    await expect(recoverHostedBootstrap({
      inviteFile: "/protected/loser-invite",
      readCapability: async () => capability,
      runner,
      target,
      verifyTarget: exactTargetVerifier,
    })).rejects.toThrow("bootstrap_authority_conflict");
  });
});

describe("bootstrap capability custody", () => {
  test("writes and rereads only one capability in an owned private directory", async () => {
    const directory = await makeTemporaryDirectory();
    const output = join(directory, "identity-invite");
    const sink = await reserveCapabilityFile(output);
    await sink.commit(capability);

    expect(await readFile(output, "utf8")).toBe(`${capability}\n`);
    expect(await readProtectedInviteCapability(output)).toBe(capability);
    const metadata = await stat(output);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
    await expect(reserveCapabilityFile(output)).rejects.toThrow("invite_output_refused");
  });

  test("refuses existing, symlinked, shared-parent, or weakened recovery paths", async () => {
    const directory = await makeTemporaryDirectory();
    const existing = join(directory, "existing-invite");
    const linkTarget = join(directory, "target");
    const link = join(directory, "linked-invite");
    await writeFile(existing, `${capability}\n`, { mode: 0o600 });
    await writeFile(linkTarget, `${capability}\n`, { mode: 0o600 });
    await symlink(linkTarget, link);

    await expect(reserveCapabilityFile(existing)).rejects.toThrow("invite_output_refused");
    await expect(reserveCapabilityFile(link)).rejects.toThrow("invite_output_refused");
    await expect(readProtectedInviteCapability(link)).rejects.toThrow("invite_input_refused");

    await chmod(existing, 0o644);
    await expect(readProtectedInviteCapability(existing))
      .rejects.toThrow("invite_input_refused");
    await chmod(existing, 0o600);
    await chmod(directory, 0o755);
    await expect(readProtectedInviteCapability(existing))
      .rejects.toThrow("invite_input_refused");
    await expect(reserveCapabilityFile(join(directory, "new-invite")))
      .rejects.toThrow("invite_output_refused");
  });

  test("aborts an uncommitted reservation but preserves committed recovery custody", async () => {
    const uncommitted = makeFakeSink();
    const { runner: dirtyRunner } = sequenceRunner([{
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify(emptyAuthority),
    }]);
    await expect(bootstrapHostedSync({
      authorityFactory: async () => ({ ...authority, publicId: "invite_invalid" }),
      inviteOutput: "/protected/new-invite",
      reserve: async () => uncommitted.sink,
      runner: dirtyRunner,
      target,
      verifyTarget: exactTargetVerifier,
    })).rejects.toThrow("invite_result_invalid");
    expect(uncommitted.aborts()).toBe(1);
    expect(uncommitted.commits()).toEqual([]);

    const committed = makeFakeSink();
    const { runner: failedRunner } = sequenceRunner([
      { exitCode: 0, stderr: "", stdout: JSON.stringify(emptyAuthority) },
      { exitCode: 1, stderr: "lost", stdout: "" },
      { exitCode: 0, stderr: "", stdout: JSON.stringify({ control: [], invites: [], quota: [] }) },
    ]);
    await expect(bootstrapHostedSync({
      authorityFactory: async () => authority,
      inviteOutput: "/protected/new-invite",
      reserve: async () => committed.sink,
      runner: failedRunner,
      target,
      verifyTarget: exactTargetVerifier,
    })).rejects.toThrow("genesis_failed");
    expect(committed.aborts()).toBe(0);
    expect(committed.commits()).toEqual([capability]);
  });

  test("surfaces genesis cleanup uncertainty without reconciliation or postflight", async () => {
    const sink = makeFakeSink();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let runnerCalls = 0;
    let verifications = 0;
    expect(await executeHostedBootstrap({
      arguments: [...targetArguments, "--invite-output", "/protected/new-invite"],
      authorityFactory: async () => authority,
      reserve: async () => sink.sink,
      runner: async () => {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(emptyAuthority) };
        }
        throw new BoundedProcessCleanupUnprovenError(
          43_222,
          "hosted-bootstrap-genesis",
        );
      },
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: async () => { verifications += 1; },
    })).toBe(75);
    expect(runnerCalls).toBe(2);
    expect(verifications).toBe(1);
    expect(sink.commits()).toEqual([capability]);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      code: "process_cleanup_unproven",
      phase: "hosted-bootstrap-genesis",
      recoveryPaths: ["/protected/new-invite"],
      status: "recovery_required",
    });
  });

  test("preserves a genesis recovery journal without target postflight or reconciliation", async () => {
    const sink = makeFakeSink();
    const stdout: string[] = [];
    const stderr: string[] = [];
    let runnerCalls = 0;
    let verifications = 0;
    const recoveryPath = "/private/operator/process-recovery/authority-bootstrap.json";
    expect(await executeHostedBootstrap({
      arguments: [...targetArguments, "--invite-output", "/protected/new-invite"],
      authorityFactory: async () => authority,
      reserve: async () => sink.sink,
      runner: async () => {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(emptyAuthority) };
        }
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
    expect(runnerCalls).toBe(2);
    expect(verifications).toBe(1);
    expect(sink.commits()).toEqual([capability]);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "process_recovery_journal_blocked",
      reason: "authority_recovery_required",
      recoveryPaths: [recoveryPath, "/protected/new-invite"],
      schemaVersion: 1,
      status: "recovery_required",
    });
  });

  test("refuses an unavailable authority backend without issuing a reconciliation read", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let runnerCalls = 0;
    let verifications = 0;
    expect(await executeHostedBootstrap({
      arguments: [...targetArguments, "--invite-output", "/protected/new-invite"],
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

describe("bootstrap command grammar", () => {
  test("requires an exact target and one absolute initialize or recovery path", () => {
    expect(parseBootstrapArguments([
      ...targetArguments,
      "--invite-output",
      "/protected/new-invite",
    ])).toEqual({
      operation: { inviteOutput: "/protected/new-invite", kind: "initialize" },
      target,
    });
    expect(parseBootstrapArguments([
      "recover",
      ...targetArguments,
      "--invite-file",
      "/protected/bootstrap-invite",
    ])).toEqual({
      operation: { inviteFile: "/protected/bootstrap-invite", kind: "recover" },
      target,
    });
    expect(() => parseBootstrapArguments([
      ...targetArguments,
      "--invite-output",
      "relative-invite",
    ])).toThrow("usage_invalid");
    expect(() => parseBootstrapArguments([
      ...targetArguments,
      "recover",
      "--invite-file",
      `/protected/${capability}`,
    ])).toThrow("usage_invalid");
    expect(() => parseBootstrapArguments([
      ...targetArguments.slice(0, 3),
      String(HRA_CONVEX_TEAM_ID + 1),
      ...targetArguments.slice(4),
      "--invite-output",
      "/protected/new-invite",
    ])).toThrow("usage_invalid");
    expect(() => parseBootstrapArguments([
      ...targetArguments,
      "--invite-output",
      "/protected/new-invite",
      "--force",
    ])).toThrow("usage_invalid");
  });
});
