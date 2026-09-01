import {
  renderHranessSiteFooter,
  type HranessMailingListConfig,
} from "@hraness/site-footer";
import { AskAiAboutThis } from "@hraness/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  deepseekHarnessReading,
  findSection,
  haxReading,
  headlongMicroharnessReading,
  oracleAndFirmReading,
  publicContent,
  type ContentBlock,
  type ContentSection,
  type InlineContent,
  type PublicContent,
  type ReadingPage,
} from "./content.ts";
import {
  editorialImage,
  editorialImages,
  editorialImageSrcSet,
  editorialImageUrl,
  type EditorialImage,
} from "./editorial-images.ts";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const HRA_MAILING_TURNSTILE_SITEKEY_ENV =
  "NEXT_PUBLIC_HRANESS_MAILING_TURNSTILE_SITEKEY" as const;

const turnstileSitekeyPattern = /^[A-Za-z0-9_-]{20,100}$/u;

export const hraMailingListConfig = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HranessMailingListConfig => {
  const turnstileSitekey = environment[HRA_MAILING_TURNSTILE_SITEKEY_ENV];
  if (turnstileSitekey === undefined || turnstileSitekey.length === 0) {
    if (environment.VERCEL_ENV === "production") {
      throw new Error(
        `${HRA_MAILING_TURNSTILE_SITEKEY_ENV} must be configured for Vercel Production.`,
      );
    }
    return { kind: "none" };
  }
  if (!turnstileSitekeyPattern.test(turnstileSitekey)) {
    throw new Error(
      `${HRA_MAILING_TURNSTILE_SITEKEY_ENV} must be a 20-100 character URL-safe public Cloudflare Turnstile sitekey.`,
    );
  }
  return {
    audience: "hra",
    kind: "signup",
    turnstileSitekey,
  };
};

export const renderHraSiteFooter = (
  turnstileSitekey = process.env[HRA_MAILING_TURNSTILE_SITEKEY_ENV],
): string => {
  const environment: Record<string, string | undefined> = {
    [HRA_MAILING_TURNSTILE_SITEKEY_ENV]: turnstileSitekey,
    VERCEL_ENV: process.env.VERCEL_ENV,
  };
  return renderHranessSiteFooter({
    mailingList: hraMailingListConfig(environment),
  });
};

export const renderAskAiAboutThis = (canonicalUrl: string): string =>
  renderToStaticMarkup(createElement(AskAiAboutThis, {
    className: "hra-ask-ai",
    url: canonicalUrl,
  }));

const renderInline = (content: readonly InlineContent[]): string =>
  content
    .map((part) => {
      switch (part.kind) {
        case "code":
          return `<code>${escapeHtml(part.value)}</code>`;
        case "link":
          return `<a href="${escapeHtml(part.href)}">${escapeHtml(part.label)}</a>`;
        case "text":
          return escapeHtml(part.value);
      }
    })
    .join("");

const renderBlock = (
  block: ContentBlock,
  sectionId: string,
  blockIndex: number,
  subheadingLevel: "h2" | "h3" = "h3",
): string => {
  switch (block.kind) {
    case "commands":
      return `<pre class="command-list" tabindex="0"><code>${escapeHtml(block.commands.join("\n"))}</code></pre>`;
    case "list":
      return `<ul>${block.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`;
    case "notice":
      return `<aside class="notice" aria-label="${escapeHtml(block.label)}"><strong>${escapeHtml(block.label)}.</strong> ${renderInline(block.content)}</aside>`;
    case "paragraph":
      return `<p>${renderInline(block.content)}</p>`;
    case "subheading": {
      const id = `${sectionId}-${blockIndex.toString()}-${block.text.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")}`;
      return `<${subheadingLevel} id="${escapeHtml(id)}">${escapeHtml(block.text)}</${subheadingLevel}>`;
    }
  }
};

const renderSection = (
  section: ContentSection,
  headingLevel: "h1" | "h2" = "h2",
  afterHeading = "",
): string =>
  `<section id="${escapeHtml(section.id)}" aria-labelledby="${escapeHtml(section.id)}-heading">
  <${headingLevel} id="${escapeHtml(section.id)}-heading">${escapeHtml(section.heading)}</${headingLevel}>
  ${afterHeading}
  ${section.blocks.map((block, index) => renderBlock(
    block,
    section.id,
    index,
    headingLevel === "h1" ? "h2" : "h3",
  )).join("\n  ")}
</section>`;

const renderHead = (
  content: PublicContent,
  options: {
    readonly canonicalPath: string;
    readonly description: string;
    readonly includeStructuredData?: boolean;
    readonly image?: Readonly<{
      alt: string;
      height?: number;
      src: string;
      type?: string;
      width?: number;
    }>;
    readonly jsonLd?: Readonly<Record<string, unknown>>;
    readonly openGraphType?: "article" | "website";
    readonly robots?: string;
    readonly title: string;
  },
): string => {
  const canonicalUrl = `${content.siteUrl}${options.canonicalPath}`;
  const image = options.image ?? {
    alt: "HRA command line prompt",
    src: `${content.siteUrl}/social-card.svg`,
  };
  const jsonLd = JSON.stringify(options.jsonLd ?? {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "DeveloperApplication",
    codeRepository: content.links.github,
    description: options.description,
    license: "https://opensource.org/license/mit",
    name: content.productName,
    operatingSystem: "macOS, Linux",
    url: canonicalUrl,
  }).replaceAll("<", "\\u003c");
  const robots = options.robots === undefined
    ? ""
    : `\n<meta name="robots" content="${escapeHtml(options.robots)}">`;
  const structuredData = options.includeStructuredData === false
    ? ""
    : `\n<script type="application/ld+json">${jsonLd}</script>`;

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<meta name="description" content="${escapeHtml(options.description)}">${robots}
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:type" content="${escapeHtml(options.openGraphType ?? "website")}">
<meta property="og:site_name" content="${escapeHtml(content.productName)}">
<meta property="og:title" content="${escapeHtml(options.title)}">
<meta property="og:description" content="${escapeHtml(options.description)}">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:image" content="${escapeHtml(image.src)}">
${image.type === undefined ? "" : `<meta property="og:image:type" content="${escapeHtml(image.type)}">\n`}${image.width === undefined ? "" : `<meta property="og:image:width" content="${image.width.toString()}">\n`}${image.height === undefined ? "" : `<meta property="og:image:height" content="${image.height.toString()}">\n`}<meta property="og:image:alt" content="${escapeHtml(image.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(image.src)}">
<meta name="twitter:image:alt" content="${escapeHtml(image.alt)}">
<meta name="theme-color" content="#11100e">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">${structuredData}`;
};

const renderEditorialFigure = (image: EditorialImage): string =>
  `<figure class="editorial-figure">
    <img alt="${escapeHtml(image.alt)}" decoding="async" fetchpriority="high" height="${image.height.toString()}" sizes="(max-width: 68rem) calc(100vw - 2rem), 68rem" src="${image.src}" srcset="${editorialImageSrcSet(image)}" width="${image.width.toString()}">
    <figcaption><span>${escapeHtml(image.caption)}</span><small>${escapeHtml(image.credit)}</small></figcaption>
  </figure>`;

const renderReadingCards = (): string => editorialImages.map((image) =>
  `<article class="reading-card">
    <a href="${image.canonicalPath}">
      <img alt="" decoding="async" height="${image.height.toString()}" loading="lazy" sizes="(max-width: 48rem) calc(100vw - 2rem), 50vw" src="${image.src}" srcset="${editorialImageSrcSet(image)}" width="${image.width.toString()}">
      <span><strong>${escapeHtml(image.cardTitle)}</strong>${escapeHtml(image.cardDescription)}</span>
    </a>
  </article>`).join("\n");

const renderHomeReading = (): string => `<section class="home-reading" aria-labelledby="home-reading-heading">
  <div class="home-reading-heading">
    <h2 id="home-reading-heading">Reading</h2>
    <a href="/reading/">View all</a>
  </div>
  <div class="reading-grid">${renderReadingCards()}</div>
</section>`;

const renderProjectResources = (content: PublicContent): string => `<aside aria-label="HRA project information" class="project-resources">
  <p>${escapeHtml(content.productName)} is MIT licensed.</p>
  <nav aria-label="Project links">
    <a href="${escapeHtml(content.links.github)}">GitHub</a>
    <a href="${escapeHtml(content.links.documentation)}">Documentation</a>
    <a href="${escapeHtml(content.links.security)}">Security</a>
    <a href="/privacy/">Privacy</a>
  </nav>
</aside>`;

export const renderSiteHtml = (content: PublicContent = publicContent): string => {
  const navigation = content.sections
    .map((section) => `<a href="#${escapeHtml(section.id)}">${escapeHtml(section.heading)}</a>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/",
  description: content.description,
  title: `${content.productName} | Multi-account Codex CLI`,
})}
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<main id="content">
  <header class="hero">
    <h1>${escapeHtml(content.productName)}</h1>
    <pre class="install-command" tabindex="0"><code>${escapeHtml(content.installCommand)}</code></pre>
    <pre class="doctor-command" tabindex="0"><code>${escapeHtml(content.doctorCommand)}</code></pre>
    <pre class="init-command" tabindex="0"><code>${escapeHtml(content.initCommand)}</code></pre>
    ${content.introduction.map((block, index) => renderBlock(block, "introduction", index)).join("\n    ")}
    ${renderHomeReading()}
  </header>
  <nav class="section-nav" aria-label="Documentation">${navigation}</nav>
  ${content.sections.map((section) => renderSection(section)).join("\n  ")}
</main>
${renderAskAiAboutThis(`${content.siteUrl}/`)}
${renderProjectResources(content)}
${renderHraSiteFooter()}
</body>
</html>
`;
};

export const renderPreviewHtml = (content: PublicContent = publicContent): string =>
  `<!doctype html>
<html lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/",
  description: content.description,
  includeStructuredData: false,
  robots: "noindex, nofollow",
  title: `${content.productName} | Multi-account Codex CLI`,
})}
</head>
<body class="preview-page">
<main id="content" class="preview-shell">
  <article class="preview-card" aria-labelledby="preview-title">
    <p class="preview-eyebrow">Persistent Codex workspace</p>
    <h1 id="preview-title">${escapeHtml(content.productName)}</h1>
    <p class="preview-summary">${escapeHtml(content.description)}</p>
    <ul class="preview-capabilities" aria-label="HRA capabilities">
      <li><strong>Accounts</strong><span>Isolated by default</span></li>
      <li><strong>Sessions</strong><span>Live and durable</span></li>
      <li><strong>Sync</strong><span>Optional and encrypted</span></li>
    </ul>
    <p class="preview-status">Local-first <span aria-hidden="true">·</span> Bun CLI</p>
  </article>
</main>
</body>
</html>
`;

export const renderPrivacyHtml = (content: PublicContent = publicContent): string => {
  const privacy = findSection(content, "privacy");
  return `<!doctype html>
<html lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/privacy/",
  description: "The local, encrypted cloud, and website data boundaries for HRA.",
  title: `Privacy | ${content.productName}`,
})}
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<main id="content" class="narrow-page">
  <p><a href="/">← ${escapeHtml(content.productName)}</a></p>
  ${renderSection(privacy)}
  <p>Report a suspected boundary violation through <a href="${escapeHtml(content.links.privateSecurityReport)}">private vulnerability reporting</a>.</p>
</main>
${renderAskAiAboutThis(`${content.siteUrl}/privacy/`)}
${renderProjectResources(content)}
${renderHraSiteFooter()}
</body>
</html>
`;
};

export const renderReadingHtml = (
  page: ReadingPage,
  content: PublicContent = publicContent,
): string => {
  const canonicalUrl = `${content.siteUrl}${page.canonicalPath}`;
  const image = editorialImage(page.canonicalPath);
  if (image === undefined) {
    throw new Error(`Reading page is missing its editorial image: ${page.canonicalPath}`);
  }
  const imageUrl = editorialImageUrl(image);
  return `<!doctype html>
<html lang="en">
<head>
${renderHead(content, {
  canonicalPath: page.canonicalPath,
  description: page.description,
  image: {
    alt: image.alt,
    height: image.height,
    src: imageUrl,
    type: "image/webp",
    width: image.width,
  },
  openGraphType: "article",
  jsonLd: {
    "@context": "https://schema.org",
    "@type": "Article",
    author: {
      "@type": "Organization",
      name: content.productName,
      url: `${content.siteUrl}/`,
    },
    dateModified: page.datePublished,
    datePublished: page.datePublished,
    description: page.description,
    headline: page.title,
    image: {
      "@type": "ImageObject",
      caption: image.caption,
      contentUrl: imageUrl,
      creditText: image.credit,
      height: image.height,
      url: imageUrl,
      width: image.width,
    },
    mainEntityOfPage: canonicalUrl,
    publisher: {
      "@type": "Organization",
      name: content.productName,
      url: `${content.siteUrl}/`,
    },
    url: canonicalUrl,
  },
  title: `${page.title} | ${content.productName}`,
})}
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<main id="content" class="narrow-page">
  <p><a href="/">← ${escapeHtml(content.productName)}</a></p>
  ${renderSection(page.section, "h1", renderEditorialFigure(image))}
</main>
${renderAskAiAboutThis(canonicalUrl)}
${renderProjectResources(content)}
${renderHraSiteFooter()}
</body>
</html>
`;
};

export const renderReadingIndexHtml = (
  content: PublicContent = publicContent,
): string => `<!doctype html>
<html lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/reading/",
  description: "Sourced HRA reading notes about adjacent agent designs, plugin catalogs, and isolated Codex account loops.",
  title: `Reading | ${content.productName}`,
})}
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
<main id="content" class="narrow-page reading-index">
  <p><a href="/">← ${escapeHtml(content.productName)}</a></p>
  <header>
    <h1>Reading</h1>
    <p>Sourced notes on adjacent agent designs and the boundary HRA keeps.</p>
  </header>
  <div class="reading-grid">${renderReadingCards()}</div>
</main>
${renderAskAiAboutThis(`${content.siteUrl}/reading/`)}
${renderProjectResources(content)}
${renderHraSiteFooter()}
</body>
</html>
`;

export const renderDeepseekHarnessReadingHtml = (
  content: PublicContent = publicContent,
): string => renderReadingHtml(deepseekHarnessReading, content);

export const renderHeadlongMicroharnessReadingHtml = (
  content: PublicContent = publicContent,
): string => renderReadingHtml(headlongMicroharnessReading, content);

export const renderOracleAndFirmReadingHtml = (
  content: PublicContent = publicContent,
): string => renderReadingHtml(oracleAndFirmReading, content);

export const renderHaxReadingHtml = (
  content: PublicContent = publicContent,
): string => renderReadingHtml(haxReading, content);
