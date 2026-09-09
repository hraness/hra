import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { cn } from "../lib/cn";
import {
  sessionStateLabel,
  sessionStateTone,
  type SessionTone,
} from "../model/session-view";
import type { SessionStateValue } from "../hra/cloud";
import { stateIndicatorStyles } from "./state-indicator.stylex";

const toneStyles: Readonly<Record<SessionTone, StyleXStyles>> = {
  accent: stateIndicatorStyles.accent,
  attention: stateIndicatorStyles.attention,
  danger: stateIndicatorStyles.danger,
  neutral: stateIndicatorStyles.neutral,
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
  const presentation = stylex.props(stateIndicatorStyles.root, toneStyles[tone]);
  return (
    <span {...presentation} className={cn(presentation.className, className)}>
      <span
        aria-hidden="true"
        {...stylex.props(stateIndicatorStyles.dot, toneStyles[tone])}
      />
      {sessionStateLabel[state]}
    </span>
  );
}
