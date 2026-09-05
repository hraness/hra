import { describe, expect, test } from "bun:test";
import { basename, join } from "node:path";

import { HOSTED_PUBLIC_FUNCTION_AUTHORITY } from "./publicAuthorityPolicy";

const publicBuilderExport = /^export const ([A-Za-z][A-Za-z0-9_]*) = (?:query|mutation|action)\(/gmu;
const convexAuthExport = /^export const (isAuthenticated|signIn|signOut) = configuredAuth\.[A-Za-z]+;/gmu;

const publicFunctionExports = async (): Promise<readonly string[]> => {
  const root = import.meta.dir;
  const functions: string[] = [];
  for await (const relative of new Bun.Glob("*.ts").scan({ cwd: root })) {
    if (relative.endsWith(".test.ts") || relative === "server.ts") continue;
    const moduleName = basename(relative, ".ts");
    const source = await Bun.file(join(root, relative)).text();
    for (const pattern of [publicBuilderExport, convexAuthExport]) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const exportName = match[1];
        if (exportName === undefined) throw new Error("Public function export scan lost its name.");
        functions.push(`${moduleName}:${exportName}`);
      }
    }
  }
  return functions.sort();
};

describe("hosted public authority policy", () => {
  test("classifies every public query, mutation, action, and auth entrypoint exactly once", async () => {
    const discovered = await publicFunctionExports();
    expect(new Set(discovered).size).toBe(discovered.length);
    expect(discovered).toEqual(Object.keys(HOSTED_PUBLIC_FUNCTION_AUTHORITY).sort());
    expect(HOSTED_PUBLIC_FUNCTION_AUTHORITY["attentionNotifications:authorityStatus"])
      .toBe("active_daemon_device");
    expect(HOSTED_PUBLIC_FUNCTION_AUTHORITY["attentionNotifications:reconcile"])
      .toBe("active_daemon_device");
    expect(Object.values(HOSTED_PUBLIC_FUNCTION_AUTHORITY).every((policy) => [
      "active_device",
      "active_daemon_device",
      "convex_auth",
      "public_release_attestation",
      "registered_device",
      "status_capability",
      "verified_identity",
      "verified_identity_and_device_signature",
    ].includes(policy))).toBe(true);
  });

  test("keeps delivery effects behind internal-only functions", async () => {
    const discovered = await publicFunctionExports();
    expect(discovered.filter((name) => name.startsWith("attentionNotifications:")))
      .toEqual([
        "attentionNotifications:authorityStatus",
        "attentionNotifications:reconcile",
      ]);
    for (const forbidden of [
      "attentionNotifications:claimNext",
      "attentionNotifications:settleAttempt",
      "attentionNotificationDelivery:deliver",
      "attentionNotificationDelivery:drain",
    ]) expect(discovered).not.toContain(forbidden);
  });
});
