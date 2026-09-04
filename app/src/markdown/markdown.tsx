import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { neutraliseText, safeHref, splitMarkdownBlocks } from "./sanitise";

/**
 * The rendered markdown surface.
 *
 * Three layers keep projection text from becoming markup. `skipHtml` drops raw
 * HTML nodes rather than rendering them, and no raw-HTML rehype plugin exists in
 * this bundle to put them back. `urlTransform` refuses every href that is not an
 * absolute `https:` URL, and the anchor component checks again before it emits
 * one, so a plugin that bypassed the transform still cannot produce a live
 * `javascript:` link. Images never become an element: `img-src 'none'` would
 * block the request anyway, so the alt text is the rendering.
 *
 * Every element is styled through a class. The policy is `style-src 'self'`, so
 * a style attribute anywhere in this tree would be a silently broken page.
 */

const components: Components = {
  a({ children, href }) {
    const resolved = safeHref(href);
    if (resolved === null) {
      return <span className="text-ink-muted underline decoration-dotted">{children}</span>;
    }
    return (
      <a
        className="text-accent underline underline-offset-2"
        href={resolved}
        rel="noopener noreferrer"
        target="_blank"
      >
        {children}
      </a>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="my-2 border-l-2 border-line pl-3 text-ink-muted">
        {children}
      </blockquote>
    );
  },
  code({ children, className }) {
    const fenced = typeof className === "string" && className.startsWith("language-");
    return (
      <code
        className={fenced
          ? "font-mono text-xs"
          : "rounded bg-surface-input px-1 py-0.5 font-mono text-[0.9em]"}
      >
        {children}
      </code>
    );
  },
  em({ children }) {
    return <em className="italic">{children}</em>;
  },
  h1({ children }) {
    return <h3 className="mt-3 mb-1 text-base font-semibold first:mt-0">{children}</h3>;
  },
  h2({ children }) {
    return <h3 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h3>;
  },
  h3({ children }) {
    return <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0">{children}</h4>;
  },
  h4({ children }) {
    return <h5 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h5>;
  },
  h5({ children }) {
    return <h6 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h6>;
  },
  h6({ children }) {
    return <h6 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h6>;
  },
  hr() {
    return <hr className="my-3 border-line" />;
  },
  // `img-src 'none'`: the alt text is the whole rendering.
  img({ alt }) {
    const label = typeof alt === "string" && alt.length > 0 ? alt : "image";
    return <span className="text-ink-muted italic">[{label}]</span>;
  },
  li({ children }) {
    return <li className="my-0.5">{children}</li>;
  },
  ol({ children }) {
    return <ol className="my-2 list-decimal pl-5">{children}</ol>;
  },
  p({ children }) {
    return <p className="my-2 leading-relaxed break-words first:mt-0 last:mb-0">{children}</p>;
  },
  pre({ children }) {
    return (
      <pre className="my-2 overflow-x-auto rounded-md border border-line bg-surface p-2 text-xs">
        {children}
      </pre>
    );
  },
  strong({ children }) {
    return <strong className="font-semibold">{children}</strong>;
  },
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-xs">{children}</table>
      </div>
    );
  },
  td({ children }) {
    return <td className="border border-line px-2 py-1 align-top">{children}</td>;
  },
  th({ children }) {
    return <th className="border border-line px-2 py-1 text-left font-semibold">{children}</th>;
  },
  ul({ children }) {
    return <ul className="my-2 list-disc pl-5">{children}</ul>;
  },
};

const remarkPlugins = [remarkGfm];

function transformUrl(url: string): string {
  return safeHref(url) ?? "";
}

export type MarkdownProps = Readonly<{ text: string }>;

export function Markdown({ text }: MarkdownProps): ReactNode {
  return (
    <ReactMarkdown
      components={components}
      remarkPlugins={remarkPlugins}
      skipHtml
      urlTransform={transformUrl}
    >
      {neutraliseText(text)}
    </ReactMarkdown>
  );
}

/**
 * A completed block. Its text is frozen for the rest of the turn, so memoising
 * on the text prop means a streaming delta re-renders only the tail block
 * instead of re-parsing the whole message on every batch.
 */
const CompletedBlock = memo(function CompletedBlock({ text }: MarkdownProps): ReactNode {
  return <Markdown text={text} />;
});

/**
 * Markdown that is still arriving. Blocks are split on blank lines outside
 * fenced code, every block but the last is memoised, and the last one re-renders
 * as it grows.
 */
export function StreamingMarkdown({ text }: MarkdownProps): ReactNode {
  const blocks = splitMarkdownBlocks(text);
  return (
    <div className="text-sm">
      {blocks.map((block) => block.complete
        ? <CompletedBlock key={block.key} text={block.text} />
        : <Markdown key={block.key} text={block.text} />)}
    </div>
  );
}

/** Markdown that will not change again. */
export function StaticMarkdown({ text }: MarkdownProps): ReactNode {
  return (
    <div className="text-sm">
      <Markdown text={text} />
    </div>
  );
}
