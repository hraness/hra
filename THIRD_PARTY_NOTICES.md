# Third-party notices

HRA depends on the official OpenAI Codex package, which is licensed under Apache License 2.0, and on Hraness Oh, which is licensed under the MIT License. HRA pins the immutable public npm release `@hraness/oh@0.2.7`; `bun.lock` binds its exact registry artifact integrity. HRA does not copy or redistribute Codex credentials and does not vendor Oh.

The static hra.sh analytics asset incorporates `@hraness/posthog` version 0.1.2 and its `posthog-js` version 1.412.1 dependency. Both are licensed under the MIT License. HRA pins the immutable `@hraness/posthog` GitHub release tag, and `bun.lock` binds the exact dependency graph used to build the self-hosted browser asset.

The immutable `v0.3.0` release source tag records the verified build graph in `bun.lock`, while the install tarball declares its direct runtime dependency versions in `package.json`. The GitHub Release publishes that exact tarball plus `SHA256SUMS`; npm publishes the same tarball through trusted publishing. The tarball does not vendor transitive dependencies. Dependency packages retain their own license texts and source metadata.
