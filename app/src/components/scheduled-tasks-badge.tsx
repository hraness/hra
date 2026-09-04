import { useId, useMemo, useState, type ReactNode } from "react";

import { ChevronIcon, ScheduleIcon } from "./icons";
import { Badge } from "./ui/badge";
import { useServerNow } from "../data/devices";
import { useDeviceRegistries } from "../data/registry";
import { sessionScheduledTasks } from "../model/scheduled-tasks";

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
    <div className="border-b border-line px-[max(1rem,env(safe-area-inset-left))] py-2">
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line px-3 text-xs text-ink-muted hover:text-ink"
        onClick={() => { setOpen((current) => !current); }}
        type="button"
      >
        <ScheduleIcon />
        <span>{view.badgeLabel}</span>
        <ChevronIcon open={open} />
      </button>
      {open ? (
        <div className="mt-2 flex flex-col gap-2 rounded-md border border-line p-3" id={panelId}>
          <p className="text-xs text-ink-muted">
            Read only. Create, edit, and delete a schedule in the session on its machine.
          </p>
          {view.rows.map((task) => (
            <div className="flex flex-col gap-1" key={`${task.machineLabel}:${task.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{task.label}</span>
                <Badge tone="neutral">{task.kindLabel}</Badge>
              </div>
              <span className="text-xs text-ink-muted">{task.line}</span>
              <span className="text-xs text-ink-muted">{task.machineLabel}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
