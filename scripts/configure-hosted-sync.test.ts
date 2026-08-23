import { describe, expect, test } from "bun:test";
import { PassThrough, Readable } from "node:stream";

import {
  buildConvexChildEnvironment,
  configureHostedSync,
  executeHostedSetup,
  generateHostedSecrets,
  HOSTED_ENVIRONMENT_NAMES,
  parseHostedArguments,
  parseHostedInput,
  readProtectedInput,
  runCommand,
  serializeHostedEnvironment,
  type CommandRequest,
  type CommandRunner,
  type GeneratedHostedSecrets,
} from "./configure-hosted-sync";
import type { ConvexTarget, ConvexTargetVerifier } from "./convex-target";

const target: ConvexTarget = {
  deploymentId: 7_654_321,
  deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: 1_234_567,
  teamId: 765_432,
};

const targetArguments = [
  "--deployment",
  target.deploymentName,
  "--team-id",
  String(target.teamId),
  "--project-id",
  String(target.projectId),
  "--deployment-id",
  String(target.deploymentId),
  "--deployment-url",
  target.deploymentUrl,
] as const;

const exactTargetVerifier: ConvexTargetVerifier = async (value) => {
  expect(value).toEqual(target);
};

const pemMarker = (verb: "BEGIN" | "END"): string =>
  [`-----${verb}`, "PRIVATE", "KEY-----"].join(" ");

const validInput = {
  authEmailFrom: "HRA Auth <auth@hra.sh>",
  resendApiKey: ["re", "hostile", "resend", "sentinel", "7d48f4"].join("_"),
  siteUrl: "https://hra.sh",
} as const;

const generatedSentinels: GeneratedHostedSecrets = {
  hmacSecret: "hostile_hmac_sentinel_MJ7fVf6Zc1v3n8mB2x4aQ5s9",
  jwks: "{\"keys\":[{\"kty\":\"RSA\",\"n\":\"hostile_jwks_sentinel\"}]}",
  jwtPrivateKey: `${pemMarker("BEGIN")} hostile_private_key_sentinel ${pemMarker("END")}`,
};

const protectedDocument = JSON.stringify(validInput);

const outputWriter = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array): boolean {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

const parseSingleQuotedEnvironment = (document: string): Map<string, string> => {
  const parsed = new Map<string, string>();
  for (const line of document.trimEnd().split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)='([^']*)'$/u.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error("Unexpected hosted environment document.");
    }
    parsed.set(match[1], match[2]);
  }
  return parsed;
};

describe("fresh hosted configuration", () => {
  test("generates an RS256 private key with its matching public JWKS and a fresh HMAC", async () => {
    const generated = await generateHostedSecrets();
    const jwks = JSON.parse(generated.jwks) as {
      keys: [{ alg: string; e: string; kty: string; n: string; use: string }];
    };
    const prefix = `${pemMarker("BEGIN")} `;
    const suffix = ` ${pemMarker("END")}`;
    expect(generated.jwtPrivateKey.startsWith(prefix)).toBe(true);
    expect(generated.jwtPrivateKey.endsWith(suffix)).toBe(true);
    const privateBody = generated.jwtPrivateKey
      .slice(prefix.length, -suffix.length)
      .replaceAll(" ", "");
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(privateBody, "base64"),
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      jwks.keys[0],
      { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode("hra-hosted-key-match-v1");
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, message);

    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ alg: "RS256", kty: "RSA", use: "sig" });
    expect(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      signature,
      message,
    )).toBe(true);
    expect(generated.hmacSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  test("passes the exact variable set only through piped stdin and keeps every value out of argv, environment, and output", async () => {
    const requests: CommandRequest[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const namesAfter = ["UNRELATED", ...HOSTED_ENVIRONMENT_NAMES].join("\n") + "\n";
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      if (requests.length === 1) return { exitCode: 0, stderr: "", stdout: "UNRELATED\n" };
      if (requests.length === 2) {
        return {
          exitCode: 0,
          stderr: `${validInput.resendApiKey}${generatedSentinels.hmacSecret}`,
          stdout: generatedSentinels.jwtPrivateKey,
        };
      }
      return { exitCode: 0, stderr: "", stdout: namesAfter };
    };

    const resendEnv = validInput.resendApiKey;
    const result = await executeHostedSetup({
      arguments: targetArguments,
      environment: {
        HOME: "/safe/operator",
        HRA_RESEND_API_KEY: resendEnv,
        PATH: `/safe/bin:${generatedSentinels.hmacSecret}`,
      },
      generate: async () => generatedSentinels,
      inputDocument: protectedDocument,
      runner,
      stderr: outputWriter(stderr),
      stdout: outputWriter(stdout),
      verifyTarget: exactTargetVerifier,
    });

    expect(result).toBe(0);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.arguments.slice(1))).toEqual([
      ["env", "list", "--names-only", "--deployment", target.deploymentName],
      ["env", "set", "--deployment", target.deploymentName],
      ["env", "list", "--names-only", "--deployment", target.deploymentName],
    ]);
    const configured = parseSingleQuotedEnvironment(requests[1]!.stdin);
    expect([...configured.keys()]).toEqual([...HOSTED_ENVIRONMENT_NAMES]);
    const hmac = generatedSentinels.hmacSecret;
    const resend = validInput.resendApiKey;
    expect(Object.fromEntries(configured)).toEqual({
      HRA_AUTH_EMAIL_FROM: validInput.authEmailFrom,
      HRA_AUTH_HMAC_SECRET: hmac,
      HRA_RESEND_API_KEY: resend,
      JWKS: generatedSentinels.jwks,
      JWT_PRIVATE_KEY: generatedSentinels.jwtPrivateKey,
      SITE_URL: validInput.siteUrl,
    });

    const protectedValues = [
      ...Object.values(validInput),
      ...Object.values(generatedSentinels),
    ];
    const observable = JSON.stringify({
      arguments: requests.map((request) => request.arguments),
      environments: requests.map((request) => request.environment),
      executable: requests.map((request) => request.executable),
      stderr,
      stdout,
    });
    for (const value of protectedValues) expect(observable).not.toContain(value);
    expect(stdout).toEqual(["Configured 6 fresh hosted variables.\n"]);
    expect(stderr).toEqual([]);
  });

  test("refuses every preexisting target before it sends any value", async () => {
    const requests: CommandRequest[] = [];
    const runner: CommandRunner = async (request) => {
      requests.push(request);
      return { exitCode: 0, stderr: "", stdout: "SITE_URL\n" };
    };

    await expect(configureHostedSync({
      generate: async () => generatedSentinels,
      input: validInput,
      runner,
      target,
      verifyTarget: exactTargetVerifier,
    })).rejects.toThrow("target_already_configured");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.stdin).toBe("");
  });

  test("closes on ambiguous names, failed writes, and incomplete readback without exposing provider output", async () => {
    const cases: readonly Readonly<{
      expected: string;
      results: readonly Readonly<{ exitCode: number; stderr: string; stdout: string }>[];
    }>[] = [
      {
        expected: "convex_environment_ambiguous",
        results: [{ exitCode: 0, stderr: "", stdout: "SITE_URL=value\n" }],
      },
      {
        expected: "convex_environment_set_failed",
        results: [
          { exitCode: 0, stderr: "", stdout: "" },
          { exitCode: 1, stderr: validInput.resendApiKey, stdout: generatedSentinels.jwks },
        ],
      },
      {
        expected: "convex_environment_verification_failed",
        results: [
          { exitCode: 0, stderr: "", stdout: "" },
          { exitCode: 0, stderr: "", stdout: "" },
          { exitCode: 0, stderr: "", stdout: "SITE_URL\n" },
        ],
      },
    ];
    for (const scenario of cases) {
      let index = 0;
      const runner: CommandRunner = async () => scenario.results[index++]!;
      await expect(configureHostedSync({
        generate: async () => generatedSentinels,
        input: validInput,
        runner,
        target,
        verifyTarget: exactTargetVerifier,
      })).rejects.toThrow(scenario.expected);
    }
  });

  test("accepts one strict bounded document and a closed deployment selector", () => {
    expect(parseHostedArguments([
      ...targetArguments,
      "--input-fd",
      "3",
    ])).toEqual({ inputFd: 3, target });
    expect(parseHostedInput(protectedDocument)).toEqual(validInput);
    expect(() => parseHostedArguments([
      ...targetArguments,
      "--deployment",
      "other-otter-456",
    ])).toThrow("usage_invalid");
    expect(() => parseHostedArguments([...targetArguments, "--input-fd", "1"]))
      .toThrow("usage_invalid");
    expect(() => parseHostedInput(`${protectedDocument}\n{}`)).toThrow("input_invalid");
    expect(() => parseHostedInput(JSON.stringify({ ...validInput, unexpected: true })))
      .toThrow("input_invalid");
    expect(() => parseHostedInput(JSON.stringify({ ...validInput, siteUrl: "http://hra.sh" })))
      .toThrow("input_invalid");
    expect(() => parseHostedInput(JSON.stringify({ ...validInput, resendApiKey: "not-a-key" })))
      .toThrow("input_invalid");
  });

  test("serializes deterministic dotenv input and sanitizes inherited secret variables", () => {
    const document = serializeHostedEnvironment(validInput, generatedSentinels);
    expect([...parseSingleQuotedEnvironment(document).keys()]).toEqual([
      ...HOSTED_ENVIRONMENT_NAMES,
    ]);
    const hmac = generatedSentinels.hmacSecret;
    expect(buildConvexChildEnvironment({
      CONVEX_DEPLOY_KEY: "deploy-secret",
      HOME: "/safe/home",
      HRA_AUTH_HMAC_SECRET: hmac,
      PATH: generatedSentinels.hmacSecret,
    }, Object.values(generatedSentinels))).toEqual({
      HOME: "/safe/home",
      NO_COLOR: "1",
      TERM: "dumb",
    });
  });
});

describe("protected operator process boundaries", () => {
  test("refuses a terminal before reading and bounds both stalled and oversized input", async () => {
    let created = false;
    await expect(readProtectedInput(3, 50, {
      createStream: () => {
        created = true;
        return Readable.from([]);
      },
      isTerminal: () => true,
    })).rejects.toThrow("input_not_protected");
    expect(created).toBe(false);

    await expect(readProtectedInput(3, 5, {
      createStream: () => new PassThrough(),
      isTerminal: () => false,
    })).rejects.toThrow("input_timed_out");

    await expect(readProtectedInput(3, 1_000, {
      createStream: () => Readable.from([Buffer.alloc((8 * 1024) + 1, "x")]),
      isTerminal: () => false,
    })).rejects.toThrow("input_too_large");
  });

  test("kills bounded commands on timeout or output overflow", async () => {
    const environment = buildConvexChildEnvironment(process.env, []);
    const timeout = await runCommand({
      arguments: ["-e", "setInterval(() => undefined, 1000)"],
      cwd: import.meta.dir,
      environment,
      executable: process.execPath,
      outputMaximumBytes: 1_024,
      stdin: "",
      timeoutMs: 25,
    });
    expect(timeout.exitCode).toBe(124);

    const overflow = await runCommand({
      arguments: ["-e", "process.stdout.write('x'.repeat(4096))"],
      cwd: import.meta.dir,
      environment,
      executable: process.execPath,
      outputMaximumBytes: 64,
      stdin: "",
      timeoutMs: 1_000,
    });
    expect(overflow.exitCode).toBe(1);
    expect(Buffer.byteLength(overflow.stdout, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(overflow.stderr, "utf8")).toBeLessThanOrEqual(64);
  });
});
