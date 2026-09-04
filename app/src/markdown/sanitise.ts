/**
 * The markdown sanitiser layer.
 *
 * Everything rendered as markdown is decrypted projection text: it originates
 * in a provider transcript, a tool result, or a file the agent read, so it is
 * attacker-influenced by construction. Three rules apply before a renderer sees
 * it, and all three are pure functions so `bun test ./app` proves them without a
 * document:
 *
 * 1. Bidi and invisible characters are removed. A right-to-left override can
 *    make a rendered command read as its own reverse, and zero-width characters
 *    hide text inside an approval summary the reader is about to accept.
 * 2. A link resolves only when it is an absolute `https:` URL. Relative,
 *    `http:`, `javascript:`, `data:`, and `mailto:` hrefs all fail closed, which
 *    is also what the `default-src 'none'` policy would enforce a second time.
 * 3. Raw HTML never reaches the renderer's HTML path. The renderer is
 *    configured with `skipHtml`, and no `rehype-raw` style plugin exists in this
 *    bundle, so an embedded tag is text.
 *
 * Block splitting lives here too: streaming markdown is re-parsed on every
 * delta, so the completed blocks are cut off the front and memoised, and only
 * the growing tail is re-rendered.
 */

/**
 * Zero-width, bidi control, and invisible-operator code points.
 *
 * U+200B..U+200F zero width space, non-joiner, joiner, and the left-to-right
 * and right-to-left marks. U+202A..U+202E the legacy bidi embedding and
 * override controls. U+2060..U+2069 the word joiner, the invisible operators,
 * and the bidi isolates. U+FEFF the byte order mark.
 */
const invisibleCharacters = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu;

export function neutraliseText(text: string): string {
  return text.replace(invisibleCharacters, "");
}

/** The longest href this app will resolve. */
export const maximumHrefCharacters = 2_048;

/**
 * The only link scheme the app resolves. A rejected href renders as plain text,
 * never as an anchor with a dead or dangerous target.
 */
export function safeHref(href: string | null | undefined): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (trimmed.length === 0 || trimmed.length > maximumHrefCharacters) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return url.protocol === "https:" ? url.href : null;
}

export type MarkdownBlock = Readonly<{
  /**
   * True once a later block exists, which means this one can no longer grow and
   * may be memoised for the rest of the turn.
   */
  complete: boolean;
  key: string;
  text: string;
}>;

const fenceOpening = /^(`{3,}|~{3,})/u;

/**
 * Splits markdown into top-level blocks on blank lines, ignoring blank lines
 * inside a fenced code block so a half-streamed fence is never cut in two.
 */
export function splitMarkdownBlocks(text: string): readonly MarkdownBlock[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: Readonly<{ character: string; length: number }> | null = null;

  for (const line of text.split("\n")) {
    const opening = fenceOpening.exec(line.trimStart())?.[1];
    if (opening !== undefined) {
      const character = opening.slice(0, 1);
      if (fence === null) fence = { character, length: opening.length };
      else if (character === fence.character && opening.length >= fence.length) fence = null;
    }
    if (fence === null && line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));

  return blocks.map((value, index) => ({
    complete: index < blocks.length - 1,
    key: `block-${String(index)}`,
    text: value,
  }));
}
