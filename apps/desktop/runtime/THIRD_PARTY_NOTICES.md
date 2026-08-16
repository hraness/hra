# Desktop runtime notices

HRA source builds use pinned third-party runtimes and assets:

- OpenAI Codex CLI `0.144.6` is distributed under Apache-2.0. The adjacent `CODEX-LICENSE.txt` and `CODEX-NOTICE.txt` preserve its license and notice.
- Dugite `3.2.2` is distributed under MIT.
- Dugite Native Git `2.53.0`, release `v2.53.0-3`, is the checksum-pinned Git distribution. Git is GPL-2.0; `GIT-COPYING.txt` and `GIT-CORRESPONDING-SOURCE.txt` preserve the license and corresponding-source record.
- Git Credential Manager is included in the pinned Git distribution with its upstream notices.
- Native SDK supplies the macOS host framework used by the Zig application.
- Geist `1.800` and Geist Mono are distributed under the SIL Open Font License 1.1. Their source assets have adjacent OFL texts, and desktop builds preserve those licenses with the bundled frontend.

`runtime/runtime-versions.json` records the Codex package integrity, Dugite Native asset checksum, supported macOS floor, and other runtime pins used by source builds.
