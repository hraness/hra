# Contents

- `types.ts` defines the provider-neutral pane, account, repository, projection, and provider ports.
- `chat-service.ts` owns per-pane serialization, cross-pane concurrency, turn effects, pre-turn account routing, quota terminalization, and fail-closed recovery.
- `root-turn-routing-policy-v1.ts` classifies one bounded root prompt and optional prior content-free route into HRA's closed requested profile and tier.
- `codex-chat-provider.ts` adapts the pinned Codex protocol to HRA's resolved route, ordered text/local-image input, and bounded history handoff.
- `text-bounds.ts` maintains exact UTF-8 stream offsets and Unicode-safe bounded tails.
- `index.ts` is the gateway-owned chat API.

# Guidelines

- Send only renderer-safe pane projections and provider-neutral activity. Keep prompts, paths, usage, credentials, provider IDs, and retained history inside the gateway.
- Route every ordinary root turn through the versioned local prompt policy. Bounded leaves request Luna Max/Fast, conservative standard work requests Sol Max/Standard, and large changes or wide research request Sol Ultra/Standard. Continuation prompts inherit the prior content-free route and otherwise request Sol Max/Fast.
- Start, resume, turn, and steer Codex only under the verified `never`, `auto_review`, and `danger-full-access` production policy; send the resolved model and effort explicitly on every `turn/start`.
- Keep `ChatProviderConfiguration` limited to HRA's model, effort, and service-tier route. Execution policy is immutable SessionService authority, not a provider-selectable chat configuration field.
- Resolve capability only before provider effects and only on definitive catalog absence. Preserve intent with the exact candidate order Luna Fast, Luna Standard, Sol Max Fast, Sol Max Standard; Luna Standard, Sol Max Standard; or Sol Max Fast, Sol Max Standard. Sol Ultra Standard has no fallback. Pass the selected tier at thread start, resume, and turn start.
- Persist content-free classification, resolution, effect, acceptance, and terminal cuts around each ordinary root provider effect. Never replay or choose another profile after an ambiguous provider mutation or definitive quota rejection.
- A definitive provider usage-limit rejection terminalizes the current logical turn. Never refresh candidates, capture or inject history, select another account, or replay that turn after quota proof. A later user message may select one eligible account before its provider effect begins.
- Serialize effects independently per pane and let different panes run concurrently. The app-owned message ledger is the renderer's only ordinary-send authority: journal before admission, drain exactly one FIFO head, and bind its logical turn plus root route atomically before provider effects. Steering may consume only the exact head of the exact active turn under a verified production-policy generation fence.
- A prepared steer can return to FIFO only before its effect cut. Atomic composer enqueue-and-steer instead cancels its newly created prepared row and restores its exact live attachment draft leases on a pre-effect race. After effect-start, every non-acknowledged outcome is ambiguous, never retried or converted into an ordinary turn.
- Acquire digest-verified attachment descriptors and exact turn/provider-thread leases before every image effect. Keep user text first, then stable attachment order, and send images only as private `localImage` input. Reject generic files before custody or provider mutation until HRA owns a bounded extraction or structured provider capability; never put vault paths in model-visible text. Retain ambiguous provider custody until exact generation or native-thread containment proves release.
- Project ambiguous content as one neutral delivery-outcome-unknown receipt. Discard may only append a resolution after the owning logical turn is terminal or contained; it never edits, retries, or changes the ambiguous ledger row.
- Fail closed on unexpected interaction requests, interrupt or detach the provider turn, and leave the pane able to accept a later message.
- Run the focused chat store, service, adapter, transition, and property tests before the desktop affected gate.
