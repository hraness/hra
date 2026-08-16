"use node";

import {
  createHash,
  randomBytes,
} from "node:crypto";

import {
  productLinkProofMessage,
  SUITE_CATALOG_REVISION,
  suiteEntitlementReceiptMessage,
  suiteLinkReceiptMessage,
  validateSuiteEntitlementReceipt,
  validateSuiteLinkReceipt,
  type ProductLinkProof,
  type SuiteEntitlementReceipt,
  type SuiteLinkReceipt,
} from "../suite-account-contracts";
import {
  selectSuiteReceiptConfiguration,
  signSuiteProductLinkProof,
  verifySuiteEntitlementReceiptSignature,
  verifySuiteLinkReceiptSignature,
  type SuiteReceiptConfiguration,
} from "../suite-account-receipts";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";

import type { Id } from "./_generated/dataModel";
import { action } from "./_generated/server";

const PRODUCT = "hra" as const;
// Input-only compatibility for still-live receipts signed before either rename.
const LEGACY_PRODUCTS = ["oprte", "kitchen"] as const;
const LINK_TTL_MS = 4 * 60_000;

type LinkEnvironment = "development" | "production";
type CurrentHuman = Readonly<{
  localSubject: string;
  userId: Id<"users">;
}>;
type ConfiguredIdentity = SuiteReceiptConfiguration;

const currentSubject = makeFunctionReference<
  "query",
  Record<string, never>,
  CurrentHuman | null
>("suiteIdentityModel:currentSubject");
const storeChallenge = makeFunctionReference<
  "mutation",
  Readonly<{
    challengeId: string;
    environment: LinkEnvironment;
    expiresAt: number;
    issuedAt: number;
    keyVersion: string;
    localSubject: string;
    proofDigest: string;
    userId: Id<"users">;
  }>,
  "accepted" | "rejected"
>("suiteIdentityModel:storeChallenge");
const consumeReceipt = makeFunctionReference<
  "mutation",
  Readonly<{
    challengeId: string;
    environment: LinkEnvironment;
    expiresAt: number;
    issuedAt: number;
    keyVersion: string;
    localSubject: string;
    receiptDigest: string;
    suiteAccountId: string;
    userId: Id<"users">;
  }>,
  "conflict" | "expired" | "linked"
>("suiteIdentityModel:consumeReceipt");
const applyEntitlementReceipt = makeFunctionReference<
  "mutation",
  Readonly<{
    expiresAt: number;
    features: readonly ("suite.paid" | "suite.believer")[];
    localSubject: string;
    observedAt: number;
    projectionRevision: number;
    receiptDigest: string;
    receiptIssuedAt: number;
    suiteAccountId: string;
    userId: Id<"users">;
  }>,
  "accepted" | "conflict" | "unlinked"
>("suiteIdentityModel:applyEntitlementReceipt");

const environmentValidator = v.union(
  v.literal("development"),
  v.literal("production"),
);
const receiptValidator = v.object({
  challengeId: v.string(),
  environment: environmentValidator,
  expiresAtMs: v.number(),
  issuedAtMs: v.number(),
  keyVersion: v.string(),
  localSubject: v.string(),
  product: v.union(
    v.literal(PRODUCT),
    v.literal(LEGACY_PRODUCTS[0]),
    v.literal(LEGACY_PRODUCTS[1]),
  ),
  signature: v.string(),
  suiteAccountId: v.string(),
  version: v.literal("suite-link-receipt-v1"),
});
const entitlementReceiptValidator = v.object({
  entitlements: v.object({
    catalogRevision: v.literal(SUITE_CATALOG_REVISION),
    expiresAtMs: v.number(),
    features: v.array(v.union(
      v.literal("suite.paid"),
      v.literal("suite.believer"),
    )),
    observedAtMs: v.number(),
    projectionRevision: v.number(),
    version: v.literal("suite-entitlements-v1"),
  }),
  environment: environmentValidator,
  expiresAtMs: v.number(),
  issuedAtMs: v.number(),
  keyVersion: v.string(),
  product: v.union(
    v.literal(PRODUCT),
    v.literal(LEGACY_PRODUCTS[0]),
    v.literal(LEGACY_PRODUCTS[1]),
  ),
  signature: v.string(),
  suiteAccountId: v.string(),
  version: v.literal("suite-entitlement-receipt-v1"),
});

function configuredIdentity(): ConfiguredIdentity | null {
  const raw = process.env.SUITE_IDENTITY_LINK_KEYS;
  const activeVersion = process.env.SUITE_IDENTITY_RECEIPT_KEY_VERSION;
  if (raw === undefined || activeVersion === undefined) return null;
  const configured = selectSuiteReceiptConfiguration(raw, PRODUCT, activeVersion);
  return configured;
}

function digest(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

export const createLinkProof = action({
  args: {},
  returns: v.union(
    v.object({ kind: v.literal("unauthorized") }),
    v.object({ kind: v.literal("unavailable") }),
    v.object({
      kind: v.literal("proof"),
      proof: v.object({
        challengeId: v.string(),
        environment: environmentValidator,
        expiresAtMs: v.number(),
        issuedAtMs: v.number(),
        keyVersion: v.string(),
        localSubject: v.string(),
        product: v.literal(PRODUCT),
      }),
      proofSignature: v.string(),
    }),
  ),
  handler: async (ctx) => {
    const human = await ctx.runQuery(currentSubject, {});
    if (human === null) return { kind: "unauthorized" as const };
    const configured = configuredIdentity();
    if (configured === null) return { kind: "unavailable" as const };
    const { key, keyring } = configured;
    const issuedAtMs = Date.now();
    const proof = {
      challengeId: randomBytes(24).toString("base64url"),
      environment: key.environment,
      expiresAtMs: issuedAtMs + LINK_TTL_MS,
      issuedAtMs,
      keyVersion: key.keyVersion,
      localSubject: human.localSubject,
      product: PRODUCT,
    } as const satisfies ProductLinkProof;
    const proofSignature = await signSuiteProductLinkProof(
      proof,
      keyring,
      issuedAtMs,
    );
    if (proofSignature === null) return { kind: "unavailable" as const };
    const stored = await ctx.runMutation(storeChallenge, {
      challengeId: proof.challengeId,
      environment: proof.environment,
      expiresAt: proof.expiresAtMs,
      issuedAt: proof.issuedAtMs,
      keyVersion: proof.keyVersion,
      localSubject: proof.localSubject,
      proofDigest: digest(
        `${productLinkProofMessage(proof)}.${proofSignature}`,
      ),
      userId: human.userId,
    });
    return stored === "accepted"
      ? { kind: "proof" as const, proof, proofSignature }
      : { kind: "unavailable" as const };
  },
});
export const acceptLinkReceipt = action({
  args: { receipt: receiptValidator },
  returns: v.union(
    v.literal("conflict"),
    v.literal("expired"),
    v.literal("invalid"),
    v.literal("linked"),
    v.literal("unauthorized"),
    v.literal("unavailable"),
  ),
  handler: async (ctx, { receipt }) => {
    const human = await ctx.runQuery(currentSubject, {});
    if (human === null) return "unauthorized";
    const configured = configuredIdentity();
    if (configured === null) return "unavailable";
    const { key, keyring } = configured;
    const typedReceipt: SuiteLinkReceipt = receipt;
    const now = Date.now();
    const issue = validateSuiteLinkReceipt(typedReceipt, now);
    if (issue === "expired") return "expired";
    if (
      issue !== null
      || receipt.localSubject !== human.localSubject
      || receipt.environment !== key.environment
    ) {
      return "invalid";
    }
    if (!await verifySuiteLinkReceiptSignature(receipt, keyring, now)) {
      return "invalid";
    }
    return await ctx.runMutation(consumeReceipt, {
      challengeId: receipt.challengeId,
      environment: receipt.environment,
      expiresAt: receipt.expiresAtMs,
      issuedAt: receipt.issuedAtMs,
      keyVersion: receipt.keyVersion,
      localSubject: receipt.localSubject,
      receiptDigest: digest(
        `${suiteLinkReceiptMessage(receipt)}.${receipt.signature}`,
      ),
      suiteAccountId: receipt.suiteAccountId,
      userId: human.userId,
    });
  },
});

export const acceptEntitlementReceipt = action({
  args: { receipt: entitlementReceiptValidator },
  returns: v.union(
    v.literal("accepted"),
    v.literal("conflict"),
    v.literal("expired"),
    v.literal("invalid"),
    v.literal("unauthorized"),
    v.literal("unavailable"),
    v.literal("unlinked"),
  ),
  handler: async (ctx, { receipt }) => {
    const human = await ctx.runQuery(currentSubject, {});
    if (human === null) return "unauthorized";
    const configured = configuredIdentity();
    if (configured === null) return "unavailable";
    const { key, keyring } = configured;
    const typedReceipt: SuiteEntitlementReceipt = receipt;
    const now = Date.now();
    const issue = validateSuiteEntitlementReceipt(typedReceipt, now);
    if (issue === "expired") return "expired";
    if (
      issue !== null
      || receipt.environment !== key.environment
    ) {
      return "invalid";
    }
    if (!await verifySuiteEntitlementReceiptSignature(receipt, keyring, now)) {
      return "invalid";
    }
    return await ctx.runMutation(applyEntitlementReceipt, {
      expiresAt: receipt.entitlements.expiresAtMs,
      features: receipt.entitlements.features,
      localSubject: human.localSubject,
      observedAt: receipt.entitlements.observedAtMs,
      projectionRevision: receipt.entitlements.projectionRevision,
      receiptDigest: digest(
        `${suiteEntitlementReceiptMessage(receipt)}.${receipt.signature}`,
      ),
      receiptIssuedAt: receipt.issuedAtMs,
      suiteAccountId: receipt.suiteAccountId,
      userId: human.userId,
    });
  },
});
