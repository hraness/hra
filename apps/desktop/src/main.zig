const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const cloud_config = @import("cloud_config.zon");
const runner = @import("runner");
const native_sdk = @import("native_sdk");
const runtime_host = @import("runtime_host.zig");

extern fn hra_macos_updater_start() bool;
extern fn hra_macos_updater_check_for_updates(updater_allowed: bool) bool;
extern fn hra_macos_updater_stop() void;
extern fn hra_macos_update_removal_lease_acquire(
    current_count: usize,
    next_count: *usize,
) bool;
extern fn hra_macos_update_removal_lease_release(
    current_count: usize,
    next_count: *usize,
) bool;
extern fn hra_macos_update_hazard_may_clear_without_artifact(
    state: c_int,
    cancellation_pending: bool,
) bool;
const MacosUpdateHazards = extern struct {
    session_in_progress: bool,
    memory_hazard: bool,
    durable_hazard: bool,
    preparation_failed: bool,
    installer_job_present: bool,
    sparkle_cache_present: bool,
    probe_indeterminate: bool,
};
extern fn hra_macos_update_removal_is_safe(
    hazards: MacosUpdateHazards,
) bool;
extern fn hra_macos_update_preparation_failure_next(
    currently_latched: bool,
    result: c_int,
) bool;
extern fn hra_macos_instance_guard_acquire() c_int;
extern fn hra_macos_instance_guard_release() void;

pub const panic = std.debug.FullPanic(native_sdk.debug.capturePanic);

const app_slug = "hra";
const display_name = "HRA";
// The first HRA bridge remains the sole authority at OPRTE.app and its
// existing physical Application Support root. Treat this as opaque storage,
// not user-facing product identity.
const legacy_oprte_storage_app_name = "OPRTE";
const bundle_id = "kitchen.hraness";
const legacy_bundle_ids = &.{ "com.jungle.oprte", "com.jungle.kitchen" };
const legacy_application_support_directory_name = "Hraness Kitchen";
const source_development_app_name = "HRA Source Development";
const source_development_bundle_id = "kitchen.hraness.source-development";
const update_check_command = "hra.update.check";
const instance_guard_unavailable: c_int = -1;
const instance_guard_busy: c_int = 0;
const instance_guard_clear: c_int = 1;
const instance_guard_recovery_required: c_int = 2;
const instance_guard_retry_interval_ms: i64 = 25;
const instance_guard_retry_deadline_ms: i64 = 3_000;

fn instanceGuardRetryDelay(status: c_int, remaining_ms: i64) ?i64 {
    if (status != instance_guard_busy or remaining_ms <= 0) return null;
    return @min(remaining_ms, instance_guard_retry_interval_ms);
}

fn acquireMacOSInstanceGuard(io: std.Io) c_int {
    var remaining_ms = instance_guard_retry_deadline_ms;
    while (true) {
        const status = hra_macos_instance_guard_acquire();
        const delay_ms = instanceGuardRetryDelay(status, remaining_ms) orelse
            return status;
        std.Io.sleep(
            io,
            .fromMilliseconds(delay_ms),
            .awake,
        ) catch return instance_guard_unavailable;
        remaining_ms -= delay_ms;
    }
}
const dev_frontend_url = "http://127.0.0.1:5173/";
const dev_frontend_url_environment = "NATIVE_SDK_FRONTEND_URL";
const dev_mode_environment = "NATIVE_SDK_MODE";
const dev_hmr_environment = "NATIVE_SDK_HMR";
const dev_session_environment = "HRA_DEV_SESSION_ID";
const legacy_oprte_dev_session_environment = "OPRTE_DEV_SESSION_ID";
const dev_session_id_length = 64;

comptime {
    if (cloud_config.enabled) {
        if (!std.mem.eql(
            u8,
            cloud_config.api_origin,
            "https://benevolent-akita-439.convex.site",
        )) {
            @compileError("HRA production cloud API origin must match its checked Convex HTTP deployment");
        }
        if (!std.mem.eql(u8, cloud_config.web_origin, "https://hra.sh")) {
            @compileError("HRA production browser origin must match its checked web deployment");
        }
    }
}

const App = struct {
    env_map: *std.process.Environ.Map,
    runtime_host: runtime_host.RuntimeHost,
    product_native_authority: bool,
    instance_guard_acquired: bool = false,
    removal_recovery_required: bool = false,

    fn app(self: *@This()) native_sdk.App {
        return .{
            .context = self,
            .name = app_slug,
            .source = native_sdk.frontend.productionSource(.{ .dist = "frontend/dist" }),
            .source_fn = source,
            .start_fn = start,
            .event_fn = event,
            .stop_fn = stop,
        };
    }

    fn source(context: *anyopaque) anyerror!native_sdk.WebViewSource {
        const self: *@This() = @ptrCast(@alignCast(context));
        return frontendSourceForMode(builtin.mode, self.env_map);
    }

    fn ensureMacOSInstanceGuard(self: *@This(), io: std.Io) !void {
        if (comptime !std.mem.eql(u8, build_options.platform, "macos")) return;
        if (!self.product_native_authority) return;
        if (self.instance_guard_acquired) return;

        // Sparkle may create the replacement process while the exact
        // predecessor is still completing RuntimeHost shutdown. Retry only
        // the kernel-proven busy result within the package smoke's separate
        // fixed singleton-observation window. Every unavailable or otherwise
        // unsafe result still fails immediately.
        const guard = acquireMacOSInstanceGuard(io);
        if (guard != instance_guard_clear and
            guard != instance_guard_recovery_required)
        {
            return error.HRAInstanceUnavailable;
        }
        self.instance_guard_acquired = true;
        self.removal_recovery_required =
            guard == instance_guard_recovery_required;
        self.runtime_host.options.startup_removal_recovery =
            self.removal_recovery_required;
    }

    fn releaseMacOSInstanceGuard(self: *@This()) void {
        if (comptime !std.mem.eql(u8, build_options.platform, "macos")) return;
        if (!self.instance_guard_acquired) return;
        hra_macos_instance_guard_release();
        self.instance_guard_acquired = false;
    }

    fn start(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        try self.ensureMacOSInstanceGuard(self.runtime_host.io);
        self.runtime_host.start(runtime) catch |err| {
            self.releaseMacOSInstanceGuard();
            return err;
        };
        if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
            if (self.product_native_authority and
                !self.removal_recovery_required)
            {
                _ = hra_macos_updater_start();
            }
        }
    }

    fn event(context: *anyopaque, runtime: *native_sdk.Runtime, value: native_sdk.Event) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
            switch (value) {
                .command => |command| {
                    if (std.mem.eql(u8, command.name, update_check_command)) {
                        if (self.product_native_authority) {
                            _ = hra_macos_updater_check_for_updates(
                                !self.removal_recovery_required,
                            );
                        }
                        return;
                    }
                },
                else => {},
            }
        }
        self.runtime_host.onEvent(runtime, value);
    }

    fn stop(context: *anyopaque, runtime: *native_sdk.Runtime) anyerror!void {
        const self: *@This() = @ptrCast(@alignCast(context));
        if (comptime std.mem.eql(u8, build_options.platform, "macos") and
            self.product_native_authority)
        {
            hra_macos_updater_stop();
        }
        self.runtime_host.stop(runtime);
        self.releaseMacOSInstanceGuard();
    }
};

pub fn main(init: std.process.Init) !void {
    if (init.environ_map.get("HRA_PACKAGE_SMOKE_ROOT")) |root| {
        try runtime_host.runPackagedSmoke(init, root);
        return;
    }
    const development_frontend_enabled = try developmentFrontendEnabled(
        builtin.mode,
        init.environ_map,
    );
    const bridge_profile = bridgeProfileForLaunch(
        builtin.mode,
        development_frontend_enabled,
        build_options.automation,
    );
    const runtime_profile = runtimeProfileForLaunch(
        builtin.mode,
        build_options.automation,
    );
    const launch_policy = nativeLaunchPolicy(runtime_profile);
    var app = App{
        .env_map = init.environ_map,
        .product_native_authority = launch_policy.product_native_authority,
        .runtime_host = runtime_host.RuntimeHost.init(init, .{
            .bridge_profile = bridge_profile,
            .runtime_profile = runtime_profile,
            .removal_lifecycle = launch_policy.removal_lifecycle,
            .account_profile_runner = launch_policy.account_profile_runner,
            .harness_custody_runner = launch_policy.harness_custody_runner,
            .production_cloud = if (cloud_config.enabled)
                .{
                    .api_origin = cloud_config.api_origin,
                    .web_origin = cloud_config.web_origin,
                }
            else
                null,
        }),
    };
    // Reject a competing process before the runner initializes AppKit,
    // WebKit, or any Native SDK runtime state. App.start repeats this through
    // an idempotent guard so alternate runners retain the same invariant.
    try app.ensureMacOSInstanceGuard(init.io);
    defer app.releaseMacOSInstanceGuard();
    try runner.runWithOptions(app.app(), .{
        .app_name = launch_policy.app_name,
        .window_title = display_name,
        .bundle_id = launch_policy.bundle_id,
        .legacy_window_state_bundle_ids = launch_policy.legacy_window_state_bundle_ids,
        .legacy_application_support_directory_name = launch_policy.legacy_application_support_directory_name,
        .icon_path = "assets/icon.png",
        .bridge = app.runtime_host.dispatcher(),
        .web_inspector_enabled = webInspectorEnabledForMode(builtin.mode),
        .security = .{
            .navigation = .{ .allowed_origins = bridge_profile.origins() },
        },
    }, init);
}

fn webInspectorEnabledForMode(mode: std.builtin.OptimizeMode) bool {
    return mode == .Debug;
}

fn canonicalDevSessionId(value: []const u8) bool {
    if (value.len != dev_session_id_length) return false;
    for (value) |byte| switch (byte) {
        '0'...'9', 'a'...'f' => {},
        else => return false,
    };
    return true;
}

fn developmentFrontendEnabled(
    mode: std.builtin.OptimizeMode,
    environment: *const std.process.Environ.Map,
) error{ConflictingEnvironmentAlias}!bool {
    if (mode != .Debug) return false;
    const url = environment.get(dev_frontend_url_environment) orelse return false;
    const dev_mode = environment.get(dev_mode_environment) orelse return false;
    const hmr = environment.get(dev_hmr_environment) orelse return false;
    const canonical_session_id = environment.get(dev_session_environment);
    const legacy_session_id = environment.get(legacy_oprte_dev_session_environment);
    if (canonical_session_id != null and legacy_session_id != null and
        !std.mem.eql(u8, canonical_session_id.?, legacy_session_id.?))
    {
        return error.ConflictingEnvironmentAlias;
    }
    const session_id = canonical_session_id orelse legacy_session_id orelse
        return false;
    return std.mem.eql(u8, url, dev_frontend_url) and
        std.mem.eql(u8, dev_mode, "dev") and
        std.mem.eql(u8, hmr, "1") and
        canonicalDevSessionId(session_id);
}

fn frontendSourceForMode(
    mode: std.builtin.OptimizeMode,
    environment: *const std.process.Environ.Map,
) error{ConflictingEnvironmentAlias}!native_sdk.WebViewSource {
    if (try developmentFrontendEnabled(mode, environment)) {
        return native_sdk.WebViewSource.url(dev_frontend_url);
    }
    return native_sdk.frontend.productionSource(.{
        .dist = "frontend/dist",
        .entry = "index.html",
    });
}

fn bridgeProfileForLaunch(
    mode: std.builtin.OptimizeMode,
    development_frontend_enabled: bool,
    automation_enabled: bool,
) runtime_host.BridgeProfile {
    if (automation_enabled) return .automation;
    if (mode == .Debug and development_frontend_enabled) return .development;
    return .production;
}

/// Runtime storage and native capability isolation is broader than remote-UI
/// authority: every ad-hoc Debug host is source development, but only the
/// nonce-authenticated HMR envelope may open the Vite bridge origin.
fn runtimeProfileForLaunch(
    mode: std.builtin.OptimizeMode,
    automation_enabled: bool,
) runtime_host.BridgeProfile {
    if (automation_enabled) return .automation;
    if (mode == .Debug) return .development;
    return .production;
}

const NativeLaunchPolicy = struct {
    app_name: []const u8,
    bundle_id: []const u8,
    legacy_window_state_bundle_ids: []const []const u8,
    legacy_application_support_directory_name: ?[]const u8,
    removal_lifecycle: ?runtime_host.RemovalLifecycle,
    account_profile_runner: ?runtime_host.AccountProfileOperationRunner,
    harness_custody_runner: ?runtime_host.HarnessCustodyHelperRunner,
    product_native_authority: bool,
};

const isolated_development_removal_lifecycle: runtime_host.RemovalLifecycle = .{
    .context = null,
    .prepare_fn = rejectIsolatedDevelopmentRemoval,
    .rollback_fn = ignoreIsolatedDevelopmentRemoval,
    .spawn_fn = rejectIsolatedDevelopmentRemovalSpawn,
    .recover_staged_fn = rejectIsolatedDevelopmentRemovalRecovery,
    .arm_termination_watchdog_fn = rejectIsolatedDevelopmentRemovalTermination,
    .terminate_fn = ignoreIsolatedDevelopmentRemoval,
};

fn rejectIsolatedDevelopmentRemoval(
    context: ?*anyopaque,
    helper_path: []const u8,
    mode: runtime_host.RemovalPreparation,
) bool {
    _ = context;
    _ = helper_path;
    _ = mode;
    return false;
}

fn ignoreIsolatedDevelopmentRemoval(context: ?*anyopaque) void {
    _ = context;
}

fn rejectIsolatedDevelopmentRemovalSpawn(
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
    _ = io;
    _ = helper_path;
    _ = request_path;
    _ = signing_key_path;
    _ = parent_process_id;
    return error.ProductNativeAuthorityUnavailable;
}

fn rejectIsolatedDevelopmentRemovalRecovery(
    context: ?*anyopaque,
    allocator: std.mem.Allocator,
    io: std.Io,
    helper_path: []const u8,
    helper_state_root: []const u8,
) !void {
    _ = context;
    _ = allocator;
    _ = io;
    _ = helper_path;
    _ = helper_state_root;
    return error.ProductNativeAuthorityUnavailable;
}

fn rejectIsolatedDevelopmentRemovalTermination(
    context: ?*anyopaque,
) bool {
    _ = context;
    return false;
}

/// Raw Debug runs are not signed product launches. Give them a disjoint Native
/// state/log identity and keep them out of every production migration, process
/// guard, removal-recovery, and updater authority. Automation intentionally
/// retains the product-shaped identity so its existing fixtures stay exact.
fn nativeLaunchPolicy(profile: runtime_host.BridgeProfile) NativeLaunchPolicy {
    return switch (profile) {
        .development => .{
            .app_name = source_development_app_name,
            .bundle_id = source_development_bundle_id,
            .legacy_window_state_bundle_ids = &.{},
            .legacy_application_support_directory_name = null,
            .removal_lifecycle = isolated_development_removal_lifecycle,
            .account_profile_runner =
                runtime_host.isolatedDevelopmentAccountProfileRunner(),
            .harness_custody_runner =
                runtime_host.isolatedDevelopmentHarnessCustodyRunner(),
            .product_native_authority = false,
        },
        .production, .automation => .{
            .app_name = legacy_oprte_storage_app_name,
            .bundle_id = bundle_id,
            .legacy_window_state_bundle_ids = legacy_bundle_ids,
            .legacy_application_support_directory_name = legacy_application_support_directory_name,
            .removal_lifecycle = null,
            .account_profile_runner = null,
            .harness_custody_runner = null,
            .product_native_authority = true,
        },
    };
}

test "application identity is stable" {
    try std.testing.expectEqualStrings("hra", app_slug);
    try std.testing.expectEqualStrings("HRA", display_name);
    try std.testing.expectEqualStrings("OPRTE", legacy_oprte_storage_app_name);
    try std.testing.expectEqualStrings("kitchen.hraness", bundle_id);
    try std.testing.expectEqual(@as(usize, 2), legacy_bundle_ids.len);
    try std.testing.expectEqualStrings("com.jungle.oprte", legacy_bundle_ids[0]);
    try std.testing.expectEqualStrings("com.jungle.kitchen", legacy_bundle_ids[1]);
    try std.testing.expectEqualStrings(
        "Hraness Kitchen",
        legacy_application_support_directory_name,
    );
}

test "manual updater command is stable" {
    try std.testing.expectEqualStrings("hra.update.check", update_check_command);
}

test "instance guard retries only a bounded busy predecessor" {
    try std.testing.expectEqual(
        @as(?i64, instance_guard_retry_interval_ms),
        instanceGuardRetryDelay(instance_guard_busy, instance_guard_retry_deadline_ms),
    );
    try std.testing.expectEqual(
        @as(?i64, 1),
        instanceGuardRetryDelay(instance_guard_busy, 1),
    );
    try std.testing.expectEqual(
        @as(?i64, null),
        instanceGuardRetryDelay(instance_guard_busy, 0),
    );
    for ([_]c_int{
        instance_guard_unavailable,
        instance_guard_clear,
        instance_guard_recovery_required,
        3,
    }) |status| {
        try std.testing.expectEqual(
            @as(?i64, null),
            instanceGuardRetryDelay(status, instance_guard_retry_deadline_ms),
        );
    }
    try std.testing.expect(instance_guard_retry_deadline_ms < 5_000);
}

test "web inspector is enabled only for Debug hosts" {
    try std.testing.expect(webInspectorEnabledForMode(.Debug));
    try std.testing.expect(!webInspectorEnabledForMode(.ReleaseSafe));
    try std.testing.expect(!webInspectorEnabledForMode(.ReleaseFast));
    try std.testing.expect(!webInspectorEnabledForMode(.ReleaseSmall));
}

test "remote frontend requires the complete canonical Debug launch envelope" {
    var environment = std.process.Environ.Map.init(std.testing.allocator);
    defer environment.deinit();
    try environment.put(dev_frontend_url_environment, dev_frontend_url);
    try environment.put(dev_mode_environment, "dev");
    try environment.put(dev_hmr_environment, "1");
    try environment.put(
        dev_session_environment,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    try std.testing.expect(try developmentFrontendEnabled(.Debug, &environment));
    try std.testing.expect(
        !(try developmentFrontendEnabled(.ReleaseSafe, &environment)),
    );
    try std.testing.expect(
        !(try developmentFrontendEnabled(.ReleaseFast, &environment)),
    );
    try std.testing.expect(
        !(try developmentFrontendEnabled(.ReleaseSmall, &environment)),
    );

    try environment.put(dev_hmr_environment, "0");
    try std.testing.expect(!(try developmentFrontendEnabled(.Debug, &environment)));
    try environment.put(dev_hmr_environment, "1");
    try environment.put(dev_mode_environment, "development");
    try std.testing.expect(!(try developmentFrontendEnabled(.Debug, &environment)));
    try environment.put(dev_mode_environment, "dev");
    try environment.put(dev_frontend_url_environment, "http://localhost:5173/");
    try std.testing.expect(!(try developmentFrontendEnabled(.Debug, &environment)));
    try environment.put(dev_frontend_url_environment, dev_frontend_url);
    try environment.put(
        dev_session_environment,
        "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    try std.testing.expect(!(try developmentFrontendEnabled(.Debug, &environment)));
}

test "Debug launch accepts equal OPRTE session compatibility and rejects conflicts" {
    var environment = std.process.Environ.Map.init(std.testing.allocator);
    defer environment.deinit();
    try environment.put(dev_frontend_url_environment, dev_frontend_url);
    try environment.put(dev_mode_environment, "dev");
    try environment.put(dev_hmr_environment, "1");
    const session =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    try environment.put(legacy_oprte_dev_session_environment, session);
    try std.testing.expect(try developmentFrontendEnabled(.Debug, &environment));
    try environment.put(dev_session_environment, session);
    try std.testing.expect(try developmentFrontendEnabled(.Debug, &environment));
    try environment.put(
        dev_session_environment,
        "1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    try std.testing.expectError(
        error.ConflictingEnvironmentAlias,
        developmentFrontendEnabled(.Debug, &environment),
    );
}

test "invalid or release launch markers always select bundled assets" {
    var environment = std.process.Environ.Map.init(std.testing.allocator);
    defer environment.deinit();

    const missing = try frontendSourceForMode(.Debug, &environment);
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.assets, missing.kind);
    try std.testing.expectEqualStrings(
        "frontend/dist",
        missing.asset_options.?.root_path,
    );

    try environment.put(dev_frontend_url_environment, dev_frontend_url);
    try environment.put(dev_mode_environment, "dev");
    try environment.put(dev_hmr_environment, "1");
    try environment.put(
        dev_session_environment,
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const development = try frontendSourceForMode(.Debug, &environment);
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.url, development.kind);
    try std.testing.expectEqualStrings(dev_frontend_url, development.bytes);

    const release = try frontendSourceForMode(.ReleaseFast, &environment);
    try std.testing.expectEqual(native_sdk.WebViewSourceKind.assets, release.kind);
    try std.testing.expectEqualStrings(
        "frontend/dist",
        release.asset_options.?.root_path,
    );
}

test "remote bridge authority still requires the complete Debug envelope" {
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.production,
        bridgeProfileForLaunch(.Debug, false, false),
    );
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.development,
        bridgeProfileForLaunch(.Debug, true, false),
    );
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.production,
        bridgeProfileForLaunch(.ReleaseSafe, false, false),
    );
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.automation,
        bridgeProfileForLaunch(.Debug, false, true),
    );
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.automation,
        bridgeProfileForLaunch(.ReleaseSafe, true, true),
    );
}

test "every raw Debug runtime uses isolated development authority" {
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.development,
        runtimeProfileForLaunch(.Debug, false),
    );
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.production,
        runtimeProfileForLaunch(.ReleaseSafe, false),
    );
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.automation,
        runtimeProfileForLaunch(.Debug, true),
    );
    try std.testing.expectEqual(
        runtime_host.BridgeProfile.automation,
        runtimeProfileForLaunch(.ReleaseSafe, true),
    );
}

test "raw development has disjoint Native state and no product lifecycle authority" {
    const development = nativeLaunchPolicy(.development);
    try std.testing.expectEqualStrings(
        "HRA Source Development",
        development.app_name,
    );
    try std.testing.expectEqualStrings(
        "kitchen.hraness.source-development",
        development.bundle_id,
    );
    try std.testing.expectEqual(@as(usize, 0), development.legacy_window_state_bundle_ids.len);
    try std.testing.expectEqual(
        @as(?[]const u8, null),
        development.legacy_application_support_directory_name,
    );
    try std.testing.expect(!development.product_native_authority);
    try std.testing.expect(development.removal_lifecycle != null);
    try std.testing.expect(development.account_profile_runner != null);
    try std.testing.expect(development.harness_custody_runner != null);

    const expected_account_runner =
        runtime_host.isolatedDevelopmentAccountProfileRunner();
    try std.testing.expect(
        development.account_profile_runner.?.run_fn ==
            expected_account_runner.run_fn,
    );
    const expected_harness_runner =
        runtime_host.isolatedDevelopmentHarnessCustodyRunner();
    try std.testing.expect(
        development.harness_custody_runner.?.run_fn ==
            expected_harness_runner.run_fn,
    );

    const removal = development.removal_lifecycle.?;
    try std.testing.expect(!removal.prepare_fn(
        removal.context,
        "/Applications/HRA.app/Contents/Resources/runtime/bin/oprte-data-remover",
        .requested,
    ));

    for ([_]runtime_host.BridgeProfile{ .production, .automation }) |profile| {
        const product = nativeLaunchPolicy(profile);
        try std.testing.expectEqualStrings("OPRTE", product.app_name);
        try std.testing.expectEqualStrings("kitchen.hraness", product.bundle_id);
        try std.testing.expectEqual(@as(usize, 2), product.legacy_window_state_bundle_ids.len);
        try std.testing.expectEqualStrings(
            "Hraness Kitchen",
            product.legacy_application_support_directory_name.?,
        );
        try std.testing.expect(product.product_native_authority);
        try std.testing.expect(product.removal_lifecycle == null);
        try std.testing.expect(product.account_profile_runner == null);
        try std.testing.expect(product.harness_custody_runner == null);
    }
}

test "overlapping removal leases keep the updater gate closed until final release" {
    var leases: usize = 0;
    try std.testing.expect(
        hra_macos_update_removal_lease_acquire(leases, &leases),
    );
    try std.testing.expectEqual(@as(usize, 1), leases);
    try std.testing.expect(
        hra_macos_update_removal_lease_acquire(leases, &leases),
    );
    try std.testing.expectEqual(@as(usize, 2), leases);

    try std.testing.expect(
        hra_macos_update_removal_lease_release(leases, &leases),
    );
    try std.testing.expectEqual(@as(usize, 1), leases);
    try std.testing.expect(leases != 0);
    try std.testing.expect(
        hra_macos_update_removal_lease_release(leases, &leases),
    );
    try std.testing.expectEqual(@as(usize, 0), leases);

    try std.testing.expect(
        !hra_macos_update_removal_lease_release(leases, &leases),
    );
    leases = std.math.maxInt(usize);
    try std.testing.expect(
        !hra_macos_update_removal_lease_acquire(leases, &leases),
    );
}

test "only pre-download or proven-cancelled updater hazards clear without artifacts" {
    const unknown: c_int = 0;
    const found: c_int = 1;
    const downloading: c_int = 2;
    const downloaded: c_int = 3;
    const extracting: c_int = 4;
    const installing: c_int = 5;
    const install_on_quit: c_int = 6;
    const cancelled: c_int = 7;

    try std.testing.expect(
        hra_macos_update_hazard_may_clear_without_artifact(found, false),
    );
    try std.testing.expect(
        hra_macos_update_hazard_may_clear_without_artifact(cancelled, false),
    );
    for ([_]c_int{
        unknown,
        downloading,
        downloaded,
        extracting,
        installing,
        install_on_quit,
    }) |state| {
        try std.testing.expect(
            !hra_macos_update_hazard_may_clear_without_artifact(
                state,
                false,
            ),
        );
        try std.testing.expect(
            hra_macos_update_hazard_may_clear_without_artifact(
                state,
                true,
            ),
        );
    }
}

test "failed temporary hazard preparation stays latched until a successful re-prepare" {
    const preparation_not_attempted: c_int = 0;
    const preparation_failed: c_int = 1;
    const preparation_succeeded: c_int = 2;

    for ([_]struct {
        currently_latched: bool,
        result: c_int,
        expected: bool,
    }{
        .{
            .currently_latched = false,
            .result = preparation_not_attempted,
            .expected = false,
        },
        .{
            .currently_latched = true,
            .result = preparation_not_attempted,
            .expected = true,
        },
        .{
            .currently_latched = false,
            .result = preparation_failed,
            .expected = true,
        },
        .{
            .currently_latched = true,
            .result = preparation_failed,
            .expected = true,
        },
        .{
            .currently_latched = false,
            .result = preparation_succeeded,
            .expected = false,
        },
        .{
            .currently_latched = true,
            .result = preparation_succeeded,
            .expected = false,
        },
    }) |case| {
        try std.testing.expectEqual(
            case.expected,
            hra_macos_update_preparation_failure_next(
                case.currently_latched,
                case.result,
            ),
        );
    }

    var failure_latched =
        hra_macos_update_preparation_failure_next(
            false,
            preparation_failed,
        );
    try std.testing.expect(failure_latched);
    try std.testing.expect(
        !hra_macos_update_removal_is_safe(.{
            .session_in_progress = false,
            .memory_hazard = false,
            // The malformed temporary journal can coexist with an absent
            // final journal, so the durable read alone appears clean.
            .durable_hazard = false,
            .preparation_failed = failure_latched,
            .installer_job_present = false,
            .sparkle_cache_present = false,
            .probe_indeterminate = false,
        }),
    );

    failure_latched = hra_macos_update_preparation_failure_next(
        failure_latched,
        preparation_not_attempted,
    );
    try std.testing.expect(failure_latched);

    failure_latched = hra_macos_update_preparation_failure_next(
        failure_latched,
        preparation_succeeded,
    );
    try std.testing.expect(!failure_latched);
    try std.testing.expect(
        hra_macos_update_removal_is_safe(.{
            .session_in_progress = false,
            .memory_hazard = false,
            .durable_hazard = false,
            .preparation_failed = failure_latched,
            .installer_job_present = false,
            .sparkle_cache_present = false,
            .probe_indeterminate = false,
        }),
    );
}

test "legacy Native window state copies atomically and retains its source" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State",
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "legacy-window-state",
    });
    const source_before = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .{ .follow_symlinks = false },
    );

    try runner.migrateLegacyWindowStatePaths(
        tmp.dir,
        io,
        "home/Library/Application Support",
        "OPRTE",
        "com.jungle.kitchen",
        "kitchen.hraness",
    );

    const source_after = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .{ .follow_symlinks = false },
    );
    const target_after = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        .{ .follow_symlinks = false },
    );
    try std.testing.expectEqual(source_before.inode, source_after.inode);
    try std.testing.expect(source_after.inode != target_after.inode);
    const migrated = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(migrated);
    try std.testing.expectEqualStrings("legacy-window-state", migrated);
    const retained = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(retained);
    try std.testing.expectEqualStrings("legacy-window-state", retained);

    try runner.migrateLegacyWindowStatePaths(
        tmp.dir,
        io,
        "home/Library/Application Support",
        "OPRTE",
        "com.jungle.kitchen",
        "kitchen.hraness",
    );
}

test "live legacy authority causes zero Native window state mutation" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/OPRTE",
    );
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State",
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/OPRTE/control-plane.sqlite",
        .data = "legacy-control-plane",
    });
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "legacy-window-state",
    });
    const source_before = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .{ .follow_symlinks = false },
    );

    const ActiveAuthorityProbe = struct {
        fn run(
            context: ?*anyopaque,
            probe_io: std.Io,
            canonical_database_path: []const u8,
        ) !bool {
            _ = probe_io;
            if (!std.mem.endsWith(
                u8,
                canonical_database_path,
                "/OPRTE/control-plane.sqlite",
            )) {
                return error.UnexpectedLegacyAuthorityPath;
            }
            const call_count: *usize = @ptrCast(@alignCast(context orelse
                return error.MissingLegacyAuthorityProbeContext));
            call_count.* += 1;
            return true;
        }
    };
    var probe_call_count: usize = 0;
    try std.testing.expectError(
        error.LegacyApplicationSupportAuthorityInUse,
        runner.migrateLegacyWindowStatePathsWithOps(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
            .{
                .authority_probe_context = &probe_call_count,
                .probe_legacy_authority_fn = ActiveAuthorityProbe.run,
            },
        ),
    );
    try std.testing.expectEqual(@as(usize, 1), probe_call_count);

    const source_after = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .{ .follow_symlinks = false },
    );
    try std.testing.expectEqual(source_before.inode, source_after.inode);
    const retained = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(retained);
    try std.testing.expectEqualStrings("legacy-window-state", retained);
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.statFile(
            io,
            "home/Library/Application Support/kitchen.hraness",
            .{ .follow_symlinks = false },
        ),
    );
}

test "empty Native window cutover prevents later legacy divergence" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(io, "home/Library/Application Support");

    try runner.migrateLegacyWindowStatePaths(
        tmp.dir,
        io,
        "home/Library/Application Support",
        "OPRTE",
        "com.jungle.kitchen",
        "kitchen.hraness",
    );
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.statFile(
            io,
            "home/Library/Application Support/kitchen.hraness/State/windows.zon",
            .{ .follow_symlinks = false },
        ),
    );

    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State",
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "recreated-by-legacy-app",
    });
    try runner.migrateLegacyWindowStatePaths(
        tmp.dir,
        io,
        "home/Library/Application Support",
        "OPRTE",
        "com.jungle.kitchen",
        "kitchen.hraness",
    );
    const retained = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(retained);
    try std.testing.expectEqualStrings("recreated-by-legacy-app", retained);
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.statFile(
            io,
            "home/Library/Application Support/kitchen.hraness/State/windows.zon",
            .{ .follow_symlinks = false },
        ),
    );
}

test "completed Native window cutover ignores later live legacy divergence" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/OPRTE",
    );
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State",
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/OPRTE/control-plane.sqlite",
        .data = "legacy-control-plane",
    });
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "migrated-window-state",
    });

    const AuthorityProbe = struct {
        active: bool = false,
        call_count: usize = 0,

        fn run(
            context: ?*anyopaque,
            probe_io: std.Io,
            canonical_database_path: []const u8,
        ) !bool {
            _ = probe_io;
            if (!std.mem.endsWith(
                u8,
                canonical_database_path,
                "/OPRTE/control-plane.sqlite",
            )) {
                return error.UnexpectedLegacyAuthorityPath;
            }
            const self: *@This() = @ptrCast(@alignCast(context orelse
                return error.MissingLegacyAuthorityProbeContext));
            self.call_count += 1;
            return self.active;
        }
    };
    var probe = AuthorityProbe{};
    const migration_ops: runner.WindowStateMigrationOps = .{
        .authority_probe_context = &probe,
        .probe_legacy_authority_fn = AuthorityProbe.run,
    };

    try runner.migrateLegacyWindowStatePathsWithOps(
        tmp.dir,
        io,
        "home/Library/Application Support",
        "OPRTE",
        "com.jungle.kitchen",
        "kitchen.hraness",
        migration_ops,
    );
    try std.testing.expectEqual(@as(usize, 1), probe.call_count);
    const target_before_divergence = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        .{ .follow_symlinks = false },
    );
    const source_before_divergence = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .{ .follow_symlinks = false },
    );
    try std.testing.expect(
        target_before_divergence.inode != source_before_divergence.inode,
    );

    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "recreated-by-legacy-app",
    });
    probe.active = true;

    try runner.migrateLegacyWindowStatePathsWithOps(
        tmp.dir,
        io,
        "home/Library/Application Support",
        "OPRTE",
        "com.jungle.kitchen",
        "kitchen.hraness",
        migration_ops,
    );
    try std.testing.expectEqual(@as(usize, 1), probe.call_count);
    const retained = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(retained);
    try std.testing.expectEqualStrings("recreated-by-legacy-app", retained);
    const migrated = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(migrated);
    try std.testing.expectEqualStrings("migrated-window-state", migrated);
}

test "Native window state migration rejects two authorities" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State",
    );
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/kitchen.hraness/State",
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "legacy-window-state",
    });
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        .data = "new-window-state",
    });

    try std.testing.expectError(
        error.WindowStateIdentityConflict,
        runner.migrateLegacyWindowStatePaths(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
        ),
    );
}

test "Native window state preflight rejects both historical authorities before mutation" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    inline for (.{ "com.jungle.oprte", "com.jungle.kitchen" }) |identifier| {
        const state_path = "home/Library/Application Support/" ++ identifier ++ "/State";
        const file_path = state_path ++ "/windows.zon";
        try tmp.dir.createDirPath(io, state_path);
        try tmp.dir.writeFile(io, .{ .sub_path = file_path, .data = identifier });
    }

    try std.testing.expectError(
        error.WindowStateIdentityConflict,
        runner.migrateLegacyWindowStatePathsMany(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "Hraness Kitchen",
            &.{ "com.jungle.oprte", "com.jungle.kitchen" },
            "kitchen.hraness",
        ),
    );
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.statFile(
            io,
            "home/Library/Application Support/kitchen.hraness",
            .{ .follow_symlinks = false },
        ),
    );
}

test "prepared Native window copy converges after publication interruption" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State",
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "legacy-window-state",
    });

    const FailingPublicationHook = struct {
        fn run(
            context: ?*anyopaque,
        ) !void {
            const call_count: *usize = @ptrCast(@alignCast(context orelse
                return error.MissingPublicationHookContext));
            call_count.* += 1;
            return error.InjectedWindowStatePublicationInterruption;
        }
    };
    var publication_hook_call_count: usize = 0;
    try std.testing.expectError(
        error.InjectedWindowStatePublicationInterruption,
        runner.migrateLegacyWindowStatePathsWithOps(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
            .{
                .publication_hook_context = &publication_hook_call_count,
                .after_target_publication_fn = FailingPublicationHook.run,
            },
        ),
    );
    try std.testing.expectEqual(
        @as(usize, 1),
        publication_hook_call_count,
    );

    const source_after_interruption = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .{ .follow_symlinks = false },
    );
    const target_after_interruption = try tmp.dir.statFile(
        io,
        "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        .{ .follow_symlinks = false },
    );
    try std.testing.expect(
        source_after_interruption.inode != target_after_interruption.inode,
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        .data = "legacy-changed-after-publication",
    });

    try runner.migrateLegacyWindowStatePaths(
        tmp.dir,
        io,
        "home/Library/Application Support",
        "OPRTE",
        "com.jungle.kitchen",
        "kitchen.hraness",
    );
    const retained = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(retained);
    try std.testing.expectEqualStrings(
        "legacy-changed-after-publication",
        retained,
    );
    const migrated = try tmp.dir.readFileAlloc(
        io,
        "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        std.testing.allocator,
        .limited(1024),
    );
    defer std.testing.allocator.free(migrated);
    try std.testing.expectEqualStrings("legacy-window-state", migrated);
}

test "prepared Native window copy rejects a legacy hardlink without certification" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    const legacy_window_path =
        "home/Library/Application Support/com.jungle.kitchen/State/windows.zon";
    const target_window_path =
        "home/Library/Application Support/kitchen.hraness/State/windows.zon";
    const prepared_receipt_path =
        "home/Library/Application Support/kitchen.hraness/State/.window-state-migration-v2.from.com.jungle.kitchen.to.kitchen.hraness.prepared";
    const published_receipt_path =
        "home/Library/Application Support/kitchen.hraness/State/.window-state-migration-v2.from.com.jungle.kitchen.to.kitchen.hraness.published";
    const completed_receipt_path =
        "home/Library/Application Support/kitchen.hraness/State/.window-state-migration-v2.from.com.jungle.kitchen.to.kitchen.hraness.completed";
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/com.jungle.kitchen/State",
    );
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/kitchen.hraness/State",
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = legacy_window_path,
        .data = "legacy-window-state",
    });
    try tmp.dir.hardLink(
        legacy_window_path,
        tmp.dir,
        target_window_path,
        io,
        .{ .follow_symlinks = false },
    );
    try tmp.dir.writeFile(io, .{
        .sub_path = prepared_receipt_path,
        .data = "",
    });
    const legacy_before = try tmp.dir.statFile(
        io,
        legacy_window_path,
        .{ .follow_symlinks = false },
    );
    const target_before = try tmp.dir.statFile(
        io,
        target_window_path,
        .{ .follow_symlinks = false },
    );
    try std.testing.expectEqual(legacy_before.inode, target_before.inode);

    try std.testing.expectError(
        error.WindowStateCopySharesLegacyIdentity,
        runner.migrateLegacyWindowStatePaths(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
        ),
    );

    const legacy_after = try tmp.dir.statFile(
        io,
        legacy_window_path,
        .{ .follow_symlinks = false },
    );
    const target_after = try tmp.dir.statFile(
        io,
        target_window_path,
        .{ .follow_symlinks = false },
    );
    try std.testing.expectEqual(legacy_before.inode, legacy_after.inode);
    try std.testing.expectEqual(target_before.inode, target_after.inode);
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.statFile(
            io,
            published_receipt_path,
            .{ .follow_symlinks = false },
        ),
    );
    try std.testing.expectError(
        error.FileNotFound,
        tmp.dir.statFile(
            io,
            completed_receipt_path,
            .{ .follow_symlinks = false },
        ),
    );
}

test "Native window state migration rejects unsafe identity paths" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(io, "home/Library/Application Support/redirected/State");
    try tmp.dir.symLink(
        io,
        "redirected",
        "home/Library/Application Support/com.jungle.kitchen",
        .{ .is_directory = true },
    );

    try std.testing.expectError(
        error.UnsafeWindowStatePath,
        runner.migrateLegacyWindowStatePaths(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
        ),
    );
}

test "Native window state migration rejects unsafe target state without a legacy file" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(
        io,
        "home/Library/Application Support/kitchen.hraness/State",
    );
    try tmp.dir.symLink(
        io,
        "untrusted-window-state",
        "home/Library/Application Support/kitchen.hraness/State/windows.zon",
        .{},
    );

    try std.testing.expectError(
        error.UnsafeWindowStatePath,
        runner.migrateLegacyWindowStatePaths(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
        ),
    );
}

test "Native window state migration rejects a symlinked HOME ancestor" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(io, "redirected/Library/Application Support");
    try tmp.dir.symLink(io, "redirected", "home", .{ .is_directory = true });

    try std.testing.expectError(
        error.UnsafeWindowStatePath,
        runner.migrateLegacyWindowStatePaths(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
        ),
    );
}

test "Native window state migration rejects a symlinked Library ancestor" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const io = std.testing.io;
    try tmp.dir.createDirPath(io, "home");
    try tmp.dir.createDirPath(io, "redirected/Library/Application Support");
    try tmp.dir.symLink(
        io,
        "../redirected/Library",
        "home/Library",
        .{ .is_directory = true },
    );

    try std.testing.expectError(
        error.UnsafeWindowStatePath,
        runner.migrateLegacyWindowStatePaths(
            tmp.dir,
            io,
            "home/Library/Application Support",
            "OPRTE",
            "com.jungle.kitchen",
            "kitchen.hraness",
        ),
    );
}
