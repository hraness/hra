import { join } from "node:path";

export interface CodexChildEnvironmentOptions {
  readonly codexHome: string;
  readonly gitRoot: string;
  readonly home: string;
  readonly temporaryDirectory: string;
  readonly parent?: Readonly<Record<string, string | undefined>>;
}

const inheritedKeys = ["LANG", "LC_ALL", "LOGNAME", "SHELL", "TZ", "USER"] as const;

export function codexChildEnvironment(options: CodexChildEnvironmentOptions): Record<string, string> {
  const parent = options.parent ?? {};
  const environment: Record<string, string> = {
    CODEX_HOME: options.codexHome,
    GIT_CONFIG_NOSYSTEM: "0",
    GIT_CONFIG_SYSTEM: join(options.gitRoot, "etc", "gitconfig"),
    GIT_EXEC_PATH: join(options.gitRoot, "libexec", "git-core"),
    GIT_TEMPLATE_DIR: join(options.gitRoot, "share", "git-core", "templates"),
    GIT_TERMINAL_PROMPT: "0",
    HOME: options.home,
    PATH: `${join(options.gitRoot, "bin")}:/usr/bin:/bin`,
    TMPDIR: options.temporaryDirectory,
  };
  for (const key of inheritedKeys) {
    const value = parent[key];
    if (value !== undefined && value.length > 0) environment[key] = value;
  }
  return environment;
}
