<!-- hra-local-efficiency:start -->
## HRA local efficiency

- Preserve useful agent fan-out. Do not cap agents merely to reduce their count.
- Workers own focused validation and report exact commands and results. One integration owner reviews that evidence and runs the repository aggregate/final gate after convergence. Repeat a focused command only when its inputs changed, evidence is missing, or a repair invalidated it.
- Give each CI run, merge-queue item, provider operation, or deployment wait one owner. Use one event-driven wait and do not hold a compute lease while waiting on external state.
- Route broad builds, repository-wide checks, native work, packaging, heavyweight browser suites, and HRA process-custody or recovery checks through `hra-host-run` when it is installed. Keep repository-owned schedulers and final gates intact.
- Treat the top-level host scheduler as a reviewed permission boundary. Resolve `hra-host-run` to its installed absolute command path and invoke that path directly with the complete child argv when requesting host access; do not hide it behind `env` or a shell wrapper. On `HRA_HOST_ACCESS_REQUIRED` (exit 77), retry the identical wrapper invocation once with reviewed host access. If it persists, stop and diagnose. Never run the child directly, delete scheduler or recovery state, weaken custody, or install an unconditional allow rule for the wrapper.
- Reuse a validation receipt only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and bounded validity period. Never reuse a receipt for a required final integration, merge, release, deployment, or production-verification gate.
- Keep roots and integrators on the caller-selected model. Bounded independent workers may use Terra or Luna through the installed profiles when their task is mechanical or high-volume; measure repair rate and promote difficult work.
- Use `$hra-local-efficiency` for guarded cleanup, stale-task audits, scheduler diagnostics, validation receipts, and machine adoption. This baseline does not configure or optimize cloud execution.
- The bootstrap installs a prompt-only rule for the absolute host scheduler. That rule grants no permission; configured Codex approval or auto-review still inspects each complete invocation, and a new Codex task is required after installation or update for the rule to load.
<!-- hra-local-efficiency:end -->
