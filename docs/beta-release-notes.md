# HRA v0.4.0 local CLI beta

HRA is a persistent Codex CLI for isolated accounts and live local session control. Optional hosted encrypted sync is live as an invite-only beta since 2026-09-03.

## Install

Install the immutable beta tag with Bun 1.3.14:

```sh
test "$(curl -fsSL --connect-timeout 10 --max-time 60 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.4.0/src/install-preflight-runtime.ts | bun -e 'const[a,h]=process.argv.slice(1);const b=await Bun.stdin.bytes();const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.4.0/hraness-hra-0.4.0.tgz 3e008db0520395a0d19d307f7c84ea0ce34fbc97745ce38d089341a068dc0873)" = hra-install-safe
hra --version
hra doctor --offline
hra init --yes
```

The single command verifies the SHA-256 of the exact tagged installer runtime before executing it. The installer then requires GitHub repository ID `1343008607`, a published immutable `v0.4.0` release, and one uploaded archive whose size and SHA-256 match GitHub's immutable metadata. It privately downloads the archive and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted HRA package path and SHA-256 while measuring the archive-bound completion receipt. Local and official archives use separate full-digest version namespaces. HRA also verifies the complete staged tree, package identity, zero-lifecycle manifest, reviewed normalizer, CLI SHA-256, protected descriptors, links, ownership, permissions, and ACLs before atomically publishing only the `$BUN_INSTALL/bin/hra` symlink. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the archive does not claim to contain that dependency closure. The prior verified command remains active throughout staging, and interruption recovery removes or completes only a proven private stage. Existing `trustedDependencies` remain unchanged.

The local CLI is public. Hosted sync remains an invite-only beta: this release does not grant enrollment or invitation authority.

## Included

- `hra session state` reports who must act next and how the last turn ended. A lexical classifier evaluates human-action cues before approval cues, so a login prompt or a code from email never reads as consent.
- `hra autorespond on|workspace|off|default|status` accepts freshly admitted command, file-change, and permission approvals at once scope through the ordinary resolve path, per session or daemon-wide. Every attempt leaves an evidence row, and a consecutive counter that only a human message resets, plus hourly and daily budgets, escalate rather than continue.
- A turn that ends asking for approval in prose, with no protocol interaction to resolve, can be answered through a gateway key held in the daemon's generational secret custody. `hra autorespond gateway set|clear` manages it and status reports only whether it is configured. A verbatim ask sends a byte-exact substring of the message or escalates; every other admitted case sends one fixed sentence.
- `hra remote resolve` and `hra remote send --or-steer` carry a decision from another enrolled device. The custodian verifies that the interaction exists, belongs to the session, is pending at the requested revision, is inside its deadline, and offers that decision; it refuses secret answers and session-scope grants, and honours decisions only from active requesting devices.
- Hosted sessions stream live. The daemon publishes the running turn to the encrypted `detail` stream in bounded redacted batches, wakes its sync cycle from a websocket subscription instead of the next poll, and adapts its cadence to one second while a peer device is present or a local turn is running and fifteen seconds idle. `hra sync status` reports it.
- Devices carry a class, `daemon` or `browser`, and a key fingerprint over both canonical public keys. Device listings show the fingerprint and `hra device approve --fingerprint` requires it. A browser device is refused as a first device, refused administration, and refused every daemon-owned write.
- Each device publishes an encrypted registry projection of its machine label, daemon version, defaults, accounts and projects by label, scheduled tasks, and whether prose autorespond is configured, so an enrolled device can read and change those defaults. `hra session archive` and `hra session unarchive` move a finished session out of the default listing, which `--archived` still shows.
- Everything from `v0.3.0`: isolated Codex account profiles with historical usage, persistent local sessions with bounded event streaming and typed interaction handoff, conversation-bound scheduled tasks, agent-safe JSON and JSONL output, reversible macOS ChatGPT account switching, hosted invite-only sync, and one checksummed npm tarball published as the same bytes on npm and the immutable GitHub Release with `SHA256SUMS`.

## Known limits

- Hosted sync, identity enrollment, device pairing, and remote commands are live as an invite-only beta; new identities need an invitation from an existing member.
- Remote decisions cover command approvals in full and file-change approvals as a decline only. Permission approvals, questions, and forms are resolved on the device executing the session.
- The browser client is in the repository and is not yet hosted. This release exposes it through no public address.
- Plugin and connector discovery is read-only. HRA does not install, enable, authorize, or open OAuth flows.
- Desktop account switching is macOS-only in this release.
- Upgrading over an older install migrates the local state schema on the first `hra daemon start`. Until that runs, `hra status` and `hra doctor --offline` report the pending migration and name both schema versions.

Read the [v0.4.0 README](https://github.com/hraness/hra/tree/v0.4.0#readme), [privacy notice](https://github.com/hraness/hra/blob/v0.4.0/PRIVACY.md), and [security policy](https://github.com/hraness/hra/blob/v0.4.0/SECURITY.md) before installation or use. Report defects through [GitHub issues](https://github.com/hraness/hra/issues) and security concerns through the private process in the security policy.
