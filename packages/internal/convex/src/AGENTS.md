# Contents

- `index.ts` – the public Convex deployment URL parser and result types.
- `index.test.ts` – readable configuration-boundary examples.
- `index.property.test.ts` – arbitrary-input totality and normalization laws.

# Guidelines

- Preserve the parser's exact missing, invalid, and ready states so callers must handle every configuration outcome.
- Accept only origins: reject credentials, paths, queries, fragments, and non-HTTPS remote deployments.
- Permit plain HTTP only for the exact loopback hostnames used by local Convex development.
- Test parser laws against independently generated inputs rather than restating implementation branches.
- Keep deployment credentials, provider commands, project identifiers, and release policy outside this parser package.
