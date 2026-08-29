import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { publicContent, readingPages, renderSitemapXml } from "./content.ts";
import {
  editorialImages,
  editorialImageSrcSet,
  editorialImageUrl,
} from "./editorial-images.ts";
import { renderReadingHtml, renderReadingIndexHtml, renderSiteHtml } from "./template.ts";

const siteRoot = import.meta.dir;

describe("HRA editorial images", () => {
  test("keeps the visible figures, cards, discovery metadata, and retained evidence synchronized", async () => {
    const home = renderSiteHtml();
    const readingIndex = renderReadingIndexHtml();
    const sitemap = renderSitemapXml();

    expect(editorialImages).toHaveLength(readingPages.length);
    expect(home.match(/class="reading-card"/gu)).toHaveLength(editorialImages.length);
    expect(readingIndex.match(/class="reading-card"/gu)).toHaveLength(editorialImages.length);
    expect(home).toContain('<pre class="install-command" tabindex="0"><code>');
    expect(home).toContain(`<pre class="doctor-command" tabindex="0"><code>${publicContent.doctorCommand}</code></pre>`);
    expect(home).toContain('<meta property="og:image" content="https://hra.sh/social-card.svg">');
    expect(home).not.toContain('class="editorial-figure"');
    expect(readingIndex).toContain('<link rel="canonical" href="https://hra.sh/reading/">');
    expect(sitemap).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(sitemap.match(/<image:image>/gu)).toHaveLength(editorialImages.length);

    for (const image of editorialImages) {
      const page = readingPages.find((candidate) => candidate.canonicalPath === image.canonicalPath);
      expect(page).toBeDefined();
      const html = renderReadingHtml(page!);
      const imageUrl = editorialImageUrl(image);

      expect(home).toContain(`href="${image.canonicalPath}"`);
      expect(home).toContain(`src="${image.src}"`);
      expect(readingIndex).toContain(`href="${image.canonicalPath}"`);
      expect(html).toContain(`<meta property="og:image" content="${imageUrl}">`);
      expect(html).toContain('<meta property="og:image:type" content="image/webp">');
      expect(html).toContain(`<meta property="og:image:width" content="${image.width}">`);
      expect(html).toContain(`<meta property="og:image:height" content="${image.height}">`);
      expect(html).toContain(`<meta property="og:image:alt" content="${image.alt}">`);
      expect(html).toContain(`<meta name="twitter:image" content="${imageUrl}">`);
      expect(html).toContain(`<meta name="twitter:image:alt" content="${image.alt}">`);
      expect(html).toContain('class="editorial-figure"');
      expect(html).toContain(`src="${image.src}"`);
      expect(html).toContain(`srcset="${editorialImageSrcSet(image)}"`);
      expect(html).toContain(`alt="${image.alt}"`);
      expect(html).toContain(image.caption);
      expect(html).toContain(image.credit);
      expect(html).not.toContain("editorial-provenance/");
      expect(html).not.toContain("gateway_");
      expect(sitemap).toContain(`<image:loc>${imageUrl}</image:loc>`);
      expect(sitemap).toContain(`<image:title>${image.title}</image:title>`);
      expect(sitemap).toContain(`<image:caption>${image.caption}</image:caption>`);

      const jsonLdMatch = /<script type="application\/ld\+json">([^<]+)<\/script>/u.exec(html);
      const jsonLd = JSON.parse(jsonLdMatch?.[1] ?? "null") as { image?: unknown };
      expect(jsonLd.image).toEqual({
        "@type": "ImageObject",
        caption: image.caption,
        contentUrl: imageUrl,
        creditText: image.credit,
        height: image.height,
        url: imageUrl,
        width: image.width,
      });

      const bytes = new Uint8Array(await Bun.file(join(siteRoot, image.src.slice(1))).arrayBuffer());
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(image.imageSha256);
      const stem = image.src.slice(0, -".webp".length);
      const smallBytes = await Bun.file(join(siteRoot, `${stem.slice(1)}-384.webp`)).arrayBuffer();
      const mediumBytes = await Bun.file(join(siteRoot, `${stem.slice(1)}-768.webp`)).arrayBuffer();
      expect(smallBytes.byteLength).toBeLessThan(mediumBytes.byteLength);
      expect(mediumBytes.byteLength).toBeLessThan(bytes.byteLength);
      const receipt = await Bun.file(join(siteRoot, image.provenance.receipt)).json() as {
        localValidation?: { status?: string };
        outputs?: Array<{ sha256?: string }>;
      };
      const job = await Bun.file(join(siteRoot, image.provenance.job)).json() as {
        clientMaxRetries?: number;
        noAtetRetry?: boolean;
        state?: string;
      };
      const prompt = await Bun.file(join(siteRoot, image.provenance.prompt)).text();
      expect(receipt.outputs?.[0]?.sha256).toBe(image.imageSha256);
      expect(receipt.localValidation?.status).toBe("decode-passed");
      expect(job).toMatchObject({
        clientMaxRetries: 0,
        noAtetRetry: true,
        state: "completed",
      });
      expect(prompt.trim().length).toBeGreaterThan(80);
    }
  });
});
