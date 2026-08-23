import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRequest, CommandRunner } from "./configure-hosted-sync";
import {
  deployHostedSync,
  executeHostedDeploy,
  parseDeployArguments,
  resolvedTargetAssertionCommand,
} from "./deploy-hosted-sync";
import {
  HRA_EXPECTED_CONVEX_DEPLOY_URL,
  HRA_RESOLVED_CONVEX_DEPLOY_URL,
  resolvedConvexDeployTargetMatches,
} from "./assert-convex-deploy-target";
import {
  HRA_CONVEX_TEAM_ID,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

const sourceCommit = "a".repeat(40);
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

const makeTemporaryDirectory = async (label: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
};

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

describe("verified hosted deployment", () => {
  test("ships the Convex typecheck project required by the deploy gate", async () => {
    const configuration = JSON.parse(await readFile(
      join(import.meta.dir, "..", "convex", "tsconfig.json"),
      "utf8",
    )) as unknown;

    expect(configuration).toEqual({
      compilerOptions: {
        allowJs: true,
        allowImportingTsExtensions: true,
        allowSyntheticDefaultImports: true,
        exactOptionalPropertyTypes: true,
        forceConsistentCasingInFileNames: true,
        isolatedModules: true,
        jsx: "react-jsx",
        lib: ["ES2024", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleDetection: "force",
        moduleResolution: "Bundler",
        noEmit: true,
        noFallthroughCasesInSwitch: true,
        noImplicitOverride: true,
        noUncheckedIndexedAccess: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2024",
      },
      exclude: ["./_generated", "./**/*.test.ts", "./test.setup.ts"],
      include: ["./**/*.ts"],
    });
  });

  test("binds deploy to one exact generated target and clean source without inheriting stale selectors", async () => {
    const repositoryRoot = await makeTemporaryDirectory("hra-hosted-source-");
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-binding-");
    await writeFile(
      join(repositoryRoot, ".env.local"),
      "CONVEX_DEPLOYMENT=prod:stale-beaver-999\n",
      "utf8",
    );
    const requests: CommandRequest[] = [];
    let bindingDocument = "";
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.executable === "git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      const envFileIndex = request.arguments.indexOf("--env-file");
      const envFile = request.arguments[envFileIndex + 1];
      if (envFile === undefined) throw new Error("missing test env file");
      bindingDocument = await readFile(envFile, "utf8");
      return {
        exitCode: 0,
        stderr: "provider-stderr-sentinel",
        stdout: "provider-stdout-sentinel",
      };
    };
    const verified: ConvexTarget[] = [];
    const verifyTarget: ConvexTargetVerifier = async (value) => {
      verified.push(value);
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const badKey = "hostile-deploy-key";

    const exitCode = await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      environment: {
        CONVEX_DEPLOYMENT: "prod:stale-beaver-999",
        CONVEX_DEPLOY_KEY: badKey,
        HOME: "/operator-home",
        PATH: "/safe/bin",
      },
      repositoryRoot,
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget,
    });

    expect(exitCode).toBe(0);
    expect(verified).toEqual([target, target]);
    expect(bindingDocument).toBe(`CONVEX_DEPLOYMENT=prod:${target.deploymentName}\n`);
    const deployRequest = requests.find((request) => request.executable !== "git");
    if (deployRequest === undefined) throw new Error("missing deploy request");
    const bindingPath = deployRequest.arguments[3];
    if (bindingPath === undefined) throw new Error("missing deploy binding path");
    expect(deployRequest.arguments.slice(1)).toEqual([
      "deploy",
      "--env-file",
      bindingPath,
      "--yes",
      "--typecheck",
      "enable",
      "--codegen",
      "disable",
      "--cmd",
      resolvedTargetAssertionCommand,
      "--cmd-url-env-var-name",
      HRA_RESOLVED_CONVEX_DEPLOY_URL,
      "--skip-workos-check",
      "--message",
      `HRA source ${sourceCommit}`,
    ]);
    expect(deployRequest.environment).toEqual({
      HOME: "/operator-home",
      [HRA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
      NO_COLOR: "1",
      PATH: "/safe/bin",
      TERM: "dumb",
    });
    expect(deployRequest.timeoutMs).toBe(600_000);
    expect(deployRequest.outputMaximumBytes).toBe(524_288);
    expect(requests.filter((request) => request.executable === "git")).toHaveLength(4);
    expect(await readdir(temporaryRoot)).toEqual([]);
    expect(stdout).toEqual([`Deployed exact source ${sourceCommit} to the verified target.\n`]);
    expect(stderr).toEqual([]);
    expect(JSON.stringify({ stderr, stdout })).not.toContain("provider-stdout-sentinel");
    expect(JSON.stringify({ stderr, stdout })).not.toContain("provider-stderr-sentinel");
  });

  test("the mandatory pre-push command refuses a deployment resolved after a default switch", () => {
    const environment = {
      [HRA_EXPECTED_CONVEX_DEPLOY_URL]: target.deploymentUrl,
      [HRA_RESOLVED_CONVEX_DEPLOY_URL]: "https://other-otter-999.convex.cloud",
    };
    expect(resolvedConvexDeployTargetMatches(environment)).toBeFalse();
    expect(resolvedTargetAssertionCommand).toContain("assert-convex-deploy-target.ts");
  });

  test("refuses a dirty or wrong source before target verification or provider mutation", async () => {
    const requests: CommandRequest[] = [];
    let verifications = 0;
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (request.arguments[0] === "rev-parse") {
        return { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` };
      }
      return { exitCode: 0, stderr: "", stdout: "?? hostile-untracked\n" };
    };

    await expect(deployHostedSync({
      repositoryRoot: "/repo",
      runner,
      sourceCommit,
      target,
      verifyTarget: async () => {
        verifications += 1;
      },
    })).rejects.toThrow("source_changed");
    expect(verifications).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.executable === "git")).toBe(true);
  });

  test("always performs numeric postflight after an attempted deploy and suppresses failure output", async () => {
    const temporaryRoot = await makeTemporaryDirectory("hra-hosted-failed-binding-");
    let verification = 0;
    const runner: CommandRunner = async (request) => {
      if (request.executable === "git") {
        return request.arguments[0] === "rev-parse"
          ? { exitCode: 0, stderr: "", stdout: `${sourceCommit}\n` }
          : { exitCode: 0, stderr: "", stdout: "" };
      }
      return {
        exitCode: 1,
        stderr: "sensitive-provider-failure",
        stdout: "sensitive-provider-output",
      };
    };
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await executeHostedDeploy({
      arguments: [...targetArguments, "--source-commit", sourceCommit],
      repositoryRoot: "/repo",
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      temporaryRoot,
      verifyTarget: async () => {
        verification += 1;
      },
    });

    expect(exitCode).toBe(1);
    expect(verification).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Hosted deploy refused (convex_deploy_failed).\n"]);
    expect(JSON.stringify({ stderr, stdout })).not.toContain("sensitive-provider");
    expect(await readdir(temporaryRoot)).toEqual([]);
  });

  test("requires an exact lowercase source commit and closed target arguments", () => {
    expect(parseDeployArguments([...targetArguments, "--source-commit", sourceCommit]))
      .toEqual({ sourceCommit, target });
    expect(() => parseDeployArguments([...targetArguments, "--source-commit", "HEAD"]))
      .toThrow("usage_invalid");
    expect(() => parseDeployArguments([
      ...targetArguments.slice(0, 3),
      String(HRA_CONVEX_TEAM_ID + 1),
      ...targetArguments.slice(4),
      "--source-commit",
      sourceCommit,
    ])).toThrow("usage_invalid");
    expect(() => parseDeployArguments([
      ...targetArguments,
      "--source-commit",
      sourceCommit,
      "--force",
    ])).toThrow("usage_invalid");
  });
});
