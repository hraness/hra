#!/usr/bin/env bun
import {
  createBearerSecret,
  desktopPairingRedeemEnvelopeSchema,
  desktopPairingStartEnvelopeSchema,
  errorEnvelopeSchema,
  pairedHumanAuthenticationResponseSchema,
  refreshAuthEnvelopeSchema,
  selectHumanScopeEnvelopeSchema,
  type PairedHumanAuthenticationResponse,
} from "@hraness/agent-tasks-protocol";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { fileURLToPath } from "node:url";

import { startFakeDesktopPairing } from "./fake-desktop-pairing";

const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONVEX_BINARY = fileURLToPath(new URL("../node_modules/.bin/convex", import.meta.url));
const ENV_FILE = fileURLToPath(new URL("../.env.local", import.meta.url));
const FIXTURE_SUBJECT = "taskctl-local-convex-auth";

type AuthTokens = { readonly token: string; readonly refreshToken: string };
type SignInResult = { readonly tokens?: AuthTokens | null };

const signInRef = makeFunctionReference<
  "action",
  {
    provider?: string;
    params?: Record<string, unknown>;
    refreshToken?: string;
    calledBy?: string;
  },
  SignInResult
>("auth:signIn");
const approvalContextRef = makeFunctionReference<
  "query",
  { pairingId: string },
  {
    status: string;
    comparisonCode: string;
    organizations: Array<{
      organization: { id: string; name: string };
      workspaces: Array<{ id: string; organizationId: string }>;
    }>;
  } | null
>("desktopPairing:approvalContext");
const approvePairingRef = makeFunctionReference<
  "mutation",
  { pairingId: string; organizationId: string; workspaceId: string },
  boolean
>("desktopPairing:approve");
const selectBrowserSessionRef = makeFunctionReference<
  "mutation",
  { organizationId: string; workspaceId: string },
  unknown
>("desktopPairing:selectSession");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
    ) value = value.slice(1, -1);
    values.set(name, value);
  }
  return values;
}

function cleanOrigin(value: string | undefined, label: string): string {
  assert(value !== undefined, `${label} is unavailable.`);
  const url = new URL(value);
  assert(
    url.protocol === "http:" && url.hostname === "127.0.0.1" &&
      url.username === "" && url.password === "" &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search === "" && url.hash === "",
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

function redact(source: string, secrets: readonly string[]): string {
  let safe = source;
  for (const secret of secrets) safe = safe.replaceAll(secret, "[REDACTED]");
  return safe.replace(
    /\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{43,})\b/gu,
    "[REDACTED]",
  );
}

async function setConvexEnvironmentVariable(name: string, value: string): Promise<void> {
  const child = Bun.spawn([CONVEX_BINARY, "env", "set", name], {
    cwd: WEB_ROOT,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.stdin.write(value);
  await child.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Convex environment update failed: ${redact(`${stdout}\n${stderr}`, [value])}`);
  }
}

async function spawnConvex(args: readonly string[]): Promise<string> {
  const child = Bun.spawn([CONVEX_BINARY, ...args], {
    cwd: WEB_ROOT,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Convex command failed: ${redact(stderr, [])}`);
  return stdout;
}

async function startConvexDevelopment() {
  const child = Bun.spawn([CONVEX_BINARY, "dev", "--tail-logs", "disable"], {
    cwd: WEB_ROOT,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
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

async function authKeyMaterial(): Promise<{ privateKey: string; jwks: string }> {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2_048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const privateBase64 = Buffer.from(privateBytes).toString("base64");
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    ...privateBase64.match(/.{1,64}/gu) ?? [],
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    privateKey,
    jwks: JSON.stringify({
      keys: [{ ...publicJwk, use: "sig", alg: "RS256", kid: "local-human-v1" }],
    }),
  };
}

async function challengeForVerifier(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

async function jsonRequest(
  origin: string,
  path: string,
  args: { readonly body: unknown; readonly bearer?: string },
): Promise<unknown> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (args.bearer !== undefined) headers.set("Authorization", `Bearer ${args.bearer}`);
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    headers,
    body: JSON.stringify(args.body),
  });
  return await response.json() as unknown;
}

function requireTokens(result: SignInResult, label: string): AuthTokens {
  assert(result.tokens !== null && result.tokens !== undefined, `${label} returned no tokens.`);
  return result.tokens;
}

async function realDesktopPairing(args: {
  accessToken: string;
  convexOrigin: string;
  siteOrigin: string;
}): Promise<PairedHumanAuthenticationResponse> {
  const verifier = createBearerSecret(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await challengeForVerifier(verifier);
  const started = desktopPairingStartEnvelopeSchema.parse(await jsonRequest(
    args.siteOrigin,
    "/v1/auth/desktop-pairings",
    { body: { challenge } },
  )).data;
  assert(!started.verificationUri.includes(verifier), "Pairing verifier escaped into the browser URL.");

  const browser = new ConvexHttpClient(args.convexOrigin);
  browser.setAuth(args.accessToken);
  const context = await browser.query(approvalContextRef, { pairingId: started.pairingId });
  assert(context !== null && context.status === "pending", "Browser pairing context was unavailable.");
  assert(context.comparisonCode === started.comparisonCode, "Pairing comparison code changed.");
  const scope = context.organizations
    .flatMap(({ organization, workspaces }) =>
      workspaces.map((workspace) => ({ organization, workspace })))
    .at(0);
  assert(scope !== undefined, "Password sign-up created no approvable workspace.");
  assert(await browser.mutation(approvePairingRef, {
    pairingId: started.pairingId,
    organizationId: scope.organization.id,
    workspaceId: scope.workspace.id,
  }), "Browser pairing approval was rejected.");

  const redeemPath = `/v1/auth/desktop-pairings/${started.pairingId}/redeem`;
  const redeemed = desktopPairingRedeemEnvelopeSchema.parse(
    await jsonRequest(args.siteOrigin, redeemPath, { body: { verifier } }),
  ).data;
  assert(redeemed.status === "approved", "Native verifier did not redeem an approved pairing.");
  const replay = desktopPairingRedeemEnvelopeSchema.parse(
    await jsonRequest(args.siteOrigin, redeemPath, { body: { verifier } }),
  ).data;
  assert(replay.status === "consumed", "Desktop pairing replay was not consumed.");
  return redeemed.authentication;
}

async function runCliAcceptance(
  siteOrigin: string,
  authentication: PairedHumanAuthenticationResponse,
): Promise<void> {
  const fake = startFakeDesktopPairing(authentication);
  try {
    const secrets = [authentication.accessToken, authentication.refreshToken];
    const child = Bun.spawn([process.execPath, "run", "../cli/tests/local-human.ts"], {
      cwd: WEB_ROOT,
      env: {
        ...process.env,
        TASKCTL_TEST_CONVEX_SITE_ORIGIN: siteOrigin,
        TASKCTL_TEST_PAIRING_ORIGIN: fake.origin,
        CI: "1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const safeOutput = redact(`${stdout}\n${stderr}`, secrets);
    if (safeOutput.length > 0) process.stdout.write(safeOutput);
    assert(exitCode === 0, "Signed CLI acceptance failed.");
    assert(
      stdout.includes("✓ taskctl signed human + agent CLI acceptance passed"),
      "Signed CLI acceptance omitted its success marker.",
    );
  } finally {
    await fake.close();
  }
}

async function setMembershipStatus(
  userPublicId: string,
  organizationPublicId: string,
  status: "active" | "removed",
): Promise<void> {
  const output = await spawnConvex([
    "run",
    "localFixtures:setHumanMembershipStatus",
    JSON.stringify({ userPublicId, organizationPublicId, status }),
    "--identity",
    JSON.stringify({
      subject: FIXTURE_SUBJECT,
      issuer: "https://fixture.local",
      tokenIdentifier: `https://fixture.local|${FIXTURE_SUBJECT}`,
    }),
    "--typecheck",
    "disable",
    "--codegen",
    "disable",
  ]);
  assert(output.includes('"applied": true') || output.includes('"applied":true'),
    `Membership ${status} fixture did not apply.`);
}

async function main(): Promise<void> {
  console.log("taskctl Convex Auth human acceptance");
  const dotEnv = await readDotEnv();
  const deployment = process.env.CONVEX_DEPLOYMENT ?? dotEnv.get("CONVEX_DEPLOYMENT");
  assert(
    deployment?.startsWith("anonymous:") === true,
    "The Convex Auth acceptance requires an initialized anonymous deployment.",
  );
  const siteOrigin = cleanOrigin(
    process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? process.env.CONVEX_SITE_URL ??
      dotEnv.get("NEXT_PUBLIC_CONVEX_SITE_URL") ?? dotEnv.get("CONVEX_SITE_URL"),
    "local Convex site origin",
  );
  const convexOrigin = cleanOrigin(
    process.env.NEXT_PUBLIC_CONVEX_URL ?? dotEnv.get("NEXT_PUBLIC_CONVEX_URL"),
    "local Convex deployment origin",
  );
  const signing = await authKeyMaterial();
  const environment = {
    HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT:
      createBearerSecret(deterministicBytes(0x48524146, 32)),
    HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION: "local-human-v1",
    JWKS: signing.jwks,
    JWT_PRIVATE_KEY: signing.privateKey,
    NEXT_PUBLIC_SITE_URL: siteOrigin,
    SITE_URL: siteOrigin,
    TASKCTL_CREDENTIAL_PEPPER_CURRENT:
      createBearerSecret(deterministicBytes(0x43524544, 32)),
    TASKCTL_CREDENTIAL_PEPPER_CURRENT_VERSION: "local-human-v1",
    TASKCTL_ENROLLMENT_PEPPER_CURRENT:
      createBearerSecret(deterministicBytes(0x454e524c, 32)),
    TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION: "local-human-v1",
    TASKCTL_LOCAL_FIXTURES_ENABLED: "true",
    TASKCTL_LOCAL_FIXTURE_SUBJECT: FIXTURE_SUBJECT,
  } as const;
  for (const [name, value] of Object.entries(environment)) {
    await setConvexEnvironmentVariable(name, value);
  }

  let development: Awaited<ReturnType<typeof startConvexDevelopment>> | undefined;
  let revocationScope: { userId: string; organizationId: string } | undefined;
  try {
    development = await startConvexDevelopment();
    const authClient = new ConvexHttpClient(convexOrigin);
    const suffix = `${Date.now()}-${crypto.randomUUID()}`;
    const email = `convex-auth-${suffix}@example.test`;
    const password = `HRA-local-${suffix}-password`;

    let shortPasswordRejected = false;
    try {
      await authClient.action(signInRef, {
        provider: "password",
        params: { flow: "signUp", email: `short-${email}`, password: "too-short", name: "Short" },
        calledBy: "hra-local-password-policy-proof",
      });
    } catch {
      shortPasswordRejected = true;
    }
    assert(shortPasswordRejected, "Direct password sign-up bypassed the server minimum.");

    requireTokens(await authClient.action(signInRef, {
      provider: "password",
      params: { flow: "signUp", email, password, name: "Local HRA Human" },
      calledBy: "hra-local-password-sign-up",
    }), "Password sign-up");
    const passwordTokens = requireTokens(await authClient.action(signInRef, {
      provider: "password",
      params: { flow: "signIn", email, password },
      calledBy: "hra-local-password-sign-in",
    }), "Password sign-in");

    const paired = await realDesktopPairing({
      accessToken: passwordTokens.token,
      convexOrigin,
      siteOrigin,
    });
    const rotated = selectHumanScopeEnvelopeSchema.parse(await jsonRequest(
      siteOrigin,
      "/v1/auth/selection",
      {
        bearer: paired.accessToken,
        body: {
          organizationId: paired.organization.id,
          workspaceId: paired.workspace.id,
        },
      },
    )).data;
    assert(rotated.accessToken !== paired.accessToken, "Scope selection did not rotate access.");
    const oldScope = await jsonRequest(siteOrigin, "/v1/auth/selection", {
      bearer: paired.accessToken,
      body: { organizationId: paired.organization.id, workspaceId: paired.workspace.id },
    });
    assert(errorEnvelopeSchema.safeParse(oldScope).success,
      "The old scope token remained authorized after rotation.");

    const refreshed = refreshAuthEnvelopeSchema.parse(await jsonRequest(
      siteOrigin,
      "/v1/auth/refresh",
      { bearer: rotated.refreshToken, body: {} },
    )).data;
    assert(refreshed.workspace !== undefined, "Refresh lost the exact selected workspace.");
    const cliAuthentication = pairedHumanAuthenticationResponseSchema.parse(refreshed);
    await runCliAcceptance(siteOrigin, cliAuthentication);

    const revocationTokens = requireTokens(await authClient.action(signInRef, {
      provider: "password",
      params: { flow: "signIn", email, password },
      calledBy: "hra-local-membership-revocation",
    }), "Revocation sign-in");
    const revocationClient = new ConvexHttpClient(convexOrigin);
    revocationClient.setAuth(revocationTokens.token);
    assert(await revocationClient.mutation(selectBrowserSessionRef, {
      organizationId: cliAuthentication.organization.id,
      workspaceId: cliAuthentication.workspace.id,
    }) !== null, "Revocation session selection failed.");
    revocationScope = {
      userId: cliAuthentication.user.id,
      organizationId: cliAuthentication.organization.id,
    };
    await setMembershipStatus(revocationScope.userId, revocationScope.organizationId, "removed");
    const denied = await jsonRequest(siteOrigin, "/v1/auth/selection", {
      bearer: revocationTokens.token,
      body: {
        organizationId: cliAuthentication.organization.id,
        workspaceId: cliAuthentication.workspace.id,
      },
    });
    assert(errorEnvelopeSchema.safeParse(denied).success,
      "Removed membership retained scope authority.");
    await setMembershipStatus(revocationScope.userId, revocationScope.organizationId, "active");
    revocationScope = undefined;

    console.log("✓ Convex Auth password, pairing, refresh, scope, revocation, and CLI acceptance passed");
  } finally {
    if (revocationScope !== undefined) {
      await setMembershipStatus(
        revocationScope.userId,
        revocationScope.organizationId,
        "active",
      ).catch(() => undefined);
    }
    await development?.stop();
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? redact(error.message, []) : "Convex Auth acceptance failed.");
  process.exitCode = 1;
}
