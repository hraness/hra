# Contents

- `ci.yml` – frozen dependency installation, source verification, native macOS tests, and a core ad-hoc-signed package verification without large corresponding-source downloads.

# Guidelines

- Run on pull requests, pushes to `main`, and explicit manual dispatch.
- Keep `permissions` read-only, persist no checkout credential, and consume no repository secret.
- Pin Bun 1.3.14, Node 24 through `.node-version`, the Apple Silicon Zig archive by URL and SHA-256, and every third-party action by a full commit SHA.
- Do not use `pull_request_target`, provider or release commands, credential-backed signing identities, publication, or artifact upload. Credential-free ad-hoc signing is allowed only as a package-integrity check.
- Verify the pinned Bun, WebKit, Git, and Dugite Native source boundary in CI without downloading their release archives. Full clean-tree release assembly fetches and verifies those archives locally.
- Keep CI output free of credentials, account data, provider coordinates, local source paths, and unpublished provenance.
