import { HranessBrand } from "@hra-internal/brand-ui";
import { ThemeMenuButton } from "@hra-internal/design-kit/react";
import { createPublicSiteMetadata, serializeJsonLd } from "@hraness/web-discovery";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { HRA_BRAND_ICON_PATH, hraSearchSite, hraSocialPageTitle } from "../../site";
import {
  COMPARISON_REVIEW_DATE,
  COMPARISON_REVIEW_LABEL,
  alternativeSourcesForRow,
  comparisonForSlug,
  hraSourcesForRow,
  hraComparisons,
  sourceNumber,
  sourcesForIds,
  summarySourceIds,
  type HraComparison,
} from "../comparisons";

interface ComparisonPageProps {
  readonly params: Promise<{ readonly slug: string }>;
}

function ComparisonCitations({
  comparison,
  label,
  sourceIds,
}: Readonly<{
  comparison: HraComparison;
  label: string;
  sourceIds: readonly string[];
}>) {
  return (
    <span className="comparison-citations">
      {sourcesForIds(comparison, sourceIds).map((source) => (
        <a aria-label={`${label} source: ${source.label}`} href={source.url} key={source.id}>
          {sourceNumber(comparison, source)}
        </a>
      ))}
    </span>
  );
}

export const dynamicParams = false;

export function generateStaticParams() {
  return hraComparisons.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: ComparisonPageProps): Promise<Metadata> {
  const { slug } = await params;
  const comparison = comparisonForSlug(slug);
  if (comparison === undefined) return {};
  return createPublicSiteMetadata({
    ...hraSearchSite,
    description: comparison.description,
    socialTitle: hraSocialPageTitle(`HRA vs ${comparison.shortName}`),
    title: `HRA vs ${comparison.shortName}`,
  }, { canonicalPath: `/alternatives/${comparison.slug}` });
}

export default async function ComparisonPage({ params }: ComparisonPageProps) {
  const { slug } = await params;
  const comparison = comparisonForSlug(slug);
  if (comparison === undefined) notFound();
  const comparisonUrl = `${hraSearchSite.origin}/alternatives/${comparison.slug}`;
  const structuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebPage",
      about: [
        { "@type": "SoftwareApplication", name: "HRA", url: hraSearchSite.origin },
        { "@type": "SoftwareApplication", name: comparison.name },
      ],
      dateModified: COMPARISON_REVIEW_DATE,
      description: comparison.description,
      name: `HRA vs ${comparison.shortName}`,
      url: comparisonUrl,
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", item: hraSearchSite.origin, name: "HRA", position: 1 },
        { "@type": "ListItem", item: `${hraSearchSite.origin}/alternatives`, name: "Alternatives", position: 2 },
        { "@type": "ListItem", item: comparisonUrl, name: `HRA vs ${comparison.shortName}`, position: 3 },
      ],
    },
  ];

  return (
    <div className="alternatives-page comparison-page">
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        type="application/ld+json"
      />
      <a className="landing-skip-link" href="#main-content">Skip to content</a>
      <header className="alternatives-header">
        <Link aria-label="HRA home" className="landing-wordmark" href="/">
          <span aria-hidden="true">
            <Image alt="" className="brand-icon-image" height={512} src={HRA_BRAND_ICON_PATH} width={512} />
          </span>
          <strong>HRA</strong>
        </Link>
        <div className="alternatives-header-actions">
          <nav aria-label="Comparison navigation">
            <Link href="/alternatives">All comparisons</Link>
            <Link href="/download">Download</Link>
          </nav>
          <ThemeMenuButton />
        </div>
      </header>

      <main className="alternatives-shell" id="main-content">
        <nav aria-label="Breadcrumb" className="comparison-breadcrumb">
          <Link href="/">HRA</Link><span aria-hidden="true">/</span>
          <Link href="/alternatives">Alternatives</Link><span aria-hidden="true">/</span>
          <span>{comparison.shortName}</span>
        </nav>

        <article>
          <header className="comparison-hero">
            <p className="landing-eyebrow">Last verified {COMPARISON_REVIEW_LABEL}</p>
            <h1>HRA vs {comparison.shortName}</h1>
            <p>
              {comparison.commonGround}
              <ComparisonCitations comparison={comparison} label="Common ground" sourceIds={summarySourceIds(comparison)} />
            </p>
          </header>

          <section aria-labelledby="short-answer-title" className="comparison-section comparison-short-answer">
            <div className="alternatives-section-heading">
              <p className="landing-eyebrow">Short answer</p>
              <h2 id="short-answer-title">Choose for the job in front of you.</h2>
            </div>
            <div>
              <article>
                <h3>Choose {comparison.shortName}</h3>
                <p>
                  {comparison.alternativeFit}
                  <ComparisonCitations comparison={comparison} label={`Choose ${comparison.shortName}`} sourceIds={comparison.alternativeSummarySourceIds} />
                </p>
              </article>
              <article>
                <h3>Choose HRA</h3>
                <p>
                  {comparison.hraFit}
                  <ComparisonCitations comparison={comparison} label="Choose HRA" sourceIds={comparison.hraSummarySourceIds} />
                </p>
              </article>
            </div>
          </section>

          <section aria-labelledby="difference-title" className="comparison-section comparison-difference">
            <p className="landing-eyebrow">The meaningful difference</p>
            <h2 id="difference-title">The products put authority in different places.</h2>
            <p>
              {comparison.meaningfulDifference}
              <ComparisonCitations comparison={comparison} label="Meaningful difference" sourceIds={summarySourceIds(comparison)} />
            </p>
          </section>

          <section aria-labelledby="table-title" className="comparison-section">
            <div className="alternatives-section-heading">
              <p className="landing-eyebrow">Side by side</p>
              <h2 id="table-title">The decisions that matter.</h2>
            </div>
            <div className="comparison-table-scroll">
              <table className="comparison-table">
                <thead><tr><th scope="col">Decision</th><th scope="col">HRA</th><th scope="col">{comparison.shortName}</th></tr></thead>
                <tbody>
                  {comparison.rows.map((row) => (
                    <tr key={row.label}>
                      <th scope="row">{row.label}</th>
                      <td>
                        {row.hra}
                        <span className="comparison-citations">
                          {hraSourcesForRow(comparison, row).map((source) => (
                            <a aria-label={`${row.label} HRA source: ${source.label}`} href={source.url} key={source.id}>
                              {sourceNumber(comparison, source)}
                            </a>
                          ))}
                        </span>
                      </td>
                      <td>
                        {row.alternative}
                        <span className="comparison-citations">
                          {alternativeSourcesForRow(comparison, row).map((source) => (
                            <a aria-label={`${row.label} ${comparison.shortName} source: ${source.label}`} href={source.url} key={source.id}>
                              {sourceNumber(comparison, source)}
                            </a>
                          ))}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="limits-title" className="comparison-section comparison-limits">
            <div className="alternatives-section-heading">
              <p className="landing-eyebrow">What HRA cannot do yet</p>
              <h2 id="limits-title">Current HRA limitations.</h2>
            </div>
            <ul>
              <li>HRA&apos;s native host currently supports Apple Silicon Macs only.</li>
              <li>The downloadable app is ad-hoc signed, not Developer ID signed or notarized.</li>
              <li>The recursive harness is experimental, and the adaptive optimizer cannot activate policy.</li>
              <li>HRA is Codex-only; it is the wrong choice when provider breadth is the requirement.</li>
              <li>Multiple accounts must be owned or authorized by you and permitted to access the same work.</li>
            </ul>
          </section>

          <section aria-labelledby="sources-title" className="comparison-section comparison-sources">
            <div className="alternatives-section-heading">
              <p className="landing-eyebrow">How we verified this</p>
              <h2 id="sources-title">Current first-party sources.</h2>
            </div>
            <ol>
              {comparison.sources.map((source) => <li key={source.id}><a href={source.url}>{source.label} ↗</a></li>)}
            </ol>
            <p>
              “Not documented” means only that a capability was not found in these sources on {COMPARISON_REVIEW_LABEL}. It does not prove the product lacks it. HRA is independent and unaffiliated with {comparison.name}. <a href="https://github.com/hraness/hra/issues">Report a correction.</a>
            </p>
          </section>

          <nav aria-label="Related comparisons" className="comparison-related">
            <p>More comparisons</p>
            <div>
              {hraComparisons.filter((candidate) => candidate.slug !== comparison.slug).slice(0, 3).map((candidate) => (
                <Link href={`/alternatives/${candidate.slug}`} key={candidate.slug}>HRA vs {candidate.shortName} →</Link>
              ))}
            </div>
          </nav>
        </article>
      </main>

      <footer className="alternatives-footer">
        <HranessBrand />
        <Link href="/alternatives">All HRA comparisons</Link>
      </footer>
    </div>
  );
}
