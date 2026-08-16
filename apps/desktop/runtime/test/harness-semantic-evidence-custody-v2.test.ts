import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { HarnessImmutableObjectStore } from
  "../src/harness/object-store";
import {
  HarnessSemanticEvidenceCustodyV2Error,
  HarnessSemanticEvidenceSQLiteInventoryV2,
  HarnessSignedSemanticEvidenceCustodyV2,
  harnessSemanticEvidenceManifestSigningBytes,
  type HarnessSemanticEvidenceManifestV2,
  type HarnessSignedSemanticEvidenceBundleV2,
} from "../src/harness/semantic-evidence-custody-v2";
import {
  HARNESS_PINNED_CODEX_VERSION,
  HARNESS_SEMANTIC_PROVIDER_ID,
  SemanticHarnessFeatureGate,
  harnessSemanticEvidencePayloadBytes,
  requiredHarnessSemantics,
  type HarnessFeatureRequestBinding,
  type HarnessSemanticId,
  type HarnessSemanticWitness,
} from "../src/harness/semantic-gate";
import { applyMigrations } from "../src/state/database";

const at = "2030-01-01T12:00:00.000Z";
const nowAt = Date.parse(at);
const accountA = "acct_semantic_bundle_a";
const accountB = "acct_semantic_bundle_b";
const binaryA = "a".repeat(64);
const binaryB = "b".repeat(64);
const signerKeyId = "oprte-semantic-probe-test-1";
const generation = 7;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface WitnessSpec {
  readonly semantic: HarnessSemanticId;
  readonly state?: "proven" | "unsupported" | "inconclusive";
  readonly probeSuffix?: string;
}

function fixture(options: Readonly<{ tamperObjectRead?: boolean }> = {}) {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  for (const accountProfileId of [accountA, accountB]) {
    database.query(`
      INSERT INTO account_profiles (
        profile_id, label, auth_state, process_generation,
        selected, created_at, updated_at
      ) VALUES (?1, 'Semantic evidence', 'signed_in', ?2, 0, ?3, ?3)
    `).run(accountProfileId, generation, at);
  }
  const directory = mkdtempSync(join(tmpdir(), "oprte-semantic-evidence-"));
  directories.push(directory);
  const durableObjects = new HarnessImmutableObjectStore({ directory });
  let tamperedDigest: string | null = null;
  const objects = {
    publish: (value: unknown) => durableObjects.publish(value),
    read: (digest: unknown) => {
      const bytes = durableObjects.read(digest);
      if (options.tamperObjectRead && digest === tamperedDigest) {
        const tampered = Uint8Array.from(bytes);
        const last = tampered.byteLength - 1;
        tampered[last] = tampered[last]! ^ 1;
        return tampered;
      }
      return bytes;
    },
    remove: (digest: unknown) => durableObjects.remove(digest),
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let nowMs = nowAt;
  const inventory = new HarnessSemanticEvidenceSQLiteInventoryV2(database);
  const custody = new HarnessSignedSemanticEvidenceCustodyV2({
    inventory,
    objects,
    trustedSigners: [{
      signerKeyId,
      providerId: HARNESS_SEMANTIC_PROVIDER_ID,
      publicKey,
    }],
    now: () => nowMs,
  });
  const binding: HarnessFeatureRequestBinding = {
    requestInstanceId: 41,
    accountProfileId: accountA,
    accountGeneration: generation,
    processGeneration: generation,
  };
  const gate = new SemanticHarnessFeatureGate({
    evidence: custody,
    witnesses: custody,
    runtime: {
      resolveBinding: (request) => Promise.resolve(
        request.accountProfileId === accountA &&
            request.accountGeneration === generation &&
            request.processGeneration === generation
          ? {
              ...request,
              providerId: HARNESS_SEMANTIC_PROVIDER_ID,
              codexVersion: HARNESS_PINNED_CODEX_VERSION,
              binarySha256: binaryA,
              nowMs,
            }
          : null,
      ),
    },
  });
  return {
    binding,
    custody,
    database,
    gate,
    inventory,
    objects,
    privateKey,
    publicKey,
    setNow: (value: number) => {
      nowMs = value;
    },
    setTamperedDigest: (value: string) => {
      tamperedDigest = value;
    },
  };
}

function makeBundle(input: Readonly<{
  privateKey: KeyObject;
  witnesses: readonly WitnessSpec[];
  accountProfileId?: string;
  binarySha256?: string;
  processGeneration?: number;
  observedAt?: string;
  expiresAt?: string;
}>): HarnessSignedSemanticEvidenceBundleV2 {
  const observedAt = input.observedAt ??
    new Date(nowAt - 60_000).toISOString();
  const expiresAt = input.expiresAt ??
    new Date(Date.parse(observedAt) + 10 * 60_000).toISOString();
  const accountProfileId = input.accountProfileId ?? accountA;
  const binarySha256 = input.binarySha256 ?? binaryA;
  const processGeneration = input.processGeneration ?? generation;
  const witnesses = input.witnesses.map((spec): HarnessSemanticWitness => {
    const provisional = {
      version: 1 as const,
      providerId: HARNESS_SEMANTIC_PROVIDER_ID,
      semantic: spec.semantic,
      codexVersion: HARNESS_PINNED_CODEX_VERSION,
      state: spec.state ?? "proven",
      probeId: `signed.${spec.semantic.toLowerCase()}.${spec.probeSuffix ?? "primary"}`,
      probeDigest: createHash("sha256")
        .update(`probe:${spec.semantic}:${spec.probeSuffix ?? "primary"}`)
        .digest("hex"),
      observedAt,
      accountProfileId,
      accountGeneration: processGeneration,
      binarySha256,
      processGeneration,
      evidenceObjectDigest: "0".repeat(64),
    };
    return {
      ...provisional,
      evidenceObjectDigest: createHash("sha256")
        .update(harnessSemanticEvidencePayloadBytes(provisional))
        .digest("hex"),
    };
  }).toSorted((left, right) => {
    const leftKey = `${left.semantic}\0${left.probeId}\0${left.evidenceObjectDigest}`;
    const rightKey = `${right.semantic}\0${right.probeId}\0${right.evidenceObjectDigest}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const manifest: HarnessSemanticEvidenceManifestV2 = {
    version: 2,
    providerId: HARNESS_SEMANTIC_PROVIDER_ID,
    accountProfileId,
    accountGeneration: processGeneration,
    processGeneration,
    runtimeBinarySha256: binarySha256,
    codexVersion: HARNESS_PINNED_CODEX_VERSION,
    observedAt,
    expiresAt,
    witnesses,
  };
  const signature = sign(
    null,
    harnessSemanticEvidenceManifestSigningBytes(manifest),
    input.privateKey,
  ).toString("base64url");
  return {
    version: 2,
    manifest,
    signature: {
      algorithm: "Ed25519",
      signerKeyId,
      value: signature,
    },
  };
}

const recursiveWitnesses = () =>
  requiredHarnessSemantics("recursiveAgents")
    .map((semantic) => ({ semantic } satisfies WitnessSpec));

describe("signed semantic evidence custody v2", () => {
  test("imports one exact signed suite and enables only its complete witness set", async () => {
    const value = fixture();
    try {
      const bundle = makeBundle({
        privateKey: value.privateKey,
        witnesses: recursiveWitnesses(),
      });
      const imported = value.custody.importSignedBundle(bundle);
      expect(imported).toMatchObject({ state: "created" });
      expect(value.custody.importSignedBundle(bundle)).toMatchObject({
        ...imported,
        state: "existing",
      });
      const decision = await value.gate.decide(
        "recursiveAgents",
        value.binding,
      );
      expect(decision).toEqual({
        enabled: true,
        feature: "recursiveAgents",
        witnessDigests: bundle.manifest.witnesses
          .map(({ evidenceObjectDigest }) => evidenceObjectDigest)
          .toSorted(),
      });
      expect(value.database.query(`
        SELECT state, quarantine_reason, revision
        FROM harness_semantic_evidence_bundles
      `).all()).toEqual([{
        state: "active",
        quarantine_reason: null,
        revision: 1,
      }]);
    } finally {
      value.database.close();
    }
  });

  test("classifies missing, unsupported, and conflicting operation evidence", async () => {
    for (const scenario of ["missing", "unsupported", "conflicting"] as const) {
      const value = fixture();
      try {
        const required = recursiveWitnesses();
        const target = required[0]!.semantic;
        const witnesses: WitnessSpec[] = scenario === "missing"
          ? required.slice(1)
          : scenario === "unsupported"
          ? required.map((entry) => entry.semantic === target
            ? { ...entry, state: "unsupported" }
            : entry)
          : [
              ...required,
              { semantic: target, state: "unsupported", probeSuffix: "conflict" },
            ];
        value.custody.importSignedBundle(makeBundle({
          privateKey: value.privateKey,
          witnesses,
        }));
        expect(await value.gate.decide("recursiveAgents", value.binding))
          .toMatchObject({
            enabled: false,
            reason: scenario === "missing"
              ? "missing_witness"
              : scenario === "unsupported"
              ? "unsupported"
              : "conflicting_witness",
          });
      } finally {
        value.database.close();
      }
    }
  });

  test("does not cross-admit another account or binary identity", async () => {
    for (const identity of [
      { accountProfileId: accountB, binarySha256: binaryA },
      { accountProfileId: accountA, binarySha256: binaryB },
      {
        accountProfileId: accountA,
        binarySha256: binaryA,
        processGeneration: generation + 1,
      },
    ]) {
      const value = fixture();
      try {
        value.custody.importSignedBundle(makeBundle({
          privateKey: value.privateKey,
          witnesses: recursiveWitnesses(),
          ...identity,
        }));
        expect(await value.gate.decide("recursiveAgents", value.binding))
          .toMatchObject({ enabled: false, reason: "missing_witness" });
      } finally {
        value.database.close();
      }
    }
  });

  test("rejects wrong provider, version, signer, signature, and expired imports", () => {
    const value = fixture();
    try {
      const bundle = makeBundle({
        privateKey: value.privateKey,
        witnesses: recursiveWitnesses(),
      });
      const invalidValues: unknown[] = [
        { ...bundle, manifest: { ...bundle.manifest, providerId: "other" } },
        { ...bundle, manifest: { ...bundle.manifest, codexVersion: "0.145.0" } },
        { ...bundle, signature: { ...bundle.signature, signerKeyId: "unknown" } },
        {
          ...bundle,
          signature: {
            ...bundle.signature,
            value: `${bundle.signature.value.startsWith("A") ? "B" : "A"}${
              bundle.signature.value.slice(1)
            }`,
          },
        },
        makeBundle({
          privateKey: value.privateKey,
          witnesses: recursiveWitnesses(),
          observedAt: new Date(nowAt - 20 * 60_000).toISOString(),
          expiresAt: new Date(nowAt - 10 * 60_000).toISOString(),
        }),
      ];
      for (const invalid of invalidValues) {
        expect(() => value.custody.importSignedBundle(invalid))
          .toThrow(HarnessSemanticEvidenceCustodyV2Error);
      }
      expect(value.database.query(`
        SELECT COUNT(*) AS count FROM harness_semantic_evidence_bundles
      `).get()).toEqual({ count: 0 });
    } finally {
      value.database.close();
    }
  });

  test("never treats a persisted database row as its own signer trust", async () => {
    const value = fixture();
    try {
      value.custody.importSignedBundle(makeBundle({
        privateKey: value.privateKey,
        witnesses: recursiveWitnesses(),
      }));
      const untrusted = new HarnessSignedSemanticEvidenceCustodyV2({
        inventory: value.inventory,
        objects: value.objects,
        trustedSigners: [],
        now: () => nowAt,
      });
      let rejected: unknown = null;
      try {
        await untrusted.listWitnesses(value.binding);
      } catch (error: unknown) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(HarnessSemanticEvidenceCustodyV2Error);
      expect(value.database.query(`
        SELECT state, quarantine_reason
        FROM harness_semantic_evidence_bundles
      `).get()).toEqual({
        state: "quarantined",
        quarantine_reason: "signature_invalid",
      });
    } finally {
      value.database.close();
    }
  });

  test("quarantines expired or tampered active custody and fails the whole decision closed", async () => {
    for (const mode of [
      "expired",
      "tampered_bundle",
      "tampered_evidence",
    ] as const) {
      const value = fixture({ tamperObjectRead: mode !== "expired" });
      try {
        const bundle = makeBundle({
          privateKey: value.privateKey,
          witnesses: recursiveWitnesses(),
        });
        const imported = value.custody.importSignedBundle(bundle);
        if (mode === "expired") value.setNow(nowAt + 11 * 60_000);
        else if (mode === "tampered_bundle") {
          value.setTamperedDigest(imported.bundleDigest);
        } else {
          value.setTamperedDigest(
            bundle.manifest.witnesses[0]!.evidenceObjectDigest,
          );
        }
        expect(await value.gate.decide("recursiveAgents", value.binding))
          .toMatchObject({
            enabled: false,
            reason: mode === "tampered_evidence"
              ? "missing_witness"
              : "runtime_binding_unavailable",
          });
        expect(value.database.query(`
          SELECT state, quarantine_reason, revision
          FROM harness_semantic_evidence_bundles
        `).get()).toEqual({
          state: "quarantined",
          quarantine_reason: mode === "expired" ? "expired" : "manifest_invalid",
          revision: 2,
        });
      } finally {
        value.database.close();
      }
    }
  });

  test("atomically supersedes only with a newer signed observation", async () => {
    const value = fixture();
    try {
      const older = makeBundle({
        privateKey: value.privateKey,
        witnesses: recursiveWitnesses(),
        observedAt: new Date(nowAt - 2 * 60_000).toISOString(),
      });
      const newer = makeBundle({
        privateKey: value.privateKey,
        witnesses: recursiveWitnesses(),
        observedAt: new Date(nowAt - 60_000).toISOString(),
      });
      value.custody.importSignedBundle(older);
      expect(() => value.custody.importSignedBundle(makeBundle({
        privateKey: value.privateKey,
        witnesses: recursiveWitnesses(),
        binarySha256: binaryB,
        observedAt: new Date(nowAt - 30_000).toISOString(),
      }))).toThrow(HarnessSemanticEvidenceCustodyV2Error);
      value.custody.importSignedBundle(newer);
      expect(value.database.query(`
        SELECT state FROM harness_semantic_evidence_bundles ORDER BY observed_at
      `).all()).toEqual([{ state: "superseded" }, { state: "active" }]);
      expect(await value.gate.decide("recursiveAgents", value.binding))
        .toMatchObject({ enabled: true });
      expect(() => value.custody.importSignedBundle(older))
        .toThrow(HarnessSemanticEvidenceCustodyV2Error);
      expect(value.database.query(`
        SELECT state FROM harness_semantic_evidence_bundles ORDER BY observed_at
      `).all()).toEqual([{ state: "superseded" }, { state: "active" }]);
    } finally {
      value.database.close();
    }
  });
});
