import { describe, expect, test } from "bun:test";

import {
  parseNotificationEmailPolicy,
  parseNotificationEmailPolicyResult,
} from "./notification-email-contract";
import { notificationEmailPolicySchema } from "./notification-email";

describe("notification email policy", () => {
  test("parses only the exact browser-safe v1 policy", () => {
    const policy = { enabled: false, revision: 1, version: 1 } as const;
    expect(parseNotificationEmailPolicy(policy)).toEqual(policy);
    expect(notificationEmailPolicySchema.parse({
      enabled: true,
      revision: Number.MAX_SAFE_INTEGER,
      version: 1,
    })).toEqual({
      enabled: true,
      revision: Number.MAX_SAFE_INTEGER,
      version: 1,
    });
    for (const candidate of [
      { ...policy, extra: true },
      { ...policy, enabled: 1 },
      { ...policy, revision: 0 },
      { ...policy, revision: 1.5 },
      { ...policy, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...policy, version: 2 },
      null,
      [],
    ]) expect(parseNotificationEmailPolicy(candidate)).toBeNull();
  });

  test("does not invoke accessors or accept inherited authority", () => {
    let reads = 0;
    const accessor: Record<string, unknown> = { enabled: false, revision: 1 };
    Object.defineProperty(accessor, "version", {
      enumerable: true,
      get: () => {
        reads += 1;
        return 1;
      },
    });
    expect(parseNotificationEmailPolicy(accessor)).toBeNull();
    expect(reads).toBe(0);

    const inherited = Object.create({ enabled: false }) as Record<string, unknown>;
    inherited.revision = 1;
    inherited.version = 1;
    expect(parseNotificationEmailPolicy(inherited)).toBeNull();

    const throwing = new Proxy({}, {
      ownKeys: () => { throw new Error("foreign proxy"); },
    });
    expect(() => parseNotificationEmailPolicyResult(throwing)).not.toThrow();
    expect(parseNotificationEmailPolicy(throwing)).toBeNull();
  });
});
