#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  directAppearanceBootstrapAttribute,
  directAppearanceBootstrapMarker,
} from "./appearance-bootstrap";

export function builtDirectAppearanceViolations(documentSource: string): readonly string[] {
  const failures: string[] = [];
  const htmlStart = documentSource.indexOf("<html");
  const htmlEnd = documentSource.indexOf(">", htmlStart);
  const htmlTag = htmlStart < 0 || htmlEnd < 0
    ? ""
    : documentSource.slice(htmlStart, htmlEnd + 1);
  const headStart = documentSource.indexOf("<head>");
  const headEnd = documentSource.indexOf("</head>", headStart);
  const scriptPattern = new RegExp(
    `<script\\s+${directAppearanceBootstrapAttribute}=(?:""|'')[^>]*>([\\s\\S]*?)<\\/script>`,
    "gu",
  );
  const scripts = [...documentSource.matchAll(scriptPattern)];
  const scriptStart = scripts[0]?.index ?? -1;
  const openingTag = scriptStart < 0
    ? ""
    : documentSource.slice(scriptStart, documentSource.indexOf(">", scriptStart) + 1);
  const firstStylesheet = documentSource.search(
    /<link\b(?=[^>]*\brel=(?:"stylesheet"|'stylesheet'))[^>]*>/u,
  );
  const firstAppModule = documentSource.search(
    /<script\b(?=[^>]*\btype=(?:"module"|'module'))[^>]*>/u,
  );

  if (!/\bdata-theme=(?:"light"|'light')/u.test(htmlTag)) {
    failures.push("built Direct HTML lost the concrete light SSR fallback");
  }
  if (documentSource.includes(directAppearanceBootstrapMarker)) {
    failures.push("built Direct HTML retained the appearance bootstrap marker");
  }
  if (scripts.length !== 1) {
    failures.push(`built Direct HTML has ${scripts.length} appearance bootstrap scripts instead of 1`);
  }
  if (headStart < 0 || headEnd < 0 || scriptStart <= headStart || scriptStart >= headEnd) {
    failures.push("appearance bootstrap is not inside the built document head");
  }
  if (/\b(?:src|type)=/u.test(openingTag)) {
    failures.push("appearance bootstrap is not a self-contained classic script");
  }
  if (firstStylesheet < 0) {
    failures.push("built Direct HTML is missing its stylesheet");
  } else if (firstStylesheet <= headStart || firstStylesheet >= headEnd) {
    failures.push("built Direct HTML stylesheet is not inside the document head");
  } else if (scriptStart >= firstStylesheet) {
    failures.push("appearance bootstrap runs after the built stylesheet");
  }
  if (firstAppModule < 0) {
    failures.push("built Direct HTML is missing its app module");
  } else if (scriptStart >= firstAppModule) {
    failures.push("appearance bootstrap runs after the app module");
  }

  const script = scripts[0]?.[1] ?? "";
  for (const contract of [
    "jungle-design-theme-v1",
    'fallback="system"',
    "localStorage.getItem(key)",
    'matchMedia("(prefers-color-scheme: dark)")',
    "root.dataset.theme=resolvedTheme",
    "root.dataset.hraAppearanceBootstrapThemeColor=themeColor",
    'background.dataset.hraAppearanceBootstrapBackground=""',
    "getComputedStyle(root).backgroundColor",
    'meta.name="theme-color"',
    'window,"__hraAppearanceBootstrap"',
    "Object.freeze",
    'schema:"hra.appearance-bootstrap/v1"',
  ]) {
    if (!script.includes(contract)) {
      failures.push(`appearance bootstrap is missing ${JSON.stringify(contract)}`);
    }
  }
  return failures;
}

export async function verifyBuiltDirectAppearance(
  documentPath = fileURLToPath(new URL("../dist-direct/index.html", import.meta.url)),
): Promise<void> {
  const documentSource = await readFile(documentPath, "utf8");
  const failures = builtDirectAppearanceViolations(documentSource);
  if (failures.length > 0) throw new Error(failures.join("; "));
}

if (import.meta.main) {
  await verifyBuiltDirectAppearance();
  console.log("HRA Direct built appearance bootstrap verified.");
}
