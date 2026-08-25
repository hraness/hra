//! Linux-only descendant-lifetime custody for trusted provider commands.
//!
//! This repository-local helper is deliberately not a general sandbox. The
//! target retains its cwd, environment, ordinary filesystem access, and
//! ordinary stdio. The one filesystem exception is HRA's recovery directory,
//! which is concealed behind an empty read-only mount before READY so the
//! target cannot replace the journal lock or tamper with durable custody. A
//! strict, stable mountinfo preflight first rejects inherited bind aliases of
//! that directory or any ancestor, which would otherwise bypass one overmount.
//! Every descendant that the trusted target starts lives in one nested PID
//! namespace and is gone before the helper reports CLEAN.
//!
//! Invocation:
//!
//!   authority-supervisor \
//!     --control-socket /absolute/0700-recovery-dir/control.sock \
//!     --nonce 32-lowercase-hex-characters \
//!     -- /absolute/program arg...
//!
//! Recovery invocation uses the same authenticated socket protocol:
//!
//!   authority-supervisor --control-socket /absolute/0700-recovery-dir/control.sock \
//!     --nonce 32-lowercase-hex-characters --terminate \
//!     --outer-pid 2..2147483647 --outer-start-time /proc-stat-clock-ticks \
//!     --boot-id canonical-lowercase-uuid \
//!     --init-host-pid 2..2147483647 --init-start-time /proc-stat-clock-ticks \
//!     --init-pid-namespace-inode positive-decimal-inode
//!
//! HRA owns the Unix socket beneath a held 0700 recovery directory. It verifies
//! the nonce in READY, sends the matching GO frame, then requires both CLEAN
//! and the outer helper child exit before accepting cleanup proof. The target
//! never inherits the control socket or helper arguments; it inherits only
//! stdin, stdout, and stderr. HRA writes target stdin only after it sends GO.
//!
//! Control frames are line-oriented UTF-8 on the Unix socket:
//!
//!   HRA_AUTHORITY_SUPERVISOR/1 READY nonce=<hex> outer_pid=<pid> outer_pgid=<pid> outer_start_time=<ticks> boot_id=<uuid> init_host_pid=<pid> init_start_time=<ticks> init_pid_namespace_inode=<inode> ns_init_pid=1 monotonic_ms=<positive-u64>
//!   HRA_AUTHORITY_SUPERVISOR/1 GO nonce=<hex> deadline_monotonic_ms=<positive-u64>
//!   HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=<hex> exit=<0-255>
//!   HRA_AUTHORITY_SUPERVISOR/1 FAIL nonce=<hex> code=<stable-code>
//!   HRA_AUTHORITY_SUPERVISOR/1 RECOVERY_READY nonce=<hex> recovery_pid=<pid> recovery_start_time=<ticks> outer_pid=<pid> outer_start_time=<ticks> init_host_pid=<pid> init_start_time=<ticks> init_pid_namespace_inode=<inode>
//!   HRA_AUTHORITY_SUPERVISOR/1 RECOVERY_GO nonce=<hex>
//!   HRA_AUTHORITY_SUPERVISOR/1 RECOVERY_CLEAN nonce=<hex> recovery_pid=<pid> recovery_start_time=<ticks> outer_pid=<pid> outer_start_time=<ticks> boot_id=<uuid> init_host_pid=<pid> init_start_time=<ticks> init_pid_namespace_inode=<inode> method=<pidfd-sigkill|pidfd-already-exited>
//!
//! READY means a fresh user, mount, and PID namespace exists and its PID 1 is
//! waiting behind the GO gate. GO carries an absolute CLOCK_MONOTONIC deadline.
//! Both the outer supervisor and namespace PID 1 enforce it independently, so
//! a stopped or starved HRA process cannot extend target authority. CLEAN is
//! emitted only by the outer supervisor, after it has reaped that PID 1. Linux
//! kills all remaining tasks in a PID namespace when its init exits, including
//! double-forked or setsid() children. Any missing CLEAN or missing outer-helper
//! exit is indeterminate and must block later authority work.
//!
//! Recovery never claims remote provider-effect rollback. It validates the
//! recorded boot ID and start-time while holding a pidfd, signals only through
//! that pidfd, and polls at most five seconds for both the local outer process
//! and its exact namespace init to exit. A failed validation sends no signal.
//! A post-signal timeout or wait failure remains indeterminate for the caller.
//! Before RECOVERY_GO, HRA must verify recovery_pid and recovery_start_time
//! against the freshly spawned direct recovery-helper child it owns.

const builtin = @import("builtin");
const std = @import("std");
const linux = std.os.linux;

comptime {
    if (builtin.os.tag != .linux) {
        @compileError("authority-supervisor is supported only for Linux targets");
    }
}

const protocol_prefix = "HRA_AUTHORITY_SUPERVISOR/1 ";
const nonce_hex_length = 32;
const Nonce = [16]u8;
const boot_id_length = 36;
const BootId = [boot_id_length]u8;
const recovery_exit_timeout_ms: u64 = 5_000;
const launch_timeout_exit_code: u8 = 124;
const mountinfo_max_bytes = 1_048_576;
const mountinfo_max_lines = 4_096;
const mountinfo_max_line_bytes = 8_192;
const authority_socket_prefix = ".authority-control-";
const authority_socket_suffix = ".sock";

const control_fd: i32 = 3;
const start_write_fd: i32 = 4;
const start_read_fd: i32 = 5;
const result_read_fd: i32 = 6;
const result_write_fd: i32 = 7;
const ready_read_fd: i32 = 8;
const ready_write_fd: i32 = 9;
const lifeline_write_fd: i32 = 10;
const lifeline_read_fd: i32 = 11;
const maximum_preserved_fd: i32 = lifeline_read_fd;
const scratch_fd_minimum: i32 = 64;

const SupervisorError = error{
    InvalidArguments,
    InvalidTarget,
    InvalidControlSocket,
    ControlConnectFailed,
    NamespaceUnavailable,
    NamespaceMappingFailed,
    MountIsolationFailed,
    MountTableInvalid,
    MountAliasUnsafe,
    SupervisorHardeningFailed,
    TargetHardeningFailed,
    FileDescriptorIsolationUnavailable,
    PipeFailed,
    ForkFailed,
    InitNotReady,
    ParentExited,
    ControlProtocolRejected,
    TargetStartFailed,
    ResultMissing,
    InitExitedAbruptly,
    WaitFailed,
    CleanupUnproven,
    LaunchIdentityUnavailable,
    RecoveryUnsafeTarget,
    RecoveryBootIdUnavailable,
    RecoveryBootIdMismatch,
    RecoverySelfIdentityUnavailable,
    RecoveryProcUnavailable,
    RecoveryStartTimeMismatch,
    RecoveryPidfdUnavailable,
    RecoveryOuterNotLive,
    RecoveryInitPidfdUnavailable,
    RecoveryInitProcUnavailable,
    RecoveryInitStartTimeMismatch,
    RecoveryInitNamespaceMismatch,
    RecoveryInitNotLive,
    RecoverySignalFailed,
    RecoveryExitTimeout,
    RecoveryWaitFailed,
};

const LaunchConfig = struct {
    recovery_directory: []const u8,
    target_path: [*:0]const u8,
    target_argv: [*:null]const ?[*:0]const u8,
    target_cwd: [*:0]const u8 = "/",
    target_env: [*:null]const ?[*:0]const u8,
};

const RecoveryConfig = struct {
    outer_pid: linux.pid_t,
    outer_start_time: u64,
    boot_id: BootId,
    init_host_pid: linux.pid_t,
    init_start_time: u64,
    init_pid_namespace_inode: u64,
};

const RecoveryHelperIdentity = struct {
    pid: linux.pid_t,
    start_time: u64,
};

const Action = union(enum) {
    launch: LaunchConfig,
    terminate: RecoveryConfig,
};

const Config = struct {
    control_socket_path: []const u8,
    nonce: Nonce,
    action: Action,
};

const LaunchIdentity = struct {
    outer_pid: linux.pid_t,
    outer_start_time: u64,
    boot_id: BootId,
};

const InitIdentity = struct {
    host_pid: linux.pid_t,
    start_time: u64,
    pid_namespace_inode: u64,
};

const InitReadyRecord = extern struct {
    tag: u8,
    reserved: [7]u8,
    start_time: u64,
    pid_namespace_inode: u64,
};

const StartRecord = extern struct {
    tag: u8,
    reserved: [7]u8,
    deadline_monotonic_ms: u64,
};

const ResultKind = struct {
    const target: u8 = 1;
    const internal: u8 = 2;
};

const TargetResult = extern struct {
    kind: u8,
    reserved: [3]u8,
    wait_status: u32,
};

pub fn main(init: std.process.Init.Minimal) void {
    const launch_parent_pid = linux.getppid();
    const args = init.args.vector;
    // In recovery mode the old target can still be alive while this helper is
    // starting. Classify only the fixed action position and hide the nonce
    // before full parsing or opening a pidfd. Launch must remain dumpable until
    // it writes its unprivileged uid/gid maps; runLaunch hardens it immediately
    // after that credential transition and before READY or target creation.
    if (args.len > 5 and std.mem.eql(u8, std.mem.span(args[5]), "--terminate")) {
        setUndumpable() catch linux.exit(1);
    }
    const config = parseConfig(init) catch {
        linux.exit(64);
    };

    switch (config.action) {
        // HRA deliberately gives a launch target raw standard streams. Refuse
        // to start rather than let a control socket occupy one of them. This
        // is checked before socket() because socket() may otherwise reuse a
        // missing standard descriptor.
        .launch => if (!standardDescriptorsOpen()) linux.exit(64),
        .terminate => {},
    }

    const connected_socket = connectControl(config.control_socket_path) catch {
        linux.exit(1);
    };
    // Keep the original connection alive until the duplicate is established,
    // then make the descriptor-preparation input unambiguously non-stdio.
    const socket = duplicateAtLeast(connected_socket, control_fd) catch {
        emitFail(connected_socket, config.nonce, "fd_isolation_unavailable");
        closeIgnore(connected_socket);
        linux.exit(1);
    };
    closeIgnore(connected_socket);

    switch (config.action) {
        .launch => |launch| runLaunch(config.nonce, launch, socket, launch_parent_pid) catch |err| {
            emitFail(socket, config.nonce, errorCode(err));
            closeIgnore(socket);
            linux.exit(1);
        },
        .terminate => |recovery| runRecovery(config.nonce, recovery, socket, launch_parent_pid) catch |err| {
            emitFail(socket, config.nonce, errorCode(err));
            closeIgnore(socket);
            linux.exit(1);
        },
    }
    closeIgnore(socket);
    linux.exit(0);
}

fn parseConfig(init: std.process.Init.Minimal) SupervisorError!Config {
    const args = init.args.vector;
    if (args.len < 6) return error.InvalidArguments;
    if (!std.mem.eql(u8, std.mem.span(args[1]), "--control-socket")) {
        return error.InvalidArguments;
    }
    if (!std.mem.eql(u8, std.mem.span(args[3]), "--nonce")) {
        return error.InvalidArguments;
    }
    const control_socket_path = std.mem.span(args[2]);
    if (control_socket_path.len == 0 or control_socket_path[0] != '/' or control_socket_path.len >= 108) return error.InvalidControlSocket;
    const recovery_directory = recoveryDirectoryFromControlSocket(control_socket_path) orelse return error.InvalidControlSocket;

    const nonce = parseNonce(std.mem.span(args[4])) orelse return error.InvalidArguments;
    if (std.mem.eql(u8, std.mem.span(args[5]), "--")) {
        if (args.len < 7) return error.InvalidArguments;
        const target_path = args[6];
        const target_path_bytes = std.mem.span(target_path);
        if (target_path_bytes.len == 0 or target_path_bytes[0] != '/') {
            return error.InvalidTarget;
        }
        return .{
            .control_socket_path = control_socket_path,
            .nonce = nonce,
            .action = .{ .launch = .{
                .recovery_directory = recovery_directory,
                .target_path = target_path,
                .target_argv = @ptrCast(args.ptr + 6),
                .target_env = init.environ.block.slice.ptr,
            } },
        };
    }

    if (!std.mem.eql(u8, std.mem.span(args[5]), "--terminate") or args.len != 18) {
        return error.InvalidArguments;
    }
    if (!std.mem.eql(u8, std.mem.span(args[6]), "--outer-pid") or !std.mem.eql(u8, std.mem.span(args[8]), "--outer-start-time") or !std.mem.eql(u8, std.mem.span(args[10]), "--boot-id")) {
        return error.InvalidArguments;
    }
    const outer_pid = parseRecoveryPid(std.mem.span(args[7])) orelse return error.InvalidArguments;
    const outer_start_time = parsePositiveU64(std.mem.span(args[9])) orelse return error.InvalidArguments;
    const boot_id = parseBootId(std.mem.span(args[11])) orelse return error.InvalidArguments;
    if (!std.mem.eql(u8, std.mem.span(args[12]), "--init-host-pid") or !std.mem.eql(u8, std.mem.span(args[14]), "--init-start-time") or !std.mem.eql(u8, std.mem.span(args[16]), "--init-pid-namespace-inode")) {
        return error.InvalidArguments;
    }
    const init_host_pid = parseRecoveryPid(std.mem.span(args[13])) orelse return error.InvalidArguments;
    const init_start_time = parsePositiveU64(std.mem.span(args[15])) orelse return error.InvalidArguments;
    const init_pid_namespace_inode = parsePositiveU64(std.mem.span(args[17])) orelse return error.InvalidArguments;
    return .{
        .control_socket_path = control_socket_path,
        .nonce = nonce,
        .action = .{ .terminate = .{
            .outer_pid = outer_pid,
            .outer_start_time = outer_start_time,
            .boot_id = boot_id,
            .init_host_pid = init_host_pid,
            .init_start_time = init_start_time,
            .init_pid_namespace_inode = init_pid_namespace_inode,
        } },
    };
}

fn recoveryDirectoryFromControlSocket(path: []const u8) ?[]const u8 {
    const separator = std.mem.lastIndexOfScalar(u8, path, '/') orelse return null;
    if (separator <= 1 or separator + 1 >= path.len) return null;
    const directory = path[0..separator];
    if (!isCanonicalAbsolutePath(directory)) return null;
    const name = path[separator + 1 ..];
    const expected_length = authority_socket_prefix.len + nonce_hex_length + authority_socket_suffix.len;
    if (name.len != expected_length or
        !std.mem.startsWith(u8, name, authority_socket_prefix) or
        !std.mem.endsWith(u8, name, authority_socket_suffix)) return null;
    const token = name[authority_socket_prefix.len .. authority_socket_prefix.len + nonce_hex_length];
    for (token) |character| {
        if (decodeHex(character) == null) return null;
    }
    return directory;
}

fn isCanonicalAbsolutePath(path: []const u8) bool {
    if (path.len < 2 or path[0] != '/' or path[path.len - 1] == '/') return false;
    var start: usize = 1;
    while (start < path.len) {
        const relative_end = std.mem.indexOfScalar(u8, path[start..], '/');
        const end = if (relative_end) |offset| start + offset else path.len;
        const segment = path[start..end];
        if (segment.len == 0 or std.mem.eql(u8, segment, ".") or std.mem.eql(u8, segment, "..")) return false;
        if (relative_end == null) break;
        start = end + 1;
    }
    return true;
}

fn parseNonce(input: []const u8) ?Nonce {
    if (input.len != nonce_hex_length) return null;
    var nonce: Nonce = undefined;
    for (0..nonce.len) |index| {
        const high = decodeHex(input[index * 2]) orelse return null;
        const low = decodeHex(input[index * 2 + 1]) orelse return null;
        nonce[index] = (high << 4) | low;
    }
    return nonce;
}

fn decodeHex(character: u8) ?u8 {
    return switch (character) {
        '0'...'9' => character - '0',
        'a'...'f' => character - 'a' + 10,
        else => null,
    };
}

fn parseBootId(input: []const u8) ?BootId {
    if (input.len != boot_id_length) return null;
    var boot_id: BootId = undefined;
    for (input, 0..) |character, index| {
        if (index == 8 or index == 13 or index == 18 or index == 23) {
            if (character != '-') return null;
        } else if (decodeHex(character) == null) {
            return null;
        }
        boot_id[index] = character;
    }
    return boot_id;
}

fn parsePositiveU64(input: []const u8) ?u64 {
    if (input.len == 0 or input[0] < '1' or input[0] > '9') return null;
    return parseDecimalU64(input);
}

fn parseDecimalU64(input: []const u8) ?u64 {
    if (input.len == 0) return null;
    var value: u64 = 0;
    for (input) |character| {
        if (character < '0' or character > '9') return null;
        const digit: u64 = character - '0';
        if (value > (std.math.maxInt(u64) - digit) / 10) return null;
        value = value * 10 + digit;
    }
    return value;
}

fn parseRecoveryPid(input: []const u8) ?linux.pid_t {
    const raw = parsePositiveU64(input) orelse return null;
    // PID 1 and the all-processes/negative PID forms are never recovery
    // targets. The remaining value is range-checked before pidfd_open().
    if (raw <= 1 or raw > @as(u64, @intCast(std.math.maxInt(linux.pid_t)))) return null;
    return @intCast(raw);
}

fn runLaunch(
    nonce: Nonce,
    config: LaunchConfig,
    socket: i32,
    launch_parent_pid: linux.pid_t,
) SupervisorError!void {
    const host_uid = linux.getuid();
    const host_gid = linux.getgid();
    if (host_uid != linux.geteuid() or host_gid != linux.getegid()) {
        return error.NamespaceUnavailable;
    }

    // Do not carry an open cwd reference around the recovery-directory
    // overmount. Capture its canonical kernel path, detach to /, and restore
    // the requested cwd only in the capability-free target. A caller that
    // tries to launch from inside the concealed directory therefore fails
    // closed instead of retaining an inode-level route around the mount.
    var cwd_buffer: [linux.PATH_MAX + 1]u8 = undefined;
    const target_cwd = try readCurrentWorkingDirectory(&cwd_buffer);
    if (linux.errno(linux.chdir("/")) != .SUCCESS) return error.InvalidTarget;
    var prepared_config = config;
    prepared_config.target_cwd = target_cwd.ptr;

    try unshareAndMapCurrentIdentity(host_uid, host_gid);
    // The outer supervisor is itself a child of HRA. It arms PDEATHSIG after
    // uid/gid mapping, then checks the pre-arm race before it can announce
    // READY or fork namespace PID 1.
    try armParentDeath();
    try assertParentStill(launch_parent_pid);
    try setUndumpable();
    const outer_pid = linux.getpid();
    const identity = LaunchIdentity{
        .outer_pid = outer_pid,
        .outer_start_time = try readProcStartTime(outer_pid, error.LaunchIdentityUnavailable),
        .boot_id = try readBootId(error.LaunchIdentityUnavailable),
    };
    const fds = try prepareFileDescriptors(socket, nonce);

    return runPrepared(nonce, prepared_config, identity, fds) catch |err| {
        // Descriptor preparation has replaced the caller's socket with the
        // fixed helper-only control descriptor. Never fall back to a stale
        // numeric descriptor when reporting a post-remap failure.
        failControlAndExit(fds.control, nonce, err);
    };
}

fn runPrepared(
    nonce: Nonce,
    config: LaunchConfig,
    identity: LaunchIdentity,
    fds: PreparedFileDescriptors,
) SupervisorError!void {
    const outer_pgid_result = linux.getpgid(0);
    if (linux.errno(outer_pgid_result) != .SUCCESS) return error.SupervisorHardeningFailed;
    const outer_pgid: linux.pid_t = @intCast(outer_pgid_result);

    const fork_result = linux.fork();
    switch (linux.errno(fork_result)) {
        .SUCCESS => {},
        else => return error.ForkFailed,
    }
    if (fork_result == 0) initMain(config, fds);

    const init_pid: linux.pid_t = @intCast(fork_result);
    closeIgnore(fds.start_read);
    closeIgnore(fds.result_write);
    closeIgnore(fds.ready_write);
    closeIgnore(fds.lifeline_read);

    var ready: InitReadyRecord = undefined;
    readExactly(fds.ready_read, std.mem.asBytes(&ready)) catch {
        return stopInitAndFail(init_pid, error.InitNotReady);
    };
    closeIgnore(fds.ready_read);
    if (ready.tag != 'R') return stopInitAndFail(init_pid, error.InitNotReady);
    const init_identity = InitIdentity{
        .host_pid = init_pid,
        .start_time = ready.start_time,
        .pid_namespace_inode = ready.pid_namespace_inode,
    };

    const ready_monotonic_ms = monotonicMilliseconds(error.ControlProtocolRejected) catch {
        return stopInitAndFail(init_pid, error.ControlProtocolRejected);
    };
    try emitReady(fds.control, nonce, identity, outer_pgid, init_identity, ready_monotonic_ms);
    const deadline_monotonic_ms = readGo(fds.control, nonce) catch {
        return stopInitAndFail(init_pid, error.ControlProtocolRejected);
    };
    const start_record = StartRecord{
        .tag = 'G',
        .reserved = .{ 0, 0, 0, 0, 0, 0, 0 },
        .deadline_monotonic_ms = deadline_monotonic_ms,
    };
    writeAll(fds.start_write, std.mem.asBytes(&start_record)) catch {
        return stopInitAndFail(init_pid, error.TargetStartFailed);
    };
    closeIgnore(fds.start_write);
    // Target stdin begins immediately after GO. The outer helper must never
    // consume it, and now releases its own descriptor 0 copy.
    closeIgnore(0);

    const maybe_result = readTargetResultUntil(fds.result_read, deadline_monotonic_ms) catch {
        return stopInitAndFail(init_pid, error.ResultMissing);
    };
    if (maybe_result == null) {
        return completeLaunchDeadlineExpiry(init_pid, fds, nonce);
    }
    const result = maybe_result.?;
    closeIgnore(fds.result_read);

    const maybe_init_status = waitForPidUntil(init_pid, deadline_monotonic_ms) catch {
        return stopInitAndFail(init_pid, error.CleanupUnproven);
    };
    if (maybe_init_status == null) {
        return completeLaunchDeadlineExpiry(init_pid, fds, nonce);
    }
    const init_status = maybe_init_status.?;
    closeIgnore(fds.lifeline_write);
    if (!linux.W.IFEXITED(init_status) or linux.W.EXITSTATUS(init_status) != 0) {
        return error.InitExitedAbruptly;
    }
    if (result.kind != ResultKind.target) return error.TargetStartFailed;

    const exit_code = exitCodeFromWaitStatus(result.wait_status);
    // This is the only CLEAN emission site. PID 1 was already reaped above;
    // this outer process immediately exits after writing CLEAN, and HRA must
    // observe that exit as the second half of the custody proof.
    try emitClean(fds.control, nonce, exit_code);
    closeIgnore(fds.control);
    linux.exit(@intCast(exit_code));
}

fn runRecovery(
    nonce: Nonce,
    recovery: RecoveryConfig,
    socket: i32,
    launch_parent_pid: linux.pid_t,
) SupervisorError!void {
    // Recovery is a child of HRA, never the recorded outer helper or HRA
    // itself. Refuse pathological journal input before opening a pidfd.
    if (recovery.outer_pid == linux.getpid() or recovery.outer_pid == launch_parent_pid or recovery.init_host_pid == linux.getpid() or recovery.init_host_pid == launch_parent_pid or recovery.init_host_pid == recovery.outer_pid) {
        return error.RecoveryUnsafeTarget;
    }
    try armParentDeath();
    try assertParentStill(launch_parent_pid);
    try setUndumpable();
    const recovery_identity = RecoveryHelperIdentity{
        .pid = linux.getpid(),
        .start_time = try readProcStartTime(linux.getpid(), error.RecoverySelfIdentityUnavailable),
    };
    try verifyBootId(recovery.boot_id);

    // Open both pidfds before looking at either /proc/<pid>/stat. If a task
    // exits and its numeric PID is reused after this point, these descriptors
    // still refer only to the old tasks and can never signal the replacement.
    const raw_outer_pidfd = linux.pidfd_open(recovery.outer_pid, 0);
    if (linux.errno(raw_outer_pidfd) != .SUCCESS) return error.RecoveryPidfdUnavailable;
    const outer_pidfd: i32 = @intCast(raw_outer_pidfd);
    defer closeIgnore(outer_pidfd);
    const raw_init_pidfd = linux.pidfd_open(recovery.init_host_pid, 0);
    if (linux.errno(raw_init_pidfd) != .SUCCESS) return error.RecoveryInitPidfdUnavailable;
    const init_pidfd: i32 = @intCast(raw_init_pidfd);
    defer closeIgnore(init_pidfd);

    try verifyRecoveryIdentity(recovery);
    try assertPidfdLive(outer_pidfd, error.RecoveryOuterNotLive);
    try assertPidfdLive(init_pidfd, error.RecoveryInitNotLive);
    try emitRecoveryReady(socket, nonce, recovery_identity, recovery);
    try readRecoveryGo(socket, nonce);
    try assertParentStill(launch_parent_pid);
    // Revalidate both exact identities immediately before the only signal.
    // A dead pidfd can only report ESRCH below; it cannot retarget a reused
    // numeric PID. A missing or mismatched namespace init blocks recovery.
    try verifyRecoveryIdentity(recovery);
    try assertPidfdLive(outer_pidfd, error.RecoveryOuterNotLive);
    try assertPidfdLive(init_pidfd, error.RecoveryInitNotLive);

    const deadline = try recoveryExitDeadline();
    const signal_result = linux.errno(linux.pidfd_send_signal(outer_pidfd, .KILL, null, 0));
    const method: RecoveryMethod = switch (signal_result) {
        .SUCCESS => .pidfd_sigkill,
        .SRCH => .pidfd_already_exited,
        else => return error.RecoverySignalFailed,
    };
    try waitForPidfdExit(outer_pidfd, deadline);
    // The init pidfd is the durable proof that the exact namespace PID 1,
    // rather than only its outer supervisor, has exited before success.
    try waitForPidfdExit(init_pidfd, deadline);
    try emitRecoveryClean(socket, nonce, recovery_identity, recovery, method);
}

const RecoveryMethod = enum {
    pidfd_sigkill,
    pidfd_already_exited,
};

fn verifyBootId(expected: BootId) SupervisorError!void {
    const actual = try readBootId(error.RecoveryBootIdUnavailable);
    if (!std.mem.eql(u8, actual[0..], expected[0..])) return error.RecoveryBootIdMismatch;
}

fn verifyRecoveryIdentity(recovery: RecoveryConfig) SupervisorError!void {
    try verifyProcStartTime(recovery.outer_pid, recovery.outer_start_time);
    const init_start_time = try readProcStartTime(recovery.init_host_pid, error.RecoveryInitProcUnavailable);
    if (init_start_time != recovery.init_start_time) return error.RecoveryInitStartTimeMismatch;
    const init_namespace_inode = try readPidNamespaceInode(recovery.init_host_pid, error.RecoveryInitProcUnavailable);
    if (init_namespace_inode != recovery.init_pid_namespace_inode) return error.RecoveryInitNamespaceMismatch;
}

fn verifyProcStartTime(expected_pid: linux.pid_t, expected_start_time: u64) SupervisorError!void {
    const actual_start_time = try readProcStartTime(expected_pid, error.RecoveryProcUnavailable);
    if (actual_start_time != expected_start_time) return error.RecoveryStartTimeMismatch;
}

const PreparedFileDescriptors = struct {
    control: i32,
    start_write: i32,
    start_read: i32,
    result_read: i32,
    result_write: i32,
    ready_read: i32,
    ready_write: i32,
    lifeline_write: i32,
    lifeline_read: i32,
};

fn prepareFileDescriptors(input_control: i32, nonce: Nonce) SupervisorError!PreparedFileDescriptors {
    if (input_control < control_fd) return error.FileDescriptorIsolationUnavailable;
    // Preserve every source above the fixed descriptor range before remapping.
    // This prevents a pipe allocation from becoming another protocol channel
    // while its endpoints are being assigned fixed names.
    const control_copy = try duplicateAtLeast(input_control, scratch_fd_minimum);

    var start: [2]i32 = undefined;
    var result: [2]i32 = undefined;
    var ready: [2]i32 = undefined;
    var lifeline: [2]i32 = undefined;
    try makePipe(&start);
    try makePipe(&result);
    try makePipe(&ready);
    try makePipe(&lifeline);

    const start_read_copy = try duplicateAtLeast(start[0], scratch_fd_minimum);
    const start_write_copy = try duplicateAtLeast(start[1], scratch_fd_minimum);
    const result_read_copy = try duplicateAtLeast(result[0], scratch_fd_minimum);
    const result_write_copy = try duplicateAtLeast(result[1], scratch_fd_minimum);
    const ready_read_copy = try duplicateAtLeast(ready[0], scratch_fd_minimum);
    const ready_write_copy = try duplicateAtLeast(ready[1], scratch_fd_minimum);
    const lifeline_read_copy = try duplicateAtLeast(lifeline[0], scratch_fd_minimum);
    const lifeline_write_copy = try duplicateAtLeast(lifeline[1], scratch_fd_minimum);

    // Stdio is the target's explicitly allowed surface. Everything else is
    // copied into a fixed helper descriptor below or closed forever.
    // Keep the caller's connected socket alive until descriptor 3 has been
    // installed. That leaves main() a live channel for any failure before the
    // fixed control descriptor exists.
    try closeRangeExcept(control_fd, scratch_fd_minimum - 1, input_control);
    try duplicateInto(control_copy, control_fd);
    // From here fd 3 is known-good, so every failure can still emit an
    // authenticated FAIL frame even though the original numeric descriptor
    // may be replaced or closed below.
    duplicateInto(start_write_copy, start_write_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    duplicateInto(start_read_copy, start_read_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    duplicateInto(result_read_copy, result_read_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    duplicateInto(result_write_copy, result_write_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    duplicateInto(ready_read_copy, ready_read_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    duplicateInto(ready_write_copy, ready_write_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    duplicateInto(lifeline_write_copy, lifeline_write_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    duplicateInto(lifeline_read_copy, lifeline_read_fd) catch |err| failControlAndExit(control_fd, nonce, err);
    closeRange(maximum_preserved_fd + 1, std.math.maxInt(i32)) catch |err| {
        failControlAndExit(control_fd, nonce, err);
    };

    return .{
        .control = control_fd,
        .start_write = start_write_fd,
        .start_read = start_read_fd,
        .result_read = result_read_fd,
        .result_write = result_write_fd,
        .ready_read = ready_read_fd,
        .ready_write = ready_write_fd,
        .lifeline_write = lifeline_write_fd,
        .lifeline_read = lifeline_read_fd,
    };
}

fn initMain(config: LaunchConfig, fds: PreparedFileDescriptors) noreturn {
    closeIgnore(fds.control);
    closeIgnore(fds.start_write);
    closeIgnore(fds.result_read);
    closeIgnore(fds.ready_read);
    closeIgnore(fds.lifeline_write);

    // PID 1 never writes raw bytes to HRA's target stdout/stderr streams, but
    // retains them so the target can inherit its ordinary raw stdio surface.

    armParentDeath() catch initExit(fds.result_write, ResultKind.internal, 1);
    setUndumpable() catch initExit(fds.result_write, ResultKind.internal, 2);
    // PR_SET_PDEATHSIG covers parent death after this point. The lifeline pipe
    // closes the small fork-to-prctl race before READY can be emitted.
    assertLifelineStillOpen(fds.lifeline_read) catch initExit(fds.result_write, ResultKind.internal, 3);
    // This runs while this process is PID 1 in the child PID namespace and
    // only after root propagation was made private in the outer supervisor.
    rejectRecoveryDirectoryMountAliases(config.recovery_directory) catch initExit(fds.result_write, ResultKind.internal, 4);
    concealRecoveryDirectory(config.recovery_directory) catch initExit(fds.result_write, ResultKind.internal, 4);
    mountFreshProc() catch initExit(fds.result_write, ResultKind.internal, 4);
    const init_identity = InitReadyRecord{
        .tag = 'R',
        .reserved = .{ 0, 0, 0, 0, 0, 0, 0 },
        .start_time = readProcStartTime(linux.getpid(), error.InitNotReady) catch initExit(fds.result_write, ResultKind.internal, 5),
        .pid_namespace_inode = readPidNamespaceInode(linux.getpid(), error.InitNotReady) catch initExit(fds.result_write, ResultKind.internal, 6),
    };
    writeAll(fds.ready_write, std.mem.asBytes(&init_identity)) catch initExit(fds.result_write, ResultKind.internal, 7);
    closeIgnore(fds.ready_write);

    const deadline_monotonic_ms = waitForStartOrParentDeath(fds.start_read, fds.lifeline_read) catch |err| switch (err) {
        error.ParentExited => linux.exit(0),
        else => initExit(fds.result_write, ResultKind.internal, 8),
    };
    closeIgnore(fds.start_read);
    closeIgnore(fds.lifeline_read);

    const target_fork = linux.fork();
    switch (linux.errno(target_fork)) {
        .SUCCESS => {},
        else => initExit(fds.result_write, ResultKind.internal, 9),
    }
    if (target_fork == 0) targetMain(config);

    const target_pid: linux.pid_t = @intCast(target_fork);
    const maybe_target_status = waitForPidUntil(target_pid, deadline_monotonic_ms) catch initExit(fds.result_write, ResultKind.internal, 10);
    const target_status = maybe_target_status orelse blk: {
        killAndReap(target_pid) catch initExit(fds.result_write, ResultKind.internal, 10);
        // The outer supervisor owns the externally visible timeout status. PID
        // 1 exits promptly after proving that its direct target is reaped.
        break :blk timeoutWaitStatus();
    };
    const result = TargetResult{
        .kind = ResultKind.target,
        .reserved = .{ 0, 0, 0 },
        .wait_status = target_status,
    };
    writeAll(fds.result_write, std.mem.asBytes(&result)) catch linux.exit(1);
    closeIgnore(fds.result_write);
    // Exiting namespace PID 1 is intentional: Linux SIGKILLs every remaining
    // task in this namespace before the outer supervisor can emit CLEAN.
    linux.exit(0);
}

fn targetMain(config: LaunchConfig) noreturn {
    closeRange(3, std.math.maxInt(i32)) catch linux.exit(127);
    clearCloseOnExec(0) catch linux.exit(127);
    clearCloseOnExec(1) catch linux.exit(127);
    clearCloseOnExec(2) catch linux.exit(127);
    hardenTargetCredentials() catch linux.exit(127);
    if (linux.errno(linux.chdir(config.target_cwd)) != .SUCCESS) linux.exit(127);
    _ = linux.execve(config.target_path, config.target_argv, config.target_env);
    linux.exit(127);
}

fn unshareAndMapCurrentIdentity(host_uid: linux.uid_t, host_gid: linux.gid_t) SupervisorError!void {
    const flags = @as(usize, linux.CLONE.NEWUSER | linux.CLONE.NEWPID | linux.CLONE.NEWNS);
    if (linux.errno(linux.unshare(flags)) != .SUCCESS) return error.NamespaceUnavailable;

    writePath("/proc/self/setgroups", "deny\n") catch return error.NamespaceMappingFailed;

    var uid_mapping: [64]u8 = undefined;
    const uid_text = std.fmt.bufPrint(&uid_mapping, "0 {d} 1\n", .{host_uid}) catch {
        return error.NamespaceMappingFailed;
    };
    writePath("/proc/self/uid_map", uid_text) catch return error.NamespaceMappingFailed;

    var gid_mapping: [64]u8 = undefined;
    const gid_text = std.fmt.bufPrint(&gid_mapping, "0 {d} 1\n", .{host_gid}) catch {
        return error.NamespaceMappingFailed;
    };
    writePath("/proc/self/gid_map", gid_text) catch return error.NamespaceMappingFailed;

    // The mount namespace is private before namespace PID 1 remounts /proc.
    // A target mount operation can therefore never propagate to the host.
    if (linux.errno(linux.mount(null, "/", null, linux.MS.REC | linux.MS.PRIVATE, 0)) != .SUCCESS) {
        return error.MountIsolationFailed;
    }
}

fn mountFreshProc() SupervisorError!void {
    // Mounts inherited from a more privileged namespace are locked together
    // and cannot be individually detached here. Linux permits stacking a new
    // procfs over that locked mount inside this private namespace.
    const flags = linux.MS.NOSUID | linux.MS.NODEV | linux.MS.NOEXEC;
    if (linux.errno(linux.mount("proc", "/proc", "proc", flags, 0)) != .SUCCESS) {
        return error.MountIsolationFailed;
    }
}

const DirectoryIdentity = struct {
    device_major: u32,
    device_minor: u32,
    inode: u64,
};

const RecoveryAncestor = struct {
    path_length: usize,
    identity: DirectoryIdentity,
};

fn rejectRecoveryDirectoryMountAliases(directory: []const u8) SupervisorError!void {
    // Directory is derived from a sub-108-byte canonical control-socket path,
    // so there can be at most one ancestor per byte. Keep the entire proof on
    // the stack: no allocator or inherited descriptor survives into PID 1.
    var ancestors: [108]RecoveryAncestor = undefined;
    const ancestor_count = try collectRecoveryAncestors(directory, &ancestors);

    // A bounded full read rejects truncation. The byte-for-byte second read is
    // a seqlock-style stability proof: although no untrusted task shares this
    // new private mount namespace yet, an unexpected concurrent mutation must
    // still stop launch rather than invalidate the inode comparison below.
    var first_buffer: [mountinfo_max_bytes]u8 = undefined;
    const first = try readSmallFile(
        "/proc/self/mountinfo",
        &first_buffer,
        error.MountTableInvalid,
    );
    try inspectMountInfoForRecoveryAliases(first, directory, ancestors[0..ancestor_count]);

    var second_buffer: [mountinfo_max_bytes]u8 = undefined;
    const second = try readSmallFile(
        "/proc/self/mountinfo",
        &second_buffer,
        error.MountTableInvalid,
    );
    if (!std.mem.eql(u8, first, second)) return error.MountTableInvalid;
}

fn collectRecoveryAncestors(
    directory: []const u8,
    output: *[108]RecoveryAncestor,
) SupervisorError!usize {
    var count: usize = 0;
    output[count] = .{
        .path_length = 1,
        .identity = try statDirectoryIdentity(directory[0..1]),
    };
    count += 1;

    for (directory[1..], 1..) |character, index| {
        if (character != '/') continue;
        if (count == output.len) return error.MountTableInvalid;
        output[count] = .{
            .path_length = index,
            .identity = try statDirectoryIdentity(directory[0..index]),
        };
        count += 1;
    }
    if (count == output.len) return error.MountTableInvalid;
    output[count] = .{
        .path_length = directory.len,
        .identity = try statDirectoryIdentity(directory),
    };
    return count + 1;
}

fn inspectMountInfoForRecoveryAliases(
    contents: []const u8,
    directory: []const u8,
    ancestors: []const RecoveryAncestor,
) SupervisorError!void {
    if (contents.len == 0 or contents[contents.len - 1] != '\n') return error.MountTableInvalid;
    var cursor: usize = 0;
    var line_count: usize = 0;
    while (cursor < contents.len) {
        const relative_end = std.mem.indexOfScalar(u8, contents[cursor..], '\n') orelse {
            return error.MountTableInvalid;
        };
        const line_end = cursor + relative_end;
        const line = contents[cursor..line_end];
        if (line.len == 0 or line.len > mountinfo_max_line_bytes) return error.MountTableInvalid;
        line_count += 1;
        if (line_count > mountinfo_max_lines) return error.MountTableInvalid;

        var mountpoint_buffer: [linux.PATH_MAX + 1]u8 = undefined;
        const mountpoint = try parseMountInfoLine(line, &mountpoint_buffer);
        if (try statMountpointDirectoryIdentity(mountpoint)) |identity| {
            if (mountpointAliasesRecoveryAncestor(mountpoint, identity, directory, ancestors)) {
                return error.MountAliasUnsafe;
            }
        }
        cursor = line_end + 1;
    }
}

fn mountpointAliasesRecoveryAncestor(
    mountpoint: []const u8,
    identity: DirectoryIdentity,
    directory: []const u8,
    ancestors: []const RecoveryAncestor,
) bool {
    for (ancestors) |ancestor| {
        if (!sameDirectoryIdentity(identity, ancestor.identity)) continue;
        const canonical_ancestor = directory[0..ancestor.path_length];
        if (!std.mem.eql(u8, mountpoint, canonical_ancestor)) return true;
    }
    return false;
}

fn parseMountInfoLine(
    line: []const u8,
    mountpoint_buffer: *[linux.PATH_MAX + 1]u8,
) SupervisorError![]const u8 {
    const separator = std.mem.indexOf(u8, line, " - ") orelse return error.MountTableInvalid;
    if (std.mem.indexOf(u8, line[separator + 3 ..], " - ") != null) return error.MountTableInvalid;

    var root_buffer: [linux.PATH_MAX + 1]u8 = undefined;
    var before = std.mem.splitScalar(u8, line[0..separator], ' ');
    var field_index: usize = 0;
    var mountpoint: ?[]const u8 = null;
    while (before.next()) |field| : (field_index += 1) {
        if (!validMountInfoToken(field)) return error.MountTableInvalid;
        switch (field_index) {
            0, 1 => if (parsePositiveU64(field) == null) return error.MountTableInvalid,
            2 => if (!validMountDevice(field)) return error.MountTableInvalid,
            3 => _ = decodeMountInfoPath(field, &root_buffer) orelse return error.MountTableInvalid,
            4 => mountpoint = decodeMountInfoPath(field, mountpoint_buffer) orelse return error.MountTableInvalid,
            else => {},
        }
    }
    if (field_index < 6 or mountpoint == null) return error.MountTableInvalid;

    var after = std.mem.splitScalar(u8, line[separator + 3 ..], ' ');
    var after_count: usize = 0;
    while (after.next()) |field| : (after_count += 1) {
        if (!validMountInfoToken(field)) return error.MountTableInvalid;
    }
    if (after_count != 3) return error.MountTableInvalid;
    return mountpoint.?;
}

fn validMountDevice(field: []const u8) bool {
    const separator = std.mem.indexOfScalar(u8, field, ':') orelse return false;
    if (std.mem.indexOfScalar(u8, field[separator + 1 ..], ':') != null) return false;
    return parseDecimalU64(field[0..separator]) != null and
        parseDecimalU64(field[separator + 1 ..]) != null;
}

fn validMountInfoToken(field: []const u8) bool {
    if (field.len == 0) return false;
    var cursor: usize = 0;
    while (cursor < field.len) {
        const character = field[cursor];
        if (character == '\\') {
            if (cursor + 4 > field.len or decodeMountInfoEscape(field[cursor + 1 .. cursor + 4]) == null) {
                return false;
            }
            cursor += 4;
            continue;
        }
        if (character <= ' ' or character == 0x7f) return false;
        cursor += 1;
    }
    return true;
}

fn decodeMountInfoPath(input: []const u8, output: []u8) ?[]const u8 {
    if (!validMountInfoToken(input)) return null;
    var input_cursor: usize = 0;
    var output_cursor: usize = 0;
    while (input_cursor < input.len) {
        const decoded = if (input[input_cursor] == '\\') blk: {
            const character = decodeMountInfoEscape(input[input_cursor + 1 .. input_cursor + 4]) orelse return null;
            input_cursor += 4;
            break :blk character;
        } else blk: {
            const character = input[input_cursor];
            input_cursor += 1;
            break :blk character;
        };
        if (output_cursor >= output.len - 1) return null;
        output[output_cursor] = decoded;
        output_cursor += 1;
    }
    const decoded = output[0..output_cursor];
    if (!(std.mem.eql(u8, decoded, "/") or isCanonicalAbsolutePath(decoded))) return null;
    output[output_cursor] = 0;
    return decoded;
}

fn decodeMountInfoEscape(input: []const u8) ?u8 {
    if (std.mem.eql(u8, input, "040")) return ' ';
    if (std.mem.eql(u8, input, "011")) return '\t';
    if (std.mem.eql(u8, input, "012")) return '\n';
    if (std.mem.eql(u8, input, "134")) return '\\';
    return null;
}

fn statDirectoryIdentity(path: []const u8) SupervisorError!DirectoryIdentity {
    return (try statMountpointDirectoryIdentity(path)) orelse error.MountTableInvalid;
}

fn statMountpointDirectoryIdentity(path: []const u8) SupervisorError!?DirectoryIdentity {
    if (path.len == 0 or path.len > linux.PATH_MAX) return error.MountTableInvalid;
    var path_buffer: [linux.PATH_MAX + 1]u8 = undefined;
    @memcpy(path_buffer[0..path.len], path);
    path_buffer[path.len] = 0;
    var information: linux.Statx = undefined;
    if (linux.errno(linux.statx(
        linux.AT.FDCWD,
        path_buffer[0..path.len :0].ptr,
        linux.AT.NO_AUTOMOUNT,
        linux.STATX.BASIC_STATS,
        &information,
    )) != .SUCCESS) return error.MountTableInvalid;
    if (!information.mask.TYPE or !information.mask.INO) return error.MountTableInvalid;
    if ((information.mode & linux.S.IFMT) != linux.S.IFDIR) return null;
    return .{
        .device_major = information.dev_major,
        .device_minor = information.dev_minor,
        .inode = information.ino,
    };
}

fn sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity) bool {
    return left.device_major == right.device_major and
        left.device_minor == right.device_minor and
        left.inode == right.inode;
}

fn assertMountInfoParserFixtures() void {
    var mountpoint_buffer: [linux.PATH_MAX + 1]u8 = undefined;
    const decoded = parseMountInfoLine(
        "36 25 0:32 / /tmp/recovery\\040alias rw,nosuid shared:1 - tmpfs tmpfs rw",
        &mountpoint_buffer,
    ) catch @compileError("valid mountinfo fixture rejected");
    if (!std.mem.eql(u8, decoded, "/tmp/recovery alias")) {
        @compileError("mountinfo escape fixture decoded incorrectly");
    }

    var malformed_buffer: [linux.PATH_MAX + 1]u8 = undefined;
    if (parseMountInfoLine(
        "36 25 0:32 / /tmp/recovery\\777 rw - tmpfs tmpfs rw",
        &malformed_buffer,
    )) |_| {
        @compileError("unknown mountinfo escape accepted");
    } else |_| {}

    const identity = DirectoryIdentity{ .device_major = 1, .device_minor = 2, .inode = 3 };
    const ancestors = [_]RecoveryAncestor{.{ .path_length = 13, .identity = identity }};
    if (mountpointAliasesRecoveryAncestor("/tmp/recovery", identity, "/tmp/recovery", &ancestors)) {
        @compileError("canonical recovery mountpoint classified as alias");
    }
    if (!mountpointAliasesRecoveryAncestor("/tmp/recovery-alias", identity, "/tmp/recovery", &ancestors)) {
        @compileError("distinct-path same-inode mount alias accepted");
    }
}

comptime {
    assertMountInfoParserFixtures();
}

fn concealRecoveryDirectory(directory: []const u8) SupervisorError!void {
    var path_buffer: [108]u8 = undefined;
    const path = std.fmt.bufPrintZ(&path_buffer, "{s}", .{directory}) catch {
        return error.MountIsolationFailed;
    };
    const flags = linux.MS.RDONLY | linux.MS.NOSUID | linux.MS.NODEV | linux.MS.NOEXEC;
    const options = "mode=000,size=4096,nr_inodes=1";
    if (linux.errno(linux.mount(
        "tmpfs",
        path.ptr,
        "tmpfs",
        flags,
        @intFromPtr(options),
    )) != .SUCCESS) return error.MountIsolationFailed;
}

fn setUndumpable() SupervisorError!void {
    if (linux.errno(linux.prctl(@intFromEnum(linux.PR.SET_DUMPABLE), 0, 0, 0, 0)) != .SUCCESS) {
        return error.SupervisorHardeningFailed;
    }
}

fn hardenTargetCredentials() SupervisorError!void {
    if (linux.errno(linux.prctl(@intFromEnum(linux.PR.SET_NO_NEW_PRIVS), 1, 0, 0, 0)) != .SUCCESS) {
        return error.TargetHardeningFailed;
    }
    if (linux.errno(linux.prctl(
        @intFromEnum(linux.PR.CAP_AMBIENT),
        linux.PR.CAP_AMBIENT_CLEAR_ALL,
        0,
        0,
        0,
    )) != .SUCCESS) return error.TargetHardeningFailed;

    var capability: u8 = 0;
    while (capability <= linux.CAP.LAST_CAP) : (capability += 1) {
        if (linux.errno(linux.prctl(
            @intFromEnum(linux.PR.CAPBSET_DROP),
            capability,
            0,
            0,
            0,
        )) != .SUCCESS) return error.TargetHardeningFailed;
    }

    const CapabilityHeader = extern struct {
        version: u32,
        pid: i32,
    };
    const CapabilityData = extern struct {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    };
    var header = CapabilityHeader{ .version = 0x2008_0522, .pid = 0 };
    const data = [_]CapabilityData{
        .{ .effective = 0, .permitted = 0, .inheritable = 0 },
        .{ .effective = 0, .permitted = 0, .inheritable = 0 },
    };
    if (linux.errno(linux.syscall2(.capset, @intFromPtr(&header), @intFromPtr(&data))) != .SUCCESS) {
        return error.TargetHardeningFailed;
    }
}

fn armParentDeath() SupervisorError!void {
    if (linux.errno(linux.prctl(
        @intFromEnum(linux.PR.SET_PDEATHSIG),
        @intFromEnum(linux.SIG.KILL),
        0,
        0,
        0,
    )) != .SUCCESS) return error.SupervisorHardeningFailed;
}

fn assertParentStill(expected_parent: linux.pid_t) SupervisorError!void {
    if (linux.getppid() != expected_parent) return error.ParentExited;
}

fn assertLifelineStillOpen(lifeline: i32) SupervisorError!void {
    var descriptors = [_]linux.pollfd{.{
        .fd = lifeline,
        .events = linux.POLL.IN,
        .revents = 0,
    }};
    while (true) {
        const result = linux.poll(&descriptors, descriptors.len, 0);
        switch (linux.errno(result)) {
            .SUCCESS => {},
            .INTR => continue,
            else => return error.ParentExited,
        }
        if (result == 0) return;
        if ((descriptors[0].revents & (linux.POLL.IN | linux.POLL.HUP | linux.POLL.ERR | linux.POLL.NVAL)) != 0) {
            return error.ParentExited;
        }
    }
}

fn waitForStartOrParentDeath(start: i32, lifeline: i32) SupervisorError!u64 {
    var descriptors = [_]linux.pollfd{
        .{ .fd = start, .events = linux.POLL.IN, .revents = 0 },
        .{ .fd = lifeline, .events = linux.POLL.IN, .revents = 0 },
    };
    while (true) {
        const result = linux.poll(&descriptors, descriptors.len, -1);
        switch (linux.errno(result)) {
            .SUCCESS => {},
            .INTR => continue,
            else => return error.WaitFailed,
        }
        if ((descriptors[1].revents & (linux.POLL.IN | linux.POLL.HUP | linux.POLL.ERR | linux.POLL.NVAL)) != 0) {
            return error.ParentExited;
        }
        if ((descriptors[0].revents & linux.POLL.IN) != 0) {
            var record: StartRecord = undefined;
            try readExactly(start, std.mem.asBytes(&record));
            if (record.tag != 'G' or !std.mem.allEqual(u8, &record.reserved, 0)) {
                return error.ControlProtocolRejected;
            }
            const now = try monotonicMilliseconds(error.ControlProtocolRejected);
            if (record.deadline_monotonic_ms <= now) return error.ControlProtocolRejected;
            return record.deadline_monotonic_ms;
        }
        if ((descriptors[0].revents & (linux.POLL.HUP | linux.POLL.ERR | linux.POLL.NVAL)) != 0) {
            return error.ParentExited;
        }
    }
}

fn assertPidfdLive(pidfd: i32, not_live: SupervisorError) SupervisorError!void {
    var descriptors = [_]linux.pollfd{.{
        .fd = pidfd,
        .events = linux.POLL.IN,
        .revents = 0,
    }};
    while (true) {
        const result = linux.poll(&descriptors, descriptors.len, 0);
        switch (linux.errno(result)) {
            .SUCCESS => {},
            .INTR => continue,
            else => return error.RecoveryWaitFailed,
        }
        if (result == 0) return;
        if ((descriptors[0].revents & linux.POLL.IN) != 0) return not_live;
        return error.RecoveryWaitFailed;
    }
}

fn recoveryExitDeadline() SupervisorError!u64 {
    const started = try monotonicMilliseconds(error.RecoveryWaitFailed);
    if (started > std.math.maxInt(u64) - recovery_exit_timeout_ms) {
        return error.RecoveryWaitFailed;
    }
    return started + recovery_exit_timeout_ms;
}

fn waitForPidfdExit(pidfd: i32, deadline: u64) SupervisorError!void {
    var descriptors = [_]linux.pollfd{.{
        .fd = pidfd,
        .events = linux.POLL.IN,
        .revents = 0,
    }};

    while (true) {
        const now = try monotonicMilliseconds(error.RecoveryWaitFailed);
        if (now >= deadline) return error.RecoveryExitTimeout;
        const remaining = deadline - now;
        const timeout: i32 = @intCast(@min(remaining, @as(u64, std.math.maxInt(i32))));
        descriptors[0].revents = 0;
        const result = linux.poll(&descriptors, descriptors.len, timeout);
        switch (linux.errno(result)) {
            .SUCCESS => {
                if (result == 0) return error.RecoveryExitTimeout;
                if ((descriptors[0].revents & linux.POLL.IN) != 0) return;
                return error.RecoveryWaitFailed;
            },
            .INTR => continue,
            else => return error.RecoveryWaitFailed,
        }
    }
}

fn monotonicMilliseconds(failure: SupervisorError) SupervisorError!u64 {
    var timestamp: linux.timespec = undefined;
    if (linux.errno(linux.clock_gettime(.MONOTONIC, &timestamp)) != .SUCCESS) {
        return failure;
    }
    if (timestamp.sec < 0 or timestamp.nsec < 0) return failure;
    const seconds: u64 = @intCast(timestamp.sec);
    const nanoseconds: u64 = @intCast(timestamp.nsec);
    if (seconds > std.math.maxInt(u64) / 1_000) return failure;
    return seconds * 1_000 + nanoseconds / 1_000_000;
}

fn readGo(fd: i32, nonce: Nonce) SupervisorError!u64 {
    const prefix = protocol_prefix ++ "GO nonce=";
    const deadline_field = " deadline_monotonic_ms=";
    var expected_prefix: [prefix.len + nonce_hex_length + deadline_field.len]u8 = undefined;
    @memcpy(expected_prefix[0..prefix.len], prefix);
    const nonce_text = nonceHex(nonce);
    @memcpy(expected_prefix[prefix.len .. prefix.len + nonce_hex_length], &nonce_text);
    @memcpy(expected_prefix[prefix.len + nonce_hex_length ..], deadline_field);

    var line_buffer: [192]u8 = undefined;
    const line = try readBoundedLine(fd, &line_buffer);
    if (!std.mem.startsWith(u8, line, &expected_prefix)) return error.ControlProtocolRejected;
    const deadline_text = line[expected_prefix.len..];
    const deadline = parsePositiveU64(deadline_text) orelse return error.ControlProtocolRejected;
    const now = try monotonicMilliseconds(error.ControlProtocolRejected);
    if (deadline <= now) return error.ControlProtocolRejected;
    return deadline;
}

fn readRecoveryGo(fd: i32, nonce: Nonce) SupervisorError!void {
    const prefix = protocol_prefix ++ "RECOVERY_GO nonce=";
    var expected: [prefix.len + nonce_hex_length + 1]u8 = undefined;
    @memcpy(expected[0..prefix.len], prefix);
    const nonce_text = nonceHex(nonce);
    @memcpy(expected[prefix.len .. prefix.len + nonce_hex_length], &nonce_text);
    expected[expected.len - 1] = '\n';

    var actual: [expected.len]u8 = undefined;
    try readExactly(fd, &actual);
    if (!std.mem.eql(u8, &actual, &expected)) return error.ControlProtocolRejected;
}

fn readTargetResultUntil(fd: i32, deadline: u64) SupervisorError!?TargetResult {
    var descriptors = [_]linux.pollfd{.{
        .fd = fd,
        .events = linux.POLL.IN,
        .revents = 0,
    }};
    while (true) {
        const now = try monotonicMilliseconds(error.WaitFailed);
        if (now >= deadline) return null;
        const remaining = deadline - now;
        const timeout: i32 = @intCast(@min(remaining, @as(u64, std.math.maxInt(i32))));
        descriptors[0].revents = 0;
        const poll_result = linux.poll(&descriptors, descriptors.len, timeout);
        switch (linux.errno(poll_result)) {
            .SUCCESS => {},
            .INTR => continue,
            else => return error.WaitFailed,
        }
        if (poll_result == 0) return null;
        if ((descriptors[0].revents & linux.POLL.IN) != 0) {
            if (try monotonicMilliseconds(error.WaitFailed) >= deadline) return null;
            var result: TargetResult = undefined;
            try readExactly(fd, std.mem.asBytes(&result));
            return result;
        }
        return error.ResultMissing;
    }
}

fn waitForPidUntil(pid: linux.pid_t, deadline: u64) SupervisorError!?u32 {
    var status: u32 = 0;
    while (true) {
        const now = try monotonicMilliseconds(error.WaitFailed);
        if (now >= deadline) return null;
        const result = linux.waitpid(pid, &status, linux.W.NOHANG);
        switch (linux.errno(result)) {
            .SUCCESS => {
                if (result != 0) {
                    if (result != @as(usize, @intCast(pid))) return error.WaitFailed;
                    return status;
                }
            },
            .INTR => continue,
            else => return error.WaitFailed,
        }

        const remaining = deadline - now;
        const timeout: i32 = @intCast(@min(remaining, @as(u64, 25)));
        var no_descriptors: [0]linux.pollfd = .{};
        const poll_result = linux.poll(&no_descriptors, no_descriptors.len, timeout);
        switch (linux.errno(poll_result)) {
            .SUCCESS, .INTR => {},
            else => return error.WaitFailed,
        }
    }
}

fn killAndReap(pid: linux.pid_t) SupervisorError!void {
    const kill_result = linux.errno(linux.kill(pid, .KILL));
    if (kill_result != .SUCCESS and kill_result != .SRCH) return error.CleanupUnproven;
    _ = waitForPid(pid) catch return error.CleanupUnproven;
}

fn completeLaunchDeadlineExpiry(
    init_pid: linux.pid_t,
    fds: PreparedFileDescriptors,
    nonce: Nonce,
) SupervisorError!void {
    try killAndReap(init_pid);
    closeIgnore(fds.result_read);
    closeIgnore(fds.lifeline_write);
    try emitClean(fds.control, nonce, launch_timeout_exit_code);
    closeIgnore(fds.control);
    linux.exit(launch_timeout_exit_code);
}

fn timeoutWaitStatus() u32 {
    // waitpid encodes a normal exit code in bits 8..15. Preserve the public
    // timeout contract even when PID 1 reaches the deadline and reports first.
    return @as(u32, launch_timeout_exit_code) << 8;
}

fn stopInitAndFail(init_pid: linux.pid_t, failure: SupervisorError) SupervisorError {
    killAndReap(init_pid) catch return error.CleanupUnproven;
    return failure;
}

fn waitForPid(pid: linux.pid_t) SupervisorError!u32 {
    var status: u32 = 0;
    while (true) {
        const result = linux.waitpid(pid, &status, 0);
        switch (linux.errno(result)) {
            .SUCCESS => return status,
            .INTR => continue,
            else => return error.WaitFailed,
        }
    }
}

fn exitCodeFromWaitStatus(status: u32) u8 {
    if (linux.W.IFEXITED(status)) return linux.W.EXITSTATUS(status);
    if (linux.W.IFSIGNALED(status)) {
        const signal_code: u16 = @truncate(@intFromEnum(linux.W.TERMSIG(status)));
        return @intCast(@as(u16, 128) + signal_code);
    }
    return 1;
}

fn connectControl(path: []const u8) SupervisorError!i32 {
    const socket_result = linux.socket(linux.AF.UNIX, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0);
    if (linux.errno(socket_result) != .SUCCESS) return error.ControlConnectFailed;
    const socket: i32 = @intCast(socket_result);
    errdefer closeIgnore(socket);

    var address = linux.sockaddr.un{
        .family = linux.AF.UNIX,
        .path = [_]u8{0} ** 108,
    };
    @memcpy(address.path[0..path.len], path);
    const address_length: linux.socklen_t = @intCast(@offsetOf(linux.sockaddr.un, "path") + path.len + 1);
    while (true) {
        const result = linux.connect(socket, @ptrCast(&address), address_length);
        switch (linux.errno(result)) {
            .SUCCESS => return socket,
            .INTR => continue,
            else => return error.ControlConnectFailed,
        }
    }
}

fn readBoundedLine(fd: i32, buffer: []u8) SupervisorError![]const u8 {
    var cursor: usize = 0;
    while (cursor < buffer.len) {
        var byte: [1]u8 = undefined;
        try readExactly(fd, &byte);
        if (byte[0] == '\n') return buffer[0..cursor];
        buffer[cursor] = byte[0];
        cursor += 1;
    }
    return error.ControlProtocolRejected;
}

fn readExactly(fd: i32, output: []u8) SupervisorError!void {
    var cursor: usize = 0;
    while (cursor < output.len) {
        const result = linux.read(fd, output[cursor..].ptr, output.len - cursor);
        switch (linux.errno(result)) {
            .SUCCESS => {
                const count: usize = @intCast(result);
                if (count == 0) return error.ResultMissing;
                cursor += count;
            },
            .INTR => continue,
            else => return error.ResultMissing,
        }
    }
}

fn writeAll(fd: i32, input: []const u8) SupervisorError!void {
    var cursor: usize = 0;
    while (cursor < input.len) {
        const result = linux.write(fd, input[cursor..].ptr, input.len - cursor);
        switch (linux.errno(result)) {
            .SUCCESS => {
                const count: usize = @intCast(result);
                if (count == 0) return error.ResultMissing;
                cursor += count;
            },
            .INTR => continue,
            else => return error.ResultMissing,
        }
    }
}

fn writePath(path: [*:0]const u8, contents: []const u8) SupervisorError!void {
    const raw_fd = linux.open(path, .{ .ACCMODE = .WRONLY, .CLOEXEC = true }, 0);
    if (linux.errno(raw_fd) != .SUCCESS) return error.NamespaceMappingFailed;
    const fd: i32 = @intCast(raw_fd);
    defer closeIgnore(fd);
    try writeAll(fd, contents);
}

fn readBootId(failure: SupervisorError) SupervisorError!BootId {
    var contents: [64]u8 = undefined;
    const read = try readSmallFile(
        "/proc/sys/kernel/random/boot_id",
        &contents,
        failure,
    );
    if (read.len != boot_id_length + 1 or read[boot_id_length] != '\n') return failure;
    return parseBootId(read[0..boot_id_length]) orelse failure;
}

fn readProcStartTime(pid: linux.pid_t, failure: SupervisorError) SupervisorError!u64 {
    var path_buffer: [64]u8 = undefined;
    const path = std.fmt.bufPrintZ(&path_buffer, "/proc/{d}/stat", .{pid}) catch return failure;
    var contents: [4_096]u8 = undefined;
    const read = try readSmallFile(path.ptr, &contents, failure);
    return parseProcStartTime(pid, read) orelse failure;
}

fn readPidNamespaceInode(pid: linux.pid_t, failure: SupervisorError) SupervisorError!u64 {
    var path_buffer: [64]u8 = undefined;
    const path = std.fmt.bufPrintZ(&path_buffer, "/proc/{d}/ns/pid", .{pid}) catch return failure;
    var target: [64]u8 = undefined;
    const result = linux.readlink(path.ptr, target[0..].ptr, target.len);
    if (linux.errno(result) != .SUCCESS) return failure;
    const length: usize = @intCast(result);
    if (length == target.len) return failure;
    return parsePidNamespaceInode(target[0..length]) orelse failure;
}

fn readCurrentWorkingDirectory(
    buffer: *[linux.PATH_MAX + 1]u8,
) SupervisorError![:0]const u8 {
    const result = linux.readlink("/proc/self/cwd", buffer[0..linux.PATH_MAX].ptr, linux.PATH_MAX);
    if (linux.errno(result) != .SUCCESS) return error.InvalidTarget;
    const length: usize = @intCast(result);
    if (length == 0 or length >= linux.PATH_MAX) return error.InvalidTarget;
    const path = buffer[0..length];
    if (path[0] != '/' or std.mem.endsWith(u8, path, " (deleted)")) return error.InvalidTarget;
    buffer[length] = 0;
    return buffer[0..length :0];
}

fn readSmallFile(
    path: [*:0]const u8,
    buffer: []u8,
    failure: SupervisorError,
) SupervisorError![]const u8 {
    const raw_fd = linux.open(path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true }, 0);
    if (linux.errno(raw_fd) != .SUCCESS) return failure;
    const fd: i32 = @intCast(raw_fd);
    defer closeIgnore(fd);

    var cursor: usize = 0;
    while (cursor < buffer.len) {
        const result = linux.read(fd, buffer[cursor..].ptr, buffer.len - cursor);
        switch (linux.errno(result)) {
            .SUCCESS => {
                const count: usize = @intCast(result);
                if (count == 0) return buffer[0..cursor];
                cursor += count;
            },
            .INTR => continue,
            else => return failure,
        }
    }
    // A full buffer has no proof that its last byte was EOF. Reject rather
    // than parse a potentially truncated proc record.
    return failure;
}

fn parseProcStartTime(expected_pid: linux.pid_t, contents: []const u8) ?u64 {
    const first_space = std.mem.indexOfScalar(u8, contents, ' ') orelse return null;
    const stat_pid = parseDecimalU64(contents[0..first_space]) orelse return null;
    if (stat_pid != @as(u64, @intCast(expected_pid))) return null;

    // Linux wraps comm in parentheses, and a process may put spaces or ')'
    // into comm. Its closing delimiter is therefore the final ')' in stat.
    var closing_parenthesis: ?usize = null;
    for (contents, 0..) |character, index| {
        if (character == ')') closing_parenthesis = index;
    }
    var cursor = (closing_parenthesis orelse return null) + 1;
    var token_index: usize = 0;
    while (cursor < contents.len) {
        while (cursor < contents.len and isAsciiWhitespace(contents[cursor])) : (cursor += 1) {}
        if (cursor == contents.len) break;
        const token_start = cursor;
        while (cursor < contents.len and !isAsciiWhitespace(contents[cursor])) : (cursor += 1) {}
        // Field 3 is the first token after comm, so field 22 is index 19.
        if (token_index == 19) return parseDecimalU64(contents[token_start..cursor]);
        token_index += 1;
    }
    return null;
}

fn parsePidNamespaceInode(target: []const u8) ?u64 {
    const prefix = "pid:[";
    if (!std.mem.startsWith(u8, target, prefix) or target.len <= prefix.len + 1 or target[target.len - 1] != ']') {
        return null;
    }
    return parsePositiveU64(target[prefix.len .. target.len - 1]);
}

fn isAsciiWhitespace(character: u8) bool {
    return switch (character) {
        ' ', '\t', '\n', '\r', 0x0b, 0x0c => true,
        else => false,
    };
}

fn makePipe(output: *[2]i32) SupervisorError!void {
    if (linux.errno(linux.pipe2(output, .{ .CLOEXEC = true })) != .SUCCESS) {
        return error.PipeFailed;
    }
}

fn duplicateAtLeast(source: i32, minimum: i32) SupervisorError!i32 {
    const result = linux.fcntl(source, linux.F.DUPFD_CLOEXEC, @intCast(minimum));
    if (linux.errno(result) != .SUCCESS) return error.FileDescriptorIsolationUnavailable;
    return @intCast(result);
}

fn duplicateInto(source: i32, destination: i32) SupervisorError!void {
    if (linux.errno(linux.dup3(source, destination, 0)) != .SUCCESS) {
        return error.FileDescriptorIsolationUnavailable;
    }
}

fn clearCloseOnExec(fd: i32) SupervisorError!void {
    const current = linux.fcntl(fd, linux.F.GETFD, 0);
    if (linux.errno(current) != .SUCCESS) return error.FileDescriptorIsolationUnavailable;
    const flags: usize = @intCast(current);
    if (linux.errno(linux.fcntl(fd, linux.F.SETFD, flags & ~@as(usize, linux.FD_CLOEXEC))) != .SUCCESS) {
        return error.FileDescriptorIsolationUnavailable;
    }
}

fn standardDescriptorsOpen() bool {
    for ([_]i32{ 0, 1, 2 }) |fd| {
        if (linux.errno(linux.fcntl(fd, linux.F.GETFD, 0)) != .SUCCESS) return false;
    }
    return true;
}

fn closeRangeExcept(first: i32, last: i32, preserved: i32) SupervisorError!void {
    if (first > last) return;
    if (preserved < first or preserved > last) return closeRange(first, last);
    if (preserved > first) try closeRange(first, preserved - 1);
    if (preserved < last) try closeRange(preserved + 1, last);
}

fn closeRange(first: i32, last: i32) SupervisorError!void {
    if (linux.errno(linux.close_range(first, last, .{
        .UNSHARE = false,
        .CLOEXEC = false,
    })) != .SUCCESS) return error.FileDescriptorIsolationUnavailable;
}

fn closeIgnore(fd: i32) void {
    _ = linux.close(fd);
}

fn failControlAndExit(fd: i32, nonce: Nonce, err: SupervisorError) noreturn {
    emitFail(fd, nonce, errorCode(err));
    closeIgnore(fd);
    linux.exit(1);
}

fn initExit(result_fd: i32, kind: u8, status: u32) noreturn {
    const result = TargetResult{
        .kind = kind,
        .reserved = .{ 0, 0, 0 },
        .wait_status = status,
    };
    writeAll(result_fd, std.mem.asBytes(&result)) catch {};
    linux.exit(1);
}

fn nonceHex(nonce: Nonce) [nonce_hex_length]u8 {
    const digits = "0123456789abcdef";
    var rendered: [nonce_hex_length]u8 = undefined;
    for (nonce, 0..) |byte, index| {
        rendered[index * 2] = digits[byte >> 4];
        rendered[index * 2 + 1] = digits[byte & 0x0f];
    }
    return rendered;
}

fn emitReady(
    fd: i32,
    nonce: Nonce,
    identity: LaunchIdentity,
    outer_pgid: linux.pid_t,
    init_identity: InitIdentity,
    ready_monotonic_ms: u64,
) SupervisorError!void {
    const nonce_text = nonceHex(nonce);
    var line: [512]u8 = undefined;
    const rendered = std.fmt.bufPrint(
        &line,
        protocol_prefix ++ "READY nonce={s} outer_pid={d} outer_pgid={d} outer_start_time={d} boot_id={s} init_host_pid={d} init_start_time={d} init_pid_namespace_inode={d} ns_init_pid=1 monotonic_ms={d}\n",
        .{ &nonce_text, identity.outer_pid, outer_pgid, identity.outer_start_time, &identity.boot_id, init_identity.host_pid, init_identity.start_time, init_identity.pid_namespace_inode, ready_monotonic_ms },
    ) catch return error.ResultMissing;
    try writeAll(fd, rendered);
}

fn emitRecoveryReady(
    fd: i32,
    nonce: Nonce,
    recovery_identity: RecoveryHelperIdentity,
    recovery: RecoveryConfig,
) SupervisorError!void {
    const nonce_text = nonceHex(nonce);
    var line: [512]u8 = undefined;
    const rendered = std.fmt.bufPrint(
        &line,
        protocol_prefix ++ "RECOVERY_READY nonce={s} recovery_pid={d} recovery_start_time={d} outer_pid={d} outer_start_time={d} init_host_pid={d} init_start_time={d} init_pid_namespace_inode={d}\n",
        .{ &nonce_text, recovery_identity.pid, recovery_identity.start_time, recovery.outer_pid, recovery.outer_start_time, recovery.init_host_pid, recovery.init_start_time, recovery.init_pid_namespace_inode },
    ) catch return error.ResultMissing;
    try writeAll(fd, rendered);
}

fn emitRecoveryClean(
    fd: i32,
    nonce: Nonce,
    recovery_identity: RecoveryHelperIdentity,
    recovery: RecoveryConfig,
    method: RecoveryMethod,
) SupervisorError!void {
    const nonce_text = nonceHex(nonce);
    const method_text = switch (method) {
        .pidfd_sigkill => "pidfd-sigkill",
        .pidfd_already_exited => "pidfd-already-exited",
    };
    var line: [512]u8 = undefined;
    const rendered = std.fmt.bufPrint(
        &line,
        protocol_prefix ++ "RECOVERY_CLEAN nonce={s} recovery_pid={d} recovery_start_time={d} outer_pid={d} outer_start_time={d} boot_id={s} init_host_pid={d} init_start_time={d} init_pid_namespace_inode={d} method={s}\n",
        .{ &nonce_text, recovery_identity.pid, recovery_identity.start_time, recovery.outer_pid, recovery.outer_start_time, &recovery.boot_id, recovery.init_host_pid, recovery.init_start_time, recovery.init_pid_namespace_inode, method_text },
    ) catch return error.ResultMissing;
    try writeAll(fd, rendered);
}

fn emitClean(fd: i32, nonce: Nonce, exit_code: u8) SupervisorError!void {
    const nonce_text = nonceHex(nonce);
    var line: [128]u8 = undefined;
    const rendered = std.fmt.bufPrint(
        &line,
        protocol_prefix ++ "CLEAN nonce={s} exit={d}\n",
        .{ &nonce_text, exit_code },
    ) catch return error.ResultMissing;
    try writeAll(fd, rendered);
}

fn emitFail(fd: i32, nonce: Nonce, code: []const u8) void {
    const nonce_text = nonceHex(nonce);
    var line: [160]u8 = undefined;
    const rendered = std.fmt.bufPrint(
        &line,
        protocol_prefix ++ "FAIL nonce={s} code={s}\n",
        .{ &nonce_text, code },
    ) catch return;
    writeAll(fd, rendered) catch {};
}

fn errorCode(err: SupervisorError) []const u8 {
    return switch (err) {
        error.InvalidArguments => "invalid_arguments",
        error.InvalidTarget => "invalid_target",
        error.InvalidControlSocket => "invalid_control_socket",
        error.ControlConnectFailed => "control_connect_failed",
        error.NamespaceUnavailable => "namespace_unavailable",
        error.NamespaceMappingFailed => "namespace_mapping_failed",
        error.MountIsolationFailed => "mount_isolation_failed",
        error.MountTableInvalid => "mount_table_invalid",
        error.MountAliasUnsafe => "mount_alias_unsafe",
        error.SupervisorHardeningFailed => "supervisor_hardening_failed",
        error.TargetHardeningFailed => "target_hardening_failed",
        error.FileDescriptorIsolationUnavailable => "fd_isolation_unavailable",
        error.PipeFailed => "pipe_failed",
        error.ForkFailed => "fork_failed",
        error.InitNotReady => "init_not_ready",
        error.ParentExited => "parent_exited",
        error.ControlProtocolRejected => "control_rejected",
        error.TargetStartFailed => "target_start_failed",
        error.ResultMissing => "result_missing",
        error.InitExitedAbruptly => "init_exited_abruptly",
        error.WaitFailed => "wait_failed",
        error.CleanupUnproven => "cleanup_unproven",
        error.LaunchIdentityUnavailable => "launch_identity_unavailable",
        error.RecoveryUnsafeTarget => "recovery_unsafe_target",
        error.RecoveryBootIdUnavailable => "recovery_boot_id_unavailable",
        error.RecoveryBootIdMismatch => "recovery_boot_id_mismatch",
        error.RecoverySelfIdentityUnavailable => "recovery_self_identity_unavailable",
        error.RecoveryProcUnavailable => "recovery_proc_unavailable",
        error.RecoveryStartTimeMismatch => "recovery_start_time_mismatch",
        error.RecoveryPidfdUnavailable => "recovery_pidfd_unavailable",
        error.RecoveryOuterNotLive => "recovery_outer_not_live",
        error.RecoveryInitPidfdUnavailable => "recovery_init_pidfd_unavailable",
        error.RecoveryInitProcUnavailable => "recovery_init_proc_unavailable",
        error.RecoveryInitStartTimeMismatch => "recovery_init_start_time_mismatch",
        error.RecoveryInitNamespaceMismatch => "recovery_init_namespace_mismatch",
        error.RecoveryInitNotLive => "recovery_init_not_live",
        error.RecoverySignalFailed => "recovery_signal_failed",
        error.RecoveryExitTimeout => "recovery_exit_timeout",
        error.RecoveryWaitFailed => "recovery_wait_failed",
    };
}
