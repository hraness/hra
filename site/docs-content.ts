import {
  admittedReleaseVersion,
  findSection,
  isAdmittedRelease,
  publicContent,
  publicPins,
  releaseAdmissionNotice,
  renderMarkdownBlocks,
  type ContentBlock,
  type ContentSection,
  type InlineContent,
} from "./content.ts";

export type DocsPath = "/docs/" | "/docs/start/" | "/docs/web/" | "/docs/sessions/" | "/docs/reference/" | "/docs/status/";

export interface DocsAdmission {
  readonly owner: string;
  readonly checkedOn: string;
  readonly reassessOn: string;
  readonly decision: "keep";
  readonly readerJob: string;
  readonly contribution: string;
  readonly overlapDecision: string;
  readonly evidence: readonly string[];
  /** Utility, original evidence, confidence, host fit, voice, maintenance. */
  readonly scores: readonly [number, number, number, number, number, number];
}

export interface DocsPage {
  readonly path: DocsPath;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly reviewDate: string;
  readonly sections: readonly ContentSection[];
  /** Existing detailed contracts stay canonical and retain their section IDs. */
  readonly referenceSectionIds: readonly string[];
  readonly related: readonly Readonly<{ path: string; label: string }>[];
  readonly previewId?: "overview" | "conversation" | "question" | "settings";
  readonly admission: DocsAdmission;
}

const text = (value: string): InlineContent => ({ kind: "text", value });
const code = (value: string): InlineContent => ({ kind: "code", value });
const link = (label: string, href: string): InlineContent => ({ kind: "link", label, href });
const paragraph = (...content: readonly InlineContent[]): ContentBlock => ({ kind: "paragraph", content });
const commands = (...values: readonly string[]): ContentBlock => ({ kind: "commands", commands: values });
const list = (...items: readonly (readonly InlineContent[])[]): ContentBlock => ({ kind: "list", items });
const source = (path: string): string => `https://github.com/hraness/hra/blob/main/${path}`;

const candidateInstallNotice: ContentBlock = {
  kind: "notice",
  label: isAdmittedRelease(publicContent.releaseVersion)
    ? "CLI artifact admitted; daemon startup blocked"
    : "Candidate artifact not yet admitted",
  content: [
    text(isAdmittedRelease(publicContent.releaseVersion)
      ? `The admitted v${admittedReleaseVersion} artifact may be installed with the command below.`
      : publicContent.installNotice),
    text(" Read the "),
    link("admitted release installation notes", publicContent.links.admittedInstall),
    text(isAdmittedRelease(publicContent.releaseVersion)
      ? ` for v${admittedReleaseVersion}, or use its `
      : ` for v${admittedReleaseVersion}. Only after immutable GitHub release admission may you run the candidate install command below. For the admitted v${admittedReleaseVersion} artifact, you can also use its `),
    link("immutable README", `https://github.com/hraness/hra/tree/v${admittedReleaseVersion}#get-started`),
    text(". Neither artifact admission nor installation authorizes daemon startup."),
  ],
};

const setupNotice: ContentBlock = {
  kind: "notice",
  label: "Before you start a daemon",
  content: [
    text(`${isAdmittedRelease(publicContent.releaseVersion) ? `The v${publicContent.releaseVersion} CLI artifact is admitted for installation.` : `The v${publicContent.releaseVersion} candidate is not yet admitted. Install it only after its own immutable GitHub release admission.`} Initialization, daemon startup, and hosted command writers remain blocked on capacity. Complete the `),
    link("rollout and update prerequisites", "/docs/status/#install-and-update"),
    text(" before the steps below. Installing the CLI or opening the app does not clear that gate."),
  ],
};

/**
 * Product documentation, not a second command or policy authority. Every guide
 * owns one reader task and points to the shared, exact reference when needed.
 * Admission reasoning is authored per page before the page enters discovery.
 */
export const docsPages: readonly DocsPage[] = [
  {
    path: "/docs/",
    title: "HRA documentation",
    description: "Set up HRA, follow your coding sessions in the web app, and use the terminal or CLI when you need more control.",
    keywords: ["guides", "browser", "CLI", "getting started"],
    reviewDate: "2026-09-08",
    admission: {
      owner: "Hraness",
      checkedOn: "2026-09-08",
      reassessOn: "2026-10-20",
      decision: "keep",
      readerJob: "Choose the right HRA guide without first reading the command catalog.",
      contribution: "A task map separates browser supervision, local setup, conversation management, automation, and current availability using HRA's actual entry points.",
      overlapDecision: "The homepage explains the product; Start is a procedure; Reference is an interface catalog. This index connects those different tasks without repeating their procedures.",
      evidence: ["app/src/routing/route.ts", "src/cli/parser.ts", "site/content.ts"],
      scores: [2, 2, 2, 2, 2, 2],
    },
    sections: [
      {
        id: "choose-your-next-step",
        heading: "What do you want to do?",
        blocks: [
          list(
            [link("Set up HRA", "/docs/start/"), text(": install the CLI, connect a provider account, and open your first session.")],
            [link("Use the web app", "/docs/web/"), text(": pair a browser, follow the session grid, and send the next instruction.")],
            [link("Manage sessions and accounts", "/docs/sessions/"), text(": continue a conversation, switch providers, inspect usage, or recover a stopped flow.")],
            [link("Find a command", "/docs/reference/"), text(": look up CLI families, machine-readable output, memory, and automation.")],
            [link("Check availability", "/docs/status/"), text(": distinguish the released CLI from runtime rollout and provider support.")],
          ),
        ],
      },
      {
        id: "three-parts-of-hra",
        heading: "Your machine runs the work. You choose the interface.",
        blocks: [
          paragraph(text("HRA keeps Codex and Claude Code sessions on the machine that runs them. The web app shows their synchronized state; the terminal and CLI address the same local accounts and conversations. Other devices can send commands, but do not take over execution.")),
          list(
            [code("Provider account"), text(": your Codex or Claude Code sign-in, owned by that provider and used on the execution machine.")],
            [code("HRA identity"), text(": an email sign-in for optional encrypted sync and paired devices. It does not sign you into a provider.")],
            [code("Session"), text(": one HRA conversation with an account, project, and execution machine. Changing its provider does not move a provider-native thread.")],
          ),
          paragraph(text("Local use does not require an HRA cloud identity. The web app does require sync, an approved machine, and a paired browser. "), link("Current setup limits", "/docs/status/"), text(" apply to either route.")),
        ],
      },
    ],
    referenceSectionIds: ["project"],
    related: [{ path: "/docs/start/", label: "Start with one machine" }, { path: "/docs/web/", label: "Explore the web app" }],
  },
  {
    path: "/docs/start/",
    title: "Set up HRA",
    description: "Find the admitted CLI and this candidate's installation limits, then follow the first-run path only when artifact admission and rollout prerequisites are satisfied.",
    keywords: ["install", "setup", "login", "first session", "Bun"],
    reviewDate: "2026-09-09",
    admission: {
      owner: "Hraness",
      checkedOn: "2026-09-09",
      reassessOn: "2026-10-06",
      decision: "keep",
      readerJob: "Install HRA safely and understand the shortest path to a first local conversation.",
      contribution: "An ordered installer-to-session path separates the immutable admitted predecessor from the unavailable candidate installer and puts the still-closed startup boundary before the first state-changing setup command.",
      overlapDecision: "The homepage offers a product overview, Sessions covers an existing setup, and Status owns upgrade and rollout detail. This page alone owns first-run order.",
      evidence: ["src/install-preflight.ts", "src/cli/parser.ts", "site/content.ts", "docs/beta-release-notes.md"],
      scores: [2, 2, 2, 2, 2, 1],
    },
    sections: [
      {
        id: "install",
        heading: "1. Install and check the CLI",
        blocks: [
          candidateInstallNotice,
          commands(publicContent.installCommand),
          paragraph(text(`Only after exact artifact admission, use macOS or Linux with Bun ${publicPins.bun} and curl to install v${publicContent.releaseVersion}. The installer verifies the immutable release before replacing the HRA command. It does not start the daemon.`)),
          commands("hra --version", publicContent.doctorCommand),
          paragraph(text("Already using HRA? Follow the "), link("update runbook", "/docs/status/#install-and-update"), text(" before changing a daemon or restoring local state. Do not apply first-run instructions to an existing installation.")),
        ],
      },
      {
        id: "connect-an-account",
        heading: "2. Connect a provider account",
        blocks: [
          setupNotice,
          paragraph(text("After the rollout prerequisites are satisfied, run these as separate commands in a foreground terminal. Initialization sets up the local state and a default project. Name your profile, then let Codex complete its own device-code sign-in.")),
          commands(publicContent.initCommand, "hra account add personal", "hra account login personal --provider codex --device-code"),
          paragraph(text("For Claude Code on Linux, use "), code("hra account login personal --provider claude"), text(" instead. Claude owns its terminal prompts and browser handoff. Managed Claude login and execution are not available on macOS, and Claude has no HRA browser-linking flow.")),
          paragraph(text("Provider login is a one-shot command, not a command inside HRA's persistent shell. HRA never asks you to paste a provider credential. "), link("Account status and login recovery", "/docs/sessions/#accounts"), text(" cover an interrupted sign-in.")),
        ],
      },
      {
        id: "open-a-conversation",
        heading: "3. Start a conversation",
        blocks: [
          paragraph(text("With setup complete and your provider signed in, start a session. Keep the session ID returned by the first command. Open HRA's shell and select that exact session before writing your request.")),
          paragraph(text("If you signed in to Claude Code, replace the first command below with "), code("hra session start personal --provider claude --preset fable-max"), text(". The remaining shell steps are the same.")),
          commands("hra session start personal --provider codex", "hra", "/account personal", "/session <session-id>", "Review this project and summarize its current state."),
          paragraph(text("Type "), code("/exit"), text(" to leave the shell. The daemon keeps the session running. Return later, select the same account and session, and continue.")),
          paragraph(text("To use a specific repository, register it with "), code("hra project add --path <directory> --name <name>"), text(" and select it with "), code("hra project use <project>"), text(" before starting the session.")),
        ],
      },
      {
        id: "add-your-browser",
        heading: "4. Add the web app when you want it",
        blocks: [
          paragraph(text("You can stay local, or connect your HRA identity and approve a browser to see sessions away from the terminal. The "), link("web app guide", "/docs/web/"), text(" walks through email sign-in, device approval, and the session grid.")),
        ],
      },
    ],
    referenceSectionIds: [],
    related: [{ path: "/docs/web/", label: "Pair a browser" }, { path: "/docs/status/", label: "Release and setup status" }],
  },
  {
    path: "/docs/web/",
    title: "Use the web app",
    description: "Pair a browser, see which sessions need you, and direct work on your own machines from the session grid.",
    keywords: ["web app", "browser", "pairing", "grid", "settings", "questions"],
    reviewDate: "2026-09-09",
    previewId: "overview",
    admission: {
      owner: "Hraness",
      checkedOn: "2026-09-09",
      reassessOn: "2026-10-06",
      decision: "keep",
      readerJob: "Enroll a browser and use HRA's real grid, conversation, and Settings screens without mistaking a browser for an execution machine.",
      contribution: "A screen-by-screen guide joins the app's actual enrollment states, target picker, composer, and remote interaction policy into a usable first browser journey.",
      overlapDecision: "Start owns local installation, Sessions owns CLI conversation operations, and the deployment runbook addresses operators. None explains everyday browser use.",
      evidence: ["app/src/custody/enrollment-screen.tsx", "app/src/screens/grid-screen.tsx", "app/src/screens/session-screen.tsx", "app/src/screens/settings-screen.tsx", "src/domain/remote-interaction-policy.ts"],
      scores: [2, 2, 2, 2, 2, 1],
    },
    sections: [
      {
        id: "pair-your-browser",
        heading: "Pair your browser with an approved machine",
        blocks: [
          setupNotice,
          paragraph(text("First-time machine setup belongs in "), link("Set up HRA", "/docs/start/"), text(". On a configured, eligible machine, complete HRA's "), link("protected email-code sign-in", "/docs/web/#cloud-sign-in-and-device-pairing"), text(" with "), code("hra auth login --input-stdin"), text(". Each invocation reads one protected JSON document; the linked instructions show how to request and verify a code. Complete machine sign-in before enrolling the browser. Your provider sign-in is separate.")),
          paragraph(text("Open "), link("app.hra.sh", "https://app.hra.sh/"), text(" and sign in with your HRA email and one-time code. Use the same identity as your execution machine. A browser cannot be the first device on an account or approve another device.")),
          list(
            [text("Choose Enroll this browser. HRA generates this browser's device keys and shows a fingerprint.")],
            [text("On an already approved machine, list devices and compare the browser fingerprint before approving its exact device ID.")],
            [text("Return to the waiting browser and choose Check again. Once approved and unlocked, it can decrypt your synchronized sessions.")],
          ),
          commands("hra device list", "hra device approve <pending-device-id-or-prefix> --fingerprint <value>"),
          paragraph(text("Email access alone cannot recover encrypted history. Keep an approved device with the account key. The browser drops its unwrapped account key when locked; "), code("Ctrl+L"), text(" also locks the app.")),
        ],
      },
      {
        id: "read-the-grid",
        heading: "See what needs you",
        blocks: [
          paragraph(text("The grid shows your conversations as cards with their latest activity and a named state: Working, Needs an answer, Needs approval, or Done. Sessions needing attention come first. Open a card to read the conversation; drag cards to keep your preferred arrangement.")),
          paragraph(text("With no session selected, the composer starts a new conversation on the account and project you choose. With a session selected, it sends to that conversation. Only registered targets with the necessary local permissions appear. Claude targets require a Linux execution machine.")),
          paragraph(text("The execution machine must be running and eligible before it can apply a command. An offline command can remain pending until its deadline; opening this page does not move the session to your browser. "), link("Current rollout status", "/docs/status/"), text(" determines whether new commands are available.")),
        ],
      },
      {
        id: "direct-a-session",
        heading: "Read, answer, and send the next instruction",
        blocks: [
          paragraph(text("Inside a session, follow the transcript and send your next message. HRA lets the execution machine decide whether to begin a turn or steer the active one. Stop is available while a turn is running. The session menu offers model presets, Codex Fast mode, approval settings, and eligible provider changes.")),
          paragraph(text("Attach supported images or text files by picking, pasting, or dropping them into an existing conversation. A new session starts with text only. Other devices see attachment names and metadata, not a copy of the original file or image.")),
          paragraph(text("A supported, non-secret multiple-choice question can be answered here. Command, file-change, and permission requests can be declined remotely; accepting them, granting permission, typing a free-text or Other answer, and completing MCP forms stay on the execution machine. Follow the interaction's local instruction when the browser cannot act.")),
        ],
      },
      {
        id: "use-settings",
        heading: "Find machines, accounts, and history in Settings",
        blocks: [
          list(
            [text("Machines show published defaults and projects. Changes travel as commands to that machine, so wait for the confirmed result.")],
            [text("Accounts show provider sign-in status. Codex can offer Link here after the machine enables "), code("hra remote allow account-linking"), text(". Claude sign-in stays in a foreground terminal on Linux.")],
            [text("Memory and peer activity show read-only summaries, coverage, and recent activity. The browser does not edit memory pages.")],
            [text("Archived sessions remain readable and can be restored to the grid. Scheduled tasks are read-only here; create or edit them with the CLI.")],
            [text("Devices show enrollment state. Approve or revoke a device from an active machine, not from this browser.")],
          ),
        ],
      },
    ],
    referenceSectionIds: ["cloud-sign-in-and-device-pairing", "sessions-across-machines"],
    related: [{ path: "/docs/sessions/", label: "Session and account operations" }, { path: "/privacy/", label: "Privacy and encryption" }],
  },
  {
    path: "/docs/sessions/",
    title: "Sessions and accounts",
    description: "Inspect account status and usage, continue a conversation, switch providers, and handle interrupted work without duplicating it.",
    keywords: ["account", "session", "usage", "switch", "recovery", "transcript"],
    reviewDate: "2026-09-09",
    previewId: "conversation",
    admission: {
      owner: "Hraness",
      checkedOn: "2026-09-09",
      reassessOn: "2026-10-20",
      decision: "keep",
      readerJob: "Operate an existing HRA conversation and know which identity, provider, and recovery action it belongs to.",
      contribution: "A practical command sequence connects account status, explicit provider switching, retained conversation history, and exact interrupted-operation recovery.",
      overlapDecision: "Start ends at a first conversation, Web explains screen controls, and Reference lists complete syntax. This page owns the ongoing conversation workflow and its recovery decisions.",
      evidence: ["src/cli/parser.ts", "site/content.ts", "docs/providers/claude.md", "docs/facts-memory.md", "docs/attachments.md"],
      scores: [2, 2, 2, 2, 2, 2],
    },
    sections: [
      {
        id: "accounts",
        heading: "Check the account before starting work",
        blocks: [
          paragraph(text("Use these commands on an existing, initialized machine whose rollout prerequisites are satisfied. Each named profile isolates its managed provider configuration. Select the provider explicitly when checking sign-in state.")),
          commands("hra account list", "hra account show personal --provider codex", "hra account usage personal --refresh"),
          paragraph(text("Codex usage reports observed limits and resets; "), code("hra account usage-history personal --limit 50 --json"), text(" reads its retained local history. Claude exposes sign-in status, not account quotas or usage history. HRA does not pool subscription limits or automatically move a failed turn to another account.")),
          paragraph(text("A pending Codex login can be checked with "), code("hra account show personal --provider codex"), text(" and canceled with "), code("hra account login-cancel personal --provider codex"), text(". A lost one-time URL cannot be recovered by starting another login over the pending attempt. Claude recovery instead requires the exact acknowledged command reported by status, after you have confirmed the original login child exited.")),
        ],
      },
      {
        id: "continue-a-session",
        heading: "Continue the same conversation",
        blocks: [
          commands("hra session list", "hra session status <session-id> --json", "hra session send <session-id> -- \"Review the latest changes.\"", "hra session stop <session-id>"),
          paragraph(text("Use the returned session ID in scripts. A session name is convenient for people, but can change. For live observation, read "), code("data.eventStream.cursor"), text(" from status and pass that exact cursor to "), code("hra session watch <session-id> --cursor <status-cursor> --jsonl"), text(" so the status snapshot and subsequent events join without a gap.")),
          paragraph(text("Queue a message for later with "), code("hra session queue <session-id> -- <message>"), text(". Use "), code("hra session steer <session-id> -- <message>"), text(" for the current turn. The "), link("attachment contract", source("docs/attachments.md")), text(" lists accepted files and limits.")),
        ],
      },
      {
        id: "switch-providers",
        heading: "Change the provider for the next turn",
        blocks: [
          paragraph(text("When the session is idle and the target provider is signed in, switch it explicitly. Claude Code requires a Linux execution machine.")),
          commands("hra session switch <session-id> --provider claude --preset fable-max", "hra session export <session-id> --format json"),
          paragraph(text("The new provider receives the retained tail of HRA's conversation record. Its native thread, hidden state, and cached context do not transfer. HRA states a retention gap when older recorded history was pruned; it does not invent history from before a session was adopted.")),
          paragraph(text("Switching providers within the same account profile preserves the session's working-memory binding. An eligible manual switch to another account can transfer custody only after outstanding memory submissions settle. That transfer purges the old working lane and starts a fresh empty epoch; it does not carry working-memory contents across accounts. A failed transfer remains recoverable before the session is rebound. Shared project memory stays project-scoped. Presets control future turns and do not reinterpret an already-bound historical model until you select a preset.")),
        ],
      },
      {
        id: "recover-without-repeating-work",
        heading: "Inspect an interrupted operation before retrying",
        blocks: [
          paragraph(text("A lost connection is not proof that a command failed before taking effect. Keep the command ID and reuse the exact recovery command or idempotency key HRA reports. An ambiguous result needs inspection, not a new send.")),
          commands("hra status --json", "hra session status <session-id> --json", "hra remote command <uuidv7>", "hra sync status"),
          paragraph(text("A recovery-required session stays fenced while HRA cannot prove who owns the provider process. Do not delete state or launch a second writer to clear it. "), code("hra session abandon <session-id>"), text(" ends HRA's local session with provider state still unknown; use it only when you accept that consequence.")),
        ],
      },
    ],
    referenceSectionIds: ["first-account", "first-session", "presets-and-permissions", "desktop-account-switching"],
    related: [{ path: "/docs/reference/", label: "Complete command reference" }, { path: "/docs/status/#install-and-update", label: "Update and recovery runbook" }],
  },
  {
    path: "/docs/reference/",
    title: "CLI reference",
    description: "Find the right HRA command family, the machine-readable output contract, and the deeper guides for automation and memory.",
    keywords: ["commands", "JSON", "automation", "memory", "work", "help"],
    reviewDate: "2026-09-08",
    admission: {
      owner: "Hraness",
      checkedOn: "2026-09-08",
      reassessOn: "2026-10-20",
      decision: "keep",
      readerJob: "Locate exact CLI syntax and protocol contracts without searching through setup and marketing copy.",
      contribution: "A grouped entry to the command catalog retains help parity and directs advanced readers to the owned memory, interaction, and Work contracts.",
      overlapDecision: "Start and Sessions teach ordered tasks; Web teaches a graphical interface. A searchable exact command surface is a distinct reference job and remains the canonical syntax destination.",
      evidence: ["src/cli/parser.ts", "site/content.test.ts", "docs/facts-memory.md", "docs/session-adoption.md"],
      scores: [2, 2, 2, 2, 2, 2],
    },
    sections: [
      {
        id: "find-a-command",
        heading: "Start with command help",
        blocks: [
          commands("hra --help", "hra session --help", "hra help session send"),
          paragraph(text("Root help lists the command families. Group and command help give the accepted flags and examples. The full catalog below is checked against the CLI's group help.")),
          list(
            [code("account"), text(" and "), code("project"), text(": provider profiles, sign-in status, Codex usage, and local workspaces.")],
            [code("session"), text(": conversation lifecycle, messages, presets, provider changes, schedules, and exports.")],
            [code("interaction"), text(" and "), code("turn"), text(": local protected inspection and provider-specific approval or question handling.")],
            [code("auth"), text(", "), code("device"), text(", "), code("sync"), text(", and "), code("remote"), text(": HRA identity, encrypted pairing, synchronized views, and remote command receipts.")],
            [code("work"), text(" and "), code("memory"), text(": bounded local agent coordination and working or shared project memory.")],
            [code("status"), text(", "), code("doctor"), text(", and "), code("daemon"), text(": local health, prerequisites, and process lifecycle.")],
          ),
        ],
      },
      {
        id: "automation-output",
        heading: "Use structured output for automation",
        blocks: [
          paragraph(text("Supported one-shot commands use "), code("--json"), text(" for a versioned result. Session watching uses "), code("--jsonl"), text(" for an event stream. Read stdout as data and stderr as diagnostics; check the exit status and any bounded result diagnostics.")),
          paragraph(text("Secrets and protected interaction documents never belong in command-line arguments. Use the documented protected input descriptor or file for that command. Provider login has a separate foreground or protected-handoff flow; it is not an ordinary background JSON mutation.")),
          paragraph(text("For a lost mutation response, preserve its exact key and command ID. Changing a request under an existing key is rejected; submitting a new key can represent new work. Read the terminal and agent contract below before building a caller.")),
        ],
      },
      {
        id: "advanced-workflows",
        heading: "Go deeper when the task needs it",
        blocks: [
          list(
            [link("Working and project memory", source("docs/facts-memory.md")), text(": session-scoped notes, explicit sharing, and hosted memory boundaries.")],
            [link("Personal-session adoption", source("docs/session-adoption.md")), text(": opt in locally to bring eligible existing provider sessions into HRA.")],
            [link("Attachments", source("docs/attachments.md")), text(": supported media, byte limits, and what crosses a device boundary.")],
            [link("Cloud retention", source("docs/retention.md")), text(": retention windows and command-receipt recovery.")],
          ),
          paragraph(text("Recurring conversation tasks are created with "), code("hra session task"), text(" and stay bound to that session. The browser displays schedules but does not edit them. The separate "), code("hra work"), text(" protocol coordinates bounded local work; it is not cross-device execution or automatic provider failover.")),
        ],
      },
    ],
    referenceSectionIds: ["command-reference", "terminal-and-agent-interfaces", "agent-work-protocol", "features", "plugin-discovery"],
    related: [{ path: "/docs/sessions/", label: "Practical session workflows" }, { path: "/docs/status/", label: "Provider and release support" }],
  },
  {
    path: "/docs/status/",
    title: "Availability and release status",
    description: "Distinguish the v0.8.0 candidate from the admitted v0.7.1 CLI, check provider support, and understand the runtime rollout prerequisites.",
    keywords: ["release", "availability", "platforms", "Codex", "Claude", "upgrade"],
    reviewDate: "2026-09-09",
    admission: {
      owner: "Hraness",
      checkedOn: "2026-09-09",
      reassessOn: "2026-09-22",
      decision: "keep",
      readerJob: "Decide whether to install, initialize, upgrade, or use a provider without confusing released files with operational readiness.",
      contribution: "One current status explanation joins immutable artifact admission, platform support, and the separately guarded runtime rollout that previously overwhelmed the homepage.",
      overlapDecision: "Release records prove historical bytes and the operator runbook proves deployment authority. This page translates current evidence into an installation decision without replacing either proof.",
      evidence: ["docs/beta-release.md", "docs/hosted-sync.md", "docs/providers/claude.md", "site/content.ts", "src/claude/pin.ts"],
      scores: [2, 2, 2, 2, 2, 1],
    },
    sections: [
      {
        id: "current-release",
        heading: isAdmittedRelease(publicContent.releaseVersion)
          ? `v${publicContent.releaseVersion} artifacts are admitted. Daemon rollout remains blocked.`
          : `v${publicContent.releaseVersion} is a candidate. v${admittedReleaseVersion} remains admitted.`,
        blocks: [
          candidateInstallNotice,
          paragraph(text(`The v${admittedReleaseVersion} CLI passed immutable GitHub and npm artifact admission. ${isAdmittedRelease(publicContent.releaseVersion) ? "For its exact installation instructions, use the " : `The v${publicContent.releaseVersion} candidate is not yet admitted and requires its own immutable GitHub proof. For the admitted predecessor, use its `}`), link("immutable README", `https://github.com/hraness/hra/tree/v${admittedReleaseVersion}#get-started`), text(" to install and run "), code("hra doctor --offline"), text(". The public website, browser app, and open-beta sync service are available; their availability does not authorize starting the current daemon or sending new hosted commands.")),
          paragraph(text(`The v${publicContent.releaseVersion} ${isAdmittedRelease(publicContent.releaseVersion) ? "release" : "candidate"} retains the read-only exact Codex default-profile observation admitted in v0.7.1. The display remains unavailable until the intended daemon publishes a matching fresh companion after its rollout gates pass. This does not change Ultra defaults, admit models, choose a route, or authorize a command.`)),
          releaseAdmissionNotice,
          { kind: "notice", label: "Current runtime hold", content: [text(publicContent.daemonRolloutNotice)] },
          paragraph(text("The operator must complete protected capacity activation, then prove the current daemon and every intended target before enabling writers. Installing a release, signing in, or loading a fresh browser tab does not substitute for those proofs. "), link("Release record", source("docs/beta-release.md")), text(" · "), link("Hosted rollout procedure", source("docs/hosted-sync.md#converge-command-lifecycle-capacity-before-writer-rollout"))),
        ],
      },
      {
        id: "provider-support",
        heading: "Provider support",
        blocks: [
          list(
            [text(`Codex: macOS and Linux, through pinned Codex ${publicPins.codex}. Managed device-code sign-in, account usage and reset observations, and opt-in browser linking are implemented.`)],
            [text(`Claude Code: Linux for managed sign-in and execution, using an installed executable that reports the exact ${publicPins.claude} compatibility pin. HRA reports signed-in status only; quota, usage history, Fast mode, and browser linking are unavailable.`)],
            [text("macOS Claude: new managed effects remain disabled pending authenticated isolated-Keychain and detached-daemon acceptance. A discovered executable is not acceptance evidence.")],
            [text("Devin: retired. Historical records remain read-only; HRA does not start new Devin logins or sessions.")],
          ),
          paragraph(text("Providers own their accounts, billing, tools, and native execution. HRA's automated tests do not imply that every live provider and device flow has been qualified. "), link("Claude compatibility details", source("docs/providers/claude.md")), text(" record the remaining live checks.")),
        ],
      },
      {
        id: "before-an-upgrade",
        heading: "Before upgrading an existing machine",
        blocks: [
          paragraph(text("Use the ordered update runbook below. Preserve recovery evidence, obtain a successful daemon-stop authority release, and back up the complete private state as one unit before the upgrade boundary. Never launch an older daemon against state after a newer daemon has begun migrating it.")),
          paragraph(text("An interrupted installer belongs to its exact originating release. Do not remove the durable intent or retry with a different release. The runbook names the safe inspection and recovery path; local installation recovery does not authorize changing a release workflow.")),
        ],
      },
    ],
    referenceSectionIds: ["install-and-update", "authority-boundaries"],
    related: [{ path: "/docs/start/", label: "Install and check HRA" }, { path: source("docs/beta-release-notes.md"), label: "Release notes" }, { path: source("SECURITY.md"), label: "Security support policy" }],
  },
];

export const docsPaths: readonly DocsPath[] = docsPages.map((page) => page.path);

export const findDocsPage = (path: string): DocsPage | undefined =>
  docsPages.find((page) => page.path === path);

export const docsReferenceSections = (page: DocsPage): readonly ContentSection[] =>
  page.referenceSectionIds.map((id) => findSection(publicContent, id));

export const docsPathForSection = (id: string): string => {
  if (id === "privacy") return "/privacy/";
  const page = docsPages.find((candidate) => candidate.referenceSectionIds.includes(id));
  if (page === undefined) throw new Error(`No documentation page owns section: ${id}`);
  return `${page.path}#${id}`;
};

/** Complete, readable machine source for the same page, including its details. */
export const renderDocsMarkdown = (path: string): string => {
  const page = findDocsPage(path);
  if (page === undefined) throw new Error(`Unknown documentation page: ${path}`);
  const sections = [...page.sections, ...docsReferenceSections(page)];
  return [
    `# ${page.title}`,
    page.description,
    ...sections.map((section) => `## ${section.heading}\n\n${renderMarkdownBlocks(section.blocks, 3)}`),
    `## Next\n\n${page.related.map((item) => `- [${item.label}](${item.path})`).join("\n")}`,
  ].join("\n\n") + "\n";
};
