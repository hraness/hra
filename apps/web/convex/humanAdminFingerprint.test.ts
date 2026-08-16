import { describe, expect, test } from "bun:test";

import { humanAdminRequestFingerprint } from "./humanAdminFingerprint";
import { assertRequestMetadata } from "./domain";

describe("human admin request fingerprints", () => {
  test("matches SHA-256 fixed vectors", () => {
    expect(humanAdminRequestFingerprint("")).toBe(
      "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    );
    expect(humanAdminRequestFingerprint("abc")).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });

  test("is deterministic and order-sensitive", () => {
    const left = JSON.stringify(["workspace.roles.set", "wsp_A", "usr_A", ["viewer", "planner"]]);
    const right = JSON.stringify(["workspace.roles.set", "wsp_A", "usr_A", ["planner", "viewer"]]);
    expect(humanAdminRequestFingerprint(left)).toBe(humanAdminRequestFingerprint(left));
    expect(humanAdminRequestFingerprint(left)).not.toBe(humanAdminRequestFingerprint(right));
  });

  test("does not let the public v.string boundary weaken UUIDv7 receipts", () => {
    const checked = assertRequestMetadata({
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
      requestDigest: humanAdminRequestFingerprint("public-human-admin-command"),
      requestId: "req_00000000000000000000000000",
      now: Date.now(),
    });
    expect(checked.ok).toBeFalse();
    if (!checked.ok) expect(checked.error.code).toBe("IDEMPOTENCY_REQUIRED");
  });
});
