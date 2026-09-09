import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { canonical24ResetDatabaseBytes, canonical24ResetFixture, canonical24ResetFixtureGeneratorSource } from "./fixtures/canonical24-reset";
import { canonical30WorkDatabaseBytes, canonical30WorkFixture, canonical30WorkFixtureGeneratorSource } from "./fixtures/canonical30-work";
import { canonical34StorageDatabaseBytes, canonical34StorageFixture } from "./fixtures/canonical34-storage";
import { canonical35To38DatabaseBytes, canonical35To38Fixture, canonical35To38GeneratorSource, type Canonical35To38Scenario } from "./fixtures/canonical35-38";
import { canonical20To40DatabaseBytes, canonical20To40Fixture, canonical20To40GeneratorSource, type Canonical20To40Scenario } from "./fixtures/canonical20-40";
import { canonical38RuntimeDatabaseBytes, canonical38RuntimeFixture, canonical38RuntimeGeneratorSource } from "./fixtures/canonical38-runtime";
import { observed2DatabaseBytes, observed2Fixture, observed2GeneratorSource } from "./fixtures/observed2-stage";
import { canonicalAdoption35DatabaseBytes, canonicalAdoption35Fixture, canonicalAdoption35GeneratorSource } from "./fixtures/canonical-adoption35";
import { canonicalIdentityAttentionDatabaseBytes, canonicalIdentityAttentionFixtures, canonicalIdentityAttentionGeneratorSource, type CanonicalIdentityAttentionScenario } from "./fixtures/canonical-identity-attention";
import { canonicalSessionStartDatabaseBytes, canonicalSessionStartFixtures, type CanonicalSessionStartScenario } from "./fixtures/canonical-session-start";
import { canonicalEarlyMigrationDatabaseBytes, canonicalEarlyMigrationFixture } from "./fixtures/canonical-early-migration";
import { canonical39AttachmentDatabaseBytes, canonical39AttachmentFixtures } from "./fixtures/canonical39-attachments";
import { canonicalLabelPresetDatabaseBytes, canonicalLabelPresetFixture, type CanonicalLabelPresetScenario } from "./fixtures/canonical-label-preset";
import { canonicalResetPolicyDatabaseBytes, canonicalResetPolicyFixtures } from "./fixtures/canonical-reset-policy";
import { canonical39SwitchDatabaseBytes, canonical39SwitchFixtures } from "./fixtures/canonical39-switch";
import { canonical39RetiredRecoveryDatabaseBytes, canonical39RetiredRecoveryFixtures } from "./fixtures/canonical39-retired-recovery";
import { canonical39RetiredTargetDatabaseBytes, canonical39RetiredTargetFixtures } from "./fixtures/canonical39-retired-targets";
import { canonicalLoginLedgerDatabaseBytes, canonicalLoginLedgerFixtures } from "./fixtures/canonical-login-ledger";
import { canonicalAdoption40DatabaseBytes, canonicalAdoption40Fixture, canonicalAdoption40FixtureGeneratorSource } from "./fixtures/canonical-adoption40";
import { canonical40QueuesDatabaseBytes, canonical40QueuesFixture, canonical40QueuesFixtureGeneratorSource } from "./fixtures/canonical40-queues";
import { canonical40UsageDatabaseBytes, canonical40UsageFixture, canonical40UsageFixtureGeneratorSource } from "./fixtures/canonical40-usage";
import { canonical41TimestampsDatabaseBytes, canonical41TimestampsFixture, canonical41TimestampsGeneratorSource } from "./fixtures/canonical41-timestamps";
import { canonical43MemoryDatabaseBytes, canonical43MemoryFixture, canonical43MemoryGeneratorSource } from "./fixtures/canonical43-memory";
import { canonical48WorkDatabaseBytes, canonical48WorkFixture } from "./fixtures/canonical48-work";
import { canonical50CollisionDatabaseBytes, canonical50CollisionFixture } from "./fixtures/canonical50-collision";
import { privateTask48DatabaseBytes, privateTask48Fixture, privateTask48FixtureDatabaseIdentity, privateTask48FixtureGeneratorSource } from "./fixtures/private-task48";
import { privateTask48PinnedDatabaseBytes, privateTask48PinnedDatabaseIdentity, privateTask48PinnedFixture, privateTask48PinnedGeneratorSource } from "./fixtures/private-task48-pinned";
import { privateTask48UsageDatabaseBytes, privateTask48UsageFixture, privateTask48UsageGeneratorSource } from "./fixtures/private-task48-usage";
import { combined49ArchiveProvenance, combined49DatabaseBytes, combined49Fixture, combined49GeneratorSource } from "./fixtures/combined49";
import { combined49SwitchArchiveProvenance, combined49SwitchDatabaseBytes, combined49SwitchFixture, combined49SwitchGeneratorSource } from "./fixtures/combined49-switch";
import { combined49RetiredArchiveProvenance, combined49RetiredDatabaseBytes, combined49RetiredFixture, combined49RetiredGeneratorSource } from "./fixtures/combined49-retired";
import { assertPublicSensitiveText } from "./public-text-policy";
import { syntheticAdoption36SchemaFixture, syntheticAdoption36SchemaObjects } from "./fixtures/synthetic-adoption36-schema";
import { syntheticAdoption36 } from "./fixtures/synthetic-adoption36";

const fixtures: readonly Readonly<{
  name: string;
  bytes: () => Uint8Array;
  generator: string;
  metadata: unknown;
}>[] = [
  { name: "canonical24-reset", bytes: canonical24ResetDatabaseBytes, generator: canonical24ResetFixtureGeneratorSource, metadata: canonical24ResetFixture },
  { name: "canonical30-work", bytes: canonical30WorkDatabaseBytes, generator: canonical30WorkFixtureGeneratorSource, metadata: canonical30WorkFixture },
  { name: "canonical34-storage", bytes: canonical34StorageDatabaseBytes,
    generator: readFileSync(new URL("./fixtures/canonical34-storage-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata: canonical34StorageFixture },
  ...Object.values(canonicalEarlyMigrationFixture.images).map((image) => ({
    name: `early-migration-${String(image.version)}-${image.provenance.kind}`,
    bytes: () => canonicalEarlyMigrationDatabaseBytes(image.version),
    generator: readFileSync(new URL("./fixtures/canonical-early-migration-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata: { ...canonicalEarlyMigrationFixture, selectedVersion: image.version },
  })),
  ...Object.keys(canonicalLabelPresetFixture.captures).map((scenario) => ({
    name: `label-preset-${scenario}`,
    bytes: () => canonicalLabelPresetDatabaseBytes(scenario as CanonicalLabelPresetScenario),
    generator: readFileSync(new URL("./fixtures/canonical-label-preset-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata: { ...canonicalLabelPresetFixture, selectedScenario: scenario },
  })),
  ...Object.keys(canonical35To38Fixture.captures).map((scenario) => ({
    name: `canonical35-38-${scenario}`,
    bytes: () => canonical35To38DatabaseBytes(scenario as Canonical35To38Scenario),
    generator: canonical35To38GeneratorSource,
    metadata: { ...canonical35To38Fixture, selectedScenario: scenario },
  })),
  ...Object.keys(canonical20To40Fixture.captures).map((scenario) => ({
    name: `legacy20-40-${scenario}`,
    bytes: () => canonical20To40DatabaseBytes(scenario as Canonical20To40Scenario),
    generator: canonical20To40GeneratorSource,
    metadata: { ...canonical20To40Fixture, selectedScenario: scenario },
  })),
  { name: "canonical38-runtime", bytes: canonical38RuntimeDatabaseBytes,
    generator: canonical38RuntimeGeneratorSource, metadata: canonical38RuntimeFixture },
  { name: "observed2-stage", bytes: observed2DatabaseBytes,
    generator: observed2GeneratorSource, metadata: observed2Fixture },
  { name: "canonical-adoption35", bytes: canonicalAdoption35DatabaseBytes,
    generator: canonicalAdoption35GeneratorSource, metadata: canonicalAdoption35Fixture },
  ...Object.keys(canonicalIdentityAttentionFixtures).map((scenario) => ({
    name: `identity-attention-${scenario}`,
    bytes: () => canonicalIdentityAttentionDatabaseBytes(scenario as CanonicalIdentityAttentionScenario),
    generator: canonicalIdentityAttentionGeneratorSource,
    metadata: canonicalIdentityAttentionFixtures[scenario as CanonicalIdentityAttentionScenario],
  })),
  ...Object.values(canonicalResetPolicyFixtures).map((metadata) => ({
    name: `canonical-reset-policy-${String(metadata.version)}`,
    bytes: () => canonicalResetPolicyDatabaseBytes(metadata.version),
    generator: readFileSync(new URL("./fixtures/canonical-reset-policy-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata,
  })),
  ...Object.values(canonical39AttachmentFixtures).map((metadata) => ({
    name: `canonical39-attachments-${metadata.scenario}`,
    bytes: () => canonical39AttachmentDatabaseBytes(metadata.scenario),
    generator: readFileSync(new URL("./fixtures/canonical39-attachments-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata,
  })),
  ...Object.entries(canonicalSessionStartFixtures).map(([scenario, metadata]) => ({
    name: `session-start-${scenario}`,
    bytes: () => canonicalSessionStartDatabaseBytes(scenario as CanonicalSessionStartScenario),
    generator: readFileSync(new URL("./fixtures/canonical-session-start-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata,
  })),
  ...Object.values(canonical39SwitchFixtures).map((metadata) => ({
    name: `canonical39-switch-${metadata.scenario.name}`,
    bytes: () => canonical39SwitchDatabaseBytes(metadata.scenario.name),
    generator: readFileSync(new URL("./fixtures/canonical39-switch-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata,
  })),
  ...Object.values(canonical39RetiredRecoveryFixtures).map((metadata) => ({
    name: `canonical39-retired-recovery-${metadata.scenario}`,
    bytes: () => canonical39RetiredRecoveryDatabaseBytes(metadata.scenario),
    generator: readFileSync(new URL("./fixtures/canonical39-retired-recovery-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata,
  })),
  ...Object.values(canonical39RetiredTargetFixtures).map((metadata) => ({
    name: `canonical39-retired-targets-${metadata.scenario}`,
    bytes: () => canonical39RetiredTargetDatabaseBytes(metadata.scenario),
    generator: readFileSync(new URL("./fixtures/canonical39-retired-targets-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata,
  })),
  ...Object.values(canonicalLoginLedgerFixtures).map((metadata) => ({
    name: `canonical${String(metadata.schemaVersion)}-login-ledger`,
    bytes: () => canonicalLoginLedgerDatabaseBytes(metadata.schemaVersion),
    generator: readFileSync(new URL("./fixtures/canonical-login-ledger-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata,
  })),
  { name: "canonical-adoption40", bytes: canonicalAdoption40DatabaseBytes, generator: canonicalAdoption40FixtureGeneratorSource, metadata: canonicalAdoption40Fixture },
  { name: "canonical40-queues", bytes: canonical40QueuesDatabaseBytes, generator: canonical40QueuesFixtureGeneratorSource, metadata: canonical40QueuesFixture },
  { name: "canonical40-usage", bytes: canonical40UsageDatabaseBytes, generator: canonical40UsageFixtureGeneratorSource, metadata: canonical40UsageFixture },
  { name: "canonical41-timestamps", bytes: canonical41TimestampsDatabaseBytes, generator: canonical41TimestampsGeneratorSource, metadata: canonical41TimestampsFixture },
  { name: "canonical43-memory", bytes: canonical43MemoryDatabaseBytes, generator: canonical43MemoryGeneratorSource, metadata: canonical43MemoryFixture },
  { name: "canonical48-work", bytes: canonical48WorkDatabaseBytes,
    generator: readFileSync(new URL("./fixtures/canonical48-work-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata: canonical48WorkFixture },
  { name: "canonical50-collision", bytes: canonical50CollisionDatabaseBytes,
    generator: readFileSync(new URL("./fixtures/canonical50-collision-generator.original.ts.txt", import.meta.url), "utf8"),
    metadata: canonical50CollisionFixture },
  { name: "private-task48", bytes: privateTask48DatabaseBytes, generator: privateTask48FixtureGeneratorSource, metadata: { fixture: privateTask48Fixture, identity: privateTask48FixtureDatabaseIdentity } },
  { name: "private-task48-pinned", bytes: privateTask48PinnedDatabaseBytes, generator: privateTask48PinnedGeneratorSource, metadata: { fixture: privateTask48PinnedFixture, identity: privateTask48PinnedDatabaseIdentity } },
  { name: "private-task48-usage", bytes: privateTask48UsageDatabaseBytes, generator: privateTask48UsageGeneratorSource, metadata: privateTask48UsageFixture },
  { name: "combined49", bytes: combined49DatabaseBytes, generator: combined49GeneratorSource, metadata: { fixture: combined49Fixture, provenance: combined49ArchiveProvenance } },
  { name: "combined49-switch", bytes: combined49SwitchDatabaseBytes, generator: combined49SwitchGeneratorSource, metadata: { fixture: combined49SwitchFixture, provenance: combined49SwitchArchiveProvenance } },
  { name: "combined49-retired", bytes: combined49RetiredDatabaseBytes, generator: combined49RetiredGeneratorSource, metadata: { fixture: combined49RetiredFixture, provenance: combined49RetiredArchiveProvenance } },
];

// Inspect complete images, including stale cells/free pages and UTF-16 blobs.
// Generator source uses the public text policy: bare prefix denylist literals
// are not themselves private paths. The sole image exception below is bound
// to an exact immutable capture, not an inferred SQLite/text field boundary.
const hostPrefixes = ["/Users/", "/home/", "/private/", "/tmp/", "/var/folders/", "\\Users\\"] as const;
const encodings = ["utf8", "utf16le", "utf16be"] as const;
type FixtureEncoding = (typeof encodings)[number];
const encode = (text: string, encoding: FixtureEncoding): Buffer =>
  encoding === "utf16be" ? Buffer.from(text, "utf16le").swap16() : Buffer.from(text, encoding);
type RootSpan = Readonly<{ start: number; end: number; encoding: FixtureEncoding }>;
const publicProjectRoot = "/private/tmp/hra-public-canonical43-fixture/project";

const assertNoHostPrefixes = (bytes: Buffer, admittedSpans: readonly RootSpan[] = []): void => {
  for (const prefix of hostPrefixes) {
    for (const encoding of encodings) {
      const encodedPrefix = encode(prefix, encoding);
      for (let at = bytes.indexOf(encodedPrefix); at !== -1; at = bytes.indexOf(encodedPrefix, at + 1)) {
        // Every byte inside a proved complete root is public, including an
        // interior ASCII substring seen at the opposite UTF-16 alignment.
        if (!admittedSpans.some((span) => (span.encoding === encoding
          || (span.encoding !== "utf8" && encoding !== "utf8"))
          && at >= span.start && at + encodedPrefix.length <= span.end)) {
          throw new Error("HISTORICAL_FIXTURE_HOST_PATH");
        }
      }
    }
  }
};

const assertCanonical43CapturedPaths = (bytes: Buffer): void => {
  // A table cell packs the title directly against root_path; text boundaries
  // cannot prove that field. Admit only the two reviewed UTF-8 byte spans in
  // this entire checksum-verified image (table value and unique index value).
  if (bytes.byteLength !== 1_892_352
    || createHash("sha256").update(bytes).digest("hex") !== "046f5ede0c377a0db943206e09b6dfbee5e8aa0a55d90e06f98e0faf6f9ffeb5") {
    throw new Error("HISTORICAL_FIXTURE_CAPTURE_MISMATCH");
  }
  const rootBytes = Buffer.from(publicProjectRoot, "utf8");
  const starts: number[] = [];
  for (let at = bytes.indexOf(rootBytes); at !== -1; at = bytes.indexOf(rootBytes, at + 1)) starts.push(at);
  if (starts.length !== 2 || starts[0] !== 32_684 || starts[1] !== 40_909) {
    throw new Error("HISTORICAL_FIXTURE_ROOT_SPANS_MISMATCH");
  }
  assertNoHostPrefixes(bytes, starts.map((start) => ({ start, end: start + rootBytes.length, encoding: "utf8" })));
};

// For independent textual fields, unlike packed SQLite cells, both boundaries
// must be explicit. Never admit descendants, lookalikes or relative prefixes.
const isTextBoundary = (unit: number | undefined): boolean => unit === undefined
  || [0, 9, 10, 13, 32, 34, 39, 44, 59, 91, 93, 123, 125].includes(unit);
const assertPublicProjectPathText = (bytes: Buffer): void => {
  const spans: RootSpan[] = [];
  for (const encoding of encodings) {
    const rootBytes = encode(publicProjectRoot, encoding);
    const width = encoding === "utf8" ? 1 : 2;
    const unitAt = (at: number): number => encoding === "utf8" ? bytes.readUInt8(at)
      : encoding === "utf16be" ? bytes.readUInt16BE(at) : bytes.readUInt16LE(at);
    for (let at = bytes.indexOf(rootBytes); at !== -1; at = bytes.indexOf(rootBytes, at + 1)) {
      const end = at + rootBytes.length;
      const startsAtBoundary = at === 0 || (at >= width && isTextBoundary(unitAt(at - width)));
      const endsAtBoundary = end === bytes.length || (end + width <= bytes.length && isTextBoundary(unitAt(end)));
      if (startsAtBoundary && endsAtBoundary) {
        spans.push({ start: at, end, encoding });
        // ASCII UTF-16 bytes can also spell the complete same root in the
        // opposite byte order at a one-byte offset. Admit that exact whole
        // byte sequence only after the actual text field's two boundaries
        // were proved; a prefix-shaped substring alone grants nothing.
        if (encoding !== "utf8") {
          const opposite = encoding === "utf16le" ? "utf16be" : "utf16le";
          const shifted = at + (encoding === "utf16le" ? -1 : 1);
          const encoded = encode(publicProjectRoot, opposite);
          if (shifted >= 0 && shifted + encoded.length <= bytes.length
            && bytes.subarray(shifted, shifted + encoded.length).equals(encoded)) {
            spans.push({ start: shifted, end: shifted + encoded.length, encoding: opposite });
          }
        }
      }
    }
  }
  assertNoHostPrefixes(bytes, spans);
};

const assertFixtureMetadataPaths = (metadata: unknown, canonical43 = false): void => {
  let originalSourceFields = 0;
  const visit = (value: unknown, path: readonly (string | number)[]): void => {
    if (typeof value === "string") {
      // Only this exact root-level field is source rather than metadata. Its
      // pinned checksum grants no exemption to a same-named nested field.
      if (canonical43 && path.length === 2 && path[0] === "regenerationInputs" && path[1] === "originalGeneratorSource") {
        if (createHash("sha256").update(value).digest("hex") !== "8f87f678feb2ce27de26029d5475fa5935c7f131e4dd87f0d25cce7a7a7ee8da") {
          throw new Error("HISTORICAL_FIXTURE_SOURCE_MISMATCH");
        }
        assertPublicSensitiveText(value, "canonical43 original generator source");
        originalSourceFields++;
      } else if (canonical43 && value === publicProjectRoot) {
        // Metadata must hold exactly the complete root, not a sentence or
        // serialized structure with a root-shaped substring inside it.
        assertPublicProjectPathText(Buffer.from(value));
      } else {
        assertNoHostPrefixes(Buffer.from(value));
      }
    } else if (Array.isArray(value)) {
      value.forEach((child: unknown, index: number) => visit(child, [...path, index]));
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        assertNoHostPrefixes(Buffer.from(key));
        visit(child, [...path, key]);
      }
    } else if (value !== null && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("HISTORICAL_FIXTURE_METADATA_INVALID");
    }
  };
  visit(metadata, []);
  if (canonical43 && originalSourceFields !== 1) throw new Error("HISTORICAL_FIXTURE_SOURCE_MISMATCH");
};

describe("historical fixture decoded privacy", () => {
  for (const fixture of fixtures) {
    test(`${fixture.name} contains only public synthetic evidence in source, metadata and complete SQLite bytes`, () => {
      // Each exported decoder verifies its exact captured checksum/byte count.
      // No database is opened and no migration or generated source is executed.
      const bytes = Buffer.from(fixture.bytes());
      expect(bytes.byteLength).toBeGreaterThanOrEqual(100);
      expect(bytes.subarray(0, 16).toString("ascii")).toBe("SQLite format 3\0");
      expect(bytes.readUInt32BE(56)).toBe(1); // SQLite text encoding: UTF-8.
      expect(() => assertPublicSensitiveText(fixture.generator, `${fixture.name} generator`)).not.toThrow();
      expect(() => assertPublicSensitiveText(JSON.stringify(fixture.metadata), `${fixture.name} metadata`)).not.toThrow();
      expect(() => assertFixtureMetadataPaths(fixture.metadata, fixture.name === "canonical43-memory")).not.toThrow();
      expect(() => assertPublicSensitiveText(bytes.toString("utf8"), `${fixture.name} decoded database`)).not.toThrow();
      if (fixture.name === "canonical43-memory") {
        expect(canonical43MemoryFixture.publicFixtureProjectRoot).toBe(publicProjectRoot);
        expect(() => assertCanonical43CapturedPaths(bytes)).not.toThrow();
      } else {
        expect(() => assertNoHostPrefixes(bytes)).not.toThrow();
      }
    });
  }
});

describe("synthetic recognizer fixture privacy and qualification", () => {
  test("adoption-v36 frozen SQL and constrained seed are explicitly synthetic, public and source-pinned", () => {
    const objects = syntheticAdoption36SchemaObjects();
    const recipe = readFileSync(new URL("./fixtures/synthetic-adoption36-builder.original.ts.txt", import.meta.url), "utf8");
    const seed = readFileSync(new URL("./fixtures/synthetic-adoption36.ts", import.meta.url), "utf8");
    expect(syntheticAdoption36SchemaFixture.historicalWriterProvenance).toBe(false);
    expect(syntheticAdoption36.historicalWriterProvenance).toBe(false);
    expect(syntheticAdoption36SchemaFixture.kind).toBe("synthetic_adoption_v36_recognizer_contract");
    expect(createHash("sha256").update(recipe).digest("hex"))
      .toBe("d10b93bc2cef84bee6b955d2934276234170ca8d3f25a33ef8c7615648fef54f");
    expect(objects.length).toBe(syntheticAdoption36SchemaFixture.objectCount);
    expect(objects.filter(({ type }) => type === "table").length).toBe(syntheticAdoption36SchemaFixture.tableCount);
    const bytes = Buffer.from(JSON.stringify(objects));
    expect(bytes.byteLength).toBe(syntheticAdoption36SchemaFixture.schemaBytes);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(syntheticAdoption36SchemaFixture.schemaSha256);
    expect(() => assertNoHostPrefixes(bytes)).not.toThrow();
    for (const [name, value] of [["recipe", recipe], ["seed", seed], ["schema", bytes.toString("utf8")]] as const) {
      expect(() => assertPublicSensitiveText(value, `synthetic adoption36 ${name}`)).not.toThrow();
    }
    for (const metadata of [syntheticAdoption36SchemaFixture, syntheticAdoption36]) {
      expect(() => assertFixtureMetadataPaths(metadata)).not.toThrow();
      expect(() => assertPublicSensitiveText(JSON.stringify(metadata), "synthetic adoption36 metadata")).not.toThrow();
    }
    // Decode afresh: a caller cannot rewrite the frozen expected schema for a
    // later test. No historical database image or archived writer is executed.
    const first = objects[0];
    if (first === undefined) throw new Error("Synthetic schema is empty.");
    first.sql = "SELECT 1";
    expect(syntheticAdoption36SchemaObjects()[0]?.sql).not.toBe(first.sql);
  });
});

describe("historical fixture public-root exception boundaries", () => {
  test("actual canonical43 metadata admits only whole-root fields and refuses mutated provenance paths", () => {
    expect(() => assertFixtureMetadataPaths(canonical43MemoryFixture, true)).not.toThrow();
    for (const path of ["/private/tmp/unreviewed-fixture/project", `${publicProjectRoot}-sibling`, `archive${publicProjectRoot}`, `embedded "${publicProjectRoot}" text`]) {
      const changed = { ...canonical43MemoryFixture, publicFixtureProjectRoot: path };
      expect(() => assertFixtureMetadataPaths(changed, true)).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
    }
    const nested = { ...canonical43MemoryFixture, extra: [{ originalGeneratorSource: "/private/tmp/unreviewed-generator.ts" }] };
    expect(() => assertFixtureMetadataPaths(nested, true)).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
    const changedSource = {
      ...canonical43MemoryFixture,
      regenerationInputs: {
        ...canonical43MemoryFixture.regenerationInputs,
        originalGeneratorSource: `${canonical43MemoryFixture.regenerationInputs.originalGeneratorSource}\n`,
      },
    };
    expect(() => assertFixtureMetadataPaths(changedSource, true)).toThrow("HISTORICAL_FIXTURE_SOURCE_MISMATCH");
    // A matching property name or even the public root grants nothing to any
    // other fixture. Canonical41's genuine relative provenance remains valid.
    expect(() => assertFixtureMetadataPaths(canonical41TimestampsFixture)).not.toThrow();
    expect(() => assertFixtureMetadataPaths({ ...canonical41TimestampsFixture, outputPath: publicProjectRoot })).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
    expect(() => assertFixtureMetadataPaths({ ...canonical41TimestampsFixture, regenerationInputs: { originalGeneratorSource: "/private/tmp/unreviewed-generator.ts" } })).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
  });

  for (const encoding of encodings) {
    test(`${encoding} accepts only complete public-root text fields`, () => {
      for (const value of [publicProjectRoot, JSON.stringify({ root: publicProjectRoot }), `\0${publicProjectRoot}\0`, ` ${publicProjectRoot}\n`]) {
        expect(() => assertPublicProjectPathText(encode(value, encoding))).not.toThrow();
      }
      expect(() => assertPublicProjectPathText(encode("archive/src/storage/state-store.ts", encoding))).not.toThrow();
      // Even an exact public root stays forbidden outside its explicit scope.
      expect(() => assertNoHostPrefixes(encode(publicProjectRoot, encoding))).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
    });

    test(`${encoding} rejects descendants, siblings, private roots and relative provenance embeddings`, () => {
      const privateUserRoot = ["", "Users", "synthetic-private-account", "project"].join("/");
      const values = [
        `${publicProjectRoot}/child`, `${publicProjectRoot}/`, `${publicProjectRoot}\\child`,
        `${publicProjectRoot}-sibling`, `${publicProjectRoot}.sqlite`, `${publicProjectRoot}é`,
        `${publicProjectRoot}%2fchild`, publicProjectRoot.slice(0, -1),
        "/private/tmp/unreviewed-fixture/project", privateUserRoot,
        `archive${publicProjectRoot}`, `.${publicProjectRoot}`, `..${publicProjectRoot}`,
        `archive/src${publicProjectRoot}`, `é${publicProjectRoot}`,
      ];
      for (const value of values) {
        expect(() => assertPublicProjectPathText(encode(value, encoding))).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
      }
    });

    test(`${encoding} scans every byte offset and rejects truncated encoded boundaries`, () => {
      const framed = Buffer.concat([Buffer.from([0xff]), encode(`"${publicProjectRoot}"`, encoding)]);
      expect(() => assertPublicProjectPathText(framed)).not.toThrow();
      expect(() => assertNoHostPrefixes(framed)).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
      const unframed = Buffer.concat([Buffer.from([0xff]), encode(publicProjectRoot, encoding), Buffer.from([0xff])]);
      expect(() => assertPublicProjectPathText(unframed)).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
    });
  }

  test("canonical43 root spans require the original whole image, never caller metadata or altered bytes", () => {
    const original = Buffer.from(canonical43MemoryDatabaseBytes());
    expect(() => assertNoHostPrefixes(original)).toThrow("HISTORICAL_FIXTURE_HOST_PATH");
    for (const offset of [32_683, 32_684, 32_684 + Buffer.byteLength(publicProjectRoot), 40_908, 40_909, 40_909 + Buffer.byteLength(publicProjectRoot), 1_000_000]) {
      const changed = Buffer.from(original);
      changed[offset] = changed.readUInt8(offset) ^ 1;
      expect(() => assertCanonical43CapturedPaths(changed)).toThrow("HISTORICAL_FIXTURE_CAPTURE_MISMATCH");
    }
    const appended = Buffer.concat([original, Buffer.from(publicProjectRoot, "utf16le")]);
    expect(() => assertCanonical43CapturedPaths(appended)).toThrow("HISTORICAL_FIXTURE_CAPTURE_MISMATCH");
    expect(() => assertCanonical43CapturedPaths(Buffer.from(publicProjectRoot))).toThrow("HISTORICAL_FIXTURE_CAPTURE_MISMATCH");
  });
});
