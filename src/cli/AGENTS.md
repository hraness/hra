# Contents

- Command modules map strict argv into one domain intent.
- Renderers produce stable human output or versioned JSON.
- Exit codes map closed domain failures to shell behavior.
- `--attach` collects file paths; the composition entry stores each file and reissues the command with digest references, so no path ever crosses the local socket.

# Guidelines

- Parse argv once and reject unknown flags or extra positional values.
- Select objects by exact ID or one unambiguous label. Ambiguity performs no effect.
- Do not prompt in `--json` mode. Return a closed `interaction_required` error with the next command.
- Keep stdout data-only and stderr diagnostic-only.
- Add command examples and JSON snapshots for every public command.
