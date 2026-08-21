import { HranessBrand } from "@hra-internal/brand-ui";
import { ThemeMenuButton } from "@hra-internal/design-kit/react";
import { createPublicSiteMetadata, serializeJsonLd } from "@hraness/web-discovery";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { HRA_BRAND_ICON_PATH, hraSearchSite, hraSocialPageTitle } from "../site";
import { COMPARISON_REVIEW_LABEL, hraComparisons } from "./comparisons";

export const metadata = createPublicSiteMetadata({
  ...hraSearchSite,
  description:
    "Compare HRA with Codex app, OpenCode Desktop, Paseo, Conductor, Superset, OpenChamber, and Happy Coder using current first-party sources.",
  socialTitle: hraSocialPageTitle("HRA alternatives"),
  title: "HRA alternatives",
}, { canonicalPath: "/alternatives" }) satisfies Metadata;

export default function AlternativesPage() {
  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: hraComparisons.map((comparison, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: `${hraSearchSite.origin}/alternatives/${comparison.slug}`,
      name: `HRA vs ${comparison.shortName}`,
    })),
    name: "HRA alternatives and comparisons",
  };

  return (
    <div className="alternatives-page">
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(itemList) }}
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
            <Link href="/">Overview</Link>
            <Link href="/download">Download</Link>
            <a href="https://github.com/hraness/hra">GitHub</a>
          </nav>
          <ThemeMenuButton />
        </div>
      </header>

      <main className="alternatives-shell" id="main-content">
        <section aria-labelledby="alternatives-title" className="alternatives-hero">
          <p className="landing-eyebrow">HRA alternatives</p>
          <h1 id="alternatives-title">Choose the layer you actually need.</h1>
          <p className="alternatives-lede">
            Coding-agent tools now overlap. Most can run work in parallel. The useful question is whether you need a first-party Codex app, a multi-provider workspace, a remote client, or a durable metaharness around Codex.
          </p>
          <p className="alternatives-reviewed">Sources last reviewed {COMPARISON_REVIEW_LABEL}.</p>
        </section>

        <section aria-labelledby="comparison-list-title" className="alternatives-section">
          <div className="alternatives-section-heading">
            <p className="landing-eyebrow">Seven honest comparisons</p>
            <h2 id="comparison-list-title">What each tool is trying to be.</h2>
          </div>
          <div className="alternatives-grid">
            {hraComparisons.map((comparison) => (
              <article key={comparison.slug}>
                <p>{comparison.shortName}</p>
                <h3>HRA vs {comparison.shortName}</h3>
                <p>{comparison.meaningfulDifference}</p>
                <Link href={`/alternatives/${comparison.slug}`}>Read the comparison →</Link>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="categories-title" className="alternatives-section alternatives-categories">
          <div className="alternatives-section-heading">
            <p className="landing-eyebrow">A quick map</p>
            <h2 id="categories-title">Four different jobs hide behind “agent orchestration.”</h2>
          </div>
          <dl>
            <div><dt>First-party Codex</dt><dd>Codex app is the default answer when you want OpenAI&apos;s supported parallel Codex experience.</dd></div>
            <div><dt>Multi-provider workspace</dt><dd>Paseo, Conductor, Superset, OpenCode, and OpenChamber offer broader agent or provider surfaces.</dd></div>
            <div><dt>Remote control</dt><dd>Happy Coder is centered on reaching coding sessions from a phone or browser.</dd></div>
            <div><dt>Codex metaharness</dt><dd>HRA goes narrower and deeper on authorized account custody, durable delegation, continuity, and recovery around Codex.</dd></div>
          </dl>
        </section>

        <section aria-labelledby="method-title" className="alternatives-section alternatives-method">
          <div>
            <p className="landing-eyebrow">How these pages work</p>
            <h2 id="method-title">Sources, limits, and corrections.</h2>
          </div>
          <p>
            Positive claims link to current first-party documentation where possible. “Not documented” means only that we did not find the feature in the reviewed official sources. It is not proof that a product lacks it. HRA is an independent project and is not affiliated with any compared product.
          </p>
        </section>
      </main>

      <footer className="alternatives-footer">
        <HranessBrand />
        <p>See something stale? <a href="https://github.com/hraness/hra/issues">Open a correction.</a></p>
      </footer>
    </div>
  );
}
