import { describe, expect, test } from "bun:test";

import {
  absoluteWebUrl,
  createPrivateRobots,
  createPrivateSiteMetadata,
  createIndexNowPayload,
  createPublicRobots,
  createPublicSiteMetadata,
  createSitemap,
  createWebManifest,
  NOINDEX_ROBOTS,
  parseOwnedPath,
  profilePageJsonLd,
  serializeJsonLd,
  webApplicationJsonLd,
  websiteJsonLd,
  type SearchSite,
} from "./discovery";

const site = {
  description: "A useful public browser tool.",
  name: "Example",
  origin: "https://example.com",
  socialTitle: "Example — useful browser tool",
  title: "Example",
  titleTemplate: "%s — Example",
} as const satisfies SearchSite;

describe("web discovery foundations", () => {
  test("builds coherent public metadata from one origin", () => {
    const metadata = createPublicSiteMetadata(site);

    expect(metadata.metadataBase?.toString()).toBe("https://example.com/");
    expect(metadata.alternates).toEqual({
      canonical: "https://example.com/",
    });
    expect(metadata.openGraph).toMatchObject({
      url: "https://example.com/",
      title: site.socialTitle,
      images: [
        {
          url: "https://example.com/opengraph-image",
          width: 1200,
          height: 630,
        },
      ],
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: site.socialTitle,
    });
  });

  test("keeps private surfaces out of index and social discovery", () => {
    const metadata = createPrivateSiteMetadata(site);

    expect(metadata.robots).toEqual(NOINDEX_ROBOTS);
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).toBeUndefined();
    expect(metadata.twitter).toBeUndefined();
    expect(createPrivateRobots()).toEqual({
      rules: { disallow: "/", userAgent: "*" },
    });
  });

  test("publishes canonical crawler and sitemap locations", () => {
    expect(createPublicRobots(site.origin, { disallow: ["/api/"] })).toEqual({
      host: "https://example.com",
      rules: {
        allow: "/",
        disallow: ["/api/"],
        userAgent: "*",
      },
      sitemap: "https://example.com/sitemap.xml",
    });
    expect(createSitemap(site.origin, [
      { path: "/", priority: 1 },
      {
        images: ["/guide.png"],
        lastModified: "2026-07-24",
        path: "/guide",
      },
    ])).toEqual([
      { priority: 1, url: "https://example.com/" },
      {
        images: ["https://example.com/guide.png"],
        lastModified: "2026-07-24",
        url: "https://example.com/guide",
      },
    ]);
    expect(() => createSitemap(site.origin, [{ path: "/" }, { path: "/" }]))
      .toThrow("Sitemap paths must be unique");
  });

  test("rejects noncanonical origins and foreign paths", () => {
    expect(() => absoluteWebUrl("https://example.com/path", "/"))
      .toThrow("bare HTTPS origins");
    expect(() => absoluteWebUrl(site.origin, "//other.example/path"))
      .toThrow("root-relative");
    expect(parseOwnedPath("/guide")).toBe("/guide");
    expect(() => parseOwnedPath("https://other.example/")).toThrow(
      "root-relative",
    );
    expect(() => parseOwnedPath("/guide?source=feed")).toThrow(
      "queries or fragments",
    );
    expect(() => parseOwnedPath("/guide#section")).toThrow(
      "queries or fragments",
    );
    expect(() => parseOwnedPath("/guide/../reference")).toThrow(
      "URL normalization",
    );
    expect(() => parseOwnedPath("/guide/./reference")).toThrow(
      "URL normalization",
    );
    expect(() => parseOwnedPath("/guide/%2e%2e/reference")).toThrow(
      "URL normalization",
    );
    expect(() => parseOwnedPath("/guide ")).toThrow(
      "URL normalization",
    );
  });

  test("deduplicates sitemap entries by their emitted absolute URL", () => {
    expect(() => createSitemap(site.origin, [
      { path: "/" },
      { path: "/" },
    ])).toThrow(
      "Sitemap paths must be unique after URL normalization",
    );
  });

  test("builds an installable manifest without inventing product facts", () => {
    expect(createWebManifest(site, {
      background: "#ffffff",
      theme: "#111111",
    })).toMatchObject({
      background_color: "#ffffff",
      description: site.description,
      name: site.name,
      theme_color: "#111111",
    });
  });

  test("deduplicates checked same-origin IndexNow URLs", () => {
    expect(createIndexNowPayload(
      site.origin,
      "abcdef123456",
      ["/", "/guide", "/guide"],
    )).toEqual({
      host: "example.com",
      key: "abcdef123456", // gitleaks:allow - deterministic test vector
      keyLocation: "https://example.com/abcdef123456.txt",
      urlList: [
        "https://example.com/",
        "https://example.com/guide",
      ],
    });
    expect(() => createIndexNowPayload(site.origin, "short", ["/"]))
      .toThrow("8–128");
    expect(() => createIndexNowPayload(site.origin, "abcdef123456", []))
      .toThrow("at least one");
  });

  test("keeps generic website and explicit app schema truthful", () => {
    expect(websiteJsonLd(site)).toMatchObject({
      "@type": "WebSite",
      name: site.name,
      url: "https://example.com/",
    });
    expect(webApplicationJsonLd(site, {
      category: "DeveloperApplication",
      features: ["Works locally"],
      free: true,
    })).toMatchObject({
      "@type": "WebApplication",
      applicationCategory: "DeveloperApplication",
      featureList: ["Works locally"],
      isAccessibleForFree: true,
      offers: { price: 0, priceCurrency: "USD" },
    });
  });

  test("describes a visible personal homepage as a profile page", () => {
    expect(profilePageJsonLd(site, {
      image: "/icon.png",
      name: "Example Person",
      sameAs: ["https://social.example/person"],
    })).toMatchObject({
      "@type": "ProfilePage",
      mainEntity: {
        "@type": "Person",
        image: "https://example.com/icon.png",
        name: "Example Person",
        sameAs: ["https://social.example/person"],
      },
    });
  });

  test("escapes JSON-LD for an HTML script context", () => {
    expect(serializeJsonLd({ value: "</script>&\u2028" })).toBe(
      "{\"value\":\"\\u003c/script\\u003e\\u0026\\u2028\"}",
    );
  });
});
