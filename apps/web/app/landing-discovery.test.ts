import { describe, expect, test } from "bun:test";
import {
  createPublicSiteMetadata,
  serializeJsonLd,
  webApplicationJsonLd,
  websiteJsonLd,
} from "@hra-internal/web-discovery";

import { hraComparisons } from "./alternatives/comparisons";
import OpenGraphImage from "./opengraph-image";
import robots from "./robots";
import { hraSearchSite } from "./site";
import sitemap from "./sitemap";

describe("HRA public discovery contract", () => {
  test("publishes canonical social metadata for the public product", () => {
    expect(createPublicSiteMetadata(hraSearchSite)).toMatchObject({
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
        type: "website",
        url: "https://hra.sh/",
      },
      robots: { follow: true, index: true },
      twitter: { card: "summary_large_image" },
    });
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
