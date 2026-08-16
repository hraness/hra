---
title: HRA desktop context
type: agent-context
scope: apps/desktop
tags:
  - architecture
  - context-engineering
---

# HRA desktop context

The HRA desktop workspace owns the native shell, renderer, local runtime, and product composition. Portable task and client contracts stay in their neutral packages; native authority, account custody, Codex supervision, and presentation remain product-owned. The closest guide is normative.

The repository-wide dependency and parallel-work contract lives in [[notes/repository-seams|repository seams]].
