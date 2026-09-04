# HRA v0.5.0 local CLI beta

HRA is a persistent Codex CLI for isolated accounts and live local session control. Optional hosted encrypted sync has been live since 2026-09-03 and is now an open beta.

## Install

Install the immutable beta tag with Bun 1.3.14:

```sh
test "$(curl -fsSL --connect-timeout 10 --max-time 60 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.5.0/src/install-preflight-runtime.ts | bun -e 'const[a,h]=process.argv.slice(1);const b=await Bun.stdin.bytes();const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.5.0/hraness-hra-0.5.0.tgz d4c6f33971eaf106dcde0d54b0f7e6c96591c9f591bb7e04cbdc9c2f2310a641)" = hra-install-safe
hra --version
hra doctor --offline
hra init --yes
```

The single command verifies the SHA-256 of the exact tagged installer runtime before executing it. The installer then requires GitHub repository ID `1343008607`, a published immutable `v0.5.0` release, and one uploaded archive whose size and SHA-256 match GitHub's immutable metadata. It privately downloads the archive and gives Bun only a verified in-memory snapshot of those exact bytes. The reviewed normalizer verifies the private archive again, derives its bounded package-file manifest, and compares every extracted HRA package path and SHA-256 while measuring the archive-bound completion receipt. Local and official archives use separate full-digest version namespaces. HRA also verifies the complete staged tree, package identity, zero-lifecycle manifest, reviewed normalizer, CLI SHA-256, protected descriptors, links, ownership, permissions, and ACLs before atomically publishing only the `$BUN_INSTALL/bin/hra` symlink. Bun 1.3.14 resolves the package's exact dependency versions from the configured package registry trust boundary with lifecycle scripts disabled; the archive does not claim to contain that dependency closure. The prior verified command remains active throughout staging, and interruption recovery removes or completes only a proven private stage. Existing `trustedDependencies` remain unchanged.

The local CLI is public. Hosted sync is an open beta: sign-up no longer needs an invitation, and this release grants no enrollment authority of its own.

## Included

- A pending interaction now carries enough detail to decide it elsewhere. The compact `interaction_state` event gains a versioned optional block with a label, a headline, redacted markdown detail, the command class, the decisions the provider actually offered, and for a question its id, label, and secret flag. Every field is bounded and re-checked when it is read, and the emitter drops the whole block rather than project anything unsafe.
- Remote decisions reach further. Beyond command approvals and file-change declines, the daemon accepts a decision on a permission approval whose requested categories it re-verifies as workspace-only, and answers to a question set that carries no secret, including a plain-text MCP form. Each remaining refusal keeps its own code, and the browser panel offers a control only where the daemon would accept it.
- Subagent activity is visible. Codex reports a spawned subagent as an activity item on the parent thread, which HRA projects as `subagent_activity` session events folded by agent id and carrying only a bounded nickname, role, depth, and last status. A subagent's own message never enters the parent transcript.
- The pinned Codex runtime moves from 0.149.0 to 0.153.2 through the repository's own bump tool, with every generated schema digest and both reviewed matrix digests re-pinned and six added notifications reviewed and discarded.
- A session records its provider. `SessionRuntimePort` is a provider-neutral seam with `CodexRuntimePort` and a new `ClaudeRuntimePort` beside it, `src/claude/` speaks the pinned Claude Code stream-json dialect behind an exact version admission and a matrix that fails closed on drift, and the model preset union gains `fable-max`. Codex behaviour is unchanged, and a preset the session's provider cannot run is refused rather than ignored.
- Device commands reach a daemon without a session lease: `session_start`, `account_login_start`, `account_login_status`, and `usage_refresh`, fenced by the target daemon's boot authority. A per-device kill switch, a per-day cap, registry-public-id addressing, project-inherited approval mode, a first-use notice, and an account-linking switch that stays off until it is allowed locally bound them. `hra remote allow|deny device-commands|account-linking` and `hra remote policy` are local commands, so nothing hosted can grant them.
- Everything from `v0.4.1`: isolated Codex account profiles with historical usage, persistent local sessions with bounded event streaming and typed interaction handoff, session state and autorespond, live hosted session projection, browser devices with key fingerprints, conversation-bound scheduled tasks, the one-time local state schema migration on `hra daemon start`, agent-safe JSON and JSONL output, reversible macOS ChatGPT account switching, and one checksummed npm tarball published as the same bytes on npm and the immutable GitHub Release with `SHA256SUMS`.

## Known limits

- Hosted sync, identity enrollment, device pairing, and remote commands are an open beta. Sign-up no longer needs an invitation, and the hosted service can change while the beta runs.
- The daemon accepts and validates `hra session start --provider claude`, and then refuses to start the session: its durable session-start evidence carries only Codex runtime profiles. This release runs no Claude session.
- Remote decisions cover command approvals, file-change declines, permission approvals whose requested categories are all workspace-only, and question sets that carry no secret. Everything else, including any secret answer, any typed or credential-shaped MCP field, and any session-scope grant, is decided on the device executing the session.
- The browser client is in the repository and is not yet hosted. This release exposes it through no public address.
- Plugin and connector discovery is read-only. HRA does not install, enable, authorize, or open OAuth flows.
- Desktop account switching is macOS-only in this release.
- Upgrading over an older install leaves the local state schema pending until the first `hra daemon start`. Until that runs, `hra status` and `hra doctor --offline` report the pending migration and name both schema versions rather than migrating.

Read the [v0.5.0 README](https://github.com/hraness/hra/tree/v0.5.0#readme), [privacy notice](https://github.com/hraness/hra/blob/v0.5.0/PRIVACY.md), and [security policy](https://github.com/hraness/hra/blob/v0.5.0/SECURITY.md) before installation or use. Report defects through [GitHub issues](https://github.com/hraness/hra/issues) and security concerns through the private process in the security policy.
