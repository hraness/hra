# Contents

- `index.ts` – shared property-test API.
- `index.test.ts` – property-run configuration examples.

# Guidelines

- Keep the wrapper thin enough that fast-check replay information remains intact.
- Defaults must bound accidental runaway suites without reducing normal shrinking quality.
