/**
 * View-model derivations for the grid and the session screen.
 *
 * Everything here is a pure function over projection-derived values: no React,
 * no document, no Convex. The screens keep only layout and effects, so the
 * ordering ladder, the composer target rule, and the interaction affordance
 * table are all provable under `bun test ./app`.
 */
import type { CompactInteractionKind, SessionStateValue } from "../hra/cloud";

export type SessionTone = "neutral" | "accent" | "attention" | "danger";

export const sessionStateLabel: Readonly<Record<SessionStateValue, string>> = Object.freeze({
  aborted: "Aborted",
  done: "Done",
  done_caveats: "Done, caveats",
  done_followups: "Done, follow ups",
  needs_action: "Needs you",
  needs_answer: "Needs an answer",
  needs_approval: "Needs approval",
  working: "Working",
});

export const sessionStateTone: Readonly<Record<SessionStateValue, SessionTone>> = Object.freeze({
  aborted: "danger",
  done: "neutral",
  done_caveats: "danger",
  done_followups: "neutral",
  needs_action: "attention",
  needs_answer: "attention",
  needs_approval: "attention",
  working: "accent",
});

/**
 * One card's ordering facts. The grid cannot read them from the session head,
 * because the head carries no session state, so each card reports its own
 * folded summary upward and the grid orders what it has been told.
 */
export type SessionCardSummary = Readonly<{
  archived: boolean;
  attention: boolean;
  lastActivityAt: number;
  /**
   * The head revision the archived flag and the name were read from. The grid
   * discards a summary whose revision the head has moved past, so a rename or
   * an unarchive from another device re-mounts the card instead of leaving a
   * stale one hidden.
   */
  metadataRevision: number;
  publicId: string;
  state: SessionStateValue;
  title: string;
}>;

/**
 * The ordering ladder: cards that want a human first, then cards that are
 * working, then everything else. Inside a group the most recent activity wins,
 * with the public id as the final tie break so the order never depends on the
 * arrival order of two equal timestamps. Archived sessions leave the grid; they
 * come back from the settings screen.
 */
export function orderSessionCards(
  summaries: readonly SessionCardSummary[],
): readonly SessionCardSummary[] {
  const rank = (summary: SessionCardSummary): number => {
    if (summary.attention) return 0;
    return summary.state === "working" ? 1 : 2;
  };
  return [...summaries]
    .filter((summary) => !summary.archived)
    .sort((left, right) => {
      const byRank = rank(left) - rank(right);
      if (byRank !== 0) return byRank;
      const byActivity = right.lastActivityAt - left.lastActivityAt;
      if (byActivity !== 0) return byActivity;
      return left.publicId < right.publicId ? -1 : left.publicId > right.publicId ? 1 : 0;
    });
}

const idleStates = new Set<SessionStateValue>([
  "done",
  "done_followups",
  "done_caveats",
  "aborted",
]);

export function isIdleSession(state: SessionStateValue): boolean {
  return idleStates.has(state);
}

/**
 * Where the grid composer steers.
 *
 * With no session selected the composer starts a new one through the
 * `session_start` device command instead; this resolves the target only for the
 * steering half. `summaries` is expected in the grid's own display order, which
 * already puts the freshest first inside each group, so the fallback re-sorts
 * by activity rather than trusting it.
 */
export function resolveComposerTarget(
  summaries: readonly SessionCardSummary[],
  selectedPublicId: string | null,
): SessionCardSummary | null {
  const visible = summaries.filter((summary) => !summary.archived);
  const selected = selectedPublicId === null
    ? undefined
    : visible.find((summary) => summary.publicId === selectedPublicId);
  if (selected !== undefined && isIdleSession(selected.state)) return selected;
  const byActivity = [...visible].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  return byActivity[0] ?? null;
}

export const interactionKindLabel: Readonly<Record<CompactInteractionKind, string>> =
  Object.freeze({
    command_approval: "Command approval",
    file_change_approval: "File change approval",
    mcp_elicitation: "MCP form",
    permission_approval: "Permission request",
    user_input: "Question",
  });

export type InteractionAffordance =
  /** Approve at `once` scope and decline are both offered. */
  | Readonly<{ kind: "approve_or_decline" }>
  /** Only a refusal is accepted remotely. */
  | Readonly<{ kind: "decline_only" }>
  /** A free-text answer, which the daemon keys by the provider's question ids. */
  | Readonly<{ kind: "answers" }>
  /** Nothing this device may resolve: the reader goes to the machine. */
  | Readonly<{ kind: "local_only" }>;

/**
 * What a browser may offer for a pending interaction.
 *
 * The daemon verifies every remote decision before applying it, and its rules
 * are narrower than the command payload union, so the buttons are derived from
 * what will actually be accepted rather than from what can be encoded:
 *
 * - `command_approval` accepts `once`, `decline`, and `cancel` remotely,
 *   subject to the provider's own `availableDecisions`, which the compact
 *   projection does not carry. An unavailable decision comes back as a failed
 *   command with a result code rather than a silent no-op.
 * - `file_change_approval` accepts a remote decision, but the local resolver
 *   refuses `once` and `session` for it because the pinned provider callback
 *   exposes no affected paths or diff. Only a refusal is offered.
 * - `permission_approval` is refused remotely outright
 *   (`INTERACTION_DECISION_NOT_REMOTE`): granting a permission needs the exact
 *   requested permission values, which never enter the projection.
 * - `user_input` is answerable remotely, but only with the provider's exact
 *   question ids, and the compact `interaction_state` event carries a fixed
 *   per-kind summary with no question list. Until the projection carries the
 *   questions, the answer field is shown disabled with the reason.
 * - `mcp_elicitation` is form input against an MCP server and stays local.
 *
 * Secret questions are refused by the daemon
 * (`INTERACTION_SECRET_ANSWER_REFUSED`). The projection gives the browser no
 * way to tell a secret question from an ordinary one, which is the second
 * reason answers are offered for `user_input` alone and never for a form.
 */
export function interactionAffordance(kind: CompactInteractionKind): InteractionAffordance {
  switch (kind) {
    case "command_approval": return { kind: "approve_or_decline" };
    case "file_change_approval": return { kind: "decline_only" };
    case "user_input": return { kind: "answers" };
    case "permission_approval":
    case "mcp_elicitation": return { kind: "local_only" };
  }
}

/** Why an affordance is withheld, rendered next to the panel. */
export function interactionRestriction(kind: CompactInteractionKind): string | null {
  switch (kind) {
    case "command_approval": return null;
    case "file_change_approval":
      return "Approving a file change needs the exact diff, which stays on the machine.";
    case "permission_approval":
      return "Granting a permission needs the exact requested values, which never leave the machine.";
    case "user_input":
      return "Answering needs the provider's question identifiers, which this projection does not carry yet.";
    case "mcp_elicitation":
      return "MCP form input is completed on the machine.";
  }
}

/** The one-line `turn_summary` marker under a finished turn. */
export function turnSummaryLine(input: Readonly<{
  filesTouched: number;
  gitActions: readonly string[];
  runtimeMs: number;
}>): string {
  const parts: string[] = [];
  parts.push(input.filesTouched === 1 ? "1 file" : `${String(input.filesTouched)} files`);
  if (input.gitActions.length > 0) parts.push(input.gitActions.join(", "));
  parts.push(formatDuration(input.runtimeMs));
  return parts.join(" · ");
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/** A bounded, non-identifying label for a session with no name and no prompt. */
export function shortSessionLabel(publicId: string): string {
  return `Session ${publicId.slice(0, 8)}`;
}
