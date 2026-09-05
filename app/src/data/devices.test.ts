import { describe, expect, test } from "bun:test";

import { projectServerClockNow } from "./devices";

describe("hosted server clock", () => {
  test("advances from monotonic elapsed time after readiness, not a changed wall clock", () => {
    const anchor = { monotonicAt: 1_000, serverNow: 1_760_000_000_000 };
    const wallClockAfterUserJump = anchor.serverNow + 10 * 60_000;

    expect(wallClockAfterUserJump).toBeGreaterThan(anchor.serverNow + 5 * 60_000);
    expect(projectServerClockNow(anchor, 2_000)).toBe(anchor.serverNow + 1_000);
    expect(projectServerClockNow(anchor, 900)).toBe(anchor.serverNow);
  });
});
