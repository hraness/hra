import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, constants, openSync, writeFileSync } from "node:fs";
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
} from "../convex/resendApiKey";
import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import { HOSTED_ENVIRONMENT_NAMES, type CommandRequest, type CommandRunner } from "./configure-hosted-sync";
import { OOMPA_CONVEX_PROJECT_ID, OOMPA_CONVEX_TEAM_ID, type ConvexTarget } from "./convex-target";
import {
  executeHostedAttentionKeyObservation,
  hostedAttentionKeyObservationSchema,
  observeHostedAttentionKey,
  parseHostedAttentionKeyInput,
  parseHostedAttentionKeyObservationArguments,
  requireProtectedAttentionKeyPipe,
} from "./migrate-hosted-attention-key";
import {
  canonicalDigest,
  deployEvidenceSchema,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const sourceCommit = "a".repeat(40);
const intendedKey = "re_attention_test";
const otpKey = "re_otp_test";
const otherKey = "re_other_test";
const inputDocument = JSON.stringify({ attentionResendApiKey: intendedKey });
const target: ConvexTarget = {
  deploymentId: 7_654_321, deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: OOMPA_CONVEX_PROJECT_ID, teamId: OOMPA_CONVEX_TEAM_ID,
};
const targetArguments = [
  "--deployment", target.deploymentName, "--deployment-url", target.deploymentUrl,
  "--team-id", String(target.teamId), "--project-id", String(target.projectId),
  "--deployment-id", String(target.deploymentId),
];
const before: RuntimeReleaseAttestation = {
  bound: true, deployedAtMs: 1_000, previousDeployDigest: null,
  runtimeRevision: "00000000-0000-4000-8000-000000000001",
  runtimeSourceCommit: "b".repeat(40), schemaIdentity: "hra-release-attestation-v1", schemaVersion: 1,
};
const after: RuntimeReleaseAttestation = {
  ...before, deployedAtMs: 2_000, previousDeployDigest: "c".repeat(64),
  runtimeRevision: "00000000-0000-4000-8000-000000000002", runtimeSourceCommit: sourceCommit,
};
const inactive = { generation: 0, globalState: "absent", outboxOccupancy: 0, safetyFaultOccupancy: 0 };
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const harness = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "oompa-attention-observe-")));
  directories.push(directory);
  await chmod(directory, 0o700);
  const deployEvidencePath = join(directory, "candidate.json");
  const evidencePath = join(directory, "prepare.json");
  const candidate = deployEvidenceSchema.parse(withSelfDigest({
    after, before, kind: "convex-deploy", overlaySha256: "d".repeat(64), phase: "candidate",
    previousDeployDigest: after.previousDeployDigest, schemaVersion: 1,
    sourceCommit, target, targetDigest: canonicalDigest(target),
  }));
  writeProtectedJsonNoReplace(deployEvidencePath, candidate, deployEvidenceSchema);
  const state = {
    attention: undefined as string | undefined,
    attestation: after,
    head: sourceCommit,
    inactive: inactive as unknown,
    names: new Set<string>(HOSTED_ENVIRONMENT_NAMES.filter((name) =>
      name !== oompaAttentionResendApiKeyEnvironmentName)),
    namesOutput: undefined as string | undefined,
    otp: otpKey,
    status: "",
  };
  const requests: CommandRequest[] = [];
  let hook: ((request: CommandRequest) => void) | undefined;
  const runner: CommandRunner = async (request) => {
    requests.push(request);
    hook?.(request);
    if (request.executable === "/usr/bin/git") {
      return { exitCode: 0, stderr: "", stdout: request.arguments[0] === "rev-parse"
        ? `${state.head}\n` : state.status };
    }
    const arguments_ = request.arguments.slice(1);
    if (arguments_[0] === "env" && arguments_[1] === "list") {
      return { exitCode: 0, stderr: "", stdout: state.namesOutput ?? `${[...state.names].join("\n")}\n` };
    }
    if (arguments_[0] === "env" && arguments_[1] === "get") {
      const value = arguments_[2] === oompaResendApiKeyEnvironmentName ? state.otp : state.attention;
      return value === undefined
        ? { exitCode: 1, stderr: "missing synthetic key", stdout: "" }
        : { exitCode: 0, stderr: "", stdout: `${value}\n` };
    }
    if (arguments_[0] === "run" && arguments_[1] === "attentionNotificationControl:inactiveDeploymentStatus") {
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(state.inactive) };
    }
    throw new Error("Unexpected write-capable or unsupported transport");
  };
  const options = {
    deployEvidencePath, evidencePath, phase: "prepare" as const, inputDocument,
    readAttestation: async () => state.attestation, repositoryRoot: directory, runner,
    sourceCommit, target, verifyTarget: async () => {},
  };
  const arguments_ = [
    ...targetArguments, "--phase", "prepare", "--source-commit", sourceCommit,
    "--deploy-evidence", deployEvidencePath, "--evidence-path", evidencePath,
  ];
  return {
    arguments_, candidate, directory, options, requests, state,
    setHook(value: (request: CommandRequest) => void) { hook = value; },
  };
};

type Harness = Awaited<ReturnType<typeof harness>>;
const expectReadOnly = (value: Harness) => {
  for (const request of value.requests) {
    expect(request.stdin).toBe("");
    expect(request.timeoutMs).toBe(60_000);
    expect(request.outputMaximumBytes).toBe(64 * 1024);
    const transport = JSON.stringify([request.arguments, request.environment]);
    for (const key of [intendedKey, otpKey, otherKey]) expect(transport).not.toContain(key);
    if (request.executable === "/usr/bin/git") continue;
    const arguments_ = request.arguments.slice(1);
    expect(arguments_.slice(-2)).toEqual(["--deployment", target.deploymentName]);
    expect(
      (arguments_[0] === "env" && ["list", "get"].includes(arguments_[1] ?? ""))
      || (arguments_[0] === "run" && arguments_[1] === "attentionNotificationControl:inactiveDeploymentStatus"),
    ).toBe(true);
    expect(arguments_).not.toContain("set");
    expect(arguments_).not.toContain("--force");
  }
};
const writer = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
  write(chunk: string | Uint8Array) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  },
});

describe("attention key observation arguments and protected input", () => {
  test("requires explicit prepare/reconcile and rejects apply, secrets, duplicates, and path aliases", async () => {
    const value = await harness();
    expect(parseHostedAttentionKeyObservationArguments(value.arguments_).phase).toBe("prepare");
    for (const arguments_ of [
      value.arguments_.filter((argument) => argument !== "--phase" && argument !== "prepare"),
      value.arguments_.map((argument) => argument === "prepare" ? "apply" : argument),
      [...value.arguments_, "--attention-resend-api-key", intendedKey],
      [...value.arguments_, "--phase", "prepare"],
      value.arguments_.map((argument) => argument === value.options.evidencePath
        ? `${value.directory}/./candidate.json` : argument),
      value.arguments_.map((argument) => argument === "prepare" ? "reconcile" : argument),
    ]) expect(() => parseHostedAttentionKeyObservationArguments(arguments_)).toThrow("usage_invalid");
    expectReadOnly(value);
  });

  test("accepts exactly one strict bounded key field without interpolating invalid input", () => {
    expect(parseHostedAttentionKeyInput(inputDocument)).toBe(intendedKey);
    for (const document of [
      "{", "[]", "{}", JSON.stringify({ attentionResendApiKey: intendedKey, other: otpKey }),
      `{"attentionResendApiKey":"${otherKey}","attentionResendApiKey":"${intendedKey}"}`,
      ...["re_shrt", "re_bad'quote", "re_bad\nline", `re_${"a".repeat(510)}`].map((key) =>
        JSON.stringify({ attentionResendApiKey: key })),
      " ".repeat(8 * 1024 + 1),
    ]) expect(() => parseHostedAttentionKeyInput(document)).toThrow("input_invalid");
  });
});

describe("protected anonymous-pipe transport", () => {
  const metadata = { dev: 1n, ino: 123n, mode: 0o10660n, nlink: 0n, uid: 501n, isFIFO: () => true };
  const dependencies = {
    currentUid: () => 501, inspect: () => metadata,
    isTerminal: () => false, platform: "darwin" as const,
  };

  test("accepts stable Darwin and proven Linux pipe identities in pure policy checks", () => {
    expect(() => requireProtectedAttentionKeyPipe(0, dependencies)).not.toThrow();
    expect(() => requireProtectedAttentionKeyPipe(0, {
      ...dependencies, inspect: () => ({ ...metadata, ino: -123n }),
    })).not.toThrow();
    expect(() => requireProtectedAttentionKeyPipe(0, {
      ...dependencies, platform: "linux", inspect: () => ({ ...metadata, nlink: 1n }),
      readLink: (path) => {
        expect(path).toBe("/proc/self/fd/0");
        return "pipe:[123]";
      },
    })).not.toThrow();
  });

  test("rejects TTY, socket/file, named pipe, wrong owner, unsupported platform and identity drift", () => {
    for (const overrides of [
      { isTerminal: () => true },
      { inspect: () => ({ ...metadata, isFIFO: () => false }) },
      { inspect: () => ({ ...metadata, nlink: 1n }) },
      { currentUid: () => 502 },
      { platform: "win32" as const },
    ]) expect(() => requireProtectedAttentionKeyPipe(0, { ...dependencies, ...overrides }))
      .toThrow("input_not_protected");
    let reads = 0;
    expect(() => requireProtectedAttentionKeyPipe(0, {
      ...dependencies, inspect: () => ({ ...metadata, ino: ++reads === 1 ? 123n : 124n }),
    })).toThrow("input_not_protected");
    for (const target of ["/protected/named-fifo", "socket:[123]", "pipe:[124]", "pipe:[0123]", "pipe:[123]\n"]) {
      expect(() => requireProtectedAttentionKeyPipe(0, {
        ...dependencies, platform: "linux", inspect: () => ({ ...metadata, nlink: 1n }),
        readLink: () => target,
      })).toThrow("input_not_protected");
    }
  });

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "accepts a real shell anonymous pipe on the running platform without exposing its contents",
    () => {
      const entry = join(import.meta.dir, "migrate-hosted-attention-key.ts");
      const script = `import { readProtectedAttentionKeyInput, parseHostedAttentionKeyInput } from ${JSON.stringify(entry)}; const value = parseHostedAttentionKeyInput(await readProtectedAttentionKeyInput()); if (value.length < 8) process.exit(1); console.log("accepted");`;
      const child = Bun.spawnSync([
        "/bin/sh", "-c", "printf '%s' \"$1\" | \"$2\" -e \"$3\"", "synthetic-pipe-test",
        inputDocument, process.execPath, script,
      ], { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      expect(child.exitCode).toBe(0);
      expect(child.stderr.toString()).toBe("");
      expect(child.stdout.toString()).toBe("accepted\n");
    },
  );

  test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "rejects real protected/public regular files, symlinks, hardlinks and named FIFOs before reading",
    async () => {
      const value = await harness();
      const privateFile = join(value.directory, "private-input.json");
      const publicFile = join(value.directory, "public-input.json");
      const symbolic = join(value.directory, "symbolic-input.json");
      const hard = join(value.directory, "hard-input.json");
      const fifo = join(value.directory, "named-input");
      await writeFile(privateFile, inputDocument, { mode: 0o600 });
      await writeFile(publicFile, inputDocument, { mode: 0o644 });
      await symlink(privateFile, symbolic);
      await link(privateFile, hard);
      const created = Bun.spawnSync(["/usr/bin/mkfifo", fifo], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      expect(created.exitCode).toBe(0);
      for (const path of [privateFile, publicFile, symbolic, hard, fifo]) {
        const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        try { expect(() => requireProtectedAttentionKeyPipe(descriptor)).toThrow("input_not_protected"); }
        finally { closeSync(descriptor); }
      }
      expectReadOnly(value);
    },
  );
});

describe("read-only preparation and reconciliation", () => {
  test.each([
    [undefined, "absent"], [intendedKey, "existing_equal"], [otherKey, "existing_mismatched"],
  ] as const)("records %s only as %s, with no provider write", async (key, expected) => {
    const value = await harness();
    if (key !== undefined) {
      value.state.attention = key;
      value.state.names.add(oompaAttentionResendApiKeyEnvironmentName);
    }
    const result = await observeHostedAttentionKey(value.options);
    expect(result.code).toBe("provider_add_only_unavailable");
    expect(result.evidence).toMatchObject({
      effect: "none", keyState: expected, phase: "prepare", preparationDigest: null,
      providerWriteCapability: "unavailable", status: "observed_only", inactive,
    });
    const protectedEvidence = readProtectedJson(value.options.evidencePath, hostedAttentionKeyObservationSchema);
    expect(protectedEvidence).toEqual(result.evidence);
    expect(protectedEvidence.intendedKeyDigest).not.toBe(createHash("sha256").update(intendedKey).digest("hex"));
    const serialized = await readFile(value.options.evidencePath, "utf8");
    for (const secret of [intendedKey, otpKey, otherKey]) expect(serialized).not.toContain(secret);
    expect((await stat(value.options.evidencePath)).mode & 0o777).toBe(0o600);
    expect((await observeHostedAttentionKey(value.options)).replayed).toBe(true);
    expectReadOnly(value);
  });

  test.each([intendedKey, otherKey, undefined])("reconciles external state %s without attributing an apply", async (key) => {
    const value = await harness();
    const prepared = await observeHostedAttentionKey(value.options);
    if (key !== undefined) {
      value.state.attention = key;
      value.state.names.add(oompaAttentionResendApiKeyEnvironmentName);
    }
    const reconciled = await observeHostedAttentionKey({
      ...value.options, phase: "reconcile", preparationEvidencePath: value.options.evidencePath,
      evidencePath: join(value.directory, "reconcile.json"),
    });
    expect(reconciled.evidence.preparationDigest).toBe(prepared.evidence.selfDigest);
    expect(reconciled.evidence.status).toBe("observed_only");
    expect(reconciled.evidence.effect).toBe("none");
    expect(reconciled.code).toBe("provider_add_only_unavailable");
    expectReadOnly(value);
  });

  test("rejects a different intended key or non-prepare evidence on reconciliation", async () => {
    const value = await harness();
    await observeHostedAttentionKey(value.options);
    const options = {
      ...value.options, phase: "reconcile" as const,
      preparationEvidencePath: value.options.evidencePath,
      evidencePath: join(value.directory, "reconcile.json"),
    };
    await expect(observeHostedAttentionKey({ ...options, inputDocument: JSON.stringify({ attentionResendApiKey: otherKey }) }))
      .rejects.toThrow("preparation_mismatch");
    await observeHostedAttentionKey(options);
    await expect(observeHostedAttentionKey({
      ...options, preparationEvidencePath: options.evidencePath, evidencePath: join(value.directory, "again.json"),
    })).rejects.toThrow("preparation_mismatch");
    expectReadOnly(value);
  });

  test("CLI always refuses write capability and never prints key digests or secrets", async () => {
    const value = await harness();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await executeHostedAttentionKeyObservation({
      ...value.options, arguments: value.arguments_, stdout: writer(stdout), stderr: writer(stderr),
    });
    expect(exitCode).toBe(1);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.join("")) as unknown).toEqual({
      code: "provider_add_only_unavailable", effect: "none", evidenceWritten: true,
      keyState: "absent", phase: "prepare", replayed: false, schemaVersion: 1, status: "refused",
    });
    const evidence = readProtectedJson(value.options.evidencePath, hostedAttentionKeyObservationSchema);
    for (const secret of [intendedKey, otpKey, evidence.intendedKeyDigest]) {
      expect(stdout.join("") + stderr.join("")).not.toContain(secret);
    }
    expectReadOnly(value);
  });

  test("filters all inherited credential shapes before the first source or provider command", async () => {
    const value = await harness();
    value.state.attention = otherKey;
    value.state.names.add(oompaAttentionResendApiKeyEnvironmentName);
    await observeHostedAttentionKey({
      ...value.options,
      environment: {
        HOME: `/protected/${otpKey}`, PATH: `/tools/${intendedKey}`, TMPDIR: `/temporary/${otherKey}`,
        APPDATA: "/settings/re_bad!fragment", USERPROFILE: "/profile/re_", SystemRoot: "/system",
        OOMPA_RESEND_API_KEY: otpKey, OOMPA_ATTENTION_RESEND_API_KEY: intendedKey,
        CONVEX_DEPLOY_KEY: "fake-deploy", RESEND_API_KEY: otherKey,
      },
    });
    expect(value.requests.length).toBeGreaterThan(0);
    for (const request of value.requests) {
      expect(request.environment).toEqual({ NO_COLOR: "1", TERM: "dumb", SystemRoot: "/system" });
      expect(JSON.stringify(request.environment)).not.toContain("re_");
    }
    expectReadOnly(value);
  });
});

describe("closed prestate, binding, and capability failures", () => {
  test("target drift stops before any further read or evidence publication", async () => {
    const value = await harness();
    let checks = 0;
    await expect(observeHostedAttentionKey({
      ...value.options,
      verifyTarget: async () => {
        if (++checks === 3) throw new Error("synthetic target changed");
      },
    })).rejects.toThrow("observation_failed");
    expect(value.requests.filter((request) => request.executable !== "/usr/bin/git")).toHaveLength(1);
    expect(await Bun.file(value.options.evidencePath).exists()).toBe(false);
    expectReadOnly(value);
  });

  test.each(["candidate", "preparation"] as const)("rejects late %s evidence changes before publication", async (kind) => {
    const value = await harness();
    const prepared = kind === "preparation" ? await observeHostedAttentionKey(value.options) : undefined;
    let reads = 0;
    value.setHook((request) => {
      if (request.phase !== "hosted-attention-key-inactive-read" || ++reads !== 3) return;
      if (prepared === undefined) {
        const { selfDigest: ignored, ...unsigned } = value.candidate;
        void ignored;
        const changed = withSelfDigest({ ...unsigned, overlaySha256: "e".repeat(64) });
        writeFileSync(value.options.deployEvidencePath, `${JSON.stringify(changed)}\n`);
      } else {
        const { selfDigest: ignored, ...unsigned } = prepared.evidence;
        void ignored;
        const changed = withSelfDigest({ ...unsigned, keyState: "existing_equal" });
        writeFileSync(value.options.evidencePath, `${JSON.stringify(changed)}\n`);
      }
    });
    const options = prepared === undefined ? value.options : {
      ...value.options, phase: "reconcile" as const, preparationEvidencePath: value.options.evidencePath,
      evidencePath: join(value.directory, "reconcile.json"),
    };
    await expect(observeHostedAttentionKey(options)).rejects.toThrow(
      prepared === undefined ? "candidate_mismatch" : "preparation_mismatch",
    );
    expect(await Bun.file(options.evidencePath).exists()).toBe(false);
    expectReadOnly(value);
  });

  test.each([
    ["dirty source", (value: Harness) => { value.state.status = " M file\n"; }, "source_changed"],
    ["different HEAD", (value: Harness) => { value.state.head = "b".repeat(40); }, "source_changed"],
    ["reused OTP", (value: Harness) => { value.state.otp = intendedKey; }, "otp_key_reused"],
    ["missing OTP", (value: Harness) => { value.state.names.delete(oompaResendApiKeyEnvironmentName); }, "prerequisites_missing"],
    ["missing reply-to", (value: Harness) => { value.state.names.delete("OOMPA_AUTH_EMAIL_REPLY_TO"); }, "prerequisites_missing"],
    ["duplicate names", (value: Harness) => { value.state.namesOutput = "SITE_URL\nSITE_URL\n"; }, "environment_ambiguous"],
    ["malformed OTP", (value: Harness) => { value.state.otp = "re_bad\nline"; }, "environment_ambiguous"],
    ["malformed attention", (value: Harness) => {
      value.state.attention = "re_bad'quote";
      value.state.names.add(oompaAttentionResendApiKeyEnvironmentName);
    }, "environment_ambiguous"],
    ["missing listed key", (value: Harness) => {
      value.state.names.add(oompaAttentionResendApiKeyEnvironmentName);
    }, "environment_ambiguous"],
    ["different runtime", (value: Harness) => { value.state.attestation = before; }, "release_attestation_invalid"],
    ["enabled", (value: Harness) => { value.state.inactive = { ...inactive, globalState: "enabled", generation: 1 }; }, "attention_not_inactive"],
    ["disabled generation", (value: Harness) => { value.state.inactive = { ...inactive, globalState: "disabled", generation: 1 }; }, "attention_not_inactive"],
    ["outbox occupied", (value: Harness) => { value.state.inactive = { ...inactive, outboxOccupancy: 1 }; }, "attention_not_inactive"],
    ["safety occupied", (value: Harness) => { value.state.inactive = { ...inactive, safetyFaultOccupancy: 1 }; }, "attention_not_inactive"],
    ["malformed status", (value: Harness) => { value.state.inactive = { ...inactive, secret: otherKey }; }, "attention_not_inactive"],
  ] as const)("%s refuses without any mutation", async (_label, change, code) => {
    const value = await harness();
    change(value);
    await expect(observeHostedAttentionKey(value.options)).rejects.toThrow(code);
    expect(await Bun.file(value.options.evidencePath).exists()).toBe(false);
    expectReadOnly(value);
  });

  test.each(["attention", "otp", "runtime", "outbox"] as const)("a concurrent %s change cannot dispatch a write", async (kind) => {
    const value = await harness();
    let statusReads = 0;
    value.setHook((request) => {
      if (request.phase !== "hosted-attention-key-inactive-read" || ++statusReads !== 2) return;
      if (kind === "attention") {
        value.state.attention = otherKey;
        value.state.names.add(oompaAttentionResendApiKeyEnvironmentName);
      } else if (kind === "otp") value.state.otp = otherKey;
      else if (kind === "runtime") value.state.attestation = before;
      else value.state.inactive = { ...inactive, outboxOccupancy: 1 };
    });
    await expect(observeHostedAttentionKey(value.options)).rejects.toThrow(
      kind === "runtime" ? "release_attestation_invalid"
        : kind === "outbox" ? "attention_not_inactive" : "prestate_changed",
    );
    expect(await Bun.file(value.options.evidencePath).exists()).toBe(false);
    expectReadOnly(value);
  });

  test.each([false, true])("transport failure is bounded, with authority refusal=%s preserved", async (authority) => {
    const value = await harness();
    value.setHook((request) => {
      if (request.executable === "/usr/bin/git") return;
      if (authority) throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable");
      throw new Error(`${intendedKey} ${otpKey} raw provider response`);
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedAttentionKeyObservation({
      ...value.options, arguments: value.arguments_, stdout: writer(stdout), stderr: writer(stderr),
    })).toBe(1);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain(authority ? "authority_containment_unavailable" : "observation_failed");
    for (const secret of [intendedKey, otpKey]) expect(stderr.join("")).not.toContain(secret);
    expect(await Bun.file(value.options.evidencePath).exists()).toBe(false);
    expectReadOnly(value);
  });

  test.each(["cleanup", "journal"] as const)("preserves terminal %s evidence and stops further reads", async (kind) => {
    const value = await harness();
    const error = kind === "cleanup"
      ? new BoundedProcessCleanupUnprovenError(42_432, "hosted-attention-key-inactive-read")
      : new BoundedProcessRecoveryJournalError(["/protected/recovery.json"], "authority_recovery_required");
    value.setHook((request) => {
      if (request.executable !== "/usr/bin/git") throw error;
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    expect(await executeHostedAttentionKeyObservation({
      ...value.options, arguments: value.arguments_, stdout: writer(stdout), stderr: writer(stderr),
    })).toBe(75);
    expect(stdout).toEqual([]);
    expect(stderr.join("")).toContain("recovery_required");
    expect(stderr.join("")).toContain("\"evidencePreserved\":true");
    expect(value.requests.filter((request) => request.executable !== "/usr/bin/git")).toHaveLength(1);
    expect(await Bun.file(value.options.evidencePath).exists()).toBe(false);
    expectReadOnly(value);
  });
});
