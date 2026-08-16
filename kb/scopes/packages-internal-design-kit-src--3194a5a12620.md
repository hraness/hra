---
title: HRA internal design-kit source context
type: agent-context
scope: packages/internal/design-kit/src
tags:
  - architecture
  - context-engineering
---

# HRA internal design-kit source context

The design source keeps typed roles, CSS, fonts, server utilities, and browser presentation in explicit entrypoints. Preserve parity between typed and CSS contracts, deterministic appearance, accessible fallbacks, and product-free package code. The closest guide and property tests own exact behavior.

The repository-wide dependency and parallel-work contract lives in [[notes/repository-seams|repository seams]].
