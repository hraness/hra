import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapHostedSync,
  executeHostedBootstrap,
  parseBootstrapArguments,
  reserveCapabilityFile,
  type CapabilitySink,
} from "./bootstrap-hosted-sync";
import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  HRA_CONVEX_TEAM_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
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

const exactTargetVerifier: ConvexTargetVerifier = async (value) => {
  expect(value).toEqual(target);
};

const capability = `hra_invite_identity_v1_${"S".repeat(43)}`;
const inviteResult = {
  capability,
  expiresAt: 1_800_000_000_000,
  publicId: `invite_${"P".repeat(32)}`,
  purpose: "identity",
  replay: false,
  state: "issued",
} as const;
const zeroAuthority = {
  _creationTime: 1_799_999_999_000,
  _id: "authority_row_1",
  enforcement: "hard",
  identities: 0,
  key: "global",
  logicalBytes: 0,
  records: 0,
  serviceLogicalBytes: 0,
  serviceRecords: 0,
  updatedAt: 1_799_999_999_000,
  userLogicalBytes: 0,
  userRecords: 0,
} as const;

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

describe("fresh hosted bootstrap", () => {
  test("runs genesis, proves the exact zero singleton, and protects the first invite without observable secrets", async () => {
    const requests: CommandRequest[] = [];
    const results = [
      { exitCode: 0, stderr: capability, stdout: "[]\n" },
      { exitCode: 0, stderr: capability, stdout: "{\n  \"enforcement\": \"hard\"\n}\n" },
      { exitCode: 0, stderr: capability, stdout: `${JSON.stringify([zeroAuthority])}\n` },
      { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(inviteResult)}\n` },
    ] as const;
    let resultIndex = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      return results[resultIndex++]!;
    };
    const fakeSink = makeFakeSink();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeHostedBootstrap({
      arguments: [
        ...targetArguments,
        "--invite-output",
        "/protected/new-invite",
      ],
      environment: {
        CONVEX_DEPLOY_KEY: capability,
        HOME: "/safe/operator",
        PATH: "/safe/bin",
      },
      reserve: async () => fakeSink.sink,
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: exactTargetVerifier,
    });

    expect(exitCode).toBe(0);
    expect(fakeSink.commits()).toEqual([capability]);
    expect(fakeSink.aborts()).toBe(0);
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.arguments.slice(1))).toEqual([
      [
        "run",
        "--inline-query",
        "return await ctx.db.query(\"storageUsageService\").take(2);",
        "--deployment",
        target.deploymentName,
      ],
      ["run", "quota:genesisHardAuthority", "{}", "--deployment", target.deploymentName],
      [
        "run",
        "--inline-query",
        "return await ctx.db.query(\"storageUsageService\").take(2);",
        "--deployment",
        target.deploymentName,
      ],
      [
        "run",
        "authInvites:issue",
        "{\"lifetimeMs\":86400000,\"purpose\":\"identity\"}",
        "--deployment",
        target.deploymentName,
      ],
    ]);
    expect(requests.every((request) => request.stdin === "")).toBe(true);
    const observable = JSON.stringify({
      arguments: requests.map((request) => request.arguments),
      environments: requests.map((request) => request.environment),
      stderr,
      stdout,
    });
    expect(observable).not.toContain(capability);
    expect(stdout).toEqual([
      "Hosted bootstrap verified hard zero authority and protected the first identity invite.\n",
    ]);
    expect(stderr).toEqual([]);
  });

  test("refuses a dirty pre-genesis authority before reserving output or mutating", async () => {
    const requests: CommandRequest[] = [];
    let reserved = false;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      return { exitCode: 0, stderr: capability, stdout: JSON.stringify([zeroAuthority]) };
    };

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

  test("refuses an existing or symlink output before genesis", async () => {
    const directory = await makeTemporaryDirectory();
    const existing = join(directory, "existing-invite");
    const linkTarget = join(directory, "target");
    const link = join(directory, "linked-invite");
    await writeFile(existing, "occupied", { mode: 0o600 });
    await writeFile(linkTarget, "target", { mode: 0o600 });
    await symlink(linkTarget, link);

    await expect(reserveCapabilityFile(existing)).rejects.toThrow("invite_output_refused");
    await expect(reserveCapabilityFile(link)).rejects.toThrow("invite_output_refused");

    const requests: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      return { exitCode: 0, stderr: "", stdout: "[]" };
    };
    await expect(bootstrapHostedSync({
      inviteOutput: existing,
      runner,
      target,
      verifyTarget: exactTargetVerifier,
    })).rejects.toThrow("invite_output_refused");
    expect(requests).toHaveLength(1);
  });

  test("writes only the capability to a new exclusive regular 0600 file", async () => {
    const directory = await makeTemporaryDirectory();
    const output = join(directory, "identity-invite");
    const sink = await reserveCapabilityFile(output);
    await sink.commit(capability);

    expect(await readFile(output, "utf8")).toBe(`${capability}\n`);
    const metadata = await stat(output);
    expect(metadata.isFile()).toBe(true);
    expect(metadata.nlink).toBe(1);
    expect(metadata.mode & 0o777).toBe(0o600);
    await expect(reserveCapabilityFile(output)).rejects.toThrow("invite_output_refused");
  });

  test("closes on ambiguous genesis and authority results and removes the reserved output", async () => {
    const scenarios = [
      {
        expected: "authority_readback_invalid",
        results: [{ exitCode: 0, stderr: capability, stdout: "[]\n{}" }],
      },
      {
        expected: "genesis_result_invalid",
        results: [
          { exitCode: 0, stderr: "", stdout: "[]" },
          { exitCode: 0, stderr: capability, stdout: "{\"enforcement\":\"shadow\"}" },
        ],
      },
      {
        expected: "authority_readback_invalid",
        results: [
          { exitCode: 0, stderr: "", stdout: "[]" },
          { exitCode: 0, stderr: "", stdout: "{\"enforcement\":\"hard\"}" },
          { exitCode: 0, stderr: capability, stdout: JSON.stringify([zeroAuthority, zeroAuthority]) },
        ],
      },
      {
        expected: "authority_readback_invalid",
        results: [
          { exitCode: 0, stderr: "", stdout: "[]" },
          { exitCode: 0, stderr: "", stdout: "{\"enforcement\":\"hard\"}" },
          {
            exitCode: 0,
            stderr: capability,
            stdout: JSON.stringify([{ ...zeroAuthority, userRecords: 1 }]),
          },
        ],
      },
      {
        expected: "invite_result_invalid",
        results: [
          { exitCode: 0, stderr: "", stdout: "[]" },
          { exitCode: 0, stderr: "", stdout: "{\"enforcement\":\"hard\"}" },
          { exitCode: 0, stderr: "", stdout: JSON.stringify([zeroAuthority]) },
          { exitCode: 0, stderr: capability, stdout: `${JSON.stringify(inviteResult)}\n{}` },
        ],
      },
    ] as const;

    for (const scenario of scenarios) {
      let index = 0;
      const fakeSink = makeFakeSink();
      const runner: CommandRunner = async () => scenario.results[index++]!;
      await expect(bootstrapHostedSync({
        inviteOutput: "/protected/new-invite",
        reserve: async () => fakeSink.sink,
        runner,
        target,
        verifyTarget: exactTargetVerifier,
      })).rejects.toThrow(scenario.expected);
      if (scenario.expected === "authority_readback_invalid" && scenario.results.length === 1) {
        expect(fakeSink.aborts()).toBe(0);
      } else {
        expect(fakeSink.aborts()).toBe(1);
      }
      expect(fakeSink.commits()).toEqual([]);
    }
  });

  test("requires one explicit deployment and one absolute new output path", () => {
    expect(parseBootstrapArguments([
      ...targetArguments,
      "--invite-output",
      "/protected/new-invite",
    ])).toEqual({
      inviteOutput: "/protected/new-invite",
      target,
    });
    expect(() => parseBootstrapArguments([
      ...targetArguments,
      "--invite-output",
      "relative-invite",
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
