import { createRequire } from "node:module";
import { accessSync, chmodSync, constants, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { codexChildEnvironment } from "./security/environment";
import { optionalRenamedEnvironmentValue } from "./security/renamed-environment";
import { applicationSupportRoot } from "./state/application-support";

const require = createRequire(import.meta.url);

export interface RuntimePaths {
  readonly bunBinary: string;
  readonly codexBinary: string;
  readonly codexHome: string;
  readonly gitBinary: string;
  readonly gitRoot: string;
}

export type PortableRuntimeAssets = Omit<RuntimePaths, "codexHome">;

function executable(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const canonical = realpathSync(path);
  accessSync(canonical, constants.X_OK);
  return canonical;
}

function directory(path: string, label: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return realpathSync(path);
}

function developmentCodexBinary(): string {
  const codexPackage = realpathSync(dirname(require.resolve("@openai/codex/package.json")));
  const packageJson = join(dirname(codexPackage), "codex-darwin-arm64", "package.json");
  return join(dirname(packageJson), "vendor", "aarch64-apple-darwin", "bin", "codex");
}

function developmentGitRoot(): string {
  return join(dirname(require.resolve("dugite/package.json")), "git");
}

function developmentBunBinary(): string {
  const candidate = realpathSync(process.execPath);
  if (!basename(candidate).startsWith("bun")) {
    throw new Error(
      "A compiled gateway requires the exact packaged HRA_BUN_BIN runtime.",
    );
  }
  return candidate;
}

export function resolveRuntimePaths(environment: NodeJS.ProcessEnv = process.env): RuntimePaths {
  const assets = resolvePortableRuntimeAssets(environment);
  const homeDirectory = environment.HOME ?? homedir();
  const configuredCodexHome = optionalRenamedEnvironmentValue(
    environment,
    "HRA_CODEX_HOME",
  );
  const codexHome = configuredCodexHome
    ? join(configuredCodexHome)
    : join(
        applicationSupportRoot(homeDirectory),
        "profiles",
        "default",
        "codex-home",
      );

  return accountPaths(assets, codexHome);
}

export function resolvePortableRuntimeAssets(
  environment: NodeJS.ProcessEnv = process.env,
): PortableRuntimeAssets {
  const gitRoot = directory(
    optionalRenamedEnvironmentValue(environment, "HRA_GIT_ROOT")
      ?? developmentGitRoot(),
    "Git root",
  );

  return {
    bunBinary: executable(
      optionalRenamedEnvironmentValue(environment, "HRA_BUN_BIN")
        ?? developmentBunBinary(),
      "Bun binary",
    ),
    codexBinary: executable(
      optionalRenamedEnvironmentValue(environment, "HRA_CODEX_BIN")
        ?? developmentCodexBinary(),
      "Codex binary",
    ),
    gitBinary: executable(
      optionalRenamedEnvironmentValue(environment, "HRA_GIT_BIN")
        ?? join(gitRoot, "bin", "git"),
      "Git binary",
    ),
    gitRoot,
  };
}

export function accountPaths(
  assets: PortableRuntimeAssets,
  codexHome: string,
): RuntimePaths {
  if (!isAbsolute(codexHome)) {
    throw new Error("Codex home must be an absolute path");
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const canonicalCodexHome = realpathSync(codexHome);
  chmodSync(canonicalCodexHome, 0o700);

  return {
    ...assets,
    codexHome: canonicalCodexHome,
  };
}

export function childEnvironment(paths: RuntimePaths, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return codexChildEnvironment({
    codexHome: paths.codexHome,
    gitRoot: paths.gitRoot,
    home: environment.HOME ?? homedir(),
    temporaryDirectory: environment.TMPDIR ?? tmpdir(),
    parent: environment,
  });
}
