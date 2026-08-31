<!-- hra-local-efficiency:start -->
## HRA local efficiency

- Preserve useful agent fan-out. Do not cap agents merely to reduce their count.
- Workers own focused validation and report exact commands and results. One integration owner reviews that evidence and runs the repository aggregate/final gate after convergence. Repeat a focused command only when its inputs changed, evidence is missing, or a repair invalidated it.
- Give each CI run, merge-queue item, provider operation, or deployment wait one owner. Use one event-driven wait and do not hold a compute lease while waiting on external state.
- Route broad builds, repository-wide checks, native work, packaging, and heavyweight browser suites through `hra-host-run` when it is installed. Keep repository-owned schedulers and final gates intact.
- Reuse a validation receipt only for the exact Git tree, command, lockfiles, toolchain, relevant environment, and bounded validity period. Never reuse a receipt for a required final integration, merge, release, deployment, or production-verification gate.
- Keep roots and integrators on the caller-selected model. Bounded independent workers may use Terra or Luna through the installed profiles when their task is mechanical or high-volume; measure repair rate and promote difficult work.
- Use `$hra-local-efficiency` for guarded cleanup, stale-task audits, scheduler diagnostics, validation receipts, and machine adoption. This baseline does not configure or optimize cloud execution.
<!-- hra-local-efficiency:end -->
