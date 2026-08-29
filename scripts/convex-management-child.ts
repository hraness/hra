import { z } from "zod";

import {
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
  HRA_CONVEX_TEAM_SLUG,
  parseConvexTarget,
  readConvexAccessToken,
  type ConvexTarget,
} from "./convex-target";
import { readProtectedInput } from "./configure-hosted-sync";

const managementOrigin = "https://api.convex.dev";
const requestTimeoutMs = 30_000;
const responseMaximumBytes = 64 * 1024;

const deploymentNameSchema = z.string()
  .min(5)
  .max(160)
  .regex(/^[a-z][a-z0-9]*-[a-z][a-z0-9]*-[0-9]+$/u);

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

const projectSlugSchema = z.string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9-]*$/u);

const targetSchema = z.object({
  deploymentId: z.number().int().positive().safe(),
  deploymentName: deploymentNameSchema,
  deploymentUrl: deploymentUrlSchema,
  projectId: z.literal(HRA_CONVEX_PROJECT_ID),
  teamId: z.literal(HRA_CONVEX_TEAM_ID),
}).strict();

const replacementReferenceSchema = z.string()
  .regex(/^hra-replace-[0-9a-f]{32}$/u);

const childRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create_nondefault"),
    previousTarget: targetSchema,
    reference: replacementReferenceSchema,
  }).strict(),
  z.object({
    kind: z.literal("reconcile_create"),
    previousTarget: targetSchema,
    reference: replacementReferenceSchema,
  }).strict(),
  z.object({
    kind: z.literal("demote_default"),
    previousTarget: targetSchema,
    target: targetSchema,
  }).strict(),
  z.object({
    kind: z.literal("promote_default"),
    previousTarget: targetSchema,
    target: targetSchema,
  }).strict(),
  z.object({
    kind: z.literal("reconcile_demotion"),
    previousTarget: targetSchema,
    target: targetSchema,
  }).strict(),
  z.object({
    kind: z.literal("reconcile_promotion"),
    previousTarget: targetSchema,
    target: targetSchema,
  }).strict(),
  z.object({
    kind: z.literal("verify_default"),
    target: targetSchema,
  }).strict(),
  z.object({
    kind: z.literal("verify_switch_preconditions"),
    previousTarget: targetSchema,
    target: targetSchema,
  }).strict(),
  z.object({
    kind: z.literal("verify_demoted"),
    previousTarget: targetSchema,
    target: targetSchema,
  }).strict(),
]);

const deploymentReadbackSchema = z.object({
  deploymentType: z.literal("prod"),
  deploymentUrl: deploymentUrlSchema,
  id: z.number().int().positive().safe(),
  isDefault: z.boolean(),
  name: deploymentNameSchema,
  projectId: z.number().int().positive().safe(),
}).passthrough();

const projectReadbackSchema = z.object({
  id: z.literal(HRA_CONVEX_PROJECT_ID),
  prodDeploymentName: deploymentNameSchema.nullable(),
  slug: projectSlugSchema,
  teamId: z.literal(HRA_CONVEX_TEAM_ID),
}).passthrough();

const teamAndProjectReadbackSchema = z.object({
  project: projectSlugSchema,
  projectId: z.literal(HRA_CONVEX_PROJECT_ID),
  team: z.literal(HRA_CONVEX_TEAM_SLUG),
  teamId: z.literal(HRA_CONVEX_TEAM_ID),
}).passthrough();

const deploymentReferenceReadbackSchema = z.object({
  name: deploymentNameSchema,
}).passthrough();

const createDeploymentReadbackSchema = z.object({
  kind: z.literal("cloud"),
  name: deploymentNameSchema,
}).passthrough();

export const convexManagementChildResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("demoted"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("reference_missing") }).strict(),
  z.object({ kind: z.literal("switched"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("verified_default"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("verified_demoted"), target: targetSchema }).strict(),
  z.object({ kind: z.literal("verified_switch_preconditions"), target: targetSchema }).strict(),
]);

type ManagementChildRequest = z.infer<typeof childRequestSchema>;
export type ConvexManagementChildResult = z.infer<typeof convexManagementChildResultSchema>;

export class ConvexManagementChildError extends Error {
  constructor(readonly code: "input_invalid" | "provider_request_failed" | "provider_response_invalid" | "target_refused") {
    super(code);
    this.name = "ConvexManagementChildError";
  }
}

export type ManagementFetcher = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

type ChildOptions = Readonly<{
  fetcher?: ManagementFetcher;
  readAccessToken?: () => Promise<string>;
}>;

const sameTarget = (left: ConvexTarget, right: ConvexTarget): boolean => (
  left.deploymentId === right.deploymentId
  && left.deploymentName === right.deploymentName
  && left.deploymentUrl === right.deploymentUrl
);

const targetIsDistinct = (previous: ConvexTarget, target: ConvexTarget): boolean => (
  previous.deploymentId !== target.deploymentId
  && previous.deploymentName !== target.deploymentName
  && previous.deploymentUrl !== target.deploymentUrl
);

const parseRequest = (document: string): ManagementChildRequest => {
  if (Buffer.byteLength(document, "utf8") > 8 * 1024 || document.trim().length === 0) {
    throw new ConvexManagementChildError("input_invalid");
  }
  try {
    return childRequestSchema.parse(JSON.parse(document) as unknown);
  } catch {
    throw new ConvexManagementChildError("input_invalid");
  }
};

const discardResponse = async (response: Response): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

const readBoundedJson = async (response: Response): Promise<unknown> => {
  if (response.body === null) throw new ConvexManagementChildError("provider_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > responseMaximumBytes) {
        throw new ConvexManagementChildError("provider_response_invalid");
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ConvexManagementChildError) throw error;
    throw new ConvexManagementChildError("provider_response_invalid");
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  if (text.trim().length === 0) throw new ConvexManagementChildError("provider_response_invalid");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConvexManagementChildError("provider_response_invalid");
  }
};

const consumeBoundedResponse = async (response: Response): Promise<void> => {
  if (response.body === null) return;
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      bytes += next.value.byteLength;
      if (bytes > responseMaximumBytes) {
        throw new ConvexManagementChildError("provider_response_invalid");
      }
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ConvexManagementChildError) throw error;
    throw new ConvexManagementChildError("provider_response_invalid");
  }
};

class ManagementClient {
  readonly #fetcher: ManagementFetcher;
  readonly #token: string;

  constructor(fetcher: ManagementFetcher, token: string) {
    this.#fetcher = fetcher;
    this.#token = token;
  }

  async json(
    path: string,
    options: Readonly<{ body?: unknown; method: "GET" | "PATCH" | "POST" }> = { method: "GET" },
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetcher(new URL(path, managementOrigin), {
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "Convex-Client": "hra-hosted-recovery-v1",
        },
        method: options.method,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new ConvexManagementChildError("provider_request_failed");
    }
    if (response.status !== 200) {
      await discardResponse(response);
      throw new ConvexManagementChildError("provider_request_failed");
    }
    return await readBoundedJson(response);
  }

  async referenceName(reference: string): Promise<string | null> {
    const path = `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}/deployment?reference=${encodeURIComponent(reference)}`;
    let response: Response;
    try {
      response = await this.#fetcher(new URL(path, managementOrigin), {
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Convex-Client": "hra-hosted-recovery-v1",
        },
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new ConvexManagementChildError("provider_request_failed");
    }
    if (response.status === 404) {
      await discardResponse(response);
      return null;
    }
    if (response.status !== 200) {
      await discardResponse(response);
      throw new ConvexManagementChildError("provider_request_failed");
    }
    try {
      return deploymentReferenceReadbackSchema.parse(await readBoundedJson(response)).name;
    } catch {
      throw new ConvexManagementChildError("provider_response_invalid");
    }
  }

  async patchDefault(deploymentName: string, isDefault: boolean): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetcher(new URL(
        `/v1/deployments/${encodeURIComponent(deploymentName)}`,
        managementOrigin,
      ), {
        body: JSON.stringify({ isDefault }),
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "Convex-Client": "hra-hosted-recovery-v1",
        },
        method: "PATCH",
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      throw new ConvexManagementChildError("provider_request_failed");
    }
    if (response.status !== 200) {
      await discardResponse(response);
      throw new ConvexManagementChildError("provider_request_failed");
    }
    await consumeBoundedResponse(response);
  }

  async project(): Promise<z.infer<typeof projectReadbackSchema>> {
    try {
      return projectReadbackSchema.parse(await this.json(
        `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}`,
      ));
    } catch (error: unknown) {
      if (error instanceof ConvexManagementChildError) throw error;
      throw new ConvexManagementChildError("provider_response_invalid");
    }
  }
}

type TargetReadback = Readonly<{
  isDefault: boolean;
  projectDefaultName: string | null;
  target: ConvexTarget;
}>;

const readTarget = async (
  client: ManagementClient,
  deploymentName: string,
): Promise<TargetReadback> => {
  const encodedName = encodeURIComponent(deploymentName);
  const [teamAndProjectValue, deploymentValue, project] = await Promise.all([
    client.json(`/api/deployment/${encodedName}/team_and_project`),
    client.json(`/v1/deployments/${encodedName}`),
    client.project(),
  ]);
  let teamAndProject: z.infer<typeof teamAndProjectReadbackSchema>;
  let deployment: z.infer<typeof deploymentReadbackSchema>;
  try {
    teamAndProject = teamAndProjectReadbackSchema.parse(teamAndProjectValue);
    deployment = deploymentReadbackSchema.parse(deploymentValue);
  } catch {
    throw new ConvexManagementChildError("provider_response_invalid");
  }
  if (teamAndProject.project !== project.slug) {
    throw new ConvexManagementChildError("target_refused");
  }
  let target: ConvexTarget;
  try {
    target = parseConvexTarget({
      deploymentId: deployment.id,
      deploymentName: deployment.name,
      deploymentUrl: deployment.deploymentUrl,
      projectId: deployment.projectId,
      teamId: teamAndProject.teamId,
    });
  } catch {
    throw new ConvexManagementChildError("target_refused");
  }
  return {
    isDefault: deployment.isDefault,
    projectDefaultName: project.prodDeploymentName,
    target,
  };
};

const verifyDefault = async (
  client: ManagementClient,
  expected: ConvexTarget,
): Promise<void> => {
  const observed = await readTarget(client, expected.deploymentName);
  if (
    !sameTarget(observed.target, expected)
    || !observed.isDefault
    || observed.projectDefaultName !== expected.deploymentName
  ) throw new ConvexManagementChildError("target_refused");
};

const verifyNondefault = async (
  client: ManagementClient,
  expected: ConvexTarget,
): Promise<void> => {
  const observed = await readTarget(client, expected.deploymentName);
  if (
    !sameTarget(observed.target, expected)
    || observed.isDefault
    || observed.projectDefaultName === expected.deploymentName
  ) {
    throw new ConvexManagementChildError("target_refused");
  }
};

const createNondefault = async (
  client: ManagementClient,
  previousTarget: ConvexTarget,
  reference: string,
): Promise<ConvexTarget> => {
  await verifyDefault(client, previousTarget);
  let createdName: string;
  try {
    createdName = createDeploymentReadbackSchema.parse(await client.json(
      `/v1/projects/${String(HRA_CONVEX_PROJECT_ID)}/create_deployment`,
      {
        body: {
          isDefault: false,
          reference,
          region: null,
          type: "prod",
        },
        method: "POST",
      },
    )).name;
  } catch (error: unknown) {
    if (error instanceof ConvexManagementChildError) throw error;
    throw new ConvexManagementChildError("provider_response_invalid");
  }
  const referenceName = await client.referenceName(reference);
  const observed = await readTarget(client, createdName);
  if (
    referenceName !== createdName
    || observed.isDefault
    || !targetIsDistinct(previousTarget, observed.target)
  ) throw new ConvexManagementChildError("target_refused");
  await verifyDefault(client, previousTarget);
  return observed.target;
};

const reconcileCreate = async (
  client: ManagementClient,
  previousTarget: ConvexTarget,
  reference: string,
): Promise<ConvexManagementChildResult> => {
  const name = await client.referenceName(reference);
  if (name === null) return { kind: "reference_missing" };
  const observed = await readTarget(client, name);
  if (!observed.isDefault && targetIsDistinct(previousTarget, observed.target)) {
    await verifyDefault(client, previousTarget);
    return { kind: "created", target: observed.target };
  }
  throw new ConvexManagementChildError("target_refused");
};

const verifySwitchPreconditions = async (
  client: ManagementClient,
  previousTarget: ConvexTarget,
  target: ConvexTarget,
): Promise<void> => {
  if (!targetIsDistinct(previousTarget, target)) {
    throw new ConvexManagementChildError("target_refused");
  }
  await verifyDefault(client, previousTarget);
  await verifyNondefault(client, target);
};

const verifyDemoted = async (
  client: ManagementClient,
  previousTarget: ConvexTarget,
  target: ConvexTarget,
): Promise<void> => {
  if (!targetIsDistinct(previousTarget, target)) {
    throw new ConvexManagementChildError("target_refused");
  }
  const [previous, replacement] = await Promise.all([
    readTarget(client, previousTarget.deploymentName),
    readTarget(client, target.deploymentName),
  ]);
  if (
    !sameTarget(previous.target, previousTarget)
    || !sameTarget(replacement.target, target)
    || previous.isDefault
    || replacement.isDefault
    || previous.projectDefaultName !== null
    || replacement.projectDefaultName !== null
  ) throw new ConvexManagementChildError("target_refused");
};

const demoteDefault = async (
  client: ManagementClient,
  previousTarget: ConvexTarget,
  target: ConvexTarget,
): Promise<ConvexTarget> => {
  await verifySwitchPreconditions(client, previousTarget, target);
  await client.patchDefault(previousTarget.deploymentName, false);
  await verifyDemoted(client, previousTarget, target);
  return target;
};

const promoteDefault = async (
  client: ManagementClient,
  previousTarget: ConvexTarget,
  target: ConvexTarget,
): Promise<ConvexTarget> => {
  await verifyDemoted(client, previousTarget, target);
  await client.patchDefault(target.deploymentName, true);
  await verifyDefault(client, target);
  await verifyNondefault(client, previousTarget);
  return target;
};

export async function executeConvexManagementChild(
  inputDocument: string,
  options: ChildOptions = {},
): Promise<ConvexManagementChildResult> {
  const request = parseRequest(inputDocument);
  const readAccessToken = options.readAccessToken ?? readConvexAccessToken;
  let token: string;
  try {
    token = await readAccessToken();
  } catch {
    throw new ConvexManagementChildError("provider_request_failed");
  }
  if (token.length < 1 || token.length > 4_096) {
    throw new ConvexManagementChildError("provider_request_failed");
  }
  const client = new ManagementClient(options.fetcher ?? fetch, token);
  switch (request.kind) {
    case "verify_default":
      await verifyDefault(client, parseConvexTarget(request.target));
      return { kind: "verified_default", target: request.target };
    case "create_nondefault":
      return {
        kind: "created",
        target: await createNondefault(
          client,
          parseConvexTarget(request.previousTarget),
          request.reference,
        ),
      };
    case "reconcile_create":
      return await reconcileCreate(
        client,
        parseConvexTarget(request.previousTarget),
        request.reference,
      );
    case "verify_switch_preconditions":
      await verifySwitchPreconditions(
        client,
        parseConvexTarget(request.previousTarget),
        parseConvexTarget(request.target),
      );
      return { kind: "verified_switch_preconditions", target: request.target };
    case "verify_demoted":
      await verifyDemoted(
        client,
        parseConvexTarget(request.previousTarget),
        parseConvexTarget(request.target),
      );
      return { kind: "verified_demoted", target: request.target };
    case "demote_default":
      return {
        kind: "demoted",
        target: await demoteDefault(
          client,
          parseConvexTarget(request.previousTarget),
          parseConvexTarget(request.target),
        ),
      };
    case "reconcile_demotion":
      await verifyDemoted(
        client,
        parseConvexTarget(request.previousTarget),
        parseConvexTarget(request.target),
      );
      return { kind: "demoted", target: request.target };
    case "promote_default":
      return {
        kind: "switched",
        target: await promoteDefault(
          client,
          parseConvexTarget(request.previousTarget),
          parseConvexTarget(request.target),
        ),
      };
    case "reconcile_promotion":
      await verifyDefault(client, parseConvexTarget(request.target));
      await verifyNondefault(client, parseConvexTarget(request.previousTarget));
      return { kind: "switched", target: request.target };
    default:
      request satisfies never;
      throw new ConvexManagementChildError("input_invalid");
  }
}

if (import.meta.main) {
  let exitCode = 1;
  try {
    const inputDocument = await readProtectedInput(0);
    const result = await executeConvexManagementChild(inputDocument);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    exitCode = 0;
  } catch {
    process.stderr.write("Convex management operation refused.\n");
  }
  process.exitCode = exitCode;
}
