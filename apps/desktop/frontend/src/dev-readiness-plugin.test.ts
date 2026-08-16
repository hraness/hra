import { describe, expect, test } from "bun:test";

import {
  devReadinessResponseForRequest,
  devSessionIdForVite,
  hraDevReadinessPlugin,
} from "../vite.config";
import {
  devSessionIdFromBytes,
  HRA_DEV_READY_PATH,
  HRA_DEV_READY_SCHEMA,
  HRA_DEV_SESSION_ENV,
} from "../../runtime/dev-protocol";

const sessionId = devSessionIdFromBytes(new Uint8Array(32).fill(0xa5));

describe("HRA Vite development readiness plugin", () => {
  test("serves exact no-store JSON only at the fixed GET endpoint", () => {
    const response = devReadinessResponseForRequest(
      "GET",
      HRA_DEV_READY_PATH,
      sessionId,
    );
    expect(response).toBeDefined();
    expect(response?.statusCode).toBe(200);
    expect(response?.headers).toMatchObject({
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    expect(JSON.parse(response?.body ?? "null")).toEqual({
      schema: HRA_DEV_READY_SCHEMA,
      sessionId,
    });
    expect(devReadinessResponseForRequest("GET", "/", sessionId)).toBeUndefined();
    expect(devReadinessResponseForRequest(
      "GET",
      `${HRA_DEV_READY_PATH}?stale=1`,
      sessionId,
    )).toBeUndefined();
    expect(devReadinessResponseForRequest(
      "POST",
      HRA_DEV_READY_PATH,
      sessionId,
    )).toMatchObject({ statusCode: 405, body: "" });
  });

  test("registers as a serve-only plugin", () => {
    const plugin = hraDevReadinessPlugin(sessionId);
    expect(plugin.apply).toBe("serve");
    expect(plugin.name).toBe("hra-dev-readiness");
    expect(typeof plugin.configureServer).toBe("function");
  });

  test("accepts a launcher nonce, creates a UI-only nonce, and rejects malformed overrides", () => {
    expect(devSessionIdForVite({ [HRA_DEV_SESSION_ENV]: sessionId })).toBe(sessionId);
    expect(devSessionIdForVite(
      {},
      () => new Uint8Array(32).fill(0x5c),
    )).toBe(devSessionIdFromBytes(new Uint8Array(32).fill(0x5c)));
    for (const invalid of ["", "A".repeat(64), "0".repeat(63), "g".repeat(64)]) {
      expect(() => devSessionIdForVite({ [HRA_DEV_SESSION_ENV]: invalid })).toThrow(
        "canonical 32-byte lowercase hexadecimal",
      );
    }
  });
});
