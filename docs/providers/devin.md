# Devin provider

Status: current source drives the official local Devin CLI through Agent Client
Protocol (ACP) v1. HRA admits exactly Devin CLI `3000.6.14`. The `devin`
executable must already be on the daemon's `PATH`; HRA resolves its real path,
reads its exact self-reported version, and refuses a different version before a
provider session starts.

HRA starts each admitted session with this exact provider command:

```text
devin acp --model gpt-6-astra
```

`astra` is Devin's only HRA preset and the default when `--provider devin` is
used without `--preset`. The effective profile records model
`gpt-6-astra`, reasoning effort `provider-default`, Devin CLI `3000.6.14`, and
ACP protocol version 1. Devin exposes no separate HRA Fast tier, so `--fast`
is refused instead of ignored.

Codex uses separate provider profiles and presets. Its `high` and `ultra`
presets also select `gpt-6-astra`, with `max` and `ultra` reasoning
respectively. A matching model name does not share authentication, native
sessions, usage, or provider authority between Codex and Devin.

## Account isolation and sign-in

Install the exact supported Devin CLI by following the [official Devin CLI
guide](https://docs.devin.ai/cli), then verify the version before asking HRA to
use it:

```text
devin --version
hra account login <profile> --provider devin
```

The login command requires a foreground terminal. HRA launches `devin auth
login` and gives that exact child the terminal. To request Devin's own manual
token flow, use:

```text
hra account login <profile> --provider devin --manual-token-flow
```

That option launches `devin auth login --force-manual-token-flow`. HRA does not
accept `--device-code`, `--handoff-file`, JSON mode, or web account linking for
Devin.

The web account registry shows Devin only after a bounded background status
observation. Unknown or expired observations omit the Devin row; they never
borrow Codex's sign-in state. A slow Devin status command does not block
unrelated Codex commands or settings changes.

Each HRA profile gives Devin five distinct private directories:

- `HOME`
- `XDG_CONFIG_HOME`
- `XDG_DATA_HOME`
- `XDG_CACHE_HOME`
- `XDG_STATE_HOME`

The child receives an allowlisted environment with those five values replaced.
Devin owns every provider-private file in that boundary, including
`$XDG_DATA_HOME/devin/credentials.toml`. HRA never opens, parses, copies, or
uploads that credential. It runs the bounded `devin auth status` command inside
the same isolated boundary and reduces the result to `signedIn` only.

If the foreground HRA parent or daemon fails after granting a login launch,
`hra account show <profile> --provider devin` reports the exact unsettled
attempt. Confirm that the original child has exited before running the complete
acknowledged `hra account login-cancel` command returned by status. That command
releases only HRA's local launch fence. It does not stop Devin or read, change,
or delete a credential. HRA does not implement Devin sign-out; perform that
operation with Devin inside the same isolated five-directory boundary.

## Sessions and protocol limits

HRA uses `initialize`, `session/new`, `session/prompt`, session updates,
permission requests, and `session/cancel`. It uses `session/load` after a
restart only when Devin advertises that ACP capability. The provider owns the
native session, tool execution, permissions, model behavior, and hidden state.
HRA stores only its bounded provider-neutral transcript, lifecycle, interaction,
and usage facts. ACP `agent_thought_chunk` content is raw reasoning rather than
a provider-certified summary, so HRA drops it at the provider boundary.

ACP's remembered allow and reject choices are provider-persistent, not scoped
to one HRA session. HRA therefore exposes only one-time allow, one-time deny,
and cancel decisions; it never presents a remembered choice as session scope.

ACP v1 has no in-turn steering method. `hra session steer` therefore refuses an
active Devin turn. Use `hra session queue` to send the message after the current
prompt completes, or stop the turn before sending another message. HRA never
sends two concurrent prompts to one Devin session. The initial Devin adapter is
text-only, so it also refuses attachments.

## Usage and limits

An ACP `usage_update` reports current context occupancy as `used` and context
capacity as `size`. HRA records those supplied values as session usage. If
Devin also supplies a cumulative session cost with an amount and ISO currency,
HRA records that provider cost as supplied. Neither value is interpreted as an
account allowance, remaining balance, billing settlement, or reset window.

ACP v1 and `devin auth status` expose no documented machine-readable account
allowance, remaining balance, reset time, or reset-credit operation. HRA
therefore reports Devin account allowance as `unknown` with source `devin_acp`.
It does not submit the human-facing `/usage` or `/session-stats` commands as
hidden model turns. Explicit provider quota or credit refusals remain bounded
provider errors. HRA never invokes a Codex reset credit for Devin and never
rotates to another account or provider to evade a limit.

## Upstream references

- [Devin CLI overview](https://docs.devin.ai/cli)
- [Devin CLI command reference](https://docs.devin.ai/cli/reference/commands)
- [Devin CLI models](https://docs.devin.ai/cli/models)
- [Devin authentication](https://docs.devin.ai/cli/enterprise/devin-auth)
- [Devin ACP integration](https://docs.devin.ai/cli/acp)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/introduction)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)

The installed CLI has passed a zero-token compatibility check in a disposable
isolated profile: exact version `3000.6.14`, signed-out status, Astra launch,
and ACP v1 initialization with session loading advertised. The protocol reducer
and runtime manager also have deterministic fixture coverage. A bounded paid
turn is still required before HRA claims live-provider proof for turn, tool,
permission, cancellation, and usage-update behavior.
