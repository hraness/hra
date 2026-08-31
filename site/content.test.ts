import { describe, expect, test } from "bun:test";

import {
  HRANESS_HOME_URL,
  HRANESS_NEWSLETTER_URL,
  hranessSocialLinks,
} from "@hraness/site-footer";

import {
  buildHraGlobalInstallCommand,
  HRA_INSTALL_PREFLIGHT_SOURCE_URL,
} from "../src/install-preflight";
import {
  deepseekHarnessReading,
  headlongMicroharnessReading,
  oracleAndFirmReading,
  publicContent,
  renderLlmsText,
  renderPrivacyMarkdown,
  renderReadmeMarkdown,
  renderSitemapXml,
} from "./content.ts";
import {
  renderDeepseekHarnessReadingHtml,
  renderHeadlongMicroharnessReadingHtml,
  renderOracleAndFirmReadingHtml,
  renderPreviewHtml,
  renderPrivacyHtml,
  renderSiteHtml,
} from "./template.ts";

const htmlText = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

describe("public content contract", () => {
  test("publishes the exact HRA release identity", () => {
    expect(publicContent).toMatchObject({
      doctorCommand: "hra doctor --offline",
      initCommand: "hra init --yes",
      installCommand: buildHraGlobalInstallCommand(
        "https://github.com/hraness/hra/releases/download/v0.1.3/hraness-hra-0.1.3.tgz",
      ),
      links: {
        github: "https://github.com/hraness/hra",
      },
      productName: "HRA",
      siteUrl: "https://hra.sh",
    });
  });

  test("leads both public surfaces with the release-ready immutable CLI install command", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const encodedInstallCommand = htmlText(publicContent.installCommand);

    expect(markdown).toStartWith(
      `# ${publicContent.productName}\n\n\`\`\`sh\n${publicContent.installCommand}\n\`\`\``,
    );
    expect(html.indexOf(`<h1>${publicContent.productName}</h1>`)).toBeLessThan(
      html.indexOf(encodedInstallCommand),
    );
    expect(html.indexOf(encodedInstallCommand)).toBeLessThan(
      html.indexOf(publicContent.doctorCommand),
    );
    expect(html.indexOf(publicContent.doctorCommand)).toBeLessThan(
      html.indexOf(publicContent.initCommand),
    );
    expect(markdown.indexOf(publicContent.installCommand)).toBeLessThan(
      markdown.indexOf(publicContent.doctorCommand),
    );
    expect(markdown.indexOf(publicContent.doctorCommand)).toBeLessThan(
      markdown.indexOf(publicContent.initCommand),
    );
  });

  test("marks the local release ready and website live while keeping hosted sync unavailable", () => {
    expect(publicContent.endpoints).toEqual({
      betaTag: "release-ready",
      githubRepository: "live",
      hostedSync: "beta-not-yet-live",
      website: "live",
    });
    for (const surface of [renderReadmeMarkdown(), renderSiteHtml()]) {
      expect(surface).toContain("Immutable local CLI release; hosted sync not yet live");
      expect(surface).toContain("works once GitHub exposes the immutable");
      expect(surface).toContain("public CLI stays immutable once admitted");
      expect(surface).not.toContain("release tag is release-ready");
      expect(surface).toContain("optional hosted sync remains beta-not-yet-live");
      expect(surface).toContain("Local release boundary");
      expect(surface).toContain("once its GitHub Release exists");
      expect(surface).not.toContain("install command becomes usable");
      expect(surface).not.toContain("Beta not yet live");
      expect(surface).not.toContain("No published `v0.1.3` tag currently exposes these commands");
    }
  });

  test("publishes protected cloud auth and the exact device-pairing path", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const documents = [
      '{"email":"you@example.com"}',
      '{"email":"you@example.com","invite":"<identity-invite>"}',
      '{"email":"you@example.com","code":"12345678"}',
    ];

    for (const command of [
      "hra auth login --input-stdin",
      "hra auth login --input-fd <fd>",
      "hra auth delete --acknowledge-erasure",
      "hra device pair",
    ]) {
      expect(markdown).toContain(command);
      expect(html).toContain(
        command.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      );
    }
    for (const document of documents) {
      expect(markdown).toContain(document);
      expect(html).toContain(
        document
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;"),
      );
    }
    for (const surface of [markdown, html]) {
      expect(surface).not.toContain("auth login --email");
      expect(surface).not.toContain("auth login --code");
    }
    expect(markdown).toContain(
      "hra device approve <pending-device-id-or-prefix> [--idempotency-key <current-uuidv7>]",
    );
    expect(html).toContain("hra device approve &lt;pending-device-id-or-prefix&gt;");
    for (const claim of [
      "hra device key-loss --acknowledge-no-key-holders",
      "the account key as a closed status",
      "recovery requires an existing account-key holder",
      "no remaining holder makes the encrypted content unrecoverable",
      "authenticated, registered, active installation",
      "current HRA cloud identity's isolated local custody",
      "current auth token generation, identity, auth epoch, registered device, and pairing observation agree exactly",
      "no network, provider, or cloud mutation",
      "does not mint, replace, or delete a key or ciphertext",
      "fail with a bounded next command",
      "Pairing the real account key later supersedes the observation",
      "Local Codex accounts, sessions, credentials, and execution are unaffected",
      "existing encrypted cloud content cannot be decrypted",
      "Search again for an existing holder",
      "the real key restores ready status and supersedes the acknowledgement",
      "Only after that renewed holder search is exhausted",
      "erasing and reinitializing the HRA cloud account",
      "does not regenerate the lost account key",
      "not the default response to a key-loss acknowledgement",
    ]) {
      expect(markdown).toContain(claim);
      expect(html).toContain(htmlText(claim));
    }
    for (const surface of [markdown, html]) {
      expect(surface).toContain("An unset");
      expect(surface).toContain("hosted deployment");
      expect(surface).toContain("explicit empty value");
      expect(surface).toContain("self-managed Convex deployment");
      expect(surface).toContain("permanently binds that local state root");
      expect(surface).toContain("report its exact restart prerequisite");
      expect(surface).toContain("restore the bound URL for a self-managed deployment");
      expect(surface).not.toContain("require an explicit deployment URL");
      expect(surface).toContain("automatically registers the current installation");
      expect(surface).toContain("registered as pending");
      expect(surface).toContain("no synchronized data, execution, or key authority");
      expect(surface).toContain("an uncontested, unrevoked copy can impersonate that device");
      expect(surface).not.toContain("device pair` to create a pending device request");
      expect(surface).not.toContain("device pair</code> to create a pending device request");
    }
    for (const surface of [markdown, html]) {
      expect(surface).toContain("capability-only progress");
      expect(surface).toContain("does not delete local Codex accounts");
      expect(surface).not.toContain("account deletion remains a launch gate and must be implemented");
    }
  });

  test("publishes exact lost-login recovery without retaining provider credentials", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    for (const surface of [markdown, html]) {
      expect(surface).toContain("the daemon restarts before completion");
      expect(surface).toContain("hra account show personal");
      expect(surface).toContain("hra account login-cancel");
      expect(surface).toContain("exact current-generation provider login");
      expect(surface).toContain("Verification URLs and device codes never enter HRA state, logs, or ordinary output");
      expect(surface).toContain("--handoff-file /absolute/private/login.json --json");
      expect(surface).toContain("A same-key replay never claims or rewrites a handoff");
      expect(surface).toContain("after completion or cancellation it reports the terminal account state");
    }
  });

  test("publishes an explicit read-only plugin boundary", () => {
    const claims = [
      "hra plugin list <account> [--project <project>] [--refresh]",
      "hra plugin show <account> <plugin> [--project <project>] [--refresh]",
      "Plugin commands are read-only discovery.",
      "Pinned Codex 0.149.0 has no safely separated install, enablement, and OAuth lifecycle surface",
      "HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects.",
      "The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission.",
      "Other standard MCP forms are brokered only when their pinned schema fits HRA's closed primitive-field contract.",
      "Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission",
    ];
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(
        claim
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll("'", "&#39;"),
      );
    }
  });

  test("publishes informed protected approval inspection", () => {
    const claims = [
      "hra interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]",
      "intentionally returns only a durable safe summary",
      "complete authority still held by the live provider callback",
      "ordinary stdout receives only safe binding and cleanup metadata",
      "neither the directory nor file may have an extended ACL",
      "Detail larger than 64 KiB also requires this file path.",
      "rejects file-change approval callbacks before durable admission",
      "does not provide the exact affected paths or change detail needed for informed approval",
    ];
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(
        claim
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll("'", "&#39;"),
      );
    }
  });

  test("publishes the persistent shell input and live-redaction boundaries", () => {
    const claims = [
      "An overflow or interrupted line flushes the current native terminal queue, retains input custody while discarding through EOF, and exits without executing the tail.",
      "Protected terminal documents require a visible stderr TTY plus unpredictable begin and return phrases while raw no-echo mode is active.",
      "then closes shell input instead of returning ambiguous bytes to an ordinary prompt.",
      "Display loss, termination, and job-control signals restore or fence raw mode before propagation.",
      "updates from an old session generation are discarded before a new selection is announced.",
      "Slow-terminal backpressure drops additional updates behind one explicit omission notice",
      "Human watch renders assistant and provider-visible reasoning-summary text only after observing that item's start boundary",
      "A mid-item join omits ambiguous delta suffixes until the next item starts.",
      "discard undecided tails with an explicit notice",
    ];
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim.replaceAll("'", "&#39;"));
    }
  });

  test("publishes the protected standard MCP form contract", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    for (const claim of [
      "interaction show returns the exact public field contract without defaults or answers",
      '{"content":{...}}',
      "Decline and cancel accept no content.",
      "validation failures identify the contract failure without echoing a submitted value",
    ]) {
      expect(markdown).toContain(claim);
      expect(html).toContain(
        claim
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;"),
      );
    }
  });

  test("states the origin-machine execution boundary and exact remote command set", () => {
    const claims = [
      "The machine that created a provider session remains its only executor in v1.",
      "send, queue, steer, stop, preset, and Fast commands",
      "Project directories are local-only and are neither synced nor remotely changed.",
      "hra remote send <cloud-session> <message>",
      "hra remote command <uuidv7>",
      "--idempotency-key <current-uuidv7>",
      "includes observation-only interaction events with a public interaction ID, kind, state, revision, blocking status, and bounded safe summary",
      "Resolve a pending callback on its execution device; remote interaction responses are unavailable in v1.",
      "Transcript upload is bound to a durable local stream ledger",
      "HRA never resets, aliases, overwrites, or destructively reseeds encrypted history.",
      "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
      "performs no daemon call and returns",
      "JSON mode never prompts.",
      "preserves all older encrypted cloud history and changes no provider or app state.",
      "baselines only completed turns currently visible in the bounded local projection.",
      "Any possibly unsynced interval remains visible to remote readers as a recovery gap.",
      "Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command.",
    ];

    for (const claim of claims) {
      expect(renderReadmeMarkdown()).toContain(claim);
      expect(renderSiteHtml()).toContain(
        claim.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      );
    }
  });

  test("publishes append-only projection recovery on every relevant public surface", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const privacy = renderPrivacyMarkdown();
    const command = "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]";

    expect(markdown).toContain(command);
    expect(html).toContain(
      command.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    );
    for (const surface of [markdown, html, privacy]) {
      expect(surface).toContain("Compact-projection recovery is append-only.");
      expect(surface).toContain("preserves every older encrypted cloud chunk");
      expect(surface).toContain("recovery gap");
    }
    expect(publicContent.endpoints.hostedSync).toBe("beta-not-yet-live");
  });

  test("renders every shared section on both primary surfaces", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();

    for (const section of publicContent.sections) {
      expect(markdown).toContain(`## ${section.heading}`);
      expect(html).toContain(`id="${section.id}"`);
      expect(html).toContain(`>${section.heading}</h2>`);
    }
  });

  test("keeps the full privacy boundary on the readme, site, and policy page", () => {
    const sentinelClaims = [
      "Codex account labels and observed provider email and plan metadata when cloud sync is enabled.",
      "Codex credentials, profile files, plugin credentials, or OAuth material.",
      "Raw reasoning, hidden chain of thought, or approval secrets.",
      "Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.",
      "Provider login and request IDs, permission values, MCP field contracts, protected answers, or response digests.",
      "Email access alone does not recover that key.",
      "an uncontested, unrevoked copy can impersonate that device",
      "HRA uses Convex to authenticate the HRA identity",
      "HRA uses Resend to deliver verification email.",
      "one-time verification code and message content",
      "Vercel serves hra.sh.",
      "GitHub hosts the source repository, releases, and release downloads.",
      "HRA does not add analytics, cookies, remote fonts, or executable JavaScript to the site.",
    ];
    const surfaces = [
      renderReadmeMarkdown(),
      renderPrivacyMarkdown(),
      renderSiteHtml(),
      renderPrivacyHtml(),
    ];

    for (const claim of sentinelClaims) {
      for (const surface of surfaces) {
        expect(surface).toContain(claim.replaceAll("'", "&#39;"));
      }
    }
  });

  test("publishes exact beta prerequisites and package lifecycle limits", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const surfaces = [markdown, html];
    expect(publicContent.installCommand).toContain(HRA_INSTALL_PREFLIGHT_SOURCE_URL);
    expect(publicContent.installCommand).toContain("| bun -e '");
    expect(publicContent.installCommand).toContain(
      "-- https://github.com/hraness/hra/releases/download/v0.1.3/hraness-hra-0.1.3.tgz",
    );
    expect(publicContent.installCommand).toContain("hra-install-safe");
    expect(publicContent.installCommand).not.toContain("bun add --global");
    expect(publicContent.installCommand).not.toContain("install-normalizer.ts");
    expect(markdown).toContain(publicContent.installCommand);
    expect(html).toContain(htmlText(publicContent.installCommand));
    for (const surface of surfaces) {
      expect(surface).toContain("HRA requires Bun 1.3.14");
      expect(surface).toContain("curl with HTTPS and TLS 1.2 support");
      expect(surface).toContain("support macOS and Linux");
      expect(surface).toContain(HRA_INSTALL_PREFLIGHT_SOURCE_URL);
      expect(surface).toContain("hra-install-safe");
      expect(surface).toContain("fresh random private staging root");
      expect(surface).toContain("GitHub repository ID 1343008607");
      expect(surface).toContain("published immutable v0.1.3 release");
      expect(surface).toContain("immutable release metadata");
      expect(surface).toContain("verified in-memory snapshot");
      expect(surface).toContain("bounded package-file manifest");
      expect(surface).toContain("every extracted HRA package path and SHA-256");
      expect(surface).toContain("separate full-digest version namespaces");
      expect(surface).toContain("lifecycle scripts disabled");
      expect(surface).toContain("complete staged tree");
      expect(surface).toContain("configured package registry trust boundary");
      expect(surface).toContain("does not claim to contain that dependency closure");
      expect(surface).toContain("prior verified command remains active throughout staging");
      expect(surface).toContain("atomically replaces only the $BUN_INSTALL/bin/hra symlink");
      expect(surface).toContain("next invocation recovers or removes only the proven private stage");
      expect(surface).toContain("Existing trustedDependencies remain unchanged");
      expect(surface).toContain("hra daemon stop");
      expect(surface).toContain("hra daemon status --json");
      expect(surface).toContain("hra daemon start");
      expect(surface).toContain("Do not install a moving branch");
      expect(surface).toContain("verified repair installation of v0.1.3");
      expect(surface).toContain("replace the tagged preflight and release archive references together");
      expect(surface).not.toContain("bun remove --global hra");
      expect(surface).not.toContain("uninstall the package");
    }
    const updateStart = markdown.indexOf("Before replacing the installed binary");
    const updateDoctor = markdown.indexOf("hra doctor --offline", updateStart);
    const updateRestart = markdown.indexOf("hra daemon start", updateStart);
    expect(updateDoctor).toBeGreaterThan(updateStart);
    expect(updateRestart).toBeGreaterThan(updateDoctor);
  });

  test("publishes first-session walkthroughs for humans and agents", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const claims = [
      "Human terminal",
      "hra session start personal --preset high",
      "/account personal",
      "/session <session-id>",
      "Agent caller",
      "data.session.id",
      "data.eventStream.cursor",
      "hra session start personal --preset high --json",
      "hra session status <session-id> --json",
      "hra session watch <session-id> --cursor <status-cursor> --jsonl",
      "--follow",
      "equivalent compatibility spelling",
      "hra session interactions <session-id> --pending --json",
      "Keep following while a separate one-shot invocation handles the approval, question, permission grant, or supported MCP form.",
    ];

    expect(markdown).toContain("## First session");
    expect(html).toContain('id="first-session"');
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(htmlText(claim));
    }
  });

  test("publishes bounded status and cursor-safe observation contracts", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const claims = [
      "Bounded local status",
      "hra status [--json]",
      "bounded, effect-free read of local SQLite state",
      "does not start, stop, or contact the daemon",
      "at most 50 ID-and-revision action records",
      "complete JSON result, including its versioned command envelope, is at most 256 KiB",
      "Provider and cloud coverage are explicitly",
      "not_attempted",
      "registered and online device counts are unknown rather than zero",
      "Session observation",
      "returns status version 2",
      "one typed provider-observation result, attempting a Codex app-server read only when the current local state makes one applicable",
      "Execution, attention, provider, and queue remain separate axes",
      "Pending and response-in-flight counts are exact",
      "at most 10 bounded safe summaries",
      "excludes the session note and private provider thread binding",
      "becomes a secret-keyed opaque public alias before status, event, or interaction output",
      "renders a bounded human stream by default",
      "Watch is a presentation alias over the existing session event stream",
      "drains each output page before advancing its internal cursor",
      "Resolution guidance appears only from a complete current interaction record and only for a supported decision",
      "event-only interaction notice points to the exact show command without proposing a mutation",
      "JSONL delivery is at least once across a pipe or process failure",
      "(sessionId, streamEpoch, sequence)",
      "persist each checkpoint only after durably applying all preceding lines",
      "remains an equivalent compatibility spelling",
      "is unavailable until every wait predicate has a transactional wake revision",
      "Use status followed by watch from its cursor, or bounded repeated status polling",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(htmlText(claim));
    }

    const documentedCommands = publicContent.sections.flatMap((section) =>
      section.blocks.flatMap((block) => block.kind === "commands" ? block.commands : []),
    );
    expect(documentedCommands).toContain("hra status [--json]");
    expect(documentedCommands).toContain("hra session watch <session> [--cursor <cursor>] [--jsonl]");
    expect(documentedCommands.some((command) => command.startsWith("hra session wait"))).toBe(false);
  });

  test("documents safe optional full local-data removal without a recursive command", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const claims = [
      "Optional full local-data removal",
      "hra auth delete --acknowledge-erasure",
      "hra account logout <profile>",
      "data.running",
      "$HOME/Library/Application Support/HRA Control Plane v1",
      "$HOME/.local/state/hra-control-plane-v1",
      "explicitly accepts permanent loss",
      "move only the exact platform directory to Trash",
      "Do not move or remove its parent.",
      "obtain explicit destructive approval",
      "An install, update, or daemon-stop request does not authorize local-data removal.",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(htmlText(claim));
    }
    expect(markdown).not.toContain("rm -r");
    expect(html).not.toContain("rm -r");
  });

  test("publishes the exact exit-code and JSONL terminal-error contract", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const statuses = [
      ["0", "success. A normally stopped event follower, including a user SIGINT, may also return 0."],
      ["1", "CONFLICT, AMBIGUOUS, INTERNAL, any other closed failure code, or an unhealthy doctor result."],
      ["2", "INVALID_INPUT."],
      ["4", "NOT_FOUND."],
      ["5", "UNAVAILABLE."],
      ["6", "INTERACTION_REQUIRED."],
      ["7", "RECOVERY_REQUIRED."],
    ] as const;
    const claims = [
      "Exit status and JSONL",
      "stdout contains only JSONL gap, event, and checkpoint frames",
      "exactly one newline-terminated version-1 failure envelope to stderr",
      '{"ok":false,"version":1,"error":{"code":"<code>","message":"<safe-message>"}}',
      "must not merge the terminal error into the JSONL stream",
      "must check the process exit status",
      "may exit 0 without a terminal failure envelope",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(htmlText(claim));
    }
    for (const [status, meaning] of statuses) {
      expect(markdown).toContain(`- \`${status}\`: ${meaning}`);
      expect(html).toContain(`<code>${status}</code>: ${htmlText(meaning)}`);
    }
  });

  test("publishes the local interaction deadline boundary", () => {
    const surfaces = [renderReadmeMarkdown(), renderSiteHtml()];
    for (const surface of surfaces) {
      expect(surface).toContain("anchored when Codex delivered it");
      expect(surface).toContain("caps the pending interval at 30 minutes");
      expect(surface).toContain("never invents an answer or grant");
      expect(surface).toContain("encrypted remote interaction metadata does not include it");
    }
  });

  test("contains JSON-LD and no executable scripts", () => {
    const html = renderSiteHtml();
    expect(html).toContain('<link rel="canonical" href="https://hra.sh/">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html).not.toMatch(/<script(?! type="application\/ld\+json")/);
    expect(html).not.toContain("onclick=");
  });

  test("renders the canonical Hraness network footer on every HTML page", () => {
    const expectedHrefs = [
      HRANESS_HOME_URL,
      HRANESS_NEWSLETTER_URL,
      ...hranessSocialLinks.map(({ href }) => href),
    ];

    for (const document of [
      renderSiteHtml(),
      renderPrivacyHtml(),
      renderDeepseekHarnessReadingHtml(),
      renderHeadlongMicroharnessReadingHtml(),
      renderOracleAndFirmReadingHtml(),
    ]) {
      expect(document.match(/<footer\b/gu)).toHaveLength(1);
      const footer = /<footer\b[\s\S]*?<\/footer>/u.exec(document)?.[0];
      expect(footer).toContain('data-slot="hraness-site-footer"');
      expect(footer?.match(/data-slot="hraness-mark"/gu)).toHaveLength(1);
      expect(footer?.match(/data-slot="social-icon"/gu)).toHaveLength(10);
      expect(
        [...(footer?.matchAll(/<a\b[^>]*\shref="([^"]+)"/gu) ?? [])]
          .map((match) => match[1]),
      ).toEqual(expectedHrefs);
      expect(document.indexOf('class="project-resources"')).toBeLessThan(
        document.indexOf('data-slot="hraness-site-footer"'),
      );
    }
  });

  test("renders an inert noindex preview canonicalized to the full product page", () => {
    const preview = renderPreviewHtml();
    expect(preview).toContain('<body class="preview-page">');
    expect(preview).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(preview).toContain('<link rel="canonical" href="https://hra.sh/">');
    expect(preview).toContain(`<h1 id="preview-title">${publicContent.productName}</h1>`);
    expect(preview.match(/<h1\b/gu)).toHaveLength(1);
    expect(preview).not.toContain("<script");
    expect(preview).not.toMatch(/analytics|auth(?:entication|orization)?|cookie|user data/iu);
    expect(preview).not.toMatch(/<(?:a|button|form|input|select|textarea)\b/iu);
    expect(preview).not.toContain("<footer");
    expect(renderSitemapXml()).not.toContain("/preview");
  });

  test("provides keyboard and landmark structure without inline presentation", () => {
    const html = renderSiteHtml();
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<a class="skip-link" href="#content">Skip to content</a>');
    expect(html).toContain('<main id="content">');
    expect(html).toContain('aria-label="Documentation"');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain(" style=");
  });

  test("ships one crawlable DeepSeek Harness reading page without orphaning it", () => {
    const home = renderSiteHtml();
    const reading = renderDeepseekHarnessReadingHtml();
    const llms = renderLlmsText();
    const sitemap = renderSitemapXml();
    const markdown = renderReadmeMarkdown();
    const requiredHrefs = [
      "https://hra.sh/",
      "https://hraness.com/writing/what-is-an-agent-harness",
      "https://hraness.com/writing/direct-wrench-hra",
      "https://github.com/deepseek-ai/deepseek-harness",
      "https://hraness.com/reading/deepseek-harness",
      "/reading/headlong-microharness/",
      "/reading/oracle-and-firm/",
      "https://wrench.rip/provider-capabilities/",
    ];
    const absentHrefs = [
      "/reading/headlong-always-on-loop",
      "/reading/not-a-codex-tui",
      "stripedex.com",
      "spongeresearch.com",
    ];

    expect(home).toContain('href="/reading/deepseek-harness/"');
    expect(home).toContain("A plugin catalog is not a Codex account loop");
    expect(home).toContain('"@type":"SoftwareApplication"');
    expect(home).not.toContain('"@type":"Article"');
    expect(reading).toContain(
      `<link rel="canonical" href="https://hra.sh${deepseekHarnessReading.canonicalPath}">`,
    );
    expect(reading).toContain('<meta property="og:type" content="article">');
    expect(reading).toContain('"@type":"Article"');
    expect(reading).not.toContain('"@type":"SoftwareApplication"');
    expect(reading).toContain(
      `<h1 id="reading-deepseek-harness-heading">${deepseekHarnessReading.heading}</h1>`,
    );
    expect(reading.match(/<h1\b/gu)).toHaveLength(1);
    expect(reading).toContain(
      '<h2 id="reading-deepseek-harness-2-deepseek-harness-as-published">',
    );
    expect(reading).toContain(deepseekHarnessReading.description);
    expect(llms).toContain(
      `[${deepseekHarnessReading.title}](${publicContent.siteUrl}${deepseekHarnessReading.canonicalPath})`,
    );
    expect(sitemap).toContain(`<loc>${publicContent.siteUrl}/</loc>`);
    expect(sitemap).toContain(`<loc>${publicContent.siteUrl}/privacy/</loc>`);
    expect(sitemap).toContain(
      `<loc>${publicContent.siteUrl}${deepseekHarnessReading.canonicalPath}</loc>`,
    );
    expect(markdown).not.toContain("/reading/deepseek-harness/");
    for (const href of requiredHrefs) {
      expect(reading).toContain(`href="${href}"`);
    }
    for (const document of [home, reading, llms, sitemap, markdown]) {
      for (const href of absentHrefs) {
        expect(document).not.toContain(href);
      }
      expect(document).not.toMatch(/<script(?! type="application\/ld\+json")/);
    }
    expect(reading).not.toMatch(/<script[^>]+src=/);
    expect(reading).not.toContain("onclick=");
    expect(reading).not.toContain("graphql");
    expect(reading).not.toContain("GraphQL");
    expect(reading).not.toContain("OAuth");
    expect(reading).not.toContain("MCP");
  });

  test("ships one crawlable Headlong reading page without orphaning it", () => {
    const home = renderSiteHtml();
    const reading = renderHeadlongMicroharnessReadingHtml();
    const deepseek = renderDeepseekHarnessReadingHtml();
    const llms = renderLlmsText();
    const sitemap = renderSitemapXml();
    const markdown = renderReadmeMarkdown();
    const requiredHrefs = [
      "https://www.laude.org/updates/headlong-a-microharness-for-persistent-agents",
      "https://hraness.com/reading/headlong-a-microharness-for-persistent-agents",
      "https://hra.sh/",
      "/reading/deepseek-harness/",
      "/reading/oracle-and-firm/",
      "https://hraness.com/writing/what-is-an-agent-harness",
      "https://hraness.com/writing/direct-wrench-hra",
      "https://wrench.rip/provider-capabilities/",
    ];
    const absentHrefs = [
      "/reading/headlong-always-on-loop",
      "/reading/not-a-codex-tui",
      "stripedex.com",
      "spongeresearch.com",
    ];

    expect(home).toContain('href="/reading/headlong-microharness/"');
    expect(home).toContain("A microharness for persistence is not a Codex account loop");
    expect(deepseek).toContain('href="/reading/headlong-microharness/"');
    expect(reading).toContain(
      `<link rel="canonical" href="https://hra.sh${headlongMicroharnessReading.canonicalPath}">`,
    );
    expect(reading).toContain('<meta property="og:type" content="article">');
    expect(reading).toContain('"@type":"Article"');
    expect(reading).not.toContain('"@type":"SoftwareApplication"');
    expect(reading).toContain(
      `<h1 id="reading-headlong-microharness-heading">${headlongMicroharnessReading.heading}</h1>`,
    );
    expect(reading.match(/<h1\b/gu)).toHaveLength(1);
    expect(reading).toContain(
      '<h2 id="reading-headlong-microharness-2-headlong-as-published">',
    );
    expect(reading).toContain(headlongMicroharnessReading.description);
    expect(reading).toContain("This page is the HRA take, not that digest.");
    expect(reading).toContain("generation-0 always-on-loop URL");
    expect(reading).toContain("HRA does not implement Headlong");
    expect(llms).toContain(
      `[${headlongMicroharnessReading.title}](${publicContent.siteUrl}${headlongMicroharnessReading.canonicalPath})`,
    );
    expect(sitemap).toContain(
      `<loc>${publicContent.siteUrl}${headlongMicroharnessReading.canonicalPath}</loc>`,
    );
    expect(markdown).not.toContain("/reading/headlong-microharness/");
    for (const href of requiredHrefs) {
      expect(reading).toContain(`href="${href}"`);
    }
    for (const document of [home, reading, deepseek, llms, sitemap, markdown]) {
      for (const href of absentHrefs) {
        expect(document).not.toContain(href);
      }
      expect(document).not.toMatch(/<script(?! type="application\/ld\+json")/);
    }
    expect(reading).not.toMatch(/<script[^>]+src=/);
    expect(reading).not.toContain("onclick=");
    expect(reading).not.toContain("graphql");
    expect(reading).not.toContain("GraphQL");
    expect(reading).not.toContain("OAuth");
    expect(reading).not.toContain("MCP");
  });

  test("ships one crawlable oracle-and-firm reading page without orphaning it", () => {
    const home = renderSiteHtml();
    const reading = renderOracleAndFirmReadingHtml();
    const deepseek = renderDeepseekHarnessReadingHtml();
    const headlong = renderHeadlongMicroharnessReadingHtml();
    const llms = renderLlmsText();
    const sitemap = renderSitemapXml();
    const markdown = renderReadmeMarkdown();
    const requiredHrefs = [
      "https://calv.info/the-oracle-and-the-firm",
      "https://hraness.com/reading/the-oracle-and-the-firm",
      "https://hraness.com/writing/what-is-an-agent-harness",
      "/reading/deepseek-harness/",
      "/reading/headlong-microharness/",
      "https://hra.sh/",
      "https://hraness.com/writing/direct-wrench-hra",
      "https://wrench.rip/provider-capabilities/",
    ];
    const absentHrefs = [
      "/reading/headlong-always-on-loop",
      "/reading/not-a-codex-tui",
      "stripedex.com",
      "spongeresearch.com",
    ];

    expect(home).toContain('href="/reading/oracle-and-firm/"');
    expect(home).toContain("A Codex account loop is an oracle thread, not a firm");
    expect(deepseek).toContain('href="/reading/oracle-and-firm/"');
    expect(headlong).toContain('href="/reading/oracle-and-firm/"');
    expect(reading).toContain(
      `<link rel="canonical" href="https://hra.sh${oracleAndFirmReading.canonicalPath}">`,
    );
    expect(reading).toContain('<meta property="og:type" content="article">');
    expect(reading).toContain('"@type":"Article"');
    expect(reading).not.toContain('"@type":"SoftwareApplication"');
    expect(reading).toContain(
      `<h1 id="reading-oracle-and-firm-heading">${oracleAndFirmReading.heading}</h1>`,
    );
    expect(reading.match(/<h1\b/gu)).toHaveLength(1);
    expect(reading).toContain(
      '<h2 id="reading-oracle-and-firm-2-the-oracle-and-the-firm-as-published">',
    );
    expect(reading).toContain(oracleAndFirmReading.description);
    expect(reading).toContain("This page is the HRA take, not that digest.");
    expect(reading).toContain("HRA does not implement Claude Code");
    expect(reading).toContain("oracle-shaped");
    expect(llms).toContain(
      `[${oracleAndFirmReading.title}](${publicContent.siteUrl}${oracleAndFirmReading.canonicalPath})`,
    );
    expect(sitemap).toContain(
      `<loc>${publicContent.siteUrl}${oracleAndFirmReading.canonicalPath}</loc>`,
    );
    expect(markdown).not.toContain("/reading/oracle-and-firm/");
    for (const href of requiredHrefs) {
      expect(reading).toContain(`href="${href}"`);
    }
    for (const document of [home, reading, deepseek, headlong, llms, sitemap, markdown]) {
      for (const href of absentHrefs) {
        expect(document).not.toContain(href);
      }
      expect(document).not.toMatch(/<script(?! type="application\/ld\+json")/);
    }
    expect(reading).not.toMatch(/<script[^>]+src=/);
    expect(reading).not.toContain("onclick=");
    expect(reading).not.toContain("graphql");
    expect(reading).not.toContain("GraphQL");
    expect(reading).not.toContain("OAuth");
    expect(reading).not.toContain("MCP");
  });
});
