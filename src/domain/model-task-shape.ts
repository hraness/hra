/*
 * Conservative task-shape classification for shadow model routing.
 *
 * This module is deliberately lexical and pure. It describes the shape of a
 * task; it does not select a provider, model, account, permission, or runtime.
 * Rules are ordered from fail-closed input handling through open-ended work,
 * then the narrow mechanical cases, and finally bounded authored work.
 */

import { z } from "zod";

export const MODEL_TASK_SHAPES = [
  "well_defined",
  "open_ended",
  "mechanical",
  "uncertain",
] as const;

export const modelTaskShapeSchema = z.enum(MODEL_TASK_SHAPES);
export type ModelTaskShape = z.infer<typeof modelTaskShapeSchema>;

export const MODEL_TASK_SHAPE_RULES = [
  "input_too_long",
  "input_empty",
  "input_unsupported_format",
  "classification_directive",
  "conflicting_requirements",
  "open_ended_unknown_cause",
  "open_ended_research",
  "open_ended_comparison",
  "open_ended_design",
  "open_ended_broad_scope",
  "open_ended_conditional_authorship",
  "mechanical_wait_only",
  "mechanical_monitor_only",
  "mechanical_command_only",
  "well_defined_scope_and_outcome",
  "default_uncertain",
] as const;

export const modelTaskShapeRuleSchema = z.enum(MODEL_TASK_SHAPE_RULES);
export type ModelTaskShapeRule = z.infer<typeof modelTaskShapeRuleSchema>;

export const MODEL_TASK_SHAPE_MAX_BYTES = 65_536;
export const MODEL_TASK_SHAPE_REASON_MAX_CHARACTERS = 96;

export const MODEL_TASK_SHAPE_REASONS = Object.freeze({
  classification_directive: "Task text attempts to direct model selection or classification.",
  conflicting_requirements: "Task text signals conflicting requirements or evidence.",
  default_uncertain: "Task lacks enough high-confidence lexical evidence.",
  input_empty: "No task text remained after normalization.",
  input_too_long: "Task text exceeds the local classifier limit.",
  input_unsupported_format: "Task text contains an unsupported control format.",
  mechanical_command_only: "Task only asks to run one exact command and report it.",
  mechanical_monitor_only: "Task only asks to monitor and report a named state.",
  mechanical_wait_only: "Task only asks to wait for a named state.",
  open_ended_broad_scope: "Task scope or outcome is materially broad.",
  open_ended_comparison: "Task asks for comparison or a choice among approaches.",
  open_ended_conditional_authorship: "Task adds conditional authorship after an observation.",
  open_ended_design: "Task asks for design, architecture, or planning.",
  open_ended_research: "Task asks for research, exploration, evaluation, or audit.",
  open_ended_unknown_cause: "Task asks for work whose cause is not established.",
  well_defined_scope_and_outcome: "Task names a bounded scope and a checkable outcome.",
} as const satisfies Readonly<Record<ModelTaskShapeRule, string>>);

export type ModelTaskShapeReason =
  (typeof MODEL_TASK_SHAPE_REASONS)[ModelTaskShapeRule];

export type ModelTaskShapeInput = Readonly<{
  taskText: string;
}>;

export type ModelTaskShapeClassification = Readonly<{
  shape: ModelTaskShape;
  matchedRule: ModelTaskShapeRule;
  reason: ModelTaskShapeReason;
}>;

type LiteralKind = "inline_code" | "quoted" | "url";

type TaskLiteral = Readonly<{
  kind: LiteralKind;
  value: string;
}>;

type PreparedTaskText = Readonly<{
  hasClassificationDirectiveLiteral: boolean;
  hasMixedReportedAndOperativeContext: boolean;
  hasUnsafeDetachedBlock: boolean;
  hasNestedInstruction: boolean;
  hasUnsafeProseLiteral: boolean;
  literals: readonly TaskLiteral[];
  requiredOutcomeText: string;
  scanText: string;
}>;

const UNICODE_FORMAT_CHARACTER = /\p{Cf}/u;
const DEFAULT_IGNORABLE_CODE_POINT = /\p{Default_Ignorable_Code_Point}/u;
const FENCED_CODE = /(?:```|~~~)[\s\S]*?(?:(?:```|~~~)|$)/gu;
const BLOCKQUOTE_LINE = /^[ \t]*>[^\n]*(?:\n|$)/gmu;
const INLINE_CODE = /`([^`\n]*)(?:`|$)/gu;
const URL_LITERAL = /https?:\/\/[^\s<>()]+/giu;
const DOUBLE_QUOTED_LITERAL = /"([^"\n]{1,2048})"/gu;
const SINGLE_QUOTED_LITERAL = /(^|[\s(])'([^'\n]{1,512})'(?=$|[\s).,;:])/gmu;
const DETACHED_BLOCK_PRESENT = /(?:```|~~~)|^[ \t]*>/mu;
const REPORTED_LITERAL_PRESENT = /`|https?:\/\/|"|(^|[\s(])'/imu;
const RESERVED_ROUTING_LITERAL = /^(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain|astra|fable|gpt(?:-\w+)?|luna|opus|sol|terra)$/iu;

const CLASSIFICATION_DIRECTIVES: readonly RegExp[] = [
  /\b(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain)\b/iu,
  /\b(?:astra|fable|gpt-\w+|luna|opus|sol|terra)\b/iu,
  /\b(?:ignore|override|disregard)\b.{0,80}\b(?:rules?|instructions?|classifier|classification)\b/iu,
  /\bclassif(?:y|ication)\b.{0,48}\b(?:as|is|to)\b.{0,24}\b(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain)\b/iu,
  /\b(?:output|return|choose|select)\b.{0,40}\b(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain)\b/iu,
  /\b(?:route|send|use)\b.{0,48}\b(?:astra|fable|gpt(?:-\w+)?|luna|opus|sol|terra)\b/iu,
  /\b(?:choose|pick|route|select|send|switch|use)\b.{0,64}\b(?:model|provider|profile|tier)\b/iu,
  /\b(?:another|cheap(?:er)?|different|fast(?:er)?|small(?:er)?|slow(?:er)?|strong(?:er)?|weak(?:er)?)\b.{0,16}\b(?:model|provider|profile|tier)\b/iu,
  /\b(?:assign|delegate)\b.{0,64}\b(?:model|provider|profile|tier)\b/iu,
  /\b(?:have|let)\b.{0,48}\b(?:model|provider|profile|tier)\b.{0,32}\b(?:do|handle|perform|take)\b/iu,
  /\b(?:task|request)\b.{0,32}\b(?:is|as)\b.{0,16}\b(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain)\b/iu,
  /\b(?:label|mark|tag)\b.{0,48}\b(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain)\b/iu,
  /\b(?:treat|regard)\b.{0,24}\bas\b.{0,16}\b(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain)\b/iu,
  /\b(?:well[_ -]?defined|open[_ -]?ended|mechanical|uncertain)\b.{0,24}\b(?:classification|label|request|task)\b/iu,
  /\b(?:model|provider)\b.{0,32}\b(?:astra|fable|gpt(?:-\w+)?|luna|opus|sol|terra)\b/iu,
  /\btrust\b.{0,24}\b(?:label|classification)\b/iu,
];

const CONFLICTING_REQUIREMENT_CUES: readonly RegExp[] = [
  /\b(?:conflicting|contradictory|incompatible)\b.{0,40}\b(?:evidence|outcomes?|requirements?)\b/iu,
  /\b(?:evidence|outcomes?|requirements?)\b.{0,40}\b(?:conflict|contradict|are incompatible)\b/iu,
  /\bfor the same (?:case|input|request)\b.{0,80}\b(?:both|and also)\b/iu,
  /\bmust return true\b.{0,96}\bmust return false\b/iu,
  /\bmust return false\b.{0,96}\bmust return true\b/iu,
  /\b(?:must|need to|needs to|should)\s+(?:accept\s+(?:and|but(?:\s+also)?)\s+reject|reject\s+(?:and|but(?:\s+also)?)\s+accept|enable\s+(?:and|but(?:\s+also)?)\s+disable|disable\s+(?:and|but(?:\s+also)?)\s+enable|include\s+(?:and|but(?:\s+also)?)\s+exclude|exclude\s+(?:and|but(?:\s+also)?)\s+include)\b/iu,
];

const UNKNOWN_CAUSE_CUES: readonly RegExp[] = [
  /\b(?:debug|diagnose|investigate)\b/iu,
  /\b(?:find|figure) out why\b/iu,
  /\bfind why\b/iu,
  /\broot[- ]cause\b/iu,
  /\bunknown cause\b/iu,
  /\bflaky\b/iu,
];

const RESEARCH_CUES: readonly RegExp[] = [
  /\b(?:audit|discover|evaluate|explore|research|survey)\b/iu,
  /\b(?:discovery|evaluation|exploration|research)\b/iu,
];

const COMPARISON_CUES: readonly RegExp[] = [
  /\bcompare\b/iu,
  /\btrade[- ]?offs?\b/iu,
  /\bchoose\b.{0,40}\b(?:among|between|best|which)\b/iu,
  /\brecommend\b.{0,40}\b(?:approach|best|which)\b/iu,
];

const DESIGN_CUES: readonly RegExp[] = [
  /\b(?:architect|design|redesign|rethink)\b/iu,
  /\b(?:architecture|implementation plan|technical plan)\b/iu,
];

const BROAD_SCOPE_CUES: readonly RegExp[] = [
  /\b(?:entire|whole)\b.{0,24}\b(?:application|codebase|repo|repository|system)\b/iu,
  /\b(?:all|every)\b.{0,24}\b(?:bugs?|issues?|problems?)\b/iu,
  /\bproduction[- ]read(?:iness|y)\b/iu,
  /\bwhatever (?:is )?(?:needed|necessary|wrong)\b/iu,
  /\bmake\b.{0,32}\b(?:better|faster|robust|safer|secure)\b/iu,
];

const CONDITIONAL_AUTHORSHIP_CUES: readonly RegExp[] = [
  /\b(?:check|monitor|run|watch)\b.{0,160}\b(?:and|then)\b.{0,48}\b(?:change|fix|handle|repair|resolve|update)\b.{0,64}\b(?:anything|failures?|problems?|what(?:ever)?|whatever)\b/iu,
];

const AUTHORSHIP_OR_JUDGMENT =
  /\b(?:add|alert|analy[sz]e|approve|cancel|change|choose|create|debug|decide|delete|deploy|design|edit|email|fix|implement|investigate|merge|message|modify|notif(?:y|ying)|remove|rename|repair|replace|resolve|rewrite|roll(?:ing)? back|rollback|send|set|start|stop|update|write)\b/iu;
const REPORT_SUFFIX =
  /\s+and\s+(?:report|return|show|tell me)(?:\s+(?:its?|the))?\s+(?:exit status|outcome|raw output|result|status|success or failure|terminal state)\s*[.!]?$/iu;
const AMBIGUOUS_AUTHORSHIP =
  /\b(?:could you|do not|don't|if|maybe|might|must not|never|should not|should we|unless|whether)\b/iu;
const MECHANICAL_TARGET =
  "(?:the\\s+)?(?:named\\s+)?(?:ci\\s+)?(?:build|deployment|job|queue|run|state|task)"
  + "(?:\\s+#?[A-Za-z0-9][\\w.-]{1,80})?";
const MECHANICAL_TERMINAL_STATE =
  "(?:complete[sd]?|finish(?:ed|es)?|fail(?:ed|s)?|reach(?:ed|es)?\\s+(?:a\\s+)?terminal\\s+state|succeed(?:ed|s)?)";
const MECHANICAL_WAIT = new RegExp(
  `^(?:please\\s+)?wait\\s+(?:for|until)\\s+${MECHANICAL_TARGET}`
  + `(?:\\s+(?:(?:to|until)\\s+)?${MECHANICAL_TERMINAL_STATE})?$`,
  "iu",
);
const MECHANICAL_MONITOR = new RegExp(
  `^(?:please\\s+)?(?:monitor|poll|watch)\\s+${MECHANICAL_TARGET}`
  + `(?:\\s+(?:until\\s+)?${MECHANICAL_TERMINAL_STATE})?$`,
  "iu",
);

const ACTION_CUE =
  /\b(?:add|change|correct|create|delete|edit|fix|implement|move|remove|rename|replace|set|update|wire|write)\b/iu;
const NAMED_SCOPE_CUES: readonly RegExp[] = [
  /\b(?:app|convex|docs|scripts|site|src|test|tests)\/[\w./-]{1,240}\b/iu,
  /\b[\w-]{1,120}\.(?:css|html|json|jsx|md|mjs|sql|ts|tsx|yaml|yml)\b/iu,
  /\b(?:class|command|component|endpoint|field|file|function|method|module|route|screen|symbol|table|test)\s+named\s+[A-Za-z_$][\w$./:#-]{1,160}\b/iu,
  /\b(?:class|command|component|endpoint|field|file|function|method|module|route|screen|symbol|table|test)\s+(?:[a-z_$][\w$]*[A-Z][\w$]*|[A-Z][A-Z0-9_]+|[A-Za-z$][\w$]*_[\w$]+)\b/u,
];
const CHECKABLE_OUTCOME_CUES: readonly RegExp[] = [
  /\bdone when\b/iu,
  /\b(?:expected|observable) (?:behavior|outcome|output|result)\b/iu,
  /\bverify by (?:checking|executing|running)\b/iu,
  /\b(?:run|execute)\s+(?:the\s+)?(?:[\w-]+\s+){0,2}(?:check|checks|lint|test|tests|typecheck)\b/iu,
  /\b(?:check|checks|test|tests)\s+(?:must|need to|needs to|should)\s+pass\b/iu,
  /\b(?:must|need to|needs to|should)\s+(?:accept|be|equal|pass|produce|reject|remain|return)\b/iu,
  /\b(?:accepts?|becomes?|equals?|produces?|rejects?|returns?)\b/iu,
  /\bfrom\b.{1,80}\bto\b/iu,
];

const firstCue = (cues: readonly RegExp[], text: string): boolean =>
  cues.some((cue) => cue.test(text));

const hasConflictingRequiredOutcomes = (text: string): boolean => {
  const normalizedValue = (rawValue: string): string => {
    const delimiter = rawValue.at(0);
    return (
      delimiter !== undefined
      && delimiter === rawValue.at(-1)
      && ["`", "\"", "'"].includes(delimiter)
        ? rawValue.slice(1, -1)
        : rawValue
    ).toLowerCase();
  };
  const outcomes = new Map<string, Set<string>>();
  for (const match of text.matchAll(
    /\b(?:must|need to|needs to|should)\s+(return|be|equal|produce)\s+(`[^`\n]{1,64}`|"[^"\n]{1,64}"|'[^'\n]{1,64}'|[A-Za-z0-9_.:/-]{1,64})/giu,
  )) {
    const operation = match[1]?.toLowerCase();
    const rawValue = match[2];
    if (operation === undefined || rawValue === undefined) continue;
    const value = normalizedValue(rawValue);
    const values = outcomes.get(operation) ?? new Set<string>();
    values.add(value);
    outcomes.set(operation, values);
    if (values.size > 1) return true;
  }
  for (const match of text.matchAll(
    /\b(?:must|need to|needs to|should)\s+(?:return|be|equal|produce)\s+(`[^`\n]{1,64}`|"[^"\n]{1,64}"|'[^'\n]{1,64}'|[A-Za-z0-9_.:/-]{1,64})\s+(?:and(?:\s+also)?|but(?:\s+also)?)\s+(`[^`\n]{1,64}`|"[^"\n]{1,64}"|'[^'\n]{1,64}'|[A-Za-z0-9_.:/-]{1,64})/giu,
  )) {
    const first = match[1];
    const second = match[2];
    if (
      first !== undefined
      && second !== undefined
      && normalizedValue(first) !== normalizedValue(second)
    ) return true;
  }
  return false;
};

const result = (
  shape: ModelTaskShape,
  matchedRule: ModelTaskShapeRule,
): ModelTaskShapeClassification => ({
  matchedRule,
  reason: MODEL_TASK_SHAPE_REASONS[matchedRule],
  shape,
});

const normalizedTaskText = (text: string): string => text
  .replace(/\r\n?/gu, "\n")
  .normalize("NFKC")
  .replace(/[\u2018\u2019]/gu, "'")
  .replace(/[\u201C\u201D]/gu, '"');

const containsDisallowedFormat = (text: string): boolean => {
  if (
    UNICODE_FORMAT_CHARACTER.test(text)
    || DEFAULT_IGNORABLE_CODE_POINT.test(text)
  ) return true;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (
      codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint === 0x7f
      || (codePoint >= 0x80 && codePoint <= 0x9f)
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) return true;
  }
  return false;
};

function prepareTaskText(text: string): PreparedTaskText {
  const literals: TaskLiteral[] = [];
  const detachedBlock = DETACHED_BLOCK_PRESENT.test(text);
  const hasReportedLiteral = detachedBlock || REPORTED_LITERAL_PRESENT.test(text);
  let scanText = text
    .replace(FENCED_CODE, " ")
    .replace(BLOCKQUOTE_LINE, " ");
  const requiredOutcomeText = scanText;

  scanText = scanText.replace(INLINE_CODE, (_match, value: string) => {
    if (value.length > 0) literals.push({ kind: "inline_code", value });
    return " ";
  });
  scanText = scanText.replace(URL_LITERAL, (value) => {
    literals.push({ kind: "url", value });
    return " ";
  });
  scanText = scanText.replace(DOUBLE_QUOTED_LITERAL, (_match, value: string) => {
    literals.push({ kind: "quoted", value });
    return " ";
  });
  scanText = scanText.replace(
    SINGLE_QUOTED_LITERAL,
    (_match, prefix: string, value: string) => {
      literals.push({ kind: "quoted", value });
      return prefix;
    },
  );

  const collapsed = scanText.replace(/\s+/gu, " ").trim();
  const safeReportedContext = /\b(?:add|document|include|record|update|write)\b.{0,48}\b(?:example|fixture|quote|reported text|sample|test)\b.{0,48}\b(?:contain|containing|document|show|that (?:contains|says))\b/iu
    .test(collapsed);
  const hasCommandContext = /\b(?:execute|run)\b|\bverify (?:using|with)\b/iu
    .test(collapsed);
  const hasSecondOperativeClause = /(?:[.;]|\bthen\b)\s*(?:and\s+)?(?:add|change|create|edit|implement|remove|replace|update|use)\b/iu
    .test(collapsed);
  const hasProseLiteral = literals.some((literal) => /\s/u.test(literal.value.trim()));
  return {
    // An exact routing token is unsafe even when another literal in the same
    // task is a documented example. Reported status is local to a literal,
    // never a blanket exemption for the rest of the request.
    hasClassificationDirectiveLiteral: literals.some((literal) =>
      RESERVED_ROUTING_LITERAL.test(literal.value.trim())),
    // The lexical classifier cannot reliably bind several literals or blocks
    // to separate clauses. A task that first establishes a reported example
    // and then adds another authored clause therefore fails closed.
    hasMixedReportedAndOperativeContext: safeReportedContext
      && hasSecondOperativeClause
      && (detachedBlock || hasProseLiteral),
    hasNestedInstruction: hasReportedLiteral && !safeReportedContext
      ? /\b(?:according to|as follows|block below|follow(?:ing)? instructions?|implement (?:the )?(?:following )?(?:request|task)|instructions? below|request below)\b/iu
        .test(collapsed)
      : false,
    hasUnsafeDetachedBlock: detachedBlock && !safeReportedContext,
    hasUnsafeProseLiteral: !safeReportedContext && literals.some((literal) => {
      const value = literal.value.trim();
      if (!/\s/u.test(value)) return false;
      return !(
        literal.kind === "inline_code"
        && hasCommandContext
        && isCommandLiteral(value)
      );
    }),
    literals,
    requiredOutcomeText,
    scanText: collapsed,
  };
}

const withoutReportSuffix = (text: string): string => text.replace(REPORT_SUFFIX, "").trim();

const hasNamedTarget = (prepared: PreparedTaskText): boolean => {
  if (prepared.literals.some((literal) => literal.value.trim().length > 0)) return true;
  return /\bnamed\s+(?:ci\s+)?(?:build|deployment|job|queue|run|state|task)\b/iu
    .test(prepared.scanText)
    || /\b(?:build|deployment|job|queue|run|task)\s+(?:number\s+)?#?[A-Za-z0-9][\w.-]{1,80}\b/iu
      .test(prepared.scanText);
};

const isMechanicalWait = (prepared: PreparedTaskText): boolean => {
  if (AUTHORSHIP_OR_JUDGMENT.test(prepared.scanText) || !hasNamedTarget(prepared)) return false;
  const core = withoutReportSuffix(prepared.scanText).replace(/[.!]$/u, "").trim();
  return MECHANICAL_WAIT.test(core)
    && !/[,;:]|\b(?:and|if|then|unless|when)\b/iu.test(core);
};

const isMechanicalMonitor = (prepared: PreparedTaskText): boolean => {
  if (AUTHORSHIP_OR_JUDGMENT.test(prepared.scanText) || !hasNamedTarget(prepared)) return false;
  const core = withoutReportSuffix(prepared.scanText).replace(/[.!]$/u, "").trim();
  return MECHANICAL_MONITOR.test(core)
    && !/[,;:]|\b(?:and|if|then|unless|when)\b/iu.test(core);
};

const isCommandLiteral = (value: string): boolean => {
  const command = value.trim();
  return command.length > 0
    && command.length <= 2_048
    && !/[\r\n]/u.test(command)
    && /^[A-Za-z0-9_./-]+(?:\s+.*)?$/u.test(command);
};

const isMechanicalCommand = (prepared: PreparedTaskText): boolean => {
  if (AUTHORSHIP_OR_JUDGMENT.test(prepared.scanText)) return false;
  const commands = prepared.literals.filter((literal) =>
    literal.kind === "inline_code" && isCommandLiteral(literal.value));
  if (commands.length !== 1 || prepared.literals.length !== 1) return false;
  const core = withoutReportSuffix(prepared.scanText).replace(/[.!]$/u, "").trim();
  return /^(?:please\s+)?(?:execute|run)(?:\s+(?:the\s+)?(?:following\s+)?command)?$/iu.test(core);
};

const isScopeLiteral = (literal: TaskLiteral): boolean => {
  const value = literal.value.trim();
  if (literal.kind === "url") return true;
  if (value.length === 0 || value.length > 256 || /\s/u.test(value)) return false;
  return /\//u.test(value)
    || /\.(?:css|html|json|jsx|md|mjs|sql|ts|tsx|yaml|yml)$/iu.test(value)
    || /^[A-Za-z_$][\w$]*(?:[.:#][A-Za-z_$][\w$-]*)+$/u.test(value)
    || /^[a-z_$][\w$]*[A-Z][\w$]*$/u.test(value)
    || /^[A-Z][A-Z0-9_]+$/u.test(value)
    || /^[A-Za-z$][\w$]*_[\w$]+$/u.test(value);
};

const hasNamedScope = (prepared: PreparedTaskText): boolean =>
  prepared.literals.some(isScopeLiteral)
  || firstCue(NAMED_SCOPE_CUES, prepared.scanText);

const hasCheckableOutcome = (prepared: PreparedTaskText): boolean =>
  firstCue(CHECKABLE_OUTCOME_CUES, prepared.scanText)
  || (
    /\bverify (?:using|with)\b/iu.test(prepared.scanText)
    && prepared.literals.some((literal) =>
      literal.kind === "inline_code"
      && /\s/u.test(literal.value.trim())
      && isCommandLiteral(literal.value))
  );

/** Classifies one bounded task without IO, provider calls, or runtime effects. */
export function classifyModelTaskShape(
  input: ModelTaskShapeInput,
): ModelTaskShapeClassification {
  if (new TextEncoder().encode(input.taskText).byteLength > MODEL_TASK_SHAPE_MAX_BYTES) {
    return result("uncertain", "input_too_long");
  }

  if (containsDisallowedFormat(input.taskText)) {
    return result("uncertain", "input_unsupported_format");
  }

  const normalized = normalizedTaskText(input.taskText);
  if (normalized.trim().length === 0) return result("uncertain", "input_empty");
  if (containsDisallowedFormat(normalized)) {
    return result("uncertain", "input_unsupported_format");
  }

  const prepared = prepareTaskText(normalized);
  if (
    firstCue(CLASSIFICATION_DIRECTIVES, prepared.scanText)
    || prepared.hasClassificationDirectiveLiteral
  ) {
    return result("uncertain", "classification_directive");
  }
  if (
    firstCue(CONFLICTING_REQUIREMENT_CUES, prepared.scanText)
    || hasConflictingRequiredOutcomes(prepared.requiredOutcomeText)
  ) {
    return result("open_ended", "conflicting_requirements");
  }
  if (firstCue(UNKNOWN_CAUSE_CUES, prepared.scanText)) {
    return result("open_ended", "open_ended_unknown_cause");
  }
  if (firstCue(RESEARCH_CUES, prepared.scanText)) {
    return result("open_ended", "open_ended_research");
  }
  if (firstCue(COMPARISON_CUES, prepared.scanText)) {
    return result("open_ended", "open_ended_comparison");
  }
  if (firstCue(DESIGN_CUES, prepared.scanText)) {
    return result("open_ended", "open_ended_design");
  }
  if (firstCue(BROAD_SCOPE_CUES, prepared.scanText)) {
    return result("open_ended", "open_ended_broad_scope");
  }
  if (firstCue(CONDITIONAL_AUTHORSHIP_CUES, prepared.scanText)) {
    return result("open_ended", "open_ended_conditional_authorship");
  }
  if (
    AMBIGUOUS_AUTHORSHIP.test(prepared.scanText)
    || /\?\s*$/u.test(prepared.scanText)
    || prepared.hasMixedReportedAndOperativeContext
    || prepared.hasNestedInstruction
    || prepared.hasUnsafeDetachedBlock
    || prepared.hasUnsafeProseLiteral
  ) return result("uncertain", "default_uncertain");
  if (isMechanicalWait(prepared)) return result("mechanical", "mechanical_wait_only");
  if (isMechanicalMonitor(prepared)) return result("mechanical", "mechanical_monitor_only");
  if (isMechanicalCommand(prepared)) return result("mechanical", "mechanical_command_only");
  if (
    ACTION_CUE.test(prepared.scanText)
    && hasNamedScope(prepared)
    && hasCheckableOutcome(prepared)
  ) {
    return result("well_defined", "well_defined_scope_and_outcome");
  }
  return result("uncertain", "default_uncertain");
}
