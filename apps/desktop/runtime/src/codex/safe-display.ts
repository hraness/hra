export const MAX_CODEX_FACT_DISPLAY_TEXT_UTF8_BYTES = 2 * 1_024 * 1_024;

export interface BoundedCodexDisplayText {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Produces the only prose representation admitted to owned session facts.
 * It replaces terminal control characters and applies a UTF-8 byte bound
 * before the value can enter retained state or a renderer-facing adapter.
 */
export function boundedCodexDisplayText(
  value: string,
  maxUtf8Bytes = MAX_CODEX_FACT_DISPLAY_TEXT_UTF8_BYTES,
): BoundedCodexDisplayText {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new Error("The Codex display-text budget must be a non-negative safe integer.");
  }
  const characters: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const character of value) {
    const safe = forbiddenDisplayControl(character) ? "�" : character;
    const nextBytes = utf8BytesForCodePoint(safe.codePointAt(0) ?? 0);
    if (bytes + nextBytes > maxUtf8Bytes) {
      truncated = true;
      break;
    }
    characters.push(safe);
    bytes += nextBytes;
  }
  return Object.freeze({
    text: characters.join(""),
    truncated,
  });
}

function forbiddenDisplayControl(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (
    (codePoint <= 31 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13) ||
    codePoint === 127
  );
}

function utf8BytesForCodePoint(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}
