import { createHash } from "node:crypto";
import { z } from "@hra-internal/schema";

import type { GitRunner, GitRunOptions } from "./git-runner";

const commitPattern = /^[a-f0-9]{40,64}$/u;
const blobPattern = /^[a-f0-9]{40,64}$/u;
const recipePath = ".hra/workspace.json";
const maximumRecipeBytes = 16 * 1_024;
const recipeGitOptions = {
  stderrLimitBytes: 8 * 1_024,
  stdoutLimitBytes: maximumRecipeBytes,
  timeoutMs: 30_000,
} as const satisfies GitRunOptions;

export const workspaceSetupRecipeV1Schema = z.object({
  version: z.literal(1),
  setup: z.object({
    kind: z.literal("bunInstall"),
    frozenLockfile: z.literal(true),
    lifecycleScripts: z.literal("disabled"),
    timeoutSeconds: z.number().int().min(1).max(600),
    outputLimitBytes: z.number().int().min(1).max(262_144),
  }).strict(),
}).strict();

export type WorkspaceSetupRecipeV1 = z.infer<
  typeof workspaceSetupRecipeV1Schema
>;

export interface LoadedWorkspaceSetupRecipe {
  readonly canonicalRecipe: string;
  /** SHA-256 over the immutable base SHA and canonical validated recipe. */
  readonly digest: string;
  readonly recipe: WorkspaceSetupRecipeV1;
}

export class WorkspaceSetupRecipeError extends Error {
  readonly reason: "git_read_failed" | "invalid_recipe" | "unsafe_object";
  readonly rejectionDigest: string;

  constructor(
    reason: WorkspaceSetupRecipeError["reason"],
    baseSha: string,
  ) {
    super(reason === "git_read_failed"
      ? "Workspace setup recipe could not be read from its immutable base"
      : reason === "unsafe_object"
      ? "Workspace setup recipe is not a regular Git blob"
      : "Workspace setup recipe is invalid");
    this.name = "WorkspaceSetupRecipeError";
    this.reason = reason;
    this.rejectionDigest = workspaceSetupRejectionDigest(baseSha, reason);
  }
}

/** Opaque, restart-stable identity for a recipe that cannot be admitted. */
export function workspaceSetupRejectionDigest(
  baseSha: string,
  reason: WorkspaceSetupRecipeError["reason"],
): string {
  return createHash("sha256")
    .update("hra.workspace-setup-rejection.v1\0", "utf8")
    .update(baseSha, "utf8")
    .update("\0", "utf8")
    .update(reason, "utf8")
    .digest("hex");
}

/**
 * Reads the recipe from the immutable commit rather than from mutable checkout
 * bytes. Git mode proves that symlinks and submodules can never become recipe
 * input, and the schema deliberately has no command, argv, environment, or
 * copy surface.
 */
export async function loadWorkspaceSetupRecipe(
  git: GitRunner,
  canonicalRepositoryPath: string,
  baseSha: string,
): Promise<LoadedWorkspaceSetupRecipe | null> {
  if (!commitPattern.test(baseSha)) {
    throw new WorkspaceSetupRecipeError("invalid_recipe", baseSha);
  }
  let listing: Awaited<ReturnType<GitRunner["run"]>>;
  try {
    listing = await git.run(
      canonicalRepositoryPath,
      ["ls-tree", "-z", baseSha, "--", recipePath],
      recipeGitOptions,
    );
  } catch {
    throw new WorkspaceSetupRecipeError("git_read_failed", baseSha);
  }
  if (listing.exitCode !== 0 || listing.stderr !== "") {
    throw new WorkspaceSetupRecipeError("git_read_failed", baseSha);
  }
  if (listing.stdout === "") return null;
  const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t\.hra\/workspace\.json\0$/u
    .exec(listing.stdout);
  if (match === null) {
    throw new WorkspaceSetupRecipeError("unsafe_object", baseSha);
  }
  const blobSha = match[2];
  if (blobSha === undefined || !blobPattern.test(blobSha)) {
    throw new WorkspaceSetupRecipeError("unsafe_object", baseSha);
  }
  let blob: Awaited<ReturnType<GitRunner["run"]>>;
  try {
    blob = await git.run(
      canonicalRepositoryPath,
      ["cat-file", "blob", blobSha],
      recipeGitOptions,
    );
  } catch {
    throw new WorkspaceSetupRecipeError("git_read_failed", baseSha);
  }
  if (blob.exitCode !== 0 || blob.stderr !== "") {
    throw new WorkspaceSetupRecipeError("git_read_failed", baseSha);
  }
  if (Buffer.byteLength(blob.stdout, "utf8") > maximumRecipeBytes) {
    throw new WorkspaceSetupRecipeError("invalid_recipe", baseSha);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob.stdout);
  } catch {
    throw new WorkspaceSetupRecipeError("invalid_recipe", baseSha);
  }
  let recipe: WorkspaceSetupRecipeV1;
  try {
    recipe = workspaceSetupRecipeV1Schema.parse(parsed);
  } catch {
    throw new WorkspaceSetupRecipeError("invalid_recipe", baseSha);
  }
  const canonicalRecipe = JSON.stringify(recipe);
  return {
    canonicalRecipe,
    digest: createHash("sha256")
      .update("hra.workspace-setup-recipe.v1\0", "utf8")
      .update(baseSha, "utf8")
      .update("\0", "utf8")
      .update(canonicalRecipe, "utf8")
      .digest("hex"),
    recipe,
  };
}
