import { describe, expect, test } from "bun:test";

import {
  createClaudeProviderAccountId,
  createDevinProviderAccountId,
  providerAccountAuthoritySchema,
} from "./provider-accounts";

describe("exact provider account authority", () => {
  test("keeps three independent opaque identity namespaces and rejects borrowed identities", () => {
    const ids = {
      codex: `acct_${"1".repeat(32)}`,
      claude: createClaudeProviderAccountId(),
      devin: createDevinProviderAccountId(),
    };
    expect(ids.claude).toMatch(/^pact_[0-9a-f]{32}$/u);
    expect(ids.devin).toMatch(/^dact_[0-9a-f]{32}$/u);
    for (const provider of ["codex", "claude", "devin"] as const) {
      const authority = {
        profileId: ids.codex,
        provider,
        providerAccountId: ids[provider],
        bindingGeneration: 2,
        processGeneration: 0,
      };
      expect(providerAccountAuthoritySchema.parse(authority)).toEqual(authority);
      expect(providerAccountAuthoritySchema.safeParse({ ...authority, extra: true }).success).toBe(false);
      for (const other of ["codex", "claude", "devin"] as const) {
        expect(providerAccountAuthoritySchema.safeParse({
          ...authority,
          providerAccountId: ids[other],
        }).success).toBe(provider === other);
      }
      for (const generation of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(providerAccountAuthoritySchema.safeParse({ ...authority, processGeneration: generation }).success).toBe(false);
      }
      expect(providerAccountAuthoritySchema.safeParse({ ...authority, bindingGeneration: 0 }).success).toBe(false);
    }
  });
});
