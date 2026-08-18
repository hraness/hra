# Contents

- `main.zig` – HRA identity, frontend source, runtime lifecycle composition, bridge dispatcher, navigation allowlist, icon, and initial window options.
- `runtime_host.zig` – packaged gateway resolution, sanitized child environment, asynchronous JSONL transport, paged snapshots, bounded queues, and UI-loop bridge/event delivery.
- `cloud_config.zon` – checked public production relay and WorkOS client coordinates; it never contains provider secrets.
- `runner.zig` – generated Native SDK lifecycle, logging, platform, and WebView runner integration.
- `data_remover.zig` – private signed-request whole-app remover plus descriptor-relative exact account-home deletion helper.
- `macos_image_normalizer.{h,m}` – entitlement-free ImageIO/CoreGraphics attachment normalizer with descriptor-relative input/output authority, bounded single-frame decoding, and receipt-only JSON output.
- `macos_application_lifecycle.{h,m}` – immediately reverified helper recovery/spawn plus an independent one-shot graceful-then-forced termination watchdog.
- `macos_code_identity.{h,m}` – effective-user path validation plus sealed-bundle, exact-CDHash suspended helper launch and dynamic child attestation.
- `macos_instance_guard.{h,m}` – process-lifetime singleton lock stored outside the removable application-data root.
- `macos_updater.{h,m}` – release-key-gated dynamic Sparkle startup and the native Check for Updates command.

# Guidelines

- Keep product-specific native composition in `main.zig`; keep `runner.zig` aligned with the pinned Native SDK scaffold unless a documented platform requirement forces a divergence.
- Preserve the macOS 13 minimum imposed by the compiled Bun gateway and the system-WebView path in the build graph.
- Keep gateway process I/O off the UI thread and call Native SDK responders or window-event APIs only while draining `.effects_wake` on the UI loop.
- Keep renderer bridge command names and allowed origins identical in `runtime_host.zig`, `app.zon`, and the renderer contract. Native-only gateway commands must stay absent from every renderer command policy.
- Keep Native responsible for transport limits, protected ordered delivery of scoped task invalidations, and lifecycle—not Codex/task semantics, account state, credential access, or process-generation decisions.
- Do not expose filesystem, process, clipboard, or network privileges to the renderer without a typed capability and an explicit product requirement.
- Keep bundle identity and visible application naming consistent with `app.zon`.
- A remote frontend is a Debug-only development capability. Require the exact fixed loopback URL, HMR marker, development mode, and canonical session nonce together; every incomplete envelope and every Release build must use bundled assets and the production bridge origin.
- Keep the nonce-authenticated Debug HMR envelope limited to the fixed frontend URL and bridge origin. Do not forward a source checkout or direct-execution capability to the gateway.
- Keep runtime hot apply behind the existing transport-retry bridge command's strict Debug-development payload. Ordinary and forced recovery retain their existing meanings; production and automation must reject development reload, and a busy gateway must remain untouched.
- Retire an accepted development generation through stdin closure and canonical gateway cleanup. Fence the old process tree before launching the exact reserved candidate, and never turn a compiler failure or ambiguous apply into forced recovery.
- Keep the packaged production Convex HTTP origin and public WorkOS client coordinate pinned in `cloud_config.zon` and disabled until exact provider readback passes. Ambient cloud variables may select development and automation fixtures, but must never redirect the production bridge profile.
- Keep the local-data helper private to the native/gateway launch envelope. Spawn it suspended with close-by-default descriptors, an empty environment, and null stdio; dynamically attest the actual child against the sealed embedded helper's exact CodeDirectory hash before resuming it. Reap every rejected child, start the READY deadline only after resume, require a positive readiness handshake before scheduling termination, and make startup recovery avoid every ordinary application writer.
- Keep account-home deletion anchored to no-follow directory descriptors from the absolute control-plane path through the fixed `codex/accounts/<account-id>/home` layout. Reject redirected ancestors, special files, cross-device trees, or identity changes, and never follow a symlink while deleting.
- Keep image normalization in the signed native helper. Accept only one bounded PNG, JPEG, HEIC, or WebP frame from a no-follow single-link regular file; render orientation into a metadata-free sRGB raster; and publish bounded deterministic `canonical.png` plus `preview.png` through one exclusive, fsynced generation-directory rename. Reject redirected paths, reused outputs, special files, animation, decompression excess, and identity changes. The helper has no network authority or entitlements, and its public JSON must never contain a path.
- Treat an exact final generation directory containing only `canonical.png` and `preview.png` as the attachment-ready boundary. Startup reconciliation may remove only no-follow sibling directories whose names match the helper-owned `.hra-image-normalizer-<32 lowercase hex>.tmp` shape; an absent final generation is uncommitted, while a present final generation must be reverified from its durable digest receipt before use.
- Terminal local-data removal must arm the detached one-shot watchdog before returning the pathless public result. Preserve enough grace for RuntimeHost shutdown while retaining an independent forced-exit bound if AppKit or the UI loop stalls.
- Keep the updater inert when the release feed or canonical Ed25519 public key is absent; local unsigned development must never invent an update trust root.
