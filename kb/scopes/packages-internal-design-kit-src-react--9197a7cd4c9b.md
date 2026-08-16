---
title: HRA internal design-kit React context
type: agent-context
scope: packages/internal/design-kit/src/react
tags:
  - architecture
  - context-engineering
---

# HRA internal design-kit React context

The React boundary composes accessible primitives into HRA-owned application presentation. Interaction semantics remain with React Aria and `@hraness/ui`; HRA supplies product layout and content. Keep server-safe and browser-only entrypoints explicit and prove state, focus, and geometry with deterministic tests.

The repository-wide dependency and parallel-work contract lives in [[notes/repository-seams|repository seams]].
