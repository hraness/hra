import { describe, expect, test } from "bun:test";

import {
  HRA_BRAND_EMOJI,
  HRA_RELEASE,
  HRA_RELEASE_CHECKSUM_URL,
  HRA_RELEASE_MANIFEST_URL,
  HRA_RELEASE_URL,
} from "./site";

async function source(name: string): Promise<string> {
  return Bun.file(new URL(name, import.meta.url)).text();
}

describe("HRA public landing", () => {
  test("uses the phoenix across product marks and generated icons", async () => {
    const [page, download, adminShell, openGraphImage, site] = await Promise.all([
      source("./page.tsx"),
      source("./download/page.tsx"),
      source("./admin-shell.tsx"),
      source("./opengraph-image.tsx"),
      source("./site.ts"),
    ]);
    const sha256 = async (name: string) => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(await Bun.file(new URL(name, import.meta.url)).arrayBuffer());
      return hasher.digest("hex");
    };

    expect(HRA_BRAND_EMOJI).toBe("🐦‍🔥");
    expect(site).toContain('HRA_BRAND_EMOJI = "🐦‍🔥"');
    expect(site).toContain('HRA_BRAND_ICON_PATH = "/icon.png"');
    expect(page).toContain("HRA_BRAND_ICON_PATH");
    expect(download).toContain("HRA_BRAND_ICON_PATH");
    expect(adminShell).toContain("HRA_BRAND_ICON_PATH");
    expect(openGraphImage).toContain('join(process.cwd(), "app", "icon.png")');
    expect(openGraphImage).toContain('"base64"');
    expect(openGraphImage).toContain("const phoenixIconSource =");
    expect(openGraphImage).toContain("data:image/png;base64,");
    expect(openGraphImage).not.toContain("phoenixIcon.src");
    for (const brandedSurface of [page, download, adminShell]) {
      expect(brandedSurface).not.toContain("{HRA_BRAND_EMOJI}");
    }
    expect(page).toContain('aria-label="HRA home"');
    expect(download).toContain('aria-label="HRA download"');
    expect(adminShell).not.toContain('className="brand-mark" aria-hidden="true">OP');
    expect(await sha256("./icon.png")).toBe(
      "17f58b8c253691f5302d5a742f540e04e7b8105bad1032cd1f1320a9388029e1",
    );
    expect(await sha256("./apple-icon.png")).toBe(
      "b9d3d18a3375f026afca7a82c222ce961187e3383714a8f600a5dc9692e98520",
    );
    expect(await sha256("../../desktop/assets/icon.png")).toBe(
      "451bf4681fe1ac0b1210e0d53668d13ea47405df41f29bb8998e40fa401e8320",
    );
  });

  test("leads with the outcome and exposes the complete public decision path", async () => {
    const page = await source("./page.tsx");

    expect(page).toContain("A metaharness for Codex");
    expect(page).toContain("Give Codex a team, a memory, and a budget.");
    expect(page).toContain("Codex accounts you already use");
    expect(page).toContain("Delegate work with structure");
    expect(page).toContain("Spend reasoning deliberately");
    expect(page).toContain("Recover the work, not just the window");
    expect(page.match(/<h1\b/gu)).toHaveLength(1);
    expect(page).toContain('href="/download">Download for macOS</Link>');
    expect(page).toContain('href="/alternatives">Compare HRA</Link>');
    expect(page).toContain('href="https://github.com/hraness/hra"');
    expect(page).toContain("Let the Mac keep the authority.");
    expect(page).toContain("HRA is intentionally narrower than an AI IDE.");
    expect(page).toContain("A provider limit ends the affected turn.");
    expect(page).toContain("Before you give it a repository.");
    expect(page).toContain("The public repository includes the product source");
  });

  test("pins the exact honest native prerelease contract", async () => {
    const download = await source("./download/page.tsx");

    expect(HRA_RELEASE).toEqual({
      architecture: "Apple Silicon",
      asset: "HRA-0.1.7-8-macos-arm64.dmg",
      build: 8,
      manifestAsset: "HRA-0.1.7-8-release-manifest.json",
      minimumMacOS: "13",
      tag: "v0.1.7",
      version: "0.1.7",
    });
    expect(HRA_RELEASE_URL).toEndWith("/v0.1.7/HRA-0.1.7-8-macos-arm64.dmg");
    expect(HRA_RELEASE_CHECKSUM_URL).toBe(`${HRA_RELEASE_URL}.sha256`);
    expect(HRA_RELEASE_MANIFEST_URL).toEndWith("/v0.1.7/HRA-0.1.7-8-release-manifest.json");
    expect(download).toContain("Unknown developer.");
    expect(download).toContain("not Developer ID signed or notarized");
    expect(download).toContain("HRA_RELEASE_MANIFEST_URL");
  });

  test("keeps navigation, sections, disclosure, and structured data semantic", async () => {
    const page = await source("./page.tsx");

    expect(page).toContain('href="#main-content">Skip to content</a>');
    expect(page).toContain('aria-label="Primary navigation"');
    expect(page).toContain('<main id="main-content">');
    expect(page).toContain('<figure className="landing-authority-card">');
    expect(page).toContain("<figcaption>");
    expect(page).toContain('<ul aria-label="Control plane authority">');
    expect(page).toContain('<ul aria-label="Paired Mac authority">');
    expect(page).not.toContain('role="img"');
    expect(page.match(/<section aria-labelledby=/gu)?.length).toBeGreaterThanOrEqual(6);
    expect(page.match(/question:/gu)).toHaveLength(5);
    expect(page.match(/<details/gu)).toHaveLength(2);
    expect(page.match(/type="application\/ld\+json"/gu)).toHaveLength(2);
    expect(page).toContain("websiteJsonLd(hraSearchSite)");
    expect(page).toContain("webApplicationJsonLd(hraSearchSite");
  });

  test("makes the absence and residual boundary of analytics explicit", async () => {
    const page = await source("./page.tsx");

    expect(page).toContain("HRA adds no client-side analytics or advertising trackers to this page.");
    expect(page).toContain("Hosting providers may retain operational request logs");
    expect(page).not.toMatch(/posthog|plausible|segment|google analytics|gtag\(/iu);
    expect(page).not.toContain("data-analytics-");
  });

  test("positions the repository around concrete outcomes and boundaries", async () => {
    const readme = await source("../../../README.md");

    expect(readme).toContain("# HRA");
    expect(readme).toContain("**A metaharness for Codex.**");
    expect(readme).toContain("one durable system for planning work, delegating it, running it in parallel");
    expect(readme).toContain("[Website](https://hra.sh)");
    expect(readme).toContain("[![HRA](https://hra.sh/opengraph-image)](https://hra.sh)");
    expect(readme).toContain("[Download for macOS](https://hra.sh/download)");
    expect(readme).toContain("[Compare HRA](https://hra.sh/alternatives)");
    expect(readme).toContain("[Open HRA](https://hra.sh/app)");
    expect(readme).toContain("## Why HRA exists");
    expect(readme).toContain("Several authorized accounts, kept separate.");
    expect(readme).toContain("HRA does not combine subscriptions or bypass provider limits.");
    expect(readme).toContain("See [Security architecture](SECURITY_ARCHITECTURE.md)");
    expect(readme).toContain("HRA is under active development.");
  });
});
