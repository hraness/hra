import { describe, expect, test } from "bun:test";

import {
  publicContent,
  renderPrivacyMarkdown,
  renderReadmeMarkdown,
} from "./content.ts";
import { renderPrivacyHtml, renderSiteHtml } from "./template.ts";

const firstSubstantiveReadmeLine = (markdown: string): string => {
  const lines = markdown.split("\n");
  const titleIndex = lines.findIndex((line) => line === `# ${publicContent.productName}`);
  return lines.slice(titleIndex + 1).find((line) => line.trim().length > 0 && line !== "```sh") ?? "";
};

describe("public content contract", () => {
  test("publishes the exact HRA release identity", () => {
    expect(publicContent).toMatchObject({
      doctorCommand: "hra doctor --offline",
      initCommand: "hra init --yes",
      installCommand: "bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz",
      links: {
        github: "https://github.com/hraness/hra",
      },
      productName: "HRA",
      siteUrl: "https://hra.sh",
    });
  });

  test("leads both public surfaces with the eventual beta install command", () => {
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();

    expect(firstSubstantiveReadmeLine(markdown)).toBe(publicContent.installCommand);
    expect(html.indexOf(`<h1>${publicContent.productName}</h1>`)).toBeLessThan(
      html.indexOf(publicContent.installCommand),
    );
    expect(html.indexOf(publicContent.installCommand)).toBeLessThan(
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

  test("marks unavailable external endpoints in source", () => {
    expect(publicContent.endpoints).toEqual({
      betaTag: "beta-not-yet-live",
      githubRepository: "live",
      hostedSync: "beta-not-yet-live",
      website: "beta-not-yet-live",
    });
    expect(renderReadmeMarkdown()).toContain("beta-not-yet-live");
    expect(renderSiteHtml()).toContain("beta-not-yet-live");
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
    for (const surface of [markdown, html]) {
      expect(surface).toContain("An unset");
      expect(surface).toContain("hosted deployment");
      expect(surface).toContain("explicit empty value");
      expect(surface).toContain("self-managed Convex deployment");
      expect(surface).toContain("permanently binds that local state root");
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
      "It renders assistant and provider-visible reasoning-summary text only after observing that item's start boundary",
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
      "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <current-uuidv7>] [--json]",
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
    const command = "hra sync projection recover <local-session-selector> --acknowledge-gap [--idempotency-key <current-uuidv7>] [--json]";

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
    const surfaces = [markdown, renderSiteHtml()];
    for (const surface of surfaces) {
      expect(surface).toContain("HRA requires Bun 1.3.14");
      expect(surface).toContain("support macOS and Linux");
      expect(surface).toContain("bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz");
      expect(surface).toContain("bun remove --global hra");
      expect(surface).toContain("hra daemon stop");
      expect(surface).toContain("hra daemon status --json");
      expect(surface).toContain("hra daemon start");
      expect(surface).toContain("Removing the package does not remove");
      expect(surface).toContain("local profiles, session history, recovery evidence, or cloud account");
      expect(surface).toContain("Do not install a moving branch");
      expect(surface).toContain("verified repair installation of v0.1.0");
      expect(surface).toContain("replace both v0.1.0 occurrences");
    }
    const updateStart = markdown.indexOf("Before updating");
    const updateDoctor = markdown.indexOf("hra doctor --offline", updateStart);
    const updateRestart = markdown.indexOf("hra daemon start", updateStart);
    expect(updateDoctor).toBeGreaterThan(updateStart);
    expect(updateRestart).toBeGreaterThan(updateDoctor);
    const removalWarning = markdown.indexOf("Removing the package does not remove");
    const removalCommand = markdown.indexOf("bun remove --global hra");
    expect(removalWarning).toBeGreaterThan(-1);
    expect(removalCommand).toBeGreaterThan(removalWarning);
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

  test("provides keyboard and landmark structure without inline presentation", () => {
    const html = renderSiteHtml();
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain('<a class="skip-link" href="#content">Skip to content</a>');
    expect(html).toContain('<main id="content">');
    expect(html).toContain('aria-label="Documentation"');
    expect(html).not.toContain("<style>");
    expect(html).not.toContain(" style=");
  });
});
