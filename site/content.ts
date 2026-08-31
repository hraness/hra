import { buildHraGlobalInstallCommand } from "../src/install-preflight";
import { editorialImage, editorialImageUrl } from "./editorial-images.ts";

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

export interface PublicContent {
  readonly description: string;
  readonly doctorCommand: string;
  readonly endpoints: PublicEndpoints;
  readonly installCommand: string;
  readonly initCommand: string;
  readonly introduction: readonly ContentBlock[];
  readonly links: {
    readonly contributing: string;
    readonly documentation: string;
    readonly github: string;
    readonly privateSecurityReport: string;
    readonly privacy: string;
    readonly security: string;
  };
  readonly productName: string;
  readonly sections: readonly ContentSection[];
  readonly siteUrl: string;
}

export interface ReadingPage {
  readonly canonicalPath: string;
  readonly datePublished: string;
  readonly description: string;
  readonly heading: string;
  readonly homeLink: ContentBlock;
  readonly section: ContentSection;
  readonly title: string;
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

const links = {
  contributing: "https://github.com/hraness/hra/blob/main/CONTRIBUTING.md",
  documentation: "https://github.com/hraness/hra#command-reference",
  github: "https://github.com/hraness/hra",
  privateSecurityReport: "https://github.com/hraness/hra/security/advisories/new",
  privacy: "https://github.com/hraness/hra/blob/main/PRIVACY.md",
  security: "https://github.com/hraness/hra/blob/main/SECURITY.md",
} as const;

const privacyBlocks: readonly ContentBlock[] = [
  paragraph(
    text("Cloud sync is optional. Local account profiles, Codex credentials, and local execution continue to work without it. HRA identity is separate from every Codex account."),
  ),
  { kind: "subheading", text: "Encrypted before upload" },
  list(
    [text("User messages and final assistant display text.")],
    [text("Session names, notes, queued messages, and steering input.")],
    [text("Codex account labels and observed provider email and plan metadata when cloud sync is enabled.")],
    [text("Turn timing, observed model and tier, and provider usage summaries.")],
    [text("Bounded observed file and Git metadata, without unbounded filesystem paths.")],
    [text("Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.")],
    [text("Remote-command input and results that fit the closed command protocol.")],
  ),
  { kind: "subheading", text: "Never uploaded" },
  list(
    [text("Codex credentials, profile files, plugin credentials, or OAuth material.")],
    [text("Raw app-server requests or responses.")],
    [text("Raw reasoning, hidden chain of thought, or approval secrets.")],
    [text("Provider login and request IDs, permission values, MCP field contracts, protected answers, or response digests.")],
    [text("Environment variables, arbitrary command output, or unbounded filesystem paths.")],
  ),
  paragraph(
    text("The sync service necessarily sees the verified HRA email address, device identifiers, record types, revisions, ciphertext sizes, timestamps, and execution-lease or command lifecycle metadata. It cannot decrypt session content without a paired device key. Email access alone does not recover that key."),
  ),
  paragraph(
    text("HRA uses Convex to authenticate the HRA identity and store server-visible metadata plus encrypted projections. Convex receives the verified email address and the service metadata described above, but not the keys required to decrypt session content."),
  ),
  paragraph(
    text("HRA uses Resend to deliver verification email. Resend receives the recipient email address, sender identity, one-time verification code and message content, and ordinary delivery metadata. It receives no Codex credentials or encrypted session projection."),
  ),
  paragraph(
    text("Vercel serves hra.sh. GitHub hosts the source repository, releases, and release downloads. When you visit or download from either service, that provider receives ordinary web request metadata such as the requested URL, IP address, user agent, and time. HRA does not add analytics, cookies, remote fonts, or executable JavaScript to the site."),
  ),
  paragraph(
    text("Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked."),
  ),
  paragraph(
    text("Compact-projection recovery is append-only. It preserves every older encrypted cloud chunk, opens a new stream epoch, and keeps the acknowledged unsynced interval visible as a recovery gap until authenticated account deletion."),
  ),
  paragraph(
    text("Codex activity remains subject to OpenAI's own service and privacy terms."),
  ),
  {
    kind: "notice",
    label: "Hosted sync status",
    content: [
      text("The hosted sync endpoint is beta-not-yet-live. Authenticated account deletion and capability-only progress recovery are implemented and pass deterministic hostile tests. Fresh-deployment and live completion acceptance remain launch gates."),
    ],
  },
];

export const deepseekHarnessReading: ReadingPage = {
  canonicalPath: "/reading/deepseek-harness/",
  datePublished: "2026-08-27",
  description:
    "DeepSeek Harness is an open-source plugin-first agent harness. HRA is a Bun CLI and local daemon for isolated Codex accounts, live sessions, and optional encrypted sync.",
  heading: "A plugin catalog is not a Codex account loop",
  title: "A plugin catalog is not a Codex account loop",
  homeLink: paragraph(
    text("A sourced reading take: "),
    link("A plugin catalog is not a Codex account loop", "/reading/deepseek-harness/"),
    text(" reads DeepSeek Harness as a plugin-first design reference, not as HRA's isolated Codex account job."),
  ),
  section: {
    id: "reading-deepseek-harness",
    heading: "A plugin catalog is not a Codex account loop",
    blocks: [
      paragraph(text("Published 27 August 2026.")),
      paragraph(
        text("DeepSeek Harness is an open-source agent harness whose public design is \"everything is a plugin.\" That catalog is a composition model. HRA is a Bun CLI plus a local daemon. It keeps isolated Codex accounts, live sessions, and optional encrypted sync. A plugin catalog is not multi-subscription Codex parallelism."),
      ),
      { kind: "subheading", text: "DeepSeek Harness as published" },
      paragraph(
        text("The "),
        link("DeepSeek Harness repository", "https://github.com/deepseek-ai/deepseek-harness"),
        text(" describes an open-source harness from DeepSeek AI. Features live in plugins instead of a growing privileged core. Cordis is the published composition layer. The first advertised run starts a local browser interface from npm without a repository checkout."),
      ),
      paragraph(
        text("The maintainers mark the work as a developer preview and warn that compatibility-breaking changes will happen. That warning is the useful boundary. The "),
        link("Reading digest", "https://hraness.com/reading/deepseek-harness"),
        text(" records the same source as a gist. This page is the HRA take, not that digest."),
      ),
      { kind: "subheading", text: "A design reference, not a target" },
      paragraph(
        text("HRA does not wrap DeepSeek Harness, consume its plugin catalog, or treat the preview interface as a provider. The repository is worth reading because it keeps the core small and pushes features into plugins. It is not a stable integration target while that preview warning remains."),
      ),
      paragraph(
        text("HRA already has a closed plugin surface of its own: read-only discovery against the selected isolated Codex profile. Codex app-server remains authoritative for plugins. HRA does not install, enable, or disable them. That boundary is about one pinned Codex profile. It is not a marketplace, and it is not an account loop."),
      ),
      { kind: "subheading", text: "What HRA keeps on this host" },
      paragraph(
        text("The live product page is "),
        link("HRA on hra.sh", "https://hra.sh/"),
        text(". HRA owns isolated profiles, process generations, durable commands, local projections, optional encrypted sync, and recovery. Codex app-server owns login, transcripts, turns, tools, and approvals. One machine remains the fenced execution custodian for a session. Other paired devices may read or submit durable commands. They do not become a second provider writer."),
      ),
      paragraph(
        text("Several Codex accounts stay independent subscriptions. HRA does not pool quota or replay a failed turn under another account. That is the account loop this host publishes: named profiles, live sessions, and a local daemon. It is not a plugin catalog."),
      ),
      { kind: "subheading", text: "The harness noun stays on its own host" },
      paragraph(
        link("What is an agent harness?", "https://hraness.com/writing/what-is-an-agent-harness"),
        text(" defines the noun and points at live surfaces. "),
        link("Direct, Wrench, and Hra", "https://hraness.com/writing/direct-wrench-hra"),
        text(" keeps the product split off this host: Direct owns application state, Wrench owns attested web operations, and Hra owns multi-subscription Codex parallelism. This generation-1 site publishes the Bun CLI and daemon that keep those isolated Codex accounts. It does not republish the comparison essay."),
      ),
      paragraph(
        text("A sourced reading take: "),
        link("A microharness for persistence is not a Codex account loop", "/reading/headlong-microharness/"),
        text(" reads Headlong as a persistence design, not as this host's isolated Codex account loop."),
      ),
      paragraph(
        text("When those Codex sessions need an attested web operation rather than a plugin slot, the "),
        link("Wrench provider capabilities", "https://wrench.rip/provider-capabilities/"),
        text(" table names the operations a session can call on purpose."),
      ),
    ],
  },
};

export const headlongMicroharnessReading: ReadingPage = {
  canonicalPath: "/reading/headlong-microharness/",
  datePublished: "2026-08-28",
  description:
    "Headlong is a Laude microharness for persistent agents. HRA is a Bun CLI and local daemon for isolated Codex accounts, live sessions, and optional encrypted sync.",
  heading: "A microharness for persistence is not a Codex account loop",
  title: "A microharness for persistence is not a Codex account loop",
  homeLink: paragraph(
    text("A sourced reading take: "),
    link("A microharness for persistence is not a Codex account loop", "/reading/headlong-microharness/"),
    text(" reads Headlong as a persistence design, not as HRA's isolated Codex account job."),
  ),
  section: {
    id: "reading-headlong-microharness",
    heading: "A microharness for persistence is not a Codex account loop",
    blocks: [
      paragraph(text("Published 28 August 2026.")),
      paragraph(
        text("Headlong is an open-source microharness for persistent agents. Its published design keeps an agent thinking between external messages. HRA is a Bun CLI plus a local daemon. It keeps isolated Codex accounts, live sessions, and optional encrypted sync. Persistence is the shared noun: work that survives a dead window. The objects differ. A microharness for persistence is not multi-subscription Codex parallelism."),
      ),
      { kind: "subheading", text: "Headlong as published" },
      paragraph(
        text("The Laude Institute post "),
        link("Headlong: a microharness for persistent agents", "https://www.laude.org/updates/headlong-a-microharness-for-persistent-agents"),
        text(" describes a Bash core that treats incoming chat as observations in one thought stream. The agent decides if and when to reply."),
      ),
      paragraph(
        text("The "),
        link("Reading digest", "https://hraness.com/reading/headlong-a-microharness-for-persistent-agents"),
        text(" records the same source as a gist. This page is the HRA take, not that digest. It is also not the generation-0 always-on-loop URL, which 404s on this host."),
      ),
      { kind: "subheading", text: "A design reference, not an implementation" },
      paragraph(
        text("HRA does not implement Headlong, wrap its thinker loop, or treat a self-guided inner monologue as a Codex provider. The Laude post is worth reading because it isolates persistence as a harness constraint. It is not a product claim about this host."),
      ),
      { kind: "subheading", text: "What HRA keeps on this host" },
      paragraph(
        text("The live product page is "),
        link("HRA on hra.sh", "https://hra.sh/"),
        text(". HRA owns isolated profiles, process generations, durable commands, local projections, optional encrypted sync, and recovery. Codex app-server owns login, transcripts, turns, tools, and approvals. One machine remains the fenced execution custodian for a session. Other paired devices may read or submit durable commands. They do not become a second provider writer."),
      ),
      paragraph(
        text("Several Codex accounts stay independent subscriptions. HRA does not pool quota or replay a failed turn under another account. That is the account loop this host publishes: named profiles, live sessions, and a local daemon. It is not a Headlong thinker loop."),
      ),
      { kind: "subheading", text: "The harness noun stays on its own host" },
      paragraph(
        link("What is an agent harness?", "https://hraness.com/writing/what-is-an-agent-harness"),
        text(" defines the noun and points at live surfaces. "),
        link("Direct, Wrench, and Hra", "https://hraness.com/writing/direct-wrench-hra"),
        text(" keeps the product split off this host: Direct owns application state, Wrench owns attested web operations, and Hra owns multi-subscription Codex parallelism. This generation-1 site publishes the Bun CLI and daemon that keep those isolated Codex accounts. It does not republish the comparison essay."),
      ),
      paragraph(
        text("A sourced reading take: "),
        link("A plugin catalog is not a Codex account loop", "/reading/deepseek-harness/"),
        text(" reads DeepSeek Harness as a plugin-first design reference. This page reads Headlong as a persistence design. Neither page is the other source's digest."),
      ),
      paragraph(
        text("When those Codex sessions need an attested web operation rather than a thought stream, the "),
        link("Wrench provider capabilities", "https://wrench.rip/provider-capabilities/"),
        text(" table names the operations a session can call on purpose."),
      ),
    ],
  },
};

export const readingPages: readonly ReadingPage[] = [
  deepseekHarnessReading,
  headlongMicroharnessReading,
];

export const siteDocumentPaths: readonly string[] = [
  "/",
  "/privacy/",
  "/reading/",
  ...readingPages.map((page) => page.canonicalPath),
];

export const publicReleaseState: "release-ready" | "staged" = "release-ready";

const betaInstallCommand = buildHraGlobalInstallCommand(
  "https://github.com/hraness/hra/releases/download/v0.1.0/hraness-hra-0.1.0.tgz",
);

export const publicContent: PublicContent = {
  productName: "HRA",
  description: "A persistent Bun CLI for isolated Codex accounts, live sessions, safe macOS account switching, and optional encrypted sync.",
  siteUrl: "https://hra.sh",
  installCommand: betaInstallCommand,
  initCommand: "hra init --yes",
  doctorCommand: "hra doctor --offline",
  endpoints: {
    betaTag: "release-ready",
    githubRepository: "live",
    hostedSync: "beta-not-yet-live",
    website: "live",
  },
  links,
  introduction: [
    {
      kind: "notice",
      label: "Immutable local CLI release; hosted sync not yet live",
      content: [
        text("The exact install command below works once GitHub exposes the immutable "),
        code("v0.1.0"),
        text(" Release and its verified archive. The website is live; the public CLI stays immutable once admitted, and optional hosted sync remains beta-not-yet-live."),
      ],
    },
    paragraph(
      text("HRA is one Bun CLI plus a local daemon. It keeps Codex accounts isolated, gives you a compact session interface, and optionally syncs encrypted session projections and commands across your enrolled machines."),
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
          text("HRA requires Bun 1.3.14 plus curl with HTTPS and TLS 1.2 support. The CLI and local daemon support macOS and Linux; supported ChatGPT desktop account switching is macOS-only. Native protected-input control loads only when a terminal prompt needs it and supports the standard macOS, glibc, and x64 or arm64 musl library names. Install one reviewed immutable tag, then verify the binary before initialization:"),
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
          text("The single install command streams the exact v0.1.0 preflight from HRA's protected source tag and passes it the exact release archive URL. The preflight requires GitHub repository ID 1343008607, a published immutable v0.1.0 release, and one uploaded archive whose byte length and SHA-256 match GitHub's immutable release metadata. It creates a fresh random private staging root, downloads the archive into a private file there, and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted HRA package path and SHA-256 while measuring the completion receipt. Local archives and official archives use separate full-digest version namespaces, so a local package cannot populate or replace the official cache entry. HRA then verifies the tagged preflight and normalizer, exact package identity, zero-lifecycle manifest, CLI SHA-256, and complete staged tree under protected descriptor and ACL custody. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the release archive does not claim to contain that dependency closure. The prior verified command remains active throughout staging. Publication atomically replaces only the $BUN_INSTALL/bin/hra symlink after every check succeeds and fsyncs its directory. If installation is interrupted, the next invocation recovers or removes only the proven private stage. Existing trustedDependencies remain unchanged."),
        ),
        paragraph(
          text("Before replacing the installed binary, stop the persistent daemon and confirm that its old process has released authority. The command below performs a verified repair installation of v0.1.0. For a future update, replace the tagged preflight and release archive references together with the exact reviewed release version, verify it, then restart explicitly. Do not install a moving branch for a release machine:"),
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
          text(" for every Codex profile. Stop the daemon, require a successful "),
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
            text(" on Linux. After every prerequisite above, a human who explicitly accepts permanent loss of all local profiles, Codex credential stores, sessions, ledgers, encryption keys, device credentials, and recovery evidence may move only the exact platform directory to Trash. Do not move or remove its parent. Inspect the trashed directory before emptying Trash."),
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
            "hra account login personal",
            "hra account usage personal --refresh",
            "hra account usage-history personal --limit 50 --json",
          ],
        },
        paragraph(
          text("Account login is always a dedicated one-shot invocation, including while the persistent shell is running. Use "),
          code("hra account login personal --device-code"),
          text(" in a foreground TTY for the provider's device-code path. The code and verification URL are shown only on that protected foreground terminal. HRA keeps the resulting provider state inside that profile's isolated "),
          code("CODEX_HOME"),
          text(" without copying "),
          code("auth.json"),
          text("."),
        ),
        paragraph(
          text("JSON and noninteractive callers must create an empty mode-0600 file under a canonical current-user-owned mode-0700 directory, then pass its absolute canonical path:"),
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
          code("hra account show personal"),
          text(" reports the pending attempt. Then run "),
          code("hra account login-cancel personal"),
          text(". A caller that retained the idempotency key may retry it without redispatching. A still-pending replay cannot recover the one-time code or URL; a completed or canceled replay returns terminal signed-in or signed-out evidence instead of stale pending state. HRA cancels only that profile's exact current-generation provider login before allowing a fresh login. Verification URLs and device codes never enter HRA state, logs, or ordinary output; only the caller-owned protected handoff file retains them for completion."),
        ),
        paragraph(
          code("hra account usage"),
          text(" keeps the latest snapshot and 1-, 5-, and 15-minute observed token velocity. "),
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
          text("HRA cloud identity is separate from every Codex account. Use the email-code flow below only after a hosted or self-managed Convex deployment has been configured."),
        ),
      ],
    },
    {
      id: "first-session",
      heading: "First session",
      blocks: [
        paragraph(
          text("Complete initialization and the first account login before this walkthrough. Account login remains a dedicated one-shot command. The session-start command returns the new session ID."),
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
            "hra session start personal --preset high",
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
            "hra session start personal --preset high --json",
            "hra session status <session-id> --json",
            "hra session send <session-id> -- \"Review this project and summarize its current state.\"",
            "hra session watch <session-id> --cursor <status-cursor> --jsonl",
            "hra session interactions <session-id> --pending --json",
          ],
        },
        paragraph(
          text("If the event stream reports a blocking interaction, read its exact ID and revision, inspect the live authority through the protected path, and resolve only the interaction kind you received. Keep following while a separate one-shot invocation handles the approval, question, permission grant, or supported MCP form. The protected interaction commands and input documents are defined below."),
        ),
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
            code("v0.1.0"),
            text(" local CLI release and become installable through the exact command above once its GitHub Release exists. Hosted sync is not required for this local protocol."),
          ],
        },
        paragraph(
          text("The frozen source contract defines a narrow local coordination kernel for agents operating several already-existing Codex sessions. It records six bounded objects: work, tasks, attempts, submissions, reviews, and signals. Codex app-server still owns model execution, turns, tools, context, and approvals. HRA does not add a second model loop or a generic executable workflow engine."),
        ),
        {
          kind: "commands",
          commands: [
            "hra work protocol [--operation <kind>|--type <name>|--topic <topic>]",
            "hra work apply --input-stdin",
            "hra work snapshot <work> [--actor <session>]",
            "hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]",
            "hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1-50>] [--wait-ms <0-30000>]",
            "hra work events <work> [--cursor <cursor>] [--limit <1-200>] [--wait-ms <0-30000>]",
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
          text("Accepted submissions, reviews, evidence references, receipts, and completed tasks are durable prefixes. Later failure or cancellation preserves them. No SQLite writer transaction spans Codex reasoning, provider I/O, artifact hashing, or Git inspection. This applies the durable-prefix lesson in "),
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
          text("The hosted endpoint is beta-not-yet-live. An unset "),
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
          text("."),
        ),
        paragraph(
          text("After successful email verification, the daemon automatically registers the current installation before it reads cloud data. The first registered device becomes active and creates the client-side encryption key. A later verified installation is registered as pending and may report presence, but it has no synchronized data, execution, or key authority."),
        ),
        paragraph(
          text("On an already active machine, list devices and approve the pending device by its exact ID or unique prefix:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra device list",
            "hra device approve <pending-device-id-or-prefix> [--idempotency-key <current-uuidv7>]",
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
            text("After that acknowledgement, account-key status is unrecoverable on this installation. Local Codex accounts, sessions, credentials, and execution are unaffected, but existing encrypted cloud content cannot be decrypted without the real account key. Search again for an existing holder and run hra device pair if one is rediscovered; the real key restores ready status and supersedes the acknowledgement. Only after that renewed holder search is exhausted may the operator explicitly choose erasing and reinitializing the HRA cloud account as a fallback. Reinitialization creates a new account boundary; it does not regenerate the lost account key or recover old ciphertext."),
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
          text(" recovers capability-only progress after authentication records disappear. Erasure does not delete local Codex accounts, local sessions, or local encryption custody."),
        ),
      ],
    },
    {
      id: "features",
      heading: "Features",
      blocks: [
        list(
          [
            text("Isolated accounts: each named profile has its own user-only "),
            code("CODEX_HOME"),
            text(". Codex app-server owns login and token refresh; HRA does not copy or parse provider credentials."),
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
          text(" returns status version 2. HRA produces one typed provider-observation result, attempting a Codex app-server read only when the current local state makes one applicable, then reads the session, event cut, interactions, and queue from one local SQLite transaction. Execution, attention, provider, and queue remain separate axes, so a headline state cannot hide a recovery condition, pending interaction, response in flight, or queued work. Pending and response-in-flight counts are exact. The result includes at most 10 bounded safe summaries for pending interactions and excludes the session note and private provider thread binding. Every provider turn and item identifier becomes a secret-keyed opaque public alias before status, event, or interaction output. Public observation schemas accept only that exact alias form. The same local installation key keeps aliases coherent across surfaces and daemon restarts without making low-entropy provider IDs guessable from public output. If an existing installation loses that key, HRA refuses to replace it and directs the operator to restore the original local secret."),
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
            "hra session watch <session> --cursor <cursor>",
            "hra session watch <session> --cursor <cursor> --jsonl",
            "hra session events <session> --cursor <cursor> --limit <1-200> --wait-ms <0-30000> --json",
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
          text("; ordinary stdout receives only safe binding and cleanup metadata. On macOS, neither the directory nor file may have an extended ACL, and HRA rechecks both held descriptors before and after writing. Detail larger than 64 KiB also requires this file path. Read it within that protected boundary and remove it after deciding. HRA rejects file-change approval callbacks before durable admission because pinned Codex 0.149.0 does not provide the exact affected paths or change detail needed for informed approval."),
        ),
      ],
    },
    {
      id: "presets-and-permissions",
      heading: "Presets and permissions",
      blocks: [
        paragraph(
          text("HRA refreshes the requested model, reasoning effort, Fast service tier, permission profile, computer-use capability, and enabled accessible apps immediately before each new thread or turn. An unavailable requirement fails before the provider effect. Every successful start records that exact account generation and effective profile; "),
          code("hra session show"),
          text(" displays it with the condensed transcript. An empty enabled-app list is reported as empty. Codex app-server remains authoritative for permissions, tools, computer use, and plugins."),
        ),
        list(
          [code("low"), text(": Luna Max, currently "), code("gpt-5.6-luna"), text(" with "), code("max"), text(" reasoning.")],
          [code("high"), text(": Sol Max, currently "), code("gpt-5.6-sol"), text(" with "), code("max"), text(" reasoning.")],
          [code("ultra"), text(": Sol Ultra, currently "), code("gpt-5.6-sol"), text(" with "), code("ultra"), text(" reasoning.")],
          [code("fast on|off"), text(": an explicit per-turn Fast or Standard overlay. A prior Fast value cannot leak into the next turn.")],
        ),
        paragraph(
          code("hra init"),
          text(" reports the required confirmation without changing local state; "),
          code("hra init --yes"),
          text(" creates your Documents directory when it is absent, verifies that it is a readable, writable, and traversable canonical directory, and accepts it as the default project. Initialization is a one-shot maintenance command: run it before opening the persistent shell. The shell rejects "),
          code("/init"),
          text(" because its running daemon already owns local state. Turns use Codex's "),
          code("auto_review"),
          text(" path, the exact advertised "),
          code(":workspace"),
          text(" permission profile, and the selected project as the runtime workspace root. Codex remains authoritative for the profile's effective sandbox and network policy and computer use."),
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
          text("Pinned Codex 0.149.0 has no safely separated install, enablement, and OAuth lifecycle surface: its available lifecycle path can combine installation with enablement and may then open browser authorization. HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects. The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission. Other standard MCP forms are brokered only when their pinned schema fits HRA's closed primitive-field contract. The interaction exposes bounded field names, types, requiredness, constraints, and allowed choices; titles, descriptions, defaults, and answers stay off the public and durable display. Protected submissions are checked for exact required fields, types, bounds, formats, choices, and the absence of additional properties before response preparation. Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission and receive a safe unsupported-capability response with no schema, submitted value, or URL echo. The schema-11 security migration terminalizes and replaces any prerelease URL record before interaction reads. HRA will keep extended-form and URL handoff unavailable until each has a closed protected path."),
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
          text("The machine that created a provider session remains its only executor in v1. It must be online with its HRA daemon running and must hold the current execution lease before a remote command can affect Codex. Other paired machines never execute that provider session through their own local Codex profile."),
        ),
        paragraph(
          text("Paired machines can read the encrypted projection and submit bounded send, queue, steer, stop, preset, and Fast commands. The origin daemon claims each command by lease generation and idempotency key. Commands remain pending within their deadline while the origin machine is offline; another machine cannot take over or become a second provider writer."),
        ),
        paragraph(
          code("hra remote show"),
          text(" includes observation-only interaction events with a public interaction ID, kind, state, revision, blocking status, and bounded safe summary. Provider request IDs, permission values, MCP fields, protected answers, and response digests remain local. Resolve a pending callback on its execution device; remote interaction responses are unavailable in v1."),
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
            "hra remote preset <cloud-session> <low|high|ultra>",
            "hra remote fast <cloud-session> <on|off>",
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
            "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
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
            "hra device list|pair",
            "hra device key-loss --acknowledge-no-key-holders",
            "hra device approve|revoke <device-id-or-prefix> [--idempotency-key <current-uuidv7>]",
            "hra account add <label>",
            "hra account login <profile> [--device-code] [--handoff-file <absolute-path>] [--idempotency-key <uuid>]",
            "hra account login-cancel <profile>",
            "hra account logout <profile>",
            "hra account list",
            "hra account show <profile>",
            "hra account usage [profile] [--refresh]",
            "hra account usage-history <profile> [--from <UTC-RFC3339>] [--through <UTC-RFC3339>] [--limit <1-100>] [--cursor <cursor>]",
            "hra account switch <profile>",
            "hra account switch-recover",
            "hra plugin list <account> [--project <project>] [--refresh]",
            "hra plugin show <account> <plugin> [--project <project>] [--refresh]",
            "hra project add --path <directory> [--name <name>]",
            "hra project list",
            "hra project use <project>",
            "hra session list [--account <profile>] [--limit <1-100>] [--cursor <cursor>]",
            "hra session show <session> [--detail]",
            "hra session status <session> [--json]",
            "hra session watch <session> [--cursor <cursor>] [--jsonl]",
            "hra session events <session> [--cursor <cursor>] [--limit <1-200>] [--wait-ms <0-30000>] [--json|--jsonl|--follow]",
            "hra session interactions <session> [--pending] [--limit <1-100>] [--cursor <cursor>]",
            "hra session start <account> [--project <project>] [--preset <low|high|ultra>] [--fast]",
            "hra session send|queue|steer <session> <message>",
            "hra session stop <session>",
            "hra session rename <session> <name>",
            "hra session recover|abandon <session>",
            "hra session note get|edit|clear <session>",
            "hra session note set <session> <note>",
            "hra session preset <session> <low|high|ultra>",
            "hra session fast <session> <on|off>",
            "hra session project <session> <project>",
            "hra work protocol [--operation <kind>|--type <name>|--topic <topic>]",
            "hra work apply --input-stdin|--input-fd <fd>",
            "hra work snapshot <work> [--actor <session>]",
            "hra work task <task> [--history-limit <1..50>] [--history-cursor <cursor>]",
            "hra work poll <work> [--actor <session>] [--cursor <event-cursor>] [--action-cursor <action-cursor>] [--limit <1-50>] [--wait-ms <0-30000>]",
            "hra work events <work> [--cursor <cursor>] [--limit <1-200>] [--wait-ms <0-30000>] [--json|--jsonl|--follow]",
            "hra work watch <work> [--cursor <cursor>]",
            "hra interaction list [session] [--pending] [--limit <1-100>] [--cursor <cursor>]",
            "hra interaction show <interaction-id>",
            "hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]",
            "hra interaction decide <interaction-id> --revision <n> --decision <once|session|decline|cancel>",
            "hra interaction grant|answer <interaction-id> --revision <n> --input-stdin|--input-fd <fd>",
            "hra interaction submit <interaction-id> --revision <n> --action <accept|decline|cancel> [--input-stdin|--input-fd <fd>]",
            "hra remote list [--limit <1-100>]",
            "hra remote show <cloud-session>",
            "hra remote command <uuidv7>",
            "hra remote send|queue|steer <cloud-session> <message>",
            "hra remote stop <cloud-session>",
            "hra remote preset <cloud-session> <low|high|ultra>",
            "hra remote fast <cloud-session> <on|off>",
            "hra turn inspect <session> <turn> [--json]",
            "hra sync status|now",
            "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
            "hra daemon start|status|stop|run",
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
          text(" through protected input. The live Codex adapter rehydrates selected permission names to their exact private provider values immediately before the response write; those values never enter display, storage, logs, or sync."),
        ),
        paragraph(
          text("Every admitted callback carries a local deadline anchored when Codex delivered it. HRA caps the pending interval at 30 minutes and honors a shorter valid provider interval, including an immediate zero interval. At the deadline it writes one provider-neutral timeout error through the same write-ahead ledger, never invents an answer or grant, and quarantines the provider generation if the write may have escaped. "),
          code("interaction show"),
          text(" displays the safe local deadline; encrypted remote interaction metadata does not include it."),
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
          text(" asks Codex app-server to remove that profile's provider login while HRA preserves its local session history."),
        ),
      ],
    },
    {
      id: "authority-boundaries",
      heading: "Authority boundaries",
      blocks: [
        paragraph(
          text("Codex app-server remains authoritative for provider login, transcripts, turns, tools, approvals, models, plugins, and usage. HRA owns isolated profiles, durable commands, process generations, local projections, optional encrypted sync, and recovery records. The frozen work contract assigns local coordination records to HRA rather than Codex app-server."),
        ),
        paragraph(
          text("Cloud service availability is not required for local login, local execution, local work coordination, local recovery, or reading local sessions. Multiple Codex accounts remain independent subscriptions. HRA does not pool quota or replay a limited turn under another account. SQLite remains the local work execution authority; Turso is deferred and non-authoritative."),
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

  return [
    `# ${content.productName}`,
    `\`\`\`sh\n${content.installCommand}\n\`\`\``,
    `\`\`\`sh\n${content.doctorCommand}\n\`\`\``,
    `\`\`\`sh\n${content.initCommand}\n\`\`\``,
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
    "This policy describes the HRA v0.1 beta data boundary. The hosted sync service is beta-not-yet-live.",
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
    `Install after the v0.1.0 beta tag is live: ${content.installCommand}`,
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
    "## Reading",
    "",
    `- [Reading index](${content.siteUrl}/reading/)`,
    ...readingPages.map(
      (page) => `- [${page.title}](${content.siteUrl}${page.canonicalPath})`,
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
  const urls = siteDocumentPaths.map((path) => {
    const image = editorialImage(path);
    const imageMarkup = image === undefined ? "" : `
    <image:image>
      <image:loc>${escapeXml(editorialImageUrl(image))}</image:loc>
      <image:title>${escapeXml(image.title)}</image:title>
      <image:caption>${escapeXml(image.caption)}</image:caption>
    </image:image>`;
    return `  <url>
    <loc>${escapeXml(`${content.siteUrl}${path}`)}</loc>${imageMarkup}
  </url>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
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
