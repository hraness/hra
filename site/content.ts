import packageJson from "../package.json";
import { CLAUDE_PIN } from "../src/claude/pin";
import { buildHraGlobalInstallCommand } from "../src/install-preflight";

export type EndpointAvailability = "beta-not-yet-live" | "live" | "release-ready";

export interface PublicEndpoints {
  readonly betaTag: EndpointAvailability;
  readonly githubRepository: EndpointAvailability;
  readonly hostedSync: EndpointAvailability;
  readonly website: EndpointAvailability;
}

export type InlineContent =
  | { readonly kind: "code"; readonly value: string }
  | { readonly kind: "link"; readonly href: string; readonly label: string }
  | { readonly kind: "text"; readonly value: string };

export type ContentBlock =
  | { readonly kind: "commands"; readonly commands: readonly string[] }
  | { readonly kind: "list"; readonly items: readonly (readonly InlineContent[])[] }
  | { readonly kind: "notice"; readonly label: string; readonly content: readonly InlineContent[] }
  | { readonly kind: "paragraph"; readonly content: readonly InlineContent[] }
  | { readonly kind: "subheading"; readonly text: string };

export interface ContentSection {
  readonly blocks: readonly ContentBlock[];
  readonly heading: string;
  readonly id: string;
}

export interface HeroFact {
  readonly detail: string;
  readonly label: string;
  readonly value: string;
}

export interface HeroStep {
  readonly command: string;
  readonly detail: string;
  readonly label: string;
}

export interface HeroPillar {
  readonly label: string;
  readonly summary: string;
}

export interface HeroContent {
  readonly boundary: string;
  /** A request a reader could make once HRA is installed. */
  readonly example: string;
  readonly eyebrow: string;
  readonly facts: readonly HeroFact[];
  readonly heading: string;
  /** Three short statements shown under the hero. */
  readonly pillars: readonly HeroPillar[];
  readonly primaryAction: {
    readonly href: string;
    readonly label: string;
  };
  readonly proofLabel: string;
  readonly secondaryAction: {
    readonly href: string;
    readonly label: string;
  };
  readonly steps: readonly HeroStep[];
  readonly summary: string;
}

export interface Badge {
  readonly alt: string;
  readonly href: string;
  readonly image: string;
}

export interface SocialCard {
  /** Rendered card text; also the `og:image:alt` value. */
  readonly alt: string;
  readonly height: number;
  readonly path: string;
  readonly width: number;
}

export type HostedSignup = "invite_only" | "open";

export interface SiteQuestion {
  readonly answer: readonly InlineContent[];
  readonly question: string;
}

export interface SiteTrustItem {
  readonly detail: string;
  readonly label: string;
}

export interface SiteMaker {
  readonly bio: readonly InlineContent[];
  readonly heading: string;
  readonly links: readonly { readonly href: string; readonly label: string }[];
}

export interface PublicContent {
  /** README trust-signal badges, rendered on one line under the H1. */
  readonly badges: readonly Badge[];
  /** Qualified source-and-release positioning for package metadata, discovery, and llms.txt. */
  readonly description: string;
  readonly doctorCommand: string;
  readonly endpoints: PublicEndpoints;
  readonly installCommand: string;
  readonly initCommand: string;
  readonly introduction: readonly ContentBlock[];
  readonly hero: HeroContent;
  /** Whether hosted sign-up needs an invitation. Drives every beta claim. */
  readonly hostedSignup: HostedSignup;
  /** The person behind HRA, in plain words, for the website only. */
  readonly maker: SiteMaker;
  /** Reader objections answered on the website before the reference. */
  readonly questions: readonly SiteQuestion[];
  /** Local-by-design boundaries stated as reassurance on the website. */
  readonly trust: readonly SiteTrustItem[];
  readonly links: {
    readonly contributing: string;
    readonly documentation: string;
    readonly github: string;
    readonly hraness: string;
    readonly privateSecurityReport: string;
    readonly privacy: string;
    readonly security: string;
  };
  readonly maintainer: {
    readonly name: string;
    readonly url: string;
  };
  readonly productName: string;
  /** Provider order stated the same way everywhere. */
  readonly providerRoadmap: string;
  /** The exact immutable CLI release installed by the public command. */
  readonly releaseVersion: string;
  readonly sections: readonly ContentSection[];
  readonly siteUrl: string;
  readonly socialCard: SocialCard;
  /** One-line release status shown directly under the thesis. */
  readonly statusLine: string;
  /** Category label used in the page title, hero eyebrow, and social card. */
  readonly tagline: string;
  /** The README thesis: what HRA does, stated once, before any command. */
  readonly thesis: string;
}

const text = (value: string): InlineContent => ({ kind: "text", value });
const code = (value: string): InlineContent => ({ kind: "code", value });
const link = (label: string, href: string): InlineContent => ({ kind: "link", label, href });
const paragraph = (...content: readonly InlineContent[]): ContentBlock => ({
  kind: "paragraph",
  content,
});
const list = (...items: readonly (readonly InlineContent[])[]): ContentBlock => ({
  kind: "list",
  items,
});

/**
 * The one place the public beta claim is decided. It must match the deployed
 * `serviceControl.newIdentityAdmissions` value: say "invite-only beta" while
 * the authority refuses an uninvited identity, and "open beta" only once it
 * admits one. Every surface below derives its wording from this constant.
 */
const hostedSignup: HostedSignup = "open";

/** The exact public wording for each hosted sign-up state. */
export const hostedSignupCopy = (signup: HostedSignup): Readonly<{
  admissionClaim: string;
  betaLabel: string;
}> => signup === "open"
  ? {
      admissionClaim: "Anyone can create an identity with an email address and a one-time code; an invitation is optional.",
      betaLabel: "open beta",
    }
  : {
      admissionClaim: "The first identity and device were admitted on the production deployment on 2026-09-03; new identities need an invitation from an existing member.",
      betaLabel: "invite-only beta",
    };

const {
  admissionClaim: hostedAdmissionClaim,
  betaLabel: hostedBetaLabel,
} = hostedSignupCopy(hostedSignup);

const links = {
  contributing: "https://github.com/hraness/hra/blob/main/CONTRIBUTING.md",
  documentation: "https://github.com/hraness/hra#command-reference",
  github: "https://github.com/hraness/hra",
  hraness: "https://hraness.com/",
  privateSecurityReport: "https://github.com/hraness/hra/security/advisories/new",
  privacy: "https://github.com/hraness/hra/blob/main/PRIVACY.md",
  security: "https://github.com/hraness/hra/blob/main/SECURITY.md",
} as const;

const privacyBlocks: readonly ContentBlock[] = [
  paragraph(
    text("Cloud sync is optional. Local provider profiles, Codex credentials, Claude Code configuration and credentials, and local execution continue to work without it. HRA identity is separate from every provider account."),
  ),
  { kind: "subheading", text: "Encrypted before upload" },
  list(
    [text("User messages and final assistant display text.")],
    [text("Session names, notes, queued messages, and steering input.")],
    [text("Codex account labels and observed provider email and plan metadata when cloud sync is enabled. Claude Code account identity and usage are not projected. HRA validates one bounded Claude Code authentication-status response transiently, reduces it to signedIn, and never retains, returns, projects, or uploads the identity or usage fields; it never opens or parses a Claude credential file.")],
    [text("Turn timing, observed model and tier, and provider usage summaries.")],
    [text("Bounded observed file and Git metadata, without unbounded filesystem paths.")],
    [text("Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.")],
    [text("Remote-command input and results that fit the closed command protocol.")],
    [text("For an explicitly requested Codex web login, the provider HTTPS verification URL and separate one-time user code. HRA encrypts both to the account key before upload, lets only the requesting browser read them once, and deletes the hosted handoff on that read or after five minutes.")],
  ),
  { kind: "subheading", text: "Never uploaded" },
  list(
    [text("Codex or Claude Code credentials, provider profile or configuration files, plugin credentials, OAuth access or refresh tokens, authorization codes, PKCE verifiers, provider cookies, or the private device code.")],
    [text("Raw Codex app-server or Claude Code stream requests or responses.")],
    [text("Raw reasoning, hidden chain of thought, or approval secrets.")],
    [text("Provider-internal login and request IDs, permission values, MCP field contracts, protected answers, or response digests.")],
    [text("Environment variables, arbitrary command output, or unbounded filesystem paths.")],
  ),
  paragraph(
    text("The sync service necessarily sees the verified HRA email address, device identifiers, record types, revisions, ciphertext sizes, timestamps, and execution-lease or command lifecycle metadata. It cannot decrypt session content without a paired device key. Email access alone does not recover that key."),
  ),
  paragraph(
    text("A browser device holds the account key and decrypted projection only in that tab's memory by default. HRA does not programmatically write decrypted provider or session text to the clipboard, but browser extensions, accessibility APIs, screenshots, and explicit user selection can observe rendered text."),
  ),
  paragraph(
    text("HRA uses Convex to authenticate the HRA identity and store server-visible metadata plus encrypted projections. Convex receives the verified email address and the service metadata described above, but not the keys required to decrypt session content."),
  ),
  paragraph(
    text("HRA uses Resend to deliver verification email. Resend receives the recipient email address, sender identity, one-time verification code and message content, and ordinary delivery metadata. It receives no provider credentials or encrypted session projection."),
  ),
  paragraph(
    text("HRA uses anonymous, cookieless PostHog analytics on the public hra.sh pages to count page views and page leaves and measure selected Web Vitals. Collection runs only on the canonical production host, honors Do Not Track, keeps its visitor identifier in memory, and disables person profiles, autocapture, heatmaps, feature flags, surveys, conversations, and session recording. PostHog receives the canonical route, bounded referral classification, browser performance measurements, a cookieless visitor identifier, and ordinary request metadata such as IP address, user agent, and time. HRA sends no form values, account identity, provider or session data, URL query, or fragment. Vercel serves hra.sh, and GitHub hosts the source repository, releases, and release downloads; those providers receive ordinary request metadata when visited."),
  ),
  paragraph(
    text("Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked."),
  ),
  paragraph(
    text("Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion."),
  ),
  paragraph(
    text("Codex activity remains subject to OpenAI's service and privacy terms. Claude Code activity remains subject to Anthropic's service and privacy terms."),
  ),
  {
    kind: "notice",
    label: "Hosted sync status",
    content: [
      text(`The hosted sync endpoint is live as an ${hostedBetaLabel}. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. ${hostedAdmissionClaim}`),
    ],
  },
];

export const siteDocumentPaths: readonly string[] = [
  "/",
  "/privacy/",
];

export const publicReleaseState: "live" | "release-ready" | "staged" = "release-ready";

const betaInstallCommand = buildHraGlobalInstallCommand(
  "https://github.com/hraness/hra/releases/download/v0.6.0/hraness-hra-0.6.0.tgz",
);

const productName = "HRA";
const tagline = "Control plane for Codex and Claude Code";
const providerRoadmap = "Codex and Claude Code, side by side.";
const releaseVersion = "0.6.0";

/** Public runtime pins come from their authoritative source modules. */
export const publicPins = {
  bun: packageJson.engines.bun,
  claude: CLAUDE_PIN,
  codex: packageJson.dependencies["@openai/codex"],
} as const;

const shieldsLabel = (value: string): string =>
  encodeURIComponent(value.replaceAll("-", "--").replaceAll("_", "__"));
const staticBadge = (label: string, message: string, color: string): string =>
  `https://img.shields.io/badge/${shieldsLabel(label)}-${shieldsLabel(message)}-${color}`;

const badges: readonly Badge[] = [
  {
    alt: "npm version",
    href: "https://www.npmjs.com/package/@hraness/hra",
    image: "https://img.shields.io/npm/v/%40hraness%2Fhra",
  },
  {
    alt: "provenance: sigstore",
    href: "https://www.npmjs.com/package/@hraness/hra#provenance",
    image: staticBadge("provenance", "sigstore", "2e7d32"),
  },
  {
    alt: "CI",
    href: "https://github.com/hraness/hra/actions/workflows/ci.yml",
    image: "https://img.shields.io/github/actions/workflow/status/hraness/hra/ci.yml?branch=main&label=CI",
  },
  {
    alt: "license: MIT",
    href: "https://github.com/hraness/hra/blob/main/LICENSE",
    image: "https://img.shields.io/npm/l/%40hraness%2Fhra",
  },
  {
    alt: `Bun ${publicPins.bun}`,
    href: "https://bun.sh",
    image: staticBadge("Bun", publicPins.bun, "14151a"),
  },
  {
    alt: `runtime: Codex ${publicPins.codex}`,
    href: `https://www.npmjs.com/package/@openai/codex/v/${publicPins.codex}`,
    image: staticBadge("runtime", `Codex ${publicPins.codex}`, "0b5fa5"),
  },
  {
    alt: `runtime: Claude Code ${publicPins.claude}`,
    href: "https://github.com/hraness/hra/blob/main/docs/providers/claude.md",
    image: staticBadge("runtime", `Claude Code ${publicPins.claude}`, "6f42c1"),
  },
];

export const publicContent: PublicContent = {
  productName,
  tagline,
  providerRoadmap,
  releaseVersion,
  thesis: `${productName} runs Codex and Claude Code sessions side by side, keeps them alive in a local daemon, and gives humans and AI agents the same commands to drive them.`,
  description: `${tagline} in current source; v${releaseVersion} is release-ready. Run provider sessions side by side through one durable CLI.`,
  statusLine: `Status: public beta. The local CLI v${releaseVersion} is release-ready: Codex runs on macOS and Linux, Claude Code on Linux; hosted sync is live as an ${hostedBetaLabel}.`,
  badges,
  maintainer: {
    name: "Hraness",
    url: links.hraness,
  },
  socialCard: {
    alt: `${productName} · Codex + Claude Code · v${releaseVersion} release-ready · hra.sh`,
    height: 630,
    path: "/social-card.png",
    width: 1200,
  },
  siteUrl: "https://hra.sh",
  installCommand: betaInstallCommand,
  initCommand: "hra init --yes",
  doctorCommand: "hra doctor --offline",
  endpoints: {
    betaTag: "release-ready",
    githubRepository: "live",
    hostedSync: "live",
    website: "live",
  },
  hostedSignup,
  links,
  hero: {
    eyebrow: tagline,
    heading: "One terminal for every Codex and Claude Code session",
    summary: "HRA keeps sessions alive behind a local daemon, isolates each account, and lets you or your agent direct any of them from a shell or JSON. Sync between machines is optional and encrypted.",
    example: "Ask your agent to start a Codex session on your work account, then hand the next turn to Claude Code without losing the conversation.",
    boundary: `Codex on macOS and Linux · Claude Code on Linux · local v${releaseVersion} release-ready · hosted sync live (${hostedBetaLabel})`,
    primaryAction: {
      href: "#install-command",
      label: "Install HRA",
    },
    secondaryAction: {
      href: "#how-it-works",
      label: "See how it works",
    },
    pillars: [
      {
        label: "Isolated accounts",
        summary: "Each provider profile keeps its own credentials and configuration. Nothing is shared between them.",
      },
      {
        label: "Durable sessions",
        summary: "A local daemon keeps every session alive after the terminal that started it closes.",
      },
      {
        label: "One interface for people and agents",
        summary: "The same account and session objects answer to a shell and to versioned JSON.",
      },
    ],
    proofLabel: "One request, one account, one session.",
    steps: [
      {
        label: "Start",
        command: "hra session start personal --provider codex --preset high --json",
        detail: "Create a Codex session under the account profile you name.",
      },
      {
        label: "Inspect",
        command: "hra session status <session-id> --json",
        detail: "Read the session and the cursor where its event stream continues.",
      },
      {
        label: "Switch",
        command: "hra session switch <session-id> --provider claude --preset fable-max",
        detail: "Move the next turns to your signed-in Claude Code profile. The HRA conversation stays intact.",
      },
      {
        label: "Direct",
        command: "hra session send <session-id> -- \"Review this project.\"",
        detail: "Send the next request to that session and provider.",
      },
    ],
    facts: [
      {
        label: "Accounts",
        value: "Isolated profiles",
        detail: "Codex uses its own CODEX_HOME per profile; Claude Code uses its own CLAUDE_CONFIG_DIR.",
      },
      {
        label: "Sessions",
        value: "Live and durable",
        detail: "The local daemon keeps running after a terminal exits.",
      },
      {
        label: "Interfaces",
        value: "Shell and JSON",
        detail: "People and agents address the same account and session objects.",
      },
      {
        label: "Sync",
        value: "Optional, encrypted",
        detail: "Everything local works without the cloud service.",
      },
    ],
  },
  trust: [
    {
      label: "Your provider credentials stay with the provider",
      detail: "HRA launches Codex and Claude Code with the sign-in you already have. It never reads, copies, or forwards the Claude credential, and Codex state stays inside its isolated profile.",
    },
    {
      label: "Local by default",
      detail: "Accounts, sessions, and execution live on your machine. Cloud sync is optional, encrypted before upload, and separate from every provider account.",
    },
    {
      label: "Nothing decrypts server-side",
      detail: "The sync service sees your verified email, device identifiers, and ciphertext sizes. It cannot read session content without a paired device key.",
    },
    {
      label: "Analytics you can audit",
      detail: "hra.sh counts page views anonymously, without cookies, only on the production host, and honors Do Not Track. The privacy page lists every field.",
    },
  ],
  questions: [
    {
      question: "Does HRA need an account?",
      answer: [text("No. Install the CLI, add a Codex profile or sign into Claude Code inside its isolated directory, and start a session. An HRA cloud identity is only needed for optional sync between machines.")],
    },
    {
      question: "What does the release candidate include?",
      answer: [text(`The v${releaseVersion} local CLI release candidate runs Codex on macOS and Linux and Claude Code on Linux. It becomes public only after immutable GitHub and npm release admission. Hosted sync is live as an ${hostedBetaLabel}.`)],
    },
    {
      question: "Does HRA use my API keys or provider subscription?",
      answer: [text("HRA does not broker model access. Each provider CLI keeps using its own account, billing, and terms. HRA adds isolation, durability, and one command surface on top.")],
    },
    {
      question: "How do agents drive it?",
      answer: [text("Every command that a person runs in the shell has a JSON form. An agent starts a session, reads its status cursor, sends requests, and follows the event stream as a long-running subprocess. The reference below lists the exact commands and protected interaction paths.")],
    },
    {
      question: "What if the terminal closes?",
      answer: [text("The local daemon keeps the session alive. Reopen the shell, select the account and session, and continue. Claude Code sessions cannot be resumed after the daemon that started them exits.")],
    },
    {
      question: "Which platforms are supported?",
      answer: [text("macOS and Linux with Bun 1.3.14. Supported ChatGPT desktop account switching is macOS-only.")],
    },
  ],
  maker: {
    heading: "Built by Ben Guo",
    bio: [
      text("HRA is built by Ben Guo, a musician and builder, formerly a founder and engineering leader at companies including Venmo and Stripe, who now builds his software factory from Puerto Rico. He runs more than a dozen Codex subscriptions at once and built HRA to keep every session alive, isolated, and reachable from the same terminal."),
    ],
    links: [
      { href: links.hraness, label: "hraness.com" },
      { href: "https://x.com/hraness", label: "@hraness" },
      { href: links.github, label: "GitHub" },
    ],
  },
  introduction: [
    {
      kind: "notice",
      label: `Immutable local CLI release candidate; hosted sync live as an ${hostedBetaLabel}`,
      content: [
        text("The exact install command below works once GitHub exposes the immutable "),
        code(`v${releaseVersion}`),
        text(" GitHub Release and its verified archive. The website and optional hosted sync are live; the candidate becomes public only after exact admission."),
      ],
    },
    paragraph(
      text("HRA is one Bun CLI plus a local daemon. It isolates Codex and Claude Code profiles, gives both providers one compact session interface, and optionally syncs encrypted provider-neutral projections and commands across your enrolled machines."),
    ),
    paragraph(
      text("HRA is short for harness: the control plane that keeps Codex and Claude Code sessions working together, and "),
      link("hraness.com", links.hraness),
      text(" explains the parent brand. The Hraness organization maintains HRA and publishes it under the MIT license."),
    ),
    paragraph(
      link("GitHub", links.github),
      text(" · "),
      link("Documentation", links.documentation),
      text(" · "),
      link("Security", links.security),
      text(" · "),
      link("Privacy", links.privacy),
    ),
  ],
  sections: [
    {
      id: "install-and-update",
      heading: "Install and update",
      blocks: [
        paragraph(
          text("HRA requires Bun 1.3.14 plus curl with HTTPS and TLS 1.2 support. The CLI and local daemon support macOS and Linux. Codex effects run on both platforms; Claude Code effects run on Linux only. HRA refuses new Claude Code effects on macOS pending authenticated isolated-Keychain and detached-read acceptance. Supported ChatGPT desktop account switching is macOS-only. Native protected-input control loads only when a terminal prompt needs it and supports the standard macOS, glibc, and x64 or arm64 musl library names. Install one reviewed immutable tag, then verify the binary before initialization:"),
        ),
        {
          kind: "commands",
          commands: [
            "bun --version",
            betaInstallCommand,
            "hra --version",
            "hra doctor --offline",
          ],
        },
        paragraph(
          text("The single install command streams the exact v0.6.0 preflight from HRA's protected source tag and passes it the exact release archive URL. The preflight requires GitHub repository ID 1343008607, a published immutable v0.6.0 release, and one uploaded archive whose byte length and SHA-256 match GitHub's immutable release metadata. It creates a fresh random private staging root, downloads the archive into a private file there, and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted HRA package path and SHA-256 while measuring the completion receipt. Local archives and official archives use separate full-digest version namespaces, so a local package cannot populate or replace the official cache entry. HRA then verifies the tagged preflight and normalizer, exact package identity, zero-lifecycle manifest, CLI SHA-256, and complete staged tree under protected descriptor and ACL custody. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the release archive does not claim to contain that dependency closure. The prior verified command remains active throughout staging. Publication atomically replaces only the $BUN_INSTALL/bin/hra symlink after every check succeeds and fsyncs its directory. If installation is interrupted, the next invocation recovers or removes only the proven private stage. Existing trustedDependencies remain unchanged."),
        ),
        paragraph(
          text("Before replacing the installed binary, stop the persistent daemon and confirm that its old process has released authority. The command below performs a verified repair installation of v0.6.0. For a future update, replace the tagged preflight and release archive references together with the exact reviewed release version, verify it, then restart explicitly. Do not install a moving branch for a release machine:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra daemon stop",
            "hra daemon status --json",
            betaInstallCommand,
            "hra --version",
            "hra doctor --offline",
            "hra daemon start",
          ],
        },
        { kind: "subheading", text: "Optional full local-data removal" },
        paragraph(
          text("Full local-data removal is a separate destructive operation. While HRA remains installed, complete "),
          code("hra auth delete --acknowledge-erasure"),
          text(" if "),
          code("hra auth status"),
          text(" says you are signed in, then wait for "),
          code("hra auth status"),
          text(" to report terminal deletion. Run "),
          code("hra account list"),
          text(", then run "),
          code("hra account logout <profile>"),
          text(" for every Codex profile. HRA does not sign Claude Code out; use Claude Code's own authentication flow inside every isolated "),
          code("CLAUDE_CONFIG_DIR"),
          text(" whose credential should be removed. Stop the daemon, require a successful "),
          code("hra daemon status --json"),
          text(" result whose "),
          code("data.running"),
          text(" is "),
          code("false"),
          text(" before touching local data."),
        ),
        {
          kind: "commands",
          commands: [
            "hra auth delete --acknowledge-erasure",
            "hra auth status",
            "hra account list",
            "hra account logout <profile>",
            "hra daemon stop",
            "hra daemon status --json",
          ],
        },
        {
          kind: "notice",
          label: "Permanent local-data loss",
          content: [
            text("HRA deliberately has no recursive local-delete command. The exact state directory is "),
            code("$HOME/Library/Application Support/HRA Control Plane v1"),
            text(" on macOS and "),
            code("$HOME/.local/state/hra-control-plane-v1"),
            text(" on Linux. After every prerequisite above, a human who explicitly accepts permanent loss of all local provider profiles, Codex credential stores, Claude Code configuration directories, sessions, ledgers, encryption keys, device credentials, and recovery evidence may move only the exact platform directory to Trash. Claude Code may also own credentials outside that directory, including provider-managed system credential storage; sign out through Claude Code before deletion. Do not move or remove the state directory's parent. Inspect the trashed directory before emptying Trash."),
          ],
        },
        paragraph(
          text("An agent must resolve the canonical exact state-directory path, present that path and the permanent-loss consequences to the user, and obtain explicit destructive approval before moving or removing it. An install, update, or daemon-stop request does not authorize local-data removal."),
        ),
      ],
    },
    {
      id: "first-account",
      heading: "First account",
      blocks: [
        {
          kind: "commands",
          commands: [
            "hra account add personal",
            "hra account login personal --provider codex --device-code",
            "hra account usage personal --refresh",
            "hra account usage-history personal --limit 50 --json",
          ],
        },
        paragraph(
          text("Account login is always a dedicated one-shot invocation, including while the persistent shell is running. For Codex, use "),
          code("hra account login personal --provider codex --device-code"),
          text(" in a foreground TTY for app-server's device-code path. That terminal displays the code and verification URL directly. An opted-in registered machine can also receive a versioned web request that always selects device-code mode; HRA accepts only the pinned Codex device URL and a separate closed code, encrypts them to the account key, and lets only the requesting browser read the handoff once before its five-minute hosted expiry. HRA keeps the resulting provider state inside that profile's isolated "),
          code("CODEX_HOME"),
          text(" without copying "),
          code("auth.json"),
          text("."),
        ),
        paragraph(
          text("On Linux, "),
          code("hra account login personal --provider claude"),
          text(" launches a realpath-resolved Claude Code executable only after its exact self-reported version matches HRA's pin, in the foreground inside that profile's isolated "),
          code("CLAUDE_CONFIG_DIR"),
          text(". Claude owns its prompts and browser handoff. HRA gives it the terminal, joins the exact child, and reports only whether Claude says it is signed in; HRA never opens or copies a Claude credential. Claude exposes no HRA device-code, handoff-file, or web-linking protocol. New Claude effects are refused on macOS pending authenticated isolated-Keychain and detached-read acceptance."),
        ),
        paragraph(
          text("For a Codex login, JSON and noninteractive callers must create an empty mode-0600 file under a canonical current-user-owned mode-0700 directory, then pass its absolute canonical path:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra account login personal --device-code --handoff-file /absolute/private/login.json --json",
          ],
        },
        paragraph(
          text("HRA opens and holds the parent and file, resolves the account selector to one exact local account ID, and dispatches login only for that authority. It validates the returned account, state, cancellation command, URL, and device-code shape, writes one versioned login document through the held descriptor, verifies it with fsync and readback, and closes both descriptors before returning only the path and cleanup disposition on stdout. The caller reads the file through its protected boundary and removes it after login. A same-key replay never claims or rewrites a handoff. While login is pending it reports that one-time instructions are unavailable; after completion or cancellation it reports the terminal account state."),
        ),
        paragraph(
          text("If the first pending-login handoff is lost or the daemon restarts before completion, "),
          code("hra account show personal --provider codex"),
          text(" reports the pending attempt. Then run "),
          code("hra account login-cancel personal --provider codex"),
          text(". A caller that retained the idempotency key may retry it without redispatching. A still-pending local replay cannot recover the one-time code or URL; a completed or canceled replay returns terminal signed-in or signed-out evidence instead of stale pending state. HRA cancels only that profile's exact current-generation provider login before allowing a fresh login. Verification URLs and user codes never enter local durable HRA state, logs, or ordinary command output. A protected handoff file may retain them for its local caller; the web path instead retains only an account-key-encrypted, one-read hosted result until consumption or five-minute expiry."),
        ),
        paragraph(
          text("If a Claude foreground parent or daemon fails after launch, "),
          code("hra account show personal --provider claude"),
          text(" retains the one-child fence even if Claude reports signed in. After confirming that original child has exited, use the exact attempt, generation, and idempotency key in the reported acknowledged "),
          code("hra account login-cancel"),
          text(" command to release only the local fence. That recovery does not stop Claude or read, change, or delete a credential."),
        ),
        paragraph(
          code("hra account usage"),
          text(" is Codex-only and keeps the latest snapshot and 1-, 5-, and 15-minute observed token velocity. "),
          code("hra account usage-history <profile>"),
          text(" reads the retained 24-hour local ledger in durable source order. Use UTC RFC3339 "),
          code("--from"),
          text(" and "),
          code("--through"),
          text(" bounds plus the returned opaque cursor for later pages; a cursor freezes that account and range and expires after five minutes. History rows contain only derived token observations or closed poll-failure codes; raw provider payloads are never returned."),
        ),
        paragraph(
          text("HRA automatically spends one available earned Codex rate-limit reset when a fresh read shows the exact seven-day Codex window at 99 percent used or higher. It records a private idempotency key before dispatch, retries only that key after an uncertain response, and rereads limits after every closed outcome. A successful redemption is latched to that weekly window, so a stale usage snapshot cannot spend another credit. Rate-limit notifications wake a coalesced authoritative read; the staggered 50-to-70-second poll remains the fallback. "),
          code("hra account usage"),
          text(" reports the most recent local reset attempt with its source weekly-window boundary and suppresses a prior identity's snapshot after an account change. Credit IDs, descriptions, private keys, and account fingerprints never enter that reset status or its cloud projection."),
        ),
        paragraph(
          text("HRA cloud identity is separate from every Codex or Claude Code account. Use the email-code flow below only after a hosted or self-managed Convex deployment has been configured."),
        ),
      ],
    },
    {
      id: "first-session",
      heading: "First session",
      blocks: [
        paragraph(
          text("Complete initialization and the first provider login before this walkthrough. Account login remains a dedicated one-shot command, and the session-start command returns the new session ID."),
        ),
        { kind: "subheading", text: "Human terminal" },
        paragraph(
          text("Create an idle session, open the persistent shell, select the account and exact returned session ID, then type a request as an ordinary line. HRA sends that line to the selected session and shows safe live updates. "),
          code("/exit"),
          text(" leaves the daemon running."),
        ),
        {
          kind: "commands",
          commands: [
            "hra session start personal --provider codex --preset high",
            "hra",
            "/account personal",
            "/session <session-id>",
            "Review this project and summarize its current state.",
          ],
        },
        { kind: "subheading", text: "Agent caller" },
        paragraph(
          text("Read "),
          code("data.session.id"),
          text(" from the start response. Before sending, call status and read "),
          code("data.eventStream.cursor"),
          text(" from its version-2 result. Start watch from that exact cursor so the atomic local snapshot and subsequent event stream are contiguous. Keep watch as a long-running subprocess, consume its two output streams independently, and use the exact ID instead of a mutable title in automation."),
        ),
        {
          kind: "commands",
          commands: [
            "hra session start personal --provider codex --preset high --json",
            "hra session status <session-id> --json",
            "hra session send <session-id> -- \"Review this project and summarize its current state.\"",
            "hra session watch <session-id> --cursor <status-cursor> --jsonl",
            "hra session interactions <session-id> --pending --json",
          ],
        },
        paragraph(
          text("If the event stream reports a blocking interaction, read its exact ID and revision, inspect the live authority through the protected path, and resolve only the interaction kind you received. Keep following while a separate one-shot invocation handles the approval, question, permission grant, or supported MCP form. The protected interaction commands and input documents are defined below."),
        ),
        { kind: "subheading", text: "Claude Code and provider switching" },
        paragraph(
          text("Start directly with Claude Code by selecting its provider and reviewed preset, or move an idle session between providers. A switch preserves HRA's provider-neutral conversation record but starts a fresh provider-native runtime; it refuses an active turn, an unsettled provider effect, an unsigned target profile, or a preset that belongs to the other provider. Claude Code sessions cannot be resumed after the daemon that started them exits."),
        ),
        {
          kind: "commands",
          commands: [
            "hra session start personal --provider claude --preset fable-max --json",
            "hra session switch <session-id> --provider claude --preset fable-max",
            "hra session export <session-id> --format json",
          ],
        },
        { kind: "subheading", text: "Scheduled work in the same conversation" },
        paragraph(
          text("Attach a recurring whole-minute interval to an existing session with "),
          code("hra session task"),
          text(". Each run returns to that exact HRA conversation. A task cannot independently retarget its account, provider, project, model, or execution environment; later explicit changes to the session apply to future runs. Missed intervals coalesce into one queued turn. Use the returned task ID and revision for later edits or deletion; HRA never creates a replacement provider conversation or writes a provider's private automation registry."),
        ),
        {
          kind: "commands",
          commands: [
            "hra session task create <session-id> --name daily-review --every-minutes 1440 -- \"Review the release queue.\"",
            "hra session task list <session-id>",
            "hra session task show <session-id> <task-id>",
            "hra session task edit <session-id> <task-id> --revision <revision> --pause",
            "hra session task edit <session-id> <task-id> --revision <revision> --resume",
            "hra session task delete <session-id> <task-id> --revision <revision>",
          ],
        },
      ],
    },
    {
      id: "agent-work-protocol",
      heading: "Agent work protocol",
      blocks: [
        {
          kind: "notice",
          label: "Local release boundary",
          content: [
            text("These commands are part of the immutable "),
            code(`v${releaseVersion}`),
            text(" local CLI release candidate and become installable through the exact command above once its GitHub Release exists. Hosted sync is not required for this local protocol."),
          ],
        },
        paragraph(
          text("The frozen source contract defines a narrow local coordination kernel for agents operating several already-existing provider sessions. It records six bounded objects: work, tasks, attempts, submissions, reviews, and signals. Codex and Claude Code still own their provider-native execution, turns, tools, context, and approvals. HRA does not add a second model loop or a generic executable workflow engine."),
        ),
        {
          kind: "commands",
          commands: [
            "hra work protocol [--operation <kind>|--type <name>|--topic <topic>]",
            "hra work apply --input-stdin",
            "hra work snapshot <work> [--actor <session>]",
            "hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]",
            "hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]",
            "hra work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>]",
            "hra work watch <work> [--cursor <cursor>]",
          ],
        },
        paragraph(
          text("The seven commands are agent-only. Non-streaming commands emit compact JSON without requiring "),
          code("--json"),
          text(". "),
          code("work watch"),
          text(" emits resumable JSON Lines. "),
          code("work apply"),
          text(" is the only mutation entry point. It reads one strict "),
          code("{protocol,version,requestId,operation}"),
          text(" request from nonterminal standard input or an explicit file descriptor. The nested operation carries its UUIDv7 "),
          code("idempotencyKey"),
          text("; success and failure echo the request ID, and work capabilities are never accepted as argv fields. Same-key replay preserves the durable decision, stable identities, and capabilities without adding a mutation, event, or revision, while mutable public records and the work revision are reprojected from current state. It is not a byte-identical response promise. A retained release tombstone is the exact stored-result exception. "),
          code("work protocol"),
          text(" is queryable by operation, type, or topic. It returns exact field contracts, value syntax, capability semantics, operation kinds, hard bounds, and the closed recovery and process-exit guidance for failures."),
        ),
        paragraph(
          text("Each task carries an exact account ID, project ID, preset, and Fast setting. HRA never chooses another subscription from quota, availability, usage, or incidental ordering. A provider limit blocks or fails that attempt. It does not rotate the task to another account. Explicit tasks on separate accounts may run in parallel."),
        ),
        paragraph(
          text("Readiness is derived from the open work state, time bounds, accepted dependency submissions, and absence of a live or ambiguous attempt. A final assistant message is not completion. The worker submits a bounded structured result and evidence; declared independent reviews and HRA-owned completion gates must accept the exact submission revision."),
        ),
        paragraph(
          text("Dispatch binds one already-existing exact actor session and always starts a new turn. HRA's task graph is the durable task queue; queue and steer are reserved for coordination signals. HRA commits the claim, monotonic fence, route, session binding, request digest, and prepared effect before the provider call. If the provider effect may have started but cannot be proved, the attempt becomes recovery-required. HRA does not redispatch, steal, or reroute it speculatively."),
        ),
        paragraph(
          text("Coordinator, member, and exact-attempt capabilities scope every mutation and never appear in snapshots, polls, or events. Poll action arrays have a separate signed, actor-bound continuation with a frozen projection time; a changed work stream invalidates it instead of returning stale authority."),
        ),
        paragraph(
          text("Signal delivery and recipient acknowledgement are separate facts. "),
          code("deliveryState"),
          text(" reports pending, accepted, failed, or unknown provider delivery. "),
          code("acknowledgedAt"),
          text(" records the recipient acknowledgement independently, including when delivery remains pending or unknown."),
        ),
        paragraph(
          text("Snapshots expose bounded recent work-level signals and an omitted count. With no history option, "),
          code("work task"),
          text(" returns task detail with active and latest attempt lineage, the latest full attempt report, the latest submission and its ordered reviews, and bounded recent task signals. Either "),
          code("--history-limit"),
          text(" or "),
          code("--history-cursor"),
          text(" selects a separate task-history page over the task's attempts, reports, submissions, reviews, and task signals; a cursor-only continuation defaults to 20 items. Each complete compact JSON response for snapshot, task detail, and task history, including its envelope and terminating newline, is capped at 512 KiB. Only recent or historical arrays are trimmed, and omitted or remaining counts and continuations make every reduction explicit."),
        ),
        paragraph(
          text("A signed task-history continuation freezes the work stream sequence and epoch, task membership high-water ordinal, task revision, projection time, and next offset. Append-only bounded public projection versions reconstruct every returned record as of that cut. Later mutations and later history memberships are excluded from every continued page, so pagination is coherent even while agents keep working."),
        ),
        paragraph(
          text("Each JSONL gap, event, or checkpoint frame, including its terminating newline and terminal-safe escaping, is capped at 512 KiB. A terminal stream failure is one compact JSON document on stderr capped at 64 KiB. The queryable protocol advertises both wire limits."),
        ),
        paragraph(
          text("Accepted submissions, reviews, evidence references, receipts, and completed tasks are durable prefixes. Later failure or cancellation preserves them. No SQLite writer transaction spans provider reasoning, provider I/O, artifact hashing, or Git inspection. This applies the durable-prefix lesson in "),
          link("Agent Swarms are a Distributed Systems Problem", "https://www.trychroma.com/engineering/transactions"),
          text(" without adopting generic page locking, wound-wait, or speculative replay."),
        ),
        paragraph(
          code("task.claimNext"),
          text(" records an exact idempotent empty result when no task is ready without appending an event or advancing the work revision. "),
          code("work.release"),
          text(" is the other stream-neutral mutation. It requires terminal work, the exact coordinator capability and revision, and "),
          code("acknowledgeDataLoss: true"),
          text(". Only an unresolved attempt dispatch blocks release. An ambiguous signal delivery may be discarded under that acknowledgement and is counted in the tombstone."),
        ),
        paragraph(
          text("A successful release atomically deletes the work graph and durable history, including the task-history membership index and projection versions, then retains a separately bounded tombstone with the final stream head, terminal and release request digests, discarded-record counts for both history tables and the rest of the graph, and a digest of that release boundary. While the tombstone remains, only the same release idempotency key and canonical request digest have an exact replay result. Replay guarantees for every earlier operation have ended. Tombstones have count, byte, and maximum-age bounds, so their retention timestamp is an upper bound rather than a promise."),
        ),
        paragraph(
          text("This release is an explicit logical destructive purge, not a forensic-erasure promise. SQLite secure deletion is defense in depth, but the command does not promise immediate physical sanitization of prior database pages, WAL frames, backups, snapshots, or storage media."),
        ),
        paragraph(
          text("Local SQLite is the only execution authority for work admission, claims, fences, dispatch receipts, submissions, reviews, signals, and the work-scoped event cursor. The initial work protocol has no cloud execution or cross-device takeover path. Turso is deferred behind a repository boundary and cannot be added as a second authority beside SQLite or encrypted Convex projections."),
        ),
      ],
    },
    {
      id: "cloud-sign-in-and-device-pairing",
      heading: "Cloud sign-in and device pairing",
      blocks: [
        paragraph(
          text(`The hosted endpoint is live as an ${hostedBetaLabel}. An unset `),
          code("HRA_CONVEX_URL"),
          text(" selects HRA's hosted deployment. Set it to an explicit empty value before the first daemon starts to disable cloud transport. A nonempty HTTPS value selects a self-managed Convex deployment. The first valid selection permanently binds that local state root; a later mismatch fails closed instead of moving credentials or recovery state. After deliberately disabling a bound state root, "),
          code("hra sync status"),
          text(" and "),
          code("hra doctor"),
          text(" report its exact restart prerequisite: unset "),
          code("HRA_CONVEX_URL"),
          text(" for the hosted deployment, or restore the bound URL for a self-managed deployment. HRA accepts cloud credentials only as protected JSON on standard input or a nonterminal file descriptor. It rejects email addresses, identity invites, and verification codes on the command line:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra auth login --input-stdin",
            "hra auth login --input-fd <fd>",
            "hra device pair",
            "hra device key-loss --acknowledge-no-key-holders",
            "hra sync status",
          ],
        },
        paragraph(
          text("Each login reads exactly one JSON document. Request a code for an existing identity with "),
          code('{"email":"you@example.com"}'),
          text(", create a new identity with "),
          code('{"email":"you@example.com","invite":"<identity-invite>"}'),
          text(", or verify a requested code with "),
          code('{"email":"you@example.com","code":"12345678"}'),
          text(". No other keys or combinations are accepted. A TTY prompt hides the document; agents should pass a private descriptor with "),
          code("--input-fd <fd>"),
          text(". The document is never an argument."),
        ),
        paragraph(
          text("The CLI stores HRA's revocable device credential, workspace encryption key, and local signing authority as immutable generations below its private state root. Custody directories are current-user-owned mode-0700 directories, values are single-link mode-0600 files, and reads use bounded no-follow descriptors. The detached Bun daemon never opens a Keychain prompt. HRA forces both pinned Codex credential stores to file mode and verifies their effective settings, so Codex credentials remain separately owned by each profile's isolated "),
          code("CODEX_HOME"),
          text(". Claude Code receives that profile's isolated "),
          code("CLAUDE_CONFIG_DIR"),
          text("; HRA treats the whole directory as Claude's authentication boundary and never reads, copies, or forwards its credentials. Provider-managed system credential storage remains owned by the provider runtime."),
        ),
        paragraph(
          text("After successful email verification, the daemon automatically registers the current installation before it reads cloud data. The first registered device becomes active and creates the client-side encryption key. A later verified installation is registered as pending and may report presence, but it has no synchronized data, execution, or key authority."),
        ),
        paragraph(
          text("On an already active machine, list devices and approve the pending device by its exact ID or unique prefix. The listing shows each device's class, daemon or browser, and the fingerprint of its two public keys. Approval requires that exact fingerprint, so the machine you approve is the one whose fingerprint you read:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra device list",
            "hra device approve <pending-device-id-or-prefix> --fingerprint <value> [--idempotency-key <current-uuidv7>]",
          ],
        },
        paragraph(
          text("After approval, run "),
          code("hra device pair"),
          text(" on the new machine to retrieve and unwrap its encryption-key envelope. Use "),
          code("hra device revoke <device-id-or-prefix>"),
          text(" from a different active machine to revoke a device."),
        ),
        paragraph(
          code("hra auth status"),
          text(" and "),
          code("hra sync status"),
          text(" expose the account key as a closed status. "),
          code("ready"),
          text(" includes the usable key version. "),
          code("pairing_required"),
          text(" says recovery requires an existing account-key holder and that no remaining holder makes the encrypted content unrecoverable."),
        ),
        paragraph(
          text("Only after this authenticated, registered, active installation reports "),
          code("pairing_required"),
          text(" and the operator has confirmed that no account-key holder remains, run "),
          code("hra device key-loss --acknowledge-no-key-holders"),
          text(". The command records that explicit observation in the current HRA cloud identity's isolated local custody, but only when the current auth token generation, identity, auth epoch, registered device, and pairing observation agree exactly. It performs no network, provider, or cloud mutation and does not mint, replace, or delete a key or ciphertext. Signed-out, unregistered, stale-identity, missing-observation, and already-ready states fail with a bounded next command. Pairing the real account key later supersedes the observation."),
        ),
        {
          kind: "notice",
          label: "Unrecoverable encrypted cloud content",
          content: [
            text("After that acknowledgement, account-key status is unrecoverable on this installation. Local provider profiles, sessions, credentials, and execution are unaffected, but existing encrypted cloud content cannot be decrypted without the real account key. Search again for an existing holder and run hra device pair if one is rediscovered; the real key restores ready status and supersedes the acknowledgement. Only after that renewed holder search is exhausted may the operator explicitly choose erasing and reinitializing the HRA cloud account as a fallback. Reinitialization creates a new account boundary; it does not regenerate the lost account key or recover old ciphertext."),
          ],
        },
        paragraph(
          text("Approve and revoke create one current UUIDv7 before daemon transport. If the response is lost after dispatch, HRA prints the exact same-key replay command. Reusing that command recovers the original operation; changing the device or operation under the same key is rejected."),
        ),
        paragraph(
          text("Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked."),
        ),
        paragraph(
          text("Cloud-account erasure is an explicit and irreversible fallback, not the default response to a key-loss acknowledgement. After a renewed holder search is exhausted, run "),
          code("hra auth delete --acknowledge-erasure"),
          text(" to disable every cloud effect before bounded server-side removal begins. "),
          code("hra auth status"),
          text(" recovers capability-only progress after authentication records disappear. Erasure does not delete local provider profiles, local sessions, or local encryption custody."),
        ),
      ],
    },
    {
      id: "features",
      heading: "Features",
      blocks: [
        list(
          [
            text("Isolated provider profiles: each named profile has its own user-only "),
            code("CODEX_HOME"),
            text(" for Codex and "),
            code("CLAUDE_CONFIG_DIR"),
            text(" for Claude Code. Each provider owns its authentication state; HRA never copies or parses provider credentials."),
          ],
          [
            text("Usage with provenance: account identity, quota, rate-limit, and token snapshots include their provider source time and freshness. A bounded source-ordered 24-hour ledger supports safe human and JSON pagination without returning raw provider payloads."),
          ],
          [
            text("Compact sessions: list sessions, read user and final assistant messages, inspect elapsed time plus bounded observed file and Git actions, then open one turn for full provider-visible detail."),
          ],
          [
            text("Durable controls: send, queue, steer, stop, rename, and keep one editable note per session. Provider and desktop effects use exact authority, idempotency keys, and process-generation fencing."),
          ],
          [
            text("Named projects: a project is a canonical directory that may contain several repositories. Changing it affects future turns only."),
          ],
          [
            text("Agent work coordination: the frozen beta contract specifies bounded local task graphs, fenced attempts, structured submissions, independent reviews, signals, and a resumable work event stream for exact existing sessions."),
          ],
          [
            text("Optional encrypted sync: paired devices share a bounded session projection and submit commands to the one machine holding the execution lease."),
          ],
        ),
      ],
    },
    {
      id: "terminal-and-agent-interfaces",
      heading: "Terminal and agent interfaces",
      blocks: [
        paragraph(
          text("Run "),
          code("hra"),
          text(" in a TTY to open a persistent shell. Account and session selections stay in the prompt, live updates redraw wrapped partial input without moving its logical cursor, protected answers are read without terminal echo, and "),
          code("/exit"),
          text(" leaves the daemon running. Pasted command lines use a bounded queue. An overflow or interrupted line flushes the current native terminal queue, retains input custody while discarding through EOF, and exits without executing the tail. Protected terminal documents require a visible stderr TTY plus unpredictable begin and return phrases while raw no-echo mode is active. A failed protected boundary keeps echo disabled while discarding the tail, then closes shell input instead of returning ambiguous bytes to an ordinary prompt. Display loss, termination, and job-control signals restore or fence raw mode before propagation. Live display is buffered while a foreground or protected prompt owns the terminal, and updates from an old session generation are discarded before a new selection is announced. Slow-terminal backpressure drops additional updates behind one explicit omission notice instead of growing memory without bound. One-shot commands provide the same control surface to scripts and agents."),
        ),
        { kind: "subheading", text: "Bounded local status" },
        paragraph(
          code("hra status [--json]"),
          text(" is a bounded, effect-free read of local SQLite state. It does not start, stop, or contact the daemon; use the network; attempt provider or cloud observation; open a browser; log in; refresh usage; or run recovery. It returns fixed count fields for account, session, interaction, queue, and latest usage states plus at most 50 ID-and-revision action records. Provider and cloud coverage are explicitly "),
          code("not_attempted"),
          text(", and registered and online device counts are unknown rather than zero. The complete JSON result, including its versioned command envelope, is at most 256 KiB."),
        ),
        {
          kind: "commands",
          commands: [
            "hra status",
            "hra status --json",
          ],
        },
        { kind: "subheading", text: "Session observation" },
        paragraph(
          code("hra session status <session> --json"),
          text(" returns status version 2. HRA produces one typed provider-observation result, attempting the bound provider's reviewed observation path only when the current local state makes one applicable, then reads the session, event cut, interactions, and queue from one local SQLite transaction. Codex supports a native app-server observation read; Claude Code status uses HRA's live provider-neutral projection because provider-side session listing and resume are not implemented. Execution, attention, provider, and queue remain separate axes, so a headline state cannot hide a recovery condition, pending interaction, response in flight, or queued work. Pending and response-in-flight counts are exact. The result includes at most 10 bounded safe summaries for pending interactions and excludes the session note and private provider thread binding. Every provider turn and item identifier becomes a secret-keyed opaque public alias before status, event, or interaction output. Public observation schemas accept only that exact alias form. The same local installation key keeps aliases coherent across surfaces and daemon restarts without making low-entropy provider IDs guessable from public output. If an existing installation loses that key, HRA refuses to replace it and directs the operator to restore the original local secret."),
        ),
        paragraph(
          code("hra session state <session> --json"),
          text(" returns the daemon's latest classification of who must act next: working, needs approval, needs an answer, needs a human action, done, done with followups, done with caveats, or aborted, with an attention flag, a short reason, and a monotonic revision. The daemon classifies the final assistant text of every completed turn with ordered lexical rules in which human-action cues beat approval cues, so a login or a code from email never reads as consent, and it reclassifies when a provider interaction is requested or resolved. The same classification is appended to the session event stream as a "),
          code("session_state"),
          text(" event."),
        ),
        paragraph(
          text("Autorespond answers provider approvals on your behalf. By default every session runs in approval mode "),
          code("auto:all"),
          text(": command, file-change, and permission approvals are accepted immediately at once scope, never for the session, and each answer leaves an evidence row with the approval class, decision, mode, latency, and outcome. "),
          code("hra autorespond workspace"),
          text(" keeps commands and file changes automatic but escalates network, MCP, and unknown-tool permissions to you; "),
          code("hra autorespond off"),
          text(" restores manual approvals; add "),
          code("--session <session>"),
          text(" to override one session and "),
          code("default"),
          text(" to clear the override. Questions and MCP forms are never answered automatically. A session stops autoresponding after three consecutive answers without a human message, ten in an hour, or forty in a day, and "),
          code("hra autorespond status"),
          text(" shows the counters and the last twenty evidence rows."),
        ),
        paragraph(
          text("For snapshot-to-stream continuity, start selected-session monitoring at the atomic status cursor. "),
          code("hra session watch <session> [--cursor <cursor>]"),
          text(" renders a bounded human stream by default; add "),
          code("--jsonl"),
          text(" for a machine stream. Watch is a presentation alias over the existing session event stream, and it drains each output page before advancing its internal cursor. The shell drains every signed pending-interaction continuation page before following newer committed ledger events from the status cursor. Standalone human watch buffers that initial guidance until enumeration is complete, caps the atomic bootstrap at 1 MiB of UTF-8, and writes none of it if enumeration or the bound fails. Resolution guidance appears only from a complete current interaction record and only for a supported decision; an event-only interaction notice points to the exact show command without proposing a mutation. Those events cover bounded lifecycle, tool, interaction, warning, error, and terminal updates, but the ledger is not a complete wake source for every authority transition. Agents that need exact current authority must also repeat bounded session status or pending-interaction reads. Human watch renders assistant and provider-visible reasoning-summary text only after observing that item's start boundary, then redacts credentials and absolute paths with state carried across chunks and interleaved events. A mid-item join omits ambiguous delta suffixes until the next item starts. Gaps, shutdown, malformed repeated starts, and exhausted redaction capacity discard undecided tails with an explicit notice rather than releasing text whose boundary cannot be proved."),
        ),
        {
          kind: "commands",
          commands: [
            "hra",
            "hra session status <session> --json",
            "hra session state <session> --json",
            "hra session watch <session> --cursor <cursor>",
            "hra session watch <session> --cursor <cursor> --jsonl",
            "hra session events <session> --cursor <cursor> --limit <1..200> --wait-ms <0..30000> --json",
            "hra session events <session> --cursor <cursor> --wait-ms 30000 --jsonl",
            "hra session interactions <session> --pending --json",
            "hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]",
          ],
        },
        paragraph(
          text("JSON mode writes one versioned document to stdout and diagnostics to stderr. Event following with "),
          code("--jsonl"),
          text(" writes JSON Lines as the turn progresses; "),
          code("--follow"),
          text(" remains an equivalent compatibility spelling for "),
          code("session events"),
          text(". JSONL delivery is at least once across a pipe or process failure: a crash after an event line but before its page checkpoint can replay that event. Durable consumers deduplicate by "),
          code("(sessionId, streamEpoch, sequence)"),
          text(" and persist each checkpoint only after durably applying all preceding lines. Signed opaque cursors let an agent resume bounded session-list, event, and interaction pages, and durable interaction records keep approvals, questions, permission grants, and MCP form elicitation visible until they are explicitly resolved."),
        ),
        paragraph(
          text("Exact "),
          code("hra session wait"),
          text(" is unavailable until every wait predicate has a transactional wake revision that changes in the same commit as the observed state. Use status followed by watch from its cursor, or bounded repeated status polling, when a caller needs to wait."),
        ),
        { kind: "subheading", text: "Exit status and JSONL" },
        paragraph(
          text("Every one-shot caller must check the process exit status. HRA uses this exact mapping:"),
        ),
        list(
          [code("0"), text(": success. A normally stopped event follower, including a user SIGINT, may also return 0.")],
          [code("1"), text(": CONFLICT, AMBIGUOUS, INTERNAL, any other closed failure code, or an unhealthy doctor result.")],
          [code("2"), text(": INVALID_INPUT.")],
          [code("4"), text(": NOT_FOUND.")],
          [code("5"), text(": UNAVAILABLE.")],
          [code("6"), text(": INTERACTION_REQUIRED.")],
          [code("7"), text(": RECOVERY_REQUIRED.")],
        ),
        paragraph(
          text("For non-streaming "),
          code("--json"),
          text(" commands, stdout contains exactly one versioned success or failure envelope. For "),
          code("--jsonl"),
          text(" or its equivalent "),
          code("--follow"),
          text(", stdout contains only JSONL gap, event, and checkpoint frames. If the follower ends on a command error, HRA leaves all completed frames on stdout and writes exactly one newline-terminated version-1 failure envelope to stderr shaped as "),
          code('{"ok":false,"version":1,"error":{"code":"<code>","message":"<safe-message>"}}'),
          text("; the error may also include bounded details. Callers must consume stdout and stderr independently, must not merge the terminal error into the JSONL stream, and must check the process exit status. A normal user stop or SIGINT may exit 0 without a terminal failure envelope."),
        ),
        paragraph(
          code("interaction show"),
          text(" intentionally returns only a durable safe summary. Before approving a command or permission request, run "),
          code("hra interaction inspect <interaction-id> --revision <n>"),
          text(" to read the complete authority still held by the live provider callback. A foreground human receives bounded detail on the protected stderr terminal. An agent or other noninteractive caller must first create an empty mode-0600 regular file under a current-user-owned mode-0700 directory and pass its absolute canonical path with "),
          code("--handoff-file"),
          text("; ordinary stdout receives only safe binding and cleanup metadata. On macOS, neither the directory nor file may have an extended ACL, and HRA rechecks both held descriptors before and after writing. Detail larger than 64 KiB also requires this file path. Read it within that protected boundary and remove it after deciding. HRA rejects file-change approval callbacks before durable admission because pinned Codex 0.153.2 does not provide the exact affected paths or change detail needed for informed approval."),
        ),
      ],
    },
    {
      id: "presets-and-permissions",
      heading: "Presets and permissions",
      blocks: [
        paragraph(
          text("HRA reviews the bound provider's exact runtime profile immediately before each new provider-native session or turn. An unavailable requirement fails before the provider effect. Every successful start records that exact account generation and effective profile; "),
          code("hra session show"),
          text(" displays it with the provider-neutral transcript. Codex profiles include the requested model, reasoning effort, service tier, permission profile, computer-use capability, and accessible apps; an empty enabled-app list is reported as empty. Claude Code profiles include the pinned CLI, model, reasoning effort, default permission mode, isolated-config proof, and stream formats. Each provider remains authoritative for its native permissions, tools, and hidden runtime state."),
        ),
        list(
          [code("low"), text(": Codex Luna Max, currently "), code("gpt-5.6-luna"), text(" with "), code("max"), text(" reasoning.")],
          [code("high"), text(": Codex Sol Max, currently "), code("gpt-5.6-sol"), text(" with "), code("max"), text(" reasoning.")],
          [code("ultra"), text(": Codex Sol Ultra, currently "), code("gpt-5.6-sol"), text(" with "), code("ultra"), text(" reasoning.")],
          [code("fable-max"), text(": Claude Code Fable, currently "), code("claude-fable-5-1"), text(" with "), code("max"), text(" reasoning.")],
          [code("fast on|off"), text(": a Codex-only, explicit per-turn Fast or Standard overlay. Claude Code refuses Fast instead of ignoring it. A prior Fast value cannot leak into the next turn.")],
        ),
        paragraph(
          code("hra init"),
          text(" reports the required confirmation without changing local state; "),
          code("hra init --yes"),
          text(" creates your Documents directory when it is absent, verifies that it is a readable, writable, and traversable canonical directory, and accepts it as the default project. Initialization is a one-shot maintenance command: run it before opening the persistent shell. The shell rejects "),
          code("/init"),
          text(" because its running daemon already owns local state. Codex turns use Codex's "),
          code("auto_review"),
          text(" path, the exact advertised "),
          code(":workspace"),
          text(" permission profile, and the selected project as the runtime workspace root. Codex remains authoritative for the profile's effective sandbox, network policy, computer use, plugins, and protected turn inspection. Claude Code runs in its default interactive permission mode under the selected project and maps supported tool-use requests into HRA interactions; it does not expose Codex's permission-profile, app, plugin, or protected turn-inspection surfaces."),
        ),
      ],
    },
    {
      id: "plugin-discovery",
      heading: "Plugin discovery",
      blocks: [
        {
          kind: "commands",
          commands: [
            "hra plugin list <account> [--project <project>] [--refresh]",
            "hra plugin show <account> <plugin> [--project <project>] [--refresh]",
          ],
        },
        paragraph(
          text("Plugin commands are read-only discovery. They report the exact installed, enabled, availability, authorization, and capability state exposed by the selected isolated Codex profile."),
        ),
        paragraph(
          text("Pinned Codex 0.153.2 has no safely separated install, enablement, and OAuth lifecycle surface: its available lifecycle path can combine installation with enablement and may then open browser authorization. HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects. The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission. Other standard MCP forms are brokered only when their pinned schema fits HRA's closed primitive-field contract. The interaction exposes bounded field names, types, requiredness, constraints, and allowed choices; titles, descriptions, defaults, and answers stay off the public and durable display. Protected submissions are checked for exact required fields, types, bounds, formats, choices, and the absence of additional properties before response preparation. Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission and receive a safe unsupported-capability response with no schema, submitted value, or URL echo. The schema-11 security migration terminalizes and replaces any prerelease URL record before interaction reads. HRA will keep extended-form and URL handoff unavailable until each has a closed protected path."),
        ),
      ],
    },
    {
      id: "desktop-account-switching",
      heading: "Desktop account switching",
      blocks: [
        paragraph(
          code("hra account switch <profile>"),
          text(" is experimental and macOS-only in the first beta. The current compatibility gate accepts only the signed OpenAI ChatGPT application at "),
          code("/Applications/ChatGPT.app"),
          text(" with reviewed version, build, CDHash, and isolated-profile launch hooks. Unsupported or changed bundles fail before quit."),
        ),
        paragraph(
          text("A switch requires a signed-in target with a verified provider email, takes one machine-global lock, rejects multiple exact app processes, and refuses an unsettled earlier switch. It journals the target generation, gracefully quits the exact process, waits for exit, relaunches once with the target's isolated Codex and desktop-data roots, and binds read-only account verification to that launched PID, executable, CDHash, and environment."),
        ),
        paragraph(
          text("HRA never copies "),
          code("auth.json"),
          text(", swaps one token, changes Keychain blindly, rotates accounts to evade a provider limit, or retries an uncertain switch. An uncertain quit, transition, or relaunch becomes "),
          code("recovery_required"),
          text(" and preserves both profiles. Run "),
          code("hra account switch-recover"),
          text(" to reconcile only the current attempt. Recovery performs bounded read-only bundle, process, environment, and account observations; it never quits or launches the app. It releases the switch authority only when those observations prove the target account is active or prove that no target instance remains."),
        ),
      ],
    },
    {
      id: "sessions-across-machines",
      heading: "Sessions across machines",
      blocks: [
        paragraph(
          text("The machine that created a provider session remains its only executor in v1. It must be online with its HRA daemon running and must hold the current execution lease before a remote command can affect Codex or Claude Code. Other paired machines never execute that provider session through one of their own local provider profiles."),
        ),
        paragraph(
          text("Paired machines can read the encrypted projection and submit bounded send, queue, steer, stop, preset, provider-switch, and Codex Fast commands. The origin daemon claims each command by lease generation and idempotency key. Commands remain pending within their deadline while the origin machine is offline; another machine cannot take over or become a second provider writer."),
        ),
        paragraph(
          code("hra remote show"),
          text(" includes interaction events with a public interaction ID, kind, state, revision, blocking status, bounded safe summary, and a nested version 2 remote policy. That policy is the only remote action authority. Provider request IDs, exact commands, permission values, affected paths, MCP fields, protected answers, and response digests remain local. Another device may decline a pending command, permission, or file-change request with "),
          code("hra remote resolve <cloud-session> --interaction <id> --revision <n> --decision decline"),
          text(". The web app may answer only a complete non-secret closed-choice user question set whose provider adapter proves exact response translation. Every command, permission, or file-change acceptance or grant, cancel, session scope, free-text or Other response, and every MCP answer stays on the execution machine. A missing policy, nested policy version 1, or unknown policy version exposes no control. The execution daemon rechecks the session, revision, pending state, deadline, requesting device, and exact action membership before using the ordinary local resolution path. "),
          code("hra remote send --or-steer"),
          text(" lets the execution device decide whether a message steers the active turn or starts a new one, because a remote view of turn state is always slightly stale."),
        ),
        {
          kind: "commands",
          commands: [
            "hra remote list",
            "hra remote show <cloud-session>",
            "hra remote command <uuidv7>",
            "hra remote send <cloud-session> <message>",
            "hra remote queue|steer <cloud-session> <message>",
            "hra remote stop <cloud-session>",
            "hra remote preset <cloud-session> <low|high|ultra|fable-max>",
            "hra remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]",
            "hra remote fast <cloud-session> <on|off>",
            "hra remote allow|deny <device-commands|account-linking>",
            "hra remote policy",
          ],
        },
        paragraph(
          text("A cloud-session selector accepts an exact public ID, a unique public-ID prefix, or an exact synced name. HRA resolves that selector to the session's exact execution device before enqueueing. Remote mutations accept "),
          code("--idempotency-key <current-uuidv7>"),
          text(" for explicit lost-response recovery; otherwise the CLI creates one and durably recovers an unsettled encrypted outbox entry before accepting a different command. Every enqueue returns its command ID. Use "),
          code("hra remote command <uuidv7>"),
          text(" to read its bounded current or terminal state and result code, including a failed or ambiguous outcome."),
        ),
        paragraph(
          text("Transcript upload is bound to a durable local stream ledger and the exact remote head and tail. Missing or mismatched evidence pauses upload for only that session. Remote reads, commands, and usage continue, while "),
          code("hra sync status"),
          text(" keeps the recovery condition visible. HRA never resets, aliases, overwrites, or destructively reseeds encrypted history."),
        ),
        {
          kind: "commands",
          commands: [
            "hra sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
          ],
        },
        paragraph(
          text("Projection recovery is an explicit append-only operation. Running it without "),
          code("--acknowledge-gap"),
          text(" performs no daemon call and returns "),
          code("INTERACTION_REQUIRED"),
          text(" with the exact safe next command. JSON mode never prompts. The acknowledged operation preserves all older encrypted cloud history and changes no provider or app state. It opens the next compact stream epoch at sequence "),
          code("H+1"),
          text(", where "),
          code("H"),
          text(" is the exact remote compact head, and baselines only completed turns currently visible in the bounded local projection. Any possibly unsynced interval remains visible to remote readers as a recovery gap."),
        ),
        paragraph(
          text("The CLI creates a current UUIDv7 before daemon transport. Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command. A prepared recovery inside the seven-day server window renews its execution lease and keeps the same exact key. Changed-key retry remains closed while that recovery is unsettled. After the window, exact-key replay first reconciles an already committed effect from immutable lineage. If no effect began, it discards local staging, settles the old attempt as rejected, and clears its authority. Run "),
          code("hra sync status --json"),
          text(", then start a fresh recovery without "),
          code("--idempotency-key"),
          text(" if recovery is still required."),
        ),
        paragraph(
          text("Session names and notes sync as encrypted metadata, but v1 does not execute remote rename or note commands. Project directories are local-only and are neither synced nor remotely changed."),
        ),
      ],
    },
    {
      id: "privacy",
      heading: "Privacy",
      blocks: privacyBlocks,
    },
    {
      id: "command-reference",
      heading: "Command reference",
      blocks: [
        {
          kind: "commands",
          commands: [
            "hra init [--yes] [--json]",
            "hra status [--json]",
            "hra doctor [--offline] [--json]",
            "hra auth login --input-stdin|--input-fd <fd>",
            "hra auth status|logout",
            "hra auth delete --acknowledge-erasure",
            "hra device list",
            "hra device pair",
            "hra device key-loss --acknowledge-no-key-holders",
            "hra device approve <device-id-or-prefix> --fingerprint <value> [--idempotency-key <uuidv7>] [--json]",
            "hra device revoke <device-id-or-prefix> [--idempotency-key <uuidv7>] [--json]",
            "hra account add <label>",
            "hra account login <profile> [--provider <codex|claude>] [--device-code] [--handoff-file <absolute-path>] [--idempotency-key <uuid>]",
            "hra account login-cancel <profile> [--provider codex]",
            "hra account login-cancel <profile> --provider claude --attempt-id <attempt-id> --provider-generation <n> --idempotency-key <uuid> --acknowledge-child-exited",
            "hra account logout <profile>",
            "hra account list",
            "hra account show <profile> [--provider <codex|claude>]",
            "hra account usage [profile] [--refresh]",
            "hra account usage-history <profile> [--from <UTC-RFC3339>] [--through <UTC-RFC3339>] [--limit <1..100>] [--cursor <cursor>]",
            "hra account switch <profile>",
            "hra account switch-recover",
            "hra plugin list <account> [--project <project>] [--refresh]",
            "hra plugin show <account> <plugin> [--project <project>] [--refresh]",
            "hra project add --path <directory> [--name <name>]",
            "hra project list",
            "hra project use <project>",
            "hra session list [--account <profile>] [--archived] [--limit <1..100>] [--cursor <cursor>]",
            "hra session show <session> [--detail]",
            "hra session status <session> [--json]",
            "hra session watch <session> [--cursor <cursor>] [--jsonl]",
            "hra session events <session> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]",
            "hra session interactions <session> [--pending] [--limit <1..100>] [--cursor <cursor>]",
            "hra session start <account> [--project <project>] [--provider <codex|claude>] [--preset <low|high|ultra|fable-max>] [--fast]",
            "hra session send|queue|steer <session> [--attach <path>]... <message>",
            "hra session stop|recover|abandon <session>",
            "hra session rename <session> <name>",
            "hra session archive|unarchive <session>",
            "hra session note get|edit|clear <session>",
            "hra session note set <session> <note>",
            "hra session state <session> [--json]",
            "hra session preset <session> <low|high|ultra|fable-max>",
            "hra session switch <session> --provider <codex|claude> [--preset <low|high|ultra|fable-max>] [--account <account>]",
            "hra session export <session> [--format <trajectory|json>] [--out <path>]",
            "hra session fast <session> <on|off>",
            "hra session project <session> <project>",
            "hra session task list <session>",
            "hra session task show <session> <task-id>",
            "hra session task create <session> --name <name> --every-minutes <15..10080> [--paused] [--idempotency-key <uuid>] -- <prompt>",
            "hra session task edit <session> <task-id> --revision <n> [--name <name>] [--every-minutes <15..10080>] [--pause|--resume] [--idempotency-key <uuid>] [-- <replacement-prompt>]",
            "hra session task delete <session> <task-id> --revision <n> [--idempotency-key <uuid>]",
            "hra work protocol [--operation <kind>|--type <name>|--topic <topic>]",
            "hra work apply --input-stdin|--input-fd <fd>",
            "hra work snapshot <work> [--actor <session>]",
            "hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]",
            "hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1..50>] [--wait-ms <0..30000>]",
            "hra work events <work> [--cursor <cursor>] [--limit <1..200>] [--wait-ms <0..30000>] [--json|--jsonl|--follow]",
            "hra work watch <work> [--cursor <cursor>]",
            "hra interaction list [session] [--pending] [--limit <1..100>] [--cursor <cursor>]",
            "hra interaction show <interaction-id>",
            "hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]",
            "hra interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>",
            "hra interaction grant|answer <interaction-id> --revision <n> --input-stdin|--input-fd <fd>",
            "hra interaction submit <interaction-id> --revision <n> --action <accept|decline|cancel> [--input-stdin|--input-fd <fd>]",
            "hra autorespond on|workspace|off|default|status [--session <session>] [--json]",
            "hra autorespond gateway set [--from-fd <fd>] [--json]",
            "hra autorespond gateway clear [--json]",
            "hra remote list [--limit <1..100>]",
            "hra remote show <cloud-session>",
            "hra remote command <uuidv7>",
            "hra remote send|queue|steer <cloud-session> <message>",
            "hra remote send --or-steer <cloud-session> <message>",
            "hra remote resolve <cloud-session> --interaction <interaction-id> --revision <n> --decision <decline>",
            "hra remote stop <cloud-session>",
            "hra remote preset <cloud-session> <low|high|ultra|fable-max>",
            "hra remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]",
            "hra remote fast <cloud-session> <on|off>",
            "hra remote allow|deny <device-commands|account-linking>",
            "hra remote policy",
            "hra turn inspect <session> <turn> [--json]",
            "hra sync status|now",
            "hra sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
            "hra daemon start [--json]",
            "hra daemon status|stop [--json]",
            "hra daemon run",
          ],
        },
        paragraph(
          text("Account, project, and local-session selectors accept an exact ID or an unambiguous case-insensitive label. Cloud-session selectors accept an exact public ID, a unique public-ID prefix, or an exact synced name. Device selectors accept an exact ID or unique prefix. Ambiguity lists candidates and performs no effect. The CLI creates and sends an idempotency key before every provider effect; pass "),
          code("--idempotency-key <uuid>"),
          text(" to reuse one after a lost response. If a local mutation response is uncertain, HRA returns the generated key and the exact replay arguments without repeating the command payload. Put those arguments before any "),
          code("--"),
          text(" delimiter when rerunning the otherwise unchanged command. session recover accepts only exact, kind-specific provider proof. session abandon never retries or deletes provider state and releases only the local recovery authority. Remote mutations require a current UUIDv7 when this option is supplied. With "),
          code("--json"),
          text(", stdout contains one versioned object; diagnostics stay on stderr."),
        ),
        paragraph(
          code("interaction show"),
          text(" lists each safe requested permission category and each exact question ID. Complete live command and permission authority is available only through the revision-bound protected "),
          code("interaction inspect"),
          text(" path described above. A permission grant reads "),
          code('{"permissions":["<requested-name>"]}'),
          text(" and a question response reads "),
          code('{"answers":{"<question-id>":{"answers":["<answer>"]}}}'),
          text(" through protected input. Those permission-name and question-answer document shapes are Codex-specific. The live Codex adapter rehydrates selected permission names to their exact private provider values immediately before the response write; those values never enter display, storage, logs, or sync. Claude Code tool-use requests map to HRA's provider-neutral interaction kinds and accept only the response choices that exact callback offers."),
        ),
        paragraph(
          text("Every admitted callback carries a local deadline anchored when the provider delivered it. HRA caps the pending interval at 30 minutes and honors a shorter valid provider interval, including an immediate zero interval. At the deadline it writes one provider-neutral timeout error through the same write-ahead ledger, never invents an answer or grant, and quarantines the provider generation if the write may have escaped. "),
          code("interaction show"),
          text(" displays the safe local deadline; nested remote policy version 2 carries the same absolute deadline so readers can suppress an expired control, while the daemon remains authoritative."),
        ),
        paragraph(
          text("For a standard MCP form, interaction show returns the exact public field contract without defaults or answers. Accept reads one protected document shaped as "),
          code('{"content":{...}}'),
          text(" from nonterminal stdin or a file descriptor. Decline and cancel accept no content. JSON mode never prompts, and validation failures identify the contract failure without echoing a submitted value."),
        ),
        paragraph(
          text("Projection recovery uses the local-session selector rules. It requires "),
          code("--acknowledge-gap"),
          text(" and a canonical UUIDv7; the CLI generates a current key when it is omitted. A stored exact key remains the only admissible replay while recovery is unsettled. Inside the seven-day window, a prepared replay renews its lease and can apply. After the window, replay reconciles immutable committed lineage or safely settles known-no-effect authority as rejected; status then determines whether to retry with a fresh generated key."),
        ),
        paragraph(
          text("The beta does not expose destructive local profile or project deletion. "),
          code("account logout"),
          text(" asks Codex app-server to remove that profile's Codex login while HRA preserves its local session history. HRA does not implement Claude Code sign-out; use Claude Code's own authentication flow inside the isolated profile."),
        ),
      ],
    },
    {
      id: "authority-boundaries",
      heading: "Authority boundaries",
      blocks: [
        paragraph(
          text("Codex app-server and Claude Code remain authoritative for their provider-native authentication, sessions, execution, tools, approvals, models, and hidden runtime state; Codex additionally owns its plugin, usage, and native transcript surfaces. HRA owns isolated profiles, the durable provider-neutral conversation record and commands, process generations, local projections, optional encrypted sync, and recovery records. The frozen work contract assigns local coordination records to HRA rather than either provider runtime."),
        ),
        paragraph(
          text("Cloud service availability is not required for local provider authentication, local execution, local work coordination, local recovery, or reading local sessions. Provider accounts remain independent subscriptions. HRA does not pool quota or replay a limited turn under another account or provider. SQLite remains the local work execution authority; Turso is deferred and non-authoritative."),
        ),
      ],
    },
    {
      id: "project",
      heading: "Project",
      blocks: [
        paragraph(
          text("HRA is MIT licensed. Read the "),
          link("security policy", links.security),
          text(" before reporting a vulnerability, use "),
          link("private vulnerability reporting", links.privateSecurityReport),
          text(" for suspected security issues, and read the "),
          link("contribution guide", links.contributing),
          text(" before a large change."),
        ),
      ],
    },
  ],
};

const renderMarkdownInline = (content: readonly InlineContent[]): string =>
  content
    .map((part) => {
      switch (part.kind) {
        case "code":
          return `\`${part.value}\``;
        case "link":
          return `[${part.label}](${part.href})`;
        case "text":
          return part.value;
      }
    })
    .join("");

const renderMarkdownBlock = (block: ContentBlock, headingLevel: number): string => {
  switch (block.kind) {
    case "commands":
      return `\`\`\`text\n${block.commands.join("\n")}\n\`\`\``;
    case "list":
      return block.items.map((item) => `- ${renderMarkdownInline(item)}`).join("\n");
    case "notice":
      return `> **${block.label}.** ${renderMarkdownInline(block.content)}`;
    case "paragraph":
      return renderMarkdownInline(block.content);
    case "subheading":
      return `${"#".repeat(headingLevel)} ${block.text}`;
  }
};

const renderMarkdownBlocks = (blocks: readonly ContentBlock[], headingLevel: number): string =>
  blocks.map((block) => renderMarkdownBlock(block, headingLevel)).join("\n\n");

export const renderReadmeMarkdown = (content: PublicContent = publicContent): string => {
  const sections = content.sections
    .map(
      (section) =>
        `## ${section.heading}\n\n${renderMarkdownBlocks(section.blocks, 3)}`,
    )
    .join("\n\n");

  const badgeLine = content.badges
    .map((badge) => `[![${badge.alt}](${badge.image})](${badge.href})`)
    .join(" ");

  // The badge line ends with a hard line break so the thesis is line 3 of the
  // README and still renders as its own line under the badges.
  return [
    `# ${content.productName}\n${badgeLine}\\\n${content.thesis}`,
    content.statusLine,
    `\`\`\`sh\n${content.installCommand}\n\`\`\``,
    `\`\`\`sh\n${content.doctorCommand}\n\`\`\``,
    `\`\`\`sh\n${content.initCommand}\n\`\`\``,
    `## ${content.hero.heading}\n\n${content.hero.summary}\n\n${content.hero.boundary}`,
    `### ${content.hero.proofLabel}\n\n${content.hero.steps.map((step, index) => `${index + 1}. **${step.label}:** \`${step.command}\`. ${step.detail}`).join("\n")}`,
    renderMarkdownBlocks(content.introduction, 3),
    sections,
  ].join("\n\n") + "\n";
};

export const renderPrivacyMarkdown = (content: PublicContent = publicContent): string => {
  const privacy = content.sections.find((section) => section.id === "privacy");
  if (privacy === undefined) {
    throw new Error("Public content is missing its privacy section.");
  }

  return [
    "# Privacy",
    `This policy describes the HRA beta data boundary. The hosted sync service is live as an ${hostedBetaLabel}. Besides completed turns, the daemon streams the current turn's assistant text to the hosted service in encrypted, redacted batches that expire within six hours; reasoning summaries are included only when you enable show-thinking for a session, and raw reasoning is never uploaded.`,
    renderMarkdownBlocks(privacy.blocks, 2),
    `Report a suspected boundary violation through [private vulnerability reporting](${content.links.privateSecurityReport}).`,
  ].join("\n\n") + "\n";
};

export const renderLlmsText = (content: PublicContent = publicContent): string =>
  [
    `# ${content.productName}`,
    "",
    `> ${content.description}`,
    "",
    content.thesis,
    content.statusLine,
    "",
    `Install after the v${content.releaseVersion} beta tag is live: ${content.installCommand}`,
    `Initialize: ${content.initCommand}`,
    `Verify local prerequisites without cloud access: ${content.doctorCommand}`,
    "",
    `Repository: ${content.links.github}`,
    `Documentation: ${content.links.documentation}`,
    `Security: ${content.links.security}`,
    `Privacy: ${content.links.privacy}`,
    "",
    "## Documentation sections",
    "",
    ...content.sections.map(
      (section) => `- [${section.heading}](${content.siteUrl}/#${section.id})`,
    ),
    "",
  ].join("\n");

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&apos;");

export const renderSitemapXml = (content: PublicContent = publicContent): string => {
  const urls = siteDocumentPaths.map((path) => `  <url>
    <loc>${escapeXml(`${content.siteUrl}${path}`)}</loc>
  </url>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
};

export const findSection = (content: PublicContent, id: string): ContentSection => {
  const section = content.sections.find((candidate) => candidate.id === id);
  if (section === undefined) {
    throw new Error(`Unknown public content section: ${id}`);
  }
  return section;
};
