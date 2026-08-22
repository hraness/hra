import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: v.optional(v.string()),
    HRA_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION:
      v.optional(v.string()),
    HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS: v.optional(v.string()),
    HRA_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION:
      v.optional(v.string()),
    HRA_IDENTITY_CUTOVER_ENABLED: v.optional(v.string()),
    HRA_SESSION_SYNC_ENABLED: v.optional(v.string()),
    JWKS: v.string(),
    JWT_PRIVATE_KEY: v.string(),
    NEXT_PUBLIC_SITE_URL: v.string(),
    OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT: v.optional(v.string()),
    OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_CURRENT_VERSION:
      v.optional(v.string()),
    OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS: v.optional(v.string()),
    OPRTE_HOSTED_MUTATION_FINGERPRINT_KEY_PREVIOUS_VERSION:
      v.optional(v.string()),
    OPRTE_SESSION_SYNC_ENABLED: v.optional(v.string()),
    TASKCTL_CREDENTIAL_PEPPER_CURRENT: v.optional(v.string()),
    TASKCTL_CREDENTIAL_PEPPER_CURRENT_VERSION: v.optional(v.string()),
    TASKCTL_CREDENTIAL_PEPPER_PREVIOUS: v.optional(v.string()),
    TASKCTL_CREDENTIAL_PEPPER_PREVIOUS_VERSION: v.optional(v.string()),
    TASKCTL_ENROLLMENT_PEPPER_CURRENT: v.optional(v.string()),
    TASKCTL_ENROLLMENT_PEPPER_CURRENT_VERSION: v.optional(v.string()),
    TASKCTL_ENROLLMENT_PEPPER_PREVIOUS: v.optional(v.string()),
    TASKCTL_ENROLLMENT_PEPPER_PREVIOUS_VERSION: v.optional(v.string()),
    TASKCTL_LOCAL_FIXTURES_ENABLED: v.optional(v.string()),
    TASKCTL_LOCAL_FIXTURE_SUBJECT: v.optional(v.string()),
    SITE_URL: v.string(),
    SUITE_IDENTITY_LINK_KEYS: v.optional(v.string()),
    SUITE_IDENTITY_RECEIPT_KEY_VERSION: v.optional(v.string()),
  },
});
