---
title: HRA internal design-kit context
type: agent-context
scope: packages/internal/design-kit
tags:
  - architecture
  - context-engineering
---

# HRA internal design-kit context

HRA's internal design kit is a repository-owned presentation boundary over portable `@hraness/ui` primitives. It may serve HRA applications inside this workspace, but it is not public cross-repository package authority. Products retain route identity, domain behavior, copy, and composition.

The repository-wide dependency and parallel-work contract lives in [[notes/repository-seams|repository seams]].
