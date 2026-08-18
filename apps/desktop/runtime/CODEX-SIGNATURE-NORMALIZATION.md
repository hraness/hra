# Codex signature normalization

HRA packages the exact official `@openai/codex@0.144.6-darwin-arm64`
payload identified by npm integrity
`sha512-6zgvh70MzBNSeT17HEhSOrmmGGZGAKzSC7x6JAq+edkJkdPYA9P0I1tG7aJ49GlBkBxuC+MKBH1qm6+2Cghcww==`.
Its `codex` and `codex-code-mode-host` Developer ID signatures validate on
some supported macOS builders but fail strict validation on macOS 26.5.2.
The same failure is reproducible from fresh official npm downloads, follows
the bytes across copies, and is not caused by quarantine or path metadata.

The package build verifies the official source package and both source files
before changing the staged copy. It requires these exact source identities:

| Payload | Source SHA-256 | Size | Identifier | Team | CDHash |
| --- | --- | ---: | --- | --- | --- |
| `bin/codex` | `80a3933d11a9d13ef806aa24f7bb8afc9169cfe4e9b09d6da6a92922cbde9cff` | 260472144 | `codex` | `2DC432GLL2` | `14fe9fce7d47a8c12e42094e5cc90ff97b2cf627` |
| `bin/codex-code-mode-host` | `de329ec247b5ebbdf796b5888a7c2a9d731e221321584c5abdcc686c70b2db81` | 46374288 | `codex-code-mode-host` | `2DC432GLL2` | `d4a7d8e1af4b06413ef43fa933d983c3db019e8f` |

Only those two exact staged files are re-signed with an ad-hoc hardened
runtime signature and their original identifiers. The result is deterministic
across paths and repeated copies. The build and verifier require these exact
packaged identities:

| Payload | Packaged SHA-256 | Size | Identifier | Team | CDHash |
| --- | --- | ---: | --- | --- | --- |
| `bin/codex` | `587cdb466744d6ed95cd189185b21764edc240c858c6d1de9c3d9f640072ec5b` | 258959424 | `codex` | unset | `5ae280ff1821f445b9a57fd1cae94a5638b64412` |
| `bin/codex-code-mode-host` | `b0d18d2e3c9c2040e4f05ea08cbc6df35bb0c991f097200489d936759d453f69` | 46106576 | `codex-code-mode-host` | unset | `c6baa6a305971da8115c47e52005e922ea767540` |

Both normalized files must pass strict code-signature verification before the
outer app is signed. The runtime manifest records the source and packaged
identity for each file. A deterministic, bounded source delta is also packaged
for each normalized file. Verification reconstructs the exact official source
bytes in an owner-private temporary directory and runs the unchanged native
payload verifier against the reconstructed vendor tree. The deltas are pinned
to SHA-256 `31e85f5acf1ac89da21e8299c1a4da473e64da45c9a80dd9aa56363ce34754d3`
and `5db3af7a60caedfac88b65ed96054e5faea1759d1d90072621c3fe2a7c6686e9`.

All other reviewed third-party signatures remain unchanged. Any upstream
version, package integrity, source hash, size, identifier, team, CDHash, or
source delta change requires a new reviewed policy and evidence.

Every macOS package build runs destructive-in-fixture regressions against the
exact staged app. They alter each normalized payload and source delta, alter a
normalized manifest path, and re-sign one payload without hardened-runtime
flags. Each mutation must make the full app verifier fail. The runner restores
the exact original bytes, reruns the full verifier, and finishes with deep,
strict verification of the restored outer app.
