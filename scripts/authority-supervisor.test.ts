import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const supervisorSource = async (): Promise<string> =>
  readFile(join(import.meta.dir, "authority-supervisor.zig"), "utf8");

test("authority supervisor keeps control separate from target stdio", async () => {
  const source = await supervisorSource();

  expect(source).toContain("--control-socket");
  expect(source).toContain("--nonce");
  expect(source).toContain("HRA_AUTHORITY_SUPERVISOR/1 READY");
  expect(source).toContain("HRA_AUTHORITY_SUPERVISOR/1 CLEAN");
  expect(source).toContain("init_host_pid");
  expect(source).toContain("init_start_time");
  expect(source).toContain("init_pid_namespace_inode");
  expect(source).toContain("recovery_pid");
  expect(source).toContain("recovery_start_time");
  expect(source).toContain("const InitReadyRecord = extern struct");
  expect(source).toContain("target_argv = @ptrCast(args.ptr + 6)");
  expect(source).toContain("standardDescriptorsOpen()");
  expect(source).toContain("closeRangeExcept(control_fd, scratch_fd_minimum - 1, input_control)");
  expect(source).toContain("failControlAndExit(fds.control, nonce, err)");
  expect(source).toContain("closeRange(3, std.math.maxInt(i32))");
  expect(source).toContain("clearCloseOnExec(0)");
  expect(source).toContain("clearCloseOnExec(1)");
  expect(source).toContain("clearCloseOnExec(2)");
});

test("authority supervisor establishes a private, fail-closed Linux custody boundary", async () => {
  const source = await supervisorSource();

  expect(source).toContain("linux.CLONE.NEWUSER | linux.CLONE.NEWPID | linux.CLONE.NEWNS");
  expect(source).toContain("linux.MS.REC | linux.MS.PRIVATE");
  expect(source).not.toContain('linux.umount2("/proc"');
  expect(source).toContain('linux.mount("proc", "/proc", "proc", flags, 0)');
  expect(source).toContain("linux.PR.SET_PDEATHSIG");
  expect(source).toContain("try assertParentStill(launch_parent_pid)");
  expect(source).toContain("assertLifelineStillOpen(fds.lifeline_read)");
  expect(source).toContain("linux.PR.SET_DUMPABLE");
  expect(source).toContain("linux.PR.SET_NO_NEW_PRIVS");
  expect(source).toContain("linux.PR.CAPBSET_DROP");
});

test("authority supervisor conceals durable custody before READY without a cwd escape", async () => {
  const source = await supervisorSource();
  const launchStart = source.indexOf("fn runLaunch(");
  const launchEnd = source.indexOf("fn runPrepared(", launchStart);
  const launch = source.slice(launchStart, launchEnd);
  const initStart = source.indexOf("fn initMain(");
  const targetStart = source.indexOf("fn targetMain(", initStart);
  const init = source.slice(initStart, targetStart);
  const targetEnd = source.indexOf("fn unshareAndMapCurrentIdentity(", targetStart);
  const target = source.slice(targetStart, targetEnd);

  expect(source).toContain('const authority_socket_prefix = ".authority-control-"');
  expect(source).toContain("recoveryDirectoryFromControlSocket(control_socket_path)");
  expect(source).toContain("fn concealRecoveryDirectory(directory: []const u8)");
  expect(source).toContain("fn rejectRecoveryDirectoryMountAliases(directory: []const u8)");
  expect(source).toContain("linux.MS.RDONLY | linux.MS.NOSUID | linux.MS.NODEV | linux.MS.NOEXEC");
  expect(source).toContain('"mode=000,size=4096,nr_inodes=1"');
  expect(launch.indexOf("readCurrentWorkingDirectory(&cwd_buffer)")).toBeLessThan(
    launch.indexOf('linux.chdir("/")'),
  );
  expect(launch.indexOf('linux.chdir("/")')).toBeLessThan(
    launch.indexOf("unshareAndMapCurrentIdentity(host_uid, host_gid)"),
  );
  expect(init.indexOf("rejectRecoveryDirectoryMountAliases(config.recovery_directory)")).toBeLessThan(
    init.indexOf("concealRecoveryDirectory(config.recovery_directory)"),
  );
  expect(init.indexOf("concealRecoveryDirectory(config.recovery_directory)")).toBeLessThan(
    init.indexOf("const init_identity = InitReadyRecord"),
  );
  expect(target.indexOf("hardenTargetCredentials()")).toBeLessThan(
    target.indexOf("linux.chdir(config.target_cwd)"),
  );
  expect(target.indexOf("linux.chdir(config.target_cwd)")).toBeLessThan(
    target.indexOf("linux.execve"),
  );
});

test("authority supervisor emits CLEAN only after reaping namespace PID 1", async () => {
  const source = await supervisorSource();
  const reap = source.indexOf("const init_status = maybe_init_status.?");
  const clean = source.indexOf("try emitClean(fds.control, nonce, exit_code)");

  expect(reap).toBeGreaterThanOrEqual(0);
  expect(clean).toBeGreaterThan(reap);
  expect(source).toContain("linux.exit(@intCast(exit_code))");
});

test("authority supervisor rejects inherited mount aliases before concealing custody", async () => {
  const source = await supervisorSource();
  const preflightStart = source.indexOf("fn rejectRecoveryDirectoryMountAliases(");
  const concealStart = source.indexOf("fn concealRecoveryDirectory(");
  const preflight = source.slice(preflightStart, concealStart);

  expect(preflightStart).toBeGreaterThanOrEqual(0);
  expect(concealStart).toBeGreaterThan(preflightStart);
  expect(source).toContain('"/proc/self/mountinfo"');
  expect(source).toContain("mountinfo_max_bytes = 1_048_576");
  expect(source).toContain("mountinfo_max_lines = 4_096");
  expect(source).toContain("mountinfo_max_line_bytes = 8_192");
  expect(preflight).toContain("inspectMountInfoForRecoveryAliases(first, directory");
  expect(preflight).toContain("if (!std.mem.eql(u8, first, second)) return error.MountTableInvalid");
  expect(preflight).toContain("statMountpointDirectoryIdentity(mountpoint)");
  expect(preflight).toContain("mountpointAliasesRecoveryAncestor");
  expect(source).toContain("device_major");
  expect(source).toContain("device_minor");
  expect(source).toContain("inode");
  expect(source).toContain("return error.MountAliasUnsafe");
  expect(source).toContain('"040"');
  expect(source).toContain('"011"');
  expect(source).toContain('"012"');
  expect(source).toContain('"134"');
  expect(source).toContain("valid mountinfo fixture rejected");
  expect(source).toContain("unknown mountinfo escape accepted");
  expect(source).toContain("distinct-path same-inode mount alias accepted");
});

test("launch deadline is authenticated and independently enforced by outer supervisor and PID 1", async () => {
  const source = await supervisorSource();
  const preparedStart = source.indexOf("fn runPrepared(");
  const recoveryStart = source.indexOf("fn runRecovery(", preparedStart);
  const prepared = source.slice(preparedStart, recoveryStart);
  const initStart = source.indexOf("fn initMain(");
  const targetStart = source.indexOf("fn targetMain(", initStart);
  const init = source.slice(initStart, targetStart);

  expect(source).toContain("ns_init_pid=1 monotonic_ms={d}");
  expect(source).toContain('const deadline_field = " deadline_monotonic_ms="');
  expect(source).toContain("const StartRecord = extern struct");
  expect(source).toContain("deadline_monotonic_ms: u64");
  expect(prepared).toContain("const deadline_monotonic_ms = readGo(fds.control, nonce)");
  expect(prepared).toContain("readTargetResultUntil(fds.result_read, deadline_monotonic_ms)");
  expect(prepared).toContain("waitForPidUntil(init_pid, deadline_monotonic_ms)");
  expect(prepared).toContain("completeLaunchDeadlineExpiry(init_pid, fds, nonce)");
  expect(init).toContain("waitForStartOrParentDeath(fds.start_read, fds.lifeline_read)");
  expect(init).toContain("waitForPidUntil(target_pid, deadline_monotonic_ms)");
  expect(init).toContain("killAndReap(target_pid)");
  expect(source).toContain("if (record.deadline_monotonic_ms <= now) return error.ControlProtocolRejected");
  expect(source).toContain("if (deadline <= now) return error.ControlProtocolRejected");
  expect(source).toContain("try killAndReap(init_pid)");
  expect(source).toContain("try emitClean(fds.control, nonce, launch_timeout_exit_code)");
  expect(source).toContain("launch_timeout_exit_code: u8 = 124");
  expect(source).toContain("return @as(u32, launch_timeout_exit_code) << 8");
});

test("READY journals an exact namespace-init identity before GO", async () => {
  const source = await supervisorSource();
  const start = source.indexOf("fn runPrepared(");
  const end = source.indexOf("fn runRecovery(", start);
  const prepared = source.slice(start, end);
  const initStart = source.indexOf("fn initMain(");
  const targetStart = source.indexOf("fn targetMain(", initStart);
  const init = source.slice(initStart, targetStart);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(initStart).toBeGreaterThanOrEqual(0);
  expect(targetStart).toBeGreaterThan(initStart);
  expect(prepared).toContain("var ready: InitReadyRecord = undefined");
  expect(prepared).toContain("const init_identity = InitIdentity");
  expect(prepared).toContain(".host_pid = init_pid");
  expect(prepared).toContain("try emitReady(fds.control, nonce, identity, outer_pgid, init_identity, ready_monotonic_ms)");
  expect(prepared.indexOf("readExactly(fds.ready_read, std.mem.asBytes(&ready))")).toBeLessThan(
    prepared.indexOf("try emitReady(fds.control, nonce, identity, outer_pgid, init_identity, ready_monotonic_ms)"),
  );
  expect(init).toContain("mountFreshProc()");
  expect(init).toContain("readProcStartTime(linux.getpid(), error.InitNotReady)");
  expect(init).toContain("readPidNamespaceInode(linux.getpid(), error.InitNotReady)");
  expect(init.indexOf("mountFreshProc()")).toBeLessThan(init.indexOf("const init_identity = InitReadyRecord"));
  expect(init.indexOf("const init_identity = InitReadyRecord")).toBeLessThan(init.indexOf("waitForStartOrParentDeath"));
});

test("launch maps its caller identity before becoming nondumpable", async () => {
  const source = await supervisorSource();
  const mainStart = source.indexOf("pub fn main(");
  const mainEnd = source.indexOf("fn parseConfig(", mainStart);
  const main = source.slice(mainStart, mainEnd);
  const launchStart = source.indexOf("fn runLaunch(");
  const launchEnd = source.indexOf("fn runPrepared(", launchStart);
  const launch = source.slice(launchStart, launchEnd);
  const earlyRecoveryClassification =
    'if (args.len > 5 and std.mem.eql(u8, std.mem.span(args[5]), "--terminate"))';
  const earlyRecoveryHardening = "setUndumpable() catch linux.exit(1)";

  expect(mainStart).toBeGreaterThanOrEqual(0);
  expect(mainEnd).toBeGreaterThan(mainStart);
  expect(launchStart).toBeGreaterThanOrEqual(0);
  expect(launchEnd).toBeGreaterThan(launchStart);
  expect(main).toContain("const args = init.args.vector");
  expect(main).toContain(earlyRecoveryClassification);
  expect(main.indexOf(earlyRecoveryClassification)).toBeLessThan(main.indexOf(earlyRecoveryHardening));
  expect(main.indexOf(earlyRecoveryHardening)).toBeLessThan(main.indexOf("const config = parseConfig(init)"));
  expect(main.match(/setUndumpable\(\)/g)).toHaveLength(1);
  expect(launch.indexOf("try unshareAndMapCurrentIdentity(host_uid, host_gid)")).toBeLessThan(
    launch.indexOf("try setUndumpable()"),
  );
  expect(launch.indexOf("try setUndumpable()")).toBeLessThan(
    launch.indexOf("const identity = LaunchIdentity"),
  );
});

test("recovery validates both pidfd-bound identities before signaling the outer helper", async () => {
  const source = await supervisorSource();
  const start = source.indexOf("fn runRecovery(");
  const end = source.indexOf("const RecoveryMethod", start);
  const recovery = source.slice(start, end);

  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(source).toContain("--terminate");
  expect(source).toContain("--outer-pid");
  expect(source).toContain("--outer-start-time");
  expect(source).toContain("--boot-id");
  expect(source).toContain("--init-host-pid");
  expect(source).toContain("--init-start-time");
  expect(source).toContain("--init-pid-namespace-inode");
  expect(recovery).toContain("const recovery_identity = RecoveryHelperIdentity");
  expect(recovery).toContain("readProcStartTime(linux.getpid(), error.RecoverySelfIdentityUnavailable)");
  expect(recovery).toContain("emitRecoveryReady(socket, nonce, recovery_identity, recovery)");
  expect(recovery).toContain("readRecoveryGo(socket, nonce)");
  expect(recovery).toContain("linux.pidfd_open(recovery.outer_pid, 0)");
  expect(recovery).toContain("linux.pidfd_open(recovery.init_host_pid, 0)");
  expect(recovery).toContain("linux.pidfd_send_signal(outer_pidfd, .KILL, null, 0)");
  expect(recovery).toContain("waitForPidfdExit(outer_pidfd, deadline)");
  expect(recovery).toContain("waitForPidfdExit(init_pidfd, deadline)");
  expect(recovery).toContain("emitRecoveryClean(socket, nonce, recovery_identity, recovery, method)");
  expect(recovery).not.toContain("linux.kill(");
  expect(recovery.indexOf("linux.pidfd_open(recovery.outer_pid, 0)")).toBeLessThan(
    recovery.indexOf("linux.pidfd_open(recovery.init_host_pid, 0)"),
  );
  expect(recovery.indexOf("linux.pidfd_open(recovery.init_host_pid, 0)")).toBeLessThan(
    recovery.indexOf("try verifyRecoveryIdentity(recovery)"),
  );
  expect(recovery.indexOf("try verifyRecoveryIdentity(recovery)")).toBeLessThan(
    recovery.indexOf("emitRecoveryReady(socket, nonce, recovery_identity, recovery)"),
  );
  expect(recovery.indexOf("readRecoveryGo(socket, nonce)")).toBeLessThan(
    recovery.lastIndexOf("try verifyRecoveryIdentity(recovery)"),
  );
  expect(recovery.lastIndexOf("try verifyRecoveryIdentity(recovery)")).toBeLessThan(
    recovery.indexOf("linux.pidfd_send_signal(outer_pidfd, .KILL, null, 0)"),
  );
  expect(recovery.indexOf("linux.pidfd_send_signal(outer_pidfd, .KILL, null, 0)")).toBeLessThan(
    recovery.indexOf("waitForPidfdExit(outer_pidfd, deadline)"),
  );
  expect(recovery.indexOf("waitForPidfdExit(outer_pidfd, deadline)")).toBeLessThan(
    recovery.indexOf("waitForPidfdExit(init_pidfd, deadline)"),
  );
  expect(recovery.indexOf("waitForPidfdExit(init_pidfd, deadline)")).toBeLessThan(
    recovery.indexOf("emitRecoveryClean(socket, nonce, recovery_identity, recovery, method)"),
  );
  expect(recovery.indexOf("try setUndumpable()")).toBeLessThan(
    recovery.indexOf("const recovery_identity = RecoveryHelperIdentity"),
  );
  expect(recovery.indexOf("const recovery_identity = RecoveryHelperIdentity")).toBeLessThan(
    recovery.indexOf("emitRecoveryReady(socket, nonce, recovery_identity, recovery)"),
  );
});

test("recovery binds the sealed init namespace while revalidating both process identities", async () => {
  const source = await supervisorSource();
  const identityStart = source.indexOf("fn verifyRecoveryIdentity(");
  const identityEnd = source.indexOf("fn verifyProcStartTime(", identityStart);
  const identity = source.slice(identityStart, identityEnd);

  expect(identityStart).toBeGreaterThanOrEqual(0);
  expect(identityEnd).toBeGreaterThan(identityStart);
  expect(source).toContain('"/proc/sys/kernel/random/boot_id"');
  expect(source).toContain('"/proc/{d}/stat"');
  expect(source).toContain('"/proc/{d}/ns/pid"');
  expect(source).toContain("const boot_id_length = 36");
  expect(source).toContain("closing_parenthesis = index");
  expect(source).toContain("if (token_index == 19)");
  expect(source).toContain("fn parsePidNamespaceInode(target: []const u8) ?u64");
  expect(source).toContain("RecoveryInitPidfdUnavailable");
  expect(source).toContain("RecoveryInitProcUnavailable");
  expect(source).toContain("RecoveryInitStartTimeMismatch");
  expect(source).toContain("RecoveryInitNotLive");
  expect(source).toContain("RecoverySelfIdentityUnavailable");
  expect(identity).toContain("readProcStartTime(recovery.init_host_pid, error.RecoveryInitProcUnavailable)");
  expect(identity).toContain("init_start_time != recovery.init_start_time");
  expect(identity).not.toContain("readPidNamespaceInode(");
  expect(source).not.toContain("RecoveryInitNamespaceMismatch");
  expect(source).toContain("PID-namespace membership cannot change during a task's lifetime");
  expect(source).toContain(".pid_namespace_inode = readPidNamespaceInode(linux.getpid(), error.InitNotReady)");
  expect(source).toContain("recovery_exit_timeout_ms: u64 = 5_000");
  expect(source).toContain("RECOVERY_CLEAN");
  expect(source).toContain("RECOVERY_READY nonce={s} recovery_pid={d} recovery_start_time={d} outer_pid={d} outer_start_time={d} init_host_pid={d} init_start_time={d} init_pid_namespace_inode={d}");
  expect(source).toContain("RECOVERY_CLEAN nonce={s} recovery_pid={d} recovery_start_time={d} outer_pid={d} outer_start_time={d} boot_id={s} init_host_pid={d} init_start_time={d} init_pid_namespace_inode={d} method={s}");
  expect(source).toContain("never claims remote provider-effect rollback");
  expect(source).toContain("Before RECOVERY_GO, HRA must verify recovery_pid and recovery_start_time");
});
