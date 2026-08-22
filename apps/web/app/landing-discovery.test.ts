import { describe, expect, test } from "bun:test";
import {
  createPublicSiteMetadata,
  serializeJsonLd,
  webApplicationJsonLd,
  websiteJsonLd,
} from "@hraness/web-discovery";

import { generateMetadata as comparisonMetadata } from "./alternatives/[slug]/page";
import { metadata as alternativesMetadata } from "./alternatives/page";
import { hraComparisons } from "./alternatives/comparisons";
import { metadata as downloadMetadata } from "./download/page";
import { metadata as notFoundMetadata } from "./not-found";
import OpenGraphImage from "./opengraph-image";
import { metadata as homepageMetadata } from "./page";
import { HRA_LLMS_TXT } from "./public-markdown";
import robots from "./robots";
import {
  hraRootMetadata,
  hraSearchSite,
  hraSocialPageTitle,
} from "./site";
import sitemap from "./sitemap";

describe("HRA public discovery contract", () => {
  test("publishes canonical social metadata for the public product", () => {
    const product = createPublicSiteMetadata(hraSearchSite);
    expect(product).toMatchObject({
      alternates: { canonical: "https://hra.sh/" },
      applicationName: "HRA",
      description: hraSearchSite.description,
      openGraph: {
        images: [{
          alt: "HRA: a durable metaharness for Codex",
          height: 630,
          url: "https://hra.sh/opengraph-image",
          width: 1200,
        }],
        siteName: "HRA",
        title: hraSearchSite.title,
        type: "website",
        url: "https://hra.sh/",
      },
      robots: { follow: true, index: true },
      title: { default: hraSearchSite.title, template: hraSearchSite.titleTemplate },
      twitter: { card: "summary_large_image", title: hraSearchSite.title },
    });
    expect(product.openGraph?.title).toBe(hraSearchSite.title);
    expect(product.twitter?.title).toBe(hraSearchSite.title);
  });

  test("keeps only inheritable site-wide defaults on the root layout", () => {
    expect(hraRootMetadata).toMatchObject({
      applicationName: "HRA",
      creator: "Hraness",
      publisher: "Hraness",
      title: { default: "HRA", template: "%s · HRA" },
      openGraph: { siteName: "HRA", type: "website" },
    });
    expect(hraRootMetadata).not.toHaveProperty("description");
    expect(hraRootMetadata).not.toHaveProperty("robots");
    expect(hraRootMetadata).not.toHaveProperty("keywords");
    expect(hraRootMetadata).not.toHaveProperty("alternates");
    expect(hraRootMetadata.openGraph).not.toHaveProperty("url");
    expect(hraRootMetadata.openGraph).not.toHaveProperty("title");
    expect(hraRootMetadata.openGraph).not.toHaveProperty("description");
    expect(hraRootMetadata.twitter).not.toHaveProperty("title");
    expect(hraRootMetadata.twitter).not.toHaveProperty("description");
  });

  test("lets the homepage own the indexable product identity", () => {
    expect(homepageMetadata).toMatchObject({
      alternates: { canonical: "https://hra.sh/" },
      description: hraSearchSite.description,
      robots: { follow: true, index: true },
      title: { absolute: hraSearchSite.title },
    });
    expect(homepageMetadata.openGraph?.title).toBe(hraSearchSite.title);
    expect(homepageMetadata.twitter?.title).toBe(hraSearchSite.title);
    expect(homepageMetadata.openGraph?.url).toBe("https://hra.sh/");
  });

  test("keeps HTML titles aligned with Open Graph titles", () => {
    expect(hraSocialPageTitle("HRA for macOS")).toBe("HRA for macOS · HRA");
    expect(downloadMetadata.title).toEqual({
      default: "HRA for macOS",
      template: "%s · HRA",
    });
    expect(downloadMetadata.openGraph?.title).toBe("HRA for macOS · HRA");
    expect(downloadMetadata.twitter?.title).toBe("HRA for macOS · HRA");
    expect(alternativesMetadata.title).toEqual({
      default: "HRA alternatives",
      template: "%s · HRA",
    });
    expect(alternativesMetadata.openGraph?.title).toBe("HRA alternatives · HRA");
    expect(alternativesMetadata.twitter?.title).toBe("HRA alternatives · HRA");
  });

  test("keeps comparison titles aligned with Open Graph titles", async () => {
    const metadata = await comparisonMetadata({
      params: Promise.resolve({ slug: "codex-app" }),
    });
    expect(metadata.title).toEqual({
      default: "HRA vs Codex app",
      template: "%s · HRA",
    });
    expect(metadata.openGraph?.title).toBe("HRA vs Codex app · HRA");
    expect(metadata.twitter?.title).toBe("HRA vs Codex app · HRA");
    expect(metadata.alternates?.canonical).toBe("https://hra.sh/alternatives/codex-app");
  });

  test("gives unmatched routes a distinct noindex page", () => {
    expect(notFoundMetadata).toEqual({
      description: "This page does not exist.",
      robots: {
        follow: false,
        googleBot: {
          follow: false,
          index: false,
          noarchive: true,
          nosnippet: true,
        },
        index: false,
      },
      title: { absolute: "Not found · HRA" },
    });
    expect(notFoundMetadata).not.toHaveProperty("alternates");
    expect(notFoundMetadata).not.toHaveProperty("openGraph");
  });

  test("keeps crawler files on the existing public product surface", () => {
    expect(HRA_LLMS_TXT).toContain("When to use this:");
    expect(HRA_LLMS_TXT).toContain("https://hra.sh/sitemap.xml");
    expect(robots().sitemap).toBe("https://hra.sh/sitemap.xml");
    expect(sitemap().some((entry) => entry.url === "https://hra.sh/llms.txt")).toBeFalse();
  });

  test("indexes the public product, download, and sourced comparison surfaces", () => {
    expect(robots()).toEqual({
      host: "https://hra.sh",
      rules: {
        allow: "/",
        disallow: ["/api", "/app", "/auth", "/design"],
        userAgent: "*",
      },
      sitemap: "https://hra.sh/sitemap.xml",
    });
    expect(sitemap()).toEqual([
      {
        changeFrequency: "weekly",
        priority: 1,
        url: "https://hra.sh/",
      },
      {
        changeFrequency: "weekly",
        priority: 0.8,
        url: "https://hra.sh/download",
      },
      {
        changeFrequency: "monthly",
        priority: 0.8,
        url: "https://hra.sh/alternatives",
      },
      ...hraComparisons.map(({ slug }) => ({
        changeFrequency: "monthly" as const,
        priority: 0.7,
        url: `https://hra.sh/alternatives/${slug}`,
      })),
    ]);
  });

  test("describes the site and application without unsafe JSON-LD bytes", () => {
    const website = websiteJsonLd(hraSearchSite);
    const application = webApplicationJsonLd(hraSearchSite, {
      category: "DeveloperApplication",
      features: ["Durable task graph", "Human review", "Local credential custody"],
    });
    expect(website).toMatchObject({
      "@type": "WebSite",
      name: "HRA",
      url: "https://hra.sh/",
    });
    expect(application).toMatchObject({
      "@type": "WebApplication",
      applicationCategory: "DeveloperApplication",
      featureList: ["Durable task graph", "Human review", "Local credential custody"],
    });
    expect(serializeJsonLd({ unsafe: "</script>&\u2028" }))
      .toBe('{"unsafe":"\\u003c/script\\u003e\\u0026\\u2028"}');
  });

  test("pins the generated social card dimensions and copy", async () => {
    const image = await Bun.file(new URL("./opengraph-image.tsx", import.meta.url)).text();
    expect(image).toContain('export const alt = "HRA: a durable metaharness for Codex"');
    expect(image).toContain("height: 630, width: 1200");
    expect(image).toContain("Give Codex a team, a memory, and a budget.");
    expect(image).toContain("Authorized accounts · Durable delegation · Recoverable work");
  });

  test("renders the local phoenix into the full-size social card", async () => {
    const response = await OpenGraphImage();
    const image = new Uint8Array(await response.arrayBuffer());
    const imageView = new DataView(image.buffer, image.byteOffset, image.byteLength);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Array.from(image.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(imageView.getUint32(16)).toBe(1200);
    expect(imageView.getUint32(20)).toBe(630);
  });
});
