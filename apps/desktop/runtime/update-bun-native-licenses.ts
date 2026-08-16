import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  type BunNativeLicenseComponent,
  type BunNativeLicenseDocument,
  type BunNativeLicenseInventory,
  renderBunNativeLicenseNotices,
  serializeBunNativeLicenseInventory,
  verifyBunNativeLicenseInventory,
} from "./bun-native-licenses";
import {
  type CorrespondingSourceExternal,
  correspondingSourceSpecs,
  verifyCorrespondingSourceArchive,
} from "./corresponding-sources";
import runtimeVersions from "./runtime-versions.json";

const licenseBasenamePattern = /^(?:licen[cs]e|copying|notice|copyright|unlicense)(?:[._-].*)?$/iu;
const selectorsIdentity = "selectors-0.33.0";
const selectorsCommit = "f319793c6989dba83994fbd10d560b21ad4a0c85";
const remoteDocuments = Object.freeze([
  {
    component: "Node.js headers@sha256:045e9bf477cd5db0ec67f8c1a63ba7f784dedfe2c581e3d0ed09b88e9115dd07",
    name: "Node.js 24.3.0 LICENSE",
    sha256: "4da25aaf0146d7f16c275f93306ce7e88d5e6fbe7d29eb1ba00067868021dee6",
    url: "https://raw.githubusercontent.com/nodejs/node/v24.3.0/LICENSE",
  },
  {
    component: "Bun WebKit@5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    name: "JavaScriptCore COPYING.LIB",
    sha256: "5094ecb9c9dcd0eadc34f3c11511d9b5535063032bc150164ecd1a5d5a445547",
    url: "https://raw.githubusercontent.com/oven-sh/WebKit/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/JavaScriptCore/COPYING.LIB",
  },
  {
    component: "Bun WebKit@5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    name: "WebCore LICENSE-LGPL-2",
    sha256: "7555fa34bc131a75ca56d65c40cc1ea8f9515d23e353d4c15d58573a042f7805",
    url: "https://raw.githubusercontent.com/oven-sh/WebKit/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/WebCore/LICENSE-LGPL-2",
  },
  {
    component: "Bun WebKit@5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b",
    name: "WebCore LICENSE-LGPL-2.1",
    sha256: "f2b3bd09663381deb99721109d22b47af1213bb43007a8b56a06c6375c8050ce",
    url: "https://raw.githubusercontent.com/oven-sh/WebKit/5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/Source/WebCore/LICENSE-LGPL-2.1",
  },
  {
    component: "lol-html@77127cd2b8545998756e8d64e36ee2313c4bb312",
    name: "selectors 0.33.0 MPL-2.0",
    sha256: "66a3107d5ad6a058aab753eaac2047ccb2ed0e39465dd0fe5844da3e300d5172",
    url: "https://raw.githubusercontent.com/spdx/license-list-data/v3.27.0/text/MPL-2.0.txt",
  },
] as const);

type MutableDocument = {
  name: string;
  sha256: string;
  sources: Set<string>;
  text: string;
};

async function run(argv: readonly string[]): Promise<string> {
  const child = Bun.spawn([...argv], { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed with exit code ${exitCode}: ${stderr.trim()}`);
  }
  return stdout;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularBytes(path: string, maximumBytes = 2_000_000): Promise<Uint8Array> {
  const status = await lstat(path);
  if (
    !status.isFile()
    || status.isSymbolicLink()
    || status.nlink !== 1
    || status.size <= 0
    || status.size > maximumBytes
  ) {
    throw new Error(`Bun license source is not a bounded regular file: ${path}`);
  }
  const bytes = await readFile(path);
  if (bytes.byteLength !== status.size) {
    throw new Error(`Bun license source changed while it was read: ${path}`);
  }
  return bytes;
}

function decodeText(bytes: Uint8Array, label: string): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.length === 0 || text.charCodeAt(0) === 0xfeff) {
    throw new Error(`Bun license source is empty or has a UTF-8 BOM: ${label}`);
  }
  return text;
}

function addDocument(
  documents: Map<string, MutableDocument>,
  text: string,
  name: string,
  source: string,
): string {
  const digest = sha256(text);
  const existing = documents.get(digest);
  if (existing === undefined) {
    documents.set(digest, { name, sha256: digest, sources: new Set([source]), text });
  } else {
    existing.sources.add(source);
  }
  return digest;
}

async function fetchPinnedDocument(document: typeof remoteDocuments[number]): Promise<string> {
  const response = await fetch(document.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Bun remote license fetch failed with HTTP ${response.status}: ${document.url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== document.sha256) {
    throw new Error(`Bun remote license hash differs: ${document.name}`);
  }
  return decodeText(bytes, document.url);
}

function externalIdentity(source: CorrespondingSourceExternal): string {
  return source.kind === "archive"
    ? `${source.project}@sha256:${source.sha256}`
    : `${source.project}@${source.commit}`;
}

async function createInventory(archivePath: string): Promise<BunNativeLicenseInventory> {
  const bunSpec = correspondingSourceSpecs.find((spec) => spec.project === "Bun");
  const webkitSpec = correspondingSourceSpecs.find((spec) => spec.project === "Bun WebKit");
  if (bunSpec === undefined || webkitSpec === undefined) {
    throw new Error("Bun corresponding-source pins are incomplete.");
  }
  const evidence = await verifyCorrespondingSourceArchive(archivePath, bunSpec);
  const entries = (await run(["/usr/bin/tar", "-tzf", archivePath]))
    .split("\n").filter((entry) => entry.length > 0);
  const licenseEntries = entries.filter((entry) => licenseBasenamePattern.test(basename(entry)));
  const picoSource = bunSpec.externalSources.find((source) => source.project === "picohttpparser");
  if (picoSource?.kind !== "git") throw new Error("picohttpparser source pin is missing.");
  const picoLicenseHeader = `${bunSpec.archivePrefix}${picoSource.archivePath}/picohttpparser.h`;
  licenseEntries.push(picoLicenseHeader);
  const lolHtml = bunSpec.externalSources.find((source) => source.project === "lol-html");
  if (lolHtml?.kind !== "git" || lolHtml.cargoVendor === undefined) {
    throw new Error("lol-html Cargo source pin is missing.");
  }
  const lolPrefix = `${bunSpec.archivePrefix}${lolHtml.archivePath}/`;
  const vendorPrefix = `${lolPrefix}${lolHtml.cargoVendor.path}/`;
  const cargoIdentities = [...new Set(entries.flatMap((entry) => {
    if (!entry.startsWith(vendorPrefix)) return [];
    const identity = entry.slice(vendorPrefix.length).split("/")[0];
    return identity === undefined || identity.length === 0 ? [] : [identity];
  }))].sort(compareText);
  if (cargoIdentities.length !== lolHtml.cargoVendor.packageCount) {
    throw new Error(`lol-html Cargo source closure differs: ${cargoIdentities.length}.`);
  }
  const cargoChecksumEntries = cargoIdentities.map((identity) =>
    `${vendorPrefix}${identity}/.cargo-checksum.json`);
  const selectorsMetadataEntries = [
    `${vendorPrefix}${selectorsIdentity}/.cargo_vcs_info.json`,
    `${vendorPrefix}${selectorsIdentity}/Cargo.toml`,
  ];
  const extractEntries = [...new Set([
    ...licenseEntries,
    ...cargoChecksumEntries,
    ...selectorsMetadataEntries,
  ])].sort(compareText);
  const extractionRoot = await mkdtemp(join(tmpdir(), "hra-bun-license-source-"));
  try {
    await run(["/usr/bin/tar", "-xzf", archivePath, "-C", extractionRoot, ...extractEntries]);
    const documents = new Map<string, MutableDocument>();
    const archiveDocumentHashes = new Map<string, string>();
    const retainedLicenseEntries: string[] = [];
    for (const entry of licenseEntries.sort(compareText)) {
      const status = await lstat(join(extractionRoot, entry));
      if (!status.isFile() || status.isSymbolicLink() || status.size === 0) continue;
      const bytes = await readRegularBytes(join(extractionRoot, entry));
      const text = decodeText(bytes, entry);
      retainedLicenseEntries.push(entry);
      archiveDocumentHashes.set(
        entry,
        addDocument(
          documents,
          text,
          basename(entry),
          `archive:${bunSpec.archiveName}#${entry.slice(bunSpec.archivePrefix.length)}`,
        ),
      );
    }

    const componentHashes = new Map<string, Set<string>>();
    const bunIdentity = `Bun@${bunSpec.commit}`;
    componentHashes.set(bunIdentity, new Set());
    for (const entry of retainedLicenseEntries) {
      if (entry.startsWith(`${bunSpec.archivePrefix}HRA-EXTERNAL-SOURCES/`)) continue;
      componentHashes.get(bunIdentity)!.add(archiveDocumentHashes.get(entry)!);
    }
    for (const source of bunSpec.externalSources) {
      const identity = externalIdentity(source);
      const hashes = new Set<string>();
      if (source.kind !== "linked-archive") {
        const prefix = `${bunSpec.archivePrefix}${source.archivePath}/`;
        for (const entry of retainedLicenseEntries) {
          if (entry.startsWith(prefix)) hashes.add(archiveDocumentHashes.get(entry)!);
        }
      }
      componentHashes.set(identity, hashes);
    }

    const remoteHashes = new Map<string, string>();
    for (const document of remoteDocuments) {
      const text = await fetchPinnedDocument(document);
      const digest = addDocument(documents, text, document.name, document.url);
      remoteHashes.set(document.name, digest);
      componentHashes.get(document.component)?.add(digest);
    }

    const selectorsVcs = JSON.parse(decodeText(
      await readRegularBytes(join(extractionRoot, selectorsMetadataEntries[0]!)),
      selectorsMetadataEntries[0]!,
    )) as { git?: { sha1?: unknown }; path_in_vcs?: unknown };
    const selectorsManifest = decodeText(
      await readRegularBytes(join(extractionRoot, selectorsMetadataEntries[1]!)),
      selectorsMetadataEntries[1]!,
    );
    if (
      selectorsVcs.git?.sha1 !== selectorsCommit
      || selectorsVcs.path_in_vcs !== "selectors"
      || !selectorsManifest.includes('license = "MPL-2.0"')
    ) {
      throw new Error("selectors 0.33.0 MPL-2.0 provenance differs from its reviewed override.");
    }
    const selectorsOverride = remoteHashes.get("selectors 0.33.0 MPL-2.0");
    if (selectorsOverride === undefined) {
      throw new Error("selectors 0.33.0 MPL-2.0 text is missing.");
    }

    const cargoPackages = [];
    for (const identity of cargoIdentities) {
      const packagePrefix = `${vendorPrefix}${identity}/`;
      const documentSha256s = retainedLicenseEntries
        .filter((entry) => entry.startsWith(packagePrefix))
        .map((entry) => archiveDocumentHashes.get(entry)!)
        .sort(compareText);
      if (identity === selectorsIdentity) documentSha256s.push(selectorsOverride);
      if (documentSha256s.length === 0) {
        throw new Error(`lol-html Cargo package has no exact license text: ${identity}`);
      }
      cargoPackages.push({
        checksumSha256: sha256(
          await readRegularBytes(join(extractionRoot, `${packagePrefix}.cargo-checksum.json`)),
        ),
        documentSha256s: [...new Set(documentSha256s)].sort(compareText),
        identity,
      });
    }

    const sourceByIdentity = new Map<string, string>([[bunIdentity, `${bunSpec.repository}@${bunSpec.commit}`]]);
    for (const source of bunSpec.externalSources) {
      sourceByIdentity.set(
        externalIdentity(source),
        source.kind === "archive"
          ? `${source.url}#sha256=${source.sha256}`
          : `${source.repository}@${source.commit}`,
      );
    }
    const components: BunNativeLicenseComponent[] = [...componentHashes]
      .map(([identity, hashes]) => ({
        documentSha256s: [...hashes].sort(compareText),
        identity,
        source: sourceByIdentity.get(identity) ?? "",
      }))
      .sort((left, right) => compareText(left.identity, right.identity));
    const canonicalDocuments: BunNativeLicenseDocument[] = [...documents.values()]
      .map((document) => ({
        name: document.name,
        sha256: document.sha256,
        sources: [...document.sources].sort(compareText),
        text: document.text,
      }))
      .sort((left, right) => compareText(left.sha256, right.sha256));
    return verifyBunNativeLicenseInventory({
      bun: {
        completeSourceArchive: bunSpec.archiveName,
        completeSourceArchiveSha256: evidence.sha256,
        sourceCommit: bunSpec.commit,
        version: runtimeVersions.bun.version,
        webkitSourceCommit: webkitSpec.commit,
      },
      cargoPackageCount: cargoPackages.length,
      cargoPackages,
      componentCount: components.length,
      components,
      documents: canonicalDocuments,
      schemaVersion: 1,
    });
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

const write = process.argv.includes("--write");
const archiveArgument = process.argv.find((argument) => argument.endsWith(".tar.gz"));
if (!write || archiveArgument === undefined) {
  throw new Error(
    "Usage: bun run runtime/update-bun-native-licenses.ts --write <complete-bun-source.tar.gz>",
  );
}
const archivePath = archiveArgument.startsWith("/")
  ? archiveArgument
  : join(process.cwd(), archiveArgument);
const inventory = await createInventory(archivePath);
await mkdir(import.meta.dir, { recursive: true });
await Promise.all([
  writeFile(
    join(import.meta.dir, "BUN-DEPENDENCY-LICENSES.json"),
    serializeBunNativeLicenseInventory(inventory),
  ),
  writeFile(
    join(import.meta.dir, "BUN-DEPENDENCY-LICENSES.txt"),
    renderBunNativeLicenseNotices(inventory),
  ),
]);
process.stdout.write(
  `Wrote ${inventory.componentCount} Bun native components, ${inventory.cargoPackageCount} Cargo packages, and ${inventory.documents.length} unique license documents.\n`,
);
