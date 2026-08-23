# Contents

- Bundle inspection proves the supported ChatGPT application identity and isolated-profile hook.
- The switch journal coordinates quit, profile selection, relaunch, verification, and recovery.

# Guidelines

- Support only a signed OpenAI bundle whose identifier and profile hook pass the reviewed capability probe.
- Use separate desktop user-data and Codex-home directories per profile. Never copy `auth.json`, edit another profile, or mutate Keychain directly.
- Acquire one machine-global lock and refuse switching while any affected provider or login effect is unresolved.
- Preserve the source profile and prepared journal through every uncertain state. Never retry an indeterminate switch automatically.
- Relaunch the exact executable directly with an allowlisted environment, then verify the selected account through a read-only provider call.
- Reconcile only the current switch authority under the machine lock. Recovery is read-only toward ChatGPT and Codex: never quit, launch, retry, copy credentials, or edit provider state.
- Keep ambiguous attempts immutable. Append a CAS-bound resolution only after two stable exact-process observations prove the selected account or prove that no target instance remains.
