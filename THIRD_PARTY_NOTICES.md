# Third-party notices

HRA includes and builds on third-party software and assets. Their license terms
apply to those components. This summary is informational and does not replace
the license and notice files distributed with each component.

## OpenAI Codex CLI

The desktop application bundles OpenAI Codex CLI 0.144.6 under the Apache
License 2.0. The complete license is retained at
[`apps/desktop/runtime/CODEX-LICENSE.txt`](apps/desktop/runtime/CODEX-LICENSE.txt),
and the upstream notice, including Ratatui attribution, is retained at
[`apps/desktop/runtime/CODEX-NOTICE.txt`](apps/desktop/runtime/CODEX-NOTICE.txt).
The checked
[`CODEX-NATIVE-LICENSES.json`](apps/desktop/runtime/CODEX-NATIVE-LICENSES.json)
and
[`CODEX-NATIVE-LICENSES.txt`](apps/desktop/runtime/CODEX-NATIVE-LICENSES.txt)
bind all five shipped npm payloads to the exact target Cargo graph, native
source inputs, and retained license documents.

The generated Codex protocol contracts under
`apps/desktop/contracts/generated/codex/0.144.6` come from that same pinned
Codex package and retain the same license and notice linkage.

HRA is independent from OpenAI. The OpenAI and Codex names identify the
third-party product with which HRA interoperates; they do not imply affiliation,
endorsement, or sponsorship.

## Codex App SDK

`packages/internal/codex-app-sdk` contains the unchanged runtime and test source
from public `@hraness/codex-app-sdk` v0.1.1 at commit
`e7d5167ca5389ac834714a8a0a2c1602071963e2`. The snapshot record and original
MIT terms are retained in
[`PROVENANCE.md`](packages/internal/codex-app-sdk/PROVENANCE.md) and
[`LICENSE`](packages/internal/codex-app-sdk/LICENSE). Packaged distributions
that include the SDK include that license text.

## Hraness shared packages

HRA consumes three separately released Hraness packages under the MIT License:

- `@hraness/direct` v0.7.0 at commit
  `849f3413bc56df8f50c2446076ff90280916a908` supplies the development-only
  deterministic runtime and its browser-verification and bundle-boundary
  tooling.
- `@hraness/web-discovery` v0.1.0 at commit
  `1fc2cd22a62fcffffa826eededfd63c04d6522dd` supplies the web metadata,
  crawler, sitemap, JSON-LD, and social-image primitives.
- `@hraness/vercel-delivery` v0.1.2 at commit
  `7a1a0da0cd9d52b8daca328537793c1b1bbd8176` supplies the source-bound Vercel
  delivery proof and Preview response policy.

Each immutable dependency includes its own `LICENSE` file. The checked tags
and resolved commits are recorded in `package.json` and `bun.lock`.

## PostHog browser SDK

The public `hra.sh` site bundles `posthog-js` 1.412.1 under its declared Apache
License 2.0 and MIT terms. Copyright 2020 Posthog / Hiberly, Inc., and copyright
2015 Mixpanel, Inc. The upstream package retains its complete `LICENSE`; the
exact version is recorded in `package.json` and `bun.lock`.

## Desktop runtime components

The compiled desktop gateway embeds Bun 1.3.14. Its upstream license inventory,
relinking notice, and source provenance are retained at
[`apps/desktop/runtime/BUN-LICENSE.md`](apps/desktop/runtime/BUN-LICENSE.md) and
[`apps/desktop/runtime/BUN-PROVENANCE.md`](apps/desktop/runtime/BUN-PROVENANCE.md).
The checked
[`BUN-DEPENDENCY-LICENSES.json`](apps/desktop/runtime/BUN-DEPENDENCY-LICENSES.json)
and
[`BUN-DEPENDENCY-LICENSES.txt`](apps/desktop/runtime/BUN-DEPENDENCY-LICENSES.txt)
preserve exact terms for its native source inputs and locked Cargo closure.
Release artifacts include the deterministic complete Bun source bundle and
the separate patched WebKit archive.

The packaged desktop runtime uses Dugite 3.2.2 and its checksum-pinned Git
distribution. Git is licensed under GPL-2.0-only. The complete Git license and
corresponding-source record are retained at
[`apps/desktop/runtime/GIT-COPYING.txt`](apps/desktop/runtime/GIT-COPYING.txt)
and
[`apps/desktop/runtime/GIT-CORRESPONDING-SOURCE.txt`](apps/desktop/runtime/GIT-CORRESPONDING-SOURCE.txt).
Release artifacts include the pinned Git and Dugite Native source archives.

The packaged runtime also retains the exact licenses, notices, and provenance
for Dugite, Git LFS 3.7.1, Git Credential Manager 2.7.3 and its 22 external or
runtime-pack contributors, ripgrep 15.1.0, and the PCRE2 implementation linked
into ripgrep. The authoritative packaging summary is
[`apps/desktop/runtime/THIRD_PARTY_NOTICES.md`](apps/desktop/runtime/THIRD_PARTY_NOTICES.md).

The app also carries a generated, hash-verified inventory of the complete
installed production JavaScript dependency closure used to compile its
frontend and gateway. Packaging fails when an external package lacks reviewed
license text or when package metadata or a retained document drifts.

## Geist and Geist Mono

Geist and Geist Mono are distributed under the SIL Open Font License 1.1.
Their exact licenses and provenance are retained beside the vendored fonts:

- [`packages/internal/design-kit/src/fonts/geist/OFL.txt`](packages/internal/design-kit/src/fonts/geist/OFL.txt)
  and
  [`packages/internal/design-kit/src/fonts/geist/PROVENANCE.md`](packages/internal/design-kit/src/fonts/geist/PROVENANCE.md)
- [`packages/internal/design-kit/src/fonts/geist-mono/OFL.txt`](packages/internal/design-kit/src/fonts/geist-mono/OFL.txt)
  and
  [`packages/internal/design-kit/src/fonts/geist-mono/PROVENANCE.md`](packages/internal/design-kit/src/fonts/geist-mono/PROVENANCE.md)

## Noto Emoji phoenix source

The HRA phoenix icons derive from the Noto Emoji `🐦‍🔥` SVG distributed by
Google under the Apache License 2.0. The unchanged source, upstream provenance,
and license are retained in [`assets/brand/phoenix`](assets/brand/phoenix).

## Vendored interface code

The design package contains adapted or vendored interface code with retained
MIT license text:

- [EvilCharts license](packages/internal/design-kit/vendor/evilcharts/LICENSE)
  and [upstream record](packages/internal/design-kit/vendor/evilcharts/UPSTREAM.md)
- [Jelly UI license](packages/internal/design-kit/vendor/jelly-ui/LICENSE) and
  [upstream record](packages/internal/design-kit/vendor/jelly-ui/UPSTREAM.md)

## Patched dependencies

The repository applies checked patches to two Apache-2.0 packages. The patch
files are prominent records of the modifications:

- [`@native-sdk/cli` 0.5.3](https://github.com/vercel-labs/native) is modified
  by [`patches/@native-sdk%2Fcli@0.5.3.patch`](patches/@native-sdk%2Fcli@0.5.3.patch).
  The changes add an explicit WebKit-inspector capability and bounded,
  symlink-safe asset handling for macOS builds.
- [`react-aria` 3.50.0](https://github.com/adobe/react-spectrum) is modified by
  [`patches/react-aria@3.50.0.patch`](patches/react-aria@3.50.0.patch). The
  change permits the standard `aria-busy` attribute through the package's DOM
  property filter.

## Package dependencies

JavaScript and TypeScript dependencies are declared in workspace manifests and
resolved in `bun.lock`. Those packages remain subject to their respective
licenses. A source or binary distribution must retain every license, notice,
and corresponding-source obligation that applies to the components it ships.
