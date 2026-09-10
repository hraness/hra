import { stripVTControlCharacters } from "node:util";

import {
  redactCanonicalSensitiveText,
  sensitiveCredentialLabelSource,
  sensitiveHeaderLabelSource,
  sensitiveHorizontalWhitespaceSource,
  sensitiveQuotedKeyCloseSource,
} from "./domain/sensitive-text-patterns";

export {
  sensitiveCredentialLabelSource,
  sensitiveHeaderLabelSource,
  sensitiveHorizontalWhitespaceSource,
  sensitiveQuotedKeyCloseSource,
  unlabelledSecretPattern,
  unlabelledSecretPatterns,
} from "./domain/sensitive-text-patterns";

const unsafeSensitiveScalar = /(?:[\p{Cc}\p{Cf}\p{Cs}\p{M}]|\p{Default_Ignorable_Code_Point})/u;

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
