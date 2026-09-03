# HRA v0.2.1 local CLI beta

HRA is a persistent Codex CLI for isolated accounts and live local session control. Optional hosted encrypted sync is live as an invite-only beta since 2026-09-03.

## Install

Install the immutable beta tag with Bun 1.3.14:

```sh
test "$(curl -fsSL --connect-timeout 10 --max-time 60 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.2.1/src/install-preflight-runtime.ts | bun -e 'const[a,h]=process.argv.slice(1);const b=await Bun.stdin.bytes();const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.2.1/hraness-hra-0.2.1.tgz 5bed09f57b0709963c515e134e7792fcac8736f624de9a02326b182e2bfd3412)" = hra-install-safe
hra --version
hra doctor --offline
hra init --yes
```

The single command verifies the SHA-256 of the exact tagged installer runtime before executing it. The installer then requires GitHub repository ID `1343008607`, a published immutable `v0.2.1` release, and one uploaded archive whose size and SHA-256 match GitHub's immutable metadata. It privately downloads the archive and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted HRA package path and SHA-256 while measuring the archive-bound completion receipt. Local and official archives use separate full-digest version namespaces. HRA also verifies the complete staged tree, package identity, zero-lifecycle manifest, reviewed normalizer, CLI SHA-256, protected descriptors, links, ownership, permissions, and ACLs before atomically publishing only the `$BUN_INSTALL/bin/hra` symlink. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the archive does not claim to contain that dependency closure. The prior verified command remains active throughout staging, and interruption recovery removes or completes only a proven private stage. Existing `trustedDependencies` remain unchanged.

This release admits the local CLI only. Do not treat its cloud-auth commands as evidence that hosted sync, enrollment, invitation issuance, or remote control is available.

## Included

- Daemon transport admission partitioned into 16 command and 16 long-poll slots, with a closed `UNAVAILABLE` failure instead of an indeterminate close when a pool is full, and slot occupancy reported by `hra daemon status --json`.
- Read-only opens such as `hra status` no longer scan foreign keys, and the queue secure-delete checkpoint retries before it can stop the daemon.
- `account login-cancel` is recorded in the mutation ledger before dispatch and reconciled from the account read after a restart; determinate provider rejections during daemon fence loss are recorded as failed.
- Constant-time one-time-code comparison, an allowlisted environment for the daemon and the session-note editor, byte-bounded Convex responses, a per-key AES-GCM message budget that fails closed with `KEY_ROTATION_REQUIRED`, and redaction of more unlabelled secret shapes.
- `hra --json work protocol` works before `hra init` and without a daemon; `hra help [group [command]]` and leaf-level `--help`; `--json` for `help` and `version`; an unhealthy `doctor` result returns `ok: false` with `error.code: "UNHEALTHY"`.
- Provider-neutral positioning, a README that leads with a thesis and badges, a build-time PNG social card, a changelog, a public roadmap, issue templates, and a supported-versions table.
- Everything from `v0.2.0`: isolated Codex account profiles with historical usage, persistent local sessions with bounded event streaming and typed approval and question handoff, agent-safe JSON and JSONL output, reversible macOS ChatGPT account switching, and one checksummed npm tarball published as the same bytes on npm and the immutable GitHub Release with `SHA256SUMS`.

## Fixed in v0.2.1

- Hosted commands no longer fail with `INTERNAL` after fifteen idle minutes. The daemon presented its expired access token to Convex on the refresh-token sign-in that replaces it, so the refresh itself was rejected; the transport now proceeds unauthenticated once the token's `exp` claim has passed.
- The hosted identity marker at `/.well-known/hra.json` keeps its fixed release-evidence version.

## Known limits

- Hosted sync, identity enrollment, device pairing, and remote commands are live as an invite-only beta; new identities need an invitation from an existing member.
- Resolve approvals, questions, and forms on the device executing the session. Remote interaction resolution is not enabled.
- Plugin and connector discovery is read-only. HRA does not install, enable, authorize, or open OAuth flows.
- Desktop account switching is macOS-only in this release.

Read the [v0.2.1 README](https://github.com/hraness/hra/tree/v0.2.1#readme), [privacy notice](https://github.com/hraness/hra/blob/v0.2.1/PRIVACY.md), and [security policy](https://github.com/hraness/hra/blob/v0.2.1/SECURITY.md) before installation or use. Report defects through [GitHub issues](https://github.com/hraness/hra/issues) and security concerns through the private process in the security policy.
