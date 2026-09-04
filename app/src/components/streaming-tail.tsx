import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

import { streamingTailLines } from "../env";
import { streamingTail } from "../model/session-model";

/**
 * Reports whether an element is intersecting the viewport.
 *
 * A grid of live sessions is a grid of things that repaint every second. Cards
 * that scrolled away keep their subscription, because dropping and rebuilding it
 * on every scroll would cost more than it saves, but they stop slicing text and
 * stop writing to the DOM. Without `IntersectionObserver` the element counts as
 * visible, which is the correct fallback: the tail keeps updating.
 */
function useOnScreen(reference: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);

  useEffect(() => {
    const element = reference.current;
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry !== undefined) setOnScreen(entry.isIntersecting);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [reference]);

  return onScreen;
}

export type StreamingTailProps = Readonly<{
  label: string;
  text: string;
}>;

/**
 * The card's streaming tail: the last lines of the turn, monospace, following
 * the bottom as it grows, and frozen at its last rendered value while the card
 * is off screen.
 */
export function StreamingTail({ label, text }: StreamingTailProps): ReactNode {
  const container = useRef<HTMLPreElement>(null);
  const onScreen = useOnScreen(container);
  const [rendered, setRendered] = useState("");

  const tail = useMemo(
    () => onScreen ? streamingTail(text, streamingTailLines) : null,
    [onScreen, text],
  );

  useEffect(() => {
    if (tail !== null) setRendered(tail);
  }, [tail]);

  // Auto-follow: the reader watches the newest line, not the oldest.
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [rendered]);

  return (
    <pre
      aria-label={label}
      className="max-h-40 overflow-x-hidden overflow-y-auto border-t border-line px-3 py-2 font-mono text-xs leading-snug break-words whitespace-pre-wrap text-ink-muted"
      ref={container}
      role="log"
    >
      {rendered.length === 0 ? "No live output yet." : rendered}
    </pre>
  );
}
