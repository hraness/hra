const std = @import("std");

/// Replaces this tiny process with one fixed caller-supplied command after
/// binding its current directory to the directory descriptor received as
/// standard input. The gateway owns argv and environment validation; this
/// helper owns only the fchdir-to-exec boundary that Bun cannot express.
/// It must preserve the inherited process group: packaged Git, sandbox-exec,
/// and every synchronous Git helper remain inside Native's gateway-generation
/// fence across each exec and fork.
pub fn main(init: std.process.Init) !void {
    var arguments = std.process.Args.Iterator.init(init.minimal.args);
    _ = arguments.skip();

    var command: std.ArrayList([]const u8) = .empty;
    defer command.deinit(init.gpa);
    while (arguments.next()) |argument| {
        try command.append(init.gpa, argument);
    }
    if (command.items.len == 0 or command.items.len > 512) {
        return error.InvalidArguments;
    }

    const descriptor = std.posix.STDIN_FILENO;
    const metadata = try (std.Io.File{
        .handle = descriptor,
        .flags = .{ .nonblocking = false },
    }).stat(init.io);
    if (metadata.kind != .directory) {
        return error.InvalidDirectoryDescriptor;
    }
    switch (std.posix.errno(std.c.fchdir(descriptor))) {
        .SUCCESS => {},
        else => return error.DirectoryBindingFailed,
    }

    return std.process.replace(init.io, .{
        .argv = command.items,
        .environ_map = init.environ_map,
    });
}
