import * as stylex from "@stylexjs/stylex";
import { useId, useMemo, useState, type ReactNode } from "react";

import { subagentChips, type SubagentChipInput } from "../model/session-view";
import { subagentChipStyles } from "./subagent-chips.stylex";

export type SubagentChipsProps = Readonly<{
  /** The card this row belongs to, so two cards never share a chip's open state. */
  sessionTitle: string;
  subagents: readonly SubagentChipInput[];
}>;

/**
 * The card's running subagents.
 *
 * Up to three named chips and then a `+N` for the rest, from the projected
 * `subagent_activity` membership. A session with no running subagent renders
 * nothing at all: an empty row would take height from a grid that is mostly
 * sessions with no subagents.
 *
 * Hover shows the role and depth through the title attribute; touch has no
 * hover, so a tap opens the same line under the row. The chip is a button for
 * exactly that reason, and it never navigates.
 */
export function SubagentChips({ sessionTitle, subagents }: SubagentChipsProps): ReactNode {
  const { chips, overflow } = useMemo(() => subagentChips(subagents), [subagents]);
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const detailId = useId();

  if (chips.length === 0) return null;

  const open = chips.find((chip) => chip.agentId === openAgentId) ?? null;

  return (
    <div {...stylex.props(subagentChipStyles.root)}>
      <div
        aria-label={`Subagents of ${sessionTitle}`}
        {...stylex.props(subagentChipStyles.group)}
        role="group"
      >
        {chips.map((chip) => (
          <button
            aria-controls={open?.agentId === chip.agentId ? detailId : undefined}
            aria-expanded={open?.agentId === chip.agentId}
            {...stylex.props(
              subagentChipStyles.chip,
              open?.agentId === chip.agentId
                ? subagentChipStyles.open
                : [subagentChipStyles.closed, subagentChipStyles.closedInteractive],
            )}
            key={chip.agentId}
            onClick={() => {
              setOpenAgentId((current) => (current === chip.agentId ? null : chip.agentId));
            }}
            title={`${chip.label} — ${chip.detail}`}
            type="button"
          >
            <span {...stylex.props(subagentChipStyles.truncate)}>{chip.label}</span>
          </button>
        ))}
        {overflow > 0 ? (
          <span
            {...stylex.props(subagentChipStyles.chip, subagentChipStyles.closed)}
            title={`${String(overflow)} more running subagent${overflow === 1 ? "" : "s"}`}
          >
            {`+${String(overflow)}`}
          </span>
        ) : null}
      </div>
      {open === null ? null : (
        <p {...stylex.props(subagentChipStyles.detail)} id={detailId}>
          {`${open.label}: ${open.detail}`}
        </p>
      )}
    </div>
  );
}
