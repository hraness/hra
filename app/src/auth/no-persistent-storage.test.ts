import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

const appSource = join(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * Comments name these APIs on purpose (to say the app does not use them), so
 * the scan reads code only.
 */
function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//gu, " ").replaceAll(/(^|[^:])\/\/.*$/gmu, "$1");
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (/\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name)) {
        found.push(child);
      }
    }
  };
  await visit(root);
  return found.sort();
}

describe("browser storage discipline", () => {
  test("no module reaches localStorage, sessionStorage, or document.cookie", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles(appSource)) {
      const text = stripComments(await readFile(path, "utf8"));
      if (/\blocalStorage\b|\bsessionStorage\b|document\.cookie/u.test(text)) {
        offenders.push(relative(appSource, path));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the only persistent store is IndexedDB, and only for device key pairs", async () => {
    const users: string[] = [];
    for (const path of await sourceFiles(appSource)) {
      const text = stripComments(await readFile(path, "utf8"));
      if (/\bindexedDB\b/u.test(text)) users.push(relative(appSource, path));
    }
    expect(users).toEqual(["custody/keystore.ts"]);
  });

  test("the auth provider is constructed with the in-memory storage", async () => {
    const text = await readFile(join(appSource, "app.tsx"), "utf8");
    expect(text).toContain("<ConvexAuthProvider client={convexClient} storage={memoryTokenStorage}>");
  });

  test("no module registers a service worker or loads an analytics script", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles(appSource)) {
      const text = stripComments(await readFile(path, "utf8"));
      if (/serviceWorker|analytics|posthog|gtag/iu.test(text)) {
        offenders.push(relative(appSource, path));
      }
    }
    expect(offenders).toEqual([]);
  });
});
