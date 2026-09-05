# Session portability

HRA owns a provider-neutral record of every session. On Linux, a conversation
can move from Codex to Claude Code and back while it is running, and it can be
exported in the letta-ai trajectory v1 shape for memory and search tooling.
Codex switching remains available on macOS, but a switch into Claude is refused
there until authenticated testing proves isolated Keychain custody and
detached-daemon reads without a prompt.

Before this, HRA stored no conversation of its own. Assistant text existed only
as `assistant_delta` events, there was no record of what HRA had sent, and
`readSession` asked the provider for its transcript: `thread/items/list` for
Codex, and an in-memory, process-lifetime message list for Claude. A session
therefore could not outlive its provider, and could not be handed to another
one.

## The neutral transcript

Three durable session events carry the conversation, and every one of them
obeys the bounds and redaction rules that already governed the event stream
(`SESSION_EVENT_MAX_BYTES`, `containsAbsolutePath`, the secret patterns, and
the projection's `forbiddenDetailKeyPattern`).

- `user_message`, exactly what HRA sent to the provider, with the actor that
  authored it: `human`, `autorespond`, or `provider_switch` for a handoff seed.
  It is written after the provider accepted the message, so the transcript
  never claims HRA sent something the provider rejected. Text is capped at
  16,384 characters and the remainder is stated as an exact
  `omittedCharacters` count.
- `item_started` / `item_completed`, already carried the item kind, MCP server,
  tool name, and status. They now also carry `callId`, the stable opaque
  identity a result binds back to its call, and `summary`, a bounded one-line
  label. The summary is assembled only from values the protocol layer already
  reduced to safe labels: the item kind, the server and tool names, and the
  closed-vocabulary command class (`git commit`, `bun test`, `command`) that
  the command-approval display has always used. **A raw tool argument or a raw
  tool output is never stored**, so neither is ever in the transcript.
- `provider_switched`, the boundary record: the providers and presets moved
  between, whether the account changed, the digest of the neutral transcript,
  the digest of the seed the target provider was given, and how many records
  that seed omitted.

`src/domain/transcript.ts` reads those events back into an ordered, bounded,
paged conversation with a SHA-256 digest over its canonical serialization. It
is the one artifact the switch and the export both consume. Its record kinds
are `user`, `assistant`, `reasoning`, `tool_call`, `tool_result`, and
`provider_switch`. Assistant and reasoning deltas are coalesced per item; a
tool result is paired with its call by `callId`; an item whose kind is
conversation (`agentMessage`, `reasoning`, `subAgentActivity`, and so on) is
not treated as a tool call, and an unfamiliar kind is, so an unknown call is
recorded rather than dropped.

Nothing in the reader talks to a provider. A session whose provider thread is
gone, whose provider runtime is not installed, or that has already switched
still has a readable conversation.

## Switching provider

```
hra session switch <session> --provider codex|claude [--preset <preset>] [--account <account>]
```

In order, a switch:

1. refuses a switch it cannot make safely (below);
2. builds the neutral transcript and renders the bounded handoff seed from it;
3. reviews and starts a thread on the target provider and account. A target
   that refuses leaves the session on its still-runnable outgoing provider;
4. releases the outgoing provider's hold on the thread, `endSession` on the
   neutral runtime port, which stops the pinned Claude Code process that served
   the session and is a documented no-op for Codex, whose app-server owns
   thread lifetime. The outgoing thread is **never deleted**;
5. commits the whole rebinding in one transaction, provider, account, preset,
   provider thread, the target's reviewed runtime profile, and the session's
   conversation-automation row, which follows the new thread so a scheduled
   session task keeps addressing a live one;
6. appends the `provider_switched` event;
7. sends the seed as the first user message of the new thread, as an ordinary
   turn that records its own `user_message` with actor `provider_switch`.

A switch is refused, with no effect, when:

- a turn is active, the turn would be stranded on the outgoing provider with
  no way to attribute its result. Stop it with `hra session stop` first;
- the session is quarantined or terminal;
- the requested preset is not one the target provider can run (`low` on
  Claude, `fable-max` on Codex). With no `--preset`, the switch keeps the
  session's tier when the target has one and otherwise takes the target's
  highest;
- the target is Claude and the custodian daemon is not running on Linux;
- the session already runs that provider, preset, and account.

### What a switch preserves, and what it cannot

**Preserved:** the conversation as HRA saw it, what was asked, what the
assistant said, what its reasoning summaries said, which tools were called and
whether they succeeded, and the switch boundary itself. Also the session's
identity, its project, its note, its title, its queue, its session tasks, and
its event stream; the session id never changes.

**Not preserved, and not recoverable:**

- the provider's own hidden state, Codex's server-side thread and Claude's
  full reasoning traces, neither of which HRA ever stored;
- the provider's native thread. Codex `thread/resume` takes only a thread id,
  and the pinned Claude CLI's `--resume` takes only its own session id and
  cannot import a foreign transcript. Neither provider can be handed the
  other's thread, so the target starts a genuinely new one;
- cached context and prompt-cache warmth. The target pays full context cost for
  the seed;
- anything the redaction rules removed on the way in: secrets, absolute paths,
  raw tool arguments, raw tool output. These were never stored and cannot
  reappear;
- turn ids and item ids from the old provider. They remain in the transcript as
  opaque identifiers, but they mean nothing to the new provider.

### The seeding rule

The seed is one user message, and it is built only from records that already
passed HRA's redaction. It opens with the literal header
`[HRA provider handoff]`, states which provider the conversation ran on and
which it now runs on, states plainly that this is HRA's own record rather than
the previous provider's transcript, states the exact number of omitted records,
and instructs the model to ask rather than assume anything the summary does not
state.

It is capped at 24,576 characters. When the transcript does not fit, the
**most recent** records are the ones kept: a handoff needs the end of a
conversation more than its beginning. The omission count in the header is the
truth about what was dropped, and the same count plus the seed's digest are
recorded on the `provider_switched` event, so what the new provider was told is
provable after the fact.

## The remote surface

`set_provider {provider, preset?}` sits alongside `set_model` in the hosted
command union (`convex/validators.ts`, `src/cloud/contracts.ts`,
`src/cloud/payloads.ts`), and the journal, bridge lane, and local-control
parser all derive their closed unions from that one list.

Unlike the settings commands, a provider switch is a provider effect, not local
state, so `src/cloud/daemon-adapters.ts` routes it onto the ordinary execution
path as a `session.switch` command under the same execution lease as a turn.

The payload deliberately has no account field. Account selection is
user-directed and stays on the machine that holds the credentials; a remote
switch keeps the session's account.

`hra remote provider <cloud-session> <codex|claude> [--preset <preset>]` is the
CLI form. The custodian daemon applies the same Linux-only admission rule to a
remote switch into Claude; the browser cannot widen platform support.

## Exporting a trajectory

```
hra session export <session> [--format trajectory|json] [--out <path>]
```

`--format json` writes HRA's own neutral transcript. `--format trajectory`
(the default) writes the letta-ai trajectory v1 shape.

**Upstream is import-oriented.** `@letta-ai/trajectory` and its
`schema/trajectory-v1.schema.json` exist to normalize many agent harnesses'
native logs *into* that shape; the package does not convert back out of it.
HRA emits the shape rather than depending on the package, so an HRA session can
be fed to the memory and search tooling built around that format. The mapping
below is HRA's, and `src/domain/trajectory.ts` is its only implementation.

| Neutral record | Trajectory record | Notes |
| --- | --- | --- |
|, | `meta` | Always first: `version`, `source: "hra"`, `session_id`, `provider`, `created_at`, `transcript_digest`, `omitted_records`. |
| `user` | `user` | `content`, `timestamp`. An autorespond message is prefixed `[hra autorespond]`; a handoff seed keeps its own `[HRA provider handoff]` header and is not labelled twice. |
| `assistant` | `assistant` | `content`, `timestamp`. |
| `reasoning` | `reasoning` | The provider's reasoning *summary*, which is all HRA ever stored. |
| `tool_call` | `tool_call` | `id` is the neutral call id; `name` is `server/tool` or the item kind; `arguments` is a stringified JSON object. |
| `tool_result` | `tool` | `tool_call_id` links back to the call; `ok` is present only when the provider's status classifies; `content` says the output was never retained. |
| `provider_switch` | `observation` | States the providers, presets, whether the account changed, and the seed digest. |

`arguments` deserves a note. The format expects stringified JSON arguments, and
HRA holds none: it never stored them. Rather than invent input or drop the
field, HRA emits a stringified object that states exactly what it does hold, `{"hra_arguments_retained": false, "item_kind": …, "server": …, "tool": …,
"summary": …}`. A consumer can always tell an HRA trajectory's tool call from
one captured with real arguments.

Timestamps are ISO 8601 from the event's recorded time. Export reads the
transcript in bounded pages and never asks a provider, so a session whose
provider is gone still exports.
