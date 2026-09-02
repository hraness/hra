# Roadmap

This page summarizes the proposed HRA v2 plan (`kb/plans/hra-v2.md`) for readers who want to know what is coming without the implementation detail. Nothing here is a commitment until the plan is adopted; the plan file records status.

## Direction

HRA becomes a control plane for coding-agent subscriptions. Codex is supported today. Claude subscriptions are next, run only through the unmodified Claude Code runtime signed in by the user, with HRA never touching the credential. Humans get a terminal shell and a keyboard-first web surface; agents get one machine-readable CLI schema and one work protocol.

## Waves

| Wave | Focus | What you will notice |
| --- | --- | --- |
| 0 | Robustness, security, boundaries | The daemon survives many concurrent agents; `hra help` and offline `work protocol`; README leads with a thesis. |
| 1 | Contract and install | Additive JSON envelope fields; `bun add -g @hraness/hra` as the primary install; hosted sync switched on for the maintainer. |
| 2 | Decomposition, Claude, schema | A Claude account beside a Codex account; `hra schema --json`; a README under 800 words; the browser reads a live session. |
| 3 | Routing and telemetry | Typed task classes enforced at admission; a routing report from real work; plugins consume policy data. |
| 4 | Provider port and web parity | One provider port behind both runtimes; session start and current usage from the browser. |

## What HRA will not do

- Rotate, pool, or fail over between accounts or providers automatically.
- Hold, read, or forward any provider credential.
- Route through a learned model router or a cost cascade.
- Offer provider login from the web surface.
