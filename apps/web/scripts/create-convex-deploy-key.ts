import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

const MANAGEMENT_API_ORIGIN = "https://api.convex.dev/v1";
const HRA_PROJECT_ID = 2_680_173;
const HRA_TEAM_ID = 513_923;
const HRA_TEAM_SLUG = "cclrte";
const HRA_PRE_RENAME_PROJECT_NAME = "oprte";
const HRA_PRE_RENAME_PROJECT_SLUG = "oprte";
const HRA_PRODUCTION_DEPLOYMENT_ID = 4_677_913;
const HRA_PRODUCTION_DEPLOYMENT_NAME = "benevolent-akita-439";
const HRA_PRODUCTION_DEPLOYMENT_URL =
  "https://benevolent-akita-439.convex.cloud";
const HRA_DEPLOY_KEY_NAME = "vercel-hra-production-2026-08-17";
const HRA_DEPLOY_KEY_ACTION = "deployment:deploy";
const MAX_AUTH_FILE_BYTES = 32_768;
const MAX_PROVIDER_RESPONSE_BYTES = 1_048_576;
const safeProvisioningErrorCodes = new Set([
  "provider-auth-file-changed",
  "provider-auth-file-invalid",
  "provider-auth-file-oversized",
  "provider-created-key-invalid",
  "provider-deployment-identity-mismatch",
  "provider-file-custody-invalid",
  "provider-key-list-invalid",
  "provider-key-metadata-invalid",
  "provider-key-name-already-exists",
  "provider-key-readback-mismatch",
  "provider-project-identity-mismatch",
  "provider-response-empty",
  "provider-response-invalid",
  "provider-response-oversized",
  "provider-secret-parent-custody-invalid",
  "provider-secret-file-changed",
  "provider-secret-file-write-failed",
]);

type FileEvidence = Stats;

type DeployKeyMetadata = Readonly<{
  allowedActions: readonly string[];
  creationTime: number;
  expiresAt: number | null;
  id: number;
  lastUsedTime: number | null;
  name: string;
}>;

type SecretDestination = Readonly<{
  descriptor: number;
  evidence: FileEvidence;
  path: string;
}>;

export type ConvexManagementFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ConvexDeployKeyProvisioning = Readonly<{
  action: "create-deploy-key";
  deployment: Readonly<{
    id: typeof HRA_PRODUCTION_DEPLOYMENT_ID;
    name: typeof HRA_PRODUCTION_DEPLOYMENT_NAME;
    projectId: typeof HRA_PROJECT_ID;
  }>;
  key: DeployKeyMetadata & Readonly<{
    allowedActions: readonly [typeof HRA_DEPLOY_KEY_ACTION];
  }>;
  project: Readonly<{
    id: typeof HRA_PROJECT_ID;
    slug: typeof HRA_PRE_RENAME_PROJECT_SLUG;
    teamId: typeof HRA_TEAM_ID;
    teamSlug: typeof HRA_TEAM_SLUG;
  }>;
  secretFile: Readonly<{
    bytes: number;
    mode: "0600";
    path: string;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerOrNull(value: unknown): value is number | null {
  return value === null || Number.isSafeInteger(value);
}

function sameFile(left: FileEvidence, right: FileEvidence): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function assertSecureRegularFile(
  path: string,
  evidence: Stats,
  expectedSize: "empty" | "nonempty",
): void {
  if (
    !isAbsolute(path)
    || realpathSync.native(path) !== path
    || !evidence.isFile()
    || evidence.isSymbolicLink()
    || evidence.nlink !== 1
    || (evidence.mode & 0o777) !== 0o600
    || (process.getuid?.() !== undefined && evidence.uid !== process.getuid())
    || (expectedSize === "empty" ? evidence.size !== 0 : evidence.size < 1)
  ) {
    throw new Error("provider-file-custody-invalid");
  }
}

export function readConvexPersonalAccessToken(authFile: string): string {
  const pathEvidence = lstatSync(authFile);
  assertSecureRegularFile(authFile, pathEvidence, "nonempty");
  if (pathEvidence.size > MAX_AUTH_FILE_BYTES) {
    throw new Error("provider-auth-file-oversized");
  }
  const descriptor = openSync(
    authFile,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    const source = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor);
    const finalPath = lstatSync(authFile);
    if (
      !sameFile(before, after)
      || !sameFile(before, pathEvidence)
      || !sameFile(after, finalPath)
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || realpathSync.native(authFile) !== authFile
    ) {
      throw new Error("provider-auth-file-changed");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(source) as unknown;
    } catch {
      throw new Error("provider-auth-file-invalid");
    }
    const accessToken = isRecord(decoded) ? decoded["accessToken"] : undefined;
    if (
      typeof accessToken !== "string"
      || accessToken.length < 16
      || accessToken.length > 8_192
      || /\s/u.test(accessToken)
    ) {
      throw new Error("provider-auth-file-invalid");
    }
    return accessToken;
  } finally {
    closeSync(descriptor);
  }
}

function openSecretDestination(secretFile: string): SecretDestination {
  const parentPath = dirname(secretFile);
  const parentEvidence = lstatSync(parentPath);
  if (
    realpathSync.native(parentPath) !== parentPath
    || !parentEvidence.isDirectory()
    || parentEvidence.isSymbolicLink()
    || (parentEvidence.mode & 0o777) !== 0o700
    || (process.getuid?.() !== undefined && parentEvidence.uid !== process.getuid())
  ) {
    throw new Error("provider-secret-parent-custody-invalid");
  }
  const pathEvidence = lstatSync(secretFile);
  assertSecureRegularFile(secretFile, pathEvidence, "empty");
  const descriptor = openSync(
    secretFile,
    constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const evidence = fstatSync(descriptor);
  if (!sameFile(evidence, pathEvidence) || evidence.size !== 0) {
    closeSync(descriptor);
    throw new Error("provider-secret-file-changed");
  }
  return { descriptor, evidence, path: secretFile };
}

function commitSecret(destination: SecretDestination, secret: string): number {
  const bytes = Buffer.from(secret, "utf8");
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const written = writeSync(
        destination.descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
      );
      if (written < 1) throw new Error("provider-secret-file-write-failed");
      offset += written;
    }
    fsyncSync(destination.descriptor);
    const after = fstatSync(destination.descriptor);
    const finalPath = lstatSync(destination.path);
    if (
      !sameFile(destination.evidence, after)
      || !sameFile(after, finalPath)
      || after.size !== bytes.byteLength
      || realpathSync.native(destination.path) !== destination.path
    ) {
      throw new Error("provider-secret-file-changed");
    }
    return bytes.byteLength;
  } catch (error) {
    try {
      ftruncateSync(destination.descriptor, 0);
      fsyncSync(destination.descriptor);
    } catch {
      // Preserve the original fail-closed custody error.
    }
    throw error;
  } finally {
    closeSync(destination.descriptor);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`provider-http-${response.status}`);
  }
  if (response.body === null) throw new Error("provider-response-empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("provider-response-oversized");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new Error("provider-response-invalid");
  }
}

async function managementRequest(
  accessToken: string,
  path: string,
  options: Readonly<{
    body?: unknown;
    fetch: ConvexManagementFetch;
    method: "GET" | "POST";
  }>,
): Promise<unknown> {
  const response = await options.fetch(`${MANAGEMENT_API_ORIGIN}${path}`, {
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(options.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
    },
    method: options.method,
    redirect: "error",
  });
  return readBoundedJson(response);
}

function parseProject(value: unknown): ConvexDeployKeyProvisioning["project"] {
  if (
    !isRecord(value)
    || value["id"] !== HRA_PROJECT_ID
    || value["name"] !== HRA_PRE_RENAME_PROJECT_NAME
    || value["slug"] !== HRA_PRE_RENAME_PROJECT_SLUG
    || value["teamId"] !== HRA_TEAM_ID
    || value["teamSlug"] !== HRA_TEAM_SLUG
    || value["prodDeploymentName"] !== HRA_PRODUCTION_DEPLOYMENT_NAME
  ) {
    throw new Error("provider-project-identity-mismatch");
  }
  return {
    id: HRA_PROJECT_ID,
    slug: HRA_PRE_RENAME_PROJECT_SLUG,
    teamId: HRA_TEAM_ID,
    teamSlug: HRA_TEAM_SLUG,
  };
}

function parseDeployment(
  value: unknown,
): ConvexDeployKeyProvisioning["deployment"] {
  if (
    !isRecord(value)
    || value["id"] !== HRA_PRODUCTION_DEPLOYMENT_ID
    || value["name"] !== HRA_PRODUCTION_DEPLOYMENT_NAME
    || value["projectId"] !== HRA_PROJECT_ID
    || value["deploymentType"] !== "prod"
    || value["isDefault"] !== true
    || value["reference"] !== "production"
    || value["region"] !== "aws-us-east-1"
    || value["deploymentUrl"] !== HRA_PRODUCTION_DEPLOYMENT_URL
    || value["kind"] !== "cloud"
  ) {
    throw new Error("provider-deployment-identity-mismatch");
  }
  return {
    id: HRA_PRODUCTION_DEPLOYMENT_ID,
    name: HRA_PRODUCTION_DEPLOYMENT_NAME,
    projectId: HRA_PROJECT_ID,
  };
}

function parseDeployKeyMetadata(value: unknown): DeployKeyMetadata {
  if (
    !isRecord(value)
    || !Number.isSafeInteger(value["id"])
    || typeof value["name"] !== "string"
    || !Number.isSafeInteger(value["creationTime"])
    || !Array.isArray(value["allowedActions"])
    || !value["allowedActions"].every((action) => typeof action === "string")
    || !Object.hasOwn(value, "expiresAt")
    || !Object.hasOwn(value, "lastUsedTime")
    || !isIntegerOrNull(value["expiresAt"])
    || !isIntegerOrNull(value["lastUsedTime"])
  ) {
    throw new Error("provider-key-metadata-invalid");
  }
  return {
    allowedActions: [...value["allowedActions"]].toSorted(),
    creationTime: Number(value["creationTime"]),
    expiresAt: value["expiresAt"],
    id: Number(value["id"]),
    lastUsedTime: value["lastUsedTime"],
    name: value["name"],
  };
}

function parseDeployKeyList(value: unknown): readonly DeployKeyMetadata[] {
  if (!Array.isArray(value)) throw new Error("provider-key-list-invalid");
  const parsed = value
    .map(parseDeployKeyMetadata)
    .toSorted((left, right) => left.id - right.id);
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const key of parsed) {
    if (ids.has(key.id) || names.has(key.name)) {
      throw new Error("provider-key-list-invalid");
    }
    ids.add(key.id);
    names.add(key.name);
  }
  return parsed;
}

function parseCreatedSecret(value: unknown): string {
  const secret = isRecord(value) ? value["deployKey"] : undefined;
  const prefix = `prod:${HRA_PRODUCTION_DEPLOYMENT_NAME}|`;
  if (
    typeof secret !== "string"
    || secret.length <= prefix.length
    || secret.length > 16_384
    || !secret.startsWith(prefix)
    || secret.indexOf("|", prefix.length) !== -1
    || /\s/u.test(secret)
  ) {
    throw new Error("provider-created-key-invalid");
  }
  return secret;
}

export async function provisionHraConvexDeployKey(options: Readonly<{
  authFile: string;
  fetch?: ConvexManagementFetch;
  secretFile: string;
}>): Promise<ConvexDeployKeyProvisioning> {
  const accessToken = readConvexPersonalAccessToken(options.authFile);
  const providerFetch = options.fetch ?? fetch;
  const project = parseProject(await managementRequest(
    accessToken,
    `/projects/${HRA_PROJECT_ID}`,
    { fetch: providerFetch, method: "GET" },
  ));
  const deployment = parseDeployment(await managementRequest(
    accessToken,
    `/deployments/${HRA_PRODUCTION_DEPLOYMENT_NAME}`,
    { fetch: providerFetch, method: "GET" },
  ));
  const before = parseDeployKeyList(await managementRequest(
    accessToken,
    `/deployments/${HRA_PRODUCTION_DEPLOYMENT_NAME}/list_deploy_keys`,
    { fetch: providerFetch, method: "GET" },
  ));
  if (before.some(({ name }) => name === HRA_DEPLOY_KEY_NAME)) {
    throw new Error("provider-key-name-already-exists");
  }

  const destination = openSecretDestination(options.secretFile);
  let secret: string;
  let key: DeployKeyMetadata;
  try {
    secret = parseCreatedSecret(await managementRequest(
      accessToken,
      `/deployments/${HRA_PRODUCTION_DEPLOYMENT_NAME}/create_deploy_key`,
      {
        body: {
          allowedActions: [HRA_DEPLOY_KEY_ACTION],
          name: HRA_DEPLOY_KEY_NAME,
        },
        fetch: providerFetch,
        method: "POST",
      },
    ));
    const after = parseDeployKeyList(await managementRequest(
      accessToken,
      `/deployments/${HRA_PRODUCTION_DEPLOYMENT_NAME}/list_deploy_keys`,
      { fetch: providerFetch, method: "GET" },
    ));
    const beforeIds = new Set(before.map(({ id }) => id));
    const added = after.filter(({ id }) => !beforeIds.has(id));
    const retained = after.filter(({ id }) => beforeIds.has(id));
    if (
      added.length !== 1
      || JSON.stringify(retained) !== JSON.stringify(before)
      || after.filter(({ name }) => name === HRA_DEPLOY_KEY_NAME).length !== 1
      || added[0]?.name !== HRA_DEPLOY_KEY_NAME
      || added[0]?.expiresAt !== null
      || added[0]?.lastUsedTime !== null
      || added[0]?.allowedActions.length !== 1
      || added[0]?.allowedActions[0] !== HRA_DEPLOY_KEY_ACTION
    ) {
      throw new Error("provider-key-readback-mismatch");
    }
    key = added[0];
    parseProject(await managementRequest(
      accessToken,
      `/projects/${HRA_PROJECT_ID}`,
      { fetch: providerFetch, method: "GET" },
    ));
    parseDeployment(await managementRequest(
      accessToken,
      `/deployments/${HRA_PRODUCTION_DEPLOYMENT_NAME}`,
      { fetch: providerFetch, method: "GET" },
    ));
  } catch (error) {
    closeSync(destination.descriptor);
    throw error;
  }
  const bytes = commitSecret(destination, secret);
  return {
    action: "create-deploy-key",
    deployment,
    key: {
      ...key,
      allowedActions: [HRA_DEPLOY_KEY_ACTION],
    },
    project,
    secretFile: {
      bytes,
      mode: "0600",
      path: options.secretFile,
    },
  };
}

function parseArguments(
  arguments_: readonly string[],
): Readonly<{ authFile: string; secretFile: string }> | null {
  return arguments_.length === 4
      && arguments_[0] === "--auth-file"
      && arguments_[1] !== undefined
      && arguments_[2] === "--secret-file"
      && arguments_[3] !== undefined
    ? { authFile: arguments_[1], secretFile: arguments_[3] }
    : null;
}

export function safeProvisioningErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "provider-operation-failed";
  return safeProvisioningErrorCodes.has(error.message)
      || /^provider-http-[1-5][0-9]{2}$/u.test(error.message)
    ? error.message
    : "provider-operation-failed";
}

if (import.meta.main) {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_ === null) {
    console.error(
      "Convex deploy-key provisioning refused: unsupported-arguments.",
    );
    process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await provisionHraConvexDeployKey(arguments_)));
    } catch (error) {
      console.error(
        `Convex deploy-key provisioning failed: ${safeProvisioningErrorCode(error)}.`,
      );
      process.exitCode = 1;
    }
  }
}
