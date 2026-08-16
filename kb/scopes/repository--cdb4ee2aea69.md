---
title: Repository agent context
type: agent-context
scope: .
tags:
  - agents
  - architecture
  - context-engineering
---

# Repository agent context

The root `AGENTS.md` is the normative control plane. It owns the compact rules required before editing; this hub supplies pull-based rationale and routing without replacing those rules.

## Authority

The closest `AGENTS.md` owns mandatory edit-time constraints. `docs/` owns current multi-step procedures. Types, schemas, tests, and deterministic checkers own executable contracts. The KB owns rationale, history, evidence, maintained synthesis, relationships, and plans. See [[notes/documentation-ownership|documentation ownership]].

## Engineering baseline

Use unreasonably robust programming when agent work is cheap, while treating production exposure, provider coordination, rollout, and observation as real costs. Model invalid states out, parse foreign values from `unknown`, keep readable regression examples, and add property tests for laws and round trips. Promote shrunk counterexamples into deterministic examples.

## Repository boundary

[[notes/repository-seams|Repository seams]] records the stable dependency and parallel-work boundary for this repository. The repository stays independently buildable and consumes external Hraness packages only through immutable reviewed releases or commits.
