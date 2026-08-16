# Bun runtime provenance

The compiled HRA gateway embeds Bun 1.3.14 at commit
`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`. That Bun source pins its patched
WebKit and JavaScriptCore tree to commit
`5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b`.

Every HRA native release must publish the exact Bun and Bun WebKit source
archives named in the release manifest beside the DMG. The Bun archive is a
deterministic complete-source bundle. It contains the pinned Bun tree, its
Darwin native build dependencies, every declared nested Git source, the exact
Node header archive, and the 43-package Cargo closure used by `lol-html`.
WebKit remains a separate archive because it is close to GitHub's 2 GiB
per-asset limit.

The matching HRA source tag supplies the gateway TypeScript, package graph,
and `bun build --compile` command used to create the embedded application.
`BUN-LICENSE.md` is copied verbatim from the pinned Bun commit.
`BUN-DEPENDENCY-LICENSES.json` and `.txt` preserve the exact license documents
for all 22 native source components and the 43 locked Cargo packages. Their
checked source-archive and document hashes are enforced by packaging and by
mounted-DMG verification.
