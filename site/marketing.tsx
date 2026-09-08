import {
  MarketingCallToAction,
  MarketingFlow,
  MarketingInstallPanel,
  MarketingMaker,
  MarketingPage,
  MarketingPillars,
  MarketingProofFrame,
  MarketingQuestionList,
  MarketingSection,
  MarketingSectionLabel,
  MarketingSiteHeader,
  MarketingTrustBoundary,
  ProductHero,
  SyntaxCode,
} from "@hraness/design-kit/react/server";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { findSection, type ContentBlock, type InlineContent, type PublicContent } from "./content.ts";
import { heroExampleMeasureClassName } from "./marketing.stylex.ts";
import { sitePresentationClasses, type SitePresentationSlot } from "./presentation.stylex.ts";

const classes = (hook: string, ...slots: readonly SitePresentationSlot[]): string =>
  [hook, sitePresentationClasses(...slots)].filter(Boolean).join(" ");

/** Content remains text and native elements; only FAQ links use prose styling. */
function inlineContent(content: readonly InlineContent[], styleLinks: boolean): ReactNode {
  return content.map((part, index) => {
    switch (part.kind) {
      case "code":
        return <code className={classes("hra-inline-code", "inlineCode")} key={index}>{part.value}</code>;
      case "link":
        return <a className={styleLinks ? sitePresentationClasses("proseLink") : undefined} href={part.href} key={index}>{part.label}</a>;
      case "text":
        return part.value;
    }
  });
}

function ShellCode({ command }: Readonly<{ command: string }>) {
  return <SyntaxCode className={sitePresentationClasses("codeContent")} code={command} language="shell" />;
}

function HeroFrame({ content }: Readonly<{ content: PublicContent }>) {
  const firstSession = findSection(content, "first-session");
  const humanTerminal = firstSession.blocks.find(
    (block): block is Extract<ContentBlock, { kind: "commands" }> => block.kind === "commands",
  );
  if (humanTerminal === undefined) {
    throw new Error("Public content must publish the human-terminal first-session commands.");
  }
  return (
    <MarketingProofFrame
      caption="After the rollout prerequisite is satisfied, start a session, open the shell, select the account and session, then type a request. These conditional first-session commands are documented in the reference below."
      credit={`v${content.releaseVersion}`}
      title="hra · persistent shell"
    >
      <pre className={classes("shell-transcript", "codeBlock", "shellTranscript", "focusable")} tabIndex={0}>
        <ShellCode command={humanTerminal.commands.join("\n")} />
      </pre>
    </MarketingProofFrame>
  );
}

function RolloutNotice({ content, placement }: Readonly<{ content: PublicContent; placement: "hero" | "install" }>) {
  return (
    <aside className={classes("notice", "notice")}>
      <strong className={sitePresentationClasses("noticeStrong")}>
        {placement === "hero" ? "Current daemon rollout blocked" : "Before initialization"}
      </strong>
      <p>{content.daemonRolloutNotice}</p>
      {placement === "hero"
        ? <p><a href="#install-and-update">Read the rollout and update runbook</a> before running the examples below.</p>
        : <p><a href="#install-and-update">Read the rollout and update runbook.</a></p>}
    </aside>
  );
}

export function renderMarketingHeader(content: PublicContent, currentPath: "/" | "/privacy/"): string {
  return renderToStaticMarkup(
    <MarketingSiteHeader
      action={{ emphasis: "primary", href: "/#install-command", label: `Install ${content.productName}` }}
      brand={content.productName}
      brandHref="/"
      links={[
        { href: "/#how-it-works", label: "How it works", current: currentPath === "/" },
        { href: "/#install-command", label: "Install" },
        { href: "/#reference", label: "Reference" },
        { href: "/privacy/", label: "Privacy", current: currentPath === "/privacy/" },
        { href: content.links.github, label: "GitHub" },
      ]}
    />,
  );
}

export function renderReferenceLabel(): string {
  return renderToStaticMarkup(
    <MarketingSectionLabel className={sitePresentationClasses("proseMeasure")} size="body">Reference</MarketingSectionLabel>,
  );
}

/** Requires the public 0.5.2 marketing slots. The caller supplies only its own
 * already-escaped Reference contents, without an outer #reference wrapper.
 * That existing wrapper is the sole local raw-markup insertion boundary. */
export function renderMarketingPage(content: PublicContent, referenceMarkup: string): string {
  return renderToStaticMarkup(
    <MarketingPage className={sitePresentationClasses("marketingPage")}>
      <ProductHero
        actions={[
          { ...content.hero.primaryAction, emphasis: "primary" },
          { ...content.hero.secondaryAction, emphasis: "secondary" },
        ]}
        align="center"
        boundary={content.hero.boundary}
        className={heroExampleMeasureClassName()}
        example={content.hero.example}
        eyebrow={content.hero.eyebrow}
        facts={content.hero.facts}
        factsColumns={4}
        frame={<HeroFrame content={content} />}
        heading={content.hero.heading}
        headingId="hra-title"
        name={content.productName}
        notice={<RolloutNotice content={content} placement="hero" />}
        summary={content.hero.summary}
        tone="paper"
      />
      <MarketingPillars ariaLabel={`${content.productName} in three points`} columns={3} pillars={content.hero.pillars} />
      <MarketingSection
        heading={content.hero.proofLabel}
        headingId="how-it-works-heading"
        id="how-it-works"
        label="How it works"
        layout="split"
        summary="After the rollout prerequisite is satisfied, every step is one command with a JSON form, so a person in the shell and an agent in a subprocess drive the same session the same way."
      >
        <MarketingFlow
          ariaLabel={`First ${content.productName} request`}
          steps={content.hero.steps.map((step) => ({ code: step.command, detail: step.detail, label: step.label }))}
        />
      </MarketingSection>
      <MarketingInstallPanel
        eyebrow={`Local release · v${content.releaseVersion}`}
        heading="Install after release admission."
        headingId="install-command-heading"
        id="install-command"
        note={<p className={classes("install-note", "installNote")}>This release candidate is not yet admitted. Use this command only after immutable GitHub and npm release admission. It downloads the immutable release, verifies its digest, and installs it. Installing and checking the binary does not start the daemon. Initialization remains blocked by the rollout prerequisite.</p>}
      >
        <pre className={classes("install-command", "codeBlock", "installCommand", "focusable")} tabIndex={0}>
          <ShellCode command={content.installCommand} />
        </pre>
        <pre className={classes("doctor-command", "codeBlock", "focusable")} tabIndex={0}>
          <ShellCode command={content.doctorCommand} />
        </pre>
        <RolloutNotice content={content} placement="install" />
        <p>After the rollout prerequisite is satisfied, initialize:</p>
        <pre className={classes("init-command", "codeBlock", "focusable")} tabIndex={0}>
          <ShellCode command={content.initCommand} />
        </pre>
      </MarketingInstallPanel>
      <MarketingTrustBoundary
        heading="Keep control of the accounts you already have."
        headingId="local-by-design-heading"
        id="local-by-design"
        items={content.trust}
        label="Local by design"
        summary={`${content.productName} is infrastructure around the provider tools you chose, not a proxy in front of them.`}
      />
      <MarketingQuestionList
        heading="Before you install."
        headingId="questions-heading"
        id="questions"
        label="Questions"
        questions={content.questions.map((question) => ({ question: question.question, answer: <p>{inlineContent(question.answer, true)}</p> }))}
      />
      <MarketingMaker
        heading={content.maker.heading}
        headingId="maker-heading"
        id="maker"
        label="Built by"
        linkClassName={sitePresentationClasses("proseLink")}
        links={content.maker.links}
      >
        {content.maker.bio.length === 0 ? null : <p>{inlineContent(content.maker.bio, false)}</p>}
      </MarketingMaker>
      <MarketingCallToAction
        actions={[
          { emphasis: "primary", href: "#install-command", label: `Install ${content.productName}` },
          { emphasis: "secondary", href: content.links.github, label: "Read the source" },
        ]}
        footnote={content.hero.boundary}
        heading="Give every session the same terminal."
        headingId="closing-heading"
        id="closing"
        summary="After the candidate is admitted, install and verify its CLI artifact. After the rollout prerequisite is satisfied, initialize it, add one account, and start a session that outlives the tab it began in."
        tone="paper"
      />
      <div className={classes("reference", "reference")} id="reference" dangerouslySetInnerHTML={{ __html: referenceMarkup }} />
    </MarketingPage>,
  );
}
