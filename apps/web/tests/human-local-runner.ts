import {
  promotionBatchV2RequestDigest,
  promotionBatchV2Schema,
  promotionEntityCountsSchema,
  promotionEntityFamilyValues,
  promotionFamilyInitialDigest,
  promotionManifestV2RootDigest,
  promotionManifestV2Schema,
  promotionSnapshotFamilyDigests,
  type PromotionEntity,
  type PromotionManifestV2,
} from "@hraness/agent-tasks-domain";
import {
  createBearerSecret,
  createLocator,
  createUuidV7,
  formatCredentialToken,
  formatEnrollmentToken,
  hraPromotionApiOperations,
  hraPromotionApiRoutes,
  redactSecretsInText,
} from "@hraness/agent-tasks-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeWorkOS } from "./fake-workos";
import { proveSignedHumanReceivesTaskctlMutation } from "./realtime-cli-proof";

const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONVEX_BINARY = fileURLToPath(new URL("../node_modules/.bin/convex", import.meta.url));
const ENV_FILE = fileURLToPath(new URL("../.env.local", import.meta.url));
const FIXTURE_SUBJECT = "taskctl-local-black-box";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deterministicBytes(seed: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + 3_266_489_917) >>> 0;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

let requestSequence = 0;

function nextIdempotencyKey(): string {
  requestSequence += 1;
  return createUuidV7(Date.now(), deterministicBytes(0x53594e43 + requestSequence, 10));
}

function promotionConvergenceFixture() {
  const sourceWorkspaceLocator = createLocator(
    crypto.getRandomValues(new Uint8Array(26)),
  );
  const sourceWorkspaceId = `wsp_${sourceWorkspaceLocator}`;
  const promotionId = `promotion_${createLocator(
    crypto.getRandomValues(new Uint8Array(26)),
  )}`;
  const entities = [
    {
      family: "workspace_metadata",
      workspaceId: sourceWorkspaceId,
      name: "Signed client promotion convergence",
      slug: `promotion-${sourceWorkspaceLocator.slice(-12).toLowerCase()}`,
      keyPrefix: "PC",
    },
    {
      family: "executors",
      workspaceId: sourceWorkspaceId,
      executor: "local_codex",
      enabled: true,
    },
  ] as const satisfies readonly PromotionEntity[];
  const counts = promotionEntityCountsSchema.parse(Object.fromEntries(
    promotionEntityFamilyValues.map((family) => [
      family,
      entities.filter((entity) => entity.family === family).length,
    ]),
  ));
  const familyDigests = promotionSnapshotFamilyDigests(entities);
  const manifestInput = {
    schemaVersion: 2 as const,
    promotionId,
    sourceWorkspaceId,
    sourceWorkspaceRevision: 1,
    sourceEventSequence: 1,
    createdAt: Date.now(),
    counts,
    familyDigests,
    terminalLocalWork: {
      queuedIntents: 0 as const,
      activeClaims: 0 as const,
      nonterminalRuns: 0 as const,
      openInteractions: 0 as const,
    },
  };
  const manifest = promotionManifestV2Schema.parse({
    ...manifestInput,
    rootDigest: promotionManifestV2RootDigest(manifestInput),
  });
  const batches = entities.map((entity) => {
    const batchInput = {
      schemaVersion: 2 as const,
      promotionId,
      batchId: `batch_${createLocator(
        crypto.getRandomValues(new Uint8Array(26)),
      )}`,
      family: entity.family,
      ordinal: 0,
      previousFamilyCount: 0,
      previousFamilyDigest: promotionFamilyInitialDigest(entity.family),
      previousEntityIdentity: null,
      items: [entity],
    };
    return promotionBatchV2Schema.parse({
      ...batchInput,
      requestDigest: promotionBatchV2RequestDigest(batchInput),
    });
  });
  return { batches, manifest };
}

function assertPromotionManifestEqual(
  actual: PromotionManifestV2,
  expected: PromotionManifestV2,
  label: string,
): void {
  assert(
    actual.rootDigest === expected.rootDigest,
    `${label} changed the manifest root digest.`,
  );
  for (const family of promotionEntityFamilyValues) {
    assert(
      actual.counts[family] === expected.counts[family],
      `${label} changed the ${family} count.`,
    );
    assert(
      actual.familyDigests[family] === expected.familyDigests[family],
      `${label} changed the ${family} digest.`,
    );
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} was not an object.`);
  return value as Record<string, unknown>;
}

function sameClaimView(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const fields = ["id", "agentId", "fence", "leaseGeneration", "leaseUntil"] as const;
  return fields.every((field) => Object.is(left[field], right[field]));
}

async function responseBody(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await response.text();
  assert(text.length <= 2 * 1_024 * 1_024, `${label} exceeded 2 MiB.`);
  try {
    return asRecord(JSON.parse(text) as unknown, label);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function errorCode(body: Record<string, unknown>, label: string): string | null {
  const error = body["error"];
  if (typeof error !== "object" || error === null || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>)["code"];
  assert(typeof code === "string", `${label} omitted an error code.`);
  return code;
}

function parseConvexOutput(source: string, label: string): Record<string, unknown> {
  const trimmed = source.trim();
  try {
    return asRecord(JSON.parse(trimmed) as unknown, label);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    assert(start >= 0 && end > start, `${label} returned no JSON object.`);
    return asRecord(JSON.parse(trimmed.slice(start, end + 1)) as unknown, label);
  }
}

async function readDotEnv(): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  const file = Bun.file(ENV_FILE);
  if (!(await file.exists())) return values;
  for (const rawLine of (await file.text()).split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }
  return values;
}

async function spawnConvex(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
  options: {
    readonly forwardOutput?: boolean;
    readonly knownSecrets?: readonly string[];
  } = {},
): Promise<string> {
  const child = Bun.spawn([CONVEX_BINARY, ...args], {
    cwd: WEB_ROOT,
    env: { ...process.env, ...environment, CI: "1", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  const safeStdout = redactSecretsInText(stdout, options.knownSecrets);
  const safeStderr = redactSecretsInText(stderr, options.knownSecrets);
  if (options.forwardOutput === true) {
    if (safeStdout.length > 0) process.stdout.write(safeStdout);
    if (safeStderr.length > 0) process.stderr.write(safeStderr);
  }
  if (exitCode !== 0) {
    const detail = safeStderr.trim().slice(0, 2_000);
    throw new Error(`Convex CLI command failed${detail.length === 0 ? "." : `: ${detail}`}`);
  }
  return safeStdout;
}

async function spawnBunScript(
  script: string,
  environment: Readonly<Record<string, string>>,
  knownSecrets: readonly string[],
): Promise<string> {
  const child = Bun.spawn([process.execPath, "run", script], {
    cwd: WEB_ROOT,
    env: { ...process.env, ...environment, CI: "1", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const safeStdout = redactSecretsInText(stdout, knownSecrets);
  const safeStderr = redactSecretsInText(stderr, knownSecrets);
  if (safeStdout.length > 0) process.stdout.write(safeStdout);
  if (safeStderr.length > 0) process.stderr.write(safeStderr);
  if (exitCode !== 0) throw new Error("Signed CLI acceptance command failed.");
  return safeStdout;
}

async function startConvexDevelopment(environment: Readonly<Record<string, string>>) {
  const child = Bun.spawn([CONVEX_BINARY, "dev", "--tail-logs", "disable"], {
    cwd: WEB_ROOT,
    env: { ...process.env, ...environment, CI: "1", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let tail = "";
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      tail = `${tail}${decoder.decode(item.value, { stream: true })}`.slice(-4_096);
      if (tail.includes("Convex functions ready!")) markReady?.();
    }
  };
  const stdout = consume(child.stdout);
  const stderr = consume(child.stderr);
  await Promise.race([
    ready,
    child.exited.then((exitCode) => {
      throw new Error(`Convex development process exited before readiness (${exitCode}).`);
    }),
    Bun.sleep(30_000).then(() => {
      throw new Error("Convex development process did not become ready.");
    }),
  ]);
  return {
    stop: async () => {
      child.kill();
      await Promise.all([child.exited, stdout, stderr]);
    },
  };
}

async function main(): Promise<void> {
  console.log("taskctl signed human-auth local acceptance");
  const dotEnv = await readDotEnv();
  const deployment = process.env.CONVEX_DEPLOYMENT ?? dotEnv.get("CONVEX_DEPLOYMENT");
  assert(
    deployment?.startsWith("anonymous:") === true,
    "The human-auth acceptance test requires an initialized anonymous Convex deployment.",
  );
  const siteOrigin =
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
    process.env.CONVEX_SITE_URL ??
    dotEnv.get("NEXT_PUBLIC_CONVEX_SITE_URL") ??
    dotEnv.get("CONVEX_SITE_URL");
  assert(siteOrigin !== undefined, "The anonymous local Convex site origin is unavailable.");
  const convexOrigin =
    process.env.NEXT_PUBLIC_CONVEX_URL ?? dotEnv.get("NEXT_PUBLIC_CONVEX_URL");
  assert(convexOrigin !== undefined, "The anonymous local Convex deployment origin is unavailable.");

  const fake = await startFakeWorkOS();
  const realtimeProofRoot = await mkdtemp(join(tmpdir(), "taskctl-realtime-proof-"));
  let convexDevelopment: Awaited<ReturnType<typeof startConvexDevelopment>> | undefined;
  try {
    const accessToken = await fake.issueAccessToken();
    const fixtureEnvironment = {
      HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: createBearerSecret(
        deterministicBytes(0x4f505254, 32),
      ),
      HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION:
        "local-human-v1",
      TASKCTL_LOCAL_FIXTURES_ENABLED: "true",
      TASKCTL_LOCAL_FIXTURE_ISSUER: fake.issuer,
      TASKCTL_LOCAL_FIXTURE_JWKS_URL: fake.jwksUrl,
      TASKCTL_LOCAL_FIXTURE_SUBJECT: FIXTURE_SUBJECT,
      TASKCTL_CREDENTIAL_PEPPER_CURRENT: createBearerSecret(
        deterministicBytes(0x43524544, 32),
      ),
      TASKCTL_CREDENTIAL_PEPPER_CURRENT_VERSION: "local-human-v1",
      TASKCTL_ENROLLMENT_PEPPER_CURRENT: createBearerSecret(
        deterministicBytes(0x454e524c, 32),
      ),
      TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION: "local-human-v1",
      WORKOS_API_KEY: fake.apiKey,
      WORKOS_CLIENT_ID: fake.clientId,
      WORKOS_API_HOSTNAME: "127.0.0.1",
      WORKOS_API_HTTPS: "false",
      WORKOS_API_PORT: new URL(fake.origin).port,
      WORKOS_OWNER_ROLE_SLUG: "admin",
      WORKOS_WEBHOOK_SECRET: fake.webhookSecret,
    } as const;

    for (const [name, value] of Object.entries(fixtureEnvironment)) {
      await spawnConvex(["env", "set", name, value], fixtureEnvironment);
    }

    async function apiRequest(args: {
      path: string;
      method?: "GET" | "POST";
      token: string;
      sessionId?: string;
      idempotencyKey?: string;
      body?: Record<string, unknown>;
    }): Promise<{ response: Response; body: Record<string, unknown> }> {
      const headers = new Headers({ Authorization: `Bearer ${args.token}` });
      if (args.sessionId !== undefined) headers.set("X-Taskctl-Session", args.sessionId);
      if (args.idempotencyKey !== undefined) {
        headers.set("Idempotency-Key", args.idempotencyKey);
      }
      if (args.body !== undefined) headers.set("Content-Type", "application/json");
      const response = await fetch(new URL(args.path, siteOrigin), {
        method: args.method ?? "GET",
        headers,
        ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      });
      return { response, body: await responseBody(response, args.path) };
    }

    async function deliverWebhook(webhook: { body: string; signature: string }) {
      const response = await fetch(new URL("/webhooks/workos", siteOrigin), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "WorkOS-Signature": webhook.signature,
        },
        body: webhook.body,
      });
      return { response, body: await responseBody(response, "WorkOS webhook") };
    }

    async function runFixture(functionName: string, args: Record<string, unknown> = {}) {
      const output = await spawnConvex(
        [
          "run",
          functionName,
          JSON.stringify(args),
          "--identity",
          JSON.stringify({
            subject: FIXTURE_SUBJECT,
            issuer: fake.issuer,
            tokenIdentifier: `${fake.issuer}|${FIXTURE_SUBJECT}`,
          }),
          "--typecheck",
          "disable",
          "--codegen",
          "disable",
        ],
        fixtureEnvironment,
      );
      return parseConvexOutput(output, functionName);
    }

    async function runHumanMutation(
      functionName: string,
      organizationId: string,
      args: Record<string, unknown>,
    ) {
      const output = await spawnConvex(
        [
          "run",
          functionName,
          JSON.stringify(args),
          "--identity",
          JSON.stringify({
            subject: fake.userId,
            issuer: fake.issuer,
            tokenIdentifier: `${fake.issuer}|${fake.userId}`,
            sid: `session_direct_${Date.now()}`,
            org_id: organizationId,
          }),
          "--typecheck",
          "disable",
          "--codegen",
          "disable",
        ],
        fixtureEnvironment,
      );
      return parseConvexOutput(output, functionName);
    }

    const resetRateLimits = await runFixture("localFixtures:resetApiRateLimits");
    assert(
      typeof resetRateLimits["deleted"] === "number",
      "Local rate-limit reset returned an invalid result.",
    );

    async function reconcileUntilOrganizationStatus(
      workosOrganizationId: string,
      expectedStatus: "active" | "disabled",
      label: string,
    ): Promise<void> {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await runFixture("localFixtures:reconcileWorkOSMembershipsNow");
        const inspection = await runFixture("localFixtures:inspectIdentitySync");
        const organizations = inspection["organizations"];
        if (
          Array.isArray(organizations) &&
          organizations.some(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              (value as Record<string, unknown>)["workosOrganizationId"] ===
                workosOrganizationId &&
              (value as Record<string, unknown>)["status"] === expectedStatus,
          )
        ) {
          return;
        }
        await Bun.sleep(250);
      }
      throw new Error(`${label} did not reach ${expectedStatus}.`);
    }

    async function reconcileUntilMembershipStatus(
      workosMembershipId: string,
      expectedStatus: "active" | "inactive" | "pending" | "removed",
      label: string,
      expectedRole?: "owner" | "admin" | "member",
    ): Promise<Record<string, unknown>> {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const reconciliation = await runFixture("localFixtures:reconcileWorkOSMembershipsNow");
        for (const phase of ["existing", "discovery"] as const) {
          const status = asRecord(
            reconciliation[phase],
            `${label} ${phase} reconciliation`,
          )["status"];
          if (status === "failed" || status === "unavailable") {
            throw new Error(`${label} ${phase} reconciliation ${String(status)}.`);
          }
        }
        const inspection = await runFixture("localFixtures:inspectIdentitySync");
        const memberships = inspection["memberships"];
        if (
          Array.isArray(memberships) &&
          memberships.some(
            (value) =>
              typeof value === "object" &&
              value !== null &&
              (value as Record<string, unknown>)["workosMembershipId"] ===
                workosMembershipId &&
              (value as Record<string, unknown>)["status"] === expectedStatus &&
              (expectedRole === undefined ||
                (value as Record<string, unknown>)["role"] === expectedRole),
          )
        ) {
          return inspection;
        }
        await Bun.sleep(250);
      }
      throw new Error(`${label} did not reach ${expectedStatus}.`);
    }

    convexDevelopment = await startConvexDevelopment(fixtureEnvironment);
    const acceptance = spawnBunScript(
      "../cli/tests/local-human.ts",
      {
        ...fixtureEnvironment,
        TASKCTL_TEST_FAKE_WORKOS_ORIGIN: fake.origin,
        TASKCTL_TEST_CONVEX_SITE_ORIGIN: siteOrigin,
        TASKCTL_WORKOS_CLIENT_ID: fake.clientId,
        TASKCTL_TEST_HUMAN_ACCESS_TOKEN: accessToken,
        TASKCTL_TEST_HUMAN_REFRESH_TOKEN: fake.initialRefreshToken,
        TASKCTL_TEST_WORKOS_USER_ID: fake.userId,
        TASKCTL_TEST_REALTIME_PROOF_ROOT: realtimeProofRoot,
      },
      [accessToken, fake.initialRefreshToken],
    );
    const realtime = proveSignedHumanReceivesTaskctlMutation({
      convexOrigin,
      proofRoot: realtimeProofRoot,
      issueOrganizationAccessToken: async () => {
        const activeMemberships = fake
          .memberships()
          .filter((membership) => membership.status === "active");
        assert(
          activeMemberships.length === 1,
          "The realtime proof did not isolate the first organization membership.",
        );
        const membership = activeMemberships[0];
        assert(membership !== undefined, "The realtime proof found no active membership.");
        return await fake.issueAccessToken(membership.organizationId);
      },
    });
    const [acceptanceResult, realtimeResult] = await Promise.allSettled([
      acceptance,
      realtime,
    ]);
    if (acceptanceResult.status === "rejected") throw acceptanceResult.reason;
    if (realtimeResult.status === "rejected") throw realtimeResult.reason;
    const acceptanceOutput = acceptanceResult.value;
    const realtimeProof = realtimeResult.value;
    assert(
      acceptanceOutput.includes("✓ taskctl signed human + agent CLI acceptance passed"),
      "The signed CLI acceptance did not reach its completion marker.",
    );
    assert(
      acceptanceOutput.includes("TASKCTL_SIGNED_ACCEPTANCE_PROOF=") &&
        realtimeProof.callbackCount >= 2 &&
        realtimeProof.claimedRevision > realtimeProof.initialRevision,
      "The signed CLI acceptance did not publish a realtime state transition proof.",
    );
    console.log(
      "  signed human Convex subscription observed taskctl claim state and its persisted agent actor without refresh",
    );

    const snapshot = fake.snapshot();
    assert(snapshot.organizationCount >= 2, "Human acceptance did not provision two organizations.");
    assert(snapshot.membershipCount >= 2, "Human acceptance did not provision owner memberships.");
    assert(snapshot.refreshCount >= 2, "Human acceptance did not rotate organization-bound tokens.");

    const originalMembership = fake.memberships()[0];
    assert(originalMembership !== undefined, "Human acceptance produced no WorkOS membership.");
    const secondaryMembership = fake
      .memberships()
      .find((membership) => membership.organizationId !== originalMembership.organizationId);
    assert(secondaryMembership !== undefined, "Human acceptance produced only one organization membership.");
    const accountToken = await fake.issueAccessToken();
    const organizationToken = await fake.issueAccessToken(originalMembership.organizationId);
    const secondPromotionClientToken = await fake.issueAccessToken(
      originalMembership.organizationId,
    );
    assert(
      secondPromotionClientToken !== organizationToken,
      "The promotion observer reused the uploader's signed session.",
    );

    const promotionOrganizationList = await apiRequest({
      path: "/v1/organizations?limit=100",
      token: accountToken,
    });
    assert(
      promotionOrganizationList.response.status === 200,
      "Promotion acceptance could not resolve its destination organization.",
    );
    const promotionOrganizations = asRecord(
      promotionOrganizationList.body["data"],
      "Promotion organization list data",
    )["organizations"];
    assert(
      Array.isArray(promotionOrganizations),
      "Promotion organization list omitted its organizations.",
    );
    const promotionOrganizationValue = promotionOrganizations.find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>)["workosOrganizationId"] ===
          originalMembership.organizationId,
    );
    assert(
      promotionOrganizationValue !== undefined,
      "Promotion acceptance could not find its active organization.",
    );
    const promotionOrganization = asRecord(
      promotionOrganizationValue,
      "Promotion organization",
    );
    const promotionOrganizationId = promotionOrganization["id"];
    assert(
      typeof promotionOrganizationId === "string",
      "Promotion organization omitted its public ID.",
    );

    const promotionFixture = promotionConvergenceFixture();
    const promotionId = promotionFixture.manifest.promotionId;
    const promotionStart = await apiRequest({
      path: hraPromotionApiRoutes.start,
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: {
        organizationId: promotionOrganizationId,
        manifest: promotionFixture.manifest,
      },
    });
    assert(
      promotionStart.response.status === 200,
      "The first signed client could not start the promotion.",
    );
    const parsedPromotionStart =
      hraPromotionApiOperations.start.responseSchema.safeParse(
        promotionStart.body,
      );
    assert(
      parsedPromotionStart.success,
      "Promotion start returned an invalid public envelope.",
    );
    assert(
      parsedPromotionStart.data.data.promotionId === promotionId,
      "Promotion start changed the frozen promotion ID.",
    );
    const stagingWorkspaceId =
      parsedPromotionStart.data.data.stagingWorkspaceId;

    for (const [batchIndex, batch] of promotionFixture.batches.entries()) {
      const acceptedBatch = await apiRequest({
        path: hraPromotionApiRoutes.batches(promotionId),
        method: "POST",
        token: organizationToken,
        idempotencyKey: nextIdempotencyKey(),
        body: { batch },
      });
      assert(
        acceptedBatch.response.status === 200,
        `The first signed client could not upload the ${batch.family} batch.`,
      );
      const parsedAcceptedBatch =
        hraPromotionApiOperations.acceptBatch.responseSchema.safeParse(
          acceptedBatch.body,
        );
      assert(
        parsedAcceptedBatch.success,
        `The ${batch.family} batch returned an invalid public envelope.`,
      );
      const receipt = parsedAcceptedBatch.data.data.receipt;
      assert(
        receipt.cumulativeFamilyCount === 1,
        `The ${batch.family} receipt returned the wrong cumulative count.`,
      );
      assert(
        receipt.cumulativeFamilyDigest ===
          promotionFixture.manifest.familyDigests[batch.family],
        `The ${batch.family} receipt returned the wrong cumulative digest.`,
      );
      for (const family of promotionEntityFamilyValues) {
        const expectedCount = promotionFixture.batches
          .slice(0, batchIndex + 1)
          .reduce(
            (count, accepted) =>
              count +
              accepted.items.filter((item) => item.family === family).length,
            0,
          );
        assert(
          receipt.cumulativeCounts[family] === expectedCount,
          `The ${batch.family} receipt returned the wrong cumulative ${family} count.`,
        );
      }
    }

    let secondClientObservedReady = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const lookup = await apiRequest({
        path: hraPromotionApiRoutes.lookup(promotionId),
        token: secondPromotionClientToken,
      });
      assert(
        lookup.response.status === 200,
        "The second signed client could not look up the promotion.",
      );
      const parsedLookup =
        hraPromotionApiOperations.lookup.responseSchema.safeParse(
          lookup.body,
        );
      assert(
        parsedLookup.success,
        "Promotion lookup returned an invalid public envelope.",
      );
      const promotion = parsedLookup.data.data.promotion;
      assert(
        promotion.state !== "aborted",
        "The promotion unexpectedly aborted before activation.",
      );
      assertPromotionManifestEqual(
        promotion.manifest,
        promotionFixture.manifest,
        "Second-client lookup",
      );
      assert(
        promotion.state !== "outcome_unknown",
        "The promotion scheduler rejected the staged manifest.",
      );
      if (promotion.state === "ready") {
        for (const family of promotionEntityFamilyValues) {
          const progress = promotion.progress.families[family];
          assert(
            progress.complete &&
              progress.acceptedEntityCount ===
                promotionFixture.manifest.counts[family] &&
              progress.cumulativeDigest ===
                promotionFixture.manifest.familyDigests[family],
            `The ready promotion did not prove the ${family} count and digest.`,
          );
        }
        secondClientObservedReady = true;
        break;
      }
      await Bun.sleep(100);
    }
    assert(
      secondClientObservedReady,
      "The second signed client did not observe the promotion becoming ready.",
    );

    const promotionActivation = await apiRequest({
      path: hraPromotionApiRoutes.activate(promotionId),
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: {
        manifestRoot: promotionFixture.manifest.rootDigest,
        counts: promotionFixture.manifest.counts,
        familyDigests: promotionFixture.manifest.familyDigests,
      },
    });
    assert(
      promotionActivation.response.status === 200,
      "The first signed client could not activate the ready promotion.",
    );
    const parsedPromotionActivation =
      hraPromotionApiOperations.activate.responseSchema.safeParse(
        promotionActivation.body,
      );
    assert(
      parsedPromotionActivation.success,
      "Promotion activation returned an invalid public envelope.",
    );
    const activationReceipt =
      parsedPromotionActivation.data.data.receipt;
    assert(
      activationReceipt.destinationWorkspaceId === stagingWorkspaceId &&
        activationReceipt.acceptedManifestRoot ===
          promotionFixture.manifest.rootDigest,
      "Promotion activation changed the destination or manifest root.",
    );
    for (const family of promotionEntityFamilyValues) {
      assert(
        activationReceipt.acceptedCounts[family] ===
          promotionFixture.manifest.counts[family],
        `Promotion activation changed the accepted ${family} count.`,
      );
      assert(
        activationReceipt.acceptedFamilyDigests[family] ===
          promotionFixture.manifest.familyDigests[family],
        `Promotion activation changed the accepted ${family} digest.`,
      );
    }

    const secondClientLookup = await apiRequest({
      path: hraPromotionApiRoutes.lookup(promotionId),
      token: secondPromotionClientToken,
    });
    assert(
      secondClientLookup.response.status === 200,
      "The second signed client could not observe the activated promotion.",
    );
    const parsedSecondClientLookup =
      hraPromotionApiOperations.lookup.responseSchema.safeParse(
        secondClientLookup.body,
      );
    assert(
      parsedSecondClientLookup.success,
      "Activated promotion lookup returned an invalid public envelope.",
    );
    const activatedPromotion =
      parsedSecondClientLookup.data.data.promotion;
    assert(
      activatedPromotion.state === "activated",
      "The second signed client did not observe the activated decision.",
    );
    assertPromotionManifestEqual(
      activatedPromotion.manifest,
      promotionFixture.manifest,
      "Activated second-client lookup",
    );
    assert(
      activatedPromotion.activationReceipt.receiptDigest ===
        activationReceipt.receiptDigest &&
        activatedPromotion.activationReceipt.acceptedManifestRoot ===
          promotionFixture.manifest.rootDigest,
      "The second signed client observed a different activation proof.",
    );
    for (const family of promotionEntityFamilyValues) {
      assert(
        activatedPromotion.activationReceipt.acceptedCounts[family] ===
          promotionFixture.manifest.counts[family] &&
          activatedPromotion.activationReceipt.acceptedFamilyDigests[family] ===
            promotionFixture.manifest.familyDigests[family],
        `The second signed client observed different activated ${family} evidence.`,
      );
    }
    console.log(
      "  two signed HRA clients observed identical promoted manifest counts and digests",
    );

    const refreshSubjectsBefore = await runFixture(
      "localFixtures:validateApiRateLimitSubjects",
    );
    const refreshSlotsBefore = refreshSubjectsBefore["refreshSlots"];
    assert(
      typeof refreshSlotsBefore === "number",
      "Refresh limiter inspection omitted its occupied-slot count.",
    );
    let refreshSubjectsAfter = refreshSubjectsBefore;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const isolatedRefresh = await apiRequest({
        path: "/v1/auth/refresh",
        method: "POST",
        token: fake.issueRefreshToken(),
        body: {},
      });
      assert(
        isolatedRefresh.response.status === 200,
        "A fresh valid refresh credential was rejected during slot-isolation acceptance.",
      );
      refreshSubjectsAfter = await runFixture(
        "localFixtures:validateApiRateLimitSubjects",
      );
      const occupiedSlots = refreshSubjectsAfter["refreshSlots"];
      if (typeof occupiedSlots === "number" && occupiedSlots >= refreshSlotsBefore + 2) break;
    }
    assert(
      typeof refreshSubjectsAfter["refreshSlots"] === "number" &&
        refreshSubjectsAfter["refreshSlots"] >= refreshSlotsBefore + 2,
      "Distinct valid refresh credentials did not occupy independent opaque limiter slots.",
    );
    assert(
      typeof refreshSubjectsAfter["refreshRows"] === "number" &&
        refreshSubjectsAfter["refreshRows"] > 0 &&
        refreshSubjectsAfter["refreshRows"] <= 2_048 &&
        refreshSubjectsAfter["invalid"] === 0,
      "Refresh limiter persistence exceeded its 256-slot, four-shard, two-window bound or exposed a raw subject.",
    );

    const malformedEnrollmentRoute = await apiRequest({
      path: "/v1/agents/%E0%A4%A/enrollments",
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(
      errorCode(malformedEnrollmentRoute.body, "Malformed enrollment route") === "VALIDATION_ERROR",
      "Malformed percent encoding escaped the enrollment route as an internal error.",
    );

    const crossOrganizationKey = nextIdempotencyKey();
    const crossOrganizationBody = {
      name: "Tenant Scoped Receipt",
      slug: `tenant-receipt-${Date.now()}`,
      taskKeyPrefix: "TSR",
    };
    const crossOrganizationResults = await Promise.all([
      apiRequest({
        path: "/v1/workspaces",
        method: "POST",
        token: organizationToken,
        idempotencyKey: crossOrganizationKey,
        body: crossOrganizationBody,
      }),
      apiRequest({
        path: "/v1/workspaces",
        method: "POST",
        token: await fake.issueAccessToken(secondaryMembership.organizationId),
        idempotencyKey: crossOrganizationKey,
        body: crossOrganizationBody,
      }),
    ]);
    assert(
      crossOrganizationResults.every(({ response }) => response.status === 200),
      "The same human command key conflicted across organization receipt scopes.",
    );
    const workGraphWorkspace = asRecord(
      asRecord(crossOrganizationResults[0]?.body["data"], "Work graph workspace data")[
        "workspace"
      ],
      "Work graph workspace",
    );
    const workGraphWorkspaceId = workGraphWorkspace["id"];
    assert(typeof workGraphWorkspaceId === "string", "Work graph workspace omitted its ID.");
    const seededTask = await runFixture("localFixtures:seedOpenTask", {
      workspaceId: workGraphWorkspaceId,
      title: "Human lifecycle acceptance",
    });
    const seededTaskKey = seededTask["key"];
    assert(typeof seededTaskKey === "string", "Human lifecycle fixture omitted its task key.");
    const seededReviewTask = await runFixture("localFixtures:seedInReviewTask", {
      workspaceId: workGraphWorkspaceId,
      title: "Human cancellation during immutable review",
    });
    const seededReviewTaskKey = seededReviewTask["key"];
    const seededSubmissionId = seededReviewTask["submissionId"];
    assert(
      typeof seededReviewTaskKey === "string" && typeof seededSubmissionId === "string",
      "Human review-cancellation fixture omitted its durable selectors.",
    );
    const rejectedControlReason = await runHumanMutation(
      "humanTaskMutations:rejectSubmission",
      originalMembership.organizationId,
      {
        workspaceId: workGraphWorkspaceId,
        key: seededReviewTaskKey,
        submissionId: seededSubmissionId,
        reviewRevision: 1,
        reason: "Rejected reason contains a forbidden control\u0000character.",
        idempotencyKey: nextIdempotencyKey(),
      },
    );
    assert(
      asRecord(rejectedControlReason["error"], "Direct human rejection error")["code"] ===
        "VALIDATION_ERROR",
      "Direct signed-human review rejection accepted a forbidden control character.",
    );
    const saturatedHumanMutation = await runFixture(
      "localFixtures:primeHumanMutationRateLimit",
      {
        workspaceId: workGraphWorkspaceId,
        workosUserId: fake.userId,
        mode: "saturated",
      },
    );
    assert(
      saturatedHumanMutation["seeded"] === 16,
      "Human mutation limiter fixture did not seed both eight-shard subjects.",
    );
    const rateLimitedHumanReview = await runHumanMutation(
      "humanTaskMutations:rejectSubmission",
      originalMembership.organizationId,
      {
        workspaceId: workGraphWorkspaceId,
        key: seededReviewTaskKey,
        submissionId: seededSubmissionId,
        reviewRevision: 1,
        reason: "This valid reason must be rejected by the saturated limiter.",
        idempotencyKey: nextIdempotencyKey(),
      },
    );
    const limitedHumanReviewError = asRecord(
      rateLimitedHumanReview["error"],
      "Rate-limited direct human review error",
    );
    const limitedHumanReviewDetails = asRecord(
      limitedHumanReviewError["details"],
      "Rate-limited direct human review details",
    );
    assert(
      limitedHumanReviewError["code"] === "RATE_LIMITED" &&
        typeof limitedHumanReviewDetails["retryAfterMs"] === "number" &&
        limitedHumanReviewDetails["retryAfterMs"] > 0,
      "Direct human review did not return stable RATE_LIMITED details.",
    );
    await runFixture("localFixtures:resetApiRateLimits", {
      routeClass: "human_mutation",
    });
    const invalidHumanMutation = await runFixture(
      "localFixtures:primeHumanMutationRateLimit",
      {
        workspaceId: workGraphWorkspaceId,
        workosUserId: fake.userId,
        mode: "invalid",
      },
    );
    assert(invalidHumanMutation["seeded"] === 16, "Human limiter corruption fixture was incomplete.");
    const unavailableHumanReview = await runHumanMutation(
      "humanTaskMutations:rejectSubmission",
      originalMembership.organizationId,
      {
        workspaceId: workGraphWorkspaceId,
        key: seededReviewTaskKey,
        submissionId: seededSubmissionId,
        reviewRevision: 1,
        reason: "This valid reason must fail closed when limiter state is invalid.",
        idempotencyKey: nextIdempotencyKey(),
      },
    );
    assert(
      asRecord(unavailableHumanReview["error"], "Unavailable human review error")["code"] ===
        "SERVICE_UNAVAILABLE",
      "Direct human review did not fail closed on invalid limiter state.",
    );
    await runFixture("localFixtures:resetApiRateLimits", {
      routeClass: "human_mutation",
    });

    const repositoryCreateKey = nextIdempotencyKey();
    const repositoryCreate = await apiRequest({
      path: "/v1/workspace/repositories",
      method: "POST",
      token: organizationToken,
      idempotencyKey: repositoryCreateKey,
      body: {
        workspaceId: workGraphWorkspaceId,
        name: "Acceptance repository",
        provider: "github",
        url: "https://github.com/example/acceptance",
      },
    });
    assert(repositoryCreate.response.status === 200, "Human repository creation failed.");
    const repository = asRecord(
      asRecord(repositoryCreate.body["data"], "Repository create data")["repository"],
      "Created repository",
    );
    const repositoryId = repository["id"];
    assert(typeof repositoryId === "string", "Created repository omitted its public ID.");
    const repositoryReplay = await apiRequest({
      path: "/v1/workspace/repositories",
      method: "POST",
      token: organizationToken,
      idempotencyKey: repositoryCreateKey,
      body: {
        workspaceId: workGraphWorkspaceId,
        name: "Acceptance repository",
        provider: "github",
        url: "https://github.com/example/acceptance",
      },
    });
    assert(
      repositoryReplay.response.status === 200 &&
        JSON.stringify(repositoryReplay.body) === JSON.stringify(repositoryCreate.body),
      "Human repository replay did not return the original envelope.",
    );
    const credentialedUrl = await apiRequest({
      path: "/v1/workspace/repositories",
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: {
        workspaceId: workGraphWorkspaceId,
        name: "Credentialed URL must fail",
        provider: "other",
        url: "https://fixture-user:fixture-password@example.com/repository",
      },
    });
    assert(
      errorCode(credentialedUrl.body, "Credentialed repository URL") === "VALIDATION_ERROR",
      "Repository URL credentials passed backend validation.",
    );
    const repositoryList = await apiRequest({
      path: `/v1/workspace/repositories?workspaceId=${encodeURIComponent(workGraphWorkspaceId)}&limit=100`,
      token: organizationToken,
    });
    assert(repositoryList.response.status === 200, "Human repository listing failed.");
    const listedRepositories = asRecord(repositoryList.body["data"], "Repository list data")[
      "repositories"
    ];
    assert(
      Array.isArray(listedRepositories) &&
        listedRepositories.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["id"] === repositoryId,
        ),
      "Human repository list omitted the created repository.",
    );

    const cancelKey = nextIdempotencyKey();
    const cancelledTask = await apiRequest({
      path: `/v1/tasks/${encodeURIComponent(seededTaskKey)}/cancel`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: cancelKey,
      body: {
        workspaceId: workGraphWorkspaceId,
        revision: 1,
        reason: "Human cancellation acceptance",
      },
    });
    assert(cancelledTask.response.status === 200, "Human task cancellation failed.");
    const cancelledTaskView = asRecord(
      asRecord(cancelledTask.body["data"], "Cancelled task data")["task"],
      "Cancelled task",
    );
    assert(
      cancelledTaskView["status"] === "cancelled" && cancelledTaskView["revision"] === 2,
      "Human cancellation returned the wrong task transition.",
    );
    const cancellationReplay = await apiRequest({
      path: `/v1/tasks/${encodeURIComponent(seededTaskKey)}/cancel`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: cancelKey,
      body: {
        workspaceId: workGraphWorkspaceId,
        revision: 1,
        reason: "Human cancellation acceptance",
      },
    });
    assert(
      cancellationReplay.response.status === 200 &&
        JSON.stringify(cancellationReplay.body) === JSON.stringify(cancelledTask.body),
      "Human cancellation replay did not return the original envelope.",
    );
    const reopenedTask = await apiRequest({
      path: `/v1/tasks/${encodeURIComponent(seededTaskKey)}/reopen`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: { workspaceId: workGraphWorkspaceId, revision: 2 },
    });
    assert(reopenedTask.response.status === 200, "Human task reopening failed.");
    const reopenedTaskView = asRecord(
      asRecord(reopenedTask.body["data"], "Reopened task data")["task"],
      "Reopened task",
    );
    assert(
      reopenedTaskView["status"] === "open" &&
        reopenedTaskView["revision"] === 3 &&
        reopenedTaskView["isReady"] === true,
      "Human reopening returned the wrong task transition.",
    );
    const fullCancellationReason = `Human cancellation must preserve the complete review reason: ${"x".repeat(1_500)}`;
    const cancelledReviewTask = await apiRequest({
      path: `/v1/tasks/${encodeURIComponent(seededReviewTaskKey)}/cancel`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: {
        workspaceId: workGraphWorkspaceId,
        revision: 2,
        reason: fullCancellationReason,
      },
    });
    assert(
      cancelledReviewTask.response.status === 200 &&
        asRecord(
          asRecord(cancelledReviewTask.body["data"], "Cancelled review task data")["task"],
          "Cancelled review task",
        )["status"] === "cancelled",
      "Human cancellation did not transition in-review work to cancelled.",
    );
    const reviewCancellationInspection = await runFixture("localFixtures:inspectWorkspace", {
      workspaceId: workGraphWorkspaceId,
    });
    const durableSubmissions = reviewCancellationInspection["submissions"];
    const durableCancellations = reviewCancellationInspection["cancellations"];
    assert(
      Array.isArray(durableSubmissions) &&
        durableSubmissions.some((value) => {
          const submission = asRecord(value, "Durable cancelled submission");
          return (
            submission["id"] === seededSubmissionId &&
            submission["status"] === "cancelled" &&
            submission["cancellationReason"] === fullCancellationReason
          );
        }),
      "Human cancellation did not preserve the full reason on the immutable submission.",
    );
    assert(
      Array.isArray(durableCancellations) &&
        durableCancellations.some((value) => {
          const cancellation = asRecord(value, "Durable task cancellation");
          return (
            cancellation["taskId"] === seededReviewTaskKey &&
            cancellation["reason"] === fullCancellationReason
          );
        }),
      "Human cancellation did not preserve the full reason in durable task history.",
    );
    const validatedHumanRateSubjects = await runFixture(
      "localFixtures:validateApiRateLimitSubjects",
    );
    assert(
      typeof validatedHumanRateSubjects["users"] === "number" &&
        validatedHumanRateSubjects["users"] > 0 &&
        typeof validatedHumanRateSubjects["workspaces"] === "number" &&
        validatedHumanRateSubjects["workspaces"] > 0 &&
        validatedHumanRateSubjects["invalid"] === 0,
      "Human limiter subjects were not live user/workspace Convex IDs.",
    );
    const repositoryRemoval = await apiRequest({
      path: `/v1/workspace/repositories/${encodeURIComponent(repositoryId)}/remove`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: { workspaceId: workGraphWorkspaceId },
    });
    assert(repositoryRemoval.response.status === 200, "Human repository removal failed.");

    const checkpointWindowBefore = fake.snapshot();
    fake.setNextCreatedMembershipWebhookTarget(
      new URL("/webhooks/workos", siteOrigin).toString(),
    );
    const checkpointWindowCreate = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: nextIdempotencyKey(),
      body: { name: "Checkpoint Window Organization" },
    });
    assert(
      checkpointWindowCreate.response.status === 200,
      "A membership-created webhook in the provisioning window prevented completion.",
    );
    const checkpointWindowOrganization = asRecord(
      asRecord(checkpointWindowCreate.body["data"], "Checkpoint window data")["organization"],
      "Checkpoint window organization",
    );
    const checkpointWindowWorkOSId = checkpointWindowOrganization["workosOrganizationId"];
    assert(
      typeof checkpointWindowWorkOSId === "string",
      "Checkpoint-window provisioning omitted its provider organization ID.",
    );
    const checkpointWindowInspection = await runFixture("localFixtures:inspectIdentitySync");
    const checkpointWindowLocalOrganizations = checkpointWindowInspection["organizations"];
    assert(
      Array.isArray(checkpointWindowLocalOrganizations) &&
        checkpointWindowLocalOrganizations.filter(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["workosOrganizationId"] ===
              checkpointWindowWorkOSId,
        ).length === 1,
      "A membership webhook before provisioning completion created a duplicate local organization.",
    );
    const checkpointWindowAfter = fake.snapshot();
    assert(
      checkpointWindowAfter.membershipCount === checkpointWindowBefore.membershipCount + 1 &&
        checkpointWindowAfter.membershipCreateCount ===
          checkpointWindowBefore.membershipCreateCount + 1,
      "Checkpoint-window provisioning did not create exactly one provider membership.",
    );

    const indeterminateMembershipKey = nextIdempotencyKey();
    const indeterminateMembershipBefore = fake.snapshot();
    fake.setNextMembershipCreateCommitThenFail(1);
    const indeterminateMembershipFirst = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: indeterminateMembershipKey,
      body: { name: "Indeterminate Membership Organization" },
    });
    assert(
      errorCode(indeterminateMembershipFirst.body, "Indeterminate membership create") ===
        "PROVISIONING_IN_PROGRESS",
      "An indeterminate provider membership create was treated as terminal.",
    );
    const indeterminateMembershipHiddenPoll = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: indeterminateMembershipKey,
      body: { name: "Indeterminate Membership Organization" },
    });
    assert(
      errorCode(indeterminateMembershipHiddenPoll.body, "Hidden membership poll") ===
        "PROVISIONING_IN_PROGRESS",
      "An eventually consistent empty poll dispatched a duplicate membership create.",
    );
    const afterHiddenMembershipPoll = fake.snapshot();
    assert(
      afterHiddenMembershipPoll.membershipCreateCount ===
        indeterminateMembershipBefore.membershipCreateCount + 1,
      "Poll-only recovery issued a second provider membership POST.",
    );
    const indeterminateMembershipCompleted = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: indeterminateMembershipKey,
      body: { name: "Indeterminate Membership Organization" },
    });
    assert(
      indeterminateMembershipCompleted.response.status === 200,
      "A later provider poll did not recover the committed membership.",
    );
    const indeterminateMembershipAfter = fake.snapshot();
    assert(
      indeterminateMembershipAfter.membershipCount ===
        indeterminateMembershipBefore.membershipCount + 1 &&
        indeterminateMembershipAfter.membershipCreateCount ===
          indeterminateMembershipBefore.membershipCreateCount + 1,
      "Indeterminate membership recovery did not converge on exactly one provider row and POST.",
    );

    const pendingKey = nextIdempotencyKey();
    fake.setNextCreatedMembershipStatus("pending");
    const pendingFirst = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: pendingKey,
      body: { name: "Pending Resume Organization" },
    });
    assert(
      errorCode(pendingFirst.body, "Pending provisioning") === "PROVISIONING_IN_PROGRESS",
      "A pending provider membership did not remain resumable.",
    );
    const pendingReplay = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: pendingKey,
      body: { name: "Pending Resume Organization" },
    });
    assert(
      errorCode(pendingReplay.body, "Pending provisioning replay") === "PROVISIONING_IN_PROGRESS",
      "A pending provisioning replay was finalized or failed permanently.",
    );
    const pendingMembership = fake.memberships().find((membership) => membership.status === "pending");
    assert(pendingMembership !== undefined, "Fake WorkOS did not retain the pending membership.");
    const pendingActiveSnapshot = fake.setMembership({
      membershipId: pendingMembership.id,
      status: "active",
      roleSlug: "admin",
    });
    fake.setNextMembershipListAfterSnapshotHook(async () => {
      const downgradedDuringCompletion = fake.setMembership({
        membershipId: pendingActiveSnapshot.id,
        status: "active",
        roleSlug: "member",
        updatedAt: pendingActiveSnapshot.updatedAt,
      });
      const downgrade = await fake.signMembershipWebhook({
        eventId: `event_completion_downgrade_${Date.now()}`,
        event: "organization_membership.updated",
        membership: downgradedDuringCompletion,
        eventCreatedAt: new Date().toISOString(),
      });
      const delivery = await deliverWebhook(downgrade);
      assert(delivery.response.status === 200, "Injected completion downgrade webhook failed.");
    });
    const staleCompletion = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: pendingKey,
      body: { name: "Pending Resume Organization" },
    });
    assert(
      errorCode(staleCompletion.body, "Stale provisioning completion") ===
        "PROVISIONING_IN_PROGRESS",
      "A delayed owner snapshot overwrote a newer active-member downgrade during completion.",
    );
    fake.setMembership({
      membershipId: pendingMembership.id,
      status: "active",
      roleSlug: "admin",
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const pendingCompleted = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: pendingKey,
      body: { name: "Pending Resume Organization" },
    });
    assert(pendingCompleted.response.status === 200, "Resumed provisioning did not complete.");

    const concurrentKey = nextIdempotencyKey();
    const concurrentBefore = fake.snapshot();
    fake.setNextMembershipListAfterSnapshotHook(async () => {
      await Bun.sleep(500);
    });
    const concurrentRequests = await Promise.all([
      apiRequest({
        path: "/v1/organizations",
        method: "POST",
        token: accountToken,
        idempotencyKey: concurrentKey,
        body: { name: "Concurrent Organization" },
      }),
      apiRequest({
        path: "/v1/organizations",
        method: "POST",
        token: accountToken,
        idempotencyKey: concurrentKey,
        body: { name: "Concurrent Organization" },
      }),
    ]);
    const concurrentSuccesses = concurrentRequests.filter(({ response }) => response.status === 200);
    const concurrentInProgress = concurrentRequests.filter(
      ({ body }) => errorCode(body, "Concurrent provisioning") === "PROVISIONING_IN_PROGRESS",
    );
    assert(
      concurrentSuccesses.length === 1 && concurrentInProgress.length === 1,
      "Concurrent provisioning did not serialize the provider membership call.",
    );
    const concurrentRetry = await apiRequest({
      path: "/v1/organizations",
      method: "POST",
      token: accountToken,
      idempotencyKey: concurrentKey,
      body: { name: "Concurrent Organization" },
    });
    assert(concurrentRetry.response.status === 200, "Concurrent same-key retry did not replay success.");
    const concurrentAfter = fake.snapshot();
    assert(
      concurrentAfter.organizationCount === concurrentBefore.organizationCount + 1 &&
        concurrentAfter.membershipCount === concurrentBefore.membershipCount + 1 &&
        concurrentAfter.membershipCreateCount === concurrentBefore.membershipCreateCount + 1,
      "Concurrent provisioning created duplicate provider state.",
    );

    const mismatchRefreshToken = fake.issueRefreshToken();
    fake.setNextRefreshOrganizationOverride(null);
    const mismatchedRefresh = await apiRequest({
      path: "/v1/auth/refresh",
      method: "POST",
      token: mismatchRefreshToken,
      body: { workosOrganizationId: originalMembership.organizationId },
    });
    assert(
      errorCode(mismatchedRefresh.body, "Mismatched refresh") === "AUTH_REFRESH_INDETERMINATE",
      "A refresh response bound to the wrong organization was accepted.",
    );

    const invalidWebhook = await fetch(new URL("/webhooks/workos", siteOrigin), {
      method: "POST",
      headers: { "Content-Type": "application/json", "WorkOS-Signature": "t=0,v1=invalid" },
      body: JSON.stringify({ id: "event_unverified", event: "organization_membership.deleted" }),
    });
    assert(invalidWebhook.status === 400, "An invalid WorkOS signature was accepted.");

    let inactiveWebhook: Awaited<ReturnType<typeof fake.signMembershipWebhook>> | undefined;
    fake.setNextMembershipListAfterSnapshotHook(async () => {
      const inactiveMembership = fake.setMembership({
        membershipId: originalMembership.id,
        status: "inactive",
        updatedAt: originalMembership.updatedAt,
      });
      inactiveWebhook = await fake.signMembershipWebhook({
        eventId: `event_inactive_${Date.now()}`,
        event: "organization_membership.updated",
        membership: inactiveMembership,
        eventCreatedAt: new Date().toISOString(),
      });
      const delivery = await deliverWebhook(inactiveWebhook);
      assert(
        delivery.response.status === 200 && delivery.body["status"] === "applied",
        "The signed inactive membership webhook was not applied.",
      );
    });
    const delayedOrganizationList = await apiRequest({
      path: "/v1/organizations?limit=100",
      token: accountToken,
    });
    assert(delayedOrganizationList.response.status === 200, "Delayed organization list failed.");
    const delayedOrganizations = asRecord(
      delayedOrganizationList.body["data"],
      "Delayed organization list data",
    )["organizations"];
    assert(
      Array.isArray(delayedOrganizations) &&
        !delayedOrganizations.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["workosOrganizationId"] ===
              originalMembership.organizationId,
        ),
      "A delayed active list snapshot resurrected a newer equal-version removal.",
    );
    assert(inactiveWebhook !== undefined, "The delayed list hook did not deliver its webhook.");
    const duplicateDelivery = await deliverWebhook(inactiveWebhook);
    assert(
      duplicateDelivery.response.status === 200 && duplicateDelivery.body["status"] === "duplicate",
      "A duplicate WorkOS event did not use its durable receipt.",
    );
    const staleActiveWebhook = await fake.signMembershipWebhook({
      eventId: `event_stale_active_${Date.now()}`,
      event: "organization_membership.updated",
      membership: originalMembership,
      eventCreatedAt: originalMembership.updatedAt,
    });
    const staleDelivery = await deliverWebhook(staleActiveWebhook);
    assert(
      staleDelivery.response.status === 200 && staleDelivery.body["status"] === "stale",
      "An out-of-order active webhook resurrected an inactive membership.",
    );
    const inactiveAccess = await apiRequest({
      path: "/v1/workspaces?limit=100",
      token: organizationToken,
    });
    assert(
      errorCode(inactiveAccess.body, "Inactive membership access") === "MEMBERSHIP_INACTIVE",
      "Membership removal was not reflected by final authorization.",
    );

    const downgradedMembership = fake.setMembership({
      membershipId: originalMembership.id,
      status: "active",
      roleSlug: "member",
      updatedAt: new Date(Date.now() + 2_000).toISOString(),
    });
    const downgradeWebhook = await fake.signMembershipWebhook({
      eventId: `event_downgrade_${Date.now()}`,
      event: "organization_membership.updated",
      membership: downgradedMembership,
      eventCreatedAt: downgradedMembership.updatedAt,
    });
    const downgradeDelivery = await deliverWebhook(downgradeWebhook);
    assert(downgradeDelivery.response.status === 200, "Role downgrade webhook failed.");
    const deniedWorkspaceCreate = await apiRequest({
      path: "/v1/workspaces",
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: {
        name: "Role Downgrade Must Deny",
        slug: `role-deny-${Date.now()}`,
        taskKeyPrefix: "DENY",
      },
    });
    assert(
      errorCode(deniedWorkspaceCreate.body, "Downgraded role") === "WORKSPACE_ROLE_REQUIRED",
      "A WorkOS owner-role downgrade preserved owner powers.",
    );

    const discoveredMembership = fake.createMembership({
      organizationId: originalMembership.organizationId,
      userId: `user_discovered${Date.now()}`,
      roleSlug: "member",
    });
    let identityInspection = await reconcileUntilMembershipStatus(
      discoveredMembership.id,
      "active",
      "Provider-only membership discovery",
    );
    const projectedMemberships = identityInspection["memberships"];
    assert(Array.isArray(projectedMemberships), "Identity inspection omitted memberships.");
    assert(
      projectedMemberships.some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as Record<string, unknown>)["workosMembershipId"] === discoveredMembership.id,
      ),
      "The discovery sweep missed a provider-only organization membership.",
    );
    const webhookReceipts = identityInspection["webhookReceipts"];
    assert(Array.isArray(webhookReceipts), "Identity inspection omitted webhook receipts.");
    const inactiveEventId = asRecord(
      JSON.parse(inactiveWebhook.body) as unknown,
      "Inactive webhook payload",
    )["id"];
    assert(
      webhookReceipts.filter(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as Record<string, unknown>)["providerEventId"] === inactiveEventId,
      ).length === 1,
      "Duplicate webhook delivery created more than one durable receipt.",
    );

    const isolationCandidates = fake
      .memberships()
      .filter(
        (membership) =>
          membership.status === "active" &&
          membership.id !== originalMembership.id &&
          membership.id !== discoveredMembership.id,
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const malformedEarlier = isolationCandidates[0];
    const missedDeletionLater = isolationCandidates.at(-1);
    assert(
      malformedEarlier !== undefined &&
        missedDeletionLater !== undefined &&
        malformedEarlier.id !== missedDeletionLater.id,
      "Quarantine cursor-isolation setup requires two ordered memberships.",
    );
    fake.setNextMembershipGetPayload(malformedEarlier.id, {
      object: "organization_membership",
      id: malformedEarlier.id,
      user_id: malformedEarlier.userId,
      organization_id: malformedEarlier.organizationId,
      organization_name: "Malformed earlier membership",
      status: malformedEarlier.status,
      created_at: malformedEarlier.createdAt,
      updated_at: malformedEarlier.updatedAt,
      role: { slug: malformedEarlier.roleSlug },
      roles: [null],
    });
    fake.deleteMembership(missedDeletionLater.id);
    identityInspection = await reconcileUntilMembershipStatus(
      missedDeletionLater.id,
      "removed",
      "Quarantine cursor isolation",
    );
    const isolatedMemberships = identityInspection["memberships"];
    assert(
      Array.isArray(isolatedMemberships) &&
        isolatedMemberships.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["workosMembershipId"] ===
              missedDeletionLater.id &&
            (value as Record<string, unknown>)["status"] === "removed",
        ),
      "A malformed earlier membership starved a later missed-deletion revocation.",
    );
    const isolationQuarantines = identityInspection["quarantines"];
    assert(
      Array.isArray(isolationQuarantines) &&
        isolationQuarantines.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["resourceId"] === malformedEarlier.id &&
            (value as Record<string, unknown>)["reason"] === "invalid_provider_record",
        ),
      "Malformed provider data did not leave a bounded reason-only diagnostic.",
    );

    const restoredOwner = fake.setMembership({
      membershipId: originalMembership.id,
      status: "active",
      roleSlug: "admin",
      updatedAt: new Date(Date.now() + 3_000).toISOString(),
    });
    await reconcileUntilMembershipStatus(
      restoredOwner.id,
      "active",
      "Reconciled owner restoration",
      "owner",
    );
    const workspaceList = await apiRequest({
      path: "/v1/workspaces?limit=100",
      token: organizationToken,
    });
    assert(workspaceList.response.status === 200, "Reconciled owner membership could not list workspaces.");
    const workspaceData = asRecord(workspaceList.body["data"], "Workspace list data");
    const workspaces = workspaceData["workspaces"];
    assert(Array.isArray(workspaces) && workspaces.length > 0, "Workspace list was empty after owner restore.");
    const workspaceId = asRecord(workspaces[0], "Workspace")["id"];
    assert(typeof workspaceId === "string", "Workspace list omitted its public ID.");

    // The local Convex database intentionally persists across acceptance runs, so this
    // setup token must be unique per run instead of colliding with an earlier fixture.
    const enrollment = formatEnrollmentToken(
      createLocator(crypto.getRandomValues(new Uint8Array(26))),
      createBearerSecret(crypto.getRandomValues(new Uint8Array(32))),
    );
    const firstAgentKey = nextIdempotencyKey();
    const firstAgentBody = {
      workspaceId,
      name: "locator-owner",
      preset: "worker",
      enrollment,
    };
    const firstAgent = await apiRequest({
      path: "/v1/agents",
      method: "POST",
      token: organizationToken,
      idempotencyKey: firstAgentKey,
      body: firstAgentBody,
    });
    assert(firstAgent.response.status === 200, "Agent locator regression setup failed.");
    const rotatedEnrollmentPepper = createBearerSecret(deterministicBytes(0x524f5441, 32));
    await spawnConvex(
      ["env", "set", "TASKCTL_ENROLLMENT_PEPPER_PREVIOUS", fixtureEnvironment.TASKCTL_ENROLLMENT_PEPPER_CURRENT],
      fixtureEnvironment,
    );
    await spawnConvex(
      [
        "env",
        "set",
        "TASKCTL_ENROLLMENT_PEPPER_PREVIOUS_VERSION",
        fixtureEnvironment.TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION,
      ],
      fixtureEnvironment,
    );
    await spawnConvex(
      ["env", "set", "TASKCTL_ENROLLMENT_PEPPER_CURRENT", rotatedEnrollmentPepper],
      fixtureEnvironment,
    );
    await spawnConvex(
      ["env", "set", "TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION", "local-human-v2"],
      fixtureEnvironment,
    );
    const rotatedReplay = await apiRequest({
      path: "/v1/agents",
      method: "POST",
      token: organizationToken,
      idempotencyKey: firstAgentKey,
      body: firstAgentBody,
    });
    assert(
      rotatedReplay.response.status === 200,
      "An identical enrollment replay conflicted after pepper rotation.",
    );
    const countsBeforeConflict = await runFixture("localFixtures:inspectWorkspaceAgentCounts", {
      workspaceId,
    });
    const conflictingAgent = await apiRequest({
      path: "/v1/agents",
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: { workspaceId, name: "must-not-orphan", preset: "worker", enrollment },
    });
    assert(
      errorCode(conflictingAgent.body, "Enrollment locator conflict") === "ENROLLMENT_CONFLICT",
      "A reused enrollment locator was not rejected.",
    );
    const countsAfterConflict = await runFixture("localFixtures:inspectWorkspaceAgentCounts", {
      workspaceId,
    });
    assert(
      JSON.stringify(countsAfterConflict) === JSON.stringify(countsBeforeConflict),
      "Enrollment locator conflict committed an orphan agent or grant.",
    );

    const agentCredential = formatCredentialToken(
      createLocator(crypto.getRandomValues(new Uint8Array(26))),
      createBearerSecret(crypto.getRandomValues(new Uint8Array(32))),
    );
    const redeemedAgent = await apiRequest({
      path: "/v1/agent/enrollments/redeem",
      method: "POST",
      token: enrollment,
      idempotencyKey: nextIdempotencyKey(),
      body: { credential: agentCredential },
    });
    assert(redeemedAgent.response.status === 200, "Agent setup for organization deletion failed.");
    const preDeletionSession = await apiRequest({
      path: "/v1/agent/sessions",
      method: "POST",
      token: agentCredential,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(preDeletionSession.response.status === 200, "Existing agent could not authenticate before deletion.");
    const preDeletionSessionId = asRecord(
      preDeletionSession.body["data"],
      "Existing agent session data",
    )["sessionId"];
    assert(typeof preDeletionSessionId === "string", "Existing agent session omitted its ID.");

    const humanBlockerCreate = await runHumanMutation(
      "humanTaskMutations:createTask",
      originalMembership.organizationId,
      {
        workspaceId,
        title: "Human supervisor blocker",
        type: "task",
        priority: 1,
        idempotencyKey: nextIdempotencyKey(),
      },
    );
    const humanBlocker = asRecord(
      asRecord(humanBlockerCreate["data"], "Human blocker data")["task"],
      "Human blocker task",
    );
    const humanBlockerKey = humanBlocker["key"];
    assert(typeof humanBlockerKey === "string", "Human blocker creation omitted its key.");
    const humanClaimTargetCreate = await runHumanMutation(
      "humanTaskMutations:createTask",
      originalMembership.organizationId,
      {
        workspaceId,
        title: "Claimed work supervised by a human",
        type: "task",
        priority: 1,
        idempotencyKey: nextIdempotencyKey(),
      },
    );
    const humanClaimTarget = asRecord(
      asRecord(humanClaimTargetCreate["data"], "Human claim-target data")["task"],
      "Human claim-target task",
    );
    const humanClaimTargetKey = humanClaimTarget["key"];
    assert(typeof humanClaimTargetKey === "string", "Human claim target omitted its key.");
    const claimedForHumanEdit = await apiRequest({
      path: `/v1/tasks/${encodeURIComponent(humanClaimTargetKey)}/claim`,
      method: "POST",
      token: agentCredential,
      sessionId: preDeletionSessionId,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(claimedForHumanEdit.response.status === 200, "Agent could not claim the human edit target.");
    const claimedTask = asRecord(
      asRecord(claimedForHumanEdit.body["data"], "Claimed target data")["task"],
      "Claimed target task",
    );
    const preservedClaim = asRecord(claimedTask["currentClaim"], "Claim before human edit");
    const claimedRevision = claimedTask["revision"];
    assert(typeof claimedRevision === "number", "Claimed target omitted its revision.");
    const humanBlockedClaim = await runHumanMutation(
      "humanTaskMutations:addTaskDependency",
      originalMembership.organizationId,
      {
        workspaceId,
        key: humanClaimTargetKey,
        blockerKey: humanBlockerKey,
        revision: claimedRevision,
        idempotencyKey: nextIdempotencyKey(),
      },
    );
    const humanBlockedTask = asRecord(
      asRecord(humanBlockedClaim["data"], "Human dependency data")["task"],
      "Human-blocked claimed task",
    );
    const humanBlockedCurrentClaim = asRecord(
      humanBlockedTask["currentClaim"],
      "Claim after human edit",
    );
    assert(
      sameClaimView(humanBlockedCurrentClaim, preservedClaim) &&
        humanBlockedTask["revision"] === claimedRevision + 1 &&
        humanBlockedTask["unresolvedBlockerCount"] === 1,
      "Human blocker insertion replaced the claim or failed to advance blocker projections.",
    );
    const blockedSubmit = await apiRequest({
      path: `/v1/tasks/${encodeURIComponent(humanClaimTargetKey)}/submit`,
      method: "POST",
      token: agentCredential,
      sessionId: preDeletionSessionId,
      idempotencyKey: nextIdempotencyKey(),
      body: {
        fence: preservedClaim["fence"],
        summary: "This submit became stale when a human planner added a blocker.",
        evidence: [{ kind: "note", text: "claimed-before-human-edit" }],
      },
    });
    assert(
      errorCode(blockedSubmit.body, "Human-supervised stale submit") === "TASK_BLOCKED",
      "A submit begun before a human planner blocker ignored the authoritative graph edit.",
    );

    const lifecycleEnrollmentSecret = createBearerSecret(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const lifecycleEnrollment = formatEnrollmentToken(
      createLocator(crypto.getRandomValues(new Uint8Array(26))),
      lifecycleEnrollmentSecret,
    );
    const lifecycleAgentCreate = await apiRequest({
      path: "/v1/agents",
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: {
        workspaceId,
        name: "credential-isolation-agent",
        preset: "worker",
        enrollment: lifecycleEnrollment,
      },
    });
    assert(lifecycleAgentCreate.response.status === 200, "Lifecycle agent creation failed.");
    const lifecycleAgent = asRecord(
      asRecord(lifecycleAgentCreate.body["data"], "Lifecycle agent create data")["agent"],
      "Lifecycle agent",
    );
    const lifecycleAgentId = lifecycleAgent["id"];
    assert(typeof lifecycleAgentId === "string", "Lifecycle agent omitted its public ID.");

    const firstCredentialLocator = createLocator(crypto.getRandomValues(new Uint8Array(26)));
    const firstCredentialSecret = createBearerSecret(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const firstCredential = formatCredentialToken(firstCredentialLocator, firstCredentialSecret);
    const firstCredentialRedemption = await apiRequest({
      path: "/v1/agent/enrollments/redeem",
      method: "POST",
      token: lifecycleEnrollment,
      idempotencyKey: nextIdempotencyKey(),
      body: { credential: firstCredential },
    });
    assert(firstCredentialRedemption.response.status === 200, "First credential redemption failed.");

    const rotatedEnrollmentSecret = createBearerSecret(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const rotatedEnrollment = formatEnrollmentToken(
      createLocator(crypto.getRandomValues(new Uint8Array(26))),
      rotatedEnrollmentSecret,
    );
    const rotation = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}/enrollments`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: { workspaceId, enrollment: rotatedEnrollment },
    });
    assert(rotation.response.status === 200, "Second enrollment issuance failed.");
    const secondCredentialLocator = createLocator(crypto.getRandomValues(new Uint8Array(26)));
    const secondCredentialSecret = createBearerSecret(
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const secondCredential = formatCredentialToken(secondCredentialLocator, secondCredentialSecret);
    const secondCredentialRedemption = await apiRequest({
      path: "/v1/agent/enrollments/redeem",
      method: "POST",
      token: rotatedEnrollment,
      idempotencyKey: nextIdempotencyKey(),
      body: { credential: secondCredential },
    });
    assert(secondCredentialRedemption.response.status === 200, "Second credential redemption failed.");
    for (const credential of [firstCredential, secondCredential]) {
      const session = await apiRequest({
        path: "/v1/agent/sessions",
        method: "POST",
        token: credential,
        idempotencyKey: nextIdempotencyKey(),
        body: {},
      });
      assert(session.response.status === 200, "Lifecycle credential could not start a session.");
    }

    const agentListing = await apiRequest({
      path: `/v1/agents?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`,
      token: organizationToken,
    });
    const listedAgents = asRecord(agentListing.body["data"], "Agent listing")["agents"];
    assert(
      agentListing.response.status === 200 &&
        Array.isArray(listedAgents) &&
        listedAgents.some(
          (value) => asRecord(value, "Listed agent")["id"] === lifecycleAgentId,
        ),
      "Agent listing omitted the lifecycle agent.",
    );
    const agentDetail = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
      token: organizationToken,
    });
    assert(agentDetail.response.status === 200, "Agent detail lookup failed.");
    const credentialListing = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}/credentials?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`,
      token: organizationToken,
    });
    const listedCredentials = asRecord(
      credentialListing.body["data"],
      "Credential listing",
    )["credentials"];
    assert(
      credentialListing.response.status === 200 &&
        Array.isArray(listedCredentials) &&
        listedCredentials.some(
          (value) => asRecord(value, "Listed credential")["id"] === firstCredentialLocator,
        ) &&
        listedCredentials.some(
          (value) => asRecord(value, "Listed credential")["id"] === secondCredentialLocator,
        ),
      "Credential listing did not expose both safe credential locators.",
    );

    const revokeFirst = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}/credentials/${encodeURIComponent(firstCredentialLocator)}/revoke`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: { workspaceId },
    });
    assert(revokeFirst.response.status === 200, "Credential revocation failed.");
    const rejectedFirstCredential = await apiRequest({
      path: "/v1/agent/sessions",
      method: "POST",
      token: firstCredential,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(
      rejectedFirstCredential.response.status !== 200,
      "Revoked credential remained usable.",
    );
    const acceptedSecondCredential = await apiRequest({
      path: "/v1/agent/sessions",
      method: "POST",
      token: secondCredential,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(
      acceptedSecondCredential.response.status === 200,
      "Revoking one credential disabled its sibling credential.",
    );
    const sessionsAfterRevoke = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}/sessions?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`,
      token: organizationToken,
    });
    const liveSessions = asRecord(sessionsAfterRevoke.body["data"], "Session listing")["sessions"];
    assert(
      sessionsAfterRevoke.response.status === 200 &&
        Array.isArray(liveSessions) &&
        !liveSessions.some(
          (value) => asRecord(value, "Listed session")["credentialId"] === firstCredentialLocator,
        ) &&
        liveSessions.some(
          (value) => asRecord(value, "Listed session")["credentialId"] === secondCredentialLocator,
        ),
      "Credential revocation did not isolate active sessions by credential.",
    );

    const disableLifecycleAgent = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}/disable`,
      method: "POST",
      token: organizationToken,
      idempotencyKey: nextIdempotencyKey(),
      body: { workspaceId },
    });
    assert(disableLifecycleAgent.response.status === 200, "Agent disable failed.");
    const rejectedAfterDisable = await apiRequest({
      path: "/v1/agent/sessions",
      method: "POST",
      token: secondCredential,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(rejectedAfterDisable.response.status !== 200, "Disabled agent remained usable.");
    const sessionsAfterDisable = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}/sessions?workspaceId=${encodeURIComponent(workspaceId)}&limit=100`,
      token: organizationToken,
    });
    const disabledSessions = asRecord(
      sessionsAfterDisable.body["data"],
      "Disabled agent sessions",
    )["sessions"];
    assert(
      sessionsAfterDisable.response.status === 200 &&
        Array.isArray(disabledSessions) &&
        disabledSessions.length === 0,
      "Disabled agent still exposed active sessions.",
    );

    const foreignOrganizationToken = await fake.issueAccessToken(
      secondaryMembership.organizationId,
    );
    const foreignAgentLookup = await apiRequest({
      path: `/v1/agents/${encodeURIComponent(lifecycleAgentId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
      token: foreignOrganizationToken,
    });
    const missingAgentLookup = await apiRequest({
      path: `/v1/agents/agt_00000000000000000000000000?workspaceId=${encodeURIComponent(workspaceId)}`,
      token: foreignOrganizationToken,
    });
    assert(
      errorCode(foreignAgentLookup.body, "Foreign agent lookup") === "NOT_FOUND" &&
        errorCode(missingAgentLookup.body, "Missing agent lookup") === "NOT_FOUND",
      "Foreign and missing agent selectors were distinguishable by error code.",
    );

    const lifecycleInspection = await runFixture("localFixtures:inspectWorkspace", {
      workspaceId,
    });
    assert(
      lifecycleInspection["rawSecretLikeValueCount"] === 0,
      "Agent lifecycle administration persisted raw secret-shaped material.",
    );
    const inspectedSessions = lifecycleInspection["sessions"];
    assert(
      Array.isArray(inspectedSessions) &&
        inspectedSessions.some(
          (value) =>
            asRecord(value, "Inspected session")["credentialLocator"] === firstCredentialLocator &&
            asRecord(value, "Inspected session")["status"] === "revoked",
        ),
      "Credential revocation did not project immediately onto its active session row.",
    );

    const durableWorkspaceAssignmentInspection = await runFixture(
      "localFixtures:inspectWorkspaceHumanAssignments",
      { workspaceId },
    );
    const durableWorkspaceAssignments = durableWorkspaceAssignmentInspection["assignments"];
    assert(
      Array.isArray(durableWorkspaceAssignments) &&
        durableWorkspaceAssignments.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["userId"] === fake.userId &&
            (value as Record<string, unknown>)["status"] === "active" &&
            Array.isArray((value as Record<string, unknown>)["roles"]) &&
            ((value as Record<string, unknown>)["roles"] as unknown[]).includes("planner") &&
            ((value as Record<string, unknown>)["roles"] as unknown[]).includes("viewer"),
        ),
      "Workspace role preservation setup lacked an active planner/viewer assignment.",
    );

    fake.deleteMembership(originalMembership.id);
    await reconcileUntilMembershipStatus(
      originalMembership.id,
      "removed",
      "Soft membership removal",
    );
    const removedAccess = await apiRequest({
      path: "/v1/workspaces?limit=100",
      token: organizationToken,
    });
    assert(
      errorCode(removedAccess.body, "Reconciled removal") === "MEMBERSHIP_INACTIVE",
      "A provider-side membership removal did not block access.",
    );
    const assignmentsWhileRemovedInspection = await runFixture(
      "localFixtures:inspectWorkspaceHumanAssignments",
      { workspaceId },
    );
    const assignmentsWhileRemoved = assignmentsWhileRemovedInspection["assignments"];
    assert(
      JSON.stringify(assignmentsWhileRemoved) === JSON.stringify(durableWorkspaceAssignments),
      "Upstream membership removal destructively changed Convex workspace roles.",
    );
    fake.restoreMembership(restoredOwner);
    await reconcileUntilMembershipStatus(
      restoredOwner.id,
      "active",
      "Soft membership restoration",
    );
    const restoredAccess = await apiRequest({
      path: "/v1/workspaces?limit=100",
      token: organizationToken,
    });
    assert(
      restoredAccess.response.status === 200,
      "A membership restored with the prior provider version could not reactivate.",
    );
    const assignmentsAfterMembershipRestoreInspection = await runFixture(
      "localFixtures:inspectWorkspaceHumanAssignments",
      { workspaceId },
    );
    const assignmentsAfterMembershipRestore =
      assignmentsAfterMembershipRestoreInspection["assignments"];
    assert(
      JSON.stringify(assignmentsAfterMembershipRestore) ===
        JSON.stringify(durableWorkspaceAssignments),
      "Provider membership restoration did not preserve the planner/viewer assignment.",
    );
    const delayedRetiredMembership = await fake.signMembershipWebhook({
      eventId: `event_delayed_retired_membership_${Date.now()}`,
      event: "organization_membership.updated",
      membership: restoredOwner,
      eventCreatedAt: restoredOwner.updatedAt,
    });
    const hardMembershipDeletion = await fake.signMembershipWebhook({
      eventId: `event_hard_membership_delete_${Date.now()}`,
      event: "organization_membership.deleted",
      membership: restoredOwner,
      eventCreatedAt: new Date().toISOString(),
    });
    const hardMembershipDelivery = await deliverWebhook(hardMembershipDeletion);
    assert(
      hardMembershipDelivery.response.status === 200 &&
        hardMembershipDelivery.body["status"] === "applied",
      "A signed membership deletion did not establish its hard tombstone.",
    );
    await runFixture("localFixtures:reconcileWorkOSMembershipsNow");
    const hardRemoved = await apiRequest({
      path: "/v1/workspaces?limit=100",
      token: organizationToken,
    });
    assert(
      errorCode(hardRemoved.body, "Hard membership removal") === "MEMBERSHIP_INACTIVE",
      "A same-ID provider read cleared a signed membership deletion.",
    );
    fake.deleteMembership(originalMembership.id);
    const replacementOwner = fake.createMembership({
      organizationId: originalMembership.organizationId,
      userId: fake.userId,
      roleSlug: "admin",
      updatedAt: restoredOwner.updatedAt,
    });
    await reconcileUntilMembershipStatus(
      replacementOwner.id,
      "active",
      "Replacement membership generation",
    );
    const replacementAccess = await apiRequest({
      path: "/v1/workspaces?limit=100",
      token: organizationToken,
    });
    assert(
      replacementAccess.response.status === 200,
      "A new provider membership generation did not restore the logical membership.",
    );
    const delayedRetiredDelivery = await deliverWebhook(delayedRetiredMembership);
    assert(
      delayedRetiredDelivery.response.status === 200 &&
        delayedRetiredDelivery.body["status"] === "stale",
      "A delayed retired membership generation patched the replacement row.",
    );
    identityInspection = await runFixture("localFixtures:inspectIdentitySync");
    const membershipRetirements = identityInspection["membershipRetirements"];
    assert(
      Array.isArray(membershipRetirements) &&
        membershipRetirements.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as Record<string, unknown>)["workosMembershipId"] ===
              originalMembership.id &&
            (value as Record<string, unknown>)["replacementWorkosMembershipId"] ===
              replacementOwner.id,
        ),
      "Membership generation rebind did not durably retire the prior provider ID.",
    );
    fake.deleteMembership(replacementOwner.id);
    await reconcileUntilMembershipStatus(
      replacementOwner.id,
      "removed",
      "Final replacement removal",
    );
    const finallyRemoved = await apiRequest({
      path: "/v1/workspaces?limit=100",
      token: organizationToken,
    });
    assert(
      errorCode(finallyRemoved.body, "Final reconciled removal") === "MEMBERSHIP_INACTIVE",
      "Final replacement removal was not reflected immediately by authorization.",
    );

    const providerOrganization = fake
      .organizations()
      .find((organization) => organization.id === originalMembership.organizationId);
    assert(providerOrganization !== undefined, "Provider organization deletion setup failed.");
    const hardOrganizationDeletion = await fake.signOrganizationWebhook({
      eventId: `event_hard_organization_delete_${Date.now()}`,
      event: "organization.deleted",
      organization: providerOrganization,
      eventCreatedAt: providerOrganization.updatedAt,
    });
    const agentStateBeforeOrganizationDeletion = await runFixture(
      "localFixtures:inspectWorkspaceAgentCounts",
      { workspaceId },
    );
    const deletedOrganization = fake.deleteOrganization(providerOrganization.id);
    assert(deletedOrganization !== null, "Fake WorkOS did not delete the provider organization.");
    await reconcileUntilOrganizationStatus(
      providerOrganization.id,
      "disabled",
      "Provider organization deletion",
    );
    const blockedAgent = await apiRequest({
      path: "/v1/agent/sessions",
      method: "POST",
      token: agentCredential,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(
      errorCode(blockedAgent.body, "Agent after organization deletion") === "AUTHORIZATION_DENIED",
      "A missed organization deletion left an existing agent authorized.",
    );
    fake.restoreOrganization(providerOrganization);
    await reconcileUntilOrganizationStatus(
      providerOrganization.id,
      "active",
      "Provider organization restoration",
    );
    const hardOrganizationDelivery = await deliverWebhook(hardOrganizationDeletion);
    assert(
      hardOrganizationDelivery.response.status === 200 &&
        hardOrganizationDelivery.body["status"] === "applied",
      "A signed organization deletion did not establish its hard tombstone.",
    );
    await reconcileUntilOrganizationStatus(
      providerOrganization.id,
      "disabled",
      "Terminal signed organization deletion",
    );
    const terminallyBlockedAgent = await apiRequest({
      path: "/v1/agent/sessions",
      method: "POST",
      token: agentCredential,
      idempotencyKey: nextIdempotencyKey(),
      body: {},
    });
    assert(
      errorCode(terminallyBlockedAgent.body, "Agent after signed organization deletion") ===
        "AUTHORIZATION_DENIED",
      "A same-ID provider organization read cleared a signed deletion.",
    );
    const agentStateAfterOrganizationRestoration = await runFixture(
      "localFixtures:inspectWorkspaceAgentCounts",
      { workspaceId },
    );
    assert(
      JSON.stringify(agentStateAfterOrganizationRestoration) ===
        JSON.stringify(agentStateBeforeOrganizationDeletion),
      "Organization lifecycle projection mutated agent, grant, or enrollment history.",
    );
    const assignmentsAfterOrganizationRestoreInspection = await runFixture(
      "localFixtures:inspectWorkspaceHumanAssignments",
      { workspaceId },
    );
    const assignmentsAfterOrganizationRestore =
      assignmentsAfterOrganizationRestoreInspection["assignments"];
    assert(
      JSON.stringify(assignmentsAfterOrganizationRestore) ===
        JSON.stringify(durableWorkspaceAssignments),
      "Organization lifecycle projection mutated Convex-owned workspace assignments.",
    );

    identityInspection = await runFixture("localFixtures:inspectIdentitySync");
    assert(Array.isArray(identityInspection["memberships"]), "Final identity inspection failed.");
    console.log("✓ signed human-auth local acceptance passed");
  } finally {
    await convexDevelopment?.stop();
    fake.stop();
    await rm(realtimeProofRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown human-auth acceptance failure.";
  console.error(`✗ ${redactSecretsInText(message)}`);
  process.exitCode = 1;
}
