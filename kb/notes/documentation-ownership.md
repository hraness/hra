---
title: Documentation ownership
type: concept
tags:
  - agents
  - documentation
  - knowledge-management
repository_scopes:
  - AGENTS.md
  - docs
  - kb
  - WRITING.md
  - STYLE.md
---

# Documentation ownership

Repository knowledge stays useful when each kind of truth has one primary home. The closest inherited `AGENTS.md` owns mandatory edit-time rules. `docs/` owns current multi-step procedures. Types, schemas, tests, and deterministic checkers own executable contracts. The KB owns pull-based rationale, evidence, maintained synthesis, relationships, and plans. `README.md` remains the human front door.

This authority direction is one-way. [[scopes/repository--cdb4ee2aea69|A scope hub]] can explain why a guide contains a constraint, but it cannot silently override that guide. A runbook can point to a test, but copying the test's rules into prose creates a second contract that can drift.

Use plans under `kb/plans/` to coordinate change and preserve decisions, deviations, review findings, and verification evidence. Promote a conclusion into a maintained note when it remains useful after the plan reaches a terminal state.
