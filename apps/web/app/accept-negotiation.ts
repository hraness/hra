export const HTML_MEDIA_TYPE = "text/html" as const;
export const MARKDOWN_MEDIA_TYPE = "text/markdown" as const;
export const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8" as const;

export const PUBLIC_DOCUMENT_MEDIA_TYPES = [
  HTML_MEDIA_TYPE,
  MARKDOWN_MEDIA_TYPE,
] as const;

export type PublicDocumentMediaType =
  (typeof PUBLIC_DOCUMENT_MEDIA_TYPES)[number];

interface AcceptEntry {
  readonly position: number;
  readonly q: number;
  readonly specificity: number;
  readonly type: string;
}

function clampQuality(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function parseQuality(parameters: readonly string[]): number {
  for (const parameter of parameters) {
    const separator = parameter.indexOf("=");
    if (separator <= 0) continue;
    const name = parameter.slice(0, separator).trim().toLowerCase();
    if (name !== "q") continue;
    let raw = parameter.slice(separator + 1).trim();
    if (
      raw.length >= 2
      && (
        (raw.startsWith("\"") && raw.endsWith("\""))
        || (raw.startsWith("'") && raw.endsWith("'"))
      )
    ) {
      raw = raw.slice(1, -1);
    }
    return clampQuality(Number(raw));
  }
  return 1;
}

function specificityFor(type: string): number {
  if (type === "*/*") return 0;
  if (type.endsWith("/*")) return 1;
  return 2;
}

export function parseAcceptHeader(header: string): readonly AcceptEntry[] {
  const entries: AcceptEntry[] = [];
  for (const raw of header.split(",")) {
    const parts = raw.trim().split(";").map((part) => part.trim()).filter(
      (part) => part.length > 0,
    );
    const type = parts[0]?.toLowerCase();
    if (type === undefined || !type.includes("/")) continue;
    entries.push({
      position: entries.length,
      q: parseQuality(parts.slice(1)),
      specificity: specificityFor(type),
      type,
    });
  }
  return entries;
}

function matchesType(entry: AcceptEntry, candidate: string): boolean {
  if (entry.type === "*/*") return true;
  if (entry.type.endsWith("/*")) {
    return candidate.startsWith(entry.type.slice(0, -1));
  }
  return entry.type === candidate;
}

function matchingEntry(
  entries: readonly AcceptEntry[],
  candidate: string,
): AcceptEntry | null {
  let matched: AcceptEntry | null = null;
  for (const entry of entries) {
    if (!matchesType(entry, candidate)) continue;
    if (
      matched === null
      || entry.specificity > matched.specificity
      || (
        entry.specificity === matched.specificity
        && entry.position < matched.position
      )
    ) {
      matched = entry;
    }
  }
  return matched;
}

/**
 * Choose among HTML and Markdown using RFC 9110 quality, specificity, and
 * client order. A missing or empty Accept header is "no constraint" and
 * defaults to HTML. `null` means every produced type is absent or q=0.
 */
export function preferredPublicDocumentType(
  header: string | null,
): PublicDocumentMediaType | null {
  if (header === null || header.trim().length === 0) return HTML_MEDIA_TYPE;
  const entries = parseAcceptHeader(header);
  if (entries.length === 0) return HTML_MEDIA_TYPE;

  let bestType: PublicDocumentMediaType | null = null;
  let bestQ = -1;
  let bestPosition = Number.POSITIVE_INFINITY;

  for (const candidate of PUBLIC_DOCUMENT_MEDIA_TYPES) {
    const matched = matchingEntry(entries, candidate);
    if (matched === null || matched.q <= 0) continue;
    if (matched.q > bestQ || (matched.q === bestQ && matched.position < bestPosition)) {
      bestQ = matched.q;
      bestPosition = matched.position;
      bestType = candidate;
    }
  }

  return bestType;
}

export function appendVaryAccept(headers: Headers): void {
  const existing = headers.get("Vary");
  if (existing === null || existing.trim().length === 0) {
    headers.set("Vary", "Accept");
    return;
  }
  const tokens = existing.split(",").map((token) => token.trim().toLowerCase());
  if (!tokens.includes("accept")) {
    headers.set("Vary", `${existing}, Accept`);
  }
}

export const NOT_ACCEPTABLE_BODY = [
  "Not Acceptable",
  "",
  "This resource is available in:",
  "- text/html",
  "- text/markdown",
  "",
].join("\n");
