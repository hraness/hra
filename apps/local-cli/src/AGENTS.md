# Contents

- `args.ts` – exact read-only command grammar.
- `discovery.ts` – fixed production and development endpoint discovery with POSIX custody checks.
- `client.ts` – bounded one-request AF_UNIX client and strict response parsing.
- `output.ts` and `index.ts` – stable stdout JSON, pathless diagnostics, and executable composition.
- `*.test.ts` – argument, discovery, transport, redaction, and output regressions.

# Guidelines

- Parse argv as foreign input and reject every undocumented token, option, and positional argument.
- Keep test seams limited to an isolated home directory, expected UID, clock, and timeout. Never accept an endpoint or capability override.
- Erase capabilities after request construction and keep thrown errors limited to closed public codes.
- Successful stdout contains only a validated attention or pane projection followed by one newline.
