# HRA
[![npm version](https://img.shields.io/npm/v/%40hraness%2Fhra)](https://www.npmjs.com/package/@hraness/hra) [![provenance: sigstore](https://img.shields.io/badge/provenance-sigstore-2e7d32)](https://www.npmjs.com/package/@hraness/hra#provenance) [![CI](https://img.shields.io/github/actions/workflow/status/hraness/hra/ci.yml?branch=main&label=CI)](https://github.com/hraness/hra/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/npm/l/%40hraness%2Fhra)](https://github.com/hraness/hra/blob/main/LICENSE) [![Bun 1.3.14](https://img.shields.io/badge/Bun-1.3.14-14151a)](https://bun.sh) [![runtime: Codex 0.153.2](https://img.shields.io/badge/runtime-Codex%200.153.2-0b5fa5)](https://www.npmjs.com/package/@openai/codex/v/0.153.2) [![runtime: Claude Code 2.1.260](https://img.shields.io/badge/runtime-Claude%20Code%202.1.260-6f42c1)](https://github.com/hraness/hra/blob/main/docs/providers/claude.md)\
HRA brings your Codex and Claude Code sessions into one workspace. Follow the work in your browser, direct it from your terminal, and keep execution on your own machines.

Status: public beta. Local CLI v0.8.0 is a release candidate, not an admitted artifact; v0.7.1 remains the fully admitted public artifact. Codex runs on macOS and Linux, Claude Code on Linux; hosted sync is live as an open beta. Current daemon and hosted command-writer rollout remains blocked on capacity.

[Open HRA](https://app.hra.sh) · [Documentation](https://hra.sh/docs/) · [Availability](https://hra.sh/docs/status/)

See what’s running, follow the conversation, and decide what happens next. HRA brings your Codex and Claude Code sessions together in a web workspace, with a CLI for you and your agents.

- **See the whole workspace.** A grid of sessions shows what is running and what needs your attention. Open a card to read the conversation.
- **Pick up the next turn.** Send a follow-up from the browser or terminal. The session runs on its machine, even after you close the tab.
- **Keep accounts separate.** Choose the provider profile for the work. Each managed profile has its own configuration; HRA does not rotate accounts for you.

## Get started

Public beta. Codex execution supports macOS and Linux; Claude Code execution supports Linux. The local CLI does not need an HRA cloud identity. The web workspace uses optional encrypted sync and requires a paired machine and browser.

> This release candidate is not yet admitted. The v0.8.0 install command is unavailable until its immutable GitHub artifact passes exact release admission. The npm mirror is admitted separately. The last admitted release is v0.7.1; use its immutable installation notes for the existing artifact. [Admitted release installation notes](https://github.com/hraness/hra/blob/v0.7.1/docs/beta-release-notes.md#install).

The v0.8.0 candidate is not yet admitted. For the admitted v0.7.1 artifact, use its [immutable README](https://github.com/hraness/hra/blob/v0.7.1/README.md#get-started).

Only after immutable GitHub release admission, install and verify the v0.8.0 candidate CLI artifact. This does not start the daemon:

```sh
test "$(unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH && curl -fsSL --connect-timeout 10 --max-time 60 --max-filesize 524288 --retry 3 --retry-delay 1 --retry-max-time 60 --proto '=https' --tlsv1.2 https://raw.githubusercontent.com/hraness/hra/v0.8.0/src/install-preflight-runtime.ts | command bun --no-env-file --config=/dev/null -e 'const n=["BUN_OPTIONS","NODE_OPTIONS","LD_AUDIT","LD_LIBRARY_PATH","LD_ORIGIN_PATH","LD_PRELOAD","DYLD_FALLBACK_FRAMEWORK_PATH","DYLD_FALLBACK_LIBRARY_PATH","DYLD_FRAMEWORK_PATH","DYLD_IMAGE_SUFFIX","DYLD_INSERT_LIBRARIES","DYLD_LIBRARY_PATH","DYLD_ROOT_PATH","DYLD_VERSIONED_FRAMEWORK_PATH","DYLD_VERSIONED_LIBRARY_PATH"],x=process.execArgv;const c=x.filter(v=>v==="-c"||v.startsWith("--config"));if(n.some(k=>process.env[k]!==undefined)||x.filter(v=>v==="--no-env-file").length!==1||c.length!==1||c[0]!=="--config=/dev/null"||x.some(v=>v.startsWith("-r")||v==="--preload"||v.startsWith("--preload=")||v==="--require"||v.startsWith("--require=")||v==="--import"||v.startsWith("--import=")||v==="--env-file"||v.startsWith("--env-file=")))throw new Error("The tagged HRA preflight requires a neutral Bun stage zero.");const[a,h]=process.argv.slice(1);const r=Bun.stdin.stream().getReader(),q=[];let z=0;try{for(;;){const o=await r.read();if(o.done)break;z+=o.value.byteLength;if(z>524288)throw new Error("The tagged HRA preflight exceeds its byte limit.");q.push(o.value)}}finally{r.releaseLock()}const b=new Uint8Array(z);let p=0;for(const v of q){b.set(v,p);p+=v.byteLength}const d=new Bun.CryptoHasher("sha256").update(b).digest("hex");if(d!==h)throw new Error("The tagged HRA preflight digest is invalid.");const j=new Bun.Transpiler({loader:"ts",target:"bun"}).transformSync(b);const u=URL.createObjectURL(new Blob([j],{type:"text/javascript"}));try{const m=await import(u);await m.installHraRelease(a);process.stdout.write(`${m.HRA_INSTALL_SUCCESS}\n`);}finally{URL.revokeObjectURL(u)}' -- https://github.com/hraness/hra/releases/download/v0.8.0/hraness-hra-0.8.0.tgz 77ec0042b78e5014d11fe044867c41e3818553e85be78d61bbc9671e0b980f7a)" = hra-install-safe
```

```sh
hra doctor --offline
```

> **Before initialization:** Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart either the admitted v0.7.1 daemon or the v0.8.0 candidate until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.

Continue with the [setup guide](https://hra.sh/docs/start/). For an existing installation, use the [ordered update runbook](https://hra.sh/docs/status/#install-and-update).

## Use the interface that fits the work

- [Web workspace](https://hra.sh/docs/web/): see the session grid, read a conversation, and send a follow-up from a paired browser.
- [Sessions and accounts](https://hra.sh/docs/sessions/): inspect account usage, continue a conversation, switch providers, or recover a stopped session.
- [CLI reference](https://hra.sh/docs/reference/): command families, structured JSON, cursor-based event streams, memory, and automation.

### The same work, from your terminal.

These examples require a machine whose setup and rollout prerequisites are satisfied.

1. **Start:** `hra session start personal --provider codex --json`. Create a Codex session under the account profile you choose.
2. **Inspect:** `hra session status <session-id> --json`. Read the session and the cursor where its event stream continues.
3. **Switch:** `hra session switch <session-id> --provider claude --preset fable-max`. Continue on your signed-in Claude Code profile. HRA carries over the conversation it has retained and flags any missing history.
4. **Direct:** `hra session send <session-id> -- "Review this project."`. Send the next request to that session and provider.

## Local execution, optional encrypted sync

**Your accounts, your provider tools.** Codex and Claude Code own their sign-in and execution. HRA keeps managed profiles separate and does not broker model access.

**Local by default.** The local daemon runs the sessions. The CLI works without an HRA cloud identity; optional sync connects the web workspace and your other devices.

**Encrypted before it leaves the machine.** Synced session content is encrypted for paired devices. The service still sees account and delivery metadata, described in the privacy policy.

Read the [privacy policy](https://github.com/hraness/hra/blob/main/PRIVACY.md) for the local, synced, and website data boundaries.

## Project

HRA is maintained by [Hraness](https://hraness.com/) and published under the MIT license.

[Contributing](https://github.com/hraness/hra/blob/main/CONTRIBUTING.md) · [Security policy](https://github.com/hraness/hra/blob/main/SECURITY.md) · [Release notes](https://github.com/hraness/hra/blob/main/docs/beta-release-notes.md)
