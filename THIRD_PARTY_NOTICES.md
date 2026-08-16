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

The generated Codex protocol contracts under
`apps/desktop/contracts/generated/codex/0.144.6` come from that same pinned
Codex package and retain the same license and notice linkage.

HRA is independent from OpenAI. The OpenAI and Codex names identify the
third-party product with which HRA interoperates; they do not imply affiliation,
endorsement, or sponsorship.

## Codex App SDK

HRA consumes `@hraness/codex-app-sdk` from commit
`e7d5167ca5389ac834714a8a0a2c1602071963e2` of the
[`hraness/codex-app-sdk`](https://github.com/hraness/codex-app-sdk) repository.
The SDK is distributed under the MIT License, retained in the
[upstream source](https://github.com/hraness/codex-app-sdk/blob/e7d5167ca5389ac834714a8a0a2c1602071963e2/LICENSE).
Packaged distributions that include the SDK must include that license text.

## Git and desktop runtime components

The packaged desktop runtime uses Dugite 3.2.2 and its checksum-pinned Git
distribution. Git is licensed under GPL-2.0-only. The complete Git license and
corresponding-source record are retained at
[`apps/desktop/runtime/GIT-COPYING.txt`](apps/desktop/runtime/GIT-COPYING.txt)
and
[`apps/desktop/runtime/GIT-CORRESPONDING-SOURCE.txt`](apps/desktop/runtime/GIT-CORRESPONDING-SOURCE.txt).

The packaged runtime also includes Dugite, Git Credential Manager, and Sparkle
license material. The authoritative packaging summary is
[`apps/desktop/runtime/THIRD_PARTY_NOTICES.md`](apps/desktop/runtime/THIRD_PARTY_NOTICES.md).

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
