# Model routing: Phase 3 shadow contract

HRA does not automatically route work to a different model in Phase 3. Sol
Ultra is the only effective automatic default for new Codex sessions, with Fast off.
The task-shape classifier and the routing decision are shadow-only: they can
describe disabled studies, but they cannot mutate a session or authorize a
runtime profile.

Terra, Opus, and Fast are not enabled by this work. Sol is the active Codex
baseline, not a shadow candidate. New sessions that explicitly choose the Claude
family continue to use Fable Max. Explicit preset choices are preserved, and
established sessions never change provider, preset, exact model, effort, or Fast
state because of a shadow decision or a default change.

## Decision contract

`src/domain/model-routing.ts` accepts a closed, content-free record. It contains
only schema version 1, whether the session is new or established, how its route
was selected, the already-admitted effective provider/preset/Fast tuple, the
Phase 2 task shape and rule, and a declared safety class. It accepts no task
text, session identifier, account label, path, or model output.

The input must be coherent:

- An implicit default is only a new Codex Ultra route with Fast off.
- A family default must equal the provider's current default. Claude family
  selection is necessarily explicit.
- An explicit preset must already be compatible with its provider.
- An existing selection is only valid for an established session.
- Claude never accepts Fast.

Every result has `mode: "shadow"`, `schemaVersion: 1`, and
`runtimeMutationAllowed: false`. Its `effective` value is a semantic copy of
the admitted route. A candidate is always `disabled_unlicensed`, has a study
identifier that is not a preset, and never occupies the effective field.

Established sessions, explicit presets, mechanical work, open-ended work,
uncertain work, and work requiring the strong profile receive no candidate.
A new, well-defined Codex default may describe the disabled Terra Ultra and
Terra Fast studies against the active Sol baseline. A new, explicit,
well-defined Claude family default may
describe the disabled Opus effort study. Unknown safety does not license either
study; it adds an unresolved effect-class blocker.

The live web app labels mutable remote choices as `Codex High` and
`Codex Ultra`. A browser deployment and its target daemon can roll
independently, while encrypted device-registry version 1 projects only the
preset alias and not that daemon's exact active alias binding. Source-bound CLI
and documentation can name the current Sol mapping, but the browser must not
claim Sol or Astra for a remote command until a future additive registry
contract proves that target-specific binding. Every explicit remote preset
write for the rebound Codex `high` or `ultra` aliases carries the client's
immutable `presetContract`; so does a preset-omitted provider switch targeting
Codex, because the daemon may derive either mutable alias from the source tier.
The receiving daemon accepts the token only when it equals the named alias's
active binding, or the shared active High/Ultra binding for a derived Codex
switch; a missing or mismatched contract is refused before any provider effect.
Thus both an old browser targeting a new daemon and a new browser targeting an
old daemon fail closed instead of silently substituting Sol for Astra or Astra
for Sol. Explicit stable `low` and `fable-max` aliases keep their existing
token-free remote shapes, as do preset-omitted Claude switches, so mixed-version
rollout does not make an unchanged supported route unavailable. Devin and its
`astra` alias remain historical decoder and storage values only. Current remote
commands cannot select or execute them.

The local CLI and persistent daemon have the same independent-rollout problem.
Their strict socket envelope therefore has a build fence. It conditionally
carries the current active preset contract for `session.start` or
`session.preset` with High or Ultra, an explicit or derived High/Ultra switch to
Codex, a `work.create` whose immutable routes include High or Ultra, and a
`task.addBatch` that adds a High or Ultra task. The daemon validates that fence
before handing the command to the service. An older strict daemon rejects the
additive field, while a current daemon rejects an affected request that lacks
the current build fence. Read-only commands, daemon status and stop, explicit
stable presets, and other provider switches retain their existing token-free
envelope.

Caller-authored replay identity is separate from that socket fence. A new High
or Ultra `session.start`, and a provider switch that explicitly or implicitly
selects either mutable Codex alias, records the current contract inside the
command. If transport becomes uncertain, the CLI returns that immutable source
contract with the idempotency key, and the replay must preserve both values.
An applied source-matched request replays its historical result, and an
effect-started request remains recovery-required. A missing or inactive source
cannot create a fresh session or resume a prepared no-effect row. This lets a
current daemon look up historical evidence without treating an old Astra
request as a new Sol request.

Released session-start commands before this source field used their own exact
request digest. A v0.5.0 Codex start with the then-default preset omitted must
be replayed with an explicit `high` and contract 1, because that release meant
Sol Max and did not include `provider` in the digest. Contract 2 is a valid
compatibility selector only for an untagged Astra-era request whose immutable
runtime evidence proves Astra. Either selector can reach a source-matched
settled result or recovery-required evidence, and neither can admit a
contractless prepared row. Inactive contract 2 cannot authorize a fresh effect
under the current Sol binding. Active contract 1 can authorize the exact Sol
request when the key has no stored row, the same as a newly generated key.
Retain the originating binary when the historical meaning cannot be proved. A
contractless prepared row has no supported cancellation or retirement command.
It must reach a terminal settlement through exact replay under the originating
release, or the update remains blocked. Do not use a fresh key or
`session abandon` as a workaround. That command applies only to an existing
recovery-required session and never cancels prepared start or switch authority.

Work apply version 2 provides the same caller-authored boundary. Its top-level
`presetContract` is required for `work.create` declarations or `task.addBatch`
additions that name High or Ultra, and forbidden for stable operations. Fresh
affected version 2 requests require the current contract. Fresh affected
version 1 requests are refused because their intended Sol or Astra meaning is
not identifiable, while exact applied version 1 replay and stable version 1
operations remain available. Request version and source contract participate
in changed-intent detection. Fresh High or Ultra task additions also require
the target Work's durable contract to equal the current active contract. An
established contract 2 Work whose coordinator and participating session
authorities remain supported stays readable and may claim, execute, review, and
settle its existing Astra tasks. A Work associated with a retired Devin session
remains readable but is fenced from mutation and execution. Current tooling
refuses to extend any historical contract 2 Work with another rebound task;
create a new Work for a new Sol task graph.

Provider-switch preparation also includes the resolved High or Ultra contract
in its durable request identity. A prepared row left by a pre-update build
cannot resume after the alias changes, while stable Low and Fable preparation
and preset-omitted Claude preparation keep their prior digest shapes. Historical
Devin switch rows remain recovery evidence only and cannot execute. Stop and
restart the persistent daemon during an upgrade as the installation instructions
require. Resolve uncertain affected starts, switches, preset selections, and
Work requests before replacement, require daemon status to report
`data.running: false`, and expect affected writes to fail closed during a
mixed-version interval.

## Content-free evaluation export

The analyzer has exactly one invocation form:

```sh
bun ./scripts/routing-eval.ts --input /absolute/path/evaluation.json
```

It opens that one bounded regular JSON file once. It does not search for
exports, read session history, run a provider, write a file, or print the input
path, pair identifiers, environment bindings, task text, or model output.
Unknown keys and malformed UTF-8 are rejected. Rejections are generic so that a
private field cannot be copied into diagnostics.

The current schema version 3 accepts one of three comparisons:

- Codex Terra Ultra against Codex Sol Ultra.
- Claude Opus at `high`, `xhigh`, or `max` effort against Claude Fable Max.
- Codex Terra Fast against Terra in standard mode.

Schema version 1 remains readable only with its exact historical Sol baseline,
including the `terra_vs_sol` and `codex_sol_ultra` literals. Schema version 2
remains readable only with its exact Astra literals. Version 3 uses the Sol
literals for new studies without reusing the v1 evidence version. Relabelling
an export across these schema versions is rejected unless its exact comparison
belongs to that version.

An export declares `pilot` or `holdout`, a `well_defined` task shape, a
SHA-256 case-set digest over the exact ordered opaque pair identifiers and
their HMAC-SHA-256-shaped environment commitments, an optional preregistration
digest, and all seven fixed design assertions. The analyzer recomputes and
verifies that digest. Its array contains ordered, unique UUIDv4 pair
identifiers, unique environment commitments, and exactly balanced execution
order. Both arms use closed terminal, repair, safety, wall-clock, and
provider-native token-usage fields. These records deliberately have no dollar
price field.

Timeouts are quality failures. A holdout containing any
`infrastructure_invalid` outcome is invalid, and any candidate safety violation
is blocking. Quality non-inferiority uses a fixed margin of `0.05` and a
conservative paired interval derived from Wilson bounds for the two discordant
directions. A Fast comparison must also have an exponentiated one-sided 95%
Student-t upper bound for the geometric mean paired wall-clock ratio no greater
than `0.90`. The calculation states its independent, approximately normal
log-ratio assumption and uses upward-rounded
[NIST critical values](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm),
with conservative lower-degree-of-freedom breakpoints above 30. Even when
those statistics pass, Fast economics remain unresolved because this analyzer
has no price evidence and does not infer cost.

Forty pairs is a pilot floor only. It is not a holdout, an activation threshold,
or evidence of production safety. A holdout requires at least 200 pairs. No
private holdout currently exists, and the analyzer cannot prove that a supplied
digest predates a study. Reports therefore always state:

- `capabilityProof: "not_assessed"`
- `preregistrationChronology: "externally_unverified"`
- `liveRouting: "forbidden_phase_3_shadow_only"`
- `activationLicensed: false`

## Claims this phase does not accept

Broad plans sometimes treat public benchmark rank, advertised latency, nominal
context size, provider pricing, or account quota as sufficient routing proof.
They are not. Public evaluations need not match HRA's task distribution,
permissions, tool surface, repair policy, runtime generation, or safety effect
class. List prices do not establish observed private cost, and a documented
model name does not prove that HRA's pinned runtime can select and verify that
exact profile.

For the same reason, Phase 3 does not translate general claims such as “faster,”
“cheaper,” or “stronger” into a live rule. Technical profile admission in
Phase 4 requires a canonical identity, exact pinned-runtime and current-account
capability evidence, and reviewed runtime support. It permits explicit selection,
not automatic routing. Automatic routing in Phase 6 additionally requires private
non-inferiority evidence and the applicable latency, price, effort, and safety
evidence. Identity inventory and design for already supported profiles need not
wait for new-model capability or a private holdout. This document records those
distinct missing proof classes rather than volatile benchmark results.
