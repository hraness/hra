import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

export const HOSTED_ENVIRONMENT_NAMES = [
  "SITE_URL",
  "JWT_PRIVATE_KEY",
  "JWKS",
  "HRA_AUTH_HMAC_SECRET",
  "HRA_RESEND_API_KEY",
  "HRA_AUTH_EMAIL_FROM",
] as const;

const protectedInputMaximumBytes = 8 * 1024;
const convexOutputMaximumBytes = 64 * 1024;
const convexTimeoutMs = 60_000;
const commandOutputHardMaximumBytes = 1024 * 1024;
const commandTimeoutHardMaximumMs = 15 * 60 * 1_000;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

const hostedInputSchema = z.object({
  authEmailFrom: z.string()
    .min(3)
    .max(320)
    .refine((value) => !hasControlCharacter(value) && !value.includes("'")),
  resendApiKey: z.string()
    .min(8)
    .max(512)
    .regex(/^re_[A-Za-z0-9_-]+$/u),
  siteUrl: z.string()
    .min(8)
    .max(2_048)
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:"
          && parsed.username === ""
          && parsed.password === ""
          && parsed.origin === value;
      } catch {
        return false;
      }
    }),
}).strict();

export type HostedInput = z.infer<typeof hostedInputSchema>;

export type GeneratedHostedSecrets = Readonly<{
  hmacSecret: string;
  jwks: string;
  jwtPrivateKey: string;
}>;

export type CommandRequest = Readonly<{
  arguments: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  executable: string;
  outputMaximumBytes?: number;
  stdin: string;
  timeoutMs?: number;
}>;

export type CommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

type HostedSetupFailureCode =
  | "convex_environment_ambiguous"
  | "convex_environment_query_failed"
  | "convex_environment_set_failed"
  | "convex_environment_verification_failed"
  | "convex_target_refused"
  | "input_invalid"
  | "input_not_protected"
  | "input_timed_out"
  | "input_too_large"
  | "target_already_configured"
  | "usage_invalid";

class HostedSetupError extends Error {
  readonly code: HostedSetupFailureCode;

  constructor(code: HostedSetupFailureCode) {
    super(code);
    this.name = "HostedSetupError";
    this.code = code;
  }
}

type HostedArguments = Readonly<{
  inputFd: number;
  target: ConvexTarget;
}>;

const parseInteger = (value: string): number => {
  if (!/^[0-9]+$/u.test(value)) throw new HostedSetupError("usage_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 3 || parsed > 255) {
    throw new HostedSetupError("usage_invalid");
  }
  return parsed;
};

export function parseHostedArguments(arguments_: readonly string[]): HostedArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new HostedSetupError("usage_invalid");
  }
  let inputFd = 0;
  for (let index = 0; index < parsedTarget.otherArguments.length; index += 1) {
    const argument = parsedTarget.otherArguments[index];
    if (argument === "--input-fd" && inputFd === 0) {
      const value = parsedTarget.otherArguments[index + 1];
      if (value === undefined) throw new HostedSetupError("usage_invalid");
      inputFd = parseInteger(value);
      index += 1;
      continue;
    }
    throw new HostedSetupError("usage_invalid");
  }
  return { inputFd, target: parsedTarget.target };
}

export function parseHostedInput(document: string): HostedInput {
  if (Buffer.byteLength(document, "utf8") > protectedInputMaximumBytes) {
    throw new HostedSetupError("input_too_large");
  }
  try {
    return hostedInputSchema.parse(JSON.parse(document) as unknown);
  } catch {
    throw new HostedSetupError("input_invalid");
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const bytesToBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const privateKeyToPem = (key: ArrayBuffer): string => {
  const body = bytesToBase64(new Uint8Array(key)).match(/.{1,64}/gu)?.join("\n");
  if (body === undefined) throw new HostedSetupError("input_invalid");
  const begin = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const end = ["-----END", "PRIVATE", "KEY-----"].join(" ");
  return `${begin}\n${body}\n${end}`
    .replace(/\n/gu, " ");
};

export async function generateHostedSecrets(): Promise<GeneratedHostedSecrets> {
  const keys = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2_048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", keys.privateKey),
    crypto.subtle.exportKey("jwk", keys.publicKey),
  ]);
  if (
    publicKey.kty !== "RSA"
    || publicKey.n === undefined
    || publicKey.e === undefined
  ) throw new HostedSetupError("input_invalid");
  const hmacBytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    hmacSecret: bytesToBase64Url(hmacBytes),
    jwks: JSON.stringify({
      keys: [{
        alg: "RS256",
        e: publicKey.e,
        kty: "RSA",
        n: publicKey.n,
        use: "sig",
      }],
    }),
    jwtPrivateKey: privateKeyToPem(privateKey),
  };
}

const dotenvValue = (value: string): string => {
  if (hasControlCharacter(value) || value.includes("'")) {
    throw new HostedSetupError("input_invalid");
  }
  return `'${value}'`;
};

export function serializeHostedEnvironment(
  input: HostedInput,
  generated: GeneratedHostedSecrets,
): string {
  const hmac = generated.hmacSecret;
  const resend = input.resendApiKey;
  const values: Record<(typeof HOSTED_ENVIRONMENT_NAMES)[number], string> = {
    HRA_AUTH_EMAIL_FROM: input.authEmailFrom,
    HRA_AUTH_HMAC_SECRET: hmac,
    HRA_RESEND_API_KEY: resend,
    JWKS: generated.jwks,
    JWT_PRIVATE_KEY: generated.jwtPrivateKey,
    SITE_URL: input.siteUrl,
  };
  return `${HOSTED_ENVIRONMENT_NAMES
    .map((name) => `${name}=${dotenvValue(values[name])}`)
    .join("\n")}\n`;
}

const secretValues = (
  input: HostedInput,
  generated: GeneratedHostedSecrets,
): readonly string[] => [
  input.resendApiKey,
  generated.hmacSecret,
  generated.jwks,
  generated.jwtPrivateKey,
];

const childEnvironmentNames = [
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SystemRoot",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
] as const;

export function buildConvexChildEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  forbiddenValues: readonly string[],
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const name of childEnvironmentNames) {
    const value = source[name];
    if (
      value !== undefined
      && !forbiddenValues.some((secret) => secret.length > 0 && value.includes(secret))
    ) environment[name] = value;
  }
  return environment;
}

const parseEnvironmentNames = (output: string): ReadonlySet<string> => {
  if (Buffer.byteLength(output, "utf8") > convexOutputMaximumBytes) {
    throw new HostedSetupError("convex_environment_ambiguous");
  }
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/gu)) {
    if (line.length === 0) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(line) || names.has(line)) {
      throw new HostedSetupError("convex_environment_ambiguous");
    }
    names.add(line);
    if (names.size > 1_024) {
      throw new HostedSetupError("convex_environment_ambiguous");
    }
  }
  return names;
};

const listArguments = (deployment: string): readonly string[] => [
  "env",
  "list",
  "--names-only",
  "--deployment",
  deployment,
];

const setArguments = (deployment: string): readonly string[] => [
  "env",
  "set",
  "--deployment",
  deployment,
];

const convexCli = resolve(import.meta.dir, "..", "node_modules", "convex", "bin", "main.js");
const repositoryRoot = resolve(import.meta.dir, "..");

type ConfigureOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  generate?: () => Promise<GeneratedHostedSecrets>;
  input: HostedInput;
  runner?: CommandRunner;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function configureHostedSync(options: ConfigureOptions): Promise<void> {
  const target = parseConvexTarget(options.target);
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  await verifyTarget(target);
  const generated = await (options.generate ?? generateHostedSecrets)();
  const forbidden = secretValues(options.input, generated);
  const environment = buildConvexChildEnvironment(
    options.environment ?? process.env,
    forbidden,
  );
  const executable = process.execPath;
  const runner = options.runner ?? runCommand;
  const invoke = async (arguments_: readonly string[], stdin: string): Promise<CommandResult> =>
    await runner({
      arguments: [convexCli, ...arguments_],
      cwd: repositoryRoot,
      environment,
      executable,
      stdin,
    });
  const invokeMutation = async (
    arguments_: readonly string[],
    stdin: string,
  ): Promise<CommandResult> => {
    try {
      return await invoke(arguments_, stdin);
    } finally {
      await verifyTarget(target);
    }
  };

  const before = await invoke(listArguments(target.deploymentName), "");
  if (before.exitCode !== 0) {
    throw new HostedSetupError("convex_environment_query_failed");
  }
  const existing = parseEnvironmentNames(before.stdout);
  if (HOSTED_ENVIRONMENT_NAMES.some((name) => existing.has(name))) {
    throw new HostedSetupError("target_already_configured");
  }

  const configured = await invokeMutation(
    setArguments(target.deploymentName),
    serializeHostedEnvironment(options.input, generated),
  );
  if (configured.exitCode !== 0) {
    throw new HostedSetupError("convex_environment_set_failed");
  }

  const after = await invoke(listArguments(target.deploymentName), "");
  if (after.exitCode !== 0) {
    throw new HostedSetupError("convex_environment_verification_failed");
  }
  const verified = parseEnvironmentNames(after.stdout);
  if (!HOSTED_ENVIRONMENT_NAMES.every((name) => verified.has(name))) {
    throw new HostedSetupError("convex_environment_verification_failed");
  }
  await verifyTarget(target);
}

export const runCommand: CommandRunner = async (request) =>
  await new Promise<CommandResult>((resolvePromise) => {
    const requestedOutputMaximum = request.outputMaximumBytes === undefined
      || !Number.isSafeInteger(request.outputMaximumBytes)
      || request.outputMaximumBytes <= 0
      ? convexOutputMaximumBytes
      : request.outputMaximumBytes;
    const outputMaximumBytes = Math.min(
      requestedOutputMaximum,
      commandOutputHardMaximumBytes,
    );
    const requestedTimeout = request.timeoutMs === undefined
      || !Number.isSafeInteger(request.timeoutMs)
      || request.timeoutMs <= 0
      ? convexTimeoutMs
      : request.timeoutMs;
    const timeoutMs = Math.min(requestedTimeout, commandTimeoutHardMaximumMs);
    const child = spawn(request.executable, [...request.arguments], {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutState = { bytes: 0, overflow: false };
    const stderrState = { bytes: 0, overflow: false };
    let finished = false;
    const finish = (exitCode: number): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolvePromise({
        exitCode: stdoutState.overflow || stderrState.overflow ? 1 : exitCode,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(124);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutState.bytes += chunk.byteLength;
      if (stdoutState.bytes <= outputMaximumBytes) stdoutChunks.push(chunk);
      else stdoutState.overflow = true;
      if (stdoutState.overflow) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrState.bytes += chunk.byteLength;
      if (stderrState.bytes <= outputMaximumBytes) stderrChunks.push(chunk);
      else stderrState.overflow = true;
      if (stderrState.overflow) child.kill("SIGKILL");
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
    child.stdin.once("error", () => undefined);
    child.stdin.end(request.stdin, "utf8");
  });

export async function readProtectedInput(
  fd: number,
  timeoutMs = 15_000,
  dependencies: Readonly<{
    createStream?: (descriptor: number) => Pick<Readable, "destroy" | "on" | "once">;
    isTerminal?: (descriptor: number) => boolean;
  }> = {},
): Promise<string> {
  if ((dependencies.isTerminal ?? isatty)(fd)) {
    throw new HostedSetupError("input_not_protected");
  }
  return await new Promise<string>((resolvePromise, reject) => {
    const stream = dependencies.createStream?.(fd)
      ?? createReadStream("", { autoClose: fd !== 0, fd });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: HostedSetupError): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      else reject(error);
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish(new HostedSetupError("input_timed_out"));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > protectedInputMaximumBytes) {
        stream.destroy();
        finish(new HostedSetupError("input_too_large"));
      } else chunks.push(chunk);
    });
    stream.once("error", () => finish(new HostedSetupError("input_invalid")));
    stream.once("end", () => finish());
  });
}

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  generate?: () => Promise<GeneratedHostedSecrets>;
  inputDocument: string;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedSetup(options: ExecuteOptions): Promise<number> {
  try {
    const arguments_ = parseHostedArguments(options.arguments);
    const input = parseHostedInput(options.inputDocument);
    await configureHostedSync({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.generate === undefined ? {} : { generate: options.generate }),
      input,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      target: arguments_.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(
      `Configured ${String(HOSTED_ENVIRONMENT_NAMES.length)} fresh hosted variables.\n`,
    );
    return 0;
  } catch (error: unknown) {
    const code = error instanceof HostedSetupError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "input_invalid";
    options.stderr.write(`Hosted setup refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 1;
  try {
    const parsedArguments = parseHostedArguments(process.argv.slice(2));
    const inputDocument = await readProtectedInput(parsedArguments.inputFd);
    exitCode = await executeHostedSetup({
      arguments: process.argv.slice(2),
      inputDocument,
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const code = error instanceof HostedSetupError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "input_invalid";
    process.stderr.write(`Hosted setup refused (${code}).\n`);
  }
  process.exitCode = exitCode;
}
