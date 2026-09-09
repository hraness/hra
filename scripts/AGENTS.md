# Contents

- `check-effect-architecture.ts` and its paired fixtures constrain the reviewed Effect programs; `check-codex-effect-architecture.ts` owns the Codex module-role policy.
- `build-appearance.ts` produces the external, browser-only palette bootstrap reused by app and static-site builds; shared palette rules enter their completed StyleX unions.
- Build scripts compile the CLI, generate the static website, and finalize the browser app's complete StyleX graph.
- `build-site-stylex.ts` captures the static site's foundation and server-renderer graphs, seals all three HTML routes, and projects only verified public artifacts from the completed union.
- `dev-app.ts` watches app source and serves completed immutable app revisions on a strict loopback port. It owns its build child, listener, timers, and bounded retained revision store; it does not run installs or inject a browser runtime.
- `register-app-stylex-test-transform.ts` applies the public StyleX compiler only to app source loaded by app presentation tests, without changing the CLI or provider test runtime.
- `register-site-stylex-test-transform.ts` applies the same public compiler only to static-site source; it does not change CLI, cloud or provider loading.
- `app-browser.ts` verifies compiled production and IO-isolated app views plus the static site under their production CSP. `app-browser-runner.mjs` starts the typed Node bootstrap, which supervises the pinned Bun preparation child before importing its sealed Node driver. `app-browser-handoff.ts` binds inputs, artifacts and executable identities; `app-browser-server.ts` owns finite loopback serving and collection.
- `check:browser` builds its production inputs. `test:browser` requires those inputs, Node 24.18.1, Bun 1.3.14, and explicit `BUN_EXECUTABLE_PATH` and `CHROMIUM_EXECUTABLE_PATH`. `prepare-app-browser.ts` builds the isolated fixture and Node bundle without rewriting browser assertions or providing a Bun runtime shim.
- `test:browser:custody` proves real preparation and connected-browser cancellation plus partial setup failure before `check:browser` admits acceptance. `app-browser-custody-fixture.ts` self-signals in genuine Node at copied-data observations; the parent process test checks retained receipts and native absence without providing another cleanup owner. Ordinary script sweeps skip these explicitly enabled native cases.
- `app-browser-settlement.ts` observes exact restored stylesheet samples across adjacent browser frames within the original operation and profile deadlines. It retains stylesheet and target identity checks without changing styles or retrying the negative control.
- Check scripts verify package contents, README parity, dependencies, release metadata, and the absence of file-level import cycles under `src/`.
- `check-security-primitives.ts` compares per-file counts of load-bearing security primitives against the reviewed `security-primitives.json` table; a count changes only with a deliberate `--update` after review.
- `check-install-pins.ts` keeps the installer's embedded CLI and normalizer digests equal to the working tree (`--update` re-pins them) and, under a tag ref, proves the public command names the runtime bytes being released.
- The local release-tag helper verifies the immutable owner identity, exact clean current `main`, successful CI, monotonic version, and split provider rulesets before pushing one annotated tag. The tag workflow then creates and proves one GitHub Release and npm publication from the same bytes.

# Guidelines

- Keep scripts deterministic, noninteractive, and safe in a clean clone.
- Parse external command output from `unknown` and name every expected file.
- Do not read credentials, home-directory application state, or provider configuration during ordinary checks.
- Keep browser acceptance offline, with fresh owned profiles, a complete-profile deadline, one cancellation and cleanup owner, positive browser-process collection, and retained artifact/fixture receipts. Never weaken CSP or substitute fixture presentation for production components.
- Admit the compiler-produced browser driver once in Node, only after successful preparation, process-group and stdio collection. Preserve the producer's exact compiler-byte binding and original identity. Only pre-admission ctime may differ; every other field remains exact, each descriptor read remains strict, and the one immutable Node identity governs import, execution and terminal verification. Serialized admission records are evidence, never authority; never recapture a failed baseline or infer the cause of a metadata change.
- A release script derives publication authority only from the immutable owner identity, protected reviewed source, repository-governed trigger, and exact workload identity. It never invents scope or bypasses provider and repository gates, and it does not add a second conversational or repository-variable approval after those gates have authorized the same release.
