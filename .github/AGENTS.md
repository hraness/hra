# Contents

- `workflows/` – credential-free source, test, and build verification for pull requests, `main`, and manual runs.

# Guidelines

- Keep default permissions read-only and make unspecified permissions unavailable.
- Pin every third-party action by a full commit SHA and disable persisted checkout credentials.
- Do not use repository secrets, `pull_request_target`, release publication, signing, provider mutation, or artifact upload.
- Treat workflow names, commands, logs, and outputs as public data.
