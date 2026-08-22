import { describe, expect, test } from "bun:test";

import type { GitResult, GitRunner } from "../src/workspaces/git-runner";
import {
  loadWorkspaceSetupRecipe,
  WorkspaceSetupRecipeError,
} from "../src/workspaces/workspace-setup-recipe";

const BASE = "a".repeat(40);
const OTHER_BASE = "b".repeat(40);
const BLOB = "c".repeat(40);
const VALID_RECIPE = {
  version: 1,
  setup: {
    kind: "bunInstall",
    frozenLockfile: true,
    lifecycleScripts: "disabled",
    timeoutSeconds: 600,
    outputLimitBytes: 262_144,
  },
} as const;

class RecipeGitRunner implements GitRunner {
  readonly calls: string[][] = [];
  mode = "100644";
  recipe: string | null = JSON.stringify(VALID_RECIPE);
  stderr = "";

  run(_cwd: string, args: readonly string[]): Promise<GitResult> {
    this.calls.push([...args]);
    if (args[0] === "ls-tree") {
      if (this.stderr !== "") {
        return Promise.resolve({ exitCode: 1, stderr: this.stderr, stdout: "" });
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: this.recipe === null
          ? ""
          : `${this.mode} ${this.mode === "160000" ? "commit" : "blob"} ${BLOB}\t.hra/workspace.json\0`,
      });
    }
    if (args[0] === "cat-file" && this.recipe !== null) {
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: this.recipe });
    }
    throw new Error(`unexpected Git command: ${args.join(" ")}`);
  }
}

describe("workspace setup recipe v1", () => {
  test("reads only the exact immutable base blob and canonicalizes its digest", async () => {
    const compact = new RecipeGitRunner();
    const pretty = new RecipeGitRunner();
    pretty.recipe = JSON.stringify(VALID_RECIPE, null, 2);
    const reordered = new RecipeGitRunner();
    reordered.recipe = JSON.stringify({
      setup: {
        outputLimitBytes: 262_144,
        timeoutSeconds: 600,
        lifecycleScripts: "disabled",
        frozenLockfile: true,
        kind: "bunInstall",
      },
      version: 1,
    });

    const first = await loadWorkspaceSetupRecipe(compact, "/repo", BASE);
    const second = await loadWorkspaceSetupRecipe(pretty, "/repo", BASE);
    const third = await loadWorkspaceSetupRecipe(reordered, "/repo", BASE);
    const otherBase = await loadWorkspaceSetupRecipe(pretty, "/repo", OTHER_BASE);

    expect(first).not.toBeNull();
    expect(first?.recipe).toEqual(VALID_RECIPE);
    expect(first?.canonicalRecipe).toBe(JSON.stringify(VALID_RECIPE));
    expect(first?.digest).toBe(second?.digest);
    expect(first?.digest).toBe(third?.digest);
    expect(first?.digest).not.toBe(otherBase?.digest);
    expect(compact.calls).toEqual([
      ["ls-tree", "-z", BASE, "--", ".hra/workspace.json"],
      ["cat-file", "blob", BLOB],
    ]);
  });

  test("an absent recipe is an explicit no-op and never reads a blob", async () => {
    const git = new RecipeGitRunner();
    git.recipe = null;
    expect(await loadWorkspaceSetupRecipe(git, "/repo", BASE)).toBeNull();
    expect(git.calls).toEqual([
      ["ls-tree", "-z", BASE, "--", ".hra/workspace.json"],
    ]);
  });

  test.each([
    ["future version", { ...VALID_RECIPE, version: 2 }],
    ["shell", { ...VALID_RECIPE, shell: "postinstall.sh" }],
    ["argv", { ...VALID_RECIPE, argv: ["run", "setup"] }],
    ["environment", { ...VALID_RECIPE, env: { TOKEN: "secret" } }],
    ["copy", { ...VALID_RECIPE, copy: ["../secret"] }],
    ["unfrozen lockfile", {
      ...VALID_RECIPE,
      setup: { ...VALID_RECIPE.setup, frozenLockfile: false },
    }],
    ["lifecycle scripts", {
      ...VALID_RECIPE,
      setup: { ...VALID_RECIPE.setup, lifecycleScripts: "enabled" },
    }],
    ["zero timeout", {
      ...VALID_RECIPE,
      setup: { ...VALID_RECIPE.setup, timeoutSeconds: 0 },
    }],
    ["oversized timeout", {
      ...VALID_RECIPE,
      setup: { ...VALID_RECIPE.setup, timeoutSeconds: 601 },
    }],
    ["zero output", {
      ...VALID_RECIPE,
      setup: { ...VALID_RECIPE.setup, outputLimitBytes: 0 },
    }],
    ["oversized output", {
      ...VALID_RECIPE,
      setup: { ...VALID_RECIPE.setup, outputLimitBytes: 262_145 },
    }],
  ])("rejects %s", async (_label, value) => {
    const git = new RecipeGitRunner();
    git.recipe = JSON.stringify(value);
    expect(await recipeFailure(git, BASE)).toBeInstanceOf(
      WorkspaceSetupRecipeError,
    );
  });

  test.each(["120000", "160000", "100600"])(
    "rejects unsafe Git mode %s before reading bytes",
    async (mode) => {
      const git = new RecipeGitRunner();
      git.mode = mode;
      expect(await recipeFailure(git, BASE)).toMatchObject({
        reason: "unsafe_object",
      });
      expect(git.calls).toHaveLength(1);
    },
  );

  test("fails closed on Git read errors and oversized blobs", async () => {
    const failed = new RecipeGitRunner();
    failed.stderr = "read failed";
    expect(await recipeFailure(failed, BASE)).toMatchObject({
      reason: "git_read_failed",
    });

    const oversized = new RecipeGitRunner();
    oversized.recipe = `{"pad":"${"x".repeat(16 * 1_024)}"}`;
    expect(await recipeFailure(oversized, BASE)).toMatchObject({
      reason: "invalid_recipe",
    });

    const thrown: GitRunner = {
      run(): Promise<GitResult> {
        return Promise.reject(new Error("raw Git failure"));
      },
    };
    expect(await recipeFailure(thrown, BASE)).toMatchObject({
      reason: "git_read_failed",
    });
  });

  test("gives every rejection an opaque restart-stable digest", async () => {
    const first = new RecipeGitRunner();
    first.recipe = "not json";
    const replay = new RecipeGitRunner();
    replay.recipe = "different invalid bytes";
    const otherBase = new RecipeGitRunner();
    otherBase.recipe = "not json";

    const firstFailure = requireRecipeFailure(await recipeFailure(first, BASE));
    const replayFailure = requireRecipeFailure(await recipeFailure(replay, BASE));
    const otherFailure = requireRecipeFailure(
      await recipeFailure(otherBase, OTHER_BASE),
    );
    expect(firstFailure.rejectionDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstFailure.rejectionDigest).toBe(replayFailure.rejectionDigest);
    expect(firstFailure.rejectionDigest).not.toBe(otherFailure.rejectionDigest);
  });
});

async function recipeFailure(
  git: GitRunner,
  baseSha: string,
): Promise<unknown> {
  try {
    await loadWorkspaceSetupRecipe(git, "/repo", baseSha);
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected the workspace setup recipe to be rejected");
}

function requireRecipeFailure(value: unknown): WorkspaceSetupRecipeError {
  if (!(value instanceof WorkspaceSetupRecipeError)) {
    throw new Error("Expected WorkspaceSetupRecipeError");
  }
  return value;
}
