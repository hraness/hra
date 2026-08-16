import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "@hra-internal/schema";
import { childEnvironment, resolveRuntimePaths, type RuntimePaths } from "../src/runtime-paths";
import { runWorkspaceWriteTouchProbe } from "./probes/standalone-command";

const temporaryDirectories: string[] = [];
const macOSArm64 = process.platform === "darwin" && process.arch === "arm64";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(label: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `oprte-${label}-`)));
  temporaryDirectories.push(root);
  return root;
}

async function runGit(paths: RuntimePaths, cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn([paths.gitBinary, ...args], {
    cwd,
    env: childEnvironment(paths),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Bundled Git failed: ${stderr}`);
  return stdout.trim();
}

describe("Phase 1 feasibility gates", () => {
  test.skipIf(!macOSArm64)(
    "runs a standalone setup command under workspace-write",
    async () => {
      const root = await temporaryRoot("setup-command");
      const cwd = join(root, "workspace");
      const codexHome = join(root, "codex-home");
      await Promise.all([mkdir(cwd), mkdir(codexHome)]);
      expect(await realpath(cwd)).toBe(cwd);
      const paths = resolveRuntimePaths({ ...process.env, HRA_CODEX_HOME: codexHome });
      const marker = join(cwd, "setup-complete");
      const result = z
        .object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })
        .strict()
        .parse(await runWorkspaceWriteTouchProbe(paths, cwd, marker));
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(await Bun.file(marker).exists()).toBeTrue();
    },
    45_000,
  );

  test.skipIf(!macOSArm64)("uses bundled Git for linked-worktree add, commit, and branch", async () => {
    const root = await temporaryRoot("linked-worktree");
    const repository = join(root, "repository");
    const lane = join(root, "lane");
    const codexHome = join(root, "codex-home");
    await Promise.all([mkdir(repository), mkdir(codexHome)]);
    const paths = resolveRuntimePaths({ ...process.env, HRA_CODEX_HOME: codexHome });

    await runGit(paths, repository, ["init", "--initial-branch=main"]);
    await runGit(paths, repository, ["config", "user.name", "OPRTE Probe"]);
    await runGit(paths, repository, ["config", "user.email", "probe@oprte.invalid"]);
    await writeFile(join(repository, "fixture.txt"), "base\n");
    await runGit(paths, repository, ["add", "fixture.txt"]);
    await runGit(paths, repository, ["commit", "-m", "base"]);
    await runGit(paths, repository, ["worktree", "add", "--detach", lane, "HEAD"]);
    await writeFile(join(lane, "fixture.txt"), "base\nlane\n");
    await runGit(paths, lane, ["add", "fixture.txt"]);
    await runGit(paths, lane, ["commit", "-m", "lane change"]);
    await runGit(paths, lane, ["switch", "-c", "codex/oprte-phase1-probe"]);

    expect(await runGit(paths, lane, ["branch", "--show-current"])).toBe("codex/oprte-phase1-probe");
    expect(await runGit(paths, lane, ["status", "--porcelain"])).toBe("");
    expect(await runGit(paths, lane, ["rev-parse", "--git-common-dir"])).not.toBe(".git");
  });
});
