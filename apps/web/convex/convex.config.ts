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
    HRA_SESSION_SYNC_ENABLED: v.optional(v.string()),
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
    TASKCTL_LOCAL_FIXTURE_ISSUER: v.optional(v.string()),
    TASKCTL_LOCAL_FIXTURE_JWKS_URL: v.optional(v.string()),
    TASKCTL_LOCAL_FIXTURE_SUBJECT: v.optional(v.string()),
    SUITE_IDENTITY_LINK_KEYS: v.optional(v.string()),
    SUITE_IDENTITY_RECEIPT_KEY_VERSION: v.optional(v.string()),
    WORKOS_API_KEY: v.optional(v.string()),
    WORKOS_CLIENT_ID: v.optional(v.string()),
    WORKOS_OWNER_ROLE_SLUG: v.optional(v.string()),
    WORKOS_API_HOSTNAME: v.optional(v.string()),
    WORKOS_API_HTTPS: v.optional(v.string()),
    WORKOS_API_PORT: v.optional(v.string()),
    WORKOS_WEBHOOK_SECRET: v.optional(v.string()),
  },
});
