/*
 * Session-state classification after an assistant turn.
 *
 * The classifier is pure and lexical. It decides who must act next and how
 * the turn ended, using the final assistant message plus a few protocol
 * facts. Ordering matters and is fixed by the HRA Web v1 plan: provider
 * status, then pending provider interactions, then human-action cues (a strong
 * subset over the whole message, the full list over the tail), then approval
 * cues over the tail demoted by denylist cues anywhere, then a trailing
 * question, then progress, failure, and follow-up cues.
 *
 * The one harmful misclassification is treating a turn that needs the human's
 * hands (a login, a code from email, a file) as a plain approval, because an
 * autoresponder would then fabricate consent. Human-action cues are therefore
 * evaluated before approval cues.
 */

import { z } from "zod";

export const SESSION_STATES = [
  "working",
  "needs_approval",
  "needs_answer",
  "needs_action",
  "done",
  "done_followups",
  "done_caveats",
  "aborted",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_STATE_RULES = [
  "provider_status",
  "pending_interaction",
  "human_action_cue",
  "denylist_cue",
  "approval_cue",
  "trailing_question",
  "progress_cue",
  "failure_cue",
  "followup_cue",
  "default_done",
] as const;

export type SessionStateRule = (typeof SESSION_STATE_RULES)[number];

export type PendingInteractionKind =
  | "command_approval"
  | "file_change_approval"
  | "permission_approval"
  | "user_input"
  | "mcp_elicitation";

export type SessionStateInput = Readonly<{
  finalAssistantText: string;
  providerTurnStatus: "completed" | "interrupted" | "failed";
  pendingInteraction?: Readonly<{
    kind: PendingInteractionKind;
    requiresUserInteraction?: boolean;
  }>;
  openSubagents?: number;
  armedMonitor?: boolean;
  autorespondWillAct?: boolean;
}>;

export type SessionStateClassification = Readonly<{
  state: SessionState;
  attention: boolean;
  reason: string;
  verbatimRequired: boolean;
  verbatimLiteral?: string;
  matchedRule: SessionStateRule;
}>;

export const SESSION_STATE_TAIL_CHARACTERS = 600;
export const SESSION_STATE_MAX_TEXT_CHARACTERS = 64_000;

/*
 * Cue lists. Each is an ordered array of regular expressions; the first match
 * names the reason. Patterns are case-insensitive and deliberately narrow:
 * every entry was checked against the mined corpus for false positives.
 */
export const HUMAN_ACTION_CUES: readonly RegExp[] = [
  /\bon your (?:phone|device|mobile)\b/iu,
  /\bin your (?:system )?browser\b/iu,
  /\bopen (?:telegram|whatsapp|signal|the app|chrome|safari|firefox)\b/iu,
  /\bscan (?:the |this )?qr\b/iu,
  /\breply (?:\*\*)?(?:done|ready|continue)(?:\*\*)?\b/iu,
  /\btell me when\b/iu,
  /\battach (?:the|a|your) \b/iu,
  /\bwhen (?:it|that|the (?:download|export|job)) (?:finishes|completes|is done),? (?:attach|reply|tell|send)\b/iu,
  /\b(?:log|sign) ?in\b(?![\s-]*(?:flow|page|token|state) (?:is|was|has))/iu,
  /\bverification code\b/iu,
  /\bone[- ]time code\b/iu,
  /\b2fa\b/iu,
  /\bpasskey\b/iu,
  /\bnpm (?:auth\w*|login)\b/iu,
  /\bE401\b/u,
  /\bsay ["“]?continue["”]?\b/iu,
  /\bwhen the (?:rate )?limit resets\b/iu,
  /\bpaste (?:the|your|it|that)\b/iu,
  /\byou(?:'ll| will| need to| have to) (?:log|sign) in\b/iu,
  /\brun (?:this|the following|that) (?:command )?(?:yourself|manually|in your terminal)\b/iu,
];

/*
 * The strong subset is checked over the whole message because these phrases
 * are almost never reported speech; the full list is checked over the tail.
 */
export const STRONG_HUMAN_ACTION_CUES: readonly RegExp[] = [
  /\bon your (?:phone|device|mobile)\b/iu,
  /\bscan (?:the |this )?qr\b/iu,
  /\breply (?:\*\*)?(?:done|ready|continue)(?:\*\*)?\b/iu,
  /\btell me when\b/iu,
  /\bverification code\b/iu,
  /\bone[- ]time code\b/iu,
  /\bpaste (?:the|your|it|that)\b/iu,
  /\bwhen the (?:rate )?limit resets\b/iu,
];

export const DENYLIST_CUES: readonly RegExp[] = [
  /\bcredit card\b/iu,
  /\bpayment\b/iu,
  /\bpassword\b/iu,
  /\bsecret key\b/iu,
  /\bapi key\b/iu,
  /\bdelete (?:the )?production\b/iu,
  /\bdrop (?:the )?(?:production )?(?:database|table)\b/iu,
  /\bsend (?:the |an )?(?:email|message|sms|text) to\b/iu,
  /\btransfer (?:the )?(?:funds|money|domain|ownership)\b/iu,
  /\bwire (?:the )?(?:funds|money)\b/iu,
  /\bforce[- ]push\b/iu,
];

export const APPROVAL_CUES: readonly RegExp[] = [
  /\bplease (?:explicitly )?(?:approve|authorize|authorise|confirm)\b/iu,
  /\bdo you (?:approve|authorize|authorise|want me to proceed)\b/iu,
  /\bshould i (?:proceed|go ahead|continue|run|apply|send|start)\b/iu,
  /\bshall i (?:proceed|go ahead|continue|run|apply|send|start)\b/iu,
  /\bsay the word\b/iu,
  /\bplease reply\b/iu,
  /\b(?:needs?|requires?|awaiting|waiting for) your (?:explicit )?(?:approval|authorization|authorisation|consent|go-ahead|sign-off)\b/iu,
  /\b(?:needs?|requires?) explicit (?:approval|authorization|authorisation) (?:to|before|from you)\b/iu,
  /\bawaiting your (?:approval|authorization|authorisation|go|go-ahead|sign-off)\b/iu,
  /\bexplicit approval to\b/iu,
  /\breply (?:with|exactly with|by pasting)\b/iu,
  /\bwant me to (?:proceed|go ahead|continue|run|apply|send|start)\b/iu,
  /\bready to (?:proceed|apply|run|send) (?:on|with|once|when) your (?:go|approval|confirmation|word)\b/iu,
];

export const QUESTION_TAIL = /\?\s*$/u;

export const PROGRESS_CUES: readonly RegExp[] = [
  /\bmonitoring (?:remains |is )?active\b/iu,
  /\bmonitoring continues\b/iu,
  /\bi(?:'ll| will) remind you\b/iu,
  /\bhourly (?:monitor|checks?)\b/iu,
  /\bstill (?:processing|pending|running|waiting)\b/iu,
  /\bi(?:'ll| will) (?:remind|check|continue|keep|report|synthesi[sz]e|follow up)\b/iu,
  /\bjob is running\b/iu,
  /\bin progress\b/iu,
  /\bno (?:[\w-]+ ){0,3}notification yet\b/iu,
  /\bremains active\b/iu,
  /\bwaiting (?:on|for) (?:the )?(?:remaining|other|background|sub)?\s?(?:agents?|jobs?|ci|run|workers?)\b/iu,
  /\bwatcher (?:is )?(?:armed|running|active)\b/iu,
];

export const FAILURE_CUES: readonly RegExp[] = [
  /(?:^|\n)\s*(?:no[- ]go\b|blocked\b|failed\b|could not\b|unable to\b)/iu,
  /\b(?:remains?|is|are) blocked\b/iu,
  /\bblocking findings?\b/iu,
  /\bnot (?:releasable|shippable|mergeable)\b/iu,
  /\bremaining blockers?\b/iu,
  /\bunresolved\b/iu,
  /\bthe only remaining\b/iu,
  /\bstill fails?\b/iu,
  /\bgated on\b/iu,
  /\bcould not (?:complete|finish|verify)\b/iu,
];

export const FOLLOWUP_CUES: readonly RegExp[] = [
  /\brecommend(?:ed|ation)?s?\b/iu,
  /\bnext steps?\b/iu,
  /\bsuggested\b/iu,
  /\bi can (?:also )?(?:prepare|do|start|draft|open|add|write)\b/iu,
  /\bfollow[- ]ups?\b/iu,
  /\bif you (?:want|'d like|would like)\b/iu,
  /\bconsider\b/iu,
  /\boptional(?:ly)?\b/iu,
];

const FENCED_CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~/gu;
const INLINE_CODE = /`[^`\n]*`/gu;
const BLOCKQUOTE_LINE = /^[ \t]*>[^\n]*$/gmu;
const BOLD_LITERAL = /\*\*([^*\n]{1,200})\*\*/gu;
const QUOTED_LITERAL = /["“]([^"”\n]{3,200})["”]/gu;

const firstMatch = (cues: readonly RegExp[], text: string): RegExp | null => {
  for (const cue of cues) {
    if (cue.test(text)) return cue;
  }
  return null;
};

const reasonFor = (cue: RegExp): string => cue.source.slice(0, 200);

type Prepared = Readonly<{
  stripped: string;
  tail: string;
  literals: readonly string[];
}>;

/*
 * Strip fenced code and blockquotes (their contents are reported speech or
 * artefacts, not the assistant's ask), record blockquoted and bold literals as
 * candidate verbatim strings, normalise curly quotes, and take the tail as the
 * last 600 characters of what remains.
 */
export function prepareAssistantText(text: string): Prepared {
  const normalized = text.replace(/[\u2018\u2019]/gu, "'").replace(/[\u201c\u201d]/gu, '"');
  const bounded = normalized.length > SESSION_STATE_MAX_TEXT_CHARACTERS
    ? normalized.slice(-SESSION_STATE_MAX_TEXT_CHARACTERS)
    : normalized;
  const literals: string[] = [];
  for (const line of bounded.match(BLOCKQUOTE_LINE) ?? []) {
    const literal = line.replace(/^[ \t]*>[ \t]?/u, "").trim();
    if (literal.length >= 3 && literal.length <= 200) literals.push(literal);
  }
  for (const match of bounded.matchAll(BOLD_LITERAL)) {
    const literal = match[1]?.trim();
    if (literal !== undefined && literal.length >= 3) literals.push(literal);
  }
  const stripped = bounded
    .replace(FENCED_CODE, " ")
    .replace(BLOCKQUOTE_LINE, " ")
    .replace(INLINE_CODE, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .trim();
  const tail = stripped.length > SESSION_STATE_TAIL_CHARACTERS
    ? stripped.slice(-SESSION_STATE_TAIL_CHARACTERS)
    : stripped;
  return { stripped, tail, literals };
}

/*
 * A verbatim literal is required when the approval ask names an exact string
 * to reply with: a blockquoted line, a bold span, or a quoted phrase next to a
 * "reply with" cue. The literal itself is returned so the daemon can check the
 * responder's output against it byte for byte.
 */
function findVerbatimLiteral(prepared: Prepared, rawText: string): string | undefined {
  const replyWith = /\breply (?:with|exactly with|by pasting)\b[^\n]{0,80}/iu.exec(prepared.tail);
  if (replyWith !== null) {
    const after = rawText.slice(rawText.lastIndexOf(replyWith[0].slice(0, 10)));
    const quoted = QUOTED_LITERAL.exec(after);
    QUOTED_LITERAL.lastIndex = 0;
    if (quoted?.[1] !== undefined) return quoted[1].trim();
  }
  const literal = prepared.literals.at(-1);
  if (literal !== undefined && /\b(?:approve|authorize|authorise|proceed|confirm|yes|go)\b/iu.test(literal)) {
    return literal;
  }
  return undefined;
}

export function classifySessionState(input: SessionStateInput): SessionStateClassification {
  const autorespondWillAct = input.autorespondWillAct ?? true;
  const prepared = prepareAssistantText(input.finalAssistantText);

  if (input.providerTurnStatus !== "completed") {
    return {
      state: "aborted",
      attention: false,
      reason: `provider turn ${input.providerTurnStatus}`,
      verbatimRequired: false,
      matchedRule: "provider_status",
    };
  }

  const pending = input.pendingInteraction;
  if (pending !== undefined) {
    const closed = pending.kind === "command_approval"
      || pending.kind === "file_change_approval"
      || pending.kind === "permission_approval";
    if (closed && pending.requiresUserInteraction !== true) {
      return {
        state: "needs_approval",
        attention: !autorespondWillAct,
        reason: `pending ${pending.kind}`,
        verbatimRequired: false,
        matchedRule: "pending_interaction",
      };
    }
    return {
      state: "needs_answer",
      attention: true,
      reason: `pending ${pending.kind}`,
      verbatimRequired: false,
      matchedRule: "pending_interaction",
    };
  }

  const humanAction = firstMatch(STRONG_HUMAN_ACTION_CUES, prepared.stripped)
    ?? firstMatch(HUMAN_ACTION_CUES, prepared.tail);
  if (humanAction !== null) {
    return {
      state: "needs_action",
      attention: true,
      reason: reasonFor(humanAction),
      verbatimRequired: false,
      matchedRule: "human_action_cue",
    };
  }

  const approval = firstMatch(APPROVAL_CUES, prepared.tail);
  if (approval !== null) {
    const denylisted = firstMatch(DENYLIST_CUES, prepared.stripped);
    if (denylisted !== null) {
      return {
        state: "needs_answer",
        attention: true,
        reason: reasonFor(denylisted),
        verbatimRequired: false,
        matchedRule: "denylist_cue",
      };
    }
    const literal = findVerbatimLiteral(prepared, input.finalAssistantText);
    return {
      state: "needs_approval",
      attention: !autorespondWillAct,
      reason: reasonFor(approval),
      verbatimRequired: literal !== undefined,
      ...(literal === undefined ? {} : { verbatimLiteral: literal }),
      matchedRule: "approval_cue",
    };
  }

  if (QUESTION_TAIL.test(prepared.stripped)) {
    return {
      state: "needs_answer",
      attention: true,
      reason: "trailing question",
      verbatimRequired: false,
      matchedRule: "trailing_question",
    };
  }

  const progress = firstMatch(PROGRESS_CUES, prepared.tail);
  if (progress !== null || (input.openSubagents ?? 0) > 0 || input.armedMonitor === true) {
    return {
      state: "working",
      attention: false,
      reason: progress === null
        ? ((input.openSubagents ?? 0) > 0 ? "open subagents" : "armed monitor")
        : reasonFor(progress),
      verbatimRequired: false,
      matchedRule: "progress_cue",
    };
  }

  const failure = firstMatch(FAILURE_CUES, prepared.tail);
  if (failure !== null) {
    return {
      state: "done_caveats",
      attention: false,
      reason: reasonFor(failure),
      verbatimRequired: false,
      matchedRule: "failure_cue",
    };
  }

  const followup = firstMatch(FOLLOWUP_CUES, prepared.tail);
  if (followup !== null) {
    return {
      state: "done_followups",
      attention: false,
      reason: reasonFor(followup),
      verbatimRequired: false,
      matchedRule: "followup_cue",
    };
  }

  return {
    state: "done",
    attention: false,
    reason: "no cue matched",
    verbatimRequired: false,
    matchedRule: "default_done",
  };
}

/*
 * Wire shape of `hra session state`: the durable latest classification for a
 * session, or `null` when no turn has been classified yet. Exposed through the
 * daemon and validated by the CLI before rendering.
 */
export const sessionStateReportSchema = z.object({
  version: z.literal(1),
  session: z.string().min(1).max(64),
  state: z.enum(SESSION_STATES).nullable(),
  attention: z.boolean(),
  reason: z.string().max(256),
  verbatimRequired: z.boolean(),
  lastActivityAt: z.number().int().nonnegative().nullable(),
  revision: z.number().int().nonnegative(),
}).strict();

export type SessionStateReport = z.infer<typeof sessionStateReportSchema>;

export const HUMAN_INPUT_STATES: ReadonlySet<SessionState> = new Set([
  "needs_approval",
  "needs_answer",
  "needs_action",
]);

export function requiresHumanInput(state: SessionState): boolean {
  return HUMAN_INPUT_STATES.has(state);
}
