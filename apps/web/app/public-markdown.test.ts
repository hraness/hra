import { describe, expect, test } from "bun:test";

import { MARKDOWN_CONTENT_TYPE } from "./accept-negotiation";
import { hraComparisons } from "./alternatives/comparisons";
import { GET as getLlmsTxt, HEAD as headLlmsTxt } from "./llms.txt/route";
import {
  createDownloadMarkdown,
  createLandingMarkdown,
  createNotFoundMarkdown,
  HRA_LLMS_TXT,
  HRA_LLMS_TXT_PATH,
  isAuthProtectedTree,
  isPublicHtmlDocumentPath,
  publicDocumentMarkdown,
  resolvePublicDiscovery,
} from "./public-markdown";
import { HRA_RELEASE, hraSearchSite } from "./site";

describe("HRA public markdown representations", () => {
  test("publishes an llms.txt with when-to-use guidance and public page lists", () => {
    expect(HRA_LLMS_TXT.startsWith("# HRA\n")).toBeTrue();
    expect(HRA_LLMS_TXT).toContain(`> ${hraSearchSite.description}`);
    expect(HRA_LLMS_TXT).toContain("When to use this:");
    expect(HRA_LLMS_TXT).toContain("several coordinated Codex sessions");
    expect(HRA_LLMS_TXT).toContain("How an agent should call HRA:");
    expect(HRA_LLMS_TXT).toContain("Accept: text/markdown");
    expect(HRA_LLMS_TXT).not.toContain("OAuth client");
    expect(HRA_LLMS_TXT).toContain("https://hra.sh/");
    expect(HRA_LLMS_TXT).toContain("https://hra.sh/download");
    expect(HRA_LLMS_TXT).toContain("https://hra.sh/alternatives");
    expect(HRA_LLMS_TXT).toContain("https://hra.sh/llms.txt");
    expect(HRA_LLMS_TXT).toContain("https://hra.sh/sitemap.xml");
    for (const comparison of hraComparisons) {
      expect(HRA_LLMS_TXT).toContain(`https://hra.sh/alternatives/${comparison.slug}`);
    }
    expect(HRA_LLMS_TXT_PATH).toBe("/llms.txt");
  });

  test("keeps landing markdown aligned with the public product copy", () => {
    const markdown = createLandingMarkdown();
    expect(markdown).toContain("# Give Codex a team, a memory, and a budget.");
    expect(markdown).toContain("## When to use HRA");
    expect(markdown).toContain("Delegate work with structure");
    expect(markdown).toContain("A provider limit ends the affected turn.");
    expect(markdown).toContain("https://hra.sh/llms.txt");
    expect(markdown).toContain("https://hra.sh/sitemap.xml");
  });

  test("keeps download markdown honest about the current release contract", () => {
    const markdown = createDownloadMarkdown();
    expect(markdown).toContain("# Download HRA for your Mac.");
    expect(markdown).toContain(`macOS ${HRA_RELEASE.minimumMacOS}`);
    expect(markdown).toContain("not Developer ID signed or notarized");
    expect(markdown).toContain("https://hra.sh/llms.txt");
    if (HRA_RELEASE.availability === "candidate") {
      expect(markdown).toContain("Do not install an unpublished draft asset.");
    } else {
      expect(markdown).toContain(HRA_RELEASE.asset);
    }
  });

  test("renders every comparison from the existing first-party rows", () => {
    expect(publicDocumentMarkdown("/alternatives")).toContain(
      "Choose the layer you actually need.",
    );
    for (const comparison of hraComparisons) {
      const markdown = publicDocumentMarkdown(`/alternatives/${comparison.slug}`);
      expect(markdown, comparison.slug).toContain(`# HRA vs ${comparison.shortName}`);
      expect(markdown, comparison.slug).toContain(comparison.meaningfulDifference);
      expect(markdown, comparison.slug).toContain(comparison.rows[0]?.hra ?? "");
    }
  });

  test("gives unmatched public paths a markdown 404 with recovery links", () => {
    const markdown = createNotFoundMarkdown();
    expect(markdown).toContain("# Not found");
    expect(markdown).toContain("https://hra.sh/sitemap.xml");
    expect(markdown).toContain("https://hra.sh/llms.txt");
    expect(markdown).toContain("https://hra.sh/");
  });
});

describe("HRA public discovery decisions", () => {
  test("classifies only the existing public HTML documents", () => {
    expect(isPublicHtmlDocumentPath("/")).toBeTrue();
    expect(isPublicHtmlDocumentPath("/download/")).toBeTrue();
    expect(isPublicHtmlDocumentPath("/alternatives/codex-app")).toBeTrue();
    expect(isPublicHtmlDocumentPath("/alternatives/missing")).toBeFalse();
    expect(isPublicHtmlDocumentPath("/app")).toBeFalse();
    expect(isPublicHtmlDocumentPath("/llms.txt")).toBeFalse();
    expect(isAuthProtectedTree("/app/private")).toBeTrue();
    expect(isAuthProtectedTree("/this-path-does-not-exist")).toBeFalse();
  });

  test("serves markdown for Accept: text/markdown on public pages", () => {
    const home = resolvePublicDiscovery({
      accept: "text/markdown",
      method: "GET",
      nextInternalNavigation: false,
      pathname: "/",
    });
    expect(home).toMatchObject({
      action: "markdown",
      contentType: MARKDOWN_CONTENT_TYPE,
      status: 200,
    });
    if (home.action === "markdown") {
      expect(home.body).toContain("Give Codex a team, a memory, and a budget.");
    }
  });

  test("returns 406 only when a public page cannot satisfy Accept", () => {
    expect(resolvePublicDiscovery({
      accept: "application/pdf",
      method: "GET",
      nextInternalNavigation: false,
      pathname: "/",
    })).toEqual({ action: "not_acceptable" });
    expect(resolvePublicDiscovery({
      accept: "application/pdf",
      method: "GET",
      nextInternalNavigation: false,
      pathname: "/this-path-does-not-exist",
    })).toEqual({ action: "passthrough" });
  });

  test("returns a markdown 404 for unknown public paths", () => {
    const missing = resolvePublicDiscovery({
      accept: "text/markdown",
      method: "GET",
      nextInternalNavigation: false,
      pathname: "/this-path-does-not-exist",
    });
    expect(missing).toMatchObject({ action: "markdown", status: 404 });
    if (missing.action === "markdown") {
      expect(missing.body).toContain("https://hra.sh/sitemap.xml");
    }
  });

  test("does not negotiate private trees, machine files, or Next internals", () => {
    for (const [pathname, accept] of [
      ["/app", "text/markdown"],
      ["/auth/sign-in", "text/markdown"],
      ["/api/suite-auth/session", "text/markdown"],
      ["/design", "text/markdown"],
      ["/robots.txt", "text/markdown"],
      ["/sitemap.xml", "text/markdown"],
      ["/llms.txt", "text/markdown"],
      ["/icon.png", "text/markdown"],
    ] as const) {
      expect(resolvePublicDiscovery({
        accept,
        method: "GET",
        nextInternalNavigation: false,
        pathname,
      }), pathname).toEqual({ action: "passthrough" });
    }
    expect(resolvePublicDiscovery({
      accept: "text/markdown",
      method: "POST",
      nextInternalNavigation: false,
      pathname: "/",
    })).toEqual({ action: "passthrough" });
    expect(resolvePublicDiscovery({
      accept: "text/markdown",
      method: "GET",
      nextInternalNavigation: true,
      pathname: "/",
    })).toEqual({ action: "passthrough" });
  });
});

describe("llms.txt route", () => {
  test("serves the same markdown body for GET and headers-only HEAD", async () => {
    const response = getLlmsTxt();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(MARKDOWN_CONTENT_TYPE);
    expect(await response.text()).toBe(HRA_LLMS_TXT);

    const head = headLlmsTxt();
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe(MARKDOWN_CONTENT_TYPE);
    expect(await head.text()).toBe("");
  });
});
