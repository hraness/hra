import { HranessBrand } from "@hra-internal/brand-ui";
import { ThemeToggle } from "@hra-internal/design-kit/react";
import {
  serializeJsonLd,
  webApplicationJsonLd,
  websiteJsonLd,
} from "@hra-internal/web-discovery";
import Link from "next/link";
import Image from "next/image";

import { HRA_BRAND_ICON_PATH, hraSearchSite } from "./site";

const capabilities = [
  {
    index: "01",
    title: "Keep parallel sessions durable",
    detail:
      "Model prerequisites, ownership, leases, submissions, and review as one persistent task graph instead of a pile of chat tabs.",
  },
  {
    index: "02",
    title: "Coordinate subscriptions",
    detail:
      "Connect multiple Codex subscriptions, route work to the eligible local account, and keep each run fenced to its exact Mac, repository, and claim.",
  },
  {
    index: "03",
    title: "Match the lane to the work",
    detail:
      "Use Sol Max by default, Sol Ultra for genuinely wide changes or research, Luna Max for bounded leaves, and Fast only as a sparse critical-path overlay.",
  },
  {
    index: "04",
    title: "Keep local authority local",
    detail:
      "Carry stable context references and bounded summaries across turns in a cache-compatible shape while keeping credentials, transcripts, and execution authority on the paired Mac.",
  },
] as const;

const workflow = [
  ["01", "Plan the work", "Create durable tasks, dependencies, and review requirements in the web control plane."],
  ["02", "Pair subscriptions", "Connect the repositories and Codex subscriptions that this installation is allowed to use."],
  ["03", "Run in parallel", "HRA routes each session to its work-appropriate model and paired local runner inside managed worktrees."],
  ["04", "Review the evidence", "A human accepts, rejects, stops, or answers the exact waiting run before dependent work advances."],
] as const;

const frequentlyAskedQuestions = [
  {
    question: "Is HRA an AI agent?",
    answer:
      "No. HRA is a metaharness and control plane around Codex. Codex performs the work; HRA coordinates multiple subscriptions, durable parallel sessions, local account routing, human review, and recovery.",
  },
  {
    question: "How does HRA choose a model and speed?",
    answer:
      "Sol Max is the default for ordinary work. Sol Ultra is reserved for genuinely wide changes or research, while Luna Max handles clearly bounded leaves. Fast is a per-turn overlay requested sparingly on the root task's critical path when reasoning or file generation is the bottleneck.",
  },
  {
    question: "Where do my Codex credentials live?",
    answer:
      "On the paired Mac. The browser and Convex control plane never receive provider credentials, provider session identifiers, raw tool detail, or filesystem authority.",
  },
  {
    question: "What does cross-device session sync contain?",
    answer:
      "Only an encrypted session-summary projection: title, optional repository display name, model effort, coarse state, revision, origin device, and deletion state. Remote panes are view-only.",
  },
  {
    question: "What can I install today?",
    answer:
      "HRA is a source-only prerelease for Apple Silicon Macs. The macOS page links to the public repository and its pinned local build instructions; official consumer binaries are not published yet.",
  },
] as const;

export default function LandingPage() {
  return (
    <div className="landing-page">
      <script
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(websiteJsonLd(hraSearchSite)) }}
        type="application/ld+json"
      />
      <script
        dangerouslySetInnerHTML={{
          __html: serializeJsonLd(webApplicationJsonLd(hraSearchSite, {
            browserRequirements: "Requires a modern browser; local execution requires the HRA macOS app.",
            category: "DeveloperApplication",
            features: [
              "Durable task and dependency graph",
              "Parallel Codex run supervision",
              "Human approvals, questions, and review",
              "Local Codex credential and repository custody",
              "Optional encrypted session-summary sync",
            ],
          })),
        }}
        type="application/ld+json"
      />
      <a className="landing-skip-link" href="#main-content">Skip to content</a>
      <header className="landing-header">
        <Link aria-label="HRA home" className="landing-wordmark" href="/">
          <span aria-hidden="true">
            <Image
              alt=""
              className="brand-icon-image"
              height={512}
              src={HRA_BRAND_ICON_PATH}
              width={512}
            />
          </span>
          <strong>HRA</strong>
        </Link>
        <nav aria-label="Primary navigation" className="landing-navigation">
          <a href="#capabilities">Capabilities</a>
          <a href="#how-it-works">How it works</a>
          <a href="#questions">FAQ</a>
        </nav>
        <div className="landing-header-actions">
          <ThemeToggle />
          <Link className="landing-text-link" href="/download">Build for macOS</Link>
          <Link className="landing-button landing-button--compact" href="/app">Open HRA</Link>
        </div>
      </header>

      <main id="main-content">
        <section aria-labelledby="landing-title" className="landing-hero">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">The tokenmaxxing metaharness for Codex</p>
            <h1 id="landing-title">Run more Codex work without losing the thread.</h1>
            <p className="landing-hero-statement">
              HRA coordinates multiple Codex subscriptions and durable parallel sessions so long-running work can keep moving under one local authority boundary.
            </p>
            <p className="landing-hero-detail">
              Use Sol Max by default, Sol Ultra for genuinely wide work, and Luna Max for bounded leaves. HRA can request Fast sparingly on the critical path when inference or file generation is the bottleneck, while continuity and cache-compatible context reduce repeated setup. Credentials, raw execution detail, and filesystem authority stay on your Mac.
            </p>
            <div className="landing-actions">
              <Link className="landing-button" href="/app">Open HRA</Link>
              <Link className="landing-button landing-button--outline" href="/download">Build for macOS</Link>
              <a className="landing-source-link" href="https://github.com/hraness/hra">
                View source <span aria-hidden="true">↗</span>
              </a>
            </div>
            <ul aria-label="Product facts" className="landing-proof-list">
              <li>Source available</li>
              <li>Apple Silicon runner</li>
              <li>Codex app-server</li>
              <li>Multiple subscriptions</li>
              <li>Human review</li>
            </ul>
          </div>
          <figure className="landing-authority-card">
            <figcaption>
              HRA coordinates durable work in the control plane while credentials and execution authority remain on the paired Mac.
            </figcaption>
            <div className="landing-authority-tier">
              <p>HRA control plane</p>
              <ul aria-label="Control plane authority">
                <li>Durable task graph</li>
                <li>Human review</li>
              </ul>
            </div>
            <p aria-hidden="true" className="landing-authority-transfer">↓ bounded work</p>
            <div className="landing-authority-tier">
              <p>Paired Mac</p>
              <ul aria-label="Paired Mac authority">
                <li>Codex accounts</li>
                <li>Managed worktrees</li>
              </ul>
            </div>
            <p className="landing-authority-note">Credentials and execution authority stay local.</p>
          </figure>
        </section>

        <section aria-labelledby="capabilities-title" className="landing-section" id="capabilities">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Concrete capabilities</p>
            <h2 id="capabilities-title">Spend each Codex turn where it can do useful work.</h2>
            <p>
              HRA separates durable project authority from provider-local runtime authority, then connects them through narrow, fenced protocols that preserve continuity across parallel sessions.
            </p>
          </div>
          <div className="landing-card-grid">
            {capabilities.map((capability) => (
              <article className="landing-card" key={capability.index}>
                <span aria-hidden="true">{capability.index}</span>
                <h3>{capability.title}</h3>
                <p>{capability.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="how-title" className="landing-section landing-section--tonal" id="how-it-works">
          <div className="landing-section-heading landing-section-heading--wide">
            <p className="landing-eyebrow">A bounded coordination loop</p>
            <h2 id="how-title">Plan in the control plane. Execute on the Mac. Advance through review.</h2>
          </div>
          <ol className="landing-flow">
            {workflow.map(([index, title, detail]) => (
              <li key={index}>
                <span aria-hidden="true">{index}</span>
                <div><h3>{title}</h3><p>{detail}</p></div>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="boundary-title" className="landing-section landing-boundary-section">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">The boundary is part of the product</p>
            <h2 id="boundary-title">The cloud sees enough to coordinate, never enough to become your Mac.</h2>
            <p>
              Convex is authoritative for tasks, claims, review, and bounded run display. The desktop remains authoritative for Codex subscriptions, local sessions, managed worktrees, and provider execution.
            </p>
          </div>
          <dl className="landing-boundaries">
            <div><dt>Hosted task state</dt><dd>Tasks, dependencies, claims, submissions, comments, lifecycle events, and review decisions.</dd></div>
            <div><dt>Bounded live display</dt><dd>Reasoning-summary text, assistant text, anonymous tool activity, semantic phases, and explicit human questions.</dd></div>
            <div><dt>Local-only authority</dt><dd>Provider credentials and IDs, full transcripts, raw reasoning, tool names and arguments, commands, output, and canonical paths.</dd></div>
            <div><dt>Optional encrypted sync</dt><dd>View-only session summaries. No prompts, responses, transcripts, account identity, or remote execution controls.</dd></div>
          </dl>
        </section>

        <section aria-labelledby="start-title" className="landing-section landing-start-section">
          <div>
            <p className="landing-eyebrow">Apple Silicon</p>
            <h2 id="start-title">Start with the Mac that will run the work.</h2>
            <p>
              Build the Apple Silicon app from the checked public source, then open the web control plane to pair repositories and Codex accounts.
            </p>
          </div>
          <div className="landing-actions">
            <Link className="landing-button" href="/download">Build HRA for macOS</Link>
            <Link className="landing-button landing-button--outline" href="/app">Open the control plane</Link>
          </div>
        </section>

        <section aria-labelledby="faq-title" className="landing-section" id="questions">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Questions HRA should answer plainly</p>
            <h2 id="faq-title">Capabilities and limits</h2>
          </div>
          <div className="landing-faq-list">
            {frequentlyAskedQuestions.map(({ answer, question }) => (
              <details key={question}>
                <summary>{question}</summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="source-title" className="landing-section landing-source-section">
          <div>
            <p className="landing-eyebrow">Inspect the system</p>
            <h2 id="source-title">Read the source and the operating boundaries.</h2>
            <p>The public repository includes the product source, security architecture, source checks, and credential-free build instructions.</p>
          </div>
          <a className="landing-button landing-button--outline" href="https://github.com/hraness/hra">
            Open GitHub <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>

      <footer className="landing-footer">
        <HranessBrand />
        <p>HRA keeps project coordination durable and provider authority local.</p>
        <details className="landing-disclosure">
          <summary>Privacy and analytics</summary>
          <p>
            HRA adds no client-side analytics or advertising trackers to this page. Hosting providers may retain operational request logs under their own policies.
          </p>
        </details>
      </footer>
    </div>
  );
}
