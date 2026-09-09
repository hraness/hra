# Contents

- `definition.ts` and `fixtures.ts` own fictional Direct scenarios and parsed observations.
- `main.tsx` mounts production screens; `io.ts` and `config.ts` own the closed replacement boundary.
- `index.html` is the isolated shell, sealed by the product-preview builder.

# Guidelines

- These are fictional, inert examples of production app screens, not a connected account.
- `main.tsx` imports the real screens, children, model reducers, and StyleX recipes. Never replace presentation with a lookalike or alias a model.
- `config.ts` is a closed IO replacement list. Unmapped auth, custody, or data IO must fail the build. Keep this entry out of the production app and npm package.
- `definition.ts` owns a strict Direct scenario catalog, fixed clock, and truthful rendering-only coverage. `fixtures.ts` supplies synthetic observations to the real reducers.
- Provider commands, auth, key custody, file reads, navigation, and persistent storage have no authority. Keep the screen inert and the browser fetch firewall closed.
- The public iframe uses `sandbox="allow-scripts"` without same-origin, forms, popups, downloads, or navigation grants. Its CSP denies connections, forms, workers, and nested frames.
- Readiness messages contain only the exact event type and admitted view. They are observations, never authority; the parent must match the iframe's `contentWindow` and expected view.
- The integration owner owns real browser acceptance and aggregate validation. Pure fixture tests prove synthetic data and refusal contracts only.
