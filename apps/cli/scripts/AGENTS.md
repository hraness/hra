# Contents

- `release-contract.ts` – pinned targets, strict manifest parsing, checksums, and artifact verification.
- `installer-template.ts` – generated POSIX installer with local and authenticated HTTPS sources.
- `release.ts` – build, verify, and current-platform smoke command entrypoint.
- `*.test.ts` – mapping, tamper, symlink, size-bound, curl-config, and destination-safety regressions.

# Guidelines

- Pin every Bun target name and artifact filename; never infer a compile target from untrusted text.
- Treat manifests, checksum files, downloaded bytes, platform values, and install destinations as untrusted.
- Bound metadata reads before allocation, reject symlinks before opening, and require an exact release-directory file set.
- Verify SHA-256 and byte length before making an artifact executable or moving it into place.
- Install one regular file into an explicit absolute destination without archive extraction, privilege escalation, or implicit overwrite.
- Keep bearer tokens out of arguments, output, generated manifests, and redirect requests to another origin.
- Hosted publishing is out of scope; release commands only create and verify local files.
