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

export const publicReleaseState: "release-ready" | "staged" = "staged";

export const publicContent: PublicContent = {
  productName: "HRA",
  description: "A persistent Bun CLI for isolated Codex accounts, live sessions, safe macOS account switching, and optional encrypted sync.",
  siteUrl: "https://hra.sh",
  installCommand: "bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz",
  initCommand: "hra init",
  doctorCommand: "hra doctor --offline",
  endpoints: {
    betaTag: "beta-not-yet-live",
    githubRepository: "live",
    hostedSync: "beta-not-yet-live",
    website: "beta-not-yet-live",
  },
  links,
  introduction: [
    {
      kind: "notice",
      label: "Beta not yet live",
      content: [
        text("The "),
        code("v0.1.0"),
        text(" tag and hosted sync service are beta-not-yet-live. The install command becomes usable when the beta tag is published."),
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
      id: "install-update-and-remove",
      heading: "Install, update, and remove",
      blocks: [
        paragraph(
          text("HRA requires Bun 1.3.14. The CLI and local daemon support macOS and Linux; supported ChatGPT desktop account switching is macOS-only. Install one reviewed immutable tag, then verify the binary before initialization:"),
        ),
        {
          kind: "commands",
          commands: [
            "bun --version",
            "bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz",
            "hra --version",
            "hra doctor --offline",
          ],
        },
        paragraph(
          text("Before replacing the installed binary, stop the persistent daemon and confirm that its old process has released authority. The command below performs a verified repair installation of v0.1.0. For a future update, replace both v0.1.0 occurrences in the URL with the exact reviewed release version, verify it, then restart explicitly. Do not install a moving branch for a release machine:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra daemon stop",
            "hra daemon status --json",
            "bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz",
            "hra --version",
            "hra doctor --offline",
            "hra daemon start",
          ],
        },
        paragraph(
          text("Removing the package does not remove HRA's local profiles, session history, recovery evidence, or cloud account. Log out each Codex profile and complete any intended cloud-account deletion before uninstalling. Then stop the daemon, confirm that it is stopped, and remove the installed command:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra daemon stop",
            "hra daemon status --json",
            "bun remove --global hra",
          ],
        },
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
          ],
        },
        paragraph(
          text("Use "),
          code("hra account login personal --device-code"),
          text(" when you want the provider's supported device-code path. Otherwise, follow the interactive instructions printed by the CLI. HRA keeps the resulting provider state inside that profile's isolated "),
          code("CODEX_HOME"),
          text(" without copying "),
          code("auth.json"),
          text("."),
        ),
        paragraph(
          text("If the first pending-login handoff is lost or the daemon restarts before completion, "),
          code("hra account show personal"),
          text(" reports the pending attempt. Then run "),
          code("hra account login-cancel personal"),
          text(". A caller that retained the idempotency key may also retry it without redispatching. HRA cancels only that profile's exact current-generation provider login before allowing a fresh login. Verification URLs, device codes, and provider credentials are never retained."),
        ),
        paragraph(
          text("HRA cloud identity is separate from every Codex account. Use the email-code flow below only after a hosted or self-managed Convex deployment has been configured."),
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
          text(" selects HRA's hosted deployment. Set it to an explicit empty value before the first daemon starts to disable cloud transport. A nonempty HTTPS value selects a self-managed Convex deployment. The first valid selection permanently binds that local state root; a later mismatch fails closed instead of moving credentials or recovery state. HRA accepts cloud credentials only as protected JSON on standard input or a nonterminal file descriptor. It rejects email addresses, identity invites, and verification codes on the command line:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra auth login --input-stdin",
            "hra auth login --input-fd <fd>",
            "hra device pair",
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
          text("After successful email verification, the daemon automatically registers the current installation before it reads cloud data. The first registered device becomes active and creates the client-side encryption key. A later verified installation is registered as pending and may report presence, but it has no synchronized data, execution, or key authority."),
        ),
        paragraph(
          text("On an already active machine, list devices and approve the pending device by its exact ID or unique prefix:"),
        ),
        {
          kind: "commands",
          commands: [
            "hra device list",
            "hra device approve <pending-device-id-or-prefix>",
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
          text("Device credentials are bearer credentials, not hardware-bound proofs. Connection and generation fencing blocks a copied credential from creating a second concurrent connection or surviving revocation, but an uncontested, unrevoked copy can impersonate that device until it is detected and revoked."),
        ),
        paragraph(
          text("Cloud-account erasure is explicit and irreversible. Run "),
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
            text("Usage with provenance: account identity, quota, rate-limit, and token snapshots include their provider source time and freshness."),
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
          text(" in a TTY to open a persistent shell. Account and session selections stay in the prompt, protected answers are read without terminal echo, and "),
          code("/exit"),
          text(" leaves the daemon running. One-shot commands provide the same control surface to scripts and agents."),
        ),
        {
          kind: "commands",
          commands: [
            "hra",
            "hra session status <session> --json",
            "hra session events <session> --cursor <cursor> --limit <1-200> --wait-ms <0-30000> --json",
            "hra session events <session> --cursor <cursor> --wait-ms 30000 --follow",
            "hra session interactions <session> --pending --json",
          ],
        },
        paragraph(
          text("JSON mode writes one versioned document to stdout and diagnostics to stderr. Event following writes JSON Lines as the turn progresses. Signed opaque cursors let an agent resume bounded event pages, and durable interaction records keep approvals, questions, permission grants, and MCP form elicitation visible until they are explicitly resolved."),
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
          text(" asks before making your canonical Documents directory the default project; "),
          code("hra init --yes"),
          text(" accepts that default non-interactively. Turns use Codex's "),
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
            "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <current-uuidv7>] [--json]",
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
          text("The CLI creates a current UUIDv7 before daemon transport. Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command. Reuse that command after a lost response. Changed-key retry remains closed while the first recovery is unsettled."),
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
            "hra doctor [--offline] [--json]",
            "hra auth login --input-stdin|--input-fd <fd>",
            "hra auth status|logout",
            "hra auth delete --acknowledge-erasure",
            "hra device list|pair",
            "hra device approve|revoke <device-id-or-prefix>",
            "hra account add <label>",
            "hra account login <profile> [--device-code]",
            "hra account login-cancel <profile>",
            "hra account logout <profile>",
            "hra account list",
            "hra account show <profile>",
            "hra account usage [profile] [--refresh]",
            "hra account switch <profile>",
            "hra account switch-recover",
            "hra plugin list <account> [--project <project>] [--refresh]",
            "hra plugin show <account> <plugin> [--project <project>] [--refresh]",
            "hra project add --path <directory> [--name <name>]",
            "hra project list",
            "hra project use <project>",
            "hra session list [--account <profile>] [--limit <1-100>]",
            "hra session show <session> [--detail]",
            "hra session status <session>",
            "hra session events <session> [--cursor <cursor>] [--limit <1-200>] [--wait-ms <0-30000>] [--follow]",
            "hra session interactions <session> [--pending] [--limit <1-100>]",
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
            "hra interaction list [session] [--pending] [--limit <1-100>]",
            "hra interaction show <interaction-id>",
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
            "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <current-uuidv7>] [--json]",
            "hra daemon start|status|stop|run",
          ],
        },
        paragraph(
          text("Account, project, and local-session selectors accept an exact ID or an unambiguous case-insensitive label. Cloud-session selectors accept an exact public ID, a unique public-ID prefix, or an exact synced name. Device selectors accept an exact ID or unique prefix. Ambiguity lists candidates and performs no effect. The CLI creates and sends an idempotency key before every provider effect; pass "),
          code("--idempotency-key <uuid>"),
          text(" to reuse one after a lost response. session recover accepts only exact, kind-specific provider proof. session abandon never retries or deletes provider state and releases only the local recovery authority. Remote mutations require a current UUIDv7 when this option is supplied. With "),
          code("--json"),
          text(", stdout contains one versioned object; diagnostics stay on stderr."),
        ),
        paragraph(
          code("interaction show"),
          text(" lists each requested permission category and each exact question ID. A permission grant reads "),
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
          text(" and a current UUIDv7, generated by the CLI when omitted. The same-key command is safe to replay after a lost response; a changed key cannot overtake unsettled recovery authority."),
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
          text("Codex app-server remains authoritative for provider login, transcripts, turns, tools, approvals, models, plugins, and usage. HRA owns isolated profiles, durable commands, process generations, local projections, optional encrypted sync, and recovery records."),
        ),
        paragraph(
          text("Cloud service availability is not required for local login, local execution, local recovery, or reading local sessions. Multiple Codex accounts remain independent subscriptions. HRA does not pool quota or replay a limited turn under another account."),
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
  ].join("\n");

export const findSection = (content: PublicContent, id: string): ContentSection => {
  const section = content.sections.find((candidate) => candidate.id === id);
  if (section === undefined) {
    throw new Error(`Unknown public content section: ${id}`);
  }
  return section;
};
