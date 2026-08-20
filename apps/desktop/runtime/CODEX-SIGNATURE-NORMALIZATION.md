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

Only those two exact staged files are re-signed. The command fixes every input
that otherwise varies across supported builders: ad-hoc identity, the original
identifier, hardened-runtime flags and version `15.5.0`, SHA-256 digest, no
timestamp, 16 KiB signing pages, and DER entitlement generation. In particular,
the default signing page size differs between supported macOS builders.

The canonical
`codex-signature-normalization.entitlements.plist` has SHA-256
`a2f94dda68da5a6d994132cfc3ee49f07b83bccc5c1b9d5653e2e5fdb228ff41`
and contains exactly two true keys:

- `com.apple.security.cs.allow-jit`
- `com.apple.security.cs.allow-unsigned-executable-memory`

Those permissions reproduce the two permissions on the official payload and
are required by the V8 code-mode host. No Info.plist, sealed resources,
timestamp, or custom requirement is bound. The build and verifier require
these exact packaged identities:

| Payload | Packaged SHA-256 | Size | Identifier | Team | CDHash | Page size | Runtime |
| --- | --- | ---: | --- | --- | --- | ---: | --- |
| `bin/codex` | `055f18d2a33a719a2fab08e0a8326d950fa733340c596bb3df0d8dc94f85a96e` | 258960048 | `codex` | unset | `d5a8decaaecc44cd318c818f9ad794083570a812` | 16384 | `15.5.0` |
| `bin/codex-code-mode-host` | `7f622f21007acac2780b0e9e39822ba493425366fc1cf996c24adafc9c0a6e08` | 46107184 | `codex-code-mode-host` | unset | `62c42f5ea878b3d0cf931a993216a4034cd8e91f` | 16384 | `15.5.0` |

Both normalized files must pass strict code-signature verification before the
outer app is signed. The runtime manifest records the source and packaged
identity and signing contract for each file. Structural verification proves
that every byte outside the Mach-O signature envelope is unchanged. A
deterministic, bounded source delta is also packaged for each normalized file.
Verification reconstructs the exact official source bytes in an owner-private
temporary directory and runs the unchanged native payload verifier against the
reconstructed vendor tree. The deltas are pinned to SHA-256
`b0b05a7e03adf00fc1293b3e2679464cd8ec63024ca0ab5448915b5c33a1dadd`
and `5952f9bc32083e1f62e1cc13c55b5b50145f8f7e4df56dd89c2d8d5267d9c2c2`.

All other reviewed third-party signatures remain unchanged. Any upstream
version, package integrity, source hash, size, identifier, team, CDHash, or
source delta, entitlement, signing page, or runtime-version change requires a
new reviewed policy and evidence. macOS 15 and macOS 26 CI both reconstruct
the exact normalized identities, and the signed code-mode host must complete a
framed-protocol V8 JIT execution.

Every macOS package build runs destructive-in-fixture regressions against the
exact staged app. They alter each normalized payload and source delta, alter a
normalized manifest path, and re-sign one payload without hardened-runtime
flags. Each mutation must make the full app verifier fail. The runner restores
the exact original bytes, reruns the full verifier, and finishes with deep,
strict verification of the restored outer app.
