import { memo } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import type { ChatUtf8Tail } from "../../../../contracts/runtime";

const disabledControls = false;
const disallowedElements = ["img"] as const;

export function safeMarkdownUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const linkSafety = {
  enabled: true,
  onLinkCheck: (url: string) => safeMarkdownUrl(url) !== null,
} as const;

export interface MarkdownResponseProps {
  readonly content: ChatUtf8Tail;
  readonly streaming: boolean;
  readonly variant?: "reasoning" | "response";
}

function MarkdownResponseView({
  content,
  streaming,
  variant = "response",
}: MarkdownResponseProps) {
  if (content.tail.length === 0) return null;
  return (
    <div
      className="chat-markdown"
      data-markdown-kind={variant}
      data-streaming={streaming || undefined}
    >
      {content.truncatedPrefix ? (
        <p className="chat-markdown__truncation" role="note">
          {variant === "reasoning"
            ? "Earlier thinking was omitted to keep this pane fast."
            : "Earlier response text was omitted to keep this pane fast."}
        </p>
      ) : null}
      <Streamdown
        className="chat-markdown__content"
        controls={disabledControls}
        disallowedElements={disallowedElements}
        linkSafety={linkSafety}
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        skipHtml
        unwrapDisallowed
        urlTransform={(url) => safeMarkdownUrl(url)}
      >
        {content.tail}
      </Streamdown>
    </div>
  );
}

export const MarkdownResponse = memo(
  MarkdownResponseView,
  (left, right) =>
    left.streaming === right.streaming &&
    left.variant === right.variant &&
    left.content.tail === right.content.tail &&
    left.content.totalUtf8Bytes === right.content.totalUtf8Bytes &&
    left.content.truncatedPrefix === right.content.truncatedPrefix,
);

MarkdownResponse.displayName = "MarkdownResponse";
