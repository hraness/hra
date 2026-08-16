import { describe, expect, test } from "bun:test";

import { parseHostedMutationFingerprintKeyring } from "./hostedMutationFingerprint";

const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"; // gitleaks:allow - deterministic test vector

describe("hosted mutation fingerprint environment cutover", () => {
  test("reads unchanged OPRTE deployment values through the HRA boundary", () => {
    expect(parseHostedMutationFingerprintKeyring({
      OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: KEY,
      OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION: "v1",
    })).toEqual({
      current: { key: KEY, version: "v1" },
      previous: null,
    });
  });

  test("accepts equal dual names and rejects every conflicting pair", () => {
    expect(parseHostedMutationFingerprintKeyring({
      HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: KEY,
      HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION: "v1",
      OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: KEY,
      OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION: "v1",
    })).not.toBeNull();
    expect(parseHostedMutationFingerprintKeyring({
      HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: KEY,
      HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION: "v2",
      OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: KEY,
      OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION: "v1",
    })).toBeNull();
  });
});
