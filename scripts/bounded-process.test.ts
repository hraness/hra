import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessInvocationGuard,
  BoundedProcessRecoveryJournalError,
  authorityRecoveryTimingForTesting,
  boundedProcessCustodyIdentityForTesting,
  boundedProcessCustodyNameIdentityForTesting,
  boundedProcessCustodyRelationshipForTesting,
  linuxProcessIdentityProvenGoneForTesting,
  recoverBoundedProcessJournal,
  rethrowBoundedProcessTerminalError,
  requireBoundedProcessCleanup,
  runBoundedProcess,
  settleConcurrentOperations,
} from "./bounded-process";

const roots: string[] = [];

type TestCustodyIdentity = Readonly<{
  custodyBootId: string;
  custodyMountNamespaceInode: string;
  custodyPidNamespaceInode: string;
  hostIdentity: string;
}>;

const custodyJournalFields = (identity: TestCustodyIdentity) => ({
  custodyBootId: identity.custodyBootId,
  custodyMountNamespaceInode: identity.custodyMountNamespaceInode,
  custodyPidNamespaceInode: identity.custodyPidNamespaceInode,
  hostIdentity: identity.hostIdentity,
});

const custodyNamePrefix = (identity: TestCustodyIdentity): string => {
  const name = boundedProcessCustodyNameIdentityForTesting(identity);
  return `${name.machine}-${name.boot}-${name.pidns}-${name.mntns}`;
};

const changeHex = (value: string): string =>
  `${value[0] === "0" ? "1" : "0"}${value.slice(1)}`;

const makeRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-bounded-process-test-")));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
};

const waitForFile = async (path: string, timeoutMs: number): Promise<void> => {
  const deadline = performance.now() + timeoutMs;
  while (!await Bun.file(path).exists()) {
    if (performance.now() >= deadline) throw new Error(`test_file_wait_timeout:${path}`);
    await Bun.sleep(10);
  }
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

describe("bounded detached process groups", () => {
  test("every release and hosted runner delegates to the same owned group boundary", async () => {
    for (const file of [
      "configure-hosted-sync.ts",
      "domain-cutover.ts",
      "publish-beta-release.ts",
      "release-candidate.ts",
    ]) {
      const source = await readFile(join(import.meta.dir, file), "utf8");
      expect(source).toContain("runBoundedProcess({");
      expect(source).not.toContain("child.kill(");
      expect(source).not.toContain("spawn(request.executable");
    }
  });

  test("authority proof consumes CLEAN before treating the direct helper exit as terminal", async () => {
    const source = await readFile(join(import.meta.dir, "bounded-process.ts"), "utf8");
    const proofStart = source.indexOf("const cleanFrame = endpoint.nextFrame(remaining())");
    const proofEnd = source.indexOf("const cleanExit = assertAuthorityCleanFrame", proofStart);
    const proof = source.slice(proofStart, proofEnd);
    const socketEndStart = source.indexOf('socket.once("end"');
    const socketEndEnd = source.indexOf('socket.once("close"', socketEndStart);
    const socketEnd = source.slice(socketEndStart, socketEndEnd);

    expect(proofStart).toBeGreaterThanOrEqual(0);
    expect(proofEnd).toBeGreaterThan(proofStart);
    expect(proof).not.toContain("childClose.then");
    expect(socketEndStart).toBeGreaterThanOrEqual(0);
    expect(socketEndEnd).toBeGreaterThan(socketEndStart);
    expect(socketEnd).toContain('this.#fail(authorityControlError("socket_ended_early"))');
    expect(source).toContain('"monotonic_ms"');
    expect(source).toContain("announced.monotonicMilliseconds + BigInt(remaining())");
    expect(source).toContain("deadline_monotonic_ms=${authorityDeadlineMonotonicMs.toString()}");
    expect(source).toContain("performance.now() + request.timeoutMs");
    expect(source).not.toContain('"libc.so.6"');
    expect(source).not.toContain('"libc.musl-x86_64.so.1"');
    expect(source).not.toContain('"libc.musl-aarch64.so.1"');
  });

  test("authenticates a pre-GO refusal and leaves its one cleanup to the outer recovery path", async () => {
    const source = await readFile(join(import.meta.dir, "bounded-process.ts"), "utf8");
    const validatorStart = source.indexOf("const assertAuthorityFailFrame = (");
    const validatorEnd = source.indexOf(
      "const authorityRecoveryReadyIdentity = (",
      validatorStart,
    );
    const validator = source.slice(validatorStart, validatorEnd);
    const branchStart = source.indexOf('if (readyFrame.kind === "FAIL") {');
    const branchEnd = source.indexOf("let authorityDeadlineMonotonicMs", branchStart);
    const branch = source.slice(branchStart, branchEnd);

    expect(validatorStart).toBeGreaterThanOrEqual(0);
    expect(validatorEnd).toBeGreaterThan(validatorStart);
    expect(validator).toContain('requireAuthorityFrame(frame, "FAIL", ["code", "nonce"])');
    expect(validator).toContain("fields.nonce !== nonce");
    expect(branchStart).toBeGreaterThanOrEqual(0);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(branch).toContain("assertAuthorityFailFrame(readyFrame, nonce)");
    expect(branch).toContain(
      'throw new BoundedProcessContainmentUnavailableError("authority_backend_unavailable")',
    );
    expect(branch).not.toContain("recoverCurrent()");
    expect(source).not.toContain("openAuthorityArtifact?:");
  });

  test("binds native recovery to its authenticated direct-child identity without reading sealed proc state", async () => {
    const source = await readFile(join(import.meta.dir, "bounded-process.ts"), "utf8");
    const validatorStart = source.indexOf("const authorityRecoveryReadyIdentity = (");
    const validatorEnd = source.indexOf(
      "const assertAuthorityRecoveryCleanFrame = (",
      validatorStart,
    );
    const validator = source.slice(validatorStart, validatorEnd);
    const recoveryStart = source.indexOf("const runAuthorityRecoveryHelperLocked = async (");
    const recoveryEnd = source.indexOf(
      "const assertAuthorityTransitionTemporaryFile = (",
      recoveryStart,
    );
    const recovery = source.slice(recoveryStart, recoveryEnd);

    expect(validatorStart).toBeGreaterThanOrEqual(0);
    expect(validatorEnd).toBeGreaterThan(validatorStart);
    expect(validator).toContain("const recoveryPid = parseFramePid(fields.recovery_pid)");
    expect(validator).toContain(
      "const recoveryStartTime = parseFrameUnsignedDecimal(fields.recovery_start_time)",
    );
    expect(validator).toContain("recoveryPid !== childPid");
    expect(validator).toContain("return { pid: recoveryPid, startTime: recoveryStartTime }");
    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    expect(recoveryEnd).toBeGreaterThan(recoveryStart);
    expect(recovery).toContain("const recoveryPid = child.pid");
    expect(recovery).toContain("authorityRecoveryReadyIdentity(");
    expect(recovery).not.toContain("readLinuxProcessStartTime(recoveryPid)");
  });

  test("binds the sealed init namespace without a forbidden cross-process proc readlink", async () => {
    const source = await readFile(join(import.meta.dir, "bounded-process.ts"), "utf8");
    const verifyStart = source.indexOf("const verifyAuthorityLaunchIdentity = (");
    const verifyEnd = source.indexOf("const authorityJournalIdentity = (", verifyStart);
    const verify = source.slice(verifyStart, verifyEnd);

    expect(verifyStart).toBeGreaterThanOrEqual(0);
    expect(verifyEnd).toBeGreaterThan(verifyStart);
    expect(verify).toContain("childPid !== identity.outer.pid");
    expect(verify).toContain("readLinuxBootId() !== identity.bootId");
    expect(verify).toContain("readLinuxProcessStartTime(identity.outer.pid)");
    expect(verify).toContain("readLinuxProcessStartTime(identity.namespaceInit.pid)");
    expect(verify).not.toContain("readlinkSync(");
    expect(source).not.toContain("const readLinuxPidNamespaceInode =");
    expect(source).toContain(
      "identity.namespaceInit.pidNamespaceInode === intent.custodyPidNamespaceInode",
    );
  });

  test("publishes recovery journals only after an exact temporary write", async () => {
    const source = await readFile(join(import.meta.dir, "bounded-process.ts"), "utf8");
    const authorityReplacementStart = source.indexOf(
      "const replaceAuthorityRecoveryJournal = <Next extends AuthorityProcessRecoveryJournal>(",
    );
    const authorityReplacementEnd = source.indexOf(
      "const writePendingRecoveryJournal = (",
      authorityReplacementStart,
    );
    const authorityReplacement = source.slice(
      authorityReplacementStart,
      authorityReplacementEnd,
    );
    const pendingStart = source.indexOf("const writePendingRecoveryJournal = (");
    const pendingEnd = source.indexOf("const promoteRecoveryJournal = (", pendingStart);
    const pending = source.slice(pendingStart, pendingEnd);
    const promotionStart = source.indexOf("const promoteRecoveryJournal = (");
    const promotionEnd = source.indexOf("const sameRecoveryJournal = (", promotionStart);
    const promotion = source.slice(promotionStart, promotionEnd);

    expect(authorityReplacementStart).toBeGreaterThanOrEqual(0);
    expect(authorityReplacementEnd).toBeGreaterThan(authorityReplacementStart);
    expect(authorityReplacement).toContain(
      "writeExclusiveAuthorityRecoveryJournal(creationTemporary, next)",
    );
    expect(authorityReplacement).toContain("linkSync(creationTemporary, temporary)");
    expect(authorityReplacement).not.toContain(
      "writeExclusiveAuthorityRecoveryJournal(temporary, next)",
    );
    expect(pendingStart).toBeGreaterThanOrEqual(0);
    expect(pendingEnd).toBeGreaterThan(pendingStart);
    expect(pending).toContain("writeExclusiveRecoveryJournal(temporary, journal)");
    expect(pending).toContain("linkSync(temporary, path)");
    expect(pending).not.toContain("writeExclusiveRecoveryJournal(path, journal)");
    expect(promotionStart).toBeGreaterThanOrEqual(0);
    expect(promotionEnd).toBeGreaterThan(promotionStart);
    expect(promotion).toContain("writeExclusiveRecoveryJournal(promotionTemporary, active)");
    expect(promotion).toContain("linkSync(promotionTemporary, promotionPath)");
    expect(promotion).not.toContain("writeExclusiveRecoveryJournal(promotionPath, active)");
  });

  test("preserves both cleanup and journal terminal errors across adapters", () => {
    const cleanup = new BoundedProcessCleanupUnprovenError(4_242, "adapter-cleanup");
    const journal = new BoundedProcessRecoveryJournalError(
      ["/fixture/recovery.json"],
      "adapter-journal",
    );
    expect(() => rethrowBoundedProcessTerminalError(cleanup)).toThrow(cleanup);
    expect(() => rethrowBoundedProcessTerminalError(journal)).toThrow(journal);
    expect(() => rethrowBoundedProcessTerminalError(new Error("ordinary"))).not.toThrow();
  });

  test("authority recovery separates local cleanup proof from remote-effect reconciliation", async () => {
    const source = await readFile(join(import.meta.dir, "bounded-process.ts"), "utf8");
    const proofStart = source.indexOf("const authorityHelperCleanupProven = (");
    const proofEnd = source.indexOf("const runAuthorityRecoveryHelperLocked", proofStart);
    const proof = source.slice(proofStart, proofEnd);

    expect(proofStart).toBeGreaterThanOrEqual(0);
    expect(proofEnd).toBeGreaterThan(proofStart);
    expect(proof).toContain('relationship === "old_boot"');
    expect(proof).not.toContain("currentBootId !== journal.bootId");
    expect(proof).toContain('journal.state !== "go_attempted"');
    expect(proof).toContain("linuxProcessIdentityProvenGone(journal.initHostPid, journal.initStartTime)");
    expect(source.match(/authorityHelperCleanupProven\(/gu)?.length).toBe(2);
  });

  test("authority recovery treats unreadable or malformed proc identities as unknown", () => {
    const pid = 4_242;
    const expectedStartTime = "123";
    const fail = (code: string): never => {
      throw Object.assign(new Error(code), { code });
    };
    const stat = (startTime: string): string => `${String(pid)} (fixture) ${[
      "S",
      ...Array.from({ length: 18 }, () => "0"),
      startTime,
    ].join(" ")}\n`;

    expect(linuxProcessIdentityProvenGoneForTesting(pid, expectedStartTime, () => fail("EACCES"))).toBeFalse();
    expect(linuxProcessIdentityProvenGoneForTesting(pid, expectedStartTime, () => fail("EIO"))).toBeFalse();
    expect(linuxProcessIdentityProvenGoneForTesting(pid, expectedStartTime, () => "malformed")).toBeFalse();
    expect(linuxProcessIdentityProvenGoneForTesting(pid, expectedStartTime, () => stat(expectedStartTime))).toBeFalse();
    expect(linuxProcessIdentityProvenGoneForTesting(pid, expectedStartTime, () => stat("124"))).toBeTrue();
    expect(linuxProcessIdentityProvenGoneForTesting(pid, expectedStartTime, () => fail("ENOENT"))).toBeTrue();
    expect(linuxProcessIdentityProvenGoneForTesting(pid, expectedStartTime, () => fail("ESRCH"))).toBeTrue();
  });

  test("keeps the recovery-child deadline beyond late READY, RECOVERY_CLEAN, and exit", () => {
    const timing = authorityRecoveryTimingForTesting();
    expect(timing.childCloseTimeoutMs).toBe(
      timing.readyTimeoutMs + timing.cleanTimeoutMs + timing.exitMarginMs,
    );
    expect(timing.exitMarginMs).toBeGreaterThan(0);
    expect(timing.childCloseTimeoutMs)
      .toBeGreaterThan(timing.readyTimeoutMs + timing.cleanTimeoutMs);
  });

  test("authority journal startup reconciles only provable create and replace crash artifacts", async () => {
    const custodyIdentity = boundedProcessCustodyIdentityForTesting();
    const namePrefix = custodyNamePrefix(custodyIdentity);
    const common = {
      architecture: "x64",
      containment: "authority",
      createdAt: 1,
      ...custodyJournalFields(custodyIdentity),
      helperSha256: "a".repeat(64),
      phase: "crash-fixture",
      schemaVersion: 2,
    } as const;
    const intent = { ...common, state: "intent" } as const;
    const prepared = {
      ...common,
      bootId: custodyIdentity.custodyBootId,
      initHostPid: 4_243,
      initPidNamespaceInode: "2",
      initStartTime: "1",
      outerPid: 4_242,
      outerStartTime: "1",
      state: "prepared",
    } as const;
    const writeJournal = async (path: string, value: unknown): Promise<void> => {
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    };
    const makeRecoveryDirectory = async (): Promise<string> => {
      const root = await makeRoot();
      const directory = join(root, "process-recovery");
      await mkdir(directory, { mode: 0o700 });
      return directory;
    };

    const partialCreateDirectory = await makeRecoveryDirectory();
    const partialCreate = join(
      partialCreateDirectory,
      `authority-${namePrefix}-${"1".repeat(32)}.json.create-${"2".repeat(32)}`,
    );
    await writeFile(partialCreate, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: partialCreateDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(partialCreate).exists()).toBeFalse();

    const linkedCreateDirectory = await makeRecoveryDirectory();
    const linkedMain = join(
      linkedCreateDirectory,
      `authority-${namePrefix}-${"3".repeat(32)}.json`,
    );
    const linkedCreate = `${linkedMain}.create-${"4".repeat(32)}`;
    await writeJournal(linkedCreate, intent);
    await link(linkedCreate, linkedMain);
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: linkedCreateDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(linkedCreate).exists()).toBeFalse();
    expect(await Bun.file(linkedMain).exists()).toBeFalse();

    const replacementDirectory = await makeRecoveryDirectory();
    const replacementMain = join(
      replacementDirectory,
      `authority-${namePrefix}-${"5".repeat(32)}.json`,
    );
    const replacement = `${replacementMain}.replace-${"6".repeat(32)}`;
    await writeJournal(replacementMain, intent);
    await writeJournal(replacement, prepared);
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: replacementDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(replacement).exists()).toBeFalse();
    expect(await Bun.file(replacementMain).exists()).toBeFalse();

    const emptyReplacementDirectory = await makeRecoveryDirectory();
    const emptyReplacementMain = join(
      emptyReplacementDirectory,
      `authority-${namePrefix}-${"7".repeat(32)}.json`,
    );
    const emptyReplacement = `${emptyReplacementMain}.replace-${"8".repeat(32)}`;
    await writeJournal(emptyReplacementMain, intent);
    await writeFile(emptyReplacement, "", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: emptyReplacementDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(emptyReplacement).exists()).toBeFalse();
    expect(await Bun.file(emptyReplacementMain).exists()).toBeFalse();

    const partialReplacementDirectory = await makeRecoveryDirectory();
    const partialReplacementMain = join(
      partialReplacementDirectory,
      `authority-${namePrefix}-${"9".repeat(32)}.json`,
    );
    const partialReplacement = `${partialReplacementMain}.replace-${"a".repeat(32)}`;
    await writeJournal(partialReplacementMain, intent);
    await writeFile(partialReplacement, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: partialReplacementDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(partialReplacement).exists()).toBeFalse();
    expect(await Bun.file(partialReplacementMain).exists()).toBeFalse();

    const nestedReplacementDirectory = await makeRecoveryDirectory();
    const nestedReplacementMain = join(
      nestedReplacementDirectory,
      `authority-${namePrefix}-${"b".repeat(32)}.json`,
    );
    const nestedReplacement = `${nestedReplacementMain}.replace-${"c".repeat(32)}`;
    const nestedReplacementCreate = `${nestedReplacement}.create-${"d".repeat(32)}`;
    await writeJournal(nestedReplacementMain, intent);
    await writeFile(nestedReplacementCreate, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: nestedReplacementDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(nestedReplacementCreate).exists()).toBeFalse();
    expect(await Bun.file(nestedReplacementMain).exists()).toBeFalse();

    const linkedReplacementDirectory = await makeRecoveryDirectory();
    const linkedReplacementMain = join(
      linkedReplacementDirectory,
      `authority-${namePrefix}-${"e".repeat(32)}.json`,
    );
    const linkedReplacement = `${linkedReplacementMain}.replace-${"f".repeat(32)}`;
    const linkedReplacementCreate = `${linkedReplacement}.create-${"0".repeat(32)}`;
    await writeJournal(linkedReplacementMain, intent);
    await writeJournal(linkedReplacementCreate, prepared);
    await link(linkedReplacementCreate, linkedReplacement);
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: linkedReplacementDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(linkedReplacementCreate).exists()).toBeFalse();
    expect(await Bun.file(linkedReplacement).exists()).toBeFalse();
    expect(await Bun.file(linkedReplacementMain).exists()).toBeFalse();

    const malformedDirectory = await makeRecoveryDirectory();
    const malformedMain = join(
      malformedDirectory,
      `authority-${namePrefix}-${"7".repeat(32)}.json`,
    );
    const malformedReplacement = `${malformedMain}.replace-${"8".repeat(32)}`;
    await writeJournal(malformedMain, intent);
    await writeFile(malformedReplacement, `${JSON.stringify({ invalid: true })}\n`, {
      mode: 0o600,
    });
    const failure = await recoverBoundedProcessJournal({
      recoveryDirectory: malformedDirectory,
    }).then(
      () => new Error("malformed_authority_transition_unexpectedly_recovered"),
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect(await Bun.file(malformedMain).exists()).toBeTrue();
    expect(await Bun.file(malformedReplacement).exists()).toBeTrue();

    const collisionDirectory = await makeRecoveryDirectory();
    const collisionMain = join(
      collisionDirectory,
      `authority-${namePrefix}-${"a".repeat(32)}.json`,
    );
    const collisionReplacement = `${collisionMain}.replace-${"b".repeat(32)}`;
    const collisionCreate = `${collisionReplacement}.create-${"c".repeat(32)}`;
    await writeJournal(collisionMain, intent);
    await writeJournal(collisionReplacement, prepared);
    await writeJournal(collisionCreate, prepared);
    const collisionFailure = await recoverBoundedProcessJournal({
      recoveryDirectory: collisionDirectory,
    }).then(
      () => new Error("colliding_authority_transition_unexpectedly_recovered"),
      (error: unknown) => error,
    );
    expect(collisionFailure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect(await Bun.file(collisionMain).exists()).toBeTrue();
    expect(await Bun.file(collisionReplacement).exists()).toBeTrue();
    expect(await Bun.file(collisionCreate).exists()).toBeTrue();

    const linkedMalformedDirectory = await makeRecoveryDirectory();
    const linkedMalformedMain = join(
      linkedMalformedDirectory,
      `authority-${namePrefix}-${"d".repeat(32)}.json`,
    );
    const linkedMalformedReplacement = `${linkedMalformedMain}.replace-${"e".repeat(32)}`;
    const linkedMalformedCreate = `${linkedMalformedReplacement}.create-${"f".repeat(32)}`;
    await writeJournal(linkedMalformedMain, intent);
    await writeFile(linkedMalformedCreate, "{", { mode: 0o600 });
    await link(linkedMalformedCreate, linkedMalformedReplacement);
    const linkedMalformedFailure = await recoverBoundedProcessJournal({
      recoveryDirectory: linkedMalformedDirectory,
    }).then(
      () => new Error("linked_malformed_authority_transition_unexpectedly_recovered"),
      (error: unknown) => error,
    );
    expect(linkedMalformedFailure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect(await Bun.file(linkedMalformedMain).exists()).toBeTrue();
    expect(await Bun.file(linkedMalformedReplacement).exists()).toBeTrue();
    expect(await Bun.file(linkedMalformedCreate).exists()).toBeTrue();

    const mainOnlyDirectory = await makeRecoveryDirectory();
    const mainOnly = join(
      mainOnlyDirectory,
      `authority-${namePrefix}-${"9".repeat(32)}.json`,
    );
    await writeJournal(mainOnly, intent);
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: mainOnlyDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(mainOnly).exists()).toBeFalse();
  });

  test("removes only exact stale authority sockets from the pre-chmod bind window", async () => {
    const createStaleSocket = async (
      root: string,
      recoveryDirectory: string,
      token: string,
    ): Promise<string> => {
      const socketPath = join(recoveryDirectory, `.authority-control-${token}.sock`);
      const readyPath = join(root, `socket-${token}-ready`);
      const child = spawn(process.execPath, [
        "-e",
        [
          "const { writeFileSync } = require('node:fs');",
          "const { createServer } = require('node:net');",
          `const server = createServer().listen(${JSON.stringify(socketPath)}, () => {`,
          `  writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
          "});",
          "setInterval(() => undefined, 1000);",
        ].join(" "),
      ], { stdio: "ignore" });
      const closed = new Promise<void>((resolvePromise, rejectPromise) => {
        child.once("close", () => resolvePromise());
        child.once("error", rejectPromise);
      });
      try {
        await waitForFile(readyPath, 2_000);
      } catch (error: unknown) {
        child.kill("SIGKILL");
        await closed.catch(() => undefined);
        throw error;
      }
      child.kill("SIGKILL");
      await closed;
      return socketPath;
    };
    const makeRecoveryDirectory = async (): Promise<Readonly<{
      recoveryDirectory: string;
      root: string;
    }>> => {
      const root = await makeRoot();
      const recoveryDirectory = join(root, "process-recovery");
      await mkdir(recoveryDirectory, { mode: 0o700 });
      return { recoveryDirectory, root };
    };

    const stale = await makeRecoveryDirectory();
    const stalePath = await createStaleSocket(
      stale.root,
      stale.recoveryDirectory,
      "1".repeat(32),
    );
    const staleMetadata = await lstat(stalePath);
    expect(staleMetadata.isSocket()).toBeTrue();
    expect(staleMetadata.mode & 0o777).toBe(0o777 & ~process.umask());
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: stale.recoveryDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(stalePath).exists()).toBeFalse();

    const wrongMode = await makeRecoveryDirectory();
    const wrongModePath = await createStaleSocket(
      wrongMode.root,
      wrongMode.recoveryDirectory,
      "2".repeat(32),
    );
    const preChmodMode = 0o777 & ~process.umask();
    const invalidMode = [0o000, 0o111, 0o644, 0o666, 0o700, 0o755, 0o777]
      .find((mode) => mode !== 0o600 && mode !== preChmodMode);
    if (invalidMode === undefined) throw new Error("invalid_socket_mode_unavailable");
    await chmod(wrongModePath, invalidMode);
    const failure = await recoverBoundedProcessJournal({
      recoveryDirectory: wrongMode.recoveryDirectory,
    }).then(
      () => new Error("wrong_mode_authority_socket_unexpectedly_removed"),
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect(await lstat(wrongModePath).then(
      (metadata) => metadata.isSocket(),
      () => false,
    )).toBeTrue();
  });

  test("blocks foreign-host custody before cleanup or target launch", async () => {
    const custodyIdentity = boundedProcessCustodyIdentityForTesting();
    const namePrefix = custodyNamePrefix(custodyIdentity);
    const foreignCustodyIdentity = {
      ...custodyIdentity,
      hostIdentity: changeHex(custodyIdentity.hostIdentity),
    };
    const foreignNamePrefix = custodyNamePrefix(foreignCustodyIdentity);
    const makeRecoveryDirectory = async (): Promise<Readonly<{
      recoveryDirectory: string;
      root: string;
    }>> => {
      const root = await makeRoot();
      const recoveryDirectory = join(root, "process-recovery");
      await mkdir(recoveryDirectory, { mode: 0o700 });
      return { recoveryDirectory, root };
    };
    const writeJournal = async (path: string, value: unknown): Promise<void> => {
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    };
    const processGroupId = [2_000_000_006, 2_000_000_007, 2_000_000_008].find((candidate) => {
      try {
        process.kill(-candidate, 0);
        return false;
      } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    if (processGroupId === undefined) throw new Error("absent_process_group_not_found");

    const local = await makeRecoveryDirectory();
    const localPath = join(
      local.recoveryDirectory,
      `process-${foreignNamePrefix}-${"1".repeat(32)}.active-${String(processGroupId)}.json`,
    );
    await writeJournal(localPath, {
      createdAt: 1,
      ...custodyJournalFields(foreignCustodyIdentity),
      phase: "foreign-host-local",
      processGroupId,
      schemaVersion: 2,
      state: "active",
    });
    const marker = join(local.root, "foreign-host-target-must-not-run");
    await expect(runBoundedProcess({
      arguments: [marker],
      containment: "local",
      cwd: local.root,
      environment: { PATH: process.env.PATH },
      executable: "/usr/bin/touch",
      outputMaximumBytes: 64,
      phase: "foreign-host-launch",
      terminationGraceMs: 10,
      timeoutMs: 100,
    }, { recoveryDirectory: local.recoveryDirectory })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:host_identity_mismatch",
    );
    expect(await Bun.file(localPath).exists()).toBeTrue();
    expect(await Bun.file(marker).exists()).toBeFalse();

    const authority = await makeRecoveryDirectory();
    const authorityPath = join(
      authority.recoveryDirectory,
      `authority-${foreignNamePrefix}-${"2".repeat(32)}.json`,
    );
    await writeJournal(authorityPath, {
      architecture: "x64",
      bootId: "11111111-1111-1111-1111-111111111111",
      containment: "authority",
      createdAt: 1,
      ...custodyJournalFields(foreignCustodyIdentity),
      helperSha256: "a".repeat(64),
      initHostPid: 4_243,
      initPidNamespaceInode: "2",
      initStartTime: "1",
      outerPid: 4_242,
      outerStartTime: "1",
      phase: "foreign-host-authority",
      schemaVersion: 2,
      state: "go_attempted",
    });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: authority.recoveryDirectory,
    })).rejects.toThrow("bounded_process_recovery_journal_blocked:host_identity_mismatch");
    expect(await Bun.file(authorityPath).exists()).toBeTrue();

    const mismatchedDocument = await makeRecoveryDirectory();
    const mismatchedDocumentPath = join(
      mismatchedDocument.recoveryDirectory,
      `process-${namePrefix}-${"3".repeat(32)}.pending.json`,
    );
    await writeJournal(mismatchedDocumentPath, {
      createdAt: 1,
      ...custodyJournalFields(foreignCustodyIdentity),
      phase: "foreign-host-document",
      schemaVersion: 2,
      state: "pending",
    });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: mismatchedDocument.recoveryDirectory,
    })).rejects.toThrow("bounded_process_recovery_journal_blocked:host_identity_mismatch");
    expect(await Bun.file(mismatchedDocumentPath).exists()).toBeTrue();
  });

  test("classifies PID visibility before boot age and fails closed across namespaces", () => {
    const current = boundedProcessCustodyIdentityForTesting();
    const oldBoot = { ...current, custodyBootId: changeHex(current.custodyBootId) };
    const foreignPidNamespace = {
      ...current,
      custodyPidNamespaceInode: current.custodyPidNamespaceInode === "1" ? "2" : "1",
    };
    const foreignMountNamespace = {
      ...current,
      custodyMountNamespaceInode: current.custodyMountNamespaceInode === "1" ? "2" : "1",
    };
    const oldBootForeignPidNamespace = {
      ...foreignPidNamespace,
      custodyBootId: oldBoot.custodyBootId,
    };

    expect(boundedProcessCustodyRelationshipForTesting(current, current)).toBe("current");
    expect(boundedProcessCustodyRelationshipForTesting(oldBoot, current)).toBe("old_boot");
    expect(boundedProcessCustodyRelationshipForTesting(foreignPidNamespace, current))
      .toBe("foreign_pid_namespace");
    expect(boundedProcessCustodyRelationshipForTesting(oldBootForeignPidNamespace, current))
      .toBe("foreign_pid_namespace");
    expect(boundedProcessCustodyRelationshipForTesting(foreignMountNamespace, current))
      .toBe("foreign_mount_namespace");
    expect(boundedProcessCustodyRelationshipForTesting({
      ...foreignMountNamespace,
      custodyBootId: oldBoot.custodyBootId,
    }, current)).toBe("foreign_mount_namespace");
    expect(boundedProcessCustodyRelationshipForTesting({
      ...current,
      hostIdentity: changeHex(current.hostIdentity),
    }, current)).toBe("foreign_host");
    const longestPublishedName = [
      `process-${custodyNamePrefix(current)}-${"f".repeat(32)}`,
      `.active-2147483647.json.promote-${"e".repeat(32)}`,
      `.create-${"d".repeat(32)}`,
    ].join("");
    expect(Buffer.byteLength(longestPublishedName, "utf8")).toBeLessThanOrEqual(255);
  });

  test("blocks old-boot custody from a foreign mount namespace before torn repair", async () => {
    const current = boundedProcessCustodyIdentityForTesting();
    const foreign = {
      ...current,
      custodyBootId: changeHex(current.custodyBootId),
      custodyMountNamespaceInode: current.custodyMountNamespaceInode === "1" ? "2" : "1",
    };
    const recoveryDirectory = join(await makeRoot(), "process-recovery");
    await mkdir(recoveryDirectory, { mode: 0o700 });
    const path = join(
      recoveryDirectory,
      `process-${custodyNamePrefix(foreign)}-${"c".repeat(32)}.pending.json.create-${"d".repeat(32)}`,
    );
    await writeFile(path, "{", { mode: 0o600 });

    await expect(recoverBoundedProcessJournal({ recoveryDirectory })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:mount_namespace_identity_mismatch",
    );
    expect(await Bun.file(path).exists()).toBeTrue();
  });

  test("blocks same-machine current-boot foreign-PIDNS custody before cleanup or launch", async () => {
    const current = boundedProcessCustodyIdentityForTesting();
    const currentNamePrefix = custodyNamePrefix(current);
    const foreign = {
      ...current,
      custodyPidNamespaceInode: current.custodyPidNamespaceInode === "1" ? "2" : "1",
    };
    const foreignNamePrefix = custodyNamePrefix(foreign);
    const makeRecoveryDirectory = async (): Promise<Readonly<{
      recoveryDirectory: string;
      root: string;
    }>> => {
      const root = await makeRoot();
      const recoveryDirectory = join(root, "process-recovery");
      await mkdir(recoveryDirectory, { mode: 0o700 });
      return { recoveryDirectory, root };
    };
    const writeJournal = async (path: string, value: unknown): Promise<void> => {
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    };

    const torn = await makeRecoveryDirectory();
    const tornPath = join(
      torn.recoveryDirectory,
      `process-${foreignNamePrefix}-${"4".repeat(32)}.pending.json.create-${"5".repeat(32)}`,
    );
    await writeFile(tornPath, "{", { mode: 0o600 });
    const marker = join(torn.root, "foreign-pidns-target-must-not-run");
    await expect(runBoundedProcess({
      arguments: [marker],
      containment: "local",
      cwd: torn.root,
      environment: { PATH: process.env.PATH },
      executable: "/usr/bin/touch",
      outputMaximumBytes: 64,
      phase: "foreign-pidns-launch",
      terminationGraceMs: 10,
      timeoutMs: 100,
    }, { recoveryDirectory: torn.recoveryDirectory })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:pid_namespace_identity_mismatch",
    );
    expect(await Bun.file(tornPath).exists()).toBeTrue();
    expect(await Bun.file(marker).exists()).toBeFalse();

    const authority = await makeRecoveryDirectory();
    const authorityPath = join(
      authority.recoveryDirectory,
      `authority-${foreignNamePrefix}-${"6".repeat(32)}.json`,
    );
    await writeJournal(authorityPath, {
      architecture: "x64",
      bootId: current.custodyBootId,
      containment: "authority",
      createdAt: 1,
      ...custodyJournalFields(foreign),
      helperSha256: "a".repeat(64),
      initHostPid: 4_243,
      initPidNamespaceInode: "2",
      initStartTime: "1",
      outerPid: 4_242,
      outerStartTime: "1",
      phase: "foreign-pidns-authority",
      schemaVersion: 2,
      state: "go_attempted",
    });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: authority.recoveryDirectory,
    })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:pid_namespace_identity_mismatch",
    );
    expect(await Bun.file(authorityPath).exists()).toBeTrue();

    const mismatchedDocument = await makeRecoveryDirectory();
    const mismatchedDocumentPath = join(
      mismatchedDocument.recoveryDirectory,
      `process-${currentNamePrefix}-${"7".repeat(32)}.pending.json`,
    );
    await writeJournal(mismatchedDocumentPath, {
      createdAt: 1,
      ...custodyJournalFields(foreign),
      phase: "foreign-pidns-document",
      schemaVersion: 2,
      state: "pending",
    });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: mismatchedDocument.recoveryDirectory,
    })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:pid_namespace_identity_mismatch",
    );
    expect(await Bun.file(mismatchedDocumentPath).exists()).toBeTrue();
  });

  test("retires same-visibility old-boot journals without PID or PGID observation", async () => {
    const current = boundedProcessCustodyIdentityForTesting();
    const oldBoot = { ...current, custodyBootId: changeHex(current.custodyBootId) };
    const oldNamePrefix = custodyNamePrefix(oldBoot);
    const makeRecoveryDirectory = async (): Promise<string> => {
      const root = await makeRoot();
      const recoveryDirectory = join(root, "process-recovery");
      await mkdir(recoveryDirectory, { mode: 0o700 });
      return recoveryDirectory;
    };
    const writeJournal = async (path: string, value: unknown): Promise<void> => {
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    };

    const tornDirectory = await makeRecoveryDirectory();
    const tornPath = join(
      tornDirectory,
      `process-${oldNamePrefix}-${"8".repeat(32)}.pending.json.create-${"9".repeat(32)}`,
    );
    await writeFile(tornPath, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({ recoveryDirectory: tornDirectory }))
      .resolves.toBeUndefined();
    expect(await Bun.file(tornPath).exists()).toBeFalse();

    const processGroupId = 2_000_000_009;
    const localDirectory = await makeRecoveryDirectory();
    const localPath = join(
      localDirectory,
      `process-${oldNamePrefix}-${"a".repeat(32)}.active-${String(processGroupId)}.json`,
    );
    await writeJournal(localPath, {
      createdAt: 1,
      ...custodyJournalFields(oldBoot),
      phase: "old-boot-local",
      processGroupId,
      schemaVersion: 2,
      state: "active",
    });
    const originalKill = process.kill.bind(process);
    let oldGroupObserved = false;
    const processKill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -processGroupId && signal === 0) {
        oldGroupObserved = true;
        return true;
      }
      return originalKill(pid, signal);
    });
    try {
      await expect(recoverBoundedProcessJournal({ recoveryDirectory: localDirectory }))
        .resolves.toBeUndefined();
    } finally {
      processKill.mockRestore();
    }
    expect(oldGroupObserved).toBeFalse();
    expect(await Bun.file(localPath).exists()).toBeFalse();

    const authorityDirectory = await makeRecoveryDirectory();
    const authorityPath = join(
      authorityDirectory,
      `authority-${oldNamePrefix}-${"b".repeat(32)}.json`,
    );
    await writeJournal(authorityPath, {
      architecture: "x64",
      bootId: oldBoot.custodyBootId,
      containment: "authority",
      createdAt: 1,
      ...custodyJournalFields(oldBoot),
      helperSha256: "a".repeat(64),
      initHostPid: 4_243,
      initPidNamespaceInode: "2",
      initStartTime: "1",
      outerPid: 4_242,
      outerStartTime: "1",
      phase: "old-boot-authority",
      schemaVersion: 2,
      state: "go_attempted",
    });
    await expect(recoverBoundedProcessJournal({ recoveryDirectory: authorityDirectory }))
      .resolves.toBeUndefined();
    expect(await Bun.file(authorityPath).exists()).toBeFalse();
  });

  test("blocks authority journals whose launch boot differs from their custody boot", async () => {
    const current = boundedProcessCustodyIdentityForTesting();
    const oldBoot = { ...current, custodyBootId: changeHex(current.custodyBootId) };
    const makeRecoveryDirectory = async (): Promise<string> => {
      const root = await makeRoot();
      const recoveryDirectory = join(root, "process-recovery");
      await mkdir(recoveryDirectory, { mode: 0o700 });
      return recoveryDirectory;
    };
    const writeAuthorityJournal = async (
      recoveryDirectory: string,
      custody: TestCustodyIdentity,
      launchBootId: string,
      token: string,
    ): Promise<string> => {
      const path = join(
        recoveryDirectory,
        `authority-${custodyNamePrefix(custody)}-${token.repeat(32)}.json`,
      );
      await writeFile(path, `${JSON.stringify({
        architecture: "x64",
        bootId: launchBootId,
        containment: "authority",
        createdAt: 1,
        ...custodyJournalFields(custody),
        helperSha256: "a".repeat(64),
        initHostPid: 4_243,
        initPidNamespaceInode: "2",
        initStartTime: "1",
        outerPid: 4_242,
        outerStartTime: "1",
        phase: "boot-identity-mismatch",
        schemaVersion: 2,
        state: "go_attempted",
      })}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };

    const currentCustodyDirectory = await makeRecoveryDirectory();
    const currentCustodyPath = await writeAuthorityJournal(
      currentCustodyDirectory,
      current,
      oldBoot.custodyBootId,
      "c",
    );
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: currentCustodyDirectory,
    })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:authority_entry_invalid",
    );
    expect(await Bun.file(currentCustodyPath).exists()).toBeTrue();

    const oldCustodyDirectory = await makeRecoveryDirectory();
    const oldCustodyPath = await writeAuthorityJournal(
      oldCustodyDirectory,
      oldBoot,
      current.custodyBootId,
      "d",
    );
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: oldCustodyDirectory,
    })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:authority_entry_invalid",
    );
    expect(await Bun.file(oldCustodyPath).exists()).toBeTrue();
  });

  test("local journal startup reconciles only provable create crash artifacts", async () => {
    const custodyIdentity = boundedProcessCustodyIdentityForTesting();
    const namePrefix = custodyNamePrefix(custodyIdentity);
    const makeRecoveryDirectory = async (): Promise<string> => {
      const root = await makeRoot();
      const directory = join(root, "process-recovery");
      await mkdir(directory, { mode: 0o700 });
      return directory;
    };
    const writeJournal = async (path: string, value: unknown): Promise<void> => {
      await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await chmod(path, 0o600);
    };
    const processGroupId = [2_000_000_003, 2_000_000_004, 2_000_000_005].find((candidate) => {
      try {
        process.kill(-candidate, 0);
        return false;
      } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    if (processGroupId === undefined) throw new Error("absent_process_group_not_found");
    const createdAt = 1;
    const phase = "local-crash-fixture";
    const pending = {
      createdAt,
      ...custodyJournalFields(custodyIdentity),
      phase,
      schemaVersion: 2,
      state: "pending",
    } as const;
    const active = {
      createdAt,
      ...custodyJournalFields(custodyIdentity),
      phase,
      processGroupId,
      schemaVersion: 2,
      state: "active",
    } as const;

    const directPendingDirectory = await makeRecoveryDirectory();
    const directPending = join(
      directPendingDirectory,
      `process-${namePrefix}-${"0".repeat(32)}.pending.json`,
    );
    await writeFile(directPending, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: directPendingDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(directPending).exists()).toBeFalse();

    const partialPendingDirectory = await makeRecoveryDirectory();
    const partialPending = join(
      partialPendingDirectory,
      `process-${namePrefix}-${"1".repeat(32)}.pending.json.create-${"2".repeat(32)}`,
    );
    await writeFile(partialPending, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: partialPendingDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(partialPending).exists()).toBeFalse();

    const linkedPendingDirectory = await makeRecoveryDirectory();
    const linkedPendingMain = join(
      linkedPendingDirectory,
      `process-${namePrefix}-${"3".repeat(32)}.pending.json`,
    );
    const linkedPendingCreate = `${linkedPendingMain}.create-${"4".repeat(32)}`;
    await writeJournal(linkedPendingCreate, pending);
    await link(linkedPendingCreate, linkedPendingMain);
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: linkedPendingDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(linkedPendingCreate).exists()).toBeFalse();
    expect(await Bun.file(linkedPendingMain).exists()).toBeFalse();

    const partialPromotionDirectory = await makeRecoveryDirectory();
    const partialPromotionActive = join(
      partialPromotionDirectory,
      `process-${namePrefix}-${"5".repeat(32)}.active-${String(processGroupId)}.json`,
    );
    const partialPromotionCreate = [
      partialPromotionActive,
      `.promote-${"6".repeat(32)}`,
      `.create-${"7".repeat(32)}`,
    ].join("");
    await writeJournal(partialPromotionActive, pending);
    await writeFile(partialPromotionCreate, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: partialPromotionDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(partialPromotionCreate).exists()).toBeFalse();
    expect(await Bun.file(partialPromotionActive).exists()).toBeFalse();

    const directPromotionDirectory = await makeRecoveryDirectory();
    const directPromotionActive = join(
      directPromotionDirectory,
      `process-${namePrefix}-${"6".repeat(32)}.active-${String(processGroupId)}.json`,
    );
    const directPromotion = `${directPromotionActive}.promote-${"7".repeat(32)}`;
    await writeJournal(directPromotionActive, pending);
    await writeFile(directPromotion, "{", { mode: 0o600 });
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: directPromotionDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(directPromotion).exists()).toBeFalse();
    expect(await Bun.file(directPromotionActive).exists()).toBeFalse();

    const linkedPromotionDirectory = await makeRecoveryDirectory();
    const linkedPromotionActive = join(
      linkedPromotionDirectory,
      `process-${namePrefix}-${"8".repeat(32)}.active-${String(processGroupId)}.json`,
    );
    const linkedPromotion = `${linkedPromotionActive}.promote-${"9".repeat(32)}`;
    const linkedPromotionCreate = `${linkedPromotion}.create-${"a".repeat(32)}`;
    await writeJournal(linkedPromotionActive, pending);
    await writeJournal(linkedPromotionCreate, active);
    await link(linkedPromotionCreate, linkedPromotion);
    await expect(recoverBoundedProcessJournal({
      recoveryDirectory: linkedPromotionDirectory,
    })).resolves.toBeUndefined();
    expect(await Bun.file(linkedPromotionCreate).exists()).toBeFalse();
    expect(await Bun.file(linkedPromotion).exists()).toBeFalse();
    expect(await Bun.file(linkedPromotionActive).exists()).toBeFalse();

    const duplicatePromotionDirectory = await makeRecoveryDirectory();
    const duplicatePromotionActive = join(
      duplicatePromotionDirectory,
      `process-${namePrefix}-${"9".repeat(32)}.active-${String(processGroupId)}.json`,
    );
    const firstDuplicatePromotion = `${duplicatePromotionActive}.promote-${"a".repeat(32)}`;
    const secondDuplicatePromotion = `${duplicatePromotionActive}.promote-${"b".repeat(32)}`;
    await writeJournal(duplicatePromotionActive, pending);
    await writeJournal(firstDuplicatePromotion, active);
    await writeJournal(secondDuplicatePromotion, active);
    const duplicatePromotionFailure = await recoverBoundedProcessJournal({
      recoveryDirectory: duplicatePromotionDirectory,
    }).then(
      () => new Error("duplicate_local_promotions_unexpectedly_recovered"),
      (error: unknown) => error,
    );
    expect(duplicatePromotionFailure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect((duplicatePromotionFailure as BoundedProcessRecoveryJournalError).recoveryPaths)
      .toEqual([
        duplicatePromotionActive,
        firstDuplicatePromotion,
        secondDuplicatePromotion,
      ].sort());
    expect(await Bun.file(duplicatePromotionActive).exists()).toBeTrue();
    expect(await Bun.file(firstDuplicatePromotion).exists()).toBeTrue();
    expect(await Bun.file(secondDuplicatePromotion).exists()).toBeTrue();

    const collisionDirectory = await makeRecoveryDirectory();
    const collisionMain = join(
      collisionDirectory,
      `process-${namePrefix}-${"b".repeat(32)}.pending.json`,
    );
    const collisionCreate = `${collisionMain}.create-${"c".repeat(32)}`;
    await writeJournal(collisionMain, pending);
    await writeJournal(collisionCreate, pending);
    const collisionFailure = await recoverBoundedProcessJournal({
      recoveryDirectory: collisionDirectory,
    }).then(
      () => new Error("colliding_local_transition_unexpectedly_recovered"),
      (error: unknown) => error,
    );
    expect(collisionFailure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect(await Bun.file(collisionMain).exists()).toBeTrue();
    expect(await Bun.file(collisionCreate).exists()).toBeTrue();

    const malformedDirectory = await makeRecoveryDirectory();
    const malformedActive = join(
      malformedDirectory,
      `process-${namePrefix}-${"c".repeat(32)}.active-${String(processGroupId)}.json`,
    );
    const malformedPromotion = `${malformedActive}.promote-${"d".repeat(32)}`;
    await writeJournal(malformedActive, pending);
    await writeFile(malformedPromotion, `${JSON.stringify({ invalid: true })}\n`, {
      mode: 0o600,
    });
    const malformedFailure = await recoverBoundedProcessJournal({
      recoveryDirectory: malformedDirectory,
    }).then(
      () => new Error("malformed_local_transition_unexpectedly_recovered"),
      (error: unknown) => error,
    );
    expect(malformedFailure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect(await Bun.file(malformedActive).exists()).toBeTrue();
    expect(await Bun.file(malformedPromotion).exists()).toBeTrue();

    const orphanDirectory = await makeRecoveryDirectory();
    const orphanCreate = join(
      orphanDirectory,
      [
        `process-${namePrefix}-${"e".repeat(32)}.active-${String(processGroupId)}.json`,
        `.promote-${"f".repeat(32)}`,
        `.create-${"0".repeat(32)}`,
      ].join(""),
    );
    await writeFile(orphanCreate, "{", { mode: 0o600 });
    const orphanFailure = await recoverBoundedProcessJournal({
      recoveryDirectory: orphanDirectory,
    }).then(
      () => new Error("orphaned_local_transition_unexpectedly_recovered"),
      (error: unknown) => error,
    );
    expect(orphanFailure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect(await Bun.file(orphanCreate).exists()).toBeTrue();
  });

  test("kills a TERM-resistant descendant before return without signaling another group", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const hostileMarker = join(root, "hostile-marker");
    const hostilePid = join(root, "hostile-pgid");
    const unrelatedMarker = join(root, "unrelated-marker");
    const hostileGrandchild = [
      "const { writeFileSync } = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `setTimeout(() => writeFileSync(${JSON.stringify(hostileMarker)}, 'late'), 250);`,
      "setInterval(() => undefined, 1000);",
    ].join(" ");
    const hostileLeader = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(hostilePid)}, String(process.pid));`,
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(hostileGrandchild)}], { stdio: 'ignore' });`,
      "child.unref();",
    ].join(" ");
    const unrelated = spawn(process.execPath, [
      "-e",
      [
        "const { writeFileSync } = require('node:fs');",
        `setTimeout(() => writeFileSync(${JSON.stringify(unrelatedMarker)}, 'safe'), 100);`,
      ].join(" "),
    ], { detached: true, stdio: "ignore" });
    unrelated.unref();

    const result = await runBoundedProcess({
      arguments: ["-e", hostileLeader],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: process.execPath,
      killSettlementMs: 25,
      outputMaximumBytes: 1_024,
      phase: "descendant-proof",
      terminationGraceMs: 25,
      timeoutMs: 1_000,
    }, { recoveryDirectory });
    expect(result.cleanup).toBe("proven");
    const processGroupId = -Number(await readFile(hostilePid, "utf8"));
    expect(() => process.kill(processGroupId, 0)).toThrow();
    expect(result.cleanup === "proven" ? result.exitCode : undefined).toBe(1);
    await Bun.sleep(350);
    expect(await Bun.file(hostileMarker).exists()).toBeFalse();
    expect(await Bun.file(unrelatedMarker).exists()).toBeTrue();
  });

  test("keeps local containment visibly limited to the recorded process group", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const escapedMarker = join(root, "escaped-marker");
    const escapedReady = join(root, "escaped-ready");
    const escapedRelease = join(root, "escaped-release");
    const escapedChild = [
      "const { existsSync, writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(escapedReady)}, 'ready');`,
      "const deadline = setTimeout(() => process.exit(2), 3000);",
      "const release = setInterval(() => {",
      `  if (!existsSync(${JSON.stringify(escapedRelease)})) return;`,
      "  clearInterval(release);",
      "  clearTimeout(deadline);",
      `  writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped');`,
      "}, 5);",
    ].join(" ");
    const settlement = await runBoundedProcess({
      arguments: [
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const { existsSync } = require('node:fs');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(escapedChild)}], { detached: true, stdio: 'ignore' });`,
          "child.unref();",
          "const deadline = setTimeout(() => process.exit(2), 1500);",
          "const ready = setInterval(() => {",
          `  if (!existsSync(${JSON.stringify(escapedReady)})) return;`,
          "  clearInterval(ready);",
          "  clearTimeout(deadline);",
          "}, 5);",
        ].join(" "),
      ],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: process.execPath,
      outputMaximumBytes: 1_024,
      phase: "local-scope-proof",
      terminationGraceMs: 25,
      timeoutMs: 2_000,
    }, { recoveryDirectory }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const readyAtReturn = await Bun.file(escapedReady).exists();
    await writeFile(escapedRelease, "release");
    const escapedAfterReturn = await waitForFile(escapedMarker, 2_000).then(
      () => true,
      () => false,
    );

    if ("error" in settlement) throw settlement.error;
    expect(settlement.result).toMatchObject({ cleanup: "proven", exitCode: 0 });
    expect(readyAtReturn).toBeTrue();
    expect(escapedAfterReturn).toBeTrue();
  });

  test("refuses an authority target before execution while the backend is unavailable", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const marker = join(root, "authority-target-must-not-run");
    const error = await runBoundedProcess({
      arguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      containment: "authority",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: process.execPath,
      outputMaximumBytes: 64,
      phase: "authority-preexec-proof",
      terminationGraceMs: 10,
      timeoutMs: 100,
    }, { forceAuthorityUnavailable: true, recoveryDirectory }).then(
      () => new Error("authority_target_unexpectedly_started"),
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(BoundedProcessContainmentUnavailableError);
    expect((error as BoundedProcessContainmentUnavailableError).reason).toBe(
      process.platform === "linux"
        ? "authority_backend_unavailable"
        : "authority_unsupported_platform",
    );
    await Bun.sleep(25);
    expect(await Bun.file(marker).exists()).toBeFalse();
    expect(await Bun.file(recoveryDirectory).exists()).toBeFalse();
  });

  test("caps output and settles a timed-out TERM-resistant leader after KILL", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const startedAt = performance.now();
    const result = await runBoundedProcess({
      arguments: [
        "-c",
        `trap '' TERM\nprintf '%s' '${"x".repeat(4_096)}'\nwhile :; do sleep 1; done`,
      ],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: "/bin/sh",
      killSettlementMs: 25,
      outputMaximumBytes: 64,
      phase: "output-cap-proof",
      terminationGraceMs: 25,
      timeoutMs: 500,
    }, { recoveryDirectory });
    expect(result.cleanup).toBe("proven");
    expect(result.cleanup === "proven" ? result.exitCode : undefined).toBe(1);
    expect(result.stdout.byteLength).toBeLessThanOrEqual(64);
    expect(result.stderr.byteLength).toBeLessThanOrEqual(64);
    expect(result.stdout.byteLength + result.stderr.byteLength).toBeLessThanOrEqual(64);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("reports an unproven cleanup distinctly at the hard settlement deadline", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const originalKill = process.kill.bind(process);
    let killed = false;
    const processKill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === "SIGKILL") {
        killed = true;
        return originalKill(pid, signal);
      }
      if (signal === 0 && killed && pid < 0) return true;
      return originalKill(pid, signal);
    });
    try {
      const result = await runBoundedProcess({
        arguments: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => undefined, 1000);"],
        containment: "local",
        cwd: import.meta.dir,
        environment: { PATH: process.env.PATH },
        executable: process.execPath,
        killSettlementMs: 10,
        outputMaximumBytes: 64,
        phase: "cleanup-proof",
        terminationGraceMs: 10,
        timeoutMs: 100,
      }, { recoveryDirectory });
      expect(result.cleanup).toBe("unproven");
      expect(result.cleanup === "unproven" ? result.phase : undefined).toBe("cleanup-proof");
      expect(
        result.cleanup === "unproven" && "processGroupId" in result
          ? result.processGroupId
          : undefined,
      ).toBeGreaterThan(1);
      expect(() => requireBoundedProcessCleanup(result))
        .toThrow("bounded_process_cleanup_unproven:cleanup-proof:");
      const recoveryPath = result.cleanup === "unproven" ? result.recoveryPath : "";
      expect(await Bun.file(recoveryPath).exists()).toBeTrue();
      await expect(recoverBoundedProcessJournal({ recoveryDirectory }))
        .rejects.toThrow("bounded_process_cleanup_unproven:cleanup-proof:");
    } finally {
      processKill.mockRestore();
      await recoverBoundedProcessJournal({ recoveryDirectory }).catch(() => undefined);
    }
  });

  test("rejects a missing or invalid phase before spawning", async () => {
    const root = await makeRoot();
    const marker = join(root, "must-not-run");
    const result = await runBoundedProcess({
      arguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: process.execPath,
      outputMaximumBytes: 64,
      phase: "INVALID PHASE",
      terminationGraceMs: 10,
      timeoutMs: 100,
    });
    expect(result).toMatchObject({ cleanup: "proven", exitCode: 1 });
    await Bun.sleep(25);
    expect(await Bun.file(marker).exists()).toBeFalse();
    expect(() => new BoundedProcessCleanupUnprovenError(0, "valid-phase"))
      .toThrow("bounded_process_recovery_identity_invalid");
  });

  test("never releases the target when active journal promotion fails after spawn", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const marker = join(root, "must-not-run-after-journal-failure");
    await mkdir(recoveryDirectory, { mode: 0o700 });
    await expect(runBoundedProcess({
      arguments: [marker],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: "/usr/bin/touch",
      outputMaximumBytes: 64,
      phase: "journal-promotion-proof",
      terminationGraceMs: 10,
      timeoutMs: 100,
    }, {
      beforeJournalPromotion: () => chmodSync(recoveryDirectory, 0o777),
      recoveryDirectory,
    })).rejects.toThrow("bounded_process_recovery_journal_blocked:directory_invalid");
    await Bun.sleep(25);
    expect(await Bun.file(marker).exists()).toBeFalse();
  });

  test("passes every stdin byte after the durable release frame", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const stdin = `\nalpha\0beta\n🦎 ${"x".repeat(256 * 1_024)}\nTAIL`;
    const result = await runBoundedProcess({
      arguments: [],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: "/bin/cat",
      outputMaximumBytes: Buffer.byteLength(stdin),
      phase: "stdin-release-frame-proof",
      stdin,
      terminationGraceMs: 25,
      timeoutMs: 2_000,
    }, { recoveryDirectory });

    expect(result).toMatchObject({ cleanup: "proven", exitCode: 0 });
    expect(result.stdout.equals(Buffer.from(stdin, "utf8"))).toBeTrue();
    expect(result.stderr.byteLength).toBe(0);
  });

  test("keeps the release channel stable across rapid child completions", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    for (let invocation = 0; invocation < 64; invocation += 1) {
      const result = await runBoundedProcess({
        arguments: [],
        containment: "local",
        cwd: root,
        environment: { PATH: process.env.PATH },
        executable: "/usr/bin/true",
        outputMaximumBytes: 64,
        phase: "rapid-release-frame-proof",
        terminationGraceMs: 10,
        timeoutMs: 500,
      }, { recoveryDirectory });
      expect(result).toMatchObject({ cleanup: "proven", exitCode: 0 });
    }
  });

  test("serializes recovery against the pending-to-active gate transition", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    await mkdir(recoveryDirectory, { mode: 0o700 });
    let recoverySettlement: Promise<boolean> | undefined;
    const result = await runBoundedProcess({
      arguments: [],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: "/usr/bin/true",
      outputMaximumBytes: 64,
      phase: "journal-transition-proof",
      terminationGraceMs: 10,
      timeoutMs: 100,
    }, {
      beforeJournalPromotion: () => {
        recoverySettlement = recoverBoundedProcessJournal({ recoveryDirectory }).then(
          () => false,
          (error: unknown) => error instanceof Error
            && error.message.endsWith(":concurrent_invocation"),
        );
      },
      recoveryDirectory,
    });
    expect(recoverySettlement).toBeDefined();
    expect(await recoverySettlement).toBeTrue();
    expect(result).toMatchObject({ cleanup: "proven", exitCode: 0 });
    await expect(recoverBoundedProcessJournal({ recoveryDirectory })).resolves.toBeUndefined();
  });

  test("does not release a second payload while an earlier shared-custody child remains live", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const firstMarker = join(root, "first-payload-started");
    const secondMarker = join(root, "second-payload-started");
    await mkdir(recoveryDirectory, { mode: 0o700 });
    const first = runBoundedProcess({
      arguments: [
        "-e",
        [
          "const { writeFileSync } = require('node:fs');",
          `writeFileSync(${JSON.stringify(firstMarker)}, 'started');`,
          "setInterval(() => undefined, 1_000);",
        ].join(" "),
      ],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: process.execPath,
      killSettlementMs: 25,
      outputMaximumBytes: 64,
      phase: "first-custody-proof",
      terminationGraceMs: 25,
      timeoutMs: 1_500,
    }, { recoveryDirectory });
    await waitForFile(firstMarker, 1_000);
    expect(await Bun.file(firstMarker).exists()).toBeTrue();

    let firstSettled = false;
    void first.finally(() => {
      firstSettled = true;
    });
    const second = runBoundedProcess({
      arguments: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(secondMarker)}, 'started')`,
      ],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: process.execPath,
      killSettlementMs: 25,
      outputMaximumBytes: 64,
      phase: "second-custody-proof",
      terminationGraceMs: 25,
      timeoutMs: 250,
    }, { recoveryDirectory });
    const secondSettlement = second.then(
      () => "completed" as const,
      () => "rejected" as const,
    );
    await Bun.sleep(50);
    const secondExecutedDuringFirstCustody = await Bun.file(secondMarker).exists();
    const firstResult = await first;
    const secondResult = await secondSettlement;

    expect(firstSettled).toBeTrue();
    expect(firstResult).toMatchObject({ cleanup: "proven", exitCode: 124 });
    expect(secondExecutedDuringFirstCustody).toBeFalse();
    expect(["completed", "rejected"]).toContain(secondResult);
  });

  test("recovers a matching crash-promotion pair only after its named process group is absent", async () => {
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    await mkdir(recoveryDirectory, { mode: 0o700 });
    const processGroupId = [2_000_000_000, 2_000_000_001, 2_000_000_002].find((candidate) => {
      try {
        process.kill(-candidate, 0);
        return false;
      } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    });
    if (processGroupId === undefined) throw new Error("absent_process_group_not_found");
    const custodyIdentity = boundedProcessCustodyIdentityForTesting();
    const namePrefix = custodyNamePrefix(custodyIdentity);
    const token = "a".repeat(32);
    const promotionToken = "b".repeat(32);
    const activePath = join(
      recoveryDirectory,
      `process-${namePrefix}-${token}.active-${String(processGroupId)}.json`,
    );
    const promotionPath = `${activePath}.promote-${promotionToken}`;
    const createdAt = Date.now();
    const phase = "crash-promotion-proof";
    await writeFile(activePath, `${JSON.stringify({
      createdAt,
      ...custodyJournalFields(custodyIdentity),
      phase,
      schemaVersion: 2,
      state: "pending",
    })}\n`, { mode: 0o600 });
    await writeFile(promotionPath, `${JSON.stringify({
      createdAt,
      ...custodyJournalFields(custodyIdentity),
      phase,
      processGroupId,
      schemaVersion: 2,
      state: "active",
    })}\n`, { mode: 0o600 });
    await chmod(activePath, 0o600);
    await chmod(promotionPath, 0o600);

    const originalKill = process.kill.bind(process);
    const processKill = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -processGroupId && signal === 0) return true;
      return originalKill(pid, signal);
    });
    try {
      await expect(recoverBoundedProcessJournal({ recoveryDirectory }))
        .rejects.toThrow(`bounded_process_cleanup_unproven:${phase}:local:${String(processGroupId)}`);
      expect(await Bun.file(activePath).exists()).toBeTrue();
      expect(await Bun.file(promotionPath).exists()).toBeTrue();
    } finally {
      processKill.mockRestore();
    }

    await expect(recoverBoundedProcessJournal({ recoveryDirectory })).resolves.toBeUndefined();
    expect(await Bun.file(activePath).exists()).toBeFalse();
    expect(await Bun.file(promotionPath).exists()).toBeFalse();
  });

  test("never spawns through a mode-private journal directory with a dangerous Darwin ACL", async () => {
    if (process.platform !== "darwin") return;
    const root = await makeRoot();
    const recoveryDirectory = join(root, "process-recovery");
    const marker = join(root, "must-not-run-through-acl");
    await mkdir(recoveryDirectory, { mode: 0o700 });
    const acl = spawnSync("/bin/chmod", [
      "+a",
      "everyone allow list,search,add_file,add_subdirectory,delete_child,file_inherit,directory_inherit",
      recoveryDirectory,
    ], { encoding: "utf8" });
    expect(acl.status).toBe(0);
    await expect(runBoundedProcess({
      arguments: [marker],
      containment: "local",
      cwd: root,
      environment: { PATH: process.env.PATH },
      executable: "/usr/bin/touch",
      outputMaximumBytes: 64,
      phase: "journal-acl-proof",
      terminationGraceMs: 10,
      timeoutMs: 100,
    }, { recoveryDirectory })).rejects.toThrow(
      "bounded_process_recovery_journal_blocked:directory_acl_invalid",
    );
    expect(await Bun.file(marker).exists()).toBeFalse();
  });

  test("poisons one invocation after cleanup becomes indeterminate", async () => {
    const guard = new BoundedProcessInvocationGuard();
    const cleanup = new BoundedProcessCleanupUnprovenError(43_210, "provider-write");
    await expect(guard.observe(async () => {
      throw cleanup;
    })).rejects.toBe(cleanup);
    let invoked = false;
    await expect(guard.observe(async () => {
      invoked = true;
      return "unsafe";
    })).rejects.toBe(cleanup);
    expect(invoked).toBeFalse();
  });

  test("poisons queued and later operations after a recovery journal blocks", async () => {
    const guard = new BoundedProcessInvocationGuard();
    const journal = new BoundedProcessRecoveryJournalError(
      ["/private/operator/process-recovery/authority-queued.json"],
      "authority_recovery_required",
    );
    let laterInvoked = false;
    const first = guard.observe(async () => { throw journal; });
    const queued = guard.observe(async () => {
      laterInvoked = true;
      return "unsafe";
    });
    void first.catch(() => undefined);
    void queued.catch(() => undefined);
    await expect(first).rejects.toBe(journal);
    await expect(queued).rejects.toBe(journal);
    await expect(guard.observe(async () => {
      laterInvoked = true;
      return "unsafe";
    })).rejects.toBe(journal);
    expect(laterInvoked).toBeFalse();
  });

  test("immutably augments a blocked journal with every retained recovery path", async () => {
    const guard = new BoundedProcessInvocationGuard();
    const journal = new BoundedProcessRecoveryJournalError(
      ["/private/operator/process-recovery/authority-original.json"],
      "authority_recovery_required",
    );
    guard.retainRecoveryPath("/private/operator/release/candidate.json");

    let firstFailure: unknown;
    try {
      await guard.observe(async () => { throw journal; });
    } catch (error: unknown) {
      firstFailure = error;
    }
    expect(firstFailure).toBeInstanceOf(BoundedProcessRecoveryJournalError);
    expect((firstFailure as BoundedProcessRecoveryJournalError).recoveryPaths).toEqual([
      "/private/operator/process-recovery/authority-original.json",
      "/private/operator/release/candidate.json",
    ]);
    expect(journal.recoveryPaths).toEqual([
      "/private/operator/process-recovery/authority-original.json",
    ]);

    guard.retainRecoveryPath("/private/operator/release/temporary");
    let invoked = false;
    await expect(guard.observe(async () => {
      invoked = true;
    })).rejects.toMatchObject({
      reason: "authority_recovery_required",
      recoveryPaths: [
        "/private/operator/process-recovery/authority-original.json",
        "/private/operator/release/candidate.json",
        "/private/operator/release/temporary",
      ],
    });
    expect(invoked).toBeFalse();
  });

  test("settles every concurrent branch and gives cleanup uncertainty precedence", async () => {
    const events: string[] = [];
    const cleanup = new BoundedProcessCleanupUnprovenError(43_211, "provider-read");
    const secondCleanup = new BoundedProcessCleanupUnprovenError(43_212, "provider-write");
    const operations = [
      Promise.reject(new Error("ordinary_failure")),
      Bun.sleep(5).then(() => {
        events.push("cleanup");
        throw cleanup;
      }),
      Bun.sleep(10).then(() => {
        events.push("second_cleanup");
        throw secondCleanup;
      }),
      Bun.sleep(15).then(() => {
        events.push("sibling_settled");
        return 4;
      }),
    ] as const;
    await expect(settleConcurrentOperations(operations)).rejects.toBe(cleanup);
    expect(events).toEqual(["cleanup", "second_cleanup", "sibling_settled"]);
    expect(cleanup.processes).toEqual([
      {
        phase: "provider-read",
        recoveryIdentity: { containment: "local", processGroupId: 43_211 },
      },
      {
        phase: "provider-write",
        recoveryIdentity: { containment: "local", processGroupId: 43_212 },
      },
    ]);
  });

  test("gives a blocked recovery journal precedence over ordinary concurrent failures", async () => {
    const journal = new BoundedProcessRecoveryJournalError(
      ["/private/operator/process-recovery/authority-concurrent.json"],
      "authority_recovery_required",
    );
    await expect(settleConcurrentOperations([
      Promise.reject(new Error("ordinary_failure")),
      Promise.reject(journal),
      Promise.resolve(4),
    ] as const)).rejects.toBe(journal);
  });
});
