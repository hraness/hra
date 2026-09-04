import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, test } from "bun:test";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(appRoot);
const distributionRoot = join(appRoot, "dist");

/*
 * The shipped bundle has to survive the F1 Content Security Policy:
 *
 *   default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none';
 *   connect-src <the three pinned Convex origins>; worker-src 'none'
 *
 * A violation is invisible at build time and fails silently in a browser, so
 * the build output itself is the fixture.
 *
 * These absolute URLs come from vendored library code and are reviewed: they
 * are documentation links and XML namespace constants in error paths, never
 * fetch targets. A new entry here means a dependency started naming a new
 * origin and needs review.
 */
const reviewedVendorOrigins = new Set([
  // XML namespace constants in React DOM.
  "http://www.w3.org",
  // Documentation links inside Convex client error messages.
  "https://docs.convex.dev",
  // An example deployment URL inside a Convex client error message.
  "https://happy-otter-123.convex.cloud",
  // The React error decoder link.
  "https://react.dev",
  // Changelog and repository links inside react-markdown and
  // hast-util-to-jsx-runtime error messages.
  "https://github.com",
]);

const pinnedConvexOrigins = new Set([
  "https://qualified-hummingbird-537.convex.cloud",
  "wss://qualified-hummingbird-537.convex.cloud",
  "https://qualified-hummingbird-537.convex.site",
]);

const originPattern = /(?:https?|wss?):\/\/[A-Za-z0-9._-]+/gu;

type Artifact = Readonly<{ name: string; text: string }>;

let artifacts: readonly Artifact[] = [];
let shell = "";

async function collect(root: string, prefix = ""): Promise<Artifact[]> {
  const found: Artifact[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = join(root, entry.name);
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await collect(child, name));
    else found.push({ name, text: await readFile(child, "utf8") });
  }
  return found;
}

beforeAll(async () => {
  const build = Bun.spawn(["bun", "run", "build:app"], {
    cwd: repositoryRoot,
    stderr: "pipe",
    stdout: "pipe",
  });
  const status = await build.exited;
  if (status !== 0) {
    throw new Error(`build:app failed: ${await new Response(build.stderr).text()}`);
  }
  artifacts = await collect(distributionRoot);
  shell = await readFile(join(distributionRoot, "index.html"), "utf8");
}, 180_000);

describe("built shell", () => {
  test("emits one module entry point and one linked stylesheet", () => {
    expect(artifacts.some((artifact) => artifact.name === "index.html")).toBe(true);
    expect(artifacts.filter((artifact) => artifact.name.endsWith(".js")).length)
      .toBeGreaterThanOrEqual(1);
    expect(artifacts.filter((artifact) => artifact.name.endsWith(".css")).length).toBe(1);
    expect(shell).toMatch(/<link rel="stylesheet"[^>]*href="\/assets\/[^"]+\.css"/u);
    expect(shell).toMatch(/<script type="module"[^>]*src="\/assets\/[^"]+\.js"/u);
  });

  test("carries the mobile viewport with the safe-area opt in", () => {
    expect(shell).toContain("viewport-fit=cover");
    expect(shell).toContain("width=device-width");
  });

  test("has no inline script", () => {
    expect(shell).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/u);
  });

  test("has no style element, because style-src is 'self'", () => {
    for (const artifact of artifacts) {
      expect(artifact.text).not.toMatch(/<style[\s>]/u);
    }
  });
});

describe("bundle invariants", () => {
  /*
   * `style-src 'self'` blocks a style attribute, and a violation is invisible
   * until a browser drops the rule, so the built text is the fixture. The
   * lookbehind excludes an assignment to a `style` member on an object, which
   * is how a vendored renderer builds a React props record: that is a property
   * write inside library code, not an attribute this app emits, and the
   * component overrides in `app/src/markdown/markdown.tsx` drop the prop before
   * it can reach an element. Anything that reads as an attribute, in the shell
   * or in a bundle, still fails here.
   */
  test("no output sets a style attribute", () => {
    for (const artifact of artifacts) {
      const offenders = [...artifact.text.matchAll(/(?<![.\w$])style\s*=/gu)];
      expect({ file: artifact.name, offenders: offenders.length }).toEqual({
        file: artifact.name,
        offenders: 0,
      });
    }
  });

  test("no output references a service worker", () => {
    for (const artifact of artifacts) {
      expect(artifact.text.includes("navigator.serviceWorker")).toBe(false);
      expect(artifact.text.includes("serviceWorker")).toBe(false);
    }
  });

  test("no output calls eval", () => {
    for (const artifact of artifacts) {
      expect(artifact.text.includes("eval(")).toBe(false);
    }
  });

  test("no output embeds a data URI asset", () => {
    for (const artifact of artifacts) {
      expect(artifact.text).not.toMatch(/data:[a-z]+\/[a-z0-9.+-]+;base64,/iu);
    }
  });

  test("every absolute URL is a pinned Convex origin or a reviewed vendor literal", () => {
    const unexpected = new Set<string>();
    for (const artifact of artifacts) {
      for (const match of artifact.text.matchAll(originPattern)) {
        const origin = match[0];
        if (pinnedConvexOrigins.has(origin) || reviewedVendorOrigins.has(origin)) continue;
        unexpected.add(`${artifact.name}: ${origin}`);
      }
    }
    expect([...unexpected]).toEqual([]);
  });

  test("names the pinned deployment", () => {
    const scripts = artifacts.filter((artifact) => artifact.name.endsWith(".js"));
    expect(scripts.some((artifact) =>
      artifact.text.includes("https://qualified-hummingbird-537.convex.cloud"))).toBe(true);
  });
});

describe("vercel project headers", () => {
  test("serve the F1 policy, the referrer policy, and the clipboard denial", async () => {
    const configuration = JSON.parse(
      await readFile(join(appRoot, "vercel.json"), "utf8"),
    ) as {
      headers: { headers: { key: string; value: string }[]; source: string }[];
      outputDirectory: string;
    };
    const all = configuration.headers.flatMap((entry) =>
      entry.headers.map((header) => [entry.source, header.key, header.value] as const));
    const find = (source: string, key: string) =>
      all.find(([entrySource, entryKey]) => entrySource === source && entryKey === key)?.[2];

    expect(configuration.outputDirectory).toBe("dist");
    expect(find("/(.*)", "Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'self'; "
      + "connect-src https://qualified-hummingbird-537.convex.cloud "
      + "wss://qualified-hummingbird-537.convex.cloud "
      + "https://qualified-hummingbird-537.convex.site; "
      + "style-src 'self'; img-src 'none'; font-src 'self'; base-uri 'none'; object-src 'none'; "
      + "form-action 'none'; worker-src 'none'; manifest-src 'none'; frame-ancestors 'none'",
    );
    expect(find("/(.*)", "Referrer-Policy")).toBe("no-referrer");
    expect(find("/(.*)", "X-Content-Type-Options")).toBe("nosniff");
    expect(find("/(.*)", "Permissions-Policy")).toContain("clipboard-read=()");
    expect(find("/", "Cache-Control")).toBe("no-store");
    expect(find("/index.html", "Cache-Control")).toBe("no-store");
  });
});
