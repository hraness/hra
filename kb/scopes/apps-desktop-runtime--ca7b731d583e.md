---
title: HRA desktop runtime context
type: agent-context
scope: apps/desktop/runtime
tags:
  - architecture
  - context-engineering
---

# HRA desktop runtime context

The desktop runtime is the compiled gateway between the native shell, local Codex processes, durable state, and renderer-safe contracts. Keep filesystem, process, credential, and repository authority behind validated runtime boundaries. Its guide and executable probes own the operational contract.

The repository-wide dependency and parallel-work contract lives in [[notes/repository-seams|repository seams]].
