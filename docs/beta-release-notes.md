# HRA v0.1.0 friend beta

HRA is a persistent Codex CLI for isolated accounts, live session control, and optional end-to-end encrypted device sync.

## Install

Install the immutable beta tag with Bun 1.3.14:

```sh
bun add --global https://github.com/hraness/hra/releases/download/v0.1.0/hra-v0.1.0.tgz
hra --version
hra doctor --offline
hra init --yes
```

Cloud enrollment is invitation-only during the friend beta. Keep the invite and email verification code out of shell arguments and history; `hra auth login --input-stdin` or `--input-fd` accepts one protected JSON document.

## Included

- Multiple isolated Codex account profiles and historical usage observations.
- Persistent local sessions with bounded event streaming, typed approval and question handoff, and agent-safe JSON or JSONL output.
- Encrypted session projections, device presence, pairing, revocation, and remote commands through the hosted HRA control plane.
- Reversible account switching for the supported macOS ChatGPT application.
- A checksummed install tarball, artifact-identity SPDX record, and Ubuntu 24.04 x64 accepted-install runtime SPDX inventory.

## Known limits

- This is a friend beta. Hosted identity creation requires a one-time invitation.
- Resolve approvals, questions, and forms on the device executing the session. Remote interaction resolution is not enabled.
- Plugin and connector discovery is read-only. HRA does not install, enable, authorize, or open OAuth flows.
- Desktop account switching is macOS-only in this release.
- Device credentials are bearer credentials, not hardware-bound proofs. Revoke a missing or suspect device from another active device.

Read the [v0.1.0 README](https://github.com/hraness/hra/tree/v0.1.0#readme), [privacy notice](https://github.com/hraness/hra/blob/v0.1.0/PRIVACY.md), and [security policy](https://github.com/hraness/hra/blob/v0.1.0/SECURITY.md) before enrollment. Report defects through [GitHub issues](https://github.com/hraness/hra/issues) and security concerns through the private process in the security policy.
