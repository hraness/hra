# Third-party notices

HRA depends on the official OpenAI Codex package, which is licensed under Apache License 2.0, and on Hraness Oh, which is licensed under the MIT License. HRA pins the immutable public npm release `@hraness/oh@0.2.7`; `bun.lock` binds its exact registry artifact integrity. HRA also interoperates with the separately installed Claude Code 2.1.260 runtime. HRA does not redistribute Claude Code, copy or redistribute either provider's credentials, or vendor Oh.

The static hra.sh analytics asset incorporates `@hraness/posthog` version 0.1.2 and its `posthog-js` version 1.412.1 dependency. Both are licensed under the MIT License. HRA pins the immutable `@hraness/posthog` GitHub release tag, and `bun.lock` binds the exact dependency graph used to build the self-hosted browser asset.

The static hra.sh styles and footer use the MIT-licensed `@hraness/design-kit` v0.4.0 and `@hraness/site-footer` v0.4.6 packages; `bun.lock` binds both exact release tags.

The immutable `v0.6.0` release source tag records the verified build graph in `bun.lock`, while the install tarball declares its direct runtime dependency versions in `package.json`. The GitHub Release publishes that exact tarball plus `SHA256SUMS`; npm publishes the same tarball through trusted publishing. The tarball does not vendor transitive dependencies. Dependency packages retain their own license texts and source metadata.
