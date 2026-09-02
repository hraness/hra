// Text that leaves the machine or reaches a terminal must carry no local
// absolute path and no control scalar. These checks are shared by cloud
// projections, streaming redaction, and CLI rendering.

const absolutePathTokenPattern = /(^|[^\p{L}\p{N}_/\\])((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;]*)/iu;
const absolutePathTokenGlobalPattern = /(^|[^\p{L}\p{N}_/\\])((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;]*)/giu;
const repeatedLeadingSlashPathPattern = /(^|[\s"'`<>{}[\](),;])\/{2,}[^\s"'`<>{}[\](),;]*/u;
const repeatedLeadingSlashPathGlobalPattern = /(^|[\s"'`<>{}[\](),;])\/{2,}[^\s"'`<>{}[\](),;]*/gu;
const unsafeTerminalScalarPattern = /[\p{Cc}\p{Cf}\p{Cs}]/u;

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
