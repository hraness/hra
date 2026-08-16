---
title: HRA runtime source context
type: agent-context
scope: apps/desktop/runtime/src
tags:
  - architecture
  - context-engineering
---

# HRA runtime source context

Runtime source owns the private host protocol, supervision, persistence, dispatch, projection, and recovery implementation. Parse every foreign message from unknown, fence generation-scoped work, and preserve deterministic receipts and recovery evidence. The closest guide remains authoritative.

The repository-wide dependency and parallel-work contract lives in [[notes/repository-seams|repository seams]].
