import {
  PINNED_BUN_VERSION,
  RELEASE_CHECKSUM_FILE,
  RELEASE_MANIFEST_FILE,
  RELEASE_INSTALLER_FILE,
  RELEASE_PRODUCT,
  RELEASE_SCHEMA_VERSION,
  releaseManifestSchema,
  releaseTargets,
  type ReleaseManifest,
} from "./release-contract";

export const MAX_INSTALLER_METADATA_BYTES = 64 * 1_024;
export const MAX_INSTALLER_ARTIFACT_BYTES = 512 * 1_024 * 1_024;

export interface InstallerCatalog {
  readonly version: string;
  readonly artifacts: ReleaseManifest["artifacts"];
  readonly manifest: {
    readonly file: typeof RELEASE_MANIFEST_FILE;
    readonly bytes: number;
    readonly sha256: string;
  };
}

export function generateInstaller(input: InstallerCatalog): string {
  const parsed = releaseManifestSchema.parse({
    schemaVersion: RELEASE_SCHEMA_VERSION,
    product: RELEASE_PRODUCT,
    version: input.version,
    bunVersion: PINNED_BUN_VERSION,
    artifacts: input.artifacts,
    installer: { file: RELEASE_INSTALLER_FILE },
    checksum: { algorithm: "sha256", file: RELEASE_CHECKSUM_FILE },
  });
  if (
    input.manifest.file !== RELEASE_MANIFEST_FILE ||
    !Number.isSafeInteger(input.manifest.bytes) ||
    input.manifest.bytes <= 0 ||
    input.manifest.bytes > MAX_INSTALLER_METADATA_BYTES ||
    !/^[0-9a-f]{64}$/u.test(input.manifest.sha256)
  ) {
    throw new Error("installer manifest binding is invalid");
  }
  const artifacts = Object.fromEntries(
    releaseTargets.map((target, index) => [target.artifactSuffix, parsed.artifacts[index]]),
  );
  const darwinArm64 = artifacts["darwin-arm64"];
  const darwinX64 = artifacts["darwin-x64"];
  const linuxArm64 = artifacts["linux-arm64-glibc"];
  const linuxX64 = artifacts["linux-x64-glibc-baseline"];
  if (
    darwinArm64 === undefined ||
    darwinX64 === undefined ||
    linuxArm64 === undefined ||
    linuxX64 === undefined
  ) {
    throw new Error("installer target mapping invariant failed");
  }

  const catalog = [darwinArm64, darwinX64, linuxArm64, linuxX64] as const;
  if (catalog.some((artifact) => artifact === undefined)) {
    throw new Error("installer target catalog invariant failed");
  }

  return `#!/bin/sh
set -eu

fail() {
  printf '%s\\n' "taskctl installer: $1" >&2
  exit 1
}

SOURCE_DIR=''
RELEASE_URL=''
DESTINATION=''
TOKEN_ENV=''
REPLACE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-dir)
      [ "$#" -ge 2 ] || fail 'missing --source-dir value'
      SOURCE_DIR=$2
      shift 2
      ;;
    --release-url)
      [ "$#" -ge 2 ] || fail 'missing --release-url value'
      RELEASE_URL=$2
      shift 2
      ;;
    --destination)
      [ "$#" -ge 2 ] || fail 'missing --destination value'
      DESTINATION=$2
      shift 2
      ;;
    --github-token-env)
      [ "$#" -ge 2 ] || fail 'missing --github-token-env value'
      TOKEN_ENV=$2
      shift 2
      ;;
    --replace)
      REPLACE=1
      shift
      ;;
    *)
      fail 'unknown argument'
      ;;
  esac
done

[ -n "$DESTINATION" ] || fail '--destination is required'
if [ -n "$SOURCE_DIR" ] && [ -n "$RELEASE_URL" ]; then
  fail 'pass exactly one of --source-dir or --release-url'
fi
if [ -z "$SOURCE_DIR" ] && [ -z "$RELEASE_URL" ]; then
  fail 'pass exactly one of --source-dir or --release-url'
fi
if [ -n "$TOKEN_ENV" ] && [ -z "$RELEASE_URL" ]; then
  fail '--github-token-env requires --release-url'
fi

case "$DESTINATION" in
  /*) ;;
  *) fail '--destination must be an absolute path' ;;
esac
case "$DESTINATION" in
  *'//'*) fail '--destination must be normalized' ;;
  *'/./'*|*'/../'*|*/.|*/..) fail '--destination must be normalized' ;;
  */) fail '--destination must name a file' ;;
esac

PARENT=$(dirname "$DESTINATION")
[ -d "$PARENT" ] || fail 'destination parent does not exist'
[ ! -L "$PARENT" ] || fail 'destination parent must not be a symbolic link'
PARENT_PHYSICAL=$(CDPATH='' cd -P "$PARENT" 2>/dev/null && pwd -P) || fail 'cannot resolve destination parent'
[ "$PARENT_PHYSICAL" = "$PARENT" ] || fail 'destination parent must be a normalized physical path'
if [ -L "$DESTINATION" ]; then
  fail 'destination must not be a symbolic link'
fi
if [ -e "$DESTINATION" ]; then
  [ -f "$DESTINATION" ] || fail 'existing destination must be a regular file'
  [ "$REPLACE" -eq 1 ] || fail 'destination exists; pass --replace explicitly'
fi

SYSTEM=$(uname -s)
MACHINE=$(uname -m)
case "$SYSTEM:$MACHINE" in
  Darwin:arm64)
    ARTIFACT='${darwinArm64.file}'
    EXPECTED_SHA='${darwinArm64.sha256}'
    EXPECTED_BYTES='${darwinArm64.bytes}'
    ;;
  Darwin:x86_64)
    ARTIFACT='${darwinX64.file}'
    EXPECTED_SHA='${darwinX64.sha256}'
    EXPECTED_BYTES='${darwinX64.bytes}'
    ;;
  Linux:aarch64|Linux:arm64)
    command -v ldd >/dev/null 2>&1 || fail 'Linux glibc detection requires ldd'
    ldd --version 2>&1 | grep -E 'GLIBC|GNU C Library|GNU libc' >/dev/null 2>&1 || fail 'Linux musl and unknown libc hosts are unsupported'
    ARTIFACT='${linuxArm64.file}'
    EXPECTED_SHA='${linuxArm64.sha256}'
    EXPECTED_BYTES='${linuxArm64.bytes}'
    ;;
  Linux:x86_64|Linux:amd64)
    command -v ldd >/dev/null 2>&1 || fail 'Linux glibc detection requires ldd'
    ldd --version 2>&1 | grep -E 'GLIBC|GNU C Library|GNU libc' >/dev/null 2>&1 || fail 'Linux musl and unknown libc hosts are unsupported'
    ARTIFACT='${linuxX64.file}'
    EXPECTED_SHA='${linuxX64.sha256}'
    EXPECTED_BYTES='${linuxX64.bytes}'
    ;;
  *) fail 'unsupported operating system or architecture' ;;
esac

umask 077
WORK_DIR=$(mktemp -d "\${TMPDIR:-/tmp}/taskctl-install.XXXXXX") || fail 'could not create temporary directory'
INSTALL_TEMP=''
cleanup() {
  [ -z "$INSTALL_TEMP" ] || rm -f "$INSTALL_TEMP"
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT HUP INT TERM

file_size() {
  case "$SYSTEM" in
    Darwin) stat -f '%z' "$1" ;;
    Linux) stat -c '%s' "$1" ;;
    *) fail 'unsupported file-size platform' ;;
  esac
}

check_source_size() {
  PATHNAME=$1
  MAX_BYTES=$2
  EXACT_BYTES=$3
  LABEL=$4
  SIZE=$(file_size "$PATHNAME") || fail "could not inspect $LABEL"
  case "$SIZE" in
    ''|*[!0-9]*) fail "$LABEL has an invalid byte length" ;;
  esac
  [ "$SIZE" -gt 0 ] || fail "$LABEL is empty"
  [ "$SIZE" -le "$MAX_BYTES" ] || fail "$LABEL is too large"
  if [ "$EXACT_BYTES" -ne 0 ]; then
    [ "$SIZE" -eq "$EXACT_BYTES" ] || fail "$LABEL byte length does not match this installer build"
  fi
}

copy_local() {
  NAME=$1
  MAX_BYTES=$2
  EXACT_BYTES=$3
  LABEL=$4
  [ -f "$SOURCE_DIR/$NAME" ] || fail 'release file is missing or not regular'
  [ ! -L "$SOURCE_DIR/$NAME" ] || fail 'release file must not be a symbolic link'
  check_source_size "$SOURCE_DIR/$NAME" "$MAX_BYTES" "$EXACT_BYTES" "$LABEL"
  cp "$SOURCE_DIR/$NAME" "$WORK_DIR/$NAME" || fail 'could not copy release file'
}

curl_once() {
  URL=$1
  OUTPUT=$2
  HEADER_FILE=$3
  CONFIG_FILE=$4
  MAX_BYTES=$5
  if [ -n "$CONFIG_FILE" ]; then
    curl -q --config "$CONFIG_FILE" --proto '=https' --tlsv1.2 --silent --show-error \\
      --max-filesize "$MAX_BYTES" --max-redirs 0 --dump-header "$HEADER_FILE" --output "$OUTPUT" \\
      --write-out '%{http_code}' "$URL"
  else
    curl -q --proto '=https' --tlsv1.2 --silent --show-error \\
      --max-filesize "$MAX_BYTES" --max-redirs 0 --dump-header "$HEADER_FILE" --output "$OUTPUT" \\
      --write-out '%{http_code}' "$URL"
  fi
}

download_remote() {
  NAME=$1
  MAX_BYTES=$2
  EXACT_BYTES=$3
  LABEL=$4
  URL="$RELEASE_URL/$NAME"
  HEADER_FILE="$WORK_DIR/headers"
  OUTPUT="$WORK_DIR/$NAME"
  STATUS=$(curl_once "$URL" "$OUTPUT" "$HEADER_FILE" "$AUTH_CONFIG" "$MAX_BYTES") || fail 'release download failed'
  case "$STATUS" in
    200) ;;
    301|302|303|307|308)
      REDIRECT=$(awk 'tolower($1) == "location:" { $1=""; sub(/^ /, ""); sub(/\\r$/, ""); print; exit }' "$HEADER_FILE")
      case "$REDIRECT" in
        https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*|https://github-releases.githubusercontent.com/*) ;;
        *) fail 'release download returned an unsafe redirect' ;;
      esac
      : > "$HEADER_FILE"
      STATUS=$(curl_once "$REDIRECT" "$OUTPUT" "$HEADER_FILE" '' "$MAX_BYTES") || fail 'redirected release download failed'
      [ "$STATUS" = '200' ] || fail 'redirected release download returned an unexpected status'
      ;;
    *) fail 'release download returned an unexpected status' ;;
  esac
  rm -f "$HEADER_FILE"
  check_source_size "$OUTPUT" "$MAX_BYTES" "$EXACT_BYTES" "$LABEL"
}

if [ -n "$SOURCE_DIR" ]; then
  case "$SOURCE_DIR" in
    /*) ;;
    *) fail '--source-dir must be an absolute path' ;;
  esac
  [ -d "$SOURCE_DIR" ] || fail 'source directory does not exist'
  [ ! -L "$SOURCE_DIR" ] || fail 'source directory must not be a symbolic link'
  SOURCE_PHYSICAL=$(CDPATH='' cd -P "$SOURCE_DIR" 2>/dev/null && pwd -P) || fail 'cannot resolve source directory'
  [ "$SOURCE_PHYSICAL" = "$SOURCE_DIR" ] || fail 'source directory must be a normalized physical path'
  copy_local '${RELEASE_CHECKSUM_FILE}' '${MAX_INSTALLER_METADATA_BYTES}' '0' 'checksum file'
  copy_local '${RELEASE_MANIFEST_FILE}' '${MAX_INSTALLER_METADATA_BYTES}' '${input.manifest.bytes}' 'manifest'
  copy_local "$ARTIFACT" '${MAX_INSTALLER_ARTIFACT_BYTES}' "$EXPECTED_BYTES" 'artifact'
else
  command -v curl >/dev/null 2>&1 || fail 'remote installation requires curl'
  case "$RELEASE_URL" in
    https://github.com/*|https://api.github.com/*) ;;
    *) fail '--release-url must be an HTTPS GitHub URL' ;;
  esac
  case "$RELEASE_URL" in
    *'?'*|*'#'*|*'@'*|*' '*) fail '--release-url must not contain credentials, query, fragment, or spaces' ;;
  esac
  RELEASE_URL=\${RELEASE_URL%/}
  AUTH_CONFIG=''
  if [ -n "$TOKEN_ENV" ]; then
    printf '%s' "$TOKEN_ENV" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$' || fail 'invalid token environment variable name'
    TOKEN=$(printenv "$TOKEN_ENV" 2>/dev/null || true)
    [ -n "$TOKEN" ] || fail 'GitHub token environment variable is empty'
    printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9_=-]+$' || fail 'GitHub token contains unsupported characters'
    AUTH_CONFIG="$WORK_DIR/curl-config"
    printf 'header = "Authorization: Bearer %s"\\n' "$TOKEN" > "$AUTH_CONFIG"
    chmod 600 "$AUTH_CONFIG"
    unset "$TOKEN_ENV"
    unset TOKEN
  fi
  download_remote '${RELEASE_CHECKSUM_FILE}' '${MAX_INSTALLER_METADATA_BYTES}' '0' 'checksum file'
  download_remote '${RELEASE_MANIFEST_FILE}' '${MAX_INSTALLER_METADATA_BYTES}' '${input.manifest.bytes}' 'manifest'
  download_remote "$ARTIFACT" '${MAX_INSTALLER_ARTIFACT_BYTES}' "$EXPECTED_BYTES" 'artifact'
fi

[ $(wc -c < "$WORK_DIR/${RELEASE_CHECKSUM_FILE}") -le ${MAX_INSTALLER_METADATA_BYTES} ] || fail 'checksum file is too large'
[ $(wc -c < "$WORK_DIR/${RELEASE_MANIFEST_FILE}") -eq ${input.manifest.bytes} ] || fail 'manifest byte length does not match this installer build'
[ $(wc -c < "$WORK_DIR/$ARTIFACT") -le ${MAX_INSTALLER_ARTIFACT_BYTES} ] || fail 'artifact is too large'
[ $(wc -c < "$WORK_DIR/$ARTIFACT") -eq "$EXPECTED_BYTES" ] || fail 'artifact byte length does not match this installer build'

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail 'SHA-256 verification requires sha256sum or shasum'
  fi
}

require_checksum() {
  CHECKSUM_FILE=$1
  CHECKSUM_SHA=$2
  CHECKSUM_COUNT=$(grep -Fxc -- "$CHECKSUM_SHA  $CHECKSUM_FILE" "$WORK_DIR/${RELEASE_CHECKSUM_FILE}" || true)
  [ "$CHECKSUM_COUNT" -eq 1 ] || fail 'checksum set is stale, mixed, incomplete, or duplicated'
}

CHECKSUM_RECORDS=$(awk 'END { print NR }' "$WORK_DIR/${RELEASE_CHECKSUM_FILE}")
[ "$CHECKSUM_RECORDS" -eq 6 ] || fail 'checksum file must contain the exact six release entries'
require_checksum '${darwinArm64.file}' '${darwinArm64.sha256}'
require_checksum '${darwinX64.file}' '${darwinX64.sha256}'
require_checksum '${linuxArm64.file}' '${linuxArm64.sha256}'
require_checksum '${linuxX64.file}' '${linuxX64.sha256}'
require_checksum '${RELEASE_MANIFEST_FILE}' '${input.manifest.sha256}'
INSTALLER_SHA=$(hash_file "$0")
require_checksum '${RELEASE_INSTALLER_FILE}' "$INSTALLER_SHA"

MANIFEST_SHA=$(hash_file "$WORK_DIR/${RELEASE_MANIFEST_FILE}")
[ "$MANIFEST_SHA" = '${input.manifest.sha256}' ] || fail 'manifest does not match this installer build'
ACTUAL=$(hash_file "$WORK_DIR/$ARTIFACT")
[ "$ACTUAL" = "$EXPECTED_SHA" ] || fail 'artifact SHA-256 verification failed'

INSTALL_TEMP=$(mktemp "$PARENT/.taskctl-install.XXXXXX") || fail 'could not create destination temp file'
cp "$WORK_DIR/$ARTIFACT" "$INSTALL_TEMP" || fail 'could not copy verified artifact'
chmod 0755 "$INSTALL_TEMP" || fail 'could not mark verified artifact executable'
if [ -L "$DESTINATION" ]; then
  fail 'destination became a symbolic link'
fi
if [ -e "$DESTINATION" ] && [ "$REPLACE" -ne 1 ]; then
  fail 'destination appeared; pass --replace explicitly'
fi
mv -f "$INSTALL_TEMP" "$DESTINATION" || fail 'could not atomically install taskctl'
INSTALL_TEMP=''
printf '%s\\n' "installed taskctl at $DESTINATION"
`;
}
