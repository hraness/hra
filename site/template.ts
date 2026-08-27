import { renderHranessSiteFooter } from "@hraness/site-footer";

import {
  deepseekHarnessReading,
  findSection,
  publicContent,
  type ContentBlock,
  type ContentSection,
  type InlineContent,
  type PublicContent,
} from "./content.ts";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

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

const renderBlock = (block: ContentBlock, sectionId: string, blockIndex: number): string => {
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
      return `<h3 id="${escapeHtml(id)}">${escapeHtml(block.text)}</h3>`;
    }
  }
};

const renderSection = (section: ContentSection): string =>
  `<section id="${escapeHtml(section.id)}" aria-labelledby="${escapeHtml(section.id)}-heading">
  <h2 id="${escapeHtml(section.id)}-heading">${escapeHtml(section.heading)}</h2>
  ${section.blocks.map((block, index) => renderBlock(block, section.id, index)).join("\n  ")}
</section>`;

const renderHead = (
  content: PublicContent,
  options: {
    readonly canonicalPath: string;
    readonly description: string;
    readonly jsonLd?: Readonly<Record<string, unknown>>;
    readonly openGraphType?: "article" | "website";
    readonly title: string;
  },
): string => {
  const canonicalUrl = `${content.siteUrl}${options.canonicalPath}`;
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

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<meta name="description" content="${escapeHtml(options.description)}">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:type" content="${escapeHtml(options.openGraphType ?? "website")}">
<meta property="og:site_name" content="${escapeHtml(content.productName)}">
<meta property="og:title" content="${escapeHtml(options.title)}">
<meta property="og:description" content="${escapeHtml(options.description)}">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:image" content="${escapeHtml(content.siteUrl)}/social-card.svg">
<meta property="og:image:alt" content="HRA command line prompt">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#11100e">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
<script type="application/ld+json">${jsonLd}</script>`;
};

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
    ${renderBlock(deepseekHarnessReading.homeLink, "introduction", content.introduction.length)}
  </header>
  <nav class="section-nav" aria-label="Documentation">${navigation}</nav>
  ${content.sections.map(renderSection).join("\n  ")}
</main>
${renderProjectResources(content)}
${renderHranessSiteFooter()}
</body>
</html>
`;
};

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
${renderProjectResources(content)}
${renderHranessSiteFooter()}
</body>
</html>
`;
};

export const renderDeepseekHarnessReadingHtml = (
  content: PublicContent = publicContent,
): string => {
  const page = deepseekHarnessReading;
  const canonicalUrl = `${content.siteUrl}${page.canonicalPath}`;
  return `<!doctype html>
<html lang="en">
<head>
${renderHead(content, {
  canonicalPath: page.canonicalPath,
  description: page.description,
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
  ${renderSection(page.section)}
</main>
${renderProjectResources(content)}
${renderHranessSiteFooter()}
</body>
</html>
`;
};
