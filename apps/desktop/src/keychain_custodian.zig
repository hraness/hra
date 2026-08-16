const std = @import("std");

extern fn hra_keychain_custodian_main() c_int;

pub fn main() u8 {
    const status = hra_keychain_custodian_main();
    return @intCast(@min(@max(status, 0), 255));
}

test "custodian executable keeps a native-only entrypoint" {
    try std.testing.expect(@TypeOf(hra_keychain_custodian_main) == fn () callconv(.c) c_int);
}
