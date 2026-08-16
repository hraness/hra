import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectGcmDependencyEvidence,
  gcmDependencyLicensePins,
  renderGcmDependencyLicenseNotices,
  serializeGcmDependencyLicenseInventory,
  verifyGcmDependencyLicenseInventory,
  type GcmDependencyLicenseDocument,
  type GcmDependencyLicenseInventory,
  type GcmDependencyLicensePackage,
  type GcmDependencyPackagePin,
} from "./gcm-dependency-licenses";

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeText(bytes: Uint8Array, label: string, allowBom = false): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    if (!allowBom) throw new Error(`${label} has a UTF-8 BOM.`);
    bytes = bytes.slice(3);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.length === 0) throw new Error(`${label} is empty.`);
  return text;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function unzipEntry(archivePath: string, entry: string): Promise<Uint8Array> {
  const child = Bun.spawn(["/usr/bin/unzip", "-p", archivePath, entry], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Could not extract ${entry}: ${stderr.trim()}`);
  }
  return new Uint8Array(stdout);
}

function addDocument(
  documents: Map<string, GcmDependencyLicenseDocument>,
  input: Readonly<{ name: string; sha256: string; source: string; text: string }>,
): void {
  if (sha256(new TextEncoder().encode(input.text)) !== input.sha256) {
    throw new Error(`License document hash differs: ${input.name}`);
  }
  const existing = documents.get(input.sha256);
  if (existing === undefined) {
    documents.set(input.sha256, {
      name: input.name,
      sha256: input.sha256,
      sources: [input.source],
      text: input.text,
    });
    return;
  }
  if (existing.name !== input.name || existing.text !== input.text) {
    throw new Error(`Conflicting license documents share ${input.sha256}.`);
  }
  documents.set(input.sha256, {
    ...existing,
    sources: [...new Set([...existing.sources, input.source])].sort(compareText),
  });
}

async function materializeNugetPackage(
  pin: GcmDependencyPackagePin,
  workRoot: string,
  documents: Map<string, GcmDependencyLicenseDocument>,
  runtimeAssets: GcmDependencyLicensePackage["runtimeAssets"],
): Promise<GcmDependencyLicensePackage> {
  const archiveBytes = await download(pin.nugetUrl);
  if (sha256(archiveBytes) !== pin.archiveSha256) {
    throw new Error(`NuGet archive hash differs: ${pin.identity}`);
  }
  const archivePath = join(workRoot, `${pin.identity.replaceAll(/[^A-Za-z0-9.-]/gu, "_")}.nupkg`);
  await writeFile(archivePath, archiveBytes, { flag: "wx" });
  const nuspecBytes = await unzipEntry(archivePath, pin.nuspecEntry);
  if (sha256(nuspecBytes) !== pin.nuspecSha256) {
    throw new Error(`NuGet manifest hash differs: ${pin.identity}`);
  }
  const nuspec = decodeText(nuspecBytes, `${pin.identity} NuGet manifest`, true);
  const declaredLicense = /<license\s+type=["']expression["']>([^<]+)<\/license>/iu.exec(nuspec)?.[1]?.trim();
  const hasExactMitDocument = pin.documents.some((document) =>
    document.entry?.toLowerCase().startsWith("license") === true
    && new Set([
      "89101e35a8c66fd4d6dffc1763259161d35cb564c169714ec227a768c89f2938",
      "d7a68596ab69b06f51ca278a6545148e4269a9381c26d597c13df5d88e08cf5b",
    ]).has(document.sha256));
  const license = declaredLicense ?? (hasExactMitDocument ? "MIT" : undefined);
  if (license !== "MIT") {
    throw new Error(`NuGet license expression differs: ${pin.identity}`);
  }
  for (const documentPin of pin.documents) {
    const source = documentPin.url ?? `nuget:${pin.nugetUrl}#${documentPin.entry!}`;
    const bytes = documentPin.url === undefined
      ? await unzipEntry(archivePath, documentPin.entry!)
      : await download(documentPin.url);
    if (sha256(bytes) !== (documentPin.sourceSha256 ?? documentPin.sha256)) {
      throw new Error(`License document hash differs: ${pin.identity} ${documentPin.name}`);
    }
    const text = decodeText(
      bytes,
      `${pin.identity} ${documentPin.name}`,
      documentPin.sourceSha256 !== undefined,
    );
    addDocument(documents, {
      name: documentPin.name,
      sha256: documentPin.sha256,
      source,
      text,
    });
  }
  return {
    archiveSha256: pin.archiveSha256,
    depsSha512: pin.depsSha512,
    documentSha256s: [...new Set(pin.documents.map((entry) => entry.sha256))].sort(compareText),
    identity: pin.identity,
    license,
    nugetUrl: pin.nugetUrl,
    nuspecSha256: pin.nuspecSha256,
    ...(pin.provenanceNote === undefined ? {} : { provenanceNote: pin.provenanceNote }),
    runtimeAssets,
  };
}

async function materializeDotnetRuntime(
  documents: Map<string, GcmDependencyLicenseDocument>,
  runtimeAssets: GcmDependencyLicensePackage["runtimeAssets"],
): Promise<GcmDependencyLicensePackage> {
  const pin = gcmDependencyLicensePins.dotnetRuntime;
  for (const documentPin of pin.documents) {
    const bytes = await download(documentPin.url);
    if (sha256(bytes) !== documentPin.sha256) {
      throw new Error(`.NET runtime license document hash differs: ${documentPin.name}`);
    }
    addDocument(documents, {
      name: documentPin.name,
      sha256: documentPin.sha256,
      source: documentPin.url,
      text: decodeText(bytes, documentPin.name),
    });
  }
  return {
    documentSha256s: pin.documents.map((entry) => entry.sha256).sort(compareText),
    identity: pin.identity,
    license: "MIT",
    repository: pin.repository,
    runtimeAssets,
    sourceCommit: pin.sourceCommit,
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--write")) {
    throw new Error("Pass --write to refresh the checked GCM dependency license inventory.");
  }
  const gcmRoot = join(
    import.meta.dir,
    "../node_modules/dugite/git/libexec/git-core",
  );
  const evidence = await collectGcmDependencyEvidence(gcmRoot);
  const workRoot = await mkdtemp(join(tmpdir(), "hra-gcm-licenses-"));
  try {
    const documents = new Map<string, GcmDependencyLicenseDocument>();
    const packages: GcmDependencyLicensePackage[] = [];
    for (const pin of gcmDependencyLicensePins.packages) {
      process.stderr.write(`[gcm-licenses] ${pin.identity}\n`);
      packages.push(await materializeNugetPackage(
        pin,
        workRoot,
        documents,
        evidence.assets.get(pin.identity) ?? [],
      ));
    }
    packages.push(await materializeDotnetRuntime(
      documents,
      evidence.assets.get(gcmDependencyLicensePins.dotnetRuntime.identity) ?? [],
    ));
    packages.sort((left, right) => compareText(left.identity, right.identity));
    const inventory: GcmDependencyLicenseInventory = {
      documents: [...documents.values()].sort((left, right) => compareText(left.sha256, right.sha256)),
      gcm: {
        depsJsonSha256: evidence.depsJsonSha256,
        externalPackageCount: packages.length,
        runtimeConfigSha256: evidence.runtimeConfigSha256,
        runtimeTarget: gcmDependencyLicensePins.gcm.runtimeTarget,
        sourceCommit: gcmDependencyLicensePins.gcm.sourceCommit,
        version: gcmDependencyLicensePins.gcm.version,
      },
      packageCount: packages.length,
      packages,
      schemaVersion: 1,
    };
    verifyGcmDependencyLicenseInventory(inventory, evidence);
    await Promise.all([
      writeFile(
        join(import.meta.dir, "GCM-DEPENDENCY-LICENSES.json"),
        serializeGcmDependencyLicenseInventory(inventory),
      ),
      writeFile(
        join(import.meta.dir, "GCM-DEPENDENCY-LICENSES.txt"),
        renderGcmDependencyLicenseNotices(inventory),
      ),
    ]);
    process.stdout.write(
      `Wrote ${packages.length} GCM external/runtime packages and ${documents.size} deduplicated license documents.\n`,
    );
  } finally {
    await rm(workRoot, { force: true, recursive: true });
  }
}

if (import.meta.main) await main();
