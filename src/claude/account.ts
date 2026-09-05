import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { ClaudeError } from "./errors.ts";
import { allowlistedEnvironment } from "./process.ts";
import type { PinnedClaudeRuntime } from "./runtime.ts";

export type ClaudeConfigurationHome = "isolated" | "personal";

export type ClaudeAccountProjection = Readonly<{
  signedIn: boolean;
  accountId?: string;
  email?: string;
  organizationId?: string;
}>;

export type ClaudeAccountMetadataReader = (path: string) => Promise<unknown>;

export type ClaudeAuthStatusProbe = (input: Readonly<{
  configDir: string;
  configHome: ClaudeConfigurationHome;
  runtime: PinnedClaudeRuntime;
  signal: AbortSignal;
}>) => Promise<unknown>;

const ACCOUNT_DOCUMENT_MAX_BYTES = 128 * 1_024;
const AUTH_STATUS_MAX_BYTES = 16 * 1_024;
const AUTH_STATUS_TIMEOUT_MS = 3_000;
const ACCOUNT_IDENTITY_MAX_BYTES = 320;
const encoder = new TextEncoder();

type ClaudeAccountIdentity = Readonly<{
  accountUuid: string | null;
  email: string | null;
  organizationUuid: string | null;
}>;

/**
 * Claude's default home is asymmetric: sessions live in `~/.claude`, while
 * the non-secret account metadata document lives at `~/.claude.json`.
 * Explicit `CLAUDE_CONFIG_DIR` homes place that document inside the selected
 * directory. Keep this distinction closed and testable instead of guessing at
 * call sites.
 */
export function claudeAccountDocumentPath(
  configDir: string,
  configHome: ClaudeConfigurationHome,
): string {
  if (!isAbsolute(configDir)) {
    throw new ClaudeError("INVALID_INPUT", "The Claude configuration home must be absolute.");
  }
  return configHome === "personal"
    ? `${configDir}.json`
    : join(configDir, ".claude.json");
}

/**
 * Proves a currently authenticated Claude account without reading a token.
 * `claude auth status --json` supplies current sign-in state; two no-follow
 * reads of the scalar-only account metadata fence an identity change across
 * that status probe. API-key and provider modes remain signed in but carry no
 * stable email, so the daemon can refuse to grant session authority to them.
 */
export async function readClaudeAccountProjection(input: Readonly<{
  configDir: string;
  configHome: ClaudeConfigurationHome;
  runtime: PinnedClaudeRuntime;
  signal: AbortSignal;
  readMetadata?: ClaudeAccountMetadataReader;
  probeAuthStatus?: ClaudeAuthStatusProbe;
}>): Promise<ClaudeAccountProjection> {
  input.signal.throwIfAborted();
  const accountPath = claudeAccountDocumentPath(input.configDir, input.configHome);
  const readMetadata = input.readMetadata ?? readAccountMetadataDocument;
  const probeAuthStatus = input.probeAuthStatus ?? spawnClaudeAuthStatusProbe;
  const before = parseAccountIdentity(await readMetadata(accountPath));
  const status = parseAuthStatus(await probeAuthStatus({
    configDir: input.configDir,
    configHome: input.configHome,
    runtime: input.runtime,
    signal: input.signal,
  }));
  input.signal.throwIfAborted();
  const after = parseAccountIdentity(await readMetadata(accountPath));
  if (!sameAccountIdentity(before, after)) {
    throw new ClaudeError(
      "AUTHORITY_STALE",
      "Claude account identity changed during its protected status read.",
    );
  }
  if (!status.signedIn) return Object.freeze({ signedIn: false });
  if (before === null) return Object.freeze({ signedIn: true });
  return Object.freeze({
    signedIn: true,
    ...(before.accountUuid === null ? {} : { accountId: before.accountUuid }),
    ...(before.email === null ? {} : { email: before.email }),
    ...(before.organizationUuid === null
      ? {}
      : { organizationId: before.organizationUuid }),
  });
}

export const spawnClaudeAuthStatusProbe: ClaudeAuthStatusProbe = async (input) => {
  input.signal.throwIfAborted();
  const env = allowlistedEnvironment(process.env);
  if (input.configHome === "isolated") env.CLAUDE_CONFIG_DIR = input.configDir;
  env.NO_COLOR = "1";
  const child = Bun.spawn([
    input.runtime.executablePath,
    "auth",
    "status",
    "--json",
  ], {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = collectBoundedStdout(child.stdout, AUTH_STATUS_MAX_BYTES);
  const completion = Promise.all([child.exited, stdout]);
  void completion.catch(() => undefined);
  let rejectBoundary!: (reason: unknown) => void;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const stop = (reason: unknown): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The closed failure below remains authoritative.
    }
    rejectBoundary(reason);
  };
  const onAbort = (): void => stop(input.signal.reason);
  input.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => stop(new ClaudeError("TIMEOUT", "Claude account status did not settle in time.")),
    AUTH_STATUS_TIMEOUT_MS,
  );
  timer.unref();
  try {
    const [exitCode, text] = await Promise.race([completion, boundary]);
    if (exitCode !== 0) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude account status was unavailable.");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (cause: unknown) {
      throw new ClaudeError("PROTOCOL_ERROR", "Claude account status was invalid.", { cause });
    }
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
  }
};

async function readAccountMetadataDocument(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw new ClaudeError("AUTHORITY_STALE", "Claude account metadata was unavailable.", {
      cause: error,
    });
  }
  try {
    const metadata = await handle.stat();
    const uid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size < 2
      || metadata.size > ACCOUNT_DOCUMENT_MAX_BYTES
      || (metadata.mode & 0o077) !== 0
      || (uid !== undefined && metadata.uid !== uid)
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude account metadata failed its custody checks.");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > ACCOUNT_DOCUMENT_MAX_BYTES) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude account metadata exceeded its size bound.");
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch (cause: unknown) {
      throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata was invalid.", { cause });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseAuthStatus(value: unknown): Readonly<{ signedIn: boolean }> {
  if (!isRecord(value) || typeof value.loggedIn !== "boolean") {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account status omitted its sign-in state.");
  }
  return Object.freeze({ signedIn: value.loggedIn });
}

function parseAccountIdentity(value: unknown): ClaudeAccountIdentity | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata was not an object.");
  }
  if (value.oauthAccount === undefined) return null;
  if (!isRecord(value.oauthAccount)) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata contained an invalid identity.");
  }
  const email = optionalIdentityScalar(value.oauthAccount.emailAddress, true);
  const accountUuid = optionalIdentityScalar(value.oauthAccount.accountUuid, false);
  const organizationUuid = optionalIdentityScalar(value.oauthAccount.organizationUuid, false);
  return Object.freeze({ accountUuid, email, organizationUuid });
}

function optionalIdentityScalar(value: unknown, email: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata contained an invalid scalar.");
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || encoder.encode(normalized).byteLength > ACCOUNT_IDENTITY_MAX_BYTES
    || hasAsciiControlCharacter(normalized)
    || (email && !/^[^@\s]+@[^@\s]+$/u.test(normalized))
  ) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata contained an invalid scalar.");
  }
  return normalized;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function sameAccountIdentity(
  left: ClaudeAccountIdentity | null,
  right: ClaudeAccountIdentity | null,
): boolean {
  return left?.accountUuid === right?.accountUuid
    && left?.email === right?.email
    && left?.organizationUuid === right?.organizationUuid;
}

async function collectBoundedStdout(
  stream: ReadableStream<Uint8Array> | number | undefined,
  maximumBytes: number,
): Promise<string> {
  if (stream === undefined || typeof stream === "number") {
    throw new ClaudeError("PROCESS_EXITED", "Claude account status exposed no stdout stream.");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        throw new ClaudeError("PROTOCOL_LIMIT", "Claude account status exceeded its output bound.");
      }
      if (next.value.byteLength > 0) chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account status was not UTF-8.", { cause });
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
