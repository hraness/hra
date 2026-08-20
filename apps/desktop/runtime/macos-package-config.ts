import { resolve } from "node:path";

import { hraReleaseIdentity } from "./release-identity";
import runtimeVersions from "./runtime-versions.json";

export const macosPackage = Object.freeze({
  appBundleName: "HRA",
  appBundlePath: resolve(
    import.meta.dir,
    `../zig-out/package/HRA-${hraReleaseIdentity.version}-${hraReleaseIdentity.build}-macos-arm64.app`,
  ),
  architecture: "arm64",
  artifactBaseName:
    `HRA-${hraReleaseIdentity.version}-${hraReleaseIdentity.build}-macos-arm64`,
  bundleIdentifier: "kitchen.hraness",
  build: hraReleaseIdentity.build,
  desktopRoot: resolve(import.meta.dir, ".."),
  displayName: "HRA",
  executableName: "hra",
  minimumMacOS: runtimeVersions.minimumMacOS,
  productName: "HRA",
  releaseDirectory: resolve(import.meta.dir, "../zig-out/release/macos/arm64"),
  version: hraReleaseIdentity.version,
} as const);

export const trustedThirdPartyTeams: ReadonlyMap<string, string> = Object.freeze(new Map([
  ["2DC432GLL2", "OpenAI"],
  ["VEKTX9H2N7", "GitHub"],
  ["UBF8T346G9", "Microsoft"],
] as const));

export const hranessUiStylesheetInput = Object.freeze({
  licenseSha256: "799b4743aab185faac6fd07349d8ab19f9c9714b47e261996ff0971dda3d4309",
  packageJsonSha256: "f5f5131405ee72b68b341485d6561f107ec14a3c34d82d902fff9e38c764b810",
  sourceCommit: "7d4af51b2e4bf36be7e24a1ceb266b1fa4ee5cd3",
  stylesheetSha256: "f1c131cd97b7d8fa34767b836f41a2b96fe02ae365a60cfc9a210e705df03c63",
  version: "0.3.1",
} as const);

export const imageNormalizerPackageContract = Object.freeze({
  canonicalFileName: "canonical.png",
  identifier: "hra-image-normalizer",
  previewFileName: "preview.png",
  runtimeRelativePath: "bin/hra-image-normalizer",
  sourceRelativePath: "zig-out/bin/hra-image-normalizer",
  temporaryDirectoryPattern:
    /^\.hra-image-normalizer-[0-9a-f]{32}\.tmp$/u,
} as const);

export const requiredLicenseFileNames = Object.freeze([
  "BUN-DEPENDENCY-LICENSES.json",
  "BUN-DEPENDENCY-LICENSES.txt",
  "BUN-LICENSE.md",
  "BUN-PROVENANCE.md",
  "CODEX-APP-SDK-LICENSE.txt",
  "CODEX-LICENSE.txt",
  "CODEX-NATIVE-LICENSES.json",
  "CODEX-NATIVE-LICENSES.txt",
  "CODEX-NOTICE.txt",
  "CODEX-SIGNATURE-NORMALIZATION.md",
  "CODEX-package.json",
  "CODEX-platform-package.json",
  "DESKTOP-THIRD-PARTY-NOTICES.md",
  "DUGITE-LICENSE.txt",
  "EVILCHARTS-LICENSE.txt",
  "EVILCHARTS-UPSTREAM.md",
  "GCM-DEPENDENCY-LICENSES.json",
  "GCM-DEPENDENCY-LICENSES.txt",
  "GEIST-MONO-OFL.txt",
  "GEIST-MONO-PROVENANCE.md",
  "GEIST-OFL.txt",
  "GEIST-PROVENANCE.md",
  "GIT-COPYING.txt",
  "GIT-CORRESPONDING-SOURCE.txt",
  "GIT-CREDENTIAL-MANAGER-LICENSE.txt",
  "GIT-CREDENTIAL-MANAGER-NOTICE.txt",
  "GIT-CREDENTIAL-MANAGER-PROVENANCE.md",
  "GIT-LFS-LICENSE.md",
  "GIT-LFS-PROVENANCE.md",
  "HRA-LICENSE.txt",
  "HRANESS-UI-LICENSE.txt",
  "HRANESS-UI-PROVENANCE.md",
  "JAVASCRIPT-LICENSE-OVERRIDES.md",
  "JELLY-UI-LICENSE.txt",
  "JELLY-UI-UPSTREAM.md",
  "NATIVE-SDK-LICENSE.txt",
  "NOTO-PHOENIX-LICENSE.txt",
  "NOTO-PHOENIX-PROVENANCE.md",
  "PCRE2-LICENCE.md",
  "RIPGREP-COPYING.txt",
  "RIPGREP-LICENSE-MIT.txt",
  "RIPGREP-PROVENANCE.md",
  "RIPGREP-UNLICENSE.txt",
  "ROOT-THIRD-PARTY-NOTICES.md",
  "RUNTIME-VERSIONS.json",
  "SHIPPED-JAVASCRIPT-LICENSES.json",
  "SHIPPED-JAVASCRIPT-LICENSES.txt",
  "SPDX-MIT-LICENSE.txt",
  "embedded-git.json",
] as const);

export const requiredRuntimeBinFileNames = Object.freeze([
  imageNormalizerPackageContract.identifier,
  "oprte-data-remover",
  "oprte-gateway",
  "oprte-git-executor",
  "oprte-keychain-custodian",
] as const);
