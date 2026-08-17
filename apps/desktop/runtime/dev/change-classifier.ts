const MAX_REPOSITORY_RELATIVE_PATH_BYTES = 2_048;
const MAX_REPOSITORY_RELATIVE_SEGMENTS = 128;

export type RepositoryRelativePath = string & {
  readonly __repositoryRelativePath: unique symbol;
};

export type DevChangeClassification =
  | Readonly<{ readonly kind: "ignored" }>
  | Readonly<{ readonly kind: "frontendLive" }>
  | Readonly<{ readonly kind: "gatewayReload" }>
  | Readonly<{
    readonly kind: "restartRequired";
    readonly target: "native" | "launcher";
  }>;

export const HRA_GATEWAY_TRANSITIVE_WORKSPACE_ROOTS = Object.freeze([
  "packages/human-client",
  "packages/task-protocol",
  "packages/task-domain",
  "packages/internal/schema",
  "packages/internal/codex-app-sdk",
] as const);

const IGNORED_SEGMENTS = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "docs",
  "kb",
  "node_modules",
  "test",
  "tests",
  "zig-out",
]);

const IGNORED_BASENAMES = new Set([
  "AGENTS.md",
  "CONTRIBUTING.md",
  "HARNESS.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "SECURITY_ARCHITECTURE.md",
  "STYLE.md",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "WRITING.md",
]);

const LAUNCHER_CONFIGURATION_BASENAMES = new Set([
  "bun.lock",
  "bunfig.toml",
  "eslint.config.mjs",
  "package.json",
  "tsconfig.json",
  "turbo.json",
  "vite.config.ts",
]);

const NATIVE_CONFIGURATION_BASENAMES = new Set([
  "app.zon",
  "build.zig",
  "build.zig.zon",
]);

// A candidate gateway executes its ordinary boot graph before the renderer can
// acknowledge and adopt it. Default every runtime module to a cold restart so
// a newly edited recovery, serialization, provider, or persistence path cannot
// mutate durable authority while the stable executable still names the prior
// generation. Widen this allowlist only for strictly parsed bounded data whose
// cold renderer has no persistence, process, network, provider, or boot-time
// authority. Executable TypeScript is deliberately excluded.
const SAFE_GATEWAY_RELOAD_PATHS = new Set([
  "apps/desktop/runtime/src/harness/actor-instruction-policy-v1.json",
]);

const COLD_FRONTEND_TOOLING_PATHS = new Set([
  "apps/desktop/frontend/dev/apply.ts",
  "apps/desktop/frontend/dev/main.dev.tsx",
  "apps/desktop/frontend/dev/native-runtime.ts",
  "apps/desktop/frontend/dev/protocol.ts",
  "apps/desktop/frontend/dev/root-lease.ts",
  "apps/desktop/frontend/dev/status-client.ts",
  "apps/desktop/frontend/dev/vite-plugin.ts",
]);

function bytesIn(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseRepositoryRelativePath(value: unknown): RepositoryRelativePath {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A development change path must be a non-empty string.");
  }
  if (
    value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || bytesIn(value) > MAX_REPOSITORY_RELATIVE_PATH_BYTES
  ) {
    throw new Error("A development change path must be a bounded repository-relative POSIX path.");
  }
  const segments = value.split("/");
  if (
    segments.length > MAX_REPOSITORY_RELATIVE_SEGMENTS
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error("A development change path may not contain empty or traversal segments.");
  }
  return value as RepositoryRelativePath;
}

function looksLikeTest(basename: string): boolean {
  return /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(basename)
    || basename.endsWith(".property.test.ts")
    || basename.endsWith(".property.test.tsx");
}

function isIgnored(segments: readonly string[]): boolean {
  const basename = segments.at(-1) ?? "";
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return true;
  if (segments[0] === ".github") return true;
  if (IGNORED_BASENAMES.has(basename)) return true;
  if (looksLikeTest(basename)) return true;
  if (/\.(?:md|mdx)$/u.test(basename)) return true;
  if (
    segments.length >= 4
    && segments[0] === "apps"
    && segments[1] === "desktop"
    && segments[2] === "frontend"
    && segments[3] === "direct"
  ) return true;
  return false;
}

function isDesktopPath(
  segments: readonly string[],
  first: string,
): boolean {
  return segments[0] === "apps"
    && segments[1] === "desktop"
    && segments[2] === first;
}

function isGatewayTransitiveWorkspaceSource(path: RepositoryRelativePath): boolean {
  return HRA_GATEWAY_TRANSITIVE_WORKSPACE_ROOTS.some((root) => (
    path === root || path.startsWith(`${root}/`)
  ));
}

export function classifyDevChange(
  path: RepositoryRelativePath,
): DevChangeClassification {
  const segments = path.split("/");
  const basename = segments.at(-1) ?? "";
  if (isIgnored(segments)) return { kind: "ignored" };

  if (
    NATIVE_CONFIGURATION_BASENAMES.has(basename)
    || isDesktopPath(segments, "src")
    || /\.(?:c|h|m|mm|swift|zig|zon)$/u.test(basename)
  ) {
    return { kind: "restartRequired", target: "native" };
  }

  if (
    LAUNCHER_CONFIGURATION_BASENAMES.has(basename)
    || isGatewayTransitiveWorkspaceSource(path)
    || COLD_FRONTEND_TOOLING_PATHS.has(path)
    || isDesktopPath(segments, "contracts")
    || (
      isDesktopPath(segments, "runtime")
      && (
        segments[3] === "dev"
        || segments.length === 4
        || (
          segments[3] === "src"
          && !SAFE_GATEWAY_RELOAD_PATHS.has(path)
        )
      )
    )
  ) {
    return { kind: "restartRequired", target: "launcher" };
  }

  if (
    isDesktopPath(segments, "frontend")
  ) {
    return { kind: "frontendLive" };
  }
  if (
    segments[0] === "packages"
    && segments[1] === "internal"
    && segments[2] === "design-kit"
    && basename.endsWith(".css")
  ) {
    return { kind: "frontendLive" };
  }

  if (
    SAFE_GATEWAY_RELOAD_PATHS.has(path)
  ) {
    return { kind: "gatewayReload" };
  }

  return { kind: "restartRequired", target: "launcher" };
}

export function parseAndClassifyDevChange(value: unknown): DevChangeClassification {
  return classifyDevChange(parseRepositoryRelativePath(value));
}
