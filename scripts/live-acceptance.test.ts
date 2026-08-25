import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type { CommandResponse, LocalCommand } from "../src/domain/contracts";
import { readDaemonAuthorityReceipt } from "../src/daemon/daemon-lock";
import { DEFAULT_CLOUD_DEPLOYMENT_URL } from "../src/cloud/identity-custody";
import { resolveStatePaths } from "../src/storage/paths";
import {
  acceptanceInstallationDescriptorSchema,
  createAcceptanceInstallation,
  type AcceptanceInstallationDescriptor,
} from "./live-acceptance-installation";
import {
  assertAcceptanceDescriptorLayout,
  createLiveAcceptanceLayout,
  LIVE_ACCEPTANCE_CONTROL_FD,
  LIVE_ACCEPTANCE_WORKER_STDIO,
  liveAcceptanceRecoveryReceiptSchema,
  liveAcceptanceSourceAttestation,
  liveAcceptanceWorkerControlSchema,
  liveAcceptanceWorkerStatusSchema,
  liveAcceptanceWorkerLaunch,
  LiveAcceptanceStartError,
  openLiveRuntimeAttestationBoundary,
  parseLiveAcceptanceEvidenceOutput,
  readLiveRuntimeAttestation,
  resumeLiveAcceptanceCleanup,
  sourceGitOutput,
  startLiveAcceptanceRun,
  type LiveAcceptanceDeviceName,
  type LiveAcceptanceWorker,
} from "./live-acceptance";
import {
  canonicalDigest,
  deployEvidenceSchema,
  withSelfDigest,
  type DeployEvidence,
  type RuntimeReleaseAttestation,
} from "./release-evidence";
import {
  HRA_CONVEX_PROJECT_ID,
  HRA_CONVEX_TEAM_ID,
} from "./convex-target";

const deadPidBase = 900_000;
const releaseSourceCommit = "a".repeat(40);
const releaseRuntimeAttestation: RuntimeReleaseAttestation = {
  bound: true,
  deployedAtMs: 1_000,
  previousDeployDigest: null,
  runtimeRevision: "00000000-0000-4000-8000-000000000010",
  runtimeSourceCommit: releaseSourceCommit,
  schemaIdentity: "hra-release-attestation-v1",
  schemaVersion: 1,
};
const releaseDeployEvidence: DeployEvidence = deployEvidenceSchema.parse(withSelfDigest({
  after: releaseRuntimeAttestation,
  before: null,
  kind: "convex-deploy" as const,
  overlaySha256: "b".repeat(64),
  phase: "bootstrap" as const,
  previousDeployDigest: null,
  schemaVersion: 1 as const,
  sourceCommit: releaseSourceCommit,
  target: {
    deploymentId: 5_089_017,
    deploymentName: "qualified-hummingbird-537",
    deploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
    projectId: HRA_CONVEX_PROJECT_ID,
    teamId: HRA_CONVEX_TEAM_ID,
  },
  targetDigest: canonicalDigest({
    deploymentId: 5_089_017,
    deploymentName: "qualified-hummingbird-537",
    deploymentUrl: DEFAULT_CLOUD_DEPLOYMENT_URL,
    projectId: HRA_CONVEX_PROJECT_ID,
    teamId: HRA_CONVEX_TEAM_ID,
  }),
}));

async function privateTestBase(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "hra-live-acceptance-test-"));
  await chmod(root, 0o700);
  return await realpath(root);
}

async function removeOwnedTestBase(root: string): Promise<void> {
  const canonical = await realpath(root).catch(() => null);
  if (canonical !== null && canonical === root && root.includes("hra-live-acceptance-test-")) {
    await rm(root, { force: false, recursive: true });
  }
}

const response = (data: unknown): CommandResponse => ({
  data,
  ok: true,
  requestId: randomUUID(),
  version: 1,
});

type FakeBehavior = Readonly<{
  accountInitialState?: "recovery_required" | "signed_in";
  ambiguousLogout?: boolean;
  authStatusGate?: () => Promise<void>;
  derivePeerFromDeviceB?: boolean;
  extraLivePeer?: boolean;
  extraRevokedPeer?: boolean;
  failDeletion?: boolean;
  failRevocation?: boolean;
  noCloudIdentity?: boolean;
  omitPeer?: boolean;
  peerStatus?: "active" | "pending" | "revoked";
}>;

class FakeWorker implements LiveAcceptanceWorker {
  readonly commands: LocalCommand[] = [];
  readonly device: LiveAcceptanceDeviceName;
  readonly pid: number;
  readonly projectDirectory: string;
  readonly rootDirectory: string;
  preserved = false;
  stopped = false;
  #accountState: "recovery_required" | "signed_in" | "signed_out";
  #cloudDeleted = false;
  #peerStatus: "active" | "pending" | "revoked";
  readonly #behavior: FakeBehavior;

  constructor(
    descriptor: AcceptanceInstallationDescriptor,
    index: number,
    behavior: FakeBehavior,
  ) {
    this.device = descriptor.device;
    this.pid = deadPidBase + index;
    this.projectDirectory = descriptor.documentsDirectory;
    this.rootDirectory = descriptor.rootDirectory;
    this.#behavior = behavior;
    this.#accountState = behavior.accountInitialState ?? "signed_in";
    this.#peerStatus = behavior.peerStatus ?? "revoked";
  }

  async command(command: LocalCommand): Promise<CommandResponse> {
    this.commands.push(command);
    if (command.kind === "device.list") {
      return response({
        currentDevicePublicId: "device_current",
        devices: [
          { current: true, publicId: "device_current", status: "active" },
          ...(this.#behavior.omitPeer === true
            ? []
            : [{ current: false, publicId: "device_revoked", status: this.#peerStatus }]),
          ...(this.#behavior.extraLivePeer === true
            ? [{ current: false, publicId: "device_unexpected", status: "pending" }]
            : []),
          ...(this.#behavior.extraRevokedPeer === true
            ? [{ current: false, publicId: "device_old_revoked", status: "revoked" }]
            : []),
        ],
      });
    }
    if (command.kind === "device.revoke") {
      if (command.device !== "device_revoked") throw new Error("unexpected revoke target");
      if (this.#behavior.failRevocation === true) {
        return {
          error: { code: "UNAVAILABLE", message: "synthetic revocation failure" },
          ok: false,
          requestId: randomUUID(),
          version: 1,
        };
      }
      this.#peerStatus = "revoked";
      return response({ device: { publicId: "device_revoked", status: "revoked" } });
    }
    if (command.kind === "auth.delete") {
      if (this.#behavior.failDeletion === true) {
        return {
          error: { code: "UNAVAILABLE", message: "synthetic failure" },
          ok: false,
          requestId: randomUUID(),
          version: 1,
        };
      }
      this.#cloudDeleted = true;
      return response({
        deletion: {
          effectsDisabled: true,
          state: "complete",
          statusFresh: true,
        },
      });
    }
    if (command.kind === "auth.status") {
      await this.#behavior.authStatusGate?.();
      if (this.#behavior.noCloudIdentity === true && !this.#cloudDeleted) {
        return response({ configured: true, device: null, signedIn: false });
      }
      if (!this.#cloudDeleted) {
        if (this.device === "b" && this.#behavior.derivePeerFromDeviceB !== true) {
          return response({ configured: true, device: null, signedIn: false });
        }
        return response({
          configured: true,
          device: this.device === "a"
            ? { publicId: "device_current", status: "active" }
            : { publicId: "device_revoked", status: this.#peerStatus },
          email: "acceptance@example.test",
          signedIn: true,
        });
      }
      return response({
        configured: true,
        deletion: {
          effectsDisabled: true,
          state: "complete",
          statusFresh: true,
        },
        signedIn: false,
      });
    }
    if (command.kind === "account.list") {
      if (this.#behavior.ambiguousLogout !== true) return response({ accounts: [] });
      return response({
        accounts: [{
          id: "account_ambiguous",
          state: this.#accountState,
        }],
      });
    }
    if (command.kind === "account.logout" && this.#behavior.ambiguousLogout === true) {
      this.#accountState = "recovery_required";
      return {
        error: { code: "UNAVAILABLE", message: "synthetic lost logout response" },
        ok: false,
        requestId: randomUUID(),
        version: 1,
      };
    }
    if (command.kind === "account.show" && this.#behavior.ambiguousLogout === true) {
      this.#accountState = "signed_out";
      return response({
        account: { id: "account_ambiguous", state: "signed_out" },
        recovery: { cleared: true, required: false, resolution: "proven_applied" },
      });
    }
    return response({ accepted: true });
  }

  async preserve(): Promise<void> {
    this.preserved = true;
    this.stopped = true;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  execute(): Promise<{ exitCode: number; stderr: string; stdout: string }> {
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: "{}\n" });
  }

  failure(): Promise<never> {
    return new Promise<never>(() => undefined);
  }

  lifetime(): Promise<void> {
    return Promise.resolve();
  }

  resume(): Promise<void> {
    this.stopped = false;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  suspend(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }
}

const fakeFactory = (
  workers: FakeWorker[],
  behavior: FakeBehavior = {},
): ((descriptor: AcceptanceInstallationDescriptor) => Promise<LiveAcceptanceWorker>) =>
  async (descriptor) => {
    const worker = new FakeWorker(descriptor, workers.length + 1, behavior);
    workers.push(worker);
    return worker;
  };

const fakeShutdownVerifier = async (worker: LiveAcceptanceWorker): Promise<void> => {
  expect((worker as FakeWorker).stopped).toBe(true);
};

describe("source-only live acceptance isolation", () => {
  test("ignores a hostile PATH when reading release source authority", async () => {
    const root = await privateTestBase();
    const hostileGit = join(root, "git");
    const sentinel = join(root, "ambient-git-ran");
    await writeFile(
      hostileGit,
      `#!/bin/sh\nprintf hostile > ${JSON.stringify(sentinel)}\nprintf '%s\\n' ${JSON.stringify("c".repeat(40))}\n`,
      { mode: 0o755 },
    );
    await chmod(hostileGit, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = root;
    try {
      expect(await sourceGitOutput(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "live-source-hostile-path",
      )).toMatch(/^[0-9a-f]{40}\n$/u);
      expect(await Bun.file(sentinel).exists()).toBeFalse();
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await removeOwnedTestBase(root);
    }
  });

  test("serializes source revision and status reads through local subprocess custody", async () => {
    const calls: string[] = [];
    let active = 0;
    let peak = 0;
    const sourceRevision = "b".repeat(40);
    const attestation = await liveAcceptanceSourceAttestation(
      DEFAULT_CLOUD_DEPLOYMENT_URL,
      async (arguments_, phase) => {
        calls.push(`${phase}:${arguments_.join(" ")}`);
        active += 1;
        peak = Math.max(peak, active);
        try {
          await Bun.sleep(5);
          return arguments_[0] === "rev-parse" ? `${sourceRevision}\n` : "";
        } finally {
          active -= 1;
        }
      },
    );

    expect(peak).toBe(1);
    expect(calls).toEqual([
      "live-source-revision:rev-parse --verify HEAD^{commit}",
      "live-source-status:status --porcelain=v1 --untracked-files=all",
    ]);
    expect(attestation.sourceRevision).toBe(sourceRevision);
  });

  test("rejects both unbounded event-stream aliases at the worker boundary", () => {
    const control = {
      argv: ["session", "events", "session-id"],
      requestId: randomUUID(),
      type: "cli" as const,
      version: 1 as const,
    };
    expect(liveAcceptanceWorkerControlSchema.safeParse({
      ...control,
      argv: [...control.argv, "--follow"],
    }).success).toBeFalse();
    expect(liveAcceptanceWorkerControlSchema.safeParse({
      ...control,
      argv: [...control.argv, "--jsonl"],
    }).success).toBeFalse();
    expect(liveAcceptanceWorkerControlSchema.safeParse(control).success).toBeTrue();
  });

  test("pins exact runtime authority before and after acceptance", async () => {
    const reads: string[] = [];
    const boundary = await openLiveRuntimeAttestationBoundary(
      releaseDeployEvidence,
      async (deploymentUrl) => {
        reads.push(deploymentUrl);
        return releaseRuntimeAttestation;
      },
    );
    expect(boundary.attestation).toEqual(releaseDeployEvidence.after);
    expect(await boundary.close()).toEqual(releaseDeployEvidence.after);
    expect(reads).toEqual([
      DEFAULT_CLOUD_DEPLOYMENT_URL,
      DEFAULT_CLOUD_DEPLOYMENT_URL,
    ]);
    await expect(boundary.close()).rejects.toThrow("input_invalid");
  });

  test("places both runtime probes around the live run and before durable evidence", async () => {
    const source = await readFile(join(import.meta.dir, "live-acceptance.ts"), "utf8");
    const main = source.slice(source.indexOf("export const liveAcceptanceMain"));
    const open = main.indexOf("openLiveRuntimeAttestationBoundary(");
    const start = main.indexOf("startLiveAcceptanceRun({");
    const firstClose = main.indexOf("runtimeBoundary?.close()", start);
    const firstPersist = main.indexOf("persistLiveAcceptanceEvidence(", firstClose);
    const secondClose = main.indexOf("runtimeBoundary?.close()", firstClose + 1);
    const secondPersist = main.indexOf("persistLiveAcceptanceEvidence(", secondClose);
    expect(open).toBeGreaterThan(-1);
    expect(open).toBeLessThan(start);
    expect(firstClose).toBeGreaterThan(start);
    expect(firstClose).toBeLessThan(firstPersist);
    expect(secondClose).toBeGreaterThan(firstPersist);
    expect(secondClose).toBeLessThan(secondPersist);
    expect(source).toContain("runtimeRevision: runtimeAttestation.runtimeRevision");
  });

  test("refuses runtime replacement and a wrong-before then restored-after attack", async () => {
    const replacement = {
      ...releaseRuntimeAttestation,
      runtimeRevision: "00000000-0000-4000-8000-000000000099",
    } satisfies RuntimeReleaseAttestation;
    const replacementReads = [releaseRuntimeAttestation, replacement];
    const replacementBoundary = await openLiveRuntimeAttestationBoundary(
      releaseDeployEvidence,
      async () => replacementReads.shift() ?? replacement,
    );
    await expect(replacementBoundary.close()).rejects.toThrow("input_invalid");

    let restoreReads = 0;
    await expect(openLiveRuntimeAttestationBoundary(
      releaseDeployEvidence,
      async () => {
        restoreReads += 1;
        return restoreReads === 1 ? replacement : releaseRuntimeAttestation;
      },
    )).rejects.toThrow("input_invalid");
    expect(restoreReads).toBe(1);
  });

  test("aborts a stalled runtime authority transport", async () => {
    let authoritySignal: AbortSignal | undefined;
    const authorityFetch = Object.assign((
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      authoritySignal = init?.signal ?? undefined;
      return new Promise(() => undefined);
    }, { preconnect: () => undefined }) as typeof fetch;

    const startedAt = performance.now();
    await expect(readLiveRuntimeAttestation(DEFAULT_CLOUD_DEPLOYMENT_URL, {
      fetcher: authorityFetch,
      timeoutMs: 10,
    })).rejects.toThrow("input_invalid");
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(authoritySignal?.aborted).toBeTrue();
  });

  test("accepts one protected evidence path or descriptor without changing scenario arguments", () => {
    expect(parseLiveAcceptanceEvidenceOutput([
      "--scenario-fd",
      "3",
      "--evidence-path",
      "/private/operator/candidate-live.json",
      "--deploy-evidence",
      "/private/operator/candidate-deploy.json",
    ])).toEqual({
      evidenceOutput: { kind: "path", path: "/private/operator/candidate-live.json" },
      deployEvidencePath: "/private/operator/candidate-deploy.json",
      scenarioArguments: ["--scenario-fd", "3"],
    });
    expect(parseLiveAcceptanceEvidenceOutput([
      "--evidence-fd",
      "4",
      "--deploy-evidence",
      "/private/operator/candidate-deploy.json",
      "--scenario-stdin",
    ])).toEqual({
      evidenceOutput: { descriptor: 4, kind: "descriptor" },
      deployEvidencePath: "/private/operator/candidate-deploy.json",
      scenarioArguments: ["--scenario-stdin"],
    });
    expect(() => parseLiveAcceptanceEvidenceOutput([
      "--scenario-stdin",
      "--evidence-fd",
      "2",
      "--deploy-evidence",
      "/private/operator/candidate-deploy.json",
    ])).toThrow();
    expect(() => parseLiveAcceptanceEvidenceOutput([
      "--scenario-stdin",
      "--evidence-path",
      "/one.json",
      "--evidence-fd",
      "4",
      "--deploy-evidence",
      "/private/operator/candidate-deploy.json",
    ])).toThrow();
  });

  test("creates two canonical private installations without changing HOME", async () => {
    const base = await privateTestBase();
    const originalHomeDirectory = process.env.HOME;
    let runRoot: string | undefined;
    try {
      const layout = await createLiveAcceptanceLayout({ temporaryBaseDirectory: base });
      runRoot = layout.runRoot.path;
      expect(process.env.HOME).toBe(originalHomeDirectory);
      expect(layout.descriptors.a.rootDirectory).not.toBe(layout.descriptors.b.rootDirectory);
      expect(layout.descriptors.a.documentsDirectory).not.toBe(layout.descriptors.b.documentsDirectory);
      expect(dirname(layout.descriptors.a.rootDirectory)).toBe(layout.runRoot.path);
      expect(dirname(layout.descriptors.b.rootDirectory)).toBe(layout.runRoot.path);
      for (const resource of layout.resources) {
        const metadata = await lstat(resource.identity.path);
        expect(metadata.isDirectory()).toBe(true);
        expect(metadata.isSymbolicLink()).toBe(false);
        expect(metadata.mode & 0o777).toBe(0o700);
        expect(await realpath(resource.identity.path)).toBe(resource.identity.path);
      }

      const installationA = createAcceptanceInstallation(layout.descriptors.a);
      const installationB = createAcceptanceInstallation(layout.descriptors.b);
      expect(installationA.kind).toBe("live_acceptance");
      expect(installationA.cloudEnvironment).toEqual({ HRA_CONVEX_URL: "" });
      expect(installationA.desktopSwitching).toBe(false);
      expect(installationA.credentialStorePreflight).toEqual({
        cliAuth: "file",
        cwd: layout.descriptors.a.documentsDirectory,
        mcpOauth: "file",
      });

      const codexHomeA = join(layout.descriptors.a.rootDirectory, "profiles", "acceptance-a", "codex-home");
      const codexHomeB = join(layout.descriptors.b.rootDirectory, "profiles", "acceptance-b", "codex-home");
      await Promise.all([
        installationA.prepareCodexHome(codexHomeA),
        installationB.prepareCodexHome(codexHomeB),
      ]);
      const [environmentA, environmentB] = await Promise.all([
        installationA.codexEnvironment(codexHomeA),
        installationB.codexEnvironment(codexHomeB),
      ]);
      expect(environmentA?.HOME).toBe(originalHomeDirectory);
      expect(environmentB?.HOME).toBe(originalHomeDirectory);
      expect(environmentA?.TMPDIR).toBe(join(codexHomeA, "tmp"));
      expect(environmentB?.TMPDIR).toBe(join(codexHomeB, "tmp"));
      expect(environmentA?.TMPDIR).not.toBe(environmentB?.TMPDIR);
      expect(await readFile(join(codexHomeA, "config.toml"), "utf8")).toBe([
        'cli_auth_credentials_store = "file"',
        'mcp_oauth_credentials_store = "file"',
        "",
      ].join("\n"));
      await installationA.prepareCodexHome(codexHomeA);
      await chmod(join(codexHomeA, "config.toml"), 0o644);
      await expect(installationA.prepareCodexHome(codexHomeA))
        .rejects.toThrow("unsafe credential-store configuration");
      await chmod(join(codexHomeA, "config.toml"), 0o600);

      const custody = installationA.createSecretCustody();
      expect(await custody.compareAndSwap("acceptance-test", null, "private-value"))
        .toMatchObject({ generation: 0, value: "private-value" });
      const secretDirectory = await lstat(join(layout.descriptors.a.rootDirectory, "secret-values"));
      expect(secretDirectory.isDirectory()).toBe(true);
      expect(secretDirectory.mode & 0o777).toBe(0o700);
      expect(process.env.HOME).toBe(originalHomeDirectory);
    } finally {
      if (runRoot !== undefined) await rm(runRoot, { force: false, recursive: true }).catch(() => undefined);
      await removeOwnedTestBase(base);
    }
  });

  test("prepares many private credential homes concurrently", async () => {
    const base = await privateTestBase();
    let runRoot: string | undefined;
    try {
      const layout = await createLiveAcceptanceLayout({ temporaryBaseDirectory: base });
      runRoot = layout.runRoot.path;
      const installation = createAcceptanceInstallation(layout.descriptors.a);
      const codexHomes = Array.from({ length: 64 }, (_, index) => join(
        layout.descriptors.a.rootDirectory,
        "profiles",
        `concurrent-${index}`,
        "codex-home",
      ));

      await Promise.all(codexHomes.map(async (codexHome) => {
        await installation.prepareCodexHome(codexHome);
      }));

      await Promise.all(codexHomes.map(async (codexHome) => {
        const configPath = join(codexHome, "config.toml");
        const [metadata, contents] = await Promise.all([
          lstat(configPath),
          readFile(configPath, "utf8"),
        ]);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.isSymbolicLink()).toBe(false);
        expect(metadata.mode & 0o777).toBe(0o600);
        expect(contents).toBe([
          'cli_auth_credentials_store = "file"',
          'mcp_oauth_credentials_store = "file"',
          "",
        ].join("\n"));
      }));
    } finally {
      if (runRoot !== undefined) await rm(runRoot, { force: false, recursive: true }).catch(() => undefined);
      await removeOwnedTestBase(base);
    }
  });

  test("keeps state, sockets, and capabilities out of worker argv and environment", async () => {
    const base = await privateTestBase();
    let runRoot: string | undefined;
    try {
      const layout = await createLiveAcceptanceLayout({ temporaryBaseDirectory: base });
      runRoot = layout.runRoot.path;
      const launch = liveAcceptanceWorkerLaunch(layout.descriptors.a);
      expect(launch.arguments).toHaveLength(1);
      expect(launch.arguments[0].endsWith("/scripts/live-acceptance-worker.ts")).toBe(true);
      expect(LIVE_ACCEPTANCE_WORKER_STDIO).toEqual(["pipe", "pipe", "ignore"]);
      const serializedLaunch = JSON.stringify({
        arguments: launch.arguments,
        environment: launch.environment,
      });
      expect(serializedLaunch).not.toContain(layout.descriptors.a.rootDirectory);
      expect(serializedLaunch).not.toContain(layout.descriptors.a.documentsDirectory);
      expect(serializedLaunch).not.toContain(layout.runId);
      expect(launch.environment.HOME).toBe(process.env.HOME);
      expect(launch.environment.HRA_CONVEX_URL).toBeUndefined();
      expect(Object.keys(launch.environment).some((key) =>
        /ROOT|SOCKET|CAPABILITY|CODEX_HOME/u.test(key))).toBe(false);
    } finally {
      if (runRoot !== undefined) await rm(runRoot, { force: false, recursive: true }).catch(() => undefined);
      await removeOwnedTestBase(base);
    }
  });

  test("carries descriptor and fatal controls on stdin with status only on stdout", async () => {
    const base = await privateTestBase();
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed: Promise<Readonly<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>> | undefined;
    let runRoot: string | undefined;
    try {
      const layout = await createLiveAcceptanceLayout({ temporaryBaseDirectory: base });
      runRoot = layout.runRoot.path;
      const descriptor = layout.descriptors.a;
      const launch = liveAcceptanceWorkerLaunch(descriptor);
      child = spawn(launch.executable, [...launch.arguments], {
        cwd: launch.cwd,
        env: launch.environment,
        stdio: [...LIVE_ACCEPTANCE_WORKER_STDIO],
      });
      childClosed = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
        (resolvePromise) => child!.once("close", (code, signal) => {
          resolvePromise({ code, signal });
        }),
      );
      expect(child.stdio).toHaveLength(3);
      expect(child.stdin).not.toBeNull();
      expect(child.stdout).not.toBeNull();
      expect(child.stderr).toBeNull();
      const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();

      child.stdin!.write(`${JSON.stringify(descriptor)}\n`);
      const readyLine = await lines.next();
      expect(readyLine.done).toBe(false);
      expect(liveAcceptanceWorkerStatusSchema.parse(
        JSON.parse(readyLine.value!) as unknown,
      )).toMatchObject({
        device: descriptor.device,
        runId: descriptor.runId,
        type: "ready",
      });

      child.stdin!.write("{}\n");
      const failedLine = await lines.next();
      expect(failedLine.done).toBe(false);
      expect(liveAcceptanceWorkerStatusSchema.parse(
        JSON.parse(failedLine.value!) as unknown,
      )).toEqual({
        code: "control_invalid",
        device: descriptor.device,
        runId: descriptor.runId,
        type: "failed",
        version: 1,
      });
      expect(await lines.next()).toMatchObject({ done: true });
      expect(await childClosed).toEqual({ code: 1, signal: null });
      child = undefined;
      childClosed = undefined;
    } finally {
      if (child !== undefined) {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.kill("SIGTERM");
        await childClosed?.catch(() => undefined);
      }
      if (runRoot !== undefined) await rm(runRoot, { force: false, recursive: true }).catch(() => undefined);
      await removeOwnedTestBase(base);
    }
  }, 60_000);

  test("starts and cleanly joins two full daemon subprocesses with HOME unchanged", async () => {
    const base = await privateTestBase();
    const originalHomeDirectory = process.env.HOME;
    let run: Awaited<ReturnType<typeof startLiveAcceptanceRun>> | undefined;
    try {
      run = await startLiveAcceptanceRun({
        cloudDeploymentUrl: "http://127.0.0.1:9",
        temporaryBaseDirectory: base,
      });
      expect(process.env.HOME).toBe(originalHomeDirectory);
      const runRoots = (await readdir(base, { withFileTypes: true }))
        .filter((entry) =>
          entry.isDirectory()
          && entry.name.startsWith(`hra-live-acceptance-${run!.runId}-`))
        .map((entry) => join(base, entry.name));
      expect(runRoots).toHaveLength(1);
      const runRoot = runRoots[0]!;
      const stateRoots = (await readdir(runRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("device-"))
        .map((entry) => join(runRoot, entry.name))
        .sort();
      expect(stateRoots).toHaveLength(2);
      expect(resolveStatePaths({ rootDirectory: stateRoots[0]! }).database)
        .not.toBe(resolveStatePaths({ rootDirectory: stateRoots[1]! }).database);

      const deviceA = run.device("a");
      const listed = await deviceA.execute(["project", "list", "--json"]);
      expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(listed.stdout)).toMatchObject({
        command: "project.list",
        data: {
          projects: [{
            default: true,
            label: "Documents",
            rootPath: deviceA.projectDirectory,
          }],
        },
        ok: true,
      });
      const duplicate = await deviceA.execute([
        "project",
        "add",
        "--path",
        deviceA.projectDirectory,
        "--name",
        "Acceptance",
        "--json",
      ]);
      expect(duplicate).toMatchObject({ exitCode: 1, stderr: "" });
      expect(JSON.parse(duplicate.stdout)).toMatchObject({
        error: { code: "CONFLICT" },
        ok: false,
      });
      const protectedRefusal = await deviceA.execute([
        "auth",
        "login",
        "--input-fd",
        String(LIVE_ACCEPTANCE_CONTROL_FD),
        "--json",
      ], { protectedDocument: { email: "not-an-email" } });
      expect(protectedRefusal).toMatchObject({ exitCode: 2, stderr: "" });
      expect(JSON.parse(protectedRefusal.stdout)).toMatchObject({
        error: { code: "INVALID_INPUT" },
        ok: false,
      });

      await run.device("b").suspend();
      await run.device("b").resume();
      expect((await run.device("b").execute(["project", "list", "--json"])).exitCode)
        .toBe(0);

      await run.preserveForRecovery();
      run = undefined;
      expect(process.env.HOME).toBe(originalHomeDirectory);
      for (const stateRoot of stateRoots) {
        const paths = resolveStatePaths({ rootDirectory: stateRoot });
        const daemonReceipt = await readDaemonAuthorityReceipt(paths);
        expect(daemonReceipt?.state).toBe("stopped");
        expect(await lstat(paths.socket).then(() => true).catch(() => false)).toBe(false);
        expect(await lstat(paths.capability).then(() => true).catch(() => false)).toBe(false);
      }
    } finally {
      await run?.preserveForRecovery().catch(() => undefined);
      await removeOwnedTestBase(base);
    }
  }, 60_000);

  test("returns protected recovery coordinates when one worker cannot start", async () => {
    const base = await privateTestBase();
    const workers: FakeWorker[] = [];
    try {
      const error = await startLiveAcceptanceRun({
        temporaryBaseDirectory: base,
        workerFactory: async (descriptor) => {
          if (descriptor.device === "b") throw new Error("synthetic startup failure");
          const worker = new FakeWorker(descriptor, 1, {});
          workers.push(worker);
          return worker;
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LiveAcceptanceStartError);
      const startError = error as LiveAcceptanceStartError;
      expect(startError.code).toBe("worker_failed");
      expect(startError.recoveryReceiptPath).toBe(
        join(base, `.hra-live-acceptance-${startError.runId}.recovery.json`),
      );
      expect((await lstat(startError.recoveryReceiptPath)).mode & 0o777).toBe(0o600);
      expect(workers).toHaveLength(1);
      expect(workers[0]!.preserved).toBe(true);
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("rejects descriptor extension and a substituted symlink before worker startup", async () => {
    const base = await privateTestBase();
    let runRoot: string | undefined;
    try {
      const layout = await createLiveAcceptanceLayout({ temporaryBaseDirectory: base });
      runRoot = layout.runRoot.path;
      expect(acceptanceInstallationDescriptorSchema.safeParse({
        ...layout.descriptors.a,
        socket: "/tmp/attacker.sock",
      }).success).toBe(false);

      const original = layout.descriptors.a.rootDirectory;
      const quarantine = `${original}.test-quarantine`;
      await rename(original, quarantine);
      await symlink(layout.descriptors.a.documentsDirectory, original);
      await expect(assertAcceptanceDescriptorLayout(layout.descriptors.a))
        .rejects.toThrow("layout_changed");
      await rm(original, { force: false });
      await rename(quarantine, original);
    } finally {
      if (runRoot !== undefined) await rm(runRoot, { force: false, recursive: true }).catch(() => undefined);
      await removeOwnedTestBase(base);
    }
  });

  test("proves release cleanup gates before quarantining and deleting both roots", async () => {
    const base = await privateTestBase();
    const workers: FakeWorker[] = [];
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(workers),
      });
      expect(workers.map((worker) => worker.device).sort()).toEqual(["a", "b"]);
      const runRoot = dirname(workers[0]!.rootDirectory);
      await run.bindExpectedRevokedPeer("device_revoked");
      await run.cleanup({ cloudDeletionDeadlineMs: 1_000, cloudDeletionPollMs: 1 });
      expect(workers.every((worker) => worker.stopped)).toBe(true);
      expect(workers[0]!.commands.map((command) => command.kind)).toEqual([
        "auth.status",
        "device.list",
        "auth.delete",
        "auth.status",
        "account.list",
        "account.list",
      ]);
      expect(workers[1]!.commands.map((command) => command.kind)).toEqual([
        "account.list",
        "account.list",
      ]);
      expect(await lstat(runRoot).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("retains a mode-0600 authoritative receipt and resumes from its last safe checkpoint", async () => {
    const base = await privateTestBase();
    const firstWorkers: FakeWorker[] = [];
    const resumedWorkers: FakeWorker[] = [];
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(firstWorkers, { failDeletion: true }),
      });
      await run.bindExpectedRevokedPeer("device_revoked");
      await expect(run.cleanup({ cloudDeletionDeadlineMs: 10, cloudDeletionPollMs: 1 }))
        .rejects.toThrow();
      const receiptPath = join(base, `.hra-live-acceptance-${run.runId}.recovery.json`);
      const metadata = await lstat(receiptPath);
      expect(metadata.mode & 0o777).toBe(0o600);
      const onDisk = liveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(await readFile(receiptPath, "utf8")) as unknown,
      );
      expect(onDisk.phase).toBe("recovery_required");
      expect(onDisk.checkpoint).toBe("cleanup_revocation_proven");
      expect(onDisk.cloudCleanupMode).toBe("delete_identity");
      expect(onDisk.expectedRevocationIdempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(onDisk.expectedRevokedPeerPublicId).toBe("device_revoked");
      expect(onDisk.resources.every((resource) => resource.status === "active")).toBe(true);

      const forgedCallerCopy = {
        ...onDisk,
        checkpoint: "cleanup_daemons_stopped" as const,
        phase: "cleanup_daemons_stopped" as const,
        workers: onDisk.workers.map((worker) => ({ ...worker, state: "stopped" as const })),
      };
      await resumeLiveAcceptanceCleanup(forgedCallerCopy, {
        cloudDeletionDeadlineMs: 1_000,
        cloudDeletionPollMs: 1,
        shutdownVerifier: fakeShutdownVerifier,
        workerFactory: fakeFactory(resumedWorkers),
      });
      expect(resumedWorkers).toHaveLength(2);
      expect(resumedWorkers[0]!.commands[0]?.kind).toBe("auth.delete");
      expect(await lstat(receiptPath).then(() => true).catch(() => false)).toBe(false);
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("an unknown direct child blocks deletion before either device root is removed", async () => {
    const base = await privateTestBase();
    const workers: FakeWorker[] = [];
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(workers),
      });
      const runRoot = dirname(workers[0]!.rootDirectory);
      await mkdir(join(runRoot, "unexpected-entry"), { mode: 0o700 });
      await run.bindExpectedRevokedPeer("device_revoked");
      await expect(run.cleanup({ cloudDeletionDeadlineMs: 1_000, cloudDeletionPollMs: 1 }))
        .rejects.toThrow("layout_changed");
      for (const worker of workers) {
        expect((await lstat(worker.rootDirectory)).isDirectory()).toBe(true);
      }
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("admits an unbound singleton identity but refuses every unexpected peer status", async () => {
    const base = await privateTestBase();
    const unboundWorkers: FakeWorker[] = [];
    const extraPeerWorkers: FakeWorker[] = [];
    const extraRevokedWorkers: FakeWorker[] = [];
    try {
      const unbound = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(unboundWorkers, { omitPeer: true }),
      });
      await expect(unbound.cleanup({ cloudDeletionDeadlineMs: 1_000, cloudDeletionPollMs: 1 }))
        .resolves.toBeUndefined();

      const extraPeer = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(extraPeerWorkers, { extraLivePeer: true }),
      });
      await extraPeer.bindExpectedRevokedPeer("device_revoked");
      await expect(extraPeer.cleanup({ cloudDeletionDeadlineMs: 10, cloudDeletionPollMs: 1 }))
        .rejects.toThrow("cloud_revocation_unproven");

      const extraRevoked = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(extraRevokedWorkers, { extraRevokedPeer: true }),
      });
      await extraRevoked.bindExpectedRevokedPeer("device_revoked");
      await expect(extraRevoked.cleanup({ cloudDeletionDeadlineMs: 10, cloudDeletionPollMs: 1 }))
        .rejects.toThrow("cloud_revocation_unproven");
      expect(unboundWorkers.every((worker) => worker.stopped)).toBe(true);
      expect(extraPeerWorkers.every((worker) => worker.preserved)).toBe(true);
      expect(extraRevokedWorkers.every((worker) => worker.preserved)).toBe(true);
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("converges a durably bound pending peer through one exact revoke before deletion", async () => {
    const base = await privateTestBase();
    const workers: FakeWorker[] = [];
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(workers, { peerStatus: "pending" }),
      });
      await run.bindExpectedRevokedPeer("device_revoked");
      await run.cleanup({ cloudDeletionDeadlineMs: 1_000, cloudDeletionPollMs: 1 });
      const revokes = workers[0]!.commands.filter((command) => command.kind === "device.revoke");
      expect(revokes).toHaveLength(1);
      expect(revokes[0]).toMatchObject({
        device: "device_revoked",
        kind: "device.revoke",
      });
      expect((revokes[0] as Extract<LocalCommand, { kind: "device.revoke" }>).idempotencyKey)
        .toMatch(/^[0-9a-f-]{36}$/u);
      expect(workers[0]!.commands.map((command) => command.kind)).toContain("auth.delete");
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("recovers the lost pair response by deriving and durably binding B before revoke", async () => {
    const base = await privateTestBase();
    const firstWorkers: FakeWorker[] = [];
    const resumedWorkers: FakeWorker[] = [];
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(firstWorkers, {
          derivePeerFromDeviceB: true,
          failRevocation: true,
          peerStatus: "pending",
        }),
      });
      await expect(run.cleanup({ cloudDeletionDeadlineMs: 10, cloudDeletionPollMs: 1 }))
        .rejects.toThrow();
      const receipt = liveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(await readFile(run.recoveryReceiptPath, "utf8")) as unknown,
      );
      expect(receipt.checkpoint).toBe("workers_ready");
      expect(receipt.expectedRevokedPeerPublicId).toBe("device_revoked");
      expect(receipt.expectedRevocationIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
      expect(firstWorkers[1]!.commands.map((command) => command.kind)).toContain("auth.status");
      expect(firstWorkers[0]!.commands.find((command) => command.kind === "device.revoke"))
        .toMatchObject({ device: "device_revoked" });

      await resumeLiveAcceptanceCleanup(receipt, {
        cloudDeletionDeadlineMs: 1_000,
        cloudDeletionPollMs: 1,
        shutdownVerifier: fakeShutdownVerifier,
        workerFactory: fakeFactory(resumedWorkers, {
          derivePeerFromDeviceB: true,
          peerStatus: "pending",
        }),
      });
      expect(resumedWorkers[0]!.commands.find((command) => command.kind === "device.revoke"))
        .toMatchObject({ device: "device_revoked" });
      expect(await lstat(run.recoveryReceiptPath).then(() => true).catch(() => false))
        .toBe(false);
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("reconciles an indeterminate Codex logout on resume without replaying it", async () => {
    const base = await privateTestBase();
    const firstWorkers: FakeWorker[] = [];
    const resumedWorkers: FakeWorker[] = [];
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(firstWorkers, { ambiguousLogout: true }),
      });
      await run.bindExpectedRevokedPeer("device_revoked");
      await expect(run.cleanup({ cloudDeletionDeadlineMs: 1_000, cloudDeletionPollMs: 1 }))
        .rejects.toThrow("worker_failed");
      const receipt = liveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(await readFile(run.recoveryReceiptPath, "utf8")) as unknown,
      );
      expect(receipt.checkpoint).toBe("cleanup_cloud_erased");
      expect(firstWorkers.every((worker) =>
        worker.commands.filter((command) => command.kind === "account.logout").length === 1))
        .toBe(true);

      await resumeLiveAcceptanceCleanup(receipt, {
        shutdownVerifier: fakeShutdownVerifier,
        workerFactory: fakeFactory(resumedWorkers, {
          accountInitialState: "recovery_required",
          ambiguousLogout: true,
        }),
      });
      expect(resumedWorkers.every((worker) =>
        worker.commands.filter((command) => command.kind === "account.show").length === 1))
        .toBe(true);
      expect(resumedWorkers.every((worker) =>
        worker.commands.every((command) => command.kind !== "account.logout")))
        .toBe(true);
      expect(await lstat(run.recoveryReceiptPath).then(() => true).catch(() => false))
        .toBe(false);
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("passes interruption into resumed quarantine deletion and retains every root", async () => {
    const base = await privateTestBase();
    const workers: FakeWorker[] = [];
    const controller = new AbortController();
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: async () => { controller.abort(); },
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(workers),
      });
      await run.bindExpectedRevokedPeer("device_revoked");
      await expect(run.cleanup({
        cloudDeletionDeadlineMs: 1_000,
        cloudDeletionPollMs: 1,
        signal: controller.signal,
      })).rejects.toThrow("operator_interrupted");
      const receipt = liveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(await readFile(run.recoveryReceiptPath, "utf8")) as unknown,
      );
      expect(receipt.checkpoint).toBe("cleanup_daemons_stopped");
      expect(receipt.resources.every((resource) => resource.status === "active")).toBe(true);

      await expect(resumeLiveAcceptanceCleanup(receipt, { signal: controller.signal }))
        .rejects.toThrow("operator_interrupted");
      expect(await lstat(run.recoveryReceiptPath).then(() => true).catch(() => false))
        .toBe(true);
      for (const resource of receipt.resources) {
        expect((await lstat(resource.identity.path)).isDirectory()).toBe(true);
      }
    } finally {
      await removeOwnedTestBase(base);
    }
  });

  test("serializes interruption with in-flight cleanup and preserves one resumable receipt", async () => {
    const base = await privateTestBase();
    const workers: FakeWorker[] = [];
    let releaseAuthStatus!: () => void;
    let markAuthStatusStarted!: () => void;
    const authStatusGate = new Promise<void>((resolvePromise) => {
      releaseAuthStatus = resolvePromise;
    });
    const authStatusStarted = new Promise<void>((resolvePromise) => {
      markAuthStatusStarted = resolvePromise;
    });
    try {
      const run = await startLiveAcceptanceRun({
        shutdownVerifier: fakeShutdownVerifier,
        temporaryBaseDirectory: base,
        workerFactory: fakeFactory(workers, {
          authStatusGate: async () => {
            markAuthStatusStarted();
            await authStatusGate;
          },
        }),
      });
      await run.bindExpectedRevokedPeer("device_revoked");
      const controller = new AbortController();
      const cleanup = run.cleanup({ signal: controller.signal });
      void cleanup.catch(() => undefined);
      await authStatusStarted;
      controller.abort();
      run.requestAbort();
      const preservation = run.preserveForRecovery("operator_interrupted");
      releaseAuthStatus();
      await expect(cleanup).rejects.toThrow("operator_interrupted");
      await expect(preservation).resolves.toBe("recovery_required");
      const receipt = liveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(await readFile(run.recoveryReceiptPath, "utf8")) as unknown,
      );
      expect(receipt.failureCode).toBe("operator_interrupted");
      expect(receipt.expectedRevokedPeerPublicId).toBe("device_revoked");
      expect(receipt.resources.every((resource) => resource.status === "active")).toBe(true);
      expect(workers.every((worker) => worker.preserved)).toBe(true);
    } finally {
      releaseAuthStatus();
      await removeOwnedTestBase(base);
    }
  });

  test("recovers a worker-start failure with no cloud identity and no peer binding", async () => {
    const base = await privateTestBase();
    const firstWorkers: FakeWorker[] = [];
    const recoveredWorkers: FakeWorker[] = [];
    try {
      const error = await startLiveAcceptanceRun({
        temporaryBaseDirectory: base,
        workerFactory: async (descriptor) => {
          if (descriptor.device === "b") throw new Error("synthetic startup failure");
          const worker = new FakeWorker(descriptor, 1, { noCloudIdentity: true });
          firstWorkers.push(worker);
          return worker;
        },
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(LiveAcceptanceStartError);
      const startError = error as LiveAcceptanceStartError;
      const locator = liveAcceptanceRecoveryReceiptSchema.parse(
        JSON.parse(await readFile(startError.recoveryReceiptPath, "utf8")) as unknown,
      );
      await resumeLiveAcceptanceCleanup(locator, {
        shutdownVerifier: fakeShutdownVerifier,
        workerFactory: fakeFactory(recoveredWorkers, { noCloudIdentity: true }),
      });
      expect(recoveredWorkers).toHaveLength(2);
      expect(recoveredWorkers[0]!.commands.map((command) => command.kind)).toEqual([
        "auth.status",
        "account.list",
        "account.list",
      ]);
      expect(await lstat(startError.recoveryReceiptPath).then(() => true).catch(() => false))
        .toBe(false);
    } finally {
      await removeOwnedTestBase(base);
    }
  });
});
