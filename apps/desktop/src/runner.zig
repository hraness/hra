const std = @import("std");
const builtin = @import("builtin");
const build_options = @import("build_options");
const native_sdk = @import("native_sdk");
const app_manifest = @import("app_manifest_zon");
const manifest_commands = if (@hasField(@TypeOf(app_manifest), "commands")) app_manifest.commands else .{};
const manifest_shortcuts = if (@hasField(@TypeOf(app_manifest), "shortcuts")) app_manifest.shortcuts else .{};
const manifest_menus = if (@hasField(@TypeOf(app_manifest), "menus")) app_manifest.menus else .{};
const manifest_windows = if (@hasField(@TypeOf(app_manifest), "windows")) app_manifest.windows else .{};

pub const StdoutTraceSink = struct {
    pub fn sink(self: *StdoutTraceSink) native_sdk.trace.Sink {
        return .{ .context = self, .write_fn = write };
    }

    fn write(context: *anyopaque, record: native_sdk.trace.Record) native_sdk.trace.WriteError!void {
        _ = context;
        if (!shouldTrace(record)) return;
        // Never fail on an oversized record: logging failures must
        // degrade (truncated output), not fail dispatch upstream.
        var buffer: [4096]u8 = undefined;
        std.debug.print("{s}\n", .{native_sdk.trace.formatTextBounded(record, &buffer)});
    }
};

pub const RunOptions = struct {
    app_name: []const u8,
    window_title: []const u8 = "",
    bundle_id: []const u8,
    legacy_window_state_bundle_id: ?[]const u8 = null,
    legacy_window_state_bundle_ids: []const []const u8 = &.{},
    legacy_application_support_directory_name: ?[]const u8 = null,
    icon_path: []const u8 = "assets/icon.png",
    bridge: ?native_sdk.BridgeDispatcher = null,
    builtin_bridge: native_sdk.BridgePolicy = .{},
    security: native_sdk.SecurityPolicy = .{},
    js_window_api: bool = false,
    web_inspector_enabled: bool,
    commands: ?[]const native_sdk.Command = null,
    menus: ?[]const native_sdk.Menu = null,
    shortcuts: ?[]const native_sdk.Shortcut = null,

    fn appInfo(self: RunOptions, buffers: *StateBuffers) native_sdk.AppInfo {
        var info: native_sdk.AppInfo = .{
            .app_name = self.app_name,
            .has_web_content = manifestHasWebContent(),
            .window_title = self.window_title,
            .bundle_id = self.bundle_id,
            .icon_path = self.icon_path,
        };
        const windows = manifestWindowOptions(buffers);
        if (windows.len > 0) {
            info.main_window = windows[0];
            info.windows = windows;
        }
        return info;
    }

    fn resolvedShortcuts(self: RunOptions, storage: *ShortcutStorage) []const native_sdk.Shortcut {
        return self.shortcuts orelse storage.fromManifest();
    }

    fn resolvedCommands(self: RunOptions, storage: *CommandStorage) []const native_sdk.Command {
        return self.commands orelse storage.fromManifest();
    }

    fn resolvedMenus(self: RunOptions, storage: *MenuStorage) []const native_sdk.Menu {
        return self.menus orelse storage.fromManifest();
    }
};

const CommandStorage = struct {
    commands: [native_sdk.app_manifest.max_commands]native_sdk.Command = undefined,

    fn fromManifest(self: *CommandStorage) []const native_sdk.Command {
        comptime {
            if (manifest_commands.len > native_sdk.app_manifest.max_commands) {
                @compileError("app.zon defines too many commands");
            }
        }

        inline for (manifest_commands, 0..) |command, index| {
            self.commands[index] = .{
                .id = command.id,
                .title = if (@hasField(@TypeOf(command), "title")) command.title else "",
                .enabled = if (@hasField(@TypeOf(command), "enabled")) command.enabled else true,
                .checked = if (@hasField(@TypeOf(command), "checked")) command.checked else false,
            };
        }
        return self.commands[0..manifest_commands.len];
    }
};

const MenuStorage = struct {
    menus: [native_sdk.platform.max_menus]native_sdk.Menu = undefined,
    items: [native_sdk.platform.max_menu_items]native_sdk.MenuItem = undefined,

    fn fromManifest(self: *MenuStorage) []const native_sdk.Menu {
        comptime {
            if (manifest_menus.len > native_sdk.platform.max_menus) {
                @compileError("app.zon defines too many menus");
            }
            var item_count: usize = 0;
            for (manifest_menus) |menu| {
                const items = if (@hasField(@TypeOf(menu), "items")) menu.items else .{};
                item_count += items.len;
            }
            if (item_count > native_sdk.platform.max_menu_items) {
                @compileError("app.zon defines too many menu items");
            }
        }

        var item_index: usize = 0;
        inline for (manifest_menus, 0..) |menu, menu_index| {
            const items = if (@hasField(@TypeOf(menu), "items")) menu.items else .{};
            const first_item = item_index;
            inline for (items) |item| {
                self.items[item_index] = menuItem(item);
                item_index += 1;
            }
            self.menus[menu_index] = .{
                .title = menu.title,
                .items = self.items[first_item..item_index],
            };
        }
        return self.menus[0..manifest_menus.len];
    }
};

const ShortcutStorage = struct {
    shortcuts: [native_sdk.platform.max_shortcuts]native_sdk.Shortcut = undefined,

    fn fromManifest(self: *ShortcutStorage) []const native_sdk.Shortcut {
        comptime {
            if (manifest_shortcuts.len > native_sdk.platform.max_shortcuts) {
                @compileError("app.zon defines too many shortcuts");
            }
        }

        inline for (manifest_shortcuts, 0..) |shortcut, index| {
            self.shortcuts[index] = .{
                .id = shortcut.id,
                .key = shortcut.key,
                .modifiers = shortcutModifiers(shortcut),
            };
        }
        return self.shortcuts[0..manifest_shortcuts.len];
    }
};

fn manifestWindowOptions(buffers: *StateBuffers) []const native_sdk.WindowOptions {
    comptime {
        if (manifest_windows.len > native_sdk.platform.max_windows) {
            @compileError("app.zon defines too many windows");
        }
    }

    inline for (manifest_windows, 0..) |window, index| {
        buffers.restored_windows[index] = manifestWindow(window, index);
    }
    return buffers.restored_windows[0..manifest_windows.len];
}

fn manifestWindow(comptime window: anytype, comptime index: usize) native_sdk.WindowOptions {
    return .{
        .id = index + 1,
        .label = windowLabel(window, index),
        .title = windowTitle(window),
        .default_frame = native_sdk.geometry.RectF.init(
            windowFloat(window, "x", 0),
            windowFloat(window, "y", 0),
            windowFloat(window, "width", 720),
            windowFloat(window, "height", 480),
        ),
        .resizable = windowBool(window, "resizable", true),
        .restore_state = windowBool(window, "restore_state", true),
        .restore_policy = windowRestorePolicy(window),
    };
}

fn windowLabel(comptime window: anytype, comptime index: usize) []const u8 {
    if (comptime @hasField(@TypeOf(window), "label")) return window.label;
    return if (index == 0) "main" else "window";
}

fn windowTitle(comptime window: anytype) []const u8 {
    if (comptime !@hasField(@TypeOf(window), "title")) return "";
    const title = window.title;
    if (comptime @TypeOf(title) == @TypeOf(null)) return "";
    return title;
}

fn windowFloat(comptime window: anytype, comptime field: []const u8, comptime default_value: f32) f32 {
    if (comptime @hasField(@TypeOf(window), field)) return @field(window, field);
    return default_value;
}

fn windowBool(comptime window: anytype, comptime field: []const u8, comptime default_value: bool) bool {
    if (comptime @hasField(@TypeOf(window), field)) return @field(window, field);
    return default_value;
}

fn windowRestorePolicy(comptime window: anytype) native_sdk.WindowRestorePolicy {
    if (comptime !@hasField(@TypeOf(window), "restore_policy")) return .clamp_to_visible_screen;
    const value = window.restore_policy;
    if (comptime std.mem.eql(u8, value, "clamp_to_visible_screen")) return .clamp_to_visible_screen;
    if (comptime std.mem.eql(u8, value, "center_on_primary")) return .center_on_primary;
    @compileError("unknown app.zon window restore_policy");
}

fn menuItem(comptime item: anytype) native_sdk.MenuItem {
    return .{
        .label = if (@hasField(@TypeOf(item), "label")) item.label else "",
        .command = if (@hasField(@TypeOf(item), "command")) item.command else "",
        .key = if (@hasField(@TypeOf(item), "key")) item.key else "",
        .modifiers = shortcutModifiers(item),
        .separator = if (@hasField(@TypeOf(item), "separator")) item.separator else false,
        .enabled = if (@hasField(@TypeOf(item), "enabled")) item.enabled else true,
        .checked = if (@hasField(@TypeOf(item), "checked")) item.checked else false,
    };
}

fn shortcutModifiers(comptime shortcut: anytype) native_sdk.ShortcutModifiers {
    const values = if (@hasField(@TypeOf(shortcut), "modifiers")) shortcut.modifiers else .{};
    var modifiers: native_sdk.ShortcutModifiers = .{};
    inline for (values) |value| {
        const modifier: []const u8 = value;
        if (comptime std.mem.eql(u8, modifier, "primary")) {
            modifiers.primary = true;
        } else if (comptime std.mem.eql(u8, modifier, "command")) {
            modifiers.command = true;
        } else if (comptime std.mem.eql(u8, modifier, "control")) {
            modifiers.control = true;
        } else if (comptime std.mem.eql(u8, modifier, "option") or std.mem.eql(u8, modifier, "alt")) {
            modifiers.option = true;
        } else if (comptime std.mem.eql(u8, modifier, "shift")) {
            modifiers.shift = true;
        } else {
            @compileError("unknown app.zon shortcut modifier");
        }
    }
    return modifiers;
}

pub fn runWithOptions(app: native_sdk.App, options: RunOptions, init: std.process.Init) !void {
    if (build_options.debug_overlay) {
        std.debug.print("debug-overlay=true backend={s} web-engine={s} trace={s}\n", .{ build_options.platform, build_options.web_engine, build_options.trace });
    }
    if (options.legacy_window_state_bundle_id != null and
        options.legacy_window_state_bundle_ids.len != 0)
    {
        return error.ConflictingLegacyWindowStateConfiguration;
    }
    if (options.legacy_window_state_bundle_ids.len != 0) {
        const legacy_application_support_directory_name =
            options.legacy_application_support_directory_name orelse
            return error.MissingLegacyApplicationSupportIdentity;
        try migrateLegacyWindowStates(
            init.io,
            init.environ_map,
            legacy_application_support_directory_name,
            options.legacy_window_state_bundle_ids,
            options.bundle_id,
        );
    } else if (options.legacy_window_state_bundle_id) |legacy_bundle_id| {
        const legacy_application_support_directory_name =
            options.legacy_application_support_directory_name orelse
            return error.MissingLegacyApplicationSupportIdentity;
        try migrateLegacyWindowState(
            init.io,
            init.environ_map,
            legacy_application_support_directory_name,
            legacy_bundle_id,
            options.bundle_id,
        );
    } else if (options.legacy_application_support_directory_name != null) {
        return error.MissingLegacyWindowStateIdentity;
    }
    if (comptime std.mem.eql(u8, build_options.platform, "macos")) {
        try runMacos(app, options, init);
    } else if (comptime std.mem.eql(u8, build_options.platform, "linux")) {
        try runLinux(app, options, init);
    } else if (comptime std.mem.eql(u8, build_options.platform, "windows")) {
        try runWindows(app, options, init);
    } else {
        try runNull(app, options, init);
    }
}

fn runNull(app: native_sdk.App, options: RunOptions, init: std.process.Init) !void {
    var buffers: StateBuffers = undefined;
    var app_info = options.appInfo(&buffers);
    const store = prepareStateStore(init.io, init.environ_map, &app_info, &buffers);
    var null_platform = native_sdk.NullPlatform.initWithOptions(.{}, webEngine(), app_info);
    var trace_sink = StdoutTraceSink{};
    var log_buffers: native_sdk.debug.LogPathBuffers = .{};
    const log_setup = native_sdk.debug.setupLogging(init.io, init.environ_map, app_info.bundle_id, &log_buffers) catch null;
    if (log_setup) |setup| native_sdk.debug.installPanicCapture(init.io, setup.paths);
    var file_trace_sink: native_sdk.debug.FileTraceSink = undefined;
    var fanout_sinks: [2]native_sdk.trace.Sink = undefined;
    var fanout_sink: native_sdk.debug.FanoutTraceSink = undefined;
    var runtime_trace_sink = trace_sink.sink();
    if (log_setup) |setup| {
        file_trace_sink = native_sdk.debug.FileTraceSink.init(init.io, setup.paths.log_dir, setup.paths.log_file, setup.format);
        fanout_sinks = .{ trace_sink.sink(), file_trace_sink.sink() };
        fanout_sink = .{ .sinks = &fanout_sinks };
        runtime_trace_sink = fanout_sink.sink();
    }
    var shortcut_storage: ShortcutStorage = .{};
    const shortcuts = options.resolvedShortcuts(&shortcut_storage);
    var menu_storage: MenuStorage = .{};
    const menus = options.resolvedMenus(&menu_storage);
    var command_storage: CommandStorage = .{};
    const commands = options.resolvedCommands(&command_storage);
    // The Runtime is multi-megabyte; default thread stacks overflow on a
    // stack instance, so construct it on the heap.
    const runtime = try std.heap.page_allocator.create(native_sdk.Runtime);
    defer std.heap.page_allocator.destroy(runtime);
    native_sdk.Runtime.initAt(runtime, .{
        .platform = null_platform.platform(),
        .trace_sink = runtime_trace_sink,
        .log_path = if (log_setup) |setup| setup.paths.log_file else null,
        .bridge = options.bridge,
        .builtin_bridge = options.builtin_bridge,
        .security = options.security,
        .js_window_api = options.js_window_api,
        .web_layer = webLayerEnabled(),
        .commands = commands,
        .menus = menus,
        .shortcuts = shortcuts,
        .automation = if (build_options.automation) native_sdk.automation.Server.init(init.io, ".zig-cache/native-sdk-automation", app_info.resolvedWindowTitle()) else null,
        .window_state_store = store,
        .environ = init.minimal.environ,
    });

    try runtime.run(app);
}

fn runMacos(app: native_sdk.App, options: RunOptions, init: std.process.Init) !void {
    var buffers: StateBuffers = undefined;
    var app_info = options.appInfo(&buffers);
    const store = prepareStateStore(init.io, init.environ_map, &app_info, &buffers);
    var mac_platform = try native_sdk.platform.macos.MacPlatform.initWithHostOptions(
        native_sdk.geometry.SizeF.init(720, 480),
        webEngine(),
        app_info,
        .{ .web_inspector_enabled = options.web_inspector_enabled },
    );
    defer mac_platform.deinit();
    var trace_sink = StdoutTraceSink{};
    var log_buffers: native_sdk.debug.LogPathBuffers = .{};
    const log_setup = native_sdk.debug.setupLogging(init.io, init.environ_map, app_info.bundle_id, &log_buffers) catch null;
    if (log_setup) |setup| native_sdk.debug.installPanicCapture(init.io, setup.paths);
    var file_trace_sink: native_sdk.debug.FileTraceSink = undefined;
    var fanout_sinks: [2]native_sdk.trace.Sink = undefined;
    var fanout_sink: native_sdk.debug.FanoutTraceSink = undefined;
    var runtime_trace_sink = trace_sink.sink();
    if (log_setup) |setup| {
        file_trace_sink = native_sdk.debug.FileTraceSink.init(init.io, setup.paths.log_dir, setup.paths.log_file, setup.format);
        fanout_sinks = .{ trace_sink.sink(), file_trace_sink.sink() };
        fanout_sink = .{ .sinks = &fanout_sinks };
        runtime_trace_sink = fanout_sink.sink();
    }
    var shortcut_storage: ShortcutStorage = .{};
    const shortcuts = options.resolvedShortcuts(&shortcut_storage);
    var menu_storage: MenuStorage = .{};
    const menus = options.resolvedMenus(&menu_storage);
    var command_storage: CommandStorage = .{};
    const commands = options.resolvedCommands(&command_storage);
    // The Runtime is multi-megabyte; default thread stacks overflow on a
    // stack instance, so construct it on the heap.
    const runtime = try std.heap.page_allocator.create(native_sdk.Runtime);
    defer std.heap.page_allocator.destroy(runtime);
    native_sdk.Runtime.initAt(runtime, .{
        .platform = mac_platform.platform(),
        .trace_sink = runtime_trace_sink,
        .log_path = if (log_setup) |setup| setup.paths.log_file else null,
        .bridge = options.bridge,
        .builtin_bridge = options.builtin_bridge,
        .security = options.security,
        .js_window_api = options.js_window_api,
        .web_layer = webLayerEnabled(),
        .commands = commands,
        .menus = menus,
        .shortcuts = shortcuts,
        .automation = if (build_options.automation) native_sdk.automation.Server.init(init.io, ".zig-cache/native-sdk-automation", app_info.resolvedWindowTitle()) else null,
        .window_state_store = store,
        .environ = init.minimal.environ,
    });

    try runtime.run(app);
}

fn runLinux(app: native_sdk.App, options: RunOptions, init: std.process.Init) !void {
    var buffers: StateBuffers = undefined;
    var app_info = options.appInfo(&buffers);
    const store = prepareStateStore(init.io, init.environ_map, &app_info, &buffers);
    var linux_platform = try native_sdk.platform.linux.LinuxPlatform.initWithOptions(native_sdk.geometry.SizeF.init(720, 480), webEngine(), app_info);
    defer linux_platform.deinit();
    var trace_sink = StdoutTraceSink{};
    var log_buffers: native_sdk.debug.LogPathBuffers = .{};
    const log_setup = native_sdk.debug.setupLogging(init.io, init.environ_map, app_info.bundle_id, &log_buffers) catch null;
    if (log_setup) |setup| native_sdk.debug.installPanicCapture(init.io, setup.paths);
    var file_trace_sink: native_sdk.debug.FileTraceSink = undefined;
    var fanout_sinks: [2]native_sdk.trace.Sink = undefined;
    var fanout_sink: native_sdk.debug.FanoutTraceSink = undefined;
    var runtime_trace_sink = trace_sink.sink();
    if (log_setup) |setup| {
        file_trace_sink = native_sdk.debug.FileTraceSink.init(init.io, setup.paths.log_dir, setup.paths.log_file, setup.format);
        fanout_sinks = .{ trace_sink.sink(), file_trace_sink.sink() };
        fanout_sink = .{ .sinks = &fanout_sinks };
        runtime_trace_sink = fanout_sink.sink();
    }
    var shortcut_storage: ShortcutStorage = .{};
    const shortcuts = options.resolvedShortcuts(&shortcut_storage);
    var menu_storage: MenuStorage = .{};
    const menus = options.resolvedMenus(&menu_storage);
    var command_storage: CommandStorage = .{};
    const commands = options.resolvedCommands(&command_storage);
    // The Runtime is multi-megabyte; default thread stacks overflow on a
    // stack instance, so construct it on the heap.
    const runtime = try std.heap.page_allocator.create(native_sdk.Runtime);
    defer std.heap.page_allocator.destroy(runtime);
    native_sdk.Runtime.initAt(runtime, .{
        .platform = linux_platform.platform(),
        .trace_sink = runtime_trace_sink,
        .log_path = if (log_setup) |setup| setup.paths.log_file else null,
        .bridge = options.bridge,
        .builtin_bridge = options.builtin_bridge,
        .security = options.security,
        .js_window_api = options.js_window_api,
        .web_layer = webLayerEnabled(),
        .commands = commands,
        .menus = menus,
        .shortcuts = shortcuts,
        .automation = if (build_options.automation) native_sdk.automation.Server.init(init.io, ".zig-cache/native-sdk-automation", app_info.resolvedWindowTitle()) else null,
        .window_state_store = store,
        .environ = init.minimal.environ,
    });

    try runtime.run(app);
}

fn runWindows(app: native_sdk.App, options: RunOptions, init: std.process.Init) !void {
    var buffers: StateBuffers = undefined;
    var app_info = options.appInfo(&buffers);
    const store = prepareStateStore(init.io, init.environ_map, &app_info, &buffers);
    var windows_platform = try native_sdk.platform.windows.WindowsPlatform.initWithOptions(native_sdk.geometry.SizeF.init(720, 480), webEngine(), app_info);
    defer windows_platform.deinit();
    var trace_sink = StdoutTraceSink{};
    var log_buffers: native_sdk.debug.LogPathBuffers = .{};
    const log_setup = native_sdk.debug.setupLogging(init.io, init.environ_map, app_info.bundle_id, &log_buffers) catch null;
    if (log_setup) |setup| native_sdk.debug.installPanicCapture(init.io, setup.paths);
    var file_trace_sink: native_sdk.debug.FileTraceSink = undefined;
    var fanout_sinks: [2]native_sdk.trace.Sink = undefined;
    var fanout_sink: native_sdk.debug.FanoutTraceSink = undefined;
    var runtime_trace_sink = trace_sink.sink();
    if (log_setup) |setup| {
        file_trace_sink = native_sdk.debug.FileTraceSink.init(init.io, setup.paths.log_dir, setup.paths.log_file, setup.format);
        fanout_sinks = .{ trace_sink.sink(), file_trace_sink.sink() };
        fanout_sink = .{ .sinks = &fanout_sinks };
        runtime_trace_sink = fanout_sink.sink();
    }
    var shortcut_storage: ShortcutStorage = .{};
    const shortcuts = options.resolvedShortcuts(&shortcut_storage);
    var menu_storage: MenuStorage = .{};
    const menus = options.resolvedMenus(&menu_storage);
    var command_storage: CommandStorage = .{};
    const commands = options.resolvedCommands(&command_storage);
    // The Runtime is multi-megabyte; default thread stacks overflow on a
    // stack instance, so construct it on the heap.
    const runtime = try std.heap.page_allocator.create(native_sdk.Runtime);
    defer std.heap.page_allocator.destroy(runtime);
    native_sdk.Runtime.initAt(runtime, .{
        .platform = windows_platform.platform(),
        .trace_sink = runtime_trace_sink,
        .log_path = if (log_setup) |setup| setup.paths.log_file else null,
        .bridge = options.bridge,
        .builtin_bridge = options.builtin_bridge,
        .security = options.security,
        .js_window_api = options.js_window_api,
        .web_layer = webLayerEnabled(),
        .commands = commands,
        .menus = menus,
        .shortcuts = shortcuts,
        .automation = if (build_options.automation) native_sdk.automation.Server.init(init.io, ".zig-cache/native-sdk-automation", app_info.resolvedWindowTitle()) else null,
        .window_state_store = store,
        .environ = init.minimal.environ,
    });

    try runtime.run(app);
}

fn shouldTrace(record: native_sdk.trace.Record) bool {
    if (comptime std.mem.eql(u8, build_options.trace, "off")) return false;
    if (comptime std.mem.eql(u8, build_options.trace, "all")) return true;
    if (comptime std.mem.eql(u8, build_options.trace, "events")) return true;
    return std.mem.indexOf(u8, record.name, build_options.trace) != null;
}

fn webEngine() native_sdk.WebEngine {
    if (comptime std.mem.eql(u8, build_options.web_engine, "chromium")) return .chromium;
    return .system;
}

/// Whether app.zon declares web content — the shared declare-to-use
/// contract (native_sdk.app_manifest.web_layer) over the comptime
/// manifest import: a .frontend block, the "webview" capability, a
/// .shell webview view, or .web_engine = "chromium". Hosts build
/// honest default menus from this — web items like Reload only exist
/// when a webview can answer them.
fn manifestHasWebContent() bool {
    return manifestWebDeclaration() != null;
}

/// The first web declaration visible in app.zon, evaluated at
/// comptime. The engine input is the MANIFEST engine: the runner
/// never sees the -Dweb-engine flag, so an engine resolved to
/// Chromium by flag alone stays a configure-time error in build.zig,
/// which does see the flag.
fn manifestWebDeclaration() ?native_sdk.app_manifest.web_layer.Declaration {
    const engine: native_sdk.app_manifest.WebEngine = comptime blk: {
        if (!@hasField(@TypeOf(app_manifest), "web_engine")) break :blk .system;
        break :blk native_sdk.app_manifest.web_layer.parseWebEngine(app_manifest.web_engine) orelse .system;
    };
    return comptime native_sdk.app_manifest.web_layer.webDeclaration(app_manifest, engine);
}

/// Whether this build ships the embedded web layer (build.zig's
/// -Dweb-layer inference); a build_options module that predates the
/// option keeps the layer — over-inclusion is safe.
fn webLayerEnabled() bool {
    if (comptime !@hasDecl(build_options, "web_layer")) return true;
    return build_options.web_layer;
}

// A build that excludes the web layer while app.zon declares web use
// must fail at compile time: the declared webviews of a layerless
// host would otherwise only fail later, at runtime.
comptime {
    if (!webLayerEnabled()) {
        if (manifestWebDeclaration()) |declaration| {
            @compileError("this build excludes the web layer (-Dweb-layer=exclude) but app.zon declares web use (" ++ declaration.text() ++ "); remove the exclude or drop the web declaration");
        }
    }
}

const StateBuffers = struct {
    state_dir: [1024]u8 = undefined,
    file_path: [1200]u8 = undefined,
    read: [8192]u8 = undefined,
    restored_windows: [native_sdk.platform.max_windows]native_sdk.WindowOptions = undefined,
};

const window_state_directory_name = "State";
const window_state_file_name = "windows.zon";
const legacy_control_plane_file_name = "control-plane.sqlite";
const legacy_authority_inspector_path = "/usr/sbin/lsof";
const legacy_authority_inspector_output_limit = 64 * 1024;
const legacy_authority_inspector_timeout: std.Io.Clock.Duration = .{
    .raw = .fromMilliseconds(2_000),
    .clock = .awake,
};

fn migrateLegacyWindowState(
    io: std.Io,
    env_map: *std.process.Environ.Map,
    legacy_application_support_directory_name: []const u8,
    legacy_bundle_id: []const u8,
    target_bundle_id: []const u8,
) !void {
    return migrateLegacyWindowStates(
        io,
        env_map,
        legacy_application_support_directory_name,
        &.{legacy_bundle_id},
        target_bundle_id,
    );
}

fn migrateLegacyWindowStates(
    io: std.Io,
    env_map: *std.process.Environ.Map,
    legacy_application_support_directory_name: []const u8,
    legacy_bundle_ids: []const []const u8,
    target_bundle_id: []const u8,
) !void {
    if (legacy_bundle_ids.len == 0) return error.MissingLegacyWindowStateIdentity;

    const home = env_map.get("HOME") orelse return error.MissingWindowStateHome;
    if (!std.fs.path.isAbsolute(home) or
        std.mem.eql(u8, home, "/") or
        std.mem.endsWith(u8, home, "/") or
        std.mem.indexOf(u8, home, "//") != null)
    {
        return error.InvalidWindowStateHome;
    }
    var application_support_buffer: [1024]u8 = undefined;
    const application_support_path = std.fmt.bufPrint(
        &application_support_buffer,
        "{s}/Library/Application Support",
        .{home[1..]},
    ) catch return error.WindowStatePathTooLong;
    var root = try std.Io.Dir.openDirAbsolute(io, "/", .{ .follow_symlinks = false });
    defer root.close(io);
    try migrateLegacyWindowStatePathsMany(
        root,
        io,
        application_support_path,
        legacy_application_support_directory_name,
        legacy_bundle_ids,
        target_bundle_id,
    );
}

pub fn migrateLegacyWindowStatePathsMany(
    base: std.Io.Dir,
    io: std.Io,
    application_support_path: []const u8,
    legacy_application_support_directory_name: []const u8,
    legacy_bundle_ids: []const []const u8,
    target_bundle_id: []const u8,
) !void {
    try preflightLegacyWindowStateAuthorities(
        base,
        io,
        application_support_path,
        legacy_bundle_ids,
        target_bundle_id,
    );
    for (legacy_bundle_ids) |legacy_bundle_id| {
        try migrateLegacyWindowStatePaths(
            base,
            io,
            application_support_path,
            legacy_application_support_directory_name,
            legacy_bundle_id,
            target_bundle_id,
        );
    }
}

fn preflightLegacyWindowStateAuthorities(
    base: std.Io.Dir,
    io: std.Io,
    application_support_path: []const u8,
    legacy_bundle_ids: []const []const u8,
    target_bundle_id: []const u8,
) !void {
    try validateWindowStateComponent(target_bundle_id);
    for (legacy_bundle_ids, 0..) |legacy_bundle_id, index| {
        try validateWindowStateComponent(legacy_bundle_id);
        if (std.mem.eql(u8, legacy_bundle_id, target_bundle_id)) {
            return error.WindowStateIdentityUnchanged;
        }
        for (legacy_bundle_ids[0..index]) |prior| {
            if (std.mem.eql(u8, legacy_bundle_id, prior)) {
                return error.DuplicateLegacyWindowStateIdentity;
            }
        }
    }

    var application_support = try openDirectoryPathNoFollow(
        base,
        io,
        application_support_path,
    ) orelse return;
    defer application_support.close(io);

    var nonempty_legacy_authorities: usize = 0;
    for (legacy_bundle_ids) |legacy_bundle_id| {
        const bundle = try openChildDirectoryNoFollow(
            application_support,
            io,
            legacy_bundle_id,
        );
        defer if (bundle) |directory| directory.close(io);
        const state = if (bundle) |directory|
            try openChildDirectoryNoFollow(directory, io, window_state_directory_name)
        else
            null;
        defer if (state) |directory| directory.close(io);
        if (state) |directory| {
            if (try validateWindowStateFile(directory, io) != null) {
                nonempty_legacy_authorities += 1;
            }
        }
    }
    if (nonempty_legacy_authorities > 1) {
        return error.WindowStateIdentityConflict;
    }
}

pub fn migrateLegacyWindowStatePaths(
    base: std.Io.Dir,
    io: std.Io,
    application_support_path: []const u8,
    legacy_application_support_directory_name: []const u8,
    legacy_bundle_id: []const u8,
    target_bundle_id: []const u8,
) !void {
    return migrateLegacyWindowStatePathsWithOps(
        base,
        io,
        application_support_path,
        legacy_application_support_directory_name,
        legacy_bundle_id,
        target_bundle_id,
        .{},
    );
}

pub const WindowStateMigrationOps = struct {
    authority_probe_context: ?*anyopaque = null,
    probe_legacy_authority_fn: *const fn (
        context: ?*anyopaque,
        io: std.Io,
        canonical_database_path: []const u8,
    ) anyerror!bool = probeLegacyAuthorityWithLsof,
    publication_hook_context: ?*anyopaque = null,
    after_target_publication_fn: *const fn (
        context: ?*anyopaque,
    ) anyerror!void = afterTargetPublicationNoop,

    fn afterTargetPublication(
        self: WindowStateMigrationOps,
    ) !void {
        try self.after_target_publication_fn(self.publication_hook_context);
    }

    fn legacyAuthorityIsOpen(
        self: WindowStateMigrationOps,
        io: std.Io,
        canonical_database_path: []const u8,
    ) !bool {
        return self.probe_legacy_authority_fn(
            self.authority_probe_context,
            io,
            canonical_database_path,
        );
    }
};

pub fn migrateLegacyWindowStatePathsWithOps(
    base: std.Io.Dir,
    io: std.Io,
    application_support_path: []const u8,
    legacy_application_support_directory_name: []const u8,
    legacy_bundle_id: []const u8,
    target_bundle_id: []const u8,
    ops: WindowStateMigrationOps,
) !void {
    try validateWindowStateComponent(legacy_application_support_directory_name);
    try validateWindowStateComponent(legacy_bundle_id);
    try validateWindowStateComponent(target_bundle_id);
    if (std.mem.eql(u8, legacy_bundle_id, target_bundle_id)) {
        return error.WindowStateIdentityUnchanged;
    }

    var application_support = try openDirectoryPathNoFollow(
        base,
        io,
        application_support_path,
    ) orelse return;
    defer application_support.close(io);
    try migrateLegacyWindowStateAtApplicationSupport(
        application_support,
        io,
        legacy_application_support_directory_name,
        legacy_bundle_id,
        target_bundle_id,
        ops,
    );
}

fn migrateLegacyWindowStateAtApplicationSupport(
    application_support: std.Io.Dir,
    io: std.Io,
    legacy_application_support_directory_name: []const u8,
    legacy_bundle_id: []const u8,
    target_bundle_id: []const u8,
    ops: WindowStateMigrationOps,
) !void {
    var target_bundle = try openChildDirectoryNoFollow(
        application_support,
        io,
        target_bundle_id,
    );
    defer if (target_bundle) |directory| directory.close(io);

    var target_state = if (target_bundle) |directory|
        try openChildDirectoryNoFollow(directory, io, window_state_directory_name)
    else
        null;
    defer if (target_state) |directory| directory.close(io);

    const target_file = if (target_state) |directory|
        try validateWindowStateFile(directory, io)
    else
        null;

    var prepared_receipt_name_buffer: [std.Io.Dir.max_name_bytes]u8 = undefined;
    const prepared_receipt_name = try windowStateMigrationReceiptName(
        &prepared_receipt_name_buffer,
        legacy_bundle_id,
        target_bundle_id,
        "prepared",
    );
    var published_receipt_name_buffer: [std.Io.Dir.max_name_bytes]u8 = undefined;
    const published_receipt_name = try windowStateMigrationReceiptName(
        &published_receipt_name_buffer,
        legacy_bundle_id,
        target_bundle_id,
        "published",
    );
    var completed_receipt_name_buffer: [std.Io.Dir.max_name_bytes]u8 = undefined;
    const completed_receipt_name = try windowStateMigrationReceiptName(
        &completed_receipt_name_buffer,
        legacy_bundle_id,
        target_bundle_id,
        "completed",
    );
    var empty_cutover_receipt_name_buffer: [std.Io.Dir.max_name_bytes]u8 = undefined;
    const empty_cutover_receipt_name = try windowStateMigrationReceiptName(
        &empty_cutover_receipt_name_buffer,
        legacy_bundle_id,
        target_bundle_id,
        "empty-cutover",
    );
    const receipt = if (target_state) |directory|
        try readWindowStateMigrationReceipt(
            directory,
            io,
            prepared_receipt_name,
            published_receipt_name,
            completed_receipt_name,
            empty_cutover_receipt_name,
        )
    else
        WindowStateMigrationReceipt.absent;

    switch (receipt) {
        .empty_cutover => return,
        .completed => {
            _ = target_file orelse
                return error.WindowStateMigrationPostconditionFailed;
            return;
        },
        .published => {
            _ = target_file orelse
                return error.WindowStateMigrationPostconditionFailed;
            try ensureWindowStateMigrationReceipt(
                target_state.?,
                io,
                completed_receipt_name,
            );
            return;
        },
        .prepared => {},
        .absent => {},
    }

    const legacy_bundle = try openChildDirectoryNoFollow(
        application_support,
        io,
        legacy_bundle_id,
    );
    defer if (legacy_bundle) |directory| directory.close(io);
    const legacy_state = if (legacy_bundle) |directory|
        try openChildDirectoryNoFollow(directory, io, window_state_directory_name)
    else
        null;
    defer if (legacy_state) |directory| directory.close(io);
    const legacy_file = if (legacy_state) |directory|
        try validateWindowStateFile(directory, io)
    else
        null;

    if (receipt == .absent and target_file != null and legacy_file != null) {
        return error.WindowStateIdentityConflict;
    }
    if (receipt == .prepared) {
        if (target_file) |prepared_target| {
            if (legacy_file) |source| {
                if (source.inode == prepared_target.inode) {
                    return error.WindowStateCopySharesLegacyIdentity;
                }
            }
            try ensureWindowStateMigrationReceipt(
                target_state.?,
                io,
                published_receipt_name,
            );
            try ensureWindowStateMigrationReceipt(
                target_state.?,
                io,
                completed_receipt_name,
            );
            return;
        }
    }
    if (receipt == .prepared and legacy_file == null) {
        return error.WindowStateSourceMissingAfterPreparation;
    }

    try assertLegacyAuthorityInactive(
        application_support,
        io,
        legacy_application_support_directory_name,
        ops,
    );

    if (receipt == .absent and target_file != null) {
        try ensureWindowStateMigrationReceipt(
            target_state.?,
            io,
            published_receipt_name,
        );
        try ensureWindowStateMigrationReceipt(
            target_state.?,
            io,
            completed_receipt_name,
        );
        return;
    }

    if (receipt == .absent and legacy_file == null) {
        if (target_bundle == null) {
            target_bundle = try createAndOpenChildDirectory(
                application_support,
                io,
                target_bundle_id,
            );
        }
        if (target_state == null) {
            target_state = try createAndOpenChildDirectory(
                target_bundle.?,
                io,
                window_state_directory_name,
            );
        }
        try ensureWindowStateMigrationReceipt(
            target_state.?,
            io,
            empty_cutover_receipt_name,
        );
        return;
    }

    const source = legacy_file orelse
        return error.WindowStateMigrationPostconditionFailed;
    if (target_bundle == null) {
        target_bundle = try createAndOpenChildDirectory(
            application_support,
            io,
            target_bundle_id,
        );
    }
    if (target_state == null) {
        target_state = try createAndOpenChildDirectory(
            target_bundle.?,
            io,
            window_state_directory_name,
        );
    }
    if (receipt == .absent) {
        try ensureWindowStateMigrationReceipt(
            target_state.?,
            io,
            prepared_receipt_name,
        );
    }

    var snapshot_buffer: [window_state_snapshot_limit + 1]u8 = undefined;
    const snapshot = try readLegacyWindowStateSnapshot(
        legacy_state.?,
        io,
        source.inode,
        &snapshot_buffer,
    );
    try publishIndependentWindowStateCopy(
        target_state.?,
        io,
        snapshot,
    );
    try ops.afterTargetPublication();
    try ensureWindowStateMigrationReceipt(
        target_state.?,
        io,
        published_receipt_name,
    );
    try ensureWindowStateMigrationReceipt(
        target_state.?,
        io,
        completed_receipt_name,
    );
}

const window_state_snapshot_limit = native_sdk.window_state.max_serialized_bytes;

const WindowStateSnapshot = struct {
    bytes: []const u8,
    source_inode: std.Io.File.INode,
};

fn readLegacyWindowStateSnapshot(
    legacy_state: std.Io.Dir,
    io: std.Io,
    expected_source_inode: std.Io.File.INode,
    buffer: *[window_state_snapshot_limit + 1]u8,
) !WindowStateSnapshot {
    var source_file = try legacy_state.openFile(
        io,
        window_state_file_name,
        .{
            .mode = .read_only,
            .allow_directory = false,
            .follow_symlinks = false,
        },
    );
    defer source_file.close(io);

    const before = try source_file.stat(io);
    if (before.kind != .file or before.inode != expected_source_inode) {
        return error.WindowStateSourceChangedDuringSnapshot;
    }
    if (before.size > window_state_snapshot_limit) {
        return error.WindowStateSnapshotTooLong;
    }
    const bytes_read = try source_file.readPositionalAll(io, buffer, 0);
    if (bytes_read > window_state_snapshot_limit) {
        return error.WindowStateSnapshotTooLong;
    }
    const after = try source_file.stat(io);
    const path_after = try validateWindowStateFile(legacy_state, io) orelse
        return error.WindowStateSourceChangedDuringSnapshot;
    if (!windowStateSnapshotStatIsStable(before, after) or
        !windowStateSnapshotStatIsStable(before, path_after) or
        @as(u64, bytes_read) != before.size)
    {
        return error.WindowStateSourceChangedDuringSnapshot;
    }
    return .{
        .bytes = buffer[0..bytes_read],
        .source_inode = before.inode,
    };
}

fn windowStateSnapshotStatIsStable(
    before: std.Io.File.Stat,
    after: std.Io.File.Stat,
) bool {
    return before.kind == .file and
        after.kind == .file and
        before.inode == after.inode and
        before.size == after.size and
        before.mtime.nanoseconds == after.mtime.nanoseconds and
        before.ctime.nanoseconds == after.ctime.nanoseconds;
}

fn publishIndependentWindowStateCopy(
    target_state: std.Io.Dir,
    io: std.Io,
    snapshot: WindowStateSnapshot,
) !void {
    if (try validateWindowStateFile(target_state, io)) |existing| {
        if (existing.inode == snapshot.source_inode) {
            return error.WindowStateCopySharesLegacyIdentity;
        }
        return;
    }

    var atomic_target = try target_state.createFileAtomic(
        io,
        window_state_file_name,
        .{},
    );
    defer atomic_target.deinit(io);
    try atomic_target.file.writeStreamingAll(io, snapshot.bytes);
    try atomic_target.file.sync(io);
    atomic_target.link(io) catch |err| switch (err) {
        error.PathAlreadyExists => {
            const existing = try validateWindowStateFile(target_state, io) orelse
                return error.WindowStateMigrationPostconditionFailed;
            if (existing.inode == snapshot.source_inode) {
                return error.WindowStateCopySharesLegacyIdentity;
            }
            return;
        },
        else => |link_error| return link_error,
    };
    try syncWindowStateDirectory(target_state, io);
    const published = try validateWindowStateFile(target_state, io) orelse
        return error.WindowStateMigrationPostconditionFailed;
    if (published.inode == snapshot.source_inode or
        published.size != snapshot.bytes.len)
    {
        return error.WindowStateMigrationPostconditionFailed;
    }
}

const WindowStateMigrationReceipt = enum {
    absent,
    empty_cutover,
    prepared,
    published,
    completed,
};

fn windowStateMigrationReceiptName(
    buffer: []u8,
    legacy_bundle_id: []const u8,
    target_bundle_id: []const u8,
    phase: []const u8,
) ![]const u8 {
    return std.fmt.bufPrint(
        buffer,
        ".window-state-migration-v2.from.{s}.to.{s}.{s}",
        .{ legacy_bundle_id, target_bundle_id, phase },
    ) catch return error.WindowStatePathTooLong;
}

fn readWindowStateMigrationReceipt(
    target_state: std.Io.Dir,
    io: std.Io,
    prepared_receipt_name: []const u8,
    published_receipt_name: []const u8,
    completed_receipt_name: []const u8,
    empty_cutover_receipt_name: []const u8,
) !WindowStateMigrationReceipt {
    const prepared = try validateWindowStateMigrationReceipt(
        target_state,
        io,
        prepared_receipt_name,
    );
    const published = try validateWindowStateMigrationReceipt(
        target_state,
        io,
        published_receipt_name,
    );
    const completed = try validateWindowStateMigrationReceipt(
        target_state,
        io,
        completed_receipt_name,
    );
    const empty_cutover = try validateWindowStateMigrationReceipt(
        target_state,
        io,
        empty_cutover_receipt_name,
    );
    if (empty_cutover and (prepared or published or completed)) {
        return error.InvalidWindowStateMigrationReceipt;
    }
    if (completed and !published) {
        return error.InvalidWindowStateMigrationReceipt;
    }
    if (empty_cutover) return .empty_cutover;
    if (completed) return .completed;
    if (published) return .published;
    if (prepared) return .prepared;
    return .absent;
}

fn validateWindowStateMigrationReceipt(
    target_state: std.Io.Dir,
    io: std.Io,
    receipt_name: []const u8,
) !bool {
    const receipt_stat = target_state.statFile(
        io,
        receipt_name,
        .{ .follow_symlinks = false },
    ) catch |err| switch (err) {
        error.FileNotFound => return false,
        else => |stat_error| return stat_error,
    };
    if (receipt_stat.kind != .file or
        receipt_stat.size != 0 or
        receipt_stat.nlink != 1)
    {
        return error.InvalidWindowStateMigrationReceipt;
    }
    return true;
}

fn ensureWindowStateMigrationReceipt(
    target_state: std.Io.Dir,
    io: std.Io,
    receipt_name: []const u8,
) !void {
    if (try validateWindowStateMigrationReceipt(target_state, io, receipt_name)) {
        return;
    }

    var atomic_receipt = try target_state.createFileAtomic(
        io,
        receipt_name,
        .{},
    );
    defer atomic_receipt.deinit(io);
    try atomic_receipt.file.sync(io);
    atomic_receipt.link(io) catch |err| switch (err) {
        error.PathAlreadyExists => {
            if (!try validateWindowStateMigrationReceipt(
                target_state,
                io,
                receipt_name,
            )) {
                return error.WindowStateMigrationPostconditionFailed;
            }
            return;
        },
        else => |link_error| return link_error,
    };
    try syncWindowStateDirectory(target_state, io);
    if (!try validateWindowStateMigrationReceipt(target_state, io, receipt_name)) {
        return error.WindowStateMigrationPostconditionFailed;
    }
}

fn syncWindowStateDirectory(directory: std.Io.Dir, io: std.Io) !void {
    const directory_file: std.Io.File = .{
        .handle = directory.handle,
        .flags = .{ .nonblocking = false },
    };
    try directory_file.sync(io);
}

fn assertLegacyAuthorityInactive(
    application_support: std.Io.Dir,
    io: std.Io,
    legacy_application_support_directory_name: []const u8,
    ops: WindowStateMigrationOps,
) !void {
    var legacy_application_support = try openChildDirectoryNoFollow(
        application_support,
        io,
        legacy_application_support_directory_name,
    ) orelse return;
    defer legacy_application_support.close(io);

    const database_stat = legacy_application_support.statFile(
        io,
        legacy_control_plane_file_name,
        .{ .follow_symlinks = false },
    ) catch |err| switch (err) {
        error.FileNotFound => return,
        else => |stat_error| return stat_error,
    };
    if (database_stat.kind != .file) {
        return error.UnsafeLegacyApplicationSupportPath;
    }

    var canonical_database_path_buffer: [std.Io.Dir.max_path_bytes]u8 = undefined;
    const canonical_database_path_length = try legacy_application_support.realPathFile(
        io,
        legacy_control_plane_file_name,
        &canonical_database_path_buffer,
    );
    const canonical_database_path =
        canonical_database_path_buffer[0..canonical_database_path_length];

    if (try ops.legacyAuthorityIsOpen(io, canonical_database_path)) {
        return error.LegacyApplicationSupportAuthorityInUse;
    }
}

fn probeLegacyAuthorityWithLsof(
    context: ?*anyopaque,
    io: std.Io,
    canonical_database_path: []const u8,
) !bool {
    _ = context;
    if (comptime builtin.os.tag != .macos) return false;

    var inspector_environment = std.process.Environ.Map.init(std.heap.page_allocator);
    defer inspector_environment.deinit();
    try inspector_environment.put("LANG", "C");
    try inspector_environment.put("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");

    const result = try std.process.run(std.heap.page_allocator, io, .{
        .argv = &.{
            legacy_authority_inspector_path,
            "-F",
            "pn",
            "--",
            canonical_database_path,
        },
        .environ_map = &inspector_environment,
        .stdout_limit = .limited(legacy_authority_inspector_output_limit),
        .stderr_limit = .limited(legacy_authority_inspector_output_limit),
        .timeout = .{ .duration = legacy_authority_inspector_timeout },
    });
    defer std.heap.page_allocator.free(result.stdout);
    defer std.heap.page_allocator.free(result.stderr);

    const status = switch (result.term) {
        .exited => |exit_status| exit_status,
        .signal, .stopped, .unknown => {
            return error.LegacyAuthorityInspectionDidNotComplete;
        },
    };
    return interpretLegacyAuthorityInspection(
        status,
        result.stdout,
        result.stderr,
        canonical_database_path,
    );
}

fn interpretLegacyAuthorityInspection(
    status: u8,
    stdout: []const u8,
    stderr: []const u8,
    canonical_database_path: []const u8,
) !bool {
    if (status == 1 and stdout.len == 0 and stderr.len == 0) return false;
    if (status != 0) return error.LegacyAuthorityInspectionFailed;
    return parseLegacyAuthorityInspection(stdout, canonical_database_path);
}

fn parseLegacyAuthorityInspection(
    output: []const u8,
    canonical_database_path: []const u8,
) !bool {
    var saw_process = false;
    var saw_exact_path = false;
    var records = std.mem.splitScalar(u8, output, '\n');
    while (records.next()) |record| {
        if (record.len == 0) continue;
        if (isValidLsofProcessRecord(record)) {
            saw_process = true;
            continue;
        }
        if (isValidLsofFileDescriptorRecord(record)) continue;
        if (record[0] == 'n' and
            std.mem.eql(u8, record[1..], canonical_database_path))
        {
            saw_exact_path = true;
            continue;
        }
        return error.MalformedLegacyAuthorityInspection;
    }
    if (!saw_process or !saw_exact_path) {
        return error.InexactLegacyAuthorityInspection;
    }
    return true;
}

fn isValidLsofProcessRecord(record: []const u8) bool {
    if (record.len < 2 or record[0] != 'p' or
        record[1] < '1' or record[1] > '9')
    {
        return false;
    }
    for (record[2..]) |byte| {
        if (byte < '0' or byte > '9') return false;
    }
    return true;
}

fn isValidLsofFileDescriptorRecord(record: []const u8) bool {
    if (record.len < 2 or record[0] != 'f') return false;
    const descriptor = record[1..];
    if (std.mem.eql(u8, descriptor, "cwd") or
        std.mem.eql(u8, descriptor, "rtd") or
        std.mem.eql(u8, descriptor, "txt") or
        std.mem.eql(u8, descriptor, "mem") or
        std.mem.eql(u8, descriptor, "NOFD"))
    {
        return true;
    }
    var index: usize = 0;
    while (index < descriptor.len and
        descriptor[index] >= '0' and descriptor[index] <= '9')
    {
        index += 1;
    }
    if (index == 0) return false;
    for (descriptor[index..]) |byte| {
        if (byte < 'a' or byte > 'z') return false;
    }
    return true;
}

test "legacy authority inspection requires an exact lsof process and path" {
    const path = "/tmp/OPRTE/control-plane.sqlite";
    try std.testing.expect(try parseLegacyAuthorityInspection(
        "p42\nf12u\nn/tmp/OPRTE/control-plane.sqlite\n",
        path,
    ));
    try std.testing.expectError(
        error.InexactLegacyAuthorityInspection,
        parseLegacyAuthorityInspection("p42\nf12u\n", path),
    );
    try std.testing.expectError(
        error.MalformedLegacyAuthorityInspection,
        parseLegacyAuthorityInspection(
            "p42\nf12u\nn/tmp/Other/control-plane.sqlite\n",
            path,
        ),
    );
    try std.testing.expectError(
        error.MalformedLegacyAuthorityInspection,
        parseLegacyAuthorityInspection(
            "p0\nf12u\nn/tmp/OPRTE/control-plane.sqlite\n",
            path,
        ),
    );
}

test "legacy authority inspection rejects status-one stderr" {
    try std.testing.expect(!try interpretLegacyAuthorityInspection(
        1,
        "",
        "",
        "/tmp/OPRTE/control-plane.sqlite",
    ));
    try std.testing.expectError(
        error.LegacyAuthorityInspectionFailed,
        interpretLegacyAuthorityInspection(
            1,
            "",
            "lsof: inconclusive warning\n",
            "/tmp/OPRTE/control-plane.sqlite",
        ),
    );
}

fn afterTargetPublicationNoop(
    context: ?*anyopaque,
) !void {
    _ = context;
}

fn validateWindowStateFile(
    state_directory: std.Io.Dir,
    io: std.Io,
) !?std.Io.File.Stat {
    const file_stat = state_directory.statFile(
        io,
        window_state_file_name,
        .{ .follow_symlinks = false },
    ) catch |err| switch (err) {
        error.FileNotFound => return null,
        else => |stat_error| return stat_error,
    };
    if (file_stat.kind != .file) return error.UnsafeWindowStatePath;
    return file_stat;
}

fn openDirectoryPathNoFollow(
    base: std.Io.Dir,
    io: std.Io,
    relative_path: []const u8,
) !?std.Io.Dir {
    if (relative_path.len == 0 or
        std.fs.path.isAbsolute(relative_path) or
        std.mem.endsWith(u8, relative_path, "/") or
        std.mem.indexOf(u8, relative_path, "//") != null)
    {
        return error.InvalidWindowStatePath;
    }

    var components = std.mem.splitScalar(u8, relative_path, '/');
    var current: ?std.Io.Dir = null;
    errdefer if (current) |directory| directory.close(io);
    while (components.next()) |component| {
        try validateWindowStateComponent(component);
        const parent = current orelse base;
        const next = try openChildDirectoryNoFollow(parent, io, component) orelse {
            if (current) |directory| directory.close(io);
            return null;
        };
        if (current) |directory| directory.close(io);
        current = next;
    }
    return current orelse error.InvalidWindowStatePath;
}

fn openChildDirectoryNoFollow(
    parent: std.Io.Dir,
    io: std.Io,
    component: []const u8,
) !?std.Io.Dir {
    try validateWindowStateComponent(component);
    return parent.openDir(io, component, .{
        .follow_symlinks = false,
    }) catch |err| switch (err) {
        error.FileNotFound => null,
        error.NotDir, error.SymLinkLoop => error.UnsafeWindowStatePath,
        else => |open_error| return open_error,
    };
}

fn createAndOpenChildDirectory(
    parent: std.Io.Dir,
    io: std.Io,
    component: []const u8,
) !std.Io.Dir {
    try validateWindowStateComponent(component);
    const created = created: {
        parent.createDir(io, component, .default_dir) catch |err| switch (err) {
            error.PathAlreadyExists => break :created false,
            else => |create_error| return create_error,
        };
        break :created true;
    };
    if (created) {
        try syncWindowStateDirectory(parent, io);
    }
    return (try openChildDirectoryNoFollow(parent, io, component)) orelse
        error.WindowStateMigrationRace;
}

fn validateWindowStateComponent(component: []const u8) !void {
    if (component.len == 0 or
        std.mem.eql(u8, component, ".") or
        std.mem.eql(u8, component, "..") or
        std.mem.indexOfScalar(u8, component, 0) != null or
        std.mem.indexOfScalar(u8, component, '/') != null or
        std.mem.indexOfScalar(u8, component, '\\') != null)
    {
        return error.InvalidWindowStatePath;
    }
}

fn prepareStateStore(io: std.Io, env_map: *std.process.Environ.Map, app_info: *native_sdk.AppInfo, buffers: *StateBuffers) ?native_sdk.window_state.Store {
    const paths = native_sdk.window_state.defaultPaths(&buffers.state_dir, &buffers.file_path, app_info.bundle_id, native_sdk.debug.envFromMap(env_map)) catch return null;
    const store = native_sdk.window_state.Store.init(io, paths.state_dir, paths.file_path);
    if (app_info.windows.len > 0) {
        const restored_windows = buffers.restored_windows[0..app_info.windows.len];
        for (restored_windows, 0..) |*window, index| {
            if (!window.restore_state) continue;
            if (store.loadWindow(window.label, &buffers.read) catch null) |saved| {
                window.default_frame = saved.frame;
                if (index == 0) app_info.main_window.default_frame = saved.frame;
            }
        }
    } else if (app_info.main_window.restore_state) {
        if (store.loadWindow(app_info.main_window.label, &buffers.read) catch null) |saved| {
            app_info.main_window.default_frame = saved.frame;
        }
    }
    return store;
}
