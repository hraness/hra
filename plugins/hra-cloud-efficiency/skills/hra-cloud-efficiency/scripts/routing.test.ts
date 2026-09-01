import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  decideRoute,
  dispatchPacketHeader,
  inspectRepository,
  parseGitHubRepository,
  parseRouteArguments,
  routeTask,
} from "./routing";
import { command } from "./shared";
import type { CommandRunner } from "./shared";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(root: string, ...arguments_: string[]): string {
  const result = command(["git", ...arguments_], root);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function repositoryFixture(branch = "main", defaultBranch = "main"): string {
  const root = mkdtempSync(join(tmpdir(), "hra-cloud-route-"));
  temporary.push(root);
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.com");
  writeFileSync(join(root, "README.md"), "fixture\n");
  git(root, "add", "README.md");
  git(root, "commit", "-m", "fixture");
  if (branch !== "main") git(root, "switch", "-c", branch);
  git(root, "remote", "add", "origin", "https://github.com/hraness/fixture.git");
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", `refs/remotes/origin/${branch}`, head);
  git(root, "update-ref", `refs/remotes/origin/${defaultBranch}`, head);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${defaultBranch}`);
  git(root, "config", `branch.${branch}.remote`, "origin");
  git(root, "config", `branch.${branch}.merge`, `refs/heads/${branch}`);
  return root;
}

function routeArguments(root: string, extra: readonly string[] = []): readonly string[] {
  return [
    "--root", root,
    "--intent", "read-only",
    "--owner", "fixture-owner",
    "--profile", "portable-bun",
    "--model-policy", "cloud-default-ok",
    ...extra,
  ];
}

describe("Cloud route arguments", () => {
  test("requires explicit intent, owner, profile, and model policy", () => {
    expect(() => parseRouteArguments([])).toThrow("--intent is required");
    expect(() => parseRouteArguments(["--intent", "read-only"])).toThrow("--model-policy");
    expect(() => parseRouteArguments([
      "--intent", "read-only",
      "--model-policy", "cloud-default-ok",
      "--owner", "owner",
    ])).toThrow("--profile");
    expect(() => parseRouteArguments([
      ...routeArguments(repositoryFixture()),
      "--json",
      "--packet",
    ])).toThrow("only one");
  });

  test("deduplicates and validates local-only requirements", () => {
    const root = repositoryFixture();
    const options = parseRouteArguments(routeArguments(root, [
      "--needs", "mac-native",
      "--needs", "mac-native",
      "--final-needs", "production-mutation",
    ]));
    expect(options.needs).toEqual(["mac-native"]);
    expect(options.finalNeeds).toEqual(["production-mutation"]);
    expect(() => parseRouteArguments(routeArguments(root, ["--needs", "unknown"])))
      .toThrow("must be one of");
  });
});

describe("Cloud repository qualification", () => {
  test("qualifies one clean exact local tracking branch without exposing its path", () => {
    const root = repositoryFixture();
    const options = parseRouteArguments(routeArguments(root, [
      "--environment", "env_fixture",
      "--environment-repository", "hraness/fixture",
    ]));
    const qualification = inspectRepository(options);
    const report = decideRoute(options, qualification);
    expect(report.decision).toBe("cloud");
    if (report.decision === "local") throw new Error("expected Cloud route");
    expect(report.dispatchReady).toBe(false);
    expect(report.repository).toBe("hraness/fixture");
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain("env_fixture");
  });

  test("verifies the exact fully qualified remote ref online", () => {
    const root = repositoryFixture();
    const options = parseRouteArguments(routeArguments(root, [
      "--environment", "env_fixture",
      "--environment-repository", "hraness/fixture",
      "--online",
    ]));
    const sha = git(root, "rev-parse", "HEAD");
    const runner: CommandRunner = (arguments_, cwd) => {
      if (
        arguments_[0] === "git"
        && arguments_[1] === "ls-remote"
        && arguments_.includes("--symref")
      ) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: `ref: refs/heads/main\tHEAD\n${sha}\tHEAD`,
        };
      }
      if (arguments_[0] === "git" && arguments_[1] === "ls-remote") {
        return { exitCode: 0, stderr: "", stdout: `${sha}\trefs/heads/main` };
      }
      return command(arguments_, cwd);
    };
    const report = decideRoute(options, inspectRepository(options, runner));
    if (report.decision === "local") throw new Error("expected Cloud route");
    expect(report.dispatchReady).toBe(true);
    expect(report.onlineVerified).toBe(true);
  });

  test("requires and checks an explicit environment repository binding", () => {
    const root = repositoryFixture();
    expect(() => parseRouteArguments(routeArguments(root, [
      "--environment", "env_fixture",
    ]))).toThrow("supplied together");
    const mismatched = parseRouteArguments(routeArguments(root, [
      "--environment", "env_fixture",
      "--environment-repository", "hraness/other",
    ]));
    expect(() => decideRoute(mismatched, inspectRepository(mismatched)))
      .toThrow("does not match");
  });

  test("rejects dirty state and editable default branches", () => {
    const root = repositoryFixture();
    writeFileSync(join(root, "untracked.txt"), "local\n");
    expect(() => inspectRepository(parseRouteArguments(routeArguments(root))))
      .toThrow("untracked changes");

    rmSync(join(root, "untracked.txt"));
    const edit = parseRouteArguments([
      "--root", root,
      "--intent", "edit",
      "--owner", "owner",
      "--profile", "portable-bun",
      "--model-policy", "cloud-default-ok",
    ]);
    expect(() => inspectRepository(edit)).toThrow("non-default branch");
  });

  test("accepts a unique editable branch", () => {
    const root = repositoryFixture("codex/cloud-fixture");
    const options = parseRouteArguments([
      "--root", root,
      "--intent", "edit",
      "--owner", "owner",
      "--profile", "portable-bun",
      "--model-policy", "cloud-default-ok",
    ]);
    expect(inspectRepository(options).branch).toBe("codex/cloud-fixture");
  });

  test("rejects a nonstandard default branch and an unknown default", () => {
    const root = repositoryFixture("develop", "develop");
    const edit = parseRouteArguments([
      "--root", root,
      "--intent", "edit",
      "--owner", "owner",
      "--profile", "portable-bun",
      "--model-policy", "cloud-default-ok",
    ]);
    expect(() => inspectRepository(edit)).toThrow("non-default branch");
    git(root, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    expect(() => inspectRepository(edit)).toThrow("known origin default branch");
  });

  test("rejects replacement refs, legacy grafts, and Git environment overrides", () => {
    const root = repositoryFixture();
    const options = parseRouteArguments(routeArguments(root));
    const original = git(root, "rev-parse", "HEAD");
    git(root, "switch", "-c", "replacement-fixture");
    writeFileSync(join(root, "README.md"), "replacement\n");
    git(root, "commit", "-am", "replacement");
    const replacement = git(root, "rev-parse", "HEAD");
    git(root, "switch", "main");
    git(root, "replace", original, replacement);
    expect(() => inspectRepository(options)).toThrow("replacement refs");
    git(root, "replace", "-d", original);

    const graftValue = git(root, "rev-parse", "--git-path", "info/grafts");
    const grafts = isAbsolute(graftValue) ? graftValue : resolve(root, graftValue);
    mkdirSync(dirname(grafts), { recursive: true });
    writeFileSync(grafts, "legacy\n");
    expect(() => inspectRepository(options)).toThrow("legacy Git graft");
    rmSync(grafts);

    for (const [name, value] of [
      ["GIT_REPLACE_REF_BASE", "refs/other"],
      ["GIT_CONFIG_COUNT", "1"],
    ] as const) {
      const prior = process.env[name];
      process.env[name] = value;
      try {
        expect(() => inspectRepository(options)).toThrow("environment overrides");
      } finally {
        if (prior === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = prior;
      }
    }
  });
});

describe("Cloud route decisions", () => {
  test("keeps exact-model and execution capability work local", () => {
    const root = repositoryFixture();
    writeFileSync(join(root, "uncommitted.txt"), "local-only input\n");
    const exact = parseRouteArguments([
      "--root", root,
      "--intent", "read-only",
      "--owner", "fixture-owner",
      "--model-policy", "exact",
    ]);
    const exactReport = routeTask(exact);
    expect(exactReport.decision).toBe("local");
    expect(() => dispatchPacketHeader(exactReport)).toThrow("local route");

    const native = parseRouteArguments(routeArguments(root, ["--needs", "mac-native"]));
    expect(routeTask(native).decision).toBe("local");
    const network = parseRouteArguments(routeArguments(root, ["--needs", "agent-network"]));
    expect(routeTask(network).decision).toBe("local");
  });

  test("uses hybrid only for final local proof and builds a bounded packet header", () => {
    const root = repositoryFixture();
    const options = parseRouteArguments(routeArguments(root, [
      "--final-needs", "authenticated-browser",
    ]));
    const report = decideRoute(options, inspectRepository(options));
    expect(report.decision).toBe("hybrid");
    const packet = dispatchPacketHeader(report);
    expect(packet).toContain("Final local-only proofs: authenticated-browser");
    expect(packet).not.toContain(root);
  });
});

describe("GitHub remote parsing", () => {
  test("accepts supported HTTPS and SSH forms only", () => {
    expect(parseGitHubRepository("https://github.com/hraness/result.git")).toBe("hraness/result");
    expect(parseGitHubRepository("git@github.com:hraness/types.git")).toBe("hraness/types");
    expect(parseGitHubRepository("ssh://git@github.com/hraness/design-kit.git"))
      .toBe("hraness/design-kit");
    expect(() => parseGitHubRepository("/local/private/repo")).toThrow("supported GitHub");
  });
});
