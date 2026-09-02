import { stripVTControlCharacters } from "node:util";

const delimitedLabelPrefixSource = String.raw`(?:[\p{L}\p{N}]+[_-])*`;
const collapsedLabelPrefixSource = String.raw`[\p{L}\p{N}]*`;
export const sensitiveHorizontalWhitespaceSource = String.raw`[\p{Zs}\t]`;
const sensitiveWordSeparatorSource = String.raw`(?:[_-]|${sensitiveHorizontalWhitespaceSource})`;
export const sensitiveQuotedKeyCloseSource = String.raw`(?:"|'|\x60)?`;

export const sensitiveHeaderLabelSource = String.raw`(?<![\p{L}\p{N}_-])(?:${delimitedLabelPrefixSource}(?:authorization|proxy${sensitiveWordSeparatorSource}?authorization|cookie|set${sensitiveWordSeparatorSource}?cookie)|${collapsedLabelPrefixSource}(?:proxyauthorization|authorization|setcookie))\b`;

export const sensitiveCredentialLabelSource = String.raw`(?<![\p{L}\p{N}_-])(?:${delimitedLabelPrefixSource}(?:token|(?:access|refresh|id)${sensitiveWordSeparatorSource}?token|api${sensitiveWordSeparatorSource}?key|access${sensitiveWordSeparatorSource}?key|password|secret|otp|invite|(?:verification|device|user)${sensitiveWordSeparatorSource}?code)|${collapsedLabelPrefixSource}(?:accesstoken|refreshtoken|idtoken|apikey|accesskey|secretaccesskey|password|secret|verificationcode|devicecode|usercode))\b`;

const completeHeaderAssignment = new RegExp(
  String.raw`${sensitiveHeaderLabelSource}${sensitiveQuotedKeyCloseSource}${sensitiveHorizontalWhitespaceSource}*[:=][^\r\n]*`,
  "giu",
);
const quotedCredentialValueSource = String.raw`(?:"(?:\\.|[^"\\\r\n])*(?:"|(?=\r?\n|$))|'(?:\\.|[^'\\\r\n])*(?:'|(?=\r?\n|$))|\x60(?:\\.|[^\x60\\\r\n])*(?:\x60|(?=\r?\n|$)))`;
const completeCredentialAssignment = new RegExp(
  String.raw`${sensitiveCredentialLabelSource}${sensitiveQuotedKeyCloseSource}${sensitiveHorizontalWhitespaceSource}*[:=]\s*(?:[\[{][\s\S]*|${quotedCredentialValueSource}|(?:Bearer|Basic)${sensitiveHorizontalWhitespaceSource}+[^\s]+|[^\s]+)`,
  "gimu",
);
const completeAuthorizationScheme = /\b(?:Bearer|Basic)[\p{Zs}\t]+[^\s,;]+/giu;
const completePrivateKeyHeader = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu;
const unsafeSensitiveScalar = /(?:[\p{Cc}\p{Cf}\p{Cs}\p{M}]|\p{Default_Ignorable_Code_Point})/u;
// Unlabelled secret shapes. Each pattern anchors on a vendor prefix or, for
// the AWS secret access key, on the exact 40-character mixed-class shape, so
// ordinary words, hashes, and identifiers do not match. The `sk-` family
// already covers `sk-ant-` and `sk-proj-`, and the GitHub family covers
// `ghp_` and `github_pat_`. `src/streaming-sensitive-text.ts` mirrors this
// list as introducers; change both together.
export const unlabelledSecretPatterns: readonly Readonly<{
  ignoreCase: boolean;
  source: string;
}>[] = [
  { ignoreCase: true, source: String.raw`(?<![\p{L}\p{N}_])(?:sk|re)_[A-Za-z0-9_-]{8,}` },
  { ignoreCase: true, source: String.raw`(?<![\p{L}\p{N}_])(?:sk|re)-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}` },
  { ignoreCase: true, source: String.raw`(?<![\p{L}\p{N}_])(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}` },
  { ignoreCase: true, source: String.raw`(?<![\p{L}\p{N}_])xox[baprs]-[A-Za-z0-9-]{8,}` },
  { ignoreCase: false, source: String.raw`(?<![A-Z0-9])AKIA[A-Z0-9]{12,}` },
  { ignoreCase: false, source: String.raw`(?<![\p{L}\p{N}_])glpat-[A-Za-z0-9_-]{20,}` },
  { ignoreCase: false, source: String.raw`(?<![\p{L}\p{N}_])hf_[A-Za-z0-9]{30,}` },
  { ignoreCase: false, source: String.raw`(?<![\p{L}\p{N}_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])` },
  { ignoreCase: false, source: String.raw`(?<![\p{L}\p{N}_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])` },
  {
    ignoreCase: false,
    source: String.raw`(?<![A-Za-z0-9/+=])(?=[A-Za-z0-9/+]{0,39}[A-Z])(?=[A-Za-z0-9/+]{0,39}[a-z])(?=[A-Za-z0-9/+]{0,39}[0-9])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`,
  },
];
export const unlabelledSecretPattern = (
  entry: (typeof unlabelledSecretPatterns)[number],
  global: boolean,
): RegExp => new RegExp(entry.source, `${global ? "g" : ""}${entry.ignoreCase ? "i" : ""}u`);
const completeTokenPatterns: readonly RegExp[] = [
  ...unlabelledSecretPatterns.map((entry) => unlabelledSecretPattern(entry, true)),
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/gu,
];

const redactCanonicalSensitiveText = (
  value: string,
  replacement: string,
): string => {
  if (completePrivateKeyHeader.test(value)) return replacement;
  let redacted = value
    .replace(completeHeaderAssignment, replacement)
    .replace(completeCredentialAssignment, replacement)
    .replace(completeAuthorizationScheme, replacement);
  for (const pattern of completeTokenPatterns) redacted = redacted.replace(pattern, replacement);
  return redacted;
};

const mapUnsafeSensitiveScalars = (value: string, whitespaceAsSpace: boolean): string => {
  let normalized = "";
  for (const scalar of value) {
    if (scalar === "\r" || scalar === "\n") {
      normalized += scalar;
    } else if (!unsafeSensitiveScalar.test(scalar)) {
      normalized += scalar;
    } else if (whitespaceAsSpace && /\s/u.test(scalar)) {
      normalized += " ";
    }
  }
  return normalized;
};

const sensitiveCanonicalCandidates = (value: string): ReadonlySet<string> => {
  if (!unsafeSensitiveScalar.test(value)) return new Set([value]);
  return new Set([
    value,
    mapUnsafeSensitiveScalars(value, false),
    mapUnsafeSensitiveScalars(value, true),
    mapUnsafeSensitiveScalars(stripVTControlCharacters(value), false),
    mapUnsafeSensitiveScalars(stripVTControlCharacters(value), true),
  ]);
};

const canonicalSensitiveLabelEvidence = new RegExp(
  String.raw`(?:${sensitiveHeaderLabelSource}|${sensitiveCredentialLabelSource})${sensitiveQuotedKeyCloseSource}${sensitiveHorizontalWhitespaceSource}*(?=$|[:=])`,
  "iu",
);

export const hasSensitiveObfuscatingScalar = (value: string): boolean =>
  Array.from(value).some((scalar) =>
    scalar !== "\r"
    && scalar !== "\n"
    && scalar !== "\t"
    && unsafeSensitiveScalar.test(scalar));

export const hasCanonicalSensitiveLabelEvidence = (value: string): boolean => {
  if (!unsafeSensitiveScalar.test(value)) return false;
  for (const candidate of sensitiveCanonicalCandidates(value)) {
    if (canonicalSensitiveLabelEvidence.test(candidate)) return true;
  }
  return false;
};

const containsSensitiveHeaderLabel = new RegExp(sensitiveHeaderLabelSource, "iu");
const containsSensitiveCredentialLabel = new RegExp(sensitiveCredentialLabelSource, "iu");

export const isSensitiveDiagnosticKey = (value: string): boolean => {
  for (const candidate of sensitiveCanonicalCandidates(value)) {
    if (
      containsSensitiveHeaderLabel.test(candidate)
      || containsSensitiveCredentialLabel.test(candidate)
    ) {
      return true;
    }
  }
  return false;
};

export const redactCompleteSensitiveText = (
  value: string,
  replacement = "[redacted]",
): string => {
  if (unsafeSensitiveScalar.test(value)) {
    for (const candidate of sensitiveCanonicalCandidates(value)) {
      if (redactCanonicalSensitiveText(candidate, replacement) !== candidate) return replacement;
    }
  }
  return redactCanonicalSensitiveText(value, replacement);
};
