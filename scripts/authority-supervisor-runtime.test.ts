import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { openAuthoritySupervisorArtifact } from "./authority-supervisor-artifact";
import { runBoundedProcess } from "./bounded-process";

const roots: string[] = [];

const isSupportedLinux = (): boolean =>
  process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "hra-authority-runtime-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

const waitForChildClose = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 8_000,
): Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>> => await new Promise((resolvePromise, rejectPromise) => {
  const timer = setTimeout(() => rejectPromise(new Error("authority_child_close_timeout")), timeoutMs);
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    resolvePromise({ code, signal });
  });
  child.once("error", rejectPromise);
});

const waitForChildSpawn = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<void> => await new Promise((resolvePromise, rejectPromise) => {
  let settled = false;
  const timer = setTimeout(
    () => settle(() => rejectPromise(new Error("authority_child_spawn_timeout"))),
    timeoutMs,
  );
  const settle = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.off("close", onClose);
    child.off("error", onError);
    child.off("spawn", onSpawn);
    callback();
  };
  const onSpawn = (): void => settle(resolvePromise);
  const onError = (): void => settle(() => rejectPromise(new Error("authority_child_spawn_error")));
  const onClose = (): void => settle(() => rejectPromise(new Error("authority_child_closed_before_spawn")));
  child.once("spawn", onSpawn);
  child.once("error", onError);
  child.once("close", onClose);
});

const readChildStream = async (
  stream: ChildProcessWithoutNullStreams["stderr"],
): Promise<string> => await new Promise((resolvePromise, rejectPromise) => {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  stream.once("end", () => resolvePromise(output));
  stream.once("error", rejectPromise);
});

class ControlServer {
  readonly #lines: string[] = [];
  readonly #server: Server;
  readonly path: string;
  #socket: Socket | undefined;
  #waiter: Readonly<{ reject: (error: Error) => void; resolve: (line: string) => void }> | undefined;

  private constructor(server: Server, path: string) {
    this.#server = server;
    this.path = path;
  }

  static async start(root: string): Promise<ControlServer> {
    const path = join(root, `.authority-control-${"a".repeat(32)}.sock`);
    const server = createServer();
    const control = new ControlServer(server, path);
    server.on("connection", (socket) => control.#accept(socket));
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(path, () => {
        server.removeAllListeners("error");
        resolvePromise();
      });
    });
    await chmod(path, 0o600);
    return control;
  }

  #accept(socket: Socket): void {
    if (this.#socket !== undefined) {
      socket.destroy();
      return;
    }
    this.#socket = socket;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const waiter = this.#waiter;
        if (waiter === undefined) this.#lines.push(line);
        else {
          this.#waiter = undefined;
          waiter.resolve(line);
        }
      }
    });
    socket.once("error", () => this.#waiter?.reject(new Error("authority_control_socket_error")));
    socket.once("close", () => this.#waiter?.reject(new Error("authority_control_socket_closed")));
  }

  async nextLine(timeoutMs = 5_000): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return line;
    if (this.#waiter !== undefined) throw new Error("authority_control_concurrent_wait");
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        rejectPromise(new Error("authority_control_line_timeout"));
      }, timeoutMs);
      this.#waiter = {
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
        resolve: (next) => {
          clearTimeout(timer);
          resolvePromise(next);
        },
      };
    });
  }

  write(line: string): void {
    if (this.#socket === undefined) throw new Error("authority_control_socket_missing");
    this.#socket.write(line, "utf8");
  }

  async close(): Promise<void> {
    this.#socket?.destroy();
    await new Promise<void>((resolvePromise) => {
      try {
        this.#server.close(() => resolvePromise());
      } catch {
        resolvePromise();
      }
    });
  }
}

const deadlineDriverSource = (artifactModuleUrl: string): string => `
const { spawn } = require("node:child_process");
const { chmodSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");

void (async () => {
  const root = process.env.HRA_DRIVER_ROOT;
  const mode = process.env.HRA_DRIVER_STOP_MODE;
  const startedMarker = process.env.HRA_DRIVER_STARTED_MARKER;
  const delayedMarker = process.env.HRA_DRIVER_DELAYED_MARKER;
  const goMarker = process.env.HRA_DRIVER_GO_MARKER;
  const resultMarker = process.env.HRA_DRIVER_RESULT_MARKER;
  if (!root || !mode || !startedMarker || !delayedMarker || !goMarker || !resultMarker) throw new Error("driver_environment_missing");
  const recovery = join(root, "process-recovery");
  mkdirSync(recovery, { mode: 0o700 });
  const socketPath = join(recovery, ".authority-control-" + "b".repeat(32) + ".sock");
  const server = createServer();
  let accepted;
  const connected = new Promise((resolve) => { server.once("connection", (socket) => { accepted = socket; resolve(); }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);

  const opened = await import(${JSON.stringify(artifactModuleUrl)}).then((module) => module.openAuthoritySupervisorArtifact());
  const nonce = "2".repeat(32);
  const target = [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(" + JSON.stringify(startedMarker) + ", 'started');",
    "setTimeout(() => writeFileSync(" + JSON.stringify(delayedMarker) + ", 'escaped'), 2500);",
  ].join(" ");
  const helper = spawn(opened.executionPath, ["--control-socket", socketPath, "--nonce", nonce, "--", process.execPath, "-e", target], {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const helperClosed = new Promise((resolve, reject) => {
    helper.once("error", reject);
    helper.once("close", (code, signal) => resolve({ code, signal }));
  });
  await connected;
  let buffered = "";
  const lines = [];
  let wake;
  accepted.setEncoding("utf8");
  accepted.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\\n");
      if (newline < 0) break;
      lines.push(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (wake) { const resolve = wake; wake = undefined; resolve(); }
    }
  });
  const nextLine = async () => {
    while (lines.length === 0) await new Promise((resolve) => { wake = resolve; });
    return lines.shift();
  };
  const ready = await nextLine();
  const readyMatch = ready.match(/ outer_pid=([1-9][0-9]*).* monotonic_ms=([1-9][0-9]*)$/u);
  if (!readyMatch) throw new Error("driver_ready_invalid:" + ready);
  const outerPid = Number(readyMatch[1]);
  const deadline = BigInt(readyMatch[2]) + 1500n;
  await new Promise((resolve, reject) => accepted.write(
    "HRA_AUTHORITY_SUPERVISOR/1 GO nonce=" + nonce + " deadline_monotonic_ms=" + deadline + "\\n",
    (error) => {
      if (error) { reject(error); return; }
      writeFileSync(goMarker, String(outerPid));
      if (mode === "parent") process.kill(process.pid, "SIGSTOP");
      else if (mode === "outer") {
        process.kill(outerPid, "SIGSTOP");
        setTimeout(() => process.kill(outerPid, "SIGCONT"), 3000);
      } else throw new Error("driver_stop_mode_invalid");
      resolve();
    },
  ));
  helper.stdin.end();
  const clean = await nextLine();
  const closed = await helperClosed;
  writeFileSync(resultMarker, JSON.stringify({ clean, closed }));
  accepted.destroy();
  await new Promise((resolve) => server.close(resolve));
  await opened.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

const bindAliasDriverSource = (artifactModuleUrl: string): string => `
const { spawn, spawnSync } = require("node:child_process");
const { chmodSync, mkdirSync, readlinkSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");

void (async () => {
  const root = process.env.HRA_BIND_ROOT;
  const marker = process.env.HRA_BIND_MARKER;
  const resultMarker = process.env.HRA_BIND_RESULT;
  const parentMountNamespace = process.env.HRA_BIND_PARENT_MNT_NS;
  if (!root || !marker || !resultMarker || !parentMountNamespace) throw new Error("bind_driver_environment_missing");
  if (readlinkSync("/proc/self/ns/mnt") === parentMountNamespace) throw new Error("bind_driver_mount_namespace_not_private");
  const recovery = join(root, "process-recovery");
  const alias = join(root, "recovery-bind-alias");
  mkdirSync(recovery, { mode: 0o700 });
  mkdirSync(alias, { mode: 0o700 });
  const mounted = spawnSync("/usr/bin/mount", ["--bind", recovery, alias], { encoding: "utf8" });
  if (mounted.status !== 0) throw new Error("bind_driver_mount_failed:" + mounted.stderr);

  try {
    const socketPath = join(recovery, ".authority-control-" + "c".repeat(32) + ".sock");
    const server = createServer();
    let accepted;
    const connected = new Promise((resolve) => { server.once("connection", (socket) => { accepted = socket; resolve(); }); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    const opened = await import(${JSON.stringify(artifactModuleUrl)}).then((module) => module.openAuthoritySupervisorArtifact());
    const nonce = "3".repeat(32);
    const helper = spawn(opened.executionPath, [
      "--control-socket", socketPath, "--nonce", nonce, "--", process.execPath, "-e",
      "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran')",
    ], { cwd: root, env: process.env, shell: false, stdio: ["pipe", "ignore", "ignore"] });
    const helperClosed = new Promise((resolve, reject) => {
      helper.once("error", reject);
      helper.once("close", (code, signal) => resolve({ code, signal }));
    });
    await connected;
    let buffered = "";
    const firstLine = await new Promise((resolve, reject) => {
      accepted.setEncoding("utf8");
      accepted.on("data", (chunk) => {
        buffered += chunk;
        const newline = buffered.indexOf("\\n");
        if (newline >= 0) resolve(buffered.slice(0, newline));
      });
      accepted.once("error", reject);
      accepted.once("close", () => reject(new Error("bind_driver_control_closed")));
    });
    helper.stdin.end();
    const closed = await helperClosed;
    writeFileSync(resultMarker, JSON.stringify({ firstLine, closed }));
    accepted.destroy();
    await new Promise((resolve) => server.close(resolve));
    await opened.close();
  } finally {
    const unmounted = spawnSync("/usr/bin/umount", ["--", alias], { encoding: "utf8" });
    if (unmounted.status !== 0) throw new Error("bind_driver_unmount_failed:" + unmounted.stderr);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

const waitForFile = async (path: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!await Bun.file(path).exists()) {
    if (Date.now() >= deadline) throw new Error(`authority_runtime_file_timeout:${path}`);
    await Bun.sleep(20);
  }
};

const spawnDeadlineDriver = (
  root: string,
  stopMode: "outer" | "parent",
  markers: Readonly<{
    delayed: string;
    go: string;
    result: string;
    started: string;
  }>,
): ChildProcessWithoutNullStreams => spawn(process.execPath, [
  "-e",
  deadlineDriverSource(new URL("./authority-supervisor-artifact.ts", import.meta.url).href),
], {
  cwd: root,
  env: {
    ...process.env,
    HRA_DRIVER_DELAYED_MARKER: markers.delayed,
    HRA_DRIVER_GO_MARKER: markers.go,
    HRA_DRIVER_RESULT_MARKER: markers.result,
    HRA_DRIVER_ROOT: root,
    HRA_DRIVER_STARTED_MARKER: markers.started,
    HRA_DRIVER_STOP_MODE: stopMode,
  },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

const spawnBindAliasDriver = async (
  root: string,
  marker: string,
  result: string,
): Promise<ChildProcessWithoutNullStreams> => spawn("/usr/bin/unshare", [
  "--user",
  "--map-root-user",
  "--mount",
  "--propagation",
  "private",
  "--fork",
  process.execPath,
  "-e",
  bindAliasDriverSource(new URL("./authority-supervisor-artifact.ts", import.meta.url).href),
], {
  cwd: root,
  env: {
    ...process.env,
    HRA_BIND_MARKER: marker,
    HRA_BIND_PARENT_MNT_NS: await readlink("/proc/self/ns/mnt"),
    HRA_BIND_RESULT: result,
    HRA_BIND_ROOT: root,
  },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

test("authority supervisor holds a target behind GO", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const marker = join(root, "target-ran");
  const controlRoot = join(root, "process-recovery");
  await mkdir(controlRoot, { mode: 0o700 });
  const control = await ControlServer.start(controlRoot);
  const nonce = "1".repeat(32);
  const opened = await openAuthoritySupervisorArtifact();
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    child = spawn(opened.executionPath, [
      "--control-socket",
      control.path,
      "--nonce",
      nonce,
      "--",
      process.execPath,
      "-e",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ], {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = waitForChildClose(child);
    void closed.catch(() => undefined);
    await waitForChildSpawn(child);
    await opened.close();
    child.stdout.resume();
    child.stderr.resume();
    const ready = await control.nextLine();
    expect(ready).toMatch(new RegExp(`^HRA_AUTHORITY_SUPERVISOR/1 READY nonce=${nonce} `));
    const monotonicMatch = ready.match(/ monotonic_ms=([1-9][0-9]*)$/u);
    expect(monotonicMatch).not.toBeNull();
    await Bun.sleep(175);
    expect(await Bun.file(marker).exists()).toBeFalse();
    control.write(
      `HRA_AUTHORITY_SUPERVISOR/1 GO nonce=${nonce} deadline_monotonic_ms=${BigInt(monotonicMatch?.[1] ?? "0") + 5_000n}\n`,
    );
    child.stdin.end();
    const clean = await control.nextLine();
    expect(clean).toBe(`HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=${nonce} exit=0`);
    await expect(closed).resolves.toEqual({ code: 0, signal: null });
    expect(await Bun.file(marker).exists()).toBeTrue();
  } finally {
    child?.kill("SIGKILL");
    await opened.close().catch(() => undefined);
    await control.close();
  }
});

test("native deadline kills custody while the HRA parent is stopped after GO", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const markers = {
    delayed: join(root, "stopped-parent-delayed-marker"),
    go: join(root, "stopped-parent-go-marker"),
    result: join(root, "stopped-parent-result"),
    started: join(root, "stopped-parent-started-marker"),
  };
  const driver = spawnDeadlineDriver(root, "parent", markers);
  const closed = waitForChildClose(driver, 12_000);
  void closed.catch(() => undefined);
  const stderr = readChildStream(driver.stderr);
  driver.stdout.resume();
  try {
    await waitForFile(markers.go);
    await waitForFile(markers.started);
    if (driver.pid === undefined) throw new Error("authority_driver_pid_missing");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await readFile(`/proc/${driver.pid}/status`, "utf8");
      if (/^State:\s+T/mu.test(status)) break;
      if (attempt === 99) throw new Error("authority_driver_not_stopped");
      await Bun.sleep(20);
    }
    await Bun.sleep(3_500);
    expect(await Bun.file(markers.delayed).exists()).toBeFalse();
    driver.kill("SIGCONT");
    await expect(closed).resolves.toEqual({ code: 0, signal: null });
    expect(JSON.parse(await readFile(markers.result, "utf8"))).toEqual({
      clean: `HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=${"2".repeat(32)} exit=124`,
      closed: { code: 124, signal: null },
    });
  } catch (error) {
    driver.kill("SIGCONT");
    driver.kill("SIGKILL");
    throw new Error(`${String(error)}\n${await stderr}`);
  } finally {
    driver.kill("SIGKILL");
  }
}, 15_000);

test("namespace PID 1 enforces the deadline while the outer supervisor is stopped", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const markers = {
    delayed: join(root, "stopped-outer-delayed-marker"),
    go: join(root, "stopped-outer-go-marker"),
    result: join(root, "stopped-outer-result"),
    started: join(root, "stopped-outer-started-marker"),
  };
  const driver = spawnDeadlineDriver(root, "outer", markers);
  const closed = waitForChildClose(driver, 12_000);
  void closed.catch(() => undefined);
  const stderr = readChildStream(driver.stderr);
  driver.stdout.resume();
  try {
    await waitForFile(markers.go);
    const outerPid = Number.parseInt(await readFile(markers.go, "utf8"), 10);
    expect(Number.isSafeInteger(outerPid)).toBeTrue();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await readFile(`/proc/${outerPid}/status`, "utf8");
      if (/^State:\s+T/mu.test(status)) break;
      if (attempt === 99) throw new Error("authority_outer_not_stopped");
      await Bun.sleep(20);
    }
    await waitForFile(markers.started);
    await Bun.sleep(3_500);
    expect(await Bun.file(markers.delayed).exists()).toBeFalse();
    await expect(closed).resolves.toEqual({ code: 0, signal: null });
    expect(JSON.parse(await readFile(markers.result, "utf8"))).toEqual({
      clean: `HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=${"2".repeat(32)} exit=124`,
      closed: { code: 124, signal: null },
    });
  } catch (error) {
    driver.kill("SIGKILL");
    throw new Error(`${String(error)}\n${await stderr}`);
  } finally {
    driver.kill("SIGKILL");
  }
}, 15_000);

test("authority supervisor rejects an inherited bind alias of its recovery directory", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const marker = join(root, "bind-alias-target-marker");
  const result = join(root, "bind-alias-result");
  const driver = await spawnBindAliasDriver(root, marker, result);
  const closed = waitForChildClose(driver, 10_000);
  void closed.catch(() => undefined);
  const stderr = readChildStream(driver.stderr);
  driver.stdout.resume();
  try {
    await expect(closed).resolves.toEqual({ code: 0, signal: null });
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
      firstLine: `HRA_AUTHORITY_SUPERVISOR/1 FAIL nonce=${"3".repeat(32)} code=init_not_ready`,
      closed: { code: 1, signal: null },
    });
    expect(await Bun.file(marker).exists()).toBeFalse();
  } catch (error) {
    driver.kill("SIGKILL");
    throw new Error(`${String(error)}\n${await stderr}`);
  } finally {
    driver.kill("SIGKILL");
  }
}, 12_000);

test("authority runner kills detached descendants after normal completion", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const escapedMarker = join(root, "normal-escape-marker");
  const escaped = [
    "const { writeFileSync } = require('node:fs');",
    `setTimeout(() => writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped'), 750);`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const target = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], { detached: true, stdio: 'ignore' });`,
    "child.unref();",
    "let input = ''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(`received:${input}`));",
  ].join(" ");
  const result = await runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-normal-custody",
    stdin: "hello\n",
    terminationGraceMs: 50,
    timeoutMs: 5_000,
  }, { recoveryDirectory });
  expect(result).toMatchObject({ cleanup: "proven", exitCode: 0, stdout: Buffer.from("received:hello\n") });
  await Bun.sleep(1_000);
  expect(await Bun.file(escapedMarker).exists()).toBeFalse();
});

test("authority target cannot replace the journal lock or erase custody", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const tamperResult = join(root, "tamper-result");
  const target = [
    "const fs = require('node:fs');",
    "let outcome;",
    `try { const names = fs.readdirSync(${JSON.stringify(recoveryDirectory)}); for (const name of names) { if (name === '.journal.lock' || name.endsWith('.json')) fs.unlinkSync(require('node:path').join(${JSON.stringify(recoveryDirectory)}, name)); } outcome = 'tampered'; } catch (error) { outcome = 'blocked:' + String(error && error.code); }`,
    `fs.writeFileSync(${JSON.stringify(tamperResult)}, outcome);`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const first = runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-journal-tamper",
    terminationGraceMs: 50,
    timeoutMs: 2_000,
  }, { recoveryDirectory });
  void first.catch(() => undefined);

  for (let attempt = 0; attempt < 100 && !await Bun.file(tamperResult).exists(); attempt += 1) {
    await Bun.sleep(20);
  }
  expect(await readFile(tamperResult, "utf8")).toBe("blocked:EACCES");
  await expect(runBoundedProcess({
    arguments: ["-e", "process.exit(0)"],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-concurrent-after-tamper",
    terminationGraceMs: 50,
    timeoutMs: 1_000,
  }, { recoveryDirectory })).rejects.toThrow(
    "bounded_process_recovery_journal_blocked:concurrent_invocation",
  );
  await expect(first).resolves.toMatchObject({ cleanup: "proven", exitCode: 124 });
}, 10_000);

test("authority runner refuses GO when the durable GO commit consumes the deadline", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const marker = join(root, "expired-go-must-not-run");
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  let committed = false;
  const result = await runBoundedProcess({
    arguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-expired-go",
    terminationGraceMs: 50,
    timeoutMs: 2_000,
  }, {
    afterAuthorityGoJournal: () => {
      committed = true;
      Atomics.wait(waitCell, 0, 0, 2_250);
    },
    recoveryDirectory,
  });
  expect(committed).toBeTrue();
  expect(result).toMatchObject({ cleanup: "proven", exitCode: 124 });
  await Bun.sleep(175);
  expect(await Bun.file(marker).exists()).toBeFalse();
}, 10_000);

test("authority runner recovers a timed-out detached descendant", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const escapedMarker = join(root, "timeout-escape-marker");
  const escaped = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped'), 4_000);`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const target = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], { detached: true, stdio: 'ignore' });`,
    "child.unref();",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const result = await runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-timeout-custody",
    terminationGraceMs: 50,
    timeoutMs: 1_000,
  }, { recoveryDirectory });
  expect(result).toMatchObject({ cleanup: "proven", exitCode: 124 });
  await Bun.sleep(4_250);
  expect(await Bun.file(escapedMarker).exists()).toBeFalse();
});
