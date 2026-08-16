import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface AgentGuideSource {
  readonly path: string;
  readonly source: string;
}

export function agentGuideErrors(
  guides: readonly AgentGuideSource[],
): readonly string[] {
  const errors: string[] = [];
  const paths = new Set<string>();
  for (const guide of guides.toSorted((left, right) =>
    left.path.localeCompare(right.path))) {
    if (paths.has(guide.path)) {
      errors.push(`${guide.path}: duplicate agent guide`);
      continue;
    }
    paths.add(guide.path);
    if (guide.path !== "AGENTS.md" && !guide.path.endsWith("/AGENTS.md")) {
      errors.push(`${guide.path}: agent guide must be named AGENTS.md`);
      continue;
    }
    const lines = guide.source.replaceAll("\r\n", "\n").split("\n");
    const headings = lines.filter((line) => line.startsWith("# "));
    const contentsIndex = lines.indexOf("# Contents");
    const prefix = lines.slice(0, contentsIndex).filter((line) => line.length > 0);
    if (
      headings.length !== 2
      || headings[0] !== "# Contents"
      || headings[1] !== "# Guidelines"
      || prefix.some((line) => !/^<!-- kb:context [^<>]+ -->$/u.test(line))
    ) {
      errors.push(`${guide.path}: must contain exactly # Contents then # Guidelines`);
      continue;
    }
    const guidelinesIndex = lines.indexOf("# Guidelines");
    const contents = lines.slice(contentsIndex + 1, guidelinesIndex);
    const guidelines = lines.slice(guidelinesIndex + 1);
    if (!contents.some((line) => line.startsWith("- "))) {
      errors.push(`${guide.path}: Contents must include at least one list item`);
    }
    if (!guidelines.some((line) => line.startsWith("- "))) {
      errors.push(`${guide.path}: Guidelines must include at least one list item`);
    }
  }
  if (!paths.has("AGENTS.md")) errors.push("AGENTS.md: root agent guide is missing");
  return errors;
}

function repositoryPaths(): readonly string[] {
  const result = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || "git ls-files failed");
  }
  return result.stdout.toString().split("\0").filter(Boolean);
}

async function readAgentGuides(): Promise<readonly AgentGuideSource[]> {
  const guides: AgentGuideSource[] = [];
  for (const path of repositoryPaths().filter((candidate) =>
    candidate === "AGENTS.md" || candidate.endsWith("/AGENTS.md"))) {
    const absolutePath = resolve(repositoryRoot, path);
    try {
      const status = await lstat(absolutePath);
      if (status.isFile()) {
        guides.push({ path, source: await readFile(absolutePath, "utf8") });
      }
    } catch (error) {
      if (
        typeof error !== "object"
        || error === null
        || !("code" in error)
        || error.code !== "ENOENT"
      ) throw error;
    }
  }
  return guides;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("Usage: bun run check:agent-guides");
  const guides = await readAgentGuides();
  const errors = agentGuideErrors(guides);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Agent guides clean: ${guides.length} files.`);
}

if (import.meta.main) await main();
