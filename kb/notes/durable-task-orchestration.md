---
title: Durable task orchestration
type: concept
tags:
  - orchestration
  - control-plane
  - durability
repository_scopes:
  - apps/desktop/runtime/src/dispatch
  - apps/desktop/runtime/src/state/local-run-execution-store.ts
  - apps/desktop/runtime/src/tasks
  - apps/desktop/runtime/src/workspaces
---

# Durable task orchestration

HRA treats task orchestration as a durable control plane. Coordination first
reconciles recorded work with current authority, then admits new work. Every
external-effect boundary must settle as current, obsolete, or explicitly
ambiguous. A process restart cannot turn missing memory into permission to
replay an effect.

This durability is the decisive boundary when learning from lightweight
tracker-driven orchestrators. Their control-loop shapes, workspace adversarial
tests, and policy separation can improve HRA's conformance evidence. Their
in-memory claims, retries, tracker authority, arbitrary repository hooks, and
terminal workspace deletion cannot replace HRA's receipts, fences, semantic
deadlines, managed worktree identity, and retained ambiguity evidence.

Execution text should have one owner whenever it must not vary by authority
path. The built-in task workflow prompt is therefore versioned in code and
shared by local and cloud dispatch. It remains a user message, not an authority
boundary. Sandbox admission, repository instructions, managed-worktree
custody, and current fences continue to govern effects.

If HRA later makes execution policy mutable at runtime, the entire candidate
must be strictly validated and activated atomically. The last-known-good policy
should survive an invalid candidate, a canonical cryptographic revision should
be pinned to each new admission, and reloads should affect future work only.
Persisting a ceremonial version before that mutability exists would add schema
surface without improving recovery.

The source comparison, disanalogies, and implemented first slice are recorded
in [[plans/hra-task-dispatch-prompt|one workflow prompt for local and cloud task dispatch]].
