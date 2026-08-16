import { memo } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";

import type { ChatUtf8Tail } from "../../../../contracts/runtime";

const disabledControls = false;
const disallowedElements = ["img"] as const;
const linkSafety = { enabled: true } as const;

export interface MarkdownResponseProps {
  readonly content: ChatUtf8Tail;
  readonly streaming: boolean;
}

function MarkdownResponseView({ content, streaming }: MarkdownResponseProps) {
  if (content.tail.length === 0) return null;
  return (
    <div className="chat-markdown" data-streaming={streaming || undefined}>
      {content.truncatedPrefix ? (
        <p className="chat-markdown__truncation" role="note">
          Earlier response text was omitted to keep this pane fast.
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
    left.content.tail === right.content.tail &&
    left.content.totalUtf8Bytes === right.content.totalUtf8Bytes &&
    left.content.truncatedPrefix === right.content.truncatedPrefix,
);

MarkdownResponse.displayName = "MarkdownResponse";
