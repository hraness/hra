const std = @import("std");

const direct_invocation_requests = [_][]const u8{
    "printf '%s' '{\"version\":1,\"action\":\"read\"}' | \"$1\"",
    "printf '%s' '{\"version\":1,\"action\":\"setIfAbsent\",\"value\":\"{\\\"version\\\":1,\\\"algorithm\\\":\\\"hkdf-sha256\\\",\\\"key\\\":\\\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\\"}\"}' | \"$1\"",
    "printf '%s' '{\"version\":1,\"action\":\"delete\"}' | \"$1\"",
};

/// Runs the ReleaseFast helper under a deliberately non-HRA shell parent.
/// Every valid action must be rejected before request parsing and therefore
/// before any SecItem operation. That boundary is observable as exit 1 with
/// no stdout: all post-authorization protocol failures emit a JSON response.
pub fn main(init: std.process.Init) !void {
    var arguments = std.process.Args.Iterator.init(init.minimal.args);
    defer arguments.deinit();
    if (!arguments.skip()) return error.MissingProgramArgument;
    const helper_path = arguments.next() orelse return error.MissingHelperPath;
    if (arguments.next() != null) return error.UnexpectedArgument;

    for (direct_invocation_requests) |command| {
        const result = try std.process.run(init.gpa, init.io, .{
            .argv = &.{
                "/bin/sh",
                "-c",
                command,
                "oprte-keychain-parent-probe",
                helper_path,
            },
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
            return error.UnauthorizedHelperProducedOutput;
        }
        switch (result.term) {
            .exited => |status| if (status != 1) {
                return error.UnauthorizedHelperWasNotRejected;
            },
            .signal, .stopped, .unknown => {
                return error.UnauthorizedHelperDidNotExitNormally;
            },
        }
    }
}
