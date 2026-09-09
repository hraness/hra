import * as stylex from "@stylexjs/stylex";
import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { neutraliseText, safeHref, splitMarkdownBlocks } from "./sanitise";
import { markdownStyles } from "./markdown.stylex";

/**
 * The rendered markdown surface.
 *
 * Three layers keep projection text from becoming markup. `skipHtml` drops raw
 * HTML nodes rather than rendering them, and no raw-HTML rehype plugin exists in
 * this bundle to put them back. `urlTransform` refuses every href that is not an
 * absolute `https:` URL, and the anchor component checks again before it emits
 * one, so a plugin that bypassed the transform still cannot produce a live
 * `javascript:` link. Images never become an element: `img-src` names no origin,
 * so a remote image would be blocked anyway, and projection text is
 * attacker-influenced by construction, so the alt text is the rendering. The
 * only images this app renders are attachment thumbnails from bytes the tab
 * already holds, and those go through `components/attachment-chips.tsx`.
 *
 * Every element is styled through a class. The policy is `style-src 'self'`, so
 * a style attribute anywhere in this tree would be a silently broken page.
 */

const components: Components = {
  a({ children, href }) {
    const resolved = safeHref(href);
    if (resolved === null) {
      return <span {...stylex.props(markdownStyles.invalidLink)}>{children}</span>;
    }
    return (
      <a
        {...stylex.props(markdownStyles.link)}
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
      <blockquote {...stylex.props(markdownStyles.blockquote)}>
        {children}
      </blockquote>
    );
  },
  code({ children, className }) {
    const fenced = typeof className === "string" && className.startsWith("language-");
    return (
      <code
        {...stylex.props(fenced ? markdownStyles.codeBlock : markdownStyles.codeInline)}
      >
        {children}
      </code>
    );
  },
  em({ children }) {
    return <em {...stylex.props(markdownStyles.em)}>{children}</em>;
  },
  h1({ children }) {
    return <h3 {...stylex.props(markdownStyles.headingLarge)}>{children}</h3>;
  },
  h2({ children }) {
    return <h3 {...stylex.props(markdownStyles.headingSmall)}>{children}</h3>;
  },
  h3({ children }) {
    return <h4 {...stylex.props(markdownStyles.headingSmall)}>{children}</h4>;
  },
  h4({ children }) {
    return <h5 {...stylex.props(markdownStyles.headingSmall, markdownStyles.headingCompact)}>{children}</h5>;
  },
  h5({ children }) {
    return <h6 {...stylex.props(markdownStyles.headingSmall, markdownStyles.headingCompact)}>{children}</h6>;
  },
  h6({ children }) {
    return <h6 {...stylex.props(markdownStyles.headingSmall, markdownStyles.headingCompact)}>{children}</h6>;
  },
  hr() {
    return <hr {...stylex.props(markdownStyles.horizontalRule)} />;
  },
  // Projection text never resolves an image: the alt text is the whole
  // rendering. `img-src data: blob:` exists for attachment thumbnails, not for
  // this surface.
  img({ alt }) {
    const label = typeof alt === "string" && alt.length > 0 ? alt : "image";
    return <span {...stylex.props(markdownStyles.unavailableImage)}>[{label}]</span>;
  },
  li({ children }) {
    return <li {...stylex.props(markdownStyles.item)}>{children}</li>;
  },
  ol({ children }) {
    return <ol {...stylex.props(markdownStyles.list, markdownStyles.orderedList)}>{children}</ol>;
  },
  p({ children }) {
    return <p {...stylex.props(markdownStyles.paragraph)}>{children}</p>;
  },
  pre({ children }) {
    return (
      <pre {...stylex.props(markdownStyles.pre)}>
        {children}
      </pre>
    );
  },
  strong({ children }) {
    return <strong {...stylex.props(markdownStyles.strong)}>{children}</strong>;
  },
  table({ children }) {
    return (
      <div {...stylex.props(markdownStyles.tableWrapper)}>
        <table {...stylex.props(markdownStyles.table)}>{children}</table>
      </div>
    );
  },
  td({ children }) {
    return <td {...stylex.props(markdownStyles.tableCell)}>{children}</td>;
  },
  th({ children }) {
    return <th {...stylex.props(markdownStyles.tableHeader)}>{children}</th>;
  },
  ul({ children }) {
    return <ul {...stylex.props(markdownStyles.list, markdownStyles.unorderedList)}>{children}</ul>;
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
    <div {...stylex.props(markdownStyles.root)}>
      {blocks.map((block) => block.complete
        ? <CompletedBlock key={block.key} text={block.text} />
        : <Markdown key={block.key} text={block.text} />)}
    </div>
  );
}

/** Markdown that will not change again. */
export function StaticMarkdown({ text }: MarkdownProps): ReactNode {
  return (
    <div {...stylex.props(markdownStyles.root)}>
      <Markdown text={text} />
    </div>
  );
}
