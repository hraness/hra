import type { HraComparisonSlug } from "./slugs";
import { HRA_RELEASE } from "../site";

export const COMPARISON_REVIEW_DATE = "2026-08-16" as const;
export const COMPARISON_REVIEW_LABEL = "16 August 2026" as const;

export interface ComparisonSource {
  readonly id: string;
  readonly label: string;
  readonly url: `https://${string}`;
}

export interface ComparisonRow {
  readonly alternative: string;
  readonly alternativeSourceIds: readonly string[];
  readonly hra: string;
  readonly hraSourceIds: readonly string[];
  readonly label: string;
}

export interface HraComparison {
  readonly alternativeFit: string;
  readonly alternativeSummarySourceIds: readonly string[];
  readonly commonGround: string;
  readonly description: string;
  readonly hraFit: string;
  readonly hraSummarySourceIds: readonly string[];
  readonly meaningfulDifference: string;
  readonly name: string;
  readonly rows: readonly ComparisonRow[];
  readonly shortName: string;
  readonly slug: HraComparisonSlug;
  readonly sources: readonly ComparisonSource[];
}

export function hraComparisonCitationVersion(
  release: Readonly<{
    availability: "candidate" | "published";
    version: string;
  }>,
): string {
  return release.availability === "published" ? release.version : "0.1.12";
}

const HRA_COMPARISON_CITATION_VERSION =
  hraComparisonCitationVersion(HRA_RELEASE);
const HRA_VERSIONED_SOURCE_ROOT =
  `https://github.com/hraness/hra/blob/v${HRA_COMPARISON_CITATION_VERSION}/` as const;

export const hraComparisonSources = [
  {
    id: "hra-readme",
    label: `HRA v${HRA_COMPARISON_CITATION_VERSION}: Project overview`,
    url: `${HRA_VERSIONED_SOURCE_ROOT}README.md`,
  },
  {
    id: "hra-desktop",
    label: `HRA v${HRA_COMPARISON_CITATION_VERSION}: macOS architecture and limits`,
    url: `${HRA_VERSIONED_SOURCE_ROOT}apps/desktop/README.md`,
  },
  {
    id: "hra-harness",
    label: `HRA v${HRA_COMPARISON_CITATION_VERSION}: Recursive Codex harness`,
    url: `${HRA_VERSIONED_SOURCE_ROOT}apps/desktop/HARNESS.md`,
  },
  {
    id: "hra-security",
    label: `HRA v${HRA_COMPARISON_CITATION_VERSION}: Security architecture`,
    url: `${HRA_VERSIONED_SOURCE_ROOT}SECURITY_ARCHITECTURE.md`,
  },
  {
    id: "hra-routing-policy",
    label: `HRA v${HRA_COMPARISON_CITATION_VERSION}: Model and acceleration policy`,
    url: `${HRA_VERSIONED_SOURCE_ROOT}apps/desktop/runtime/src/harness/metaharness-policy-v1.ts`,
  },
] as const satisfies readonly ComparisonSource[];

const hraSummarySourceIds = [
  "hra-readme",
  "hra-harness",
  "hra-security",
] as const;

export const hraComparisons = [
  {
    slug: "codex-app",
    name: "OpenAI Codex app",
    shortName: "Codex app",
    description:
      "Compare the first-party Codex app with HRA's multi-account task graph, work-aware routing, and durable recovery layer.",
    commonGround:
      "Both run Codex locally, support parallel work, preserve conversation context, and give a human a place to inspect results.",
    meaningfulDifference:
      "Codex app is the first-party Codex experience. HRA deliberately sits one level above Codex sessions: it coordinates separate authorized account identities, models parent and child work durably, and records enough effect evidence to recover without guessing after a crash.",
    alternativeFit:
      "Choose Codex app for the supported first-party experience, built-in worktrees and subagents, skills, automations, and the shortest path from prompt to parallel Codex work.",
    hraFit:
      "Choose HRA when several Codex sessions must behave like one recoverable project and you need explicit account isolation, delegation, dependencies, review gates, and cross-session recovery.",
    sources: [
      ...hraComparisonSources,
      { id: "intro", label: "OpenAI: Introducing the Codex app", url: "https://openai.com/index/introducing-the-codex-app/" },
      { id: "worktrees", label: "Codex documentation: Git worktrees", url: "https://learn.chatgpt.com/docs/environments/git-worktrees" },
      { id: "subagents", label: "Codex documentation: Subagents", url: "https://learn.chatgpt.com/docs/agent-configuration/subagents" },
      { id: "accounts", label: "OpenAI Help: Use multiple accounts", url: "https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching" },
    ],
    hraSummarySourceIds,
    alternativeSummarySourceIds: ["intro", "worktrees", "subagents", "accounts"],
    rows: [
      { label: "Core job", hra: "Coordinate a durable Codex workload across sessions.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Provide the first-party interface for running and reviewing Codex.", alternativeSourceIds: ["intro"] },
      { label: "Parallel work", hra: "Managed roots and bounded child work in a persistent task graph.", hraSourceIds: ["hra-readme", "hra-security"], alternative: "Parallel chats, isolated worktrees, and native subagents.", alternativeSourceIds: ["worktrees", "subagents"] },
      { label: "Account identities", hra: "Several authorized Codex accounts can be paired with separate local custody.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Codex desktop does not currently support ChatGPT account switching.", alternativeSourceIds: ["accounts"] },
      { label: "Coordination state", hra: "Dependencies, claims, leases, submissions, questions, and review survive sessions.", hraSourceIds: ["hra-readme", "hra-security"], alternative: "Projects, threads, skills, automations, and long-running work live in the first-party product.", alternativeSourceIds: ["intro"] },
      { label: "Recovery", hra: "Generation-bound receipts reconcile applied, absent, ambiguous, and rerouted effects.", hraSourceIds: ["hra-harness", "hra-security"], alternative: "Thread continuity and app-managed task state; HRA's receipt graph is a different layer.", alternativeSourceIds: ["intro"] },
      { label: "Best fit", hra: "A Codex-only system whose coordination must outlive any one session.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Most people starting with parallel Codex work or wanting first-party support.", alternativeSourceIds: ["intro"] },
    ],
  },
  {
    slug: "opencode-desktop",
    name: "OpenCode Desktop",
    shortName: "OpenCode Desktop",
    description:
      "Compare OpenCode's open multi-provider agent runtime with HRA's Codex-specific orchestration and account custody.",
    commonGround:
      "Both are open-source desktop tools for agent and subagent work in local repositories, with a human-facing session interface.",
    meaningfulDifference:
      "OpenCode Desktop is an interface for an agent runtime that lets you choose providers, models, permissions, and agent definitions. HRA keeps Codex as the runtime and specializes in coordinating a durable workload across several authorized Codex identities.",
    alternativeFit:
      "Choose OpenCode Desktop when provider and model freedom, cross-platform support, configurable agents, and one open agent runtime matter most.",
    hraFit:
      "Choose HRA when you want official Codex sessions underneath a persistent task graph with account isolation, work-class routing, review, and generation-fenced recovery.",
    sources: [
      ...hraComparisonSources,
      { id: "intro", label: "OpenCode documentation: Introduction", url: "https://opencode.ai/docs/" },
      { id: "agents", label: "OpenCode documentation: Agents", url: "https://opencode.ai/docs/agents" },
      { id: "providers", label: "OpenCode documentation: Providers", url: "https://opencode.ai/docs/providers" },
      { id: "repo", label: "OpenCode source and desktop downloads", url: "https://github.com/anomalyco/opencode" },
    ],
    hraSummarySourceIds,
    alternativeSummarySourceIds: ["intro", "agents", "providers", "repo"],
    rows: [
      { label: "Core job", hra: "Operate a durable coordination layer around Codex.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Run an open coding agent across many model providers.", alternativeSourceIds: ["intro", "providers"] },
      { label: "Platforms", hra: "Apple Silicon macOS prerelease.", hraSourceIds: ["hra-desktop"], alternative: "Terminal, desktop, and IDE surfaces; desktop builds cover macOS, Windows, and Linux.", alternativeSourceIds: ["repo"] },
      { label: "Agents", hra: "Persistent Codex actors with bounded parent-child authority.", hraSourceIds: ["hra-harness", "hra-security"], alternative: "Configurable primary agents and subagents with model, prompt, permissions, and tool access.", alternativeSourceIds: ["agents"] },
      { label: "Provider scope", hra: "Codex only by design.", hraSourceIds: ["hra-desktop", "hra-harness"], alternative: "Many providers and models, including OpenAI-compatible options.", alternativeSourceIds: ["providers"] },
      { label: "Account coordination", hra: "Separate authorized Codex identities are first-class routing inputs.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Provider authentication is documented; HRA-style multi-Codex identity scheduling is not the product focus.", alternativeSourceIds: ["providers"] },
      { label: "Best fit", hra: "Codex-specific orchestration, continuity, and recovery.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "An open, configurable coding-agent runtime with broad provider choice.", alternativeSourceIds: ["intro"] },
    ],
  },
  {
    slug: "paseo",
    name: "Paseo",
    shortName: "Paseo",
    description:
      "Compare Paseo's cross-provider, cross-device agent orchestration with HRA's deeper Codex-specific account and recovery model.",
    commonGround:
      "Both go beyond a chat grid: they manage worktrees, sessions, follow-ups, model choices, subagents, and long-running work from a control surface.",
    meaningfulDifference:
      "Paseo emphasizes provider breadth and access across desktop, web, mobile, and CLI. HRA is narrower: it treats Codex account custody, work-class routing, durable parent-child work, and recovery receipts as one Codex-specific system.",
    alternativeFit:
      "Choose Paseo for cross-provider orchestration, multiple provider profiles, remote access, mobile supervision, schedules, and a mature workspace CLI.",
    hraFit:
      "Choose HRA when all workers are Codex and the hard problem is exact account isolation, durable delegation, continuity, and fail-closed recovery rather than provider breadth.",
    sources: [
      ...hraComparisonSources,
      { id: "orchestration", label: "Paseo documentation: Orchestration", url: "https://paseo.sh/docs/orchestration" },
      { id: "providers", label: "Paseo documentation: Custom providers", url: "https://paseo.sh/docs/custom-providers" },
      { id: "worktrees", label: "Paseo documentation: Git worktrees", url: "https://paseo.sh/docs/worktrees" },
      { id: "repo", label: "Paseo source", url: "https://github.com/getpaseo/paseo" },
    ],
    hraSummarySourceIds,
    alternativeSummarySourceIds: ["orchestration", "providers", "worktrees", "repo"],
    rows: [
      { label: "Core job", hra: "A Codex metaharness with durable task and effect custody.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "A cross-provider agent orchestrator available across several surfaces.", alternativeSourceIds: ["orchestration", "repo"] },
      { label: "Provider scope", hra: "Codex only by design.", hraSourceIds: ["hra-desktop", "hra-harness"], alternative: "First-class and custom providers, including multiple profiles for one provider.", alternativeSourceIds: ["providers"] },
      { label: "Parallel work", hra: "Managed worktrees plus a persistent parent-child task graph.", hraSourceIds: ["hra-readme", "hra-security"], alternative: "Worktree workspaces and orchestrated child sessions.", alternativeSourceIds: ["worktrees", "orchestration"] },
      { label: "Devices", hra: "Native execution on an Apple Silicon Mac with a bounded hosted view.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Desktop, web, mobile, and CLI around a daemon.", alternativeSourceIds: ["repo"] },
      { label: "Recovery emphasis", hra: "Provider generations, effect receipts, ambiguity containment, and exact account leases.", hraSourceIds: ["hra-harness", "hra-security"], alternative: "Daemon-owned sessions, heartbeats, follow-ups, and orchestration lifecycle.", alternativeSourceIds: ["orchestration"] },
      { label: "Best fit", hra: "A deep Codex-only control system.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "A broad agent command center across providers and devices.", alternativeSourceIds: ["repo"] },
    ],
  },
  {
    slug: "conductor",
    name: "Conductor",
    shortName: "Conductor",
    description:
      "Compare Conductor's polished multi-agent workspaces and review flow with HRA's Codex-specific durable task system.",
    commonGround:
      "Both help a developer run several coding-agent tasks without colliding in one checkout and bring the changes back through review.",
    meaningfulDifference:
      "Conductor makes each task a polished workspace with its own branch, files, terminal, diff, checks, and pull-request path across several harnesses. HRA focuses on the coordination semantics inside one Codex workload: account custody, recursive delegation, continuity, and recovery evidence.",
    alternativeFit:
      "Choose Conductor for a mature Mac workspace, diff, checks, and pull-request workflow across Codex, Claude Code, Cursor, and OpenCode.",
    hraFit:
      "Choose HRA when work must form one persistent Codex task graph and recover across multiple authorized Codex identities, not merely land as parallel branches.",
    sources: [
      ...hraComparisonSources,
      { id: "intro", label: "Conductor documentation: Introduction", url: "https://www.conductor.build/docs" },
      { id: "parallel", label: "Conductor documentation: Parallel agents", url: "https://www.conductor.build/docs/concepts/parallel-agents" },
      { id: "codex", label: "Conductor documentation: Multiple Codex sessions", url: "https://www.conductor.build/docs/guides/parallel-agents/run-multiple-codex-sessions" },
    ],
    hraSummarySourceIds,
    alternativeSummarySourceIds: ["intro", "parallel", "codex"],
    rows: [
      { label: "Core job", hra: "Coordinate one durable Codex workload.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Create isolated agent workspaces and carry each through review and merge.", alternativeSourceIds: ["intro"] },
      { label: "Harnesses", hra: "Codex only by design.", hraSourceIds: ["hra-desktop", "hra-harness"], alternative: "Codex, Claude Code, Cursor, and OpenCode.", alternativeSourceIds: ["intro"] },
      { label: "Isolation", hra: "Managed worktrees owned by durable actors and task claims.", hraSourceIds: ["hra-harness", "hra-security"], alternative: "A workspace, branch, files, terminal, diff, and review path per independent task.", alternativeSourceIds: ["parallel", "codex"] },
      { label: "Coordination", hra: "Parent-child tasks, dependencies, inherited authority, submissions, and review.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Parallel workspaces or multiple sessions inside one shared workspace.", alternativeSourceIds: ["parallel"] },
      { label: "Account identities", hra: "Multiple authorized Codex identities are routed separately.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Uses Codex access in its workspaces; multi-identity Codex routing is not its documented center.", alternativeSourceIds: ["codex"] },
      { label: "Best fit", hra: "Codex-specific durable orchestration.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Polished workspace isolation and change review across popular coding agents.", alternativeSourceIds: ["intro"] },
    ],
  },
  {
    slug: "superset",
    name: "Superset",
    shortName: "Superset",
    description:
      "Compare Superset's programmable multi-agent workspaces with HRA's Codex-specific account routing and recovery receipts.",
    commonGround:
      "Both organize parallel agent work around isolated Git worktrees, local hosts, durable task state, and human review.",
    meaningfulDifference:
      "Superset is a broad source-available coding platform exposed as a desktop IDE, CLI, SDK, and MCP server. HRA is a smaller Codex-specific control system that makes account generations, actor lineage, model intent, and recovery evidence part of the durable record.",
    alternativeFit:
      "Choose Superset when you want a programmable workspace platform, broad agent support, automations, and control through desktop, CLI, SDK, or MCP.",
    hraFit:
      "Choose HRA when the system can be Codex-only and the primary need is coordinated authorized accounts, recursive task ownership, continuity, and fail-closed recovery.",
    sources: [
      ...hraComparisonSources,
      { id: "overview", label: "Superset documentation: Overview", url: "https://docs.superset.sh/overview" },
      { id: "agents", label: "Superset documentation: AI agents", url: "https://docs.superset.sh/agent-integration" },
      { id: "cli", label: "Superset documentation: CLI reference", url: "https://docs.superset.sh/cli/cli-reference" },
      { id: "mcp", label: "Superset documentation: MCP server", url: "https://docs.superset.sh/mcp-server" },
    ],
    hraSummarySourceIds,
    alternativeSummarySourceIds: ["overview", "agents", "cli", "mcp"],
    rows: [
      { label: "Core job", hra: "A durable metaharness around Codex.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "A source-available AI coding platform for tasks, workspaces, agents, and automations.", alternativeSourceIds: ["overview", "mcp"] },
      { label: "Interfaces", hra: "Native Mac host plus a bounded web control plane.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Desktop IDE, CLI, SDK, and MCP server.", alternativeSourceIds: ["overview", "cli", "mcp"] },
      { label: "Agent scope", hra: "Codex actors with fixed work classes and inherited authority.", hraSourceIds: ["hra-harness", "hra-routing-policy"], alternative: "Claude Code, Cursor, Codex, and other terminal agents in workspaces.", alternativeSourceIds: ["agents"] },
      { label: "Automation", hra: "Recursive delegation inside a durable Codex task graph.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Tasks, automations, workspace APIs, and programmatic agent creation.", alternativeSourceIds: ["cli", "mcp"] },
      { label: "Account custody", hra: "Separate authorized Codex identities and generations are part of admission and recovery.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Host and workspace orchestration; HRA-style multi-Codex identity custody is not its documented center.", alternativeSourceIds: ["overview"] },
      { label: "Best fit", hra: "Codex-specific correctness and recovery depth.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "A broad programmable platform for agent workspaces and operations.", alternativeSourceIds: ["overview"] },
    ],
  },
  {
    slug: "openchamber",
    name: "OpenChamber",
    shortName: "OpenChamber",
    description:
      "Compare OpenChamber's visual OpenCode environment across devices with HRA's native Codex coordination and recovery model.",
    commonGround:
      "Both provide a visual place to start, supervise, and revisit agent work while the actual coding process runs on a developer-controlled machine.",
    meaningfulDifference:
      "OpenChamber is an interface and workflow layer around OpenCode, with broad desktop, browser, remote, worktree, goal, and schedule surfaces. HRA uses Codex directly and makes durable account identity, delegation, model intent, and effect reconciliation its center.",
    alternativeFit:
      "Choose OpenChamber for a visual OpenCode workflow across macOS, Windows, Linux, browser, and mobile beta, including worktrees and scheduled tasks.",
    hraFit:
      "Choose HRA when your runtime is Codex and you need several authorized Codex accounts to participate in one durable, recoverable task graph.",
    sources: [
      ...hraComparisonSources,
      { id: "home", label: "OpenChamber homepage", url: "https://openchamber.dev/" },
      { id: "repo", label: "OpenChamber source", url: "https://github.com/openchamber/openchamber" },
      { id: "worktrees", label: "OpenChamber documentation: Worktrees", url: "https://docs.openchamber.dev/worktrees/" },
      { id: "schedules", label: "OpenChamber documentation: Scheduled tasks", url: "https://docs.openchamber.dev/scheduled-tasks/" },
    ],
    hraSummarySourceIds,
    alternativeSummarySourceIds: ["home", "repo", "worktrees", "schedules"],
    rows: [
      { label: "Core job", hra: "Coordinate a Codex workload with durable authority.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Give OpenCode a visual, multi-device working environment.", alternativeSourceIds: ["home", "repo"] },
      { label: "Runtime", hra: "OpenAI Codex app-server.", hraSourceIds: ["hra-desktop", "hra-harness"], alternative: "OpenCode and its provider/agent model.", alternativeSourceIds: ["home"] },
      { label: "Platforms", hra: "Apple Silicon Mac execution with a bounded hosted view.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "macOS, Windows, Linux, browser/PWA, and native mobile beta.", alternativeSourceIds: ["home", "repo"] },
      { label: "Work structure", hra: "Persistent roots, children, dependencies, leases, submissions, and review.", hraSourceIds: ["hra-readme", "hra-security"], alternative: "Sessions, worktrees, goals, GitHub flows, and scheduled tasks.", alternativeSourceIds: ["worktrees", "schedules", "repo"] },
      { label: "Account coordination", hra: "Several authorized Codex identities with local isolation.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Inherits OpenCode provider authentication; multi-Codex identity routing is not its documented focus.", alternativeSourceIds: ["home"] },
      { label: "Best fit", hra: "Deep Codex-only orchestration and recovery.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "A cross-platform visual environment for OpenCode sessions.", alternativeSourceIds: ["home"] },
    ],
  },
  {
    slug: "happy-coder",
    name: "Happy Coder",
    shortName: "Happy Coder",
    description:
      "Compare Happy Coder's remote mobile and web control for coding sessions with HRA's local Codex workload orchestration.",
    commonGround:
      "Both keep an agent process on a developer-controlled machine while giving a human another surface to see status and continue the work.",
    meaningfulDifference:
      "Happy Coder is centered on reaching and steering coding sessions from a phone or browser. HRA is centered on decomposing one Codex workload, selecting an authorized local identity, preserving task ownership, and reconciling interrupted effects.",
    alternativeFit:
      "Choose Happy Coder when the main problem is securely checking, messaging, or continuing existing Codex and Claude Code sessions while away from your keyboard.",
    hraFit:
      "Choose HRA when the main problem is the coordination itself: parent-child work, account isolation, routing, review, and durable recovery across a Codex project.",
    sources: [
      ...hraComparisonSources,
      { id: "repo", label: "Happy Coder source and overview", url: "https://github.com/slopus/happy" },
      { id: "agent", label: "Happy Agent documentation", url: "https://github.com/slopus/happy/blob/main/packages/happy-agent/README.md" },
      { id: "releases", label: "Happy Coder releases", url: "https://github.com/slopus/happy/releases" },
    ],
    hraSummarySourceIds,
    alternativeSummarySourceIds: ["repo", "agent", "releases"],
    rows: [
      { label: "Core job", hra: "Plan, route, review, and recover a coordinated Codex workload.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Reach local coding sessions from mobile and web surfaces.", alternativeSourceIds: ["repo"] },
      { label: "Agent scope", hra: "Codex only by design.", hraSourceIds: ["hra-desktop", "hra-harness"], alternative: "Codex and Claude Code are the documented core clients.", alternativeSourceIds: ["repo"] },
      { label: "Remote experience", hra: "A bounded summary/control-plane view; local authority stays on the Mac.", hraSourceIds: ["hra-readme", "hra-security"], alternative: "Remote session creation, status, messaging, and continuation are the product center.", alternativeSourceIds: ["repo", "agent"] },
      { label: "Delegation", hra: "Durable roots and bounded children with inherited authority and review.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Happy Agent can spawn, inspect, message, wait for, and stop sessions.", alternativeSourceIds: ["agent"] },
      { label: "Account routing", hra: "Authorized Codex identities are isolated and selected as part of local admission.", hraSourceIds: ["hra-desktop", "hra-security"], alternative: "Multiple Codex identity scheduling is not documented as the core workflow.", alternativeSourceIds: ["repo"] },
      { label: "Best fit", hra: "A recoverable Codex project operating system.", hraSourceIds: ["hra-readme", "hra-harness"], alternative: "Remote access to coding sessions from away from the development machine.", alternativeSourceIds: ["repo"] },
    ],
  },
] as const satisfies readonly HraComparison[];

export function comparisonForSlug(slug: string): HraComparison | undefined {
  return hraComparisons.find((comparison) => comparison.slug === slug);
}

export function hraSourcesForRow(
  comparison: HraComparison,
  row: ComparisonRow,
): readonly ComparisonSource[] {
  return sourcesForIds(comparison, row.hraSourceIds);
}

export function alternativeSourcesForRow(
  comparison: HraComparison,
  row: ComparisonRow,
): readonly ComparisonSource[] {
  return sourcesForIds(comparison, row.alternativeSourceIds);
}

export function summarySourceIds(
  comparison: HraComparison,
): readonly string[] {
  return [
    ...comparison.hraSummarySourceIds,
    ...comparison.alternativeSummarySourceIds,
  ];
}

export function sourcesForIds(
  comparison: HraComparison,
  sourceIds: readonly string[],
): readonly ComparisonSource[] {
  return sourceIds.map((sourceId) => {
    const source = comparison.sources.find((candidate) => candidate.id === sourceId);
    if (source === undefined) throw new Error(`Unknown source ${sourceId} for ${comparison.slug}`);
    return source;
  });
}

export function sourceNumber(
  comparison: HraComparison,
  source: ComparisonSource,
): number {
  const index = comparison.sources.findIndex((candidate) => candidate.id === source.id);
  if (index < 0) throw new Error(`Unknown source ${source.id} for ${comparison.slug}`);
  return index + 1;
}
