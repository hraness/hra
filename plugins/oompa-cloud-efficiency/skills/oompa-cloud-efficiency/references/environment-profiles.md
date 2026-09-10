# Codex Cloud environment profiles

Read this reference only when creating or maintaining a Codex Cloud repository environment.

Environment creation currently happens in [Codex environment settings](https://chatgpt.com/codex/settings/environments). Do not call undocumented provider endpoints. Grant the GitHub installation only the repositories approved for Cloud use during the pilot.

Keep agent internet off and configure no secrets unless a reviewed task proves a narrower requirement. Setup scripts have network access. Secrets are available only during setup and are removed before the agent phase.

## Portable Bun

Use for `hraness/result`, `hraness/types`, and similar credential-free packages:

```sh
set -euo pipefail
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
case "$(uname -m)" in
  x86_64)
    bun_asset="bun-linux-x64-baseline"
    bun_sha256="a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7"
    ;;
  aarch64|arm64)
    bun_asset="bun-linux-aarch64"
    bun_sha256="a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b"
    ;;
  *)
    printf '%s\n' 'unsupported Cloud architecture' >&2
    exit 1
    ;;
esac
bun_setup_root="$(mktemp -d)"
trap 'rm -R -- "$bun_setup_root"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$bun_setup_root/bun.zip" \
  "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/${bun_asset}.zip"
printf '%s  %s\n' "$bun_sha256" "$bun_setup_root/bun.zip" | sha256sum --check --strict
unzip -q "$bun_setup_root/bun.zip" -d "$bun_setup_root/unpacked"
install -d -m 0755 "$BUN_INSTALL/bin"
install -m 0755 "$bun_setup_root/unpacked/$bun_asset/bun" "$BUN_INSTALL/bin/bun"
rm -R -- "$bun_setup_root"
trap - EXIT
grep -Fqx 'export BUN_INSTALL="$HOME/.bun"' "$HOME/.bashrc" || printf '%s\n' 'export BUN_INSTALL="$HOME/.bun"' >> "$HOME/.bashrc"
grep -Fqx 'export PATH="$BUN_INSTALL/bin:$PATH"' "$HOME/.bashrc" || printf '%s\n' 'export PATH="$BUN_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
test "$(bun --version)" = "1.3.14"
bun install --frozen-lockfile --ignore-scripts
test -z "$(git status --porcelain --untracked-files=all)"
```

The asset digests above are the official GitHub release digests for Bun 1.3.14. Do not replace this with an unverified installer pipe.

Maintenance:

```sh
set -euo pipefail
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
test "$(bun --version)" = "1.3.14"
bun install --frozen-lockfile --ignore-scripts
test -z "$(git status --porcelain --untracked-files=all)"
```

## Linux browser

For `hraness/design-kit`, use Portable Bun and then install its pinned browser:

```sh
DEBIAN_FRONTEND=noninteractive node_modules/.bin/playwright-core install --with-deps --no-progress chromium
```

Maintenance uses:

```sh
node_modules/.bin/playwright-core install --no-progress chromium
```

This profile is for auth-free headless tests. It does not make signed-in browser sessions eligible for Cloud.

## Other reviewed profiles

- `node24-web`: Portable Bun plus the repository-pinned Node 24 runtime.
- `linux-media`: a portable profile plus pinned FFmpeg for auth-free media tests.
- `qmd-linux`: a reviewed Bun or npm contract plus `libsqlite3-dev`; add Nix only when the task requires it.

Do not infer that a profile makes a repository safe. The route gate still applies to every task and branch.
