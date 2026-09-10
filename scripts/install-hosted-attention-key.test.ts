import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { chmod, link, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { oompaAttentionResendApiKeyEnvironmentName, oompaResendApiKeyEnvironmentName } from "../convex/resendApiKey";
import { BoundedProcessCleanupUnprovenError } from "./bounded-process";
import { HOSTED_ENVIRONMENT_NAMES, type CommandRequest, type CommandRunner } from "./configure-hosted-sync";
import { OOMPA_CONVEX_PROJECT_ID, OOMPA_CONVEX_TEAM_ID, type ConvexTarget } from "./convex-target";
import {
  attentionKeyInstallCustodySchema,
  attentionKeyInstallIntentSchema,
  attentionKeyInstallSlot,
  attentionEnvironmentFingerprint,
  executeAttentionKeyInstallation,
  installHostedAttentionKey,
  parseAttentionKeyInstallationArguments,
  parseAttentionKeyInstallationInput,
} from "./install-hosted-attention-key";
import { hostedAttentionKeyObservationSchema, observeHostedAttentionKey } from "./migrate-hosted-attention-key";
import {
  canonicalDigest, canonicalJson, deployEvidenceSchema, readProtectedJson, withSelfDigest, writeProtectedJsonNoReplace,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const sourceCommit = "a".repeat(40);
const intendedKey = "re_attention_synthetic";
const otpKey = "re_otp_synthetic";
const target: ConvexTarget = {
  deploymentId: 7_654_321, deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: OOMPA_CONVEX_PROJECT_ID, teamId: OOMPA_CONVEX_TEAM_ID,
};
const adminKey = `prod:${target.deploymentName}|${"synthetic_admin_".repeat(3)}`;
const inputDocument = JSON.stringify({ attentionResendApiKey: intendedKey, convexDeploymentAdminKey: adminKey });
const targetArguments = ["--deployment", target.deploymentName, "--deployment-url", target.deploymentUrl,
  "--team-id", String(target.teamId), "--project-id", String(target.projectId), "--deployment-id", String(target.deploymentId)];
const attestation: RuntimeReleaseAttestation = {
  bound: true, deployedAtMs: 2_000, previousDeployDigest: "c".repeat(64),
  runtimeRevision: "00000000-0000-4000-8000-000000000002", runtimeSourceCommit: sourceCommit,
  schemaIdentity: "hra-release-attestation-v1", schemaVersion: 1,
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

const harness = async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "oompa-attention-install-")));
  directories.push(directory);
  await chmod(directory, 0o700);
  const deployEvidencePath = join(directory, "candidate.json");
  const preparationEvidencePath = join(directory, "prepare.json");
  const custodyAttestationPath = join(directory, "custody.json");
  const candidate = deployEvidenceSchema.parse(withSelfDigest({
    after: attestation, before: { ...attestation, deployedAtMs: 1_000, previousDeployDigest: null,
      runtimeRevision: "00000000-0000-4000-8000-000000000001", runtimeSourceCommit: "b".repeat(40) },
    kind: "convex-deploy", overlaySha256: "d".repeat(64), phase: "candidate",
    previousDeployDigest: attestation.previousDeployDigest, schemaVersion: 1, sourceCommit,
    target, targetDigest: canonicalDigest(target),
  }));
  writeProtectedJsonNoReplace(deployEvidencePath, candidate, deployEvidenceSchema);
  const environment = new Map<string, string>(HOSTED_ENVIRONMENT_NAMES.filter((name) => name !== oompaAttentionResendApiKeyEnvironmentName)
    .map((name) => [name, name === oompaResendApiKeyEnvironmentName ? otpKey : `synthetic_${name}`]));
  const state = {
    environment, head: sourceCommit, status: "", now: 10_000, attestation,
    inactive: { generation: 0, globalState: "absent", outboxOccupancy: 0, safetyFaultOccupancy: 0 },
    dispatches: 0, reads: 0,
  };
  let requestHook: ((request: CommandRequest) => void) | undefined;
  let readHook: (() => void) | undefined;
  let dispatchHook: (() => void) | undefined;
  const requests: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    requests.push(request);
    requestHook?.(request);
    if (request.executable === "/usr/bin/git") return { exitCode: 0, stderr: "", stdout:
      request.arguments[0] === "rev-parse" ? `${state.head}\n` : state.status };
    const args = request.arguments.slice(1);
    if (args[0] === "env" && args[1] === "list") return { exitCode: 0, stderr: "", stdout: `${[...environment.keys()].join("\n")}\n` };
    if (args[0] === "env" && args[1] === "get") return { exitCode: 0, stderr: "", stdout: `${environment.get(args[2] ?? "")}\n` };
    if (args[0] === "run") return { exitCode: 0, stderr: "", stdout: JSON.stringify(state.inactive) };
    throw new Error("Unexpected write-capable command");
  };
  const observation = {
    environment: { PATH: `/synthetic/${adminKey}`, LANG: `prefix-${intendedKey}` },
    readAttestation: async () => state.attestation, repositoryRoot: directory, runner,
    verifyTarget: async () => {},
  };
  const preparation = await observeHostedAttentionKey({
    ...observation, deployEvidencePath, evidencePath: preparationEvidencePath,
    inputDocument: JSON.stringify({ attentionResendApiKey: intendedKey }), phase: "prepare",
    sourceCommit, target,
  });
  requests.splice(0);
  const custody = attentionKeyInstallCustodySchema.parse(withSelfDigest({
    authorityPremise: "operational_custody_attested", candidateDeployDigest: candidate.selfDigest,
    competingWritersQuiesced: { ci: true, cli: true, dashboard: true, delegated: true },
    evidenceDirectory: directory, evidenceDirectorySharedAndRetained: true,
    expiresAtMs: 800_000, issuedAtMs: 0,
    intendedKeyDigest: createHash("sha256").update("oompa-attention-key-observation-v1\0").update(intendedKey).digest("hex"),
    kind: "hosted-attention-key-custody", operationId: "00000000-0000-4000-8000-000000000003",
    preparationDigest: preparation.evidence.selfDigest, schemaVersion: 1, sourceCommit,
    target, targetDigest: canonicalDigest(target),
  }));
  writeProtectedJsonNoReplace(custodyAttestationPath, custody, attentionKeyInstallCustodySchema);
  const options = {
    custodyAttestationPath, deployEvidencePath, evidenceDirectory: directory, inputDocument,
    now: () => state.now, observation, phase: "install" as const, preparationEvidencePath, sourceCommit, target,
    transport: {
      async readEnvironment() {
        state.reads += 1;
        readHook?.();
        return [...environment].map(([name, value]) => ({ name, value }));
      },
      async installAttentionKey() {
        state.dispatches += 1;
        // Every provider write follows a durable, protected exact intent.
        const intent = readProtectedJson(join(directory, attentionKeyInstallSlot(target)), attentionKeyInstallIntentSchema);
        expect(intent.intendedKeyDigest).toBe(custody.intendedKeyDigest);
        dispatchHook?.();
        environment.set(oompaAttentionResendApiKeyEnvironmentName, intendedKey);
      },
    },
  };
  const arguments_ = [...targetArguments, "--phase", "install", "--source-commit", sourceCommit,
    "--deploy-evidence", deployEvidencePath, "--preparation-evidence", preparationEvidencePath,
    "--custody-attestation", custodyAttestationPath, "--evidence-directory", directory];
  const rewriteCustody = async (changes: Partial<typeof custody>) => {
    const unsigned = Object.fromEntries(Object.entries({ ...custody, ...changes }).filter(([name]) => name !== "selfDigest"));
    await writeFile(custodyAttestationPath, `${JSON.stringify(withSelfDigest(unsigned))}\n`, { mode: 0o600 });
  };
  return { arguments_, candidate, custody, directory, options, requests, rewriteCustody, state,
    setRequestHook(value: (request: CommandRequest) => void) { requestHook = value; },
    setReadHook(value: () => void) { readHook = value; },
    setDispatchHook(value: () => void) { dispatchHook = value; },
  };
};

describe("custody-scoped attention installation", () => {
  test("fixed intent slot exposes only its public name and exact target digest", () => {
    expect(attentionKeyInstallSlot(target)).toBe(
      `attention-key-OOMPA_ATTENTION_RESEND_API_KEY-${canonicalDigest(target)}.intent.json`,
    );
    expect(attentionKeyInstallSlot({ ...target, deploymentId: target.deploymentId + 1 }))
      .not.toBe(attentionKeyInstallSlot(target));
    expect(attentionKeyInstallSlot(target)).not.toContain(intendedKey);
  });

  test("environment fingerprint is purpose-bound, keyed and independent of entry order", () => {
    const entries = [{ name: "SECOND", value: "second-secret" }, { name: "FIRST", value: "first-secret" }];
    const fingerprint = attentionEnvironmentFingerprint(entries, target, intendedKey);
    const expected = createHmac("sha256", intendedKey)
      .update("oompa-attention-environment-fingerprint-v1\0", "utf8")
      .update(canonicalJson({ entries: entries.toReversed(), target }), "utf8").digest("hex");
    expect(fingerprint).toBe(expected);
    expect(attentionEnvironmentFingerprint(entries.toReversed(), target, intendedKey)).toBe(fingerprint);
    expect(fingerprint).not.toBe(canonicalDigest({ entries: entries.toReversed(), target }));
    expect(attentionEnvironmentFingerprint(entries, target, "re_other_synthetic")).not.toBe(fingerprint);
    expect(attentionEnvironmentFingerprint(entries, { ...target, deploymentId: target.deploymentId + 1 }, intendedKey))
      .not.toBe(fingerprint);
    expect(createHmac("sha256", intendedKey).update(canonicalJson({ entries: entries.toReversed(), target })).digest("hex"))
      .not.toBe(fingerprint);
  });

  test("environment fingerprint excludes only attention and detects names, values and string boundaries", () => {
    const entries = [{ name: "A", value: "bc" }];
    const fingerprint = attentionEnvironmentFingerprint(entries, target, intendedKey);
    for (const value of [intendedKey, "re_other_synthetic"]) {
      expect(attentionEnvironmentFingerprint([...entries, { name: oompaAttentionResendApiKeyEnvironmentName, value }], target, intendedKey))
        .toBe(fingerprint);
    }
    for (const changed of [
      [{ name: "A", value: "changed" }], [{ name: "CHANGED", value: "bc" }],
      [{ name: "Ab", value: "c" }], [...entries, { name: "EXTRA", value: "" }], [],
    ]) expect(attentionEnvironmentFingerprint(changed, target, intendedKey)).not.toBe(fingerprint);
  });

  test("strict arguments and protected JSON expose no secret flags or ambiguous key spellings", async () => {
    const value = await harness();
    expect(parseAttentionKeyInstallationArguments(value.arguments_).phase).toBe("install");
    expect(parseAttentionKeyInstallationInput(inputDocument, target).convexDeploymentAdminKey).toBe(adminKey);
    for (const args of [
      [...value.arguments_, "--key", intendedKey], [...value.arguments_, "--phase", "install"],
      value.arguments_.map((arg) => arg === "install" ? "apply" : arg),
      value.arguments_.map((arg) => arg === value.directory ? `${value.directory}/.` : arg),
    ]) expect(() => parseAttentionKeyInstallationArguments(args)).toThrow();
    for (const document of ["{}", "[]", " ".repeat(8 * 1024 + 1),
      inputDocument.replace(adminKey, "project:scope|key"), inputDocument.replace(adminKey, adminKey.replace("prod:", "dev:")),
      inputDocument.replace("steady-otter-321", "other-otter-321"),
      inputDocument.replace('"convexDeploymentAdminKey"', '"attentionResendApiKey"'),
      inputDocument.replace('"attentionResendApiKey"', '"attentionResendApi\\u004bey"'),
      inputDocument.replace(intendedKey, "invalid"),
    ]) expect(() => parseAttentionKeyInstallationInput(document, target)).toThrow("input_invalid");
  });

  test("writes exactly one fixed-name intent then acknowledges exact readback without activation or secret evidence", async () => {
    const value = await harness();
    const result = await installHostedAttentionKey(value.options);
    expect(result.status).toBe("provider_acknowledged_and_observed_equal");
    expect(result.nonAttentionEnvironmentUnchanged).toBe(true);
    expect(value.state.dispatches).toBe(1);
    expect(value.state.environment.get(oompaResendApiKeyEnvironmentName)).toBe(otpKey);
    for (const request of value.requests) {
      expect(request.stdin).toBe("");
      for (const secret of [intendedKey, adminKey, otpKey]) {
        expect(JSON.stringify([request.arguments, request.environment])).not.toContain(secret);
      }
    }
    for (const name of await readdir(value.directory)) {
      const document = await readFile(join(value.directory, name), "utf8");
      for (const secret of [intendedKey, adminKey, otpKey]) expect(document).not.toContain(secret);
    }
  });

  test.each(["expiry", "future", "head", "dirty", "runtime", "inactive", "prerequisite", "otp", "occupied"])(
    "%s preflight refuses without intent or dispatch", async (failure) => {
      const value = await harness();
      if (failure === "expiry") value.state.now = 800_000;
      if (failure === "future") value.state.now = -1;
      if (failure === "head") value.state.head = "f".repeat(40);
      if (failure === "dirty") value.state.status = " M source.ts\n";
      if (failure === "runtime") value.state.attestation = { ...attestation, deployedAtMs: 3_000 };
      if (failure === "inactive") value.state.inactive.generation = 1;
      if (failure === "prerequisite") value.state.environment.delete("JWT_PRIVATE_KEY");
      if (failure === "otp") value.state.environment.set(oompaResendApiKeyEnvironmentName, intendedKey);
      if (failure === "occupied") value.state.environment.set(oompaAttentionResendApiKeyEnvironmentName, "re_other_synthetic");
      await expect(installHostedAttentionKey(value.options)).rejects.toThrow();
      expect(value.state.dispatches).toBe(0);
      expect((await readdir(value.directory)).includes(attentionKeyInstallSlot(target))).toBe(false);
    },
  );

  test.each(["source", "target", "candidate", "preparation", "key", "directory", "writers"])(
    "custody %s mismatch cannot authorize an install", async (failure) => {
      const value = await harness();
      if (failure === "source") await value.rewriteCustody({ sourceCommit: "e".repeat(40) });
      if (failure === "target") await value.rewriteCustody({ targetDigest: "e".repeat(64) });
      if (failure === "candidate") await value.rewriteCustody({ candidateDeployDigest: "e".repeat(64) });
      if (failure === "preparation") await value.rewriteCustody({ preparationDigest: "e".repeat(64) });
      if (failure === "key") await value.rewriteCustody({ intendedKeyDigest: "e".repeat(64) });
      if (failure === "directory") await value.rewriteCustody({ evidenceDirectory: `${value.directory}/other` });
      if (failure === "writers") await writeFile(value.options.custodyAttestationPath,
        JSON.stringify(withSelfDigest({ ...value.custody, competingWritersQuiesced: { ci: false, cli: true, dashboard: true, delegated: true } })));
      await expect(installHostedAttentionKey(value.options)).rejects.toThrow();
      expect(value.state.dispatches).toBe(0);
    },
  );

  test("non-attention environment drift before intent refuses, after intent remains uncertain with no dispatch", async () => {
    for (const atRead of [2, 3]) {
      const value = await harness();
      value.setReadHook(() => {
        if (value.state.reads === atRead) value.state.environment.set("JWT_PRIVATE_KEY", "changed-private");
      });
      if (atRead === 2) await expect(installHostedAttentionKey(value.options)).rejects.toThrow("prestate_changed");
      else expect((await installHostedAttentionKey(value.options)).status).toBe("dispatch_outcome_unknown");
      expect(value.state.dispatches).toBe(0);
    }
  });

  test("all dispatch failures retain intent and later absence never authorizes a retry", async () => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error(`uncertain ${intendedKey} ${adminKey}`); });
    expect((await installHostedAttentionKey(value.options)).status).toBe("dispatch_outcome_unknown");
    expect(value.state.dispatches).toBe(1);
    expect((await installHostedAttentionKey(value.options)).status).toBe("dispatch_outcome_unknown");
    expect(value.state.dispatches).toBe(1);
    const reconciled = await installHostedAttentionKey({ ...value.options, phase: "reconcile" });
    expect(reconciled.status).toBe("observed_absent");
    expect(value.state.dispatches).toBe(1);
  });

  test("new operation or key cannot bypass the target's fixed intent slot", async () => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error("uncertain"); });
    await installHostedAttentionKey(value.options);
    await value.rewriteCustody({ operationId: "00000000-0000-4000-8000-000000000004" });
    expect((await installHostedAttentionKey(value.options)).status).toBe("dispatch_outcome_unknown");
    expect(value.state.dispatches).toBe(1);
    const intentPath = join(value.directory, attentionKeyInstallSlot(target));
    expect(readProtectedJson(intentPath, attentionKeyInstallIntentSchema).intendedKeyDigest).toBe(value.custody.intendedKeyDigest);
    const otherKey = "re_another_synthetic";
    const otherKeyDigest = createHash("sha256").update("oompa-attention-key-observation-v1\0").update(otherKey).digest("hex");
    const originalPreparation = readProtectedJson(value.options.preparationEvidencePath, hostedAttentionKeyObservationSchema);
    const unsignedPreparation = Object.fromEntries(Object.entries(originalPreparation).filter(([name]) => name !== "selfDigest"));
    const otherPreparation = hostedAttentionKeyObservationSchema.parse(withSelfDigest({ ...unsignedPreparation, intendedKeyDigest: otherKeyDigest }));
    const otherPreparationPath = join(value.directory, "other-key-prepare.json");
    writeProtectedJsonNoReplace(otherPreparationPath, otherPreparation, hostedAttentionKeyObservationSchema);
    await value.rewriteCustody({ intendedKeyDigest: otherKeyDigest, preparationDigest: otherPreparation.selfDigest });
    expect((await installHostedAttentionKey({ ...value.options, preparationEvidencePath: otherPreparationPath,
      inputDocument: JSON.stringify({ attentionResendApiKey: otherKey, convexDeploymentAdminKey: adminKey }),
    })).status).toBe("dispatch_outcome_unknown");
    expect(value.state.dispatches).toBe(1);
  });

  test("interrupted or invalid existing intent is reconciliation-only", async () => {
    for (const name of [attentionKeyInstallSlot(target), `.${attentionKeyInstallSlot(target)}.interrupted.tmp`]) {
      const value = await harness();
      await writeFile(join(value.directory, name), "incomplete", { mode: 0o600 });
      expect((await installHostedAttentionKey(value.options)).status).toBe("dispatch_outcome_unknown");
      expect(value.state.dispatches).toBe(0);
      expect(await readFile(join(value.directory, name), "utf8")).toBe("incomplete");
    }
  });

  test("pre-release intent names and interrupted publications remain preserved and cannot redispatch", async () => {
    const legacy = `attention-key-${"f".repeat(64)}.intent.json`;
    for (const name of [legacy, `.${legacy}.${"a".repeat(32)}.tmp`]) {
      const value = await harness();
      const path = join(value.directory, name);
      await writeFile(path, "preserved pre-release intent", { mode: 0o600 });
      expect((await installHostedAttentionKey(value.options)).status).toBe("dispatch_outcome_unknown");
      expect(value.state.dispatches).toBe(0);
      expect(value.state.reads).toBe(0);
      expect(await readFile(path, "utf8")).toBe("preserved pre-release intent");
    }
  });

  test.each(["dirty", "runtime", "attention", "other-env"])(
    "post-acknowledgement %s verification failure preserves uncertainty", async (failure) => {
      const value = await harness();
      value.setDispatchHook(() => {
        if (failure === "dirty") value.state.status = " M source.ts\n";
        if (failure === "runtime") value.state.attestation = { ...attestation, deployedAtMs: 9_000 };
        if (failure === "other-env") value.state.environment.set("JWT_PRIVATE_KEY", "changed-private");
        if (failure === "attention") value.setReadHook(() => value.state.environment.delete(oompaAttentionResendApiKeyEnvironmentName));
      });
      expect((await installHostedAttentionKey(value.options)).status).toBe("dispatch_outcome_unknown");
      expect(value.state.dispatches).toBe(1);
    },
  );

  test("expiry prevents dispatch but permits read-only settlement of an already acknowledged write", async () => {
    const before = await harness();
    before.setReadHook(() => { if (before.state.reads === 3) before.state.now = 800_000; });
    expect((await installHostedAttentionKey(before.options)).status).toBe("dispatch_outcome_unknown");
    expect(before.state.dispatches).toBe(0);
    const after = await harness();
    after.setDispatchHook(() => { after.state.now = 800_000; });
    expect((await installHostedAttentionKey(after.options)).status).toBe("provider_acknowledged_and_observed_equal");
    expect(after.state.dispatches).toBe(1);
  });

  test.each(["equal", "absent", "conflict", "other-env"])(
    "read-only reconciliation reports %s, accepts expired custody, and never attributes causality", async (state) => {
      const value = await harness();
      value.setDispatchHook(() => { throw new Error("uncertain"); });
      await installHostedAttentionKey(value.options);
      value.state.now = 900_000;
      if (state === "equal") value.state.environment.set(oompaAttentionResendApiKeyEnvironmentName, intendedKey);
      if (state === "conflict") value.state.environment.set(oompaAttentionResendApiKeyEnvironmentName, "re_other_synthetic");
      if (state === "other-env") value.state.environment.set("JWT_PRIVATE_KEY", "changed-private");
      const result = await installHostedAttentionKey({ ...value.options, phase: "reconcile" });
      expect(result.status).toBe(state === "equal" ? "observed_equal" : state === "absent" ? "observed_absent" : "observed_conflict");
      expect(value.state.dispatches).toBe(1);
    },
  );

  test("repeated reconciliation appends fresh evidence as observed state changes", async () => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error("uncertain"); });
    await installHostedAttentionKey(value.options);
    expect((await installHostedAttentionKey({ ...value.options, phase: "reconcile" })).status).toBe("observed_absent");
    value.state.environment.set(oompaAttentionResendApiKeyEnvironmentName, intendedKey);
    expect((await installHostedAttentionKey({ ...value.options, phase: "reconcile" })).status).toBe("observed_equal");
    expect((await installHostedAttentionKey({ ...value.options, phase: "reconcile" })).status).toBe("observed_equal");
    expect((await readdir(value.directory)).filter((name) => name.includes(".reconcile.")).length).toBe(3);
    expect(value.state.dispatches).toBe(1);
  });

  test("administrative credential rotation preserves the original environment comparison", async () => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error("uncertain"); });
    await installHostedAttentionKey(value.options);
    value.state.environment.set(oompaAttentionResendApiKeyEnvironmentName, intendedKey);
    const input = JSON.stringify({ attentionResendApiKey: intendedKey,
      convexDeploymentAdminKey: `prod:${target.deploymentName}|${"rotated_admin_".repeat(3)}` });
    expect((await installHostedAttentionKey({ ...value.options, inputDocument: input, phase: "reconcile" })).status)
      .toBe("observed_equal");
    value.state.environment.set("JWT_PRIVATE_KEY", "changed-private");
    expect((await installHostedAttentionKey({ ...value.options, inputDocument: input, phase: "reconcile" })).status)
      .toBe("observed_conflict");
    expect(value.state.dispatches).toBe(1);
  });

  test.each(["reconcile", "result"])("exhausted %s evidence preserves every slot and cannot redispatch", async (stage) => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error("uncertain"); });
    await installHostedAttentionKey(value.options);
    const prefix = `${attentionKeyInstallSlot(target)}.${value.custody.operationId}.${stage}.`;
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      await writeFile(join(value.directory, `${prefix}${sequence}.json`), "retained evidence", { mode: 0o600 });
    }
    expect((await installHostedAttentionKey({ ...value.options, phase: "reconcile" })).status).toBe("dispatch_outcome_unknown");
    expect(value.state.dispatches).toBe(1);
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      expect(await readFile(join(value.directory, `${prefix}${sequence}.json`), "utf8")).toBe("retained evidence");
    }
  });

  test("an interrupted observation slot is preserved while reconciliation uses the next slot", async () => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error("uncertain"); });
    await installHostedAttentionKey(value.options);
    const prefix = `${attentionKeyInstallSlot(target)}.${value.custody.operationId}.reconcile.`;
    const interrupted = join(value.directory, `.${prefix}1.json.${"f".repeat(32)}.tmp`);
    await writeFile(interrupted, "retained interrupted evidence", { mode: 0o600 });
    expect((await installHostedAttentionKey({ ...value.options, phase: "reconcile" })).status).toBe("observed_absent");
    expect(await readFile(interrupted, "utf8")).toBe("retained interrupted evidence");
    expect((await readdir(value.directory)).includes(`${prefix}2.json`)).toBe(true);
    expect(value.state.dispatches).toBe(1);
  });

  test("read-only reconciliation completes exact interrupted hard-link publication without retrying the provider", async () => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error("uncertain"); });
    await installHostedAttentionKey(value.options);
    const slot = attentionKeyInstallSlot(target);
    const intentPath = join(value.directory, slot);
    const temporaryPath = join(value.directory, `.${slot}.${"f".repeat(32)}.tmp`);
    await link(intentPath, temporaryPath);
    expect((await stat(intentPath)).nlink).toBe(2);
    expect((await installHostedAttentionKey({ ...value.options, phase: "reconcile" })).status).toBe("observed_absent");
    expect((await stat(intentPath)).nlink).toBe(1);
    expect(value.state.dispatches).toBe(1);
  });

  test("unrelated custody cannot reconcile an existing intent", async () => {
    const value = await harness();
    value.setDispatchHook(() => { throw new Error("uncertain"); });
    await installHostedAttentionKey(value.options);
    await value.rewriteCustody({ operationId: "00000000-0000-4000-8000-000000000004" });
    expect((await installHostedAttentionKey({ ...value.options, phase: "reconcile" })).status).toBe("dispatch_outcome_unknown");
    expect(value.state.dispatches).toBe(1);
  });

  test("provider snapshot is fenced by fresh numeric target verification on both sides", async () => {
    for (const afterRead of [false, true]) {
      const value = await harness();
      let drift = !afterRead;
      value.setReadHook(() => { drift = true; });
      await expect(installHostedAttentionKey({ ...value.options, observation: {
        ...value.options.observation, verifyTarget: async () => { if (drift) throw new Error("target changed"); },
      } })).rejects.toThrow("preflight_failed");
      expect(value.state.reads).toBe(afterRead ? 1 : 0);
      expect(value.state.dispatches).toBe(0);
    }
  });

  test("typed process-custody failures preserve recovery paths and prohibit dispatch", async () => {
    const value = await harness();
    const failure = new BoundedProcessCleanupUnprovenError(42_432, "hosted-attention-key-inactive-read");
    value.setRequestHook(() => { throw failure; });
    await expect(installHostedAttentionKey(value.options)).rejects.toBe(failure);
    expect(failure.recoveryPaths).toContain(value.options.evidenceDirectory);
    expect(failure.recoveryPaths).toContain(value.options.custodyAttestationPath);
    expect(value.state.dispatches).toBe(0);
  });

  test("safe CLI suppresses raw transport failures after intent", async () => {
    const value = await harness();
    const chunks: string[] = [];
    const writer = { write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")); return true;
    } };
    value.setDispatchHook(() => { throw new Error(`${adminKey} ${intendedKey}`); });
    expect(await executeAttentionKeyInstallation({ ...value.options, arguments: value.arguments_, stdout: writer, stderr: writer })).toBe(1);
    expect(chunks.join("")).toContain("dispatch_outcome_unknown");
    expect(chunks.join("")).not.toContain(adminKey);
    expect(chunks.join("")).not.toContain(intendedKey);
  });
});
