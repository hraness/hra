const std = @import("std");
const builtin = @import("builtin");
const native_sdk = @import("native_sdk");
const build_options = @import("build_options");

pub const snapshot_command = "hra.runtime.snapshot";
pub const dispatch_command = "hra.runtime.dispatch";
const private_project_onboarding_command = "hra.runtime.onboardProject";
const private_folder_access_select_command =
    "hra.runtime.selectFolderAccess";
pub const native_project_add_command = "hra.project.add";
pub const native_folder_access_select_command = "hra.folderAccess.select";
pub const transport_retry_command = "hra.runtime.retryTransport";
pub const transport_health_command = "hra.runtime.confirmTransportHealth";
const private_development_reload_command =
    "hra.runtime.developmentReload";
const development_reload_result_kind =
    "developmentReloadDecision";
const runtime_bridge_profile_environment =
    "HRA_RUNTIME_BRIDGE_PROFILE";
pub const renderer_event = "hra:runtime-event";
pub const transport_lifecycle_event = "hra:runtime-transport";
const runtime_protocol_version: i64 = 3;
const transport_lifecycle_version: i64 = 1;
const max_transport_generation: u64 = 9_007_199_254_740_991;
const development_reload_candidate_bytes: usize = 64;

const main_window_id: native_sdk.WindowId = 1;
// The product supports 64 simultaneous pane mutations. Keep a separate,
// bounded reserve so their burst cannot starve the authoritative snapshot or
// private recovery/control traffic needed to make those panes usable again.
const max_renderer_mutation_requests: usize = 64;
const max_pending_requests: usize = max_renderer_mutation_requests + 8;
const max_queued_events: usize = 128;
const max_transport_lifecycle_actions: usize = 16;
const max_actions: usize =
    max_pending_requests * 2 + max_queued_events +
    max_transport_lifecycle_actions;
const reader_buffer_bytes: usize = native_sdk.bridge.max_response_bytes + 2;
const writer_buffer_bytes: usize = 16 * 1024;
const shutdown_poll_ms: i64 = 10;
const recovery_poll_ms: i64 = 10;
const generation_fence_wait_ms: i64 = 2_000;
const default_max_recovery_attempts: u8 = 3;
const default_recovery_backoff_ms: u16 = 250;
const max_recovery_backoff_ms: u16 = 2_000;
const renderer_delivery_retry_timer_id: u64 = 0x4f50_5254_4500_0001;
const renderer_delivery_retry_base_ms: u64 = 25;
const renderer_delivery_retry_max_ms: u64 = 1_000;
const max_trusted_directory_path_bytes: usize = 4096;
const max_removal_path_bytes: usize = 4096;
const local_data_removal_confirmation =
    "REMOVE HRA LOCAL DATA";
const local_data_removal_remove_command =
    "maintenance.localDataRemoval.remove";
const local_data_removal_launch_kind =
    "localDataRemovalNativeLaunch";
const local_data_removal_termination_required_kind =
    "localDataRemovalNativeTerminationRequired";
const private_removal_recovery_command =
    "hra.runtime.recoverLocalDataRemoval";
const private_removal_recovery_id =
    "native-removal-recovery-1";
const private_account_profile_result_command =
    "hra.runtime.accountProfileNativeResult";
const account_profile_native_request_kind =
    "accountProfileNativeRequest";
const account_profile_native_result_kind =
    "accountProfileNativeResult";
const private_harness_custody_result_command =
    "hra.runtime.harnessCustodyNativeResult";
const harness_custody_native_request_kind =
    "harnessCustodyNativeRequest";
const harness_custody_native_result_kind =
    "harnessCustodyNativeResult";
const removal_deletion_capability_bytes: usize = 32;
const removal_deletion_capability_hex_bytes: usize =
    removal_deletion_capability_bytes * 2;
// Direct v2 custody performs at most three helper calls. Each call also
// receives the one absolute operation deadline. Keep the aggregate success
// budget below the gateway client's fixed timeout so a mutation can never
// finish after its reporter abandons it.
const harness_custody_helper_timeout_ms: u32 = 5_000;
const legacy_harness_custody_timeout_ms: u32 = 10_000;
const harness_custody_helper_reap_timeout_ms: u32 = 1_000;
const legacy_harness_group_absence_timeout_ms: u32 = 1_000;
const max_harness_custody_native_operation_ms: u32 =
    3 * harness_custody_helper_timeout_ms +
    harness_custody_helper_reap_timeout_ms;
const harness_custody_native_deadline_ms: u32 = 50_000;
const harness_custody_gateway_timeout_ms: u32 = 55_000;
const max_harness_install_envelope_bytes: usize = 256;
const harness_legacy_bridge_cdhash =
    "9f39a6414ae834959ec63b39237a0ee426fd978a";
const harness_reconciliation_digest_bytes: usize = 64;
const max_harness_reconciliation_marker_bytes: usize = 320;
const max_harness_custody_native_request_bytes: usize = 2_048;
const harness_custody_parse_scratch_bytes: usize = 16_384;
const harness_custody_json_parse_scratch_bytes: usize = 4_096;
const account_profile_ensure_helper_timeout_ms: u32 = 4_000;
const account_profile_delete_helper_timeout_ms: u32 = 295_000;
// Recovery may finish deleting a deliberately large local-data tombstone, but
// startup must never wait indefinitely for the attested helper. A timeout is
// fail-closed: Native kills and reaps the owned helper and the staged journal
// remains for the next explicit recovery launch.
const removal_recovery_helper_timeout_ms: u32 = 295_000;
comptime {
    if (max_harness_custody_native_operation_ms >=
        harness_custody_native_deadline_ms or
        harness_custody_native_deadline_ms >=
            harness_custody_gateway_timeout_ms)
    {
        @compileError(
            "native Harness custody must finish before the gateway timeout",
        );
    }
    if (removal_recovery_helper_timeout_ms == 0 or
        removal_recovery_helper_timeout_ms > 5 * 60 * 1000)
    {
        @compileError("removal recovery timeout must be within five minutes");
    }
}
const removal_ready_message =
    // Stable v1 helper-protocol token; the predecessor spelling is opaque.
    "KITCHEN_REMOVAL_READY_V1\n";
const removal_ready_timeout_ms: i64 = 5_000;
const removal_termination_watchdog_ms: u32 = 750;
// Opaque durable storage identity retained for first-HRA-bridge continuity.
const legacy_oprte_removal_helper_state_directory_name =
    "OPRTE Removal";

extern "c" fn getpgid(process_id: c_int) c_int;

fn gatewayGroupMatchesUnreapedChild(
    process_id: c_int,
    observed_process_group: c_int,
) bool {
    // Darwin may stop reporting getpgid for a zombie leader. The Child handle
    // still owns that unreaped PID, so -1 cannot denote a reused foreign group.
    return observed_process_group == -1 or
        observed_process_group == process_id;
}

const GroupRetirementPollPreparation = struct {
    context: ?*anyopaque,
    run_fn: *const fn (context: ?*anyopaque, io: std.Io) bool,
};

fn gatewayStderrForMode(
    mode: std.builtin.OptimizeMode,
) std.process.SpawnOptions.StdIo {
    return if (mode == .Debug) .inherit else .ignore;
}

extern fn hra_macos_updater_enter_removal_maintenance() bool;
extern fn hra_macos_updater_leave_removal_maintenance() void;
extern fn hra_macos_verify_embedded_helper(
    path: [*]const u8,
    path_length: usize,
) bool;
extern fn hra_macos_spawn_attested_removal_execute(
    path: [*]const u8,
    path_length: usize,
    request_path: [*]const u8,
    request_path_length: usize,
    signing_key_path: [*]const u8,
    signing_key_path_length: usize,
    parent_process_id: u32,
    ready_fd: c_int,
    out_process_id: *c_int,
) bool;
extern fn hra_macos_spawn_attested_removal_recovery(
    path: [*]const u8,
    path_length: usize,
    helper_state_root: [*]const u8,
    helper_state_root_length: usize,
    out_process_id: *c_int,
) bool;
extern fn hra_macos_wait_removal_helper(
    process_id: c_int,
    timeout_milliseconds: u32,
) bool;
extern fn hra_macos_kill_and_reap_removal_helper(
    process_id: c_int,
) void;
extern fn hra_macos_run_attested_account_profile_operation(
    path: [*]const u8,
    path_length: usize,
    action: [*]const u8,
    action_length: usize,
    control_plane_path: [*]const u8,
    control_plane_path_length: usize,
    account_profile_id: [*]const u8,
    account_profile_id_length: usize,
    state_root_device: [*]const u8,
    state_root_device_length: usize,
    state_root_inode: [*]const u8,
    state_root_inode_length: usize,
    control_plane_device: [*]const u8,
    control_plane_device_length: usize,
    control_plane_inode: [*]const u8,
    control_plane_inode_length: usize,
    deletion_nonce: ?[*]const u8,
    deletion_nonce_length: usize,
    expected_revision: u64,
    source_development: bool,
    timeout_milliseconds: u32,
) bool;
extern fn hra_macos_prepare_attested_account_profile_operations() void;
extern fn hra_macos_cancel_attested_account_profile_operation() void;
extern fn hra_macos_run_attested_keychain_custodian(
    path: [*]const u8,
    path_length: usize,
    request: [*]const u8,
    request_length: usize,
    response: [*]u8,
    response_capacity: usize,
    out_response_length: *usize,
    timeout_milliseconds: u32,
    allow_unsealed_development: bool,
) bool;
extern fn hra_macos_prepare_attested_keychain_custodian_operations() void;
extern fn hra_macos_cancel_attested_keychain_custodian() void;
const LegacyHarnessCustodyFailureSubstage = enum(c_int) {
    none = 0,
    admission,
    static_bundle,
    static_self_managed,
    static_security_metadata,
    spawn,
    descriptor_before_dynamic,
    dynamic_pid_hash,
    dynamic_security_metadata,
    descriptor_after_dynamic,
    @"resume",
    output,
    exit,
    group_retirement,
    response_parse,

    fn text(self: @This()) ?[]const u8 {
        return switch (self) {
            .none => null,
            .admission => "admission",
            .static_bundle => "static_bundle",
            .static_self_managed => "static_self_managed",
            .static_security_metadata => "static_security_metadata",
            .spawn => "spawn",
            .descriptor_before_dynamic => "descriptor_before_dynamic",
            .dynamic_pid_hash => "dynamic_pid_hash",
            .dynamic_security_metadata => "dynamic_security_metadata",
            .descriptor_after_dynamic => "descriptor_after_dynamic",
            .@"resume" => "resume",
            .output => "output",
            .exit => "exit",
            .group_retirement => "group_retirement",
            .response_parse => "response_parse",
        };
    }
};
extern fn hra_macos_run_attested_legacy_harness_custody(
    path: [*]const u8,
    path_length: usize,
    delete_action: bool,
    response: [*]u8,
    response_capacity: usize,
    out_response_length: *usize,
    out_failure_substage: *LegacyHarnessCustodyFailureSubstage,
    timeout_milliseconds: u32,
    allow_unsealed_development: bool,
) bool;
extern fn hra_macos_prepare_attested_legacy_harness_custody_operations() void;
extern fn hra_macos_cancel_attested_legacy_harness_custody() void;
extern fn hra_macos_validate_removal_launch_paths(
    request_path: [*]const u8,
    request_path_length: usize,
    signing_key_path: [*]const u8,
    signing_key_path_length: usize,
) bool;
extern fn hra_macos_account_profile_identifier_is_valid(
    value: [*]const u8,
    value_length: usize,
) bool;
extern fn hra_macos_request_application_termination() bool;
extern fn hra_macos_arm_application_termination_watchdog(
    delay_milliseconds: u32,
) bool;

const DirectoryChoice = union(enum) {
    cancelled,
    selected: usize,
    failed,
};

/// The SDK's generic open dialog also permits files. This app-owned seam is a
/// strict one-directory NSOpenPanel in production and deterministic in tests.
pub const DirectoryPicker = struct {
    context: ?*anyopaque,
    choose_fn: *const fn (context: ?*anyopaque, output: []u8) DirectoryChoice,
};

const MacosDirectoryPickerResult = extern struct {
    status: c_int,
    path_len: usize,
};

extern fn hra_macos_choose_directory(output: [*]u8, output_len: usize) MacosDirectoryPickerResult;

const production_origins = [_][]const u8{"zero://app"};
const development_origins = [_][]const u8{ "zero://app", "http://127.0.0.1:5173" };
const automation_origins = [_][]const u8{ "zero://app", "zero://inline" };

pub const BridgeProfile = enum {
    production,
    development,
    automation,

    /// Use this same slice for Native SDK navigation and `RuntimeHost` bridge
    /// configuration so a build cannot navigate to an origin its bridge denies.
    pub fn origins(self: BridgeProfile) []const []const u8 {
        return switch (self) {
            .production => &production_origins,
            .development => &development_origins,
            .automation => &automation_origins,
        };
    }
};

const production_command_policies = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = snapshot_command, .origins = &production_origins },
    .{ .name = dispatch_command, .origins = &production_origins },
    .{ .name = native_project_add_command, .origins = &production_origins },
    .{ .name = native_folder_access_select_command, .origins = &production_origins },
    .{ .name = transport_retry_command, .origins = &production_origins },
    .{ .name = transport_health_command, .origins = &production_origins },
};
const development_command_policies = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = snapshot_command, .origins = &development_origins },
    .{ .name = dispatch_command, .origins = &development_origins },
    .{ .name = native_project_add_command, .origins = &development_origins },
    .{ .name = native_folder_access_select_command, .origins = &development_origins },
    .{ .name = transport_retry_command, .origins = &development_origins },
    .{ .name = transport_health_command, .origins = &development_origins },
};
const automation_command_policies = [_]native_sdk.bridge.CommandPolicy{
    .{ .name = snapshot_command, .origins = &automation_origins },
    .{ .name = dispatch_command, .origins = &automation_origins },
    .{ .name = native_project_add_command, .origins = &automation_origins },
    .{ .name = native_folder_access_select_command, .origins = &automation_origins },
    .{ .name = transport_retry_command, .origins = &automation_origins },
    .{ .name = transport_health_command, .origins = &automation_origins },
};
fn commandPolicies(profile: BridgeProfile) []const native_sdk.bridge.CommandPolicy {
    return switch (profile) {
        .production => &production_command_policies,
        .development => &development_command_policies,
        .automation => &automation_command_policies,
    };
}

fn bridgePolicy(profile: BridgeProfile) native_sdk.bridge.Policy {
    return .{
        .enabled = true,
        .commands = commandPolicies(profile),
    };
}

fn developmentReloadAvailableForMode(
    mode: std.builtin.OptimizeMode,
    profile: BridgeProfile,
) bool {
    return mode == .Debug and profile == .development;
}

fn developmentReloadAvailable(profile: BridgeProfile) bool {
    return developmentReloadAvailableForMode(builtin.mode, profile);
}

pub const PathOptions = struct {
    /// Development/test-only values have priority over matching environment
    /// variables. Every override is ignored when the host executable is inside
    /// a `.app/Contents/MacOS` directory.
    gateway_path: ?[]const u8 = null,
    runtime_root: ?[]const u8 = null,
    bun_bin: ?[]const u8 = null,
    codex_bin: ?[]const u8 = null,
    git_root: ?[]const u8 = null,
    git_bin: ?[]const u8 = null,
    git_executor_path: ?[]const u8 = null,
    data_remover_path: ?[]const u8 = null,
    keychain_custodian_path: ?[]const u8 = null,
    image_normalizer_path: ?[]const u8 = null,
};

pub const RuntimePaths = struct {
    runtime_root: []u8,
    gateway_path: []u8,
    bun_bin: []u8,
    codex_bin: []u8,
    git_root: []u8,
    git_bin: []u8,
    git_executor_path: []u8,
    data_remover_path: []u8,
    keychain_custodian_path: []u8,
    image_normalizer_path: []u8,

    pub fn deinit(self: *RuntimePaths, allocator: std.mem.Allocator) void {
        allocator.free(self.runtime_root);
        allocator.free(self.gateway_path);
        allocator.free(self.bun_bin);
        allocator.free(self.codex_bin);
        allocator.free(self.git_root);
        allocator.free(self.git_bin);
        allocator.free(self.git_executor_path);
        allocator.free(self.data_remover_path);
        allocator.free(self.keychain_custodian_path);
        allocator.free(self.image_normalizer_path);
        self.* = undefined;
    }
};

pub const ResolvePathError = error{
    ConflictingEnvironmentAlias,
    InvalidAbsolutePath,
    MissingDevelopmentRuntimeRoot,
} || std.mem.Allocator.Error || std.process.ExecutablePathAllocError;

/// Resolves the sidecar and its toolchain from one immutable runtime root.
///
/// A `.app/Contents/MacOS/*` executable always resolves exclusively from its
/// own `Contents/Resources/runtime`. This deliberately ignores both `PathOptions`
/// and `HRA_*` tool overrides so an environment variable cannot replace a
/// signed bundle resource. Non-bundle development and test executables require
/// an explicit runtime root or gateway override.
pub fn resolveRuntimePaths(
    io: std.Io,
    allocator: std.mem.Allocator,
    parent: *const std.process.Environ.Map,
    options: PathOptions,
) ResolvePathError!RuntimePaths {
    const executable_path = try std.process.executablePathAlloc(io, allocator);
    defer allocator.free(executable_path);
    return resolveRuntimePathsForExecutable(allocator, parent, options, executable_path);
}

fn resolveRuntimePathsForExecutable(
    allocator: std.mem.Allocator,
    parent: *const std.process.Environ.Map,
    options: PathOptions,
    executable_path: []const u8,
) ResolvePathError!RuntimePaths {
    const packaged_root = try packagedRuntimeRoot(allocator, executable_path);
    defer if (packaged_root) |path| allocator.free(path);

    if (packaged_root) |root| {
        return runtimePathsFromRoot(allocator, root, .{});
    }

    const gateway_override = options.gateway_path orelse try renamedEnvironmentValue(
        parent,
        "HRA_GATEWAY_PATH",
        "OPRTE_GATEWAY_PATH",
        "KITCHEN_GATEWAY_PATH",
    );
    const raw_runtime_root = options.runtime_root orelse root: {
        const gateway = gateway_override orelse return error.MissingDevelopmentRuntimeRoot;
        const bin_dir = std.fs.path.dirname(gateway) orelse return error.InvalidAbsolutePath;
        break :root std.fs.path.dirname(bin_dir) orelse return error.InvalidAbsolutePath;
    };
    return runtimePathsFromRoot(allocator, raw_runtime_root, .{
        .gateway_path = gateway_override,
        .bun_bin = options.bun_bin orelse try renamedEnvironmentValue(
            parent,
            "HRA_BUN_BIN",
            "OPRTE_BUN_BIN",
            "KITCHEN_BUN_BIN",
        ),
        .codex_bin = options.codex_bin orelse try renamedEnvironmentValue(
            parent,
            "HRA_CODEX_BIN",
            "OPRTE_CODEX_BIN",
            "KITCHEN_CODEX_BIN",
        ),
        .git_root = options.git_root orelse try renamedEnvironmentValue(
            parent,
            "HRA_GIT_ROOT",
            "OPRTE_GIT_ROOT",
            "KITCHEN_GIT_ROOT",
        ),
        .git_bin = options.git_bin orelse try renamedEnvironmentValue(
            parent,
            "HRA_GIT_BIN",
            "OPRTE_GIT_BIN",
            "KITCHEN_GIT_BIN",
        ),
        .git_executor_path = options.git_executor_path orelse
            try renamedEnvironmentValue(
                parent,
                "HRA_GIT_EXECUTOR_PATH",
                "OPRTE_GIT_EXECUTOR_PATH",
                "KITCHEN_GIT_EXECUTOR_PATH",
            ),
        .data_remover_path = options.data_remover_path orelse
            try renamedEnvironmentValue(
                parent,
                "HRA_DATA_REMOVER_PATH",
                "OPRTE_DATA_REMOVER_PATH",
                "KITCHEN_DATA_REMOVER_PATH",
            ),
        .keychain_custodian_path = options.keychain_custodian_path orelse
            try renamedEnvironmentValue(
                parent,
                "HRA_KEYCHAIN_CUSTODIAN_PATH",
                "OPRTE_KEYCHAIN_CUSTODIAN_PATH",
                "KITCHEN_KEYCHAIN_CUSTODIAN_PATH",
            ),
        .image_normalizer_path = options.image_normalizer_path orelse
            try renamedEnvironmentValue(
                parent,
                "HRA_IMAGE_NORMALIZER_PATH",
                "OPRTE_IMAGE_NORMALIZER_PATH",
                "KITCHEN_IMAGE_NORMALIZER_PATH",
            ),
    });
}

fn renamedEnvironmentValue(
    environment: *const std.process.Environ.Map,
    canonical_name: []const u8,
    legacy_name: []const u8,
    predecessor_name: ?[]const u8,
) error{ConflictingEnvironmentAlias}!?[]const u8 {
    const names = [_]?[]const u8{
        canonical_name,
        legacy_name,
        predecessor_name,
    };
    var resolved: ?[]const u8 = null;
    for (names) |maybe_name| {
        const name = maybe_name orelse continue;
        const value = environment.get(name) orelse continue;
        if (value.len == 0) continue;
        if (resolved) |current| {
            if (!std.mem.eql(u8, current, value))
                return error.ConflictingEnvironmentAlias;
        } else {
            resolved = value;
        }
    }
    return resolved;
}

const ToolOverrides = struct {
    gateway_path: ?[]const u8 = null,
    bun_bin: ?[]const u8 = null,
    codex_bin: ?[]const u8 = null,
    git_root: ?[]const u8 = null,
    git_bin: ?[]const u8 = null,
    git_executor_path: ?[]const u8 = null,
    data_remover_path: ?[]const u8 = null,
    keychain_custodian_path: ?[]const u8 = null,
    image_normalizer_path: ?[]const u8 = null,
};

fn runtimePathsFromRoot(
    allocator: std.mem.Allocator,
    raw_runtime_root: []const u8,
    overrides: ToolOverrides,
) ResolvePathError!RuntimePaths {
    var paths: RuntimePaths = undefined;
    paths.runtime_root = try normalizedAbsolute(allocator, raw_runtime_root);
    errdefer allocator.free(paths.runtime_root);

    paths.gateway_path = if (overrides.gateway_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.runtime_root, "bin", "oprte-gateway" });
    errdefer allocator.free(paths.gateway_path);

    paths.bun_bin = if (overrides.bun_bin) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.runtime_root, "bin", "bun" });
    errdefer allocator.free(paths.bun_bin);

    paths.codex_bin = if (overrides.codex_bin) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.runtime_root, "codex", "bin", "codex" });
    errdefer allocator.free(paths.codex_bin);

    paths.git_root = if (overrides.git_root) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.runtime_root, "git" });
    errdefer allocator.free(paths.git_root);

    paths.git_bin = if (overrides.git_bin) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(allocator, &.{ paths.git_root, "bin", "git" });
    errdefer allocator.free(paths.git_bin);

    paths.git_executor_path = if (overrides.git_executor_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(
            allocator,
            &.{ paths.runtime_root, "bin", "oprte-git-executor" },
        );
    errdefer allocator.free(paths.git_executor_path);

    paths.data_remover_path = if (overrides.data_remover_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(
            allocator,
            &.{
                paths.runtime_root,
                "bin",
                "oprte-data-remover",
            },
        );
    errdefer allocator.free(paths.data_remover_path);

    paths.keychain_custodian_path = if (overrides.keychain_custodian_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(
            allocator,
            &.{
                paths.runtime_root,
                "bin",
                "oprte-keychain-custodian",
            },
        );
    errdefer allocator.free(paths.keychain_custodian_path);

    paths.image_normalizer_path = if (overrides.image_normalizer_path) |path|
        try normalizedAbsolute(allocator, path)
    else
        try joinAbsolute(
            allocator,
            &.{ paths.runtime_root, "bin", "hra-image-normalizer" },
        );
    errdefer allocator.free(paths.image_normalizer_path);

    return paths;
}

fn packagedRuntimeRoot(allocator: std.mem.Allocator, executable_path: []const u8) ResolvePathError!?[]u8 {
    const normalized = try normalizedAbsolute(allocator, executable_path);
    defer allocator.free(normalized);

    const macos_dir = std.fs.path.dirname(normalized) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(macos_dir), "MacOS")) return null;
    const contents_dir = std.fs.path.dirname(macos_dir) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(contents_dir), "Contents")) return null;
    const app_dir = std.fs.path.dirname(contents_dir) orelse return null;
    const app_name = std.fs.path.basename(app_dir);
    if (app_name.len <= ".app".len or !std.mem.endsWith(u8, app_name, ".app")) return null;
    return @as(?[]u8, try joinAbsolute(allocator, &.{ contents_dir, "Resources", "runtime" }));
}

fn normalizedAbsolute(allocator: std.mem.Allocator, path: []const u8) ResolvePathError![]u8 {
    if (!std.fs.path.isAbsolute(path) or std.mem.findScalar(u8, path, 0) != null) {
        return error.InvalidAbsolutePath;
    }
    return std.fs.path.resolve(allocator, &.{path});
}

fn joinAbsolute(allocator: std.mem.Allocator, parts: []const []const u8) ResolvePathError![]u8 {
    const joined = try std.fs.path.join(allocator, parts);
    defer allocator.free(joined);
    return normalizedAbsolute(allocator, joined);
}

const inherited_environment_keys = [_][]const u8{
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
};

const automation_cloud_environment_keys = [_][]const u8{
    // Automation may select an exact local or hosted fixture. Raw source
    // development is intentionally cloud-detached so its ad-hoc executable
    // identity can never reach production credential custody or journals.
    // Preserve compatibility names so the TypeScript boundary can reject
    // conflicts instead of Native silently choosing one.
    "HRA_CLOUD_API_URL",
    "OPRTE_CLOUD_API_URL",
    "TASKCTL_API_URL",
    "HRA_CLOUD_WEB_URL",
    "OPRTE_CLOUD_WEB_URL",
    "KITCHEN_CLOUD_WEB_URL",
};

pub const PublicCloudConfiguration = struct {
    api_origin: []const u8,
    web_origin: []const u8,
};

/// Constructs the sidecar's complete environment instead of cloning the app's
/// environment. Only locale/temporary-directory values and public cloud
/// connection coordinates cross the boundary. Tokens, proxy variables,
/// dynamic-loader knobs, SSH agent sockets, and Node/Bun option injection do
/// not.
pub fn buildSanitizedEnvironment(
    allocator: std.mem.Allocator,
    parent: *const std.process.Environ.Map,
    paths: *const RuntimePaths,
    profile: BridgeProfile,
    production_cloud: ?PublicCloudConfiguration,
) std.mem.Allocator.Error!std.process.Environ.Map {
    var environment: std.process.Environ.Map = .init(allocator);
    errdefer environment.deinit();

    for (inherited_environment_keys) |key| {
        if (parent.get(key)) |value| try environment.put(key, value);
    }
    switch (profile) {
        .development => {},
        .automation => for (automation_cloud_environment_keys) |key| {
            if (parent.get(key)) |value| try environment.put(key, value);
        },
        .production => if (production_cloud) |configuration| {
            // Release builds use checked public coordinates. An ambient shell
            // environment cannot redirect a packaged app to another relay or
            // browser control plane.
            try environment.put("HRA_CLOUD_API_URL", configuration.api_origin);
            try environment.put("HRA_CLOUD_WEB_URL", configuration.web_origin);
        },
    }

    try environment.put(runtime_bridge_profile_environment, switch (profile) {
        .production => "production",
        .development => "development",
        .automation => "automation",
    });

    try environment.put("HRA_GATEWAY_PATH", paths.gateway_path);
    try environment.put("HRA_BUN_BIN", paths.bun_bin);
    try environment.put("HRA_CODEX_BIN", paths.codex_bin);
    try environment.put("HRA_GIT_ROOT", paths.git_root);
    try environment.put("HRA_GIT_BIN", paths.git_bin);
    try environment.put("HRA_GIT_EXECUTOR_PATH", paths.git_executor_path);
    try environment.put(
        "HRA_DATA_REMOVER_PATH",
        paths.data_remover_path,
    );
    try environment.put(
        "HRA_IMAGE_NORMALIZER_PATH",
        paths.image_normalizer_path,
    );

    const gateway_dir = std.fs.path.dirname(paths.gateway_path) orelse paths.runtime_root;
    const codex_dir = std.fs.path.dirname(paths.codex_bin) orelse paths.runtime_root;
    const git_dir = std.fs.path.dirname(paths.git_bin) orelse paths.git_root;
    const path = try std.fmt.allocPrint(
        allocator,
        "{s}:{s}:{s}:/usr/bin:/bin:/usr/sbin:/sbin",
        .{ gateway_dir, codex_dir, git_dir },
    );
    defer allocator.free(path);
    try environment.put("PATH", path);
    return environment;
}

fn normalizedPackageSmokeRoot(
    allocator: std.mem.Allocator,
    raw_root: []const u8,
) ResolvePathError![]u8 {
    const normalized = try normalizedAbsolute(allocator, raw_root);
    errdefer allocator.free(normalized);
    if (!std.mem.eql(u8, raw_root, normalized) or
        !std.mem.startsWith(
            u8,
            std.fs.path.basename(normalized),
            "hra-package-smoke-",
        ) or
        std.fs.path.dirname(normalized) == null)
    {
        return error.InvalidAbsolutePath;
    }
    return normalized;
}

/// Starts only the packaged native executable and its bundled Bun gateway.
/// This verifier-only path never initializes AppKit, WebKit, updater state,
/// account profiles, or Keychain custody. The gateway admits only its matching
/// marker routine and writes exclusively beneath `raw_root`.
pub fn runPackagedSmoke(
    init: std.process.Init,
    raw_root: []const u8,
) !void {
    const allocator = std.heap.page_allocator;
    const root = try normalizedPackageSmokeRoot(allocator, raw_root);
    defer allocator.free(root);
    var paths = try resolveRuntimePaths(
        init.io,
        allocator,
        init.environ_map,
        .{},
    );
    defer paths.deinit(allocator);
    var environment = try buildSanitizedEnvironment(
        allocator,
        init.environ_map,
        &paths,
        .production,
        null,
    );
    defer environment.deinit();
    try environment.put("HRA_PACKAGE_SMOKE_ROOT", root);

    var child = try std.process.spawn(init.io, .{
        .argv = &.{paths.gateway_path},
        .environ_map = &environment,
        .stdin = .ignore,
        .stdout = .inherit,
        .stderr = gatewayStderrForMode(builtin.mode),
        // Inherit the verifier-owned host process group so its bounded cleanup
        // terminates both exact births without a global process search.
        .create_no_window = true,
    });
    defer child.kill(init.io);
    std.Io.sleep(
        init.io,
        .fromMilliseconds(30_000),
        .awake,
    ) catch {};
}

fn addStartupRemovalRecoveryEnvironment(
    environment: *std.process.Environ.Map,
    enabled: bool,
) std.mem.Allocator.Error!void {
    if (enabled) {
        try environment.put(
            "HRA_STARTUP_REMOVAL_RECOVERY",
            "1",
        );
    }
}

pub const CodecError = error{
    InvalidRequestId,
    InvalidJson,
    MessageTooLarge,
    InvalidTrustedDirectoryPath,
};

/// Encodes the private gateway envelope. `payload` remains the exact JSON value
/// supplied by the renderer bridge; it is not converted to a JSON string.
pub fn encodeRequest(
    allocator: std.mem.Allocator,
    id: []const u8,
    command: []const u8,
    payload: []const u8,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    return encodeRequestWithRemovalCapability(
        allocator,
        id,
        command,
        payload,
        null,
    );
}

fn encodeRequestWithRemovalCapability(
    allocator: std.mem.Allocator,
    id: []const u8,
    command: []const u8,
    payload: []const u8,
    removal_deletion_capability: ?[]const u8,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    if (!validRequestId(id)) return error.InvalidRequestId;
    if (payload.len > native_sdk.bridge.max_message_bytes) return error.MessageTooLarge;
    if (!try std.json.validate(allocator, payload)) return error.InvalidJson;
    if (removal_deletion_capability) |capability| {
        if (!validPrefixedLowerHex(
            capability,
            "",
            removal_deletion_capability_hex_bytes,
        )) return error.InvalidJson;
    }

    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    output.writer.writeAll("{\"id\":") catch return error.OutOfMemory;
    std.json.Stringify.value(id, .{}, &output.writer) catch return error.OutOfMemory;
    output.writer.writeAll(",\"command\":") catch return error.OutOfMemory;
    std.json.Stringify.value(command, .{}, &output.writer) catch return error.OutOfMemory;
    output.writer.writeAll(",\"payload\":") catch return error.OutOfMemory;
    output.writer.writeAll(payload) catch return error.OutOfMemory;
    if (removal_deletion_capability) |capability| {
        output.writer.writeAll(",\"nativeRemovalCapability\":") catch
            return error.OutOfMemory;
        std.json.Stringify.value(capability, .{}, &output.writer) catch
            return error.OutOfMemory;
    }
    output.writer.writeAll("}\n") catch return error.OutOfMemory;
    return output.toOwnedSlice();
}

/// These are the only path-bearing chooser requests Native may submit. The
/// renderer has no policy for either private gateway command.
fn encodeNativeTrustedDirectoryRequest(
    allocator: std.mem.Allocator,
    id: []const u8,
    command: []const u8,
    trusted_directory_path: []const u8,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    if (trusted_directory_path.len == 0 or
        trusted_directory_path.len > max_trusted_directory_path_bytes or
        !std.fs.path.isAbsolute(trusted_directory_path) or
        std.mem.indexOfScalar(u8, trusted_directory_path, 0) != null) return error.InvalidTrustedDirectoryPath;

    var payload: std.Io.Writer.Allocating = .init(allocator);
    defer payload.deinit();
    payload.writer.writeAll("{\"version\":3,\"trustedDirectoryPath\":") catch return error.OutOfMemory;
    std.json.Stringify.value(trusted_directory_path, .{}, &payload.writer) catch return error.OutOfMemory;
    payload.writer.writeByte('}') catch return error.OutOfMemory;
    return encodeRequest(allocator, id, command, payload.writer.buffered());
}

fn encodeNativeProjectOnboardingRequest(
    allocator: std.mem.Allocator,
    id: []const u8,
    trusted_directory_path: []const u8,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    return encodeNativeTrustedDirectoryRequest(
        allocator,
        id,
        private_project_onboarding_command,
        trusted_directory_path,
    );
}

fn encodeNativeFolderAccessSelectRequest(
    allocator: std.mem.Allocator,
    id: []const u8,
    trusted_directory_path: []const u8,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    return encodeNativeTrustedDirectoryRequest(
        allocator,
        id,
        private_folder_access_select_command,
        trusted_directory_path,
    );
}

fn encodeStartupRemovalRecoveryRequest(
    allocator: std.mem.Allocator,
    removal_deletion_capability: []const u8,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    return encodeRequestWithRemovalCapability(
        allocator,
        private_removal_recovery_id,
        private_removal_recovery_command,
        "{\"version\":1,\"nativeRecoveryPrepared\":true}",
        removal_deletion_capability,
    );
}

fn encodeAccountProfileNativeResultRequest(
    allocator: std.mem.Allocator,
    request: *const AccountProfileNativeRequest,
    ok: bool,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    var payload: std.Io.Writer.Allocating = .init(allocator);
    defer {
        if (payload.writer.buffer.len > 0) secureWipe(payload.writer.buffer);
        payload.deinit();
    }
    payload.writer.writeAll(
        "{\"kind\":\"" ++ account_profile_native_result_kind ++
            "\",\"version\":1,\"nativeRequestId\":",
    ) catch return error.OutOfMemory;
    std.json.Stringify.value(
        request.idSlice(),
        .{},
        &payload.writer,
    ) catch return error.OutOfMemory;
    payload.writer.writeAll(",\"binding\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(
        request.binding[0..],
        .{},
        &payload.writer,
    ) catch return error.OutOfMemory;
    payload.writer.writeAll(",\"action\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(
        request.action.text(),
        .{},
        &payload.writer,
    ) catch return error.OutOfMemory;
    payload.writer.writeAll(",\"accountProfileId\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(
        request.accountProfileId(),
        .{},
        &payload.writer,
    ) catch return error.OutOfMemory;
    payload.writer.writeAll(",\"ok\":") catch
        return error.OutOfMemory;
    payload.writer.writeAll(if (ok) "true}" else "false}") catch
        return error.OutOfMemory;
    return encodeRequest(
        allocator,
        request.idSlice(),
        private_account_profile_result_command,
        payload.writer.buffered(),
    );
}

fn validateAccountProfileNativeResultAcknowledgement(
    allocator: std.mem.Allocator,
    line: []const u8,
    expected_id: []const u8,
) bool {
    var parsed =
        std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch
            return false;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return false,
    };
    if (outer.count() != 3) return false;
    const id = switch (outer.get("id") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const ok = switch (outer.get("ok") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    const result = switch (outer.get("result") orelse return false) {
        .object => |value| value,
        else => return false,
    };
    if (!ok or
        !std.mem.eql(u8, id, expected_id) or
        result.count() != 3)
    {
        return false;
    }
    const kind = switch (result.get("kind") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const version = switch (result.get("version") orelse return false) {
        .integer => |value| value,
        else => return false,
    };
    const accepted = switch (result.get("accepted") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    return std.mem.eql(
        u8,
        kind,
        "accountProfileNativeResultAccepted",
    ) and version == 1 and accepted;
}

fn encodeHarnessCustodyNativeResultRequest(
    allocator: std.mem.Allocator,
    request: *const HarnessCustodyNativeRequest,
    result: HarnessCustodyOperationResult,
) (CodecError || std.mem.Allocator.Error)![]u8 {
    var payload: std.Io.Writer.Allocating = .init(allocator);
    defer {
        if (payload.writer.buffer.len > 0) secureWipe(payload.writer.buffer);
        payload.deinit();
    }
    payload.writer.writeAll("{\"kind\":\"" ++ harness_custody_native_result_kind ++
        "\",\"version\":1,\"nativeRequestId\":") catch return error.OutOfMemory;
    std.json.Stringify.value(request.idSlice(), .{}, &payload.writer) catch
        return error.OutOfMemory;
    payload.writer.writeAll(",\"binding\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(request.binding[0..], .{}, &payload.writer) catch
        return error.OutOfMemory;
    payload.writer.writeAll(",\"action\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(request.action.text(), .{}, &payload.writer) catch
        return error.OutOfMemory;
    switch (result) {
        .failed => |stage| {
            if (stage.isLegacy()) return error.InvalidJson;
            payload.writer.writeAll(",\"ok\":false,\"failureStage\":") catch
                return error.OutOfMemory;
            std.json.Stringify.value(stage.text(), .{}, &payload.writer) catch
                return error.OutOfMemory;
            payload.writer.writeByte('}') catch return error.OutOfMemory;
        },
        .legacy_failed => |failure| {
            const substage = failure.substage.text() orelse
                return error.InvalidJson;
            if (!failure.stage.isLegacy()) return error.InvalidJson;
            payload.writer.writeAll(",\"ok\":false,\"failureStage\":") catch
                return error.OutOfMemory;
            std.json.Stringify.value(
                failure.stage.text(),
                .{},
                &payload.writer,
            ) catch return error.OutOfMemory;
            payload.writer.writeAll(",\"legacySubstage\":") catch
                return error.OutOfMemory;
            std.json.Stringify.value(substage, .{}, &payload.writer) catch
                return error.OutOfMemory;
            payload.writer.writeByte('}') catch return error.OutOfMemory;
        },
        .read => |read| {
            payload.writer.writeAll(",\"ok\":true,\"state\":") catch
                return error.OutOfMemory;
            std.json.Stringify.value(
                if (read.value.state == .present) "present" else "absent",
                .{},
                &payload.writer,
            ) catch return error.OutOfMemory;
            payload.writer.writeAll(",\"value\":") catch
                return error.OutOfMemory;
            if (read.value.valueSlice()) |value| {
                std.json.Stringify.value(value, .{}, &payload.writer) catch
                    return error.OutOfMemory;
            } else {
                payload.writer.writeAll("null") catch
                    return error.OutOfMemory;
            }
            payload.writer.print(
                ",\"migratedFromLegacy\":{},\"legacyPreserved\":{}}}",
                .{ read.migrated_from_legacy, read.legacy_preserved },
            ) catch return error.OutOfMemory;
        },
        .set_if_absent => |set| {
            const value = set.value.valueSlice() orelse
                return error.InvalidJson;
            payload.writer.writeAll(",\"ok\":true,\"value\":") catch
                return error.OutOfMemory;
            std.json.Stringify.value(value, .{}, &payload.writer) catch
                return error.OutOfMemory;
            payload.writer.print(",\"created\":{}}}", .{set.created}) catch
                return error.OutOfMemory;
        },
        .delete_both => |deleted| payload.writer.print(
            ",\"ok\":true,\"deletedV1\":{},\"deletedV2\":{}," ++
                "\"absentV1\":true,\"absentV2\":true}}",
            .{ deleted.deleted_v1, deleted.deleted_v2 },
        ) catch return error.OutOfMemory,
    }
    return encodeRequest(
        allocator,
        request.idSlice(),
        private_harness_custody_result_command,
        payload.writer.buffered(),
    );
}

// Failure reporting is reserved before any Keychain operation begins. Keep the
// allocation at one fixed maximum size so the actual sealed stage can replace
// the pre-encoded reporting fallback without allocating after a mutation.
const harness_custody_failure_request_bytes: usize = 768;

fn encodeFixedHarnessCustodyFailureRequest(
    output: *[harness_custody_failure_request_bytes]u8,
    request: *const HarnessCustodyNativeRequest,
    stage: HarnessCustodyFailureStage,
    legacy_substage: ?LegacyHarnessCustodyFailureSubstage,
) bool {
    if (!validPrefixedLowerHex(request.idSlice(), "native-harness-", 24) or
        !validPrefixedLowerHex(&request.binding, "binding_", 48) or
        stage.isLegacy() != (legacy_substage != null) or
        legacy_substage == .none)
    {
        return false;
    }
    @memset(output, ' ');
    if (legacy_substage) |substage| {
        const substage_text = substage.text() orelse return false;
        _ = std.fmt.bufPrint(
            output[0 .. output.len - 1],
            "{{\"id\":\"{s}\",\"command\":\"" ++
                private_harness_custody_result_command ++
                "\",\"payload\":{{\"kind\":\"" ++
                harness_custody_native_result_kind ++
                "\",\"version\":1,\"nativeRequestId\":\"{s}\"," ++
                "\"binding\":\"{s}\",\"action\":\"{s}\"," ++
                "\"ok\":false,\"failureStage\":\"{s}\"," ++
                "\"legacySubstage\":\"{s}\"}}}}",
            .{
                request.idSlice(),
                request.idSlice(),
                &request.binding,
                request.action.text(),
                stage.text(),
                substage_text,
            },
        ) catch return false;
    } else {
        _ = std.fmt.bufPrint(
            output[0 .. output.len - 1],
            "{{\"id\":\"{s}\",\"command\":\"" ++
                private_harness_custody_result_command ++
                "\",\"payload\":{{\"kind\":\"" ++
                harness_custody_native_result_kind ++
                "\",\"version\":1,\"nativeRequestId\":\"{s}\"," ++
                "\"binding\":\"{s}\",\"action\":\"{s}\"," ++
                "\"ok\":false,\"failureStage\":\"{s}\"}}}}",
            .{
                request.idSlice(),
                request.idSlice(),
                &request.binding,
                request.action.text(),
                stage.text(),
            },
        ) catch return false;
    }
    output[output.len - 1] = '\n';
    return true;
}

fn validateHarnessCustodyNativeResultAcknowledgement(
    allocator: std.mem.Allocator,
    line: []const u8,
    expected_id: []const u8,
) bool {
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        allocator,
        line,
        .{},
    ) catch return false;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return false,
    };
    if (outer.count() != 3) return false;
    const id = switch (outer.get("id") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const ok = switch (outer.get("ok") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    const result = switch (outer.get("result") orelse return false) {
        .object => |value| value,
        else => return false,
    };
    if (!ok or !std.mem.eql(u8, id, expected_id) or result.count() != 3)
        return false;
    const kind = switch (result.get("kind") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const version = switch (result.get("version") orelse return false) {
        .integer => |value| value,
        else => return false,
    };
    const accepted = switch (result.get("accepted") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    return std.mem.eql(
        u8,
        kind,
        "harnessCustodyNativeResultAccepted",
    ) and version == 1 and accepted;
}

/// Renderer callers may request the trusted native chooser, but never supply
/// its selected path. Keep this public payload deliberately featureless.
fn validateProjectAddRequest(allocator: std.mem.Allocator, payload: []const u8) !void {
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, payload, .{}) catch {
        return error.InvalidProjectAddRequest;
    };
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidProjectAddRequest,
    };
    if (object.count() != 1) return error.InvalidProjectAddRequest;
    const version = switch (object.get("version") orelse return error.InvalidProjectAddRequest) {
        .integer => |value| value,
        else => return error.InvalidProjectAddRequest,
    };
    if (version != runtime_protocol_version) return error.InvalidProjectAddRequest;
}

fn validateFolderAccessSelectRequest(
    allocator: std.mem.Allocator,
    payload: []const u8,
) !void {
    validateProjectAddRequest(allocator, payload) catch
        return error.InvalidFolderAccessSelectRequest;
}

const RemovalCorrelation = struct {
    operation_id: [96]u8,
    operation_id_len: usize,
    preview_id: [96]u8,
    preview_id_len: usize,

    fn operationId(self: *const RemovalCorrelation) []const u8 {
        return self.operation_id[0..self.operation_id_len];
    }

    fn previewId(self: *const RemovalCorrelation) []const u8 {
        return self.preview_id[0..self.preview_id_len];
    }
};

fn opaqueId(value: []const u8, prefix: []const u8) bool {
    if (value.len < prefix.len + 8 or
        value.len > 96 or
        !std.mem.startsWith(u8, value, prefix) or
        value[prefix.len] != '_') return false;
    for (value[prefix.len + 1 ..]) |byte| {
        if (!std.ascii.isAlphanumeric(byte) and
            byte != '_' and
            byte != '-') return false;
    }
    return true;
}

test "Native opaque identifiers match the public exact lower bound" {
    const cases = [_]struct {
        value: []const u8,
        prefix: []const u8,
    }{
        .{ .value = "op_1234567", .prefix = "op" },
        .{ .value = "acct_1234567", .prefix = "acct" },
        .{ .value = "removal_1234567", .prefix = "removal" },
        .{ .value = "confirm_1234567", .prefix = "confirm" },
    };
    for (cases) |case| {
        try std.testing.expect(opaqueId(case.value, case.prefix));
        try std.testing.expect(!opaqueId(
            case.value[0 .. case.value.len - 1],
            case.prefix,
        ));
    }
    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        const minimum_account_id = "acct_1234567";
        try std.testing.expect(hra_macos_account_profile_identifier_is_valid(
            minimum_account_id.ptr,
            minimum_account_id.len,
        ));
        const too_short_account_id = "acct_123456";
        try std.testing.expect(!hra_macos_account_profile_identifier_is_valid(
            too_short_account_id.ptr,
            too_short_account_id.len,
        ));
    }
}

/// Returns correlation only for the exact destructive confirmation request.
/// Other dispatch payloads return null; malformed attempts that name the
/// destructive command fail closed.
fn parseRemovalConfirmation(
    allocator: std.mem.Allocator,
    payload: []const u8,
) !?RemovalCorrelation {
    var parsed =
        std.json.parseFromSlice(std.json.Value, allocator, payload, .{}) catch
            return null;
    defer parsed.deinit();
    const root = switch (parsed.value) {
        .object => |value| value,
        else => return null,
    };
    const command_value = root.get("command") orelse return null;
    const command = switch (command_value) {
        .object => |value| value,
        else => return null,
    };
    const command_type = switch (command.get("type") orelse return null) {
        .string => |value| value,
        else => return null,
    };
    if (!std.mem.eql(
        u8,
        command_type,
        local_data_removal_remove_command,
    )) return null;

    if (root.count() != 3 or command.count() != 5) {
        return error.InvalidRemovalConfirmation;
    }
    const version = switch (root.get("version") orelse
        return error.InvalidRemovalConfirmation) {
        .integer => |value| value,
        else => return error.InvalidRemovalConfirmation,
    };
    const operation_id = switch (root.get("operationId") orelse
        return error.InvalidRemovalConfirmation) {
        .string => |value| value,
        else => return error.InvalidRemovalConfirmation,
    };
    const preview_id = switch (command.get("previewId") orelse
        return error.InvalidRemovalConfirmation) {
        .string => |value| value,
        else => return error.InvalidRemovalConfirmation,
    };
    const confirmation_token = switch (command.get("confirmationToken") orelse
        return error.InvalidRemovalConfirmation) {
        .string => |value| value,
        else => return error.InvalidRemovalConfirmation,
    };
    const confirmation = switch (command.get("confirmation") orelse
        return error.InvalidRemovalConfirmation) {
        .string => |value| value,
        else => return error.InvalidRemovalConfirmation,
    };
    _ = switch (command.get("acknowledgeDirtyWorktrees") orelse
        return error.InvalidRemovalConfirmation) {
        .bool => |value| value,
        else => return error.InvalidRemovalConfirmation,
    };
    if (version != runtime_protocol_version or
        !opaqueId(operation_id, "op") or
        !opaqueId(preview_id, "removal") or
        !opaqueId(confirmation_token, "confirm") or
        !std.mem.eql(
            u8,
            confirmation,
            local_data_removal_confirmation,
        )) return error.InvalidRemovalConfirmation;

    var correlation: RemovalCorrelation = .{
        .operation_id = undefined,
        .operation_id_len = operation_id.len,
        .preview_id = undefined,
        .preview_id_len = preview_id.len,
    };
    @memcpy(
        correlation.operation_id[0..operation_id.len],
        operation_id,
    );
    @memcpy(
        correlation.preview_id[0..preview_id.len],
        preview_id,
    );
    return correlation;
}

fn validRequestId(id: []const u8) bool {
    if (id.len == 0 or id.len > native_sdk.bridge.max_id_bytes) return false;
    for (id) |byte| {
        if (byte <= 0x1f or byte == '"' or byte == '\\') return false;
    }
    return true;
}

pub const EventRecovery = enum {
    snapshot_recoverable,
    protected,
};

pub const LineKind = union(enum) {
    response: struct {
        id: [native_sdk.bridge.max_id_bytes]u8,
        id_len: usize,
        ok: bool,
    },
    event: struct {
        sequence: u64,
        recovery: EventRecovery,
    },
    account_profile_request,
    harness_custody_request,
};

const AccountProfileAction = enum {
    delete,
    ensure,

    fn text(self: AccountProfileAction) []const u8 {
        return switch (self) {
            .delete => "delete",
            .ensure => "ensure",
        };
    }
};

const AccountProfileNativeRequest = struct {
    id: [native_sdk.bridge.max_id_bytes]u8,
    id_len: usize,
    binding: ["binding_".len + 48]u8,
    action: AccountProfileAction,
    control_plane_path: [max_removal_path_bytes]u8,
    control_plane_path_len: usize,
    account_profile_id: [96]u8,
    account_profile_id_len: usize,
    state_root_device: [20]u8,
    state_root_device_len: usize,
    state_root_inode: [20]u8,
    state_root_inode_len: usize,
    control_plane_device: [20]u8,
    control_plane_device_len: usize,
    control_plane_inode: [20]u8,
    control_plane_inode_len: usize,
    deletion_nonce: ["deletion_".len + 64]u8 = undefined,
    deletion_nonce_len: usize = 0,
    expected_revision: u64 = 0,

    fn idSlice(self: *const AccountProfileNativeRequest) []const u8 {
        return self.id[0..self.id_len];
    }

    fn controlPlanePath(self: *const AccountProfileNativeRequest) []const u8 {
        return self.control_plane_path[0..self.control_plane_path_len];
    }

    fn accountProfileId(self: *const AccountProfileNativeRequest) []const u8 {
        return self.account_profile_id[0..self.account_profile_id_len];
    }

    fn stateRootDevice(self: *const AccountProfileNativeRequest) []const u8 {
        return self.state_root_device[0..self.state_root_device_len];
    }

    fn stateRootInode(self: *const AccountProfileNativeRequest) []const u8 {
        return self.state_root_inode[0..self.state_root_inode_len];
    }

    fn controlPlaneDevice(self: *const AccountProfileNativeRequest) []const u8 {
        return self.control_plane_device[0..self.control_plane_device_len];
    }

    fn controlPlaneInode(self: *const AccountProfileNativeRequest) []const u8 {
        return self.control_plane_inode[0..self.control_plane_inode_len];
    }

    fn deletionNonce(self: *const AccountProfileNativeRequest) ?[]const u8 {
        return if (self.deletion_nonce_len == 0)
            null
        else
            self.deletion_nonce[0..self.deletion_nonce_len];
    }
};

pub const HarnessCustodyAction = enum {
    read,
    set_if_absent,
    delete_both,

    fn text(self: HarnessCustodyAction) []const u8 {
        return switch (self) {
            .read => "read",
            .set_if_absent => "setIfAbsent",
            .delete_both => "deleteBoth",
        };
    }
};

const HarnessCustodyFailureStage = enum {
    admission,
    marker_read,
    envelope_read,
    legacy_read,
    marker_prepare,
    envelope_set_if_absent,
    legacy_preservation_read,
    marker_commit,
    legacy_delete,
    envelope_delete,
    marker_delete,
    reconciliation,
    reporting,

    fn text(self: @This()) []const u8 {
        return switch (self) {
            .admission => "admission",
            .marker_read => "marker_read",
            .envelope_read => "envelope_read",
            .legacy_read => "legacy_read",
            .marker_prepare => "marker_prepare",
            .envelope_set_if_absent => "envelope_set_if_absent",
            .legacy_preservation_read => "legacy_preservation_read",
            .marker_commit => "marker_commit",
            .legacy_delete => "legacy_delete",
            .envelope_delete => "envelope_delete",
            .marker_delete => "marker_delete",
            .reconciliation => "reconciliation",
            .reporting => "reporting",
        };
    }

    fn isLegacy(self: @This()) bool {
        return switch (self) {
            .legacy_read, .legacy_preservation_read, .legacy_delete => true,
            else => false,
        };
    }
};

const HarnessCustodyNativeRequest = struct {
    id: [native_sdk.bridge.max_id_bytes]u8,
    id_len: usize,
    binding: ["binding_".len + 48]u8,
    action: HarnessCustodyAction,
    deadline_unix_milliseconds: u64,
    deadline_boot_milliseconds: u64 = 0,
    deadline_admitted: bool = false,
    value: [max_harness_install_envelope_bytes]u8 = undefined,
    value_len: usize = 0,
    removal_deletion_capability: [removal_deletion_capability_hex_bytes]u8 = undefined,
    removal_operation_id: [96]u8 = undefined,
    removal_operation_id_len: usize = 0,
    removal_preview_id: [96]u8 = undefined,
    removal_preview_id_len: usize = 0,
    deletion_authorized: bool = false,

    fn idSlice(self: *const @This()) []const u8 {
        return self.id[0..self.id_len];
    }

    fn valueSlice(self: *const @This()) ?[]const u8 {
        return if (self.value_len == 0) null else self.value[0..self.value_len];
    }

    fn removalDeletionCapability(self: *const @This()) ?[]const u8 {
        return if (self.action == .delete_both)
            &self.removal_deletion_capability
        else
            null;
    }

    fn removalOperationId(self: *const @This()) ?[]const u8 {
        return if (self.removal_operation_id_len == 0)
            null
        else
            self.removal_operation_id[0..self.removal_operation_id_len];
    }

    fn removalPreviewId(self: *const @This()) ?[]const u8 {
        return if (self.removal_preview_id_len == 0)
            null
        else
            self.removal_preview_id[0..self.removal_preview_id_len];
    }
};

pub const HarnessCustodyReadState = enum {
    absent,
    present,
};

pub const HarnessCustodyValue = struct {
    state: HarnessCustodyReadState = .absent,
    value: [max_harness_install_envelope_bytes]u8 = undefined,
    value_len: usize = 0,

    fn valueSlice(self: *const @This()) ?[]const u8 {
        return if (self.state == .present)
            self.value[0..self.value_len]
        else
            null;
    }
};

const HarnessReconciliationPhase = enum {
    prepared,
    committed,

    fn text(self: @This()) []const u8 {
        return switch (self) {
            .prepared => "prepared",
            .committed => "committed",
        };
    }
};

const HarnessReconciliationLegacyState = enum {
    absent,
    present,

    fn text(self: @This()) []const u8 {
        return switch (self) {
            .absent => "absent",
            .present => "present",
        };
    }
};

const HarnessReconciliationMarker = struct {
    phase: HarnessReconciliationPhase,
    legacy_state: HarnessReconciliationLegacyState,
    envelope_state: HarnessCustodyReadState,
    envelope_sha256: [harness_reconciliation_digest_bytes]u8 = undefined,
    envelope_sha256_len: usize = 0,

    fn envelopeSHA256(self: *const @This()) ?[]const u8 {
        return if (self.envelope_sha256_len == 0)
            null
        else
            self.envelope_sha256[0..self.envelope_sha256_len];
    }
};

const HarnessReconciliationMarkerRead = union(enum) {
    absent,
    present: HarnessReconciliationMarker,
};

const HarnessCustodyHelperAction = enum {
    envelope_read,
    envelope_set_if_absent,
    envelope_delete,
    marker_read,
    marker_prepare,
    marker_commit,
    marker_delete,
};

const HarnessCustodyOperationResult = union(enum) {
    read: struct {
        value: HarnessCustodyValue,
        migrated_from_legacy: bool,
        legacy_preserved: bool,
    },
    set_if_absent: struct {
        value: HarnessCustodyValue,
        created: bool,
    },
    delete_both: struct {
        deleted_v1: bool,
        deleted_v2: bool,
    },
    failed: HarnessCustodyFailureStage,
    legacy_failed: struct {
        stage: HarnessCustodyFailureStage,
        substage: LegacyHarnessCustodyFailureSubstage,
    },
};

fn legacyHarnessCustodyFailure(
    stage: HarnessCustodyFailureStage,
    substage: LegacyHarnessCustodyFailureSubstage,
) HarnessCustodyOperationResult {
    std.debug.assert(stage.isLegacy());
    return .{ .legacy_failed = .{
        .stage = stage,
        .substage = if (substage == .none) .admission else substage,
    } };
}

fn canonicalHarnessInstallEnvelope(value: []const u8) bool {
    if (value.len == 0 or value.len > max_harness_install_envelope_bytes)
        return false;
    var scratch: [harness_custody_json_parse_scratch_bytes]u8 = undefined;
    defer secureWipe(&scratch);
    var fixed = std.heap.FixedBufferAllocator.init(&scratch);
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        fixed.allocator(),
        value,
        .{},
    ) catch return false;
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |candidate| candidate,
        else => return false,
    };
    if (object.count() != 3) return false;
    const version = switch (object.get("version") orelse return false) {
        .integer => |candidate| candidate,
        else => return false,
    };
    const algorithm = switch (object.get("algorithm") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    const key = switch (object.get("key") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    if (version != 1 or
        !std.mem.eql(u8, algorithm, "hkdf-sha256") or
        key.len != 43) return false;
    var last_index: u8 = 0;
    for (key, 0..) |byte, index| {
        const decoded: ?u8 = if (byte >= 'A' and byte <= 'Z')
            byte - 'A'
        else if (byte >= 'a' and byte <= 'z')
            byte - 'a' + 26
        else if (byte >= '0' and byte <= '9')
            byte - '0' + 52
        else if (byte == '-')
            62
        else if (byte == '_')
            63
        else
            null;
        if (decoded == null) return false;
        if (index == key.len - 1) last_index = decoded.?;
    }
    if (last_index & 0x03 != 0) return false;
    var canonical: [max_harness_install_envelope_bytes]u8 = undefined;
    defer secureWipe(&canonical);
    const encoded = std.fmt.bufPrint(
        &canonical,
        "{{\"version\":1,\"algorithm\":\"hkdf-sha256\",\"key\":\"{s}\"}}",
        .{key},
    ) catch return false;
    return std.mem.eql(u8, value, encoded);
}

fn boundedCopy(
    destination: []u8,
    value: []const u8,
) !usize {
    if (value.len == 0 or value.len > destination.len) {
        return error.InvalidAccountProfileNativeRequest;
    }
    @memcpy(destination[0..value.len], value);
    return value.len;
}

fn validPrefixedLowerHex(
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

fn generateRemovalDeletionCapability(
    io: std.Io,
) std.Io.RandomSecureError![removal_deletion_capability_hex_bytes]u8 {
    var random: [removal_deletion_capability_bytes]u8 = undefined;
    try io.randomSecure(&random);
    defer secureWipe(&random);
    return std.fmt.bytesToHex(random, .lower);
}

fn harnessCustodyDeadlineIsAdmissible(
    now_raw: i64,
    deadline_unix_milliseconds: u64,
) bool {
    if (now_raw < 0) return false;
    const now: u64 = @intCast(now_raw);
    return deadline_unix_milliseconds > now and
        deadline_unix_milliseconds - now <=
            harness_custody_native_deadline_ms;
}

fn harnessCustodyBootDeadlineFromAdmissionSamples(
    real_before_raw: i64,
    boot_now_raw: i64,
    real_after_raw: i64,
    deadline_unix_milliseconds: u64,
) ?u64 {
    if (real_before_raw < 0 or real_after_raw < 0 or boot_now_raw < 0)
        return null;
    // A backward wall-clock adjustment during admission cannot enlarge the
    // accepted duration. A forward adjustment shortens it and can reject it.
    const effective_real_raw = @max(real_before_raw, real_after_raw);
    if (!harnessCustodyDeadlineIsAdmissible(
        effective_real_raw,
        deadline_unix_milliseconds,
    )) return null;
    const effective_real: u64 = @intCast(effective_real_raw);
    const boot_now: u64 = @intCast(boot_now_raw);
    const remaining = deadline_unix_milliseconds - effective_real;
    return std.math.add(u64, boot_now, remaining) catch null;
}

fn canonicalPositiveDecimal(value: []const u8) ?u64 {
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

fn parseAccountProfileNativeRequest(
    allocator: std.mem.Allocator,
    line: []const u8,
) !AccountProfileNativeRequest {
    var parsed =
        std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch
            return error.InvalidAccountProfileNativeRequest;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    if (outer.count() != 3) {
        return error.InvalidAccountProfileNativeRequest;
    }
    const kind = switch (outer.get("kind") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const version = switch (outer.get("version") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .integer => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const request = switch (outer.get("request") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .object => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    if (version != 1 or
        !std.mem.eql(u8, kind, account_profile_native_request_kind))
    {
        return error.InvalidAccountProfileNativeRequest;
    }

    const id = switch (request.get("id") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const binding = switch (request.get("binding") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const action_text = switch (request.get("action") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const action: AccountProfileAction =
        if (std.mem.eql(u8, action_text, "ensure"))
            .ensure
        else if (std.mem.eql(u8, action_text, "delete"))
            .delete
        else
            return error.InvalidAccountProfileNativeRequest;
    const control_plane_path = switch (request.get("controlPlanePath") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const account_profile_id = switch (request.get("accountProfileId") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const state_root_device = switch (request.get("stateRootDevice") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const state_root_inode = switch (request.get("stateRootInode") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const control_plane_device = switch (request.get("controlPlaneDevice") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    const control_plane_inode = switch (request.get("controlPlaneInode") orelse
        return error.InvalidAccountProfileNativeRequest) {
        .string => |value| value,
        else => return error.InvalidAccountProfileNativeRequest,
    };
    if (!validPrefixedLowerHex(id, "native-profile-", 24) or
        !validPrefixedLowerHex(binding, "binding_", 48) or
        !opaqueId(account_profile_id, "acct") or
        canonicalPositiveDecimal(state_root_device) == null or
        canonicalPositiveDecimal(state_root_inode) == null or
        canonicalPositiveDecimal(control_plane_device) == null or
        canonicalPositiveDecimal(control_plane_inode) == null)
    {
        return error.InvalidAccountProfileNativeRequest;
    }
    try exactRemovalPath(allocator, control_plane_path);

    const deletion_nonce_value = request.get("deletionNonce");
    const expected_revision_value = request.get("expectedRevision");
    const expected_count: usize = if (action == .delete) 11 else 9;
    if (request.count() != expected_count) {
        return error.InvalidAccountProfileNativeRequest;
    }
    var result: AccountProfileNativeRequest = .{
        .id = undefined,
        .id_len = id.len,
        .binding = undefined,
        .action = action,
        .control_plane_path = undefined,
        .control_plane_path_len = control_plane_path.len,
        .account_profile_id = undefined,
        .account_profile_id_len = account_profile_id.len,
        .state_root_device = undefined,
        .state_root_device_len = state_root_device.len,
        .state_root_inode = undefined,
        .state_root_inode_len = state_root_inode.len,
        .control_plane_device = undefined,
        .control_plane_device_len = control_plane_device.len,
        .control_plane_inode = undefined,
        .control_plane_inode_len = control_plane_inode.len,
    };
    _ = try boundedCopy(&result.id, id);
    _ = try boundedCopy(&result.binding, binding);
    _ = try boundedCopy(&result.control_plane_path, control_plane_path);
    _ = try boundedCopy(&result.account_profile_id, account_profile_id);
    _ = try boundedCopy(&result.state_root_device, state_root_device);
    _ = try boundedCopy(&result.state_root_inode, state_root_inode);
    _ = try boundedCopy(
        &result.control_plane_device,
        control_plane_device,
    );
    _ = try boundedCopy(&result.control_plane_inode, control_plane_inode);

    switch (action) {
        .ensure => {
            if (deletion_nonce_value != null or
                expected_revision_value != null)
            {
                return error.InvalidAccountProfileNativeRequest;
            }
        },
        .delete => {
            const deletion_nonce = switch (deletion_nonce_value orelse
                return error.InvalidAccountProfileNativeRequest) {
                .string => |value| value,
                else => return error.InvalidAccountProfileNativeRequest,
            };
            if (!validPrefixedLowerHex(
                deletion_nonce,
                "deletion_",
                64,
            )) return error.InvalidAccountProfileNativeRequest;
            result.deletion_nonce_len =
                try boundedCopy(&result.deletion_nonce, deletion_nonce);
            const expected_revision = switch (expected_revision_value orelse
                return error.InvalidAccountProfileNativeRequest) {
                .integer => |value| value,
                else => return error.InvalidAccountProfileNativeRequest,
            };
            if (expected_revision <= 0 or
                expected_revision > 9_007_199_254_740_991)
            {
                return error.InvalidAccountProfileNativeRequest;
            }
            result.expected_revision = @intCast(expected_revision);
        },
    }
    return result;
}

fn parseHarnessCustodyNativeRequest(
    line: []const u8,
) !HarnessCustodyNativeRequest {
    if (line.len == 0 or line.len > max_harness_custody_native_request_bytes)
        return error.InvalidHarnessCustodyNativeRequest;
    var scratch: [harness_custody_parse_scratch_bytes]u8 = undefined;
    defer secureWipe(&scratch);
    var fixed = std.heap.FixedBufferAllocator.init(&scratch);
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        fixed.allocator(),
        line,
        .{},
    ) catch return error.InvalidHarnessCustodyNativeRequest;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    if (outer.count() != 3) return error.InvalidHarnessCustodyNativeRequest;
    const kind = switch (outer.get("kind") orelse
        return error.InvalidHarnessCustodyNativeRequest) {
        .string => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    const version = switch (outer.get("version") orelse
        return error.InvalidHarnessCustodyNativeRequest) {
        .integer => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    const request = switch (outer.get("request") orelse
        return error.InvalidHarnessCustodyNativeRequest) {
        .object => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    if (version != 1 or !std.mem.eql(
        u8,
        kind,
        harness_custody_native_request_kind,
    )) return error.InvalidHarnessCustodyNativeRequest;
    const id = switch (request.get("id") orelse
        return error.InvalidHarnessCustodyNativeRequest) {
        .string => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    const binding = switch (request.get("binding") orelse
        return error.InvalidHarnessCustodyNativeRequest) {
        .string => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    const action_text = switch (request.get("action") orelse
        return error.InvalidHarnessCustodyNativeRequest) {
        .string => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    const action: HarnessCustodyAction =
        if (std.mem.eql(u8, action_text, "read"))
            .read
        else if (std.mem.eql(u8, action_text, "setIfAbsent"))
            .set_if_absent
        else if (std.mem.eql(u8, action_text, "deleteBoth"))
            .delete_both
        else
            return error.InvalidHarnessCustodyNativeRequest;
    const deadline_unix_milliseconds = switch (request.get(
        "deadlineUnixMilliseconds",
    ) orelse return error.InvalidHarnessCustodyNativeRequest) {
        .integer => |value| value,
        else => return error.InvalidHarnessCustodyNativeRequest,
    };
    const expected_request_fields: usize = switch (action) {
        .read => 4,
        .set_if_absent => 5,
        .delete_both => 7,
    };
    if (!validPrefixedLowerHex(id, "native-harness-", 24) or
        !validPrefixedLowerHex(binding, "binding_", 48) or
        deadline_unix_milliseconds <= 0 or
        deadline_unix_milliseconds > 9_007_199_254_740_991 or
        request.count() != expected_request_fields)
    {
        return error.InvalidHarnessCustodyNativeRequest;
    }
    var result: HarnessCustodyNativeRequest = .{
        .id = undefined,
        .id_len = id.len,
        .binding = undefined,
        .action = action,
        .deadline_unix_milliseconds = @intCast(deadline_unix_milliseconds),
    };
    defer {
        secureWipe(&result.value);
        secureWipe(&result.removal_deletion_capability);
        secureWipe(&result.removal_operation_id);
        secureWipe(&result.removal_preview_id);
    }
    _ = try boundedCopy(&result.id, id);
    _ = try boundedCopy(&result.binding, binding);
    switch (action) {
        .read => {
            if (request.get("value") != null or
                request.get("removalCapability") != null or
                request.get("operationId") != null or
                request.get("previewId") != null)
            {
                return error.InvalidHarnessCustodyNativeRequest;
            }
        },
        .set_if_absent => {
            const value = switch (request.get("value") orelse
                return error.InvalidHarnessCustodyNativeRequest) {
                .string => |candidate| candidate,
                else => return error.InvalidHarnessCustodyNativeRequest,
            };
            if (!canonicalHarnessInstallEnvelope(value) or
                request.get("removalCapability") != null or
                request.get("operationId") != null or
                request.get("previewId") != null)
            {
                return error.InvalidHarnessCustodyNativeRequest;
            }
            result.value_len = try boundedCopy(&result.value, value);
        },
        .delete_both => {
            if (request.get("value") != null) {
                return error.InvalidHarnessCustodyNativeRequest;
            }
            const capability = switch (request.get("removalCapability") orelse
                return error.InvalidHarnessCustodyNativeRequest) {
                .string => |candidate| candidate,
                else => return error.InvalidHarnessCustodyNativeRequest,
            };
            const operation_id = switch (request.get("operationId") orelse
                return error.InvalidHarnessCustodyNativeRequest) {
                .string => |candidate| candidate,
                else => return error.InvalidHarnessCustodyNativeRequest,
            };
            const preview_id = switch (request.get("previewId") orelse
                return error.InvalidHarnessCustodyNativeRequest) {
                .string => |candidate| candidate,
                else => return error.InvalidHarnessCustodyNativeRequest,
            };
            if (!validPrefixedLowerHex(
                capability,
                "",
                removal_deletion_capability_hex_bytes,
            ) or !opaqueId(operation_id, "op") or
                !opaqueId(preview_id, "removal"))
            {
                return error.InvalidHarnessCustodyNativeRequest;
            }
            _ = try boundedCopy(
                &result.removal_deletion_capability,
                capability,
            );
            result.removal_operation_id_len = try boundedCopy(
                &result.removal_operation_id,
                operation_id,
            );
            result.removal_preview_id_len = try boundedCopy(
                &result.removal_preview_id,
                preview_id,
            );
        },
    }
    return result;
}

const state_recoverable_event_types = [_][]const u8{
    "runtime.changed",
    "execution.changed",
    "runner.changed",
    "account.upserted",
    "account.removed",
    "chat.pane.upserted",
    "chat.pane.stateChanged",
    "chat.pane.removed",
    "chat.panes.reordered",
    "chat.turn.delta",
    "chat.messageQueue.changed",
    "accountLocalData.upserted",
    "accountLocalData.removed",
    "humanAccount.changed",
    "sessionSync.statusChanged",
    "sessionSync.localGrid.changed",
    "sessionSync.remote.upserted",
    "sessionSync.remote.removed",
    "sessionSync.remote.cleared",
    "snapshot.invalidated",
};

const transient_exact_event_types = [_][]const u8{
    "operation.completed",
    "task.invalidated",
};

fn eventRecovery(event_type: []const u8) ?EventRecovery {
    for (transient_exact_event_types) |candidate| {
        if (std.mem.eql(u8, event_type, candidate)) return .protected;
    }
    for (state_recoverable_event_types) |candidate| {
        if (std.mem.eql(u8, event_type, candidate)) return .snapshot_recoverable;
    }
    return null;
}

/// Validates and distinguishes gateway output without changing the bytes that
/// will later be delivered to Native SDK or the renderer.
pub fn classifyLine(allocator: std.mem.Allocator, line: []const u8) !LineKind {
    if (line.len == 0 or line.len > native_sdk.bridge.max_response_bytes) return error.InvalidGatewayLine;
    var parsed = std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch return error.InvalidGatewayLine;
    defer parsed.deinit();

    const object = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidGatewayLine,
    };

    const id_value = object.get("id");
    const ok_value = object.get("ok");
    const event_value = object.get("event");
    const sequence_value = object.get("sequence");
    const kind_value = object.get("kind");

    if (kind_value) |raw_kind| {
        if (id_value != null or ok_value != null or event_value != null or
            sequence_value != null or object.count() != 3)
        {
            return error.InvalidGatewayLine;
        }
        const kind = switch (raw_kind) {
            .string => |value| value,
            else => return error.InvalidGatewayLine,
        };
        const version = switch (object.get("version") orelse
            return error.InvalidGatewayLine) {
            .integer => |value| value,
            else => return error.InvalidGatewayLine,
        };
        if (version != 1 or object.get("request") == null) {
            return error.InvalidGatewayLine;
        }
        if (std.mem.eql(
            u8,
            kind,
            account_profile_native_request_kind,
        )) return .account_profile_request;
        if (std.mem.eql(
            u8,
            kind,
            harness_custody_native_request_kind,
        )) return .harness_custody_request;
        return error.InvalidGatewayLine;
    }

    if (id_value != null or ok_value != null) {
        if (event_value != null or sequence_value != null) return error.InvalidGatewayLine;
        const id = switch (id_value orelse return error.InvalidGatewayLine) {
            .string => |value| value,
            else => return error.InvalidGatewayLine,
        };
        const ok = switch (ok_value orelse return error.InvalidGatewayLine) {
            .bool => |value| value,
            else => return error.InvalidGatewayLine,
        };
        if (!validRequestId(id)) return error.InvalidGatewayLine;
        if (ok) {
            if (object.get("result") == null or object.get("error") != null) return error.InvalidGatewayLine;
        } else {
            if (object.get("error") == null or object.get("result") != null) return error.InvalidGatewayLine;
        }

        var result: LineKind = .{ .response = .{
            .id = undefined,
            .id_len = id.len,
            .ok = ok,
        } };
        @memcpy(result.response.id[0..id.len], id);
        return result;
    }

    const event = switch (event_value orelse return error.InvalidGatewayLine) {
        .object => |value| value,
        else => return error.InvalidGatewayLine,
    };
    const event_type = switch (event.get("type") orelse return error.InvalidGatewayLine) {
        .string => |value| value,
        else => return error.InvalidGatewayLine,
    };
    const recovery = eventRecovery(event_type) orelse return error.InvalidGatewayLine;
    const version = switch (object.get("version") orelse
        return error.InvalidGatewayLine) {
        .integer => |value| value,
        else => return error.InvalidGatewayLine,
    };
    const sequence = switch (sequence_value orelse return error.InvalidGatewayLine) {
        .integer => |value| value,
        else => return error.InvalidGatewayLine,
    };
    if (version != runtime_protocol_version or object.count() != 3 or
        sequence <= 0 or line.len > native_sdk.platform.max_window_event_detail_bytes)
    {
        return error.InvalidGatewayLine;
    }
    return .{ .event = .{
        .sequence = @intCast(sequence),
        .recovery = recovery,
    } };
}

const RemovalLaunchEnvelope = struct {
    correlation: RemovalCorrelation,
    request_path: [max_removal_path_bytes]u8,
    request_path_len: usize,
    signing_key_path: [max_removal_path_bytes]u8,
    signing_key_path_len: usize,

    fn requestPath(self: *const RemovalLaunchEnvelope) []const u8 {
        return self.request_path[0..self.request_path_len];
    }

    fn signingKeyPath(self: *const RemovalLaunchEnvelope) []const u8 {
        return self.signing_key_path[0..self.signing_key_path_len];
    }
};

fn exactRemovalPath(
    allocator: std.mem.Allocator,
    value: []const u8,
) !void {
    if (value.len == 0 or
        value.len > max_removal_path_bytes or
        !std.fs.path.isAbsolute(value) or
        std.mem.indexOfScalar(u8, value, 0) != null) return error.InvalidRemovalLaunchEnvelope;
    const normalized =
        std.fs.path.resolve(allocator, &.{value}) catch
            return error.InvalidRemovalLaunchEnvelope;
    defer allocator.free(normalized);
    if (!std.mem.eql(u8, normalized, value)) {
        return error.InvalidRemovalLaunchEnvelope;
    }
}

fn parseRemovalLaunchEnvelope(
    allocator: std.mem.Allocator,
    line: []const u8,
    expected_id: []const u8,
    expected_correlation: ?*const RemovalCorrelation,
    expected_parent_process_id: u32,
) !?RemovalLaunchEnvelope {
    var parsed =
        std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch
            return error.InvalidRemovalLaunchEnvelope;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const outer_id = switch (outer.get("id") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const outer_ok = switch (outer.get("ok") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .bool => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    if (!outer_ok) return null;
    const envelope = switch (outer.get("result") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .object => |value| value,
        else => return null,
    };
    const kind = switch (envelope.get("kind") orelse return null) {
        .string => |value| value,
        else => return null,
    };
    if (!std.mem.eql(u8, kind, local_data_removal_launch_kind)) {
        return null;
    }
    if (outer.count() != 3 or
        !std.mem.eql(u8, outer_id, expected_id) or
        envelope.count() != 8) return error.InvalidRemovalLaunchEnvelope;

    const version = switch (envelope.get("version") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .integer => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const operation_id = switch (envelope.get("operationId") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const preview_id = switch (envelope.get("previewId") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const parent_process_id = switch (envelope.get("parentProcessId") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .integer => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const request_path = switch (envelope.get("requestPath") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const signing_key_path = switch (envelope.get("signingKeyPath") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    if (version != 1 or
        !opaqueId(operation_id, "op") or
        !opaqueId(preview_id, "removal") or
        parent_process_id != expected_parent_process_id) return error.InvalidRemovalLaunchEnvelope;
    if (expected_correlation) |correlation| {
        if (!std.mem.eql(
            u8,
            operation_id,
            correlation.operationId(),
        ) or
            !std.mem.eql(
                u8,
                preview_id,
                correlation.previewId(),
            ))
        {
            return error.InvalidRemovalLaunchEnvelope;
        }
    }

    const public_response = switch (envelope.get("publicResponse") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .object => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    if (public_response.count() != 4) {
        return error.InvalidRemovalLaunchEnvelope;
    }
    const public_version = switch (public_response.get("version") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .integer => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const public_operation_id = switch (public_response.get("operationId") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const public_ok = switch (public_response.get("ok") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .bool => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const public_result = switch (public_response.get("result") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .object => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    if (public_version != runtime_protocol_version or
        !public_ok or
        !std.mem.eql(
            u8,
            public_operation_id,
            operation_id,
        ) or
        public_result.count() != 4) return error.InvalidRemovalLaunchEnvelope;
    const result_type = switch (public_result.get("type") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const public_preview_id = switch (public_result.get("previewId") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const state = switch (public_result.get("state") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .string => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    const will_quit = switch (public_result.get("willQuitApplication") orelse
        return error.InvalidRemovalLaunchEnvelope) {
        .bool => |value| value,
        else => return error.InvalidRemovalLaunchEnvelope,
    };
    if (!std.mem.eql(u8, result_type, "localDataRemovalScheduled") or
        !std.mem.eql(u8, public_preview_id, preview_id) or
        !std.mem.eql(u8, state, "scheduled") or
        !will_quit) return error.InvalidRemovalLaunchEnvelope;

    try exactRemovalPath(allocator, request_path);
    try exactRemovalPath(allocator, signing_key_path);
    const helper_root =
        std.fs.path.dirname(signing_key_path) orelse
        return error.InvalidRemovalLaunchEnvelope;
    if (!std.mem.eql(
        u8,
        std.fs.path.basename(signing_key_path),
        "removal-signing.key",
    )) return error.InvalidRemovalLaunchEnvelope;
    const requests_root =
        std.fs.path.dirname(request_path) orelse
        return error.InvalidRemovalLaunchEnvelope;
    if (!std.mem.eql(
        u8,
        std.fs.path.basename(requests_root),
        "requests",
    ) or
        !std.mem.eql(
            u8,
            std.fs.path.dirname(requests_root) orelse "",
            helper_root,
        )) return error.InvalidRemovalLaunchEnvelope;
    var expected_request_name_buffer: [102]u8 = undefined;
    const expected_request_name = try std.fmt.bufPrint(
        &expected_request_name_buffer,
        "{s}.json",
        .{operation_id},
    );
    if (!std.mem.eql(
        u8,
        std.fs.path.basename(request_path),
        expected_request_name,
    )) return error.InvalidRemovalLaunchEnvelope;

    var result: RemovalLaunchEnvelope = .{
        .correlation = .{
            .operation_id = undefined,
            .operation_id_len = operation_id.len,
            .preview_id = undefined,
            .preview_id_len = preview_id.len,
        },
        .request_path = undefined,
        .request_path_len = request_path.len,
        .signing_key_path = undefined,
        .signing_key_path_len = signing_key_path.len,
    };
    @memcpy(
        result.correlation.operation_id[0..operation_id.len],
        operation_id,
    );
    @memcpy(
        result.correlation.preview_id[0..preview_id.len],
        preview_id,
    );
    @memcpy(
        result.request_path[0..request_path.len],
        request_path,
    );
    @memcpy(
        result.signing_key_path[0..signing_key_path.len],
        signing_key_path,
    );
    return result;
}

const RemovalRecoveryState = enum {
    clear,
    active,
};

const RemovalTerminationRequired = struct {
    correlation: RemovalCorrelation,
    code: [64]u8,
    code_len: usize,
    message: [500]u8,
    message_len: usize,
    retryable: bool,
    action: [32]u8,
    action_len: usize,

    fn codeSlice(self: *const @This()) []const u8 {
        return self.code[0..self.code_len];
    }

    fn messageSlice(self: *const @This()) []const u8 {
        return self.message[0..self.message_len];
    }

    fn actionSlice(self: *const @This()) []const u8 {
        return self.action[0..self.action_len];
    }
};

fn parseRemovalTerminationRequired(
    allocator: std.mem.Allocator,
    line: []const u8,
    expected_id: []const u8,
    expected_correlation: ?*const RemovalCorrelation,
) !?RemovalTerminationRequired {
    var parsed =
        std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch
            return error.InvalidRemovalTerminationRequired;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return null,
    };
    const result = switch (outer.get("result") orelse return null) {
        .object => |value| value,
        else => return null,
    };
    const kind = switch (result.get("kind") orelse return null) {
        .string => |value| value,
        else => return null,
    };
    if (!std.mem.eql(
        u8,
        kind,
        local_data_removal_termination_required_kind,
    )) return null;

    const id = switch (outer.get("id") orelse
        return error.InvalidRemovalTerminationRequired) {
        .string => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const outer_ok = switch (outer.get("ok") orelse
        return error.InvalidRemovalTerminationRequired) {
        .bool => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    if (outer.count() != 3 or
        !outer_ok or
        !std.mem.eql(u8, id, expected_id) or
        result.count() != 3)
    {
        return error.InvalidRemovalTerminationRequired;
    }
    const version = switch (result.get("version") orelse
        return error.InvalidRemovalTerminationRequired) {
        .integer => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const public_response = switch (result.get("publicResponse") orelse
        return error.InvalidRemovalTerminationRequired) {
        .object => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    if (version != 1 or public_response.count() != 4) {
        return error.InvalidRemovalTerminationRequired;
    }
    const public_version = switch (public_response.get("version") orelse
        return error.InvalidRemovalTerminationRequired) {
        .integer => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const operation_id = switch (public_response.get("operationId") orelse
        return error.InvalidRemovalTerminationRequired) {
        .string => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const public_ok = switch (public_response.get("ok") orelse
        return error.InvalidRemovalTerminationRequired) {
        .bool => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    if (public_version != runtime_protocol_version or !opaqueId(operation_id, "op")) {
        return error.InvalidRemovalTerminationRequired;
    }
    if (expected_correlation) |correlation| {
        if (!std.mem.eql(
            u8,
            operation_id,
            correlation.operationId(),
        )) return error.InvalidRemovalTerminationRequired;
    }

    var output: RemovalTerminationRequired = .{
        .correlation = .{
            .operation_id = undefined,
            .operation_id_len = operation_id.len,
            .preview_id = undefined,
            .preview_id_len = 0,
        },
        .code = undefined,
        .code_len = 0,
        .message = undefined,
        .message_len = 0,
        .retryable = false,
        .action = undefined,
        .action_len = 0,
    };
    @memcpy(
        output.correlation.operation_id[0..operation_id.len],
        operation_id,
    );
    if (public_ok) return error.InvalidRemovalTerminationRequired;
    const runtime_error = switch (public_response.get("error") orelse
        return error.InvalidRemovalTerminationRequired) {
        .object => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    if (runtime_error.count() != 4) {
        return error.InvalidRemovalTerminationRequired;
    }
    const code = switch (runtime_error.get("code") orelse
        return error.InvalidRemovalTerminationRequired) {
        .string => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const message = switch (runtime_error.get("message") orelse
        return error.InvalidRemovalTerminationRequired) {
        .string => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const retryable = switch (runtime_error.get("retryable") orelse
        return error.InvalidRemovalTerminationRequired) {
        .bool => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const action = switch (runtime_error.get("action") orelse
        return error.InvalidRemovalTerminationRequired) {
        .string => |value| value,
        else => return error.InvalidRemovalTerminationRequired,
    };
    const allowed_codes = [_][]const u8{
        "invalid_request",
        "runtime_unavailable",
        "not_found",
        "conflict",
        "stale_revision",
        "policy_denied",
        "capability_unavailable",
        "protocol_error",
        "upstream_ambiguous",
        "not_implemented",
        "operation_failed",
        "authority_mismatch",
        "revision_conflict",
        "invalid_state",
        "graph_cycle",
        "graph_limit",
        "terminal",
        "capacity_full",
        "operation_conflict",
    };
    const allowed_actions = [_][]const u8{
        "none",
        "retry",
        "restartRuntime",
        "signIn",
        "resolveAttention",
    };
    if (message.len == 0 or
        message.len > 500 or
        code.len > output.code.len or
        action.len > output.action.len or
        !stringInSet(code, &allowed_codes) or
        !stringInSet(action, &allowed_actions))
    {
        return error.InvalidRemovalTerminationRequired;
    }
    output.code_len = code.len;
    @memcpy(output.code[0..code.len], code);
    output.message_len = message.len;
    @memcpy(output.message[0..message.len], message);
    output.retryable = retryable;
    output.action_len = action.len;
    @memcpy(output.action[0..action.len], action);
    return output;
}

fn parseRemovalRecoveryResult(
    allocator: std.mem.Allocator,
    line: []const u8,
    expected_id: []const u8,
) !?RemovalRecoveryState {
    var parsed =
        std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch
            return error.InvalidRemovalRecoveryResult;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    const id = switch (outer.get("id") orelse
        return error.InvalidRemovalRecoveryResult) {
        .string => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    const ok = switch (outer.get("ok") orelse
        return error.InvalidRemovalRecoveryResult) {
        .bool => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    if (outer.count() != 3 or
        !std.mem.eql(u8, id, expected_id) or
        !ok) return error.InvalidRemovalRecoveryResult;
    const result = switch (outer.get("result") orelse
        return error.InvalidRemovalRecoveryResult) {
        .object => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    const kind = switch (result.get("kind") orelse
        return error.InvalidRemovalRecoveryResult) {
        .string => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    if (std.mem.eql(u8, kind, local_data_removal_launch_kind)) {
        return null;
    }
    if (!std.mem.eql(
        u8,
        kind,
        "localDataRemovalRecoveryResult",
    ) or
        result.count() != 4)
    {
        return error.InvalidRemovalRecoveryResult;
    }
    const version = switch (result.get("version") orelse
        return error.InvalidRemovalRecoveryResult) {
        .integer => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    const state = switch (result.get("state") orelse
        return error.InvalidRemovalRecoveryResult) {
        .string => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    const recovered_count = switch (result.get("recoveredOperationCount") orelse
        return error.InvalidRemovalRecoveryResult) {
        .integer => |value| value,
        else => return error.InvalidRemovalRecoveryResult,
    };
    if (version != 1 or
        recovered_count < 0 or
        recovered_count > 9_007_199_254_740_991)
    {
        return error.InvalidRemovalRecoveryResult;
    }
    if (std.mem.eql(u8, state, "clear")) return .clear;
    if (std.mem.eql(u8, state, "active")) return .active;
    return error.InvalidRemovalRecoveryResult;
}

fn encodePublicRemovalResponse(
    allocator: std.mem.Allocator,
    id: []const u8,
    correlation: *const RemovalCorrelation,
) std.mem.Allocator.Error![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    output.writer.writeAll("{\"id\":") catch return error.OutOfMemory;
    std.json.Stringify.value(id, .{}, &output.writer) catch
        return error.OutOfMemory;
    output.writer.writeAll(
        ",\"ok\":true,\"result\":{\"version\":3,\"operationId\":",
    ) catch return error.OutOfMemory;
    std.json.Stringify.value(
        correlation.operationId(),
        .{},
        &output.writer,
    ) catch return error.OutOfMemory;
    output.writer.writeAll(
        ",\"ok\":true,\"result\":{\"type\":" ++
            "\"localDataRemovalScheduled\",\"previewId\":",
    ) catch return error.OutOfMemory;
    std.json.Stringify.value(
        correlation.previewId(),
        .{},
        &output.writer,
    ) catch return error.OutOfMemory;
    output.writer.writeAll(
        ",\"state\":\"scheduled\",\"willQuitApplication\":true}}}",
    ) catch return error.OutOfMemory;
    return output.toOwnedSlice();
}

fn encodePublicRemovalFailure(
    allocator: std.mem.Allocator,
    id: []const u8,
    correlation: *const RemovalCorrelation,
) std.mem.Allocator.Error![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    output.writer.writeAll("{\"id\":") catch return error.OutOfMemory;
    std.json.Stringify.value(id, .{}, &output.writer) catch
        return error.OutOfMemory;
    output.writer.writeAll(
        ",\"ok\":true,\"result\":{\"version\":3,\"operationId\":",
    ) catch return error.OutOfMemory;
    std.json.Stringify.value(
        correlation.operationId(),
        .{},
        &output.writer,
    ) catch return error.OutOfMemory;
    output.writer.writeAll(
        ",\"ok\":false,\"error\":{\"code\":\"operation_failed\"," ++
            "\"message\":\"HRA could not remove local data.\"," ++
            "\"retryable\":false,\"action\":\"none\"}}}",
    ) catch return error.OutOfMemory;
    return output.toOwnedSlice();
}

fn encodePublicTerminationRequiredResponse(
    allocator: std.mem.Allocator,
    id: []const u8,
    required: *const RemovalTerminationRequired,
) std.mem.Allocator.Error![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    output.writer.writeAll("{\"id\":") catch return error.OutOfMemory;
    std.json.Stringify.value(id, .{}, &output.writer) catch
        return error.OutOfMemory;
    output.writer.writeAll(
        ",\"ok\":true,\"result\":{\"version\":3,\"operationId\":",
    ) catch return error.OutOfMemory;
    std.json.Stringify.value(
        required.correlation.operationId(),
        .{},
        &output.writer,
    ) catch return error.OutOfMemory;
    output.writer.writeAll(
        ",\"ok\":false,\"error\":{\"code\":",
    ) catch return error.OutOfMemory;
    std.json.Stringify.value(
        required.codeSlice(),
        .{},
        &output.writer,
    ) catch return error.OutOfMemory;
    output.writer.writeAll(",\"message\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(
        required.messageSlice(),
        .{},
        &output.writer,
    ) catch return error.OutOfMemory;
    output.writer.writeAll(",\"retryable\":") catch
        return error.OutOfMemory;
    output.writer.writeAll(if (required.retryable) "true" else "false") catch
        return error.OutOfMemory;
    output.writer.writeAll(",\"action\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(
        required.actionSlice(),
        .{},
        &output.writer,
    ) catch return error.OutOfMemory;
    output.writer.writeAll("}}}") catch return error.OutOfMemory;
    return output.toOwnedSlice();
}

fn validatePublicRemovalFailure(
    allocator: std.mem.Allocator,
    line: []const u8,
    expected_id: []const u8,
    correlation: *const RemovalCorrelation,
) bool {
    var parsed =
        std.json.parseFromSlice(std.json.Value, allocator, line, .{}) catch
            return false;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return false,
    };
    const id = switch (outer.get("id") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const ok = switch (outer.get("ok") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    if (!std.mem.eql(u8, id, expected_id) or outer.count() != 3) {
        return false;
    }
    if (!ok) {
        const host_error = switch (outer.get("error") orelse return false) {
            .object => |value| value,
            else => return false,
        };
        const code = switch (host_error.get("code") orelse return false) {
            .string => |value| value,
            else => return false,
        };
        const message = switch (host_error.get("message") orelse return false) {
            .string => |value| value,
            else => return false,
        };
        return host_error.count() == 2 and
            (std.mem.eql(u8, code, "invalid_request") or
                std.mem.eql(u8, code, "internal_error")) and
            message.len > 0 and message.len <= 240;
    }
    const response = switch (outer.get("result") orelse return false) {
        .object => |value| value,
        else => return false,
    };
    if (response.count() != 4) return false;
    const version = switch (response.get("version") orelse return false) {
        .integer => |value| value,
        else => return false,
    };
    const operation_id = switch (response.get("operationId") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const response_ok = switch (response.get("ok") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    const runtime_error = switch (response.get("error") orelse return false) {
        .object => |value| value,
        else => return false,
    };
    if (version != runtime_protocol_version or response_ok or
        !std.mem.eql(
            u8,
            operation_id,
            correlation.operationId(),
        ) or
        runtime_error.count() != 4) return false;
    const code = switch (runtime_error.get("code") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const message = switch (runtime_error.get("message") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    _ = switch (runtime_error.get("retryable") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    const action = switch (runtime_error.get("action") orelse return false) {
        .string => |value| value,
        else => return false,
    };
    const allowed_codes = [_][]const u8{
        "invalid_request",
        "conflict",
        "operation_conflict",
        "operation_failed",
        "runtime_unavailable",
    };
    const allowed_actions = [_][]const u8{
        "none",
        "retry",
        "restartRuntime",
        "resolveAttention",
    };
    return message.len > 0 and message.len <= 240 and
        stringInSet(code, &allowed_codes) and
        stringInSet(action, &allowed_actions);
}

fn stringInSet(
    value: []const u8,
    candidates: []const []const u8,
) bool {
    for (candidates) |candidate| {
        if (std.mem.eql(u8, value, candidate)) return true;
    }
    return false;
}

fn encodeProjectionOverflowEvent(allocator: std.mem.Allocator, sequence: u64) std.mem.Allocator.Error![]u8 {
    var buffer: [160]u8 = undefined;
    const encoded = std.fmt.bufPrint(
        &buffer,
        "{{\"version\":3,\"sequence\":{d},\"event\":{{\"type\":\"snapshot.invalidated\",\"reason\":\"projectionOverflow\"}}}}",
        .{sequence},
    ) catch unreachable;
    std.debug.assert(encoded.len <= native_sdk.platform.max_window_event_detail_bytes);
    return allocator.dupe(u8, encoded);
}

pub const Options = struct {
    paths: PathOptions = .{},
    bridge_profile: BridgeProfile = .production,
    /// Gateway storage/cloud classification. When omitted it follows the
    /// renderer bridge profile; raw Debug hosts set it explicitly so bundled
    /// UI launches remain cloud-detached without opening the Vite origin.
    runtime_profile: ?BridgeProfile = null,
    production_cloud: ?PublicCloudConfiguration = null,
    shutdown_grace_ms: u16 = 500,
    directory_picker: ?DirectoryPicker = null,
    removal_lifecycle: ?RemovalLifecycle = null,
    account_profile_runner: ?AccountProfileOperationRunner = null,
    harness_custody_runner: ?HarnessCustodyHelperRunner = null,
    legacy_harness_custody_runner: ?LegacyHarnessCustodyRunner = null,
    startup_removal_recovery: bool = false,
    max_recovery_attempts: u8 = default_max_recovery_attempts,
    recovery_backoff_ms: u16 = default_recovery_backoff_ms,
};

fn resolvedRuntimeProfile(options: *const Options) BridgeProfile {
    return options.runtime_profile orelse options.bridge_profile;
}

pub const HarnessCustodyHelperResult = union(enum) {
    envelope_read: HarnessCustodyValue,
    envelope_set_if_absent: struct {
        value: HarnessCustodyValue,
        created: bool,
    },
    envelope_delete: bool,
    marker_read: HarnessReconciliationMarkerRead,
    marker_write: HarnessReconciliationMarker,
    marker_delete: bool,
};

pub const HarnessCustodyHelperRunner = struct {
    context: ?*anyopaque,
    run_fn: *const fn (
        context: ?*anyopaque,
        helper_path: []const u8,
        action: HarnessCustodyHelperAction,
        value: ?[]const u8,
        timeout_milliseconds: u32,
        output: *HarnessCustodyHelperResult,
    ) bool,
    cancel_fn: *const fn (context: ?*anyopaque) void,
};

pub const LegacyHarnessCustodyRunner = struct {
    context: ?*anyopaque,
    read_fn: *const fn (
        context: ?*anyopaque,
        gateway_path: []const u8,
        timeout_milliseconds: u32,
        output: *HarnessCustodyValue,
        failure_substage: *LegacyHarnessCustodyFailureSubstage,
    ) bool,
    delete_fn: *const fn (
        context: ?*anyopaque,
        gateway_path: []const u8,
        timeout_milliseconds: u32,
        deleted: *bool,
        failure_substage: *LegacyHarnessCustodyFailureSubstage,
    ) bool,
    cancel_fn: *const fn (context: ?*anyopaque) void,
};

pub const AccountProfileOperationRunner = struct {
    context: ?*anyopaque,
    run_fn: *const fn (
        context: ?*anyopaque,
        helper_path: []const u8,
        action: []const u8,
        control_plane_path: []const u8,
        account_profile_id: []const u8,
        state_root_device: []const u8,
        state_root_inode: []const u8,
        control_plane_device: []const u8,
        control_plane_inode: []const u8,
        deletion_nonce: ?[]const u8,
        expected_revision: u64,
    ) bool,
    cancel_fn: *const fn (context: ?*anyopaque) void,
};

pub const RemovalLifecycle = struct {
    context: ?*anyopaque,
    prepare_fn: *const fn (
        context: ?*anyopaque,
        helper_path: []const u8,
        mode: RemovalPreparation,
    ) bool,
    rollback_fn: *const fn (context: ?*anyopaque) void,
    spawn_fn: *const fn (
        context: ?*anyopaque,
        allocator: std.mem.Allocator,
        io: std.Io,
        helper_path: []const u8,
        request_path: []const u8,
        signing_key_path: []const u8,
        parent_process_id: u32,
    ) anyerror!void,
    recover_staged_fn: *const fn (
        context: ?*anyopaque,
        allocator: std.mem.Allocator,
        io: std.Io,
        helper_path: []const u8,
        helper_state_root: []const u8,
    ) anyerror!void,
    arm_termination_watchdog_fn: *const fn (
        context: ?*anyopaque,
    ) bool,
    terminate_fn: *const fn (context: ?*anyopaque) void,
};

pub const RemovalPreparation = enum {
    requested,
    startup_recovery,
};

const State = enum {
    idle,
    running,
    recovering,
    failed,
    stopping,
    stopped,
};

const GenerationShutdown = enum {
    graceful,
    forced,
};

const RendererDestination = struct {
    responder: native_sdk.bridge.AsyncResponder,
    removal: ?RemovalCorrelation = null,
};

const PendingDestination = union(enum) {
    renderer: RendererDestination,
    native_removal_recovery,
    native_account_profile_result,
    native_harness_custody_result,
    development_reload: native_sdk.bridge.AsyncResponder,
};

const Pending = struct {
    id: [native_sdk.bridge.max_id_bytes]u8,
    id_len: usize,
    destination: PendingDestination,
    request: []u8,
    removal_deletion_capability: [removal_deletion_capability_hex_bytes]u8 = undefined,
    removal_deletion_capability_len: usize = 0,
    removal_deletion_capability_consumed: bool = false,
    writer_active: bool = false,
    writer_done: bool = false,
    ui_done: bool = false,
    terminate_after_response: bool = false,
    development_reload_accepted: bool = false,
    development_reload_candidate: [development_reload_candidate_bytes]u8 = undefined,
    development_reload_candidate_len: usize = 0,

    fn idSlice(self: *const Pending) []const u8 {
        return self.id[0..self.id_len];
    }

    fn removalDeletionCapability(self: *const Pending) ?[]const u8 {
        return if (self.removal_deletion_capability_len == 0)
            null
        else
            self.removal_deletion_capability[0..self.removal_deletion_capability_len];
    }

    fn developmentReloadCandidate(self: *const Pending) ?[]const u8 {
        return if (self.development_reload_candidate_len == 0)
            null
        else
            self.development_reload_candidate[0..self.development_reload_candidate_len];
    }
};

fn secureWipe(bytes: []u8) void {
    std.crypto.secureZero(u8, @volatileCast(bytes));
}

fn secureWipeAndFree(allocator: std.mem.Allocator, bytes: []u8) void {
    secureWipe(bytes);
    allocator.free(bytes);
}

const Failure = struct {
    pending: *Pending,
    code: native_sdk.bridge.ErrorCode,
    message: []const u8,
};

const Response = struct {
    pending: *Pending,
    bytes: []u8,
};

const RendererEvent = struct {
    bytes: []u8,
    sequence: u64,
    recovery: EventRecovery,
};

const Action = union(enum) {
    response: Response,
    failure: Failure,
    event: RendererEvent,
    transport_lifecycle: []u8,
    write_complete: *Pending,
};

const TransportLifecycle = union(enum) {
    starting,
    ready,
    backing_off: struct {
        attempt: u8,
        retry_at_unix_milliseconds: u64,
    },
    failed: struct {
        can_retry: bool,
        message: []const u8,
    },
    stopping,
    stopped,
};

const TransportRetryStatus = enum {
    accepted,
    already_ready,
    unavailable,

    fn text(self: TransportRetryStatus) []const u8 {
        return switch (self) {
            .accepted => "accepted",
            .already_ready => "alreadyReady",
            .unavailable => "unavailable",
        };
    }
};

const TransportRetryDecision = struct {
    status: TransportRetryStatus,
    scheduled_attempt: ?u8 = null,
};

const DevelopmentReloadDecision = enum {
    accepted,
    busy,
};

fn parseDevelopmentReloadDecision(
    allocator: std.mem.Allocator,
    line: []const u8,
    expected_id: []const u8,
    expected_candidate: []const u8,
) !DevelopmentReloadDecision {
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        allocator,
        line,
        .{},
    ) catch return error.InvalidDevelopmentReloadDecision;
    defer parsed.deinit();
    const outer = switch (parsed.value) {
        .object => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    if (outer.count() != 3) return error.InvalidDevelopmentReloadDecision;
    const id = switch (outer.get("id") orelse
        return error.InvalidDevelopmentReloadDecision) {
        .string => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    const ok = switch (outer.get("ok") orelse
        return error.InvalidDevelopmentReloadDecision) {
        .bool => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    const result = switch (outer.get("result") orelse
        return error.InvalidDevelopmentReloadDecision) {
        .object => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    if (!ok or !std.mem.eql(u8, id, expected_id) or result.count() != 4) {
        return error.InvalidDevelopmentReloadDecision;
    }
    const kind = switch (result.get("kind") orelse
        return error.InvalidDevelopmentReloadDecision) {
        .string => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    const version = switch (result.get("version") orelse
        return error.InvalidDevelopmentReloadDecision) {
        .integer => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    const status = switch (result.get("status") orelse
        return error.InvalidDevelopmentReloadDecision) {
        .string => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    const candidate = switch (result.get("candidateId") orelse
        return error.InvalidDevelopmentReloadDecision) {
        .string => |value| value,
        else => return error.InvalidDevelopmentReloadDecision,
    };
    if (version != 1 or
        !std.mem.eql(u8, kind, development_reload_result_kind) or
        !std.mem.eql(u8, candidate, expected_candidate))
    {
        return error.InvalidDevelopmentReloadDecision;
    }
    if (std.mem.eql(u8, status, "accepted")) return .accepted;
    if (std.mem.eql(u8, status, "busy")) return .busy;
    return error.InvalidDevelopmentReloadDecision;
}

fn encodeDevelopmentReloadResult(
    allocator: std.mem.Allocator,
    id: ?[]const u8,
    status: []const u8,
    candidate: []const u8,
    current_generation: u64,
    next_generation: ?u64,
) std.mem.Allocator.Error![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    if (id) |request_id| {
        output.writer.writeAll("{\"id\":") catch return error.OutOfMemory;
        std.json.Stringify.value(request_id, .{}, &output.writer) catch
            return error.OutOfMemory;
        output.writer.writeAll(",\"ok\":true,\"result\":") catch
            return error.OutOfMemory;
    }
    output.writer.writeAll(
        "{\"version\":1,\"mode\":\"developmentReload\",\"status\":",
    ) catch return error.OutOfMemory;
    std.json.Stringify.value(status, .{}, &output.writer) catch
        return error.OutOfMemory;
    output.writer.writeAll(",\"candidateId\":") catch
        return error.OutOfMemory;
    std.json.Stringify.value(candidate, .{}, &output.writer) catch
        return error.OutOfMemory;
    output.writer.print(
        ",\"currentGeneration\":{d},\"nextGeneration\":",
        .{current_generation},
    ) catch return error.OutOfMemory;
    if (next_generation) |generation| {
        output.writer.print("{d}", .{generation}) catch
            return error.OutOfMemory;
    } else {
        output.writer.writeAll("null") catch return error.OutOfMemory;
    }
    output.writer.writeByte('}') catch return error.OutOfMemory;
    if (id != null) output.writer.writeByte('}') catch
        return error.OutOfMemory;
    return output.toOwnedSlice();
}

fn recoveryDelayMilliseconds(base: u16, attempt: u8) u16 {
    std.debug.assert(base > 0);
    std.debug.assert(attempt > 0);
    var delay: u32 = base;
    for (1..attempt) |_| {
        delay = @min(delay * 2, max_recovery_backoff_ms);
    }
    return @intCast(@min(delay, max_recovery_backoff_ms));
}

fn encodeTransportLifecycle(
    allocator: std.mem.Allocator,
    generation: u64,
    lifecycle: TransportLifecycle,
) std.mem.Allocator.Error![]u8 {
    var output: std.Io.Writer.Allocating = .init(allocator);
    defer output.deinit();
    const writer = &output.writer;
    switch (lifecycle) {
        .starting, .ready, .stopping, .stopped => {
            const state_name = switch (lifecycle) {
                .starting => "starting",
                .ready => "ready",
                .stopping => "stopping",
                .stopped => "stopped",
                else => unreachable,
            };
            writer.writeAll("{\"version\":1,\"state\":") catch
                return error.OutOfMemory;
            std.json.Stringify.value(state_name, .{}, writer) catch
                return error.OutOfMemory;
            writer.print(",\"generation\":{d}}}", .{generation}) catch
                return error.OutOfMemory;
        },
        .backing_off => |backoff| {
            writer.print(
                "{{\"version\":1,\"state\":\"backingOff\",\"generation\":{d},\"attempt\":{d},\"retryAtUnixMilliseconds\":{d}}}",
                .{
                    generation,
                    backoff.attempt,
                    backoff.retry_at_unix_milliseconds,
                },
            ) catch return error.OutOfMemory;
        },
        .failed => |failure| {
            writer.print(
                "{{\"version\":1,\"state\":\"failed\",\"generation\":{d},\"canRetry\":{},\"message\":",
                .{ generation, failure.can_retry },
            ) catch return error.OutOfMemory;
            std.json.Stringify.value(failure.message, .{}, writer) catch
                return error.OutOfMemory;
            writer.writeByte('}') catch return error.OutOfMemory;
        },
    }
    return output.toOwnedSlice();
}

fn transportLifecycleIsCurrent(
    state: State,
    current_generation: u64,
    lifecycle_generation: u64,
    lifecycle: TransportLifecycle,
) bool {
    if (current_generation != lifecycle_generation) return false;
    return switch (lifecycle) {
        .starting, .backing_off => state == .recovering,
        .ready => state == .running,
        .failed => state == .failed,
        .stopping => state == .stopping,
        .stopped => state == .stopped,
    };
}

fn productionAccountProfileOperation(
    context: ?*anyopaque,
    helper_path: []const u8,
    action: []const u8,
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    state_root_device: []const u8,
    state_root_inode: []const u8,
    control_plane_device: []const u8,
    control_plane_inode: []const u8,
    deletion_nonce: ?[]const u8,
    expected_revision: u64,
) bool {
    return runAttestedAccountProfileOperation(
        false,
        context,
        helper_path,
        action,
        control_plane_path,
        account_profile_id,
        state_root_device,
        state_root_inode,
        control_plane_device,
        control_plane_inode,
        deletion_nonce,
        expected_revision,
    );
}

fn sourceDevelopmentAccountProfileOperation(
    context: ?*anyopaque,
    helper_path: []const u8,
    action: []const u8,
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    state_root_device: []const u8,
    state_root_inode: []const u8,
    control_plane_device: []const u8,
    control_plane_inode: []const u8,
    deletion_nonce: ?[]const u8,
    expected_revision: u64,
) bool {
    return runAttestedAccountProfileOperation(
        true,
        context,
        helper_path,
        action,
        control_plane_path,
        account_profile_id,
        state_root_device,
        state_root_inode,
        control_plane_device,
        control_plane_inode,
        deletion_nonce,
        expected_revision,
    );
}

fn runAttestedAccountProfileOperation(
    source_development: bool,
    context: ?*anyopaque,
    helper_path: []const u8,
    action: []const u8,
    control_plane_path: []const u8,
    account_profile_id: []const u8,
    state_root_device: []const u8,
    state_root_inode: []const u8,
    control_plane_device: []const u8,
    control_plane_inode: []const u8,
    deletion_nonce: ?[]const u8,
    expected_revision: u64,
) bool {
    _ = context;
    if (comptime !std.mem.eql(u8, build_options.platform, "macos")) {
        return false;
    }
    const deletion_nonce_pointer: ?[*]const u8 =
        if (deletion_nonce) |nonce| nonce.ptr else null;
    return hra_macos_run_attested_account_profile_operation(
        helper_path.ptr,
        helper_path.len,
        action.ptr,
        action.len,
        control_plane_path.ptr,
        control_plane_path.len,
        account_profile_id.ptr,
        account_profile_id.len,
        state_root_device.ptr,
        state_root_device.len,
        state_root_inode.ptr,
        state_root_inode.len,
        control_plane_device.ptr,
        control_plane_device.len,
        control_plane_inode.ptr,
        control_plane_inode.len,
        deletion_nonce_pointer,
        if (deletion_nonce) |nonce| nonce.len else 0,
        expected_revision,
        source_development,
        if (std.mem.eql(u8, action, "ensure"))
            account_profile_ensure_helper_timeout_ms
        else
            account_profile_delete_helper_timeout_ms,
    );
}

fn cancelProductionAccountProfileOperation(context: ?*anyopaque) void {
    _ = context;
    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        hra_macos_cancel_attested_account_profile_operation();
    }
}

const production_account_profile_runner: AccountProfileOperationRunner = .{
    .context = null,
    .run_fn = productionAccountProfileOperation,
    .cancel_fn = cancelProductionAccountProfileOperation,
};

const source_development_account_profile_runner: AccountProfileOperationRunner = .{
    .context = null,
    .run_fn = sourceDevelopmentAccountProfileOperation,
    .cancel_fn = cancelProductionAccountProfileOperation,
};

pub fn isolatedDevelopmentAccountProfileRunner() AccountProfileOperationRunner {
    return source_development_account_profile_runner;
}

fn harnessInstallEnvelopeSHA256(
    value: []const u8,
) [harness_reconciliation_digest_bytes]u8 {
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(value, &digest, .{});
    defer secureWipe(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

fn developmentReloadFileSHA256(
    io: std.Io,
    path: []const u8,
) ![development_reload_candidate_bytes]u8 {
    var file = try std.Io.Dir.cwd().openFile(io, path, .{
        .mode = .read_only,
        .allow_directory = false,
        .follow_symlinks = false,
    });
    defer file.close(io);
    const before = try file.stat(io);
    if (before.kind != .file) return error.InvalidDevelopmentReloadCandidate;

    var hasher = std.crypto.hash.sha2.Sha256.init(.{});
    var buffer: [64 * 1024]u8 = undefined;
    defer secureWipe(&buffer);
    var offset: u64 = 0;
    while (offset < before.size) {
        const remaining: usize = @intCast(@min(
            before.size - offset,
            buffer.len,
        ));
        const count = try file.readPositionalAll(
            io,
            buffer[0..remaining],
            offset,
        );
        if (count == 0) return error.DevelopmentReloadCandidateChanged;
        hasher.update(buffer[0..count]);
        offset += count;
    }
    const after = try file.stat(io);
    if (offset != before.size or before.size != after.size or
        before.inode != after.inode)
    {
        return error.DevelopmentReloadCandidateChanged;
    }
    var digest: [32]u8 = undefined;
    defer secureWipe(&digest);
    hasher.final(&digest);
    return std.fmt.bytesToHex(digest, .lower);
}

fn developmentReloadCandidatePath(
    allocator: std.mem.Allocator,
    stable_gateway_path: []const u8,
    candidate: []const u8,
) std.mem.Allocator.Error![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{s}.candidate-{s}",
        .{ stable_gateway_path, candidate },
    );
}

fn harnessReconciliationMarkerIsValid(
    marker: *const HarnessReconciliationMarker,
) bool {
    const digest = marker.envelopeSHA256();
    if (digest) |present| {
        if (present.len != harness_reconciliation_digest_bytes) return false;
        for (present) |byte| {
            if (!std.ascii.isHex(byte) or std.ascii.isUpper(byte)) return false;
        }
    }
    return switch (marker.phase) {
        .prepared => marker.envelope_state == .present and digest != null,
        .committed => switch (marker.envelope_state) {
            .absent => marker.legacy_state == .absent and digest == null,
            .present => digest != null,
        },
    };
}

fn harnessReconciliationMarkersEqual(
    left: *const HarnessReconciliationMarker,
    right: *const HarnessReconciliationMarker,
) bool {
    if (left.phase != right.phase or
        left.legacy_state != right.legacy_state or
        left.envelope_state != right.envelope_state or
        left.envelope_sha256_len != right.envelope_sha256_len)
    {
        return false;
    }
    return std.mem.eql(
        u8,
        left.envelope_sha256[0..left.envelope_sha256_len],
        right.envelope_sha256[0..right.envelope_sha256_len],
    );
}

fn encodeHarnessReconciliationMarker(
    buffer: *[max_harness_reconciliation_marker_bytes]u8,
    marker: *const HarnessReconciliationMarker,
) ?[]const u8 {
    if (!harnessReconciliationMarkerIsValid(marker)) return null;
    const prefix = std.fmt.bufPrint(
        buffer,
        "{{\"version\":1,\"phase\":\"{s}\",\"bridgeCDHash\":\"{s}\",\"legacyState\":\"{s}\",\"envelopeState\":\"{s}\",\"envelopeSHA256\":",
        .{
            marker.phase.text(),
            harness_legacy_bridge_cdhash,
            marker.legacy_state.text(),
            switch (marker.envelope_state) {
                .absent => "absent",
                .present => "present",
            },
        },
    ) catch return null;
    var offset = prefix.len;
    if (marker.envelopeSHA256()) |digest| {
        if (offset + digest.len + 3 > buffer.len) return null;
        buffer[offset] = '"';
        offset += 1;
        @memcpy(buffer[offset..][0..digest.len], digest);
        offset += digest.len;
        buffer[offset] = '"';
        offset += 1;
    } else {
        const literal = "null";
        if (offset + literal.len + 1 > buffer.len) return null;
        @memcpy(buffer[offset..][0..literal.len], literal);
        offset += literal.len;
    }
    buffer[offset] = '}';
    offset += 1;
    return buffer[0..offset];
}

fn parseHarnessReconciliationMarker(
    value: []const u8,
    output: *HarnessReconciliationMarker,
) bool {
    if (value.len == 0 or value.len > max_harness_reconciliation_marker_bytes)
        return false;
    var scratch: [harness_custody_json_parse_scratch_bytes]u8 = undefined;
    defer secureWipe(&scratch);
    var fixed = std.heap.FixedBufferAllocator.init(&scratch);
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        fixed.allocator(),
        value,
        .{},
    ) catch return false;
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |candidate| candidate,
        else => return false,
    };
    if (object.count() != 6) return false;
    const version = switch (object.get("version") orelse return false) {
        .integer => |candidate| candidate,
        else => return false,
    };
    const phase_text = switch (object.get("phase") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    const bridge_hash = switch (object.get("bridgeCDHash") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    const legacy_text = switch (object.get("legacyState") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    const envelope_text = switch (object.get("envelopeState") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    if (version != 1 or
        !std.mem.eql(u8, bridge_hash, harness_legacy_bridge_cdhash))
    {
        return false;
    }
    var marker: HarnessReconciliationMarker = .{
        .phase = if (std.mem.eql(u8, phase_text, "prepared"))
            .prepared
        else if (std.mem.eql(u8, phase_text, "committed"))
            .committed
        else
            return false,
        .legacy_state = if (std.mem.eql(u8, legacy_text, "absent"))
            .absent
        else if (std.mem.eql(u8, legacy_text, "present"))
            .present
        else
            return false,
        .envelope_state = if (std.mem.eql(u8, envelope_text, "absent"))
            .absent
        else if (std.mem.eql(u8, envelope_text, "present"))
            .present
        else
            return false,
    };
    const digest_value = object.get("envelopeSHA256") orelse return false;
    switch (digest_value) {
        .null => {},
        .string => |digest| {
            marker.envelope_sha256_len = boundedCopy(
                &marker.envelope_sha256,
                digest,
            ) catch return false;
        },
        else => return false,
    }
    if (!harnessReconciliationMarkerIsValid(&marker)) return false;
    var canonical: [max_harness_reconciliation_marker_bytes]u8 = undefined;
    const encoded = encodeHarnessReconciliationMarker(
        &canonical,
        &marker,
    ) orelse return false;
    if (!std.mem.eql(u8, value, encoded)) return false;
    output.* = marker;
    return true;
}

fn harnessReconciliationMarkerForEnvelope(
    phase: HarnessReconciliationPhase,
    legacy_state: HarnessReconciliationLegacyState,
    value: []const u8,
) HarnessReconciliationMarker {
    return .{
        .phase = phase,
        .legacy_state = legacy_state,
        .envelope_state = .present,
        .envelope_sha256 = harnessInstallEnvelopeSHA256(value),
        .envelope_sha256_len = harness_reconciliation_digest_bytes,
    };
}

fn harnessAbsentCommittedMarker() HarnessReconciliationMarker {
    return .{
        .phase = .committed,
        .legacy_state = .absent,
        .envelope_state = .absent,
    };
}

fn harnessMarkerMatchesValue(
    marker: *const HarnessReconciliationMarker,
    value: *const HarnessCustodyValue,
) bool {
    if (marker.envelope_state != value.state) return false;
    return switch (value.state) {
        .absent => marker.envelopeSHA256() == null,
        .present => blk: {
            const envelope = value.valueSlice() orelse break :blk false;
            const actual = harnessInstallEnvelopeSHA256(envelope);
            break :blk std.mem.eql(
                u8,
                marker.envelopeSHA256() orelse break :blk false,
                &actual,
            );
        },
    };
}

fn parseHarnessCustodyHelperResponse(
    action: HarnessCustodyHelperAction,
    response: []const u8,
    output: *HarnessCustodyHelperResult,
) bool {
    var scratch: [harness_custody_json_parse_scratch_bytes]u8 = undefined;
    defer secureWipe(&scratch);
    var fixed = std.heap.FixedBufferAllocator.init(&scratch);
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        fixed.allocator(),
        response,
        .{},
    ) catch return false;
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |value| value,
        else => return false,
    };
    const version = switch (object.get("version") orelse return false) {
        .integer => |value| value,
        else => return false,
    };
    const ok = switch (object.get("ok") orelse return false) {
        .bool => |value| value,
        else => return false,
    };
    if (version != 1 or !ok) return false;
    switch (action) {
        .envelope_read => {
            const state = switch (object.get("state") orelse return false) {
                .string => |value| value,
                else => return false,
            };
            if (std.mem.eql(u8, state, "absent")) {
                if (object.count() != 3) return false;
                output.* = .{
                    .envelope_read = .{ .state = .absent },
                };
                return true;
            }
            if (!std.mem.eql(u8, state, "present") or object.count() != 4)
                return false;
            const value = switch (object.get("value") orelse return false) {
                .string => |candidate| candidate,
                else => return false,
            };
            if (!canonicalHarnessInstallEnvelope(value)) return false;
            var result: HarnessCustodyValue = .{ .state = .present };
            defer wipeHarnessCustodyValue(&result);
            result.value_len = boundedCopy(&result.value, value) catch
                return false;
            output.* = .{ .envelope_read = result };
            return true;
        },
        .envelope_set_if_absent => {
            if (object.count() != 4) return false;
            const value = switch (object.get("value") orelse return false) {
                .string => |candidate| candidate,
                else => return false,
            };
            const created = switch (object.get("created") orelse return false) {
                .bool => |candidate| candidate,
                else => return false,
            };
            if (!canonicalHarnessInstallEnvelope(value)) return false;
            var authoritative: HarnessCustodyValue = .{ .state = .present };
            defer wipeHarnessCustodyValue(&authoritative);
            authoritative.value_len = boundedCopy(
                &authoritative.value,
                value,
            ) catch return false;
            output.* = .{ .envelope_set_if_absent = .{
                .value = authoritative,
                .created = created,
            } };
            return true;
        },
        .envelope_delete => {
            if (object.count() != 3) return false;
            const deleted = switch (object.get("deleted") orelse return false) {
                .bool => |candidate| candidate,
                else => return false,
            };
            output.* = .{ .envelope_delete = deleted };
            return true;
        },
        .marker_read => {
            const state = switch (object.get("state") orelse return false) {
                .string => |value| value,
                else => return false,
            };
            if (std.mem.eql(u8, state, "absent")) {
                if (object.count() != 3) return false;
                output.* = .{ .marker_read = .absent };
                return true;
            }
            if (!std.mem.eql(u8, state, "present") or object.count() != 4)
                return false;
            const value = switch (object.get("value") orelse return false) {
                .string => |candidate| candidate,
                else => return false,
            };
            var marker: HarnessReconciliationMarker = undefined;
            if (!parseHarnessReconciliationMarker(value, &marker)) return false;
            output.* = .{ .marker_read = .{ .present = marker } };
            return true;
        },
        .marker_prepare, .marker_commit => {
            if (object.count() != 3) return false;
            const value = switch (object.get("value") orelse return false) {
                .string => |candidate| candidate,
                else => return false,
            };
            var marker: HarnessReconciliationMarker = undefined;
            if (!parseHarnessReconciliationMarker(value, &marker)) return false;
            if ((action == .marker_prepare and marker.phase != .prepared) or
                (action == .marker_commit and marker.phase != .committed))
            {
                return false;
            }
            output.* = .{ .marker_write = marker };
            return true;
        },
        .marker_delete => {
            if (object.count() != 3) return false;
            const deleted = switch (object.get("deleted") orelse return false) {
                .bool => |candidate| candidate,
                else => return false,
            };
            output.* = .{ .marker_delete = deleted };
            return true;
        },
    }
}

fn productionHarnessCustodyOperation(
    context: ?*anyopaque,
    helper_path: []const u8,
    action: HarnessCustodyHelperAction,
    value: ?[]const u8,
    timeout_milliseconds: u32,
    output: *HarnessCustodyHelperResult,
) bool {
    _ = context;
    if (comptime !std.mem.eql(u8, build_options.platform, "macos"))
        return false;
    const value_required = switch (action) {
        .envelope_set_if_absent, .marker_prepare, .marker_commit => true,
        else => false,
    };
    if (value_required != (value != null) or
        timeout_milliseconds == 0 or
        timeout_milliseconds > harness_custody_helper_timeout_ms) return false;
    var request: std.Io.Writer.Allocating = .init(std.heap.page_allocator);
    defer {
        if (request.writer.buffer.len > 0) secureWipe(request.writer.buffer);
        request.deinit();
    }
    request.writer.writeAll("{\"action\":") catch return false;
    std.json.Stringify.value(switch (action) {
        .envelope_read => "read",
        .envelope_set_if_absent => "setIfAbsent",
        .envelope_delete => "delete",
        .marker_read => "markerRead",
        .marker_prepare => "markerPrepare",
        .marker_commit => "markerCommit",
        .marker_delete => "markerDelete",
    }, .{}, &request.writer) catch return false;
    if (value) |payload| {
        if (action == .envelope_set_if_absent) {
            if (!canonicalHarnessInstallEnvelope(payload)) return false;
        } else {
            var marker: HarnessReconciliationMarker = undefined;
            if (!parseHarnessReconciliationMarker(payload, &marker) or
                (action == .marker_prepare and marker.phase != .prepared) or
                (action == .marker_commit and marker.phase != .committed))
            {
                return false;
            }
        }
        request.writer.writeAll(",\"value\":") catch return false;
        std.json.Stringify.value(payload, .{}, &request.writer) catch
            return false;
    }
    request.writer.writeAll(",\"version\":1}") catch return false;
    var response: [512]u8 = undefined;
    var response_length: usize = 0;
    if (!hra_macos_run_attested_keychain_custodian(
        helper_path.ptr,
        helper_path.len,
        request.writer.buffered().ptr,
        request.writer.buffered().len,
        &response,
        response.len,
        &response_length,
        timeout_milliseconds,
        builtin.mode == .Debug,
    )) {
        secureWipe(&response);
        return false;
    }
    defer secureWipe(&response);
    return parseHarnessCustodyHelperResponse(
        action,
        response[0..response_length],
        output,
    );
}

fn cancelProductionHarnessCustodyOperation(context: ?*anyopaque) void {
    _ = context;
    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        hra_macos_cancel_attested_keychain_custodian();
    }
}

const production_harness_custody_runner: HarnessCustodyHelperRunner = .{
    .context = null,
    .run_fn = productionHarnessCustodyOperation,
    .cancel_fn = cancelProductionHarnessCustodyOperation,
};

fn rejectIsolatedDevelopmentHarnessCustodyOperation(
    context: ?*anyopaque,
    helper_path: []const u8,
    action: HarnessCustodyHelperAction,
    value: ?[]const u8,
    timeout_milliseconds: u32,
    output: *HarnessCustodyHelperResult,
) bool {
    _ = context;
    _ = helper_path;
    _ = action;
    _ = value;
    _ = timeout_milliseconds;
    _ = output;
    return false;
}

fn ignoreIsolatedDevelopmentHarnessCustodyCancellation(
    context: ?*anyopaque,
) void {
    _ = context;
}

const isolated_development_harness_custody_runner: HarnessCustodyHelperRunner = .{
    .context = null,
    .run_fn = rejectIsolatedDevelopmentHarnessCustodyOperation,
    .cancel_fn = ignoreIsolatedDevelopmentHarnessCustodyCancellation,
};

pub fn isolatedDevelopmentHarnessCustodyRunner() HarnessCustodyHelperRunner {
    return isolated_development_harness_custody_runner;
}

fn parseLegacyHarnessCustodyResponse(
    delete_action: bool,
    response: []const u8,
    output: *HarnessCustodyValue,
    deleted: *bool,
) bool {
    var scratch: [harness_custody_json_parse_scratch_bytes]u8 = undefined;
    defer secureWipe(&scratch);
    var fixed = std.heap.FixedBufferAllocator.init(&scratch);
    var parsed = std.json.parseFromSlice(
        std.json.Value,
        fixed.allocator(),
        response,
        .{},
    ) catch return false;
    defer parsed.deinit();
    const object = switch (parsed.value) {
        .object => |candidate| candidate,
        else => return false,
    };
    const version = switch (object.get("version") orelse return false) {
        .integer => |candidate| candidate,
        else => return false,
    };
    if (version != 1) return false;
    if (delete_action) {
        if (object.count() != 2) return false;
        deleted.* = switch (object.get("deleted") orelse return false) {
            .bool => |candidate| candidate,
            else => return false,
        };
        return true;
    }
    const state = switch (object.get("state") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    if (std.mem.eql(u8, state, "absent")) {
        if (object.count() != 2) return false;
        output.* = .{ .state = .absent };
        return true;
    }
    if (!std.mem.eql(u8, state, "present") or object.count() != 3)
        return false;
    const value = switch (object.get("value") orelse return false) {
        .string => |candidate| candidate,
        else => return false,
    };
    if (!canonicalHarnessInstallEnvelope(value)) return false;
    var result: HarnessCustodyValue = .{ .state = .present };
    defer wipeHarnessCustodyValue(&result);
    result.value_len = boundedCopy(&result.value, value) catch return false;
    output.* = result;
    return true;
}

fn productionLegacyHarnessOperation(
    gateway_path: []const u8,
    delete_action: bool,
    timeout_milliseconds: u32,
    output: *HarnessCustodyValue,
    deleted: *bool,
    failure_substage: *LegacyHarnessCustodyFailureSubstage,
) bool {
    failure_substage.* = .admission;
    if (comptime !std.mem.eql(u8, build_options.platform, "macos"))
        return false;
    if (timeout_milliseconds == 0 or
        timeout_milliseconds > legacy_harness_custody_timeout_ms) return false;
    var response: [512]u8 = undefined;
    var response_length: usize = 0;
    var native_failure_substage: LegacyHarnessCustodyFailureSubstage = .none;
    if (!hra_macos_run_attested_legacy_harness_custody(
        gateway_path.ptr,
        gateway_path.len,
        delete_action,
        &response,
        response.len,
        &response_length,
        &native_failure_substage,
        timeout_milliseconds,
        builtin.mode == .Debug,
    )) {
        failure_substage.* = if (native_failure_substage == .none)
            .admission
        else
            native_failure_substage;
        secureWipe(&response);
        return false;
    }
    defer secureWipe(&response);
    if (!parseLegacyHarnessCustodyResponse(
        delete_action,
        response[0..response_length],
        output,
        deleted,
    )) {
        failure_substage.* = .response_parse;
        return false;
    }
    failure_substage.* = .none;
    return true;
}

fn productionLegacyHarnessRead(
    context: ?*anyopaque,
    gateway_path: []const u8,
    timeout_milliseconds: u32,
    output: *HarnessCustodyValue,
    failure_substage: *LegacyHarnessCustodyFailureSubstage,
) bool {
    _ = context;
    var ignored_deleted = false;
    return productionLegacyHarnessOperation(
        gateway_path,
        false,
        timeout_milliseconds,
        output,
        &ignored_deleted,
        failure_substage,
    );
}

fn productionLegacyHarnessDelete(
    context: ?*anyopaque,
    gateway_path: []const u8,
    timeout_milliseconds: u32,
    deleted: *bool,
    failure_substage: *LegacyHarnessCustodyFailureSubstage,
) bool {
    _ = context;
    var ignored_value: HarnessCustodyValue = .{ .state = .absent };
    return productionLegacyHarnessOperation(
        gateway_path,
        true,
        timeout_milliseconds,
        &ignored_value,
        deleted,
        failure_substage,
    );
}

fn cancelProductionLegacyHarnessOperation(context: ?*anyopaque) void {
    _ = context;
    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        hra_macos_cancel_attested_legacy_harness_custody();
    }
}

const production_legacy_harness_custody_runner: LegacyHarnessCustodyRunner = .{
    .context = null,
    .read_fn = productionLegacyHarnessRead,
    .delete_fn = productionLegacyHarnessDelete,
    .cancel_fn = cancelProductionLegacyHarnessOperation,
};

fn harnessCustodyValuesEqual(
    left: *const HarnessCustodyValue,
    right: *const HarnessCustodyValue,
) bool {
    if (left.state != right.state) return false;
    return switch (left.state) {
        .absent => true,
        .present => left.value_len == right.value_len and
            std.mem.eql(
                u8,
                left.value[0..left.value_len],
                right.value[0..right.value_len],
            ),
    };
}

fn wipeHarnessCustodyValue(value: *HarnessCustodyValue) void {
    secureWipe(&value.value);
    value.value_len = 0;
    value.state = .absent;
}

fn wipeHarnessCustodyHelperResult(
    result: *HarnessCustodyHelperResult,
) void {
    switch (result.*) {
        .envelope_read => |*value| wipeHarnessCustodyValue(value),
        .envelope_set_if_absent => |*set| {
            wipeHarnessCustodyValue(&set.value);
            set.created = false;
        },
        .envelope_delete,
        .marker_read,
        .marker_write,
        .marker_delete,
        => {},
    }
    result.* = .{ .envelope_delete = false };
}

fn wipeHarnessCustodyOperationResult(
    result: *HarnessCustodyOperationResult,
) void {
    switch (result.*) {
        .read => |*read| wipeHarnessCustodyValue(&read.value),
        .set_if_absent => |*set| wipeHarnessCustodyValue(&set.value),
        .delete_both, .failed, .legacy_failed => {},
    }
    result.* = .{ .failed = .reporting };
}

const HarnessCustodyDeadline = struct {
    io: std.Io,
    boot_milliseconds: u64,

    fn remainingAt(
        self: *const @This(),
        now_raw: i64,
        maximum: u32,
    ) ?u32 {
        if (now_raw < 0) return null;
        const now: u64 = @intCast(now_raw);
        if (now >= self.boot_milliseconds) return null;
        return @intCast(@min(
            self.boot_milliseconds - now,
            @as(u64, maximum),
        ));
    }

    fn remaining(
        self: *const @This(),
        maximum: u32,
    ) ?u32 {
        return self.remainingAt(
            std.Io.Clock.boot.now(self.io).toMilliseconds(),
            maximum,
        );
    }
};

const HarnessEnvelopeSetResult = struct {
    value: HarnessCustodyValue,
    created: bool,
};

fn readHarnessEnvelope(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
) ?HarnessCustodyValue {
    var helper_result: HarnessCustodyHelperResult = undefined;
    if (!helper.run_fn(
        helper.context,
        helper_path,
        .envelope_read,
        null,
        deadline.remaining(harness_custody_helper_timeout_ms) orelse
            return null,
        &helper_result,
    )) return null;
    defer wipeHarnessCustodyHelperResult(&helper_result);
    return switch (helper_result) {
        .envelope_read => |value| value,
        else => null,
    };
}

fn setHarnessEnvelopeIfAbsent(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
    value: []const u8,
) ?HarnessEnvelopeSetResult {
    var helper_result: HarnessCustodyHelperResult = undefined;
    if (!helper.run_fn(
        helper.context,
        helper_path,
        .envelope_set_if_absent,
        value,
        deadline.remaining(harness_custody_helper_timeout_ms) orelse
            return null,
        &helper_result,
    )) return null;
    defer wipeHarnessCustodyHelperResult(&helper_result);
    return switch (helper_result) {
        .envelope_set_if_absent => |set| .{
            .value = set.value,
            .created = set.created,
        },
        else => null,
    };
}

fn deleteHarnessEnvelope(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
) ?bool {
    var helper_result: HarnessCustodyHelperResult = undefined;
    if (!helper.run_fn(
        helper.context,
        helper_path,
        .envelope_delete,
        null,
        deadline.remaining(harness_custody_helper_timeout_ms) orelse
            return null,
        &helper_result,
    )) return null;
    return switch (helper_result) {
        .envelope_delete => |deleted| deleted,
        else => null,
    };
}

fn readHarnessReconciliationMarker(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
) ?HarnessReconciliationMarkerRead {
    var helper_result: HarnessCustodyHelperResult = undefined;
    if (!helper.run_fn(
        helper.context,
        helper_path,
        .marker_read,
        null,
        deadline.remaining(harness_custody_helper_timeout_ms) orelse
            return null,
        &helper_result,
    )) return null;
    return switch (helper_result) {
        .marker_read => |marker| marker,
        else => null,
    };
}

fn writeHarnessReconciliationMarker(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
    action: HarnessCustodyHelperAction,
    marker: *const HarnessReconciliationMarker,
) bool {
    if (action != .marker_prepare and action != .marker_commit) return false;
    var canonical: [max_harness_reconciliation_marker_bytes]u8 = undefined;
    defer secureWipe(&canonical);
    const value = encodeHarnessReconciliationMarker(
        &canonical,
        marker,
    ) orelse return false;
    var helper_result: HarnessCustodyHelperResult = undefined;
    if (!helper.run_fn(
        helper.context,
        helper_path,
        action,
        value,
        deadline.remaining(harness_custody_helper_timeout_ms) orelse
            return false,
        &helper_result,
    )) return false;
    const written = switch (helper_result) {
        .marker_write => |authoritative| authoritative,
        else => return false,
    };
    return harnessReconciliationMarkersEqual(marker, &written);
}

fn deleteHarnessReconciliationMarker(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
) ?bool {
    var helper_result: HarnessCustodyHelperResult = undefined;
    if (!helper.run_fn(
        helper.context,
        helper_path,
        .marker_delete,
        null,
        deadline.remaining(harness_custody_helper_timeout_ms) orelse
            return null,
        &helper_result,
    )) return null;
    return switch (helper_result) {
        .marker_delete => |deleted| deleted,
        else => null,
    };
}

/// Executes the prerelease v2 custody protocol without consulting historical
/// app binaries. HRA has no installed v1 population, so a missing v2 envelope
/// is authoritative and can initialize directly. The legacy reconciliation
/// implementation below remains test-only reference code until its protocol
/// surface is removed in a later source cleanup.
fn executeDirectHarnessCustodyOperation(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    request: *const HarnessCustodyNativeRequest,
    deadline: HarnessCustodyDeadline,
) HarnessCustodyOperationResult {
    switch (request.action) {
        .read => {
            const current = readHarnessEnvelope(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .envelope_read };
            return .{ .read = .{
                .value = current,
                .migrated_from_legacy = false,
                .legacy_preserved = false,
            } };
        },
        .set_if_absent => {
            const requested = request.valueSlice() orelse
                return .{ .failed = .reconciliation };
            if (!canonicalHarnessInstallEnvelope(requested))
                return .{ .failed = .reconciliation };
            var set = setHarnessEnvelopeIfAbsent(
                helper,
                helper_path,
                &deadline,
                requested,
            ) orelse return .{ .failed = .envelope_set_if_absent };
            defer wipeHarnessCustodyValue(&set.value);
            const authoritative = set.value.valueSlice() orelse
                return .{ .failed = .reconciliation };
            if (!std.mem.eql(u8, requested, authoritative))
                return .{ .failed = .reconciliation };
            return .{ .set_if_absent = .{
                .value = set.value,
                .created = set.created,
            } };
        },
        .delete_both => {
            const deleted_v2 = deleteHarnessEnvelope(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .envelope_delete };
            var current = readHarnessEnvelope(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .envelope_read };
            defer wipeHarnessCustodyValue(&current);
            if (current.state != .absent)
                return .{ .failed = .reconciliation };
            _ = deleteHarnessReconciliationMarker(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .marker_delete };
            return .{ .delete_both = .{
                .deleted_v1 = false,
                .deleted_v2 = deleted_v2,
            } };
        },
    }
}

fn migratePreparedHarnessEnvelope(
    helper: HarnessCustodyHelperRunner,
    legacy: LegacyHarnessCustodyRunner,
    helper_path: []const u8,
    legacy_gateway_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
    prepared: *const HarnessReconciliationMarker,
    current: *const HarnessCustodyValue,
    known_legacy: ?*const HarnessCustodyValue,
) HarnessCustodyOperationResult {
    if (prepared.phase != .prepared or
        !harnessReconciliationMarkerIsValid(prepared) or
        (current.state == .present and
            !harnessMarkerMatchesValue(prepared, current)))
    {
        return .{ .failed = .reconciliation };
    }

    var legacy_value: HarnessCustodyValue = if (known_legacy) |known|
        known.*
    else blk: {
        var readback: HarnessCustodyValue = undefined;
        var failure_substage: LegacyHarnessCustodyFailureSubstage = .admission;
        if (!legacy.read_fn(
            legacy.context,
            legacy_gateway_path,
            deadline.remaining(legacy_harness_custody_timeout_ms) orelse
                return legacyHarnessCustodyFailure(.legacy_read, .admission),
            &readback,
            &failure_substage,
        )) return legacyHarnessCustodyFailure(
            .legacy_read,
            failure_substage,
        );
        break :blk readback;
    };
    defer wipeHarnessCustodyValue(&legacy_value);
    if (legacy_value.state != .present or
        !harnessMarkerMatchesValue(prepared, &legacy_value))
    {
        return .{ .failed = .reconciliation };
    }

    var authoritative = if (current.state == .present)
        current.*
    else blk: {
        var set = setHarnessEnvelopeIfAbsent(
            helper,
            helper_path,
            deadline,
            legacy_value.valueSlice() orelse
                return .{ .failed = .reconciliation },
        ) orelse return .{ .failed = .envelope_set_if_absent };
        defer wipeHarnessCustodyValue(&set.value);
        if (!harnessCustodyValuesEqual(&legacy_value, &set.value)) {
            return .{ .failed = .reconciliation };
        }
        break :blk set.value;
    };
    defer wipeHarnessCustodyValue(&authoritative);

    var preserved: HarnessCustodyValue = undefined;
    var preservation_failure_substage: LegacyHarnessCustodyFailureSubstage =
        .admission;
    if (!legacy.read_fn(
        legacy.context,
        legacy_gateway_path,
        deadline.remaining(legacy_harness_custody_timeout_ms) orelse
            return legacyHarnessCustodyFailure(
                .legacy_preservation_read,
                .admission,
            ),
        &preserved,
        &preservation_failure_substage,
    )) return legacyHarnessCustodyFailure(
        .legacy_preservation_read,
        preservation_failure_substage,
    );
    defer wipeHarnessCustodyValue(&preserved);
    if (!harnessCustodyValuesEqual(&legacy_value, &preserved))
        return .{ .failed = .reconciliation };

    var committed = prepared.*;
    committed.phase = .committed;
    if (!writeHarnessReconciliationMarker(
        helper,
        helper_path,
        deadline,
        .marker_commit,
        &committed,
    )) return .{ .failed = .marker_commit };
    return .{ .read = .{
        .value = authoritative,
        .migrated_from_legacy = true,
        .legacy_preserved = true,
    } };
}

fn reconcilePreparedNativeHarnessSet(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
    prepared: *const HarnessReconciliationMarker,
    current: *const HarnessCustodyValue,
) HarnessCustodyOperationResult {
    if (prepared.phase != .prepared or
        prepared.legacy_state != .absent or
        !harnessReconciliationMarkerIsValid(prepared))
    {
        return .{ .failed = .reconciliation };
    }
    if (current.state == .absent) {
        const committed_absent = harnessAbsentCommittedMarker();
        if (!writeHarnessReconciliationMarker(
            helper,
            helper_path,
            deadline,
            .marker_commit,
            &committed_absent,
        )) return .{ .failed = .marker_commit };
        return .{ .read = .{
            .value = .{ .state = .absent },
            .migrated_from_legacy = false,
            .legacy_preserved = false,
        } };
    }
    if (!harnessMarkerMatchesValue(prepared, current))
        return .{ .failed = .reconciliation };
    var committed = prepared.*;
    committed.phase = .committed;
    if (!writeHarnessReconciliationMarker(
        helper,
        helper_path,
        deadline,
        .marker_commit,
        &committed,
    )) return .{ .failed = .marker_commit };
    return .{ .read = .{
        .value = current.*,
        .migrated_from_legacy = false,
        .legacy_preserved = false,
    } };
}

fn completePreparedNativeHarnessSet(
    helper: HarnessCustodyHelperRunner,
    helper_path: []const u8,
    deadline: *const HarnessCustodyDeadline,
    prepared: *const HarnessReconciliationMarker,
    current: *const HarnessCustodyValue,
    requested: []const u8,
) HarnessCustodyOperationResult {
    const expected = harnessReconciliationMarkerForEnvelope(
        .prepared,
        .absent,
        requested,
    );
    if (!harnessReconciliationMarkersEqual(prepared, &expected))
        return .{ .failed = .reconciliation };
    var set: HarnessEnvelopeSetResult = if (current.state == .absent)
        setHarnessEnvelopeIfAbsent(
            helper,
            helper_path,
            deadline,
            requested,
        ) orelse return .{ .failed = .envelope_set_if_absent }
    else
        .{ .value = current.*, .created = false };
    defer wipeHarnessCustodyValue(&set.value);
    const authoritative = set.value.valueSlice() orelse
        return .{ .failed = .reconciliation };
    if (!std.mem.eql(u8, requested, authoritative))
        return .{ .failed = .reconciliation };
    var committed = prepared.*;
    committed.phase = .committed;
    if (!writeHarnessReconciliationMarker(
        helper,
        helper_path,
        deadline,
        .marker_commit,
        &committed,
    )) return .{ .failed = .marker_commit };
    return .{ .set_if_absent = .{
        .value = set.value,
        .created = set.created,
    } };
}

fn executeHarnessCustodyOperation(
    helper: HarnessCustodyHelperRunner,
    legacy: LegacyHarnessCustodyRunner,
    helper_path: []const u8,
    legacy_gateway_path: []const u8,
    request: *const HarnessCustodyNativeRequest,
    deadline: HarnessCustodyDeadline,
) HarnessCustodyOperationResult {
    switch (request.action) {
        .read => {
            const marker_read = readHarnessReconciliationMarker(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .marker_read };
            var current = readHarnessEnvelope(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .envelope_read };
            defer wipeHarnessCustodyValue(&current);
            switch (marker_read) {
                .absent => {
                    // A v2 value without a marker has ambiguous provenance.
                    // Never invoke the JIT-capable bridge in that state.
                    if (current.state == .present)
                        return .{ .failed = .reconciliation };
                    var legacy_value: HarnessCustodyValue = undefined;
                    var failure_substage: LegacyHarnessCustodyFailureSubstage =
                        .admission;
                    if (!legacy.read_fn(
                        legacy.context,
                        legacy_gateway_path,
                        deadline.remaining(
                            legacy_harness_custody_timeout_ms,
                        ) orelse return legacyHarnessCustodyFailure(
                            .legacy_read,
                            .admission,
                        ),
                        &legacy_value,
                        &failure_substage,
                    )) return legacyHarnessCustodyFailure(
                        .legacy_read,
                        failure_substage,
                    );
                    defer wipeHarnessCustodyValue(&legacy_value);
                    if (legacy_value.state == .absent) {
                        var committed_absent = harnessAbsentCommittedMarker();
                        if (!writeHarnessReconciliationMarker(
                            helper,
                            helper_path,
                            &deadline,
                            .marker_commit,
                            &committed_absent,
                        )) return .{ .failed = .marker_commit };
                        return .{ .read = .{
                            .value = .{ .state = .absent },
                            .migrated_from_legacy = false,
                            .legacy_preserved = false,
                        } };
                    }
                    const migration_value = legacy_value.valueSlice() orelse
                        return .{ .failed = .reconciliation };
                    if (!canonicalHarnessInstallEnvelope(migration_value))
                        return .{ .failed = .reconciliation };
                    var prepared = harnessReconciliationMarkerForEnvelope(
                        .prepared,
                        .present,
                        migration_value,
                    );
                    if (!writeHarnessReconciliationMarker(
                        helper,
                        helper_path,
                        &deadline,
                        .marker_prepare,
                        &prepared,
                    )) return .{ .failed = .marker_prepare };
                    return migratePreparedHarnessEnvelope(
                        helper,
                        legacy,
                        helper_path,
                        legacy_gateway_path,
                        &deadline,
                        &prepared,
                        &current,
                        &legacy_value,
                    );
                },
                .present => |marker| switch (marker.phase) {
                    .prepared => return if (marker.legacy_state == .present)
                        migratePreparedHarnessEnvelope(
                            helper,
                            legacy,
                            helper_path,
                            legacy_gateway_path,
                            &deadline,
                            &marker,
                            &current,
                            null,
                        )
                    else
                        reconcilePreparedNativeHarnessSet(
                            helper,
                            helper_path,
                            &deadline,
                            &marker,
                            &current,
                        ),
                    .committed => {
                        if (!harnessMarkerMatchesValue(&marker, &current))
                            return .{ .failed = .reconciliation };
                        return .{ .read = .{
                            .value = current,
                            .migrated_from_legacy = false,
                            .legacy_preserved = marker.legacy_state == .present,
                        } };
                    },
                },
            }
        },
        .set_if_absent => {
            const requested = request.valueSlice() orelse
                return .{ .failed = .reconciliation };
            if (!canonicalHarnessInstallEnvelope(requested))
                return .{ .failed = .reconciliation };
            const marker_read = readHarnessReconciliationMarker(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .marker_read };
            const marker = switch (marker_read) {
                .absent => return .{ .failed = .reconciliation },
                .present => |present| present,
            };
            var current = readHarnessEnvelope(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .envelope_read };
            defer wipeHarnessCustodyValue(&current);

            if (marker.phase == .prepared) {
                return completePreparedNativeHarnessSet(
                    helper,
                    helper_path,
                    &deadline,
                    &marker,
                    &current,
                    requested,
                );
            }
            if (marker.envelope_state == .absent) {
                if (marker.legacy_state != .absent or
                    marker.envelopeSHA256() != null)
                {
                    return .{ .failed = .reconciliation };
                }
                const prepared = harnessReconciliationMarkerForEnvelope(
                    .prepared,
                    .absent,
                    requested,
                );
                if (!writeHarnessReconciliationMarker(
                    helper,
                    helper_path,
                    &deadline,
                    .marker_prepare,
                    &prepared,
                )) return .{ .failed = .marker_prepare };
                return completePreparedNativeHarnessSet(
                    helper,
                    helper_path,
                    &deadline,
                    &prepared,
                    &current,
                    requested,
                );
            }

            if (!harnessMarkerMatchesValue(&marker, &current))
                return .{ .failed = .reconciliation };
            const authoritative = current.valueSlice() orelse
                return .{ .failed = .reconciliation };
            if (!std.mem.eql(u8, requested, authoritative))
                return .{ .failed = .reconciliation };
            return .{ .set_if_absent = .{
                .value = current,
                .created = false,
            } };
        },
        .delete_both => {
            var deleted_v1 = false;
            var delete_failure_substage: LegacyHarnessCustodyFailureSubstage =
                .admission;
            if (!legacy.delete_fn(
                legacy.context,
                legacy_gateway_path,
                deadline.remaining(legacy_harness_custody_timeout_ms) orelse
                    return legacyHarnessCustodyFailure(
                        .legacy_delete,
                        .admission,
                    ),
                &deleted_v1,
                &delete_failure_substage,
            )) return legacyHarnessCustodyFailure(
                .legacy_delete,
                delete_failure_substage,
            );
            var legacy_after: HarnessCustodyValue = undefined;
            var read_failure_substage: LegacyHarnessCustodyFailureSubstage =
                .admission;
            if (!legacy.read_fn(
                legacy.context,
                legacy_gateway_path,
                deadline.remaining(legacy_harness_custody_timeout_ms) orelse
                    return legacyHarnessCustodyFailure(
                        .legacy_read,
                        .admission,
                    ),
                &legacy_after,
                &read_failure_substage,
            )) return legacyHarnessCustodyFailure(
                .legacy_read,
                read_failure_substage,
            );
            defer wipeHarnessCustodyValue(&legacy_after);
            if (legacy_after.state != .absent)
                return .{ .failed = .reconciliation };

            const deleted_v2 = deleteHarnessEnvelope(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .envelope_delete };
            var v2_after = readHarnessEnvelope(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .envelope_read };
            defer wipeHarnessCustodyValue(&v2_after);
            if (v2_after.state != .absent)
                return .{ .failed = .reconciliation };
            _ = deleteHarnessReconciliationMarker(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .marker_delete };
            const marker_after = readHarnessReconciliationMarker(
                helper,
                helper_path,
                &deadline,
            ) orelse return .{ .failed = .marker_read };
            switch (marker_after) {
                .absent => {},
                .present => return .{ .failed = .reconciliation },
            }
            return .{ .delete_both = .{
                .deleted_v1 = deleted_v1,
                .deleted_v2 = deleted_v2,
            } };
        },
    }
}

fn productionRemovalLaunchPathsAreValid(
    launch: *const RemovalLaunchEnvelope,
) bool {
    if (comptime !std.mem.eql(u8, build_options.platform, "macos")) {
        return false;
    }
    return hra_macos_validate_removal_launch_paths(
        launch.requestPath().ptr,
        launch.requestPath().len,
        launch.signingKeyPath().ptr,
        launch.signingKeyPath().len,
    );
}

fn productionRemovalPrepare(
    context: ?*anyopaque,
    helper_path: []const u8,
    mode: RemovalPreparation,
) bool {
    _ = context;
    if (comptime !std.mem.eql(u8, build_options.platform, "macos")) {
        return false;
    }
    if (!hra_macos_updater_enter_removal_maintenance()) {
        return false;
    }
    const trusted = hra_macos_verify_embedded_helper(
        helper_path.ptr,
        helper_path.len,
    );
    if (!trusted and mode == .requested) {
        // No gateway request has crossed the writer boundary yet, so this is
        // still a proven ordinary pre-quiesce rejection.
        hra_macos_updater_leave_removal_maintenance();
    }
    return trusted;
}

fn productionRemovalRollback(context: ?*anyopaque) void {
    _ = context;
    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        hra_macos_updater_leave_removal_maintenance();
    }
}

fn fixedRemovalHelperStateRoot(
    allocator: std.mem.Allocator,
) ![]u8 {
    var passwd: std.c.passwd = undefined;
    var buffer: [16 * 1024]u8 = undefined;
    var result: ?*std.c.passwd = null;
    if (std.c.getpwuid_r(
        std.c.geteuid(),
        &passwd,
        &buffer,
        buffer.len,
        &result,
    ) != 0 or result == null or passwd.dir == null) {
        return error.RemovalRecoveryHomeUnavailable;
    }
    const home = std.mem.span(passwd.dir.?);
    const normalized_home =
        try std.fs.path.resolve(allocator, &.{home});
    defer allocator.free(normalized_home);
    if (!std.fs.path.isAbsolute(home) or
        std.mem.indexOfScalar(u8, home, 0) != null or
        !std.mem.eql(u8, home, normalized_home))
    {
        return error.RemovalRecoveryHomeUnavailable;
    }
    return std.fs.path.join(
        allocator,
        &.{
            home,
            "Library",
            "Application Support",
            legacy_oprte_removal_helper_state_directory_name,
        },
    );
}

fn productionRemovalRecoverStaged(
    context: ?*anyopaque,
    allocator: std.mem.Allocator,
    io: std.Io,
    helper_path: []const u8,
    helper_state_root: []const u8,
) !void {
    _ = context;
    _ = allocator;
    _ = io;
    if (comptime !std.mem.eql(u8, build_options.platform, "macos")) {
        return error.RemovalHelperUnsupported;
    }
    var process_id: c_int = -1;
    if (!hra_macos_spawn_attested_removal_recovery(
        helper_path.ptr,
        helper_path.len,
        helper_state_root.ptr,
        helper_state_root.len,
        &process_id,
    )) return error.RemovalRecoveryHelperUntrusted;
    if (!hra_macos_wait_removal_helper(
        process_id,
        removal_recovery_helper_timeout_ms,
    )) {
        return error.RemovalRecoveryFailed;
    }
}

const AttestedRemovalChild = struct {
    /// Native only constructs this token after the suspended child image has
    /// matched the sealed embedded helper's exact CodeDirectory hash and the
    /// child has been resumed.
    process_id: c_int,
};

const RemovalChildReaper = *const fn (
    context: ?*anyopaque,
    process_id: c_int,
) void;

fn productionRemovalChildReaper(
    context: ?*anyopaque,
    process_id: c_int,
) void {
    _ = context;
    hra_macos_kill_and_reap_removal_helper(process_id);
}

fn waitForRemovalReadyAfterAttestedResume(
    io: std.Io,
    child: AttestedRemovalChild,
    read_fd: std.c.fd_t,
    timeout_ms: i64,
    reaper_context: ?*anyopaque,
    reaper: RemovalChildReaper,
) !void {
    var ownership_transferred = false;
    defer if (!ownership_transferred) {
        reaper(reaper_context, child.process_id);
    };
    // The deadline begins here, after the native suspended-spawn,
    // PID-attestation, and SIGCONT sequence has returned an attested token.
    try waitForRemovalReady(io, read_fd, timeout_ms);
    ownership_transferred = true;
}

fn productionRemovalSpawn(
    context: ?*anyopaque,
    allocator: std.mem.Allocator,
    io: std.Io,
    helper_path: []const u8,
    request_path: []const u8,
    signing_key_path: []const u8,
    parent_process_id: u32,
) !void {
    _ = context;
    _ = allocator;
    if (comptime !std.mem.eql(u8, build_options.platform, "macos")) {
        return error.RemovalHelperUnsupported;
    }
    var ready_pipe: [2]std.c.fd_t = undefined;
    if (std.c.pipe(&ready_pipe) != 0) {
        return error.RemovalReadyPipeFailed;
    }
    var read_open = true;
    defer {
        if (read_open) _ = std.c.close(ready_pipe[0]);
    }
    var write_open = true;
    defer {
        if (write_open) _ = std.c.close(ready_pipe[1]);
    }
    for (ready_pipe) |descriptor| {
        if (std.c.fcntl(
            descriptor,
            std.c.F.SETFD,
            @as(c_int, std.c.FD_CLOEXEC),
        ) != 0) {
            return error.RemovalReadyPipeFailed;
        }
    }

    var process_id: c_int = -1;
    if (!hra_macos_spawn_attested_removal_execute(
        helper_path.ptr,
        helper_path.len,
        request_path.ptr,
        request_path.len,
        signing_key_path.ptr,
        signing_key_path.len,
        parent_process_id,
        ready_pipe[1],
        &process_id,
    )) return error.RemovalHelperUntrusted;
    const child: AttestedRemovalChild = .{
        .process_id = process_id,
    };
    _ = std.c.close(ready_pipe[1]);
    write_open = false;

    try waitForRemovalReadyAfterAttestedResume(
        io,
        child,
        ready_pipe[0],
        removal_ready_timeout_ms,
        null,
        productionRemovalChildReaper,
    );
    _ = std.c.close(ready_pipe[0]);
    read_open = false;
    // The helper deliberately outlives this host. It verifies and waits for
    // this exact parent PID before touching any staged target. READY proves
    // that signed validation, the execution lock, and the parent watcher are
    // all established before Native commits to termination.
    std.mem.doNotOptimizeAway(child.process_id);
}

fn waitForRemovalReady(
    io: std.Io,
    read_fd: std.c.fd_t,
    timeout_ms: i64,
) !void {
    if (read_fd < 3 or timeout_ms <= 0) {
        return error.InvalidRemovalReadyChannel;
    }
    const started = std.Io.Clock.awake.now(io).toMilliseconds();
    var observed: [removal_ready_message.len + 1]u8 = undefined;
    var observed_len: usize = 0;
    while (true) {
        const now = std.Io.Clock.awake.now(io).toMilliseconds();
        const elapsed = @max(@as(i64, 0), now - started);
        if (elapsed >= timeout_ms) return error.RemovalReadyTimeout;
        const remaining: c_int = @intCast(@min(
            timeout_ms - elapsed,
            @as(i64, std.math.maxInt(c_int)),
        ));
        var descriptors = [1]std.c.pollfd{.{
            .fd = read_fd,
            .events = std.c.POLL.IN | std.c.POLL.HUP,
            .revents = 0,
        }};
        const ready = std.c.poll(&descriptors, 1, remaining);
        if (ready == 0) return error.RemovalReadyTimeout;
        if (ready < 0) {
            if (std.c.errno(ready) == .INTR) continue;
            return error.RemovalReadyReadFailed;
        }
        if (descriptors[0].revents &
            (std.c.POLL.ERR | std.c.POLL.NVAL) != 0)
        {
            return error.RemovalReadyReadFailed;
        }
        if (descriptors[0].revents &
            (std.c.POLL.IN | std.c.POLL.HUP) == 0)
        {
            return error.RemovalReadyReadFailed;
        }
        const count = std.c.read(
            read_fd,
            observed[observed_len..].ptr,
            observed.len - observed_len,
        );
        if (count > 0) {
            observed_len += @intCast(count);
            if (observed_len > removal_ready_message.len) {
                return error.MalformedRemovalReady;
            }
            continue;
        }
        if (count < 0) {
            if (std.c.errno(count) == .INTR) continue;
            return error.RemovalReadyReadFailed;
        }
        if (!std.mem.eql(
            u8,
            observed[0..observed_len],
            removal_ready_message,
        )) {
            return error.MalformedRemovalReady;
        }
        return;
    }
}

fn productionRemovalArmTerminationWatchdog(
    context: ?*anyopaque,
) bool {
    _ = context;
    if (comptime !std.mem.eql(u8, build_options.platform, "macos")) {
        return false;
    }
    return hra_macos_arm_application_termination_watchdog(
        removal_termination_watchdog_ms,
    );
}

fn productionRemovalTerminate(context: ?*anyopaque) void {
    _ = context;
    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        _ = hra_macos_request_application_termination();
    }
}

const production_removal_lifecycle: RemovalLifecycle = .{
    .context = null,
    .prepare_fn = productionRemovalPrepare,
    .rollback_fn = productionRemovalRollback,
    .spawn_fn = productionRemovalSpawn,
    .recover_staged_fn = productionRemovalRecoverStaged,
    .arm_termination_watchdog_fn = productionRemovalArmTerminationWatchdog,
    .terminate_fn = productionRemovalTerminate,
};

fn prepareRemovalHelper(
    lifecycle: RemovalLifecycle,
    helper_path: []const u8,
    mode: RemovalPreparation,
) !void {
    if (!lifecycle.prepare_fn(
        lifecycle.context,
        helper_path,
        mode,
    )) return error.RemovalHelperPreparationFailed;
}

fn rollbackRemovalHelper(lifecycle: RemovalLifecycle) void {
    lifecycle.rollback_fn(lifecycle.context);
}

fn spawnReadyRemovalHelper(
    lifecycle: RemovalLifecycle,
    allocator: std.mem.Allocator,
    io: std.Io,
    helper_path: []const u8,
    request_path: []const u8,
    signing_key_path: []const u8,
    parent_process_id: u32,
) !void {
    try lifecycle.spawn_fn(
        lifecycle.context,
        allocator,
        io,
        helper_path,
        request_path,
        signing_key_path,
        parent_process_id,
    );
}

fn recoverStagedRemovalHelper(
    lifecycle: RemovalLifecycle,
    allocator: std.mem.Allocator,
    io: std.Io,
    helper_path: []const u8,
    helper_state_root: []const u8,
) !void {
    try lifecycle.recover_staged_fn(
        lifecycle.context,
        allocator,
        io,
        helper_path,
        helper_state_root,
    );
}

fn armTerminationAfterReady(lifecycle: RemovalLifecycle) void {
    if (!lifecycle.arm_termination_watchdog_fn(
        lifecycle.context,
    )) {
        lifecycle.terminate_fn(lifecycle.context);
    }
}

fn terminateIfRemovalDeliveryFailed(
    lifecycle: RemovalLifecycle,
    delivered: bool,
) void {
    if (!delivered) lifecycle.terminate_fn(lifecycle.context);
}

/// Owns the private gateway process and all cross-thread queues.
///
/// Keep this value at a stable address from the first `dispatcher`/`start`
/// call until `stop` returns. Worker threads only enqueue owned bytes and call
/// the platform's thread-safe `wake`; Native SDK responders and renderer event
/// emission are exclusively drained by `onEvent` on `.effects_wake`.
pub const RuntimeHost = struct {
    allocator: std.mem.Allocator = std.heap.page_allocator,
    io: std.Io,
    parent_environment: *const std.process.Environ.Map,
    options: Options,

    mutex: std.Io.Mutex = .init,
    request_ready: std.Io.Condition = .init,
    account_profile_ready: std.Io.Condition = .init,
    harness_custody_ready: std.Io.Condition = .init,
    event_space_ready: std.Io.Condition = .init,
    recovery_ready: std.Io.Condition = .init,
    event_space_waiters: std.atomic.Value(usize) = .init(0),
    state: State = .idle,
    services: ?native_sdk.platform.PlatformServices = null,

    child: ?std.process.Child = null,
    writer_thread: ?std.Thread = null,
    reader_thread: ?std.Thread = null,
    account_profile_thread: ?std.Thread = null,
    harness_custody_thread: ?std.Thread = null,
    recovery_thread: ?std.Thread = null,
    writer_finished: std.atomic.Value(bool) = .init(false),
    reader_finished: std.atomic.Value(bool) = .init(false),
    reader_delivery_ready: std.atomic.Value(bool) = .init(false),
    account_profile_finished: std.atomic.Value(bool) = .init(false),
    harness_custody_finished: std.atomic.Value(bool) = .init(false),
    recovery_finished: std.atomic.Value(bool) = .init(false),
    reader_buffer: ?[]u8 = null,
    writer_buffer: ?[]u8 = null,
    data_remover_path: ?[]u8 = null,
    keychain_custodian_path: ?[]u8 = null,

    handlers: [6]native_sdk.bridge.AsyncHandler = undefined,
    pending: [max_pending_requests]?*Pending = .{null} ** max_pending_requests,
    pending_count: usize = 0,
    requests: [max_pending_requests]?*Pending = .{null} ** max_pending_requests,
    request_head: usize = 0,
    request_len: usize = 0,
    actions: [max_actions]?Action = .{null} ** max_actions,
    action_head: usize = 0,
    action_len: usize = 0,
    queued_events: usize = 0,
    queued_transport_lifecycles: usize = 0,
    renderer_delivery_in_flight: bool = false,
    renderer_delivery_retry_attempt: u8 = 0,
    account_profile_request: ?AccountProfileNativeRequest = null,
    account_profile_busy: bool = false,
    account_profile_result_reserved: bool = false,
    account_profile_reserved_id: [native_sdk.bridge.max_id_bytes]u8 = undefined,
    account_profile_reserved_id_len: usize = 0,
    harness_custody_request: ?HarnessCustodyNativeRequest = null,
    harness_custody_busy: bool = false,
    harness_custody_result_reserved: bool = false,
    harness_custody_reserved_id: [native_sdk.bridge.max_id_bytes]u8 = undefined,
    harness_custody_reserved_id_len: usize = 0,
    generation: u64 = 0,
    recovery_attempt: u8 = 0,
    recovery_requested: bool = false,
    generation_process_tree_contained: bool = true,
    terminal_removal_committed: bool = false,
    development_reload_sealed: bool = false,
    development_reload_accepted: bool = false,
    development_reload_candidate: [development_reload_candidate_bytes]u8 = undefined,
    development_reload_candidate_len: usize = 0,
    development_reload_desired_candidate: [development_reload_candidate_bytes]u8 = undefined,
    development_reload_desired_candidate_len: usize = 0,
    development_reload_target_generation: u64 = 0,
    recovery_shutdown: GenerationShutdown = .forced,
    recovery_skips_backoff: bool = false,

    pub fn init(process_init: std.process.Init, options: Options) RuntimeHost {
        return .{
            .io = process_init.io,
            .parent_environment = process_init.environ_map,
            .options = options,
        };
    }

    fn runtimeProfile(self: *const RuntimeHost) BridgeProfile {
        return resolvedRuntimeProfile(&self.options);
    }

    pub fn dispatcher(self: *RuntimeHost) native_sdk.bridge.Dispatcher {
        self.handlers[0] = .{
            .name = snapshot_command,
            .context = self,
            .invoke_fn = invoke,
        };
        self.handlers[1] = .{
            .name = dispatch_command,
            .context = self,
            .invoke_fn = invoke,
        };
        self.handlers[2] = .{
            .name = native_project_add_command,
            .context = self,
            .invoke_fn = invoke,
        };
        self.handlers[3] = .{
            .name = native_folder_access_select_command,
            .context = self,
            .invoke_fn = invoke,
        };
        self.handlers[4] = .{
            .name = transport_retry_command,
            .context = self,
            .invoke_fn = invoke,
        };
        self.handlers[5] = .{
            .name = transport_health_command,
            .context = self,
            .invoke_fn = invoke,
        };
        return .{
            .policy = bridgePolicy(self.options.bridge_profile),
            .async_registry = .{ .handlers = &self.handlers },
        };
    }

    pub fn start(self: *RuntimeHost, runtime: *native_sdk.Runtime) !void {
        self.mutex.lockUncancelable(self.io);
        if (self.state != .idle) {
            self.mutex.unlock(self.io);
            return error.RuntimeHostAlreadyStarted;
        }
        if (self.options.max_recovery_attempts == 0 or
            self.options.recovery_backoff_ms == 0)
        {
            self.mutex.unlock(self.io);
            return error.InvalidRuntimeRecoveryOptions;
        }
        self.services = runtime.options.platform.services;
        self.generation = 1;
        self.mutex.unlock(self.io);

        self.recovery_finished.store(false, .release);
        self.recovery_thread = std.Thread.spawn(
            .{},
            recoveryMain,
            .{self},
        ) catch |err| {
            self.mutex.lockUncancelable(self.io);
            self.state = .failed;
            self.mutex.unlock(self.io);
            return err;
        };

        self.launchGeneration(self.options.startup_removal_recovery) catch |err| {
            // A prepared local-data removal is an app-termination authority,
            // not an ordinary runtime start. Preserve its instance-guarded
            // fail-closed retry on the next app launch instead of starting a
            // gateway that was not explicitly placed in recovery-only mode.
            if (!self.scheduleInitialLaunchRecovery()) {
                self.beginStopping(
                    "Runtime removal recovery failed before the gateway started",
                );
                if (self.recovery_thread) |thread| thread.join();
                self.recovery_thread = null;
                self.cleanupGeneration(.forced);
                return err;
            }
        };
    }

    fn launchGeneration(
        self: *RuntimeHost,
        startup_removal_recovery: bool,
    ) !void {
        return self.launchGenerationFromPath(startup_removal_recovery, null);
    }

    fn launchGenerationFromPath(
        self: *RuntimeHost,
        startup_removal_recovery: bool,
        gateway_executable_path: ?[]const u8,
    ) !void {
        var paths = try resolveRuntimePaths(self.io, self.allocator, self.parent_environment, self.options.paths);
        defer paths.deinit(self.allocator);
        if (startup_removal_recovery) {
            const lifecycle =
                self.options.removal_lifecycle orelse
                production_removal_lifecycle;
            const helper_state_root =
                try fixedRemovalHelperStateRoot(self.allocator);
            defer self.allocator.free(helper_state_root);
            prepareRemovalHelper(
                lifecycle,
                paths.data_remover_path,
                .startup_recovery,
            ) catch {
                return error.RemovalRecoveryFailed;
            };
            recoverStagedRemovalHelper(
                lifecycle,
                self.allocator,
                self.io,
                paths.data_remover_path,
                helper_state_root,
            ) catch {
                return error.RemovalRecoveryFailed;
            };
        }
        var environment = try buildSanitizedEnvironment(
            self.allocator,
            self.parent_environment,
            &paths,
            self.runtimeProfile(),
            self.options.production_cloud,
        );
        defer environment.deinit();
        try addStartupRemovalRecoveryEnvironment(
            &environment,
            startup_removal_recovery,
        );
        self.data_remover_path =
            try self.allocator.dupe(u8, paths.data_remover_path);
        errdefer {
            if (self.data_remover_path) |path| {
                self.allocator.free(path);
                self.data_remover_path = null;
            }
        }
        self.keychain_custodian_path = try self.allocator.dupe(
            u8,
            paths.keychain_custodian_path,
        );
        errdefer {
            if (self.keychain_custodian_path) |path| {
                self.allocator.free(path);
                self.keychain_custodian_path = null;
            }
        }
        self.reader_buffer = try self.allocator.alloc(u8, reader_buffer_bytes);
        errdefer {
            if (self.reader_buffer) |buffer| {
                secureWipe(buffer);
                self.allocator.free(buffer);
                self.reader_buffer = null;
            }
        }
        self.writer_buffer = try self.allocator.alloc(u8, writer_buffer_bytes);
        errdefer {
            if (self.writer_buffer) |buffer| {
                secureWipe(buffer);
                self.allocator.free(buffer);
                self.writer_buffer = null;
            }
        }

        const executable_path = gateway_executable_path orelse paths.gateway_path;
        var child = try std.process.spawn(self.io, .{
            .argv = &.{executable_path},
            .environ_map = &environment,
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = gatewayStderrForMode(builtin.mode),
            // The gateway and every Codex app-server it launches belong to one
            // generation-scoped process group. Native recovery must fence the
            // complete provider tree before a replacement generation starts.
            .pgid = 0,
            .create_no_window = true,
        });
        var child_transferred = false;
        errdefer if (!child_transferred) {
            if (!terminateGatewayProcessTree(&child, self.io)) {
                self.generation_process_tree_contained = false;
            }
        };

        const stdin_file = child.stdin.?;
        const stdout_file = child.stdout.?;
        child.stdin = null;
        child.stdout = null;
        self.child = child;
        self.generation_process_tree_contained = true;
        child_transferred = true;

        self.writer_finished.store(false, .release);
        self.reader_finished.store(false, .release);
        self.reader_delivery_ready.store(false, .release);
        self.account_profile_finished.store(false, .release);
        self.harness_custody_finished.store(false, .release);
        if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
            // Both product and isolated source-development account-profile
            // helpers share this generation-scoped cancellation fence. The
            // selected runner still pins which Application Support root the
            // helper may open.
            hra_macos_prepare_attested_account_profile_operations();
        }
        if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
            if (self.options.harness_custody_runner == null) {
                hra_macos_prepare_attested_keychain_custodian_operations();
            }
        }
        self.mutex.lockUncancelable(self.io);
        if (self.state != .idle and self.state != .recovering) {
            self.mutex.unlock(self.io);
            stdin_file.close(self.io);
            stdout_file.close(self.io);
            if (self.child) |*installed_child| {
                self.generation_process_tree_contained =
                    terminateGatewayProcessTree(installed_child, self.io);
            }
            self.child = null;
            return error.RuntimeHostStopping;
        }
        self.state = .running;
        self.mutex.unlock(self.io);

        if (startup_removal_recovery) {
            self.enqueueStartupRemovalRecovery() catch |err| {
                stdin_file.close(self.io);
                stdout_file.close(self.io);
                self.abortGeneration(.recovering, "Runtime host failed to start");
                return err;
            };
        }
        self.writer_thread = std.Thread.spawn(.{}, writerMain, .{ self, stdin_file }) catch |err| {
            stdin_file.close(self.io);
            stdout_file.close(self.io);
            self.abortGeneration(.recovering, "Runtime host failed to start");
            return err;
        };
        self.account_profile_thread = std.Thread.spawn(
            .{},
            accountProfileMain,
            .{self},
        ) catch |err| {
            stdout_file.close(self.io);
            self.abortGeneration(.recovering, "Runtime host failed to start");
            return err;
        };
        self.harness_custody_thread = std.Thread.spawn(
            .{},
            harnessCustodyMain,
            .{self},
        ) catch |err| {
            stdout_file.close(self.io);
            self.abortGeneration(.recovering, "Runtime host failed to start");
            return err;
        };
        self.reader_thread = std.Thread.spawn(.{}, readerMain, .{ self, stdout_file }) catch |err| {
            stdout_file.close(self.io);
            self.abortGeneration(.recovering, "Runtime host failed to start");
            return err;
        };
        // Queue the generation boundary before the new reader can enqueue any
        // process-scoped event. The renderer then buffers every later event
        // behind a fresh authoritative snapshot for this generation.
        if (!self.queueTransportLifecycle(.ready)) {
            self.mutex.lockUncancelable(self.io);
            const generation_was_interrupted = self.state != .running;
            self.mutex.unlock(self.io);
            if (!generation_was_interrupted) {
                self.abortGeneration(
                    .failed,
                    "Runtime lifecycle delivery failed",
                );
                return error.RuntimeLifecycleDeliveryFailed;
            }
            return;
        }
        self.reader_delivery_ready.store(true, .release);
    }

    pub fn onEvent(self: *RuntimeHost, runtime: *native_sdk.Runtime, event: native_sdk.Event) void {
        switch (event) {
            .effects_wake => self.drain(runtime),
            .timer => |timer| if (timer.id == renderer_delivery_retry_timer_id) {
                self.drain(runtime);
            },
            else => {},
        }
    }

    pub fn stop(self: *RuntimeHost, runtime: *native_sdk.Runtime) void {
        self.beginStopping("Runtime host is shutting down");
        _ = self.queueTransportLifecycle(.stopping);
        const account_runner = self.options.account_profile_runner orelse
            production_account_profile_runner;
        account_runner.cancel_fn(account_runner.context);
        const harness_runner = self.options.harness_custody_runner orelse
            production_harness_custody_runner;
        harness_runner.cancel_fn(harness_runner.context);
        if (self.options.legacy_harness_custody_runner) |legacy_runner| {
            legacy_runner.cancel_fn(legacy_runner.context);
        }
        self.recovery_ready.broadcast(self.io);
        if (self.recovery_thread) |thread| thread.join();
        self.recovery_thread = null;

        self.cleanupGeneration(.graceful);
        self.drain(runtime);

        self.mutex.lockUncancelable(self.io);
        self.state = .stopped;
        self.recovery_requested = false;
        self.mutex.unlock(self.io);
        _ = self.queueTransportLifecycle(.stopped);
        self.drain(runtime);
        self.mutex.lockUncancelable(self.io);
        self.services = null;
        self.mutex.unlock(self.io);
    }

    fn cleanupGeneration(
        self: *RuntimeHost,
        shutdown: GenerationShutdown,
    ) void {
        if (self.writer_thread == null) self.writer_finished.store(true, .release);
        if (self.reader_thread == null) self.reader_finished.store(true, .release);
        if (self.account_profile_thread == null) {
            self.account_profile_finished.store(true, .release);
        }
        if (self.harness_custody_thread == null) {
            self.harness_custody_finished.store(true, .release);
        }
        if (shutdown == .forced) {
            if (self.child) |*child| {
                self.generation_process_tree_contained =
                    terminateGatewayProcessTree(child, self.io);
            }
        }
        const polls: usize = if (shutdown == .forced)
            1
        else
            @max(
                1,
                @as(usize, self.options.shutdown_grace_ms) /
                    @as(usize, shutdown_poll_ms),
            );
        for (0..polls) |_| {
            if (self.writer_finished.load(.acquire) and
                self.reader_finished.load(.acquire) and
                self.account_profile_finished.load(.acquire) and
                self.harness_custody_finished.load(.acquire)) break;
            std.Io.sleep(self.io, .fromMilliseconds(shutdown_poll_ms), .awake) catch break;
        }

        if (shutdown == .graceful) {
            if (self.child) |*child| {
                self.generation_process_tree_contained =
                    terminateGatewayProcessTree(child, self.io);
            }
        }
        if (self.writer_thread) |thread| thread.join();
        if (self.reader_thread) |thread| thread.join();
        if (self.account_profile_thread) |thread| thread.join();
        if (self.harness_custody_thread) |thread| thread.join();
        self.writer_thread = null;
        self.reader_thread = null;
        self.account_profile_thread = null;
        self.harness_custody_thread = null;
        self.child = null;

        if (self.reader_buffer) |buffer| secureWipeAndFree(self.allocator, buffer);
        if (self.writer_buffer) |buffer| secureWipeAndFree(self.allocator, buffer);
        if (self.data_remover_path) |path| self.allocator.free(path);
        if (self.keychain_custodian_path) |path| self.allocator.free(path);
        self.reader_buffer = null;
        self.writer_buffer = null;
        self.data_remover_path = null;
        self.keychain_custodian_path = null;
    }

    fn abortGeneration(
        self: *RuntimeHost,
        next_state: State,
        message: []const u8,
    ) void {
        std.debug.assert(next_state == .recovering or next_state == .failed);
        self.mutex.lockUncancelable(self.io);
        if (self.state == .running) self.failAllPendingLocked(message);
        self.state = next_state;
        self.request_ready.broadcast(self.io);
        self.account_profile_ready.broadcast(self.io);
        self.harness_custody_ready.broadcast(self.io);
        self.event_space_ready.broadcast(self.io);
        self.mutex.unlock(self.io);
        const account_runner = self.options.account_profile_runner orelse
            production_account_profile_runner;
        account_runner.cancel_fn(account_runner.context);
        const harness_runner = self.options.harness_custody_runner orelse
            production_harness_custody_runner;
        harness_runner.cancel_fn(harness_runner.context);
        if (self.options.legacy_harness_custody_runner) |legacy_runner| {
            legacy_runner.cancel_fn(legacy_runner.context);
        }
        self.cleanupGeneration(.forced);
    }

    fn retryAtUnixMilliseconds(self: *RuntimeHost, attempt: u8) u64 {
        const now = std.Io.Clock.real.now(self.io).toMilliseconds();
        const safe_now: u64 = @intCast(@max(@as(i64, 0), now));
        return safe_now +| recoveryDelayMilliseconds(
            self.options.recovery_backoff_ms,
            attempt,
        );
    }

    fn commitTerminalRemoval(self: *RuntimeHost) void {
        self.mutex.lockUncancelable(self.io);
        self.terminal_removal_committed = true;
        self.recovery_requested = false;
        self.recovery_ready.broadcast(self.io);
        self.mutex.unlock(self.io);
    }

    fn requestTransportRetry(self: *RuntimeHost) TransportRetryDecision {
        return self.requestTransportRetryMode(false);
    }

    fn requestTransportRetryMode(
        self: *RuntimeHost,
        force_if_running: bool,
    ) TransportRetryDecision {
        var decision: TransportRetryDecision = .{
            .status = .unavailable,
        };
        var force_fault = false;
        self.mutex.lockUncancelable(self.io);
        if (self.development_reload_sealed) {
            self.mutex.unlock(self.io);
            return decision;
        }
        switch (self.state) {
            .running => if (force_if_running) {
                decision.status = .accepted;
                force_fault = true;
            } else {
                decision.status = .already_ready;
            },
            .recovering => decision.status = .accepted,
            .failed => {
                if (!self.terminal_removal_committed and
                    self.generation < max_transport_generation)
                {
                    self.state = .recovering;
                    self.recovery_attempt = 1;
                    self.recovery_requested = true;
                    self.recovery_ready.signal(self.io);
                    decision = .{
                        .status = .accepted,
                        .scheduled_attempt = 1,
                    };
                }
            },
            .idle, .stopping, .stopped => {},
        }
        self.mutex.unlock(self.io);
        if (force_fault) {
            // A renderer invocation crossed its deadline while the child was
            // still nominally alive. Treat that live wedge as a transport
            // fault so pending calls fail, the old generation is fenced, and
            // bounded recovery rehydrates durable state. The ambiguous
            // operation is deliberately never replayed here.
            self.transportFault("The local runtime stopped responding.");
        }
        return decision;
    }

    fn releaseDevelopmentReloadSeal(self: *RuntimeHost) void {
        self.mutex.lockUncancelable(self.io);
        if (!self.development_reload_accepted) {
            self.development_reload_sealed = false;
            secureWipe(&self.development_reload_candidate);
            self.development_reload_candidate_len = 0;
        }
        self.mutex.unlock(self.io);
    }

    fn developmentReloadFileMatches(
        self: *RuntimeHost,
        path: []const u8,
        candidate: []const u8,
    ) bool {
        var digest = developmentReloadFileSHA256(
            self.io,
            path,
        ) catch return false;
        defer secureWipe(&digest);
        return std.mem.eql(u8, &digest, candidate);
    }

    fn developmentReloadStagedCandidateMatches(
        self: *RuntimeHost,
        candidate: []const u8,
    ) bool {
        var paths = resolveRuntimePaths(
            self.io,
            self.allocator,
            self.parent_environment,
            self.options.paths,
        ) catch return false;
        defer paths.deinit(self.allocator);
        const candidate_path = developmentReloadCandidatePath(
            self.allocator,
            paths.gateway_path,
            candidate,
        ) catch return false;
        defer self.allocator.free(candidate_path);
        return self.developmentReloadFileMatches(candidate_path, candidate);
    }

    fn resolveDevelopmentReloadLaunchPath(
        self: *RuntimeHost,
        candidate: []const u8,
    ) ![]u8 {
        var paths = try resolveRuntimePaths(
            self.io,
            self.allocator,
            self.parent_environment,
            self.options.paths,
        );
        defer paths.deinit(self.allocator);
        const candidate_path = try developmentReloadCandidatePath(
            self.allocator,
            paths.gateway_path,
            candidate,
        );
        if (self.developmentReloadFileMatches(candidate_path, candidate)) {
            return candidate_path;
        }
        self.allocator.free(candidate_path);
        if (!self.developmentReloadFileMatches(paths.gateway_path, candidate)) {
            return error.InvalidDevelopmentReloadCandidate;
        }
        return self.allocator.dupe(u8, paths.gateway_path);
    }

    fn respondDevelopmentReloadStatus(
        self: *RuntimeHost,
        responder: native_sdk.bridge.AsyncResponder,
        request_id: []const u8,
        status: []const u8,
        candidate: []const u8,
        current_generation: u64,
        next_generation: ?u64,
    ) void {
        const encoded = encodeDevelopmentReloadResult(
            self.allocator,
            null,
            status,
            candidate,
            current_generation,
            next_generation,
        ) catch {
            respondError(
                responder,
                request_id,
                .internal_error,
                "Development reload response allocation failed",
            );
            return;
        };
        defer self.allocator.free(encoded);
        responder.success(request_id, encoded) catch {};
    }

    fn invokeDevelopmentReload(
        self: *RuntimeHost,
        invocation: native_sdk.bridge.Invocation,
        responder: native_sdk.bridge.AsyncResponder,
        candidate: []const u8,
    ) void {
        if (!developmentReloadAvailable(self.options.bridge_profile)) {
            respondError(
                responder,
                invocation.request.id,
                .invalid_request,
                "Development reload is unavailable",
            );
            return;
        }

        var current_generation: u64 = 0;
        var admitted = false;
        self.mutex.lockUncancelable(self.io);
        current_generation = self.generation;
        if (self.state == .running and
            self.generation < max_transport_generation and
            !self.terminal_removal_committed and
            !self.development_reload_sealed and
            self.pending_count == 0 and
            self.request_len == 0 and
            self.action_len == 0 and
            !self.renderer_delivery_in_flight and
            !self.account_profile_busy and
            self.account_profile_request == null and
            !self.account_profile_result_reserved and
            !self.harness_custody_busy and
            self.harness_custody_request == null and
            !self.harness_custody_result_reserved)
        {
            self.development_reload_sealed = true;
            self.development_reload_candidate_len = candidate.len;
            @memcpy(
                self.development_reload_candidate[0..candidate.len],
                candidate,
            );
            admitted = true;
        }
        self.mutex.unlock(self.io);
        if (!admitted) {
            self.respondDevelopmentReloadStatus(
                responder,
                invocation.request.id,
                "unavailable",
                candidate,
                current_generation,
                null,
            );
            return;
        }

        const request = encodeRequestWithRemovalCapability(
            self.allocator,
            invocation.request.id,
            private_development_reload_command,
            invocation.request.payload,
            null,
        ) catch |err| {
            self.releaseDevelopmentReloadSeal();
            const code: native_sdk.bridge.ErrorCode = switch (err) {
                error.InvalidRequestId, error.InvalidJson, error.InvalidTrustedDirectoryPath => .invalid_request,
                error.MessageTooLarge => .payload_too_large,
                error.OutOfMemory => .internal_error,
            };
            respondError(responder, invocation.request.id, code, @errorName(err));
            return;
        };
        const pending = self.allocator.create(Pending) catch {
            secureWipeAndFree(self.allocator, request);
            self.releaseDevelopmentReloadSeal();
            respondError(
                responder,
                invocation.request.id,
                .internal_error,
                "OutOfMemory",
            );
            return;
        };
        pending.* = .{
            .id = undefined,
            .id_len = invocation.request.id.len,
            .destination = .{ .development_reload = responder },
            .request = request,
            .development_reload_candidate = undefined,
            .development_reload_candidate_len = candidate.len,
        };
        @memcpy(pending.id[0..pending.id_len], invocation.request.id);
        @memcpy(
            pending.development_reload_candidate[0..candidate.len],
            candidate,
        );

        self.mutex.lockUncancelable(self.io);
        if (self.state != .running or
            !self.development_reload_sealed or
            self.pending_count != 0 or
            self.request_len != 0 or
            self.findPendingLocked(invocation.request.id) != null)
        {
            self.development_reload_sealed = false;
            secureWipe(&self.development_reload_candidate);
            self.development_reload_candidate_len = 0;
            self.mutex.unlock(self.io);
            secureWipeAndFree(self.allocator, request);
            secureWipe(&pending.development_reload_candidate);
            self.allocator.destroy(pending);
            respondError(
                responder,
                invocation.request.id,
                .handler_failed,
                "Development reload became unavailable",
            );
            return;
        }
        self.insertPendingLocked(pending) catch unreachable;
        self.requests[self.request_head] = pending;
        self.request_len = 1;
        self.request_ready.signal(self.io);
        self.mutex.unlock(self.io);
    }

    fn scheduleInitialLaunchRecovery(self: *RuntimeHost) bool {
        self.mutex.lockUncancelable(self.io);
        if (self.options.startup_removal_recovery or
            self.state == .stopping or self.state == .stopped)
        {
            self.mutex.unlock(self.io);
            return false;
        }
        self.state = .recovering;
        self.recovery_attempt = 1;
        self.recovery_requested = true;
        self.recovery_ready.signal(self.io);
        self.mutex.unlock(self.io);
        _ = self.queueTransportLifecycle(.{ .backing_off = .{
            .attempt = 1,
            .retry_at_unix_milliseconds = self.retryAtUnixMilliseconds(1),
        } });
        return true;
    }

    fn queueTransportLifecycle(
        self: *RuntimeHost,
        lifecycle: TransportLifecycle,
    ) bool {
        self.mutex.lockUncancelable(self.io);
        const enabled = self.services != null;
        const generation = self.generation;
        self.mutex.unlock(self.io);
        if (!enabled) return false;
        const bytes = encodeTransportLifecycle(
            self.allocator,
            generation,
            lifecycle,
        ) catch return false;
        self.mutex.lockUncancelable(self.io);
        const current = transportLifecycleIsCurrent(
            self.state,
            self.generation,
            generation,
            lifecycle,
        );
        const queued = current and self.pushActionLocked(.{
            .transport_lifecycle = bytes,
        });
        self.mutex.unlock(self.io);
        if (!queued) {
            self.allocator.free(bytes);
            return false;
        }
        _ = self.wake();
        return true;
    }

    fn waitForRecoveryDelay(
        self: *RuntimeHost,
        attempt: u8,
    ) bool {
        var remaining: i64 = recoveryDelayMilliseconds(
            self.options.recovery_backoff_ms,
            attempt,
        );
        while (remaining > 0) {
            self.mutex.lockUncancelable(self.io);
            const active = self.state == .recovering and
                self.recovery_attempt == attempt and
                !self.terminal_removal_committed;
            self.mutex.unlock(self.io);
            if (!active) return false;
            const slice = @min(remaining, recovery_poll_ms);
            std.Io.sleep(
                self.io,
                .fromMilliseconds(slice),
                .awake,
            ) catch return false;
            remaining -= slice;
        }
        return true;
    }

    fn recoveryMain(self: *RuntimeHost) void {
        defer self.recovery_finished.store(true, .release);
        while (true) {
            self.mutex.lockUncancelable(self.io);
            while (!self.recovery_requested and
                self.state != .stopping and
                self.state != .stopped)
            {
                self.recovery_ready.waitUncancelable(
                    self.io,
                    &self.mutex,
                );
            }
            if (self.state == .stopping or self.state == .stopped) {
                self.mutex.unlock(self.io);
                return;
            }
            const attempt = self.recovery_attempt;
            const shutdown = self.recovery_shutdown;
            const skips_backoff = self.recovery_skips_backoff;
            self.recovery_requested = false;
            self.recovery_shutdown = .forced;
            self.recovery_skips_backoff = false;
            self.mutex.unlock(self.io);

            // Fence the failed generation before spending any retry backoff.
            // A fatal bundled-Git boundary deliberately exits the gateway
            // while its synchronous helpers still share this PGID; leaving
            // cleanup until after the delay would permit old mutations to keep
            // running even though no replacement can yet start.
            self.cleanupGeneration(shutdown);

            self.mutex.lockUncancelable(self.io);
            if (!self.generation_process_tree_contained) {
                self.state = .failed;
                self.recovery_requested = false;
                self.mutex.unlock(self.io);
                _ = self.queueTransportLifecycle(.{ .failed = .{
                    .can_retry = false,
                    .message = "The prior Codex process tree could not be fenced. Restart HRA before sending another message.",
                } });
                continue;
            }
            self.mutex.unlock(self.io);

            if (!skips_backoff and
                !self.waitForRecoveryDelay(attempt)) continue;

            self.mutex.lockUncancelable(self.io);
            var development_candidate: [development_reload_candidate_bytes]u8 = undefined;
            const has_development_candidate =
                self.development_reload_desired_candidate_len ==
                development_reload_candidate_bytes;
            if (has_development_candidate) {
                @memcpy(
                    &development_candidate,
                    &self.development_reload_desired_candidate,
                );
            }
            self.mutex.unlock(self.io);
            defer secureWipe(&development_candidate);
            const development_gateway_path = if (has_development_candidate)
                self.resolveDevelopmentReloadLaunchPath(
                    &development_candidate,
                ) catch {
                    self.mutex.lockUncancelable(self.io);
                    if (self.state == .recovering) {
                        self.state = .failed;
                        self.recovery_requested = false;
                    }
                    self.mutex.unlock(self.io);
                    _ = self.queueTransportLifecycle(.{ .failed = .{
                        .can_retry = false,
                        .message = "The staged development runtime changed before launch. Restart HRA.",
                    } });
                    continue;
                }
            else
                null;
            defer if (development_gateway_path) |path| {
                self.allocator.free(path);
            };

            self.mutex.lockUncancelable(self.io);
            if (self.state != .recovering or
                self.terminal_removal_committed)
            {
                self.mutex.unlock(self.io);
                continue;
            }
            const development_target_generation =
                if (self.development_reload_accepted)
                    self.development_reload_target_generation
                else
                    0;
            if (development_target_generation != 0) {
                if (development_target_generation > max_transport_generation or
                    self.generation > development_target_generation)
                {
                    self.state = .failed;
                    self.recovery_requested = false;
                    self.mutex.unlock(self.io);
                    _ = self.queueTransportLifecycle(.{ .failed = .{
                        .can_retry = false,
                        .message = "The development runtime generation reservation became invalid. Restart HRA.",
                    } });
                    continue;
                }
                self.generation = development_target_generation;
            } else if (self.generation >= max_transport_generation) {
                self.state = .failed;
                self.recovery_requested = false;
                self.mutex.unlock(self.io);
                _ = self.queueTransportLifecycle(.{ .failed = .{
                    .can_retry = false,
                    .message = "The local runtime generation limit was reached. Restart HRA.",
                } });
                continue;
            } else {
                self.generation += 1;
            }
            self.mutex.unlock(self.io);
            _ = self.queueTransportLifecycle(.starting);

            self.launchGenerationFromPath(
                false,
                development_gateway_path,
            ) catch {
                self.scheduleNextRecovery(attempt);
                continue;
            };
            self.mutex.lockUncancelable(self.io);
            if (self.development_reload_accepted) {
                self.development_reload_sealed = false;
                self.development_reload_accepted = false;
                self.development_reload_target_generation = 0;
                secureWipe(&self.development_reload_candidate);
                self.development_reload_candidate_len = 0;
            }
            self.mutex.unlock(self.io);
        }
    }

    fn terminateGatewayProcessTree(
        child: *std.process.Child,
        io: std.Io,
    ) bool {
        return terminateGatewayProcessTreeWithPollPreparation(
            child,
            io,
            null,
        );
    }

    fn terminateGatewayProcessTreeWithPollPreparation(
        child: *std.process.Child,
        io: std.Io,
        poll_preparation: ?GroupRetirementPollPreparation,
    ) bool {
        // std.process.Child retains this exact, unreaped birth until kill/wait
        // returns and clears `id`. POSIX cannot reuse its PID, or create an
        // unrelated group with that numeric ID, while the leader is live or a
        // zombie owned by this Child handle.
        const process_id = child.id orelse return true;
        var contained = true;
        if (comptime builtin.os.tag != .windows and builtin.os.tag != .wasi) {
            // Spawn used pgid=0, so current kernel evidence must still bind the
            // unreaped owned birth to the group before Native signals it.
            if (!gatewayGroupMatchesUnreapedChild(
                process_id,
                getpgid(process_id),
            )) {
                contained = false;
            } else {
                // This is the only group-directed signal. It happens while the
                // unreaped leader still reserves both numeric identities.
                std.posix.kill(-process_id, .KILL) catch |err| switch (err) {
                    error.ProcessNotFound => {},
                    error.PermissionDenied, error.Unexpected => contained = false,
                };
            }
        }
        // Reap the gateway even when the group signal failed. The false return
        // prevents Native from starting a second provider generation whose
        // effects could overlap an uncontained descendant.
        child.kill(io);
        if (!contained) return false;
        if (comptime builtin.os.tag == .windows or builtin.os.tag == .wasi) {
            return true;
        }

        // Tests may synchronously reap another directly owned group member
        // here, after the real group SIGKILL and before the first real kernel
        // absence poll. Production passes null and retains the exact signal,
        // timeout, and fail-closed oracle below.
        if (poll_preparation) |preparation| {
            if (!preparation.run_fn(preparation.context, io)) return false;
        }

        // Signal delivery is not exit evidence. Observe only after the one
        // generation-wide SIGKILL and fail closed until the old group ID has
        // disappeared. Never signal again while polling: if the numeric ID is
        // later reused by a foreign group, recovery stops instead of targeting
        // a process Native did not launch.
        var remaining = generation_fence_wait_ms;
        while (remaining > 0) : (remaining -= shutdown_poll_ms) {
            std.posix.kill(-process_id, @enumFromInt(0)) catch |err| switch (err) {
                error.ProcessNotFound => return true,
                error.PermissionDenied, error.Unexpected => return false,
            };
            std.Io.sleep(
                io,
                .fromMilliseconds(shutdown_poll_ms),
                .awake,
            ) catch return false;
        }
        return false;
    }

    /// A spawn and a syntactically successful gateway response prove only that
    /// the child exists. Reset the budget only after the trusted renderer has
    /// parsed the complete snapshot for this exact Native generation.
    fn recordGenerationHealthEvidence(
        self: *RuntimeHost,
        generation: u64,
    ) bool {
        var accepted = false;
        self.mutex.lockUncancelable(self.io);
        if (self.state == .running and
            self.generation == generation and
            !self.development_reload_sealed)
        {
            self.recovery_attempt = 0;
            accepted = true;
        }
        self.mutex.unlock(self.io);
        return accepted;
    }

    fn scheduleNextRecovery(
        self: *RuntimeHost,
        completed_attempt: u8,
    ) void {
        self.mutex.lockUncancelable(self.io);
        if (self.state == .stopping or self.state == .stopped or
            self.terminal_removal_committed)
        {
            self.mutex.unlock(self.io);
            return;
        }
        if (completed_attempt >= self.options.max_recovery_attempts) {
            self.state = .failed;
            self.recovery_attempt = completed_attempt;
            self.recovery_requested = false;
            self.mutex.unlock(self.io);
            _ = self.queueTransportLifecycle(.{ .failed = .{
                .can_retry = true,
                .message = "The local runtime stopped after bounded recovery attempts.",
            } });
            return;
        }
        const next_attempt = completed_attempt + 1;
        self.state = .recovering;
        self.recovery_attempt = next_attempt;
        self.recovery_requested = true;
        self.recovery_ready.signal(self.io);
        self.mutex.unlock(self.io);
        _ = self.queueTransportLifecycle(.{ .backing_off = .{
            .attempt = next_attempt,
            .retry_at_unix_milliseconds = self.retryAtUnixMilliseconds(
                next_attempt,
            ),
        } });
    }

    fn invoke(
        context: *anyopaque,
        invocation: native_sdk.bridge.Invocation,
        responder: native_sdk.bridge.AsyncResponder,
    ) anyerror!void {
        const self: *RuntimeHost = @ptrCast(@alignCast(context));
        const command = invocation.request.command;
        if (std.mem.eql(u8, command, transport_retry_command)) {
            self.invokeTransportRetry(invocation, responder);
            return;
        }
        if (std.mem.eql(u8, command, transport_health_command)) {
            self.invokeTransportHealth(invocation, responder);
            return;
        }
        self.mutex.lockUncancelable(self.io);
        const development_admission_closed = self.development_reload_sealed;
        self.mutex.unlock(self.io);
        if (development_admission_closed) {
            respondError(
                responder,
                invocation.request.id,
                .handler_failed,
                "Runtime admission is closed",
            );
            return;
        }
        if (std.mem.eql(u8, command, native_project_add_command)) {
            self.invokeProjectAdd(invocation, responder);
            return;
        }
        if (std.mem.eql(u8, command, native_folder_access_select_command)) {
            self.invokeFolderAccessSelect(invocation, responder);
            return;
        }
        const removal = if (std.mem.eql(
            u8,
            command,
            dispatch_command,
        ))
            parseRemovalConfirmation(
                self.allocator,
                invocation.request.payload,
            ) catch {
                respondError(
                    responder,
                    invocation.request.id,
                    .invalid_request,
                    "Invalid local-data removal confirmation",
                );
                return;
            }
        else
            null;
        const removal_lifecycle: ?RemovalLifecycle =
            if (removal != null)
                self.options.removal_lifecycle orelse
                    production_removal_lifecycle
            else
                null;
        var removal_exclusion_owned = false;
        defer if (removal_exclusion_owned) {
            rollbackRemovalHelper(removal_lifecycle.?);
        };
        if (removal != null) {
            const helper_path = self.data_remover_path orelse {
                respondError(
                    responder,
                    invocation.request.id,
                    .handler_failed,
                    "Local-data removal is unavailable",
                );
                return;
            };
            prepareRemovalHelper(
                removal_lifecycle.?,
                helper_path,
                .requested,
            ) catch {
                respondError(
                    responder,
                    invocation.request.id,
                    .handler_failed,
                    "Local-data removal is unavailable",
                );
                return;
            };
            removal_exclusion_owned = true;
        }
        var removal_deletion_capability = if (removal != null)
            generateRemovalDeletionCapability(self.io) catch {
                respondError(
                    responder,
                    invocation.request.id,
                    .internal_error,
                    "Removal capability entropy is unavailable",
                );
                return;
            }
        else
            null;
        defer if (removal_deletion_capability) |*capability| {
            @memset(capability, 0);
        };
        const request = encodeRequestWithRemovalCapability(
            self.allocator,
            invocation.request.id,
            command,
            invocation.request.payload,
            if (removal_deletion_capability) |*capability|
                capability
            else
                null,
        ) catch |err| {
            const code: native_sdk.bridge.ErrorCode = switch (err) {
                error.InvalidRequestId, error.InvalidJson, error.InvalidTrustedDirectoryPath => .invalid_request,
                error.MessageTooLarge => .payload_too_large,
                error.OutOfMemory => .internal_error,
            };
            respondError(responder, invocation.request.id, code, @errorName(err));
            return;
        };
        errdefer secureWipeAndFree(self.allocator, request);

        const pending = self.allocator.create(Pending) catch {
            respondError(responder, invocation.request.id, .internal_error, "OutOfMemory");
            return;
        };
        errdefer self.allocator.destroy(pending);
        pending.* = .{
            .id = undefined,
            .id_len = invocation.request.id.len,
            .destination = .{ .renderer = .{
                .responder = responder,
                .removal = removal,
            } },
            .request = request,
        };
        @memcpy(pending.id[0..pending.id_len], invocation.request.id);
        if (removal_deletion_capability) |capability| {
            @memcpy(
                &pending.removal_deletion_capability,
                &capability,
            );
            pending.removal_deletion_capability_len = capability.len;
        }

        const Rejection = struct {
            code: native_sdk.bridge.ErrorCode,
            message: []const u8,
        };
        var rejection: ?Rejection = null;
        self.mutex.lockUncancelable(self.io);
        if (self.state != .running) {
            rejection = .{ .code = .handler_failed, .message = "Runtime host is unavailable" };
        } else if (!self.rendererRequestCapacityAvailableLocked(
            command,
        )) {
            rejection = .{ .code = .handler_failed, .message = "Runtime request queue is full" };
        } else if (!self.requestIdAvailableLocked(invocation.request.id)) {
            rejection = .{ .code = .invalid_request, .message = "Runtime request id is already pending" };
        }
        if (rejection) |failure| {
            self.mutex.unlock(self.io);
            secureWipeAndFree(self.allocator, request);
            secureWipe(&pending.removal_deletion_capability);
            self.allocator.destroy(pending);
            respondError(responder, invocation.request.id, failure.code, failure.message);
            return;
        }

        self.insertPendingLocked(pending) catch unreachable;
        const request_index = (self.request_head + self.request_len) % self.requests.len;
        self.requests[request_index] = pending;
        self.request_len += 1;
        self.request_ready.signal(self.io);
        self.mutex.unlock(self.io);
        removal_exclusion_owned = false;
    }

    fn invokeTransportRetry(
        self: *RuntimeHost,
        invocation: native_sdk.bridge.Invocation,
        responder: native_sdk.bridge.AsyncResponder,
    ) void {
        var parsed = std.json.parseFromSlice(
            std.json.Value,
            self.allocator,
            invocation.request.payload,
            .{},
        ) catch {
            respondError(
                responder,
                invocation.request.id,
                .invalid_request,
                "Invalid transport retry request",
            );
            return;
        };
        defer parsed.deinit();
        const object = switch (parsed.value) {
            .object => |value| value,
            else => {
                respondError(
                    responder,
                    invocation.request.id,
                    .invalid_request,
                    "Invalid transport retry request",
                );
                return;
            },
        };
        const version = switch (object.get("version") orelse .null) {
            .integer => |value| value,
            else => 0,
        };
        if (object.get("mode")) |mode_value| {
            if (!developmentReloadAvailable(self.options.bridge_profile)) {
                respondError(
                    responder,
                    invocation.request.id,
                    .invalid_request,
                    "Development reload is unavailable",
                );
                return;
            }
            const mode = switch (mode_value) {
                .string => |value| value,
                else => {
                    respondError(
                        responder,
                        invocation.request.id,
                        .invalid_request,
                        "Invalid transport retry request",
                    );
                    return;
                },
            };
            const candidate = switch (object.get("candidateId") orelse .null) {
                .string => |value| value,
                else => {
                    respondError(
                        responder,
                        invocation.request.id,
                        .invalid_request,
                        "Invalid transport retry request",
                    );
                    return;
                },
            };
            if (object.count() != 3 or
                version != transport_lifecycle_version or
                !std.mem.eql(u8, mode, "developmentReload") or
                !validPrefixedLowerHex(
                    candidate,
                    "",
                    development_reload_candidate_bytes,
                ))
            {
                respondError(
                    responder,
                    invocation.request.id,
                    .invalid_request,
                    "Invalid transport retry request",
                );
                return;
            }
            self.invokeDevelopmentReload(invocation, responder, candidate);
            return;
        }
        const force_if_running = switch (object.count()) {
            1 => false,
            2 => switch (object.get("forceIfRunning") orelse .null) {
                .bool => |value| value,
                else => {
                    respondError(
                        responder,
                        invocation.request.id,
                        .invalid_request,
                        "Invalid transport retry request",
                    );
                    return;
                },
            },
            else => {
                respondError(
                    responder,
                    invocation.request.id,
                    .invalid_request,
                    "Invalid transport retry request",
                );
                return;
            },
        };
        if (version != transport_lifecycle_version) {
            respondError(
                responder,
                invocation.request.id,
                .invalid_request,
                "Invalid transport retry request",
            );
            return;
        }

        const decision = self.requestTransportRetryMode(force_if_running);
        if (decision.scheduled_attempt) |attempt| {
            _ = self.queueTransportLifecycle(.{ .backing_off = .{
                .attempt = attempt,
                .retry_at_unix_milliseconds = self.retryAtUnixMilliseconds(
                    attempt,
                ),
            } });
        }
        var response: [64]u8 = undefined;
        const encoded = std.fmt.bufPrint(
            &response,
            "{{\"version\":1,\"status\":\"{s}\"}}",
            .{decision.status.text()},
        ) catch unreachable;
        responder.success(invocation.request.id, encoded) catch {};
    }

    fn invokeTransportHealth(
        self: *RuntimeHost,
        invocation: native_sdk.bridge.Invocation,
        responder: native_sdk.bridge.AsyncResponder,
    ) void {
        var parsed = std.json.parseFromSlice(
            std.json.Value,
            self.allocator,
            invocation.request.payload,
            .{},
        ) catch {
            respondError(
                responder,
                invocation.request.id,
                .invalid_request,
                "Invalid transport health request",
            );
            return;
        };
        defer parsed.deinit();
        const object = switch (parsed.value) {
            .object => |value| value,
            else => {
                respondError(
                    responder,
                    invocation.request.id,
                    .invalid_request,
                    "Invalid transport health request",
                );
                return;
            },
        };
        if (object.count() != 2) {
            respondError(
                responder,
                invocation.request.id,
                .invalid_request,
                "Invalid transport health request",
            );
            return;
        }
        const version = switch (object.get("version") orelse .null) {
            .integer => |value| value,
            else => 0,
        };
        const generation_value = switch (object.get("generation") orelse .null) {
            .integer => |value| value,
            else => 0,
        };
        if (version != transport_lifecycle_version or
            generation_value <= 0 or
            generation_value > max_transport_generation)
        {
            respondError(
                responder,
                invocation.request.id,
                .invalid_request,
                "Invalid transport health request",
            );
            return;
        }
        const generation: u64 = @intCast(generation_value);
        if (!self.recordGenerationHealthEvidence(generation)) {
            respondError(
                responder,
                invocation.request.id,
                .handler_failed,
                "Transport generation is no longer current",
            );
            return;
        }
        var response: [96]u8 = undefined;
        const encoded = std.fmt.bufPrint(
            &response,
            "{{\"version\":1,\"generation\":{d},\"status\":\"accepted\"}}",
            .{generation},
        ) catch unreachable;
        responder.success(invocation.request.id, encoded) catch {};
    }

    fn invokeProjectAdd(
        self: *RuntimeHost,
        invocation: native_sdk.bridge.Invocation,
        responder: native_sdk.bridge.AsyncResponder,
    ) void {
        validateProjectAddRequest(self.allocator, invocation.request.payload) catch {
            respondError(responder, invocation.request.id, .invalid_request, "Invalid project-add request");
            return;
        };

        var path_buffer: [max_trusted_directory_path_bytes]u8 = undefined;
        switch (self.chooseDirectory(&path_buffer)) {
            .cancelled => responder.success(invocation.request.id, "{\"version\":3,\"status\":\"cancelled\"}") catch {},
            .failed => respondError(responder, invocation.request.id, .handler_failed, "Directory selection failed"),
            .selected => |path_len| self.enqueueNativeProjectOnboarding(
                invocation.request.id,
                path_buffer[0..path_len],
                .{ .renderer = .{ .responder = responder } },
            ) catch |err| {
                const code: native_sdk.bridge.ErrorCode = switch (err) {
                    error.InvalidRequestId, error.InvalidTrustedDirectoryPath => .invalid_request,
                    error.OutOfMemory => .internal_error,
                    else => .handler_failed,
                };
                respondError(responder, invocation.request.id, code, @errorName(err));
            },
        }
    }

    fn invokeFolderAccessSelect(
        self: *RuntimeHost,
        invocation: native_sdk.bridge.Invocation,
        responder: native_sdk.bridge.AsyncResponder,
    ) void {
        validateFolderAccessSelectRequest(
            self.allocator,
            invocation.request.payload,
        ) catch {
            respondError(
                responder,
                invocation.request.id,
                .invalid_request,
                "Invalid folder-access request",
            );
            return;
        };

        var path_buffer: [max_trusted_directory_path_bytes]u8 = undefined;
        switch (self.chooseDirectory(&path_buffer)) {
            .cancelled => responder.success(
                invocation.request.id,
                "{\"version\":3,\"status\":\"cancelled\"}",
            ) catch {},
            .failed => respondError(
                responder,
                invocation.request.id,
                .handler_failed,
                "Directory selection failed",
            ),
            .selected => |path_len| self.enqueueNativeFolderAccessSelect(
                invocation.request.id,
                path_buffer[0..path_len],
                .{ .renderer = .{ .responder = responder } },
            ) catch |err| {
                const code: native_sdk.bridge.ErrorCode = switch (err) {
                    error.InvalidRequestId, error.InvalidTrustedDirectoryPath => .invalid_request,
                    error.OutOfMemory => .internal_error,
                    else => .handler_failed,
                };
                respondError(
                    responder,
                    invocation.request.id,
                    code,
                    @errorName(err),
                );
            },
        }
    }

    fn chooseDirectory(self: *RuntimeHost, output: []u8) DirectoryChoice {
        const choice: DirectoryChoice = if (self.options.directory_picker) |picker|
            picker.choose_fn(picker.context, output)
        else if (comptime std.mem.eql(u8, build_options.platform, "macos")) blk: {
            const result = hra_macos_choose_directory(output.ptr, output.len);
            break :blk switch (result.status) {
                0 => .cancelled,
                1 => .{ .selected = result.path_len },
                else => .failed,
            };
        } else .failed;
        return switch (choice) {
            .selected => |path_len| if (path_len <= output.len) choice else .failed,
            else => choice,
        };
    }

    fn enqueueNativeProjectOnboarding(
        self: *RuntimeHost,
        id: []const u8,
        trusted_directory_path: []const u8,
        destination: PendingDestination,
    ) !void {
        const request = try encodeNativeProjectOnboardingRequest(self.allocator, id, trusted_directory_path);
        errdefer secureWipeAndFree(self.allocator, request);

        const pending = try self.allocator.create(Pending);
        errdefer self.allocator.destroy(pending);
        pending.* = .{
            .id = undefined,
            .id_len = id.len,
            .destination = destination,
            .request = request,
        };
        @memcpy(pending.id[0..pending.id_len], id);

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.state != .running) return error.RuntimeHostUnavailable;
        if (!self.resultCapacityAvailableLocked()) {
            return error.PendingQueueFull;
        }
        if (!self.requestIdAvailableLocked(id)) {
            return error.DuplicateNativeRequestId;
        }
        self.insertPendingLocked(pending) catch unreachable;
        const request_index = (self.request_head + self.request_len) % self.requests.len;
        self.requests[request_index] = pending;
        self.request_len += 1;
        self.request_ready.signal(self.io);
    }

    fn enqueueNativeFolderAccessSelect(
        self: *RuntimeHost,
        id: []const u8,
        trusted_directory_path: []const u8,
        destination: PendingDestination,
    ) !void {
        const request = try encodeNativeFolderAccessSelectRequest(
            self.allocator,
            id,
            trusted_directory_path,
        );
        errdefer secureWipeAndFree(self.allocator, request);

        const pending = try self.allocator.create(Pending);
        errdefer self.allocator.destroy(pending);
        pending.* = .{
            .id = undefined,
            .id_len = id.len,
            .destination = destination,
            .request = request,
        };
        @memcpy(pending.id[0..pending.id_len], id);

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.state != .running) return error.RuntimeHostUnavailable;
        if (!self.resultCapacityAvailableLocked()) {
            return error.PendingQueueFull;
        }
        if (!self.requestIdAvailableLocked(id)) {
            return error.DuplicateNativeRequestId;
        }
        self.insertPendingLocked(pending) catch unreachable;
        const request_index =
            (self.request_head + self.request_len) % self.requests.len;
        self.requests[request_index] = pending;
        self.request_len += 1;
        self.request_ready.signal(self.io);
    }

    fn enqueueStartupRemovalRecovery(self: *RuntimeHost) !void {
        var removal_deletion_capability =
            try generateRemovalDeletionCapability(self.io);
        defer secureWipe(&removal_deletion_capability);
        const request =
            try encodeStartupRemovalRecoveryRequest(
                self.allocator,
                &removal_deletion_capability,
            );
        errdefer secureWipeAndFree(self.allocator, request);
        const pending = try self.allocator.create(Pending);
        errdefer self.allocator.destroy(pending);
        pending.* = .{
            .id = undefined,
            .id_len = private_removal_recovery_id.len,
            .destination = .native_removal_recovery,
            .request = request,
        };
        @memcpy(
            pending.id[0..pending.id_len],
            private_removal_recovery_id,
        );
        @memcpy(
            &pending.removal_deletion_capability,
            &removal_deletion_capability,
        );
        pending.removal_deletion_capability_len =
            removal_deletion_capability.len;

        self.mutex.lockUncancelable(self.io);
        defer self.mutex.unlock(self.io);
        if (self.state != .running) {
            return error.RuntimeHostUnavailable;
        }
        if (!self.resultCapacityAvailableLocked()) {
            return error.PendingQueueFull;
        }
        if (!self.requestIdAvailableLocked(private_removal_recovery_id)) {
            return error.DuplicateNativeRequestId;
        }
        self.insertPendingLocked(pending) catch unreachable;
        const request_index =
            (self.request_head + self.request_len) % self.requests.len;
        self.requests[request_index] = pending;
        self.request_len += 1;
        self.request_ready.signal(self.io);
    }

    fn handleAccountProfileNativeRequest(
        self: *RuntimeHost,
        line: []const u8,
    ) bool {
        const request = parseAccountProfileNativeRequest(
            self.allocator,
            line,
        ) catch {
            self.transportFault(
                "Runtime gateway emitted an invalid account-profile request",
            );
            return false;
        };

        self.mutex.lockUncancelable(self.io);
        const available = self.state == .running and
            !self.account_profile_busy and
            self.account_profile_request == null and
            self.resultCapacityAvailableLocked() and
            self.requestIdAvailableLocked(request.idSlice());
        if (!available) {
            self.mutex.unlock(self.io);
            self.transportFault(
                "Runtime account-profile operation is unavailable",
            );
            return false;
        }
        self.account_profile_request = request;
        self.account_profile_busy = true;
        self.account_profile_result_reserved = true;
        self.account_profile_reserved_id_len = request.id_len;
        @memcpy(
            self.account_profile_reserved_id[0..request.id_len],
            request.idSlice(),
        );
        self.account_profile_ready.signal(self.io);
        self.mutex.unlock(self.io);
        return true;
    }

    fn handleHarnessCustodyNativeRequest(
        self: *RuntimeHost,
        line: []const u8,
    ) bool {
        var request = parseHarnessCustodyNativeRequest(
            line,
        ) catch {
            self.transportFault(
                "Runtime gateway emitted an invalid Harness custody request",
            );
            return false;
        };
        defer {
            secureWipe(&request.value);
            secureWipe(&request.removal_deletion_capability);
            secureWipe(&request.removal_operation_id);
            secureWipe(&request.removal_preview_id);
        }
        self.mutex.lockUncancelable(self.io);
        const available = self.state == .running and
            !self.harness_custody_busy and
            self.harness_custody_request == null and
            self.resultCapacityAvailableLocked() and
            self.requestIdAvailableLocked(request.idSlice());
        if (!available) {
            self.mutex.unlock(self.io);
            self.transportFault(
                "Runtime Harness custody operation is unavailable",
            );
            return false;
        }
        const real_before_raw =
            std.Io.Clock.real.now(self.io).toMilliseconds();
        const boot_now_raw =
            std.Io.Clock.boot.now(self.io).toMilliseconds();
        const real_after_raw =
            std.Io.Clock.real.now(self.io).toMilliseconds();
        request.deadline_boot_milliseconds =
            harnessCustodyBootDeadlineFromAdmissionSamples(
                real_before_raw,
                boot_now_raw,
                real_after_raw,
                request.deadline_unix_milliseconds,
            ) orelse 0;
        request.deadline_admitted =
            request.deadline_boot_milliseconds != 0;
        if (request.action == .delete_both and request.deadline_admitted) {
            request.deletion_authorized =
                self.consumeRemovalDeletionCapabilityLocked(&request);
        }
        self.harness_custody_request = request;
        self.harness_custody_busy = true;
        self.harness_custody_result_reserved = true;
        self.harness_custody_reserved_id_len = request.id_len;
        @memcpy(
            self.harness_custody_reserved_id[0..request.id_len],
            request.idSlice(),
        );
        self.harness_custody_ready.signal(self.io);
        self.mutex.unlock(self.io);
        return true;
    }

    fn consumeRemovalDeletionCapabilityLocked(
        self: *RuntimeHost,
        request: *const HarnessCustodyNativeRequest,
    ) bool {
        const capability = request.removalDeletionCapability() orelse
            return false;
        const operation_id = request.removalOperationId() orelse return false;
        const preview_id = request.removalPreviewId() orelse return false;
        for (&self.pending) |*slot| {
            const pending = slot.* orelse continue;
            if (pending.removal_deletion_capability_consumed) continue;
            const expected = pending.removalDeletionCapability() orelse
                continue;
            if (!std.mem.eql(u8, capability, expected)) continue;
            const correlation_matches = switch (pending.destination) {
                .renderer => |renderer| match: {
                    const removal = renderer.removal orelse break :match false;
                    break :match std.mem.eql(
                        u8,
                        operation_id,
                        removal.operationId(),
                    ) and std.mem.eql(
                        u8,
                        preview_id,
                        removal.previewId(),
                    );
                },
                .native_removal_recovery => true,
                .native_account_profile_result,
                .native_harness_custody_result,
                .development_reload,
                => false,
            };
            if (!correlation_matches) continue;
            pending.removal_deletion_capability_consumed = true;
            secureWipe(&pending.removal_deletion_capability);
            pending.removal_deletion_capability_len = 0;
            return true;
        }
        return false;
    }

    fn writerMain(self: *RuntimeHost, file: std.Io.File) void {
        defer self.writer_finished.store(true, .release);
        defer file.close(self.io);
        var writer = file.writerStreaming(self.io, self.writer_buffer.?);
        defer secureWipe(self.writer_buffer.?);

        while (true) {
            self.mutex.lockUncancelable(self.io);
            while (self.request_len == 0 and self.state == .running and
                !self.development_reload_accepted)
            {
                self.request_ready.waitUncancelable(self.io, &self.mutex);
            }
            if (self.request_len == 0) {
                self.mutex.unlock(self.io);
                return;
            }
            const pending = self.requests[self.request_head].?;
            self.requests[self.request_head] = null;
            self.request_head = (self.request_head + 1) % self.requests.len;
            self.request_len -= 1;
            pending.writer_active = true;
            self.mutex.unlock(self.io);

            const development_candidate = switch (pending.destination) {
                .development_reload => pending.developmentReloadCandidate(),
                else => null,
            };
            if (development_candidate) |candidate| {
                if (!self.developmentReloadStagedCandidateMatches(candidate)) {
                    self.mutex.lockUncancelable(self.io);
                    const removed = self.takePendingLocked(
                        pending.idSlice(),
                    );
                    const failed = removed == pending and
                        self.pushActionLocked(.{ .failure = .{
                            .pending = pending,
                            .code = .invalid_request,
                            .message = "Development runtime candidate changed",
                        } }) and
                        self.pushActionLocked(.{ .write_complete = pending });
                    self.mutex.unlock(self.io);
                    if (!failed) {
                        self.transportFault(
                            "Development runtime candidate validation failed",
                        );
                        return;
                    }
                    _ = self.wake();
                    continue;
                }
            }

            writer.interface.writeAll(pending.request) catch {
                self.transportFault("Runtime gateway stdin failed");
                self.queueWriteComplete(pending);
                return;
            };
            writer.interface.flush() catch {
                self.transportFault("Runtime gateway stdin failed");
                self.queueWriteComplete(pending);
                return;
            };
            // A successful flush resets logical length but does not overwrite
            // the backing allocation. Custody results can contain the master
            // envelope, so remove retained bytes before accepting more work.
            secureWipe(self.writer_buffer.?);
            self.queueWriteComplete(pending);
        }
    }

    fn accountProfileMain(self: *RuntimeHost) void {
        defer self.account_profile_finished.store(true, .release);
        while (true) {
            self.mutex.lockUncancelable(self.io);
            while (self.account_profile_request == null and
                self.state == .running)
            {
                self.account_profile_ready.waitUncancelable(
                    self.io,
                    &self.mutex,
                );
            }
            if (self.state != .running) {
                self.account_profile_request = null;
                self.account_profile_busy = false;
                self.clearAccountProfileReservationLocked();
                self.mutex.unlock(self.io);
                return;
            }
            const request = self.account_profile_request orelse {
                self.mutex.unlock(self.io);
                return;
            };
            self.account_profile_request = null;
            self.mutex.unlock(self.io);

            // Secure all fallible completion storage before the helper can
            // create or destroy account data. Queue capacity alone is not a
            // sufficient post-mutation guarantee: an allocator failure must
            // never make a completed filesystem operation unreportable.
            const pending = self.allocator.create(Pending) catch {
                self.mutex.lockUncancelable(self.io);
                self.account_profile_busy = false;
                self.clearAccountProfileReservationLocked();
                self.mutex.unlock(self.io);
                self.transportFault(
                    "Runtime account-profile result allocation failed",
                );
                return;
            };
            const encoded_success = encodeAccountProfileNativeResultRequest(
                self.allocator,
                &request,
                true,
            ) catch {
                self.allocator.destroy(pending);
                self.mutex.lockUncancelable(self.io);
                self.account_profile_busy = false;
                self.clearAccountProfileReservationLocked();
                self.mutex.unlock(self.io);
                self.transportFault(
                    "Runtime account-profile result allocation failed",
                );
                return;
            };
            const encoded_failure = encodeAccountProfileNativeResultRequest(
                self.allocator,
                &request,
                false,
            ) catch {
                self.allocator.free(encoded_success);
                self.allocator.destroy(pending);
                self.mutex.lockUncancelable(self.io);
                self.account_profile_busy = false;
                self.clearAccountProfileReservationLocked();
                self.mutex.unlock(self.io);
                self.transportFault(
                    "Runtime account-profile result allocation failed",
                );
                return;
            };

            const runner = self.options.account_profile_runner orelse
                production_account_profile_runner;
            const ok = if (self.data_remover_path) |path|
                runner.run_fn(
                    runner.context,
                    path,
                    request.action.text(),
                    request.controlPlanePath(),
                    request.accountProfileId(),
                    request.stateRootDevice(),
                    request.stateRootInode(),
                    request.controlPlaneDevice(),
                    request.controlPlaneInode(),
                    request.deletionNonce(),
                    request.expected_revision,
                )
            else
                false;
            const encoded = if (ok) encoded_success else encoded_failure;
            secureWipeAndFree(
                self.allocator,
                if (ok) encoded_failure else encoded_success,
            );
            pending.* = .{
                .id = undefined,
                .id_len = request.id_len,
                .destination = .native_account_profile_result,
                .request = encoded,
            };
            @memcpy(pending.id[0..pending.id_len], request.idSlice());

            self.mutex.lockUncancelable(self.io);
            if (self.state != .running) {
                self.account_profile_busy = false;
                self.clearAccountProfileReservationLocked();
                self.mutex.unlock(self.io);
                secureWipeAndFree(self.allocator, pending.request);
                self.allocator.destroy(pending);
                return;
            }
            if (!self.accountProfileReservationMatchesLocked(
                request.idSlice(),
            ) or
                self.pending_count >= max_pending_requests or
                self.request_len >= max_pending_requests or
                self.findPendingLocked(request.idSlice()) != null)
            {
                self.account_profile_busy = false;
                self.clearAccountProfileReservationLocked();
                self.mutex.unlock(self.io);
                secureWipeAndFree(self.allocator, pending.request);
                self.allocator.destroy(pending);
                self.transportFault(
                    "Runtime account-profile result queue is unavailable",
                );
                return;
            }
            self.insertPendingLocked(pending) catch unreachable;
            const request_index =
                (self.request_head + self.request_len) %
                self.requests.len;
            self.requests[request_index] = pending;
            self.request_len += 1;
            self.clearAccountProfileReservationLocked();
            self.request_ready.signal(self.io);
            self.mutex.unlock(self.io);
        }
    }

    fn harnessCustodyMain(self: *RuntimeHost) void {
        defer self.harness_custody_finished.store(true, .release);
        while (true) {
            self.mutex.lockUncancelable(self.io);
            while (self.harness_custody_request == null and
                self.state == .running)
            {
                self.harness_custody_ready.waitUncancelable(
                    self.io,
                    &self.mutex,
                );
            }
            if (self.state != .running) {
                if (self.harness_custody_request) |*request| {
                    secureWipe(&request.value);
                    secureWipe(&request.removal_deletion_capability);
                    secureWipe(&request.removal_operation_id);
                    secureWipe(&request.removal_preview_id);
                }
                self.harness_custody_request = null;
                self.harness_custody_busy = false;
                self.clearHarnessCustodyReservationLocked();
                self.mutex.unlock(self.io);
                return;
            }
            var request = self.harness_custody_request orelse {
                self.mutex.unlock(self.io);
                return;
            };
            if (self.harness_custody_request) |*stored| {
                secureWipe(&stored.value);
                secureWipe(&stored.removal_deletion_capability);
                secureWipe(&stored.removal_operation_id);
                secureWipe(&stored.removal_preview_id);
            }
            self.harness_custody_request = null;
            self.mutex.unlock(self.io);
            defer secureWipe(&request.value);
            defer secureWipe(&request.removal_deletion_capability);
            defer secureWipe(&request.removal_operation_id);
            defer secureWipe(&request.removal_preview_id);

            // Reserve a pathless failure response before any helper can read,
            // create, or delete Keychain data. If success encoding later runs
            // out of memory, the already-owned failure still makes the exact
            // operation reportable and every mutation remains idempotent.
            const pending = self.allocator.create(Pending) catch {
                self.mutex.lockUncancelable(self.io);
                self.harness_custody_busy = false;
                self.clearHarnessCustodyReservationLocked();
                self.mutex.unlock(self.io);
                self.transportFault(
                    "Runtime Harness custody result allocation failed",
                );
                return;
            };
            const encoded_failure = self.allocator.alloc(
                u8,
                harness_custody_failure_request_bytes,
            ) catch {
                self.allocator.destroy(pending);
                self.mutex.lockUncancelable(self.io);
                self.harness_custody_busy = false;
                self.clearHarnessCustodyReservationLocked();
                self.mutex.unlock(self.io);
                self.transportFault(
                    "Runtime Harness custody result allocation failed",
                );
                return;
            };
            if (!encodeFixedHarnessCustodyFailureRequest(
                @ptrCast(encoded_failure.ptr),
                &request,
                .reporting,
                null,
            )) {
                secureWipeAndFree(self.allocator, encoded_failure);
                self.allocator.destroy(pending);
                self.mutex.lockUncancelable(self.io);
                self.harness_custody_busy = false;
                self.clearHarnessCustodyReservationLocked();
                self.mutex.unlock(self.io);
                self.transportFault(
                    "Runtime Harness custody result encoding failed",
                );
                return;
            }

            const helper = self.options.harness_custody_runner orelse
                production_harness_custody_runner;
            var operation_result = if (request.deadline_admitted and
                (request.action != .delete_both or
                    request.deletion_authorized) and
                self.keychain_custodian_path != null)
                executeDirectHarnessCustodyOperation(
                    helper,
                    self.keychain_custodian_path.?,
                    &request,
                    .{
                        .io = self.io,
                        .boot_milliseconds = request.deadline_boot_milliseconds,
                    },
                )
            else
                HarnessCustodyOperationResult{ .failed = .admission };
            defer wipeHarnessCustodyOperationResult(&operation_result);
            const encoded_success = switch (operation_result) {
                .failed => |stage| failure: {
                    var actual_failure: [harness_custody_failure_request_bytes]u8 =
                        undefined;
                    defer secureWipe(&actual_failure);
                    if (encodeFixedHarnessCustodyFailureRequest(
                        &actual_failure,
                        &request,
                        stage,
                        null,
                    )) {
                        @memcpy(encoded_failure, &actual_failure);
                    }
                    break :failure null;
                },
                .legacy_failed => |failure| failure: {
                    var actual_failure: [harness_custody_failure_request_bytes]u8 =
                        undefined;
                    defer secureWipe(&actual_failure);
                    if (encodeFixedHarnessCustodyFailureRequest(
                        &actual_failure,
                        &request,
                        failure.stage,
                        failure.substage,
                    )) {
                        @memcpy(encoded_failure, &actual_failure);
                    }
                    break :failure null;
                },
                else => encodeHarnessCustodyNativeResultRequest(
                    self.allocator,
                    &request,
                    operation_result,
                ) catch null,
            };
            const encoded = encoded_success orelse encoded_failure;
            if (encoded_success != null) {
                secureWipeAndFree(self.allocator, encoded_failure);
            }
            pending.* = .{
                .id = undefined,
                .id_len = request.id_len,
                .destination = .native_harness_custody_result,
                .request = encoded,
            };
            @memcpy(pending.id[0..pending.id_len], request.idSlice());

            self.mutex.lockUncancelable(self.io);
            if (self.state != .running) {
                self.harness_custody_busy = false;
                self.clearHarnessCustodyReservationLocked();
                self.mutex.unlock(self.io);
                secureWipeAndFree(self.allocator, pending.request);
                self.allocator.destroy(pending);
                return;
            }
            if (!self.harnessCustodyReservationMatchesLocked(
                request.idSlice(),
            ) or
                self.pending_count >= max_pending_requests or
                self.request_len >= max_pending_requests or
                self.findPendingLocked(request.idSlice()) != null)
            {
                self.harness_custody_busy = false;
                self.clearHarnessCustodyReservationLocked();
                self.mutex.unlock(self.io);
                secureWipeAndFree(self.allocator, pending.request);
                self.allocator.destroy(pending);
                self.transportFault(
                    "Runtime Harness custody result queue is unavailable",
                );
                return;
            }
            self.insertPendingLocked(pending) catch unreachable;
            const request_index =
                (self.request_head + self.request_len) % self.requests.len;
            self.requests[request_index] = pending;
            self.request_len += 1;
            self.clearHarnessCustodyReservationLocked();
            self.request_ready.signal(self.io);
            self.mutex.unlock(self.io);
        }
    }

    fn readerMain(self: *RuntimeHost, file: std.Io.File) void {
        defer self.reader_finished.store(true, .release);
        defer file.close(self.io);
        while (!self.reader_delivery_ready.load(.acquire)) {
            self.mutex.lockUncancelable(self.io);
            const active = self.state == .running;
            self.mutex.unlock(self.io);
            if (!active) return;
            std.Io.sleep(
                self.io,
                .fromMilliseconds(1),
                .awake,
            ) catch return;
        }
        var reader = file.readerStreaming(self.io, self.reader_buffer.?);

        while (true) {
            const maybe_line = reader.interface.takeDelimiter('\n') catch {
                self.transportFault("Runtime gateway stdout failed");
                return;
            };
            const line = maybe_line orelse {
                if (self.scheduleDevelopmentReloadAfterEOF()) return;
                self.transportFault("Runtime gateway exited");
                return;
            };
            defer secureWipe(line);
            const kind = classifyLine(self.allocator, line) catch {
                self.transportFault("Runtime gateway emitted malformed JSONL");
                return;
            };

            switch (kind) {
                .response => |response| {
                    var bytes = self.allocator.dupe(u8, line) catch {
                        self.transportFault("Runtime response allocation failed");
                        return;
                    };
                    self.mutex.lockUncancelable(self.io);
                    const pending = self.takePendingLocked(response.id[0..response.id_len]) orelse {
                        self.mutex.unlock(self.io);
                        self.allocator.free(bytes);
                        self.transportFault("Runtime gateway returned an unknown request id");
                        return;
                    };
                    self.mutex.unlock(self.io);
                    if (pending.developmentReloadCandidate()) |candidate| {
                        const decision = parseDevelopmentReloadDecision(
                            self.allocator,
                            line,
                            pending.idSlice(),
                            candidate,
                        ) catch {
                            self.allocator.free(bytes);
                            _ = self.queueReaderFailure(
                                pending,
                                "Development reload returned an invalid decision",
                            );
                            self.transportFault(
                                "Runtime gateway emitted an invalid development reload decision",
                            );
                            return;
                        };
                        self.allocator.free(bytes);
                        self.mutex.lockUncancelable(self.io);
                        const current_generation = self.generation;
                        const generation_is_current =
                            self.state == .running and
                            self.development_reload_sealed and
                            current_generation < max_transport_generation;
                        self.mutex.unlock(self.io);
                        if (!generation_is_current) {
                            _ = self.queueReaderFailure(
                                pending,
                                "Development reload became unavailable",
                            );
                            self.transportFault(
                                "Development reload generation changed before admission",
                            );
                            return;
                        }
                        pending.development_reload_accepted =
                            decision == .accepted;
                        bytes = encodeDevelopmentReloadResult(
                            self.allocator,
                            pending.idSlice(),
                            if (decision == .accepted) "accepted" else "busy",
                            candidate,
                            current_generation,
                            if (decision == .accepted)
                                current_generation + 1
                            else
                                null,
                        ) catch {
                            _ = self.queueReaderFailure(
                                pending,
                                "Development reload response allocation failed",
                            );
                            self.transportFault(
                                "Development reload response allocation failed",
                            );
                            return;
                        };
                        self.mutex.lockUncancelable(self.io);
                        const queued = self.pushActionLocked(.{ .response = .{
                            .pending = pending,
                            .bytes = bytes,
                        } });
                        self.mutex.unlock(self.io);
                        if (!queued) {
                            self.allocator.free(bytes);
                            self.transportFault(
                                "Runtime completion queue is full",
                            );
                            return;
                        }
                        _ = self.wake();
                        continue;
                    }
                    const startup_recovery = switch (pending.destination) {
                        .native_removal_recovery => true,
                        else => false,
                    };
                    if (startup_recovery) {
                        if (!self.handleStartupRemovalRecoveryResponse(
                            pending,
                            line,
                            bytes,
                        )) return;
                        continue;
                    }
                    const account_profile_result =
                        switch (pending.destination) {
                            .native_account_profile_result => true,
                            else => false,
                        };
                    if (account_profile_result) {
                        if (!validateAccountProfileNativeResultAcknowledgement(
                            self.allocator,
                            line,
                            pending.idSlice(),
                        )) {
                            self.allocator.free(bytes);
                            self.mutex.lockUncancelable(self.io);
                            self.account_profile_busy = false;
                            self.mutex.unlock(self.io);
                            _ = self.queueReaderFailure(
                                pending,
                                "Account-profile operation returned an invalid acknowledgement",
                            );
                            self.transportFault(
                                "Runtime gateway emitted an invalid account-profile acknowledgement",
                            );
                            return;
                        }
                        self.mutex.lockUncancelable(self.io);
                        self.account_profile_busy = false;
                        self.mutex.unlock(self.io);
                    }
                    const harness_custody_result =
                        switch (pending.destination) {
                            .native_harness_custody_result => true,
                            else => false,
                        };
                    if (harness_custody_result) {
                        if (!validateHarnessCustodyNativeResultAcknowledgement(
                            self.allocator,
                            line,
                            pending.idSlice(),
                        )) {
                            self.allocator.free(bytes);
                            self.mutex.lockUncancelable(self.io);
                            self.harness_custody_busy = false;
                            self.mutex.unlock(self.io);
                            _ = self.queueReaderFailure(
                                pending,
                                "Harness custody returned an invalid acknowledgement",
                            );
                            self.transportFault(
                                "Runtime gateway emitted an invalid Harness custody acknowledgement",
                            );
                            return;
                        }
                        self.mutex.lockUncancelable(self.io);
                        self.harness_custody_busy = false;
                        self.mutex.unlock(self.io);
                    }
                    const correlation = switch (pending.destination) {
                        .renderer => |renderer| renderer.removal,
                        .native_removal_recovery,
                        .native_account_profile_result,
                        .native_harness_custody_result,
                        .development_reload,
                        => null,
                    };
                    if (correlation) |removal| {
                        const termination_required =
                            parseRemovalTerminationRequired(
                                self.allocator,
                                line,
                                pending.idSlice(),
                                &removal,
                            ) catch {
                                self.allocator.free(bytes);
                                _ = self.queueReaderFailure(
                                    pending,
                                    "Local-data removal returned an invalid termination response",
                                );
                                self.transportFault(
                                    "Runtime gateway emitted an invalid private termination-required response",
                                );
                                return;
                            };
                        if (termination_required) |required| {
                            if (!self.handleRemovalTerminationRequired(
                                pending,
                                bytes,
                                required,
                            )) return;
                            continue;
                        }
                        const parent_pid_raw = std.c.getpid();
                        if (parent_pid_raw <= 1) {
                            self.allocator.free(bytes);
                            if (!self.queueReaderFailure(
                                pending,
                                "Local-data removal could not be launched",
                            )) {
                                self.transportFault(
                                    "Runtime completion queue is full",
                                );
                                return;
                            }
                            continue;
                        }
                        const envelope = parseRemovalLaunchEnvelope(
                            self.allocator,
                            line,
                            pending.idSlice(),
                            &removal,
                            @intCast(parent_pid_raw),
                        ) catch {
                            self.allocator.free(bytes);
                            _ = self.queueReaderFailure(
                                pending,
                                "Local-data removal returned an invalid launch",
                            );
                            self.transportFault(
                                "Runtime gateway emitted an invalid private removal launch",
                            );
                            return;
                        };
                        if (envelope) |launch| {
                            const lifecycle =
                                self.options.removal_lifecycle orelse
                                production_removal_lifecycle;
                            const helper_path =
                                self.data_remover_path orelse {
                                    self.allocator.free(bytes);
                                    if (!self.queueReaderFailure(
                                        pending,
                                        "Local-data removal could not be launched",
                                    )) {
                                        self.transportFault(
                                            "Runtime completion queue is full",
                                        );
                                        return;
                                    }
                                    continue;
                                };
                            if (self.options.removal_lifecycle == null and
                                !productionRemovalLaunchPathsAreValid(&launch))
                            {
                                self.allocator.free(bytes);
                                if (!self.queueReaderFailure(
                                    pending,
                                    "Local-data removal could not be launched",
                                )) {
                                    self.transportFault(
                                        "Runtime completion queue is full",
                                    );
                                    return;
                                }
                                continue;
                            }
                            self.allocator.free(bytes);
                            const scheduled_bytes =
                                encodePublicRemovalResponse(
                                    self.allocator,
                                    pending.idSlice(),
                                    &removal,
                                ) catch {
                                    if (!self.queueReaderFailure(
                                        pending,
                                        "Local-data removal could not be launched",
                                    )) {
                                        self.transportFault(
                                            "Runtime completion queue is full",
                                        );
                                        return;
                                    }
                                    continue;
                                };
                            // Reserve the renderer response slot before the
                            // helper starts. Once spawn succeeds the helper is
                            // waiting for this process to exit, so termination
                            // becomes irrevocable even if UI delivery fails.
                            self.mutex.lockUncancelable(self.io);
                            if (self.action_len >=
                                self.actions.len - max_transport_lifecycle_actions)
                            {
                                self.mutex.unlock(self.io);
                                self.allocator.free(scheduled_bytes);
                                self.transportFault(
                                    "Runtime completion queue is full",
                                );
                                return;
                            }
                            spawnReadyRemovalHelper(
                                lifecycle,
                                self.allocator,
                                self.io,
                                helper_path,
                                launch.requestPath(),
                                launch.signingKeyPath(),
                                @intCast(parent_pid_raw),
                            ) catch {
                                const queued_failure =
                                    self.pushActionLocked(.{
                                        .failure = .{
                                            .pending = pending,
                                            .code = .handler_failed,
                                            .message = "Local-data removal could not be launched",
                                        },
                                    });
                                self.mutex.unlock(self.io);
                                self.allocator.free(scheduled_bytes);
                                if (!queued_failure) {
                                    self.transportFault(
                                        "Runtime completion queue is full",
                                    );
                                    return;
                                }
                                _ = self.wake();
                                continue;
                            };
                            self.terminal_removal_committed = true;
                            armTerminationAfterReady(lifecycle);
                            pending.terminate_after_response = true;
                            const queued_response =
                                self.pushActionLocked(.{ .response = .{
                                    .pending = pending,
                                    .bytes = scheduled_bytes,
                                } });
                            self.mutex.unlock(self.io);
                            if (!queued_response) {
                                self.allocator.free(scheduled_bytes);
                                lifecycle.terminate_fn(lifecycle.context);
                                return;
                            }
                            terminateIfRemovalDeliveryFailed(
                                lifecycle,
                                self.wake(),
                            );
                            continue;
                        } else if (!validatePublicRemovalFailure(
                            self.allocator,
                            line,
                            pending.idSlice(),
                            &removal,
                        )) {
                            self.allocator.free(bytes);
                            _ = self.queueReaderFailure(
                                pending,
                                "Local-data removal returned an invalid response",
                            );
                            self.transportFault(
                                "Runtime gateway bypassed the private removal launch",
                            );
                            return;
                        } else {
                            self.allocator.free(bytes);
                            rollbackRemovalHelper(
                                self.options.removal_lifecycle orelse
                                    production_removal_lifecycle,
                            );
                            bytes = encodePublicRemovalFailure(
                                self.allocator,
                                pending.idSlice(),
                                &removal,
                            ) catch {
                                if (!self.queueReaderFailure(
                                    pending,
                                    "Local-data removal could not be launched",
                                )) {
                                    self.transportFault(
                                        "Runtime completion queue is full",
                                    );
                                    return;
                                }
                                continue;
                            };
                        }
                    }
                    self.mutex.lockUncancelable(self.io);
                    const queued = self.pushActionLocked(.{ .response = .{ .pending = pending, .bytes = bytes } });
                    self.mutex.unlock(self.io);
                    if (!queued) {
                        self.allocator.free(bytes);
                        self.transportFault("Runtime completion queue is full");
                        return;
                    }
                    _ = self.wake();
                },
                .event => |event| {
                    const bytes = self.allocator.dupe(u8, line) catch {
                        self.transportFault("Runtime event allocation failed");
                        return;
                    };
                    self.queueRendererEvent(bytes, event.sequence, event.recovery) catch {
                        self.transportFault("Runtime event queue failed");
                        return;
                    };
                },
                .account_profile_request => {
                    if (!self.handleAccountProfileNativeRequest(line)) {
                        return;
                    }
                },
                .harness_custody_request => {
                    if (!self.handleHarnessCustodyNativeRequest(line)) {
                        return;
                    }
                },
            }
        }
    }

    fn handleRemovalTerminationRequired(
        self: *RuntimeHost,
        pending: *Pending,
        private_bytes: []u8,
        required: RemovalTerminationRequired,
    ) bool {
        self.allocator.free(private_bytes);
        const public_bytes = encodePublicTerminationRequiredResponse(
            self.allocator,
            pending.idSlice(),
            &required,
        ) catch {
            const lifecycle =
                self.options.removal_lifecycle orelse
                production_removal_lifecycle;
            self.commitTerminalRemoval();
            armTerminationAfterReady(lifecycle);
            lifecycle.terminate_fn(lifecycle.context);
            return false;
        };
        const lifecycle =
            self.options.removal_lifecycle orelse
            production_removal_lifecycle;
        // Gateway writers are already quiesced. From this point forward,
        // termination is mandatory even when renderer delivery or the main
        // queue stalls; the lifecycle watchdog owns the forced fallback.
        self.commitTerminalRemoval();
        armTerminationAfterReady(lifecycle);
        pending.terminate_after_response = true;
        self.mutex.lockUncancelable(self.io);
        const queued = self.pushActionLocked(.{ .response = .{
            .pending = pending,
            .bytes = public_bytes,
        } });
        self.mutex.unlock(self.io);
        if (!queued) {
            self.allocator.free(public_bytes);
            lifecycle.terminate_fn(lifecycle.context);
            return false;
        }
        terminateIfRemovalDeliveryFailed(lifecycle, self.wake());
        return true;
    }

    fn handleStartupRemovalRecoveryResponse(
        self: *RuntimeHost,
        pending: *Pending,
        line: []const u8,
        bytes: []u8,
    ) bool {
        const lifecycle =
            self.options.removal_lifecycle orelse
            production_removal_lifecycle;
        const termination_required = parseRemovalTerminationRequired(
            self.allocator,
            line,
            pending.idSlice(),
            null,
        ) catch {
            self.allocator.free(bytes);
            _ = self.queueReaderFailure(
                pending,
                "Local-data removal recovery returned an invalid termination response",
            );
            self.transportFault(
                "Runtime gateway emitted an invalid private recovery termination-required response",
            );
            return false;
        };
        if (termination_required) |required| {
            return self.handleRemovalTerminationRequired(
                pending,
                bytes,
                required,
            );
        }
        const recovery_state = parseRemovalRecoveryResult(
            self.allocator,
            line,
            pending.idSlice(),
        ) catch {
            self.allocator.free(bytes);
            _ = self.queueReaderFailure(
                pending,
                "Local-data removal recovery returned an invalid response",
            );
            self.transportFault(
                "Runtime gateway emitted an invalid private removal recovery response",
            );
            return false;
        };

        if (recovery_state == null) {
            const parent_pid_raw = std.c.getpid();
            if (parent_pid_raw <= 1) {
                self.allocator.free(bytes);
                _ = self.queueReaderFailure(
                    pending,
                    "Local-data removal recovery could not be launched",
                );
                self.transportFault(
                    "Runtime removal recovery parent identity is invalid",
                );
                return false;
            }
            const launch = parseRemovalLaunchEnvelope(
                self.allocator,
                line,
                pending.idSlice(),
                null,
                @intCast(parent_pid_raw),
            ) catch {
                self.allocator.free(bytes);
                _ = self.queueReaderFailure(
                    pending,
                    "Local-data removal recovery returned an invalid launch",
                );
                self.transportFault(
                    "Runtime gateway emitted an invalid private recovery launch",
                );
                return false;
            } orelse {
                self.allocator.free(bytes);
                _ = self.queueReaderFailure(
                    pending,
                    "Local-data removal recovery returned an invalid launch",
                );
                self.transportFault(
                    "Runtime gateway omitted the private recovery launch",
                );
                return false;
            };
            const helper_path = self.data_remover_path orelse {
                self.allocator.free(bytes);
                _ = self.queueReaderFailure(
                    pending,
                    "Local-data removal recovery helper is unavailable",
                );
                return false;
            };
            if (self.options.removal_lifecycle == null and
                !productionRemovalLaunchPathsAreValid(&launch))
            {
                self.allocator.free(bytes);
                _ = self.queueReaderFailure(
                    pending,
                    "Local-data removal recovery launch is invalid",
                );
                return false;
            }
            self.mutex.lockUncancelable(self.io);
            if (self.action_len >=
                self.actions.len - max_transport_lifecycle_actions)
            {
                self.mutex.unlock(self.io);
                self.allocator.free(bytes);
                self.transportFault(
                    "Runtime completion queue is full",
                );
                return false;
            }
            spawnReadyRemovalHelper(
                lifecycle,
                self.allocator,
                self.io,
                helper_path,
                launch.requestPath(),
                launch.signingKeyPath(),
                @intCast(parent_pid_raw),
            ) catch {
                self.mutex.unlock(self.io);
                self.allocator.free(bytes);
                _ = self.queueReaderFailure(
                    pending,
                    "Local-data removal recovery could not be launched",
                );
                return false;
            };
        } else {
            self.mutex.lockUncancelable(self.io);
            if (self.action_len >=
                self.actions.len - max_transport_lifecycle_actions)
            {
                self.mutex.unlock(self.io);
                self.allocator.free(bytes);
                self.transportFault(
                    "Runtime completion queue is full",
                );
                return false;
            }
        }

        self.terminal_removal_committed = true;
        armTerminationAfterReady(lifecycle);
        pending.terminate_after_response = true;
        const queued = self.pushActionLocked(.{ .response = .{
            .pending = pending,
            .bytes = bytes,
        } });
        self.mutex.unlock(self.io);
        if (!queued) {
            self.allocator.free(bytes);
            lifecycle.terminate_fn(lifecycle.context);
            return false;
        }
        terminateIfRemovalDeliveryFailed(lifecycle, self.wake());
        return true;
    }

    /// Takes ownership of `bytes`. A full renderer-event queue is a UI
    /// backpressure condition, not a gateway transport fault. Snapshot-backed
    /// events may replace the newest snapshot-backed event with a transport-
    /// sized resnapshot marker. Non-durable operation completions are never
    /// replaced or dropped; the reader waits for renderer space when required.
    /// Responses and completion actions retain their positions in the queue.
    fn queueRendererEvent(
        self: *RuntimeHost,
        bytes: []u8,
        sequence: u64,
        recovery: EventRecovery,
    ) !void {
        var owned_bytes: ?[]u8 = bytes;
        defer if (owned_bytes) |remaining| self.allocator.free(remaining);
        var invalidation_bytes: ?[]u8 = null;
        defer if (invalidation_bytes) |remaining| self.allocator.free(remaining);

        while (true) {
            self.mutex.lockUncancelable(self.io);
            if (self.queued_events < max_queued_events) {
                const queued = self.pushActionLocked(.{ .event = .{
                    .bytes = bytes,
                    .sequence = sequence,
                    .recovery = recovery,
                } });
                if (!queued) {
                    self.mutex.unlock(self.io);
                    return error.ActionQueueFull;
                }
                self.queued_events += 1;
                owned_bytes = null;
                self.mutex.unlock(self.io);
                _ = self.wake();
                return;
            }

            if (recovery == .snapshot_recoverable and invalidation_bytes != null) {
                const replaced_bytes = self.replaceNewestEventIfRecoverableLocked(.{
                    .bytes = invalidation_bytes.?,
                    .sequence = sequence,
                    .recovery = .snapshot_recoverable,
                });
                if (replaced_bytes) |replaced| {
                    invalidation_bytes = null;
                    self.mutex.unlock(self.io);
                    self.allocator.free(replaced);
                    _ = self.wake();
                    return;
                }
            }

            if (self.state != .running) {
                self.mutex.unlock(self.io);
                return error.RuntimeHostUnavailable;
            }

            // Allocate outside the mutex. The renderer may drain an event in
            // the meantime; the next iteration then queues the original event
            // and releases this unnecessary marker.
            if (recovery == .snapshot_recoverable and invalidation_bytes == null) {
                self.mutex.unlock(self.io);
                invalidation_bytes = try encodeProjectionOverflowEvent(self.allocator, sequence);
                continue;
            }

            _ = self.event_space_waiters.fetchAdd(1, .acq_rel);
            self.event_space_ready.waitUncancelable(self.io, &self.mutex);
            _ = self.event_space_waiters.fetchSub(1, .acq_rel);
            self.mutex.unlock(self.io);
        }
    }

    fn queueWriteComplete(self: *RuntimeHost, pending: *Pending) void {
        self.mutex.lockUncancelable(self.io);
        const queued = self.pushActionLocked(.{ .write_complete = pending });
        self.mutex.unlock(self.io);
        if (queued) _ = self.wake();
    }

    fn queueReaderFailure(
        self: *RuntimeHost,
        pending: *Pending,
        message: []const u8,
    ) bool {
        self.mutex.lockUncancelable(self.io);
        const queued = self.pushActionLocked(.{ .failure = .{
            .pending = pending,
            .code = .handler_failed,
            .message = message,
        } });
        self.mutex.unlock(self.io);
        if (queued) _ = self.wake();
        return queued;
    }

    fn scheduleDevelopmentReloadAfterEOF(self: *RuntimeHost) bool {
        var scheduled = false;
        self.mutex.lockUncancelable(self.io);
        if (self.state == .running and
            self.development_reload_sealed and
            self.development_reload_accepted and
            self.development_reload_candidate_len ==
                development_reload_candidate_bytes and
            self.development_reload_target_generation == self.generation + 1 and
            self.pending_count == 0 and
            self.request_len == 0 and
            self.action_len == 0 and
            !self.renderer_delivery_in_flight and
            !self.account_profile_busy and
            self.account_profile_request == null and
            !self.account_profile_result_reserved and
            !self.harness_custody_busy and
            self.harness_custody_request == null and
            !self.harness_custody_result_reserved)
        {
            self.state = .recovering;
            self.recovery_attempt = 1;
            self.recovery_requested = true;
            self.recovery_shutdown = .graceful;
            self.recovery_skips_backoff = true;
            self.request_ready.broadcast(self.io);
            self.account_profile_ready.broadcast(self.io);
            self.harness_custody_ready.broadcast(self.io);
            self.event_space_ready.broadcast(self.io);
            self.recovery_ready.signal(self.io);
            scheduled = true;
        }
        self.mutex.unlock(self.io);
        return scheduled;
    }

    fn transportFault(self: *RuntimeHost, message: []const u8) void {
        var scheduled = false;
        var terminal = false;
        var exhausted = false;
        var rollback_removal = false;
        var attempt: u8 = 1;
        self.mutex.lockUncancelable(self.io);
        if (self.state != .running) {
            self.mutex.unlock(self.io);
            return;
        }
        terminal = self.terminal_removal_committed;
        rollback_removal = !terminal and self.hasPendingRemovalLocked();
        exhausted = !terminal and
            self.recovery_attempt >= self.options.max_recovery_attempts;
        self.state = if (terminal or exhausted) .failed else .recovering;
        self.failAllPendingLocked(message);
        if (!terminal and !exhausted) {
            self.recovery_attempt = if (self.recovery_attempt == 0)
                1
            else
                @min(
                    self.recovery_attempt +| 1,
                    self.options.max_recovery_attempts,
                );
            attempt = self.recovery_attempt;
            self.recovery_requested = true;
            scheduled = true;
        }
        self.request_ready.broadcast(self.io);
        self.account_profile_ready.broadcast(self.io);
        self.harness_custody_ready.broadcast(self.io);
        self.event_space_ready.broadcast(self.io);
        self.mutex.unlock(self.io);
        const account_runner = self.options.account_profile_runner orelse
            production_account_profile_runner;
        account_runner.cancel_fn(account_runner.context);
        const harness_runner = self.options.harness_custody_runner orelse
            production_harness_custody_runner;
        harness_runner.cancel_fn(harness_runner.context);
        if (self.options.legacy_harness_custody_runner) |legacy_runner| {
            legacy_runner.cancel_fn(legacy_runner.context);
        }
        if (rollback_removal) {
            rollbackRemovalHelper(
                self.options.removal_lifecycle orelse
                    production_removal_lifecycle,
            );
        }
        if (scheduled) {
            self.mutex.lockUncancelable(self.io);
            if (self.state == .recovering and self.recovery_requested) {
                self.recovery_ready.signal(self.io);
            }
            self.mutex.unlock(self.io);
        }
        if (terminal or exhausted) {
            _ = self.queueTransportLifecycle(.{ .failed = .{
                .can_retry = !terminal,
                .message = if (terminal)
                    "The local runtime stopped while the app is closing."
                else
                    "The local runtime stopped after bounded recovery attempts.",
            } });
        } else if (scheduled) {
            _ = self.queueTransportLifecycle(.{ .backing_off = .{
                .attempt = attempt,
                .retry_at_unix_milliseconds = self.retryAtUnixMilliseconds(
                    attempt,
                ),
            } });
        }
        _ = self.wake();
    }

    fn beginStopping(self: *RuntimeHost, message: []const u8) void {
        self.mutex.lockUncancelable(self.io);
        switch (self.state) {
            .running, .recovering, .failed => {
                self.state = .stopping;
                self.recovery_requested = false;
                self.failAllPendingLocked(message);
                self.request_ready.broadcast(self.io);
                self.account_profile_ready.broadcast(self.io);
                self.harness_custody_ready.broadcast(self.io);
                self.event_space_ready.broadcast(self.io);
                self.recovery_ready.broadcast(self.io);
            },
            .idle => {
                self.state = .stopping;
                self.account_profile_ready.broadcast(self.io);
                self.harness_custody_ready.broadcast(self.io);
            },
            .stopping, .stopped => {},
        }
        self.mutex.unlock(self.io);
        _ = self.wake();
    }

    fn failAllPendingLocked(self: *RuntimeHost, message: []const u8) void {
        for (&self.pending) |*slot| {
            const pending = slot.* orelse continue;
            slot.* = null;
            self.pending_count -= 1;
            if (!pending.writer_active) pending.writer_done = true;
            _ = self.pushActionLocked(.{ .failure = .{
                .pending = pending,
                .code = .handler_failed,
                .message = message,
            } });
        }
        for (&self.requests) |*slot| slot.* = null;
        self.request_head = 0;
        self.request_len = 0;
    }

    fn hasPendingRemovalLocked(self: *const RuntimeHost) bool {
        for (self.pending) |slot| {
            const pending = slot orelse continue;
            switch (pending.destination) {
                .renderer => |renderer| {
                    if (renderer.removal != null) return true;
                },
                .native_removal_recovery,
                .native_account_profile_result,
                .native_harness_custody_result,
                .development_reload,
                => {},
            }
        }
        return false;
    }

    fn commitDevelopmentReloadDecision(
        self: *RuntimeHost,
        pending: *const Pending,
    ) bool {
        const candidate = pending.developmentReloadCandidate() orelse
            return true;
        self.mutex.lockUncancelable(self.io);
        const valid = self.state == .running and
            self.development_reload_sealed and
            self.development_reload_candidate_len == candidate.len and
            std.mem.eql(
                u8,
                self.development_reload_candidate[0..self.development_reload_candidate_len],
                candidate,
            );
        if (valid and pending.development_reload_accepted) {
            self.development_reload_accepted = true;
            self.development_reload_target_generation = self.generation + 1;
            @memcpy(
                self.development_reload_desired_candidate[0..candidate.len],
                candidate,
            );
            self.development_reload_desired_candidate_len = candidate.len;
            self.request_ready.broadcast(self.io);
        } else {
            self.development_reload_sealed = false;
            self.development_reload_accepted = false;
            self.development_reload_target_generation = 0;
            secureWipe(&self.development_reload_candidate);
            self.development_reload_candidate_len = 0;
            self.request_ready.broadcast(self.io);
        }
        self.mutex.unlock(self.io);
        return valid;
    }

    fn drain(self: *RuntimeHost, runtime: *native_sdk.Runtime) void {
        while (true) {
            self.mutex.lockUncancelable(self.io);
            if (self.renderer_delivery_in_flight) {
                self.mutex.unlock(self.io);
                return;
            }
            if (self.beginRendererDeliveryLocked()) |renderer_action| {
                self.mutex.unlock(self.io);
                const delivered = switch (renderer_action) {
                    .event => |renderer_value| result: {
                        runtime.emitWindowEvent(
                            main_window_id,
                            renderer_event,
                            renderer_value.bytes,
                        ) catch break :result false;
                        break :result true;
                    },
                    .transport_lifecycle => |bytes| result: {
                        runtime.emitWindowEvent(
                            main_window_id,
                            transport_lifecycle_event,
                            bytes,
                        ) catch break :result false;
                        break :result true;
                    },
                    else => unreachable,
                };
                self.mutex.lockUncancelable(self.io);
                const completed = self.finishRendererDeliveryLocked(delivered);
                const retry_attempt = self.renderer_delivery_retry_attempt;
                const may_retry = self.state != .stopping and self.state != .stopped;
                self.mutex.unlock(self.io);
                if (completed) |action| {
                    switch (action) {
                        .event => |renderer_value| self.allocator.free(renderer_value.bytes),
                        .transport_lifecycle => |bytes| self.allocator.free(bytes),
                        else => unreachable,
                    }
                    continue;
                }
                if (may_retry) {
                    const delay_ms = rendererDeliveryRetryMilliseconds(retry_attempt);
                    runtime.startTimer(
                        renderer_delivery_retry_timer_id,
                        delay_ms * std.time.ns_per_ms,
                        false,
                    ) catch {};
                }
                return;
            }
            const action = self.popActionLocked();
            self.mutex.unlock(self.io);
            const next = action orelse return;

            switch (next) {
                .response => |response| {
                    const development_reload_valid = switch (response.pending.destination) {
                        .development_reload => self.commitDevelopmentReloadDecision(
                            response.pending,
                        ),
                        else => true,
                    };
                    switch (response.pending.destination) {
                        .renderer => |renderer| {
                            renderer.responder.respond(
                                response.bytes,
                            ) catch {};
                        },
                        .native_removal_recovery => {},
                        .native_account_profile_result => {},
                        .native_harness_custody_result => {},
                        .development_reload => |responder| {
                            if (development_reload_valid) {
                                // Commit the generation transaction before the
                                // renderer can observe accepted. A later bridge
                                // delivery failure is ambiguous to the renderer,
                                // but Native remains bound to this candidate.
                                responder.respond(response.bytes) catch {};
                            } else {
                                respondError(
                                    responder,
                                    response.pending.idSlice(),
                                    .handler_failed,
                                    "Development reload became unavailable",
                                );
                            }
                        },
                    }
                    self.allocator.free(response.bytes);
                    response.pending.ui_done = true;
                    if (response.pending.terminate_after_response) {
                        const lifecycle =
                            self.options.removal_lifecycle orelse
                            production_removal_lifecycle;
                        lifecycle.terminate_fn(lifecycle.context);
                    }
                    self.releasePendingIfDone(response.pending);
                    if (!development_reload_valid) {
                        self.transportFault(
                            "Development reload decision became stale before delivery",
                        );
                    }
                },
                .failure => |failure| {
                    switch (failure.pending.destination) {
                        .renderer => |renderer| respondError(
                            renderer.responder,
                            failure.pending.idSlice(),
                            failure.code,
                            failure.message,
                        ),
                        .native_removal_recovery => {},
                        .native_account_profile_result => {},
                        .native_harness_custody_result => {},
                        .development_reload => |responder| respondError(
                            responder,
                            failure.pending.idSlice(),
                            failure.code,
                            failure.message,
                        ),
                    }
                    failure.pending.ui_done = true;
                    if (failure.pending.developmentReloadCandidate() != null) {
                        _ = self.commitDevelopmentReloadDecision(failure.pending);
                    }
                    self.releasePendingIfDone(failure.pending);
                },
                .event, .transport_lifecycle => unreachable,
                .write_complete => |pending| {
                    pending.writer_done = true;
                    self.releasePendingIfDone(pending);
                },
            }
        }
    }

    fn releasePendingIfDone(self: *RuntimeHost, pending: *Pending) void {
        if (!pending.writer_done or !pending.ui_done) return;
        secureWipeAndFree(self.allocator, pending.request);
        secureWipe(&pending.removal_deletion_capability);
        pending.removal_deletion_capability_len = 0;
        self.allocator.destroy(pending);
    }

    fn wake(self: *RuntimeHost) bool {
        const services = self.services orelse return false;
        services.wake() catch return false;
        return true;
    }

    fn resultCapacityAvailableLocked(self: *const RuntimeHost) bool {
        const account_profile_reserved: usize = if (self.account_profile_result_reserved) 1 else 0;
        const harness_custody_reserved: usize = if (self.harness_custody_result_reserved) 1 else 0;
        const reserved = account_profile_reserved + harness_custody_reserved;
        return self.pending_count + reserved < max_pending_requests and
            self.request_len + reserved < max_pending_requests;
    }

    fn rendererRequestCapacityAvailableLocked(
        self: *const RuntimeHost,
        command: []const u8,
    ) bool {
        if (std.mem.eql(u8, command, dispatch_command) and
            self.pending_count >= max_renderer_mutation_requests)
        {
            return false;
        }
        return self.resultCapacityAvailableLocked();
    }

    fn accountProfileReservationMatchesLocked(
        self: *const RuntimeHost,
        id: []const u8,
    ) bool {
        return self.account_profile_result_reserved and
            self.account_profile_reserved_id_len == id.len and
            std.mem.eql(
                u8,
                self.account_profile_reserved_id[0..self.account_profile_reserved_id_len],
                id,
            );
    }

    fn clearAccountProfileReservationLocked(self: *RuntimeHost) void {
        @memset(
            self.account_profile_reserved_id[0..self.account_profile_reserved_id_len],
            0,
        );
        self.account_profile_reserved_id_len = 0;
        self.account_profile_result_reserved = false;
    }

    fn harnessCustodyReservationMatchesLocked(
        self: *const RuntimeHost,
        id: []const u8,
    ) bool {
        return self.harness_custody_result_reserved and
            self.harness_custody_reserved_id_len == id.len and
            std.mem.eql(
                u8,
                self.harness_custody_reserved_id[0..self.harness_custody_reserved_id_len],
                id,
            );
    }

    fn clearHarnessCustodyReservationLocked(self: *RuntimeHost) void {
        @memset(
            self.harness_custody_reserved_id[0..self.harness_custody_reserved_id_len],
            0,
        );
        self.harness_custody_reserved_id_len = 0;
        self.harness_custody_result_reserved = false;
    }

    fn requestIdAvailableLocked(
        self: *RuntimeHost,
        id: []const u8,
    ) bool {
        return self.findPendingLocked(id) == null and
            !self.accountProfileReservationMatchesLocked(id) and
            !self.harnessCustodyReservationMatchesLocked(id);
    }

    fn insertPendingLocked(self: *RuntimeHost, pending: *Pending) !void {
        for (&self.pending) |*slot| {
            if (slot.* == null) {
                slot.* = pending;
                self.pending_count += 1;
                return;
            }
        }
        return error.PendingQueueFull;
    }

    fn findPendingLocked(self: *RuntimeHost, id: []const u8) ?*Pending {
        for (self.pending) |slot| {
            const pending = slot orelse continue;
            if (std.mem.eql(u8, pending.idSlice(), id)) return pending;
        }
        return null;
    }

    fn takePendingLocked(self: *RuntimeHost, id: []const u8) ?*Pending {
        for (&self.pending) |*slot| {
            const pending = slot.* orelse continue;
            if (!std.mem.eql(u8, pending.idSlice(), id)) continue;
            slot.* = null;
            self.pending_count -= 1;
            return pending;
        }
        return null;
    }

    fn pushActionLocked(self: *RuntimeHost, action: Action) bool {
        switch (action) {
            .transport_lifecycle => {
                if (self.queued_transport_lifecycles >=
                    max_transport_lifecycle_actions)
                {
                    return false;
                }
            },
            else => {
                if (self.action_len >=
                    self.actions.len - max_transport_lifecycle_actions)
                {
                    return false;
                }
            },
        }
        const index = (self.action_head + self.action_len) % self.actions.len;
        self.actions[index] = action;
        self.action_len += 1;
        if (action == .transport_lifecycle) {
            self.queued_transport_lifecycles += 1;
        }
        return true;
    }

    /// Replacing only the newest queued event preserves monotonic event order:
    /// every retained event remains before the newer invalidation sequence.
    /// Non-event actions may follow it without affecting renderer sequencing.
    fn replaceNewestEventIfRecoverableLocked(self: *RuntimeHost, replacement: RendererEvent) ?[]u8 {
        std.debug.assert(replacement.recovery == .snapshot_recoverable);
        for (0..self.action_len) |offset| {
            const reverse_offset = self.action_len - 1 - offset;
            const index = (self.action_head + reverse_offset) % self.actions.len;
            if (self.renderer_delivery_in_flight and index == self.action_head) {
                return null;
            }
            const action = self.actions[index] orelse unreachable;
            switch (action) {
                .event => |queued| {
                    if (queued.recovery != .snapshot_recoverable) return null;
                    self.actions[index] = .{ .event = replacement };
                    return queued.bytes;
                },
                else => {},
            }
        }
        return null;
    }

    fn beginRendererDeliveryLocked(self: *RuntimeHost) ?Action {
        if (self.renderer_delivery_in_flight or self.action_len == 0) return null;
        const action = self.actions[self.action_head].?;
        switch (action) {
            .event, .transport_lifecycle => {
                self.renderer_delivery_in_flight = true;
                return action;
            },
            else => return null,
        }
    }

    fn finishRendererDeliveryLocked(
        self: *RuntimeHost,
        delivered: bool,
    ) ?Action {
        std.debug.assert(self.renderer_delivery_in_flight);
        self.renderer_delivery_in_flight = false;
        if (!delivered) {
            self.renderer_delivery_retry_attempt = @min(
                self.renderer_delivery_retry_attempt +| 1,
                std.math.maxInt(u8),
            );
            return null;
        }
        self.renderer_delivery_retry_attempt = 0;
        return self.popActionLocked();
    }

    fn popActionLocked(self: *RuntimeHost) ?Action {
        if (self.action_len == 0) return null;
        const action = self.actions[self.action_head].?;
        self.actions[self.action_head] = null;
        self.action_head = (self.action_head + 1) % self.actions.len;
        self.action_len -= 1;
        if (action == .event) {
            self.queued_events -= 1;
            self.event_space_ready.signal(self.io);
        }
        if (action == .transport_lifecycle) {
            self.queued_transport_lifecycles -= 1;
        }
        return action;
    }
};

fn rendererDeliveryRetryMilliseconds(attempt: u8) u64 {
    if (attempt <= 1) return renderer_delivery_retry_base_ms;
    var delay = renderer_delivery_retry_base_ms;
    for (1..attempt) |_| {
        delay = @min(delay * 2, renderer_delivery_retry_max_ms);
    }
    return delay;
}

fn respondError(
    responder: native_sdk.bridge.AsyncResponder,
    id: []const u8,
    code: native_sdk.bridge.ErrorCode,
    message: []const u8,
) void {
    var response: [1024]u8 = undefined;
    const encoded = native_sdk.bridge.writeErrorResponse(&response, id, code, message);
    responder.respond(encoded) catch {};
}

fn testingRemovalCorrelation(
    operation_id: []const u8,
    preview_id: []const u8,
) RemovalCorrelation {
    var correlation: RemovalCorrelation = .{
        .operation_id = undefined,
        .operation_id_len = operation_id.len,
        .preview_id = undefined,
        .preview_id_len = preview_id.len,
    };
    @memcpy(
        correlation.operation_id[0..operation_id.len],
        operation_id,
    );
    @memcpy(
        correlation.preview_id[0..preview_id.len],
        preview_id,
    );
    return correlation;
}

const RemovalLifecycleProbe = struct {
    prepare_allowed: bool = true,
    spawn_fails: bool = false,
    recovery_fails: bool = false,
    watchdog_arms: bool = true,
    prepare_count: usize = 0,
    spawn_count: usize = 0,
    recovery_count: usize = 0,
    watchdog_count: usize = 0,
    terminate_count: usize = 0,
    rollback_count: usize = 0,
    exclusion_held: bool = false,
    spawn_without_exclusion: bool = false,
    recovery_without_exclusion: bool = false,
    last_mode: ?RemovalPreparation = null,

    fn lifecycle(self: *@This()) RemovalLifecycle {
        return .{
            .context = self,
            .prepare_fn = prepare,
            .rollback_fn = rollback,
            .spawn_fn = spawn,
            .recover_staged_fn = recoverStaged,
            .arm_termination_watchdog_fn = arm,
            .terminate_fn = terminate,
        };
    }

    fn prepare(
        context: ?*anyopaque,
        helper_path: []const u8,
        mode: RemovalPreparation,
    ) bool {
        _ = helper_path;
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.prepare_count += 1;
        self.last_mode = mode;
        if (self.prepare_allowed) self.exclusion_held = true;
        return self.prepare_allowed;
    }

    fn rollback(context: ?*anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.rollback_count += 1;
        self.exclusion_held = false;
    }

    fn spawn(
        context: ?*anyopaque,
        allocator: std.mem.Allocator,
        io: std.Io,
        helper_path: []const u8,
        request_path: []const u8,
        signing_key_path: []const u8,
        parent_process_id: u32,
    ) !void {
        _ = allocator;
        _ = io;
        _ = helper_path;
        _ = request_path;
        _ = signing_key_path;
        _ = parent_process_id;
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.spawn_count += 1;
        if (!self.exclusion_held) self.spawn_without_exclusion = true;
        if (self.spawn_fails) return error.HandshakeFailed;
    }

    fn recoverStaged(
        context: ?*anyopaque,
        allocator: std.mem.Allocator,
        io: std.Io,
        helper_path: []const u8,
        helper_state_root: []const u8,
    ) !void {
        _ = allocator;
        _ = io;
        _ = helper_path;
        _ = helper_state_root;
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.recovery_count += 1;
        if (!self.exclusion_held) self.recovery_without_exclusion = true;
        if (self.recovery_fails) return error.RecoveryFailed;
    }

    fn arm(context: ?*anyopaque) bool {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.watchdog_count += 1;
        return self.watchdog_arms;
    }

    fn terminate(context: ?*anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.terminate_count += 1;
    }
};

const RemovalChildReaperProbe = struct {
    reap_count: usize = 0,
    last_process_id: c_int = -1,

    fn reap(
        context: ?*anyopaque,
        process_id: c_int,
    ) void {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        self.reap_count += 1;
        self.last_process_id = process_id;
    }
};

const AccountProfileRunnerProbe = struct {
    started: std.atomic.Value(bool) = .init(false),
    cancelled: std.atomic.Value(bool) = .init(false),
    cancel_count: std.atomic.Value(usize) = .init(0),
    run_count: std.atomic.Value(usize) = .init(0),

    fn runner(self: *@This()) AccountProfileOperationRunner {
        return .{
            .context = self,
            .run_fn = run,
            .cancel_fn = cancel,
        };
    }

    fn run(
        context: ?*anyopaque,
        helper_path: []const u8,
        action: []const u8,
        control_plane_path: []const u8,
        account_profile_id: []const u8,
        state_root_device: []const u8,
        state_root_inode: []const u8,
        control_plane_device: []const u8,
        control_plane_inode: []const u8,
        deletion_nonce: ?[]const u8,
        expected_revision: u64,
    ) bool {
        _ = helper_path;
        _ = action;
        _ = control_plane_path;
        _ = account_profile_id;
        _ = state_root_device;
        _ = state_root_inode;
        _ = control_plane_device;
        _ = control_plane_inode;
        _ = deletion_nonce;
        _ = expected_revision;
        const self: *@This() = @ptrCast(@alignCast(context.?));
        _ = self.run_count.fetchAdd(1, .acq_rel);
        self.started.store(true, .release);
        while (!self.cancelled.load(.acquire)) {
            std.atomic.spinLoopHint();
        }
        return false;
    }

    fn cancel(context: ?*anyopaque) void {
        const self: *@This() = @ptrCast(@alignCast(context.?));
        _ = self.cancel_count.fetchAdd(1, .acq_rel);
        self.cancelled.store(true, .release);
    }
};

const testing_removal_launch =
    "{\"id\":\"removal-request-1\",\"ok\":true,\"result\":{" ++
    "\"kind\":\"localDataRemovalNativeLaunch\",\"version\":1," ++
    "\"operationId\":\"op_example01\",\"previewId\":\"removal_example01\"," ++
    "\"parentProcessId\":4242," ++
    "\"requestPath\":\"/Users/test/Library/Application Support/OPRTE Removal/requests/op_example01.json\"," ++
    "\"signingKeyPath\":\"/Users/test/Library/Application Support/OPRTE Removal/removal-signing.key\"," ++
    "\"publicResponse\":{\"version\":3,\"operationId\":\"op_example01\"," ++
    "\"ok\":true,\"result\":{\"type\":\"localDataRemovalScheduled\"," ++
    "\"previewId\":\"removal_example01\",\"state\":\"scheduled\"," ++
    "\"willQuitApplication\":true}}}}";
const testing_account_profile_ensure_request =
    "{\"kind\":\"accountProfileNativeRequest\",\"version\":1,\"request\":{" ++
    "\"id\":\"native-profile-0123456789abcdef01234567\"," ++
    "\"binding\":\"binding_0123456789abcdef0123456789abcdef0123456789abcdef\"," ++
    "\"action\":\"ensure\"," ++
    "\"controlPlanePath\":\"/Users/test/Library/Application Support/OPRTE/control-plane.sqlite\"," ++
    "\"accountProfileId\":\"acct_fixture01\"," ++
    "\"stateRootDevice\":\"1\",\"stateRootInode\":\"2\"," ++
    "\"controlPlaneDevice\":\"1\",\"controlPlaneInode\":\"3\"}}";
const testing_account_profile_delete_request =
    "{\"kind\":\"accountProfileNativeRequest\",\"version\":1,\"request\":{" ++
    "\"id\":\"native-profile-0123456789abcdef01234567\"," ++
    "\"binding\":\"binding_0123456789abcdef0123456789abcdef0123456789abcdef\"," ++
    "\"action\":\"delete\"," ++
    "\"controlPlanePath\":\"/Users/test/Library/Application Support/OPRTE/control-plane.sqlite\"," ++
    "\"accountProfileId\":\"acct_fixture01\"," ++
    "\"stateRootDevice\":\"1\",\"stateRootInode\":\"2\"," ++
    "\"controlPlaneDevice\":\"1\",\"controlPlaneInode\":\"3\"," ++
    "\"deletionNonce\":\"deletion_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\"," ++
    "\"expectedRevision\":7}}";

const testing_harness_envelope_zero =
    "{\"version\":1,\"algorithm\":\"hkdf-sha256\",\"key\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\"}";
const testing_harness_envelope_one =
    "{\"version\":1,\"algorithm\":\"hkdf-sha256\",\"key\":\"AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE\"}";
const testing_keychain_custodian_path =
    "/Applications/HRA.app/Contents/Resources/runtime/bin/oprte-keychain-custodian";
const testing_legacy_harness_gateway_path =
    "/Applications/OPRTE.app/Contents/Resources/runtime/legacy/preview-0.1.4-5/oprte-gateway";

fn testingHarnessCustodyValue(value: ?[]const u8) HarnessCustodyValue {
    var result: HarnessCustodyValue = .{
        .state = if (value == null) .absent else .present,
    };
    if (value) |present| {
        result.value_len = boundedCopy(&result.value, present) catch unreachable;
    }
    return result;
}

const HarnessCustodyOperationProbe = struct {
    v2: HarnessCustodyValue = .{ .state = .absent },
    legacy: HarnessCustodyValue = .{ .state = .absent },
    marker: ?HarnessReconciliationMarker = null,
    marker_corrupt: bool = false,
    set_conflict: bool = false,
    envelope_read_fails: bool = false,
    envelope_delete_fails: bool = false,
    legacy_read_fails: bool = false,
    legacy_read_fails_at: ?usize = null,
    legacy_disappears_after_first_read: bool = false,
    legacy_delete_fails: bool = false,
    legacy_failure_substage: LegacyHarnessCustodyFailureSubstage = .spawn,
    envelope_set_fails_once: bool = false,
    marker_prepare_fails_once: bool = false,
    marker_commit_fails_once: bool = false,
    marker_delete_fails_once: bool = false,
    helper_read_count: usize = 0,
    helper_set_count: usize = 0,
    helper_delete_count: usize = 0,
    marker_read_count: usize = 0,
    marker_prepare_count: usize = 0,
    marker_commit_count: usize = 0,
    marker_delete_count: usize = 0,
    legacy_read_count: usize = 0,
    legacy_delete_count: usize = 0,

    fn markerTransitionAllowed(
        existing: ?*const HarnessReconciliationMarker,
        desired: *const HarnessReconciliationMarker,
        prepare_action: bool,
    ) bool {
        if (!harnessReconciliationMarkerIsValid(desired) or
            prepare_action != (desired.phase == .prepared))
        {
            return false;
        }
        const prior = existing orelse {
            return (prepare_action and desired.legacy_state == .present) or
                (!prepare_action and desired.phase == .committed and
                    desired.legacy_state == .absent and
                    desired.envelope_state == .absent and
                    desired.envelopeSHA256() == null);
        };
        if (harnessReconciliationMarkersEqual(prior, desired)) return true;
        if (prepare_action) {
            return prior.phase == .committed and
                prior.legacy_state == .absent and
                prior.envelope_state == .absent and
                prior.envelopeSHA256() == null and
                desired.legacy_state == .absent and
                desired.envelope_state == .present;
        }
        if (desired.phase != .committed) return false;
        if (prior.phase == .prepared) {
            var expected = prior.*;
            expected.phase = .committed;
            return harnessReconciliationMarkersEqual(&expected, desired) or
                (prior.legacy_state == .absent and
                    desired.legacy_state == .absent and
                    desired.envelope_state == .absent and
                    desired.envelopeSHA256() == null);
        }
        return false;
    }

    fn helperRun(
        context: ?*anyopaque,
        helper_path: []const u8,
        action: HarnessCustodyHelperAction,
        value: ?[]const u8,
        timeout_milliseconds: u32,
        output: *HarnessCustodyHelperResult,
    ) bool {
        const self: *@This() = @ptrCast(@alignCast(context orelse return false));
        if (!std.mem.eql(u8, helper_path, testing_keychain_custodian_path))
            return false;
        if (timeout_milliseconds == 0) return false;
        switch (action) {
            .envelope_read => {
                self.helper_read_count += 1;
                if (self.envelope_read_fails) return false;
                output.* = .{ .envelope_read = self.v2 };
            },
            .envelope_set_if_absent => {
                self.helper_set_count += 1;
                if (self.envelope_set_fails_once) {
                    self.envelope_set_fails_once = false;
                    return false;
                }
                const requested = value orelse return false;
                if (self.set_conflict) {
                    self.v2 = testingHarnessCustodyValue(
                        testing_harness_envelope_one,
                    );
                    output.* = .{ .envelope_set_if_absent = .{
                        .value = self.v2,
                        .created = false,
                    } };
                    return true;
                }
                const created = self.v2.state == .absent;
                if (created) self.v2 = testingHarnessCustodyValue(requested);
                output.* = .{ .envelope_set_if_absent = .{
                    .value = self.v2,
                    .created = created,
                } };
            },
            .envelope_delete => {
                self.helper_delete_count += 1;
                if (self.envelope_delete_fails) return false;
                const deleted = self.v2.state == .present;
                self.v2 = .{ .state = .absent };
                output.* = .{ .envelope_delete = deleted };
            },
            .marker_read => {
                self.marker_read_count += 1;
                if (self.marker_corrupt) return false;
                output.* = .{ .marker_read = if (self.marker) |marker|
                    .{ .present = marker }
                else
                    .absent };
            },
            .marker_prepare, .marker_commit => {
                const prepare_action = action == .marker_prepare;
                if (prepare_action) {
                    self.marker_prepare_count += 1;
                    if (self.marker_prepare_fails_once) {
                        self.marker_prepare_fails_once = false;
                        return false;
                    }
                } else {
                    self.marker_commit_count += 1;
                    if (self.marker_commit_fails_once) {
                        self.marker_commit_fails_once = false;
                        return false;
                    }
                }
                if (self.marker_corrupt) return false;
                var desired: HarnessReconciliationMarker = undefined;
                if (!parseHarnessReconciliationMarker(
                    value orelse return false,
                    &desired,
                )) return false;
                const existing = if (self.marker) |*marker| marker else null;
                if (!markerTransitionAllowed(
                    existing,
                    &desired,
                    prepare_action,
                )) return false;
                self.marker = desired;
                output.* = .{ .marker_write = desired };
            },
            .marker_delete => {
                self.marker_delete_count += 1;
                if (self.marker_delete_fails_once) {
                    self.marker_delete_fails_once = false;
                    return false;
                }
                const deleted = self.marker != null or self.marker_corrupt;
                self.marker = null;
                self.marker_corrupt = false;
                output.* = .{ .marker_delete = deleted };
            },
        }
        return true;
    }

    fn legacyRead(
        context: ?*anyopaque,
        gateway_path: []const u8,
        timeout_milliseconds: u32,
        output: *HarnessCustodyValue,
        failure_substage: *LegacyHarnessCustodyFailureSubstage,
    ) bool {
        failure_substage.* = .admission;
        const self: *@This() = @ptrCast(@alignCast(context orelse return false));
        if (!std.mem.eql(u8, gateway_path, testing_legacy_harness_gateway_path))
            return false;
        if (timeout_milliseconds == 0) return false;
        self.legacy_read_count += 1;
        if (self.legacy_read_fails or
            self.legacy_read_fails_at == self.legacy_read_count)
        {
            failure_substage.* = self.legacy_failure_substage;
            return false;
        }
        output.* = if (self.legacy_disappears_after_first_read and
            self.legacy_read_count > 1)
            .{ .state = .absent }
        else
            self.legacy;
        failure_substage.* = .none;
        return true;
    }

    fn legacyDelete(
        context: ?*anyopaque,
        gateway_path: []const u8,
        timeout_milliseconds: u32,
        deleted: *bool,
        failure_substage: *LegacyHarnessCustodyFailureSubstage,
    ) bool {
        failure_substage.* = .admission;
        const self: *@This() = @ptrCast(@alignCast(context orelse return false));
        if (!std.mem.eql(u8, gateway_path, testing_legacy_harness_gateway_path))
            return false;
        if (timeout_milliseconds == 0) return false;
        self.legacy_delete_count += 1;
        if (self.legacy_delete_fails) {
            failure_substage.* = self.legacy_failure_substage;
            return false;
        }
        deleted.* = self.legacy.state == .present;
        self.legacy = .{ .state = .absent };
        failure_substage.* = .none;
        return true;
    }

    fn cancel(context: ?*anyopaque) void {
        _ = context;
    }

    fn helperRunner(self: *@This()) HarnessCustodyHelperRunner {
        return .{
            .context = self,
            .run_fn = helperRun,
            .cancel_fn = cancel,
        };
    }

    fn legacyRunner(self: *@This()) LegacyHarnessCustodyRunner {
        return .{
            .context = self,
            .read_fn = legacyRead,
            .delete_fn = legacyDelete,
            .cancel_fn = cancel,
        };
    }
};

fn testingHarnessCustodyRequest(
    action: HarnessCustodyAction,
) HarnessCustodyNativeRequest {
    const now_raw = std.Io.Clock.real.now(std.testing.io).toMilliseconds();
    const now: u64 = @intCast(@max(@as(i64, 0), now_raw));
    const boot_raw = std.Io.Clock.boot.now(std.testing.io).toMilliseconds();
    const boot: u64 = @intCast(@max(@as(i64, 0), boot_raw));
    return .{
        .id = undefined,
        .id_len = 0,
        .binding = undefined,
        .action = action,
        .deadline_unix_milliseconds = now + harness_custody_native_deadline_ms,
        .deadline_boot_milliseconds = boot + harness_custody_native_deadline_ms,
    };
}

fn setTestingHarnessCustodyValue(
    request: *HarnessCustodyNativeRequest,
    value: []const u8,
) void {
    request.value_len = boundedCopy(&request.value, value) catch unreachable;
}

fn testingHarnessCustodyDeadline(
    request: *const HarnessCustodyNativeRequest,
) HarnessCustodyDeadline {
    return .{
        .io = std.testing.io,
        .boot_milliseconds = request.deadline_boot_milliseconds,
    };
}

fn expectHarnessCustodyFailureStage(
    result: *const HarnessCustodyOperationResult,
    expected: HarnessCustodyFailureStage,
) !void {
    switch (result.*) {
        .failed => |actual| try std.testing.expectEqual(expected, actual),
        .legacy_failed => |actual| try std.testing.expectEqual(
            expected,
            actual.stage,
        ),
        else => return error.ExpectedHarnessCustodyFailure,
    }
}

fn expectLegacyHarnessCustodyFailure(
    result: *const HarnessCustodyOperationResult,
    expected_stage: HarnessCustodyFailureStage,
    expected_substage: LegacyHarnessCustodyFailureSubstage,
) !void {
    switch (result.*) {
        .legacy_failed => |actual| {
            try std.testing.expectEqual(expected_stage, actual.stage);
            try std.testing.expectEqual(expected_substage, actual.substage);
        },
        else => return error.ExpectedLegacyHarnessCustodyFailure,
    }
}

fn setTestingRemovalAuthorization(
    request: *HarnessCustodyNativeRequest,
    capability: []const u8,
    operation_id: []const u8,
    preview_id: []const u8,
) void {
    @memcpy(&request.removal_deletion_capability, capability);
    request.removal_operation_id_len = operation_id.len;
    @memcpy(
        request.removal_operation_id[0..operation_id.len],
        operation_id,
    );
    request.removal_preview_id_len = preview_id.len;
    @memcpy(
        request.removal_preview_id[0..preview_id.len],
        preview_id,
    );
}

test "legacy Harness custody response is exact and canonical" {
    var value: HarnessCustodyValue = undefined;
    var deleted = false;
    try std.testing.expect(parseLegacyHarnessCustodyResponse(
        false,
        "{\"version\":1,\"state\":\"present\",\"value\":\"{\\\"version\\\":1,\\\"algorithm\\\":\\\"hkdf-sha256\\\",\\\"key\\\":\\\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\\"}\"}",
        &value,
        &deleted,
    ));
    defer wipeHarnessCustodyValue(&value);
    try std.testing.expectEqualStrings(
        testing_harness_envelope_zero,
        value.valueSlice().?,
    );
    try std.testing.expect(!parseLegacyHarnessCustodyResponse(
        false,
        "{\"version\":1,\"state\":\"absent\",\"extra\":true}",
        &value,
        &deleted,
    ));
    try std.testing.expect(parseLegacyHarnessCustodyResponse(
        true,
        "{\"version\":1,\"deleted\":true}",
        &value,
        &deleted,
    ));
    try std.testing.expect(deleted);
}

test "Darwin helper request pipe reports EPIPE without SIGPIPE" {
    if (comptime !std.mem.eql(u8, build_options.platform, "macos")) return;
    var descriptors: [2]std.c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), std.c.pipe(&descriptors));
    var read_open = true;
    defer {
        if (read_open) _ = std.c.close(descriptors[0]);
        _ = std.c.close(descriptors[1]);
    }
    try std.testing.expectEqual(
        @as(c_int, 0),
        std.c.fcntl(
            descriptors[1],
            std.c.F.SETNOSIGPIPE,
            @as(c_int, 1),
        ),
    );
    _ = std.c.close(descriptors[0]);
    read_open = false;
    const byte = [_]u8{0x7b};
    const written = std.c.write(descriptors[1], &byte, byte.len);
    try std.testing.expectEqual(@as(isize, -1), written);
    try std.testing.expectEqual(std.posix.E.PIPE, std.posix.errno(written));
}

test "Harness reconciliation marker is canonical and bridge bound" {
    const marker = harnessReconciliationMarkerForEnvelope(
        .prepared,
        .present,
        testing_harness_envelope_zero,
    );
    var encoded_buffer: [max_harness_reconciliation_marker_bytes]u8 = undefined;
    const encoded = encodeHarnessReconciliationMarker(
        &encoded_buffer,
        &marker,
    ) orelse return error.ExpectedCanonicalHarnessMarker;
    var parsed: HarnessReconciliationMarker = undefined;
    try std.testing.expect(parseHarnessReconciliationMarker(encoded, &parsed));
    try std.testing.expect(harnessReconciliationMarkersEqual(&marker, &parsed));
    try std.testing.expect(std.mem.indexOf(
        u8,
        encoded,
        harness_legacy_bridge_cdhash,
    ) != null);

    const wrong_bridge =
        "{\"version\":1,\"phase\":\"prepared\",\"bridgeCDHash\":\"0000000000000000000000000000000000000000\",\"legacyState\":\"present\",\"envelopeState\":\"present\",\"envelopeSHA256\":\"1f41345a14c9ecadb2302ad66a34784e64bb04da83199cc286ee40c577864328\"}";
    try std.testing.expect(!parseHarnessReconciliationMarker(
        wrong_bridge,
        &parsed,
    ));
    const impossible_prepared =
        "{\"version\":1,\"phase\":\"prepared\",\"bridgeCDHash\":\"9f39a6414ae834959ec63b39237a0ee426fd978a\",\"legacyState\":\"absent\",\"envelopeState\":\"absent\",\"envelopeSHA256\":null}";
    try std.testing.expect(!parseHarnessReconciliationMarker(
        impossible_prepared,
        &parsed,
    ));

    const committed_present = harnessReconciliationMarkerForEnvelope(
        .committed,
        .absent,
        testing_harness_envelope_zero,
    );
    var prepared = committed_present;
    prepared.phase = .prepared;
    prepared.legacy_state = .present;
    const committed_absent = harnessAbsentCommittedMarker();
    try std.testing.expect(!HarnessCustodyOperationProbe.markerTransitionAllowed(
        null,
        &committed_present,
        false,
    ));
    try std.testing.expect(HarnessCustodyOperationProbe.markerTransitionAllowed(
        null,
        &prepared,
        true,
    ));
    try std.testing.expect(HarnessCustodyOperationProbe.markerTransitionAllowed(
        null,
        &committed_absent,
        false,
    ));
    try std.testing.expect(!HarnessCustodyOperationProbe.markerTransitionAllowed(
        &committed_absent,
        &committed_present,
        false,
    ));
    const native_prepared = harnessReconciliationMarkerForEnvelope(
        .prepared,
        .absent,
        testing_harness_envelope_zero,
    );
    try std.testing.expect(!HarnessCustodyOperationProbe.markerTransitionAllowed(
        null,
        &native_prepared,
        true,
    ));
    try std.testing.expect(HarnessCustodyOperationProbe.markerTransitionAllowed(
        &committed_absent,
        &native_prepared,
        true,
    ));
    try std.testing.expect(HarnessCustodyOperationProbe.markerTransitionAllowed(
        &native_prepared,
        &committed_absent,
        false,
    ));
}

test "Harness custody rejects expired or overlong Native deadlines" {
    const now: i64 = 1_800_000_000_000;
    try std.testing.expect(!harnessCustodyDeadlineIsAdmissible(-1, 1));
    try std.testing.expect(!harnessCustodyDeadlineIsAdmissible(
        now,
        @intCast(now),
    ));
    try std.testing.expect(harnessCustodyDeadlineIsAdmissible(
        now,
        @intCast(now + 1),
    ));
    try std.testing.expect(harnessCustodyDeadlineIsAdmissible(
        now,
        @intCast(now + harness_custody_native_deadline_ms),
    ));
    try std.testing.expect(!harnessCustodyDeadlineIsAdmissible(
        now,
        @intCast(now + harness_custody_native_deadline_ms + 1),
    ));
    try std.testing.expectEqual(
        @as(?u64, 550),
        harnessCustodyBootDeadlineFromAdmissionSamples(
            1_000,
            500,
            900,
            1_050,
        ),
    );
    try std.testing.expectEqual(
        @as(?u64, 525),
        harnessCustodyBootDeadlineFromAdmissionSamples(
            1_000,
            500,
            1_025,
            1_050,
        ),
    );
    const fixed_boot_deadline: HarnessCustodyDeadline = .{
        .io = std.testing.io,
        .boot_milliseconds = 550,
    };
    try std.testing.expectEqual(
        @as(?u32, 25),
        fixed_boot_deadline.remainingAt(525, 100),
    );
    try std.testing.expectEqual(
        @as(?u32, null),
        fixed_boot_deadline.remainingAt(550, 100),
    );

    var probe: HarnessCustodyOperationProbe = .{};
    var request = testingHarnessCustodyRequest(.read);
    request.deadline_unix_milliseconds = 1;
    request.deadline_boot_milliseconds = 1;
    var result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&result);
    try std.testing.expect(switch (result) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 0), probe.helper_read_count);
    try std.testing.expectEqual(@as(usize, 0), probe.legacy_read_count);
}

test "Harness custody failure reporting is fixed, exhaustive, and pathless" {
    var request = testingHarnessCustodyRequest(.read);
    const id = "native-harness-0123456789abcdef01234567";
    request.id_len = id.len;
    @memcpy(request.id[0..id.len], id);
    const binding =
        "binding_0123456789abcdef0123456789abcdef0123456789abcdef";
    @memcpy(&request.binding, binding);

    const nonlegacy_stages = [_]HarnessCustodyFailureStage{
        .admission,
        .marker_read,
        .envelope_read,
        .marker_prepare,
        .envelope_set_if_absent,
        .marker_commit,
        .envelope_delete,
        .marker_delete,
        .reconciliation,
        .reporting,
    };
    try std.testing.expectEqual(
        @as(usize, 13),
        std.meta.tags(HarnessCustodyFailureStage).len,
    );
    try std.testing.expectEqual(@as(usize, 10), nonlegacy_stages.len);
    for (nonlegacy_stages, 0..) |stage, stage_index| {
        try std.testing.expect(!stage.isLegacy());
        for (nonlegacy_stages[0..stage_index]) |earlier| {
            try std.testing.expect(stage != earlier);
        }
        var encoded: [harness_custody_failure_request_bytes]u8 = undefined;
        defer secureWipe(&encoded);
        try std.testing.expect(encodeFixedHarnessCustodyFailureRequest(
            &encoded,
            &request,
            stage,
            null,
        ));
        try std.testing.expectEqual(@as(u8, '\n'), encoded[encoded.len - 1]);
        try std.testing.expect(std.mem.indexOf(
            u8,
            &encoded,
            stage.text(),
        ) != null);
        try std.testing.expect(std.mem.indexOf(
            u8,
            &encoded,
            "failureStage",
        ) != null);
        try std.testing.expect(std.mem.indexOf(u8, &encoded, "/private/") == null);
        try std.testing.expect(std.mem.indexOf(u8, &encoded, "OSStatus") == null);
        var parsed = try std.json.parseFromSlice(
            std.json.Value,
            std.testing.allocator,
            encoded[0 .. encoded.len - 1],
            .{},
        );
        parsed.deinit();
    }

    const public_substages = [_]LegacyHarnessCustodyFailureSubstage{
        .admission,
        .static_bundle,
        .static_self_managed,
        .static_security_metadata,
        .spawn,
        .descriptor_before_dynamic,
        .dynamic_pid_hash,
        .dynamic_security_metadata,
        .descriptor_after_dynamic,
        .@"resume",
        .output,
        .exit,
        .group_retirement,
        .response_parse,
    };
    try std.testing.expectEqual(
        @as(usize, 15),
        std.meta.tags(LegacyHarnessCustodyFailureSubstage).len,
    );
    try std.testing.expectEqual(@as(usize, 14), public_substages.len);
    for (public_substages, 0..) |substage, substage_index| {
        try std.testing.expect(substage != .none);
        for (public_substages[0..substage_index]) |earlier| {
            try std.testing.expect(substage != earlier);
        }
        var encoded: [harness_custody_failure_request_bytes]u8 = undefined;
        defer secureWipe(&encoded);
        try std.testing.expect(encodeFixedHarnessCustodyFailureRequest(
            &encoded,
            &request,
            .legacy_read,
            substage,
        ));
        try std.testing.expect(std.mem.indexOf(
            u8,
            &encoded,
            substage.text().?,
        ) != null);
        try std.testing.expect(std.mem.indexOf(
            u8,
            &encoded,
            "legacySubstage",
        ) != null);
        try std.testing.expect(std.mem.indexOf(u8, &encoded, "/private/") == null);
        try std.testing.expect(std.mem.indexOf(u8, &encoded, "OSStatus") == null);
        try std.testing.expect(std.mem.indexOf(u8, &encoded, "\"pid\":") == null);
        var parsed = try std.json.parseFromSlice(
            std.json.Value,
            std.testing.allocator,
            encoded[0 .. encoded.len - 1],
            .{},
        );
        parsed.deinit();
    }

    var invalid: [harness_custody_failure_request_bytes]u8 = undefined;
    defer secureWipe(&invalid);
    try std.testing.expect(!encodeFixedHarnessCustodyFailureRequest(
        &invalid,
        &request,
        .legacy_read,
        null,
    ));
    try std.testing.expect(!encodeFixedHarnessCustodyFailureRequest(
        &invalid,
        &request,
        .marker_read,
        .spawn,
    ));
    try std.testing.expect(!encodeFixedHarnessCustodyFailureRequest(
        &invalid,
        &request,
        .legacy_read,
        .none,
    ));
}

test "Harness custody reports the exact failed operation stage" {
    var request = testingHarnessCustodyRequest(.read);

    var marker_read_probe: HarnessCustodyOperationProbe = .{
        .marker_corrupt = true,
    };
    var marker_read = executeHarnessCustodyOperation(
        marker_read_probe.helperRunner(),
        marker_read_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&marker_read);
    try expectHarnessCustodyFailureStage(&marker_read, .marker_read);

    var envelope_read_probe: HarnessCustodyOperationProbe = .{
        .envelope_read_fails = true,
    };
    var envelope_read = executeHarnessCustodyOperation(
        envelope_read_probe.helperRunner(),
        envelope_read_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&envelope_read);
    try expectHarnessCustodyFailureStage(&envelope_read, .envelope_read);

    var legacy_read_probe: HarnessCustodyOperationProbe = .{
        .legacy_read_fails = true,
    };
    var legacy_read = executeHarnessCustodyOperation(
        legacy_read_probe.helperRunner(),
        legacy_read_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&legacy_read);
    try expectLegacyHarnessCustodyFailure(
        &legacy_read,
        .legacy_read,
        .spawn,
    );

    var marker_prepare_probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .marker_prepare_fails_once = true,
    };
    var marker_prepare = executeHarnessCustodyOperation(
        marker_prepare_probe.helperRunner(),
        marker_prepare_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&marker_prepare);
    try expectHarnessCustodyFailureStage(&marker_prepare, .marker_prepare);

    var envelope_set_probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .envelope_set_fails_once = true,
    };
    var envelope_set = executeHarnessCustodyOperation(
        envelope_set_probe.helperRunner(),
        envelope_set_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&envelope_set);
    try expectHarnessCustodyFailureStage(
        &envelope_set,
        .envelope_set_if_absent,
    );

    var preservation_probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .legacy_read_fails_at = 2,
    };
    var preservation = executeHarnessCustodyOperation(
        preservation_probe.helperRunner(),
        preservation_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&preservation);
    try expectLegacyHarnessCustodyFailure(
        &preservation,
        .legacy_preservation_read,
        .spawn,
    );

    var marker_commit_probe: HarnessCustodyOperationProbe = .{
        .marker_commit_fails_once = true,
    };
    var marker_commit = executeHarnessCustodyOperation(
        marker_commit_probe.helperRunner(),
        marker_commit_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&marker_commit);
    try expectHarnessCustodyFailureStage(&marker_commit, .marker_commit);

    var reconciliation_probe: HarnessCustodyOperationProbe = .{
        .v2 = testingHarnessCustodyValue(testing_harness_envelope_zero),
    };
    var reconciliation = executeHarnessCustodyOperation(
        reconciliation_probe.helperRunner(),
        reconciliation_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&reconciliation);
    try expectHarnessCustodyFailureStage(&reconciliation, .reconciliation);

    request.action = .delete_both;
    var legacy_delete_probe: HarnessCustodyOperationProbe = .{
        .legacy_delete_fails = true,
    };
    var legacy_delete = executeHarnessCustodyOperation(
        legacy_delete_probe.helperRunner(),
        legacy_delete_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&legacy_delete);
    try expectLegacyHarnessCustodyFailure(
        &legacy_delete,
        .legacy_delete,
        .spawn,
    );

    var envelope_delete_probe: HarnessCustodyOperationProbe = .{
        .envelope_delete_fails = true,
    };
    var envelope_delete = executeHarnessCustodyOperation(
        envelope_delete_probe.helperRunner(),
        envelope_delete_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&envelope_delete);
    try expectHarnessCustodyFailureStage(&envelope_delete, .envelope_delete);

    var marker_delete_probe: HarnessCustodyOperationProbe = .{
        .marker_delete_fails_once = true,
    };
    var marker_delete = executeHarnessCustodyOperation(
        marker_delete_probe.helperRunner(),
        marker_delete_probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&marker_delete);
    try expectHarnessCustodyFailureStage(&marker_delete, .marker_delete);
}

test "Harness delete consumes only its exact live removal capability once" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
    };
    var request = testingHarnessCustodyRequest(.delete_both);
    const exact_capability = "ab" ** removal_deletion_capability_bytes;
    const wrong_capability = "cd" ** removal_deletion_capability_bytes;
    setTestingRemovalAuthorization(
        &request,
        wrong_capability,
        "op_removal01",
        "removal_example1",
    );
    try std.testing.expect(!host.consumeRemovalDeletionCapabilityLocked(
        &request,
    ));

    var no_request: [0]u8 = .{};
    var pending: Pending = .{
        .id = undefined,
        .id_len = 0,
        .destination = .{ .renderer = .{
            .responder = undefined,
            .removal = testingRemovalCorrelation(
                "op_removal01",
                "removal_example1",
            ),
        } },
        .request = &no_request,
    };
    @memcpy(&pending.removal_deletion_capability, exact_capability);
    pending.removal_deletion_capability_len = exact_capability.len;
    host.pending[0] = &pending;
    host.pending_count = 1;

    setTestingRemovalAuthorization(
        &request,
        exact_capability,
        "op_forged001",
        "removal_example1",
    );
    try std.testing.expect(!host.consumeRemovalDeletionCapabilityLocked(
        &request,
    ));
    setTestingRemovalAuthorization(
        &request,
        exact_capability,
        "op_removal01",
        "removal_example1",
    );
    try std.testing.expect(host.consumeRemovalDeletionCapabilityLocked(
        &request,
    ));
    try std.testing.expect(!host.consumeRemovalDeletionCapabilityLocked(
        &request,
    ));
    try std.testing.expect(pending.removal_deletion_capability_consumed);

    pending.destination = .native_removal_recovery;
    pending.removal_deletion_capability_consumed = false;
    @memcpy(&pending.removal_deletion_capability, exact_capability);
    pending.removal_deletion_capability_len = exact_capability.len;
    setTestingRemovalAuthorization(
        &request,
        exact_capability,
        "op_recovery01",
        "removal_recovery1",
    );
    try std.testing.expect(host.consumeRemovalDeletionCapabilityLocked(
        &request,
    ));
    try std.testing.expect(!host.consumeRemovalDeletionCapabilityLocked(
        &request,
    ));

    request.deletion_authorized = true;
    var probe: HarnessCustodyOperationProbe = .{
        .v2 = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
    };
    var result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&result);
    try std.testing.expect(switch (result) {
        .delete_both => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 1), probe.legacy_delete_count);
    try std.testing.expectEqual(@as(usize, 1), probe.helper_delete_count);
}

test "Harness custody commits one migration then restarts with zero legacy reads" {
    var probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
    };
    var request = testingHarnessCustodyRequest(.read);
    var result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&result);
    const read = switch (result) {
        .read => |read| read,
        else => return error.ExpectedMigratedHarnessCustodyRead,
    };
    try std.testing.expect(read.migrated_from_legacy);
    try std.testing.expect(read.legacy_preserved);
    try std.testing.expectEqualStrings(
        testing_harness_envelope_zero,
        read.value.valueSlice().?,
    );
    try std.testing.expectEqual(@as(usize, 1), probe.helper_set_count);
    try std.testing.expectEqual(@as(usize, 2), probe.legacy_read_count);
    try std.testing.expectEqual(@as(usize, 1), probe.marker_prepare_count);
    try std.testing.expectEqual(@as(usize, 1), probe.marker_commit_count);
    const marker = probe.marker orelse
        return error.ExpectedCommittedHarnessMarker;
    try std.testing.expectEqual(HarnessReconciliationPhase.committed, marker.phase);
    try std.testing.expect(harnessMarkerMatchesValue(&marker, &probe.v2));
    try std.testing.expectEqualStrings(
        testing_harness_envelope_zero,
        probe.legacy.valueSlice().?,
    );

    var restart = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&restart);
    const restarted = switch (restart) {
        .read => |readback| readback,
        else => return error.ExpectedHarnessCustodyRead,
    };
    try std.testing.expect(!restarted.migrated_from_legacy);
    try std.testing.expect(restarted.legacy_preserved);
    try std.testing.expectEqual(@as(usize, 2), probe.legacy_read_count);
    try std.testing.expectEqual(@as(usize, 1), probe.helper_set_count);
}

test "Harness custody commits absence and native set self-heals without legacy" {
    var probe: HarnessCustodyOperationProbe = .{};
    var read_request = testingHarnessCustodyRequest(.read);
    var initial = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &read_request,
        testingHarnessCustodyDeadline(&read_request),
    );
    defer wipeHarnessCustodyOperationResult(&initial);
    try std.testing.expect(switch (initial) {
        .read => |read| read.value.state == .absent,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 1), probe.legacy_read_count);
    const absent_marker = probe.marker orelse
        return error.ExpectedAbsentHarnessMarker;
    try std.testing.expectEqual(HarnessCustodyReadState.absent, absent_marker.envelope_state);

    var absent_restart = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &read_request,
        testingHarnessCustodyDeadline(&read_request),
    );
    defer wipeHarnessCustodyOperationResult(&absent_restart);
    try std.testing.expect(switch (absent_restart) {
        .read => |read| read.value.state == .absent,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 1), probe.legacy_read_count);

    var set_request = testingHarnessCustodyRequest(.set_if_absent);
    setTestingHarnessCustodyValue(&set_request, testing_harness_envelope_zero);
    var set_result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &set_request,
        testingHarnessCustodyDeadline(&set_request),
    );
    defer wipeHarnessCustodyOperationResult(&set_result);
    try std.testing.expect(switch (set_result) {
        .set_if_absent => |set| set.created,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 1), probe.legacy_read_count);
    const present_marker = probe.marker orelse
        return error.ExpectedPresentHarnessMarker;
    try std.testing.expectEqual(
        HarnessReconciliationLegacyState.absent,
        present_marker.legacy_state,
    );
    try std.testing.expect(harnessMarkerMatchesValue(&present_marker, &probe.v2));

    var restart = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &read_request,
        testingHarnessCustodyDeadline(&read_request),
    );
    defer wipeHarnessCustodyOperationResult(&restart);
    try std.testing.expect(switch (restart) {
        .read => |read| read.value.state == .present and
            !read.legacy_preserved,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 1), probe.legacy_read_count);
}

test "Harness native set self-heals its post-v2 crash window" {
    var probe: HarnessCustodyOperationProbe = .{
        .marker = harnessAbsentCommittedMarker(),
        .marker_commit_fails_once = true,
    };
    var request = testingHarnessCustodyRequest(.set_if_absent);
    setTestingHarnessCustodyValue(&request, testing_harness_envelope_zero);
    var interrupted = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&interrupted);
    try std.testing.expect(switch (interrupted) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(HarnessCustodyReadState.present, probe.v2.state);
    try std.testing.expectEqual(
        HarnessReconciliationPhase.prepared,
        (probe.marker orelse return error.ExpectedPreparedHarnessMarker).phase,
    );
    try std.testing.expectEqual(@as(usize, 0), probe.legacy_read_count);

    var restart_request = testingHarnessCustodyRequest(.read);
    var resumed = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &restart_request,
        testingHarnessCustodyDeadline(&restart_request),
    );
    defer wipeHarnessCustodyOperationResult(&resumed);
    try std.testing.expect(switch (resumed) {
        .read => |read| read.value.state == .present and
            !read.migrated_from_legacy and !read.legacy_preserved,
        else => false,
    });
    const healed = probe.marker orelse
        return error.ExpectedPresentHarnessMarker;
    try std.testing.expect(harnessMarkerMatchesValue(&healed, &probe.v2));
    try std.testing.expectEqual(@as(usize, 0), probe.legacy_read_count);
    try std.testing.expectEqual(@as(usize, 1), probe.helper_set_count);
}

test "Harness native set restart rolls back a prepared pre-v2 crash" {
    var probe: HarnessCustodyOperationProbe = .{
        .marker = harnessAbsentCommittedMarker(),
        .envelope_set_fails_once = true,
    };
    var set_request = testingHarnessCustodyRequest(.set_if_absent);
    setTestingHarnessCustodyValue(&set_request, testing_harness_envelope_zero);
    var interrupted = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &set_request,
        testingHarnessCustodyDeadline(&set_request),
    );
    defer wipeHarnessCustodyOperationResult(&interrupted);
    try std.testing.expect(switch (interrupted) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(HarnessCustodyReadState.absent, probe.v2.state);
    try std.testing.expectEqual(
        HarnessReconciliationPhase.prepared,
        (probe.marker orelse return error.ExpectedPreparedHarnessMarker).phase,
    );

    var read_request = testingHarnessCustodyRequest(.read);
    var resumed = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &read_request,
        testingHarnessCustodyDeadline(&read_request),
    );
    defer wipeHarnessCustodyOperationResult(&resumed);
    try std.testing.expect(switch (resumed) {
        .read => |read| read.value.state == .absent and
            !read.migrated_from_legacy and !read.legacy_preserved,
        else => false,
    });
    const rolled_back = probe.marker orelse
        return error.ExpectedAbsentHarnessMarker;
    try std.testing.expectEqual(
        HarnessReconciliationPhase.committed,
        rolled_back.phase,
    );
    try std.testing.expectEqual(
        HarnessCustodyReadState.absent,
        rolled_back.envelope_state,
    );
    try std.testing.expectEqual(@as(usize, 0), probe.legacy_read_count);
}

test "Harness custody resumes only a prepared crash boundary" {
    var probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .envelope_set_fails_once = true,
    };
    var request = testingHarnessCustodyRequest(.read);
    var interrupted = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&interrupted);
    try std.testing.expect(switch (interrupted) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(
        HarnessReconciliationPhase.prepared,
        (probe.marker orelse return error.ExpectedPreparedHarnessMarker).phase,
    );
    try std.testing.expectEqual(HarnessCustodyReadState.absent, probe.v2.state);
    try std.testing.expectEqual(@as(usize, 1), probe.legacy_read_count);

    var resumed = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&resumed);
    try std.testing.expect(switch (resumed) {
        .read => |read| read.migrated_from_legacy and read.legacy_preserved,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 3), probe.legacy_read_count);
    try std.testing.expectEqual(
        HarnessReconciliationPhase.committed,
        (probe.marker orelse return error.ExpectedCommittedHarnessMarker).phase,
    );

    var restart = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&restart);
    try std.testing.expect(switch (restart) {
        .read => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 3), probe.legacy_read_count);
}

test "Harness custody resumes after v2 creation but before marker commit" {
    var probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .marker_commit_fails_once = true,
    };
    var request = testingHarnessCustodyRequest(.read);
    var interrupted = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&interrupted);
    try std.testing.expect(switch (interrupted) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(HarnessCustodyReadState.present, probe.v2.state);
    try std.testing.expectEqual(
        HarnessReconciliationPhase.prepared,
        (probe.marker orelse return error.ExpectedPreparedHarnessMarker).phase,
    );
    try std.testing.expectEqual(@as(usize, 2), probe.legacy_read_count);

    var resumed = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&resumed);
    try std.testing.expect(switch (resumed) {
        .read => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 4), probe.legacy_read_count);
    try std.testing.expectEqual(@as(usize, 1), probe.helper_set_count);
}

test "Harness custody fails closed on missing corrupt or mismatched marker" {
    var missing: HarnessCustodyOperationProbe = .{
        .v2 = testingHarnessCustodyValue(testing_harness_envelope_zero),
    };
    var request = testingHarnessCustodyRequest(.read);
    var missing_result = executeHarnessCustodyOperation(
        missing.helperRunner(),
        missing.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&missing_result);
    try std.testing.expect(switch (missing_result) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 0), missing.legacy_read_count);

    var corrupt: HarnessCustodyOperationProbe = .{
        .v2 = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .marker_corrupt = true,
    };
    var corrupt_result = executeHarnessCustodyOperation(
        corrupt.helperRunner(),
        corrupt.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&corrupt_result);
    try std.testing.expect(switch (corrupt_result) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 0), corrupt.helper_read_count);
    try std.testing.expectEqual(@as(usize, 0), corrupt.legacy_read_count);

    var mismatched: HarnessCustodyOperationProbe = .{
        .v2 = testingHarnessCustodyValue(testing_harness_envelope_one),
        .marker = harnessReconciliationMarkerForEnvelope(
            .committed,
            .present,
            testing_harness_envelope_zero,
        ),
    };
    var mismatched_result = executeHarnessCustodyOperation(
        mismatched.helperRunner(),
        mismatched.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&mismatched_result);
    try std.testing.expect(switch (mismatched_result) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 0), mismatched.legacy_read_count);
}

test "Harness custody never commits a conflicting v2 value" {
    var probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .set_conflict = true,
    };
    var request = testingHarnessCustodyRequest(.read);
    var result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&result);
    try std.testing.expect(switch (result) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqualStrings(
        testing_harness_envelope_one,
        probe.v2.valueSlice().?,
    );
    try std.testing.expectEqualStrings(
        testing_harness_envelope_zero,
        probe.legacy.valueSlice().?,
    );
    try std.testing.expectEqual(
        HarnessReconciliationPhase.prepared,
        (probe.marker orelse return error.ExpectedPreparedHarnessMarker).phase,
    );
    try std.testing.expectEqual(@as(usize, 0), probe.marker_commit_count);
}

test "Harness custody fails migration when exact legacy readback changes" {
    var probe: HarnessCustodyOperationProbe = .{
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .legacy_disappears_after_first_read = true,
    };
    var request = testingHarnessCustodyRequest(.read);
    var result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&result);
    try std.testing.expect(switch (result) {
        .failed => true,
        else => false,
    });
    try std.testing.expectEqual(
        HarnessReconciliationPhase.prepared,
        (probe.marker orelse return error.ExpectedPreparedHarnessMarker).phase,
    );
    try std.testing.expectEqual(@as(usize, 0), probe.marker_commit_count);
}

test "Harness custody authenticated delete removes a corrupt marker last" {
    var probe: HarnessCustodyOperationProbe = .{
        .v2 = testingHarnessCustodyValue(testing_harness_envelope_one),
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .marker_corrupt = true,
    };
    var request = testingHarnessCustodyRequest(.delete_both);
    request.deletion_authorized = true;
    var result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&result);
    try std.testing.expect(switch (result) {
        .delete_both => |deleted| deleted.deleted_v1 and deleted.deleted_v2,
        else => false,
    });
    try std.testing.expectEqual(HarnessCustodyReadState.absent, probe.legacy.state);
    try std.testing.expectEqual(HarnessCustodyReadState.absent, probe.v2.state);
    try std.testing.expect(probe.marker == null and !probe.marker_corrupt);
    try std.testing.expectEqual(@as(usize, 1), probe.marker_delete_count);
    try std.testing.expectEqual(@as(usize, 1), probe.marker_read_count);
}

test "Harness custody delete never touches v2 when v1 deletion fails" {
    var probe: HarnessCustodyOperationProbe = .{
        .v2 = testingHarnessCustodyValue(testing_harness_envelope_one),
        .legacy = testingHarnessCustodyValue(testing_harness_envelope_zero),
        .legacy_delete_fails = true,
    };
    var request = testingHarnessCustodyRequest(.delete_both);
    var result = executeHarnessCustodyOperation(
        probe.helperRunner(),
        probe.legacyRunner(),
        testing_keychain_custodian_path,
        testing_legacy_harness_gateway_path,
        &request,
        testingHarnessCustodyDeadline(&request),
    );
    defer wipeHarnessCustodyOperationResult(&result);
    try std.testing.expect(switch (result) {
        .legacy_failed => true,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 0), probe.helper_delete_count);
    try std.testing.expectEqualStrings(
        testing_harness_envelope_one,
        probe.v2.valueSlice().?,
    );
}

test "direct Harness custody initializes and mutates v2 without a legacy runner" {
    var probe: HarnessCustodyOperationProbe = .{};

    var read_request = testingHarnessCustodyRequest(.read);
    var initial = executeDirectHarnessCustodyOperation(
        probe.helperRunner(),
        testing_keychain_custodian_path,
        &read_request,
        testingHarnessCustodyDeadline(&read_request),
    );
    defer wipeHarnessCustodyOperationResult(&initial);
    try std.testing.expect(switch (initial) {
        .read => |read| read.value.state == .absent and
            !read.migrated_from_legacy and !read.legacy_preserved,
        else => false,
    });

    var set_request = testingHarnessCustodyRequest(.set_if_absent);
    setTestingHarnessCustodyValue(&set_request, testing_harness_envelope_zero);
    var set = executeDirectHarnessCustodyOperation(
        probe.helperRunner(),
        testing_keychain_custodian_path,
        &set_request,
        testingHarnessCustodyDeadline(&set_request),
    );
    defer wipeHarnessCustodyOperationResult(&set);
    try std.testing.expect(switch (set) {
        .set_if_absent => |created| created.created and
            std.mem.eql(
                u8,
                created.value.valueSlice() orelse "",
                testing_harness_envelope_zero,
            ),
        else => false,
    });

    var delete_request = testingHarnessCustodyRequest(.delete_both);
    var deleted = executeDirectHarnessCustodyOperation(
        probe.helperRunner(),
        testing_keychain_custodian_path,
        &delete_request,
        testingHarnessCustodyDeadline(&delete_request),
    );
    defer wipeHarnessCustodyOperationResult(&deleted);
    try std.testing.expect(switch (deleted) {
        .delete_both => |result| !result.deleted_v1 and result.deleted_v2,
        else => false,
    });
    try std.testing.expectEqual(@as(usize, 0), probe.legacy_read_count);
    try std.testing.expectEqual(@as(usize, 0), probe.legacy_delete_count);
    try std.testing.expectEqual(@as(usize, 0), probe.marker_read_count);
    try std.testing.expectEqual(@as(usize, 0), probe.marker_prepare_count);
    try std.testing.expectEqual(@as(usize, 0), probe.marker_commit_count);
    try std.testing.expectEqual(@as(usize, 1), probe.marker_delete_count);
}

test "packaged runtime paths ignore every executable and root override" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HRA_GATEWAY_PATH", "/tmp/untrusted/bin/oprte-gateway");
    try parent.put("HRA_BUN_BIN", "/tmp/untrusted/bun");
    try parent.put("HRA_CODEX_BIN", "/tmp/untrusted/codex");
    try parent.put("HRA_GIT_ROOT", "/tmp/untrusted/git");
    try parent.put("HRA_GIT_BIN", "/tmp/untrusted/git/bin/git");
    try parent.put(
        "HRA_GIT_EXECUTOR_PATH",
        "/tmp/untrusted/bin/oprte-git-executor",
    );
    try parent.put(
        "HRA_IMAGE_NORMALIZER_PATH",
        "/tmp/untrusted/bin/hra-image-normalizer",
    );

    var paths = try resolveRuntimePathsForExecutable(std.testing.allocator, &parent, .{
        .runtime_root = "/tmp/explicit/runtime",
        .gateway_path = "/tmp/explicit/runtime/bin/oprte-gateway",
        .bun_bin = "/tmp/explicit/runtime/bin/bun",
        .codex_bin = "/tmp/explicit/codex",
        .git_root = "/tmp/explicit/git",
        .git_bin = "/tmp/explicit/git/bin/git",
        .git_executor_path = "/tmp/explicit/bin/oprte-git-executor",
        .image_normalizer_path = "/tmp/explicit/bin/hra-image-normalizer",
    }, "/Applications/HRA.app/Contents/MacOS/hra");
    defer paths.deinit(std.testing.allocator);

    try std.testing.expectEqualStrings("/Applications/HRA.app/Contents/Resources/runtime", paths.runtime_root);
    try std.testing.expectEqualStrings("/Applications/HRA.app/Contents/Resources/runtime/bin/oprte-gateway", paths.gateway_path);
    try std.testing.expectEqualStrings("/Applications/HRA.app/Contents/Resources/runtime/bin/bun", paths.bun_bin);
    try std.testing.expectEqualStrings("/Applications/HRA.app/Contents/Resources/runtime/codex/bin/codex", paths.codex_bin);
    try std.testing.expectEqualStrings("/Applications/HRA.app/Contents/Resources/runtime/git", paths.git_root);
    try std.testing.expectEqualStrings("/Applications/HRA.app/Contents/Resources/runtime/git/bin/git", paths.git_bin);
    try std.testing.expectEqualStrings(
        "/Applications/HRA.app/Contents/Resources/runtime/bin/oprte-git-executor",
        paths.git_executor_path,
    );
    try std.testing.expectEqualStrings(
        "/Applications/HRA.app/Contents/Resources/runtime/bin/oprte-data-remover",
        paths.data_remover_path,
    );
    try std.testing.expectEqualStrings(
        testing_keychain_custodian_path,
        paths.keychain_custodian_path,
    );
    try std.testing.expectEqualStrings(
        "/Applications/HRA.app/Contents/Resources/runtime/bin/hra-image-normalizer",
        paths.image_normalizer_path,
    );
}

test "packaged runtime ignores package smoke custodian environment" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("OPRTE_PACKAGE_SMOKE", "1");
    try parent.put(
        "OPRTE_PACKAGE_SMOKE_CUSTODIAN_PATH",
        "/tmp/zig-out/bin/package-smoke/oprte-keychain-custodian",
    );
    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{},
        "/Applications/HRA.app/Contents/MacOS/hra",
    );
    defer paths.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(
        testing_keychain_custodian_path,
        paths.keychain_custodian_path,
    );
}

test "development path overrides are explicit and independently preserved" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HRA_GATEWAY_PATH", "/tmp/hra-runtime/bin/oprte-gateway");
    try parent.put("HRA_BUN_BIN", "/opt/runtime/bin/bun");
    try parent.put("HRA_CODEX_BIN", "/opt/codex/codex");
    try parent.put("HRA_GIT_ROOT", "/opt/git-runtime");
    try parent.put("HRA_GIT_BIN", "/opt/git-runtime/libexec/git");
    try parent.put(
        "HRA_GIT_EXECUTOR_PATH",
        "/opt/runtime/bin/oprte-git-executor",
    );
    try parent.put(
        "HRA_IMAGE_NORMALIZER_PATH",
        "/opt/runtime/bin/hra-image-normalizer",
    );

    var paths = try resolveRuntimePathsForExecutable(std.testing.allocator, &parent, .{
        .gateway_path = "/tmp/explicit-runtime/bin/oprte-gateway",
        .bun_bin = "/tmp/explicit-runtime/bin/bun",
        .codex_bin = "/tmp/explicit-codex/codex",
        .git_root = "/tmp/explicit-git",
        .git_bin = "/tmp/explicit-git/libexec/git",
        .git_executor_path = "/tmp/explicit/bin/oprte-git-executor",
        .image_normalizer_path = "/tmp/explicit/bin/hra-image-normalizer",
    }, "/tmp/hra-tests/zig-out/bin/hra-test");
    defer paths.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("/tmp/explicit-runtime", paths.runtime_root);
    try std.testing.expectEqualStrings("/tmp/explicit-runtime/bin/oprte-gateway", paths.gateway_path);
    try std.testing.expectEqualStrings("/tmp/explicit-runtime/bin/bun", paths.bun_bin);
    try std.testing.expectEqualStrings("/tmp/explicit-codex/codex", paths.codex_bin);
    try std.testing.expectEqualStrings("/tmp/explicit-git", paths.git_root);
    try std.testing.expectEqualStrings("/tmp/explicit-git/libexec/git", paths.git_bin);
    try std.testing.expectEqualStrings(
        "/tmp/explicit/bin/oprte-git-executor",
        paths.git_executor_path,
    );
    try std.testing.expectEqualStrings(
        "/tmp/explicit/bin/hra-image-normalizer",
        paths.image_normalizer_path,
    );
}

test "non-bundle execution requires an explicit development runtime" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();

    try std.testing.expectError(error.MissingDevelopmentRuntimeRoot, resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{},
        "/tmp/hra-tests/zig-out/bin/hra-test",
    ));
}

test "development path overrides accept equal legacy aliases and reject conflicts" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("KITCHEN_GATEWAY_PATH", "/opt/bridge/runtime/bin/oprte-gateway");
    try parent.put("OPRTE_GATEWAY_PATH", "/opt/bridge/runtime/bin/oprte-gateway");
    try parent.put("HRA_GATEWAY_PATH", "/opt/bridge/runtime/bin/oprte-gateway");

    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{},
        "/tmp/hra-tests/zig-out/bin/hra-test",
    );
    defer paths.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(
        "/opt/bridge/runtime/bin/oprte-gateway",
        paths.gateway_path,
    );

    try parent.put("HRA_GATEWAY_PATH", "/opt/conflict/runtime/bin/oprte-gateway");
    try std.testing.expectError(
        error.ConflictingEnvironmentAlias,
        resolveRuntimePathsForExecutable(
            std.testing.allocator,
            &parent,
            .{},
            "/tmp/hra-tests/zig-out/bin/hra-test",
        ),
    );
}

test "development path overrides treat empty renamed values as absent" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HRA_GATEWAY_PATH", "");
    try parent.put("OPRTE_GATEWAY_PATH", "/opt/legacy/runtime/bin/oprte-gateway");

    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{},
        "/tmp/hra-tests/zig-out/bin/hra-test",
    );
    defer paths.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings(
        "/opt/legacy/runtime/bin/oprte-gateway",
        paths.gateway_path,
    );
}

test "raw development sidecar is cloud detached while pinning runtime tools" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HOME", "/Users/tester");
    try parent.put("CFFIXED_USER_HOME", "/Users/tester");
    try parent.put("LANG", "en_US.UTF-8");
    try parent.put("HRA_CLOUD_API_URL", "https://hra.example.com");
    try parent.put("OPRTE_CLOUD_API_URL", "https://hra.example.com");
    try parent.put("TASKCTL_API_URL", "https://compat.example.com");
    try parent.put("HRA_CLOUD_WEB_URL", "https://app.hra.example.com");
    try parent.put("OPRTE_CLOUD_WEB_URL", "https://app.hra.example.com");
    try parent.put("GITHUB_TOKEN", "must-not-leak");
    try parent.put("SSH_AUTH_SOCK", "/tmp/agent.sock");
    try parent.put("DYLD_INSERT_LIBRARIES", "/tmp/inject.dylib");
    try parent.put("NODE_OPTIONS", "--require=/tmp/hook.js");

    var paths = try resolveRuntimePathsForExecutable(std.testing.allocator, &parent, .{
        .runtime_root = "/opt/hra/runtime",
    }, "/tmp/hra-tests/zig-out/bin/hra-test");
    defer paths.deinit(std.testing.allocator);
    var environment = try buildSanitizedEnvironment(
        std.testing.allocator,
        &parent,
        &paths,
        .development,
        null,
    );
    defer environment.deinit();

    try std.testing.expect(environment.get("HOME") == null);
    try std.testing.expect(environment.get("CFFIXED_USER_HOME") == null);
    try std.testing.expectEqualStrings("en_US.UTF-8", environment.get("LANG").?);
    try std.testing.expect(environment.get("HRA_CLOUD_API_URL") == null);
    try std.testing.expect(environment.get("OPRTE_CLOUD_API_URL") == null);
    try std.testing.expect(environment.get("TASKCTL_API_URL") == null);
    try std.testing.expect(environment.get("HRA_CLOUD_WEB_URL") == null);
    try std.testing.expect(environment.get("OPRTE_CLOUD_WEB_URL") == null);
    try std.testing.expectEqualStrings("/opt/hra/runtime/bin/oprte-gateway", environment.get("HRA_GATEWAY_PATH").?);
    try std.testing.expectEqualStrings("/opt/hra/runtime/bin/bun", environment.get("HRA_BUN_BIN").?);
    try std.testing.expectEqualStrings("/opt/hra/runtime/codex/bin/codex", environment.get("HRA_CODEX_BIN").?);
    try std.testing.expectEqualStrings(
        "/opt/hra/runtime/bin/oprte-git-executor",
        environment.get("HRA_GIT_EXECUTOR_PATH").?,
    );
    try std.testing.expectEqualStrings(
        "/opt/hra/runtime/bin/hra-image-normalizer",
        environment.get("HRA_IMAGE_NORMALIZER_PATH").?,
    );
    try std.testing.expect(environment.get("OPRTE_GATEWAY_PATH") == null);
    try std.testing.expect(environment.get("OPRTE_CODEX_BIN") == null);
    try std.testing.expect(environment.get("GITHUB_TOKEN") == null);
    try std.testing.expect(environment.get("SSH_AUTH_SOCK") == null);
    try std.testing.expect(environment.get("DYLD_INSERT_LIBRARIES") == null);
    try std.testing.expect(environment.get("NODE_OPTIONS") == null);
}

test "automation sidecar may receive explicit fixture cloud coordinates" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HRA_CLOUD_API_URL", "http://127.0.0.1:4100");
    try parent.put("TASKCTL_API_URL", "http://127.0.0.1:4200");
    try parent.put("HRA_CLOUD_WEB_URL", "http://127.0.0.1:4300");
    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{ .runtime_root = "/opt/hra/runtime" },
        "/tmp/hra-tests/zig-out/bin/hra-test",
    );
    defer paths.deinit(std.testing.allocator);
    var environment = try buildSanitizedEnvironment(
        std.testing.allocator,
        &parent,
        &paths,
        .automation,
        null,
    );
    defer environment.deinit();

    try std.testing.expectEqualStrings(
        "http://127.0.0.1:4100",
        environment.get("HRA_CLOUD_API_URL").?,
    );
    try std.testing.expectEqualStrings(
        "http://127.0.0.1:4200",
        environment.get("TASKCTL_API_URL").?,
    );
    try std.testing.expectEqualStrings(
        "http://127.0.0.1:4300",
        environment.get("HRA_CLOUD_WEB_URL").?,
    );
}

test "startup removal recovery environment is exact and Native controlled" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HRA_STARTUP_REMOVAL_RECOVERY", "spoofed");
    try parent.put("OPRTE_STARTUP_REMOVAL_RECOVERY", "legacy-spoofed");
    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{ .runtime_root = "/opt/hra/runtime" },
        "/tmp/hra-tests/zig-out/bin/hra-test",
    );
    defer paths.deinit(std.testing.allocator);
    var environment = try buildSanitizedEnvironment(
        std.testing.allocator,
        &parent,
        &paths,
        .production,
        null,
    );
    defer environment.deinit();
    try std.testing.expect(
        environment.get("HRA_STARTUP_REMOVAL_RECOVERY") == null,
    );
    try addStartupRemovalRecoveryEnvironment(&environment, false);
    try std.testing.expect(
        environment.get("HRA_STARTUP_REMOVAL_RECOVERY") == null,
    );
    try addStartupRemovalRecoveryEnvironment(&environment, true);
    try std.testing.expectEqualStrings(
        "1",
        environment.get("HRA_STARTUP_REMOVAL_RECOVERY").?,
    );
}

test "production cloud coordinates are pinned and ambient overrides are ignored" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    try parent.put("HRA_CLOUD_API_URL", "https://canonical-attacker.example.com");
    try parent.put("OPRTE_CLOUD_API_URL", "https://legacy-attacker.example.com");
    try parent.put("TASKCTL_API_URL", "https://compat.example.com");
    try parent.put("HRA_CLOUD_WEB_URL", "https://web-attacker.example.com");
    try parent.put("OPRTE_CLOUD_WEB_URL", "https://legacy-web-attacker.example.com");
    var paths = try resolveRuntimePathsForExecutable(
        std.testing.allocator,
        &parent,
        .{ .runtime_root = "/opt/hra/runtime" },
        "/tmp/hra-tests/zig-out/bin/hra-test",
    );
    defer paths.deinit(std.testing.allocator);

    var disabled = try buildSanitizedEnvironment(
        std.testing.allocator,
        &parent,
        &paths,
        .production,
        null,
    );
    defer disabled.deinit();
    try std.testing.expect(disabled.get("HRA_CLOUD_API_URL") == null);
    try std.testing.expect(disabled.get("HRA_CLOUD_WEB_URL") == null);
    try std.testing.expect(disabled.get("OPRTE_CLOUD_API_URL") == null);
    try std.testing.expect(disabled.get("OPRTE_CLOUD_WEB_URL") == null);
    try std.testing.expect(disabled.get("TASKCTL_API_URL") == null);

    var enabled = try buildSanitizedEnvironment(
        std.testing.allocator,
        &parent,
        &paths,
        .production,
        .{
            .api_origin = "https://benevolent-akita-439.convex.site",
            .web_origin = "https://hra.sh",
        },
    );
    defer enabled.deinit();
    try std.testing.expectEqualStrings(
        "https://benevolent-akita-439.convex.site",
        enabled.get("HRA_CLOUD_API_URL").?,
    );
    try std.testing.expectEqualStrings(
        "https://hra.sh",
        enabled.get("HRA_CLOUD_WEB_URL").?,
    );
    try std.testing.expect(enabled.get("TASKCTL_API_URL") == null);
    try std.testing.expect(enabled.get("OPRTE_CLOUD_API_URL") == null);
    try std.testing.expect(enabled.get("OPRTE_CLOUD_WEB_URL") == null);
}

test "gateway stderr is visible only in Debug hosts" {
    switch (gatewayStderrForMode(.Debug)) {
        .inherit => {},
        else => return error.ExpectedInheritedGatewayStderr,
    }
    for ([_]std.builtin.OptimizeMode{
        .ReleaseSafe,
        .ReleaseFast,
        .ReleaseSmall,
    }) |mode| switch (gatewayStderrForMode(mode)) {
        .ignore => {},
        else => return error.ExpectedIgnoredGatewayStderr,
    };
}

test "bridge profiles isolate production development and automation origins" {
    const production = bridgePolicy(.production);
    try std.testing.expect(production.allows(snapshot_command, "zero://app"));
    try std.testing.expect(production.allows(dispatch_command, "zero://app"));
    try std.testing.expect(!production.allows(dispatch_command, "zero://inline"));
    try std.testing.expect(!production.allows(snapshot_command, "http://127.0.0.1:5173"));
    try std.testing.expect(!production.allows("native-sdk.dialog.openFile", "zero://app"));
    try std.testing.expect(!production.allows(private_project_onboarding_command, "zero://app"));
    try std.testing.expect(!production.allows(private_removal_recovery_command, "zero://app"));
    try std.testing.expect(production.allows(native_project_add_command, "zero://app"));
    try std.testing.expect(production.allows(native_folder_access_select_command, "zero://app"));
    try std.testing.expect(production.allows(transport_retry_command, "zero://app"));
    try std.testing.expect(production.allows(transport_health_command, "zero://app"));

    const development = bridgePolicy(.development);
    try std.testing.expect(development.allows(snapshot_command, "zero://app"));
    try std.testing.expect(development.allows(dispatch_command, "http://127.0.0.1:5173"));
    try std.testing.expect(!development.allows(dispatch_command, "zero://inline"));
    try std.testing.expect(!development.allows(snapshot_command, "http://localhost:5173"));
    try std.testing.expect(!development.allows(dispatch_command, "http://127.0.0.1:5174"));
    try std.testing.expect(!development.allows(private_project_onboarding_command, "http://127.0.0.1:5173"));
    try std.testing.expect(!development.allows(private_removal_recovery_command, "http://127.0.0.1:5173"));
    try std.testing.expect(development.allows(native_project_add_command, "http://127.0.0.1:5173"));
    try std.testing.expect(development.allows(native_folder_access_select_command, "http://127.0.0.1:5173"));
    try std.testing.expect(development.allows(transport_retry_command, "http://127.0.0.1:5173"));
    try std.testing.expect(development.allows(transport_health_command, "http://127.0.0.1:5173"));

    const automation = bridgePolicy(.automation);
    try std.testing.expect(automation.allows(snapshot_command, "zero://app"));
    try std.testing.expect(automation.allows(dispatch_command, "zero://inline"));
    try std.testing.expect(!automation.allows(snapshot_command, "http://127.0.0.1:5173"));
    try std.testing.expect(!automation.allows(private_project_onboarding_command, "zero://inline"));
    try std.testing.expect(!automation.allows(private_removal_recovery_command, "zero://inline"));
    try std.testing.expect(automation.allows(native_project_add_command, "zero://inline"));
    try std.testing.expect(automation.allows(native_folder_access_select_command, "zero://inline"));
    try std.testing.expect(automation.allows(transport_retry_command, "zero://inline"));
    try std.testing.expect(automation.allows(transport_health_command, "zero://inline"));
}

test "raw Debug gateway isolation does not widen bundled renderer authority" {
    const raw_debug: Options = .{
        .bridge_profile = .production,
        .runtime_profile = .development,
    };
    try std.testing.expectEqual(
        BridgeProfile.development,
        resolvedRuntimeProfile(&raw_debug),
    );
    const renderer = bridgePolicy(raw_debug.bridge_profile);
    try std.testing.expect(renderer.allows(dispatch_command, "zero://app"));
    try std.testing.expect(!renderer.allows(
        dispatch_command,
        "http://127.0.0.1:5173",
    ));

    const inherited: Options = .{ .bridge_profile = .automation };
    try std.testing.expectEqual(
        BridgeProfile.automation,
        resolvedRuntimeProfile(&inherited),
    );
}

test "development reload is Debug and development profile only" {
    try std.testing.expect(developmentReloadAvailableForMode(
        .Debug,
        .development,
    ));
    try std.testing.expect(!developmentReloadAvailableForMode(
        .Debug,
        .production,
    ));
    try std.testing.expect(!developmentReloadAvailableForMode(
        .Debug,
        .automation,
    ));
    for ([_]std.builtin.OptimizeMode{
        .ReleaseSafe,
        .ReleaseFast,
        .ReleaseSmall,
    }) |mode| {
        try std.testing.expect(!developmentReloadAvailableForMode(
            mode,
            .development,
        ));
    }
    try std.testing.expectEqual(
        builtin.mode == .Debug,
        developmentReloadAvailable(.development),
    );
}

test "raw development rejects every native Keychain custody operation" {
    const runner = isolatedDevelopmentHarnessCustodyRunner();
    for ([_]HarnessCustodyHelperAction{
        .envelope_read,
        .envelope_set_if_absent,
        .envelope_delete,
        .marker_read,
        .marker_prepare,
        .marker_commit,
        .marker_delete,
    }) |action| {
        var output: HarnessCustodyHelperResult = .{
            .envelope_delete = true,
        };
        try std.testing.expect(!runner.run_fn(
            runner.context,
            "/Applications/HRA.app/Contents/Resources/runtime/bin/oprte-keychain-custodian",
            action,
            if (action == .envelope_set_if_absent) "secret" else null,
            1,
            &output,
        ));
        try std.testing.expectEqual(
            HarnessCustodyHelperResult{ .envelope_delete = true },
            output,
        );
    }
    runner.cancel_fn(runner.context);
}

test "development reload private decisions and public results are exact" {
    const candidate = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const accepted = try std.fmt.allocPrint(
        std.testing.allocator,
        "{{\"id\":\"reload-1\",\"ok\":true,\"result\":{{\"kind\":\"developmentReloadDecision\",\"version\":1,\"status\":\"accepted\",\"candidateId\":\"{s}\"}}}}",
        .{candidate},
    );
    defer std.testing.allocator.free(accepted);
    try std.testing.expectEqual(
        DevelopmentReloadDecision.accepted,
        try parseDevelopmentReloadDecision(
            std.testing.allocator,
            accepted,
            "reload-1",
            candidate,
        ),
    );

    const busy = try std.fmt.allocPrint(
        std.testing.allocator,
        "{{\"id\":\"reload-1\",\"ok\":true,\"result\":{{\"kind\":\"developmentReloadDecision\",\"version\":1,\"status\":\"busy\",\"candidateId\":\"{s}\"}}}}",
        .{candidate},
    );
    defer std.testing.allocator.free(busy);
    try std.testing.expectEqual(
        DevelopmentReloadDecision.busy,
        try parseDevelopmentReloadDecision(
            std.testing.allocator,
            busy,
            "reload-1",
            candidate,
        ),
    );

    const extra = try std.fmt.allocPrint(
        std.testing.allocator,
        "{{\"id\":\"reload-1\",\"ok\":true,\"result\":{{\"kind\":\"developmentReloadDecision\",\"version\":1,\"status\":\"accepted\",\"candidateId\":\"{s}\",\"extra\":true}}}}",
        .{candidate},
    );
    defer std.testing.allocator.free(extra);
    try std.testing.expectError(
        error.InvalidDevelopmentReloadDecision,
        parseDevelopmentReloadDecision(
            std.testing.allocator,
            extra,
            "reload-1",
            candidate,
        ),
    );
    try std.testing.expectError(
        error.InvalidDevelopmentReloadDecision,
        parseDevelopmentReloadDecision(
            std.testing.allocator,
            accepted,
            "reload-2",
            candidate,
        ),
    );

    const public_accepted = try encodeDevelopmentReloadResult(
        std.testing.allocator,
        null,
        "accepted",
        candidate,
        4,
        5,
    );
    defer std.testing.allocator.free(public_accepted);
    const expected_public_accepted = try std.fmt.allocPrint(
        std.testing.allocator,
        "{{\"version\":1,\"mode\":\"developmentReload\",\"status\":\"accepted\",\"candidateId\":\"{s}\",\"currentGeneration\":4,\"nextGeneration\":5}}",
        .{candidate},
    );
    defer std.testing.allocator.free(expected_public_accepted);
    try std.testing.expectEqualStrings(
        expected_public_accepted,
        public_accepted,
    );

    const public_busy = try encodeDevelopmentReloadResult(
        std.testing.allocator,
        null,
        "busy",
        candidate,
        4,
        null,
    );
    defer std.testing.allocator.free(public_busy);
    const expected_public_busy = try std.fmt.allocPrint(
        std.testing.allocator,
        "{{\"version\":1,\"mode\":\"developmentReload\",\"status\":\"busy\",\"candidateId\":\"{s}\",\"currentGeneration\":4,\"nextGeneration\":null}}",
        .{candidate},
    );
    defer std.testing.allocator.free(expected_public_busy);
    try std.testing.expectEqualStrings(expected_public_busy, public_busy);
}

test "development reload candidate custody never stages over the stable path" {
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const io = std.testing.io;
    const stable_name = "oprte-gateway-dev";
    const contents = "candidate gateway bytes";
    var digest_bytes: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(contents, &digest_bytes, .{});
    defer secureWipe(&digest_bytes);
    const candidate = std.fmt.bytesToHex(digest_bytes, .lower);
    const candidate_name = try std.fmt.allocPrint(
        std.testing.allocator,
        "{s}.candidate-{s}",
        .{ stable_name, &candidate },
    );
    defer std.testing.allocator.free(candidate_name);
    try temporary.dir.writeFile(io, .{
        .sub_path = stable_name,
        .data = "current gateway bytes",
    });
    try temporary.dir.writeFile(io, .{
        .sub_path = candidate_name,
        .data = contents,
    });
    var root_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const root_len = try temporary.dir.realPath(io, &root_buffer);
    const stable_path = try std.fs.path.join(
        std.testing.allocator,
        &.{ root_buffer[0..root_len], stable_name },
    );
    defer std.testing.allocator.free(stable_path);
    const expected_candidate_path = try developmentReloadCandidatePath(
        std.testing.allocator,
        stable_path,
        &candidate,
    );
    defer std.testing.allocator.free(expected_candidate_path);

    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = io,
        .parent_environment = &parent,
        .options = .{
            .paths = .{ .gateway_path = stable_path },
            .bridge_profile = .development,
        },
    };
    try std.testing.expect(host.developmentReloadStagedCandidateMatches(
        &candidate,
    ));
    const staged_path = try host.resolveDevelopmentReloadLaunchPath(
        &candidate,
    );
    defer std.testing.allocator.free(staged_path);
    try std.testing.expectEqualStrings(expected_candidate_path, staged_path);

    try temporary.dir.writeFile(io, .{
        .sub_path = stable_name,
        .data = contents,
    });
    try temporary.dir.writeFile(io, .{
        .sub_path = candidate_name,
        .data = "changed candidate bytes",
    });
    try std.testing.expect(!host.developmentReloadStagedCandidateMatches(
        &candidate,
    ));
    const acknowledged_path = try host.resolveDevelopmentReloadLaunchPath(
        &candidate,
    );
    defer std.testing.allocator.free(acknowledged_path);
    try std.testing.expectEqualStrings(stable_path, acknowledged_path);
}

test "development reload busy and crash cuts preserve generation authority" {
    const candidate = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const prior = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    const request = try std.testing.allocator.alloc(u8, 0);
    defer std.testing.allocator.free(request);
    var pending: Pending = .{
        .id = undefined,
        .id_len = 0,
        .destination = .native_removal_recovery,
        .request = request,
        .development_reload_candidate = undefined,
        .development_reload_candidate_len = candidate.len,
    };
    @memcpy(&pending.development_reload_candidate, candidate);

    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
        .state = .running,
        .generation = 7,
        .development_reload_sealed = true,
        .development_reload_candidate = undefined,
        .development_reload_candidate_len = candidate.len,
        .development_reload_desired_candidate = undefined,
        .development_reload_desired_candidate_len = prior.len,
    };
    @memcpy(&host.development_reload_candidate, candidate);
    @memcpy(&host.development_reload_desired_candidate, prior);

    try std.testing.expect(host.commitDevelopmentReloadDecision(&pending));
    try std.testing.expect(!host.development_reload_sealed);
    try std.testing.expectEqualStrings(
        prior,
        host.development_reload_desired_candidate[0..host.development_reload_desired_candidate_len],
    );

    // A transport fault after the reader queued accepted but before the UI
    // drained it must suppress that accepted response. Stable recovery cannot
    // be mistaken for the candidate generation.
    host.state = .recovering;
    host.development_reload_sealed = true;
    host.development_reload_candidate_len = candidate.len;
    @memcpy(&host.development_reload_candidate, candidate);
    pending.development_reload_accepted = true;
    try std.testing.expect(!host.commitDevelopmentReloadDecision(&pending));
    try std.testing.expect(!host.development_reload_accepted);
    try std.testing.expectEqualStrings(
        prior,
        host.development_reload_desired_candidate[0..host.development_reload_desired_candidate_len],
    );

    host.state = .running;
    host.development_reload_sealed = true;
    host.development_reload_candidate_len = candidate.len;
    @memcpy(&host.development_reload_candidate, candidate);
    try std.testing.expect(host.commitDevelopmentReloadDecision(&pending));
    try std.testing.expect(host.development_reload_accepted);
    try std.testing.expectEqual(@as(u64, 8), host.development_reload_target_generation);
    try std.testing.expectEqualStrings(
        candidate,
        host.development_reload_desired_candidate[0..host.development_reload_desired_candidate_len],
    );

    host.action_len = 1;
    try std.testing.expect(!host.scheduleDevelopmentReloadAfterEOF());
    try std.testing.expectEqual(State.running, host.state);
    host.action_len = 0;
    try std.testing.expect(host.scheduleDevelopmentReloadAfterEOF());
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expect(host.recovery_requested);
    try std.testing.expectEqual(GenerationShutdown.graceful, host.recovery_shutdown);
    try std.testing.expect(host.recovery_skips_backoff);
    try std.testing.expectEqual(@as(u64, 8), host.development_reload_target_generation);
}

test "transport recovery backoff is bounded and lifecycle envelopes are pathless" {
    try std.testing.expectEqual(@as(u16, 250), recoveryDelayMilliseconds(250, 1));
    try std.testing.expectEqual(@as(u16, 500), recoveryDelayMilliseconds(250, 2));
    try std.testing.expectEqual(@as(u16, 1_000), recoveryDelayMilliseconds(250, 3));
    try std.testing.expectEqual(@as(u16, 2_000), recoveryDelayMilliseconds(250, 4));
    try std.testing.expectEqual(@as(u16, 2_000), recoveryDelayMilliseconds(250, 32));

    const encoded = try encodeTransportLifecycle(
        std.testing.allocator,
        7,
        .{ .backing_off = .{
            .attempt = 2,
            .retry_at_unix_milliseconds = 1_800_000_000_000,
        } },
    );
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings(
        "{\"version\":1,\"state\":\"backingOff\",\"generation\":7,\"attempt\":2,\"retryAtUnixMilliseconds\":1800000000000}",
        encoded,
    );
    try std.testing.expect(std.mem.indexOf(u8, encoded, "/") == null);
}

test "transport lifecycle delivery is fenced by generation and host state" {
    try std.testing.expect(transportLifecycleIsCurrent(
        .running,
        8,
        8,
        .ready,
    ));
    try std.testing.expect(!transportLifecycleIsCurrent(
        .stopping,
        8,
        8,
        .ready,
    ));
    try std.testing.expect(!transportLifecycleIsCurrent(
        .recovering,
        9,
        8,
        .{ .backing_off = .{
            .attempt = 2,
            .retry_at_unix_milliseconds = 1,
        } },
    ));
    try std.testing.expect(transportLifecycleIsCurrent(
        .stopping,
        9,
        9,
        .stopping,
    ));
    try std.testing.expect(!transportLifecycleIsCurrent(
        .stopped,
        9,
        9,
        .stopping,
    ));
}

test "transport lifecycle actions retain dedicated recovery capacity" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    const empty = try std.testing.allocator.alloc(u8, 0);
    defer std.testing.allocator.free(empty);
    var pending: Pending = .{
        .id = undefined,
        .id_len = 0,
        .destination = .native_removal_recovery,
        .request = empty,
    };
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
    };

    for (0..max_actions - max_transport_lifecycle_actions) |_| {
        try std.testing.expect(host.pushActionLocked(.{
            .write_complete = &pending,
        }));
    }
    try std.testing.expect(!host.pushActionLocked(.{
        .write_complete = &pending,
    }));
    for (0..max_transport_lifecycle_actions) |_| {
        try std.testing.expect(host.pushActionLocked(.{
            .transport_lifecycle = empty,
        }));
    }
    try std.testing.expect(!host.pushActionLocked(.{
        .transport_lifecycle = empty,
    }));
    try std.testing.expectEqual(max_actions, host.action_len);
    while (host.popActionLocked() != null) {}
    try std.testing.expectEqual(@as(usize, 0), host.action_len);
    try std.testing.expectEqual(
        @as(usize, 0),
        host.queued_transport_lifecycles,
    );
}

test "renderer delivery failure retains exact protected bytes and queue capacity" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    const event_bytes = try std.testing.allocator.dupe(
        u8,
        "{\"version\":3,\"sequence\":1,\"event\":{\"type\":\"operation.completed\"}}",
    );
    const lifecycle_bytes = try std.testing.allocator.dupe(
        u8,
        "{\"version\":1,\"state\":\"ready\",\"generation\":2}",
    );
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
    };
    try std.testing.expect(host.pushActionLocked(.{ .event = .{
        .bytes = event_bytes,
        .sequence = 1,
        .recovery = .protected,
    } }));
    host.queued_events = 1;
    try std.testing.expect(host.pushActionLocked(.{
        .transport_lifecycle = lifecycle_bytes,
    }));

    const first = host.beginRendererDeliveryLocked().?;
    try std.testing.expectEqualStrings(event_bytes, first.event.bytes);
    const replacement = try std.testing.allocator.dupe(u8, "replacement");
    defer std.testing.allocator.free(replacement);
    try std.testing.expect(host.replaceNewestEventIfRecoverableLocked(.{
        .bytes = replacement,
        .sequence = 2,
        .recovery = .snapshot_recoverable,
    }) == null);
    try std.testing.expect(host.finishRendererDeliveryLocked(false) == null);
    try std.testing.expectEqual(@as(usize, 2), host.action_len);
    try std.testing.expectEqual(@as(usize, 1), host.queued_events);
    try std.testing.expectEqual(@as(u8, 1), host.renderer_delivery_retry_attempt);

    const retried = host.beginRendererDeliveryLocked().?;
    try std.testing.expectEqualStrings(event_bytes, retried.event.bytes);
    const delivered_event = host.finishRendererDeliveryLocked(true).?;
    try std.testing.expectEqualStrings(event_bytes, delivered_event.event.bytes);
    std.testing.allocator.free(delivered_event.event.bytes);
    try std.testing.expectEqual(@as(usize, 1), host.action_len);
    try std.testing.expectEqual(@as(usize, 0), host.queued_events);
    try std.testing.expectEqual(@as(u8, 0), host.renderer_delivery_retry_attempt);

    _ = host.beginRendererDeliveryLocked().?;
    try std.testing.expect(host.finishRendererDeliveryLocked(false) == null);
    const delivered_lifecycle = host.beginRendererDeliveryLocked().?;
    try std.testing.expectEqualStrings(
        lifecycle_bytes,
        delivered_lifecycle.transport_lifecycle,
    );
    const completed_lifecycle = host.finishRendererDeliveryLocked(true).?;
    std.testing.allocator.free(completed_lifecycle.transport_lifecycle);
    try std.testing.expectEqual(@as(usize, 0), host.action_len);
    try std.testing.expectEqual(@as(usize, 0), host.queued_transport_lifecycles);
}

test "renderer delivery retry uses bounded exponential backoff" {
    try std.testing.expectEqual(@as(u64, 25), rendererDeliveryRetryMilliseconds(1));
    try std.testing.expectEqual(@as(u64, 50), rendererDeliveryRetryMilliseconds(2));
    try std.testing.expectEqual(@as(u64, 1_000), rendererDeliveryRetryMilliseconds(255));
}

test "transport faults schedule once, exhaust, and never restart during terminal removal or stop" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{
            .account_profile_runner = probe.runner(),
            .max_recovery_attempts = 3,
        },
        .state = .running,
        .generation = 4,
    };

    host.transportFault("injected transport fault");
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expectEqual(@as(u8, 1), host.recovery_attempt);
    try std.testing.expect(host.recovery_requested);
    host.transportFault("duplicate old-generation fault");
    try std.testing.expectEqual(@as(u8, 1), host.recovery_attempt);

    host.beginStopping("test stop");
    host.beginStopping("repeated test stop");
    try std.testing.expectEqual(State.stopping, host.state);
    try std.testing.expect(!host.recovery_requested);

    host.state = .running;
    host.terminal_removal_committed = true;
    host.transportFault("fault after committed removal");
    try std.testing.expectEqual(State.failed, host.state);
    try std.testing.expect(!host.recovery_requested);
    try std.testing.expectEqual(
        TransportRetryStatus.unavailable,
        host.requestTransportRetry().status,
    );
}

test "repeated immediate gateway exits exhaust until a snapshot handshake succeeds" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{
            .account_profile_runner = probe.runner(),
            .max_recovery_attempts = 3,
        },
        .state = .running,
        .generation = 2,
        .recovery_attempt = 1,
    };

    host.transportFault("immediate exit 1");
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expectEqual(@as(u8, 2), host.recovery_attempt);
    host.state = .running;
    host.recovery_requested = false;
    host.generation += 1;

    host.transportFault("immediate exit 2");
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expectEqual(@as(u8, 3), host.recovery_attempt);
    host.state = .running;
    host.recovery_requested = false;
    host.generation += 1;

    host.transportFault("immediate exit 3");
    try std.testing.expectEqual(State.failed, host.state);
    try std.testing.expectEqual(@as(u8, 3), host.recovery_attempt);
    try std.testing.expect(!host.recovery_requested);

    host.state = .running;
    host.recovery_attempt = 2;
    try std.testing.expect(!host.recordGenerationHealthEvidence(host.generation - 1));
    try std.testing.expectEqual(@as(u8, 2), host.recovery_attempt);
    try std.testing.expect(host.recordGenerationHealthEvidence(host.generation));
    try std.testing.expectEqual(@as(u8, 0), host.recovery_attempt);
    host.transportFault("exit after healthy snapshot");
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expectEqual(@as(u8, 1), host.recovery_attempt);
}

test "explicit transport retry resets only an exhausted host and is idempotent" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
        .state = .failed,
        .generation = 9,
        .recovery_attempt = default_max_recovery_attempts,
    };
    const first = host.requestTransportRetry();
    try std.testing.expectEqual(TransportRetryStatus.accepted, first.status);
    try std.testing.expectEqual(@as(?u8, 1), first.scheduled_attempt);
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expectEqual(@as(u8, 1), host.recovery_attempt);
    const duplicate = host.requestTransportRetry();
    try std.testing.expectEqual(TransportRetryStatus.accepted, duplicate.status);
    try std.testing.expect(duplicate.scheduled_attempt == null);
    try std.testing.expectEqual(@as(u8, 1), host.recovery_attempt);
    host.state = .running;
    try std.testing.expectEqual(
        TransportRetryStatus.already_ready,
        host.requestTransportRetry().status,
    );
}

test "development reload seal rejects competing retry and health evidence" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
        .state = .running,
        .generation = 7,
        .recovery_attempt = 2,
        .development_reload_sealed = true,
    };

    const forced = host.requestTransportRetryMode(true);
    try std.testing.expectEqual(TransportRetryStatus.unavailable, forced.status);
    try std.testing.expectEqual(State.running, host.state);
    try std.testing.expectEqual(@as(u8, 2), host.recovery_attempt);
    try std.testing.expect(!host.recovery_requested);
    try std.testing.expect(!host.recordGenerationHealthEvidence(7));
    try std.testing.expectEqual(@as(u8, 2), host.recovery_attempt);

    host.development_reload_sealed = false;
    try std.testing.expect(host.recordGenerationHealthEvidence(7));
    try std.testing.expectEqual(@as(u8, 0), host.recovery_attempt);
}

test "forced transport retry fences one live-wedged generation without replay" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{
            .account_profile_runner = probe.runner(),
            .max_recovery_attempts = 3,
        },
        .state = .running,
        .generation = 7,
    };

    const forced = host.requestTransportRetryMode(true);
    try std.testing.expectEqual(TransportRetryStatus.accepted, forced.status);
    try std.testing.expect(forced.scheduled_attempt == null);
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expectEqual(@as(u8, 1), host.recovery_attempt);
    try std.testing.expect(host.recovery_requested);
    try std.testing.expectEqual(
        @as(usize, 1),
        probe.cancel_count.load(.acquire),
    );

    // A duplicate renderer timeout observes recovery but cannot advance its
    // budget or replay the ambiguous request.
    const duplicate = host.requestTransportRetryMode(true);
    try std.testing.expectEqual(TransportRetryStatus.accepted, duplicate.status);
    try std.testing.expectEqual(@as(u8, 1), host.recovery_attempt);
    try std.testing.expectEqual(
        @as(usize, 1),
        probe.cancel_count.load(.acquire),
    );

    while (host.popActionLocked()) |action| switch (action) {
        .transport_lifecycle => |bytes| std.testing.allocator.free(bytes),
        else => {},
    };
}

test "generation fencing reaps a retained stubborn group member after abrupt gateway exit" {
    if (comptime builtin.os.tag == .windows or builtin.os.tag == .wasi) return;

    var child = try std.process.spawn(std.testing.io, .{
        .argv = &.{ "/bin/sleep", "60" },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .pgid = 0,
    });
    var terminated = false;
    defer if (!terminated) {
        _ = RuntimeHost.terminateGatewayProcessTree(&child, std.testing.io);
    };

    const leader_process_id = child.id.?;
    try std.testing.expectEqual(
        leader_process_id,
        getpgid(leader_process_id),
    );

    // Keep the group member as a direct child of the test process. A shell-
    // spawned orphan becomes launchd's zombie after SIGKILL, making group
    // disappearance depend on unrelated runner load.
    var group_member = try std.process.spawn(std.testing.io, .{
        .argv = &.{
            "/bin/sh",
            "-c",
            "trap '' TERM; exec sleep 60",
        },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
        .pgid = leader_process_id,
    });
    defer if (group_member.id != null) group_member.kill(std.testing.io);
    const group_member_process_id = group_member.id.?;
    try std.testing.expectEqual(
        leader_process_id,
        getpgid(group_member_process_id),
    );
    const OwnedGroupMember = struct {
        child: *std.process.Child,
        termination: ?std.process.Child.Term = null,

        fn reap(context: ?*anyopaque, io: std.Io) bool {
            const self: *@This() = @ptrCast(@alignCast(
                context orelse return false,
            ));
            self.termination = self.child.wait(io) catch return false;
            return self.child.id == null;
        }
    };
    var owned_group_member: OwnedGroupMember = .{ .child = &group_member };

    // The gateway leader exits first while its owned group member remains.
    // Retaining the unreaped Child keeps the exact PID/PGID birth fenced until
    // terminateGatewayProcessTree has signalled the whole generation.
    try std.posix.kill(leader_process_id, .KILL);

    try std.testing.expect(
        RuntimeHost.terminateGatewayProcessTreeWithPollPreparation(
            &child,
            std.testing.io,
            .{
                .context = &owned_group_member,
                .run_fn = OwnedGroupMember.reap,
            },
        ),
    );
    terminated = true;
    try std.testing.expect(child.id == null);
    // The owned birth was reaped. A repeated cleanup is a no-op and therefore
    // cannot signal a later process that reuses the old numeric PID/PGID.
    try std.testing.expect(RuntimeHost.terminateGatewayProcessTree(
        &child,
        std.testing.io,
    ));
    try std.testing.expect(!processExistsForTest(leader_process_id));
    try std.testing.expect(group_member.id == null);
    try std.testing.expectEqual(
        std.process.Child.Term{ .signal = .KILL },
        owned_group_member.termination.?,
    );
    try std.testing.expect(!processExistsForTest(group_member_process_id));
}

test "removal recovery helper wait is bounded, exact, and single-owner" {
    if (comptime builtin.os.tag != .macos) return;

    var successful = try std.process.spawn(std.testing.io, .{
        .argv = &.{"/usr/bin/true"},
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    const successful_process_id = successful.id.?;
    try std.testing.expect(hra_macos_wait_removal_helper(
        successful_process_id,
        1_000,
    ));
    successful.id = null;
    try std.testing.expect(!hra_macos_wait_removal_helper(
        successful_process_id,
        25,
    ));

    var unsuccessful = try std.process.spawn(std.testing.io, .{
        .argv = &.{"/usr/bin/false"},
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    const unsuccessful_process_id = unsuccessful.id.?;
    try std.testing.expect(!hra_macos_wait_removal_helper(
        unsuccessful_process_id,
        1_000,
    ));
    unsuccessful.id = null;
    try std.testing.expect(!processExistsForTest(unsuccessful_process_id));

    var wedged = try std.process.spawn(std.testing.io, .{
        .argv = &.{ "/bin/sleep", "2" },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    const wedged_process_id = wedged.id.?;
    const started = std.Io.Clock.awake.now(std.testing.io);
    try std.testing.expect(!hra_macos_wait_removal_helper(
        wedged_process_id,
        25,
    ));
    const elapsed = started.untilNow(std.testing.io, .awake);
    wedged.id = null;
    try std.testing.expect(elapsed.toMilliseconds() < 1_000);
    try std.testing.expect(!processExistsForTest(wedged_process_id));
    // The timeout path already reaped its exact child. A repeated wait must
    // fail without signaling a later process that could reuse the numeric PID.
    try std.testing.expect(!hra_macos_wait_removal_helper(
        wedged_process_id,
        25,
    ));

    var invalid_timeout = try std.process.spawn(std.testing.io, .{
        .argv = &.{ "/bin/sleep", "2" },
        .stdin = .ignore,
        .stdout = .ignore,
        .stderr = .ignore,
    });
    const invalid_timeout_process_id = invalid_timeout.id.?;
    const invalid_timeout_started = std.Io.Clock.awake.now(std.testing.io);
    try std.testing.expect(!hra_macos_wait_removal_helper(
        invalid_timeout_process_id,
        0,
    ));
    const invalid_timeout_elapsed = invalid_timeout_started.untilNow(
        std.testing.io,
        .awake,
    );
    invalid_timeout.id = null;
    try std.testing.expect(invalid_timeout_elapsed.toMilliseconds() < 1_000);
    try std.testing.expect(!processExistsForTest(invalid_timeout_process_id));
    try std.testing.expect(!hra_macos_wait_removal_helper(
        invalid_timeout_process_id,
        25,
    ));
}

test "gateway group signal oracle rejects a foreign live group" {
    try std.testing.expect(gatewayGroupMatchesUnreapedChild(41, 41));
    try std.testing.expect(gatewayGroupMatchesUnreapedChild(41, -1));
    try std.testing.expect(!gatewayGroupMatchesUnreapedChild(41, 42));
}

fn processExistsForTest(process_id: std.posix.pid_t) bool {
    std.posix.kill(process_id, @enumFromInt(0)) catch |err| switch (err) {
        error.ProcessNotFound => return false,
        error.PermissionDenied => return true,
        error.Unexpected => return true,
    };
    return true;
}

test "ordinary initial launch failure enters bounded recovery while removal recovery stays fail closed" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var ordinary: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
        .state = .idle,
        .generation = 1,
    };
    try std.testing.expect(ordinary.scheduleInitialLaunchRecovery());
    try std.testing.expectEqual(State.recovering, ordinary.state);
    try std.testing.expectEqual(@as(u8, 1), ordinary.recovery_attempt);
    try std.testing.expect(ordinary.recovery_requested);

    var removal: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{ .startup_removal_recovery = true },
        .state = .idle,
        .generation = 1,
    };
    try std.testing.expect(!removal.scheduleInitialLaunchRecovery());
    try std.testing.expectEqual(State.idle, removal.state);
    try std.testing.expectEqual(@as(u8, 0), removal.recovery_attempt);
    try std.testing.expect(!removal.recovery_requested);
}

test "failed generation launch releases every staged process resource" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{ .paths = .{
            .gateway_path = "/tmp/oprte-missing-gateway-for-recovery-test",
        } },
        .state = .recovering,
        .generation = 2,
    };
    if (host.launchGeneration(false)) |_| {
        return error.ExpectedInjectedLaunchFailure;
    } else |_| {}
    try std.testing.expect(host.child == null);
    try std.testing.expect(host.reader_buffer == null);
    try std.testing.expect(host.writer_buffer == null);
    try std.testing.expect(host.data_remover_path == null);
    try std.testing.expectEqual(State.recovering, host.state);
}

test "native project onboarding encodes a bounded private request with escaped path bytes" {
    const path = "/tmp/quote\"-newline\n-café";
    const encoded = try encodeNativeProjectOnboardingRequest(std.testing.allocator, "native-onboarding-1", path);
    defer std.testing.allocator.free(encoded);

    try std.testing.expect(std.mem.indexOf(u8, encoded, "\"command\":\"hra.runtime.onboardProject\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, encoded, "\"trustedDirectoryPath\":\"/tmp/quote\\\"-newline\\n-café\"") != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, encoded, "\n"));

    var oversized: [max_trusted_directory_path_bytes + 1]u8 = undefined;
    @memset(&oversized, 'a');
    oversized[0] = '/';
    try std.testing.expectError(
        error.InvalidTrustedDirectoryPath,
        encodeNativeProjectOnboardingRequest(std.testing.allocator, "native-onboarding-2", &oversized),
    );
}

test "renderer project-add payload is pathless and version-bound" {
    try validateProjectAddRequest(std.testing.allocator, "{\"version\":3}");
    try std.testing.expectError(
        error.InvalidProjectAddRequest,
        validateProjectAddRequest(
            std.testing.allocator,
            "{\"version\":3,\"trustedDirectoryPath\":\"/not-allowed\"}",
        ),
    );
    try std.testing.expectError(
        error.InvalidProjectAddRequest,
        validateProjectAddRequest(std.testing.allocator, "{\"version\":1}"),
    );
}

test "native folder access encodes a private path and renderer payload stays pathless" {
    const path = "/tmp/Shared Documents";
    const encoded = try encodeNativeFolderAccessSelectRequest(
        std.testing.allocator,
        "native-folder-access-1",
        path,
    );
    defer std.testing.allocator.free(encoded);

    try std.testing.expect(std.mem.indexOf(
        u8,
        encoded,
        "\"command\":\"hra.runtime.selectFolderAccess\"",
    ) != null);
    try std.testing.expect(std.mem.indexOf(
        u8,
        encoded,
        "\"trustedDirectoryPath\":\"/tmp/Shared Documents\"",
    ) != null);
    try validateFolderAccessSelectRequest(
        std.testing.allocator,
        "{\"version\":3}",
    );
    try std.testing.expectError(
        error.InvalidFolderAccessSelectRequest,
        validateFolderAccessSelectRequest(
            std.testing.allocator,
            "{\"version\":3,\"trustedDirectoryPath\":\"/not-allowed\"}",
        ),
    );
}

test "request codec preserves payload JSON and terminates one JSONL record" {
    const encoded = try encodeRequest(std.testing.allocator, "bridge-42", snapshot_command, "{\"version\":3}");
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings(
        "{\"id\":\"bridge-42\",\"command\":\"hra.runtime.snapshot\",\"payload\":{\"version\":3}}\n",
        encoded,
    );
    try std.testing.expectError(error.InvalidJson, encodeRequest(std.testing.allocator, "bridge-42", snapshot_command, "{"));
    try std.testing.expectError(error.InvalidRequestId, encodeRequest(std.testing.allocator, "bad\\id", dispatch_command, "null"));
}

test "startup recovery request is private, exact, and pathless" {
    const capability = "ab" ** removal_deletion_capability_bytes;
    const encoded = try encodeStartupRemovalRecoveryRequest(
        std.testing.allocator,
        capability,
    );
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualStrings(
        "{\"id\":\"native-removal-recovery-1\"," ++
            "\"command\":\"hra.runtime.recoverLocalDataRemoval\"," ++
            "\"payload\":{\"version\":1," ++
            "\"nativeRecoveryPrepared\":true}," ++
            "\"nativeRemovalCapability\":\"" ++ capability ++ "\"}\n",
        encoded,
    );
    try std.testing.expect(
        std.mem.indexOf(u8, encoded, "/Users/") == null,
    );
}

test "removal launch envelope is strict and preserves private paths only internally" {
    const correlation = testingRemovalCorrelation(
        "op_example01",
        "removal_example01",
    );
    const launch = (try parseRemovalLaunchEnvelope(
        std.testing.allocator,
        testing_removal_launch,
        "removal-request-1",
        &correlation,
        4242,
    )).?;
    try std.testing.expectEqualStrings(
        "/Users/test/Library/Application Support/OPRTE Removal/requests/op_example01.json",
        launch.requestPath(),
    );
    try std.testing.expectEqualStrings(
        correlation.operationId(),
        launch.correlation.operationId(),
    );

    const wrong_correlation = testingRemovalCorrelation(
        "op_different1",
        "removal_example01",
    );
    try std.testing.expectError(
        error.InvalidRemovalLaunchEnvelope,
        parseRemovalLaunchEnvelope(
            std.testing.allocator,
            testing_removal_launch,
            "removal-request-1",
            &wrong_correlation,
            4242,
        ),
    );
    const extra_field =
        "{\"id\":\"removal-request-1\",\"ok\":true,\"result\":{" ++
        "\"kind\":\"localDataRemovalNativeLaunch\",\"version\":1," ++
        "\"operationId\":\"op_example01\",\"previewId\":\"removal_example01\"," ++
        "\"parentProcessId\":4242," ++
        "\"requestPath\":\"/Users/test/Library/Application Support/OPRTE Removal/requests/op_example01.json\"," ++
        "\"signingKeyPath\":\"/Users/test/Library/Application Support/OPRTE Removal/removal-signing.key\"," ++
        "\"publicResponse\":{\"version\":3,\"operationId\":\"op_example01\"," ++
        "\"ok\":true,\"result\":{\"type\":\"localDataRemovalScheduled\"," ++
        "\"previewId\":\"removal_example01\",\"state\":\"scheduled\"," ++
        "\"willQuitApplication\":true}},\"extra\":true}}";
    try std.testing.expectError(
        error.InvalidRemovalLaunchEnvelope,
        parseRemovalLaunchEnvelope(
            std.testing.allocator,
            extra_field,
            "removal-request-1",
            &correlation,
            4242,
        ),
    );

    const public = try encodePublicRemovalResponse(
        std.testing.allocator,
        "removal-request-1",
        &correlation,
    );
    defer std.testing.allocator.free(public);
    try std.testing.expect(
        std.mem.indexOf(u8, public, launch.requestPath()) == null,
    );
    try std.testing.expect(
        std.mem.indexOf(u8, public, launch.signingKeyPath()) == null,
    );
}

test "path-bearing removal failures are replaced by a fixed public failure" {
    const correlation = testingRemovalCorrelation(
        "op_example01",
        "removal_example01",
    );
    const private_path =
        "/Users/test/Library/Application Support/OPRTE Removal/requests/op_example01.json";
    const private_failure =
        "{\"id\":\"removal-request-1\",\"ok\":true,\"result\":{" ++
        "\"version\":3,\"operationId\":\"op_example01\",\"ok\":false," ++
        "\"error\":{\"code\":\"operation_failed\",\"message\":\"" ++
        private_path ++
        "\",\"retryable\":false,\"action\":\"none\"}}}";
    try std.testing.expect(validatePublicRemovalFailure(
        std.testing.allocator,
        private_failure,
        "removal-request-1",
        &correlation,
    ));
    const public_failure = try encodePublicRemovalFailure(
        std.testing.allocator,
        "removal-request-1",
        &correlation,
    );
    defer std.testing.allocator.free(public_failure);
    try std.testing.expect(
        std.mem.indexOf(u8, public_failure, private_path) == null,
    );
    try std.testing.expect(
        std.mem.indexOf(
            u8,
            public_failure,
            "HRA could not remove local data.",
        ) != null,
    );
}

test "startup recovery result and launch alternatives are exact" {
    try std.testing.expectEqual(
        RemovalRecoveryState.clear,
        (try parseRemovalRecoveryResult(
            std.testing.allocator,
            "{\"id\":\"native-removal-recovery-1\",\"ok\":true," ++
                "\"result\":{\"kind\":\"localDataRemovalRecoveryResult\"," ++
                "\"version\":1,\"state\":\"clear\",\"recoveredOperationCount\":2}}",
            private_removal_recovery_id,
        )).?,
    );
    try std.testing.expectEqual(
        RemovalRecoveryState.active,
        (try parseRemovalRecoveryResult(
            std.testing.allocator,
            "{\"id\":\"native-removal-recovery-1\",\"ok\":true," ++
                "\"result\":{\"kind\":\"localDataRemovalRecoveryResult\"," ++
                "\"version\":1,\"state\":\"active\",\"recoveredOperationCount\":0}}",
            private_removal_recovery_id,
        )).?,
    );
    try std.testing.expect(
        try parseRemovalRecoveryResult(
            std.testing.allocator,
            testing_removal_launch,
            "removal-request-1",
        ) == null,
    );
    try std.testing.expectError(
        error.InvalidRemovalRecoveryResult,
        parseRemovalRecoveryResult(
            std.testing.allocator,
            "{\"id\":\"native-removal-recovery-1\",\"ok\":true," ++
                "\"result\":{\"kind\":\"localDataRemovalRecoveryResult\"," ++
                "\"version\":1,\"state\":\"clear\",\"recoveredOperationCount\":0," ++
                "\"privatePath\":\"/Users/test\"}}",
            private_removal_recovery_id,
        ),
    );
    const recovery_launch = (try parseRemovalLaunchEnvelope(
        std.testing.allocator,
        testing_removal_launch,
        "removal-request-1",
        null,
        4242,
    )).?;
    try std.testing.expectEqualStrings(
        "op_example01",
        recovery_launch.correlation.operationId(),
    );
}

test "termination-required envelope is strict and contains only a public response" {
    const correlation = testingRemovalCorrelation(
        "op_example01",
        "removal_example01",
    );
    const exact =
        "{\"id\":\"removal-request-1\",\"ok\":true,\"result\":{" ++
        "\"kind\":\"localDataRemovalNativeTerminationRequired\"," ++
        "\"version\":1,\"publicResponse\":{\"version\":3," ++
        "\"operationId\":\"op_example01\",\"ok\":false,\"error\":{" ++
        "\"code\":\"operation_failed\",\"message\":\"private detail\"," ++
        "\"retryable\":false,\"action\":\"none\"}}}}";
    const required = (try parseRemovalTerminationRequired(
        std.testing.allocator,
        exact,
        "removal-request-1",
        &correlation,
    )).?;
    try std.testing.expectEqualStrings(
        correlation.operationId(),
        required.correlation.operationId(),
    );

    const scheduled =
        "{\"id\":\"removal-request-1\",\"ok\":true,\"result\":{" ++
        "\"kind\":\"localDataRemovalNativeTerminationRequired\"," ++
        "\"version\":1,\"publicResponse\":{\"version\":3," ++
        "\"operationId\":\"op_example01\",\"ok\":true,\"result\":{" ++
        "\"type\":\"localDataRemovalScheduled\"," ++
        "\"previewId\":\"removal_example01\",\"state\":\"scheduled\"," ++
        "\"willQuitApplication\":true}}}}";
    try std.testing.expectError(
        error.InvalidRemovalTerminationRequired,
        parseRemovalTerminationRequired(
            std.testing.allocator,
            scheduled,
            "removal-request-1",
            &correlation,
        ),
    );

    const extra =
        "{\"id\":\"removal-request-1\",\"ok\":true,\"result\":{" ++
        "\"kind\":\"localDataRemovalNativeTerminationRequired\"," ++
        "\"version\":1,\"publicResponse\":{\"version\":3," ++
        "\"operationId\":\"op_example01\",\"ok\":false,\"error\":{" ++
        "\"code\":\"operation_failed\",\"message\":\"failure\"," ++
        "\"retryable\":false,\"action\":\"none\"}},\"extra\":true}}";
    try std.testing.expectError(
        error.InvalidRemovalTerminationRequired,
        parseRemovalTerminationRequired(
            std.testing.allocator,
            extra,
            "removal-request-1",
            &correlation,
        ),
    );
}

test "READY channel rejects EOF, malformed bytes, and timeout" {
    var good: [2]std.c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), std.c.pipe(&good));
    defer _ = std.c.close(good[0]);
    try std.testing.expectEqual(
        @as(isize, removal_ready_message.len),
        std.c.write(
            good[1],
            removal_ready_message.ptr,
            removal_ready_message.len,
        ),
    );
    _ = std.c.close(good[1]);
    try waitForRemovalReady(std.testing.io, good[0], 100);

    var eof_pipe: [2]std.c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), std.c.pipe(&eof_pipe));
    defer _ = std.c.close(eof_pipe[0]);
    _ = std.c.close(eof_pipe[1]);
    try std.testing.expectError(
        error.MalformedRemovalReady,
        waitForRemovalReady(std.testing.io, eof_pipe[0], 100),
    );

    var malformed: [2]std.c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), std.c.pipe(&malformed));
    defer _ = std.c.close(malformed[0]);
    _ = std.c.write(malformed[1], "NO".ptr, 2);
    _ = std.c.close(malformed[1]);
    try std.testing.expectError(
        error.MalformedRemovalReady,
        waitForRemovalReady(std.testing.io, malformed[0], 100),
    );

    var timeout_pipe: [2]std.c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), std.c.pipe(&timeout_pipe));
    defer _ = std.c.close(timeout_pipe[0]);
    defer _ = std.c.close(timeout_pipe[1]);
    try std.testing.expectError(
        error.RemovalReadyTimeout,
        waitForRemovalReady(std.testing.io, timeout_pipe[0], 5),
    );
}

test "attested removal child is reaped on every pre-READY failure" {
    var probe = RemovalChildReaperProbe{};

    var malformed: [2]std.c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), std.c.pipe(&malformed));
    defer _ = std.c.close(malformed[0]);
    _ = std.c.write(malformed[1], "NO".ptr, 2);
    _ = std.c.close(malformed[1]);
    try std.testing.expectError(
        error.MalformedRemovalReady,
        waitForRemovalReadyAfterAttestedResume(
            std.testing.io,
            .{ .process_id = 1977 },
            malformed[0],
            100,
            &probe,
            RemovalChildReaperProbe.reap,
        ),
    );
    try std.testing.expectEqual(@as(usize, 1), probe.reap_count);
    try std.testing.expectEqual(@as(c_int, 1977), probe.last_process_id);

    var ready: [2]std.c.fd_t = undefined;
    try std.testing.expectEqual(@as(c_int, 0), std.c.pipe(&ready));
    defer _ = std.c.close(ready[0]);
    try std.testing.expectEqual(
        @as(isize, removal_ready_message.len),
        std.c.write(
            ready[1],
            removal_ready_message.ptr,
            removal_ready_message.len,
        ),
    );
    _ = std.c.close(ready[1]);
    try waitForRemovalReadyAfterAttestedResume(
        std.testing.io,
        .{ .process_id = 1981 },
        ready[0],
        100,
        &probe,
        RemovalChildReaperProbe.reap,
    );
    try std.testing.expectEqual(@as(usize, 1), probe.reap_count);
}

test "removal lifecycle never quits before READY and cannot strand after READY" {
    var probe = RemovalLifecycleProbe{ .prepare_allowed = false };
    const lifecycle = probe.lifecycle();
    try std.testing.expectError(
        error.RemovalHelperPreparationFailed,
        prepareRemovalHelper(lifecycle, "/trusted/helper", .requested),
    );
    try std.testing.expectEqual(@as(usize, 0), probe.spawn_count);
    try std.testing.expectEqual(@as(usize, 0), probe.terminate_count);

    probe.prepare_allowed = true;
    probe.spawn_fails = true;
    try prepareRemovalHelper(
        lifecycle,
        "/trusted/helper",
        .startup_recovery,
    );
    try std.testing.expectEqual(
        RemovalPreparation.startup_recovery,
        probe.last_mode.?,
    );
    probe.recovery_fails = true;
    try std.testing.expectError(
        error.RecoveryFailed,
        recoverStagedRemovalHelper(
            lifecycle,
            std.testing.allocator,
            std.testing.io,
            "/trusted/helper",
            "/Users/test/Library/Application Support/OPRTE Removal",
        ),
    );
    try std.testing.expectEqual(@as(usize, 1), probe.recovery_count);
    try std.testing.expect(!probe.recovery_without_exclusion);
    try std.testing.expectEqual(@as(usize, 0), probe.spawn_count);
    try std.testing.expectEqual(@as(usize, 0), probe.terminate_count);
    probe.recovery_fails = false;
    try recoverStagedRemovalHelper(
        lifecycle,
        std.testing.allocator,
        std.testing.io,
        "/trusted/helper",
        "/Users/test/Library/Application Support/OPRTE Removal",
    );
    try std.testing.expectEqual(@as(usize, 2), probe.recovery_count);
    try std.testing.expect(!probe.recovery_without_exclusion);
    try std.testing.expectError(
        error.HandshakeFailed,
        spawnReadyRemovalHelper(
            lifecycle,
            std.testing.allocator,
            std.testing.io,
            "/trusted/helper",
            "/private/request",
            "/private/key",
            4242,
        ),
    );
    try std.testing.expectEqual(@as(usize, 0), probe.terminate_count);
    try std.testing.expect(!probe.spawn_without_exclusion);

    probe.spawn_fails = false;
    try spawnReadyRemovalHelper(
        lifecycle,
        std.testing.allocator,
        std.testing.io,
        "/trusted/helper",
        "/private/request",
        "/private/key",
        4242,
    );
    armTerminationAfterReady(lifecycle);
    try std.testing.expectEqual(@as(usize, 1), probe.watchdog_count);
    try std.testing.expectEqual(@as(usize, 0), probe.terminate_count);
    terminateIfRemovalDeliveryFailed(lifecycle, true);
    try std.testing.expectEqual(@as(usize, 0), probe.terminate_count);
    terminateIfRemovalDeliveryFailed(lifecycle, false);
    try std.testing.expectEqual(@as(usize, 1), probe.terminate_count);

    probe.watchdog_arms = false;
    armTerminationAfterReady(lifecycle);
    try std.testing.expectEqual(@as(usize, 2), probe.terminate_count);
    rollbackRemovalHelper(lifecycle);
    try std.testing.expectEqual(@as(usize, 1), probe.rollback_count);
    try std.testing.expect(!probe.exclusion_held);
}

test "ordinary pre-quiesce rejection is the only rollback boundary" {
    var probe = RemovalLifecycleProbe{};
    const lifecycle = probe.lifecycle();
    try prepareRemovalHelper(lifecycle, "/trusted/helper", .requested);
    try std.testing.expect(probe.exclusion_held);
    rollbackRemovalHelper(lifecycle);
    try std.testing.expectEqual(@as(usize, 1), probe.rollback_count);
    try std.testing.expect(!probe.exclusion_held);

    try prepareRemovalHelper(
        lifecycle,
        "/trusted/helper",
        .startup_recovery,
    );
    try recoverStagedRemovalHelper(
        lifecycle,
        std.testing.allocator,
        std.testing.io,
        "/trusted/helper",
        "/Users/test/Library/Application Support/OPRTE Removal",
    );
    try std.testing.expect(probe.exclusion_held);
    try std.testing.expectEqual(@as(usize, 1), probe.rollback_count);
    try std.testing.expect(!probe.recovery_without_exclusion);
}

test "pathless startup recovery completion terminates without a renderer destination" {
    var probe = RemovalLifecycleProbe{};
    const lifecycle = probe.lifecycle();
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{
            .removal_lifecycle = lifecycle,
            .startup_removal_recovery = true,
        },
        .state = .running,
    };
    var pending: Pending = .{
        .id = undefined,
        .id_len = private_removal_recovery_id.len,
        .destination = .native_removal_recovery,
        .request = try std.testing.allocator.dupe(
            u8,
            "private recovery request",
        ),
        .writer_done = true,
    };
    defer secureWipeAndFree(std.testing.allocator, pending.request);
    @memcpy(
        pending.id[0..pending.id_len],
        private_removal_recovery_id,
    );
    const line =
        "{\"id\":\"native-removal-recovery-1\",\"ok\":true," ++
        "\"result\":{\"kind\":\"localDataRemovalRecoveryResult\"," ++
        "\"version\":1,\"state\":\"clear\",\"recoveredOperationCount\":1}}";
    const bytes = try std.testing.allocator.dupe(u8, line);
    try std.testing.expect(host.handleStartupRemovalRecoveryResponse(
        &pending,
        line,
        bytes,
    ));
    try std.testing.expectEqual(@as(usize, 1), probe.watchdog_count);
    // No PlatformServices are installed in this deterministic fixture, so
    // the failed wake must request termination immediately.
    try std.testing.expectEqual(@as(usize, 1), probe.terminate_count);
    const action = host.popActionLocked() orelse
        return error.ExpectedPrivateRecoveryAction;
    switch (action) {
        .response => |response| {
            defer std.testing.allocator.free(response.bytes);
            try std.testing.expect(
                response.pending.destination ==
                    .native_removal_recovery,
            );
            try std.testing.expect(
                std.mem.indexOf(u8, response.bytes, "/Users/") == null,
            );
        },
        else => return error.UnexpectedPrivateRecoveryAction,
    }
}

test "post-quiesce public failure is forwarded and irrevocably terminates" {
    var probe = RemovalLifecycleProbe{};
    const lifecycle = probe.lifecycle();
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{
            .removal_lifecycle = lifecycle,
            .startup_removal_recovery = true,
        },
        .state = .running,
    };
    var pending: Pending = .{
        .id = undefined,
        .id_len = private_removal_recovery_id.len,
        .destination = .native_removal_recovery,
        .request = try std.testing.allocator.dupe(
            u8,
            "private recovery request",
        ),
        .writer_done = true,
    };
    defer secureWipeAndFree(std.testing.allocator, pending.request);
    @memcpy(
        pending.id[0..pending.id_len],
        private_removal_recovery_id,
    );
    const public_message =
        "HRA local data changed. Create a fresh preview.";
    const line =
        "{\"id\":\"native-removal-recovery-1\",\"ok\":true,\"result\":{" ++
        "\"kind\":\"localDataRemovalNativeTerminationRequired\"," ++
        "\"version\":1,\"publicResponse\":{\"version\":3," ++
        "\"operationId\":\"op_example01\",\"ok\":false,\"error\":{" ++
        "\"code\":\"conflict\",\"message\":\"" ++ public_message ++
        "\",\"retryable\":true,\"action\":\"retry\"}}}}";
    const required = (try parseRemovalTerminationRequired(
        std.testing.allocator,
        line,
        private_removal_recovery_id,
        null,
    )).?;
    const bytes = try std.testing.allocator.dupe(u8, line);
    try std.testing.expect(host.handleRemovalTerminationRequired(
        &pending,
        bytes,
        required,
    ));
    try std.testing.expectEqual(@as(usize, 1), probe.watchdog_count);
    // No PlatformServices are installed, so a failed delivery wake requests
    // immediate graceful termination in addition to the forced watchdog.
    try std.testing.expectEqual(@as(usize, 1), probe.terminate_count);
    const action = host.popActionLocked() orelse
        return error.ExpectedTerminationResponse;
    switch (action) {
        .response => |response| {
            defer std.testing.allocator.free(response.bytes);
            try std.testing.expect(
                std.mem.indexOf(u8, response.bytes, public_message) != null,
            );
            try std.testing.expect(
                std.mem.indexOf(
                    u8,
                    response.bytes,
                    local_data_removal_termination_required_kind,
                ) == null,
            );
            try std.testing.expect(
                std.mem.indexOf(
                    u8,
                    response.bytes,
                    "\"code\":\"conflict\"",
                ) != null,
            );
            try std.testing.expect(
                std.mem.indexOf(
                    u8,
                    response.bytes,
                    "\"retryable\":true,\"action\":\"retry\"",
                ) != null,
            );
        },
        else => return error.ExpectedTerminationResponse,
    }
}

test "account profile Native requests and acknowledgements are exact" {
    const ensure = try parseAccountProfileNativeRequest(
        std.testing.allocator,
        testing_account_profile_ensure_request,
    );
    try std.testing.expectEqual(AccountProfileAction.ensure, ensure.action);
    try std.testing.expectEqualStrings(
        "acct_fixture01",
        ensure.accountProfileId(),
    );
    try std.testing.expect(ensure.deletionNonce() == null);

    const delete = try parseAccountProfileNativeRequest(
        std.testing.allocator,
        testing_account_profile_delete_request,
    );
    try std.testing.expectEqual(AccountProfileAction.delete, delete.action);
    try std.testing.expectEqual(@as(u64, 7), delete.expected_revision);
    try std.testing.expectEqualStrings(
        "deletion_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        delete.deletionNonce().?,
    );
    const encoded = try encodeAccountProfileNativeResultRequest(
        std.testing.allocator,
        &delete,
        true,
    );
    defer std.testing.allocator.free(encoded);
    try std.testing.expect(
        std.mem.indexOf(
            u8,
            encoded,
            private_account_profile_result_command,
        ) != null,
    );
    try std.testing.expect(
        std.mem.indexOf(
            u8,
            encoded,
            "\"expectedRevision\"",
        ) == null,
    );

    const classified = try classifyLine(
        std.testing.allocator,
        testing_account_profile_ensure_request,
    );
    try std.testing.expect(classified == .account_profile_request);
    try std.testing.expect(
        validateAccountProfileNativeResultAcknowledgement(
            std.testing.allocator,
            "{\"id\":\"native-profile-0123456789abcdef01234567\",\"ok\":true,\"result\":{\"kind\":\"accountProfileNativeResultAccepted\",\"version\":1,\"accepted\":true}}",
            "native-profile-0123456789abcdef01234567",
        ),
    );
    try std.testing.expect(
        !validateAccountProfileNativeResultAcknowledgement(
            std.testing.allocator,
            "{\"id\":\"native-profile-0123456789abcdef01234567\",\"ok\":true,\"result\":{\"kind\":\"accountProfileNativeResultAccepted\",\"version\":1,\"accepted\":true,\"extra\":1}}",
            "native-profile-0123456789abcdef01234567",
        ),
    );

    const extra =
        testing_account_profile_ensure_request[0 .. testing_account_profile_ensure_request.len - 2] ++ ",\"extra\":true}}";
    try std.testing.expectError(
        error.InvalidAccountProfileNativeRequest,
        parseAccountProfileNativeRequest(
            std.testing.allocator,
            extra,
        ),
    );
}

test "account profile worker never launches a request queued before stop" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{ .account_profile_runner = probe.runner() },
        .state = .running,
        .data_remover_path = try std.testing.allocator.dupe(
            u8,
            "/trusted/helper",
        ),
    };
    defer std.testing.allocator.free(host.data_remover_path.?);
    try std.testing.expect(host.handleAccountProfileNativeRequest(
        testing_account_profile_ensure_request,
    ));
    host.beginStopping("test stop");
    const worker = try std.Thread.spawn(
        .{},
        RuntimeHost.accountProfileMain,
        .{&host},
    );
    worker.join();
    try std.testing.expectEqual(
        @as(usize, 0),
        probe.run_count.load(.acquire),
    );
    try std.testing.expect(host.account_profile_request == null);
    try std.testing.expect(!host.account_profile_busy);
}

test "accepted account profile operation reserves its completion capacity" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{ .account_profile_runner = probe.runner() },
        .state = .running,
    };
    try std.testing.expect(host.handleAccountProfileNativeRequest(
        testing_account_profile_ensure_request,
    ));
    try std.testing.expect(host.account_profile_result_reserved);
    try std.testing.expect(host.accountProfileReservationMatchesLocked(
        "native-profile-0123456789abcdef01234567",
    ));
    host.pending_count = max_pending_requests - 1;
    host.request_len = max_pending_requests - 1;
    try std.testing.expect(!host.resultCapacityAvailableLocked());
    // The reserved slot is not available to unrelated bridge traffic even
    // while the helper runs outside the reader thread.
    host.pending_count = 0;
    host.request_len = 0;
    host.clearAccountProfileReservationLocked();
    host.account_profile_request = null;
    host.account_profile_busy = false;
}

test "sixty-four pane mutations retain bounded snapshot recovery capacity" {
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
        .state = .running,
    };
    host.pending_count = max_renderer_mutation_requests;
    host.request_len = max_renderer_mutation_requests;
    try std.testing.expect(!host.rendererRequestCapacityAvailableLocked(
        dispatch_command,
    ));
    try std.testing.expect(host.rendererRequestCapacityAvailableLocked(
        snapshot_command,
    ));
    try std.testing.expectEqual(
        @as(usize, 8),
        max_pending_requests - host.pending_count,
    );
}

test "accepted account profile operation reserves its correlation id" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{ .account_profile_runner = probe.runner() },
        .state = .running,
    };
    try std.testing.expect(host.handleAccountProfileNativeRequest(
        testing_account_profile_ensure_request,
    ));
    try std.testing.expectError(
        error.DuplicateNativeRequestId,
        host.enqueueNativeProjectOnboarding(
            "native-profile-0123456789abcdef01234567",
            "/trusted/repository",
            .native_removal_recovery,
        ),
    );
    host.clearAccountProfileReservationLocked();
    host.account_profile_request = null;
    host.account_profile_busy = false;
}

test "account profile worker allocates completion before launching helper" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{ .account_profile_runner = probe.runner() },
        .state = .running,
    };
    try std.testing.expect(host.handleAccountProfileNativeRequest(
        testing_account_profile_ensure_request,
    ));

    var allocation_storage: [1]u8 = undefined;
    var failing_allocator =
        std.heap.FixedBufferAllocator.init(&allocation_storage);
    host.allocator = failing_allocator.allocator();
    host.accountProfileMain();

    try std.testing.expectEqual(
        @as(usize, 0),
        probe.run_count.load(.acquire),
    );
    try std.testing.expectEqual(State.recovering, host.state);
    try std.testing.expect(!host.account_profile_busy);
    try std.testing.expect(!host.account_profile_result_reserved);
    try std.testing.expectEqual(
        @as(usize, 0),
        host.account_profile_reserved_id_len,
    );
}

test "account profile worker cancellation promptly releases shutdown" {
    var probe = AccountProfileRunnerProbe{};
    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{ .account_profile_runner = probe.runner() },
        .state = .running,
        .data_remover_path = try std.testing.allocator.dupe(
            u8,
            "/trusted/helper",
        ),
    };
    defer std.testing.allocator.free(host.data_remover_path.?);
    const worker = try std.Thread.spawn(
        .{},
        RuntimeHost.accountProfileMain,
        .{&host},
    );
    try std.testing.expect(host.handleAccountProfileNativeRequest(
        testing_account_profile_ensure_request,
    ));
    var attempts: usize = 0;
    while (!probe.started.load(.acquire) and attempts < 1000) : (attempts += 1) {
        std.Io.sleep(
            std.testing.io,
            .fromMilliseconds(1),
            .awake,
        ) catch {};
    }
    try std.testing.expect(probe.started.load(.acquire));
    host.beginStopping("test stop");
    const runner = host.options.account_profile_runner.?;
    runner.cancel_fn(runner.context);
    worker.join();
    try std.testing.expect(probe.cancelled.load(.acquire));
    try std.testing.expect(host.account_profile_finished.load(.acquire));
}

test "gateway codec separates complete responses from renderer events" {
    const response = try classifyLine(std.testing.allocator, "{\"id\":\"bridge-42\",\"ok\":true,\"result\":{\"status\":\"ok\"}}");
    try std.testing.expect(response == .response);
    try std.testing.expectEqualStrings("bridge-42", response.response.id[0..response.response.id_len]);
    try std.testing.expect(response.response.ok);

    const event = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"runtime.changed\"},\"sequence\":3}");
    try std.testing.expect(event == .event);
    try std.testing.expectEqual(@as(u64, 3), event.event.sequence);
    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, event.event.recovery);

    const runner = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"runner.changed\"},\"sequence\":4}");
    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, runner.event.recovery);

    const retained_data = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"accountLocalData.upserted\"},\"sequence\":4}");
    try std.testing.expectEqual(@as(u64, 4), retained_data.event.sequence);
    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, retained_data.event.recovery);
    const removed_data = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"accountLocalData.removed\"},\"sequence\":5}");
    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, removed_data.event.recovery);
    const human_account = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"humanAccount.changed\"},\"sequence\":6}");
    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, human_account.event.recovery);
    const task_invalidation = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"task.invalidated\",\"invalidation\":{\"workspaceId\":\"wsp_00000000000000000000000000\",\"projectionRevision\":9,\"scope\":\"workspace\"}},\"sequence\":6}");
    try std.testing.expectEqual(EventRecovery.protected, task_invalidation.event.recovery);
    const terminal = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"operation.completed\"},\"sequence\":8}");
    const chat_delta = try classifyLine(std.testing.allocator, "{\"version\":3,\"event\":{\"type\":\"chat.turn.delta\"},\"sequence\":9}");
    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, chat_delta.event.recovery);
    try std.testing.expectError(error.InvalidGatewayLine, classifyLine(
        std.testing.allocator,
        "{\"version\":2,\"event\":{\"type\":\"runtime.changed\"},\"sequence\":9}",
    ));
    try std.testing.expectError(error.InvalidGatewayLine, classifyLine(
        std.testing.allocator,
        "{\"version\":3,\"event\":{\"type\":\"runtime.changed\"},\"sequence\":9,\"extra\":true}",
    ));
    try std.testing.expect(terminal == .event);
    try std.testing.expectEqual(EventRecovery.protected, terminal.event.recovery);
    try std.testing.expectError(error.InvalidGatewayLine, classifyLine(std.testing.allocator, "{\"id\":\"bridge-42\",\"ok\":true}"));
    try std.testing.expectError(error.InvalidGatewayLine, classifyLine(std.testing.allocator, "{\"event\":{\"type\":\"run.output\"},\"sequence\":-1}"));
    try std.testing.expectError(error.InvalidGatewayLine, classifyLine(std.testing.allocator, "{\"event\":{\"type\":\"future.unknown\"},\"sequence\":5}"));
    for ([_][]const u8{
        "project.upserted",
        "workspace.upserted",
        "thread.upserted",
        "item.upserted",
        "item.delta",
        "interaction.upserted",
        "compatibility.faulted",
    }) |event_type| {
        const private_event = try std.fmt.allocPrint(
            std.testing.allocator,
            "{{\"version\":3,\"event\":{{\"type\":\"{s}\"}},\"sequence\":5}}",
            .{event_type},
        );
        defer std.testing.allocator.free(private_event);
        try std.testing.expectError(
            error.InvalidGatewayLine,
            classifyLine(std.testing.allocator, private_event),
        );
    }
    try std.testing.expectError(error.InvalidGatewayLine, classifyLine(std.testing.allocator, "not-json"));
}

test "projection overflow marker follows protocol v3 and the native event limit" {
    const encoded = try encodeProjectionOverflowEvent(std.testing.allocator, 129);
    defer std.testing.allocator.free(encoded);

    try std.testing.expect(encoded.len <= native_sdk.platform.max_window_event_detail_bytes);
    const classified = try classifyLine(std.testing.allocator, encoded);
    try std.testing.expect(classified == .event);
    try std.testing.expectEqual(@as(u64, 129), classified.event.sequence);
    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, classified.event.recovery);
    try std.testing.expect(std.mem.indexOf(u8, encoded, "\"type\":\"snapshot.invalidated\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, encoded, "\"reason\":\"projectionOverflow\"") != null);
}

test "paused renderer overflow queues an immediate resnapshot marker and preserves responses" {
    const isProtectedTerminal = struct {
        fn call(sequence: u64) bool {
            return switch (sequence) {
                1, 32, 96, 127 => true,
                else => false,
            };
        }
    }.call;
    const encodeOrderedEvent = struct {
        fn call(
            allocator: std.mem.Allocator,
            sequence: u64,
            event_type: []const u8,
        ) std.mem.Allocator.Error![]u8 {
            var buffer: [192]u8 = undefined;
            const encoded = std.fmt.bufPrint(
                &buffer,
                "{{\"version\":3,\"sequence\":{d},\"event\":{{\"type\":\"{s}\"}}}}",
                .{ sequence, event_type },
            ) catch unreachable;
            return allocator.dupe(u8, encoded);
        }
    }.call;

    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
        .state = .running,
    };

    var pending: Pending = undefined;
    const response_bytes = try std.testing.allocator.dupe(
        u8,
        "{\"id\":\"snapshot-1\",\"ok\":true,\"result\":{}}",
    );

    for (1..max_queued_events + 1) |raw_sequence| {
        const sequence: u64 = @intCast(raw_sequence);
        const is_terminal = isProtectedTerminal(sequence);
        const bytes = try encodeOrderedEvent(
            std.testing.allocator,
            sequence,
            if (is_terminal) "operation.completed" else "runtime.changed",
        );
        try host.queueRendererEvent(
            bytes,
            sequence,
            if (is_terminal) .protected else .snapshot_recoverable,
        );
    }
    // Non-event actions may follow the newest renderer event. Overflow scans
    // past them without moving or replacing the response.
    try std.testing.expect(host.pushActionLocked(.{ .response = .{
        .pending = &pending,
        .bytes = response_bytes,
    } }));

    // A sustained burst arrives with no later event to trigger recovery. The
    // newest overflow must already be represented by the queued invalidation.
    const overflow_sequence: u64 = max_queued_events * 4;
    for (max_queued_events + 1..overflow_sequence + 1) |raw_sequence| {
        const sequence: u64 = @intCast(raw_sequence);
        const overflow_bytes = try encodeOrderedEvent(std.testing.allocator, sequence, "runtime.changed");
        try host.queueRendererEvent(overflow_bytes, sequence, .snapshot_recoverable);
    }

    try std.testing.expectEqual(State.running, host.state);
    try std.testing.expectEqual(max_queued_events, host.queued_events);
    try std.testing.expectEqual(max_queued_events + 1, host.action_len);

    var event_index: usize = 0;
    var previous_sequence: u64 = 0;
    var protected_terminals_seen: usize = 0;
    var response_seen = false;
    while (host.popActionLocked()) |action| {
        switch (action) {
            .event => |event| {
                defer std.testing.allocator.free(event.bytes);
                try std.testing.expect(event.sequence > previous_sequence);
                previous_sequence = event.sequence;

                if (event_index == max_queued_events - 1) {
                    try std.testing.expectEqual(overflow_sequence, event.sequence);
                    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, event.recovery);
                    try std.testing.expect(std.mem.indexOf(u8, event.bytes, "\"reason\":\"projectionOverflow\"") != null);
                } else if (isProtectedTerminal(event.sequence)) {
                    try std.testing.expectEqual(@as(u64, @intCast(event_index + 1)), event.sequence);
                    try std.testing.expectEqual(EventRecovery.protected, event.recovery);
                    try std.testing.expect(std.mem.indexOf(u8, event.bytes, "\"type\":\"operation.completed\"") != null);
                    protected_terminals_seen += 1;
                } else {
                    try std.testing.expectEqual(@as(u64, @intCast(event_index + 1)), event.sequence);
                    try std.testing.expectEqual(EventRecovery.snapshot_recoverable, event.recovery);
                    try std.testing.expect(std.mem.indexOf(u8, event.bytes, "\"type\":\"runtime.changed\"") != null);
                }
                event_index += 1;
            },
            .response => |response| {
                defer std.testing.allocator.free(response.bytes);
                try std.testing.expect(response.pending == &pending);
                try std.testing.expectEqualStrings(
                    "{\"id\":\"snapshot-1\",\"ok\":true,\"result\":{}}",
                    response.bytes,
                );
                try std.testing.expectEqual(max_queued_events, event_index);
                response_seen = true;
            },
            .failure, .transport_lifecycle, .write_complete => return error.UnexpectedAction,
        }
    }

    try std.testing.expect(response_seen);
    try std.testing.expectEqual(@as(usize, 4), protected_terminals_seen);
    try std.testing.expectEqual(max_queued_events, event_index);
    try std.testing.expectEqual(@as(usize, 0), host.queued_events);
}

test "terminal-only saturation backpressures until the renderer drains without dropping a completion" {
    const encodeTerminal = struct {
        fn call(allocator: std.mem.Allocator, sequence: u64) std.mem.Allocator.Error![]u8 {
            var buffer: [192]u8 = undefined;
            const encoded = std.fmt.bufPrint(
                &buffer,
                "{{\"version\":3,\"sequence\":{d},\"event\":{{\"type\":\"operation.completed\",\"operationId\":\"op_12345678\",\"outcome\":{{\"ok\":true}}}}}}",
                .{sequence},
            ) catch unreachable;
            return allocator.dupe(u8, encoded);
        }
    }.call;

    var parent: std.process.Environ.Map = .init(std.testing.allocator);
    defer parent.deinit();
    var host: RuntimeHost = .{
        .allocator = std.testing.allocator,
        .io = std.testing.io,
        .parent_environment = &parent,
        .options = .{},
        .state = .running,
    };

    for (1..max_queued_events + 1) |raw_sequence| {
        const sequence: u64 = @intCast(raw_sequence);
        const bytes = try encodeTerminal(std.testing.allocator, sequence);
        try host.queueRendererEvent(bytes, sequence, .protected);
    }

    const QueueContext = struct {
        host: *RuntimeHost,
        bytes: []u8,
        sequence: u64,
        failure: ?anyerror = null,

        fn run(self: *@This()) void {
            self.host.queueRendererEvent(self.bytes, self.sequence, .protected) catch |err| {
                self.failure = err;
            };
        }
    };
    const incoming_sequence: u64 = max_queued_events + 1;
    var context: QueueContext = .{
        .host = &host,
        .bytes = try encodeTerminal(std.testing.allocator, incoming_sequence),
        .sequence = incoming_sequence,
    };
    const producer = try std.Thread.spawn(.{}, QueueContext.run, .{&context});

    while (host.event_space_waiters.load(.acquire) == 0) std.atomic.spinLoopHint();
    try std.testing.expectEqual(State.running, host.state);
    try std.testing.expectEqual(max_queued_events, host.queued_events);

    host.mutex.lockUncancelable(host.io);
    const first = host.popActionLocked().?;
    host.mutex.unlock(host.io);
    switch (first) {
        .event => |event| {
            defer std.testing.allocator.free(event.bytes);
            try std.testing.expectEqual(@as(u64, 1), event.sequence);
            try std.testing.expectEqual(EventRecovery.protected, event.recovery);
        },
        else => return error.UnexpectedAction,
    }

    producer.join();
    try std.testing.expect(context.failure == null);
    try std.testing.expectEqual(@as(usize, 0), host.event_space_waiters.load(.acquire));
    try std.testing.expectEqual(max_queued_events, host.queued_events);

    var terminal_count: usize = 1;
    var incoming_seen = false;
    while (host.popActionLocked()) |action| {
        switch (action) {
            .event => |event| {
                defer std.testing.allocator.free(event.bytes);
                try std.testing.expectEqual(EventRecovery.protected, event.recovery);
                try std.testing.expect(std.mem.indexOf(u8, event.bytes, "\"type\":\"operation.completed\"") != null);
                terminal_count += 1;
                if (event.sequence == incoming_sequence) incoming_seen = true;
            },
            else => return error.UnexpectedAction,
        }
    }
    try std.testing.expect(incoming_seen);
    try std.testing.expectEqual(max_queued_events + 1, terminal_count);
    try std.testing.expectEqual(@as(usize, 0), host.queued_events);
}
