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
      initCommand: "hra init",
      installCommand: "bun add --global github:hraness/hra#v0.1.0",
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
      html.indexOf(publicContent.initCommand),
    );
    expect(html.indexOf(publicContent.initCommand)).toBeLessThan(
      html.indexOf(publicContent.doctorCommand),
    );
    expect(markdown.indexOf(publicContent.installCommand)).toBeLessThan(
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
    expect(markdown).toContain("hra device approve <pending-device-id-or-prefix>");
    expect(html).toContain("hra device approve &lt;pending-device-id-or-prefix&gt;");
    for (const surface of [markdown, html]) {
      expect(surface).toContain("automatically registers the current installation");
      expect(surface).toContain("registered as pending");
      expect(surface).toContain("no synchronized data, execution, or key authority");
      expect(surface).not.toContain("device pair` to create a pending device request");
      expect(surface).not.toContain("device pair</code> to create a pending device request");
    }
    for (const surface of [markdown, html]) {
      expect(surface).toContain("capability-only progress");
      expect(surface).toContain("does not delete local Codex accounts");
      expect(surface).not.toContain("account deletion remains a launch gate and must be implemented");
    }
  });

  test("publishes an explicit read-only plugin boundary", () => {
    const claims = [
      "hra plugin list <account> [--project <project>] [--refresh]",
      "hra plugin show <account> <plugin> [--project <project>] [--refresh]",
      "Plugin commands are read-only discovery.",
      "Pinned Codex 0.149.0 has no safely separated install, enablement, and OAuth lifecycle surface",
      "HRA therefore does not expose plugin install, enable, disable, OAuth, or permission effects.",
    ];
    const markdown = renderReadmeMarkdown();
    const html = renderSiteHtml();
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(
        claim.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
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
      "Codex credentials, profile files, plugin credentials, or OAuth material.",
      "Raw reasoning, hidden chain of thought, or approval secrets.",
      "Email access alone does not recover that key.",
      "The website uses no analytics, cookies, remote fonts, or executable JavaScript.",
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
