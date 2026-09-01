import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cloudChildEnvironment,
  parseCloudExecArguments,
  readPromptFile,
  readRouteFile,
  runCloudExec,
} from "./cloud-run";

const temporary: string[] = [];
const commit = "a".repeat(40);

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "hra-cloud-run-"));
  temporary.push(path);
  return path;
}

function routeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    branch: "main",
    decision: "cloud",
    dispatchReady: true,
    environmentConfigured: true,
    finalNeeds: [],
    intent: "read-only",
    modelPolicy: "cloud-default-ok",
    needs: [],
    onlineVerified: true,
    owner: "fixture-owner",
    profile: "portable-bun",
    repository: "hraness/fixture",
    sha: commit,
    version: 1,
    ...overrides,
  };
}

describe("private Codex Cloud launch guard", () => {
  test("passes only reviewed process environment to the official CLI", () => {
    expect(cloudChildEnvironment({
      CODEX_HOME: "/private/codex",
      HOME: "/private/home",
      OPENAI_API_KEY: "must-not-pass",
      PATH: "/bin",
    })).toEqual({
      CODEX_HOME: "/private/codex",
      HOME: "/private/home",
      PATH: "/bin",
    });
  });

  test("requires explicit bounded arguments and a non-argv prompt source", () => {
    expect(() => parseCloudExecArguments([])).toThrow("--environment is required");
    expect(() => parseCloudExecArguments([
      "--environment", "env",
      "--prompt-file", "/private/prompt",
      "--route-file", "/private/route.json",
      "--attempts", "0",
    ])).toThrow("1 through 4");
    expect(parseCloudExecArguments([
      "--environment", "env",
      "--prompt-file", "/private/prompt",
      "--route-file", "/private/route.json",
      "--attempts", "4",
    ]).attempts).toBe(4);
    expect(() => parseCloudExecArguments([
      "--environment", "env",
      "--prompt-file", "/private/prompt",
      "--route-file", "relative",
    ])).toThrow("absolute path");
  });

  test("rejects empty, oversized, linked, and NUL prompt files", () => {
    const fixture = root();
    const empty = join(fixture, "empty");
    writeFileSync(empty, "", { mode: 0o600 });
    expect(() => readPromptFile(empty)).toThrow("bounded single-link");
    const large = join(fixture, "large");
    writeFileSync(large, "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    expect(() => readPromptFile(large)).toThrow("bounded single-link");
    const nul = join(fixture, "nul");
    writeFileSync(nul, "before\0after", { mode: 0o600 });
    expect(() => readPromptFile(nul)).toThrow("NUL");
    const target = join(fixture, "target");
    const linked = join(fixture, "linked");
    writeFileSync(target, "prompt\n", { mode: 0o600 });
    symlinkSync(target, linked);
    expect(() => readPromptFile(linked)).toThrow("bounded single-link");
    const publicPrompt = join(fixture, "public");
    writeFileSync(publicPrompt, "prompt\n", { mode: 0o644 });
    expect(() => readPromptFile(publicPrompt)).toThrow("private bounded");
  });

  test("accepts only a private dispatch-ready route report", () => {
    const fixture = root();
    const routeFile = join(fixture, "route.json");
    const route = routeReport();
    writeFileSync(routeFile, JSON.stringify(route), { mode: 0o600 });
    const parsed = readRouteFile(routeFile);
    expect(parsed.branch).toBe("main");
    expect(parsed.sha).toBe(commit);
    expect(parsed.repository).toBe("hraness/fixture");
    expect(parsed.owner).toBe("fixture-owner");
    writeFileSync(routeFile, JSON.stringify({ ...route, dispatchReady: false }), { mode: 0o600 });
    expect(() => readRouteFile(routeFile)).toThrow("not dispatch-ready");
    writeFileSync(routeFile, JSON.stringify(routeReport({
      decision: "hybrid",
      finalNeeds: [],
    })), { mode: 0o600 });
    expect(() => readRouteFile(routeFile)).toThrow("decision and final requirements");
    chmodSync(routeFile, 0o644);
    expect(() => readRouteFile(routeFile)).toThrow("private bounded");
  });

  test("feeds the prompt over stdin in a private scratch directory and removes its diagnostic log", async () => {
    const fixture = root();
    const scratchParent = join(fixture, "scratch");
    const promptFile = join(fixture, "prompt");
    const routeFile = join(fixture, "route.json");
    const capture = join(fixture, "capture.json");
    const fakeCli = join(fixture, "codex-fixture");
    Bun.spawnSync(["mkdir", scratchParent]);
    writeFileSync(promptFile, "bounded private prompt\n", { mode: 0o600 });
    writeFileSync(routeFile, JSON.stringify(routeReport({
      decision: "hybrid",
      finalNeeds: ["authenticated-browser"],
    })), { mode: 0o600 });
    writeFileSync(fakeCli, `#!/usr/bin/env bun
import { statSync, writeFileSync } from "node:fs";
const prompt = await Bun.stdin.text();
writeFileSync("error.log", "private provider diagnostic");
writeFileSync(process.env.HRA_CLOUD_TEST_CAPTURE, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  prompt,
  mode: statSync("error.log").mode & 0o777,
}));
`, { mode: 0o755 });
    chmodSync(fakeCli, 0o755);
    const options = parseCloudExecArguments([
      "--environment", "env_fixture",
      "--attempts", "1",
      "--prompt-file", promptFile,
      "--route-file", routeFile,
    ]);
    expect(await runCloudExec(options, {
      codexCli: fakeCli,
      environment: {
        HRA_CLOUD_TEST_CAPTURE: capture,
        PATH: process.env.PATH,
      },
      scratchParent,
    })).toBe(0);
    const observed = JSON.parse(readFileSync(capture, "utf8")) as {
      argv: string[];
      cwd: string;
      mode: number;
      prompt: string;
    };
    expect(observed.prompt).toContain(`git rev-parse HEAD is exactly ${commit}`);
    expect(observed.prompt).toContain("The origin GitHub repository is exactly hraness/fixture");
    expect(observed.prompt).toContain("Worker model label: cloud-default");
    expect(observed.prompt).toContain("Final local-only proofs: authenticated-browser");
    expect(observed.prompt).toContain("Do not merge, release, deploy, mutate providers");
    expect(observed.prompt.endsWith("bounded private prompt\n")).toBe(true);
    expect(observed.argv).not.toContain(observed.prompt);
    expect(observed.argv).toEqual([
      "cloud", "exec", "--env", "env_fixture", "--attempts", "1", "--branch", "main",
    ]);
    expect(observed.cwd.startsWith(`${realpathSync(scratchParent)}/hra-cloud-exec-`)).toBe(true);
    expect(observed.mode).toBe(0o600);
    expect(readdirSync(scratchParent)).toEqual([]);
  });
});
