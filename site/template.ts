import {
  renderHranessSiteFooter,
  type HranessMailingListConfig,
} from "@hraness/site-footer";
import { highlightCode } from "@hraness/design-kit/syntax-highlighting";
import { AskAiAboutThis } from "@hraness/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
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

const renderShellCode = (value: string): string => {
  const highlighted = highlightCode(value, "shell");
  return `<code class="${highlighted.className}">${highlighted.html}</code>`;
};

export const HRA_MAILING_TURNSTILE_SITEKEY_ENV =
  "NEXT_PUBLIC_HRANESS_MAILING_TURNSTILE_SITEKEY" as const;

const turnstileSitekeyPattern = /^[A-Za-z0-9_-]{20,100}$/u;
const emptySiteEnvironment: Readonly<Record<string, string | undefined>> =
  Object.freeze({});

export const hraMailingListConfig = (
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
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
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): string => renderHranessSiteFooter({
  mailingList: hraMailingListConfig(environment),
});

export const renderAskAiAboutThis = (canonicalUrl: string): string =>
  renderToStaticMarkup(createElement(AskAiAboutThis, {
    className: "hra-ask-ai",
    url: canonicalUrl,
  }));

export const renderHraAnalyticsScript = (): string =>
  '<script src="/analytics.js" type="module"></script>';

const renderInline = (content: readonly InlineContent[]): string =>
  content
    .map((part) => {
      switch (part.kind) {
        case "code":
          return `<code class="hra-inline-code">${escapeHtml(part.value)}</code>`;
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
      return `<pre class="command-list" tabindex="0">${renderShellCode(block.commands.join("\n"))}</pre>`;
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
  `<section class="documentation-section" id="${escapeHtml(section.id)}" aria-labelledby="${escapeHtml(section.id)}-heading">
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
    alt: content.socialCard.alt,
    height: content.socialCard.height,
    src: `${content.siteUrl}${content.socialCard.path}`,
    type: "image/png",
    width: content.socialCard.width,
  };
  const jsonLd = JSON.stringify(options.jsonLd ?? {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: content.tagline,
    author: {
      "@type": "Organization",
      name: content.maintainer.name,
      url: content.maintainer.url,
    },
    codeRepository: content.links.github,
    description: options.description,
    license: "https://opensource.org/license/mit",
    maintainer: {
      "@type": "Organization",
      name: content.maintainer.name,
      url: content.maintainer.url,
    },
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
<meta name="theme-color" content="#fbfaf7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141310" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">${structuredData}`;
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

const renderSiteHeader = (
  content: PublicContent,
  currentPath: "/" | "/privacy/",
): string => {
  const link = (href: string, label: string, current = false): string =>
    `<a href="${escapeHtml(href)}"${current ? ' aria-current="page"' : ""}>${escapeHtml(label)}</a>`;
  return `<header class="hraness-marketing-header" data-hraness-marketing="header">
  <div class="hraness-marketing-header__inner">
    <a class="hraness-marketing-header__brand" href="/">${escapeHtml(content.productName)}</a>
    <nav aria-label="Site" class="hraness-marketing-header__nav">
      ${link("/#how-it-works", "How it works", currentPath === "/")}
      ${link("/#install-command", "Install")}
      ${link("/#reference", "Reference")}
      ${link("/privacy/", "Privacy", currentPath === "/privacy/")}
      ${link(content.links.github, "GitHub")}
    </nav>
    <div class="hraness-marketing-header__actions">
      <a class="hraness-marketing-action" data-emphasis="primary" href="/#install-command">Install ${escapeHtml(content.productName)}</a>
    </div>
  </div>
</header>`;
};

const renderHeroFrame = (content: PublicContent): string => {
  const firstSession = findSection(content, "first-session");
  const humanTerminal = firstSession.blocks.find(
    (block): block is Extract<ContentBlock, { kind: "commands" }> => block.kind === "commands",
  );
  if (humanTerminal === undefined) {
    throw new Error("Public content must publish the human-terminal first-session commands.");
  }
  return `<div class="hraness-marketing-hero__frame">
      <figure class="hraness-marketing-proof-frame" data-hraness-marketing="proof-frame">
        <div aria-hidden="true" class="hraness-marketing-proof-frame__chrome">
          <span class="hraness-marketing-proof-frame__lights"><span></span><span></span><span></span></span>
          <span class="hraness-marketing-proof-frame__title">hra · persistent shell</span>
        </div>
        <div class="hraness-marketing-proof-frame__content"><pre class="shell-transcript" tabindex="0">${renderShellCode(humanTerminal.commands.join("\n"))}</pre></div>
        <figcaption class="hraness-marketing-proof-frame__caption">
          <span>Start a session, open the shell, select the account and session, then type a request. These are the first-session commands from the reference below.</span>
          <small>v${escapeHtml(content.releaseVersion)}</small>
        </figcaption>
      </figure>
    </div>`;
};

const renderProductHero = (content: PublicContent): string => `<header class="hraness-marketing-hero" data-hraness-marketing="hero" data-align="center" data-tone="paper" aria-labelledby="hra-title">
    <div class="hraness-marketing-hero__copy">
      <p class="hraness-marketing-hero__eyebrow">${escapeHtml(content.hero.eyebrow)}</p>
      <p class="hraness-marketing-hero__name">${escapeHtml(content.productName)}</p>
      <h1 class="hraness-marketing-hero__heading" id="hra-title">${escapeHtml(content.hero.heading)}</h1>
      <p class="hraness-marketing-hero__summary">${escapeHtml(content.hero.summary)}</p>
      <p class="hraness-marketing-hero__example">${escapeHtml(content.hero.example)}</p>
      <div class="hraness-marketing-hero__actions">
        <a class="hraness-marketing-action" data-emphasis="primary" href="${escapeHtml(content.hero.primaryAction.href)}">${escapeHtml(content.hero.primaryAction.label)}</a>
        <a class="hraness-marketing-action" data-emphasis="secondary" href="${escapeHtml(content.hero.secondaryAction.href)}">${escapeHtml(content.hero.secondaryAction.label)}</a>
      </div>
      <p class="hraness-marketing-hero__boundary">${escapeHtml(content.hero.boundary)}</p>
    </div>
    ${renderHeroFrame(content)}
    <dl class="hraness-marketing-facts" data-hraness-marketing="facts">
      ${content.hero.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd><strong>${escapeHtml(fact.value)}</strong><span>${escapeHtml(fact.detail)}</span></dd></div>`).join("\n      ")}
    </dl>
  </header>
  <dl class="hraness-marketing-pillars" data-hraness-marketing="pillars" aria-label="${escapeHtml(content.productName)} in three points">
    ${content.hero.pillars.map((pillar) => `<div><dt>${escapeHtml(pillar.label)}</dt><dd>${escapeHtml(pillar.summary)}</dd></div>`).join("\n    ")}
  </dl>
  <section class="hraness-marketing-section" data-hraness-marketing="section" data-layout="split" id="how-it-works" aria-labelledby="how-it-works-heading">
    <div class="hraness-marketing-section__heading-group">
      <p class="hraness-marketing-section__label">How it works</p>
      <h2 class="hraness-marketing-section__heading" id="how-it-works-heading">${escapeHtml(content.hero.proofLabel)}</h2>
      <p class="hraness-marketing-section__summary">Every step is one command with a JSON form, so a person in the shell and an agent in a subprocess drive the same session the same way.</p>
    </div>
    <div class="hraness-marketing-section__body">
      <ol class="hraness-marketing-flow" data-hraness-marketing="flow" aria-label="First ${escapeHtml(content.productName)} request">
        ${content.hero.steps.map((step, index) => `<li class="hraness-marketing-flow__step">
          <span aria-hidden="true" class="hraness-marketing-flow__number">${String(index + 1).padStart(2, "0")}</span>
          <div class="hraness-marketing-flow__body"><strong class="hraness-marketing-flow__label">${escapeHtml(step.label)}</strong><code class="hraness-marketing-flow__code">${escapeHtml(step.command)}</code><p class="hraness-marketing-flow__detail">${escapeHtml(step.detail)}</p></div>
        </li>`).join("\n        ")}
      </ol>
    </div>
  </section>
  <section class="hraness-marketing-install" data-hraness-marketing="install" id="install-command" aria-labelledby="install-command-heading">
    <div class="hraness-marketing-install__heading-group">
      <p class="hraness-marketing-install__eyebrow">Local release · v${escapeHtml(content.releaseVersion)}</p>
      <h2 class="hraness-marketing-install__heading" id="install-command-heading">Install the verified CLI.</h2>
      <p class="install-note">One command downloads the immutable release, verifies its digest, and installs it. Then check the host and initialize.</p>
    </div>
    <div class="hraness-marketing-install__commands">
      <pre class="install-command" tabindex="0">${renderShellCode(content.installCommand)}</pre>
      <div class="install-checks">
        <pre class="doctor-command" tabindex="0">${renderShellCode(content.doctorCommand)}</pre>
        <pre class="init-command" tabindex="0">${renderShellCode(content.initCommand)}</pre>
      </div>
    </div>
  </section>
  <section class="hraness-marketing-trust" data-hraness-marketing="trust" id="local-by-design" aria-labelledby="local-by-design-heading">
    <header class="hraness-marketing-trust__header">
      <p class="hraness-marketing-trust__label">Local by design</p>
      <h2 class="hraness-marketing-trust__heading" id="local-by-design-heading">Keep control of the accounts you already have.</h2>
      <p>${escapeHtml(content.productName)} is infrastructure around the provider tools you chose, not a proxy in front of them.</p>
    </header>
    <dl class="hraness-marketing-trust-grid">
      ${content.trust.map((item) => `<div class="hraness-marketing-trust-item"><dt>${escapeHtml(item.label)}</dt><dd>${escapeHtml(item.detail)}</dd></div>`).join("\n      ")}
    </dl>
  </section>
  <section class="hraness-marketing-questions" data-hraness-marketing="questions" id="questions" aria-labelledby="questions-heading">
    <header class="hraness-marketing-questions__header">
      <p class="hraness-marketing-questions__label">Questions</p>
      <h2 class="hraness-marketing-questions__heading" id="questions-heading">Before you install.</h2>
    </header>
    <div class="hraness-marketing-question-list">
      ${content.questions.map((question) => `<details class="hraness-marketing-question"><summary>${escapeHtml(question.question)}</summary><div class="hraness-marketing-question__answer"><p>${renderInline(question.answer)}</p></div></details>`).join("\n      ")}
    </div>
  </section>
  <section class="hraness-marketing-maker" data-hraness-marketing="maker" id="maker" aria-labelledby="maker-heading">
    <header class="hraness-marketing-maker__header">
      <p class="hraness-marketing-maker__label">Built by</p>
      <h2 class="hraness-marketing-maker__heading" id="maker-heading">${escapeHtml(content.maker.heading)}</h2>
    </header>
    <div class="hraness-marketing-maker__body">
      ${content.maker.bio.length === 0 ? "" : `<p>${renderInline(content.maker.bio)}</p>`}
      <ul class="hraness-marketing-maker__links">
        ${content.maker.links.map((entry) => `<li><a href="${escapeHtml(entry.href)}">${escapeHtml(entry.label)}</a></li>`).join("\n        ")}
      </ul>
    </div>
  </section>
  <section class="hraness-marketing-cta" data-hraness-marketing="cta" data-tone="paper" id="closing" aria-labelledby="closing-heading">
    <h2 class="hraness-marketing-cta__heading" id="closing-heading">Give every session the same terminal.</h2>
    <p class="hraness-marketing-cta__summary">Install the CLI, add one account, and start a session that outlives the tab it began in.</p>
    <div class="hraness-marketing-cta__actions">
      <a class="hraness-marketing-action" data-emphasis="primary" href="#install-command">Install ${escapeHtml(content.productName)}</a>
      <a class="hraness-marketing-action" data-emphasis="secondary" href="${escapeHtml(content.links.github)}">Read the source</a>
    </div>
    <p class="hraness-marketing-cta__footnote">${escapeHtml(content.hero.boundary)}</p>
  </section>
  <div class="reference" id="reference">
    <div class="reference__intro">
      <p class="hraness-marketing-section__label">Reference</p>
      <h2 class="reference__heading">Every command, boundary, and release claim.</h2>
      <div class="hero-notes">
        ${content.introduction.map((block, index) => renderBlock(block, "introduction", index)).join("\n        ")}
      </div>
    </div>`;

export const renderSiteHtml = (
  content: PublicContent = publicContent,
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): string => {
  const navigation = content.sections
    .map((section) => `<a href="#${escapeHtml(section.id)}">${escapeHtml(section.heading)}</a>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/",
  description: content.description,
  title: `${content.productName} | ${content.tagline}`,
})}
</head>
<body>
<a class="skip-link" href="#content">Skip to content</a>
${renderSiteHeader(content, "/")}
<main id="content">
<div class="hraness-marketing-page">
  ${renderProductHero(content)}
    <nav class="section-nav" aria-label="Documentation">${navigation}</nav>
    ${content.sections.map((section) => renderSection(section)).join("\n    ")}
  </div>
</div>
</main>
${renderAskAiAboutThis(`${content.siteUrl}/`)}
${renderProjectResources(content)}
${renderHraSiteFooter(environment)}
${renderHraAnalyticsScript()}
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
  title: `${content.productName} | ${content.tagline}`,
})}
</head>
<body class="preview-page">
<main id="content" class="preview-shell">
  <article class="preview-card" aria-labelledby="preview-title">
    <p class="preview-eyebrow">${escapeHtml(content.tagline)}</p>
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

export const renderPrivacyHtml = (
  content: PublicContent = publicContent,
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): string => {
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
${renderSiteHeader(content, "/privacy/")}
<main id="content" class="narrow-page">
  ${renderSection(privacy)}
  <p>Report a suspected boundary violation through <a href="${escapeHtml(content.links.privateSecurityReport)}">private vulnerability reporting</a>.</p>
</main>
${renderAskAiAboutThis(`${content.siteUrl}/privacy/`)}
${renderProjectResources(content)}
${renderHraSiteFooter(environment)}
${renderHraAnalyticsScript()}
</body>
</html>
`;
};
