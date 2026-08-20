import { HranessBrand } from "@hra-internal/brand-ui";
import { ThemeToggle } from "@hra-internal/design-kit/react";
import {
  createPublicSiteMetadata,
  serializeJsonLd,
  webApplicationJsonLd,
  websiteJsonLd,
} from "@hraness/web-discovery";
import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";

import {
  HRA_BRAND_ICON_PATH,
  hraHomepageKeywords,
  hraSearchSite,
} from "./site";

export const metadata = {
  ...createPublicSiteMetadata(hraSearchSite),
  keywords: [...hraHomepageKeywords],
  title: { absolute: hraSearchSite.title },
} satisfies Metadata;

const capabilities = [
  {
    index: "01",
    title: "Coordinate the accounts you already use",
    detail:
      "Pair separate Codex accounts that you own or are authorized to use. Credentials and provider sessions remain isolated on your Mac.",
  },
  {
    index: "02",
    title: "Delegate work with structure",
    detail:
      "Turn one outcome into durable parent and child tasks with dependencies, bounded ownership, and an explicit path back to review.",
  },
  {
    index: "03",
    title: "Spend reasoning deliberately",
    detail:
      "Give wide work more room, bounded work a lighter lane, and follow-ups the same conversation when continuity is still safe.",
  },
  {
    index: "04",
    title: "Recover the work, not just the window",
    detail:
      "Persist who owned each effect, what was observed, and what still needs review so a restart does not turn uncertainty into a duplicate action.",
  },
] as const;

const workflow = [
  ["01", "Connect the Mac", "Choose the repositories and Codex accounts this installation is allowed to use."],
  ["02", "Describe the outcome", "HRA keeps the plan, dependencies, ownership, and review state outside any one agent conversation."],
  ["03", "Let the work divide", "Codex sessions run in managed worktrees; bounded child work can proceed in parallel without becoming unrelated tabs."],
  ["04", "Review and continue", "Accept the result, answer a question, redirect a branch, or resume the same durable task after an interruption."],
] as const;

const fits = [
  {
    title: "Use HRA when",
    items: [
      "one project needs several coordinated Codex sessions",
      "you have separate authorized Codex accounts to keep isolated",
      "child work must rejoin a durable parent task",
      "restarts and ambiguous effects need explicit recovery",
    ],
  },
  {
    title: "Choose something simpler when",
    items: [
      "you want the first-party Codex experience for a few independent sessions",
      "your team needs one desktop for many model providers",
      "the main problem is remote access from a phone",
      "a worktree launcher and diff viewer already solve the job",
    ],
  },
] as const;

const frequentlyAskedQuestions = [
  {
    question: "What is a metaharness?",
    answer:
      "A harness runs an agent. A metaharness decides how several harnesses divide work, share bounded context, choose a lane, recover interrupted effects, and bring results back to one review path. Codex does the coding; HRA coordinates the system around it.",
  },
  {
    question: "Does HRA bypass Codex limits?",
    answer:
      "No. A provider limit ends the affected turn. HRA does not move that work to another account. Every account remains subject to its own plan, limits, organization policy, and OpenAI terms. Use only accounts you own or are authorized to use, and group them only when each is allowed to access the same repository and data.",
  },
  {
    question: "How is this different from the Codex app?",
    answer:
      "The Codex app is the first-party place to run and review parallel Codex sessions. HRA is for the layer above them: several isolated account identities, a durable parent-and-child task graph, work-aware routing, human gates, and crash recovery across sessions.",
  },
  {
    question: "Where does execution authority live?",
    answer:
      "On the paired Mac. Provider credentials, local repositories, commands, raw transcripts, and provider session identifiers do not become browser authority. The hosted surface receives bounded coordination and review state.",
  },
  {
    question: "What can I install today?",
    answer:
      "An Apple Silicon macOS prerelease. It is ad-hoc signed for bundle integrity but is not Developer ID signed or notarized, so macOS will identify it as coming from an unknown developer. The download page explains that limitation before installation.",
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
              "Multiple authorized Codex account coordination",
              "Durable parent and child task graph",
              "Work-aware model and reasoning routing",
              "Crash-safe recovery and human review",
              "Local credential and repository custody",
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
          <a href="#why-hra">Why HRA</a>
          <a href="#how-it-works">How it works</a>
          <Link href="/alternatives">Compare</Link>
        </nav>
        <div className="landing-header-actions">
          <ThemeToggle />
          <a className="landing-text-link" href="https://github.com/hraness/hra">GitHub</a>
          <Link className="landing-button landing-button--compact" href="/app">Open HRA</Link>
        </div>
      </header>

      <main id="main-content">
        <section aria-labelledby="landing-title" className="landing-hero">
          <div className="landing-hero-copy">
            <p className="landing-eyebrow">A metaharness for Codex</p>
            <h1 id="landing-title">Give Codex a team, a memory, and a budget.</h1>
            <p className="landing-hero-statement">
              HRA turns the Codex accounts you already use into one durable system for planning work, delegating it, running it in parallel, and bringing it back for review.
            </p>
            <p className="landing-hero-detail">
              It is for projects that outgrow independent sessions: work has dependencies, follow-ups need continuity, account identities stay separate, and an interrupted run needs a recoverable answer.
            </p>
            <div className="landing-actions">
              <Link className="landing-button" href="/download">Download for macOS</Link>
              <Link className="landing-button landing-button--outline" href="/alternatives">Compare HRA</Link>
              <a className="landing-source-link" href="https://github.com/hraness/hra">
                View source <span aria-hidden="true">↗</span>
              </a>
            </div>
            <ul aria-label="Product facts" className="landing-proof-list">
              <li>Apple Silicon</li>
              <li>Public prerelease</li>
              <li>Apache 2.0</li>
              <li>Local execution</li>
            </ul>
          </div>
          <figure className="landing-authority-card">
            <figcaption>
              Parallel sessions become a system only when they can divide work and meet again.
            </figcaption>
            <div className="landing-authority-tier">
              <p>One durable outcome</p>
              <ul aria-label="Control plane authority">
                <li>Plan</li>
                <li>Review</li>
              </ul>
            </div>
            <p aria-hidden="true" className="landing-authority-transfer">↓ delegate · route · recover ↓</p>
            <div className="landing-authority-tier">
              <p>Coordinated Codex work</p>
              <ul aria-label="Paired Mac authority">
                <li>Root sessions</li>
                <li>Bounded children</li>
              </ul>
            </div>
            <p className="landing-authority-note">The task graph outlives any one agent window.</p>
          </figure>
        </section>

        <section aria-labelledby="capabilities-title" className="landing-section" id="why-hra">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Why HRA exists</p>
            <h2 id="capabilities-title">Parallel is the beginning, not the product.</h2>
            <p>
              A row of sessions can do more work. It cannot decide which work belongs together, preserve ownership after a restart, or tell a bounded helper how to return to its parent. HRA supplies that missing layer.
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
            <p className="landing-eyebrow">How it works</p>
            <h2 id="how-title">Describe the outcome once. Keep the coordination outside the prompt.</h2>
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

        <section aria-labelledby="fit-title" className="landing-section landing-fit-section">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">The honest fit</p>
            <h2 id="fit-title">HRA is intentionally narrower than an AI IDE.</h2>
            <p>
              It goes deep on Codex orchestration. If your main problem is provider choice, remote access, or isolated worktrees, another tool may be the more direct answer.
            </p>
          </div>
          <div className="landing-fit-grid">
            {fits.map(({ items, title }) => (
              <article key={title}>
                <h3>{title}</h3>
                <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
              </article>
            ))}
          </div>
          <Link className="landing-source-link" href="/alternatives">See the detailed comparisons →</Link>
        </section>

        <section aria-labelledby="start-title" className="landing-section landing-start-section">
          <div>
            <p className="landing-eyebrow">Public prerelease · Apple Silicon</p>
            <h2 id="start-title">Let the Mac keep the authority.</h2>
            <p>
              HRA keeps repositories, commands, credentials, raw transcripts, and provider sessions on the paired Mac. The hosted surface sees bounded coordination and review state.
            </p>
          </div>
          <div className="landing-actions">
            <Link className="landing-button" href="/download">Download HRA for macOS</Link>
            <Link className="landing-button landing-button--outline" href="/app">Open the control plane</Link>
          </div>
        </section>

        <section aria-labelledby="faq-title" className="landing-section" id="questions">
          <div className="landing-section-heading">
            <p className="landing-eyebrow">Plain answers</p>
            <h2 id="faq-title">Before you give it a repository.</h2>
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
            <p className="landing-eyebrow">Open source</p>
            <h2 id="source-title">The harness should be inspectable.</h2>
            <p>The public repository includes the product source, security architecture, build checks, and the exact boundaries around local execution.</p>
          </div>
          <a className="landing-button landing-button--outline" href="https://github.com/hraness/hra">
            Open GitHub <span aria-hidden="true">↗</span>
          </a>
        </section>
      </main>

      <footer className="landing-footer">
        <HranessBrand />
        <p>A durable metaharness for Codex.</p>
        <details className="landing-disclosure">
          <summary>Privacy and analytics</summary>
          <p>
            HRA uses cookieless, personless PostHog analytics on public pages to count visits. It records only the canonical public route, never query text, fragments, referrers, account or task data, commands, or provider sessions. Analytics do not run inside the authenticated control plane, and HRA adds no advertising trackers. Hosting providers may retain operational request logs under their own policies.
          </p>
        </details>
      </footer>
    </div>
  );
}
