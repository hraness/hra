/**
 * The session screen's scheduled-tasks badge.
 *
 * The daemon projects each machine's schedules into its device registry, and a
 * schedule that belongs to a session carries that session's public id. This
 * selects the ones for the session being read and formats them. It is display
 * only, in both directions: nothing here creates, edits, or deletes a schedule,
 * and the badge offers no control that would.
 *
 * Pure, so `bun test ./app` proves the selection and the wording without a
 * registry, a document, or an account key.
 */
import { formatRelativeTime } from "./relative-time";
import { allScheduledTasks, type MachineView, type ScheduledTaskView } from "./settings-view";

export type SessionScheduledTaskRow = ScheduledTaskView & Readonly<{
  /** The one line under the label: provider, cadence, and when it next runs. */
  line: string;
  nextRunLabel: string;
}>;

export type SessionScheduledTasksView = Readonly<{
  /** The badge face. Empty when there is nothing to show. */
  badgeLabel: string;
  rows: readonly SessionScheduledTaskRow[];
}>;

/** "not scheduled" is not the same as overdue: a task can exist with no next run. */
export function scheduledTaskNextRun(nextRunAt: number | null, now: number): string {
  return nextRunAt === null ? "not scheduled" : formatRelativeTime(nextRunAt, now);
}

export function scheduledTaskLine(task: ScheduledTaskView, now: number): string {
  return `${task.kindLabel} · ${task.cadence} · next run ${
    scheduledTaskNextRun(task.nextRunAt, now)
  }`;
}

export function scheduledTasksBadgeLabel(count: number): string {
  return count === 1 ? "1 scheduled task" : `${String(count)} scheduled tasks`;
}

/**
 * Every scheduled task associated with one session, soonest run first.
 *
 * The registries are read across every machine rather than only the session's
 * execution device: a session that moved machines keeps its public id, and a
 * schedule that names it is still its schedule. A machine whose registry has
 * not decrypted yet simply contributes nothing.
 */
export function sessionScheduledTasks(
  machines: readonly MachineView[],
  sessionPublicId: string | null,
  now: number,
): SessionScheduledTasksView {
  if (sessionPublicId === null || sessionPublicId.length === 0) {
    return { badgeLabel: "", rows: [] };
  }
  const rows = allScheduledTasks(machines)
    .filter((task) => task.sessionPublicId === sessionPublicId)
    .map((task) => ({
      ...task,
      line: scheduledTaskLine(task, now),
      nextRunLabel: scheduledTaskNextRun(task.nextRunAt, now),
    }));
  return {
    badgeLabel: rows.length === 0 ? "" : scheduledTasksBadgeLabel(rows.length),
    rows,
  };
}
