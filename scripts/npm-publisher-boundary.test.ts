import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  assertNpmPublisherIdentity,
  type NpmPublisherSpawn,
  runNpmPublisher,
} from "./npm-publisher-boundary";

const exactIdentity = {
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-token",
  ACTIONS_ID_TOKEN_REQUEST_URL: [
    "https://run-actions-2-azure-eastus.actions.githubusercontent.com",
    "/42//idtoken/baeb7e3d-e9ad-46b9-a14d-337ef0e89b86",
    "/60484a81-4a45-58ac-ae75-cc1f68fcca0e/?api-version=2.0",
  ].join(""),
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "push",
  GITHUB_JOB: "publish",
  GITHUB_REF: "refs/tags/v0.5.0",
  GITHUB_REF_NAME: "v0.5.0",
  GITHUB_REF_TYPE: "tag",
  GITHUB_REPOSITORY: "hraness/hra",
  GITHUB_REPOSITORY_ID: "1343008607",
  GITHUB_REPOSITORY_OWNER: "hraness",
  GITHUB_REPOSITORY_OWNER_ID: "307125679",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_WORKFLOW: "Release",
  GITHUB_WORKFLOW_REF: "hraness/hra/.github/workflows/release.yml@refs/tags/v0.5.0",
  GITHUB_WORKFLOW_SHA: "a".repeat(40),
  RUNNER_ENVIRONMENT: "github-hosted",
} as const;

const stream = (value: string | Uint8Array): ReadableStream<Uint8Array> => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};

function fixedSpawn(input: Readonly<{
  exitCode?: number;
  stderr?: string | Uint8Array;
  stdout?: string | Uint8Array;
}>): NpmPublisherSpawn {
  return () => ({
    exited: Promise.resolve(input.exitCode ?? 0),
    kill: () => undefined,
    stderr: stream(input.stderr ?? ""),
    stdout: stream(input.stdout ?? ""),
  });
}

describe("npm trusted-publisher boundary", () => {
  test("requires the exact GitHub-hosted HRA release identity", () => {
    expect(() => assertNpmPublisherIdentity(exactIdentity, "v0.5.0", "a".repeat(40)))
      .not.toThrow();
    for (const key of Object.keys(exactIdentity)) {
      expect(() => assertNpmPublisherIdentity(
        { ...exactIdentity, [key]: undefined },
        "v0.5.0",
        "a".repeat(40),
      ), key).toThrow("exact GitHub-hosted release OIDC identity");
    }
    expect(() => assertNpmPublisherIdentity(exactIdentity, "v0.1.8", "a".repeat(40))).toThrow();
    expect(() => assertNpmPublisherIdentity(exactIdentity, "v0.5.0", "b".repeat(40))).toThrow();
  });

  test("accepts current and legacy GitHub-hosted OIDC endpoints", () => {
    const workflowBackend = "baeb7e3d-e9ad-46b9-a14d-337ef0e89b86";
    const jobBackend = "60484a81-4a45-58ac-ae75-cc1f68fcca0e";
    for (const url of [
      exactIdentity.ACTIONS_ID_TOKEN_REQUEST_URL,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/0//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/1234567890//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      [
        "https://pipelinesghubeus13.actions.githubusercontent.com",
        "/opaque/00000000-0000-0000-0000-000000000000",
        "/_apis/distributedtask/hubs/Actions/plans/1/jobs/2/idtoken?api-version=2.0",
      ].join(""),
    ]) {
      expect(() => assertNpmPublisherIdentity(
        { ...exactIdentity, ACTIONS_ID_TOKEN_REQUEST_URL: url },
        "v0.5.0",
        "a".repeat(40),
      ), url).not.toThrow();
    }
  });

  test("rejects OIDC bearer-token exfiltration URLs", () => {
    const workflowBackend = "baeb7e3d-e9ad-46b9-a14d-337ef0e89b86";
    const jobBackend = "60484a81-4a45-58ac-ae75-cc1f68fcca0e";
    for (const url of [
      "http://pipelines.actions.githubusercontent.com/opaque/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0",
      "https://actions.githubusercontent.com/opaque/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0",
      "https://pipelines.actions.githubusercontent.com.evil.invalid/opaque/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0",
      "https://pipelines.actions.githubusercontent.com/opaque/%5fapis/distributedtask/hubs/Actions/idtoken?api-version=2.0",
      "https://pipelines.actions.githubusercontent.com/opaque/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0#fragment",
      "https://user@pipelines.actions.githubusercontent.com/opaque/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0",
      "https://pipelines.actions.githubusercontent.com/opaque/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0&audience=evil",
      "https://evil.invalid/opaque/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0",
      `https://actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com.evil.invalid/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com:444/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://user@run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42/idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42///idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42/%2Fidtoken/${workflowBackend}/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/not-a-uuid/${jobBackend}/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/not-a-uuid/?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/extra?api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=1.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0&api-version=2.0`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?audience=evil`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?%61udience=evil`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?unknown=1`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0&extra=1`,
      `https://run-actions-2-azure-eastus.actions.githubusercontent.com/42//idtoken/${workflowBackend}/${jobBackend}/?api-version=2.0#fragment`,
      `https://pipelines.actions.githubusercontent.com/${"a".repeat(4_096)}/_apis/distributedtask/hubs/Actions/idtoken?api-version=2.0`,
    ]) {
      expect(() => assertNpmPublisherIdentity(
        { ...exactIdentity, ACTIONS_ID_TOKEN_REQUEST_URL: url },
        "v0.5.0",
        "a".repeat(40),
      ), url).toThrow("exact GitHub-hosted release OIDC identity");
    }
  });

  test("uses a dry-run-only flag and a credential-minimal npm environment", async () => {
    const invocations: Array<{
      argv: readonly string[];
      env: Record<string, string>;
    }> = [];
    const spawn: NpmPublisherSpawn = (argv, options) => {
      const userConfig = options.env.NPM_CONFIG_USERCONFIG;
      const globalConfig = options.env.NPM_CONFIG_GLOBALCONFIG;
      expect(userConfig).toBeDefined();
      expect(globalConfig).toBeDefined();
      expect(userConfig).not.toBe(globalConfig);
      expect(dirname(userConfig!)).toBe(dirname(globalConfig!));
      expect(statSync(dirname(userConfig!)).mode & 0o777).toBe(0o700);
      for (const config of [userConfig!, globalConfig!]) {
        expect(statSync(config).isFile()).toBe(true);
        expect(statSync(config).mode & 0o777).toBe(0o600);
        expect(readFileSync(config, "utf8")).toBe("");
      }
      invocations.push({ argv, env: options.env });
      return fixedSpawn({
        stderr: "npm verbose oidc Successfully retrieved and set token\n",
      })(argv, options);
    };
    const source = {
      ...exactIdentity,
      GH_TOKEN: "github-secret",
      HOME: "/home/runner",
      NODE_AUTH_TOKEN: "npm-secret",
      NPM_CONFIG_USERCONFIG: "/private/npmrc",
      NPM_TOKEN: "npm-secret",
      PATH: "/usr/bin:/bin",
      UNRELATED_SECRET: "private",
    };
    const dryRun = await runNpmPublisher({
      dryRun: true,
      source,
      tarball: "/tmp/hra.tgz",
    }, { spawn });
    const live = await runNpmPublisher({
      dryRun: false,
      source,
      tarball: "/tmp/hra.tgz",
    }, { spawn });
    expect(dryRun).toEqual({ exitCode: 0, failure: null, trustedExchangeProven: true });
    expect(live).toEqual({ exitCode: 0, failure: null, trustedExchangeProven: true });
    expect(invocations).toHaveLength(2);
    expect(invocations[0]?.argv).toContain("--dry-run");
    expect(invocations[1]?.argv).not.toContain("--dry-run");
    for (const invocation of invocations) {
      for (const argument of ["npm", "publish", "/tmp/hra.tgz", "--ignore-scripts", "--provenance"]) {
        expect(invocation.argv).toContain(argument);
      }
      expect(invocation.env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmjs.org");
      expect(invocation.env.NPM_CONFIG_USERCONFIG).not.toBe("/dev/null");
      expect(invocation.env.NPM_CONFIG_GLOBALCONFIG).not.toBe("/dev/null");
      expect(invocation.env.NPM_CONFIG_USERCONFIG)
        .not.toBe(invocation.env.NPM_CONFIG_GLOBALCONFIG);
      expect(existsSync(invocation.env.NPM_CONFIG_USERCONFIG!)).toBe(false);
      expect(existsSync(invocation.env.NPM_CONFIG_GLOBALCONFIG!)).toBe(false);
      expect(existsSync(dirname(invocation.env.NPM_CONFIG_USERCONFIG!))).toBe(false);
      expect(invocation.env).not.toHaveProperty("GH_TOKEN");
      expect(invocation.env).not.toHaveProperty("NODE_AUTH_TOKEN");
      expect(invocation.env).not.toHaveProperty("NPM_TOKEN");
      expect(invocation.env).not.toHaveProperty("UNRELATED_SECRET");
    }
    expect(invocations[0]?.env.NPM_CONFIG_USERCONFIG)
      .not.toBe(invocations[1]?.env.NPM_CONFIG_USERCONFIG);
  });

  test("loads the distinct empty configs with the real npm client", async () => {
    const version = Bun.spawnSync(["npm", "--version"], {
      env: { PATH: process.env.PATH ?? "" },
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/u);

    let userConfig: string | undefined;
    let globalConfig: string | undefined;
    const spawn: NpmPublisherSpawn = (_argv, options) => {
      userConfig = options.env.NPM_CONFIG_USERCONFIG;
      globalConfig = options.env.NPM_CONFIG_GLOBALCONFIG;
      return Bun.spawn(["npm", "--version"], options);
    };
    const result = await runNpmPublisher({
      dryRun: true,
      source: {
        ...exactIdentity,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
      },
      tarball: "/tmp/hra.tgz",
    }, { spawn });
    expect(result).toEqual({
      exitCode: 0,
      failure: "trusted_exchange_not_proven",
      trustedExchangeProven: false,
    });
    expect(userConfig).toBeDefined();
    expect(globalConfig).toBeDefined();
    expect(userConfig).not.toBe(globalConfig);
    expect(existsSync(userConfig!)).toBe(false);
    expect(existsSync(globalConfig!)).toBe(false);
    expect(existsSync(dirname(userConfig!))).toBe(false);
  });

  test("returns only allowlisted failure classes and never provider output", async () => {
    const secret = "PRIVATE_MESSAGE_BODY";
    const cases = [
      ["Skipped because incorrect permissions for id-token within GitHub workflow", "github_oidc_permission_missing"],
      ["Failed to fetch id_token from GitHub", "github_oidc_fetch_failed"],
      ["Failed token exchange request with body message", "oidc_exchange_rejected"],
      ["npm error code E401", "authentication_failed"],
      ["npm error code E403", "authorization_rejected"],
      ["npm error code ETIMEDOUT", "network_failed"],
      ["You cannot publish over the previously published versions", "version_conflict"],
      ["sigstore failure", "provenance_failed"],
      [
        "Exit prior to config file resolving\ncause\ndouble-loading config \"PRIVATE_MESSAGE_BODY\"",
        "publisher_configuration_failed",
      ],
    ] as const;
    for (const [output, failure] of cases) {
      const result = await runNpmPublisher({
        dryRun: true,
        source: exactIdentity,
        tarball: "/tmp/hra.tgz",
      }, { spawn: fixedSpawn({ exitCode: 1, stderr: `${secret}\n${output}\n` }) });
      expect(result.failure, output).toBe(failure);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    const withoutMarker = await runNpmPublisher({
      dryRun: true,
      source: exactIdentity,
      tarball: "/tmp/hra.tgz",
    }, { spawn: fixedSpawn({ stderr: secret }) });
    expect(withoutMarker).toEqual({
      exitCode: 0,
      failure: "trusted_exchange_not_proven",
      trustedExchangeProven: false,
    });
    const genericAfterExchange = await runNpmPublisher({
      dryRun: false,
      source: exactIdentity,
      tarball: "/tmp/hra.tgz",
    }, {
      spawn: fixedSpawn({
        exitCode: 1,
        stderr: [
          "npm verbose argv publish /tmp/hra.tgz --provenance",
          "npm verbose oidc Successfully retrieved and set token",
          "private unknown failure",
        ].join("\n"),
      }),
    });
    expect(genericAfterExchange.failure).toBe("post_exchange_failed");
  });

  test("kills and classifies aggregate output overflow", async () => {
    let kills = 0;
    const oversized = new Uint8Array(600 * 1024);
    const spawn: NpmPublisherSpawn = () => ({
      exited: Promise.resolve(137),
      kill: () => { kills += 1; },
      stderr: stream(oversized),
      stdout: stream(oversized),
    });
    const result = await runNpmPublisher({
      dryRun: true,
      source: exactIdentity,
      tarball: "/tmp/hra.tgz",
    }, { spawn });
    expect(result.failure).toBe("output_limit_exceeded");
    expect(kills).toBeGreaterThan(0);
  });

  test("kills and classifies a bounded timeout", async () => {
    let kills = 0;
    let settle: ((value: number) => void) | undefined;
    const exited = new Promise<number>((resolve) => { settle = resolve; });
    const spawn: NpmPublisherSpawn = () => ({
      exited,
      kill: () => {
        kills += 1;
        settle?.(137);
      },
      stderr: stream(""),
      stdout: stream(""),
    });
    const result = await runNpmPublisher({
      dryRun: true,
      source: exactIdentity,
      tarball: "/tmp/hra.tgz",
    }, { spawn, timeoutMilliseconds: 5 });
    expect(result.failure).toBe("publisher_timed_out");
    expect(kills).toBe(1);
  });

  test("classifies a synchronous child-process launch failure", async () => {
    let userConfig: string | undefined;
    const result = await runNpmPublisher({
      dryRun: false,
      source: exactIdentity,
      tarball: "/tmp/hra.tgz",
    }, {
      spawn: (_argv, options) => {
        userConfig = options.env.NPM_CONFIG_USERCONFIG;
        throw new Error("private launch failure");
      },
    });
    expect(result).toEqual({
      exitCode: 1,
      failure: "publisher_process_failed",
      trustedExchangeProven: false,
    });
    expect(userConfig).toBeDefined();
    expect(existsSync(userConfig!)).toBe(false);
    expect(existsSync(dirname(userConfig!))).toBe(false);
  });

  test("classifies private configuration cleanup failure without leaking paths", async () => {
    let directory: string | undefined;
    const result = await runNpmPublisher({
      dryRun: true,
      source: exactIdentity,
      tarball: "/tmp/hra.tgz",
    }, {
      spawn: (argv, options) => {
        directory = dirname(options.env.NPM_CONFIG_USERCONFIG!);
        writeFileSync(join(directory, "unexpected-private-file"), "private", {
          flag: "wx",
          mode: 0o600,
        });
        return fixedSpawn({
          stderr: "npm verbose oidc Successfully retrieved and set token\n",
        })(argv, options);
      },
    });
    try {
      expect(result).toEqual({
        exitCode: 0,
        failure: "publisher_configuration_cleanup_failed",
        trustedExchangeProven: true,
      });
      expect(JSON.stringify(result)).not.toContain(directory!);
    } finally {
      if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
    }
  });
});
