import { access, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const publicRepositoryUrl = "git+https://github.com/hraness/hra.git";
const publicHomepage = "https://hra.sh";
const publicBugsUrl = "https://github.com/hraness/hra/issues";
const expectedNamedWorkspaces: ReadonlyMap<string, string> = new Map([
  ["apps/cli", "@hraness/hra-cli"],
  ["apps/desktop", "@hraness/hra"],
  ["apps/web", "@hraness/hra-web"],
  ["packages/human-client", "@hraness/hra-human-client"],
  ["packages/internal/brand-ui", "@hra-internal/brand-ui"],
  ["packages/internal/browser-storage", "@hra-internal/browser-storage"],
  ["packages/internal/convex", "@hra-internal/convex"],
  ["packages/internal/codex-app-sdk", "@hra-internal/codex-app-sdk"],
  ["packages/internal/design-kit", "@hra-internal/design-kit"],
  ["packages/internal/eslint-config", "@hra-internal/eslint-config"],
  ["packages/internal/schema", "@hra-internal/schema"],
  ["packages/internal/test", "@hra-internal/test"],
  ["packages/internal/typescript-config", "@hra-internal/typescript-config"],
  ["packages/task-domain", "@hraness/agent-tasks-domain"],
  ["packages/task-protocol", "@hraness/agent-tasks-protocol"],
  ["packages/task-ui", "@hraness/agent-tasks-ui"],
] as const);

const requiredRootPaths = [
  ".bun-version",
  ".github/workflows/ci.yml",
  ".gitignore",
  ".node-version",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SECURITY_ARCHITECTURE.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "apps/web/next-env.d.ts",
  "bun.lock",
  "bunfig.toml",
  "hra-legacy-identifiers.manifest.json",
  "package.json",
  "packages/internal/codex-app-sdk/LICENSE",
  "packages/internal/codex-app-sdk/PROVENANCE.md",
  "scripts/check-public-boundary.ts",
  "scripts/check-public-structure.ts",
  "scripts/check-public-tree.ts",
  "scripts/check-resource-scheduler.ts",
  "scripts/check-standalone.ts",
  "scripts/direct/agent-browser.verify.json",
  "scripts/public-tree.manifest.json",
  "scripts/vercel-deploy-gate.ts",
] as const;

const joinLiteral = (...parts: readonly string[]): string => parts.join("");
const forbiddenRootPaths = [
  joinLiteral(".public-", "bootstrap"),
  joinLiteral(".github/workflows/hra-", "preview-release.yml"),
  joinLiteral(".github/workflows/hra-", "release.yml"),
  "OPERATIONS.md",
  "THREAT_MODEL.md",
  joinLiteral("docs/migration-", "inventory.md"),
  "lab",
  "package-lock.json",
  joinLiteral("packages/codex-", "app-sdk"),
  joinLiteral("packages/internal/", "identity"),
  joinLiteral("packages/internal/", "suite-accounts"),
  "pnpm-lock.yaml",
  "projects",
  joinLiteral("public-source-", "inventory.json"),
  joinLiteral("release-", "authority.json"),
  joinLiteral("scripts/check-legacy-", "identifiers.ts"),
  joinLiteral("scripts/check-public-source-", "inventory.ts"),
  joinLiteral("scripts/check-release-", "authority.ts"),
  "yarn.lock",
] as const;

export interface WorkspaceManifest {
  readonly path: string;
  readonly value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataErrors(
  path: string,
  directory: string | null,
  value: Record<string, unknown>,
): readonly string[] {
  const errors: string[] = [];
  const repository = value["repository"];
  const bugs = value["bugs"];
  if (value["private"] !== true) errors.push(`${path}: workspace must remain private`);
  const expectedLicense = directory === "packages/internal/codex-app-sdk"
    ? "MIT"
    : "Apache-2.0";
  if (value["license"] !== expectedLicense) {
    errors.push(`${path}: license must be ${expectedLicense}`);
  }
  if (
    !isRecord(repository)
    || repository["type"] !== "git"
    || repository["url"] !== publicRepositoryUrl
    || (directory === null
      ? "directory" in repository
      : repository["directory"] !== directory)
  ) {
    errors.push(`${path}: repository metadata must point to the public HRA source`);
  }
  if (value["homepage"] !== publicHomepage) {
    errors.push(`${path}: homepage must be ${publicHomepage}`);
  }
  if (!isRecord(bugs) || bugs["url"] !== publicBugsUrl) {
    errors.push(`${path}: bugs metadata must point to the public HRA issue tracker`);
  }
  return errors;
}

export function publicStructureErrors(options: Readonly<{
  manifests: readonly WorkspaceManifest[];
  presentPaths: ReadonlySet<string>;
}>): readonly string[] {
  const errors: string[] = [];
  const byPath = new Map(
    options.manifests.map((manifest) => [manifest.path, manifest.value]),
  );
  const root = byPath.get("package.json");
  if (!isRecord(root)) {
    errors.push("package.json: root manifest is missing or invalid");
  } else {
    if (root["name"] !== "hra") errors.push("package.json: root name must be hra");
    errors.push(...metadataErrors("package.json", null, root));
    if (root["packageManager"] !== "bun@1.3.14") {
      errors.push("package.json: packageManager must be bun@1.3.14");
    }
    const workspaces = root["workspaces"];
    const patterns = isRecord(workspaces) ? workspaces["packages"] : undefined;
    if (
      !Array.isArray(patterns)
      || JSON.stringify(patterns) !== JSON.stringify([
        "apps/*",
        "packages/*",
        "packages/internal/*",
      ])
    ) {
      errors.push("package.json: workspace patterns must match the public graph");
    }
    const catalog = isRecord(workspaces) ? workspaces["catalog"] : undefined;
    if (isRecord(catalog) && "@hraness/codex-app-sdk" in catalog) {
      errors.push("package.json: external Codex App SDK catalog pin must be absent");
    }
    if (!isRecord(catalog) || catalog["react-aria-components"] !== "1.19.0") {
      errors.push("package.json: react-aria-components must remain pinned to 1.19.0");
    }
    const sharedPackagePins = {
      "@hraness/direct": "github:hraness/direct#v0.7.0",
      "@hraness/vercel-delivery": "github:hraness/vercel-delivery#v0.1.2",
      "@hraness/web-discovery": "github:hraness/web-discovery#v0.1.0",
    } as const;
    for (const [name, expected] of Object.entries(sharedPackagePins)) {
      if (!isRecord(catalog) || catalog[name] !== expected) {
        errors.push(`package.json: ${name} must use immutable release ${expected}`);
      }
    }
    const scripts = root["scripts"];
    if (
      !isRecord(scripts)
      || scripts["hra"] !== "bun run dev:desktop"
      || scripts["check:public-boundary"] !== "bun run scripts/check-public-boundary.ts"
      || scripts["check:public-tree"] !== "bun run scripts/check-public-tree.ts"
      || scripts["check:structure"] !== "bun run scripts/check-public-structure.ts"
      || scripts["check"] !== "bun run scripts/check-resource-scheduler.ts --mode=heavy --label=HRA-source-check -- bun run check:uncoordinated"
      || scripts["check:complete"] !== "bun run scripts/check-resource-scheduler.ts --mode=exclusive --label=HRA-complete-check -- bun run check:complete:uncoordinated"
      || scripts["build"] !== "bun run scripts/check-resource-scheduler.ts --mode=exclusive --label=HRA-production-build -- bun run build:uncoordinated"
      || scripts["typecheck:workspaces"] !== "bun run --sequential --filter '@hraness/*' --filter '@hra-internal/*' typecheck"
      || scripts["lint:workspaces"] !== "bun run --sequential --filter '@hraness/*' --filter '@hra-internal/*' lint"
      || scripts["test"] !== "bun run --sequential --filter '@hraness/*' --filter '@hra-internal/*' test"
      || "check:legacy-identifiers" in scripts
      || "check:public-source-inventory" in scripts
      || "check:public-source-ready" in scripts
      || "check:release-authority" in scripts
      || "operate" in scripts
    ) {
      errors.push("package.json: canonical public launcher and check scripts are invalid");
    }
    const devDependencies = root["devDependencies"];
    if (
      !isRecord(catalog)
      || catalog["agent-browser"] !== "0.32.3"
      || !isRecord(devDependencies)
      || devDependencies["agent-browser"] !== "catalog:"
    ) {
      errors.push("package.json: Direct verification requires pinned root agent-browser 0.32.3");
    }
  }

  for (const [directory, expectedName] of expectedNamedWorkspaces) {
    const path = `${directory}/package.json`;
    const value = byPath.get(path);
    if (!isRecord(value) || value["name"] !== expectedName) {
      errors.push(`${path}: expected workspace ${expectedName}`);
    }
  }
  for (const [path, value] of byPath) {
    if (path === "package.json") continue;
    if (!isRecord(value)) {
      errors.push(`${path}: workspace manifest is invalid`);
      continue;
    }
    const directory = path.slice(0, -"/package.json".length);
    if (!expectedNamedWorkspaces.has(directory)) {
      errors.push(`${path}: unexpected public workspace`);
      continue;
    }
    errors.push(...metadataErrors(path, directory, value));
    if (!options.presentPaths.has(`${directory}/AGENTS.md`)) {
      errors.push(`${directory}/AGENTS.md: workspace guide is missing`);
    }
    if (
      directory === "apps/desktop"
      || directory === "apps/web"
      || directory === "packages/task-ui"
    ) {
      const dependencies = value["dependencies"];
      if (
        !isRecord(dependencies)
        || dependencies["@hra-internal/codex-app-sdk"] !== "workspace:*"
      ) {
        errors.push(`${path}: Codex App SDK must use the internal workspace`);
      }
    }
  }
  const web = byPath.get("apps/web/package.json");
  const webDependencies = isRecord(web) ? web["dependencies"] : undefined;
  if (
    !isRecord(webDependencies)
    || webDependencies["@hraness/vercel-delivery"] !== "catalog:"
    || webDependencies["@hraness/web-discovery"] !== "catalog:"
    || "@hra-internal/web-discovery" in webDependencies
  ) {
    errors.push(
      "apps/web/package.json: shared delivery and discovery packages must use the catalog",
    );
  }
  const desktop = byPath.get("apps/desktop/package.json");
  const desktopScripts = isRecord(desktop) ? desktop["scripts"] : undefined;
  if (
    !isRecord(desktopScripts)
    || desktopScripts["test"] !== "bun test ./frontend/src ./frontend/dev ./frontend/direct ./contracts ./runtime/test --path-ignore-patterns='**/gateway.integration.test.ts' --path-ignore-patterns='**/application-support-migration.test.ts' --path-ignore-patterns='**/feasibility.test.ts' && bun run test:application-support-migration && bun run test:feasibility && bun run test:gateway"
    || desktopScripts["test:application-support-migration"] !== "bun test ./runtime/test/application-support-migration.test.ts"
    || desktopScripts["test:feasibility"] !== "bun test ./runtime/test/feasibility.test.ts"
  ) {
    errors.push(
      "apps/desktop/package.json: process-sensitive migration and feasibility tests must run in isolated Bun processes",
    );
  }
  for (const path of requiredRootPaths) {
    if (!options.presentPaths.has(path)) {
      errors.push(`${path}: required public path is missing`);
    }
  }
  for (const path of forbiddenRootPaths) {
    if (options.presentPaths.has(path)) {
      errors.push(`${path}: excluded private path is present`);
    }
  }
  return errors;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return false;
    throw error;
  }
}

async function childPackagePaths(parent: string): Promise<readonly string[]> {
  const entries = await readdir(resolve(repositoryRoot, parent), {
    withFileTypes: true,
  });
  const paths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(parent, entry.name, "package.json");
    if (await exists(resolve(repositoryRoot, path))) paths.push(path);
  }
  return paths;
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) {
    throw new Error("Usage: bun run check:public-structure");
  }
  const workspacePackagePaths = [
    ...(await childPackagePaths("apps")),
    ...(await childPackagePaths("packages")),
    ...(await childPackagePaths("packages/internal")),
  ].toSorted();
  const packagePaths = ["package.json", ...workspacePackagePaths];
  const manifests = await Promise.all(packagePaths.map(async (path) => ({
    path,
    value: JSON.parse(
      await readFile(resolve(repositoryRoot, path), "utf8"),
    ) as unknown,
  })));
  const candidatePaths = new Set<string>([
    ...requiredRootPaths,
    ...forbiddenRootPaths,
    ...packagePaths,
    ...workspacePackagePaths.map((path) =>
      `${path.slice(0, -"/package.json".length)}/AGENTS.md`),
  ]);
  const presentPaths = new Set<string>();
  for (const path of candidatePaths) {
    if (await exists(resolve(repositoryRoot, path))) {
      presentPaths.add(relative(repositoryRoot, resolve(repositoryRoot, path)) || ".");
    }
  }
  const errors = publicStructureErrors({ manifests, presentPaths });
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Public structure clean: ${workspacePackagePaths.length} workspaces.`);
}

if (import.meta.main) await main();
