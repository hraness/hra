import { v } from "convex/values";

import {
  createSuiteReceiptProviderProof,
  parseSuiteReceiptKeyring,
  selectSuiteReceiptConfiguration,
} from "../suite-account-receipts";
import { internalQuery } from "./_generated/server";

const auditStatusValidator = v.union(
  v.literal("candidate-challenge-invalid"),
  v.literal("malformed"),
  v.literal("missing"),
  v.literal("not-exact"),
  v.literal("ready"),
  v.literal("selector-mismatch"),
);

export type SuiteIdentityConfigurationAudit = Readonly<{
  candidateProof: string | null;
  hraProductionV1Count: number;
  keyCount: number;
  otherKeyCount: number;
  selectorV1: boolean;
  status:
    | "candidate-challenge-invalid"
    | "malformed"
    | "missing"
    | "not-exact"
    | "ready"
    | "selector-mismatch";
}>;

type SuiteIdentityAuditEnvironment = Readonly<{
  SUITE_IDENTITY_LINK_KEYS?: string | undefined;
  SUITE_IDENTITY_RECEIPT_KEY_VERSION?: string | undefined;
}>;

/**
 * Return only bounded counts, a closed status, and an optional nonce-bound
 * proof. The key identity, version string, and secret never leave the
 * function; a proof cannot be reused as a stable secret fingerprint.
 */
export async function auditSuiteIdentityConfiguration(
  environment: SuiteIdentityAuditEnvironment,
  challenge?: string,
): Promise<SuiteIdentityConfigurationAudit> {
  const raw = environment.SUITE_IDENTITY_LINK_KEYS;
  const selectorV1 =
    environment.SUITE_IDENTITY_RECEIPT_KEY_VERSION === "v1";
  if (raw === undefined || raw === "") {
    return {
      candidateProof: null,
      hraProductionV1Count: 0,
      keyCount: 0,
      otherKeyCount: 0,
      selectorV1,
      status: "missing",
    };
  }
  const keyring = parseSuiteReceiptKeyring(raw);
  if (keyring === null) {
    return {
      candidateProof: null,
      hraProductionV1Count: 0,
      keyCount: 0,
      otherKeyCount: 0,
      selectorV1,
      status: "malformed",
    };
  }
  const hraProductionV1 = keyring.keys.filter(key =>
    key.product === "hra"
    && key.environment === "production"
    && key.keyVersion === "v1"
  );
  const exact = selectSuiteReceiptConfiguration(raw, "hra", "v1") !== null;
  const counts = {
    hraProductionV1Count: hraProductionV1.length,
    keyCount: keyring.keys.length,
    otherKeyCount: keyring.keys.length - hraProductionV1.length,
    selectorV1,
  };
  if (!selectorV1) {
    return {
      ...counts,
      candidateProof: null,
      status: "selector-mismatch",
    };
  }
  if (!exact) {
    return {
      ...counts,
      candidateProof: null,
      status: "not-exact",
    };
  }
  const candidateProof = challenge === undefined
    ? null
    : await createSuiteReceiptProviderProof(
        hraProductionV1[0]!.secret,
        challenge,
      );
  if (challenge !== undefined && candidateProof === null) {
    return {
      ...counts,
      candidateProof: null,
      status: "candidate-challenge-invalid",
    };
  }
  return {
    ...counts,
    candidateProof,
    status: "ready",
  };
}

export const audit = internalQuery({
  args: { challenge: v.optional(v.string()) },
  returns: v.object({
    candidateProof: v.union(v.string(), v.null()),
    hraProductionV1Count: v.number(),
    keyCount: v.number(),
    otherKeyCount: v.number(),
    selectorV1: v.boolean(),
    status: auditStatusValidator,
  }),
  handler: async (_ctx, args) => await auditSuiteIdentityConfiguration(
    {
      SUITE_IDENTITY_LINK_KEYS: process.env.SUITE_IDENTITY_LINK_KEYS,
      SUITE_IDENTITY_RECEIPT_KEY_VERSION:
        process.env.SUITE_IDENTITY_RECEIPT_KEY_VERSION,
    },
    args.challenge,
  ),
});
