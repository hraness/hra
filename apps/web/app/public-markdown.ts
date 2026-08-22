import {
  HTML_MEDIA_TYPE,
  MARKDOWN_CONTENT_TYPE,
  MARKDOWN_MEDIA_TYPE,
  preferredPublicDocumentType,
} from "./accept-negotiation";
import {
  COMPARISON_REVIEW_LABEL,
  comparisonForSlug,
  hraComparisons,
  sourceNumber,
  type HraComparison,
} from "./alternatives/comparisons";
import { isHraPublicComparisonPath } from "./alternatives/slugs";
import {
  HRA_RELEASE,
  HRA_RELEASE_CHECKSUM_URL,
  HRA_RELEASE_MANIFEST_URL,
  HRA_RELEASE_URL,
  hraSearchSite,
} from "./site";

export const HRA_LLMS_TXT_PATH = "/llms.txt" as const;

const origin = hraSearchSite.origin;

function absoluteUrl(path: `/${string}`): string {
  return `${origin}${path}`;
}

function citationMarks(
  comparison: HraComparison,
  sourceIds: readonly string[],
): string {
  if (sourceIds.length === 0) return "";
  const marks = sourceIds.map((sourceId) => {
    const source = comparison.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) {
      throw new Error(`Unknown source ${sourceId} for ${comparison.slug}`);
    }
    return `[${sourceNumber(comparison, source)}]`;
  });
  return ` ${marks.join("")}`;
}

export function canonicalPublicPath(pathname: string): string | null {
  if (pathname.includes("//") || pathname.includes("\\")) return null;
  if (!pathname.startsWith("/")) return null;
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

export function isPublicHtmlDocumentPath(pathname: string): boolean {
  const canonicalPath = canonicalPublicPath(pathname);
  if (canonicalPath === null) return false;
  return canonicalPath === "/"
    || canonicalPath === "/download"
    || isHraPublicComparisonPath(canonicalPath);
}

export function isAgentDiscoveryPath(pathname: string): boolean {
  const canonicalPath = canonicalPublicPath(pathname);
  return canonicalPath === HRA_LLMS_TXT_PATH
    || canonicalPath === "/robots.txt"
    || canonicalPath === "/sitemap.xml";
}

export function isAuthProtectedTree(pathname: string): boolean {
  const canonicalPath = canonicalPublicPath(pathname);
  if (canonicalPath === null) return true;
  return canonicalPath === "/api"
    || canonicalPath.startsWith("/api/")
    || canonicalPath === "/app"
    || canonicalPath.startsWith("/app/")
    || canonicalPath === "/auth"
    || canonicalPath.startsWith("/auth/")
    || canonicalPath === "/design"
    || canonicalPath.startsWith("/design/");
}

function lastPathSegment(pathname: string): string {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? "";
}

export function pathLooksLikeStaticAsset(pathname: string): boolean {
  const segment = lastPathSegment(pathname);
  return segment.includes(".");
}

export function createHraLlmsTxt(): string {
  const pages = [
    `- [HRA home](${absoluteUrl("/")}): Product overview, fit, and limits`,
    `- [Download for macOS](${absoluteUrl("/download")}): Apple Silicon prerelease status and source-build guidance`,
    `- [HRA alternatives](${absoluteUrl("/alternatives")}): First-party-sourced comparisons`,
    ...hraComparisons.map((comparison) =>
      `- [HRA vs ${comparison.shortName}](${absoluteUrl(`/alternatives/${comparison.slug}`)}): ${comparison.description}`),
  ];
  return [
    "# HRA",
    "",
    `> ${hraSearchSite.description}`,
    "",
    "When to use this: reach for HRA when one project needs several coordinated Codex sessions, you have separate authorized Codex accounts to keep isolated, child work must rejoin a durable parent task, or restarts and ambiguous effects need explicit recovery.",
    "",
    "Choose something simpler when you want the first-party Codex experience for a few independent sessions, your team needs one desktop for many model providers, the main problem is remote access from a phone, or a worktree launcher and diff viewer already solve the job.",
    "",
    "How an agent should call HRA: request `Accept: text/markdown` on the public pages below, or start from this file. Point humans at the website for product decisions, `/download` for the Mac app, and `/app` for the hosted control plane. Do not treat hra.sh as an execution, OAuth, GraphQL, MCP, or commerce API. Provider credentials, repositories, commands, and raw transcripts stay on the paired Mac. The public source is https://github.com/hraness/hra.",
    "",
    "## Pages",
    "",
    ...pages,
    "",
    "## Optional",
    "",
    `- [Agent guide](${absoluteUrl(HRA_LLMS_TXT_PATH)}): This file`,
    `- [XML sitemap](${absoluteUrl("/sitemap.xml")}): Indexable public HTML pages`,
    `- [Robots](${absoluteUrl("/robots.txt")}): Crawler allow and deny rules`,
    "- [Public source](https://github.com/hraness/hra): Product source, security architecture, and build checks",
    "- [Hosted control plane](https://hra.sh/app): Authenticated human supervision; not a public API",
    "",
  ].join("\n");
}

export const HRA_LLMS_TXT = createHraLlmsTxt();

export function createLandingMarkdown(): string {
  return [
    "# Give Codex a team, a memory, and a budget.",
    "",
    hraSearchSite.description,
    "",
    "HRA turns the Codex accounts you already use into one durable system for planning work, delegating it, running it in parallel, and bringing it back for review.",
    "",
    "It is for projects that outgrow independent sessions: work has dependencies, follow-ups need continuity, account identities stay separate, and an interrupted run needs a recoverable answer.",
    "",
    "## When to use HRA",
    "",
    "- one project needs several coordinated Codex sessions",
    "- you have separate authorized Codex accounts to keep isolated",
    "- child work must rejoin a durable parent task",
    "- restarts and ambiguous effects need explicit recovery",
    "",
    "## Choose something simpler when",
    "",
    "- you want the first-party Codex experience for a few independent sessions",
    "- your team needs one desktop for many model providers",
    "- the main problem is remote access from a phone",
    "- a worktree launcher and diff viewer already solve the job",
    "",
    "## Why HRA exists",
    "",
    "Parallel is the beginning, not the product. A row of sessions can do more work. It cannot decide which work belongs together, preserve ownership after a restart, or tell a bounded helper how to return to its parent.",
    "",
    "1. Coordinate the accounts you already use. Pair separate Codex accounts that you own or are authorized to use. Credentials and provider sessions remain isolated on your Mac.",
    "2. Delegate work with structure. Turn one outcome into durable parent and child tasks with dependencies, bounded ownership, and an explicit path back to review.",
    "3. Spend reasoning deliberately. Give wide work more room, bounded work a lighter lane, and follow-ups the same conversation when continuity is still safe.",
    "4. Recover the work, not just the window. Persist who owned each effect, what was observed, and what still needs review so a restart does not turn uncertainty into a duplicate action.",
    "",
    "## How it works",
    "",
    "1. Connect the Mac. Choose the repositories and Codex accounts this installation is allowed to use.",
    "2. Describe the outcome. HRA keeps the plan, dependencies, ownership, and review state outside any one agent conversation.",
    "3. Let the work divide. Codex sessions run in managed worktrees; bounded child work can proceed in parallel without becoming unrelated tabs.",
    "4. Review and continue. Accept the result, answer a question, redirect a branch, or resume the same durable task after an interruption.",
    "",
    "## Questions",
    "",
    "### What is a metaharness?",
    "",
    "A harness runs an agent. A metaharness decides how several harnesses divide work, share bounded context, choose a lane, recover interrupted effects, and bring results back to one review path. Codex does the coding; HRA coordinates the system around it.",
    "",
    "### Does HRA bypass Codex limits?",
    "",
    "No. A provider limit ends the affected turn. HRA does not move that work to another account. Every account remains subject to its own plan, limits, organization policy, and OpenAI terms. Use only accounts you own or are authorized to use, and group them only when each is allowed to access the same repository and data.",
    "",
    "### How is this different from the Codex app?",
    "",
    "The Codex app is the first-party place to run and review parallel Codex sessions. HRA is for the layer above them: several isolated account identities, a durable parent-and-child task graph, work-aware routing, human gates, and crash recovery across sessions.",
    "",
    "### Where does execution authority live?",
    "",
    "On the paired Mac. Provider credentials, local repositories, commands, raw transcripts, and provider session identifiers do not become browser authority. The hosted surface receives bounded coordination and review state.",
    "",
    "### What can I install today?",
    "",
    "An Apple Silicon macOS prerelease. It is ad-hoc signed for bundle integrity but is not Developer ID signed or notarized, so macOS will identify it as coming from an unknown developer. The download page explains that limitation before installation.",
    "",
    "## Public pages",
    "",
    `- [Download for macOS](${absoluteUrl("/download")})`,
    `- [Compare HRA](${absoluteUrl("/alternatives")})`,
    `- [Agent guide](${absoluteUrl(HRA_LLMS_TXT_PATH)})`,
    `- [XML sitemap](${absoluteUrl("/sitemap.xml")})`,
    "- [Public source](https://github.com/hraness/hra)",
    "",
  ].join("\n");
}

export function createDownloadMarkdown(): string {
  const published = HRA_RELEASE_URL !== null
    && HRA_RELEASE_CHECKSUM_URL !== null
    && HRA_RELEASE_MANIFEST_URL !== null;
  const statusLines = published
    ? [
        `Download the DMG: ${HRA_RELEASE_URL}`,
        `SHA-256 file: ${HRA_RELEASE_CHECKSUM_URL}`,
        `Release manifest: ${HRA_RELEASE_MANIFEST_URL}`,
        "",
        "Unknown developer. This candidate uses an ad-hoc code seal, but it is not Developer ID signed or notarized by Apple. The published SHA-256 verifies the exact release bytes; macOS will still ask you to approve the app manually.",
        "",
        "## Install the prerelease",
        "",
        `1. Download both files. Save the DMG and its SHA-256 file in the same folder.`,
        `2. Check the bytes. In Terminal, run \`shasum -a 256 -c ${HRA_RELEASE.asset}.sha256\`. Continue only when it prints \`OK\`.`,
        "3. Copy HRA to Applications. Open the DMG and drag HRA into the Applications folder.",
        "4. Approve the unknown developer. Control-click HRA in Finder and choose Open. If macOS still blocks it, use System Settings → Privacy & Security → Open Anyway.",
      ]
    : [
        "Candidate verification in progress. Do not install an unpublished draft asset.",
        "",
        "Unknown developer. This candidate uses an ad-hoc code seal, but it is not Developer ID signed or notarized by Apple. Its release commit, tag, manifest, and artifact hashes are still awaiting publication.",
        "",
        `HRA ${HRA_RELEASE.version} (${HRA_RELEASE.build}) is a checked source candidate. Do not drag a second app beside an installed OPRTE predecessor, and do not install an unpublished draft asset.`,
        "",
        `You can inspect or build the candidate from ${HRA_RELEASE.repository} while release evidence is completed.`,
      ];

  return [
    "# Download HRA for your Mac.",
    "",
    `The native prerelease bundles HRA, Codex, and Git for Apple Silicon Macs running macOS ${HRA_RELEASE.minimumMacOS} or newer.`,
    "",
    `Version ${HRA_RELEASE.version} (${HRA_RELEASE.build}) · Apple Silicon · macOS ${HRA_RELEASE.minimumMacOS}+ · ${published ? "Published prerelease" : "Candidate"} · Ad-hoc · not notarized.`,
    "",
    ...statusLines,
    "",
    "HRA can run coding agents with local filesystem and process authority. Pair only repositories and Codex accounts you intend it to use.",
    "",
    "## Build it yourself",
    "",
    "The public repository pins Bun, Zig, Codex, Git, native build inputs, and the package verifier. Build the same app locally if the ad-hoc release boundary is not right for you: https://github.com/hraness/hra#develop-hra",
    "",
    "Developer ID signing is not available yet. A later release needs a Developer ID certificate and Apple notarization before normal double-click installation can replace the unknown-developer flow. Automatic updates remain disabled until HRA owns a signed update channel.",
    "",
    "## Public pages",
    "",
    `- [HRA home](${absoluteUrl("/")})`,
    `- [Agent guide](${absoluteUrl(HRA_LLMS_TXT_PATH)})`,
    `- [XML sitemap](${absoluteUrl("/sitemap.xml")})`,
    "",
  ].join("\n");
}

export function createAlternativesIndexMarkdown(): string {
  return [
    "# Choose the layer you actually need.",
    "",
    "Coding-agent tools now overlap. Most can run work in parallel. The useful question is whether you need a first-party Codex app, a multi-provider workspace, a remote client, or a durable metaharness around Codex.",
    "",
    `Sources last reviewed ${COMPARISON_REVIEW_LABEL}.`,
    "",
    "## Comparisons",
    "",
    ...hraComparisons.flatMap((comparison) => [
      `### [HRA vs ${comparison.shortName}](${absoluteUrl(`/alternatives/${comparison.slug}`)})`,
      "",
      comparison.meaningfulDifference,
      "",
    ]),
    "## Four different jobs hide behind “agent orchestration.”",
    "",
    "- First-party Codex: Codex app is the default answer when you want OpenAI's supported parallel Codex experience.",
    "- Multi-provider workspace: Paseo, Conductor, Superset, OpenCode, and OpenChamber offer broader agent or provider surfaces.",
    "- Remote control: Happy Coder is centered on reaching coding sessions from a phone or browser.",
    "- Codex metaharness: HRA goes narrower and deeper on authorized account custody, durable delegation, continuity, and recovery around Codex.",
    "",
    "Positive claims link to current first-party documentation where possible. “Not documented” means only that we did not find the feature in the reviewed official sources. It is not proof that a product lacks it. HRA is an independent project and is not affiliated with any compared product.",
    "",
    "## Public pages",
    "",
    `- [HRA home](${absoluteUrl("/")})`,
    `- [Download for macOS](${absoluteUrl("/download")})`,
    `- [Agent guide](${absoluteUrl(HRA_LLMS_TXT_PATH)})`,
    `- [XML sitemap](${absoluteUrl("/sitemap.xml")})`,
    "",
  ].join("\n");
}

export function createComparisonMarkdown(comparison: HraComparison): string {
  const rows = comparison.rows.flatMap((row) => [
    `### ${row.label}`,
    "",
    `- HRA: ${row.hra}${citationMarks(comparison, row.hraSourceIds)}`,
    `- ${comparison.shortName}: ${row.alternative}${citationMarks(comparison, row.alternativeSourceIds)}`,
    "",
  ]);
  const sources = comparison.sources.map((source, index) =>
    `${index + 1}. [${source.label}](${source.url})`);
  const related = hraComparisons
    .filter((candidate) => candidate.slug !== comparison.slug)
    .slice(0, 3)
    .map((candidate) =>
      `- [HRA vs ${candidate.shortName}](${absoluteUrl(`/alternatives/${candidate.slug}`)})`);

  return [
    `# HRA vs ${comparison.shortName}`,
    "",
    `Last verified ${COMPARISON_REVIEW_LABEL}.`,
    "",
    `${comparison.commonGround}${citationMarks(comparison, [
      ...comparison.hraSummarySourceIds,
      ...comparison.alternativeSummarySourceIds,
    ])}`,
    "",
    "## Short answer",
    "",
    `### Choose ${comparison.shortName}`,
    "",
    `${comparison.alternativeFit}${citationMarks(comparison, comparison.alternativeSummarySourceIds)}`,
    "",
    "### Choose HRA",
    "",
    `${comparison.hraFit}${citationMarks(comparison, comparison.hraSummarySourceIds)}`,
    "",
    "## The meaningful difference",
    "",
    `${comparison.meaningfulDifference}${citationMarks(comparison, [
      ...comparison.hraSummarySourceIds,
      ...comparison.alternativeSummarySourceIds,
    ])}`,
    "",
    "## The decisions that matter",
    "",
    ...rows,
    "## Current HRA limitations",
    "",
    "- HRA's native host currently supports Apple Silicon Macs only.",
    "- The downloadable app is ad-hoc signed, not Developer ID signed or notarized.",
    "- The recursive harness is experimental, and the adaptive optimizer cannot activate policy.",
    "- HRA is Codex-only; it is the wrong choice when provider breadth is the requirement.",
    "- Multiple accounts must be owned or authorized by you and permitted to access the same work.",
    "",
    "## Current first-party sources",
    "",
    ...sources,
    "",
    `“Not documented” means only that a capability was not found in these sources on ${COMPARISON_REVIEW_LABEL}. It does not prove the product lacks it. HRA is independent and unaffiliated with ${comparison.name}. Report a correction: https://github.com/hraness/hra/issues`,
    "",
    "## More comparisons",
    "",
    ...related,
    "",
    `- [All HRA comparisons](${absoluteUrl("/alternatives")})`,
    `- [Agent guide](${absoluteUrl(HRA_LLMS_TXT_PATH)})`,
    `- [XML sitemap](${absoluteUrl("/sitemap.xml")})`,
    "",
  ].join("\n");
}

export function createNotFoundMarkdown(): string {
  return [
    "# Not found",
    "",
    "The requested HRA page does not exist or is no longer available.",
    "",
    "## Where to look next",
    "",
    `- [HRA home](${absoluteUrl("/")})`,
    `- [Download for macOS](${absoluteUrl("/download")})`,
    `- [Comparisons](${absoluteUrl("/alternatives")})`,
    `- [Agent guide](${absoluteUrl(HRA_LLMS_TXT_PATH)})`,
    `- [XML sitemap](${absoluteUrl("/sitemap.xml")})`,
    "",
  ].join("\n");
}

export function publicDocumentMarkdown(pathname: string): string | null {
  const canonicalPath = canonicalPublicPath(pathname);
  if (canonicalPath === null) return null;
  if (canonicalPath === "/") return createLandingMarkdown();
  if (canonicalPath === "/download") return createDownloadMarkdown();
  if (canonicalPath === "/alternatives") return createAlternativesIndexMarkdown();
  if (canonicalPath.startsWith("/alternatives/")) {
    const comparison = comparisonForSlug(canonicalPath.slice("/alternatives/".length));
    return comparison === undefined ? null : createComparisonMarkdown(comparison);
  }
  return null;
}

export type PublicDiscoveryDecision =
  | {
    readonly action: "markdown";
    readonly body: string;
    readonly contentType: typeof MARKDOWN_CONTENT_TYPE;
    readonly status: 200 | 404;
  }
  | {
    readonly action: "not_acceptable";
  }
  | {
    readonly action: "html";
  }
  | {
    readonly action: "passthrough";
  };

export function isNextInternalNavigation(headers: Headers): boolean {
  return headers.has("rsc")
    || headers.has("next-router-state-tree")
    || headers.has("next-router-prefetch")
    || headers.has("next-router-segment-prefetch")
    || headers.has("next-url");
}

export function resolvePublicDiscovery(input: {
  readonly accept: string | null;
  readonly method: string;
  readonly nextInternalNavigation: boolean;
  readonly pathname: string;
}): PublicDiscoveryDecision {
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return { action: "passthrough" };
  if (input.nextInternalNavigation) return { action: "passthrough" };

  const canonicalPath = canonicalPublicPath(input.pathname);
  if (canonicalPath === null) return { action: "passthrough" };
  if (isAuthProtectedTree(canonicalPath)) return { action: "passthrough" };
  if (isAgentDiscoveryPath(canonicalPath) || pathLooksLikeStaticAsset(canonicalPath)) {
    return { action: "passthrough" };
  }

  const preferred = preferredPublicDocumentType(input.accept);
  const document = publicDocumentMarkdown(canonicalPath);

  if (document !== null) {
    if (preferred === MARKDOWN_MEDIA_TYPE) {
      return {
        action: "markdown",
        body: document,
        contentType: MARKDOWN_CONTENT_TYPE,
        status: 200,
      };
    }
    if (preferred === null) return { action: "not_acceptable" };
    return { action: "html" };
  }

  if (preferred === MARKDOWN_MEDIA_TYPE) {
    return {
      action: "markdown",
      body: createNotFoundMarkdown(),
      contentType: MARKDOWN_CONTENT_TYPE,
      status: 404,
    };
  }
  return { action: "passthrough" };
}

export { HTML_MEDIA_TYPE, MARKDOWN_CONTENT_TYPE, MARKDOWN_MEDIA_TYPE };
