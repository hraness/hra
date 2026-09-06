// Text that leaves the machine or reaches a terminal must carry no local
// absolute path and no control scalar. These checks are shared by cloud
// projections, streaming redaction, and CLI rendering.

const absolutePathTokenPattern = /(^|[^\p{L}\p{N}_/\\])((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;]*)/iu;
const absolutePathTokenGlobalPattern = /(^|[^\p{L}\p{N}_/\\])((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;]*)/giu;
const repeatedLeadingSlashPathPattern = /(^|[\s"'`<>{}[\](),;])\/{2,}[^\s"'`<>{}[\](),;]*/u;
const repeatedLeadingSlashPathGlobalPattern = /(^|[\s"'`<>{}[\](),;])\/{2,}[^\s"'`<>{}[\](),;]*/gu;
const unsafeTerminalScalarPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const secretShapedTextPattern =
  /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk|re)_[A-Za-z0-9_-]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{12,}|\bBearer\s+[A-Za-z0-9._~-]{8,})/u;

export function containsAbsolutePath(value: string): boolean {
  return absolutePathTokenPattern.test(value) || repeatedLeadingSlashPathPattern.test(value);
}

export function redactAbsolutePaths(value: string): string {
  return value
    .replace(repeatedLeadingSlashPathGlobalPattern, (_match, prefix: string) =>
      `${prefix}[local-path]`)
    .replace(absolutePathTokenGlobalPattern, (_match, prefix: string) =>
      `${prefix}[local-path]`);
}

export function containsUnsafeTerminalScalar(value: string, allowLineFeeds = false): boolean {
  for (const scalar of value) {
    if (allowLineFeeds && scalar === "\n") continue;
    if (unsafeTerminalScalarPattern.test(scalar)) return true;
  }
  return false;
}

/** Recognised credential material that must never cross a public/cloud text boundary. */
export function containsSecretShapedText(value: string): boolean {
  return secretShapedTextPattern.test(value);
}
