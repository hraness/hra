import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  createSuiteReceiptProviderProof,
  parseSuiteReceiptKeyring,
} from "../suite-account-receipts";

const HRA_PRODUCTION_DEPLOYMENT = "benevolent-akita-439";
const MAX_PROVIDER_OUTPUT_BYTES = 32_768;

type VerificationSubprocess = Readonly<{
  exited: Promise<number>;
  stderr: ReadableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}>;

export type ReceiptProviderVerificationLauncher = (
  command: readonly string[],
  options: Readonly<{
    env: Record<string, string | undefined>;
    stderr: "pipe";
    stdin: "ignore";
    stdout: "pipe";
  }>,
) => VerificationSubprocess;

export type ReceiptProviderVerification = Readonly<{
  candidateSecretMatch: true;
  hraProductionV1Count: 1;
  keyCount: 1;
  otherKeyCount: 0;
  selectorV1: true;
  status: "ready";
}>;

type ReceiptProviderAuditResponse = Readonly<{
  candidateProof: string;
  hraProductionV1Count: 1;
  keyCount: 1;
  otherKeyCount: 0;
  selectorV1: true;
  status: "ready";
}>;

function sameFileEvidence(
  before: ReturnType<typeof fstatSync>,
  after: ReturnType<typeof fstatSync>,
): boolean {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.mode === after.mode
    && before.nlink === after.nlink
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.ctimeMs === after.ctimeMs;
}

export function readReceiptCandidateSecret(path: string): string {
  if (!isAbsolute(path) || realpathSync.native(path) !== path) {
    throw new Error("receipt-candidate-path-invalid");
  }
  const pathEvidence = lstatSync(path);
  if (
    !pathEvidence.isFile()
    || pathEvidence.isSymbolicLink()
    || pathEvidence.nlink !== 1
    || (pathEvidence.mode & 0o777) !== 0o600
    || (process.getuid?.() !== undefined && pathEvidence.uid !== process.getuid())
    || pathEvidence.size < 43
    || pathEvidence.size > 1_366
  ) {
    throw new Error("receipt-candidate-custody-invalid");
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    const value = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const finalPathEvidence = lstatSync(path);
    if (
      !sameFileEvidence(before, after)
      || before.dev !== pathEvidence.dev
      || before.ino !== pathEvidence.ino
      || after.dev !== finalPathEvidence.dev
      || after.ino !== finalPathEvidence.ino
      || realpathSync.native(path) !== path
    ) {
      throw new Error("receipt-candidate-changed");
    }
    const parsed = parseSuiteReceiptKeyring({
      keys: [{
        environment: "production",
        keyVersion: "v1",
        product: "hra",
        secret: value,
      }],
      version: 1,
    });
    if (parsed === null || parsed.keys.length !== 1) {
      throw new Error("receipt-candidate-secret-invalid");
    }
    return parsed.keys[0]!.secret;
  } finally {
    closeSync(descriptor);
  }
}

export function hraOnlyReceiptKeyringFromSecret(secret: string): string {
  const parsed = parseSuiteReceiptKeyring({
    keys: [{
      environment: "production",
      keyVersion: "v1",
      product: "hra",
      secret,
    }],
    version: 1,
  });
  if (parsed === null || parsed.keys.length !== 1) {
    throw new Error("receipt-candidate-secret-invalid");
  }
  return JSON.stringify(parsed);
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_PROVIDER_OUTPUT_BYTES) {
      await reader.cancel();
      throw new Error("receipt-provider-output-oversized");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReceiptProviderVerification(
  value: unknown,
): ReceiptProviderVerification {
  if (
    !isRecord(value)
    || value["candidateSecretMatch"] !== true
    || value["hraProductionV1Count"] !== 1
    || value["keyCount"] !== 1
    || value["otherKeyCount"] !== 0
    || value["selectorV1"] !== true
    || value["status"] !== "ready"
    || Object.keys(value).sort().join(",") !== [
      "candidateSecretMatch",
      "hraProductionV1Count",
      "keyCount",
      "otherKeyCount",
      "selectorV1",
      "status",
    ].join(",")
  ) {
    throw new Error("receipt-provider-verification-failed");
  }
  return value as ReceiptProviderVerification;
}

function parseReceiptProviderAuditResponse(
  value: unknown,
): ReceiptProviderAuditResponse {
  if (
    !isRecord(value)
    || typeof value["candidateProof"] !== "string"
    || !/^[A-Za-z0-9_-]{43}$/u.test(value["candidateProof"])
    || Buffer.from(value["candidateProof"], "base64url").toString("base64url")
      !== value["candidateProof"]
    || value["hraProductionV1Count"] !== 1
    || value["keyCount"] !== 1
    || value["otherKeyCount"] !== 0
    || value["selectorV1"] !== true
    || value["status"] !== "ready"
    || Object.keys(value).sort().join(",") !== [
      "candidateProof",
      "hraProductionV1Count",
      "keyCount",
      "otherKeyCount",
      "selectorV1",
      "status",
    ].join(",")
  ) {
    throw new Error("receipt-provider-verification-failed");
  }
  return value as ReceiptProviderAuditResponse;
}

function defaultLauncher(
  command: readonly string[],
  options: Parameters<ReceiptProviderVerificationLauncher>[1],
): VerificationSubprocess {
  const child = Bun.spawn([...command], options);
  if (child.stdout === undefined || child.stderr === undefined) {
    throw new Error("receipt-provider-launch-failed");
  }
  return {
    exited: child.exited,
    stderr: child.stderr,
    stdout: child.stdout,
  };
}

export async function verifyReceiptProvider(options: Readonly<{
  createChallenge?: () => string;
  environment?: Record<string, string | undefined>;
  launch?: ReceiptProviderVerificationLauncher;
  secretFile: string;
}>): Promise<ReceiptProviderVerification> {
  const secret = readReceiptCandidateSecret(options.secretFile);
  const challenge = options.createChallenge?.()
    ?? randomBytes(32).toString("base64url");
  const expectedProof = await createSuiteReceiptProviderProof(secret, challenge);
  if (expectedProof === null) {
    throw new Error("receipt-provider-challenge-invalid");
  }
  const launch = options.launch ?? defaultLauncher;
  const child = launch([
    process.execPath,
    "x",
    "convex",
    "run",
    "suiteIdentityAudit:audit",
    JSON.stringify({ challenge }),
    "--deployment",
    HRA_PRODUCTION_DEPLOYMENT,
  ], {
    env: { ...(options.environment ?? process.env) },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    readBounded(child.stdout),
    readBounded(child.stderr),
  ]);
  if (exitCode !== 0) throw new Error("receipt-provider-query-failed");
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("receipt-provider-output-malformed");
  }
  const audit = parseReceiptProviderAuditResponse(decoded);
  const receivedProof = Buffer.from(audit.candidateProof, "base64url");
  const localProof = Buffer.from(expectedProof, "base64url");
  if (
    receivedProof.byteLength !== localProof.byteLength
    || !timingSafeEqual(receivedProof, localProof)
  ) {
    throw new Error("receipt-provider-verification-failed");
  }
  return parseReceiptProviderVerification({
    candidateSecretMatch: true,
    hraProductionV1Count: audit.hraProductionV1Count,
    keyCount: audit.keyCount,
    otherKeyCount: audit.otherKeyCount,
    selectorV1: audit.selectorV1,
    status: audit.status,
  });
}

function parseArguments(arguments_: readonly string[]): string | null {
  return arguments_.length === 2
      && arguments_[0] === "--secret-file"
      && arguments_[1] !== undefined
    ? arguments_[1]
    : null;
}

if (import.meta.main) {
  const secretFile = parseArguments(process.argv.slice(2));
  if (secretFile === null) {
    console.error("Receipt provider verification refused: unsupported-arguments.");
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await verifyReceiptProvider({ secretFile })));
    } catch {
      console.error("Receipt provider verification failed.");
      process.exitCode = 1;
    }
  }
}
