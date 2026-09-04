import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import {
  sessionStateLabel,
  sessionStateTone,
  type SessionTone,
} from "../model/session-view";
import type { SessionStateValue } from "../hra/cloud";

const dotClasses: Readonly<Record<SessionTone, string>> = {
  accent: "bg-accent",
  attention: "bg-attention",
  danger: "bg-danger",
  neutral: "bg-ink-muted",
};

const textClasses: Readonly<Record<SessionTone, string>> = {
  accent: "text-accent",
  attention: "text-attention",
  danger: "text-danger",
  neutral: "text-ink-muted",
};

export type StateIndicatorProps = Readonly<{
  className?: string;
  state: SessionStateValue;
}>;

/**
 * The state indicator: a small dot plus its label.
 *
 * Colour alone never carries the state, because the three attention states and
 * the two quiet ones would be indistinguishable to a reader who cannot separate
 * them. The label is always rendered.
 */
export function StateIndicator({ className, state }: StateIndicatorProps): ReactNode {
  const tone = sessionStateTone[state];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", textClasses[tone], className)}>
      <span
        aria-hidden="true"
        className={cn("inline-block h-2 w-2 shrink-0 rounded-full", dotClasses[tone])}
      />
      {sessionStateLabel[state]}
    </span>
  );
}
