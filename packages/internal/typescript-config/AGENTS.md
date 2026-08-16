# Contents

- `base.json` – strict framework-neutral compiler policy.
- `nextjs.json` – DOM, JSX, and Next.js additions.
- `package.json` – exported config subpaths.

# Guidelines

- Tighten shared safety flags here only when every workspace can adopt them in the same change.
- Workspace configs extend an exported preset and add only environment-specific types, paths, and includes.
- Do not weaken strictness locally to accommodate an unsafe boundary; parse or narrow the boundary instead.
