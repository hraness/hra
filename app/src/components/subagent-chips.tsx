import { useId, useMemo, useState, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { subagentChips, type SubagentChipInput } from "../model/session-view";

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
    <div className="flex flex-col gap-1 px-3 pb-2">
      <div
        aria-label={`Subagents of ${sessionTitle}`}
        className="flex flex-wrap items-center gap-1"
        role="group"
      >
        {chips.map((chip) => (
          <button
            aria-controls={open?.agentId === chip.agentId ? detailId : undefined}
            aria-expanded={open?.agentId === chip.agentId}
            className={cn(
              "inline-flex min-h-11 max-w-full items-center rounded-full border px-2.5",
              "text-xs font-medium",
              open?.agentId === chip.agentId
                ? "border-accent text-accent"
                : "border-line text-ink-muted hover:text-ink",
            )}
            key={chip.agentId}
            onClick={() => {
              setOpenAgentId((current) => (current === chip.agentId ? null : chip.agentId));
            }}
            title={`${chip.label} — ${chip.detail}`}
            type="button"
          >
            <span className="truncate">{chip.label}</span>
          </button>
        ))}
        {overflow > 0 ? (
          <span
            className="inline-flex min-h-11 items-center rounded-full border border-line px-2.5 text-xs font-medium text-ink-muted"
            title={`${String(overflow)} more running subagent${overflow === 1 ? "" : "s"}`}
          >
            {`+${String(overflow)}`}
          </span>
        ) : null}
      </div>
      {open === null ? null : (
        <p className="text-xs text-ink-muted" id={detailId}>
          {`${open.label}: ${open.detail}`}
        </p>
      )}
    </div>
  );
}
