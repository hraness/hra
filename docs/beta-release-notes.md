# HRA v0.3.0 local CLI beta

HRA is a persistent Codex CLI for isolated accounts and live local session control. Optional hosted encrypted sync is live as an invite-only beta since 2026-09-03.

## Install

Install the immutable beta tag with Bun 1.3.14:

```sh
test "$(curl -fsSL --connect-timeout 10 --max-time 60 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.3.0/src/install-preflight-runtime.ts | bun -e 'const[a,h]=process.argv.slice(1);const b=await Bun.stdin.bytes();const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.3.0/hraness-hra-0.3.0.tgz 880673a6cd3ebfbce6ac36172d4ee34f707fd2fb34783244714edca870055344)" = hra-install-safe
hra --version
hra doctor --offline
hra init --yes
```

The single command verifies the SHA-256 of the exact tagged installer runtime before executing it. The installer then requires GitHub repository ID `1343008607`, a published immutable `v0.3.0` release, and one uploaded archive whose size and SHA-256 match GitHub's immutable metadata. It privately downloads the archive and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted HRA package path and SHA-256 while measuring the archive-bound completion receipt. Local and official archives use separate full-digest version namespaces. HRA also verifies the complete staged tree, package identity, zero-lifecycle manifest, reviewed normalizer, CLI SHA-256, protected descriptors, links, ownership, permissions, and ACLs before atomically publishing only the `$BUN_INSTALL/bin/hra` symlink. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the archive does not claim to contain that dependency closure. The prior verified command remains active throughout staging, and interruption recovery removes or completes only a proven private stage. Existing `trustedDependencies` remain unchanged.

The local CLI is public. Hosted sync remains an invite-only beta: this release does not grant enrollment or invitation authority.

## Included

- Create, inspect, edit, pause, resume, and delete recurring whole-minute interval tasks for an existing conversation with `hra session task`. Intervals range from 15 minutes through 7 days, with at most 32 retained tasks per conversation.
- New HRA-created Codex conversations expose the narrow `hra.automation_update` tool. Provider thread identity and profile generation bind every mutation to that exact conversation; the tool cannot retarget a project, model, account, or execution environment.
- Due tasks enter the durable session queue transactionally. Missed intervals coalesce into one run, while revisions, replay receipts, restart recovery, collisions, and daemon-generation fencing prevent duplicate or misdirected execution.
- Scheduled prompts remain local and are omitted from cloud projections. Approval, question, form, permission, MCP, and plugin handling keeps the existing explicit human-in-the-loop boundaries.
- Hosted sign-in verification email uses the production HRA sender and pinned authentication subdomain.
- Everything from `v0.2.1`: isolated Codex account profiles with historical usage, persistent local sessions with bounded event streaming and typed interaction handoff, agent-safe JSON and JSONL output, reversible macOS ChatGPT account switching, hosted invite-only sync, and one checksummed npm tarball published as the same bytes on npm and the immutable GitHub Release with `SHA256SUMS`.

## Known limits

- Hosted sync, identity enrollment, device pairing, and remote commands are live as an invite-only beta; new identities need an invitation from an existing member.
- Resolve approvals, questions, and forms on the device executing the session. Remote interaction resolution is not enabled.
- Plugin and connector discovery is read-only. HRA does not install, enable, authorize, or open OAuth flows.
- Desktop account switching is macOS-only in this release.

Read the [v0.3.0 README](https://github.com/hraness/hra/tree/v0.3.0#readme), [privacy notice](https://github.com/hraness/hra/blob/v0.3.0/PRIVACY.md), and [security policy](https://github.com/hraness/hra/blob/v0.3.0/SECURITY.md) before installation or use. Report defects through [GitHub issues](https://github.com/hraness/hra/issues) and security concerns through the private process in the security policy.
