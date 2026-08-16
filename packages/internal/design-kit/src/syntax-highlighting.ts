import { highlight } from "sugar-high";

export const syntaxLanguages = [
  "css",
  "html",
  "json",
  "markdown",
  "shell",
  "text",
  "typescript",
] as const;

export type SyntaxLanguage = (typeof syntaxLanguages)[number];

export interface HighlightedCode {
  readonly className: `syntax-code language-${SyntaxLanguage}`;
  readonly html: string;
  readonly language: SyntaxLanguage;
}

type SyntaxToken =
  | "command"
  | "comment"
  | "flag"
  | "heading"
  | "inline"
  | "keyword"
  | "marker"
  | "operator"
  | "string"
  | "variable";

const shellKeywords = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);

const shellKeywordsFollowedByCommand = new Set([
  "do",
  "elif",
  "if",
  "then",
  "until",
  "while",
]);

function languageToken(input: string): string {
  const tokens = input.trim().toLowerCase().split(/\s+/u);
  const languageClass = tokens.find((token) => token.startsWith("language-"));
  return (languageClass ?? tokens[0] ?? "").replace(/^language-/u, "");
}

/**
 * Parses Markdown info strings and DOM class names from an untrusted boundary
 * into the finite language set supported by the design kit.
 */
export function resolveSyntaxLanguage(input: unknown): SyntaxLanguage {
  if (typeof input !== "string") return "text";

  switch (languageToken(input)) {
    case "css":
      return "css";
    case "htm":
    case "html":
    case "xml":
      return "html";
    case "json":
    case "jsonc":
      return "json";
    case "markdown":
    case "md":
    case "mdx":
      return "markdown";
    case "bash":
    case "console":
    case "sh":
    case "shell":
    case "zsh":
      return "shell";
    case "javascript":
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "typescript":
      return "typescript";
    case "plaintext":
    case "text":
    case "txt":
    default:
      return "text";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}

function tokenHtml(kind: SyntaxToken, html: string): string {
  return `<span class="syntax-token syntax-token--${kind}">${html}</span>`;
}

function token(kind: SyntaxToken, value: string): string {
  return tokenHtml(kind, escapeHtml(value));
}

function highlightMarkdownInline(value: string): string {
  let html = "";
  let cursor = 0;

  for (const match of value.matchAll(/`[^`\n]+`/gu)) {
    const index = match.index;
    const inlineCode = match[0];
    html += escapeHtml(value.slice(cursor, index));
    html += token("inline", inlineCode);
    cursor = index + inlineCode.length;
  }

  return html + escapeHtml(value.slice(cursor));
}

function highlightMarkdownLine(line: string): string {
  const fence = /^(\s*)(`{3,}|~{3,})(.*)$/u.exec(line);
  if (fence !== null) {
    return `${escapeHtml(fence[1] ?? "")}${token("marker", fence[2] ?? "")}${token("keyword", fence[3] ?? "")}`;
  }

  const heading = /^(\s*)(#{1,6})(\s+)(.*)$/u.exec(line);
  if (heading !== null) {
    return `${escapeHtml(heading[1] ?? "")}${token("marker", heading[2] ?? "")}${escapeHtml(heading[3] ?? "")}${tokenHtml("heading", highlightMarkdownInline(heading[4] ?? ""))}`;
  }

  const listItem = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/u.exec(line);
  if (listItem !== null) {
    return `${escapeHtml(listItem[1] ?? "")}${token("marker", listItem[2] ?? "")}${escapeHtml(listItem[3] ?? "")}${highlightMarkdownInline(listItem[4] ?? "")}`;
  }

  const quote = /^(\s*)(>)(\s?)(.*)$/u.exec(line);
  if (quote !== null) {
    return `${escapeHtml(quote[1] ?? "")}${token("marker", quote[2] ?? "")}${escapeHtml(quote[3] ?? "")}${highlightMarkdownInline(quote[4] ?? "")}`;
  }

  return highlightMarkdownInline(line);
}

function highlightMarkdown(value: string): string {
  return value.split("\n").map(highlightMarkdownLine).join("\n");
}

function isShellOperator(character: string): boolean {
  return character === "&"
    || character === "("
    || character === ")"
    || character === ";"
    || character === "<"
    || character === ">"
    || character === "|";
}

function isShellWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function isEscaped(line: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function highlightShellLine(line: string): string {
  let cursor = 0;
  let expectsCommand = true;
  let html = "";

  while (cursor < line.length) {
    const character = line[cursor] ?? "";

    if (isShellWhitespace(character)) {
      html += escapeHtml(character);
      cursor += 1;
      continue;
    }

    if (character === "#") {
      html += token("comment", line.slice(cursor));
      break;
    }

    if (character === "'" || character === '"') {
      const quote = character;
      let end = cursor + 1;
      while (end < line.length) {
        const next = line[end] ?? "";
        end += 1;
        if (next === quote && (quote === "'" || !isEscaped(line, end - 1))) break;
      }
      html += token("string", line.slice(cursor, end));
      cursor = end;
      expectsCommand = false;
      continue;
    }

    if (character === "$") {
      const variable = /^\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[?$!#*@0-9-])/u.exec(
        line.slice(cursor),
      )?.[0] ?? "$";
      html += token("variable", variable);
      cursor += variable.length;
      expectsCommand = false;
      continue;
    }

    if (isShellOperator(character)) {
      const pair = line.slice(cursor, cursor + 2);
      const operator = pair === "&&" || pair === "||" || pair === ">>" || pair === "<<"
        ? pair
        : character;
      html += token("operator", operator);
      cursor += operator.length;
      expectsCommand = operator === ";" || operator === "&&" || operator === "||" || operator === "|";
      continue;
    }

    let end = cursor + 1;
    while (end < line.length) {
      const next = line[end] ?? "";
      if (
        isShellWhitespace(next)
        || isShellOperator(next)
        || next === "$"
        || next === "'"
        || next === '"'
      ) {
        break;
      }
      end += 1;
    }

    const word = line.slice(cursor, end);
    if (shellKeywords.has(word)) {
      html += token("keyword", word);
      expectsCommand = shellKeywordsFollowedByCommand.has(word);
    } else if (word.startsWith("-")) {
      html += token("flag", word);
      expectsCommand = false;
    } else if (expectsCommand && !word.includes("=")) {
      html += token("command", word);
      expectsCommand = false;
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
      html += token("variable", word);
    } else {
      html += escapeHtml(word);
      expectsCommand = false;
    }
    cursor = end;
  }

  return html;
}

function highlightShell(value: string): string {
  return value.split("\n").map(highlightShellLine).join("\n");
}

export function highlightCode(
  code: string,
  language: SyntaxLanguage,
): HighlightedCode {
  const html = language === "text"
    ? escapeHtml(code)
    : language === "markdown"
      ? highlightMarkdown(code)
      : language === "shell"
        ? highlightShell(code)
        : highlight(code);

  return Object.freeze({
    className: `syntax-code language-${language}`,
    html,
    language,
  });
}
