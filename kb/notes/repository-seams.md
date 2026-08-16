---
title: Repository seams
type: concept
tags:
  - architecture
  - dependencies
  - parallel-work
---

# Repository seams

HRA is a standalone public multi-app workspace. Product-neutral task contracts may be shared by its apps, while HRA-specific desktop, web, account, and presentation behavior remains product-owned. Internal design and support packages stay internal; external Hraness packages are immutable reviewed inputs and never require sibling checkouts.

Shared interfaces are frozen before parallel implementation lanes begin. One integration owner changes manifests, lockfiles, generated registries, or other convergence files. Consumers upgrade immutable releases independently, so no repository requires coordinated `main` branches or a sibling checkout.

All committed knowledge is public-safe and excludes credentials, private task content, provider account state, signing custody, and internal operating context.
