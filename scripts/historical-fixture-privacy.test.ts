import { describe, expect, test } from "bun:test";

import { canonical24ResetDatabaseBytes, canonical24ResetFixture, canonical24ResetFixtureGeneratorSource } from "./fixtures/canonical24-reset";
import { canonical30WorkDatabaseBytes, canonical30WorkFixture, canonical30WorkFixtureGeneratorSource } from "./fixtures/canonical30-work";
import { canonicalAdoption40DatabaseBytes, canonicalAdoption40Fixture, canonicalAdoption40FixtureGeneratorSource } from "./fixtures/canonical-adoption40";
import { canonical40QueuesDatabaseBytes, canonical40QueuesFixture, canonical40QueuesFixtureGeneratorSource } from "./fixtures/canonical40-queues";
import { canonical40UsageDatabaseBytes, canonical40UsageFixture, canonical40UsageFixtureGeneratorSource } from "./fixtures/canonical40-usage";
import { privateTask48DatabaseBytes, privateTask48Fixture, privateTask48FixtureDatabaseIdentity, privateTask48FixtureGeneratorSource } from "./fixtures/private-task48";
import { privateTask48PinnedDatabaseBytes, privateTask48PinnedDatabaseIdentity, privateTask48PinnedFixture, privateTask48PinnedGeneratorSource } from "./fixtures/private-task48-pinned";
import { privateTask48UsageDatabaseBytes, privateTask48UsageFixture, privateTask48UsageGeneratorSource } from "./fixtures/private-task48-usage";
import { combined49ArchiveProvenance, combined49DatabaseBytes, combined49Fixture, combined49GeneratorSource } from "./fixtures/combined49";
import { combined49SwitchArchiveProvenance, combined49SwitchDatabaseBytes, combined49SwitchFixture, combined49SwitchGeneratorSource } from "./fixtures/combined49-switch";
import { combined49RetiredArchiveProvenance, combined49RetiredDatabaseBytes, combined49RetiredFixture, combined49RetiredGeneratorSource } from "./fixtures/combined49-retired";
import { assertPublicSensitiveText } from "./public-text-policy";

const fixtures: readonly Readonly<{
  name: string;
  bytes: () => Uint8Array;
  generator: string;
  metadata: unknown;
}>[] = [
  { name: "canonical24-reset", bytes: canonical24ResetDatabaseBytes, generator: canonical24ResetFixtureGeneratorSource, metadata: canonical24ResetFixture },
  { name: "canonical30-work", bytes: canonical30WorkDatabaseBytes, generator: canonical30WorkFixtureGeneratorSource, metadata: canonical30WorkFixture },
  { name: "canonical-adoption40", bytes: canonicalAdoption40DatabaseBytes, generator: canonicalAdoption40FixtureGeneratorSource, metadata: canonicalAdoption40Fixture },
  { name: "canonical40-queues", bytes: canonical40QueuesDatabaseBytes, generator: canonical40QueuesFixtureGeneratorSource, metadata: canonical40QueuesFixture },
  { name: "canonical40-usage", bytes: canonical40UsageDatabaseBytes, generator: canonical40UsageFixtureGeneratorSource, metadata: canonical40UsageFixture },
  { name: "private-task48", bytes: privateTask48DatabaseBytes, generator: privateTask48FixtureGeneratorSource, metadata: { fixture: privateTask48Fixture, identity: privateTask48FixtureDatabaseIdentity } },
  { name: "private-task48-pinned", bytes: privateTask48PinnedDatabaseBytes, generator: privateTask48PinnedGeneratorSource, metadata: { fixture: privateTask48PinnedFixture, identity: privateTask48PinnedDatabaseIdentity } },
  { name: "private-task48-usage", bytes: privateTask48UsageDatabaseBytes, generator: privateTask48UsageGeneratorSource, metadata: privateTask48UsageFixture },
  { name: "combined49", bytes: combined49DatabaseBytes, generator: combined49GeneratorSource, metadata: { fixture: combined49Fixture, provenance: combined49ArchiveProvenance } },
  { name: "combined49-switch", bytes: combined49SwitchDatabaseBytes, generator: combined49SwitchGeneratorSource, metadata: { fixture: combined49SwitchFixture, provenance: combined49SwitchArchiveProvenance } },
  { name: "combined49-retired", bytes: combined49RetiredDatabaseBytes, generator: combined49RetiredGeneratorSource, metadata: { fixture: combined49RetiredFixture, provenance: combined49RetiredArchiveProvenance } },
];

// Decoded fixture bytes must contain no host-location prefix at all, including
// stale cells/free pages and UTF-16 strings inside a blob. Generator source is
// checked by the public text policy instead: its literal prefix denylist is
// not itself a private path and must not produce a false-positive refusal.
const hostPrefixes = ["/Users/", "/home/", "/private/", "/tmp/", "/var/folders/", "\\Users\\"] as const;

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
      expect(() => assertPublicSensitiveText(bytes.toString("utf8"), `${fixture.name} decoded database`)).not.toThrow();
      for (const prefix of hostPrefixes) {
        for (const encoding of ["utf8", "utf16le"] as const) {
          expect(bytes.includes(Buffer.from(prefix, encoding))).toBe(false);
        }
      }
    });
  }
});
