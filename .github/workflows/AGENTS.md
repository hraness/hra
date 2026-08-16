# Contents

- `ci.yml` – frozen dependency installation, source verification, native macOS tests, and a ReleaseFast native build.

# Guidelines

- Run on pull requests, pushes to `main`, and explicit manual dispatch.
- Keep `permissions` read-only, persist no checkout credential, and consume no repository secret.
- Pin Bun 1.3.14, Node 24 through `.node-version`, the Apple Silicon Zig archive by URL and SHA-256, and every third-party action by a full commit SHA.
- Do not use `pull_request_target`, provider or release commands, signing identities, publication, or artifact upload.
- Keep CI output free of credentials, account data, provider coordinates, local source paths, and unpublished provenance.
