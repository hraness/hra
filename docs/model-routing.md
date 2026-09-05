# Model routing: Phase 3 shadow contract

HRA does not automatically route work to a different model in Phase 3. Ultra
is the only effective automatic default for new Codex sessions, with Fast off.
The task-shape classifier and the routing decision are shadow-only: they can
describe disabled studies, but they cannot mutate a session or authorize a
runtime profile.

Terra, Opus, Fast, and Astra are not enabled by this work. New sessions that
explicitly choose the Claude family continue to use Fable Max. Explicit preset
choices are preserved, and established sessions never change provider, preset,
or Fast state because of a shadow decision.

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
Terra Fast studies. A new, explicit, well-defined Claude family default may
describe the disabled Opus effort study. Unknown safety does not license either
study; it adds an unresolved effect-class blocker.

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

The strict schema accepts one of three comparisons:

- Codex Terra Ultra against Codex Sol Ultra.
- Claude Opus at `high`, `xhigh`, or `max` effort against Claude Fable Max.
- Codex Terra Fast against Terra in standard mode.

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
“cheaper,” or “stronger” into a live rule. Candidate admission belongs to later
phases and requires a canonical profile, exact capability evidence, reviewed
runtime support, private non-inferiority evidence, and the applicable latency,
price, effort, and safety evidence. This document intentionally records those
missing proof classes rather than volatile benchmark results.
