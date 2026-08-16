import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import type { ChatService } from "../src/chat";
import { HarnessInstallKeyCustody } from "../src/harness/key-custody";
import { HarnessImmutableObjectStore } from
  "../src/harness/object-store";
import { HarnessProductionCompositionV2 } from
  "../src/harness/production-composition-v2";
import {
  createHarnessProductionGraphV2,
  type HarnessProductionGraphV2Options,
} from "../src/harness/production-graph-v2";
import {
  HARNESS_PRODUCTION_SEMANTIC_EVIDENCE_SIGNERS_V2,
  harnessProductionSemanticEvidenceInboxFileNameV2,
  importHarnessProductionSemanticEvidenceBatchV2,
  loadHarnessProductionSemanticEvidenceConfigV2,
} from "../src/harness/production-semantic-evidence-v2";
import {
  HarnessSemanticEvidenceSQLiteInventoryV2,
  HarnessSignedSemanticEvidenceCustodyV2,
  harnessSemanticEvidenceManifestSigningBytes,
  type HarnessSemanticEvidenceManifestV2,
  type HarnessSemanticEvidenceTrustedSignerV2,
  type HarnessSignedSemanticEvidenceBundleV2,
} from "../src/harness/semantic-evidence-custody-v2";
import {
  HARNESS_PINNED_CODEX_VERSION,
  HARNESS_SEMANTIC_PROVIDER_ID,
  SemanticHarnessFeatureGate,
  harnessSemanticEvidencePayloadBytes,
  requiredHarnessSemantics,
  type HarnessSemanticWitness,
} from "../src/harness/semantic-gate";
import {
  prepareHarnessStorageLayout,
  type HarnessPreparedStorageLayout,
} from "../src/harness/storage-layout";
import { applyMigrations } from "../src/state/database";

const nowAt = Date.parse("2030-01-01T12:00:00.000Z");
const accountProfileId = "acct_production_evidence";
const processGeneration = 11;
const binarySha256 = "a".repeat(64);
const signerKeyId = "oprte-production-semantic-test-1";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly database: Database;
  readonly layout: HarnessPreparedStorageLayout;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly signer: HarnessSemanticEvidenceTrustedSignerV2;
  readonly custody: HarnessSignedSemanticEvidenceCustodyV2;
  close(): void;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "oprte-production-evidence-"));
  temporaryRoots.push(root);
  const applicationSupport = join(root, "OPRTE");
  mkdirSync(applicationSupport, { mode: 0o700 });
  const controlPlanePath = join(applicationSupport, "control-plane.sqlite");
  writeFileSync(controlPlanePath, "sqlite fixture", { mode: 0o600 });
  const layout = prepareHarnessStorageLayout(controlPlanePath);
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  database.query(`
    INSERT INTO account_profiles (
      profile_id, label, auth_state, process_generation,
      selected, created_at, updated_at
    ) VALUES (?1, 'Evidence fixture', 'signed_in', ?2, 0, ?3, ?3)
  `).run(
    accountProfileId,
    processGeneration,
    new Date(nowAt).toISOString(),
  );
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signer = Object.freeze({
    signerKeyId,
    providerId: HARNESS_SEMANTIC_PROVIDER_ID,
    publicKey,
  });
  const custody = new HarnessSignedSemanticEvidenceCustodyV2({
    inventory: new HarnessSemanticEvidenceSQLiteInventoryV2(database),
    objects: new HarnessImmutableObjectStore({ directory: layout.objects }),
    trustedSigners: [signer],
    now: () => nowAt,
  });
  return {
    custody,
    database,
    layout,
    privateKey,
    publicKey,
    signer,
    close: () => database.close(),
  };
}

function makeBundle(input: Readonly<{
  privateKey: KeyObject;
  binary?: string;
  observedOffsetMs?: number;
}>): HarnessSignedSemanticEvidenceBundleV2 {
  const observedAt = new Date(
    nowAt + (input.observedOffsetMs ?? -60_000),
  ).toISOString();
  const expiresAt = new Date(Date.parse(observedAt) + 10 * 60_000)
    .toISOString();
  const binary = input.binary ?? binarySha256;
  const witnesses = requiredHarnessSemantics("recursiveAgents")
    .map((semantic): HarnessSemanticWitness => {
      const provisional = {
        version: 1 as const,
        providerId: HARNESS_SEMANTIC_PROVIDER_ID,
        semantic,
        codexVersion: HARNESS_PINNED_CODEX_VERSION,
        state: "proven" as const,
        probeId: `production.${semantic.toLowerCase()}`,
        probeDigest: createHash("sha256")
          .update(`probe:${semantic}`)
          .digest("hex"),
        observedAt,
        accountProfileId,
        accountGeneration: processGeneration,
        binarySha256: binary,
        processGeneration,
        evidenceObjectDigest: "0".repeat(64),
      };
      return Object.freeze({
        ...provisional,
        evidenceObjectDigest: createHash("sha256")
          .update(harnessSemanticEvidencePayloadBytes(provisional))
          .digest("hex"),
      });
    })
    .toSorted((left, right) => {
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
    runtimeBinarySha256: binary,
    codexVersion: HARNESS_PINNED_CODEX_VERSION,
    observedAt,
    expiresAt,
    witnesses,
  };
  return Object.freeze({
    version: 2,
    manifest,
    signature: Object.freeze({
      algorithm: "Ed25519",
      signerKeyId,
      value: sign(
        null,
        harnessSemanticEvidenceManifestSigningBytes(manifest),
        input.privateKey,
      ).toString("base64url"),
    }),
  });
}

function stageBundle(
  layout: HarnessPreparedStorageLayout,
  value: unknown,
): Readonly<{ bytes: Uint8Array; name: string; path: string }> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const name = harnessProductionSemanticEvidenceInboxFileNameV2(bytes);
  const path = join(layout.semanticEvidenceInbox, name);
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  return Object.freeze({ bytes, name, path });
}

function defaultCustody(value: Fixture): HarnessSignedSemanticEvidenceCustodyV2 {
  return new HarnessSignedSemanticEvidenceCustodyV2({
    inventory: new HarnessSemanticEvidenceSQLiteInventoryV2(value.database),
    objects: new HarnessImmutableObjectStore({
      directory: value.layout.objects,
    }),
    trustedSigners: HARNESS_PRODUCTION_SEMANTIC_EVIDENCE_SIGNERS_V2,
    now: () => nowAt,
  });
}

describe("production semantic evidence ingress v2", () => {
  test("the complete graph leaves signed semantic custody dormant", () => {
    const value = fixture();
    try {
      writeFileSync(
        join(value.layout.semanticEvidenceInbox, ".unexpected-stale-entry"),
        "not a signed evidence bundle",
      );
      const inert = Object.freeze({});
      const graph = createHarnessProductionGraphV2({
        accounts: inert as HarnessProductionGraphV2Options["accounts"],
        chatProjection: inert as HarnessProductionGraphV2Options["chatProjection"],
        composition: new HarnessProductionCompositionV2(),
        controlPlanePath: value.layout.applicationSupportRoot +
          "/control-plane.sqlite",
        database: value.database,
        git: Object.freeze({
          run: () => Promise.reject(new Error("unused Git fixture")),
        }),
        keyCustody: new HarnessInstallKeyCustody({
          secrets: {
            get: () => Promise.resolve(null),
            set: () => Promise.resolve(),
            delete: () => Promise.resolve(false),
          },
          randomMaster: () => new Uint8Array(32).fill(7),
        }),
        lifetimeLock: inert as HarnessProductionGraphV2Options["lifetimeLock"],
        panes: inert as HarnessProductionGraphV2Options["panes"],
        projection: inert as HarnessProductionGraphV2Options["projection"],
        rendererProjection:
          inert as HarnessProductionGraphV2Options["rendererProjection"],
        repositories: inert as HarnessProductionGraphV2Options["repositories"],
        runtimes: inert as HarnessProductionGraphV2Options["runtimes"],
        sessions: inert as HarnessProductionGraphV2Options["sessions"],
        onActorSessionRecoveryFatalFailure: () => undefined,
        createChat: () => inert as ChatService,
      });
      expect(graph).not.toHaveProperty("semanticEvidence");
    } finally {
      value.close();
    }
  });

  test("the empty production inbox grants no semantic authority", async () => {
    const value = fixture();
    try {
      const config = loadHarnessProductionSemanticEvidenceConfigV2(value.layout);
      expect(config.importBundles).toEqual([]);
      const custody = defaultCustody(value);
      const gate = new SemanticHarnessFeatureGate({
        evidence: custody,
        witnesses: custody,
        runtime: {
          resolveBinding: (binding) => Promise.resolve({
            ...binding,
            providerId: HARNESS_SEMANTIC_PROVIDER_ID,
            codexVersion: HARNESS_PINNED_CODEX_VERSION,
            binarySha256,
            nowMs: nowAt,
          }),
        },
      });
      expect(await gate.decide("recursiveAgents", {
        requestInstanceId: 1,
        accountProfileId,
        accountGeneration: processGeneration,
        processGeneration,
      })).toMatchObject({ enabled: false, reason: "missing_witness" });
    } finally {
      value.close();
    }
  });

  test("imports a canonical externally signed inbox bundle with explicit signer trust", async () => {
    const value = fixture();
    try {
      const bundle = makeBundle({ privateKey: value.privateKey });
      stageBundle(value.layout, bundle);
      const config = loadHarnessProductionSemanticEvidenceConfigV2(value.layout);
      expect(config.importBundles).toHaveLength(1);
      importHarnessProductionSemanticEvidenceBatchV2(
        value.database,
        value.custody,
        config.importBundles,
      );
      expect(await value.custody.listWitnesses({
        requestInstanceId: 1,
        accountProfileId,
        accountGeneration: processGeneration,
        processGeneration,
      })).toEqual(bundle.manifest.witnesses);
    } finally {
      value.close();
    }
  });

  test("reads canonical files in deterministic bytewise filename order", () => {
    const value = fixture();
    try {
      const first = makeBundle({
        privateKey: value.privateKey,
        observedOffsetMs: -120_000,
      });
      const second = makeBundle({
        privateKey: value.privateKey,
        observedOffsetMs: -60_000,
      });
      const staged = [
        stageBundle(value.layout, second),
        stageBundle(value.layout, first),
      ].toSorted((left, right) => left.name < right.name ? -1 : 1);
      const config = loadHarnessProductionSemanticEvidenceConfigV2(value.layout);
      expect(config.importBundles.map((bundle) => bundle.signature.value))
        .toEqual(staged.map(({ bytes }) =>
          (JSON.parse(new TextDecoder().decode(bytes)) as {
            signature: { value: string };
          }).signature.value
        ));
    } finally {
      value.close();
    }
  });

  test("rejects links, non-files, relaxed permissions, oversized files, and mutation", () => {
    for (const scenario of [
      "symlink",
      "hard_link",
      "directory",
      "permissions",
      "oversized",
      "mutation",
    ] as const) {
      const value = fixture();
      try {
        const bundle = makeBundle({ privateKey: value.privateKey });
        const bytes = new TextEncoder().encode(JSON.stringify(bundle));
        const name = harnessProductionSemanticEvidenceInboxFileNameV2(bytes);
        const path = join(value.layout.semanticEvidenceInbox, name);
        if (scenario === "symlink" || scenario === "hard_link") {
          const outside = join(value.layout.root, `${scenario}.json`);
          writeFileSync(outside, bytes, { mode: 0o600 });
          if (scenario === "symlink") symlinkSync(outside, path);
          else linkSync(outside, path);
        } else if (scenario === "directory") {
          mkdirSync(path, { mode: 0o700 });
        } else if (scenario === "permissions") {
          writeFileSync(path, bytes, { mode: 0o644 });
        } else if (scenario === "oversized") {
          const oversized = Buffer.alloc(256 * 1024 + 1, 0x20);
          const digest = createHash("sha256").update(oversized).digest("hex");
          writeFileSync(
            join(
              value.layout.semanticEvidenceInbox,
              `semantic-evidence-v2-${digest}.json`,
            ),
            oversized,
            { mode: 0o600 },
          );
        } else {
          writeFileSync(path, bytes, { mode: 0o600 });
        }
        const run = () => loadHarnessProductionSemanticEvidenceConfigV2(
          value.layout,
          scenario === "mutation"
            ? { afterCandidateBytesRead: () => chmodSync(path, 0o400) }
            : {},
        );
        expect(run).toThrow(expect.objectContaining({
          code: scenario === "oversized"
            ? "inbox_limit"
            : scenario === "mutation"
            ? "entry_tampered"
            : "unsafe_entry",
        }));
      } finally {
        value.close();
      }
    }
  });

  test("rejects replacement or permission drift of the bound inbox directory", () => {
    for (const scenario of ["replacement", "permissions"] as const) {
      const value = fixture();
      try {
        if (scenario === "replacement") {
          const displaced = `${value.layout.semanticEvidenceInbox}.displaced`;
          renameSync(value.layout.semanticEvidenceInbox, displaced);
          symlinkSync(displaced, value.layout.semanticEvidenceInbox);
        } else {
          chmodSync(value.layout.semanticEvidenceInbox, 0o750);
        }
        expect(() => loadHarnessProductionSemanticEvidenceConfigV2(
          value.layout,
        )).toThrow(expect.objectContaining({ code: "unsafe_inbox" }));
      } finally {
        value.close();
      }
    }
  });

  test("rejects an inbox directory mutation during a candidate read", () => {
    const value = fixture();
    try {
      stageBundle(value.layout, makeBundle({ privateKey: value.privateKey }));
      expect(() => loadHarnessProductionSemanticEvidenceConfigV2(
        value.layout,
        {
          afterCandidateBytesRead: () => writeFileSync(
            join(value.layout.semanticEvidenceInbox, ".raced-entry"),
            "raced",
            { mode: 0o600 },
          ),
        },
      )).toThrow(expect.objectContaining({ code: "unsafe_inbox" }));
    } finally {
      value.close();
    }
  });

  test("rejects unexpected entries and an over-count inbox before parsing", () => {
    const unexpected = fixture();
    try {
      writeFileSync(
        join(unexpected.layout.semanticEvidenceInbox, ".DS_Store"),
        "metadata",
        { mode: 0o600 },
      );
      expect(() => loadHarnessProductionSemanticEvidenceConfigV2(
        unexpected.layout,
      )).toThrow(expect.objectContaining({ code: "unexpected_entry" }));
    } finally {
      unexpected.close();
    }

    const overCount = fixture();
    try {
      for (let index = 0; index < 17; index += 1) {
        stageBundle(overCount.layout, { index });
      }
      expect(() => loadHarnessProductionSemanticEvidenceConfigV2(
        overCount.layout,
      )).toThrow(expect.objectContaining({ code: "inbox_limit" }));
    } finally {
      overCount.close();
    }
  });

  test("rejects malformed JSON and a filename that does not bind its exact bytes", () => {
    for (const scenario of ["malformed", "digest_mismatch"] as const) {
      const value = fixture();
      try {
        const bytes = new TextEncoder().encode(
          scenario === "malformed" ? "{\"version\":" : "{}",
        );
        const digest = scenario === "malformed"
          ? createHash("sha256").update(bytes).digest("hex")
          : "f".repeat(64);
        writeFileSync(
          join(
            value.layout.semanticEvidenceInbox,
            `semantic-evidence-v2-${digest}.json`,
          ),
          bytes,
          { mode: 0o600 },
        );
        expect(() => loadHarnessProductionSemanticEvidenceConfigV2(
          value.layout,
        )).toThrow(expect.objectContaining({
          code: scenario === "malformed"
            ? "bundle_invalid"
            : "entry_tampered",
        }));
      } finally {
        value.close();
      }
    }
  });

  test("rolls back a conflicting or untrusted import batch without authority", () => {
    for (const scenario of ["conflicting", "untrusted"] as const) {
      const value = fixture();
      try {
        const bundles = scenario === "conflicting"
          ? [
              makeBundle({
                privateKey: value.privateKey,
                observedOffsetMs: -120_000,
              }),
              makeBundle({
                privateKey: value.privateKey,
                binary: "b".repeat(64),
                observedOffsetMs: -60_000,
              }),
            ]
          : [makeBundle({ privateKey: value.privateKey })];
        const custody = scenario === "conflicting"
          ? value.custody
          : defaultCustody(value);
        expect(() => importHarnessProductionSemanticEvidenceBatchV2(
          value.database,
          custody,
          bundles,
        )).toThrow();
        expect(value.database.query(`
          SELECT COUNT(*) AS count FROM harness_semantic_evidence_bundles
        `).get()).toEqual({ count: 0 });
      } finally {
        value.close();
      }
    }
  });

  test("never promotes a persisted inventory row into signer trust", async () => {
    const value = fixture();
    try {
      importHarnessProductionSemanticEvidenceBatchV2(
        value.database,
        value.custody,
        [makeBundle({ privateKey: value.privateKey })],
      );
      const custody = defaultCustody(value);
      let rejected: unknown = null;
      try {
        await custody.listWitnesses({
          requestInstanceId: 1,
          accountProfileId,
          accountGeneration: processGeneration,
          processGeneration,
        });
      } catch (error: unknown) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(Error);
      expect(value.database.query(`
        SELECT state, quarantine_reason
        FROM harness_semantic_evidence_bundles
      `).get()).toEqual({
        state: "quarantined",
        quarantine_reason: "signature_invalid",
      });
    } finally {
      value.close();
    }
  });
});
