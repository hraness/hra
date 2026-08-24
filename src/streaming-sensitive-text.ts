import {
  hasCanonicalSensitiveLabelEvidence,
  hasSensitiveObfuscatingScalar,
  redactCompleteSensitiveText,
  sensitiveCredentialLabelSource,
  sensitiveHeaderLabelSource,
  sensitiveHorizontalWhitespaceSource,
  sensitiveQuotedKeyCloseSource,
} from "./sensitive-text";

type SensitiveMode =
  | Readonly<{
      escaped: boolean;
      kind: "credential";
      quote: "'" | "\"" | "`" | null;
      structured: boolean;
      valueStarted: boolean;
  }>
  | Readonly<{ kind: "header" }>
  | Readonly<{
      escaped: boolean;
      kind: "path";
      quote: "'" | "\"" | "`" | null;
  }>
  | Readonly<{ kind: "pem" }>
  | Readonly<{ kind: "token" }>;

type SensitiveIntroducer = Readonly<{
  index: number;
  kind: SensitiveMode["kind"];
  length: number;
  quote?: "'" | "\"" | "`" | null;
  replacement: "[local-path]" | "[protected]";
}>;

type BoundedIncompleteSensitiveIntroducer = Readonly<{
  index: number;
  kind: "credential" | "header" | "path" | "token";
  length: number;
  replacement: "[local-path]" | "[protected]";
}>;

const streamingCarryCodeUnits = 128;
const tokenCodeUnit = /^[A-Za-z0-9._~+/=-]$/u;
const credentialCodeUnit = /^\S$/u;
const pathCodeUnit = /^[^\s"'`<>{}[\](),;]$/u;
const dangerousLiveScalar = /[\p{Cc}\p{Cs}]/u;
const hasUnexpectedLiveScalar = (value: string): boolean => {
  if (hasCanonicalSensitiveLabelEvidence(value)) return true;
  return Array.from(value).some((scalar) =>
    scalar !== "\r"
    && scalar !== "\n"
    && scalar !== "\t"
    && dangerousLiveScalar.test(scalar));
};
const authorizationSchemeSource = String.raw`(?:[Bb][Ee][Aa][Rr][Ee][Rr]|[Bb][Aa][Ss][Ii][Cc])`;
const authorizationValueStartSource = String.raw`[^\s,;]`;
const standaloneAuthorizationSchemePattern = new RegExp(
  String.raw`\b${authorizationSchemeSource}${sensitiveHorizontalWhitespaceSource}+(?=${authorizationValueStartSource})`,
  "u",
);
const secretIntroducerPatterns: readonly Readonly<{
  kind: SensitiveMode["kind"];
  pattern: RegExp;
}>[] = [
  { kind: "pem", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu },
  { kind: "token", pattern: /(?<![\p{L}\p{N}_])(?:sk|re)_[A-Za-z0-9_-]{8,}/iu },
  { kind: "token", pattern: /(?<![\p{L}\p{N}_])(?:sk|re)-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}/iu },
  { kind: "token", pattern: /(?<![\p{L}\p{N}_])(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/iu },
  { kind: "token", pattern: /(?<![\p{L}\p{N}_])xox[baprs]-[A-Za-z0-9-]{8,}/iu },
  { kind: "token", pattern: /(?<![A-Z0-9])AKIA[A-Z0-9]{12,}/u },
  { kind: "token", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}/u },
  { kind: "credential", pattern: standaloneAuthorizationSchemePattern },
  {
    kind: "header",
    pattern: new RegExp(`${sensitiveHeaderLabelSource}${sensitiveQuotedKeyCloseSource}${sensitiveHorizontalWhitespaceSource}*[:=]`, "iu"),
  },
  {
    kind: "credential",
    pattern: new RegExp(`${sensitiveCredentialLabelSource}${sensitiveQuotedKeyCloseSource}${sensitiveHorizontalWhitespaceSource}*[:=]`, "iu"),
  },
];

const absolutePathIntroducerPattern = /(^|[^\p{L}\p{N}_/\\])((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/)))/iu;
const repeatedSlashPathIntroducerPattern = /(^|[\s"'`<>{}[\](),;])(\/{2,})/u;
const incompleteJwtCandidatePattern = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+$/u;
const incompleteUncCandidatePattern = /(^|[^\p{L}\p{N}_/\\])(\\\\[^\\/\s"'`<>{}[\](),;]+)$/u;
const incompleteStandaloneCredentialPattern = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])((?:Bearer|Basic))${sensitiveHorizontalWhitespaceSource}+[A-Za-z0-9._~+/=-]*$`,
  "iu",
);
const incompleteHeaderIntroducerPattern = new RegExp(
  `${sensitiveHeaderLabelSource}${sensitiveQuotedKeyCloseSource}${sensitiveHorizontalWhitespaceSource}*$`,
  "iu",
);
const incompleteLabeledCredentialIntroducerPattern = new RegExp(
  `${sensitiveCredentialLabelSource}${sensitiveQuotedKeyCloseSource}${sensitiveHorizontalWhitespaceSource}*$`,
  "iu",
);

const enclosingPathQuote = (value: string): "'" | "\"" | "`" | null =>
  value === "'" || value === "\"" || value === "`" ? value : null;

const pathIntroducer = (value: string): SensitiveIntroducer | null => {
  const candidates = [absolutePathIntroducerPattern.exec(value), repeatedSlashPathIntroducerPattern.exec(value)];
  let earliest: SensitiveIntroducer | null = null;
  for (const match of candidates) {
    if (match?.index === undefined || match[1] === undefined || match[2] === undefined) continue;
    const found = {
      index: match.index + match[1].length,
      kind: "path" as const,
      length: match[2].length,
      quote: enclosingPathQuote(match[1]),
      replacement: "[local-path]" as const,
    };
    if (earliest === null || found.index < earliest.index) earliest = found;
  }
  return earliest;
};

const earliestSensitiveIntroducer = (value: string): SensitiveIntroducer | null => {
  let earliest = pathIntroducer(value);
  for (const candidate of secretIntroducerPatterns) {
    const match = candidate.pattern.exec(value);
    if (match?.index === undefined) continue;
    const found = {
      index: match.index,
      kind: candidate.kind,
      length: match[0].length,
      replacement: "[protected]" as const,
    };
    if (earliest === null || found.index < earliest.index) earliest = found;
  }
  return earliest;
};

const boundedIncompleteSensitiveIntroducer = (
  value: string,
): BoundedIncompleteSensitiveIntroducer | null => {
  const jwt = incompleteJwtCandidatePattern.exec(value);
  let earliest: BoundedIncompleteSensitiveIntroducer | null = jwt !== null
    && jwt[0].length >= streamingCarryCodeUnits
    ? {
        index: jwt.index,
        kind: "token",
        length: jwt[0].length,
        replacement: "[protected]",
      }
    : null;
  const unc = incompleteUncCandidatePattern.exec(value);
  if (unc !== null && unc[1] !== undefined && unc[2] !== undefined) {
    const found = {
      index: unc.index + unc[1].length,
      kind: "path" as const,
      length: unc[2].length,
      replacement: "[local-path]" as const,
    };
    if (
      found.length >= streamingCarryCodeUnits
      && (earliest === null || found.index < earliest.index)
    ) earliest = found;
  }
  const credential = incompleteStandaloneCredentialPattern.exec(value);
  if (
    credential !== null
    && credential[0].length >= streamingCarryCodeUnits
    && credential[1] !== undefined
  ) {
    const found = {
      index: credential.index,
      kind: "credential" as const,
      length: credential[1].length,
      replacement: "[protected]" as const,
    };
    if (earliest === null || found.index < earliest.index) earliest = found;
  }
  for (const candidate of [
    { kind: "header" as const, pattern: incompleteHeaderIntroducerPattern },
    { kind: "credential" as const, pattern: incompleteLabeledCredentialIntroducerPattern },
  ]) {
    const match = candidate.pattern.exec(value);
    if (match === null || match[0].length < streamingCarryCodeUnits) continue;
    const found = {
      index: match.index,
      kind: candidate.kind,
      length: match[0].length,
      replacement: "[protected]" as const,
    };
    if (earliest === null || found.index < earliest.index) earliest = found;
  }
  return earliest;
};

export class StreamingSensitiveRedactor {
  #buffer = "";
  #mode: SensitiveMode | null = null;
  #unsafeCandidate = false;
  #unsafeTail = false;

  push(value: string, final = false): string {
    if (this.#unsafeTail) {
      if (final) this.#unsafeTail = false;
      return "";
    }
    const combined = this.#buffer + value;
    const hasUnexpectedScalar = hasUnexpectedLiveScalar(combined);
    const hasObfuscatingScalar = hasSensitiveObfuscatingScalar(combined);
    if (hasUnexpectedScalar && this.#mode !== null) {
      this.#buffer = "";
      this.#mode = null;
      this.#unsafeCandidate = false;
      this.#unsafeTail = !final;
      return "[protected]";
    }
    this.#buffer += value;
    this.#unsafeCandidate ||= hasUnexpectedScalar;
    if (
      hasObfuscatingScalar
      && redactCompleteSensitiveText(this.#buffer, "[protected]") !== this.#buffer
    ) {
      this.#buffer = "";
      this.#mode = null;
      this.#unsafeCandidate = false;
      this.#unsafeTail = !final;
      return "[protected]";
    }
    let rendered = "";
    for (;;) {
      if (this.#mode?.kind === "pem") {
        const endStart = this.#buffer.search(/-----END/iu);
        if (endStart < 0) {
          this.#buffer = "";
          if (final) this.#mode = null;
          return rendered;
        }
        const end = this.#buffer.indexOf("-----", endStart + "-----END".length);
        if (end < 0) {
          this.#buffer = "";
          if (final) this.#mode = null;
          return rendered;
        }
        this.#buffer = this.#buffer.slice(end + 5);
        this.#mode = null;
        continue;
      }
      if (this.#mode?.kind === "token" || this.#mode?.kind === "credential") {
        let offset = 0;
        if (this.#mode.kind === "credential" && !this.#mode.valueStarted) {
          while (offset < this.#buffer.length && /[\s:=]/u.test(this.#buffer[offset] ?? "")) {
            offset += 1;
          }
          if (offset === this.#buffer.length) {
            this.#buffer = "";
            if (final) this.#mode = null;
            return rendered;
          }
          const candidateQuote = this.#buffer[offset];
          const quote = candidateQuote === "'" || candidateQuote === "\"" || candidateQuote === "`"
            ? candidateQuote
            : null;
          if (quote !== null) offset += 1;
          if (quote === null) {
            const candidate = this.#buffer.slice(offset);
            const scheme = /^(?:Bearer|Basic)[\p{Zs}\t]+/iu.exec(candidate);
            if (scheme !== null) {
              offset += scheme[0].length;
            } else if (!final && /^(?:B(?:a(?:s(?:i(?:c)?)?)?|e(?:a(?:r(?:e(?:r)?)?)?)?))$/iu.test(candidate)) {
              return rendered;
            }
          }
          this.#mode = {
            escaped: false,
            kind: "credential",
            quote,
            structured: quote === null
              && (candidateQuote === "{" || candidateQuote === "["),
            valueStarted: true,
          };
        }
        if (this.#mode.kind === "credential" && this.#mode.structured) {
          this.#buffer = "";
          if (final) this.#mode = null;
          return rendered;
        }
        if (this.#mode.kind === "credential" && this.#mode.quote !== null) {
          let escaped = this.#mode.escaped;
          while (offset < this.#buffer.length) {
            const codeUnit = this.#buffer[offset] ?? "";
            offset += 1;
            if (escaped) {
              escaped = false;
              continue;
            }
            if (codeUnit === "\\") {
              escaped = true;
              continue;
            }
            if (codeUnit === this.#mode.quote) {
              this.#buffer = this.#buffer.slice(offset);
              this.#mode = null;
              break;
            }
          }
          if (this.#mode !== null) {
            this.#buffer = "";
            if (final) this.#mode = null;
            else this.#mode = { ...this.#mode, escaped };
            return rendered;
          }
          continue;
        }
        const continuation = this.#mode.kind === "credential" ? credentialCodeUnit : tokenCodeUnit;
        while (offset < this.#buffer.length && continuation.test(this.#buffer[offset] ?? "")) {
          offset += 1;
        }
        this.#buffer = this.#buffer.slice(offset);
        if (this.#buffer.length === 0) {
          if (final) this.#mode = null;
          return rendered;
        }
        this.#mode = null;
        continue;
      }
      if (this.#mode?.kind === "header") {
        let offset = 0;
        while (offset < this.#buffer.length && !/[\r\n]/u.test(this.#buffer[offset] ?? "")) {
          offset += 1;
        }
        this.#buffer = this.#buffer.slice(offset);
        if (this.#buffer.length === 0) {
          if (final) this.#mode = null;
          return rendered;
        }
        this.#mode = null;
        continue;
      }
      if (this.#mode?.kind === "path") {
        let offset = 0;
        let escaped = this.#mode.escaped;
        if (this.#mode.quote !== null) {
          while (offset < this.#buffer.length) {
            const codeUnit = this.#buffer[offset] ?? "";
            offset += 1;
            if (escaped) {
              escaped = false;
              continue;
            }
            if (codeUnit === "\\") {
              escaped = true;
              continue;
            }
            if (codeUnit === this.#mode.quote) {
              this.#buffer = this.#buffer.slice(offset - 1);
              this.#mode = null;
              break;
            }
          }
          if (this.#mode !== null) {
            this.#buffer = "";
            if (final) this.#mode = null;
            else this.#mode = { ...this.#mode, escaped };
            return rendered;
          }
        } else {
          while (offset < this.#buffer.length) {
            const codeUnit = this.#buffer[offset] ?? "";
            if (escaped) {
              escaped = false;
              offset += 1;
              continue;
            }
            if (codeUnit === "\\") {
              escaped = true;
              offset += 1;
              continue;
            }
            if (!pathCodeUnit.test(codeUnit)) break;
            offset += 1;
          }
          this.#buffer = this.#buffer.slice(offset);
          if (this.#buffer.length > 0) this.#mode = null;
        }
        if (this.#mode !== null && this.#buffer.length === 0) {
          if (final) this.#mode = null;
          else this.#mode = { ...this.#mode, escaped };
          return rendered;
        }
        continue;
      }

      const introducer = earliestSensitiveIntroducer(this.#buffer);
      if (introducer !== null) {
        rendered += this.#buffer.slice(0, introducer.index);
        rendered += introducer.replacement;
        this.#buffer = this.#buffer.slice(introducer.index + introducer.length);
        this.#mode = introducer.kind === "credential"
          ? {
              escaped: false,
              kind: "credential",
              quote: null,
              structured: false,
              valueStarted: false,
            }
          : introducer.kind === "path"
            ? { escaped: false, kind: "path", quote: introducer.quote ?? null }
            : { kind: introducer.kind };
        continue;
      }
      const incompleteIntroducer = boundedIncompleteSensitiveIntroducer(this.#buffer);
      if (incompleteIntroducer !== null) {
        rendered += this.#buffer.slice(0, incompleteIntroducer.index);
        rendered += incompleteIntroducer.replacement;
        this.#buffer = this.#buffer.slice(incompleteIntroducer.index + incompleteIntroducer.length);
        this.#mode = incompleteIntroducer.kind === "credential"
          ? {
              escaped: false,
              kind: "credential",
              quote: null,
              structured: false,
              valueStarted: false,
            }
          : incompleteIntroducer.kind === "path"
            ? { escaped: false, kind: "path", quote: null }
            : { kind: incompleteIntroducer.kind };
        continue;
      }
      if (final) {
        rendered += redactCompleteSensitiveText(this.#buffer, "[protected]");
        this.#buffer = "";
        this.#unsafeCandidate = false;
        return rendered;
      }
      if (this.#buffer.length <= streamingCarryCodeUnits) return rendered;
      if (this.#unsafeCandidate) {
        this.#buffer = "";
        this.#unsafeCandidate = false;
        this.#unsafeTail = true;
        return `${rendered}[protected]`;
      }
      let emitThrough = this.#buffer.length - streamingCarryCodeUnits;
      const finalCodeUnit = this.#buffer.charCodeAt(emitThrough - 1);
      if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) emitThrough -= 1;
      rendered += this.#buffer.slice(0, emitThrough);
      this.#buffer = this.#buffer.slice(emitThrough);
      this.#unsafeCandidate = hasUnexpectedLiveScalar(this.#buffer);
      return rendered;
    }
  }
}
