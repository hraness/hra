const std = @import("std");

/// Runs the helper from an ad-hoc executable with the raw Debug host identifier.
/// The helper must reject this identifier-only impersonator before reading its
/// bounded JSON protocol or reaching any SecItem action.
pub fn main(init: std.process.Init) !void {
    var arguments = std.process.Args.Iterator.init(init.minimal.args);
    defer arguments.deinit();
    if (!arguments.skip()) return error.MissingProgramArgument;
    const helper_path = arguments.next() orelse return error.MissingHelperPath;
    if (arguments.next() != null) return error.UnexpectedArgument;

    const result = try std.process.run(init.gpa, init.io, .{
        .argv = &.{helper_path},
        .stdout_limit = .limited(512),
        .stderr_limit = .limited(512),
        .timeout = .{ .duration = .{
            .raw = .fromSeconds(5),
            .clock = .awake,
        } },
    });
    defer init.gpa.free(result.stdout);
    defer init.gpa.free(result.stderr);

    if (result.stdout.len != 0 or result.stderr.len != 0) {
        return error.IdentifierOnlyParentWasAccepted;
    }
    switch (result.term) {
        .exited => |status| if (status != 1) {
            return error.IdentifierOnlyParentWasNotRejected;
        },
        .signal, .stopped, .unknown => {
            return error.DevelopmentHelperDidNotExitNormally;
        },
    }
}
