import { describe, expect, test } from "bun:test";
import {
  createPublicSiteMetadata,
  serializeJsonLd,
  webApplicationJsonLd,
  websiteJsonLd,
} from "@hra-internal/web-discovery";

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
          alt: "HRA — durable control for parallel Codex work",
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

  test("indexes only the public landing and download surfaces", () => {
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
    expect(image).toContain('export const alt = "HRA — durable control for parallel Codex work"');
    expect(image).toContain("height: 630, width: 1200");
    expect(image).toContain("Run parallel project work without losing the thread.");
    expect(image).toContain("Durable tasks · Human review · Local authority");
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
