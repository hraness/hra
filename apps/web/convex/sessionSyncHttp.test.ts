import { describe, expect, test } from "bun:test";
import {
  canonicalSessionSyncJson,
  legacyOprteSessionSyncHttpRoutes,
  parseSessionSyncResponseJson,
  sessionSyncHttpRoutes,
} from "@hraness/agent-tasks-protocol";

import http from "./http";
import {
  sessionSyncHttpOperation,
  sessionSyncHttpStatus,
} from "./sessionSyncHttp";

describe("session sync HTTP surface", () => {
  test("registers only the exact authenticated POST routes", () => {
    for (const path of Object.values(sessionSyncHttpRoutes)) {
      expect(http.lookup(path, "POST")).not.toBeNull();
      expect(http.lookup(path, "GET")).toBeNull();
    }
    for (const path of Object.values(legacyOprteSessionSyncHttpRoutes)) {
      expect(http.lookup(path, "POST")).not.toBeNull();
      expect(http.lookup(path, "GET")).toBeNull();
    }
    expect(http.lookup("/v1/kitchen/session-sync", "POST")).toBeNull();
    expect(http.lookup(`${sessionSyncHttpRoutes.execute}/extra`, "POST")).toBeNull();
  });

  test("normalizes every exact OPRTE compatibility route to its HRA operation", () => {
    for (const operation of Object.keys(sessionSyncHttpRoutes) as Array<
      keyof typeof sessionSyncHttpRoutes
    >) {
      expect(sessionSyncHttpOperation(sessionSyncHttpRoutes[operation])).toBe(
        operation,
      );
      expect(
        sessionSyncHttpOperation(legacyOprteSessionSyncHttpRoutes[operation]),
      ).toBe(operation);
    }
    expect(sessionSyncHttpOperation("/v1/kitchen/session-sync/negotiate"))
      .toBeNull();
    expect(sessionSyncHttpOperation(`${sessionSyncHttpRoutes.execute}/extra`))
      .toBeNull();
  });

  test("maps typed domain failures to stable retry-aware statuses", () => {
    expect(sessionSyncHttpStatus({ ok: true, responseJson: "{}" })).toBe(200);
    expect(sessionSyncHttpStatus({ ok: false, code: "AUTHENTICATION_FAILED" })).toBe(401);
    expect(sessionSyncHttpStatus({ ok: false, code: "STALE_BOOT" })).toBe(409);
    expect(sessionSyncHttpStatus({ ok: false, code: "QUOTA_EXCEEDED" })).toBe(429);
    expect(sessionSyncHttpStatus({ ok: false, code: "SERVICE_UNAVAILABLE" })).toBe(503);
  });

  test("parses decoded operation responses through the shared bounded wire", () => {
    const parsed = parseSessionSyncResponseJson(canonicalSessionSyncJson({
      kind: "boot_current",
      vault: {
        tenantId: `synctenant_${"t".repeat(32)}`,
        organizationId: `syncorg_${"o".repeat(32)}`,
        ownerUserId: `syncuser_${"u".repeat(32)}`,
        vaultId: `syncvault_${"v".repeat(32)}`,
        vaultGeneration: "1",
      },
      bootGeneration: "2",
      bootId: `syncboot_${"b".repeat(32)}`,
      heartbeatSequence: "7",
    }));
    expect(parsed.kind).toBe("boot_current");
    if (parsed.kind !== "boot_current") throw new Error("unexpected response kind");
    expect(String(parsed.bootGeneration)).toBe("2");
    expect(String(parsed.bootId)).toBe(`syncboot_${"b".repeat(32)}`);
    expect(String(parsed.heartbeatSequence)).toBe("7");
  });
});
