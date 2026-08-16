const std = @import("std");
const builtin = @import("builtin");

const Allocator = std.mem.Allocator;
const Dir = std.Io.Dir;
const File = std.Io.File;
const Io = std.Io;
const c = std.c;

const request_kind = "hraness-kitchen-local-data-removal";
// Signed v1 JSON identifiers are immutable compatibility data shared with
// already-shipped helpers. A future spelling change requires a v2 protocol.
const predecessor_codex_profile_category = "kitchen_codex_profile_data";
const request_version: u8 = 1;
const helper_state_directory_name = "OPRTE Removal";
const signing_key_file_name = "removal-signing.key";
const execution_lock_file_name = "execution.lock";
const gateway_receipts_directory_name = "gateway-receipts";
const requests_directory_name = "requests";
const helper_receipts_directory_name = "helper-receipts";
const staging_directory_name = "staging";
const uncommitted_private_directory_names = [_][]const u8{
    gateway_receipts_directory_name,
    requests_directory_name,
    helper_receipts_directory_name,
    staging_directory_name,
};
// The v1 parent/helper handshake token is a stable protocol identifier.
const ready_message = "KITCHEN_REMOVAL_READY_V1\n";
const completion_proof_kind =
    "hraness-kitchen-local-data-removal-completion";
const internal_completion_proof_directory_name = "completion-proof";
const completion_proof_file_name = "completion.json";
const completion_proof_key_file_name = "completion.key";
const maximum_request_bytes = 64 * 1024 * 1024;
const maximum_receipt_bytes = 4 * 1024 * 1024;
const maximum_pointer_bytes = 4096;
const maximum_targets = 4096;
const maximum_owned_roots_per_category = 64;
const private_directory_mode: c.mode_t = 0o700;
const private_file_mode: c.mode_t = 0o600;
const control_plane_file_name = "control-plane.sqlite";
const operation_receipt_key_file_name = "operation-receipts.hmac.key";
const account_codex_directory_name = "codex";
const account_profiles_directory_name = "accounts";
const account_home_directory_name = "home";
const account_runtime_directory_name = "runtime";
const account_home_deletion_receipt_name =
    ".account-home-deletion-v1.receipt";

extern "c" fn flock(fd: c.fd_t, operation: c_int) c_int;
extern "c" fn mkfifoat(fd: c.fd_t, path: [*:0]const u8, mode: c.mode_t) c_int;
extern "c" fn renameatx_np(
    from_fd: c.fd_t,
    from: [*:0]const u8,
    to_fd: c.fd_t,
    to: [*:0]const u8,
    flags: c_uint,
) c_int;

const LOCK_EX: c_int = 0x02;
const LOCK_NB: c_int = 0x04;
const RENAME_EXCL: c_uint = 0x00000004;

const RemovalError = error{
    ActiveOperation,
    CrossDeviceTarget,
    DirtyWorktreeNeedsAcknowledgement,
    ExpiredRequest,
    GitFailure,
    InvalidArguments,
    InvalidParent,
    InvalidReceipt,
    InvalidRequest,
    InvalidSignature,
    IoFailure,
    LifecycleFailure,
    OperationConflict,
    OutOfMemory,
    ParentWaitFailure,
    PathAbsent,
    UnsafePath,
};

const Registration = struct {
    administrativeDirectory: []const u8,
    gitCommonDirectory: []const u8,
    repositoryPath: []const u8,
};

const Target = struct {
    category: []const u8,
    dirty: ?bool = null,
    id: []const u8,
    kind: []const u8,
    path: []const u8,
    registration: ?Registration = null,
};

const OwnedRoots = struct {
    applicationState: []const []const u8,
    controlPlane: []const []const u8,
    helperStateRoot: []const u8,
    kitchenCodexProfileData: []const []const u8,
    managedWorktrees: []const []const u8,
    releaseUpdateArtifacts: []const []const u8,
};

const Payload = struct {
    acknowledgeDirtyWorktrees: bool,
    allowlistDigest: []const u8,
    exclusionPath: []const u8,
    executionLockPath: []const u8,
    expiresAt: u64,
    helperStateRoot: []const u8,
    inventoryDigest: []const u8,
    issuedAt: u64,
    kind: []const u8,
    operationId: []const u8,
    ownedRoots: OwnedRoots,
    parentProcessId: u32,
    preservedUserRepositories: []const []const u8,
    previewId: []const u8,
    receiptPath: []const u8,
    stageRoot: []const u8,
    targets: []const Target,
    version: u8,
    waitForParentExit: bool,
};

const SignedRequest = struct {
    payload: Payload,
    signature: []const u8,
};

const TargetProgress = struct {
    id: []const u8,
    state: []const u8,
};

const HelperReceipt = struct {
    operationId: []const u8,
    requestDigest: []const u8,
    state: []const u8,
    targets: []TargetProgress,
    version: u8,
};

const CompletionProofBody = struct {
    kind: []const u8,
    operationId: []const u8,
    requestDigest: []const u8,
    version: u8,
};

const SignedCompletionProof = struct {
    body: CompletionProofBody,
    signature: []const u8,
};

const AllowlistEnvelope = struct {
    roots: OwnedRoots,
    version: u8,
};

const AccountProfileAuthority = struct {
    state_root_device: u64,
    state_root_inode: u64,
    control_plane_device: u64,
    control_plane_inode: u64,
};

const AccountProfileCliOptions = struct {
    account_profile_id: []const u8,
    control_plane_path: []const u8,
    authority: AccountProfileAuthority,
    deletion_nonce: ?[]const u8 = null,
    expected_revision: u64 = 0,
};

const Cli = union(enum) {
    delete_account_home: AccountProfileCliOptions,
    ensure_account_profile: AccountProfileCliOptions,
    execute: struct {
        parent_pid: u32,
        ready_fd: c.fd_t,
        request_path: []const u8,
        signing_key_path: []const u8,
    },
    recover_staged: struct {
        helper_state_root: []const u8,
    },
};

const PathParent = struct {
    fd: c.fd_t,
    leaf: []const u8,

    fn close(self: *PathParent) void {
        _ = c.close(self.fd);
        self.* = undefined;
    }
};

const OpenedNode = struct {
    fd: c.fd_t,
    stat: c.Stat,
    parent: PathParent,

    fn close(self: *OpenedNode) void {
        _ = c.close(self.fd);
        self.parent.close();
        self.* = undefined;
    }
};

const PathState = union(enum) {
    absent,
    present: OpenedNode,
};

const UncommittedRecoveryState = enum {
    no_live_state,
    live_state_untouched,
    recovered,
};

const UncommittedTreeState = enum {
    exact_empty,
    contains_operation_state,
};

const StageContext = struct {
    allocator: Allocator,
    io: Io,
    root_device: c.dev_t,
    stage_dir: c.fd_t,
};

pub fn main(init: std.process.Init) !void {
    if (builtin.os.tag != .macos) {
        std.process.exit(70);
    }

    const result = runMain(init) catch |err| {
        writeFailure(init.io, err);
        std.process.exit(exitCode(err));
    };
    _ = result;
}

fn runMain(init: std.process.Init) RemovalError!void {
    var iterator = std.process.Args.Iterator.init(init.minimal.args);
    _ = iterator.next();
    const cli = try parseCli(&iterator);
    switch (cli) {
        .delete_account_home => |options| try deleteAccountHome(
            init.gpa,
            init.io,
            options.control_plane_path,
            options.account_profile_id,
            options.authority,
            options.deletion_nonce orelse return error.InvalidArguments,
            options.expected_revision,
        ),
        .ensure_account_profile => |options| try ensureAccountProfile(
            options.control_plane_path,
            options.account_profile_id,
            options.authority,
        ),
        .execute => |options| try execute(
            init.gpa,
            init.io,
            options.request_path,
            options.signing_key_path,
            options.parent_pid,
            options.ready_fd,
        ),
        .recover_staged => |options| try recoverStaged(
            init.gpa,
            init.io,
            options.helper_state_root,
        ),
    }
}

fn parseCli(iterator: *std.process.Args.Iterator) RemovalError!Cli {
    const command = iterator.next() orelse return error.InvalidArguments;
    if (std.mem.eql(u8, command, "delete-account-home") or
        std.mem.eql(u8, command, "ensure-account-profile"))
    {
        const deletes_home =
            std.mem.eql(u8, command, "delete-account-home");
        const options = try parseAccountProfileCliOptions(
            iterator,
            deletes_home,
        );
        return if (deletes_home)
            .{ .delete_account_home = options }
        else
            .{ .ensure_account_profile = options };
    }
    if (std.mem.eql(u8, command, "execute")) {
        var request_path: ?[]const u8 = null;
        var signing_key_path: ?[]const u8 = null;
        var parent_pid: ?u32 = null;
        var ready_fd: ?c.fd_t = null;
        while (iterator.next()) |argument| {
            if (std.mem.eql(u8, argument, "--request-path")) {
                if (request_path != null) return error.InvalidArguments;
                request_path = iterator.next() orelse return error.InvalidArguments;
            } else if (std.mem.eql(u8, argument, "--signing-key-path")) {
                if (signing_key_path != null) return error.InvalidArguments;
                signing_key_path = iterator.next() orelse return error.InvalidArguments;
            } else if (std.mem.eql(u8, argument, "--parent-pid")) {
                if (parent_pid != null) return error.InvalidArguments;
                const raw = iterator.next() orelse return error.InvalidArguments;
                parent_pid = std.fmt.parseInt(u32, raw, 10) catch
                    return error.InvalidArguments;
            } else if (std.mem.eql(u8, argument, "--ready-fd")) {
                if (ready_fd != null) return error.InvalidArguments;
                const raw = iterator.next() orelse return error.InvalidArguments;
                const parsed = std.fmt.parseInt(c.fd_t, raw, 10) catch
                    return error.InvalidArguments;
                if (parsed < 3) return error.InvalidArguments;
                ready_fd = parsed;
            } else {
                return error.InvalidArguments;
            }
        }
        return .{ .execute = .{
            .request_path = request_path orelse return error.InvalidArguments,
            .signing_key_path = signing_key_path orelse return error.InvalidArguments,
            .parent_pid = parent_pid orelse return error.InvalidArguments,
            .ready_fd = ready_fd orelse return error.InvalidArguments,
        } };
    }
    if (std.mem.eql(u8, command, "recover-staged")) {
        const flag = iterator.next() orelse return error.InvalidArguments;
        if (!std.mem.eql(u8, flag, "--helper-state-root")) {
            return error.InvalidArguments;
        }
        const helper_state_root = iterator.next() orelse
            return error.InvalidArguments;
        if (iterator.next() != null) return error.InvalidArguments;
        return .{ .recover_staged = .{
            .helper_state_root = helper_state_root,
        } };
    }
    return error.InvalidArguments;
}

fn parseAccountProfileCliOptions(
    iterator: *std.process.Args.Iterator,
    deletes_home: bool,
) RemovalError!AccountProfileCliOptions {
    var control_plane_path: ?[]const u8 = null;
    var account_profile_id: ?[]const u8 = null;
    var state_root_device: ?u64 = null;
    var state_root_inode: ?u64 = null;
    var control_plane_device: ?u64 = null;
    var control_plane_inode: ?u64 = null;
    var deletion_nonce: ?[]const u8 = null;
    var expected_revision: ?u64 = null;
    while (iterator.next()) |argument| {
        const value = iterator.next() orelse return error.InvalidArguments;
        if (std.mem.eql(u8, argument, "--control-plane-path")) {
            if (control_plane_path != null) return error.InvalidArguments;
            control_plane_path = value;
        } else if (std.mem.eql(u8, argument, "--account-profile-id")) {
            if (account_profile_id != null) return error.InvalidArguments;
            account_profile_id = value;
        } else if (std.mem.eql(u8, argument, "--state-root-device")) {
            if (state_root_device != null) return error.InvalidArguments;
            state_root_device = parseCanonicalPositiveU64(value) orelse
                return error.InvalidArguments;
        } else if (std.mem.eql(u8, argument, "--state-root-inode")) {
            if (state_root_inode != null) return error.InvalidArguments;
            state_root_inode = parseCanonicalPositiveU64(value) orelse
                return error.InvalidArguments;
        } else if (std.mem.eql(u8, argument, "--control-plane-device")) {
            if (control_plane_device != null) return error.InvalidArguments;
            control_plane_device = parseCanonicalPositiveU64(value) orelse
                return error.InvalidArguments;
        } else if (std.mem.eql(u8, argument, "--control-plane-inode")) {
            if (control_plane_inode != null) return error.InvalidArguments;
            control_plane_inode = parseCanonicalPositiveU64(value) orelse
                return error.InvalidArguments;
        } else if (std.mem.eql(u8, argument, "--deletion-nonce")) {
            if (!deletes_home or deletion_nonce != null or
                !validPrefixedHex(value, "deletion_", 64))
            {
                return error.InvalidArguments;
            }
            deletion_nonce = value;
        } else if (std.mem.eql(u8, argument, "--expected-revision")) {
            if (!deletes_home or expected_revision != null) {
                return error.InvalidArguments;
            }
            const revision = parseCanonicalPositiveU64(value) orelse
                return error.InvalidArguments;
            if (revision > 9_007_199_254_740_991) {
                return error.InvalidArguments;
            }
            expected_revision = revision;
        } else {
            return error.InvalidArguments;
        }
    }
    const parsed_control_plane_path = control_plane_path orelse
        return error.InvalidArguments;
    const parsed_account_profile_id = account_profile_id orelse
        return error.InvalidArguments;
    validateNormalizedAbsolute(parsed_control_plane_path) catch
        return error.InvalidArguments;
    if (!std.mem.eql(
        u8,
        std.fs.path.basename(parsed_control_plane_path),
        control_plane_file_name,
    ) or
        std.mem.eql(
            u8,
            std.fs.path.dirname(parsed_control_plane_path) orelse "",
            "/",
        ) or
        !validAccountProfileId(parsed_account_profile_id) or
        (deletes_home and
            (deletion_nonce == null or expected_revision == null)) or
        (!deletes_home and
            (deletion_nonce != null or expected_revision != null)))
    {
        return error.InvalidArguments;
    }
    return .{
        .control_plane_path = parsed_control_plane_path,
        .account_profile_id = parsed_account_profile_id,
        .authority = .{
            .state_root_device = state_root_device orelse
                return error.InvalidArguments,
            .state_root_inode = state_root_inode orelse
                return error.InvalidArguments,
            .control_plane_device = control_plane_device orelse
                return error.InvalidArguments,
            .control_plane_inode = control_plane_inode orelse
                return error.InvalidArguments,
        },
        .deletion_nonce = deletion_nonce,
        .expected_revision = expected_revision orelse 0,
    };
}

fn parseCanonicalPositiveU64(value: []const u8) ?u64 {
    if (value.len == 0 or value.len > 20 or
        (value.len > 1 and value[0] == '0'))
    {
        return null;
    }
    for (value) |byte| {
        if (!std.ascii.isDigit(byte)) return null;
    }
    const parsed = std.fmt.parseInt(u64, value, 10) catch return null;
    return if (parsed == 0) null else parsed;
}

const AuthorizedControlPlane = struct {
    state_root: PathParent,
    state_stat: c.Stat,
    control_plane_fd: c.fd_t,

    fn close(self: *AuthorizedControlPlane) void {
        _ = c.close(self.control_plane_fd);
        self.state_root.close();
        self.* = undefined;
    }
};

fn statDevice(stat: c.Stat) u64 {
    return @intCast(stat.dev);
}

fn statInode(stat: c.Stat) u64 {
    return @intCast(stat.ino);
}

/// Proves that the state root and database reached by the fixed path are the
/// exact objects whose identities the live gateway captured and held open.
fn openAuthorizedControlPlane(
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    authority: AccountProfileAuthority,
) RemovalError!AuthorizedControlPlane {
    try validateNormalizedAbsolute(control_plane_path);
    if (!std.mem.eql(
        u8,
        std.fs.path.basename(control_plane_path),
        control_plane_file_name,
    ) or
        !validAccountProfileId(account_profile_id) or
        std.mem.eql(
            u8,
            std.fs.path.dirname(control_plane_path) orelse "",
            "/",
        ))
    {
        return error.UnsafePath;
    }

    var state_root = try openParentNoFollow(control_plane_path);
    errdefer state_root.close();
    if (!std.mem.eql(u8, state_root.leaf, control_plane_file_name)) {
        return error.UnsafePath;
    }
    var state_stat: c.Stat = undefined;
    if (c.fstat(state_root.fd, &state_stat) != 0 or
        !c.S.ISDIR(state_stat.mode) or
        state_stat.uid != c.geteuid() or
        state_stat.mode & 0o777 != private_directory_mode or
        statDevice(state_stat) != authority.state_root_device or
        statInode(state_stat) != authority.state_root_inode)
    {
        return error.UnsafePath;
    }

    const control_plane_z = try stackZ(control_plane_file_name);
    var observed: c.Stat = undefined;
    if (c.fstatat(
        state_root.fd,
        &control_plane_z,
        &observed,
        c.AT.SYMLINK_NOFOLLOW,
    ) != 0 or
        !c.S.ISREG(observed.mode) or
        observed.uid != c.geteuid() or
        observed.nlink != 1 or
        observed.mode & 0o777 != private_file_mode or
        observed.dev != state_stat.dev or
        statDevice(observed) != authority.control_plane_device or
        statInode(observed) != authority.control_plane_inode)
    {
        return error.UnsafePath;
    }
    const control_plane_fd = c.openat(
        state_root.fd,
        &control_plane_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .NONBLOCK = true,
            .NOFOLLOW = true,
        },
    );
    if (control_plane_fd < 0) {
        return switch (c.errno(control_plane_fd)) {
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(control_plane_fd);
    var opened: c.Stat = undefined;
    if (c.fstat(control_plane_fd, &opened) != 0 or
        !c.S.ISREG(opened.mode) or
        opened.uid != c.geteuid() or
        opened.nlink != 1 or
        opened.mode & 0o777 != private_file_mode or
        opened.dev != observed.dev or
        opened.ino != observed.ino or
        statDevice(opened) != authority.control_plane_device or
        statInode(opened) != authority.control_plane_inode)
    {
        return error.UnsafePath;
    }
    return .{
        .state_root = state_root,
        .state_stat = state_stat,
        .control_plane_fd = control_plane_fd,
    };
}

/// Opens the published directory without following it, repairs its mode
/// through that descriptor, and then revalidates the published identity.
fn repairPrivateDirectDirectory(
    parent_fd: c.fd_t,
    leaf: []const u8,
    expected_device: c.dev_t,
) RemovalError!c.fd_t {
    return repairPrivateDirectDirectoryWithHook(
        parent_fd,
        leaf,
        expected_device,
        null,
    );
}

fn repairPrivateDirectDirectoryWithHook(
    parent_fd: c.fd_t,
    leaf: []const u8,
    expected_device: c.dev_t,
    after_open: ?*const fn (c.fd_t, []const u8) void,
) RemovalError!c.fd_t {
    if (!validLeafName(leaf)) return error.UnsafePath;
    const leaf_z = try stackZ(leaf);
    var observed: c.Stat = undefined;
    var status = c.fstatat(
        parent_fd,
        &leaf_z,
        &observed,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (status != 0) {
        if (c.errno(status) != .NOENT) {
            return switch (c.errno(status)) {
                .LOOP, .NOTDIR => error.UnsafePath,
                else => error.IoFailure,
            };
        }
        const mkdir_status = c.mkdirat(
            parent_fd,
            &leaf_z,
            private_directory_mode,
        );
        if (mkdir_status != 0 and c.errno(mkdir_status) != .EXIST) {
            return error.IoFailure;
        }
        status = c.fstatat(
            parent_fd,
            &leaf_z,
            &observed,
            c.AT.SYMLINK_NOFOLLOW,
        );
        if (status != 0) return error.OperationConflict;
    }
    if (!c.S.ISDIR(observed.mode) or
        observed.uid != c.geteuid() or
        observed.dev != expected_device)
    {
        return error.UnsafePath;
    }
    const fd = c.openat(
        parent_fd,
        &leaf_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.OperationConflict,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(fd);
    var opened: c.Stat = undefined;
    if (c.fstat(fd, &opened) != 0 or
        opened.dev != observed.dev or
        opened.ino != observed.ino or
        !c.S.ISDIR(opened.mode) or
        opened.uid != c.geteuid() or
        opened.dev != expected_device)
    {
        return error.OperationConflict;
    }
    if (after_open) |hook| hook(parent_fd, leaf);
    if (c.fchmod(fd, private_directory_mode) != 0) return error.IoFailure;
    var repaired: c.Stat = undefined;
    var published: c.Stat = undefined;
    if (c.fstat(fd, &repaired) != 0 or
        repaired.dev != opened.dev or
        repaired.ino != opened.ino or
        !c.S.ISDIR(repaired.mode) or
        repaired.uid != c.geteuid() or
        repaired.mode & 0o777 != private_directory_mode or
        c.fstatat(
            parent_fd,
            &leaf_z,
            &published,
            c.AT.SYMLINK_NOFOLLOW,
        ) != 0 or
        published.dev != repaired.dev or
        published.ino != repaired.ino or
        !c.S.ISDIR(published.mode) or
        published.uid != c.geteuid() or
        published.mode & 0o777 != private_directory_mode)
    {
        return error.OperationConflict;
    }
    try fsyncFd(parent_fd);
    return fd;
}

fn ensureAccountProfile(
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    authority: AccountProfileAuthority,
) RemovalError!void {
    var authorized = try openAuthorizedControlPlane(
        control_plane_path,
        account_profile_id,
        authority,
    );
    defer authorized.close();
    const codex_fd = try repairPrivateDirectDirectory(
        authorized.state_root.fd,
        account_codex_directory_name,
        authorized.state_stat.dev,
    );
    defer _ = c.close(codex_fd);
    const accounts_fd = try repairPrivateDirectDirectory(
        codex_fd,
        account_profiles_directory_name,
        authorized.state_stat.dev,
    );
    defer _ = c.close(accounts_fd);
    const profile_fd = try repairPrivateDirectDirectory(
        accounts_fd,
        account_profile_id,
        authorized.state_stat.dev,
    );
    defer _ = c.close(profile_fd);
    const home_fd = try repairPrivateDirectDirectory(
        profile_fd,
        account_home_directory_name,
        authorized.state_stat.dev,
    );
    defer _ = c.close(home_fd);
    const runtime_fd = try repairPrivateDirectDirectory(
        profile_fd,
        account_runtime_directory_name,
        authorized.state_stat.dev,
    );
    _ = c.close(runtime_fd);
}

fn readAccountDeletionKey(
    io: Io,
    state_root_fd: c.fd_t,
    expected_device: c.dev_t,
) RemovalError![32]u8 {
    const key_z = try stackZ(operation_receipt_key_file_name);
    var observed: c.Stat = undefined;
    if (c.fstatat(
        state_root_fd,
        &key_z,
        &observed,
        c.AT.SYMLINK_NOFOLLOW,
    ) != 0 or
        !c.S.ISREG(observed.mode) or
        observed.uid != c.geteuid() or
        observed.nlink != 1 or
        observed.mode & 0o777 != private_file_mode or
        observed.size != 32 or
        observed.dev != expected_device)
    {
        return error.UnsafePath;
    }
    const fd = c.openat(
        state_root_fd,
        &key_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .NONBLOCK = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) return error.UnsafePath;
    defer _ = c.close(fd);
    var opened: c.Stat = undefined;
    if (c.fstat(fd, &opened) != 0 or
        !c.S.ISREG(opened.mode) or
        opened.uid != c.geteuid() or
        opened.nlink != 1 or
        opened.mode & 0o777 != private_file_mode or
        opened.size != 32 or
        opened.dev != observed.dev or
        opened.ino != observed.ino)
    {
        return error.UnsafePath;
    }
    var key: [32]u8 = undefined;
    const file = File{
        .handle = fd,
        .flags = .{ .nonblocking = false },
    };
    const read = file.readPositionalAll(io, &key, 0) catch
        return error.IoFailure;
    if (read != key.len) return error.IoFailure;
    var published: c.Stat = undefined;
    if (c.fstatat(
        state_root_fd,
        &key_z,
        &published,
        c.AT.SYMLINK_NOFOLLOW,
    ) != 0 or
        published.dev != opened.dev or
        published.ino != opened.ino or
        published.uid != opened.uid or
        published.nlink != 1 or
        published.mode & 0o777 != private_file_mode or
        published.size != 32)
    {
        return error.OperationConflict;
    }
    return key;
}

fn accountDeletionNonce(
    allocator: Allocator,
    key: *const [32]u8,
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    authority: AccountProfileAuthority,
    expected_revision: u64,
) RemovalError![]u8 {
    const transcript = std.fmt.allocPrint(
        allocator,
        "hraness-kitchen-account-home-deletion-v1\x00{s}\x00{d}\x00{d}\x00{d}\x00{d}\x00{s}\x00{d}",
        .{
            control_plane_path,
            authority.state_root_device,
            authority.state_root_inode,
            authority.control_plane_device,
            authority.control_plane_inode,
            account_profile_id,
            expected_revision,
        },
    ) catch return error.OutOfMemory;
    defer allocator.free(transcript);
    var digest: [32]u8 = undefined;
    std.crypto.auth.hmac.sha2.HmacSha256.create(
        &digest,
        transcript,
        key,
    );
    return std.fmt.allocPrint(
        allocator,
        "deletion_{x}",
        .{digest},
    ) catch return error.OutOfMemory;
}

/// Removes only `codex/accounts/<account-id>/home` below the exact live
/// control-plane identity. A durable, request-bound receipt is committed
/// before the first mutation. Only a retry presenting that exact receipt may
/// treat an already-absent home as success.
fn deleteAccountHome(
    allocator: Allocator,
    io: Io,
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    authority: AccountProfileAuthority,
    deletion_nonce: []const u8,
    expected_revision: u64,
) RemovalError!void {
    if (!validPrefixedHex(deletion_nonce, "deletion_", 64) or
        expected_revision == 0 or
        expected_revision > 9_007_199_254_740_991)
    {
        return error.UnsafePath;
    }
    var authorized = try openAuthorizedControlPlane(
        control_plane_path,
        account_profile_id,
        authority,
    );
    defer authorized.close();
    var deletion_key = try readAccountDeletionKey(
        io,
        authorized.state_root.fd,
        authorized.state_stat.dev,
    );
    defer @memset(&deletion_key, 0);
    const expected_nonce = try accountDeletionNonce(
        allocator,
        &deletion_key,
        control_plane_path,
        account_profile_id,
        authority,
        expected_revision,
    );
    defer allocator.free(expected_nonce);
    if (!constantTimeStringEqual(deletion_nonce, expected_nonce)) {
        return error.InvalidSignature;
    }
    try deleteAccountHomeBelowStateRoot(
        allocator,
        io,
        authorized.state_root.fd,
        authorized.state_stat,
        account_profile_id,
        authority,
        deletion_nonce,
        expected_revision,
    );
}

fn deleteAccountHomeBelowStateRoot(
    allocator: Allocator,
    io: Io,
    state_root_fd: c.fd_t,
    state_stat: c.Stat,
    account_profile_id: []const u8,
    authority: AccountProfileAuthority,
    deletion_nonce: []const u8,
    expected_revision: u64,
) RemovalError!void {
    const codex_fd = (try openOptionalPrivateDirectDirectory(
        state_root_fd,
        account_codex_directory_name,
        state_stat.dev,
    )) orelse return error.PathAbsent;
    defer _ = c.close(codex_fd);
    const accounts_fd = (try openOptionalPrivateDirectDirectory(
        codex_fd,
        account_profiles_directory_name,
        state_stat.dev,
    )) orelse return error.PathAbsent;
    defer _ = c.close(accounts_fd);
    const profile_fd = (try openOptionalPrivateDirectDirectory(
        accounts_fd,
        account_profile_id,
        state_stat.dev,
    )) orelse return error.PathAbsent;
    defer _ = c.close(profile_fd);

    const expected_receipt = std.fmt.allocPrint(
        allocator,
        "v1\naccount={s}\nrevision={d}\nnonce={s}\nstate={d}:{d}\ncontrol={d}:{d}\n",
        .{
            account_profile_id,
            expected_revision,
            deletion_nonce,
            authority.state_root_device,
            authority.state_root_inode,
            authority.control_plane_device,
            authority.control_plane_inode,
        },
    ) catch return error.OutOfMemory;
    defer allocator.free(expected_receipt);

    const receipt_z = try stackZ(account_home_deletion_receipt_name);
    var receipt_stat: c.Stat = undefined;
    const receipt_status = c.fstatat(
        profile_fd,
        &receipt_z,
        &receipt_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    const receipt_exists = receipt_status == 0;
    if (!receipt_exists and c.errno(receipt_status) != .NOENT) {
        return error.InvalidReceipt;
    }
    if (receipt_exists) {
        const receipt = try readDirectPrivateFile(
            allocator,
            io,
            profile_fd,
            account_home_deletion_receipt_name,
            1024,
            null,
        );
        defer allocator.free(receipt);
        if (!constantTimeStringEqual(receipt, expected_receipt)) {
            return error.InvalidReceipt;
        }
    }

    const optional_home_fd = try openOptionalPrivateDirectDirectory(
        profile_fd,
        account_home_directory_name,
        state_stat.dev,
    );
    if (optional_home_fd == null) {
        if (!receipt_exists) return error.PathAbsent;
        try fsyncFd(profile_fd);
        return;
    }
    const home_fd = optional_home_fd.?;
    defer _ = c.close(home_fd);
    var home_stat: c.Stat = undefined;
    if (c.fstat(home_fd, &home_stat) != 0) return error.IoFailure;

    // Validate the complete tree before committing authorization or mutating.
    try validateAccountHomeTree(io, home_fd, state_stat.dev);
    if (!receipt_exists) {
        try writeNewPrivateDirectFile(
            io,
            profile_fd,
            account_home_deletion_receipt_name,
            expected_receipt,
            false,
        );
        try fsyncFd(profile_fd);
    }
    try removeAccountHomeContents(
        allocator,
        io,
        home_fd,
        state_stat.dev,
    );

    const home_z = try stackZ(account_home_directory_name);
    var final_home_stat: c.Stat = undefined;
    if (c.fstatat(
        profile_fd,
        &home_z,
        &final_home_stat,
        c.AT.SYMLINK_NOFOLLOW,
    ) != 0 or
        final_home_stat.dev != home_stat.dev or
        final_home_stat.ino != home_stat.ino or
        !c.S.ISDIR(final_home_stat.mode) or
        final_home_stat.uid != c.geteuid() or
        final_home_stat.mode & 0o777 != private_directory_mode)
    {
        return error.OperationConflict;
    }
    const unlink_status = c.unlinkat(
        profile_fd,
        &home_z,
        c.AT.REMOVEDIR,
    );
    if (unlink_status != 0) {
        return switch (c.errno(unlink_status)) {
            .NOENT, .NOTEMPTY => error.OperationConflict,
            else => error.IoFailure,
        };
    }
    try fsyncFd(profile_fd);
}

fn openOptionalPrivateDirectDirectory(
    parent_fd: c.fd_t,
    leaf: []const u8,
    expected_device: c.dev_t,
) RemovalError!?c.fd_t {
    if (!validLeafName(leaf)) return error.UnsafePath;
    const leaf_z = try stackZ(leaf);
    var observed: c.Stat = undefined;
    const status = c.fstatat(
        parent_fd,
        &leaf_z,
        &observed,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (status != 0) {
        return switch (c.errno(status)) {
            .NOENT => null,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    if (!c.S.ISDIR(observed.mode) or
        observed.uid != c.geteuid() or
        observed.mode & 0o777 != private_directory_mode or
        observed.dev != expected_device)
    {
        return error.UnsafePath;
    }
    const fd = c.openat(
        parent_fd,
        &leaf_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.OperationConflict,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(fd);
    var opened: c.Stat = undefined;
    if (c.fstat(fd, &opened) != 0 or
        opened.dev != observed.dev or
        opened.ino != observed.ino or
        !c.S.ISDIR(opened.mode) or
        opened.uid != c.geteuid() or
        opened.mode & 0o777 != private_directory_mode)
    {
        return error.OperationConflict;
    }
    return fd;
}

fn validateAccountHomeTree(
    io: Io,
    fd: c.fd_t,
    expected_device: c.dev_t,
) RemovalError!void {
    var root_stat: c.Stat = undefined;
    if (c.fstat(fd, &root_stat) != 0) return error.IoFailure;
    if (root_stat.dev != expected_device) return error.CrossDeviceTarget;
    if (root_stat.uid != c.geteuid()) return error.UnsafePath;
    var iterator = (Dir{ .handle = fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        const name_z = try stackZ(entry.name);
        var child_stat: c.Stat = undefined;
        if (c.fstatat(fd, &name_z, &child_stat, c.AT.SYMLINK_NOFOLLOW) != 0) {
            return error.OperationConflict;
        }
        if (child_stat.dev != expected_device) return error.CrossDeviceTarget;
        if (child_stat.uid != c.geteuid()) return error.UnsafePath;
        if (c.S.ISDIR(child_stat.mode)) {
            const child_fd = c.openat(
                fd,
                &name_z,
                c.O{
                    .ACCMODE = .RDONLY,
                    .CLOEXEC = true,
                    .DIRECTORY = true,
                    .NOFOLLOW = true,
                },
            );
            if (child_fd < 0) return error.UnsafePath;
            defer _ = c.close(child_fd);
            var opened_stat: c.Stat = undefined;
            if (c.fstat(child_fd, &opened_stat) != 0 or
                opened_stat.dev != child_stat.dev or
                opened_stat.ino != child_stat.ino or
                opened_stat.uid != c.geteuid())
            {
                return error.OperationConflict;
            }
            try validateAccountHomeTree(
                io,
                child_fd,
                expected_device,
            );
        } else if (!c.S.ISREG(child_stat.mode) and
            !c.S.ISLNK(child_stat.mode))
        {
            return error.UnsafePath;
        }
    }
}

fn removeAccountHomeContents(
    allocator: Allocator,
    io: Io,
    fd: c.fd_t,
    expected_device: c.dev_t,
) RemovalError!void {
    var root_stat: c.Stat = undefined;
    if (c.fstat(fd, &root_stat) != 0) return error.IoFailure;
    if (root_stat.dev != expected_device) return error.CrossDeviceTarget;
    if (root_stat.uid != c.geteuid()) return error.UnsafePath;
    var iterator = (Dir{ .handle = fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        const name_z = try stackZ(entry.name);
        var child_stat: c.Stat = undefined;
        if (c.fstatat(fd, &name_z, &child_stat, c.AT.SYMLINK_NOFOLLOW) != 0) {
            return error.OperationConflict;
        }
        if (child_stat.dev != expected_device) return error.CrossDeviceTarget;
        if (child_stat.uid != c.geteuid()) return error.UnsafePath;
        if (c.S.ISDIR(child_stat.mode)) {
            const child_fd = c.openat(
                fd,
                &name_z,
                c.O{
                    .ACCMODE = .RDONLY,
                    .CLOEXEC = true,
                    .DIRECTORY = true,
                    .NOFOLLOW = true,
                },
            );
            if (child_fd < 0) return error.UnsafePath;
            defer _ = c.close(child_fd);
            var opened_stat: c.Stat = undefined;
            if (c.fstat(child_fd, &opened_stat) != 0 or
                opened_stat.dev != child_stat.dev or
                opened_stat.ino != child_stat.ino or
                opened_stat.uid != c.geteuid())
            {
                return error.OperationConflict;
            }
            try removeAccountHomeContents(
                allocator,
                io,
                child_fd,
                expected_device,
            );
            var final_stat: c.Stat = undefined;
            if (c.fstatat(
                fd,
                &name_z,
                &final_stat,
                c.AT.SYMLINK_NOFOLLOW,
            ) != 0 or
                final_stat.dev != opened_stat.dev or
                final_stat.ino != opened_stat.ino or
                final_stat.uid != c.geteuid() or
                !c.S.ISDIR(final_stat.mode))
            {
                return error.OperationConflict;
            }
            if (c.unlinkat(fd, &name_z, c.AT.REMOVEDIR) != 0) {
                return error.OperationConflict;
            }
        } else if (c.S.ISREG(child_stat.mode) or c.S.ISLNK(child_stat.mode)) {
            var final_stat: c.Stat = undefined;
            if (c.fstatat(
                fd,
                &name_z,
                &final_stat,
                c.AT.SYMLINK_NOFOLLOW,
            ) != 0 or
                final_stat.dev != child_stat.dev or
                final_stat.ino != child_stat.ino or
                final_stat.uid != c.geteuid() or
                (!c.S.ISREG(final_stat.mode) and
                    !c.S.ISLNK(final_stat.mode)))
            {
                return error.OperationConflict;
            }
            if (c.unlinkat(fd, &name_z, 0) != 0) {
                return error.OperationConflict;
            }
        } else {
            return error.UnsafePath;
        }
    }
    try fsyncFd(fd);
}

fn execute(
    allocator: Allocator,
    io: Io,
    request_path: []const u8,
    signing_key_path: []const u8,
    cli_parent_pid: u32,
    ready_fd: c.fd_t,
) RemovalError!void {
    var ready_fd_open = true;
    defer {
        if (ready_fd_open) _ = c.close(ready_fd);
    }

    const request_bytes = try readPrivateFile(
        allocator,
        io,
        request_path,
        maximum_request_bytes,
        null,
    );
    defer allocator.free(request_bytes);
    const key_bytes = try readPrivateFile(
        allocator,
        io,
        signing_key_path,
        64,
        32,
    );
    defer allocator.free(key_bytes);

    var parsed = std.json.parseFromSlice(
        SignedRequest,
        allocator,
        request_bytes,
        .{ .allocate = .alloc_always, .max_value_len = maximum_request_bytes },
    ) catch return error.InvalidRequest;
    defer parsed.deinit();
    const request = &parsed.value;

    try validateRequestShape(request);
    try verifySignature(allocator, request, key_bytes);
    try validateFixedRequestPaths(
        allocator,
        request,
        request_path,
        signing_key_path,
    );
    try validateParent(request.payload.parentProcessId, cli_parent_pid);

    var lock_file = try openExecutionLock(
        io,
        request.payload.executionLockPath,
    );
    defer lock_file.close(io);

    var parent_watcher = try registerParentExitWatcher(cli_parent_pid);
    defer parent_watcher.close();
    try signalReady(ready_fd);
    _ = c.close(ready_fd);
    ready_fd_open = false;

    try parent_watcher.wait();
    try runRequest(allocator, io, request, key_bytes);
}

fn runRequest(
    allocator: Allocator,
    io: Io,
    request: *const SignedRequest,
    signing_key: []const u8,
) RemovalError!void {
    const payload = &request.payload;
    try validatePayloadFilesystem(allocator, io, payload);
    try ensureHelperOperationDirectories(payload);

    const request_digest = try digestCanonical(
        allocator,
        request.*,
        "sha256_",
    );
    defer allocator.free(request_digest);

    var receipt_parsed: ?std.json.Parsed(HelperReceipt) = null;
    defer if (receipt_parsed) |*parsed| parsed.deinit();
    receipt_parsed = readReceipt(
        allocator,
        io,
        payload.receiptPath,
    ) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return error.InvalidReceipt,
    };

    var receipt: HelperReceipt = undefined;
    var owned_progress: ?[]TargetProgress = null;
    defer if (owned_progress) |items| allocator.free(items);

    if (receipt_parsed) |parsed| {
        try validateReceipt(parsed.value, payload);
        receipt = parsed.value;
        if (!std.mem.eql(
            u8,
            receipt.requestDigest,
            request_digest,
        )) {
            receipt.requestDigest = request_digest;
            try writeReceiptAtomic(
                allocator,
                io,
                payload.receiptPath,
                receipt,
            );
        }
    } else {
        const now = Io.Clock.real.now(io).toMilliseconds();
        if (now < 0 or @as(u64, @intCast(now)) > payload.expiresAt) {
            return error.ExpiredRequest;
        }
        const progress = allocator.alloc(
            TargetProgress,
            payload.targets.len,
        ) catch return error.OutOfMemory;
        owned_progress = progress;
        for (payload.targets, progress) |target, *entry| {
            entry.* = .{ .id = target.id, .state = "pending" };
        }
        receipt = .{
            .operationId = payload.operationId,
            .requestDigest = request_digest,
            .state = "running",
            .targets = progress,
            .version = 1,
        };
        try writeReceiptAtomic(allocator, io, payload.receiptPath, receipt);
    }

    var stage_node = try openExistingDirectory(payload.stageRoot);
    defer stage_node.close();
    const stage_stat = stage_node.stat;
    const root_device = stage_stat.dev;

    var stage_context = StageContext{
        .allocator = allocator,
        .io = io,
        .root_device = root_device,
        .stage_dir = stage_node.fd,
    };

    for (payload.targets, 0..) |target, index| {
        const progress = &receipt.targets[index];
        if (std.mem.eql(u8, progress.state, "pending")) {
            try stageTarget(&stage_context, payload, target);
            progress.state = "staged";
            try writeReceiptAtomic(allocator, io, payload.receiptPath, receipt);
        }
        if (std.mem.eql(u8, progress.state, "staged")) {
            if (target.registration != null) {
                try stageExactAdministration(
                    &stage_context,
                    payload,
                    target,
                );
                progress.state = "administration_staged";
                try writeReceiptAtomic(
                    allocator,
                    io,
                    payload.receiptPath,
                    receipt,
                );
            }
        }
        if (std.mem.eql(u8, progress.state, "staged") or
            std.mem.eql(u8, progress.state, "administration_staged"))
        {
            try removeStagedTarget(&stage_context, payload, target);
            progress.state = "removed";
            try writeReceiptAtomic(allocator, io, payload.receiptPath, receipt);
        }
    }

    receipt.state = "completed";
    try writeReceiptAtomic(allocator, io, payload.receiptPath, receipt);
    try finalizeHelperState(
        allocator,
        io,
        payload,
        request_digest,
        signing_key,
    );
}

fn ensureHelperOperationDirectories(payload: *const Payload) RemovalError!void {
    var helper = try openExistingDirectory(payload.helperStateRoot);
    defer helper.close();
    if (helper.stat.uid != c.geteuid() or
        helper.stat.mode & 0o777 != private_directory_mode)
    {
        return error.UnsafePath;
    }
    const receipts = try ensurePrivateDirectDirectory(
        helper.fd,
        "helper-receipts",
        helper.stat.dev,
    );
    _ = c.close(receipts);
    const staging = try ensurePrivateDirectDirectory(
        helper.fd,
        "staging",
        helper.stat.dev,
    );
    defer _ = c.close(staging);
    const operation_stage = try ensurePrivateDirectDirectory(
        staging,
        payload.operationId,
        helper.stat.dev,
    );
    _ = c.close(operation_stage);
    try fsyncFd(staging);
    try fsyncFd(helper.fd);
}

fn ensurePrivateDirectDirectory(
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
) RemovalError!c.fd_t {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    const mkdir_rc = c.mkdirat(parent_fd, &name_z, private_directory_mode);
    if (mkdir_rc != 0 and c.errno(mkdir_rc) != .EXIST) {
        return error.IoFailure;
    }
    const fd = c.openat(
        parent_fd,
        &name_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) return error.UnsafePath;
    errdefer _ = c.close(fd);
    var stat: c.Stat = undefined;
    if (c.fstat(fd, &stat) != 0 or
        !c.S.ISDIR(stat.mode) or
        stat.uid != c.geteuid() or
        stat.mode & 0o777 != private_directory_mode or
        stat.dev != device)
    {
        return error.UnsafePath;
    }
    return fd;
}

fn validateRequestShape(request: *const SignedRequest) RemovalError!void {
    const payload = &request.payload;
    if (payload.version != request_version or
        !std.mem.eql(u8, payload.kind, request_kind) or
        !payload.waitForParentExit or
        payload.parentProcessId < 2 or
        payload.targets.len > maximum_targets or
        payload.preservedUserRepositories.len > maximum_targets or
        payload.expiresAt <= payload.issuedAt or
        !validOperationId(payload.operationId) or
        !validPreviewId(payload.previewId) or
        !validPrefixedHex(payload.inventoryDigest, "sha256_", 64) or
        !validPrefixedHex(payload.allowlistDigest, "sha256_", 64) or
        !validPrefixedHex(request.signature, "hmac_sha256_", 64))
    {
        return error.InvalidRequest;
    }
    for (payload.targets, 0..) |target, index| {
        if (!validTarget(target)) return error.InvalidRequest;
        for (payload.targets[0..index]) |previous| {
            if (std.mem.eql(u8, target.id, previous.id)) {
                return error.InvalidRequest;
            }
        }
    }
}

fn validTarget(target: Target) bool {
    if (!validPrefixedHex(target.id, "target_", 32) or
        !isKnownCategory(target.category))
    {
        return false;
    }
    if (std.mem.eql(u8, target.category, "managed_worktree")) {
        return std.mem.eql(u8, target.kind, "directory") and
            target.dirty != null and target.registration != null;
    }
    return (std.mem.eql(u8, target.kind, "file") or
        std.mem.eql(u8, target.kind, "directory")) and
        target.dirty == null and target.registration == null;
}

fn isKnownCategory(category: []const u8) bool {
    return std.mem.eql(u8, category, "control_plane") or
        std.mem.eql(u8, category, predecessor_codex_profile_category) or
        std.mem.eql(u8, category, "release_update_artifact") or
        std.mem.eql(u8, category, "application_state") or
        std.mem.eql(u8, category, "managed_worktree");
}

fn verifySignature(
    allocator: Allocator,
    request: *const SignedRequest,
    key: []const u8,
) RemovalError!void {
    if (key.len != 32) return error.InvalidSignature;
    const canonical = try canonicalJson(allocator, request.payload);
    defer allocator.free(canonical);
    var expected: [32]u8 = undefined;
    std.crypto.auth.hmac.sha2.HmacSha256.create(
        &expected,
        canonical,
        key,
    );
    var observed: [32]u8 = undefined;
    decodePrefixedHex(
        &observed,
        request.signature,
        "hmac_sha256_",
    ) catch return error.InvalidSignature;
    if (!std.crypto.timing_safe.eql([32]u8, expected, observed)) {
        return error.InvalidSignature;
    }
}

fn canonicalJson(allocator: Allocator, value: anytype) RemovalError![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    std.json.Stringify.value(
        value,
        .{
            .emit_null_optional_fields = false,
            .whitespace = .minified,
        },
        &output.writer,
    ) catch return error.OutOfMemory;
    return output.toOwnedSlice() catch return error.OutOfMemory;
}

fn digestCanonical(
    allocator: Allocator,
    value: anytype,
    prefix: []const u8,
) RemovalError![]u8 {
    const canonical = try canonicalJson(allocator, value);
    defer allocator.free(canonical);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(canonical, &digest, .{});
    const output = allocator.alloc(u8, prefix.len + 64) catch
        return error.OutOfMemory;
    @memcpy(output[0..prefix.len], prefix);
    _ = std.fmt.bufPrint(output[prefix.len..], "{x}", .{digest}) catch
        return error.OutOfMemory;
    return output;
}

fn validateFixedRequestPaths(
    allocator: Allocator,
    request: *const SignedRequest,
    request_path: []const u8,
    signing_key_path: []const u8,
) RemovalError!void {
    const payload = &request.payload;
    const home = try effectiveHome(allocator);
    defer allocator.free(home);
    const expected_root = std.fs.path.join(
        allocator,
        &.{
            home,
            "Library",
            "Application Support",
            helper_state_directory_name,
        },
    ) catch return error.OutOfMemory;
    defer allocator.free(expected_root);
    if (!std.mem.eql(u8, payload.helperStateRoot, expected_root) or
        !std.mem.eql(u8, payload.ownedRoots.helperStateRoot, expected_root))
    {
        return error.UnsafePath;
    }

    const expected_key = try joinDirect(
        allocator,
        expected_root,
        signing_key_file_name,
    );
    defer allocator.free(expected_key);
    const expected_request_directory = try joinDirect(
        allocator,
        expected_root,
        "requests",
    );
    defer allocator.free(expected_request_directory);
    const expected_request_name = std.fmt.allocPrint(
        allocator,
        "{s}.json",
        .{payload.operationId},
    ) catch return error.OutOfMemory;
    defer allocator.free(expected_request_name);
    const expected_request = try joinDirect(
        allocator,
        expected_request_directory,
        expected_request_name,
    );
    defer allocator.free(expected_request);
    const expected_stage_directory = try joinDirect(
        allocator,
        expected_root,
        "staging",
    );
    defer allocator.free(expected_stage_directory);
    const expected_stage = try joinDirect(
        allocator,
        expected_stage_directory,
        payload.operationId,
    );
    defer allocator.free(expected_stage);
    const expected_receipt_directory = try joinDirect(
        allocator,
        expected_root,
        "helper-receipts",
    );
    defer allocator.free(expected_receipt_directory);
    const expected_receipt = try joinDirect(
        allocator,
        expected_receipt_directory,
        expected_request_name,
    );
    defer allocator.free(expected_receipt);
    const expected_lock = try joinDirect(
        allocator,
        expected_root,
        execution_lock_file_name,
    );
    defer allocator.free(expected_lock);
    const expected_exclusion = std.fs.path.join(
        allocator,
        &.{
            home,
            "Library",
            "Application Support",
            ".OPRTE Removal.removal-in-progress",
        },
    ) catch return error.OutOfMemory;
    defer allocator.free(expected_exclusion);

    if (!std.mem.eql(u8, request_path, expected_request) or
        !std.mem.eql(u8, signing_key_path, expected_key) or
        !std.mem.eql(u8, payload.stageRoot, expected_stage) or
        !std.mem.eql(u8, payload.receiptPath, expected_receipt) or
        !std.mem.eql(u8, payload.executionLockPath, expected_lock) or
        !std.mem.eql(u8, payload.exclusionPath, expected_exclusion))
    {
        return error.UnsafePath;
    }
}

fn validateParent(signed_parent: u32, cli_parent: u32) RemovalError!void {
    if (signed_parent != cli_parent or cli_parent < 2) {
        return error.InvalidParent;
    }
    const actual: u32 = @intCast(c.getppid());
    if (actual != cli_parent) return error.InvalidParent;
}

const ParentExitWatcher = struct {
    queue: c.fd_t,
    parent_pid: u32,

    fn close(self: *ParentExitWatcher) void {
        _ = c.close(self.queue);
        self.* = undefined;
    }

    fn wait(self: *const ParentExitWatcher) RemovalError!void {
        var unused_change: c.Kevent = undefined;
        var event: c.Kevent = undefined;
        const count = c.kevent(
            self.queue,
            @ptrCast(&unused_change),
            0,
            @ptrCast(&event),
            1,
            null,
        );
        if (count != 1 or
            event.filter != c.EVFILT.PROC or
            event.ident != self.parent_pid or
            event.flags & c.EV.ERROR != 0)
        {
            return error.ParentWaitFailure;
        }
    }
};

fn registerParentExitWatcher(
    parent_pid: u32,
) RemovalError!ParentExitWatcher {
    if (builtin.os.tag != .macos or
        parent_pid < 2 or
        @as(u32, @intCast(c.getppid())) != parent_pid)
    {
        return error.ParentWaitFailure;
    }
    const queue = c.kqueue();
    if (queue < 0) return error.ParentWaitFailure;
    errdefer _ = c.close(queue);

    var change = c.Kevent{
        .ident = parent_pid,
        .filter = c.EVFILT.PROC,
        .flags = c.EV.ADD | c.EV.ONESHOT,
        .fflags = c.NOTE.EXIT,
        .data = 0,
        .udata = 0,
    };
    var unused_event: c.Kevent = undefined;
    const count = c.kevent(
        queue,
        @ptrCast(&change),
        1,
        @ptrCast(&unused_event),
        0,
        null,
    );
    if (count != 0 or @as(u32, @intCast(c.getppid())) != parent_pid) {
        return error.ParentWaitFailure;
    }
    return .{ .queue = queue, .parent_pid = parent_pid };
}

fn signalReady(ready_fd: c.fd_t) RemovalError!void {
    if (ready_fd < 3) return error.LifecycleFailure;
    var stat: c.Stat = undefined;
    if (c.fstat(ready_fd, &stat) != 0 or
        !c.S.ISFIFO(stat.mode) or
        stat.uid != c.geteuid())
    {
        return error.LifecycleFailure;
    }
    var written: usize = 0;
    while (written < ready_message.len) {
        const count = c.write(
            ready_fd,
            ready_message.ptr + written,
            ready_message.len - written,
        );
        if (count > 0) {
            written += @intCast(count);
            continue;
        }
        if (count < 0 and c.errno(count) == .INTR) continue;
        return error.LifecycleFailure;
    }
}

fn openExecutionLock(io: Io, path: []const u8) RemovalError!File {
    _ = io;
    var parent = try openParentNoFollow(path);
    defer parent.close();
    const leaf_z = try stackZ(parent.leaf);
    const flags = c.O{
        .ACCMODE = .RDWR,
        .CLOEXEC = true,
        .NOFOLLOW = true,
        .CREAT = true,
    };
    const fd = c.openat(parent.fd, &leaf_z, flags, private_file_mode);
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.PathAbsent,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(fd);
    var stat: c.Stat = undefined;
    if (c.fstat(fd, &stat) != 0 or
        !c.S.ISREG(stat.mode) or
        stat.uid != c.geteuid() or
        stat.nlink != 1 or
        stat.mode & 0o777 != private_file_mode)
    {
        return error.UnsafePath;
    }
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        return if (c.errno(-1) == .AGAIN)
            error.ActiveOperation
        else
            error.IoFailure;
    }
    return .{ .handle = fd, .flags = .{ .nonblocking = false } };
}

fn validatePayloadFilesystem(
    allocator: Allocator,
    io: Io,
    payload: *const Payload,
) RemovalError!void {
    try validateNormalizedAbsolute(payload.helperStateRoot);
    try validateNormalizedAbsolute(payload.exclusionPath);
    try validateNormalizedAbsolute(payload.executionLockPath);
    try validateNormalizedAbsolute(payload.stageRoot);
    try validateNormalizedAbsolute(payload.receiptPath);

    const observed_allowlist = try digestCanonical(
        allocator,
        AllowlistEnvelope{
            .roots = payload.ownedRoots,
            .version = 1,
        },
        "sha256_",
    );
    defer allocator.free(observed_allowlist);
    if (!constantTimeStringEqual(
        observed_allowlist,
        payload.allowlistDigest,
    )) {
        return error.InvalidSignature;
    }

    try validateRoots(payload);
    try validatePreservedRepositories(payload);
    try validateTargetRelationships(payload);
    try validateSingleDevicePreflight(io, payload);
    try preflightManagedRegistrations(allocator, io, payload);
}

fn preflightManagedRegistrations(
    allocator: Allocator,
    io: Io,
    payload: *const Payload,
) RemovalError!void {
    for (payload.targets) |target| {
        const registration = target.registration orelse continue;
        try validateManagedWorktree(
            allocator,
            io,
            target,
            registration,
            target.path,
            false,
            payload.acknowledgeDirtyWorktrees,
        );
        const admin_state = try inspectPath(
            registration.administrativeDirectory,
            null,
        );
        switch (admin_state) {
            .absent => {},
            .present => |value| {
                var administration = value;
                defer administration.close();
                if (!c.S.ISDIR(administration.stat.mode)) {
                    return error.UnsafePath;
                }
                try validateTreeDevice(
                    io,
                    administration.fd,
                    administration.stat.dev,
                );
            },
        }
    }
}

fn validateRoots(payload: *const Payload) RemovalError!void {
    const home = homeFromHelperRoot(payload.helperStateRoot) orelse
        return error.UnsafePath;
    const root_lists = [_][]const []const u8{
        payload.ownedRoots.applicationState,
        payload.ownedRoots.controlPlane,
        payload.ownedRoots.kitchenCodexProfileData,
        payload.ownedRoots.managedWorktrees,
        payload.ownedRoots.releaseUpdateArtifacts,
    };
    for (root_lists) |roots| {
        if (!validOwnedRootCount(roots.len)) return error.InvalidRequest;
        for (roots, 0..) |root, index| {
            try validateOwnedPath(root, payload.helperStateRoot, home);
            for (roots[0..index]) |previous| {
                if (std.mem.eql(u8, root, previous)) {
                    return error.UnsafePath;
                }
            }
        }
    }
}

fn validOwnedRootCount(count: usize) bool {
    return count > 0 and count <= maximum_owned_roots_per_category;
}

fn validatePreservedRepositories(payload: *const Payload) RemovalError!void {
    const home = homeFromHelperRoot(payload.helperStateRoot) orelse
        return error.UnsafePath;
    for (payload.preservedUserRepositories, 0..) |repository, index| {
        try validateNormalizedAbsolute(repository);
        if (isBroadPath(repository, home) or
            pathsOverlap(repository, payload.helperStateRoot))
        {
            return error.UnsafePath;
        }
        for (payload.preservedUserRepositories[0..index]) |previous| {
            if (std.mem.eql(u8, repository, previous)) return error.UnsafePath;
        }
    }
}

fn validateTargetRelationships(payload: *const Payload) RemovalError!void {
    const home = homeFromHelperRoot(payload.helperStateRoot) orelse
        return error.UnsafePath;
    for (payload.targets, 0..) |target, index| {
        try validateNormalizedAbsolute(target.path);
        if (isBroadPath(target.path, home) or
            pathsOverlap(target.path, payload.helperStateRoot) or
            pathsOverlap(target.path, payload.exclusionPath))
        {
            return error.UnsafePath;
        }
        const roots = rootsForCategory(&payload.ownedRoots, target.category);
        var in_owned_root = false;
        for (roots) |root| {
            if (pathWithin(root, target.path)) {
                in_owned_root = true;
                if (std.mem.eql(u8, target.category, "managed_worktree") and
                    !isDirectChild(root, target.path))
                {
                    return error.UnsafePath;
                }
                break;
            }
        }
        if (!in_owned_root) return error.UnsafePath;

        for (payload.targets[0..index]) |previous| {
            if (pathsOverlap(target.path, previous.path)) {
                return error.UnsafePath;
            }
        }
        for (payload.preservedUserRepositories) |repository| {
            if (pathsOverlap(target.path, repository)) {
                return error.UnsafePath;
            }
        }

        if (target.registration) |registration| {
            try validateRegistrationLexical(payload, target, registration);
            for (payload.targets[0..index]) |previous| {
                if (previous.registration) |prior_registration| {
                    if (pathsOverlap(
                        registration.administrativeDirectory,
                        prior_registration.administrativeDirectory,
                    )) {
                        return error.UnsafePath;
                    }
                }
            }
        }
    }
}

fn validateRegistrationLexical(
    payload: *const Payload,
    target: Target,
    registration: Registration,
) RemovalError!void {
    try validateNormalizedAbsolute(registration.repositoryPath);
    try validateNormalizedAbsolute(registration.gitCommonDirectory);
    try validateNormalizedAbsolute(registration.administrativeDirectory);
    var repository_is_preserved = false;
    for (payload.preservedUserRepositories) |repository| {
        if (std.mem.eql(u8, repository, registration.repositoryPath)) {
            repository_is_preserved = true;
            break;
        }
    }
    if (!repository_is_preserved) return error.UnsafePath;
    if (!pathWithin(
        registration.gitCommonDirectory,
        registration.administrativeDirectory,
    )) {
        return error.UnsafePath;
    }
    const administration_parent = std.fs.path.dirname(
        registration.administrativeDirectory,
    ) orelse return error.UnsafePath;
    const worktrees_parent = std.fs.path.dirname(
        registration.administrativeDirectory,
    ) orelse return error.UnsafePath;
    if (!std.mem.eql(
        u8,
        std.fs.path.basename(worktrees_parent),
        "worktrees",
    ) or
        !std.mem.eql(
            u8,
            std.fs.path.dirname(worktrees_parent) orelse "",
            registration.gitCommonDirectory,
        ) or
        !isDirectChild(administration_parent, registration.administrativeDirectory))
    {
        return error.UnsafePath;
    }
    _ = target;
}

fn validateSingleDevicePreflight(
    io: Io,
    payload: *const Payload,
) RemovalError!void {
    var helper = try openExistingDirectory(payload.helperStateRoot);
    defer helper.close();
    const device = helper.stat.dev;

    const exclusion_state = try inspectPath(payload.exclusionPath, null);
    switch (exclusion_state) {
        .absent => return error.UnsafePath,
        .present => |value| {
            var exclusion = value;
            defer exclusion.close();
            if (!c.S.ISDIR(exclusion.stat.mode) or
                exclusion.stat.dev != device)
            {
                return error.CrossDeviceTarget;
            }
        },
    }

    for (payload.targets) |target| {
        const state = try inspectPath(target.path, null);
        switch (state) {
            .absent => {},
            .present => |value| {
                var node = value;
                defer node.close();
                if (node.stat.dev != device) return error.CrossDeviceTarget;
                if (std.mem.eql(u8, target.kind, "directory")) {
                    if (!c.S.ISDIR(node.stat.mode)) return error.UnsafePath;
                    try validateTreeDevice(io, node.fd, device);
                } else if (!c.S.ISREG(node.stat.mode)) {
                    return error.UnsafePath;
                }
            },
        }
    }
}

fn stageTarget(
    context: *StageContext,
    payload: *const Payload,
    target: Target,
) RemovalError!void {
    const target_z = try stackZ(target.id);
    var staged_stat: c.Stat = undefined;
    const staged_rc = c.fstatat(
        context.stage_dir,
        &target_z,
        &staged_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    const staged_exists = if (staged_rc == 0)
        true
    else if (c.errno(staged_rc) == .NOENT)
        false
    else
        return error.IoFailure;

    const source_state = try inspectPath(target.path, null);
    switch (source_state) {
        .absent => {
            if (staged_exists and target.registration != null) {
                verifyStagedManagedWorktree(
                    context,
                    payload,
                    target,
                ) catch |err| {
                    try rollbackStagedTarget(context, target);
                    return err;
                };
            }
            return;
        },
        .present => |value| {
            var source = value;
            defer source.close();
            if (staged_exists) return error.OperationConflict;
            if (source.stat.dev != context.root_device) {
                return error.CrossDeviceTarget;
            }
            if (std.mem.eql(u8, target.kind, "directory")) {
                if (!c.S.ISDIR(source.stat.mode)) return error.UnsafePath;
                try validateTreeDevice(
                    context.io,
                    source.fd,
                    context.root_device,
                );
            } else if (!c.S.ISREG(source.stat.mode)) {
                return error.UnsafePath;
            }

            if (target.registration) |registration| {
                try validateManagedWorktree(
                    context.allocator,
                    context.io,
                    target,
                    registration,
                    target.path,
                    false,
                    payload.acknowledgeDirtyWorktrees,
                );
                try ensureManagedAdministrationSerialized(
                    context,
                    payload,
                    target,
                    registration,
                );
            }

            var current: c.Stat = undefined;
            const source_leaf_z = try stackZ(source.parent.leaf);
            if (c.fstatat(
                source.parent.fd,
                &source_leaf_z,
                &current,
                c.AT.SYMLINK_NOFOLLOW,
            ) != 0 or
                current.dev != source.stat.dev or
                current.ino != source.stat.ino)
            {
                return error.OperationConflict;
            }
            if (c.renameat(
                source.parent.fd,
                &source_leaf_z,
                context.stage_dir,
                &target_z,
            ) != 0) {
                return error.IoFailure;
            }
            try fsyncFd(source.parent.fd);
            try fsyncFd(context.stage_dir);
            if (target.registration != null) {
                verifyStagedManagedWorktree(
                    context,
                    payload,
                    target,
                ) catch |err| {
                    try rollbackStagedTarget(context, target);
                    return err;
                };
            }
        },
    }
}

fn verifyStagedManagedWorktree(
    context: *StageContext,
    payload: *const Payload,
    target: Target,
) RemovalError!void {
    const registration = target.registration orelse return;
    const staged_path = std.fs.path.join(
        context.allocator,
        &.{ payload.stageRoot, target.id },
    ) catch return error.OutOfMemory;
    defer context.allocator.free(staged_path);
    try validateManagedWorktree(
        context.allocator,
        context.io,
        target,
        registration,
        staged_path,
        true,
        payload.acknowledgeDirtyWorktrees,
    );
    const administration_state = try inspectPath(
        registration.administrativeDirectory,
        null,
    );
    switch (administration_state) {
        .absent => {
            if (!payload.acknowledgeDirtyWorktrees) {
                return error.DirtyWorktreeNeedsAcknowledgement;
            }
        },
        .present => |value| {
            var administration = value;
            defer administration.close();
            const dirty = try managedWorktreeIsDirty(
                context.allocator,
                context.io,
                registration.administrativeDirectory,
                staged_path,
            );
            if (dirty and !payload.acknowledgeDirtyWorktrees) {
                return error.DirtyWorktreeNeedsAcknowledgement;
            }
        },
    }
}

fn rollbackStagedTarget(
    context: *StageContext,
    target: Target,
) RemovalError!void {
    var source_parent = try openParentNoFollow(target.path);
    defer source_parent.close();
    const source_leaf_z = try stackZ(source_parent.leaf);
    var source_stat: c.Stat = undefined;
    const source_rc = c.fstatat(
        source_parent.fd,
        &source_leaf_z,
        &source_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (source_rc == 0) return error.OperationConflict;
    if (c.errno(source_rc) != .NOENT) return error.IoFailure;
    const staged_z = try stackZ(target.id);
    if (c.renameat(
        context.stage_dir,
        &staged_z,
        source_parent.fd,
        &source_leaf_z,
    ) != 0) return error.OperationConflict;
    try fsyncFd(context.stage_dir);
    try fsyncFd(source_parent.fd);
}

fn removeStagedTarget(
    context: *StageContext,
    payload: *const Payload,
    target: Target,
) RemovalError!void {
    const source_state = try inspectPath(target.path, null);
    switch (source_state) {
        .absent => {},
        .present => |value| {
            var source = value;
            defer source.close();
            return error.OperationConflict;
        },
    }

    const target_z = try stackZ(target.id);
    var staged_stat: c.Stat = undefined;
    const rc = c.fstatat(
        context.stage_dir,
        &target_z,
        &staged_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    const staged_exists = if (rc == 0)
        true
    else if (c.errno(rc) == .NOENT)
        false
    else
        return error.IoFailure;

    if (target.registration) |registration| {
        const staged_path = std.fs.path.join(
            context.allocator,
            &.{ payload.stageRoot, target.id },
        ) catch return error.OutOfMemory;
        defer context.allocator.free(staged_path);
        try validateManagedWorktree(
            context.allocator,
            context.io,
            target,
            registration,
            staged_path,
            true,
            true,
        );
        try removeAdministrationTombstone(
            context.allocator,
            context.io,
            payload,
            target,
            registration,
        );
    }

    if (!staged_exists) return;
    if (staged_stat.dev != context.root_device) {
        return error.CrossDeviceTarget;
    }

    if (c.S.ISDIR(staged_stat.mode)) {
        const fd = c.openat(
            context.stage_dir,
            &target_z,
            c.O{
                .ACCMODE = .RDONLY,
                .CLOEXEC = true,
                .DIRECTORY = true,
                .NOFOLLOW = true,
            },
        );
        if (fd < 0) return error.IoFailure;
        defer _ = c.close(fd);
        var opened_stat: c.Stat = undefined;
        if (c.fstat(fd, &opened_stat) != 0 or
            opened_stat.dev != staged_stat.dev or
            opened_stat.ino != staged_stat.ino)
        {
            return error.OperationConflict;
        }
        try removeDirectoryContents(
            context.allocator,
            context.io,
            fd,
            context.root_device,
        );
        if (c.unlinkat(context.stage_dir, &target_z, c.AT.REMOVEDIR) != 0) {
            return error.IoFailure;
        }
    } else if (c.S.ISREG(staged_stat.mode)) {
        if (c.unlinkat(context.stage_dir, &target_z, 0) != 0) {
            return error.IoFailure;
        }
    } else {
        return error.UnsafePath;
    }
    try fsyncFd(context.stage_dir);
}

fn managedAdministrationLockReason(
    allocator: Allocator,
    payload: *const Payload,
    target: Target,
) RemovalError![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "HRA removal {s} {s}",
        .{ payload.operationId, target.id },
    ) catch return error.OutOfMemory;
}

fn readDirectOwnedRegularFile(
    allocator: Allocator,
    io: Io,
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
    maximum_bytes: usize,
) RemovalError![]u8 {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    var path_stat: c.Stat = undefined;
    const path_status = c.fstatat(
        parent_fd,
        &name_z,
        &path_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (path_status != 0) {
        if (c.errno(path_status) == .NOENT) return error.PathAbsent;
        return error.IoFailure;
    }
    const fd = c.openat(
        parent_fd,
        &name_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) return error.OperationConflict;
    defer _ = c.close(fd);
    var opened_stat: c.Stat = undefined;
    if (c.fstat(fd, &opened_stat) != 0 or
        !c.S.ISREG(opened_stat.mode) or
        opened_stat.uid != c.geteuid() or
        opened_stat.nlink != 1 or
        opened_stat.mode & 0o022 != 0 or
        opened_stat.dev != device or
        opened_stat.dev != path_stat.dev or
        opened_stat.ino != path_stat.ino or
        opened_stat.size <= 0 or
        opened_stat.size > maximum_bytes)
    {
        return error.UnsafePath;
    }
    const output = allocator.alloc(
        u8,
        @intCast(opened_stat.size),
    ) catch return error.OutOfMemory;
    errdefer allocator.free(output);
    const file = File{
        .handle = fd,
        .flags = .{ .nonblocking = false },
    };
    const read = file.readPositionalAll(
        io,
        output,
        0,
    ) catch return error.IoFailure;
    if (read != output.len) return error.IoFailure;
    return output;
}

fn directChildMatchesIdentity(
    parent_fd: c.fd_t,
    name: []const u8,
    expected: c.Stat,
) RemovalError!void {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    var observed: c.Stat = undefined;
    if (c.fstatat(
        parent_fd,
        &name_z,
        &observed,
        c.AT.SYMLINK_NOFOLLOW,
    ) != 0 or
        observed.dev != expected.dev or
        observed.ino != expected.ino)
    {
        return error.OperationConflict;
    }
}

fn validateManagedAdministrationDirectory(
    allocator: Allocator,
    io: Io,
    payload: *const Payload,
    target: Target,
    directory_fd: c.fd_t,
    expected_device: c.dev_t,
    require_operation_lock: bool,
) RemovalError!void {
    var directory_stat: c.Stat = undefined;
    if (c.fstat(directory_fd, &directory_stat) != 0 or
        !c.S.ISDIR(directory_stat.mode) or
        directory_stat.uid != c.geteuid() or
        directory_stat.dev != expected_device)
    {
        return error.UnsafePath;
    }
    try validateTreeDevice(io, directory_fd, expected_device);
    const backlink = try readDirectOwnedRegularFile(
        allocator,
        io,
        directory_fd,
        "gitdir",
        expected_device,
        maximum_pointer_bytes,
    );
    defer allocator.free(backlink);
    const expected_backlink = std.fmt.allocPrint(
        allocator,
        "{s}/.git",
        .{target.path},
    ) catch return error.OutOfMemory;
    defer allocator.free(expected_backlink);
    if (!std.mem.eql(
        u8,
        std.mem.trimEnd(u8, backlink, "\r\n"),
        expected_backlink,
    )) return error.UnsafePath;

    const operation_lock = readDirectOwnedRegularFile(
        allocator,
        io,
        directory_fd,
        "locked",
        expected_device,
        maximum_pointer_bytes,
    ) catch |err| switch (err) {
        error.PathAbsent => {
            if (require_operation_lock) {
                return error.OperationConflict;
            }
            return;
        },
        else => return err,
    };
    defer allocator.free(operation_lock);
    const expected_reason = try managedAdministrationLockReason(
        allocator,
        payload,
        target,
    );
    defer allocator.free(expected_reason);
    if (!std.mem.eql(
        u8,
        std.mem.trimEnd(u8, operation_lock, "\r\n"),
        expected_reason,
    )) return error.OperationConflict;
}

fn runManagedWorktreeLock(
    allocator: Allocator,
    io: Io,
    payload: *const Payload,
    target: Target,
    registration: Registration,
) RemovalError!void {
    const git = try fixedGitBinary(allocator, io);
    defer allocator.free(git);
    const reason = try managedAdministrationLockReason(
        allocator,
        payload,
        target,
    );
    defer allocator.free(reason);
    var environment = try safeGitEnvironment(allocator);
    defer environment.deinit();
    const result = std.process.run(allocator, io, .{
        .argv = &.{
            git,
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "safe.directory=*",
            "-C",
            registration.repositoryPath,
            "worktree",
            "lock",
            "--reason",
            reason,
            target.path,
        },
        .environ_map = &environment,
        .stdout_limit = .limited(64 * 1024),
        .stderr_limit = .limited(64 * 1024),
    }) catch return error.GitFailure;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    switch (result.term) {
        .exited => |status| if (status != 0) return error.GitFailure,
        else => return error.GitFailure,
    }
}

fn ensureManagedAdministrationSerialized(
    context: *StageContext,
    payload: *const Payload,
    target: Target,
    registration: Registration,
) RemovalError!void {
    const state = try inspectPath(
        registration.administrativeDirectory,
        null,
    );
    switch (state) {
        .absent => return,
        .present => |value| {
            var administration = value;
            defer administration.close();
            if (!c.S.ISDIR(administration.stat.mode)) {
                return error.UnsafePath;
            }
            try validateManagedAdministrationDirectory(
                context.allocator,
                context.io,
                payload,
                target,
                administration.fd,
                administration.stat.dev,
                false,
            );
            const existing_lock = readDirectOwnedRegularFile(
                context.allocator,
                context.io,
                administration.fd,
                "locked",
                administration.stat.dev,
                maximum_pointer_bytes,
            ) catch |err| switch (err) {
                error.PathAbsent => null,
                else => return err,
            };
            if (existing_lock) |bytes| {
                context.allocator.free(bytes);
                // Full validation above accepts only our exact durable reason.
                return;
            }

            try directChildMatchesIdentity(
                administration.parent.fd,
                administration.parent.leaf,
                administration.stat,
            );
            try runManagedWorktreeLock(
                context.allocator,
                context.io,
                payload,
                target,
                registration,
            );
            try directChildMatchesIdentity(
                administration.parent.fd,
                administration.parent.leaf,
                administration.stat,
            );
            try validateManagedAdministrationDirectory(
                context.allocator,
                context.io,
                payload,
                target,
                administration.fd,
                administration.stat.dev,
                true,
            );
            try validateManagedWorktree(
                context.allocator,
                context.io,
                target,
                registration,
                target.path,
                false,
                payload.acknowledgeDirtyWorktrees,
            );
        },
    }
}

fn openDirectoryMatchingIdentity(
    parent_fd: c.fd_t,
    name: []const u8,
    expected: c.Stat,
) RemovalError!c.fd_t {
    try directChildMatchesIdentity(parent_fd, name, expected);
    const name_z = try stackZ(name);
    const fd = c.openat(
        parent_fd,
        &name_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) return error.OperationConflict;
    errdefer _ = c.close(fd);
    var opened: c.Stat = undefined;
    if (c.fstat(fd, &opened) != 0 or
        !c.S.ISDIR(opened.mode) or
        opened.uid != c.geteuid() or
        opened.dev != expected.dev or
        opened.ino != expected.ino)
    {
        return error.OperationConflict;
    }
    return fd;
}

fn rollbackAdministrationRename(
    parent_fd: c.fd_t,
    administration_name: []const u8,
    tombstone_name: []const u8,
    expected: c.Stat,
) RemovalError!void {
    const administration_z = try stackZ(administration_name);
    var administration_stat: c.Stat = undefined;
    const administration_status = c.fstatat(
        parent_fd,
        &administration_z,
        &administration_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (administration_status == 0) {
        // A concurrent Git operation published a replacement. Preserve both
        // it and the tombstone rather than overwriting either identity.
        return error.OperationConflict;
    }
    if (c.errno(administration_status) != .NOENT) {
        return error.IoFailure;
    }
    try directChildMatchesIdentity(
        parent_fd,
        tombstone_name,
        expected,
    );
    const tombstone_z = try stackZ(tombstone_name);
    if (renameatx_np(
        parent_fd,
        &tombstone_z,
        parent_fd,
        &administration_z,
        RENAME_EXCL,
    ) != 0) return error.OperationConflict;
    try fsyncFd(parent_fd);
    try directChildMatchesIdentity(
        parent_fd,
        administration_name,
        expected,
    );
}

fn renameAnchoredAdministration(
    parent_fd: c.fd_t,
    administration_name: []const u8,
    tombstone_name: []const u8,
    expected: c.Stat,
) RemovalError!void {
    try directChildMatchesIdentity(
        parent_fd,
        administration_name,
        expected,
    );
    const tombstone_z = try stackZ(tombstone_name);
    var tombstone_stat: c.Stat = undefined;
    const tombstone_status = c.fstatat(
        parent_fd,
        &tombstone_z,
        &tombstone_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (tombstone_status == 0) return error.OperationConflict;
    if (c.errno(tombstone_status) != .NOENT) return error.IoFailure;
    const administration_z = try stackZ(administration_name);
    if (renameatx_np(
        parent_fd,
        &administration_z,
        parent_fd,
        &tombstone_z,
        RENAME_EXCL,
    ) != 0) return error.OperationConflict;
    try fsyncFd(parent_fd);

    directChildMatchesIdentity(
        parent_fd,
        tombstone_name,
        expected,
    ) catch |err| {
        rollbackAdministrationRename(
            parent_fd,
            administration_name,
            tombstone_name,
            expected,
        ) catch {};
        return err;
    };
    var unexpected_admin: c.Stat = undefined;
    const administration_status = c.fstatat(
        parent_fd,
        &administration_z,
        &unexpected_admin,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (administration_status == 0 or
        c.errno(administration_status) != .NOENT)
    {
        rollbackAdministrationRename(
            parent_fd,
            administration_name,
            tombstone_name,
            expected,
        ) catch {};
        return error.OperationConflict;
    }
}

fn stageExactAdministration(
    context: *StageContext,
    payload: *const Payload,
    target: Target,
) RemovalError!void {
    const registration = target.registration orelse return;
    const staged_path = std.fs.path.join(
        context.allocator,
        &.{ payload.stageRoot, target.id },
    ) catch return error.OutOfMemory;
    defer context.allocator.free(staged_path);
    try validateManagedWorktree(
        context.allocator,
        context.io,
        target,
        registration,
        staged_path,
        true,
        true,
    );

    var parent = try openParentNoFollow(
        registration.administrativeDirectory,
    );
    defer parent.close();
    const admin_z = try stackZ(parent.leaf);
    const tombstone_name = try administrationTombstoneName(
        context.allocator,
        payload.operationId,
        target.id,
    );
    defer context.allocator.free(tombstone_name);
    const tombstone_z = try stackZ(tombstone_name);

    var admin_stat: c.Stat = undefined;
    var tombstone_stat: c.Stat = undefined;
    const initial_admin_rc = c.fstatat(
        parent.fd,
        &admin_z,
        &admin_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    const admin_exists = initial_admin_rc == 0;
    const admin_errno = if (admin_exists) null else c.errno(initial_admin_rc);
    const initial_tombstone_rc = c.fstatat(
        parent.fd,
        &tombstone_z,
        &tombstone_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    const tombstone_exists = initial_tombstone_rc == 0;
    const tombstone_errno = if (tombstone_exists)
        null
    else
        c.errno(initial_tombstone_rc);
    if ((!admin_exists and admin_errno.? != .NOENT) or
        (!tombstone_exists and tombstone_errno.? != .NOENT))
    {
        return error.IoFailure;
    }
    if (admin_exists and tombstone_exists) return error.OperationConflict;

    if (!admin_exists and tombstone_exists) {
        if (!c.S.ISDIR(tombstone_stat.mode)) return error.UnsafePath;
        const tombstone_fd = try openDirectoryMatchingIdentity(
            parent.fd,
            tombstone_name,
            tombstone_stat,
        );
        defer _ = c.close(tombstone_fd);
        try validateManagedAdministrationDirectory(
            context.allocator,
            context.io,
            payload,
            target,
            tombstone_fd,
            tombstone_stat.dev,
            true,
        );
        return;
    }
    if (!admin_exists) return;
    if (!c.S.ISDIR(admin_stat.mode)) return error.UnsafePath;
    const administration_fd = try openDirectoryMatchingIdentity(
        parent.fd,
        parent.leaf,
        admin_stat,
    );
    defer _ = c.close(administration_fd);
    try validateManagedAdministrationDirectory(
        context.allocator,
        context.io,
        payload,
        target,
        administration_fd,
        admin_stat.dev,
        true,
    );
    // The operation-owned Git lock serializes ordinary worktree mutations.
    // The still-open directory and dev+ino comparisons close the force/race
    // window immediately before and after the no-replace rename.
    try renameAnchoredAdministration(
        parent.fd,
        parent.leaf,
        tombstone_name,
        admin_stat,
    );
    validateManagedAdministrationDirectory(
        context.allocator,
        context.io,
        payload,
        target,
        administration_fd,
        admin_stat.dev,
        true,
    ) catch |err| {
        rollbackAdministrationRename(
            parent.fd,
            parent.leaf,
            tombstone_name,
            admin_stat,
        ) catch {};
        return err;
    };
}

fn removeAdministrationTombstone(
    allocator: Allocator,
    io: Io,
    payload: *const Payload,
    target: Target,
    registration: Registration,
) RemovalError!void {
    var parent = try openParentNoFollow(
        registration.administrativeDirectory,
    );
    defer parent.close();
    const admin_z = try stackZ(parent.leaf);
    var admin_stat: c.Stat = undefined;
    const admin_rc = c.fstatat(
        parent.fd,
        &admin_z,
        &admin_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (admin_rc == 0) return error.OperationConflict;
    if (c.errno(admin_rc) != .NOENT) return error.IoFailure;

    const tombstone_name = try administrationTombstoneName(
        allocator,
        payload.operationId,
        target.id,
    );
    defer allocator.free(tombstone_name);
    const tombstone_z = try stackZ(tombstone_name);
    var tombstone_stat: c.Stat = undefined;
    const tombstone_rc = c.fstatat(
        parent.fd,
        &tombstone_z,
        &tombstone_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (tombstone_rc != 0) {
        if (c.errno(tombstone_rc) == .NOENT) return;
        return error.IoFailure;
    }
    if (!c.S.ISDIR(tombstone_stat.mode)) return error.UnsafePath;
    const tombstone_fd = c.openat(
        parent.fd,
        &tombstone_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (tombstone_fd < 0) return error.UnsafePath;
    defer _ = c.close(tombstone_fd);
    var opened_stat: c.Stat = undefined;
    if (c.fstat(tombstone_fd, &opened_stat) != 0 or
        opened_stat.dev != tombstone_stat.dev or
        opened_stat.ino != tombstone_stat.ino)
    {
        return error.OperationConflict;
    }
    try validateManagedAdministrationDirectory(
        allocator,
        io,
        payload,
        target,
        tombstone_fd,
        tombstone_stat.dev,
        true,
    );
    try removeDirectoryContents(
        allocator,
        io,
        tombstone_fd,
        tombstone_stat.dev,
    );
    try directChildMatchesIdentity(
        parent.fd,
        tombstone_name,
        opened_stat,
    );
    if (c.unlinkat(parent.fd, &tombstone_z, c.AT.REMOVEDIR) != 0) {
        return error.IoFailure;
    }
    try fsyncFd(parent.fd);
}

fn administrationTombstoneName(
    allocator: Allocator,
    operation_id: []const u8,
    target_id: []const u8,
) RemovalError![]u8 {
    const value = std.fmt.allocPrint(
        allocator,
        ".oprte-removing-{s}-{s}",
        .{ operation_id, target_id },
    ) catch return error.OutOfMemory;
    errdefer allocator.free(value);
    if (!validLeafName(value) or value.len > std.posix.NAME_MAX) {
        return error.UnsafePath;
    }
    return value;
}

fn validateManagedWorktree(
    allocator: Allocator,
    io: Io,
    target: Target,
    registration: Registration,
    checkout_path: []const u8,
    staged: bool,
    acknowledge_dirty: bool,
) RemovalError!void {
    const repository_common = try gitCommonDirectory(
        allocator,
        io,
        registration.repositoryPath,
    );
    defer allocator.free(repository_common);
    if (!std.mem.eql(
        u8,
        repository_common,
        registration.gitCommonDirectory,
    )) return error.UnsafePath;

    const administration_state = try inspectPath(
        registration.administrativeDirectory,
        null,
    );
    const checkout_state = try inspectPath(checkout_path, null);
    switch (checkout_state) {
        .absent => {},
        .present => |value| {
            var checkout = value;
            defer checkout.close();
            if (!c.S.ISDIR(checkout.stat.mode)) return error.UnsafePath;
            const pointer = try readDirectRegularFile(
                allocator,
                io,
                checkout.fd,
                ".git",
                maximum_pointer_bytes,
            );
            defer allocator.free(pointer);
            const expected_pointer = std.fmt.allocPrint(
                allocator,
                "gitdir: {s}",
                .{registration.administrativeDirectory},
            ) catch return error.OutOfMemory;
            defer allocator.free(expected_pointer);
            if (!std.mem.eql(
                u8,
                std.mem.trimEnd(u8, pointer, "\r\n"),
                expected_pointer,
            )) return error.UnsafePath;
        },
    }

    switch (administration_state) {
        .absent => {
            if (checkout_state == .present and !acknowledge_dirty) {
                return error.DirtyWorktreeNeedsAcknowledgement;
            }
            return;
        },
        .present => |value| {
            var administration = value;
            defer administration.close();
            if (!c.S.ISDIR(administration.stat.mode)) {
                return error.UnsafePath;
            }
            const backlink = try readDirectRegularFile(
                allocator,
                io,
                administration.fd,
                "gitdir",
                maximum_pointer_bytes,
            );
            defer allocator.free(backlink);
            const expected_backlink = std.fmt.allocPrint(
                allocator,
                "{s}/.git",
                .{target.path},
            ) catch return error.OutOfMemory;
            defer allocator.free(expected_backlink);
            if (!std.mem.eql(
                u8,
                std.mem.trimEnd(u8, backlink, "\r\n"),
                expected_backlink,
            )) return error.UnsafePath;
        },
    }

    if (!staged and checkout_state == .present) {
        const checkout_common = try gitCommonDirectory(
            allocator,
            io,
            target.path,
        );
        defer allocator.free(checkout_common);
        if (!std.mem.eql(
            u8,
            checkout_common,
            registration.gitCommonDirectory,
        )) return error.UnsafePath;
    }
}

fn managedWorktreeIsDirty(
    allocator: Allocator,
    io: Io,
    git_directory: []const u8,
    worktree_path: []const u8,
) RemovalError!bool {
    const git = try fixedGitBinary(allocator, io);
    defer allocator.free(git);
    var environment = try safeGitEnvironment(allocator);
    defer environment.deinit();
    const result = std.process.run(allocator, io, .{
        .argv = &.{
            git,
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "safe.directory=*",
            "--git-dir",
            git_directory,
            "--work-tree",
            worktree_path,
            "status",
            "--porcelain=v1",
            "--untracked-files=normal",
        },
        .environ_map = &environment,
        .stdout_limit = .limited(1024 * 1024),
        .stderr_limit = .limited(64 * 1024),
    }) catch return error.GitFailure;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    switch (result.term) {
        .exited => |status| if (status != 0) return error.GitFailure,
        else => return error.GitFailure,
    }
    return std.mem.trim(u8, result.stdout, " \r\n\t").len != 0;
}

fn gitCommonDirectory(
    allocator: Allocator,
    io: Io,
    path: []const u8,
) RemovalError![]u8 {
    var path_node = try openExistingDirectory(path);
    path_node.close();
    const git = try fixedGitBinary(allocator, io);
    defer allocator.free(git);
    var environment = try safeGitEnvironment(allocator);
    defer environment.deinit();
    const result = std.process.run(allocator, io, .{
        .argv = &.{
            git,
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "credential.helper=",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "safe.directory=*",
            "-C",
            path,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        },
        .environ_map = &environment,
        .stdout_limit = .limited(maximum_pointer_bytes),
        .stderr_limit = .limited(64 * 1024),
    }) catch return error.GitFailure;
    defer allocator.free(result.stdout);
    defer allocator.free(result.stderr);
    switch (result.term) {
        .exited => |status| if (status != 0) return error.GitFailure,
        else => return error.GitFailure,
    }
    const trimmed = std.mem.trim(u8, result.stdout, " \r\n\t");
    try validateNormalizedAbsolute(trimmed);
    const copy = allocator.dupe(u8, trimmed) catch return error.OutOfMemory;
    return copy;
}

fn safeGitEnvironment(
    allocator: Allocator,
) RemovalError!std.process.Environ.Map {
    var environment = std.process.Environ.Map.init(allocator);
    errdefer environment.deinit();
    environment.put("GIT_CONFIG_GLOBAL", "/dev/null") catch
        return error.OutOfMemory;
    environment.put("GIT_CONFIG_NOSYSTEM", "1") catch
        return error.OutOfMemory;
    environment.put("GIT_OPTIONAL_LOCKS", "0") catch
        return error.OutOfMemory;
    environment.put("GIT_TERMINAL_PROMPT", "0") catch
        return error.OutOfMemory;
    environment.put("LANG", "C") catch return error.OutOfMemory;
    environment.put("LC_ALL", "C") catch return error.OutOfMemory;
    environment.put("PATH", "/usr/bin:/bin:/usr/sbin:/sbin") catch
        return error.OutOfMemory;
    return environment;
}

fn fixedGitBinary(allocator: Allocator, io: Io) RemovalError![]u8 {
    const executable = std.process.executablePathAlloc(io, allocator) catch
        return error.IoFailure;
    defer allocator.free(executable);
    const bin_directory = std.fs.path.dirname(executable) orelse
        return error.UnsafePath;
    const runtime_root = std.fs.path.dirname(bin_directory) orelse
        return error.UnsafePath;
    return std.fs.path.join(
        allocator,
        &.{ runtime_root, "git", "bin", "git" },
    ) catch return error.OutOfMemory;
}

fn completionProofDirectoryName(
    allocator: Allocator,
    helper_leaf: []const u8,
    operation_id: []const u8,
) RemovalError![]u8 {
    const name = std.fmt.allocPrint(
        allocator,
        ".{s}.completion-{s}",
        .{ helper_leaf, operation_id },
    ) catch return error.OutOfMemory;
    errdefer allocator.free(name);
    if (!validLeafName(name)) return error.UnsafePath;
    return name;
}

fn completionProofCleanupDirectoryName(
    allocator: Allocator,
    helper_leaf: []const u8,
    operation_id: []const u8,
) RemovalError![]u8 {
    const name = std.fmt.allocPrint(
        allocator,
        ".{s}.completion-cleanup-{s}",
        .{ helper_leaf, operation_id },
    ) catch return error.OutOfMemory;
    errdefer allocator.free(name);
    if (!validLeafName(name)) return error.UnsafePath;
    return name;
}

fn ensureInternalCompletionProof(
    allocator: Allocator,
    io: Io,
    helper_fd: c.fd_t,
    device: c.dev_t,
    operation_id: []const u8,
    request_digest: []const u8,
    signing_key: []const u8,
) RemovalError!void {
    if (!validOperationId(operation_id) or
        !validPrefixedHex(request_digest, "sha256_", 64) or
        signing_key.len != 32)
    {
        return error.InvalidReceipt;
    }
    const existing = openCompletionProofDirectory(
        helper_fd,
        internal_completion_proof_directory_name,
        device,
    ) catch |err| switch (err) {
        error.PathAbsent => null,
        else => return err,
    };
    if (existing) |proof_fd| {
        defer _ = c.close(proof_fd);
        const observed_digest = try validatedCompletionProofDigest(
            allocator,
            io,
            proof_fd,
            operation_id,
            null,
        );
        defer allocator.free(observed_digest);
        if (std.mem.eql(
            u8,
            observed_digest,
            request_digest,
        )) return;
        // A completed operation may be rebound to a freshly signed request
        // after a crash before the helper-root rename. The old proof is still
        // authenticated, so it is safe to discard and atomically republish it
        // with the current signed-request digest.
        try retireInternalCompletionProof(
            io,
            helper_fd,
        );
    }

    var random: [16]u8 = undefined;
    io.random(&random);
    var temporary_name_buffer: [128]u8 = undefined;
    const temporary_name = std.fmt.bufPrint(
        &temporary_name_buffer,
        ".completion-proof-{x}.tmp",
        .{random},
    ) catch return error.IoFailure;
    const temporary_z = try stackZ(temporary_name);
    if (c.mkdirat(
        helper_fd,
        &temporary_z,
        private_directory_mode,
    ) != 0) return error.IoFailure;
    var temporary_published = false;
    defer {
        if (!temporary_published) {
            if (openCompletionProofDirectory(
                helper_fd,
                temporary_name,
                device,
            ) catch null) |temporary_fd| {
                removeDirectoryContents(
                    allocator,
                    io,
                    temporary_fd,
                    device,
                ) catch {};
                _ = c.close(temporary_fd);
            }
            _ = c.unlinkat(helper_fd, &temporary_z, c.AT.REMOVEDIR);
        }
    }

    const temporary_fd = try openCompletionProofDirectory(
        helper_fd,
        temporary_name,
        device,
    );
    defer _ = c.close(temporary_fd);
    try writeNewPrivateDirectFile(
        io,
        temporary_fd,
        completion_proof_key_file_name,
        signing_key,
        false,
    );

    const body = CompletionProofBody{
        .kind = completion_proof_kind,
        .operationId = operation_id,
        .requestDigest = request_digest,
        .version = 1,
    };
    const canonical_body = try canonicalJson(allocator, body);
    defer allocator.free(canonical_body);
    var signature_digest: [32]u8 = undefined;
    std.crypto.auth.hmac.sha2.HmacSha256.create(
        &signature_digest,
        canonical_body,
        signing_key,
    );
    var signature_buffer: ["hmac_sha256_".len + 64]u8 = undefined;
    const signature = std.fmt.bufPrint(
        &signature_buffer,
        "hmac_sha256_{x}",
        .{signature_digest},
    ) catch return error.IoFailure;
    const proof_bytes = try canonicalJson(
        allocator,
        SignedCompletionProof{
            .body = body,
            .signature = signature,
        },
    );
    defer allocator.free(proof_bytes);
    try writeNewPrivateDirectFile(
        io,
        temporary_fd,
        completion_proof_file_name,
        proof_bytes,
        true,
    );
    try fsyncFd(temporary_fd);

    const proof_z = try stackZ(
        internal_completion_proof_directory_name,
    );
    if (c.renameat(
        helper_fd,
        &temporary_z,
        helper_fd,
        &proof_z,
    ) != 0) return error.OperationConflict;
    temporary_published = true;
    try fsyncFd(helper_fd);
}

fn retireInternalCompletionProof(
    io: Io,
    helper_fd: c.fd_t,
) RemovalError!void {
    var random: [16]u8 = undefined;
    io.random(&random);
    var retired_name_buffer: [128]u8 = undefined;
    const retired_name = std.fmt.bufPrint(
        &retired_name_buffer,
        ".completion-proof-retired-{x}",
        .{random},
    ) catch return error.IoFailure;
    const proof_z = try stackZ(
        internal_completion_proof_directory_name,
    );
    const retired_z = try stackZ(retired_name);
    if (c.renameat(
        helper_fd,
        &proof_z,
        helper_fd,
        &retired_z,
    ) != 0) return error.IoFailure;
    try fsyncFd(helper_fd);
}

fn writeNewPrivateDirectFile(
    io: Io,
    parent_fd: c.fd_t,
    name: []const u8,
    bytes: []const u8,
    append_newline: bool,
) RemovalError!void {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    const fd = c.openat(
        parent_fd,
        &name_z,
        c.O{
            .ACCMODE = .WRONLY,
            .CLOEXEC = true,
            .CREAT = true,
            .EXCL = true,
            .NOFOLLOW = true,
        },
        private_file_mode,
    );
    if (fd < 0) return error.IoFailure;
    var file = File{
        .handle = fd,
        .flags = .{ .nonblocking = false },
    };
    var file_open = true;
    defer if (file_open) file.close(io);
    if (c.fchmod(fd, private_file_mode) != 0) {
        return error.IoFailure;
    }
    file.writeStreamingAll(io, bytes) catch return error.IoFailure;
    if (append_newline) {
        file.writeStreamingAll(io, "\n") catch return error.IoFailure;
    }
    file.sync(io) catch return error.IoFailure;
    file.close(io);
    file_open = false;
}

fn openCompletionProofDirectory(
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
) RemovalError!c.fd_t {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    const fd = c.openat(
        parent_fd,
        &name_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.PathAbsent,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(fd);
    var stat: c.Stat = undefined;
    if (c.fstat(fd, &stat) != 0 or
        !c.S.ISDIR(stat.mode) or
        stat.uid != c.geteuid() or
        stat.mode & 0o777 != private_directory_mode or
        stat.dev != device)
    {
        return error.UnsafePath;
    }
    return fd;
}

fn readDirectPrivateFile(
    allocator: Allocator,
    io: Io,
    parent_fd: c.fd_t,
    name: []const u8,
    maximum_bytes: usize,
    exact_bytes: ?usize,
) RemovalError![]u8 {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    const fd = c.openat(
        parent_fd,
        &name_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) return error.InvalidReceipt;
    defer _ = c.close(fd);
    var stat: c.Stat = undefined;
    if (c.fstat(fd, &stat) != 0 or
        !c.S.ISREG(stat.mode) or
        stat.uid != c.geteuid() or
        stat.nlink != 1 or
        stat.mode & 0o777 != private_file_mode or
        stat.size < 0 or
        stat.size > maximum_bytes or
        (exact_bytes != null and stat.size != exact_bytes.?))
    {
        return error.InvalidReceipt;
    }
    const output = allocator.alloc(
        u8,
        @intCast(stat.size),
    ) catch return error.OutOfMemory;
    errdefer allocator.free(output);
    const file = File{
        .handle = fd,
        .flags = .{ .nonblocking = false },
    };
    const read = file.readPositionalAll(
        io,
        output,
        0,
    ) catch return error.IoFailure;
    if (read != output.len) return error.IoFailure;
    return output;
}

fn validateCompletionProof(
    allocator: Allocator,
    io: Io,
    proof_fd: c.fd_t,
    operation_id: []const u8,
    expected_request_digest: ?[]const u8,
) RemovalError!void {
    const digest = try validatedCompletionProofDigest(
        allocator,
        io,
        proof_fd,
        operation_id,
        expected_request_digest,
    );
    allocator.free(digest);
}

fn validatedCompletionProofDigest(
    allocator: Allocator,
    io: Io,
    proof_fd: c.fd_t,
    operation_id: []const u8,
    expected_request_digest: ?[]const u8,
) RemovalError![]u8 {
    const key = try readDirectPrivateFile(
        allocator,
        io,
        proof_fd,
        completion_proof_key_file_name,
        32,
        32,
    );
    defer allocator.free(key);
    const proof_bytes = try readDirectPrivateFile(
        allocator,
        io,
        proof_fd,
        completion_proof_file_name,
        maximum_receipt_bytes,
        null,
    );
    defer allocator.free(proof_bytes);
    var proof = std.json.parseFromSlice(
        SignedCompletionProof,
        allocator,
        proof_bytes,
        .{
            .allocate = .alloc_always,
            .max_value_len = maximum_receipt_bytes,
        },
    ) catch return error.InvalidReceipt;
    defer proof.deinit();
    const body = proof.value.body;
    if (body.version != 1 or
        !std.mem.eql(u8, body.kind, completion_proof_kind) or
        !std.mem.eql(u8, body.operationId, operation_id) or
        !validPrefixedHex(body.requestDigest, "sha256_", 64) or
        !validPrefixedHex(
            proof.value.signature,
            "hmac_sha256_",
            64,
        ) or
        (expected_request_digest != null and
            !std.mem.eql(
                u8,
                body.requestDigest,
                expected_request_digest.?,
            )))
    {
        return error.InvalidReceipt;
    }
    const canonical_body = try canonicalJson(allocator, body);
    defer allocator.free(canonical_body);
    var expected: [32]u8 = undefined;
    std.crypto.auth.hmac.sha2.HmacSha256.create(
        &expected,
        canonical_body,
        key,
    );
    var observed: [32]u8 = undefined;
    decodePrefixedHex(
        &observed,
        proof.value.signature,
        "hmac_sha256_",
    ) catch return error.InvalidReceipt;
    if (!std.crypto.timing_safe.eql([32]u8, expected, observed)) {
        return error.InvalidReceipt;
    }
    return allocator.dupe(
        u8,
        body.requestDigest,
    ) catch return error.OutOfMemory;
}

fn publishCompletionProof(
    parent_fd: c.fd_t,
    tombstone_fd: c.fd_t,
    proof_name: []const u8,
) RemovalError!void {
    const proof_z = try stackZ(proof_name);
    var stat: c.Stat = undefined;
    const existing = c.fstatat(
        parent_fd,
        &proof_z,
        &stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (existing == 0) {
        if (!c.S.ISDIR(stat.mode)) return error.UnsafePath;
        return;
    }
    if (c.errno(existing) != .NOENT) return error.IoFailure;

    const internal_z = try stackZ(
        internal_completion_proof_directory_name,
    );
    if (c.renameat(
        tombstone_fd,
        &internal_z,
        parent_fd,
        &proof_z,
    ) != 0) return error.InvalidReceipt;
    try fsyncFd(tombstone_fd);
    try fsyncFd(parent_fd);
}

fn retireAndRemoveCompletionProofDirectory(
    allocator: Allocator,
    io: Io,
    parent_fd: c.fd_t,
    proof_name: []const u8,
    cleanup_name: []const u8,
    device: c.dev_t,
) RemovalError!void {
    const proof_z = try stackZ(proof_name);
    const cleanup_z = try stackZ(cleanup_name);
    var cleanup_stat: c.Stat = undefined;
    const cleanup_status = c.fstatat(
        parent_fd,
        &cleanup_z,
        &cleanup_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (cleanup_status == 0) return error.OperationConflict;
    if (c.errno(cleanup_status) != .NOENT) return error.IoFailure;
    if (c.renameat(
        parent_fd,
        &proof_z,
        parent_fd,
        &cleanup_z,
    ) != 0) return error.IoFailure;
    try fsyncFd(parent_fd);
    try removeRetiredCompletionProofDirectory(
        allocator,
        io,
        parent_fd,
        cleanup_name,
        device,
    );
}

fn removeRetiredCompletionProofDirectory(
    allocator: Allocator,
    io: Io,
    parent_fd: c.fd_t,
    proof_name: []const u8,
    device: c.dev_t,
) RemovalError!void {
    const proof_fd = try openCompletionProofDirectory(
        parent_fd,
        proof_name,
        device,
    );
    defer _ = c.close(proof_fd);
    try removeDirectoryContents(
        allocator,
        io,
        proof_fd,
        device,
    );
    const proof_z = try stackZ(proof_name);
    if (c.unlinkat(
        parent_fd,
        &proof_z,
        c.AT.REMOVEDIR,
    ) != 0) return error.IoFailure;
    try fsyncFd(parent_fd);
}

fn finalizeHelperState(
    allocator: Allocator,
    io: Io,
    payload: *const Payload,
    request_digest: []const u8,
    signing_key: []const u8,
) RemovalError!void {
    const helper_parent_path = std.fs.path.dirname(
        payload.helperStateRoot,
    ) orelse return error.UnsafePath;
    var helper_parent = try openExistingDirectory(helper_parent_path);
    defer helper_parent.close();
    const helper_leaf = std.fs.path.basename(payload.helperStateRoot);
    const tombstone_name = std.fmt.allocPrint(
        allocator,
        ".{s}.removing-{s}",
        .{ helper_leaf, payload.operationId },
    ) catch return error.OutOfMemory;
    defer allocator.free(tombstone_name);
    if (!validLeafName(tombstone_name)) return error.UnsafePath;
    const proof_name = try completionProofDirectoryName(
        allocator,
        helper_leaf,
        payload.operationId,
    );
    defer allocator.free(proof_name);
    const proof_cleanup_name = try completionProofCleanupDirectoryName(
        allocator,
        helper_leaf,
        payload.operationId,
    );
    defer allocator.free(proof_cleanup_name);

    var helper = try openExistingDirectory(payload.helperStateRoot);
    defer helper.close();
    if (helper.stat.uid != c.geteuid() or
        helper.stat.mode & 0o777 != private_directory_mode or
        helper.stat.dev != helper_parent.stat.dev)
    {
        return error.UnsafePath;
    }
    try ensureInternalCompletionProof(
        allocator,
        io,
        helper.fd,
        helper.stat.dev,
        payload.operationId,
        request_digest,
        signing_key,
    );

    const helper_leaf_z = try stackZ(helper_leaf);
    const tombstone_z = try stackZ(tombstone_name);
    var tombstone_stat: c.Stat = undefined;
    const tombstone_status = c.fstatat(
        helper_parent.fd,
        &tombstone_z,
        &tombstone_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (tombstone_status == 0) {
        return error.OperationConflict;
    }
    if (c.errno(tombstone_status) != .NOENT) return error.IoFailure;
    if (c.renameat(
        helper_parent.fd,
        &helper_leaf_z,
        helper_parent.fd,
        &tombstone_z,
    ) != 0) return error.IoFailure;
    try fsyncFd(helper_parent.fd);

    const tombstone_fd = c.openat(
        helper_parent.fd,
        &tombstone_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (tombstone_fd < 0) return error.IoFailure;
    defer _ = c.close(tombstone_fd);
    var tombstone_open_stat: c.Stat = undefined;
    if (c.fstat(tombstone_fd, &tombstone_open_stat) != 0) {
        return error.IoFailure;
    }
    try publishCompletionProof(
        helper_parent.fd,
        tombstone_fd,
        proof_name,
    );
    const proof_fd = try openCompletionProofDirectory(
        helper_parent.fd,
        proof_name,
        helper_parent.stat.dev,
    );
    defer _ = c.close(proof_fd);
    try validateCompletionProof(
        allocator,
        io,
        proof_fd,
        payload.operationId,
        request_digest,
    );
    try removeDirectoryContents(
        allocator,
        io,
        tombstone_fd,
        tombstone_open_stat.dev,
    );
    if (c.unlinkat(helper_parent.fd, &tombstone_z, c.AT.REMOVEDIR) != 0) {
        return error.IoFailure;
    }
    try fsyncFd(helper_parent.fd);
    try retireAndRemoveCompletionProofDirectory(
        allocator,
        io,
        helper_parent.fd,
        proof_name,
        proof_cleanup_name,
        helper_parent.stat.dev,
    );
    try removeExclusion(allocator, io, payload.exclusionPath);
}

fn removeExclusion(
    allocator: Allocator,
    io: Io,
    exclusion_path: []const u8,
) RemovalError!void {
    const state = try inspectPath(exclusion_path, null);
    switch (state) {
        .absent => return,
        .present => |value| {
            var exclusion = value;
            defer exclusion.close();
            if (!c.S.ISDIR(exclusion.stat.mode)) return error.UnsafePath;
            try removeDirectoryContents(
                allocator,
                io,
                exclusion.fd,
                exclusion.stat.dev,
            );
            const leaf_z = try stackZ(exclusion.parent.leaf);
            if (c.unlinkat(
                exclusion.parent.fd,
                &leaf_z,
                c.AT.REMOVEDIR,
            ) != 0) return error.IoFailure;
            try fsyncFd(exclusion.parent.fd);
        },
    }
}

fn openPrivateDirectoryAtIfPresent(
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
) RemovalError!?c.fd_t {
    return openCompletionProofDirectory(
        parent_fd,
        name,
        device,
    ) catch |err| switch (err) {
        error.PathAbsent => null,
        else => return err,
    };
}

fn directDirectoryIsEmpty(
    io: Io,
    directory_fd: c.fd_t,
) RemovalError!bool {
    var iterator = (Dir{ .handle = directory_fd }).iterate();
    return (iterator.next(io) catch return error.IoFailure) == null;
}

fn privateRegularChildStat(
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
    exact_size: ?usize,
) RemovalError!?c.Stat {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    var stat: c.Stat = undefined;
    const status = c.fstatat(
        parent_fd,
        &name_z,
        &stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (status != 0) {
        if (c.errno(status) == .NOENT) return null;
        return error.IoFailure;
    }
    if (!c.S.ISREG(stat.mode) or
        stat.uid != c.geteuid() or
        stat.nlink != 1 or
        stat.mode & 0o777 != private_file_mode or
        stat.dev != device or
        stat.size < 0 or
        (exact_size != null and
            @as(usize, @intCast(stat.size)) != exact_size.?))
    {
        return error.UnsafePath;
    }
    return stat;
}

fn openPrivateEmptyChildDirectory(
    io: Io,
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
) RemovalError!c.fd_t {
    if (!validLeafName(name)) return error.UnsafePath;
    const name_z = try stackZ(name);
    var path_stat: c.Stat = undefined;
    if (c.fstatat(
        parent_fd,
        &name_z,
        &path_stat,
        c.AT.SYMLINK_NOFOLLOW,
    ) != 0) return error.OperationConflict;
    const child_fd = c.openat(
        parent_fd,
        &name_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (child_fd < 0) return error.UnsafePath;
    errdefer _ = c.close(child_fd);
    var opened_stat: c.Stat = undefined;
    if (c.fstat(child_fd, &opened_stat) != 0 or
        !c.S.ISDIR(opened_stat.mode) or
        opened_stat.uid != c.geteuid() or
        opened_stat.mode & 0o777 != private_directory_mode or
        opened_stat.dev != device or
        opened_stat.dev != path_stat.dev or
        opened_stat.ino != path_stat.ino)
    {
        return error.UnsafePath;
    }
    if (!try directDirectoryIsEmpty(io, child_fd)) {
        return error.OperationConflict;
    }
    return child_fd;
}

fn isUncommittedPrivateDirectoryName(name: []const u8) bool {
    for (uncommitted_private_directory_names) |expected| {
        if (std.mem.eql(u8, name, expected)) return true;
    }
    return false;
}

fn isUncommittedGatewayReceiptTempName(name: []const u8) bool {
    const prefix = ".";
    const receipt_suffix = ".json.";
    const random_hex_length = 24;
    const temporary_suffix = ".tmp";
    if (!std.mem.startsWith(u8, name, prefix) or
        !std.mem.endsWith(u8, name, temporary_suffix) or
        name.len <= prefix.len +
            receipt_suffix.len +
            random_hex_length +
            temporary_suffix.len)
    {
        return false;
    }
    const random_hex_end = name.len - temporary_suffix.len;
    const random_hex_start = random_hex_end - random_hex_length;
    if (random_hex_start < receipt_suffix.len + prefix.len or
        !std.mem.eql(
            u8,
            name[random_hex_start - receipt_suffix.len .. random_hex_start],
            receipt_suffix,
        ))
    {
        return false;
    }
    const operation_id =
        name[prefix.len .. random_hex_start - receipt_suffix.len];
    // The gateway's opaque operation ID schema requires at least seven
    // characters after "op_"; do not widen crash-temp cleanup to helper-only
    // short identifiers.
    if (operation_id.len < "op".len + 8 or
        !validOperationId(operation_id)) return false;
    for (name[random_hex_start..random_hex_end]) |byte| {
        if (!std.ascii.isDigit(byte) and (byte < 'a' or byte > 'f')) {
            return false;
        }
    }
    return true;
}

fn removeUncommittedGatewayReceiptTemps(
    io: Io,
    root_fd: c.fd_t,
    device: c.dev_t,
) RemovalError!void {
    const receipts = try openPrivateDirectoryAtIfPresent(
        root_fd,
        gateway_receipts_directory_name,
        device,
    );
    const receipts_fd = receipts orelse return;
    defer _ = c.close(receipts_fd);
    var removed = false;
    var iterator = (Dir{ .handle = receipts_fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        if (!isUncommittedGatewayReceiptTempName(entry.name)) continue;
        _ = try privateRegularChildStat(
            receipts_fd,
            entry.name,
            device,
            null,
        ) orelse return error.OperationConflict;
        const entry_z = try stackZ(entry.name);
        if (c.unlinkat(receipts_fd, &entry_z, 0) != 0) {
            return error.IoFailure;
        }
        removed = true;
    }
    if (removed) try fsyncFd(receipts_fd);
}

fn inspectUncommittedTree(
    io: Io,
    root_fd: c.fd_t,
    device: c.dev_t,
    held_lock_fd: ?c.fd_t,
    signing_key_required: bool,
) RemovalError!UncommittedTreeState {
    var saw_signing_key = false;
    var saw_execution_lock = false;
    var contains_operation_state = false;
    var iterator = (Dir{ .handle = root_fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        if (std.mem.eql(u8, entry.name, signing_key_file_name)) {
            if (saw_signing_key or
                try privateRegularChildStat(
                    root_fd,
                    signing_key_file_name,
                    device,
                    32,
                ) == null)
            {
                return error.UnsafePath;
            }
            saw_signing_key = true;
            continue;
        }
        if (std.mem.eql(u8, entry.name, execution_lock_file_name)) {
            if (saw_execution_lock) return error.UnsafePath;
            const path_stat = try privateRegularChildStat(
                root_fd,
                execution_lock_file_name,
                device,
                null,
            ) orelse return error.OperationConflict;
            const lock_fd = held_lock_fd orelse
                return error.OperationConflict;
            var opened_stat: c.Stat = undefined;
            if (c.fstat(lock_fd, &opened_stat) != 0 or
                opened_stat.dev != path_stat.dev or
                opened_stat.ino != path_stat.ino)
            {
                return error.OperationConflict;
            }
            saw_execution_lock = true;
            continue;
        }
        if (isUncommittedPrivateDirectoryName(entry.name)) {
            const child_fd = openPrivateEmptyChildDirectory(
                io,
                root_fd,
                entry.name,
                device,
            ) catch |err| switch (err) {
                error.OperationConflict => {
                    contains_operation_state = true;
                    continue;
                },
                else => return err,
            };
            _ = c.close(child_fd);
            continue;
        }
        return error.UnsafePath;
    }
    if (signing_key_required and !saw_signing_key) {
        return error.InvalidReceipt;
    }
    if ((held_lock_fd != null) != saw_execution_lock) {
        return error.OperationConflict;
    }
    return if (contains_operation_state)
        .contains_operation_state
    else
        .exact_empty;
}

fn acquireDirectExecutionLock(
    root_fd: c.fd_t,
    device: c.dev_t,
) RemovalError!?c.fd_t {
    const path_stat = try privateRegularChildStat(
        root_fd,
        execution_lock_file_name,
        device,
        null,
    ) orelse return null;
    const lock_z = try stackZ(execution_lock_file_name);
    const lock_fd = c.openat(
        root_fd,
        &lock_z,
        c.O{
            .ACCMODE = .RDWR,
            .CLOEXEC = true,
            .NOFOLLOW = true,
        },
    );
    if (lock_fd < 0) return error.OperationConflict;
    errdefer _ = c.close(lock_fd);
    var opened_stat: c.Stat = undefined;
    if (c.fstat(lock_fd, &opened_stat) != 0 or
        opened_stat.dev != path_stat.dev or
        opened_stat.ino != path_stat.ino)
    {
        return error.OperationConflict;
    }
    try acquireExclusiveLock(lock_fd);
    return lock_fd;
}

fn unlinkPrivateRegularChildIfPresent(
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
    exact_size: ?usize,
) RemovalError!void {
    if (try privateRegularChildStat(
        parent_fd,
        name,
        device,
        exact_size,
    ) == null) return;
    const name_z = try stackZ(name);
    if (c.unlinkat(parent_fd, &name_z, 0) != 0) {
        return error.IoFailure;
    }
}

fn unlinkPrivateEmptyDirectoryIfPresent(
    io: Io,
    parent_fd: c.fd_t,
    name: []const u8,
    device: c.dev_t,
) RemovalError!void {
    const child_fd = openPrivateDirectoryAtIfPresent(
        parent_fd,
        name,
        device,
    ) catch |err| return err;
    const opened_fd = child_fd orelse return;
    defer _ = c.close(opened_fd);
    if (!try directDirectoryIsEmpty(io, opened_fd)) {
        return error.OperationConflict;
    }
    const name_z = try stackZ(name);
    if (c.unlinkat(parent_fd, &name_z, c.AT.REMOVEDIR) != 0) {
        return error.IoFailure;
    }
}

fn removeUncommittedCleanupDirectory(
    io: Io,
    parent_fd: c.fd_t,
    parent_device: c.dev_t,
    cleanup_name: []const u8,
    cleanup_fd: c.fd_t,
    held_lock_fd: ?c.fd_t,
) RemovalError!void {
    try removeUncommittedGatewayReceiptTemps(
        io,
        cleanup_fd,
        parent_device,
    );
    if (try inspectUncommittedTree(
        io,
        cleanup_fd,
        parent_device,
        held_lock_fd,
        false,
    ) != .exact_empty) return error.OperationConflict;
    try unlinkPrivateRegularChildIfPresent(
        cleanup_fd,
        signing_key_file_name,
        parent_device,
        32,
    );
    try unlinkPrivateRegularChildIfPresent(
        cleanup_fd,
        execution_lock_file_name,
        parent_device,
        null,
    );
    for (uncommitted_private_directory_names) |name| {
        try unlinkPrivateEmptyDirectoryIfPresent(
            io,
            cleanup_fd,
            name,
            parent_device,
        );
    }
    try fsyncFd(cleanup_fd);
    const cleanup_z = try stackZ(cleanup_name);
    if (c.unlinkat(
        parent_fd,
        &cleanup_z,
        c.AT.REMOVEDIR,
    ) != 0) return error.IoFailure;
    try fsyncFd(parent_fd);
}

fn removeAnchoredEmptyDirectory(
    io: Io,
    parent_fd: c.fd_t,
    name: []const u8,
    opened_fd: c.fd_t,
) RemovalError!void {
    if (!try directDirectoryIsEmpty(io, opened_fd)) {
        return error.OperationConflict;
    }
    var opened_stat: c.Stat = undefined;
    if (c.fstat(opened_fd, &opened_stat) != 0) return error.IoFailure;
    const name_z = try stackZ(name);
    var path_stat: c.Stat = undefined;
    if (c.fstatat(
        parent_fd,
        &name_z,
        &path_stat,
        c.AT.SYMLINK_NOFOLLOW,
    ) != 0 or
        path_stat.dev != opened_stat.dev or
        path_stat.ino != opened_stat.ino)
    {
        return error.OperationConflict;
    }
    if (c.unlinkat(parent_fd, &name_z, c.AT.REMOVEDIR) != 0) {
        return error.IoFailure;
    }
    try fsyncFd(parent_fd);
}

fn hasCommittedRecoverySibling(
    io: Io,
    parent_fd: c.fd_t,
    tombstone_prefix: []const u8,
    proof_prefix: []const u8,
) RemovalError!bool {
    var iterator = (Dir{ .handle = parent_fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        if (std.mem.startsWith(u8, entry.name, tombstone_prefix) or
            std.mem.startsWith(u8, entry.name, proof_prefix))
        {
            return true;
        }
    }
    return false;
}

fn recoverUncommittedHelperStateAt(
    io: Io,
    parent_fd: c.fd_t,
    parent_device: c.dev_t,
    helper_name: []const u8,
    exclusion_name: []const u8,
    cleanup_name: []const u8,
    held_live_lock_fd: ?c.fd_t,
    has_committed_recovery_sibling: bool,
) RemovalError!UncommittedRecoveryState {
    const live_root = try openPrivateDirectoryAtIfPresent(
        parent_fd,
        helper_name,
        parent_device,
    );
    defer if (live_root) |fd| {
        _ = c.close(fd);
    };
    const cleanup_root = try openPrivateDirectoryAtIfPresent(
        parent_fd,
        cleanup_name,
        parent_device,
    );
    defer if (cleanup_root) |fd| {
        _ = c.close(fd);
    };
    if (live_root != null and cleanup_root != null) {
        return error.OperationConflict;
    }
    if (live_root == null and cleanup_root == null) {
        return .no_live_state;
    }
    if (has_committed_recovery_sibling) {
        return error.OperationConflict;
    }

    const exclusion = try openPrivateDirectoryAtIfPresent(
        parent_fd,
        exclusion_name,
        parent_device,
    );
    if (exclusion == null) {
        if (live_root != null) return .live_state_untouched;
        return error.OperationConflict;
    }
    const exclusion_fd = exclusion.?;
    defer _ = c.close(exclusion_fd);
    if (!try directDirectoryIsEmpty(io, exclusion_fd)) {
        return error.UnsafePath;
    }

    if (cleanup_root) |cleanup_fd| {
        const cleanup_lock = try acquireDirectExecutionLock(
            cleanup_fd,
            parent_device,
        );
        defer if (cleanup_lock) |fd| {
            _ = c.close(fd);
        };
        try removeUncommittedCleanupDirectory(
            io,
            parent_fd,
            parent_device,
            cleanup_name,
            cleanup_fd,
            cleanup_lock,
        );
        try removeAnchoredEmptyDirectory(
            io,
            parent_fd,
            exclusion_name,
            exclusion_fd,
        );
        return .recovered;
    }

    const live_fd = live_root.?;
    try removeUncommittedGatewayReceiptTemps(
        io,
        live_fd,
        parent_device,
    );
    const tree_state = try inspectUncommittedTree(
        io,
        live_fd,
        parent_device,
        held_live_lock_fd,
        true,
    );
    if (tree_state == .contains_operation_state) {
        return .live_state_untouched;
    }

    const helper_z = try stackZ(helper_name);
    const cleanup_z = try stackZ(cleanup_name);
    if (c.renameat(
        parent_fd,
        &helper_z,
        parent_fd,
        &cleanup_z,
    ) != 0) return error.OperationConflict;
    try fsyncFd(parent_fd);
    var live_stat: c.Stat = undefined;
    var cleanup_stat: c.Stat = undefined;
    if (c.fstat(live_fd, &live_stat) != 0 or
        c.fstatat(
            parent_fd,
            &cleanup_z,
            &cleanup_stat,
            c.AT.SYMLINK_NOFOLLOW,
        ) != 0 or
        live_stat.dev != cleanup_stat.dev or
        live_stat.ino != cleanup_stat.ino)
    {
        return error.OperationConflict;
    }
    try removeUncommittedCleanupDirectory(
        io,
        parent_fd,
        parent_device,
        cleanup_name,
        live_fd,
        held_live_lock_fd,
    );
    try removeAnchoredEmptyDirectory(
        io,
        parent_fd,
        exclusion_name,
        exclusion_fd,
    );
    return .recovered;
}

fn recoverStaged(
    allocator: Allocator,
    io: Io,
    helper_state_root: []const u8,
) RemovalError!void {
    try validateRecoveryRoot(allocator, helper_state_root);
    var live_lock = try probeLiveExecutionLock(helper_state_root);
    defer if (live_lock) |*file| file.close(io);
    const parent_path = std.fs.path.dirname(helper_state_root) orelse
        return error.UnsafePath;
    var parent = try openExistingDirectory(parent_path);
    defer parent.close();
    const prefix = try std.fmt.allocPrint(
        allocator,
        ".{s}.removing-",
        .{std.fs.path.basename(helper_state_root)},
    );
    defer allocator.free(prefix);
    const proof_prefix = try std.fmt.allocPrint(
        allocator,
        ".{s}.completion-",
        .{std.fs.path.basename(helper_state_root)},
    );
    defer allocator.free(proof_prefix);
    const proof_cleanup_prefix = try std.fmt.allocPrint(
        allocator,
        ".{s}.completion-cleanup-",
        .{std.fs.path.basename(helper_state_root)},
    );
    defer allocator.free(proof_cleanup_prefix);
    const uncommitted_cleanup_name = try std.fmt.allocPrint(
        allocator,
        ".{s}.uncommitted-cleanup",
        .{std.fs.path.basename(helper_state_root)},
    );
    defer allocator.free(uncommitted_cleanup_name);
    const exclusion_path = try recoveryExclusionPath(
        allocator,
        helper_state_root,
    );
    defer allocator.free(exclusion_path);
    if (!std.mem.eql(
        u8,
        std.fs.path.dirname(exclusion_path) orelse "",
        parent_path,
    )) return error.UnsafePath;
    const has_committed_recovery_sibling =
        try hasCommittedRecoverySibling(
            io,
            parent.fd,
            prefix,
            proof_prefix,
        );
    const live_lock_fd: ?c.fd_t = if (live_lock) |file|
        file.handle
    else
        null;
    switch (try recoverUncommittedHelperStateAt(
        io,
        parent.fd,
        parent.stat.dev,
        std.fs.path.basename(helper_state_root),
        std.fs.path.basename(exclusion_path),
        uncommitted_cleanup_name,
        live_lock_fd,
        has_committed_recovery_sibling,
    )) {
        .no_live_state => {},
        .live_state_untouched, .recovered => return,
    }

    var iterator = (Dir{ .handle = parent.fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        if (!std.mem.startsWith(u8, entry.name, prefix)) continue;
        const operation_id = entry.name[prefix.len..];
        if (!validOperationId(operation_id)) continue;
        const entry_z = try stackZ(entry.name);
        const tombstone_fd = c.openat(
            parent.fd,
            &entry_z,
            c.O{
                .ACCMODE = .RDONLY,
                .CLOEXEC = true,
                .DIRECTORY = true,
                .NOFOLLOW = true,
            },
        );
        if (tombstone_fd < 0) return error.UnsafePath;
        defer _ = c.close(tombstone_fd);
        var tombstone_stat: c.Stat = undefined;
        if (c.fstat(tombstone_fd, &tombstone_stat) != 0 or
            tombstone_stat.uid != c.geteuid() or
            tombstone_stat.mode & 0o777 != private_directory_mode)
        {
            return error.UnsafePath;
        }

        const proof_name = try completionProofDirectoryName(
            allocator,
            std.fs.path.basename(helper_state_root),
            operation_id,
        );
        defer allocator.free(proof_name);
        const proof_cleanup_name =
            try completionProofCleanupDirectoryName(
                allocator,
                std.fs.path.basename(helper_state_root),
                operation_id,
            );
        defer allocator.free(proof_cleanup_name);
        const external_proof = openCompletionProofDirectory(
            parent.fd,
            proof_name,
            parent.stat.dev,
        ) catch |err| switch (err) {
            error.PathAbsent => null,
            else => return err,
        };
        const has_external_proof = external_proof != null;
        if (external_proof) |proof_fd| {
            defer _ = c.close(proof_fd);
            try validateCompletionProof(
                allocator,
                io,
                proof_fd,
                operation_id,
                null,
            );
        }

        const lock_fd = c.openat(
            tombstone_fd,
            execution_lock_file_name,
            c.O{
                .ACCMODE = .RDWR,
                .CLOEXEC = true,
                .NOFOLLOW = true,
            },
        );
        var held_lock_fd: ?c.fd_t = null;
        defer {
            if (held_lock_fd) |fd| _ = c.close(fd);
        }
        if (lock_fd >= 0) {
            held_lock_fd = lock_fd;
            var lock_stat: c.Stat = undefined;
            if (c.fstat(lock_fd, &lock_stat) != 0 or
                !c.S.ISREG(lock_stat.mode) or
                lock_stat.uid != c.geteuid() or
                lock_stat.nlink != 1 or
                lock_stat.mode & 0o777 != private_file_mode)
            {
                return error.UnsafePath;
            }
            if (flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
                return error.ActiveOperation;
            }
        } else if (!has_external_proof or c.errno(lock_fd) != .NOENT) {
            return error.InvalidReceipt;
        }

        if (!has_external_proof) {
            const request_digest = try validateCompletedTombstone(
                allocator,
                io,
                tombstone_fd,
                operation_id,
            );
            defer allocator.free(request_digest);
            const signing_key = try readDirectPrivateFile(
                allocator,
                io,
                tombstone_fd,
                signing_key_file_name,
                32,
                32,
            );
            defer allocator.free(signing_key);
            try ensureInternalCompletionProof(
                allocator,
                io,
                tombstone_fd,
                tombstone_stat.dev,
                operation_id,
                request_digest,
                signing_key,
            );
            try publishCompletionProof(
                parent.fd,
                tombstone_fd,
                proof_name,
            );
            const proof_fd = try openCompletionProofDirectory(
                parent.fd,
                proof_name,
                parent.stat.dev,
            );
            defer _ = c.close(proof_fd);
            try validateCompletionProof(
                allocator,
                io,
                proof_fd,
                operation_id,
                request_digest,
            );
        }
        try removeDirectoryContents(
            allocator,
            io,
            tombstone_fd,
            tombstone_stat.dev,
        );
        if (c.unlinkat(parent.fd, &entry_z, c.AT.REMOVEDIR) != 0) {
            return error.IoFailure;
        }
        try fsyncFd(parent.fd);
        try retireAndRemoveCompletionProofDirectory(
            allocator,
            io,
            parent.fd,
            proof_name,
            proof_cleanup_name,
            parent.stat.dev,
        );
    }

    const helper_state = try inspectPath(helper_state_root, null);
    switch (helper_state) {
        .absent => {
            var proof_iterator = (Dir{ .handle = parent.fd }).iterate();
            while (proof_iterator.next(io) catch
                return error.IoFailure) |entry|
            {
                if (!std.mem.startsWith(
                    u8,
                    entry.name,
                    proof_prefix,
                )) continue;
                const operation_id = entry.name[proof_prefix.len..];
                if (!validOperationId(operation_id)) continue;
                const proof_fd = try openCompletionProofDirectory(
                    parent.fd,
                    entry.name,
                    parent.stat.dev,
                );
                defer _ = c.close(proof_fd);
                try validateCompletionProof(
                    allocator,
                    io,
                    proof_fd,
                    operation_id,
                    null,
                );
                const proof_cleanup_name =
                    try completionProofCleanupDirectoryName(
                        allocator,
                        std.fs.path.basename(helper_state_root),
                        operation_id,
                    );
                defer allocator.free(proof_cleanup_name);
                try retireAndRemoveCompletionProofDirectory(
                    allocator,
                    io,
                    parent.fd,
                    entry.name,
                    proof_cleanup_name,
                    parent.stat.dev,
                );
            }
            var cleanup_iterator =
                (Dir{ .handle = parent.fd }).iterate();
            while (cleanup_iterator.next(io) catch
                return error.IoFailure) |entry|
            {
                if (!std.mem.startsWith(
                    u8,
                    entry.name,
                    proof_cleanup_prefix,
                )) continue;
                const operation_id =
                    entry.name[proof_cleanup_prefix.len..];
                if (!validOperationId(operation_id)) continue;
                try removeRetiredCompletionProofDirectory(
                    allocator,
                    io,
                    parent.fd,
                    entry.name,
                    parent.stat.dev,
                );
            }
            const exclusion = try openPrivateDirectoryAtIfPresent(
                parent.fd,
                std.fs.path.basename(exclusion_path),
                parent.stat.dev,
            );
            if (exclusion) |exclusion_fd| {
                defer _ = c.close(exclusion_fd);
                try removeAnchoredEmptyDirectory(
                    io,
                    parent.fd,
                    std.fs.path.basename(exclusion_path),
                    exclusion_fd,
                );
            }
        },
        .present => |value| {
            var node = value;
            defer node.close();
            return error.OperationConflict;
        },
    }
}

fn probeLiveExecutionLock(
    helper_state_root: []const u8,
) RemovalError!?File {
    const root_state = try inspectPath(helper_state_root, null);
    switch (root_state) {
        .absent => return null,
        .present => |value| {
            var root = value;
            defer root.close();
            if (!c.S.ISDIR(root.stat.mode)) return error.UnsafePath;
            const lock_z = try stackZ(execution_lock_file_name);
            const fd = c.openat(
                root.fd,
                &lock_z,
                c.O{
                    .ACCMODE = .RDWR,
                    .CLOEXEC = true,
                    .NOFOLLOW = true,
                },
            );
            if (fd < 0) {
                if (c.errno(fd) == .NOENT) return null;
                return error.UnsafePath;
            }
            errdefer _ = c.close(fd);
            var stat: c.Stat = undefined;
            if (c.fstat(fd, &stat) != 0 or
                !c.S.ISREG(stat.mode) or
                stat.uid != c.geteuid() or
                stat.nlink != 1 or
                stat.mode & 0o777 != private_file_mode)
            {
                return error.UnsafePath;
            }
            try acquireExclusiveLock(fd);
            return File{
                .handle = fd,
                .flags = .{ .nonblocking = false },
            };
        },
    }
}

fn acquireExclusiveLock(fd: c.fd_t) RemovalError!void {
    if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
        return if (c.errno(-1) == .AGAIN)
            error.ActiveOperation
        else
            error.IoFailure;
    }
}

fn validateCompletedTombstone(
    allocator: Allocator,
    io: Io,
    tombstone_fd: c.fd_t,
    operation_id: []const u8,
) RemovalError![]u8 {
    const receipts_fd = openDirectDirectory(tombstone_fd, "helper-receipts") catch
        return error.InvalidReceipt;
    defer _ = c.close(receipts_fd);
    const receipt_name = std.fmt.allocPrint(
        allocator,
        "{s}.json",
        .{operation_id},
    ) catch return error.OutOfMemory;
    defer allocator.free(receipt_name);
    const receipt_bytes = try readDirectRegularFile(
        allocator,
        io,
        receipts_fd,
        receipt_name,
        maximum_receipt_bytes,
    );
    defer allocator.free(receipt_bytes);
    var receipt = std.json.parseFromSlice(
        HelperReceipt,
        allocator,
        receipt_bytes,
        .{ .allocate = .alloc_always, .max_value_len = maximum_receipt_bytes },
    ) catch return error.InvalidReceipt;
    defer receipt.deinit();
    if (receipt.value.version != 1 or
        !std.mem.eql(u8, receipt.value.operationId, operation_id) or
        !std.mem.eql(u8, receipt.value.state, "completed") or
        !validPrefixedHex(receipt.value.requestDigest, "sha256_", 64))
    {
        return error.InvalidReceipt;
    }
    return allocator.dupe(
        u8,
        receipt.value.requestDigest,
    ) catch return error.OutOfMemory;
}

fn validateRecoveryRoot(
    allocator: Allocator,
    helper_state_root: []const u8,
) RemovalError!void {
    try validateNormalizedAbsolute(helper_state_root);
    const home = try effectiveHome(allocator);
    defer allocator.free(home);
    const expected = std.fs.path.join(
        allocator,
        &.{
            home,
            "Library",
            "Application Support",
            helper_state_directory_name,
        },
    ) catch return error.OutOfMemory;
    defer allocator.free(expected);
    if (!std.mem.eql(u8, helper_state_root, expected)) {
        return error.UnsafePath;
    }
}

fn recoveryExclusionPath(
    allocator: Allocator,
    helper_state_root: []const u8,
) RemovalError![]u8 {
    const parent = std.fs.path.dirname(helper_state_root) orelse
        return error.UnsafePath;
    return std.fs.path.join(
        allocator,
        &.{ parent, ".OPRTE Removal.removal-in-progress" },
    ) catch return error.OutOfMemory;
}

fn validateReceipt(
    receipt: HelperReceipt,
    payload: *const Payload,
) RemovalError!void {
    if (receipt.version != 1 or
        !std.mem.eql(u8, receipt.operationId, payload.operationId) or
        !validPrefixedHex(receipt.requestDigest, "sha256_", 64) or
        (!std.mem.eql(u8, receipt.state, "running") and
            !std.mem.eql(u8, receipt.state, "completed")) or
        receipt.targets.len != payload.targets.len)
    {
        return error.InvalidReceipt;
    }
    for (receipt.targets, payload.targets) |progress, target| {
        if (!std.mem.eql(u8, progress.id, target.id) or
            (!std.mem.eql(u8, progress.state, "pending") and
                !std.mem.eql(u8, progress.state, "staged") and
                !std.mem.eql(u8, progress.state, "administration_staged") and
                !std.mem.eql(u8, progress.state, "removed")))
        {
            return error.InvalidReceipt;
        }
    }
}

fn readReceipt(
    allocator: Allocator,
    io: Io,
    path: []const u8,
) (RemovalError || error{FileNotFound})!std.json.Parsed(HelperReceipt) {
    const bytes = readPrivateFile(
        allocator,
        io,
        path,
        maximum_receipt_bytes,
        null,
    ) catch |err| switch (err) {
        error.PathAbsent => return error.FileNotFound,
        else => return err,
    };
    defer allocator.free(bytes);
    return std.json.parseFromSlice(
        HelperReceipt,
        allocator,
        bytes,
        .{ .allocate = .alloc_always, .max_value_len = maximum_receipt_bytes },
    ) catch return error.InvalidReceipt;
}

fn writeReceiptAtomic(
    allocator: Allocator,
    io: Io,
    path: []const u8,
    receipt: HelperReceipt,
) RemovalError!void {
    const data = try canonicalJson(allocator, receipt);
    defer allocator.free(data);
    var parent = try openParentNoFollow(path);
    defer parent.close();
    if (!validLeafName(parent.leaf)) return error.UnsafePath;

    var random: [16]u8 = undefined;
    io.random(&random);
    var temporary_name_buffer: [96]u8 = undefined;
    const temporary_name = std.fmt.bufPrint(
        &temporary_name_buffer,
        ".receipt-{x}.tmp",
        .{random},
    ) catch return error.IoFailure;
    const temporary_z = try stackZ(temporary_name);
    const fd = c.openat(
        parent.fd,
        &temporary_z,
        c.O{
            .ACCMODE = .WRONLY,
            .CLOEXEC = true,
            .CREAT = true,
            .EXCL = true,
            .NOFOLLOW = true,
        },
        private_file_mode,
    );
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.PathAbsent,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    var file = File{ .handle = fd, .flags = .{ .nonblocking = false } };
    var file_open = true;
    defer if (file_open) file.close(io);
    file.writeStreamingAll(io, data) catch return error.IoFailure;
    file.writeStreamingAll(io, "\n") catch return error.IoFailure;
    file.sync(io) catch return error.IoFailure;
    file.close(io);
    file_open = false;

    const leaf_z = try stackZ(parent.leaf);
    if (c.renameat(parent.fd, &temporary_z, parent.fd, &leaf_z) != 0) {
        _ = c.unlinkat(parent.fd, &temporary_z, 0);
        return error.IoFailure;
    }
    try fsyncFd(parent.fd);
}

fn readPrivateFile(
    allocator: Allocator,
    io: Io,
    path: []const u8,
    maximum_bytes: usize,
    exact_bytes: ?usize,
) RemovalError![]u8 {
    var node = try openExistingRegularFile(path);
    defer node.close();
    if (node.stat.uid != c.geteuid() or
        node.stat.nlink != 1 or
        node.stat.mode & 0o777 != private_file_mode or
        node.stat.size < 0 or
        !requestByteLengthAllowed(@intCast(node.stat.size), maximum_bytes) or
        (exact_bytes != null and node.stat.size != exact_bytes.?))
    {
        return error.UnsafePath;
    }
    const size: usize = @intCast(node.stat.size);
    const output = allocator.alloc(u8, size) catch return error.OutOfMemory;
    errdefer allocator.free(output);
    const file = File{ .handle = node.fd, .flags = .{ .nonblocking = false } };
    const read = file.readPositionalAll(io, output, 0) catch
        return error.IoFailure;
    if (read != output.len) return error.IoFailure;
    return output;
}

fn requestByteLengthAllowed(size: usize, limit: usize) bool {
    return size <= limit;
}

fn readDirectRegularFile(
    allocator: Allocator,
    io: Io,
    parent_fd: c.fd_t,
    leaf: []const u8,
    maximum_bytes: usize,
) RemovalError![]u8 {
    if (!validLeafName(leaf)) return error.UnsafePath;
    const leaf_z = try stackZ(leaf);
    const fd = c.openat(
        parent_fd,
        &leaf_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) return error.IoFailure;
    defer _ = c.close(fd);
    var stat: c.Stat = undefined;
    if (c.fstat(fd, &stat) != 0 or
        !c.S.ISREG(stat.mode) or
        stat.nlink != 1 or
        stat.size <= 0 or
        stat.size > maximum_bytes)
    {
        return error.UnsafePath;
    }
    const output = allocator.alloc(u8, @intCast(stat.size)) catch
        return error.OutOfMemory;
    errdefer allocator.free(output);
    const file = File{ .handle = fd, .flags = .{ .nonblocking = false } };
    const read = file.readPositionalAll(io, output, 0) catch
        return error.IoFailure;
    if (read != output.len) return error.IoFailure;
    return output;
}

fn openExistingRegularFile(path: []const u8) RemovalError!OpenedNode {
    var parent = try openParentNoFollow(path);
    errdefer parent.close();
    const leaf_z = try stackZ(parent.leaf);
    const fd = c.openat(
        parent.fd,
        &leaf_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.PathAbsent,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(fd);
    var stat: c.Stat = undefined;
    if (c.fstat(fd, &stat) != 0 or !c.S.ISREG(stat.mode)) {
        return error.UnsafePath;
    }
    return .{ .fd = fd, .stat = stat, .parent = parent };
}

fn openExistingDirectory(path: []const u8) RemovalError!OpenedNode {
    var parent = try openParentNoFollow(path);
    errdefer parent.close();
    const leaf_z = try stackZ(parent.leaf);
    const fd = c.openat(
        parent.fd,
        &leaf_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.PathAbsent,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(fd);
    var stat: c.Stat = undefined;
    if (c.fstat(fd, &stat) != 0 or !c.S.ISDIR(stat.mode)) {
        return error.UnsafePath;
    }
    return .{ .fd = fd, .stat = stat, .parent = parent };
}

fn openDirectDirectory(
    parent_fd: c.fd_t,
    leaf: []const u8,
) RemovalError!c.fd_t {
    if (!validLeafName(leaf)) return error.UnsafePath;
    const leaf_z = try stackZ(leaf);
    const fd = c.openat(
        parent_fd,
        &leaf_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (fd < 0) return error.IoFailure;
    return fd;
}

fn inspectPath(path: []const u8, _: ?c.dev_t) RemovalError!PathState {
    var parent = openParentNoFollow(path) catch |err| switch (err) {
        error.PathAbsent => return .absent,
        else => return err,
    };
    errdefer parent.close();
    const leaf_z = try stackZ(parent.leaf);
    var leaf_stat: c.Stat = undefined;
    const rc = c.fstatat(
        parent.fd,
        &leaf_z,
        &leaf_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    if (rc != 0) {
        if (c.errno(rc) == .NOENT) {
            parent.close();
            return .absent;
        }
        return error.IoFailure;
    }
    if (c.S.ISLNK(leaf_stat.mode)) return error.UnsafePath;
    const flags = c.O{
        .ACCMODE = .RDONLY,
        .CLOEXEC = true,
        .DIRECTORY = c.S.ISDIR(leaf_stat.mode),
        .NOFOLLOW = true,
    };
    const fd = c.openat(parent.fd, &leaf_z, flags);
    if (fd < 0) {
        return switch (c.errno(fd)) {
            .NOENT => error.OperationConflict,
            .LOOP, .NOTDIR => error.UnsafePath,
            else => error.IoFailure,
        };
    }
    errdefer _ = c.close(fd);
    var opened_stat: c.Stat = undefined;
    if (c.fstat(fd, &opened_stat) != 0 or
        opened_stat.dev != leaf_stat.dev or
        opened_stat.ino != leaf_stat.ino)
    {
        return error.OperationConflict;
    }
    return .{ .present = .{
        .fd = fd,
        .stat = opened_stat,
        .parent = parent,
    } };
}

fn openParentNoFollow(path: []const u8) RemovalError!PathParent {
    try validateNormalizedAbsolute(path);
    const leaf = std.fs.path.basename(path);
    if (!validLeafName(leaf)) return error.UnsafePath;
    const parent_path = std.fs.path.dirname(path) orelse return error.UnsafePath;
    var current = c.open(
        "/",
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (current < 0) return error.IoFailure;
    errdefer _ = c.close(current);

    var components = std.mem.tokenizeScalar(
        u8,
        std.mem.trimStart(u8, parent_path, "/"),
        '/',
    );
    while (components.next()) |component| {
        const component_z = try stackZ(component);
        const next = c.openat(
            current,
            &component_z,
            c.O{
                .ACCMODE = .RDONLY,
                .CLOEXEC = true,
                .DIRECTORY = true,
                .NOFOLLOW = true,
            },
        );
        if (next < 0) {
            return switch (c.errno(next)) {
                .NOENT => error.PathAbsent,
                .LOOP, .NOTDIR => error.UnsafePath,
                else => error.IoFailure,
            };
        }
        _ = c.close(current);
        current = next;
    }
    return .{ .fd = current, .leaf = leaf };
}

fn validateTreeDevice(
    io: Io,
    fd: c.fd_t,
    expected_device: c.dev_t,
) RemovalError!void {
    var root_stat: c.Stat = undefined;
    if (c.fstat(fd, &root_stat) != 0 or root_stat.dev != expected_device) {
        return error.CrossDeviceTarget;
    }
    var iterator = (Dir{ .handle = fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        const name_z = try stackZ(entry.name);
        var child_stat: c.Stat = undefined;
        if (c.fstatat(fd, &name_z, &child_stat, c.AT.SYMLINK_NOFOLLOW) != 0) {
            return error.OperationConflict;
        }
        if (child_stat.dev != expected_device) return error.CrossDeviceTarget;
        if (c.S.ISDIR(child_stat.mode)) {
            const child_fd = c.openat(
                fd,
                &name_z,
                c.O{
                    .ACCMODE = .RDONLY,
                    .CLOEXEC = true,
                    .DIRECTORY = true,
                    .NOFOLLOW = true,
                },
            );
            if (child_fd < 0) return error.UnsafePath;
            defer _ = c.close(child_fd);
            try validateTreeDevice(io, child_fd, expected_device);
        } else if (!c.S.ISREG(child_stat.mode) and
            !c.S.ISLNK(child_stat.mode))
        {
            return error.UnsafePath;
        }
    }
}

fn removeDirectoryContents(
    allocator: Allocator,
    io: Io,
    fd: c.fd_t,
    expected_device: c.dev_t,
) RemovalError!void {
    var root_stat: c.Stat = undefined;
    if (c.fstat(fd, &root_stat) != 0 or root_stat.dev != expected_device) {
        return error.CrossDeviceTarget;
    }
    var iterator = (Dir{ .handle = fd }).iterate();
    while (iterator.next(io) catch return error.IoFailure) |entry| {
        const name_z = try stackZ(entry.name);
        var child_stat: c.Stat = undefined;
        if (c.fstatat(fd, &name_z, &child_stat, c.AT.SYMLINK_NOFOLLOW) != 0) {
            return error.OperationConflict;
        }
        if (child_stat.dev != expected_device) return error.CrossDeviceTarget;
        if (c.S.ISDIR(child_stat.mode)) {
            const child_fd = c.openat(
                fd,
                &name_z,
                c.O{
                    .ACCMODE = .RDONLY,
                    .CLOEXEC = true,
                    .DIRECTORY = true,
                    .NOFOLLOW = true,
                },
            );
            if (child_fd < 0) return error.UnsafePath;
            defer _ = c.close(child_fd);
            var opened_stat: c.Stat = undefined;
            if (c.fstat(child_fd, &opened_stat) != 0 or
                opened_stat.dev != child_stat.dev or
                opened_stat.ino != child_stat.ino)
            {
                return error.OperationConflict;
            }
            try removeDirectoryContents(
                allocator,
                io,
                child_fd,
                expected_device,
            );
            if (c.unlinkat(fd, &name_z, c.AT.REMOVEDIR) != 0) {
                return error.IoFailure;
            }
        } else if (c.S.ISREG(child_stat.mode) or c.S.ISLNK(child_stat.mode)) {
            if (c.unlinkat(fd, &name_z, 0) != 0) return error.IoFailure;
        } else {
            return error.UnsafePath;
        }
    }
    try fsyncFd(fd);
}

fn fsyncFd(fd: c.fd_t) RemovalError!void {
    if (c.fsync(fd) != 0) return error.IoFailure;
}

fn rootsForCategory(
    roots: *const OwnedRoots,
    category: []const u8,
) []const []const u8 {
    if (std.mem.eql(u8, category, "control_plane")) {
        return roots.controlPlane;
    }
    if (std.mem.eql(u8, category, predecessor_codex_profile_category)) {
        return roots.kitchenCodexProfileData;
    }
    if (std.mem.eql(u8, category, "release_update_artifact")) {
        return roots.releaseUpdateArtifacts;
    }
    if (std.mem.eql(u8, category, "application_state")) {
        return roots.applicationState;
    }
    return roots.managedWorktrees;
}

fn validateOwnedPath(
    path: []const u8,
    helper_root: []const u8,
    home: []const u8,
) RemovalError!void {
    try validateNormalizedAbsolute(path);
    if (isBroadPath(path, home) or pathsOverlap(path, helper_root)) {
        return error.UnsafePath;
    }
}

fn validateNormalizedAbsolute(path: []const u8) RemovalError!void {
    if (path.len < 2 or
        path.len > std.posix.PATH_MAX or
        path[0] != '/' or
        path[path.len - 1] == '/' or
        std.mem.indexOfScalar(u8, path, 0) != null or
        std.mem.indexOf(u8, path, "//") != null)
    {
        return error.UnsafePath;
    }
    var components = std.mem.tokenizeScalar(u8, path[1..], '/');
    while (components.next()) |component| {
        if (component.len == 0 or
            std.mem.eql(u8, component, ".") or
            std.mem.eql(u8, component, ".."))
        {
            return error.UnsafePath;
        }
    }
}

fn isBroadPath(path: []const u8, home: []const u8) bool {
    if (std.mem.eql(u8, path, "/") or
        std.mem.eql(u8, path, "/Users") or
        std.mem.eql(u8, path, "/private") or
        std.mem.eql(u8, path, "/private/tmp") or
        std.mem.eql(u8, path, "/tmp") or
        std.mem.eql(u8, path, home) or
        std.mem.eql(u8, path, std.fs.path.dirname(home) orelse "") or
        equalsHomeSuffix(path, home, "/Library") or
        equalsHomeSuffix(path, home, "/Library/Application Support") or
        equalsHomeSuffix(path, home, "/Library/Caches"))
    {
        return true;
    }
    return false;
}

fn homeFromHelperRoot(helper_root: []const u8) ?[]const u8 {
    const application_support = std.fs.path.dirname(helper_root) orelse
        return null;
    if (!std.mem.eql(
        u8,
        std.fs.path.basename(application_support),
        "Application Support",
    )) return null;
    const library = std.fs.path.dirname(application_support) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(library), "Library")) {
        return null;
    }
    return std.fs.path.dirname(library);
}

fn equalsHomeSuffix(
    path: []const u8,
    home: []const u8,
    suffix: []const u8,
) bool {
    return path.len == home.len + suffix.len and
        std.mem.startsWith(u8, path, home) and
        std.mem.eql(u8, path[home.len..], suffix);
}

fn pathWithin(root: []const u8, candidate: []const u8) bool {
    if (std.mem.eql(u8, root, candidate)) return true;
    return candidate.len > root.len and
        std.mem.startsWith(u8, candidate, root) and
        candidate[root.len] == '/';
}

fn pathsOverlap(left: []const u8, right: []const u8) bool {
    return pathWithin(left, right) or pathWithin(right, left);
}

fn isDirectChild(parent: []const u8, child: []const u8) bool {
    return child.len > parent.len + 1 and
        std.mem.startsWith(u8, child, parent) and
        child[parent.len] == '/' and
        std.mem.indexOfScalar(u8, child[parent.len + 1 ..], '/') == null;
}

fn validLeafName(value: []const u8) bool {
    return value.len > 0 and
        !std.mem.eql(u8, value, ".") and
        !std.mem.eql(u8, value, "..") and
        std.mem.indexOfScalar(u8, value, '/') == null and
        std.mem.indexOfScalar(u8, value, 0) == null;
}

fn joinDirect(
    allocator: Allocator,
    parent: []const u8,
    leaf: []const u8,
) RemovalError![]u8 {
    if (!validLeafName(leaf)) return error.UnsafePath;
    return std.fs.path.join(allocator, &.{ parent, leaf }) catch
        return error.OutOfMemory;
}

fn effectiveHome(allocator: Allocator) RemovalError![]u8 {
    var passwd: c.passwd = undefined;
    var buffer: [16 * 1024]u8 = undefined;
    var result: ?*c.passwd = null;
    if (c.getpwuid_r(
        c.geteuid(),
        &passwd,
        &buffer,
        buffer.len,
        &result,
    ) != 0 or result == null or passwd.dir == null) {
        return error.IoFailure;
    }
    const home = std.mem.span(passwd.dir.?);
    try validateNormalizedAbsolute(home);
    return allocator.dupe(u8, home) catch return error.OutOfMemory;
}

fn validOperationId(value: []const u8) bool {
    if (!std.mem.startsWith(u8, value, "op_") or
        value.len < "op".len + 8 or value.len > 96)
    {
        return false;
    }
    for (value[3..]) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '_' and byte != '-') {
            return false;
        }
    }
    return true;
}

fn validAccountProfileId(value: []const u8) bool {
    if (!std.mem.startsWith(u8, value, "acct_") or
        value.len < "acct_".len + 7 or
        value.len > 96)
    {
        return false;
    }
    for (value["acct_".len..]) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '_' and byte != '-') {
            return false;
        }
    }
    return true;
}

fn validPreviewId(value: []const u8) bool {
    if (!std.mem.startsWith(u8, value, "removal_") or
        value.len < "removal".len + 8 or value.len > 96)
    {
        return false;
    }
    for (value["removal_".len..]) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and byte != '_' and byte != '-') {
            return false;
        }
    }
    return true;
}

test "removal helper IDs match the public exact lower bound" {
    try std.testing.expect(validOperationId("op_1234567"));
    try std.testing.expect(!validOperationId("op_123456"));
    try std.testing.expect(validAccountProfileId("acct_1234567"));
    try std.testing.expect(!validAccountProfileId("acct_123456"));
    try std.testing.expect(validPreviewId("removal_1234567"));
    try std.testing.expect(!validPreviewId("removal_123456"));
}

fn validPrefixedHex(
    value: []const u8,
    prefix: []const u8,
    digits: usize,
) bool {
    if (value.len != prefix.len + digits or
        !std.mem.startsWith(u8, value, prefix))
    {
        return false;
    }
    for (value[prefix.len..]) |byte| {
        if (!std.ascii.isHex(byte) or std.ascii.isUpper(byte)) return false;
    }
    return true;
}

fn decodePrefixedHex(
    output: []u8,
    value: []const u8,
    prefix: []const u8,
) !void {
    if (!validPrefixedHex(value, prefix, output.len * 2)) {
        return error.InvalidHex;
    }
    _ = try std.fmt.hexToBytes(output, value[prefix.len..]);
}

fn constantTimeStringEqual(left: []const u8, right: []const u8) bool {
    if (left.len != right.len) return false;
    var difference: u8 = 0;
    for (left, right) |a, b| difference |= a ^ b;
    return difference == 0;
}

fn stackZ(value: []const u8) RemovalError![std.posix.PATH_MAX:0]u8 {
    if (value.len >= std.posix.PATH_MAX or
        std.mem.indexOfScalar(u8, value, 0) != null)
    {
        return error.UnsafePath;
    }
    var output: [std.posix.PATH_MAX:0]u8 = @splat(0);
    @memcpy(output[0..value.len], value);
    return output;
}

fn exitCode(err: anyerror) u8 {
    return switch (err) {
        error.InvalidArguments => 64,
        error.InvalidRequest,
        error.InvalidSignature,
        error.UnsafePath,
        error.DirtyWorktreeNeedsAcknowledgement,
        error.ExpiredRequest,
        error.InvalidReceipt,
        error.OperationConflict,
        error.CrossDeviceTarget,
        => 65,
        error.InvalidParent,
        error.ParentWaitFailure,
        error.LifecycleFailure,
        error.ActiveOperation,
        => 75,
        else => 70,
    };
}

fn writeFailure(io: Io, err: anyerror) void {
    const message = switch (exitCode(err)) {
        64 => "invalid local-data removal helper invocation\n",
        65 => "local-data removal request was rejected\n",
        75 => "local-data removal lifecycle is unavailable\n",
        else => "local-data removal helper failed\n",
    };
    var buffer: [256]u8 = undefined;
    var writer = File.stderr().writer(io, &buffer);
    writer.interface.writeAll(message) catch {};
    writer.interface.flush() catch {};
}

const TestAccountProfile = struct {
    accounts_fd: c.fd_t,
    codex_fd: c.fd_t,
    home_fd: c.fd_t,
    profile_fd: c.fd_t,
    runtime_fd: c.fd_t,

    fn close(self: *TestAccountProfile) void {
        _ = c.close(self.runtime_fd);
        _ = c.close(self.home_fd);
        _ = c.close(self.profile_fd);
        _ = c.close(self.accounts_fd);
        _ = c.close(self.codex_fd);
        self.* = undefined;
    }
};

fn createTestStateRoot(
    io: Io,
    root_fd: c.fd_t,
    name: []const u8,
) !c.fd_t {
    var root_stat: c.Stat = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.fstat(root_fd, &root_stat));
    const state_fd = try ensurePrivateDirectDirectory(
        root_fd,
        name,
        root_stat.dev,
    );
    errdefer _ = c.close(state_fd);
    try writeNewPrivateDirectFile(
        io,
        state_fd,
        control_plane_file_name,
        "sqlite fixture",
        true,
    );
    try writeNewPrivateDirectFile(
        io,
        state_fd,
        operation_receipt_key_file_name,
        test_operation_receipt_key,
        false,
    );
    return state_fd;
}

const test_operation_receipt_key = "0123456789abcdef0123456789abcdef"; // gitleaks:allow - deterministic test vector
const test_deletion_nonce =
    "deletion_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn testAccountProfileAuthority(
    state_fd: c.fd_t,
) !AccountProfileAuthority {
    var state_stat: c.Stat = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.fstat(state_fd, &state_stat));
    const control_plane_z = try stackZ(control_plane_file_name);
    var control_plane_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstatat(
            state_fd,
            &control_plane_z,
            &control_plane_stat,
            c.AT.SYMLINK_NOFOLLOW,
        ),
    );
    return .{
        .state_root_device = statDevice(state_stat),
        .state_root_inode = statInode(state_stat),
        .control_plane_device = statDevice(control_plane_stat),
        .control_plane_inode = statInode(control_plane_stat),
    };
}

fn testAccountDeletionNonce(
    allocator: Allocator,
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    authority: AccountProfileAuthority,
    expected_revision: u64,
) ![]u8 {
    return accountDeletionNonce(
        allocator,
        test_operation_receipt_key,
        control_plane_path,
        account_profile_id,
        authority,
        expected_revision,
    );
}

fn createTestAccountProfile(
    state_fd: c.fd_t,
    account_profile_id: []const u8,
) !TestAccountProfile {
    var state_stat: c.Stat = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.fstat(state_fd, &state_stat));
    const codex_fd = try ensurePrivateDirectDirectory(
        state_fd,
        account_codex_directory_name,
        state_stat.dev,
    );
    errdefer _ = c.close(codex_fd);
    const accounts_fd = try ensurePrivateDirectDirectory(
        codex_fd,
        account_profiles_directory_name,
        state_stat.dev,
    );
    errdefer _ = c.close(accounts_fd);
    const profile_fd = try ensurePrivateDirectDirectory(
        accounts_fd,
        account_profile_id,
        state_stat.dev,
    );
    errdefer _ = c.close(profile_fd);
    const home_fd = try ensurePrivateDirectDirectory(
        profile_fd,
        account_home_directory_name,
        state_stat.dev,
    );
    errdefer _ = c.close(home_fd);
    const runtime_fd = try ensurePrivateDirectDirectory(
        profile_fd,
        "runtime",
        state_stat.dev,
    );
    return .{
        .accounts_fd = accounts_fd,
        .codex_fd = codex_fd,
        .home_fd = home_fd,
        .profile_fd = profile_fd,
        .runtime_fd = runtime_fd,
    };
}

fn replacePublishedDirectoryForRepairTest(
    parent_fd: c.fd_t,
    leaf: []const u8,
) void {
    const leaf_z = stackZ(leaf) catch @panic("invalid repair-test leaf");
    const displaced_z = stackZ("displaced") catch
        @panic("invalid repair-test displacement");
    if (c.renameat(
        parent_fd,
        &leaf_z,
        parent_fd,
        &displaced_z,
    ) != 0) @panic("repair-test rename failed");
    if (c.mkdirat(parent_fd, &leaf_z, 0o755) != 0) {
        @panic("repair-test replacement failed");
    }
    const replacement_fd = c.openat(
        parent_fd,
        &leaf_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    if (replacement_fd < 0) @panic("repair-test replacement open failed");
    defer _ = c.close(replacement_fd);
    if (c.fchmod(replacement_fd, 0o755) != 0) {
        @panic("repair-test replacement chmod failed");
    }
}

test "delete-account-home CLI is exact and validates both authorities" {
    const valid_args = [_][*:0]const u8{
        "delete-account-home",
        "--control-plane-path",
        "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite",
        "--account-profile-id",
        "acct_fixture01",
        "--state-root-device",
        "1",
        "--state-root-inode",
        "2",
        "--control-plane-device",
        "1",
        "--control-plane-inode",
        "3",
        "--deletion-nonce",
        test_deletion_nonce,
        "--expected-revision",
        "7",
    };
    var valid_iterator = std.process.Args.Iterator.init(.{
        .vector = &valid_args,
    });
    const parsed = try parseCli(&valid_iterator);
    switch (parsed) {
        .delete_account_home => |options| {
            try std.testing.expectEqualStrings(
                "acct_fixture01",
                options.account_profile_id,
            );
            try std.testing.expectEqualStrings(
                "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite",
                options.control_plane_path,
            );
            try std.testing.expectEqual(@as(u64, 7), options.expected_revision);
            try std.testing.expectEqualStrings(
                test_deletion_nonce,
                options.deletion_nonce.?,
            );
        },
        else => return error.ExpectedDeleteAccountHomeCommand,
    }

    const duplicate_args = [_][*:0]const u8{
        "delete-account-home",
        "--control-plane-path",
        "/private/state/control-plane.sqlite",
        "--control-plane-path",
        "/private/other/control-plane.sqlite",
        "--account-profile-id",
        "acct_fixture01",
    };
    var duplicate_iterator = std.process.Args.Iterator.init(.{
        .vector = &duplicate_args,
    });
    try std.testing.expectError(
        error.InvalidArguments,
        parseCli(&duplicate_iterator),
    );

    const traversal_args = [_][*:0]const u8{
        "delete-account-home",
        "--control-plane-path",
        "/private/state/../control-plane.sqlite",
        "--account-profile-id",
        "acct_fixture01",
    };
    var traversal_iterator = std.process.Args.Iterator.init(.{
        .vector = &traversal_args,
    });
    try std.testing.expectError(
        error.InvalidArguments,
        parseCli(&traversal_iterator),
    );

    const invalid_account_args = [_][*:0]const u8{
        "delete-account-home",
        "--control-plane-path",
        "/private/state/control-plane.sqlite",
        "--account-profile-id",
        "acct_../../victim",
    };
    var invalid_account_iterator = std.process.Args.Iterator.init(.{
        .vector = &invalid_account_args,
    });
    try std.testing.expectError(
        error.InvalidArguments,
        parseCli(&invalid_account_iterator),
    );

    const unexpected_args = [_][*:0]const u8{
        "delete-account-home",
        "--control-plane-path",
        "/private/state/control-plane.sqlite",
        "--account-profile-id",
        "acct_fixture01",
        "--recursive",
    };
    var unexpected_iterator = std.process.Args.Iterator.init(.{
        .vector = &unexpected_args,
    });
    try std.testing.expectError(
        error.InvalidArguments,
        parseCli(&unexpected_iterator),
    );

    const broad_args = [_][*:0]const u8{
        "delete-account-home",
        "--control-plane-path",
        "/control-plane.sqlite",
        "--account-profile-id",
        "acct_fixture01",
    };
    var broad_iterator = std.process.Args.Iterator.init(.{
        .vector = &broad_args,
    });
    try std.testing.expectError(
        error.InvalidArguments,
        parseCli(&broad_iterator),
    );
}

test "account deletion HMAC transcript matches the gateway vector" {
    const nonce = try accountDeletionNonce(
        std.testing.allocator,
        test_operation_receipt_key,
        "/Users/example/Library/Application Support/OPRTE/control-plane.sqlite",
        "acct_fixture01",
        .{
            .state_root_device = 1,
            .state_root_inode = 2,
            .control_plane_device = 1,
            .control_plane_inode = 3,
        },
        7,
    );
    defer std.testing.allocator.free(nonce);
    try std.testing.expectEqualStrings(
        "deletion_b8c57f52ad5424f0241f132382335a9ecddf89b01b316b5b23e0092c6861ecac",
        nonce,
    );
}

test "descriptor repair rejects a published replacement without chmodding it" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var parent_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(temporary.dir.handle, &parent_stat),
    );
    const victim_z = try stackZ("victim");
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.mkdirat(temporary.dir.handle, &victim_z, 0o755),
    );
    const victim_fd = c.openat(
        temporary.dir.handle,
        &victim_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    try std.testing.expect(victim_fd >= 0);
    try std.testing.expectEqual(@as(c_int, 0), c.fchmod(victim_fd, 0o755));
    _ = c.close(victim_fd);
    try std.testing.expectError(
        error.OperationConflict,
        repairPrivateDirectDirectoryWithHook(
            temporary.dir.handle,
            "victim",
            parent_stat.dev,
            replacePublishedDirectoryForRepairTest,
        ),
    );
    const replacement_fd = c.openat(
        temporary.dir.handle,
        &victim_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    try std.testing.expect(replacement_fd >= 0);
    defer _ = c.close(replacement_fd);
    var replacement_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(replacement_fd, &replacement_stat),
    );
    try std.testing.expectEqual(
        @as(c.mode_t, 0o755),
        replacement_stat.mode & 0o777,
    );
}

test "account profile ensure creates and repairs only no-follow directories" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const state_fd = try createTestStateRoot(
        io,
        temporary.dir.handle,
        "state",
    );
    defer _ = c.close(state_fd);
    var state_stat: c.Stat = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.fstat(state_fd, &state_stat));
    const codex_z = try stackZ(account_codex_directory_name);
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.mkdirat(state_fd, &codex_z, 0o755),
    );
    const codex_fd = c.openat(
        state_fd,
        &codex_z,
        c.O{
            .ACCMODE = .RDONLY,
            .CLOEXEC = true,
            .DIRECTORY = true,
            .NOFOLLOW = true,
        },
    );
    try std.testing.expect(codex_fd >= 0);
    try std.testing.expectEqual(@as(c_int, 0), c.fchmod(codex_fd, 0o755));
    _ = c.close(codex_fd);
    const control_plane_path = try temporary.dir.realPathFileAlloc(
        io,
        "state/control-plane.sqlite",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(control_plane_path);
    const authority = try testAccountProfileAuthority(state_fd);
    try ensureAccountProfile(
        control_plane_path,
        "acct_fixture01",
        authority,
    );
    const repaired_codex = (try openOptionalPrivateDirectDirectory(
        state_fd,
        account_codex_directory_name,
        state_stat.dev,
    )).?;
    defer _ = c.close(repaired_codex);
    const accounts_fd = (try openOptionalPrivateDirectDirectory(
        repaired_codex,
        account_profiles_directory_name,
        state_stat.dev,
    )).?;
    defer _ = c.close(accounts_fd);
    const profile_fd = (try openOptionalPrivateDirectDirectory(
        accounts_fd,
        "acct_fixture01",
        state_stat.dev,
    )).?;
    defer _ = c.close(profile_fd);
    const home_fd = (try openOptionalPrivateDirectDirectory(
        profile_fd,
        account_home_directory_name,
        state_stat.dev,
    )).?;
    _ = c.close(home_fd);
    const runtime_fd = (try openOptionalPrivateDirectDirectory(
        profile_fd,
        account_runtime_directory_name,
        state_stat.dev,
    )).?;
    _ = c.close(runtime_fd);
}

test "account deletion rejects missing hierarchy without a durable receipt" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const state_fd = try createTestStateRoot(
        io,
        temporary.dir.handle,
        "state",
    );
    defer _ = c.close(state_fd);
    const control_plane_path = try temporary.dir.realPathFileAlloc(
        io,
        "state/control-plane.sqlite",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(control_plane_path);
    const authority = try testAccountProfileAuthority(state_fd);
    const deletion_nonce = try testAccountDeletionNonce(
        std.testing.allocator,
        control_plane_path,
        "acct_fixture01",
        authority,
        1,
    );
    defer std.testing.allocator.free(deletion_nonce);
    try std.testing.expectError(
        error.PathAbsent,
        deleteAccountHome(
            std.testing.allocator,
            io,
            control_plane_path,
            "acct_fixture01",
            authority,
            deletion_nonce,
            1,
        ),
    );
}

test "account home deletion preserves runtime sibling profiles and symlink targets" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const state_fd = try createTestStateRoot(
        io,
        temporary.dir.handle,
        "state",
    );
    defer _ = c.close(state_fd);
    var work = try createTestAccountProfile(state_fd, "acct_work0001");
    defer work.close();
    var personal = try createTestAccountProfile(
        state_fd,
        "acct_personal1",
    );
    defer personal.close();

    try writeNewPrivateDirectFile(
        io,
        work.home_fd,
        "auth.json",
        "work credentials",
        true,
    );
    var work_home_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(work.home_fd, &work_home_stat),
    );
    const sessions_fd = try ensurePrivateDirectDirectory(
        work.home_fd,
        "sessions",
        work_home_stat.dev,
    );
    try writeNewPrivateDirectFile(
        io,
        sessions_fd,
        "session.jsonl",
        "private transcript",
        true,
    );
    _ = c.close(sessions_fd);
    try writeNewPrivateDirectFile(
        io,
        work.runtime_fd,
        "generation",
        "7",
        true,
    );
    try writeNewPrivateDirectFile(
        io,
        personal.home_fd,
        "auth.json",
        "personal credentials",
        true,
    );
    try writeNewPrivateDirectFile(
        io,
        temporary.dir.handle,
        "outside-secret",
        "must survive",
        true,
    );
    const outside_path = try temporary.dir.realPathFileAlloc(
        io,
        "outside-secret",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(outside_path);
    try temporary.dir.symLink(
        io,
        outside_path,
        "state/codex/accounts/acct_work0001/home/external-link",
        .{},
    );
    const control_plane_path = try temporary.dir.realPathFileAlloc(
        io,
        "state/control-plane.sqlite",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(control_plane_path);
    const authority = try testAccountProfileAuthority(state_fd);
    const deletion_nonce = try testAccountDeletionNonce(
        std.testing.allocator,
        control_plane_path,
        "acct_work0001",
        authority,
        7,
    );
    defer std.testing.allocator.free(deletion_nonce);

    try std.testing.expectError(
        error.InvalidSignature,
        deleteAccountHome(
            std.testing.allocator,
            io,
            control_plane_path,
            "acct_work0001",
            authority,
            test_deletion_nonce,
            7,
        ),
    );
    const retained_before_authorization = try readDirectPrivateFile(
        std.testing.allocator,
        io,
        work.home_fd,
        "auth.json",
        64,
        null,
    );
    defer std.testing.allocator.free(retained_before_authorization);
    try std.testing.expectEqualStrings(
        "work credentials\n",
        retained_before_authorization,
    );

    try deleteAccountHome(
        std.testing.allocator,
        io,
        control_plane_path,
        "acct_work0001",
        authority,
        deletion_nonce,
        7,
    );
    const home_z = try stackZ(account_home_directory_name);
    var missing: c.Stat = undefined;
    const home_status = c.fstatat(
        work.profile_fd,
        &home_z,
        &missing,
        c.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expect(home_status != 0);
    try std.testing.expectEqual(c.E.NOENT, c.errno(home_status));

    var runtime_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(work.runtime_fd, &runtime_stat),
    );
    try directChildMatchesIdentity(
        work.profile_fd,
        "runtime",
        runtime_stat,
    );
    const personal_auth = try readDirectPrivateFile(
        std.testing.allocator,
        io,
        personal.home_fd,
        "auth.json",
        64,
        null,
    );
    defer std.testing.allocator.free(personal_auth);
    try std.testing.expectEqualStrings(
        "personal credentials\n",
        personal_auth,
    );
    const outside = try readDirectPrivateFile(
        std.testing.allocator,
        io,
        temporary.dir.handle,
        "outside-secret",
        64,
        null,
    );
    defer std.testing.allocator.free(outside);
    try std.testing.expectEqualStrings("must survive\n", outside);

    // The exact durable request is an idempotent retry.
    try deleteAccountHome(
        std.testing.allocator,
        io,
        control_plane_path,
        "acct_work0001",
        authority,
        deletion_nonce,
        7,
    );
    const conflicting_nonce = try testAccountDeletionNonce(
        std.testing.allocator,
        control_plane_path,
        "acct_work0001",
        authority,
        8,
    );
    defer std.testing.allocator.free(conflicting_nonce);
    try std.testing.expectError(
        error.InvalidReceipt,
        deleteAccountHome(
            std.testing.allocator,
            io,
            control_plane_path,
            "acct_work0001",
            authority,
            conflicting_nonce,
            8,
        ),
    );
}

test "account home deletion rejects special files before mutation" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const state_fd = try createTestStateRoot(
        io,
        temporary.dir.handle,
        "state",
    );
    defer _ = c.close(state_fd);
    var profile = try createTestAccountProfile(
        state_fd,
        "acct_fixture01",
    );
    defer profile.close();
    try writeNewPrivateDirectFile(
        io,
        profile.home_fd,
        "auth.json",
        "must remain",
        true,
    );
    const fifo_z = try stackZ("unexpected.fifo");
    try std.testing.expectEqual(
        @as(c_int, 0),
        mkfifoat(profile.home_fd, &fifo_z, private_file_mode),
    );
    const control_plane_path = try temporary.dir.realPathFileAlloc(
        io,
        "state/control-plane.sqlite",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(control_plane_path);
    const authority = try testAccountProfileAuthority(state_fd);
    const deletion_nonce = try testAccountDeletionNonce(
        std.testing.allocator,
        control_plane_path,
        "acct_fixture01",
        authority,
        3,
    );
    defer std.testing.allocator.free(deletion_nonce);
    try std.testing.expectError(
        error.UnsafePath,
        deleteAccountHome(
            std.testing.allocator,
            io,
            control_plane_path,
            "acct_fixture01",
            authority,
            deletion_nonce,
            3,
        ),
    );
    const retained_auth = try readDirectPrivateFile(
        std.testing.allocator,
        io,
        profile.home_fd,
        "auth.json",
        64,
        null,
    );
    defer std.testing.allocator.free(retained_auth);
    try std.testing.expectEqualStrings("must remain\n", retained_auth);
    var home_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(profile.home_fd, &home_stat),
    );
    try std.testing.expectError(
        error.CrossDeviceTarget,
        validateAccountHomeTree(io, profile.home_fd, home_stat.dev + 1),
    );
}

test "account home deletion rejects a symlink home without touching its target" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const state_fd = try createTestStateRoot(
        io,
        temporary.dir.handle,
        "state",
    );
    defer _ = c.close(state_fd);
    var profile = try createTestAccountProfile(
        state_fd,
        "acct_fixture01",
    );
    defer profile.close();
    _ = c.close(profile.home_fd);
    profile.home_fd = -1;
    const home_z = try stackZ(account_home_directory_name);
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.unlinkat(profile.profile_fd, &home_z, c.AT.REMOVEDIR),
    );
    try writeNewPrivateDirectFile(
        io,
        temporary.dir.handle,
        "outside-secret",
        "still outside",
        true,
    );
    const outside_path = try temporary.dir.realPathFileAlloc(
        io,
        "outside-secret",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(outside_path);
    try temporary.dir.symLink(
        io,
        outside_path,
        "state/codex/accounts/acct_fixture01/home",
        .{ .is_directory = true },
    );
    const control_plane_path = try temporary.dir.realPathFileAlloc(
        io,
        "state/control-plane.sqlite",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(control_plane_path);
    const authority = try testAccountProfileAuthority(state_fd);
    const deletion_nonce = try testAccountDeletionNonce(
        std.testing.allocator,
        control_plane_path,
        "acct_fixture01",
        authority,
        3,
    );
    defer std.testing.allocator.free(deletion_nonce);

    try std.testing.expectError(
        error.UnsafePath,
        deleteAccountHome(
            std.testing.allocator,
            io,
            control_plane_path,
            "acct_fixture01",
            authority,
            deletion_nonce,
            3,
        ),
    );
    const outside = try readDirectPrivateFile(
        std.testing.allocator,
        io,
        temporary.dir.handle,
        "outside-secret",
        64,
        null,
    );
    defer std.testing.allocator.free(outside);
    try std.testing.expectEqualStrings("still outside\n", outside);
}

test "a metadata-valid decoy state root cannot authorize deletion" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const state_fd = try createTestStateRoot(
        io,
        temporary.dir.handle,
        "state",
    );
    defer _ = c.close(state_fd);
    var profile = try createTestAccountProfile(
        state_fd,
        "acct_fixture01",
    );
    defer profile.close();
    try writeNewPrivateDirectFile(
        io,
        profile.home_fd,
        "auth.json",
        "anchored secret",
        true,
    );
    const control_plane_path = try temporary.dir.realPathFileAlloc(
        io,
        "state/control-plane.sqlite",
        std.testing.allocator,
    );
    defer std.testing.allocator.free(control_plane_path);
    const authority = try testAccountProfileAuthority(state_fd);
    const deletion_nonce = try testAccountDeletionNonce(
        std.testing.allocator,
        control_plane_path,
        "acct_fixture01",
        authority,
        9,
    );
    defer std.testing.allocator.free(deletion_nonce);
    const state_z = try stackZ("state");
    const displaced_z = try stackZ("displaced-state");
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.renameat(
            temporary.dir.handle,
            &state_z,
            temporary.dir.handle,
            &displaced_z,
        ),
    );

    const decoy_state_fd = try createTestStateRoot(
        io,
        temporary.dir.handle,
        "state",
    );
    defer _ = c.close(decoy_state_fd);
    var decoy_profile = try createTestAccountProfile(
        decoy_state_fd,
        "acct_fixture01",
    );
    defer decoy_profile.close();
    try writeNewPrivateDirectFile(
        io,
        decoy_profile.home_fd,
        "auth.json",
        "decoy must survive",
        true,
    );

    try std.testing.expectError(
        error.UnsafePath,
        deleteAccountHome(
            std.testing.allocator,
            io,
            control_plane_path,
            "acct_fixture01",
            authority,
            deletion_nonce,
            9,
        ),
    );
    const anchored_auth = try readDirectPrivateFile(
        std.testing.allocator,
        io,
        profile.home_fd,
        "auth.json",
        64,
        null,
    );
    defer std.testing.allocator.free(anchored_auth);
    try std.testing.expectEqualStrings("anchored secret\n", anchored_auth);
    const decoy_auth = try readDirectPrivateFile(
        std.testing.allocator,
        io,
        decoy_profile.home_fd,
        "auth.json",
        64,
        null,
    );
    defer std.testing.allocator.free(decoy_auth);
    try std.testing.expectEqualStrings(
        "decoy must survive\n",
        decoy_auth,
    );
}

test "canonical payload order matches the TypeScript signer" {
    const roots = OwnedRoots{
        .applicationState = &.{"/Users/example/Library/State"},
        .controlPlane = &.{"/Users/example/Library/Control"},
        .helperStateRoot = "/Users/example/Library/Removal",
        .kitchenCodexProfileData = &.{"/Users/example/Library/Codex"},
        .managedWorktrees = &.{"/Users/example/Library/Worktrees"},
        .releaseUpdateArtifacts = &.{"/Users/example/Library/Updates"},
    };
    const payload = Payload{
        .acknowledgeDirtyWorktrees = false,
        .allowlistDigest = "sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .exclusionPath = "/Users/example/Library/.removal",
        .executionLockPath = "/Users/example/Library/Removal/execution.lock",
        .expiresAt = 2,
        .helperStateRoot = roots.helperStateRoot,
        .inventoryDigest = "sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        .issuedAt = 1,
        .kind = request_kind,
        .operationId = "op_example",
        .ownedRoots = roots,
        .parentProcessId = 22,
        .preservedUserRepositories = &.{"/Users/example/repository"},
        .previewId = "removal_example",
        .receiptPath = "/Users/example/Library/Removal/helper-receipts/op_example.json",
        .stageRoot = "/Users/example/Library/Removal/staging/op_example",
        .targets = &.{},
        .version = 1,
        .waitForParentExit = true,
    };
    const encoded = try canonicalJson(std.testing.allocator, payload);
    defer std.testing.allocator.free(encoded);
    try std.testing.expect(std.mem.startsWith(
        u8,
        encoded,
        "{\"acknowledgeDirtyWorktrees\":false,\"allowlistDigest\":",
    ));
    try std.testing.expect(std.mem.endsWith(
        u8,
        encoded,
        "\"version\":1,\"waitForParentExit\":true}",
    ));
}

test "normalized paths reject traversal, aliases, and broad roots" {
    try std.testing.expectError(
        error.UnsafePath,
        validateNormalizedAbsolute("/Users/example/../victim"),
    );
    try std.testing.expectError(
        error.UnsafePath,
        validateNormalizedAbsolute("/Users//example/victim"),
    );
    try std.testing.expect(isBroadPath(
        "/Users/example",
        "/Users/example",
    ));
    try std.testing.expect(!isBroadPath(
        "/Users/example/Library/Application Support/OPRTE",
        "/Users/example",
    ));
    try std.testing.expect(!isBroadPath(
        "/Users/example/repository",
        "/Users/example",
    ));
    try std.testing.expect(!isBroadPath(
        "/Volumes/External/repository",
        "/Users/example",
    ));
}

test "path containment is component bounded" {
    try std.testing.expect(pathWithin(
        "/Users/example/owned",
        "/Users/example/owned/child",
    ));
    try std.testing.expect(!pathWithin(
        "/Users/example/owned",
        "/Users/example/owned-sibling",
    ));
    try std.testing.expect(isDirectChild(
        "/Users/example/owned",
        "/Users/example/owned/child",
    ));
    try std.testing.expect(!isDirectChild(
        "/Users/example/owned",
        "/Users/example/owned/child/grandchild",
    ));
}

test "owned root lists admit the fixed inventory while remaining bounded" {
    try std.testing.expect(validOwnedRootCount(1));
    try std.testing.expect(validOwnedRootCount(64));
    try std.testing.expect(!validOwnedRootCount(0));
    try std.testing.expect(!validOwnedRootCount(65));
}

test "signature comparison rejects tampering" {
    const left = "hmac_sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const right = "hmac_sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
    try std.testing.expect(constantTimeStringEqual(left, left));
    try std.testing.expect(!constantTimeStringEqual(left, right));
}

test "canonical JSON and HMAC match the TypeScript Unicode golden" {
    const roots = OwnedRoots{
        .applicationState = &.{"/Users/example/Library/状态/é"},
        .controlPlane = &.{"/Users/example/Library/e\u{301}/\"quoted\"\nline"},
        .helperStateRoot = "/Users/example/Library/Application Support/OPRTE Removal",
        .kitchenCodexProfileData = &.{"/Users/example/Library/Codex/雪"},
        .managedWorktrees = &.{"/Users/example/Library/Worktrees"},
        .releaseUpdateArtifacts = &.{"/Users/example/Library/Caches/🚀"},
    };
    const targets = [_]Target{.{
        .category = "application_state",
        .id = "target_11111111111111111111111111111111",
        .kind = "directory",
        .path = "/Users/example/Library/状态/é",
    }};
    const payload = Payload{
        .acknowledgeDirtyWorktrees = false,
        .allowlistDigest = "sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        .exclusionPath = "/Users/example/Library/Application Support/.OPRTE Removal.removal-in-progress",
        .executionLockPath = "/Users/example/Library/Application Support/OPRTE Removal/execution.lock",
        .expiresAt = 2000,
        .helperStateRoot = roots.helperStateRoot,
        .inventoryDigest = "sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        .issuedAt = 1000,
        .kind = request_kind,
        .operationId = "op_unicode01",
        .ownedRoots = roots,
        .parentProcessId = 4242,
        .preservedUserRepositories = &.{"/Users/example/Repos/café"},
        .previewId = "removal_unicode01",
        .receiptPath = "/Users/example/Library/Application Support/OPRTE Removal/helper-receipts/op_unicode01.json",
        .stageRoot = "/Users/example/Library/Application Support/OPRTE Removal/staging/op_unicode01",
        .targets = &targets,
        .version = 1,
        .waitForParentExit = true,
    };
    const expected_canonical = "{\"acknowledgeDirtyWorktrees\":false,\"allowlistDigest\":\"sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"exclusionPath\":\"/Users/example/Library/Application Support/.OPRTE Removal.removal-in-progress\",\"executionLockPath\":\"/Users/example/Library/Application Support/OPRTE Removal/execution.lock\",\"expiresAt\":2000,\"helperStateRoot\":\"/Users/example/Library/Application Support/OPRTE Removal\",\"inventoryDigest\":\"sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"issuedAt\":1000,\"kind\":\"hraness-kitchen-local-data-removal\",\"operationId\":\"op_unicode01\",\"ownedRoots\":{\"applicationState\":[\"/Users/example/Library/状态/é\"],\"controlPlane\":[\"/Users/example/Library/é/\\\"quoted\\\"\\nline\"],\"helperStateRoot\":\"/Users/example/Library/Application Support/OPRTE Removal\",\"kitchenCodexProfileData\":[\"/Users/example/Library/Codex/雪\"],\"managedWorktrees\":[\"/Users/example/Library/Worktrees\"],\"releaseUpdateArtifacts\":[\"/Users/example/Library/Caches/🚀\"]},\"parentProcessId\":4242,\"preservedUserRepositories\":[\"/Users/example/Repos/café\"],\"previewId\":\"removal_unicode01\",\"receiptPath\":\"/Users/example/Library/Application Support/OPRTE Removal/helper-receipts/op_unicode01.json\",\"stageRoot\":\"/Users/example/Library/Application Support/OPRTE Removal/staging/op_unicode01\",\"targets\":[{\"category\":\"application_state\",\"id\":\"target_11111111111111111111111111111111\",\"kind\":\"directory\",\"path\":\"/Users/example/Library/状态/é\"}],\"version\":1,\"waitForParentExit\":true}";
    const canonical = try canonicalJson(std.testing.allocator, payload);
    defer std.testing.allocator.free(canonical);
    try std.testing.expectEqualStrings(expected_canonical, canonical);

    const key: [32]u8 = @splat(0x5a);
    var digest: [32]u8 = undefined;
    std.crypto.auth.hmac.sha2.HmacSha256.create(&digest, canonical, &key);
    var observed: [64]u8 = undefined;
    _ = try std.fmt.bufPrint(&observed, "{x}", .{digest});
    try std.testing.expectEqualStrings(
        "e5d8815773d609d7176bbbc027239f1af79a823b0093ad6bda3133d7ed2b4cc8",
        &observed,
    );
}

test "nonblocking recovery lock probe distinguishes an active helper" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    var first = try temporary.dir.createFile(io, "execution.lock", .{
        .permissions = File.Permissions.fromMode(private_file_mode),
    });
    defer first.close(io);
    var second = try temporary.dir.openFile(io, "execution.lock", .{
        .mode = .read_write,
        .follow_symlinks = false,
    });
    defer second.close(io);

    try acquireExclusiveLock(first.handle);
    try std.testing.expectError(
        error.ActiveOperation,
        acquireExclusiveLock(second.handle),
    );
}

test "signed request limit is inclusive at exactly 64 MiB" {
    try std.testing.expectEqual(
        @as(usize, 64 * 1024 * 1024),
        maximum_request_bytes,
    );
    try std.testing.expect(requestByteLengthAllowed(
        maximum_request_bytes,
        maximum_request_bytes,
    ));
    try std.testing.expect(!requestByteLengthAllowed(
        maximum_request_bytes + 1,
        maximum_request_bytes,
    ));
}

test "READY signal is exact and one way over an inherited pipe" {
    var descriptors: [2]c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.pipe(&descriptors));
    defer _ = c.close(descriptors[0]);
    defer _ = c.close(descriptors[1]);

    try signalReady(descriptors[1]);
    try std.testing.expectEqual(@as(c_int, 0), c.close(descriptors[1]));
    descriptors[1] = -1;
    var observed: [ready_message.len + 1]u8 = undefined;
    const count = c.read(
        descriptors[0],
        &observed,
        observed.len,
    );
    try std.testing.expectEqual(
        @as(isize, ready_message.len),
        count,
    );
    try std.testing.expectEqualStrings(
        ready_message,
        observed[0..@intCast(count)],
    );
    try std.testing.expectEqual(
        @as(isize, 0),
        c.read(descriptors[0], &observed, observed.len),
    );
}

test "execute CLI requires one exact READY descriptor" {
    const valid_args = [_][*:0]const u8{
        "execute",
        "--request-path",
        "/private/request.json",
        "--signing-key-path",
        "/private/removal-signing.key",
        "--parent-pid",
        "4242",
        "--ready-fd",
        "9",
    };
    var valid_iterator = std.process.Args.Iterator.init(.{
        .vector = &valid_args,
    });
    const parsed = try parseCli(&valid_iterator);
    switch (parsed) {
        .execute => |options| {
            try std.testing.expectEqual(@as(c.fd_t, 9), options.ready_fd);
            try std.testing.expectEqual(@as(u32, 4242), options.parent_pid);
        },
        else => return error.ExpectedExecuteCommand,
    }

    const missing_args = [_][*:0]const u8{
        "execute",
        "--request-path",
        "/private/request.json",
        "--signing-key-path",
        "/private/removal-signing.key",
        "--parent-pid",
        "4242",
    };
    var missing_iterator = std.process.Args.Iterator.init(.{
        .vector = &missing_args,
    });
    try std.testing.expectError(
        error.InvalidArguments,
        parseCli(&missing_iterator),
    );

    const stdio_args = [_][*:0]const u8{
        "execute",
        "--request-path",
        "/private/request.json",
        "--signing-key-path",
        "/private/removal-signing.key",
        "--parent-pid",
        "4242",
        "--ready-fd",
        "1",
    };
    var stdio_iterator = std.process.Args.Iterator.init(.{
        .vector = &stdio_args,
    });
    try std.testing.expectError(
        error.InvalidArguments,
        parseCli(&stdio_iterator),
    );
}

test "external completion proof survives recursive tombstone deletion" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    var parent_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(temporary.dir.handle, &parent_stat),
    );
    const helper_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        "helper",
        parent_stat.dev,
    );
    defer _ = c.close(helper_fd);

    const signing_key: [32]u8 = @splat(0x4d);
    const first_request_digest =
        "sha256_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    try writeNewPrivateDirectFile(
        io,
        helper_fd,
        signing_key_file_name,
        &signing_key,
        false,
    );
    const receipts_fd = try ensurePrivateDirectDirectory(
        helper_fd,
        "helper-receipts",
        parent_stat.dev,
    );
    defer _ = c.close(receipts_fd);
    try writeNewPrivateDirectFile(
        io,
        receipts_fd,
        "op_crashproof.json",
        "{\"state\":\"completed\"}",
        true,
    );
    try ensureInternalCompletionProof(
        std.testing.allocator,
        io,
        helper_fd,
        parent_stat.dev,
        "op_crashproof",
        first_request_digest,
        &signing_key,
    );
    const rebound_request_digest =
        "sha256_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    try ensureInternalCompletionProof(
        std.testing.allocator,
        io,
        helper_fd,
        parent_stat.dev,
        "op_crashproof",
        rebound_request_digest,
        &signing_key,
    );

    const helper_z = try stackZ("helper");
    const tombstone_z = try stackZ(".helper.removing-op_crashproof");
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.renameat(
            temporary.dir.handle,
            &helper_z,
            temporary.dir.handle,
            &tombstone_z,
        ),
    );
    try fsyncFd(temporary.dir.handle);
    const proof_name = ".helper.completion-op_crashproof";
    try publishCompletionProof(
        temporary.dir.handle,
        helper_fd,
        proof_name,
    );

    try removeDirectoryContents(
        std.testing.allocator,
        io,
        helper_fd,
        parent_stat.dev,
    );
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.unlinkat(
            temporary.dir.handle,
            &tombstone_z,
            c.AT.REMOVEDIR,
        ),
    );
    try fsyncFd(temporary.dir.handle);

    const proof_fd = try openCompletionProofDirectory(
        temporary.dir.handle,
        proof_name,
        parent_stat.dev,
    );
    defer _ = c.close(proof_fd);
    try validateCompletionProof(
        std.testing.allocator,
        io,
        proof_fd,
        "op_crashproof",
        rebound_request_digest,
    );
    const proof_z = try stackZ(proof_name);
    const cleanup_name =
        ".helper.completion-cleanup-op_crashproof";
    const cleanup_z = try stackZ(cleanup_name);
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.renameat(
            temporary.dir.handle,
            &proof_z,
            temporary.dir.handle,
            &cleanup_z,
        ),
    );
    try fsyncFd(temporary.dir.handle);
    const cleanup_fd = try openCompletionProofDirectory(
        temporary.dir.handle,
        cleanup_name,
        parent_stat.dev,
    );
    defer _ = c.close(cleanup_fd);
    const key_z = try stackZ(completion_proof_key_file_name);
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.unlinkat(cleanup_fd, &key_z, 0),
    );
    // A crash here leaves an intentionally invalid partial cleanup
    // directory. The atomic retired name is sufficient recovery evidence.
    try removeRetiredCompletionProofDirectory(
        std.testing.allocator,
        io,
        temporary.dir.handle,
        cleanup_name,
        parent_stat.dev,
    );
    try std.testing.expectError(
        error.PathAbsent,
        openCompletionProofDirectory(
            temporary.dir.handle,
            proof_name,
            parent_stat.dev,
        ),
    );
    try std.testing.expectError(
        error.PathAbsent,
        openCompletionProofDirectory(
            temporary.dir.handle,
            cleanup_name,
            parent_stat.dev,
        ),
    );
}

test "startup recovery removes only the exact pre-receipt live root" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    var parent_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(temporary.dir.handle, &parent_stat),
    );
    const helper_name = "OPRTE Removal";
    const exclusion_name =
        ".OPRTE Removal.removal-in-progress";
    const cleanup_name =
        ".OPRTE Removal.uncommitted-cleanup";

    const helper_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        helper_name,
        parent_stat.dev,
    );
    defer _ = c.close(helper_fd);
    const signing_key: [32]u8 = @splat(0x7c);
    try writeNewPrivateDirectFile(
        io,
        helper_fd,
        signing_key_file_name,
        &signing_key,
        false,
    );
    for (uncommitted_private_directory_names) |name| {
        const child_fd = try ensurePrivateDirectDirectory(
            helper_fd,
            name,
            parent_stat.dev,
        );
        if (std.mem.eql(u8, name, gateway_receipts_directory_name)) {
            try writeNewPrivateDirectFile(
                io,
                child_fd,
                ".op_crashwindow.json.0123456789abcdef01234567.tmp",
                "{\"version\":1",
                true,
            );
        }
        _ = c.close(child_fd);
    }
    const exclusion_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        exclusion_name,
        parent_stat.dev,
    );
    _ = c.close(exclusion_fd);
    try fsyncFd(temporary.dir.handle);

    try std.testing.expectEqual(
        UncommittedRecoveryState.recovered,
        try recoverUncommittedHelperStateAt(
            io,
            temporary.dir.handle,
            parent_stat.dev,
            helper_name,
            exclusion_name,
            cleanup_name,
            null,
            false,
        ),
    );
    const helper_z = try stackZ(helper_name);
    const exclusion_z = try stackZ(exclusion_name);
    var absent_stat: c.Stat = undefined;
    const helper_status = c.fstatat(
        temporary.dir.handle,
        &helper_z,
        &absent_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expect(helper_status != 0);
    try std.testing.expectEqual(c.E.NOENT, c.errno(helper_status));
    const exclusion_status = c.fstatat(
        temporary.dir.handle,
        &exclusion_z,
        &absent_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expect(exclusion_status != 0);
    try std.testing.expectEqual(c.E.NOENT, c.errno(exclusion_status));

    // The next startup is an ordinary initialized helper root with no
    // exclusion. Recovery must leave it intact.
    const normal_helper_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        helper_name,
        parent_stat.dev,
    );
    defer _ = c.close(normal_helper_fd);
    try writeNewPrivateDirectFile(
        io,
        normal_helper_fd,
        signing_key_file_name,
        &signing_key,
        false,
    );
    try std.testing.expectEqual(
        UncommittedRecoveryState.live_state_untouched,
        try recoverUncommittedHelperStateAt(
            io,
            temporary.dir.handle,
            parent_stat.dev,
            helper_name,
            exclusion_name,
            cleanup_name,
            null,
            false,
        ),
    );
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstatat(
            temporary.dir.handle,
            &helper_z,
            &absent_stat,
            c.AT.SYMLINK_NOFOLLOW,
        ),
    );
}

test "startup recovery deletes only exact uncommitted gateway receipt temps" {
    try std.testing.expect(isUncommittedGatewayReceiptTempName(
        ".op_example01.json.0123456789abcdef01234567.tmp",
    ));
    try std.testing.expect(!isUncommittedGatewayReceiptTempName(
        "op_example01.json.0123456789abcdef01234567.tmp",
    ));
    try std.testing.expect(!isUncommittedGatewayReceiptTempName(
        ".op_example01.json.0123456789abcdef0123456.tmp",
    ));
    try std.testing.expect(!isUncommittedGatewayReceiptTempName(
        ".op_example01.json.0123456789abcdef0123456A.tmp",
    ));
    try std.testing.expect(!isUncommittedGatewayReceiptTempName(
        ".not-an-operation.json.0123456789abcdef01234567.tmp",
    ));
    try std.testing.expect(!isUncommittedGatewayReceiptTempName(
        ".op_ab.json.0123456789abcdef01234567.tmp",
    ));

    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    var parent_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(temporary.dir.handle, &parent_stat),
    );
    const receipts_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        gateway_receipts_directory_name,
        parent_stat.dev,
    );
    defer _ = c.close(receipts_fd);
    const exact_name =
        ".op_example01.json.0123456789abcdef01234567.tmp";
    const unrelated_name =
        ".op_example01.json.0123456789abcdef0123456A.tmp";
    try writeNewPrivateDirectFile(
        io,
        receipts_fd,
        exact_name,
        "partial",
        true,
    );
    try writeNewPrivateDirectFile(
        io,
        receipts_fd,
        unrelated_name,
        "preserve",
        true,
    );
    try removeUncommittedGatewayReceiptTemps(
        io,
        temporary.dir.handle,
        parent_stat.dev,
    );
    const exact_z = try stackZ(exact_name);
    const unrelated_z = try stackZ(unrelated_name);
    var observed: c.Stat = undefined;
    const exact_status = c.fstatat(
        receipts_fd,
        &exact_z,
        &observed,
        c.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expect(exact_status != 0);
    try std.testing.expectEqual(c.E.NOENT, c.errno(exact_status));
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstatat(
            receipts_fd,
            &unrelated_z,
            &observed,
            c.AT.SYMLINK_NOFOLLOW,
        ),
    );
    const unsafe_name =
        ".op_unsafe01.json.0123456789abcdef01234567.tmp";
    try writeNewPrivateDirectFile(
        io,
        receipts_fd,
        unsafe_name,
        "unsafe mode",
        true,
    );
    const unsafe_z = try stackZ(unsafe_name);
    const unsafe_fd = c.openat(
        receipts_fd,
        &unsafe_z,
        c.O{
            .ACCMODE = .RDWR,
            .CLOEXEC = true,
            .NOFOLLOW = true,
        },
    );
    try std.testing.expect(unsafe_fd >= 0);
    defer _ = c.close(unsafe_fd);
    try std.testing.expectEqual(@as(c_int, 0), c.fchmod(unsafe_fd, 0o644));
    try std.testing.expectError(
        error.UnsafePath,
        removeUncommittedGatewayReceiptTemps(
            io,
            temporary.dir.handle,
            parent_stat.dev,
        ),
    );
}

test "startup recovery preserves any live root with durable operation state" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    var parent_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(temporary.dir.handle, &parent_stat),
    );
    const helper_name = "OPRTE Removal";
    const exclusion_name =
        ".OPRTE Removal.removal-in-progress";
    const cleanup_name =
        ".OPRTE Removal.uncommitted-cleanup";
    const helper_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        helper_name,
        parent_stat.dev,
    );
    defer _ = c.close(helper_fd);
    const signing_key: [32]u8 = @splat(0x31);
    try writeNewPrivateDirectFile(
        io,
        helper_fd,
        signing_key_file_name,
        &signing_key,
        false,
    );
    const receipts_fd = try ensurePrivateDirectDirectory(
        helper_fd,
        gateway_receipts_directory_name,
        parent_stat.dev,
    );
    defer _ = c.close(receipts_fd);
    try writeNewPrivateDirectFile(
        io,
        receipts_fd,
        "op_committed.json",
        "{}",
        true,
    );
    const stale_temp_name =
        ".op_committed.json.0123456789abcdef01234567.tmp";
    try writeNewPrivateDirectFile(
        io,
        receipts_fd,
        stale_temp_name,
        "partial",
        true,
    );
    const exclusion_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        exclusion_name,
        parent_stat.dev,
    );
    _ = c.close(exclusion_fd);

    try std.testing.expectEqual(
        UncommittedRecoveryState.live_state_untouched,
        try recoverUncommittedHelperStateAt(
            io,
            temporary.dir.handle,
            parent_stat.dev,
            helper_name,
            exclusion_name,
            cleanup_name,
            null,
            false,
        ),
    );
    const helper_z = try stackZ(helper_name);
    const exclusion_z = try stackZ(exclusion_name);
    var observed_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstatat(
            temporary.dir.handle,
            &helper_z,
            &observed_stat,
            c.AT.SYMLINK_NOFOLLOW,
        ),
    );
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstatat(
            temporary.dir.handle,
            &exclusion_z,
            &observed_stat,
            c.AT.SYMLINK_NOFOLLOW,
        ),
    );
    const stale_temp_z = try stackZ(stale_temp_name);
    const stale_temp_status = c.fstatat(
        receipts_fd,
        &stale_temp_z,
        &observed_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expect(stale_temp_status != 0);
    try std.testing.expectEqual(c.E.NOENT, c.errno(stale_temp_status));
}

test "administration rename preserves a concurrent replacement inode" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var parent_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(temporary.dir.handle, &parent_stat),
    );
    const original_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        "administration",
        parent_stat.dev,
    );
    defer _ = c.close(original_fd);
    var original_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(original_fd, &original_stat),
    );
    const administration_z = try stackZ("administration");
    const displaced_z = try stackZ("displaced-original");
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.renameat(
            temporary.dir.handle,
            &administration_z,
            temporary.dir.handle,
            &displaced_z,
        ),
    );
    const replacement_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        "administration",
        parent_stat.dev,
    );
    defer _ = c.close(replacement_fd);
    var replacement_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(replacement_fd, &replacement_stat),
    );

    try std.testing.expectError(
        error.OperationConflict,
        renameAnchoredAdministration(
            temporary.dir.handle,
            "administration",
            ".removing-operation",
            original_stat,
        ),
    );
    try directChildMatchesIdentity(
        temporary.dir.handle,
        "administration",
        replacement_stat,
    );
    try directChildMatchesIdentity(
        temporary.dir.handle,
        "displaced-original",
        original_stat,
    );
    const tombstone_z = try stackZ(".removing-operation");
    var missing_stat: c.Stat = undefined;
    const tombstone_status = c.fstatat(
        temporary.dir.handle,
        &tombstone_z,
        &missing_stat,
        c.AT.SYMLINK_NOFOLLOW,
    );
    try std.testing.expect(tombstone_status != 0);
    try std.testing.expectEqual(c.E.NOENT, c.errno(tombstone_status));

    // If the replacement itself appears under the tombstone name, rollback
    // also refuses to move or delete it because it is not the anchored inode.
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.renameat(
            temporary.dir.handle,
            &administration_z,
            temporary.dir.handle,
            &tombstone_z,
        ),
    );
    try std.testing.expectError(
        error.OperationConflict,
        rollbackAdministrationRename(
            temporary.dir.handle,
            "administration",
            ".removing-operation",
            original_stat,
        ),
    );
    try directChildMatchesIdentity(
        temporary.dir.handle,
        ".removing-operation",
        replacement_stat,
    );
}

test "administration rename rollback restores only its anchored inode" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    var parent_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(temporary.dir.handle, &parent_stat),
    );
    const administration_fd = try ensurePrivateDirectDirectory(
        temporary.dir.handle,
        "administration",
        parent_stat.dev,
    );
    defer _ = c.close(administration_fd);
    var administration_stat: c.Stat = undefined;
    try std.testing.expectEqual(
        @as(c_int, 0),
        c.fstat(administration_fd, &administration_stat),
    );

    try renameAnchoredAdministration(
        temporary.dir.handle,
        "administration",
        ".removing-operation",
        administration_stat,
    );
    try directChildMatchesIdentity(
        temporary.dir.handle,
        ".removing-operation",
        administration_stat,
    );
    try rollbackAdministrationRename(
        temporary.dir.handle,
        "administration",
        ".removing-operation",
        administration_stat,
    );
    try directChildMatchesIdentity(
        temporary.dir.handle,
        "administration",
        administration_stat,
    );
}
