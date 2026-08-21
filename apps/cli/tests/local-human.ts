import {
  createBearerSecret,
  createLocator,
  createUuidV7,
  errorEnvelopeSchema,
  formatEnrollmentToken,
  redactSecretsInText,
  type IdempotencyKey,
} from "@hraness/agent-tasks-protocol";
import { chmod, lstat, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { runCli } from "../src/index";
import type { FetchLike } from "../src/client";
import type { CliIo } from "../src/output";

const SITE_ORIGIN_ENV = "TASKCTL_TEST_CONVEX_SITE_ORIGIN";
const PAIRING_ORIGIN_ENV = "TASKCTL_TEST_PAIRING_ORIGIN";
const REALTIME_PROOF_ROOT_ENV = "TASKCTL_TEST_REALTIME_PROOF_ROOT";
const REALTIME_MARKER_FILE = "taskctl-ready.json";
const REALTIME_SUBSCRIPTION_ACK_FILE = "subscription-ready";
const REALTIME_OBSERVED_ACK_FILE = "mutation-observed";
const REALTIME_ACK_TIMEOUT_MS = 30_000;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly data: unknown;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} was not an object.`);
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string, label: string): string {
  const field = asRecord(value, label)[name];
  assert(typeof field === "string" && field.length > 0, `${label} omitted ${name}.`);
  return field;
}

function numberField(value: unknown, name: string, label: string): number {
  const field = asRecord(value, label)[name];
  assert(Number.isSafeInteger(field) && Number(field) >= 0, `${label} omitted ${name}.`);
  return Number(field);
}

function arrayField(value: unknown, name: string, label: string): unknown[] {
  const field = asRecord(value, label)[name];
  assert(Array.isArray(field), `${label} omitted ${name}.`);
  return field;
}

function parseLastJson(source: string, label: string): unknown {
  const lines = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const last = lines.at(-1);
  assert(last !== undefined, `${label} returned no JSON.`);
  try {
    return JSON.parse(last) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function localOrigin(value: string | undefined, label: string): string {
  assert(value !== undefined, `${label} is unavailable.`);
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search === "" &&
      url.hash === "",
    `${label} must be an exact loopback HTTP origin.`,
  );
  return url.origin;
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

let idempotencySequence = 0;

function nextIdempotencyKey(): IdempotencyKey {
  idempotencySequence += 1;
  return createUuidV7(Date.now(), deterministicBytes(0x48554d41 + idempotencySequence, 10));
}

async function assertMode0600(path: string, label: string): Promise<void> {
  const metadata = await stat(path);
  assert(metadata.isFile(), `${label} was not a regular file.`);
  assert((metadata.mode & 0o777) === 0o600, `${label} was not mode 0600.`);
  if (typeof process.getuid === "function") {
    assert(metadata.uid === process.getuid(), `${label} was not owned by the current user.`);
  }
}

async function optionalRealtimeProofRoot(): Promise<string | undefined> {
  const root = process.env[REALTIME_PROOF_ROOT_ENV];
  if (root === undefined) return undefined;
  assert(isAbsolute(root), "The realtime proof root was not absolute.");
  const metadata = await lstat(root);
  assert(metadata.isDirectory(), "The realtime proof root was not a real directory.");
  assert((metadata.mode & 0o777) === 0o700, "The realtime proof root was not mode 0700.");
  if (typeof process.getuid === "function") {
    assert(metadata.uid === process.getuid(), "The realtime proof root was not owned by the current user.");
  }
  return root;
}

async function waitForRealtimeAck(root: string, filename: string, expected: string): Promise<void> {
  const path = join(root, filename);
  const deadline = Date.now() + REALTIME_ACK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const metadata = await lstat(path);
      assert(metadata.isFile(), `${filename} was not a real file.`);
      assert((metadata.mode & 0o777) === 0o600, `${filename} was not mode 0600.`);
      if (typeof process.getuid === "function") {
        assert(metadata.uid === process.getuid(), `${filename} was not owned by the current user.`);
      }
      assert((await readFile(path, "utf8")) === expected, `${filename} was malformed.`);
      return;
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await Bun.sleep(50);
  }
  throw new Error(`${filename} did not arrive before the realtime proof timeout.`);
}

async function removeRealtimeProofFiles(root: string): Promise<void> {
  await Promise.all(
    [REALTIME_MARKER_FILE, REALTIME_SUBSCRIPTION_ACK_FILE, REALTIME_OBSERVED_ACK_FILE].map(
      async (filename) => await rm(join(root, filename), { force: true }),
    ),
  );
}

function makeRoutedFetch(siteOrigin: string, pairingOrigin: string): FetchLike {
  return async (input, init) => {
    const rawUrl = input instanceof Request ? input.url : String(input);
    const url = new URL(rawUrl);
    if (
      url.origin === siteOrigin &&
      (url.pathname === "/v1/auth/desktop-pairings" ||
        /^\/v1\/auth\/desktop-pairings\/pair_[0-9A-HJKMNP-TV-Z]{26}\/redeem$/u.test(
          url.pathname,
        ))
    ) {
      const target = new URL(`${url.pathname}${url.search}`, pairingOrigin);
      const routed = await globalThis.fetch(target, init);
      // This loopback-only fixture is an injected transport, not a redirect.
      // Preserve the production API origin visible to the strict client.
      return new Response(routed.body, {
        status: routed.status,
        statusText: routed.statusText,
        headers: routed.headers,
      });
    }
    return await globalThis.fetch(input, init);
  };
}

async function main(): Promise<void> {
  console.log("taskctl signed human + agent CLI acceptance");
  const siteOrigin = localOrigin(process.env[SITE_ORIGIN_ENV], "local Convex site origin");
  const pairingOrigin = localOrigin(
    process.env[PAIRING_ORIGIN_ENV],
    "desktop pairing fixture origin",
  );

  const temporaryRoot = await mkdtemp(join(tmpdir(), "taskctl-human-local-"));
  const humanProfileFile = join(temporaryRoot, "human-profile.json");
  const humanSecretFile = join(temporaryRoot, "human-secret.json");
  const workerRoot = join(temporaryRoot, "worker");
  const reviewerRoot = join(temporaryRoot, "reviewer");
  const workerCredentialFile = join(workerRoot, "credentials.json");
  const reviewerCredentialFile = join(reviewerRoot, "credentials.json");
  const workerCredentialMetadataFile = `${workerCredentialFile}.metadata`;
  const reviewerCredentialMetadataFile = `${reviewerCredentialFile}.metadata`;
  const workerProfileFile = join(workerRoot, "profile.json");
  const reviewerProfileFile = join(reviewerRoot, "profile.json");
  const workerEnrollmentFile = join(temporaryRoot, "builder.enrollment");
  const reviewerEnrollmentFile = join(temporaryRoot, "reviewer.enrollment");
  const taskctlEntry = join(import.meta.dir, "..", "src", "index.ts");
  const environment = {
    ...process.env,
    TASKCTL_API_URL: siteOrigin,
    TASKCTL_WEB_URL: pairingOrigin,
    TASKCTL_CONFIG_HOME: temporaryRoot,
    TASKCTL_HUMAN_PROFILE_FILE: humanProfileFile,
    TASKCTL_HUMAN_SECRET_FILE: humanSecretFile,
  };
  const routedFetch = makeRoutedFetch(siteOrigin, pairingOrigin);
  const commandResults: CommandResult[] = [];
  const processResults: CommandResult[] = [];

  async function command(
    argv: readonly string[],
    options: { readonly stdin?: string; readonly expectSuccess?: boolean } = {},
  ): Promise<CommandResult> {
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
      readStdin: () => Promise.resolve(options.stdin ?? ""),
      stdinIsTTY: false,
    };
    const exitCode = await runCli(argv, {
      environment,
      fetch: routedFetch,
      io,
      sleep: () => Promise.resolve(),
      openBrowser: () => Promise.resolve(),
    });
    const expectSuccess = options.expectSuccess ?? true;
    const diagnostic = redactSecretsInText(expectSuccess ? stderr : stdout)
      .trim()
      .slice(-1_000);
    assert(
      expectSuccess ? exitCode === 0 : exitCode !== 0,
      `${argv.slice(0, 3).join(" ")} ${
        expectSuccess ? "failed" : "unexpectedly succeeded"
      }.${diagnostic.length === 0 ? "" : ` ${diagnostic}`}`,
    );
    const source = expectSuccess ? stdout : stderr;
    const result = {
      exitCode,
      stdout,
      stderr,
      data: parseLastJson(source, argv.join(" ")),
    };
    commandResults.push(result);
    return result;
  }

  async function agentProcess(
    configRoot: string,
    argv: readonly string[],
    options: { readonly stdin?: string; readonly expectSuccess?: boolean } = {},
  ): Promise<CommandResult> {
    const renderedArgv = argv.join("\u0000");
    assert(
      !/(?:agt|enr)_[0-9A-HJKMNP-TV-Z]{26}_[A-Za-z0-9_-]{43}/u.test(renderedArgv) &&
        !/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u.test(renderedArgv),
      "A taskctl subprocess received bearer material in argv.",
    );
    const subprocessEnvironment = { ...process.env };
    delete subprocessEnvironment["TASKCTL_TOKEN"];
    delete subprocessEnvironment["TASKCTL_SESSION_ID"];
    delete subprocessEnvironment["TASKCTL_ENROLLMENT_TOKEN"];
    delete subprocessEnvironment[REALTIME_PROOF_ROOT_ENV];
    subprocessEnvironment["TASKCTL_API_URL"] = siteOrigin;
    subprocessEnvironment["TASKCTL_CONFIG_HOME"] = configRoot;
    const subprocess = Bun.spawn([process.execPath, "run", taskctlEntry, ...argv], {
      cwd: join(import.meta.dir, ".."),
      env: subprocessEnvironment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    await subprocess.stdin.write(options.stdin ?? "");
    await subprocess.stdin.end();
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);
    const expectSuccess = options.expectSuccess ?? true;
    const diagnostic = redactSecretsInText(expectSuccess ? stderr : stdout)
      .trim()
      .slice(-1_000);
    assert(
      expectSuccess ? exitCode === 0 : exitCode !== 0,
      `${argv.slice(0, 3).join(" ")} subprocess ${
        expectSuccess ? "failed" : "unexpectedly succeeded"
      }.${diagnostic.length === 0 ? "" : ` ${diagnostic}`}`,
    );
    const source = expectSuccess ? stdout : stderr;
    const result = {
      exitCode,
      stdout,
      stderr,
      data: parseLastJson(source, argv.join(" ")),
    };
    processResults.push(result);
    return result;
  }

  let realtimeProofRoot: string | undefined;
  try {
    realtimeProofRoot = await optionalRealtimeProofRoot();
    const login = await command(["auth", "login", "--secret-store", "file", "--no-browser", "--json"]);
    assert(!login.stdout.includes("accessToken") && !login.stdout.includes("refreshToken"), "Login printed human tokens.");
    assert(!login.stderr.includes("accessToken") && !login.stderr.includes("refreshToken"), "Login diagnostics printed human tokens.");
    await Promise.all([
      assertMode0600(humanProfileFile, "Human profile"),
      assertMode0600(humanSecretFile, "Human secret"),
    ]);
    const profileSource = await readFile(humanProfileFile, "utf8");
    assert(!profileSource.includes("accessToken") && !profileSource.includes("refreshToken"), "Human profile stored bearer material.");
    console.log("  completed browser-confirmed desktop pairing with separated 0600 secret storage");

    const initialOrganizations = asRecord(
      (await command(["organization", "list", "--limit", "100", "--json"])).data,
      "Initial organization list",
    );
    assert(
      Array.isArray(initialOrganizations["organizations"]) &&
        initialOrganizations["organizations"].length >= 1,
      "Browser pairing did not return an authorized organization.",
    );
    const initialWorkspaces = asRecord(
      (await command(["workspace", "list", "--json"])).data,
      "Initial workspace list",
    );
    assert(
      Array.isArray(initialWorkspaces["workspaces"]) &&
        initialWorkspaces["workspaces"].length >= 1,
      "Browser pairing did not return an authorized workspace.",
    );

    const alphaOrganizationKey = nextIdempotencyKey();
    const alphaCreated = await command([
      "organization",
      "create",
      "--name",
      "Alpha Operations",
      "--idempotency-key",
      alphaOrganizationKey,
      "--json",
    ]);
    const alphaOrganization = asRecord(
      asRecord(alphaCreated.data, "Alpha organization result")["organization"],
      "Alpha organization",
    );
    const alphaOrganizationId = stringField(alphaOrganization, "id", "Alpha organization");
    const alphaReplay = await command([
      "organization",
      "create",
      "--name",
      "Alpha Operations",
      "--idempotency-key",
      alphaOrganizationKey,
      "--json",
    ]);
    assert(
      stringField(
        asRecord(asRecord(alphaReplay.data, "Alpha replay")["organization"], "Alpha replay organization"),
        "id",
        "Alpha replay organization",
      ) === alphaOrganizationId,
      "Organization idempotency replay changed the organization.",
    );
    await command(["organization", "use", alphaOrganizationId, "--json"]);

    const alphaWorkspaceCreated = await command([
      "workspace",
      "create",
      "--name",
      "Alpha Core",
      "--slug",
      "alpha-core",
      "--task-key-prefix",
      "ALPHA",
      "--json",
    ]);
    const alphaWorkspace = asRecord(
      asRecord(alphaWorkspaceCreated.data, "Alpha workspace result")["workspace"],
      "Alpha workspace",
    );
    const alphaWorkspaceId = stringField(alphaWorkspace, "id", "Alpha workspace");
    await command(["workspace", "use", alphaWorkspaceId, "--json"]);

    const agentCreated = await command([
      "agent",
      "create",
      "--name",
      "alpha-builder",
      "--preset",
      "worker",
      "--enrollment-out",
      workerEnrollmentFile,
      "--json",
    ]);
    const workerAgentId = stringField(
      asRecord(asRecord(agentCreated.data, "Worker creation")["agent"], "Worker agent"),
      "id",
      "Worker agent",
    );
    const reviewerCreated = await command([
      "agent",
      "create",
      "--name",
      "alpha-reviewer",
      "--preset",
      "reviewer",
      "--enrollment-out",
      reviewerEnrollmentFile,
      "--json",
    ]);
    const reviewerAgentId = stringField(
      asRecord(asRecord(reviewerCreated.data, "Reviewer creation")["agent"], "Reviewer agent"),
      "id",
      "Reviewer agent",
    );
    assert(workerAgentId !== reviewerAgentId, "Worker and reviewer shared one stable agent identity.");
    await Promise.all([
      assertMode0600(workerEnrollmentFile, "Worker enrollment handoff"),
      assertMode0600(reviewerEnrollmentFile, "Reviewer enrollment handoff"),
    ]);
    const workerEnrollment = (await readFile(workerEnrollmentFile, "utf8")).trim();
    const reviewerEnrollment = (await readFile(reviewerEnrollmentFile, "utf8")).trim();
    assert(
      workerEnrollment.startsWith("enr_") && reviewerEnrollment.startsWith("enr_"),
      "Agent creation did not write both enrollment tokens.",
    );
    assert(
      !agentCreated.stdout.includes(workerEnrollment) &&
        !agentCreated.stderr.includes(workerEnrollment) &&
        !reviewerCreated.stdout.includes(reviewerEnrollment) &&
        !reviewerCreated.stderr.includes(reviewerEnrollment),
      "Agent creation printed an enrollment token.",
    );
    const workerEnrolled = await agentProcess(
      workerRoot,
      ["auth", "enroll", "--secret-store", "file", "--json"],
      { stdin: `${workerEnrollment}\n` },
    );
    const reviewerEnrolled = await agentProcess(
      reviewerRoot,
      ["auth", "enroll", "--secret-store", "file", "--json"],
      { stdin: `${reviewerEnrollment}\n` },
    );
    assert(
      !workerEnrolled.stdout.includes(workerEnrollment) &&
        !workerEnrolled.stderr.includes(workerEnrollment) &&
        !reviewerEnrolled.stdout.includes(reviewerEnrollment) &&
        !reviewerEnrolled.stderr.includes(reviewerEnrollment),
      "Enrollment echoed a token.",
    );
    const contextBeforeSwitch = asRecord(
      (await agentProcess(workerRoot, ["context", "--json"])).data,
      "Worker context",
    );
    const reviewerContext = asRecord(
      (await agentProcess(reviewerRoot, ["context", "--json"])).data,
      "Reviewer context",
    );
    assert(
      stringField(
        asRecord(contextBeforeSwitch["workspace"], "Agent workspace"),
        "id",
        "Agent workspace",
      ) === alphaWorkspaceId,
      "Enrolled agent context selected another workspace.",
    );
    assert(
      stringField(
        asRecord(contextBeforeSwitch["principal"], "Worker principal"),
        "agentId",
        "Worker principal",
      ) === workerAgentId &&
        stringField(
          asRecord(reviewerContext["principal"], "Reviewer principal"),
          "agentId",
          "Reviewer principal",
        ) === reviewerAgentId,
      "A taskctl subprocess authenticated as the wrong stable agent.",
    );

    const prerequisiteCreated = await agentProcess(workerRoot, [
      "task",
      "create",
      "--title",
      "Signed prerequisite",
      "--type",
      "task",
      "--priority",
      "2",
      "--idempotency-key",
      nextIdempotencyKey(),
      "--json",
    ]);
    const prerequisite = asRecord(
      asRecord(prerequisiteCreated.data, "Prerequisite creation")["task"],
      "Prerequisite task",
    );
    const prerequisiteKey = stringField(prerequisite, "key", "Prerequisite task");
    const dependentCreated = await agentProcess(workerRoot, [
      "task",
      "create",
      "--title",
      "Signed dependent",
      "--type",
      "task",
      "--priority",
      "2",
      "--idempotency-key",
      nextIdempotencyKey(),
      "--json",
    ]);
    const dependent = asRecord(
      asRecord(dependentCreated.data, "Dependent creation")["task"],
      "Dependent task",
    );
    const dependentKey = stringField(dependent, "key", "Dependent task");
    await agentProcess(workerRoot, [
      "task",
      "dep",
      "add",
      dependentKey,
      "--blocker",
      prerequisiteKey,
      "--revision",
      String(numberField(dependent, "revision", "Dependent task")),
      "--idempotency-key",
      nextIdempotencyKey(),
      "--json",
    ]);
    if (realtimeProofRoot !== undefined) {
      await writeFile(
        join(realtimeProofRoot, REALTIME_MARKER_FILE),
        `${JSON.stringify({
          schemaVersion: 1,
          workspaceId: alphaWorkspaceId,
          taskKey: prerequisiteKey,
          expectedAgentId: workerAgentId,
          initialStatus: stringField(prerequisite, "status", "Prerequisite task"),
          initialRevision: numberField(prerequisite, "revision", "Prerequisite task"),
        })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await waitForRealtimeAck(
        realtimeProofRoot,
        REALTIME_SUBSCRIPTION_ACK_FILE,
        "ready\n",
      );
    }
    const claimed = asRecord(
      (
        await agentProcess(workerRoot, [
          "task",
          "claim",
          prerequisiteKey,
          "--idempotency-key",
          nextIdempotencyKey(),
          "--json",
        ])
      ).data,
      "Claim result",
    );
    const claimedTask = asRecord(claimed["task"], "Claimed task");
    if (realtimeProofRoot !== undefined) {
      await waitForRealtimeAck(
        realtimeProofRoot,
        REALTIME_OBSERVED_ACK_FILE,
        "observed\n",
      );
    }
    const claimFence = numberField(
      asRecord(claimedTask["currentClaim"], "Claim tuple"),
      "fence",
      "Claim tuple",
    );
    const submitted = asRecord(
      (
        await agentProcess(workerRoot, [
          "task",
          "submit",
          prerequisiteKey,
          "--fence",
          String(claimFence),
          "--summary",
          "Signed subprocess implementation",
          "--evidence-json",
          '[{"kind":"test","command":"bun test"}]',
          "--idempotency-key",
          nextIdempotencyKey(),
          "--json",
        ])
      ).data,
      "Submission result",
    );
    const submittedTask = asRecord(submitted["task"], "Submitted task");
    const submission = asRecord(submitted["submission"], "Pending submission");
    const submissionId = stringField(submission, "id", "Pending submission");
    const reviewRevision = numberField(submittedTask, "reviewRevision", "Submitted task");
    const reviewQueue = asRecord(
      (await agentProcess(reviewerRoot, ["review", "queue", "--limit", "100", "--json"]))
        .data,
      "Reviewer queue",
    );
    const queued = arrayField(reviewQueue, "reviews", "Reviewer queue");
    assert(
      queued.some((entry) => {
        const row = asRecord(entry, "Review queue row");
        return (
          stringField(asRecord(row["task"], "Queued task"), "key", "Queued task") ===
            prerequisiteKey &&
          stringField(
            asRecord(row["submission"], "Queued submission"),
            "id",
            "Queued submission",
          ) === submissionId
        );
      }),
      "The distinct reviewer did not see the worker submission.",
    );
    const accepted = asRecord(
      (
        await agentProcess(reviewerRoot, [
          "task",
          "accept",
          prerequisiteKey,
          "--submission",
          submissionId,
          "--review-revision",
          String(reviewRevision),
          "--idempotency-key",
          nextIdempotencyKey(),
          "--json",
        ])
      ).data,
      "Acceptance result",
    );
    const acceptedTask = asRecord(accepted["task"], "Accepted task");
    assert(
      stringField(acceptedTask, "status", "Accepted task") === "done",
      "The distinct reviewer did not accept the prerequisite.",
    );
    const ready = asRecord(
      (await agentProcess(workerRoot, ["task", "ready", "--limit", "100", "--json"]))
        .data,
      "Ready task result",
    );
    const readyDependent = arrayField(ready, "tasks", "Ready task result").find(
      (entry) => stringField(entry, "key", "Ready task") === dependentKey,
    );
    assert(readyDependent !== undefined, "Accepting the prerequisite did not make the dependent ready.");
    const readyDependentTask = asRecord(readyDependent, "Ready dependent task");
    console.log(
      "  used taskctl subprocesses for two agents through dependency, claim, submit, review, accept, and ready work",
    );

    const betaCreated = await command([
      "organization",
      "create",
      "--name",
      "Beta Operations",
      "--json",
    ]);
    const betaOrganization = asRecord(
      asRecord(betaCreated.data, "Beta organization result")["organization"],
      "Beta organization",
    );
    const betaOrganizationId = stringField(betaOrganization, "id", "Beta organization");
    assert(betaOrganizationId !== alphaOrganizationId, "Two tenants shared one organization ID.");

    const alphaAuthentication = asRecord(
      JSON.parse(await readFile(humanSecretFile, "utf8")) as unknown,
      "Alpha human authentication",
    );
    const alphaAccessToken = stringField(alphaAuthentication, "accessToken", "Alpha human authentication");
    const alphaRefreshToken = stringField(
      alphaAuthentication,
      "refreshToken",
      "Alpha human authentication",
    );
    await command(["organization", "use", betaOrganizationId, "--json"]);
    const betaWorkspaceCreated = await command([
      "workspace",
      "create",
      "--name",
      "Beta Core",
      "--slug",
      "beta-core",
      "--task-key-prefix",
      "BETA",
      "--json",
    ]);
    const betaWorkspace = asRecord(
      asRecord(betaWorkspaceCreated.data, "Beta workspace result")["workspace"],
      "Beta workspace",
    );
    const betaWorkspaceId = stringField(betaWorkspace, "id", "Beta workspace");
    await command(["workspace", "use", betaWorkspaceId, "--json"]);

    const crossTenantEnrollment = formatEnrollmentToken(
      createLocator(deterministicBytes(0x43524f53, 26)),
      createBearerSecret(deterministicBytes(0x54454e54, 32)),
    );
    const crossTenantResponse = await fetch(`${siteOrigin}/v1/agents`, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${alphaAccessToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": nextIdempotencyKey(),
      },
      body: JSON.stringify({
        workspaceId: betaWorkspaceId,
        name: "cross-tenant-intruder",
        preset: "worker",
        enrollment: crossTenantEnrollment,
      }),
    });
    const crossTenantBody: unknown = await crossTenantResponse.json();
    const crossTenantError = errorEnvelopeSchema.parse(crossTenantBody);
    assert(
      !crossTenantResponse.ok && crossTenantError.error.code === "NOT_FOUND",
      "An Alpha human created a Beta agent.",
    );
    assert(
      !JSON.stringify(crossTenantBody).includes(crossTenantEnrollment),
      "Cross-tenant denial reflected an enrollment token.",
    );

    const betaWorkspaces = asRecord(
      (await command(["workspace", "list", "--limit", "100", "--json"])).data,
      "Beta workspace list",
    );
    const visibleBetaWorkspaces = betaWorkspaces["workspaces"];
    assert(Array.isArray(visibleBetaWorkspaces), "Beta workspace list was malformed.");
    assert(
      visibleBetaWorkspaces.some(
        (workspace) => stringField(workspace, "id", "Visible Beta workspace") === betaWorkspaceId,
      ) &&
        !visibleBetaWorkspaces.some(
          (workspace) => stringField(workspace, "id", "Visible Beta workspace") === alphaWorkspaceId,
        ),
      "Workspace listing crossed tenant boundaries.",
    );

    const contextAfterSwitch = asRecord(
      (await agentProcess(workerRoot, ["context", "--json"])).data,
      "Agent context after human switch",
    );
    assert(
      stringField(asRecord(contextAfterSwitch["workspace"], "Agent workspace after human switch"), "id", "Agent workspace after human switch") ===
        alphaWorkspaceId,
      "Switching the human organization changed the independent agent identity.",
    );
    console.log("  switched the human to Beta, denied an Alpha-to-Beta write, and preserved the Alpha agent");

    const finalHumanAuthentication = asRecord(
      JSON.parse(await readFile(humanSecretFile, "utf8")) as unknown,
      "Final human authentication",
    );
    const workerCredential = asRecord(
      JSON.parse(await readFile(workerCredentialFile, "utf8")) as unknown,
      "Worker credential",
    );
    const reviewerCredential = asRecord(
      JSON.parse(await readFile(reviewerCredentialFile, "utf8")) as unknown,
      "Reviewer credential",
    );
    const secrets = [
      workerEnrollment,
      reviewerEnrollment,
      alphaAccessToken,
      alphaRefreshToken,
      stringField(finalHumanAuthentication, "accessToken", "Final human authentication"),
      stringField(finalHumanAuthentication, "refreshToken", "Final human authentication"),
      stringField(workerCredential, "credential", "Worker credential"),
      stringField(reviewerCredential, "credential", "Reviewer credential"),
    ];
    const diagnostics = [...commandResults, ...processResults]
      .flatMap((result) => [result.stdout, result.stderr])
      .join("\n");
    for (const secret of secrets) {
      assert(!diagnostics.includes(secret), "A persisted secret appeared in CLI output.");
    }
    assert(
      redactSecretsInText(diagnostics) === diagnostics,
      "CLI output contained bearer-shaped material.",
    );
    for (const path of [
      workerProfileFile,
      reviewerProfileFile,
      workerCredentialMetadataFile,
      reviewerCredentialMetadataFile,
    ]) {
      const source = await readFile(path, "utf8");
      assert(redactSecretsInText(source) === source, "Non-secret agent metadata stored bearer material.");
    }
    await Promise.all([
      assertMode0600(humanProfileFile, "Final human profile"),
      assertMode0600(humanSecretFile, "Final human secret"),
      assertMode0600(workerEnrollmentFile, "Final worker enrollment handoff"),
      assertMode0600(reviewerEnrollmentFile, "Final reviewer enrollment handoff"),
      assertMode0600(workerCredentialFile, "Final worker credential"),
      assertMode0600(reviewerCredentialFile, "Final reviewer credential"),
      assertMode0600(workerCredentialMetadataFile, "Final worker credential metadata"),
      assertMode0600(reviewerCredentialMetadataFile, "Final reviewer credential metadata"),
      assertMode0600(workerProfileFile, "Final worker profile"),
      assertMode0600(reviewerProfileFile, "Final reviewer profile"),
    ]);
    console.log(
      `TASKCTL_SIGNED_ACCEPTANCE_PROOF=${JSON.stringify({
        schemaVersion: 1,
        workspaceId: alphaWorkspaceId,
        prerequisite: {
          key: prerequisiteKey,
          status: stringField(acceptedTask, "status", "Accepted task"),
          revision: numberField(acceptedTask, "revision", "Accepted task"),
        },
        dependent: {
          key: dependentKey,
          status: stringField(readyDependentTask, "status", "Ready dependent task"),
          revision: numberField(readyDependentTask, "revision", "Ready dependent task"),
        },
      })}`,
    );
    console.log("✓ taskctl signed human + agent CLI acceptance passed");
  } finally {
    if (realtimeProofRoot !== undefined) {
      await removeRealtimeProofFiles(realtimeProofRoot);
    }
    await chmod(temporaryRoot, 0o700).catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown signed CLI acceptance failure.";
  console.error(`✗ ${redactSecretsInText(message)}`);
  process.exitCode = 1;
}
