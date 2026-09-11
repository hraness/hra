import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { runBoundedProcess } from "../bounded-process";
import {
  createOwnedControllerObservation,
  encodeOwnedControllerFrame,
  observeOwnedController,
  OwnedControllerDecoder,
  ownedControllerDirectChildProof,
  type OwnedControllerBinding,
  type OwnedControllerDeadlines,
  type OwnedControllerEvent,
  type OwnedControllerFrame,
  type OwnedControllerObservation,
} from "./protocol";

const enabled = process.env.OOMPA_OWNED_CONTROLLER_NATIVE === "1";
const nativeTest = test.skipIf(!enabled);
const repository = resolve(import.meta.dir, "../..");
const executeFile = promisify(execFile);
const clock = (): number => Math.floor(performance.now());
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
let root: string | undefined;
let helper: string;
let fixture: string;
let compilerCleanupUnproven = false;
const owners = new Set<NativeCase>();
const extraFixturePids = new Set<number>();

const waitUntil = async (predicate: () => Promise<boolean>, milliseconds = 2_000): Promise<void> => {
  const deadline = performance.now() + milliseconds;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error("owned_controller_fixture_deadline");
    await Bun.sleep(10);
  }
};

const exists = async (path: string): Promise<boolean> => {
  try { return (await lstat(path)).isFile(); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Observation only. This never signals a PID read from a fixture or a receipt. */
const processStart = async (pid: number): Promise<string | null> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("owned_controller_fixture_pid_invalid");
  try {
    const result = await executeFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: environment, timeout: 1_000, maxBuffer: 256,
    });
    const value = result.stdout.trim();
    if (value.length === 0 || value.length > 128) throw new Error("owned_controller_fixture_identity_invalid");
    return value;
  } catch (error: unknown) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (failure.code === 1 && failure.stdout === "" && failure.stderr === "") return null;
    throw new Error("owned_controller_fixture_identity_unproven", { cause: error });
  }
};

const waitGone = async (pid: number, expectedStart: string | null): Promise<void> => {
  await waitUntil(async () => {
    const current = await processStart(pid);
    return current === null || (expectedStart !== null && current !== expectedStart);
  }, 3_000);
};

const compile = async (zig: string, source: string, output: string): Promise<void> => {
  if (root === undefined) throw new Error("owned_controller_build_root_missing");
  compilerCleanupUnproven = true;
  const result = await runBoundedProcess({
    arguments: ["build-exe", "-O", "ReleaseSafe", "-fstrip", "-lc",
      "--cache-dir", join(root, "cache"), "--global-cache-dir", join(root, "global-cache"),
      join(import.meta.dir, source), `-femit-bin=${output}`],
    containment: "local", cwd: repository, environment: { ...environment, XDG_CACHE_HOME: join(root, "user-cache") }, executable: zig,
    outputMaximumBytes: 1024 * 1024, phase: "owned-controller-fixture-build",
    terminationGraceMs: 1_000, killSettlementMs: 1_000, timeoutMs: 60_000,
  }, { recoveryDirectory: join(root, "compiler-recovery") });
  compilerCleanupUnproven = result.cleanup !== "proven";
  if (result.cleanup !== "proven" || result.exitCode !== 0) {
    throw new Error(`owned_controller_fixture_build_failed: ${result.stderr.toString("utf8").slice(0, 4_096)}`);
  }
};

beforeAll(async () => {
  if (!enabled) return;
  if (process.platform !== "darwin") throw new Error("owned_controller_native_requires_darwin");
  const requestedZig = process.env.OOMPA_OWNED_CONTROLLER_ZIG;
  if (requestedZig === undefined || !isAbsolute(requestedZig)) throw new Error("owned_controller_zig_path_required");
  const zig = await realpath(requestedZig);
  const version = await executeFile(zig, ["version"], { env: environment, timeout: 5_000, maxBuffer: 256 });
  if (version.stdout.trim() !== "0.16.0" || version.stderr !== "") throw new Error("owned_controller_zig_version_mismatch");
  root = await realpath(await mkdtemp(join(tmpdir(), "oompa-owned-controller-")));
  await chmod(root, 0o700);
  helper = join(root, "helper");
  fixture = join(root, "fixture");
  try {
    await compile(zig, "darwin-helper.zig", helper);
    await compile(zig, "darwin-fixture.zig", fixture);
  } catch (error: unknown) {
    if (!compilerCleanupUnproven) await rm(root, { recursive: true });
    throw new Error(`owned_controller_native_setup_failed; ${compilerCleanupUnproven ? "retained" : "removed"} ${root}`, { cause: error });
  }
  const sources = ["darwin-helper.zig", "darwin-fixture.zig", "darwin-native.test.ts", "protocol.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async (source) => [source, await sha256(join(import.meta.dir, source))])));
  console.info(JSON.stringify({
    evidence: "owned_controller_native_provenance", platform: process.platform, architecture: process.arch,
    kernelRelease: release(), bun: Bun.version, zig, zigVersion: version.stdout.trim(), zigSha256: await sha256(zig),
    sourceHashes, helperSha256: await sha256(helper), fixtureSha256: await sha256(fixture), root,
    abi: "native Darwin libc; Zig ReleaseSafe; no provider process or credentials",
  }));
}, 120_000);

class NativeCase {
  readonly binding: OwnedControllerBinding = { nonce: randomBytes(16).toString("hex"), generation: 23 };
  readonly marker: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: OwnedControllerFrame[] = [];
  readonly closed: Promise<void>;
  readonly #decoder = new OwnedControllerDecoder("helper");
  state: OwnedControllerObservation;
  childPid: number | undefined;
  childStart: string | null = null;
  exitCode: number | null = null;
  stderr = "";
  #failure: unknown;
  #closeSeen = false;
  #goAttempted = false;
  readonly #extraMarkers: readonly string[];

  constructor(name: string, mode: string, deadlines: Partial<OwnedControllerDeadlines> = {}, extraMarkers: readonly string[] = []) {
    if (root === undefined) throw new Error("owned_controller_fixture_root_missing");
    this.marker = join(root, `${name}.started`);
    this.#extraMarkers = extraMarkers;
    const bounds = { startupMs: 2_000, runMs: 3_000, shutdownMs: 600, ...deadlines };
    this.state = createOwnedControllerObservation(this.binding, bounds, clock());
    this.child = spawn(helper, ["--nonce", this.binding.nonce, "--generation", String(this.binding.generation),
      "--startup-ms", String(bounds.startupMs), "--run-ms", String(bounds.runMs), "--shutdown-ms", String(bounds.shutdownMs),
      "--", fixture, mode, this.marker, ...extraMarkers], {
      env: environment, cwd: root, stdio: ["pipe", "pipe", "pipe"],
    });
    owners.add(this);
    this.child.stdin.on("error", (error: unknown) => { this.fail(error); });
    this.child.stdout.on("error", (error: unknown) => { this.fail(error); });
    this.child.stderr.on("error", (error: unknown) => { this.fail(error); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.#decoder.push(chunk)) {
          this.frames.push(frame);
          this.observe({ kind: "frame", frame });
          if (frame.type === "ready") this.childPid = frame.childPid;
        }
      } catch (error: unknown) {
        this.fail(error);
        this.child.kill("SIGTERM");
      }
    });
    this.child.stdout.on("end", () => {
      try { this.#decoder.finish(); this.observe({ kind: "control_eof" }); }
      catch (error: unknown) { this.fail(error); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(0, 4_097);
      if (this.stderr.length > 4_096) {
        this.fail(new Error("owned_controller_fixture_output_overflow"));
        this.child.kill("SIGTERM");
      }
    });
    this.child.on("exit", (code) => { this.exitCode = code; this.observe({ kind: "helper_exit", code }); });
    this.closed = new Promise((resolveClosed) => {
      this.child.on("error", (error: unknown) => { this.fail(error); });
      this.child.once("close", () => { this.#closeSeen = true; resolveClosed(); });
    });
  }

  observe(event: OwnedControllerEvent): void { this.state = observeOwnedController(this.state, event, clock()); }

  fail(error: unknown): void {
    this.#failure ??= new Error("owned_controller_fixture_stream_failure", { cause: error });
    this.observe({ kind: "protocol_failure" });
  }

  async ready(): Promise<void> {
    await waitUntil(async () => {
      if (this.#failure !== undefined) throw new Error("owned_controller_fixture_failed", { cause: this.#failure });
      if (this.#closeSeen && this.childPid === undefined) throw new Error("owned_controller_fixture_no_ready");
      return this.childPid !== undefined;
    });
    if (this.childPid === undefined) throw new Error("owned_controller_fixture_no_ready");
    this.childStart = await processStart(this.childPid);
    expect(this.childStart).not.toBeNull();
  }

  async send(type: "go" | "term"): Promise<void> {
    if (type === "go") this.#goAttempted = true;
    await this.write(encodeOwnedControllerFrame({ ...this.binding, type }));
    this.observe({ kind: type === "go" ? "go_sent" : "term_sent" });
  }

  async raw(value: string): Promise<void> {
    this.observe({ kind: "protocol_failure" });
    await this.write(value);
  }

  async write(value: string): Promise<void> {
    await new Promise<void>((resolveWrite, reject) => {
      this.child.stdin.write(value, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          this.fail(error);
          reject(new Error("owned_controller_fixture_send_uncertain", { cause: error }));
        } else resolveWrite();
      });
    });
  }

  async finish(): Promise<void> {
    await waitUntil(async () => this.#closeSeen, 5_000);
    await this.closed;
    if (this.#failure !== undefined) throw new Error("owned_controller_fixture_failed", { cause: this.#failure });
    expect(this.stderr).toBe("");
    if (this.childPid !== undefined) await waitGone(this.childPid, this.childStart);
  }

  async collect(): Promise<void> {
    if (!this.#closeSeen) {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    }
    await waitUntil(async () => this.#closeSeen, 5_000);
    if (this.childPid !== undefined) await waitGone(this.childPid, this.childStart);
    // Only the fixed escape fixture can create one additional child. It has
    // its own finite lifetime; retain the root if its absence is unproven.
    const pidMarker = this.#extraMarkers[0];
    if (pidMarker !== undefined && this.#goAttempted && !await exists(pidMarker)) {
      throw new Error("owned_controller_fixture_descendant_identity_unproven");
    }
    if (pidMarker !== undefined && await exists(pidMarker)) {
      const value = await readFile(pidMarker, "utf8");
      if (!/^[1-9][0-9]{0,9}\n$/u.test(value)) throw new Error("owned_controller_fixture_pid_marker_invalid");
      const pid = Number(value.trim());
      extraFixturePids.add(pid);
      await waitGone(pid, null);
      extraFixturePids.delete(pid);
    }
    owners.delete(this);
  }
}

afterAll(async () => {
  let failed = false;
  for (const owner of owners) {
    try { await owner.collect(); } catch { failed = true; }
  }
  if (compilerCleanupUnproven || failed || owners.size !== 0 || extraFixturePids.size !== 0) {
    throw new Error(`owned_controller_fixture_cleanup_unproven; retained ${root ?? "uncreated"}`);
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  if (enabled) console.info(JSON.stringify({ evidence: "owned_controller_native_cleanup", helperOwners: owners.size, additionalFixturePids: extraFixturePids.size, compilerCleanup: "proven", privateRootRemoved: root !== undefined }));
}, 30_000);

nativeTest("keeps the child pre-exec until GO and joins its exact normal exit", async () => {
  const value = new NativeCase("normal", "exit");
  await value.ready();
  await Bun.sleep(60);
  expect(await exists(value.marker)).toBeFalse();
  await value.send("go");
  await value.finish();
  expect(await readFile(value.marker, "utf8")).toBe("started\n");
  expect(ownedControllerDirectChildProof(value.state)).toMatchObject({
    scope: "owned_direct_child_only", released: true, termination: "exit", status: 7, replacementWriterAuthorized: false,
  });
});

nativeTest("valid TERM before GO reaps the gated child without executing the fixture", async () => {
  const value = new NativeCase("before-go", "exit");
  await value.ready(); await value.send("term"); await value.finish();
  expect(await exists(value.marker)).toBeFalse();
  expect(ownedControllerDirectChildProof(value.state)).toMatchObject({ released: false, replacementWriterAuthorized: false });
});

for (const [name, invalid] of [
  ["nonce", (binding: OwnedControllerBinding) => `OOC1 GO ${"0".repeat(32)} ${binding.generation}\n`],
  ["generation", (binding: OwnedControllerBinding) => `OOC1 GO ${binding.nonce} ${binding.generation + 1}\n`],
  ["malformed", (binding: OwnedControllerBinding) => `OOC1  GO ${binding.nonce} ${binding.generation}\n`],
  ["future-version", (binding: OwnedControllerBinding) => `OOC2 GO ${binding.nonce} ${binding.generation}\n`],
  ["oversized", () => `${"x".repeat(161)}\n`],
] as const) {
  nativeTest(`refuses ${name} control before effects and keeps the host uncertain`, async () => {
    const value = new NativeCase(name, "exit");
    await value.ready(); await value.raw(invalid(value.binding)); await value.finish();
    expect(value.exitCode).toBe(64);
    expect(await exists(value.marker)).toBeFalse();
    expect(ownedControllerDirectChildProof(value.state)).toBeNull();
    expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: false });
  });
}

nativeTest("duplicate GO closes admission and never starts a second fixture", async () => {
  const value = new NativeCase("duplicate", "hold");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  await value.raw(encodeOwnedControllerFrame({ ...value.binding, type: "go" })); await value.finish();
  expect(value.exitCode).toBe(64);
  expect(value.frames).toHaveLength(2);
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

for (const suffix of ["go", "term", "partial"] as const) {
  nativeTest(`refuses TERM with a buffered ${suffix} suffix`, async () => {
    const value = new NativeCase(`term-suffix-${suffix}`, "exit");
    await value.ready();
    const term = encodeOwnedControllerFrame({ ...value.binding, type: "term" });
    const tail = suffix === "partial" ? "OOC1" : encodeOwnedControllerFrame({ ...value.binding, type: suffix });
    await value.raw(term + tail);
    await value.finish();
    expect(value.exitCode).toBe(64);
    expect(await exists(value.marker)).toBeFalse();
    expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: false });
    expect(ownedControllerDirectChildProof(value.state)).toBeNull();
  });
}

nativeTest("explicit cancellation joins TERM-resistant child after KILL within one shutdown budget", async () => {
  const value = new NativeCase("cancel", "ignore-term");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  await value.send("term"); await value.finish();
  expect(value.exitCode).toBe(0);
  expect(ownedControllerDirectChildProof(value.state)).toMatchObject({ termination: "signal", status: 9, released: true });
});

nativeTest("startup timeout never opens the exec gate", async () => {
  const value = new NativeCase("startup-timeout", "exit", { startupMs: 150 });
  await value.ready(); await value.finish();
  expect(value.exitCode).toBe(124);
  expect(await exists(value.marker)).toBeFalse();
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("run timeout is enforced by the helper while host sends nothing", async () => {
  const value = new NativeCase("run-timeout", "ignore-term", { runMs: 100 });
  await value.ready(); await value.send("go"); await value.finish();
  expect(value.exitCode).toBe(124);
  expect(value.frames.at(-1)).toMatchObject({ type: "terminal", termination: "signal", status: 9 });
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("owner control EOF terminates and joins without admitting replacement authority", async () => {
  const value = new NativeCase("owner-eof", "hold");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  value.observe({ kind: "owner_lost" }); value.child.stdin.end(); await value.finish();
  expect(value.exitCode).toBe(70);
  expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: true });
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("helper death after GO retains uncertainty while finite fixture expires independently", async () => {
  const value = new NativeCase("helper-death", "self-expire");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  value.child.kill("SIGKILL"); await value.finish();
  expect(value.exitCode).toBeNull();
  expect(value.frames).toHaveLength(1);
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("an escaped finite descendant survives direct-child proof without a containment claim", async () => {
  if (root === undefined) throw new Error("owned_controller_fixture_root_missing");
  const pidMarker = join(root, "escape.pid");
  const finished = join(root, "escape.finished");
  const value = new NativeCase("escape", "escape", {}, [pidMarker, finished]);
  await value.ready(); await value.send("go"); await value.finish();
  const pid = Number((await readFile(pidMarker, "utf8")).trim());
  const start = await processStart(pid);
  expect(start).not.toBeNull();
  expect(await exists(finished)).toBeFalse();
  const proof = ownedControllerDirectChildProof(value.state);
  expect(proof).toMatchObject({ scope: "owned_direct_child_only", replacementWriterAuthorized: false });
  expect(proof).not.toHaveProperty("descendantsContained");
  await waitUntil(async () => await exists(finished));
  await waitGone(pid, start);
});
