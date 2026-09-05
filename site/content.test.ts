import { describe, expect, test } from "bun:test";

import {
  HRANESS_HOME_URL,
  hranessSocialLinks,
} from "@hraness/site-footer";

import {
  buildHraGlobalInstallCommand,
  HRA_INSTALL_PREFLIGHT_SOURCE_URL,
} from "../src/install-preflight";
import { helpGroupNames, usageForGroup } from "../src/cli/parser";
import packageJson from "../package.json";
import {
  hostedSignupCopy,
  publicContent,
  publicPins,
  publicReleaseState,
  renderLlmsText,
  renderPrivacyMarkdown,
  renderReadmeMarkdown,
  renderSitemapXml,
  siteDocumentPaths,
} from "./content.ts";
import {
  HRA_MAILING_TURNSTILE_SITEKEY_ENV,
  hraMailingListConfig,
  renderHraAnalyticsScript,
  renderHraSiteFooter,
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

const htmlVisibleText = (value: string): string => value
  .replaceAll(/<[^>]+>/gu, "")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&amp;", "&");

describe("public content contract", () => {
  test("publishes the exact HRA release identity", () => {
    expect(publicContent).toMatchObject({
      doctorCommand: "hra doctor --offline",
      initCommand: "hra init --yes",
      installCommand: buildHraGlobalInstallCommand(
        "https://github.com/hraness/hra/releases/download/v0.6.0/hraness-hra-0.6.0.tgz",
      ),
      links: {
        github: "https://github.com/hraness/hra",
      },
      productName: "HRA",
      siteUrl: "https://hra.sh",
    });
  });

  test("opens the README with the H1, one badge line, the thesis on line 3, the status line, then install", () => {
    const markdown = renderReadmeMarkdown();
    const lines = markdown.split("\n");
    const badgeLine = publicContent.badges
      .map((badge) => `[![${badge.alt}](${badge.image})](${badge.href})`)
      .join(" ");

    expect(lines[0]).toBe(`# ${publicContent.productName}`);
    expect(lines[1]).toBe(`${badgeLine}\\`);
    expect(lines[2]).toBe(publicContent.thesis);
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe(publicContent.statusLine);
    expect(lines[5]).toBe("");
    expect(lines[6]).toBe("```sh");
    expect(lines[7]).toBe(publicContent.installCommand);
    expect(publicContent.thesis).toBe(
      "HRA runs Codex and Claude Code sessions side by side, keeps them alive in a local daemon, and gives humans and AI agents the same commands to drive them.",
    );
    expect(publicContent.statusLine).toContain(`v${publicContent.releaseVersion}`);
    expect(publicContent.statusLine).toContain("hosted sync is live as an open beta");
    expect(markdown.indexOf(publicContent.thesis)).toBeLessThan(markdown.indexOf(publicContent.installCommand));
    expect(markdown.indexOf(publicContent.statusLine)).toBeLessThan(markdown.indexOf(publicContent.installCommand));
    expect(markdown).toContain(`## ${publicContent.hero.heading}`);
    expect(markdown.indexOf(publicContent.initCommand)).toBeLessThan(markdown.indexOf(`## ${publicContent.hero.heading}`));
    expect(markdown).toContain(`1. **Start:** \`${publicContent.hero.steps[0]!.command}\`. ${publicContent.hero.steps[0]!.detail}`);
  });

  test("publishes trust-signal badges pinned to the package manifest", () => {
    expect(publicContent.badges.map((badge) => badge.alt)).toEqual([
      "npm version",
      "provenance: sigstore",
      "CI",
      "license: MIT",
      `Bun ${packageJson.engines.bun}`,
      `runtime: Codex ${packageJson.dependencies["@openai/codex"]}`,
      `runtime: Claude Code ${publicPins.claude}`,
    ]);
    expect(publicPins).toEqual({
      bun: packageJson.engines.bun,
      claude: "2.1.260",
      codex: packageJson.dependencies["@openai/codex"],
    });
    for (const badge of publicContent.badges) {
      expect(badge.image).toMatch(/^https:\/\/img\.shields\.io\//u);
      expect(badge.href).toMatch(/^https:\/\//u);
    }
    expect(publicContent.badges[2]?.image).toContain("/hraness/hra/ci.yml?branch=main");
    expect(publicContent.badges[4]?.image).toBe("https://img.shields.io/badge/Bun-1.3.14-14151a");
    expect(publicContent.badges[5]?.image).toBe("https://img.shields.io/badge/runtime-Codex%200.153.2-0b5fa5");
    expect(publicContent.badges[6]?.image).toBe("https://img.shields.io/badge/runtime-Claude%20Code%202.1.260-6f42c1");
    expect(renderSiteHtml()).not.toContain("img.shields.io");
  });

  test("states one neutral positioning in the manifest, JSON-LD, social card, and llms.txt", () => {
    const html = renderSiteHtml();
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(jsonLd).toBeDefined();
    const structured = JSON.parse(jsonLd ?? "{}") as Record<string, unknown>;

    expect(publicContent.tagline).toBe("Control plane for Codex and Claude Code");
    expect(publicContent.providerRoadmap).toBe("Codex and Claude Code, side by side.");
    expect(packageJson.description).toBe(publicContent.description);
    expect(publicContent.description).toStartWith(`${publicContent.tagline} in current source;`);
    expect(structured).toMatchObject({
      "@type": "SoftwareApplication",
      applicationSubCategory: publicContent.tagline,
      author: { "@type": "Organization", name: "Hraness", url: "https://hraness.com/" },
      description: publicContent.description,
      maintainer: { "@type": "Organization", name: "Hraness", url: "https://hraness.com/" },
    });
    expect(structured).not.toHaveProperty("softwareVersion");
    expect(publicContent.description).toContain("current source");
    expect(publicContent.description).toContain("v0.6.0 is release-ready");
    expect(html).toContain(`<title>${publicContent.productName} | ${publicContent.tagline}</title>`);
    expect(html).toContain(`<p class="hraness-marketing-hero__eyebrow">${publicContent.tagline}</p>`);
    expect(renderPreviewHtml()).toContain(`<p class="preview-eyebrow">${publicContent.tagline}</p>`);
    expect(publicContent.socialCard).toEqual({
      alt: "HRA · Codex + Claude Code · v0.6.0 release-ready · hra.sh",
      height: 630,
      path: "/social-card.png",
      width: 1200,
    });
    for (const document of [html, renderPrivacyHtml(), renderPreviewHtml()]) {
      expect(document).toContain('<meta property="og:image" content="https://hra.sh/social-card.png">');
      expect(document).toContain('<meta property="og:image:type" content="image/png">');
      expect(document).toContain('<meta property="og:image:width" content="1200">');
      expect(document).toContain('<meta property="og:image:height" content="630">');
      expect(document).toContain(`<meta property="og:image:alt" content="${publicContent.socialCard.alt}">`);
      expect(document).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(document).toContain('<meta name="twitter:image" content="https://hra.sh/social-card.png">');
      expect(document).not.toContain("social-card.svg");
    }
    const llms = renderLlmsText();
    expect(llms.split("\n")[2]).toBe(`> ${publicContent.description}`);
    expect(llms).toContain(publicContent.thesis);
    expect(llms).toContain(publicContent.statusLine);
    expect(llms.indexOf(publicContent.thesis)).toBeLessThan(llms.indexOf(publicContent.installCommand));
  });

  test("names the product and its maintainer once, beside what HRA does", () => {
    const nameSentence = "HRA is short for harness: the control plane that keeps Codex and Claude Code sessions working together, and ";
    const maintainerSentence = "The Hraness organization maintains HRA and publishes it under the MIT license.";
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();

    expect(markdown).toContain(`${nameSentence}[hraness.com](https://hraness.com/) explains the parent brand. ${maintainerSentence}`);
    expect(html).toContain(`${nameSentence}<a href="https://hraness.com/">hraness.com</a> explains the parent brand. ${maintainerSentence}`);
    expect(markdown.match(/short for harness/gu)).toHaveLength(1);
    const maintainerParagraph = markdown.split("\n").find((line) => line.includes("short for harness")) ?? "";
    expect(maintainerParagraph).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u);
    expect(publicContent.maintainer).toEqual({ name: "Hraness", url: "https://hraness.com/" });
  });

  test("publishes no em dash on any generated public surface", () => {
    for (const [label, surface] of [
      ["README", renderReadmeMarkdown()],
      ["PRIVACY", renderPrivacyMarkdown()],
      ["llms.txt", renderLlmsText()],
      ["site", renderSiteHtml()],
      ["privacy page", renderPrivacyHtml()],
      ["preview", renderPreviewHtml()],
      ["package description", packageJson.description],
    ] as const) {
      expect(surface, label).not.toContain("\u2014");
    }
  });

  test("leads the site with the outcome and keeps the README install-first", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const installIndex = html.indexOf('<pre class="install-command"');
    const doctorIndex = html.indexOf('<pre class="doctor-command"');
    const initIndex = html.indexOf('<pre class="init-command"');

    expect(markdown).toStartWith(`# ${publicContent.productName}\n`);
    expect(markdown.indexOf("```sh")).toBeLessThan(markdown.indexOf(`## ${publicContent.hero.heading}`));
    expect(html.indexOf(`>${publicContent.hero.heading}</h1>`)).toBeLessThan(
      installIndex,
    );
    expect(html).toContain('class="hraness-marketing-hero"');
    expect(html).toContain('data-hraness-marketing="flow"');
    expect(html).toContain('data-hraness-marketing="facts"');
    expect(html).toContain('data-hraness-marketing="install"');
    expect(html.indexOf(htmlText(publicContent.hero.steps[0]!.command))).toBeLessThan(
      installIndex,
    );
    expect(installIndex).toBeGreaterThan(0);
    expect(installIndex).toBeLessThan(doctorIndex);
    expect(doctorIndex).toBeLessThan(initIndex);
    expect(markdown.indexOf(publicContent.installCommand)).toBeLessThan(
      markdown.indexOf(publicContent.doctorCommand),
    );
    expect(markdown.indexOf(publicContent.doctorCommand)).toBeLessThan(
      markdown.indexOf(publicContent.initCommand),
    );
    for (const surface of [markdown, html]) {
      expect(surface).toContain(publicContent.hero.heading);
      expect(surface).toContain(publicContent.hero.summary);
      expect(surface).toContain(publicContent.hero.boundary);
      expect(surface).toContain(publicContent.hero.proofLabel);
      for (const step of publicContent.hero.steps) {
        expect(surface).toContain(html === surface ? htmlText(step.command) : step.command);
        expect(surface).toContain(step.detail);
      }
    }
  });

  test("highlights documentation commands without touching classified hero code", () => {
    const html = renderSiteHtml();
    expect(html).toContain('<code class="hra-inline-code">v0.6.0</code>');
    expect(html).toContain('<pre class="command-list" tabindex="0"><code class="syntax-code language-shell">');
    expect(html).toContain('<pre class="install-command" tabindex="0"><code class="syntax-code language-shell">');
    expect(html).toContain('class="syntax-token syntax-token--command"');
    expect(html).toContain(
      `<code class="hraness-marketing-flow__code">${htmlText(publicContent.hero.steps[0]!.command)}</code>`,
    );
    expect(html).not.toContain('<code class="hraness-marketing-flow__code"><span');
    expect(html).not.toMatch(/<code>(?:.|\n)*?<\/code>/u);
  });

  test("marks the local release candidate release-ready while the website and hosted sync stay live", () => {
    expect(publicReleaseState).toBe("release-ready");
    expect(publicContent.endpoints).toEqual({
      betaTag: "release-ready",
      githubRepository: "live",
      hostedSync: "live",
      website: "live",
    });
    expect(renderReadmeMarkdown()).toContain("The local CLI v0.6.0 is release-ready");
    for (const surface of [renderReadmeMarkdown(), renderSiteHtml()]) {
      expect(surface).toContain("Immutable local CLI release candidate; hosted sync live as an open beta");
      expect(surface).toContain("works once GitHub exposes the immutable");
      expect(surface).toContain("candidate becomes public only after exact admission");
      expect(surface).not.toContain("beta-not-yet-live");
      expect(surface).toContain("Local release boundary");
      expect(surface).toContain("become installable through the exact command above once its GitHub Release exists");
      expect(surface).not.toContain("Beta not yet live");
      expect(surface).not.toContain("No published `v0.6.0` tag currently exposes these commands");
    }
    expect(renderLlmsText()).toContain("Install after the v0.6.0 beta tag is live");
    expect(renderLlmsText()).not.toContain("Install the live v0.6.0 beta");
  });

  test("states one hosted sign-up claim everywhere and switches it in one place", () => {
    expect(publicContent.hostedSignup).toBe("open");
    for (const surface of [
      renderReadmeMarkdown(),
      renderSiteHtml(),
      renderPrivacyMarkdown(),
    ]) {
      expect(surface).not.toContain("invite-only beta");
    }
    expect(renderReadmeMarkdown()).toContain(
      "Anyone can create an identity with an email address and a one-time code",
    );
    expect(renderPrivacyMarkdown()).toContain(
      "The hosted sync service is live as an open beta",
    );
    // The invite-only wording is one constant away, and nothing else changes.
    expect(hostedSignupCopy(publicContent.hostedSignup)).toEqual({
      admissionClaim: "Anyone can create an identity with an email address and a one-time code; an invitation is optional.",
      betaLabel: "open beta",
    });
    expect(hostedSignupCopy("invite_only")).toEqual({
      admissionClaim: "The first identity and device were admitted on the production deployment on 2026-09-03; new identities need an invitation from an existing member.",
      betaLabel: "invite-only beta",
    });
  });

  test("publishes protected cloud auth and the exact device-pairing path", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    const visibleHtml = htmlVisibleText(html);
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
      expect(visibleHtml).toContain(command);
    }
    for (const document of documents) {
      expect(markdown).toContain(document);
      expect(visibleHtml).toContain(document);
    }
    for (const surface of [markdown, visibleHtml]) {
      expect(surface).not.toContain("auth login --email");
      expect(surface).not.toContain("auth login --code");
    }
    expect(markdown).toContain(
      "hra device approve <pending-device-id-or-prefix> --fingerprint <value>"
      + " [--idempotency-key <current-uuidv7>]",
    );
    expect(visibleHtml).toContain("hra device approve <pending-device-id-or-prefix>");
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
      "Local provider profiles, sessions, credentials, and execution are unaffected",
      "existing encrypted cloud content cannot be decrypted",
      "Search again for an existing holder",
      "the real key restores ready status and supersedes the acknowledgement",
      "Only after that renewed holder search is exhausted",
      "erasing and reinitializing the HRA cloud account",
      "does not regenerate the lost account key",
      "not the default response to a key-loss acknowledgement",
    ]) {
      expect(markdown).toContain(claim);
      expect(visibleHtml).toContain(claim);
    }
    for (const surface of [markdown, visibleHtml]) {
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
    for (const surface of [markdown, visibleHtml]) {
      expect(surface).toContain("capability-only progress");
      expect(surface).toContain("does not delete local provider profiles");
      expect(surface).not.toContain("account deletion remains a launch gate and must be implemented");
    }
  });

  test("publishes exact lost-login recovery without retaining provider credentials", () => {
    const markdown = renderReadmeMarkdown();
    const html = htmlVisibleText(renderSiteHtml());
    for (const surface of [markdown, html]) {
      expect(surface).toContain("the daemon restarts before completion");
      expect(surface).toContain("hra account show personal");
      expect(surface).toContain("hra account login-cancel");
      expect(surface).toContain("exact current-generation provider login");
      expect(surface).toContain("Verification URLs and user codes never enter local durable HRA state, logs, or ordinary command output");
      expect(surface).toContain("account-key-encrypted, one-read hosted result");
      expect(surface).toContain("always selects device-code mode");
      expect(surface).toContain("--handoff-file /absolute/private/login.json --json");
      expect(surface).toContain("A same-key replay never claims or rewrites a handoff");
      expect(surface).toContain("after completion or cancellation it reports the terminal account state");
      expect(surface).toContain("hra account login personal --provider claude");
      expect(surface).toContain("CLAUDE_CONFIG_DIR");
      expect(surface).toContain("Claude exposes no HRA device-code, handoff-file, or web-linking protocol");
      expect(surface).toContain("retains the one-child fence even if Claude reports signed in");
      expect(surface).toContain("After confirming that original child has exited");
      expect(surface).toContain("recovery does not stop Claude or read, change, or delete a credential");
      expect(surface).not.toContain("HRA does not implement Claude Code sign-in");
    }
  });

  test("publishes an explicit read-only plugin boundary", () => {
    const claims = [
      "hra plugin list <account> [--project <project>] [--refresh]",
      "hra plugin show <account> <plugin> [--project <project>] [--refresh]",
      "Plugin commands are read-only discovery.",
      "Pinned Codex 0.153.2 has no safely separated install, enablement, and OAuth lifecycle surface",
      "HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects.",
      "The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission.",
      "Other standard MCP forms are brokered only when their pinned schema fits HRA's closed primitive-field contract.",
      "Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission",
    ];
    const markdown = renderReadmeMarkdown();
    const html = htmlVisibleText(renderSiteHtml());
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
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
    const html = htmlVisibleText(renderSiteHtml());
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
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
    const markdown = renderReadmeMarkdown();
    const html = htmlVisibleText(renderSiteHtml());
    const claims = [
      "The machine that created a provider session remains its only executor in v1.",
      "send, queue, steer, stop, preset, provider-switch, and Codex Fast commands",
      "Project directories are local-only and are neither synced nor remotely changed.",
      "hra remote send <cloud-session> <message>",
      "hra remote command <uuidv7>",
      "hra remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]",
      "--idempotency-key <current-uuidv7>",
      "includes interaction events with a public interaction ID, kind, state, revision, blocking status, bounded safe summary, and a nested version 2 remote policy",
      "Another device may decline a pending command, permission, or file-change request with",
      "every MCP answer stays on the execution machine",
      "Transcript upload is bound to a durable local stream ledger",
      "HRA never resets, aliases, overwrites, or destructively reseeds encrypted history.",
      "hra sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
      "performs no daemon call and returns",
      "JSON mode never prompts.",
      "preserves all older encrypted cloud history and changes no provider or app state.",
      "baselines only completed turns currently visible in the bounded local projection.",
      "Any possibly unsynced interval remains visible to remote readers as a recovery gap.",
      "Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command.",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
  });

  test("publishes append-only projection recovery on every relevant public surface", () => {
    const markdown = renderReadmeMarkdown();
    const html = htmlVisibleText(renderSiteHtml());
    const privacy = renderPrivacyMarkdown();
    const command = "hra sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]";

    expect(markdown).toContain(command);
    expect(html).toContain(command);
    for (const surface of [markdown, html, privacy]) {
      expect(surface).toContain("Compact-projection recovery is append-only.");
      expect(surface).toContain("preserves every older encrypted cloud chunk");
      expect(surface).toContain("recovery gap");
    }
    expect(publicContent.endpoints.hostedSync).toBe("live");
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
      "Claude Code account identity and usage are not projected.",
      "validates one bounded Claude Code authentication-status response transiently",
      "never retains, returns, projects, or uploads the identity or usage fields",
      "For an explicitly requested Codex web login, the provider HTTPS verification URL and separate one-time user code.",
      "encrypts both to the account key before upload",
      "deletes the hosted handoff on that read or after five minutes",
      "OAuth access or refresh tokens, authorization codes, PKCE verifiers, provider cookies, or the private device code.",
      "Raw reasoning, hidden chain of thought, or approval secrets.",
      "Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.",
      "Provider-internal login and request IDs, permission values, MCP field contracts, protected answers, or response digests.",
      "does not programmatically write decrypted provider or session text to the clipboard",
      "browser extensions, accessibility APIs, screenshots, and explicit user selection can observe rendered text",
      "Email access alone does not recover that key.",
      "an uncontested, unrevoked copy can impersonate that device",
      "HRA uses Convex to authenticate the HRA identity",
      "HRA uses Resend to deliver verification email.",
      "one-time verification code and message content",
      "anonymous, cookieless PostHog analytics",
      "Collection runs only on the canonical production host",
      "honors Do Not Track",
      "disables person profiles, autocapture, heatmaps, feature flags, surveys, conversations, and session recording",
      "HRA sends no form values, account identity, provider or session data, URL query, or fragment.",
      "Vercel serves hra.sh",
      "GitHub hosts the source repository, releases, and release downloads",
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
    const html = htmlVisibleText(renderSiteHtml());
    const surfaces = [markdown, html];
    expect(publicContent.installCommand).toContain(HRA_INSTALL_PREFLIGHT_SOURCE_URL);
    expect(publicContent.installCommand).toContain("| bun -e '");
    expect(publicContent.installCommand).toContain(
      "-- https://github.com/hraness/hra/releases/download/v0.6.0/hraness-hra-0.6.0.tgz",
    );
    expect(publicContent.installCommand).toContain("hra-install-safe");
    expect(publicContent.installCommand).not.toContain("bun add --global");
    expect(publicContent.installCommand).not.toContain("install-normalizer.ts");
    expect(markdown).toContain(publicContent.installCommand);
    expect(html).toContain(publicContent.installCommand);
    for (const surface of surfaces) {
      expect(surface).toContain("HRA requires Bun 1.3.14");
      expect(surface).toContain("curl with HTTPS and TLS 1.2 support");
      expect(surface).toContain("support macOS and Linux");
      expect(surface).toContain("Codex effects run on both platforms");
      expect(surface).toContain("Claude Code effects run on Linux only");
      expect(surface).toContain("refuses new Claude Code effects on macOS pending authenticated isolated-Keychain and detached-read acceptance");
      expect(surface).toContain(HRA_INSTALL_PREFLIGHT_SOURCE_URL);
      expect(surface).toContain("hra-install-safe");
      expect(surface).toContain("fresh random private staging root");
      expect(surface).toContain("GitHub repository ID 1343008607");
      expect(surface).toContain("published immutable v0.6.0 release");
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
      expect(surface).toContain("verified repair installation of v0.6.0");
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
    const rawHtml = renderSiteHtml();
    const html = htmlVisibleText(rawHtml);
    const claims = [
      "Human terminal",
      "hra session start personal --provider codex --preset high",
      "/account personal",
      "/session <session-id>",
      "Agent caller",
      "data.session.id",
      "data.eventStream.cursor",
      "hra session start personal --provider codex --preset high --json",
      "hra session status <session-id> --json",
      "hra session watch <session-id> --cursor <status-cursor> --jsonl",
      "--follow",
      "equivalent compatibility spelling",
      "hra session interactions <session-id> --pending --json",
      "Claude Code and provider switching",
      "hra session start personal --provider claude --preset fable-max --json",
      "hra session switch <session-id> --provider claude --preset fable-max",
      "hra session export <session-id> --format json",
      "Keep following while a separate one-shot invocation handles the approval, question, permission grant, or supported MCP form.",
      "Scheduled work in the same conversation",
      "hra session task create <session-id> --name daily-review --every-minutes 1440",
      "hra session task list <session-id>",
      "hra session task show <session-id> <task-id>",
      "hra session task edit <session-id> <task-id> --revision <revision> --pause",
      "hra session task edit <session-id> <task-id> --revision <revision> --resume",
      "hra session task delete <session-id> <task-id> --revision <revision>",
      "A task cannot independently retarget its account, provider, project, model, or execution environment",
      "later explicit changes to the session apply to future runs",
      "Missed intervals coalesce into one queued turn",
      "HRA never creates a replacement provider conversation or writes a provider's private automation registry",
    ];

    expect(markdown).toContain("## First session");
    expect(rawHtml).toContain('id="first-session"');
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
  });

  test("publishes bounded status and cursor-safe observation contracts", () => {
    const markdown = renderReadmeMarkdown();
    const html = htmlVisibleText(renderSiteHtml());
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
      "one typed provider-observation result, attempting the bound provider's reviewed observation path only when the current local state makes one applicable",
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
      expect(html).toContain(claim);
    }

    const documentedCommands = publicContent.sections.flatMap((section) =>
      section.blocks.flatMap((block) => block.kind === "commands" ? block.commands : []),
    );
    expect(documentedCommands).toContain("hra status [--json]");
    expect(documentedCommands).toContain("hra session watch <session> [--cursor <cursor>] [--jsonl]");
    expect(documentedCommands.some((command) => command.startsWith("hra session wait"))).toBe(false);
    expect(documentedCommands.some((command) => /<\d+-\d+>/u.test(command))).toBe(false);
  });

  test("keeps the public command reference in parity with CLI group help", () => {
    const commandReference = publicContent.sections.find((section) => section.id === "command-reference");
    expect(commandReference).toBeDefined();
    const documentedCommands = new Set(commandReference?.blocks.flatMap((block) =>
      block.kind === "commands" ? block.commands : []
    ) ?? []);

    for (const group of helpGroupNames) {
      const usageSection = usageForGroup(group).split("\n\n")
        .find((section) => section.startsWith("Usage:\n"));
      expect(usageSection).toBeDefined();
      for (const line of usageSection?.split("\n").slice(1) ?? []) {
        const command = line.trim();
        if (command.startsWith("hra ")) expect(documentedCommands).toContain(command);
      }
    }
  });

  test("documents safe optional full local-data removal without a recursive command", () => {
    const markdown = renderReadmeMarkdown();
    const html = htmlVisibleText(renderSiteHtml());
    const claims = [
      "Optional full local-data removal",
      "hra auth delete --acknowledge-erasure",
      "hra account logout <profile>",
      "data.running",
      "$HOME/Library/Application Support/HRA Control Plane v1",
      "$HOME/.local/state/hra-control-plane-v1",
      "explicitly accepts permanent loss",
      "Claude Code configuration directories",
      "provider-managed system credential storage",
      "sign out through Claude Code before deletion",
      "move only the exact platform directory to Trash",
      "Do not move or remove the state directory's parent.",
      "obtain explicit destructive approval",
      "An install, update, or daemon-stop request does not authorize local-data removal.",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
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
      expect(html).toContain(`<code class="hra-inline-code">${status}</code>: ${htmlText(meaning)}`);
    }
  });

  test("publishes the local interaction deadline boundary", () => {
    const surfaces = [renderReadmeMarkdown(), htmlVisibleText(renderSiteHtml())];
    for (const surface of surfaces) {
      expect(surface).toContain("anchored when the provider delivered it");
      expect(surface).toContain("caps the pending interval at 30 minutes");
      expect(surface).toContain("never invents an answer or grant");
      expect(surface).toContain("nested remote policy version 2 carries the same absolute deadline");
    }
  });

  test("contains JSON-LD and one owned analytics module on public pages", () => {
    const html = renderSiteHtml();
    const privacy = renderPrivacyHtml();
    expect(html).toContain('<link rel="canonical" href="https://hra.sh/">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html.match(/<script\b/gu)).toHaveLength(2);
    expect(html.match(/<script[^>]+src=/gu)).toHaveLength(1);
    expect(html).toContain(renderHraAnalyticsScript());
    expect(privacy).toContain(renderHraAnalyticsScript());
    expect(renderPreviewHtml()).not.toContain(renderHraAnalyticsScript());
    expect(html).not.toContain("onclick=");
  });

  test("renders the canonical Hraness network footer on every HTML page", () => {
    const expectedHrefs = [
      HRANESS_HOME_URL,
      ...hranessSocialLinks.map(({ href }) => href),
    ];

    for (const document of [
      renderSiteHtml(),
      renderPrivacyHtml(),
    ]) {
      expect(document.match(/<footer\b/gu)).toHaveLength(1);
      const footer = /<footer\b[\s\S]*?<\/footer>/u.exec(document)?.[0];
      expect(footer).toContain('data-slot="hraness-site-footer"');
      expect(footer?.match(/data-slot="hraness-mark"/gu)).toHaveLength(1);
      expect(footer?.match(/data-slot="social-icon"/gu)).toHaveLength(11);
      expect(footer).toContain('data-mailing-list="none"');
      expect(footer).toContain('href="https://substack.com/@hraness"');
      expect(
        [...(footer?.matchAll(/<a\b[^>]*\shref="([^"]+)"/gu) ?? [])]
          .map((match) => match[1]),
      ).toEqual(expectedHrefs);
      expect(document.indexOf('class="project-resources"')).toBeLessThan(
        document.indexOf('data-slot="hraness-site-footer"'),
      );
    }
  });

  test("renders only the HRA mailing audience when Turnstile is configured", () => {
    const sitekey = "1x00000000000000000000AA";
    expect(hraMailingListConfig({
      [HRA_MAILING_TURNSTILE_SITEKEY_ENV]: sitekey,
    })).toEqual({
      audience: "hra",
      kind: "signup",
      turnstileSitekey: sitekey,
    });
    expect(hraMailingListConfig({})).toEqual({ kind: "none" });
    expect(hraMailingListConfig({
      [HRA_MAILING_TURNSTILE_SITEKEY_ENV]: "",
    })).toEqual({ kind: "none" });

    const footer = renderHraSiteFooter({
      [HRA_MAILING_TURNSTILE_SITEKEY_ENV]: sitekey,
    });
    expect(footer).toContain('data-mailing-list="signup"');
    expect(footer).toContain('name="audience" type="hidden" value="hra"');
    expect(footer).toContain('data-action="mailing_hra"');
    expect(footer).toContain(
      'action="https://account.hraness.com/api/mailing/subscribe"',
    );
    expect(footer).toContain(
      'src="https://challenges.cloudflare.com/turnstile/v0/api.js"',
    );
    expect(footer).toContain('href="https://substack.com/@hraness"');
  });

  test("fails production closed on missing or malformed Turnstile configuration", () => {
    expect(hraMailingListConfig({ VERCEL_ENV: "preview" }))
      .toEqual({ kind: "none" });
    for (const turnstileSitekey of [undefined, ""]) {
      expect(() => {
        hraMailingListConfig({
          [HRA_MAILING_TURNSTILE_SITEKEY_ENV]: turnstileSitekey,
          VERCEL_ENV: "production",
        });
      })
        .toThrow(HRA_MAILING_TURNSTILE_SITEKEY_ENV);
    }
    for (const turnstileSitekey of [
      "too-short",
      "1x00000000000000000000AA!",
      "x".repeat(101),
    ]) {
      expect(() => {
        hraMailingListConfig({
          [HRA_MAILING_TURNSTILE_SITEKEY_ENV]: turnstileSitekey,
        });
      })
        .toThrow(HRA_MAILING_TURNSTILE_SITEKEY_ENV);
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
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain('<a class="skip-link" href="#content">Skip to content</a>');
    expect(html).toContain('<main id="content">');
    expect(html).toContain('aria-label="Documentation"');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain(" style=");
  });

  test("keeps retired adjacent-reading routes out of product discovery", () => {
    const retiredRoutes = [
      "/reading/deepseek-harness/",
      "/reading/hax/",
      "/reading/headlong-microharness/",
      "/reading/oracle-and-firm/",
    ] as const;
    const publicDocuments = [
      renderSiteHtml(),
      renderLlmsText(),
      renderReadmeMarkdown(),
      renderSitemapXml(),
    ];

    expect(siteDocumentPaths).toEqual(["/", "/privacy/"]);
    for (const route of retiredRoutes) {
      for (const document of publicDocuments) {
        expect(document).not.toContain(route);
      }
    }
  });
});
