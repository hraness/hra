import * as stylex from "@stylexjs/stylex";
import { useId, useMemo, useState, type ReactNode } from "react";

import { ChevronIcon, ScheduleIcon } from "./icons";
import { Badge } from "./ui/badge";
import { useServerNow } from "../data/devices";
import { useDeviceRegistries } from "../data/registry";
import { sessionScheduledTasks } from "../model/scheduled-tasks";
import { scheduledTaskStyles } from "./scheduled-tasks-badge.stylex";

export type ScheduledTasksBadgeProps = Readonly<{ sessionPublicId: string }>;

/**
 * The session's scheduled tasks, above the transcript.
 *
 * Read only, and read only in the strong sense: the schedules are projected
 * into each machine's device registry by the daemon that owns them, this badge
 * decrypts nothing of its own, and there is no control here that creates,
 * edits, or deletes one. A reader who wants to change a schedule does it in the
 * session, on the machine.
 *
 * A session with no schedule renders nothing, so the transcript keeps its full
 * height on the common case.
 */
export function ScheduledTasksBadge({ sessionPublicId }: ScheduledTasksBadgeProps): ReactNode {
  const registries = useDeviceRegistries();
  const now = useServerNow();
  const [open, setOpen] = useState(false);
  const panelId = useId();

  const view = useMemo(
    () => sessionScheduledTasks(registries.machines, sessionPublicId, now),
    [now, registries.machines, sessionPublicId],
  );

  if (view.rows.length === 0) return null;

  return (
    <div {...stylex.props(scheduledTaskStyles.root)}>
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        {...stylex.props(scheduledTaskStyles.trigger)}
        onClick={() => { setOpen((current) => !current); }}
        type="button"
      >
        <ScheduleIcon />
        <span>{view.badgeLabel}</span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div {...stylex.props(scheduledTaskStyles.panel)} id={panelId}>
          <p {...stylex.props(scheduledTaskStyles.quiet)}>
            Read only. Create, edit, and delete a schedule in the session on its machine.
          </p>
          {view.rows.map((task) => (
            <div {...stylex.props(scheduledTaskStyles.row)} key={`${task.machineLabel}:${task.id}`}>
              <div {...stylex.props(scheduledTaskStyles.rowHeader)}>
                <span {...stylex.props(scheduledTaskStyles.label)}>{task.label}</span>
                <Badge tone="neutral">{task.kindLabel}</Badge>
              </div>
              <span {...stylex.props(scheduledTaskStyles.quiet)}>{task.line}</span>
              <span {...stylex.props(scheduledTaskStyles.quiet)}>{task.machineLabel}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
