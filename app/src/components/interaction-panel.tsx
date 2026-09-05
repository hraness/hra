import { useEffect, useRef, useState, type ReactNode } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { useCommandState } from "../data/commands";
import {
  containsAbsolutePath,
  containsSecretShapedText,
  containsUnsafeTerminalScalar,
  isRecord,
  remoteInteractionAnswerLimits,
  remoteInteractionAnswersFitCommandEnvelope,
  remoteInteractionJsonFitsProviderLimit,
  snapshotForeignJson,
  type CompactRemoteInteractionQuestion,
  type RemoteCommandPayload,
} from "../hra/cloud";
import { StaticMarkdown } from "../markdown/markdown";
import {
  interactionAffordance,
  interactionIsLocalOnly,
  interactionKindLabel,
  interactionReasonCopy,
} from "../model/session-view";
import type { PendingInteraction } from "../model/session-model";

export type InteractionPanelProps = Readonly<{
  /** The command this exact interaction revision submitted, if any. */
  commandPublicId: string | null;
  interaction: PendingInteraction;
  onResolve: (payload: RemoteCommandPayload) => Promise<string | null>;
  submitting: boolean;
}>;

export type InteractionAnswerDraft = Readonly<{
  mode: "option";
  value: string;
}>;

export type InteractionAnswerDrafts = Readonly<Record<string, InteractionAnswerDraft>>;

type ResolveAnswers = Extract<RemoteCommandPayload, { readonly answers: unknown }>["answers"];

type DraftResult = Readonly<{
  include: boolean;
  valid: boolean;
  value: string;
}>;

/** The exact UTF-16 code-unit bound enforced by the local resolution schema. */
export const remoteInteractionAnswerCharacters = remoteInteractionAnswerLimits.codeUnits;

/** Terminal outcomes that prove this command did not apply the interaction. */
export function interactionCommandAllowsRetry(state: string | undefined): boolean {
  return state === "failed" || state === "cancelled" || state === "expired";
}

function answerValueIsRemoteSafe(value: string): boolean {
  return value.length <= remoteInteractionAnswerCharacters
    && !containsAbsolutePath(value)
    && !containsSecretShapedText(value)
    && !containsUnsafeTerminalScalar(value, true);
}

function questionDraftResult(
  question: unknown,
  draft: unknown,
): DraftResult {
  if (
    !isRecord(question)
    || question.kind !== "user_input"
    || question.allowsOther !== false
    || !Array.isArray(question.options)
    || question.options.length === 0
    || question.options.some((option) =>
      !isRecord(option) || typeof option.label !== "string")
  ) return { include: true, valid: false, value: "" };
  const optionLabels: readonly string[] = question.options.map((option) =>
    isRecord(option) && typeof option.label === "string" ? option.label : "");
  if (isRecord(draft) && draft.mode === "option" && typeof draft.value === "string") {
    return {
      include: true,
      valid: optionLabels.includes(draft.value)
        && answerValueIsRemoteSafe(draft.value),
      value: draft.value,
    };
  }
  return { include: true, valid: false, value: "" };
}

/**
 * Builds one exact closed-choice answer payload, or fails closed. Every
 * projected question must be present exactly once.
 */
export function buildInteractionAnswers(
  questions: readonly CompactRemoteInteractionQuestion[],
  drafts: InteractionAnswerDrafts,
): ResolveAnswers | null {
  const snapshot = snapshotForeignJson({ drafts, questions });
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !Array.isArray(snapshot.value.questions)
    || !isRecord(snapshot.value.drafts)
  ) return null;
  const capturedQuestions = snapshot.value.questions;
  const capturedDrafts = snapshot.value.drafts;
  const results: Array<Readonly<{ id: string; result: DraftResult }>> = [];
  for (const question of capturedQuestions) {
    if (!isRecord(question) || typeof question.id !== "string") return null;
    results.push({
      id: question.id,
      result: questionDraftResult(
        question,
        Object.hasOwn(capturedDrafts, question.id) ? capturedDrafts[question.id] : undefined,
      ),
    });
  }
  if (
    results.length === 0
    || new Set(results.map(({ id }) => id)).size !== results.length
    || results.some(({ result }) => !result.valid)
  ) return null;
  const entries: Array<readonly [string, Readonly<{ answers: readonly string[] }>]> = results
    .filter(({ result }) => result.include)
    .map(({ id, result }) => [id, { answers: [result.value] }]);
  // Object.fromEntries defines own data properties even for provider-owned
  // identifiers such as `__proto__`; assignment onto `{}` would invoke the
  // legacy prototype setter and silently lose that answer.
  const answers = Object.fromEntries(entries);
  return remoteInteractionJsonFitsProviderLimit(answers)
    && remoteInteractionAnswersFitCommandEnvelope(answers)
    ? answers
    : null;
}

/** Whether every exact projected answer contract is currently satisfied. */
export function interactionAnswersAreComplete(
  questions: readonly CompactRemoteInteractionQuestion[],
  drafts: InteractionAnswerDrafts,
): boolean {
  return buildInteractionAnswers(questions, drafts) !== null;
}

function useDeadlineClock(deadlineAt: number | null): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (deadlineAt === null) return;
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => {
      setRevision((current) => current + 1);
    }, Math.min(remaining, 2_147_483_647));
    return () => { window.clearTimeout(timer); };
  }, [deadlineAt, revision]);
  return revision;
}

function UserQuestion({
  disabled,
  draft,
  onChange,
  question,
}: Readonly<{
  disabled: boolean;
  draft: InteractionAnswerDraft | undefined;
  onChange: (draft: InteractionAnswerDraft) => void;
  question: Extract<CompactRemoteInteractionQuestion, { readonly kind: "user_input" }>;
}>): ReactNode {
  return (
    <fieldset className="flex flex-col gap-1 text-xs">
      <legend className="font-medium text-ink break-words">{question.header}</legend>
      <p className="text-ink-muted break-words">{question.question}</p>
      {question.options.map((option) => (
        <label
          className="flex min-h-11 items-start gap-2 rounded-md border border-line p-2"
          key={option.label}
        >
          <input
            checked={draft?.mode === "option" && draft.value === option.label}
            className="mt-1"
            disabled={disabled}
            name={`interaction-${question.id}`}
            onChange={() => { onChange({ mode: "option", value: option.label }); }}
            type="radio"
            value={option.label}
          />
          <span className="flex flex-col gap-0.5 break-words">
            <span>{option.label}</span>
            {option.description.length === 0 ? null : (
              <span className="text-ink-muted">{option.description}</span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * One pending interaction. Presentation text is sanitised before projection;
 * controls are derived exclusively from the nested compact v2 remote policy.
 */
export function InteractionPanel({
  commandPublicId,
  interaction,
  onResolve,
  submitting,
}: InteractionPanelProps): ReactNode {
  const [answers, setAnswers] = useState<InteractionAnswerDrafts>({});
  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);
  const command = useCommandState(commandPublicId);
  const deadlineAt = interaction.remotePolicy?.deadlineAt ?? null;
  useDeadlineClock(deadlineAt);

  useEffect(() => {
    setAnswers({});
    setSubmitted(false);
    submittedRef.current = false;
  }, [interaction.interactionId, interaction.revision]);

  useEffect(() => {
    if (!interactionCommandAllowsRetry(command?.state)) return;
    submittedRef.current = false;
    setSubmitted(false);
  }, [command?.state]);

  const affordance = interactionAffordance(interaction.remotePolicy);
  const disabled = submitting || submitted || command?.state === "pending";
  const complete = interactionAnswersAreComplete(affordance.questions, answers);

  const submitOnce = (payload: RemoteCommandPayload) => {
    if (disabled || submittedRef.current) return;
    submittedRef.current = true;
    setSubmitted(true);
    void onResolve(payload).then((commandId) => {
      if (commandId !== null) return;
      submittedRef.current = false;
      setSubmitted(false);
    }, () => {
      submittedRef.current = false;
      setSubmitted(false);
    });
  };

  const decline = () => {
    const current = interactionAffordance(interaction.remotePolicy);
    if (!current.actions.includes("decline")) return;
    submitOnce({
      decision: "decline",
      interactionId: interaction.interactionId,
      kind: "resolve_interaction",
      revision: interaction.revision,
    });
  };

  const answer = () => {
    const current = interactionAffordance(interaction.remotePolicy);
    if (!current.actions.includes("answer")) return;
    const payloadAnswers = buildInteractionAnswers(current.questions, answers);
    if (payloadAnswers === null) return;
    submitOnce({
      answers: payloadAnswers,
      interactionId: interaction.interactionId,
      kind: "resolve_interaction",
      revision: interaction.revision,
    });
  };

  const reachabilityLabel = affordance.reachability === "machine_only"
    ? "Machine only"
    : affordance.reachability === "remote_limited"
      ? "Remote actions limited"
      : "Remote actions available";

  return (
    <section
      aria-label="Pending interaction"
      className="rounded-md border border-attention bg-surface-raised p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="attention">
            {interaction.label ?? interactionKindLabel[interaction.interactionKind]}
          </Badge>
          <Badge tone={interactionIsLocalOnly(affordance) ? "neutral" : "accent"}>
            {reachabilityLabel}
          </Badge>
        </div>
        {interaction.blocking ? (
          <span className="text-xs text-ink-muted">Blocking the turn</span>
        ) : null}
      </div>
      <p className="mt-2 text-sm break-words">{interaction.headline ?? interaction.summary}</p>
      {interaction.detailMarkdown === null || interaction.detailMarkdown.length === 0 ? null : (
        <div className="mt-2 text-ink-muted">
          <StaticMarkdown text={interaction.detailMarkdown} />
        </div>
      )}

      {affordance.actions.includes("decline") ? (
          <div className="mt-3 flex gap-2">
            <Button disabled={disabled} onClick={decline} variant="secondary">
              Decline
            </Button>
          </div>
        ) : null}

      {!affordance.actions.includes("answer") ? null : (
        <div className="mt-3 flex flex-col gap-3">
          {affordance.questions.map((question) => (
            <UserQuestion
              disabled={disabled}
              draft={answers[question.id]}
              key={question.id}
              onChange={(draft) => {
                setAnswers((current) => ({ ...current, [question.id]: draft }));
              }}
              question={question}
            />
          ))}
          <div className="flex gap-2">
            <Button disabled={disabled || !complete} onClick={answer} type="button">Send</Button>
          </div>
        </div>
      )}

      {!interactionIsLocalOnly(affordance) && affordance.reasonCodes.length === 0 ? null : (
        <div className="mt-3 text-xs text-ink-muted">
          {interactionIsLocalOnly(affordance) ? (
            <p>Resolve this one on the machine running the session.</p>
          ) : null}
          {affordance.reasonCodes.map((reason) => (
            <p key={reason}>{interactionReasonCopy[reason]}</p>
          ))}
        </div>
      )}

      {command === null ? null : (
        <p className="mt-2 text-xs text-ink-muted" role="status">
          Decision {command.state}
          {command.resultCode === null ? "" : `: ${command.resultCode}`}.
        </p>
      )}
    </section>
  );
}
