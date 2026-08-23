import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lstat, open, type FileHandle } from "node:fs/promises";

import { z } from "zod";

const configMaximumBytes = 8 * 1024;
const responseMaximumBytes = 64 * 1024;
const requestTimeoutMs = 15_000;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

export const HRA_V0_CONVEX_PROJECT_ID = 2_680_173;
export const HRA_V0_CONVEX_DEPLOYMENT_ID = 4_677_913;
export const HRA_CONVEX_TEAM_ID = 513_923;
export const HRA_CONVEX_TEAM_SLUG = "cclrte";

const generatedDeploymentNameSchema = z.string()
  .min(5)
  .max(160)
  .regex(/^[a-z][a-z0-9]*-[a-z][a-z0-9]*-[0-9]+$/u);

const numericIdentifierSchema = z.number().int().positive().safe();

const deploymentUrlSchema = z.string()
  .min(8)
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:"
        && parsed.username === ""
        && parsed.password === ""
        && parsed.origin === value
        && parsed.hostname.endsWith(".convex.cloud");
    } catch {
      return false;
    }
  });

const expectedTargetSchema = z.object({
  deploymentId: numericIdentifierSchema,
  deploymentName: generatedDeploymentNameSchema,
  deploymentUrl: deploymentUrlSchema,
  projectId: numericIdentifierSchema,
  teamId: z.literal(HRA_CONVEX_TEAM_ID),
}).strict().superRefine((target, context) => {
  if (target.projectId === HRA_V0_CONVEX_PROJECT_ID) {
    context.addIssue({ code: "custom", message: "HRA v0 project is forbidden." });
  }
  if (target.deploymentId === HRA_V0_CONVEX_DEPLOYMENT_ID) {
    context.addIssue({ code: "custom", message: "HRA v0 deployment is forbidden." });
  }
});

const teamAndProjectSchema = z.object({
  project: z.string().min(1).max(256),
  projectId: numericIdentifierSchema,
  team: z.literal(HRA_CONVEX_TEAM_SLUG),
  teamId: z.literal(HRA_CONVEX_TEAM_ID),
}).passthrough();

const deploymentReadbackSchema = z.object({
  deploymentType: z.literal("prod"),
  deploymentUrl: deploymentUrlSchema,
  id: numericIdentifierSchema,
  name: generatedDeploymentNameSchema,
  projectId: numericIdentifierSchema,
}).passthrough();

const configSchema = z.object({
  accessToken: z.string()
    .min(1)
    .max(4_096)
    .refine((value) => !hasControlCharacter(value)),
}).passthrough();

export type ConvexTarget = Readonly<z.infer<typeof expectedTargetSchema>>;

export type ConvexTargetErrorCode =
  | "target_credentials_refused"
  | "target_invalid"
  | "target_mismatch"
  | "target_query_failed";

export class ConvexTargetError extends Error {
  readonly code: ConvexTargetErrorCode;

  constructor(code: ConvexTargetErrorCode) {
    super(code);
    this.name = "ConvexTargetError";
    this.code = code;
  }
}

export function parseConvexTarget(value: unknown): ConvexTarget {
  const parsed = expectedTargetSchema.safeParse(value);
  if (!parsed.success) throw new ConvexTargetError("target_invalid");
  return parsed.data;
}

const parsePositiveInteger = (value: string): number => {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new ConvexTargetError("target_invalid");
  const parsed = Number(value);
  if (!numericIdentifierSchema.safeParse(parsed).success) {
    throw new ConvexTargetError("target_invalid");
  }
  return parsed;
};

type ParsedConvexTargetArguments = Readonly<{
  otherArguments: readonly string[];
  target: ConvexTarget;
}>;

export function parseConvexTargetArguments(
  arguments_: readonly string[],
): ParsedConvexTargetArguments {
  let deploymentId: number | undefined;
  let deploymentName: string | undefined;
  let deploymentUrl: string | undefined;
  let projectId: number | undefined;
  let teamId: number | undefined;
  const otherArguments: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--deployment" && deploymentName === undefined) {
      if (value === undefined) throw new ConvexTargetError("target_invalid");
      deploymentName = value;
      index += 1;
      continue;
    }
    if (argument === "--deployment-url" && deploymentUrl === undefined) {
      if (value === undefined) throw new ConvexTargetError("target_invalid");
      deploymentUrl = value;
      index += 1;
      continue;
    }
    if (argument === "--team-id" && teamId === undefined) {
      if (value === undefined) throw new ConvexTargetError("target_invalid");
      teamId = parsePositiveInteger(value);
      index += 1;
      continue;
    }
    if (argument === "--project-id" && projectId === undefined) {
      if (value === undefined) throw new ConvexTargetError("target_invalid");
      projectId = parsePositiveInteger(value);
      index += 1;
      continue;
    }
    if (argument === "--deployment-id" && deploymentId === undefined) {
      if (value === undefined) throw new ConvexTargetError("target_invalid");
      deploymentId = parsePositiveInteger(value);
      index += 1;
      continue;
    }
    if (
      argument === "--deployment"
      || argument === "--deployment-url"
      || argument === "--team-id"
      || argument === "--project-id"
      || argument === "--deployment-id"
    ) throw new ConvexTargetError("target_invalid");
    if (argument !== undefined) otherArguments.push(argument);
  }

  const parsed = expectedTargetSchema.safeParse({
    deploymentId,
    deploymentName,
    deploymentUrl,
    projectId,
    teamId,
  });
  if (!parsed.success) throw new ConvexTargetError("target_invalid");
  return { otherArguments, target: parsed.data };
}

type FileIdentity = Readonly<{ dev: number; ino: number }>;

const matchingRegularPath = async (
  path: string,
  identity: FileIdentity,
): Promise<boolean> => {
  try {
    const current = await lstat(path);
    return current.isFile()
      && current.dev === identity.dev
      && current.ino === identity.ino
      && current.nlink === 1
      && (current.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
};

export async function readConvexAccessToken(
  configPath = join(homedir(), ".convex", "config.json"),
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new ConvexTargetError("target_credentials_refused");
  }
  try {
    const identity = await handle.stat();
    if (
      !identity.isFile()
      || identity.nlink !== 1
      || (identity.mode & 0o777) !== 0o600
      || identity.size <= 0
      || identity.size > configMaximumBytes
      || !await matchingRegularPath(configPath, identity)
    ) throw new ConvexTargetError("target_credentials_refused");
    const document = await handle.readFile("utf8");
    if (Buffer.byteLength(document, "utf8") !== identity.size) {
      throw new ConvexTargetError("target_credentials_refused");
    }
    const parsed = configSchema.safeParse(JSON.parse(document) as unknown);
    if (!parsed.success) throw new ConvexTargetError("target_credentials_refused");
    return parsed.data.accessToken;
  } catch (error: unknown) {
    if (error instanceof ConvexTargetError) throw error;
    throw new ConvexTargetError("target_credentials_refused");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const readBoundedJson = async (response: Response): Promise<unknown> => {
  if (response.status !== 200 || response.body === null) {
    throw new ConvexTargetError("target_query_failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    let result = await reader.read();
    while (!result.done) {
      bytes += result.value.byteLength;
      if (bytes > responseMaximumBytes) {
        throw new ConvexTargetError("target_query_failed");
      }
      chunks.push(result.value);
      result = await reader.read();
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ConvexTargetError) throw error;
    throw new ConvexTargetError("target_query_failed");
  }
  const document = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  if (document.trim().length === 0) throw new ConvexTargetError("target_query_failed");
  try {
    return JSON.parse(document) as unknown;
  } catch {
    throw new ConvexTargetError("target_query_failed");
  }
};

export type ConvexManagementFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export type ConvexTargetVerificationOptions = Readonly<{
  configPath?: string;
  fetch?: ConvexManagementFetch;
}>;

export type ConvexTargetVerifier = (target: ConvexTarget) => Promise<void>;

export async function verifyConvexTarget(
  targetValue: ConvexTarget,
  options: ConvexTargetVerificationOptions = {},
): Promise<void> {
  const target = parseConvexTarget(targetValue);
  const accessToken = await readConvexAccessToken(options.configPath);
  const fetcher = options.fetch ?? fetch;
  const encodedName = encodeURIComponent(target.deploymentName);
  const request = async (url: URL): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Convex-Client": "hra-hosted-operator-v1",
        },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new ConvexTargetError("target_query_failed");
    }
    return await readBoundedJson(response);
  };

  const [teamAndProjectValue, deploymentValue] = await Promise.all([
    request(new URL(
      `/api/deployment/${encodedName}/team_and_project`,
      "https://api.convex.dev",
    )),
    request(new URL(`/v1/deployments/${encodedName}`, "https://api.convex.dev")),
  ]);
  const teamAndProject = teamAndProjectSchema.safeParse(teamAndProjectValue);
  const deployment = deploymentReadbackSchema.safeParse(deploymentValue);
  if (
    !teamAndProject.success
    || !deployment.success
    || teamAndProject.data.projectId !== target.projectId
    || deployment.data.id !== target.deploymentId
    || deployment.data.name !== target.deploymentName
    || deployment.data.projectId !== target.projectId
    || deployment.data.deploymentUrl !== target.deploymentUrl
  ) throw new ConvexTargetError("target_mismatch");
}
