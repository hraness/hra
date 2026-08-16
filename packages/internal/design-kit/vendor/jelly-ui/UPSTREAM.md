# Jelly UI vendor record

This directory contains the browser bundle for [Jelly UI](https://jelly-ui.com),
vendored because the audited 1.0 source is not published under a usable npm
package name. HRA never loads the mutable hosted bundle in production.

- Upstream repository: `https://github.com/jelly-org/ui`
- Upstream commit: `d898ec995f3cbe16e720c4857c13c0dceb489585`
- Retrieved: 2026-07-20
- License: MIT; preserved verbatim in `LICENSE`
- Public bundle source: `https://jelly-ui.com/dist/jelly.js`
- Public declarations source: `https://jelly-ui.com/dist/jelly.d.ts`
- Public source map: `https://jelly-ui.com/dist/jelly.js.map`

Pinned SHA-256 digests:

- `jelly.js`: `c38e4e2222fcb9ecb820d5f31fd452774d07f599104c9db7ef71edcd1d38cdf9`
- `jelly.d.ts`: `63e4455d79da343039606d644c4bda6d059855f9211cd496c3b5c91d8e9cce8f`
- `jelly.js.map`: `880e5d883a58cefb6987a6e25b3580d7a1908cc3d49a440571b04e6d8163c97f`
- `LICENSE`: `4a18cf475d350f854b5058493f8d7760cca29ce09f233eeb26ae52c740fcaace`

The hosted declaration file had CRLF line endings and SHA-256
`890b16d637b19ab2584296f2e6e4955640c6579366f12711be0d81bf80cb90f9`.
Only those line endings were normalized to the repository-wide LF policy; the
vendored-file digest above is the one enforced by tests.

To upgrade, audit an exact upstream commit, build or retrieve all three matching
artifacts, preserve the license, update these hashes and the package test, then
run server-rendering, real-browser interaction, reduced-motion, dark-mode, and
visual verification before migrating to the new commit.
