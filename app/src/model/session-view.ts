/**
 * View-model derivations for the grid and the session screen.
 *
 * Everything here is a pure function over projection-derived values: no React,
 * no document, no Convex. The screens keep only layout and effects, so the
 * ordering ladder, the composer target rule, and the interaction affordance
 * table are all provable under `bun test ./app`.
 */
import type {
  CompactInteractionDecision,
  CompactInteractionKind,
  CompactInteractionQuestion,
  SessionStateValue,
} from "../hra/cloud";

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

export type InteractionAffordance = Readonly<{
  /** The questions this device may answer, in provider order. */
  answerable: readonly CompactInteractionQuestion[];
  /** The decision buttons this device may show, in display order. */
  decisions: readonly CompactInteractionDecision[];
  /** Questions that are shown but never given an input here. */
  locked: readonly CompactInteractionQuestion[];
  /** Why anything is withheld, for the "resolve on the machine" note. */
  reasons: readonly string[];
}>;

const decisionOrder: readonly CompactInteractionDecision[] = ["once", "decline"];

const orderedDecisions = (
  offered: readonly CompactInteractionDecision[],
  allowed: readonly CompactInteractionDecision[],
): readonly CompactInteractionDecision[] =>
  decisionOrder.filter((decision) =>
    offered.includes(decision) && allowed.includes(decision));

/**
 * What a browser may offer for a pending interaction.
 *
 * This is the mirror of `verifyRemoteInteraction` in
 * `src/cloud/daemon-adapters.ts`: a button appears only where the daemon would
 * accept the decision, so a reader is never offered an action that comes back
 * as a refusal code. The rules, and the projection field each one reads:
 *
 * - `command_approval` accepts `once` and `decline` from the provider's own
 *   `availableDecisions`, and `once` only while a `commandClass` is present:
 *   the daemon recomputes that class at apply time and refuses without one
 *   (`INTERACTION_COMMAND_CLASS_UNVERIFIED`).
 * - `file_change_approval` offers only a refusal. The pinned provider callback
 *   exposes no diff and no affected paths, so nothing this device could have
 *   read would justify accepting
 *   (`INTERACTION_FILE_CHANGE_ACCEPT_NOT_REMOTE`).
 * - `permission_approval` accepts `once` and `decline` only while a
 *   `commandClass` is present, which the daemon emits only when every
 *   requested category is recognisably workspace-local. A network, MCP, or
 *   unrecognised category carries no class and no button
 *   (`INTERACTION_PERMISSION_CLASS_UNVERIFIED`). The exact requested values
 *   never enter the projection either way.
 * - `user_input` and `mcp_elicitation` are answered by the provider's exact
 *   question ids, which the projection now carries. A question marked `secret`
 *   is listed so the reader knows what is being asked and is given no input:
 *   the daemon refuses a secret answer outright
 *   (`INTERACTION_SECRET_ANSWER_REFUSED`).
 *
 * An interaction projected by an older daemon carries none of these fields. It
 * gets no buttons and the note instead, which is the same answer this function
 * gives for anything the daemon would refuse.
 */
export function interactionAffordance(
  interaction: Readonly<{
    availableDecisions: readonly CompactInteractionDecision[] | null;
    commandClass: string | null;
    interactionKind: CompactInteractionKind;
    questions: readonly CompactInteractionQuestion[] | null;
  }>,
): InteractionAffordance {
  const offered = interaction.availableDecisions ?? [];
  const questions = interaction.questions ?? [];
  const answerable = questions.filter((question) => !question.secret);
  const locked = questions.filter((question) => question.secret);
  const reasons: string[] = [];
  switch (interaction.interactionKind) {
    case "command_approval": {
      const decisions = orderedDecisions(
        offered,
        interaction.commandClass === null ? ["decline"] : ["once", "decline"],
      );
      if (interaction.commandClass === null) {
        reasons.push("Approving needs the command class, which this projection does not carry.");
      }
      if (decisions.length === 0) {
        reasons.push("This request offers no decision that can be taken from here.");
      }
      return { answerable: [], decisions, locked: [], reasons };
    }
    case "file_change_approval": {
      const decisions = orderedDecisions(offered, ["decline"]);
      reasons.push("Approving a file change needs the exact diff, which stays on the machine.");
      return { answerable: [], decisions, locked: [], reasons };
    }
    case "permission_approval": {
      const decisions = interaction.commandClass === null
        ? []
        : orderedDecisions(offered, ["once", "decline"]);
      if (interaction.commandClass === null) {
        reasons.push("This permission request asks for a category outside the workspace, so it is decided on the machine.");
      }
      return { answerable: [], decisions, locked: [], reasons };
    }
    case "user_input": {
      // The daemon requires an answer for every question the provider asked,
      // so one secret question makes the whole set local: a partial answer
      // would be refused and a complete one would carry the protected value.
      const offerable = locked.length === 0 ? answerable : [];
      if (offerable.length === 0) {
        reasons.push("This question is answered on the machine running the session.");
      }
      if (locked.length > 0) {
        reasons.push(locked.length === 1
          ? "One answer is protected, so the whole question is answered there."
          : `${String(locked.length)} answers are protected, so the whole question is answered there.`);
      }
      return { answerable: offerable, decisions: [], locked, reasons };
    }
    case "mcp_elicitation": {
      // An MCP form leaves out the values it cannot carry: an optional field
      // may go unanswered, so the text fields are still offered.
      if (answerable.length === 0) {
        reasons.push("This MCP form is completed on the machine running the session.");
      }
      return { answerable, decisions: [], locked, reasons };
    }
  }
}

/** Whether this device can resolve the interaction at all. */
export function interactionIsLocalOnly(affordance: InteractionAffordance): boolean {
  return affordance.decisions.length === 0 && affordance.answerable.length === 0;
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
