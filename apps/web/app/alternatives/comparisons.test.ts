import { describe, expect, test } from "bun:test";

import {
  COMPARISON_REVIEW_DATE,
  alternativeSourcesForRow,
  comparisonForSlug,
  hraComparisonCitationVersion,
  hraComparisonSources,
  hraComparisons,
  hraSourcesForRow,
  sourceNumber,
  sourcesForIds,
  summarySourceIds,
} from "./comparisons";
import { hraComparisonSlugs, isHraPublicComparisonPath } from "./slugs";
import { HRA_RELEASE } from "../site";

describe("HRA comparison registry", () => {
  test("publishes the exact requested alternatives as unique static routes", () => {
    expect(hraComparisons.map(({ slug }) => slug)).toEqual([...hraComparisonSlugs]);
    expect(new Set(hraComparisons.map(({ slug }) => slug)).size).toBe(hraComparisons.length);
    expect(comparisonForSlug("codex-app")?.shortName).toBe("Codex app");
    expect(comparisonForSlug("opencode-desktop")?.shortName).toBe("OpenCode Desktop");
    expect(comparisonForSlug("happy-coder")?.shortName).toBe("Happy Coder");
    expect(comparisonForSlug("missing")).toBeUndefined();
    expect(COMPARISON_REVIEW_DATE).toBe("2026-08-16");
    expect(isHraPublicComparisonPath("/alternatives")).toBeTrue();
    expect(isHraPublicComparisonPath("/alternatives/codex-app/")).toBeTrue();
    expect(isHraPublicComparisonPath("/alternatives/missing")).toBeFalse();
    expect(isHraPublicComparisonPath("/alternatives/codex-app/private")).toBeFalse();
  });

  test("binds every HRA and alternative claim to current HTTPS sources", () => {
    const hraSourceIds = new Set<string>(hraComparisonSources.map(({ id }) => id));
    const repositoryCitationVersion = HRA_RELEASE.availability === "published"
      ? "0.1.12"
      : "0.1.10";
    const versionedHraPrefix =
      `https://github.com/hraness/hra/blob/v${repositoryCitationVersion}/` as const;

    expect(hraComparisonCitationVersion({
      availability: "candidate",
      version: "0.1.12",
    })).toBe("0.1.10");
    expect(hraComparisonCitationVersion({
      availability: "published",
      version: "0.1.12",
    })).toBe("0.1.12");
    expect(hraComparisonCitationVersion(HRA_RELEASE))
      .toBe(repositoryCitationVersion);

    expect(hraComparisonSources.map(({ url }) => url)).toEqual([
      `${versionedHraPrefix}README.md`,
      `${versionedHraPrefix}apps/desktop/README.md`,
      `${versionedHraPrefix}apps/desktop/HARNESS.md`,
      `${versionedHraPrefix}SECURITY_ARCHITECTURE.md`,
      `${versionedHraPrefix}apps/desktop/runtime/src/harness/metaharness-policy-v1.ts`,
    ]);
    for (const comparison of hraComparisons) {
      expect(comparison.sources.length).toBeGreaterThanOrEqual(8);
      expect(comparison.hraSummarySourceIds.length).toBeGreaterThan(0);
      expect(comparison.alternativeSummarySourceIds.length).toBeGreaterThan(0);
      expect(sourcesForIds(comparison, comparison.hraSummarySourceIds).length)
        .toBe(comparison.hraSummarySourceIds.length);
      expect(sourcesForIds(comparison, comparison.alternativeSummarySourceIds).length)
        .toBe(comparison.alternativeSummarySourceIds.length);
      expect(summarySourceIds(comparison)).toEqual([
        ...comparison.hraSummarySourceIds,
        ...comparison.alternativeSummarySourceIds,
      ]);
      expect(comparison.rows.length).toBeGreaterThanOrEqual(6);
      expect(new Set(comparison.sources.map(({ id }) => id)).size).toBe(comparison.sources.length);
      for (const [index, source] of comparison.sources.entries()) {
        expect(source.url.startsWith("https://")).toBeTrue();
        expect(new URL(source.url).protocol).toBe("https:");
        expect(sourceNumber(comparison, source)).toBe(index + 1);
        if (hraSourceIds.has(source.id)) {
          expect(source.url.startsWith(versionedHraPrefix)).toBeTrue();
        }
      }
      for (const row of comparison.rows) {
        expect(row.hra.length).toBeGreaterThan(12);
        expect(row.alternative.length).toBeGreaterThan(12);
        expect(row.hraSourceIds.length).toBeGreaterThan(0);
        expect(row.alternativeSourceIds.length).toBeGreaterThan(0);
        const hraSources = hraSourcesForRow(comparison, row);
        const alternativeSources = alternativeSourcesForRow(comparison, row);
        expect(hraSources.length).toBe(row.hraSourceIds.length);
        expect(alternativeSources.length).toBe(row.alternativeSourceIds.length);
        for (const source of hraSources) {
          expect(hraSourceIds.has(source.id)).toBeTrue();
          expect(source.url.startsWith(versionedHraPrefix)).toBeTrue();
        }
        for (const source of alternativeSources) {
          expect(hraSourceIds.has(source.id)).toBeFalse();
        }
      }
    }
  });

  test("renders symmetric HRA, alternative, and mixed-summary citations", async () => {
    const page = await Bun.file(new URL("./[slug]/page.tsx", import.meta.url)).text();
    expect(page).toContain("hraSourcesForRow(comparison, row)");
    expect(page).toContain("alternativeSourcesForRow(comparison, row)");
    expect(page).toContain('label="Choose HRA"');
    expect(page.match(/sourceIds={summarySourceIds\(comparison\)}/g)).toHaveLength(2);
  });

  test("keeps each page substantive instead of swapping only a product name", () => {
    expect(new Set(hraComparisons.map(({ meaningfulDifference }) => meaningfulDifference)).size)
      .toBe(hraComparisons.length);
    expect(new Set(hraComparisons.map(({ alternativeFit }) => alternativeFit)).size)
      .toBe(hraComparisons.length);
    expect(new Set(hraComparisons.map(({ hraFit }) => hraFit)).size)
      .toBe(hraComparisons.length);
    for (const comparison of hraComparisons) {
      expect(comparison.meaningfulDifference).toContain(comparison.shortName);
      expect(comparison.alternativeFit).toContain(comparison.shortName);
    }
  });
});
