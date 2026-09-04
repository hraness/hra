import { ClaudeError } from "./errors.ts";

export interface ClaudeProcess {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number>;
  write(bytes: Uint8Array): Promise<void>;
  terminate(): void;
  forceTerminate(): void;
}

export interface SpawnClaudeProcessOptions {
  readonly argv: readonly [string, ...string[]];
  /** Absolute. Becomes the child's whole configuration, session, and credential home. */
  readonly configDir: string;
  readonly projectRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * The same allowlist the Codex spawner uses. Nothing else from the parent
 * environment crosses the boundary, so no ambient API key, proxy, or provider
 * credential can reach the Claude runtime.
 */
export const SAFE_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
]);

export function allowlistedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  extraKeys: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(environment)) {
    if ((SAFE_ENVIRONMENT_KEYS.has(key) || extraKeys.has(key)) && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function spawnBunClaudeProcess(options: SpawnClaudeProcessOptions): ClaudeProcess {
  if (!options.configDir.startsWith("/")) {
    throw new ClaudeError("INVALID_INPUT", "CLAUDE_CONFIG_DIR must be an absolute path");
  }
  const env = allowlistedEnvironment(options.environment ?? process.env);
  env.CLAUDE_CONFIG_DIR = options.configDir;
  env.NO_COLOR = "1";

  const child = Bun.spawn([...options.argv], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    ...(options.projectRoot === undefined ? {} : { cwd: options.projectRoot }),
  });

  if (typeof child.stdin === "number") {
    child.kill();
    throw new ClaudeError("PROCESS_EXITED", "Claude did not expose a writable stdin pipe");
  }

  const stdin = child.stdin;
  return {
    exited: child.exited,
    forceTerminate(): void {
      child.kill("SIGKILL");
    },
    stderr: readableStreamChunks(child.stderr),
    stdout: readableStreamChunks(child.stdout),
    terminate(): void {
      child.kill("SIGTERM");
    },
    async write(bytes: Uint8Array): Promise<void> {
      const written = stdin.write(bytes);
      const count = written instanceof Promise ? await written : written;
      if (count !== bytes.byteLength) {
        throw new ClaudeError("PROCESS_EXITED", "Claude stdin accepted a partial frame");
      }
      const flushed = stdin.flush();
      if (flushed instanceof Promise) await flushed;
    },
  };
}

async function* readableStreamChunks(
  stream: ReadableStream<Uint8Array> | number | undefined,
): AsyncIterable<Uint8Array> {
  if (stream === undefined || typeof stream === "number") return;
  const reader = stream.getReader();
  try {
    let result = await reader.read();
    while (!result.done) {
      if (result.value.byteLength > 0) yield result.value;
      result = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}
