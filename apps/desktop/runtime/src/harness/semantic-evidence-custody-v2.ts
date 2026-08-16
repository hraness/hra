import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyLike,
  type KeyObject,
} from "node:crypto";
import type { Database } from "bun:sqlite";

import { z } from "@hra-internal/schema";

import type { HarnessObjectStorePort } from "./object-store";
import {
  HARNESS_PINNED_CODEX_VERSION,
  HARNESS_SEMANTIC_PROVIDER_ID,
  HARNESS_SEMANTIC_WITNESS_MAX_AGE_MS,
  harnessFeatureRequestBindingSchema,
  harnessSemanticEvidencePayloadBytes,
  harnessSemanticWitnessSchema,
  type HarnessSemanticEvidenceCustody,
  type HarnessSemanticEvidenceReadback,
  type HarnessSemanticId,
  type HarnessSemanticWitnessPort,
  type HarnessSemanticWitness,
} from "./semantic-gate";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const accountProfileIdSchema = z.string().min(1).max(96)
  .regex(/^acct_[A-Za-z0-9_-]+$/u);
const signerKeyIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const signatureSchema = z.string().min(43).max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const harnessSemanticEvidenceManifestV2Schema = z.object({
  version: z.literal(2),
  providerId: z.literal(HARNESS_SEMANTIC_PROVIDER_ID),
  accountProfileId: accountProfileIdSchema,
  accountGeneration: positiveSafeIntegerSchema,
  processGeneration: positiveSafeIntegerSchema,
  runtimeBinarySha256: digestSchema,
  codexVersion: z.literal(HARNESS_PINNED_CODEX_VERSION),
  observedAt: z.string().length(24).datetime(),
  expiresAt: z.string().length(24).datetime(),
  witnesses: z.array(harnessSemanticWitnessSchema).min(1).max(32),
}).strict().superRefine((value, context) => {
  if (value.accountGeneration !== value.processGeneration) {
    context.addIssue({
      code: "custom",
      message: "account and process generations must match",
    });
  }
  const observedAtMs = Date.parse(value.observedAt);
  const expiresAtMs = Date.parse(value.expiresAt);
  if (
    !Number.isFinite(observedAtMs) || !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= observedAtMs ||
    expiresAtMs - observedAtMs > HARNESS_SEMANTIC_WITNESS_MAX_AGE_MS
  ) {
    context.addIssue({ code: "custom", message: "evidence lifetime is invalid" });
  }
  let priorKey: string | null = null;
  const digests = new Set<string>();
  for (const witness of value.witnesses) {
    const key = `${witness.semantic}\0${witness.probeId}\0${witness.evidenceObjectDigest}`;
    if (priorKey !== null && priorKey >= key) {
      context.addIssue({
        code: "custom",
        message: "semantic witnesses must use unique canonical order",
      });
    }
    priorKey = key;
    if (digests.has(witness.evidenceObjectDigest)) {
      context.addIssue({ code: "custom", message: "evidence digests must be unique" });
    }
    digests.add(witness.evidenceObjectDigest);
    if (
      witness.providerId !== value.providerId ||
      witness.codexVersion !== value.codexVersion ||
      witness.accountProfileId !== value.accountProfileId ||
      witness.accountGeneration !== value.accountGeneration ||
      witness.processGeneration !== value.processGeneration ||
      witness.binarySha256 !== value.runtimeBinarySha256 ||
      witness.observedAt !== value.observedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "a witness does not match its signed runtime manifest",
      });
    }
  }
});

export const harnessSignedSemanticEvidenceBundleV2Schema = z.object({
  version: z.literal(2),
  manifest: harnessSemanticEvidenceManifestV2Schema,
  signature: z.object({
    algorithm: z.literal("Ed25519"),
    signerKeyId: signerKeyIdSchema,
    value: signatureSchema,
  }).strict(),
}).strict();

type ParsedSemanticEvidenceManifestV2 = z.infer<
  typeof harnessSemanticEvidenceManifestV2Schema
>;
export type HarnessSemanticEvidenceManifestV2 = Readonly<
  Omit<ParsedSemanticEvidenceManifestV2, "witnesses"> & {
    readonly witnesses: readonly HarnessSemanticWitness[];
  }
>;
export type HarnessSignedSemanticEvidenceBundleV2 = Readonly<{
  version: 2;
  manifest: HarnessSemanticEvidenceManifestV2;
  signature: Readonly<{
    algorithm: "Ed25519";
    signerKeyId: string;
    value: string;
  }>;
}>;

export interface HarnessSemanticEvidenceTrustedSignerV2 {
  readonly signerKeyId: string;
  readonly providerId: typeof HARNESS_SEMANTIC_PROVIDER_ID;
  readonly publicKey: KeyLike | KeyObject;
}

const inventoryRowSchema = z.object({
  bundleDigest: digestSchema,
  providerId: z.literal(HARNESS_SEMANTIC_PROVIDER_ID),
  accountProfileId: accountProfileIdSchema,
  accountGeneration: positiveSafeIntegerSchema,
  processGeneration: positiveSafeIntegerSchema,
  runtimeBinarySha256: digestSchema,
  codexVersion: z.literal(HARNESS_PINNED_CODEX_VERSION),
  observedAt: z.string().length(24).datetime(),
  expiresAt: z.string().length(24).datetime(),
  signerKeyId: signerKeyIdSchema,
  manifestDigest: digestSchema,
  manifestSignature: signatureSchema,
  state: z.enum(["active", "superseded", "quarantined"]),
  quarantineReason: z.enum([
    "signature_invalid",
    "manifest_invalid",
    "runtime_mismatch",
    "generation_mismatch",
    "provider_mismatch",
    "expired",
    "recovery_protocol_error",
  ]).nullable(),
  revision: positiveSafeIntegerSchema,
  createdAt: z.string().length(24).datetime(),
  updatedAt: z.string().length(24).datetime(),
}).strict();

export type HarnessSemanticEvidenceInventoryRowV2 = Readonly<
  z.infer<typeof inventoryRowSchema>
>;
export type HarnessSemanticEvidenceQuarantineReasonV2 = NonNullable<
  HarnessSemanticEvidenceInventoryRowV2["quarantineReason"]
>;

export interface HarnessSemanticEvidenceInventoryPortV2 {
  activate(
    row: HarnessSemanticEvidenceInventoryRowV2,
  ): "created" | "existing";
  listActive(input: Readonly<{
    accountProfileId: string;
    accountGeneration: number;
    processGeneration: number;
  }>): readonly unknown[];
  quarantine(input: Readonly<{
    bundleDigest: string;
    expectedRevision: number;
    reason: HarnessSemanticEvidenceQuarantineReasonV2;
    now: string;
  }>): void;
}

export class HarnessSemanticEvidenceCustodyV2Error extends Error {
  readonly code: "bundle_invalid" | "custody_invalid" | "import_conflict";

  constructor(code: HarnessSemanticEvidenceCustodyV2Error["code"]) {
    super({
      bundle_invalid: "The semantic evidence bundle is invalid.",
      custody_invalid: "Semantic evidence custody could not be verified.",
      import_conflict: "The semantic evidence bundle conflicts with active custody.",
    }[code]);
    this.name = "HarnessSemanticEvidenceCustodyV2Error";
    this.code = code;
  }
}

/**
 * Pinned public keys, immutable objects, and append-only SQLite inventory are
 * three independent requirements. Database bytes never grant their own trust.
 */
export class HarnessSignedSemanticEvidenceCustodyV2
  implements HarnessSemanticEvidenceCustody, HarnessSemanticWitnessPort {
  readonly #inventory: HarnessSemanticEvidenceInventoryPortV2;
  readonly #objects: HarnessObjectStorePort;
  readonly #now: () => number;
  readonly #signers: ReadonlyMap<string, Readonly<{
    providerId: typeof HARNESS_SEMANTIC_PROVIDER_ID;
    publicKey: KeyObject;
  }>>;

  constructor(input: Readonly<{
    inventory: HarnessSemanticEvidenceInventoryPortV2;
    objects: HarnessObjectStorePort;
    trustedSigners: readonly HarnessSemanticEvidenceTrustedSignerV2[];
    now?: () => number;
  }>) {
    this.#inventory = input.inventory;
    this.#objects = input.objects;
    this.#now = input.now ?? Date.now;
    const signers = new Map<string, Readonly<{
      providerId: typeof HARNESS_SEMANTIC_PROVIDER_ID;
      publicKey: KeyObject;
    }>>();
    for (const value of input.trustedSigners) {
      const signerKeyId = signerKeyIdSchema.parse(value.signerKeyId);
      if (signers.has(signerKeyId)) {
        throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
      }
      let publicKey: KeyObject;
      try {
        publicKey = isPublicKeyObject(value.publicKey)
          ? value.publicKey
          : createPublicKey(value.publicKey);
      } catch {
        throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
      }
      if (publicKey.asymmetricKeyType !== "ed25519") {
        throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
      }
      signers.set(signerKeyId, Object.freeze({
        providerId: value.providerId,
        publicKey,
      }));
    }
    this.#signers = signers;
  }

  importSignedBundle(bundleValue: unknown): Readonly<{
    bundleDigest: string;
    manifestDigest: string;
    state: "created" | "existing";
  }> {
    const nowMs = exactNow(this.#now);
    const bundle = this.#parseAndVerifyBundle(bundleValue, nowMs, true);
    for (const witness of bundle.manifest.witnesses) {
      const evidenceBytes = harnessSemanticEvidencePayloadBytes(witness);
      if (sha256(evidenceBytes) !== witness.evidenceObjectDigest) {
        throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
      }
      const publication = this.#objects.publish(evidenceBytes);
      if (publication.digest !== witness.evidenceObjectDigest) {
        throw new HarnessSemanticEvidenceCustodyV2Error("custody_invalid");
      }
    }
    const bundleBytes = canonicalJsonBytes(bundle);
    const publication = this.#objects.publish(bundleBytes);
    const manifestDigest = sha256(canonicalJsonBytes(bundle.manifest));
    const now = new Date(nowMs).toISOString();
    const row = inventoryRowSchema.parse({
      bundleDigest: publication.digest,
      providerId: bundle.manifest.providerId,
      accountProfileId: bundle.manifest.accountProfileId,
      accountGeneration: bundle.manifest.accountGeneration,
      processGeneration: bundle.manifest.processGeneration,
      runtimeBinarySha256: bundle.manifest.runtimeBinarySha256,
      codexVersion: bundle.manifest.codexVersion,
      observedAt: bundle.manifest.observedAt,
      expiresAt: bundle.manifest.expiresAt,
      signerKeyId: bundle.signature.signerKeyId,
      manifestDigest,
      manifestSignature: bundle.signature.value,
      state: "active",
      quarantineReason: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    let state: "created" | "existing";
    try {
      state = this.#inventory.activate(row);
    } catch {
      throw new HarnessSemanticEvidenceCustodyV2Error("import_conflict");
    }
    return Object.freeze({
      bundleDigest: row.bundleDigest,
      manifestDigest,
      state,
    });
  }

  async listWitnesses(bindingValue: unknown): Promise<readonly unknown[]> {
    await Promise.resolve();
    const binding = harnessFeatureRequestBindingSchema.safeParse(bindingValue);
    if (!binding.success) return [];
    const rows = this.#rows(binding.data);
    const nowMs = exactNow(this.#now);
    const witnesses: HarnessSemanticWitness[] = [];
    for (const row of rows) {
      const bundle = this.#readVerifiedBundle(row, () => nowMs);
      witnesses.push(...bundle.manifest.witnesses);
    }
    return Object.freeze(witnesses.map((witness) => Object.freeze(witness)));
  }

  async readVerifiedEvidenceObject(inputValue: Readonly<{
    digest: string;
    providerId: typeof HARNESS_SEMANTIC_PROVIDER_ID;
    codexVersion: typeof HARNESS_PINNED_CODEX_VERSION;
    semantic: HarnessSemanticId;
    probeId: string;
    accountProfileId: string;
    accountGeneration: number;
    binarySha256: string;
    processGeneration: number;
    nowMs: number;
  }>): Promise<HarnessSemanticEvidenceReadback | null> {
    await Promise.resolve();
    const input = z.object({
      digest: digestSchema,
      providerId: z.literal(HARNESS_SEMANTIC_PROVIDER_ID),
      codexVersion: z.literal(HARNESS_PINNED_CODEX_VERSION),
      semantic: harnessSemanticWitnessSchema.shape.semantic,
      probeId: harnessSemanticWitnessSchema.shape.probeId,
      accountProfileId: accountProfileIdSchema,
      accountGeneration: positiveSafeIntegerSchema,
      binarySha256: digestSchema,
      processGeneration: positiveSafeIntegerSchema,
      nowMs: z.number().int().nonnegative().safe(),
    }).strict().refine(
      ({ accountGeneration, processGeneration }) =>
        accountGeneration === processGeneration,
      "account and process generations must match",
    ).safeParse(inputValue);
    if (!input.success) return null;
    const effectiveNow = Math.max(input.data.nowMs, exactNow(this.#now));
    let match: Readonly<{
      row: HarnessSemanticEvidenceInventoryRowV2;
      witness: HarnessSemanticWitness;
    }> | null = null;
    for (const row of this.#rows(input.data)) {
      const bundle = this.#readVerifiedBundle(row, () => effectiveNow);
      if (
        bundle.manifest.providerId !== input.data.providerId ||
        bundle.manifest.codexVersion !== input.data.codexVersion ||
        bundle.manifest.runtimeBinarySha256 !== input.data.binarySha256
      ) continue;
      for (const witness of bundle.manifest.witnesses) {
        if (
          witness.evidenceObjectDigest !== input.data.digest ||
          witness.semantic !== input.data.semantic ||
          witness.probeId !== input.data.probeId
        ) continue;
        if (match !== null) {
          throw new HarnessSemanticEvidenceCustodyV2Error("custody_invalid");
        }
        match = Object.freeze({ row, witness });
      }
    }
    if (match === null) return null;
    let bytes: Uint8Array;
    try {
      bytes = this.#objects.read(match.witness.evidenceObjectDigest);
    } catch {
      this.#quarantine(
        match.row,
        "recovery_protocol_error",
        effectiveNow,
      );
      return null;
    }
    const expected = harnessSemanticEvidencePayloadBytes(match.witness);
    if (
      sha256(bytes) !== match.witness.evidenceObjectDigest ||
      !bytesEqual(bytes, expected)
    ) {
      this.#quarantine(match.row, "manifest_invalid", effectiveNow);
      return null;
    }
    return Object.freeze({
      digest: match.witness.evidenceObjectDigest,
      bytes,
    });
  }

  #rows(binding: Readonly<{
    accountProfileId: string;
    accountGeneration: number;
    processGeneration: number;
  }>): readonly HarnessSemanticEvidenceInventoryRowV2[] {
    let values: readonly unknown[];
    try {
      values = this.#inventory.listActive({
        accountProfileId: binding.accountProfileId,
        accountGeneration: binding.accountGeneration,
        processGeneration: binding.processGeneration,
      });
    } catch {
      throw new HarnessSemanticEvidenceCustodyV2Error("custody_invalid");
    }
    return values.map((value) => inventoryRowSchema.parse(value));
  }

  #readVerifiedBundle(
    row: HarnessSemanticEvidenceInventoryRowV2,
    now: () => number,
  ): HarnessSignedSemanticEvidenceBundleV2 {
    try {
      const bytes = this.#objects.read(row.bundleDigest);
      if (sha256(bytes) !== row.bundleDigest) throw new Error("digest");
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const value = JSON.parse(decoded) as unknown;
      const bundle = this.#parseAndVerifyBundle(value, now(), false);
      if (!bytesEqual(bytes, canonicalJsonBytes(bundle))) throw new Error("canonical");
      if (!rowMatchesBundle(row, bundle)) throw new Error("identity");
      return bundle;
    } catch (cause: unknown) {
      const nowMs = now();
      const reason = quarantineReason(cause, row, nowMs);
      this.#quarantine(row, reason, nowMs);
      throw new HarnessSemanticEvidenceCustodyV2Error("custody_invalid");
    }
  }

  #parseAndVerifyBundle(
    bundleValue: unknown,
    nowMs: number,
    requireCurrentlyFresh: boolean,
  ): HarnessSignedSemanticEvidenceBundleV2 {
    const parsed = harnessSignedSemanticEvidenceBundleV2Schema.safeParse(bundleValue);
    if (!parsed.success) {
      throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
    }
    const bundle = parsed.data;
    const observedAtMs = Date.parse(bundle.manifest.observedAt);
    const expiresAtMs = Date.parse(bundle.manifest.expiresAt);
    if (
      (requireCurrentlyFresh && (observedAtMs > nowMs || expiresAtMs <= nowMs)) ||
      expiresAtMs <= nowMs
    ) throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
    const signer = this.#signers.get(bundle.signature.signerKeyId);
    if (
      signer === undefined || signer.providerId !== bundle.manifest.providerId
    ) throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
    let signature: Buffer;
    try {
      signature = Buffer.from(bundle.signature.value, "base64url");
    } catch {
      throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
    }
    let verified = false;
    try {
      verified = signature.byteLength === 64 &&
        signature.toString("base64url") === bundle.signature.value &&
        verifySignature(
          null,
          harnessSemanticEvidenceManifestSigningBytes(bundle.manifest),
          signer.publicKey,
          signature,
        );
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new HarnessSemanticEvidenceCustodyV2Error("bundle_invalid");
    }
    return Object.freeze({
      version: 2 as const,
      manifest: Object.freeze({
        ...bundle.manifest,
        witnesses: Object.freeze(bundle.manifest.witnesses.map((witness) =>
          Object.freeze(witness)
        )),
      }),
      signature: Object.freeze(bundle.signature),
    });
  }

  #quarantine(
    row: HarnessSemanticEvidenceInventoryRowV2,
    reason: HarnessSemanticEvidenceQuarantineReasonV2,
    nowMs: number,
  ): void {
    try {
      this.#inventory.quarantine({
        bundleDigest: row.bundleDigest,
        expectedRevision: row.revision,
        reason,
        now: new Date(nowMs).toISOString(),
      });
    } catch {
      // Admission remains closed if containment raced or storage faulted.
    }
  }
}

const sqliteRowSchema = z.object({
  bundle_digest: digestSchema,
  provider_id: z.literal(HARNESS_SEMANTIC_PROVIDER_ID),
  account_profile_id: accountProfileIdSchema,
  account_generation: positiveSafeIntegerSchema,
  process_generation: positiveSafeIntegerSchema,
  runtime_binary_sha256: digestSchema,
  codex_version: z.literal(HARNESS_PINNED_CODEX_VERSION),
  observed_at: z.string().length(24).datetime(),
  expires_at: z.string().length(24).datetime(),
  signer_key_id: signerKeyIdSchema,
  manifest_digest: digestSchema,
  manifest_signature: signatureSchema,
  state: z.enum(["active", "superseded", "quarantined"]),
  quarantine_reason: inventoryRowSchema.shape.quarantineReason,
  revision: positiveSafeIntegerSchema,
  created_at: z.string().length(24).datetime(),
  updated_at: z.string().length(24).datetime(),
}).strict();

export class HarnessSemanticEvidenceSQLiteInventoryV2
  implements HarnessSemanticEvidenceInventoryPortV2 {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  activate(rowValue: HarnessSemanticEvidenceInventoryRowV2): "created" | "existing" {
    const row = inventoryRowSchema.parse(rowValue);
    return this.#database.transaction(() => {
      const exact = this.#read(row.bundleDigest);
      if (exact !== null) {
        if (exact.state !== "active" || !inventoryIdentityMatches(exact, row)) {
          throw new HarnessSemanticEvidenceCustodyV2Error("import_conflict");
        }
        return "existing" as const;
      }
      const activeRows: unknown[] = this.#database.query(`
        SELECT * FROM harness_semantic_evidence_bundles
        WHERE account_profile_id = ?1 AND account_generation = ?2
          AND process_generation = ?3 AND state = 'active'
        ORDER BY bundle_digest
        LIMIT 2
      `).all(
        row.accountProfileId,
        row.accountGeneration,
        row.processGeneration,
      );
      if (activeRows.length > 1) {
        throw new HarnessSemanticEvidenceCustodyV2Error("import_conflict");
      }
      if (activeRows.length === 1) {
        const active = parseSqliteRow(activeRows[0]);
        if (
          active.providerId !== row.providerId ||
          active.runtimeBinarySha256 !== row.runtimeBinarySha256 ||
          active.codexVersion !== row.codexVersion
        ) {
          throw new HarnessSemanticEvidenceCustodyV2Error("import_conflict");
        }
        if (active.observedAt >= row.observedAt) {
          throw new HarnessSemanticEvidenceCustodyV2Error("import_conflict");
        }
        const transition = this.#database.query(`
          UPDATE harness_semantic_evidence_bundles
          SET state = 'superseded', revision = revision + 1, updated_at = ?1
          WHERE bundle_digest = ?2 AND state = 'active' AND revision = ?3
        `).run(row.createdAt, active.bundleDigest, active.revision);
        if (transition.changes !== 1) {
          throw new HarnessSemanticEvidenceCustodyV2Error("import_conflict");
        }
      }
      this.#database.query(`
        INSERT INTO harness_semantic_evidence_bundles (
          bundle_digest, provider_id, account_profile_id,
          account_generation, process_generation, runtime_binary_sha256,
          codex_version, observed_at, expires_at, signer_key_id,
          manifest_digest, manifest_signature, state, quarantine_reason,
          revision, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
          ?11, ?12, 'active', NULL, 1, ?13, ?13
        )
      `).run(
        row.bundleDigest,
        row.providerId,
        row.accountProfileId,
        row.accountGeneration,
        row.processGeneration,
        row.runtimeBinarySha256,
        row.codexVersion,
        row.observedAt,
        row.expiresAt,
        row.signerKeyId,
        row.manifestDigest,
        row.manifestSignature,
        row.createdAt,
      );
      return "created" as const;
    })();
  }

  listActive(inputValue: Readonly<{
    accountProfileId: string;
    accountGeneration: number;
    processGeneration: number;
  }>): readonly unknown[] {
    const input = z.object({
      accountProfileId: accountProfileIdSchema,
      accountGeneration: positiveSafeIntegerSchema,
      processGeneration: positiveSafeIntegerSchema,
    }).strict().refine(
      ({ accountGeneration, processGeneration }) =>
        accountGeneration === processGeneration,
      "account and process generations must match",
    ).parse(inputValue);
    const rows: unknown[] = this.#database.query(`
      SELECT * FROM harness_semantic_evidence_bundles
      WHERE account_profile_id = ?1 AND account_generation = ?2
        AND process_generation = ?3 AND state = 'active'
      ORDER BY bundle_digest
      LIMIT 2
    `).all(
      input.accountProfileId,
      input.accountGeneration,
      input.processGeneration,
    );
    if (rows.length > 1) {
      throw new HarnessSemanticEvidenceCustodyV2Error("custody_invalid");
    }
    return Object.freeze(rows.map(parseSqliteRow));
  }

  quarantine(inputValue: Readonly<{
    bundleDigest: string;
    expectedRevision: number;
    reason: HarnessSemanticEvidenceQuarantineReasonV2;
    now: string;
  }>): void {
    const input = z.object({
      bundleDigest: digestSchema,
      expectedRevision: positiveSafeIntegerSchema,
      reason: inventoryRowSchema.shape.quarantineReason.unwrap(),
      now: z.string().length(24).datetime(),
    }).strict().parse(inputValue);
    const result = this.#database.query(`
      UPDATE harness_semantic_evidence_bundles
      SET state = 'quarantined', quarantine_reason = ?1,
        revision = revision + 1, updated_at = ?2
      WHERE bundle_digest = ?3 AND state = 'active' AND revision = ?4
    `).run(
      input.reason,
      input.now,
      input.bundleDigest,
      input.expectedRevision,
    );
    if (result.changes !== 1) {
      throw new HarnessSemanticEvidenceCustodyV2Error("custody_invalid");
    }
  }

  #read(bundleDigest: string): HarnessSemanticEvidenceInventoryRowV2 | null {
    const value: unknown = this.#database.query(`
      SELECT * FROM harness_semantic_evidence_bundles WHERE bundle_digest = ?1
    `).get(bundleDigest);
    return value === null ? null : parseSqliteRow(value);
  }
}

export function harnessSemanticEvidenceManifestSigningBytes(
  manifestValue: unknown,
): Uint8Array {
  const manifest = harnessSemanticEvidenceManifestV2Schema.parse(manifestValue);
  const domain = new TextEncoder().encode(
    "OPRTE signed semantic evidence manifest v2\0",
  );
  const payload = canonicalJsonBytes(manifest);
  const bytes = new Uint8Array(domain.byteLength + payload.byteLength);
  bytes.set(domain, 0);
  bytes.set(payload, domain.byteLength);
  return bytes;
}

function parseSqliteRow(value: unknown): HarnessSemanticEvidenceInventoryRowV2 {
  const row = sqliteRowSchema.parse(value);
  return inventoryRowSchema.parse({
    bundleDigest: row.bundle_digest,
    providerId: row.provider_id,
    accountProfileId: row.account_profile_id,
    accountGeneration: row.account_generation,
    processGeneration: row.process_generation,
    runtimeBinarySha256: row.runtime_binary_sha256,
    codexVersion: row.codex_version,
    observedAt: row.observed_at,
    expiresAt: row.expires_at,
    signerKeyId: row.signer_key_id,
    manifestDigest: row.manifest_digest,
    manifestSignature: row.manifest_signature,
    state: row.state,
    quarantineReason: row.quarantine_reason,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowMatchesBundle(
  row: HarnessSemanticEvidenceInventoryRowV2,
  bundle: HarnessSignedSemanticEvidenceBundleV2,
): boolean {
  const manifest = bundle.manifest;
  return row.state === "active" && row.quarantineReason === null &&
    row.providerId === manifest.providerId &&
    row.accountProfileId === manifest.accountProfileId &&
    row.accountGeneration === manifest.accountGeneration &&
    row.processGeneration === manifest.processGeneration &&
    row.runtimeBinarySha256 === manifest.runtimeBinarySha256 &&
    row.codexVersion === manifest.codexVersion &&
    row.observedAt === manifest.observedAt && row.expiresAt === manifest.expiresAt &&
    row.signerKeyId === bundle.signature.signerKeyId &&
    row.manifestSignature === bundle.signature.value &&
    row.manifestDigest === sha256(canonicalJsonBytes(manifest));
}

function inventoryIdentityMatches(
  left: HarnessSemanticEvidenceInventoryRowV2,
  right: HarnessSemanticEvidenceInventoryRowV2,
): boolean {
  return left.bundleDigest === right.bundleDigest &&
    left.providerId === right.providerId &&
    left.accountProfileId === right.accountProfileId &&
    left.accountGeneration === right.accountGeneration &&
    left.processGeneration === right.processGeneration &&
    left.runtimeBinarySha256 === right.runtimeBinarySha256 &&
    left.codexVersion === right.codexVersion &&
    left.observedAt === right.observedAt && left.expiresAt === right.expiresAt &&
    left.signerKeyId === right.signerKeyId &&
    left.manifestDigest === right.manifestDigest &&
    left.manifestSignature === right.manifestSignature;
}

function quarantineReason(
  cause: unknown,
  row: HarnessSemanticEvidenceInventoryRowV2,
  nowMs: number,
): HarnessSemanticEvidenceQuarantineReasonV2 {
  if (Date.parse(row.expiresAt) <= nowMs) return "expired";
  if (
    cause instanceof HarnessSemanticEvidenceCustodyV2Error &&
    cause.code === "bundle_invalid"
  ) return "signature_invalid";
  return "manifest_invalid";
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalizeJson(value)));
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function isPublicKeyObject(value: KeyLike | KeyObject): value is KeyObject {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === "public" &&
    "asymmetricKeyType" in value;
}

function exactNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HarnessSemanticEvidenceCustodyV2Error("custody_invalid");
  }
  return value;
}
