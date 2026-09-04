import { useState, type ReactNode } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useCommandState } from "../data/commands";
import type { RemoteCommandPayload } from "../hra/cloud";
import { StaticMarkdown } from "../markdown/markdown";
import {
  interactionAffordance,
  interactionIsLocalOnly,
  interactionKindLabel,
} from "../model/session-view";
import type { PendingInteraction } from "../model/session-model";

export type InteractionPanelProps = Readonly<{
  /** The command this panel last submitted, so its state can be shown. */
  commandPublicId: string | null;
  interaction: PendingInteraction;
  onResolve: (payload: RemoteCommandPayload) => void;
  submitting: boolean;
}>;

/**
 * The pending interaction panel, above the input.
 *
 * What it renders is the whole of what the projection carries: a headline, a
 * bounded markdown detail, the class an approval would be taken on, and the
 * provider's questions. The exact command text, the exact affected paths, the
 * exact requested permission values, and every value marked protected are not
 * in it and never will be, so the panel can only ever offer the decisions the
 * daemon will accept from a device that cannot see them. `interactionAffordance`
 * holds that table and explains each entry.
 *
 * The detail is provider-derived text: it goes through the same markdown
 * surface as the transcript, which drops raw HTML, refuses every non-`https`
 * URL, and neutralises bidirectional and zero-width scalars.
 */
export function InteractionPanel({
  commandPublicId,
  interaction,
  onResolve,
  submitting,
}: InteractionPanelProps): ReactNode {
  const [answers, setAnswers] = useState<Readonly<Record<string, string>>>({});
  const command = useCommandState(commandPublicId);
  const affordance = interactionAffordance(interaction);
  const disabled = submitting || command?.state === "pending";
  const answerable = affordance.answerable;
  const complete = answerable.every((question) => (answers[question.id] ?? "").length > 0);

  const decide = (decision: "once" | "decline") => {
    onResolve({
      decision,
      interactionId: interaction.interactionId,
      kind: "resolve_interaction",
      revision: interaction.revision,
    });
  };

  const answer = () => {
    onResolve({
      answers: Object.fromEntries(answerable.map((question) => [
        question.id,
        { answers: [answers[question.id] ?? ""] },
      ])),
      interactionId: interaction.interactionId,
      kind: "resolve_interaction",
      revision: interaction.revision,
    });
  };

  return (
    <section
      aria-label="Pending interaction"
      className="rounded-md border border-attention bg-surface-raised p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <Badge tone="attention">
          {interaction.label ?? interactionKindLabel[interaction.interactionKind]}
        </Badge>
        {interaction.blocking ? (
          <span className="text-xs text-ink-muted">Blocking the turn</span>
        ) : null}
      </div>
      <p className="mt-2 text-sm break-words">{interaction.headline ?? interaction.summary}</p>
      {interaction.commandClass === null ? null : (
        <p className="mt-1 text-xs text-ink-muted break-words">
          Class: <span className="font-mono">{interaction.commandClass}</span>
        </p>
      )}
      {interaction.detailMarkdown === null || interaction.detailMarkdown.length === 0 ? null : (
        <div className="mt-2 text-ink-muted">
          <StaticMarkdown text={interaction.detailMarkdown} />
        </div>
      )}

      {affordance.decisions.length === 0 ? null : (
        <div className="mt-3 flex gap-2">
          {affordance.decisions.includes("once") ? (
            <Button disabled={disabled} onClick={() => { decide("once"); }}>Approve</Button>
          ) : null}
          {affordance.decisions.includes("decline") ? (
            <Button disabled={disabled} onClick={() => { decide("decline"); }} variant="secondary">
              Decline
            </Button>
          ) : null}
        </div>
      )}

      {answerable.length === 0 ? null : (
        <div className="mt-3 flex flex-col gap-2">
          {answerable.map((question) => (
            <label className="flex flex-col gap-1 text-xs" key={question.id}>
              <span className="text-ink-muted break-words">{question.label}</span>
              <Input
                aria-label={question.label}
                disabled={disabled}
                onChange={(event) => {
                  const { value } = event.target;
                  setAnswers((current) => ({ ...current, [question.id]: value }));
                }}
                placeholder="Your answer"
                value={answers[question.id] ?? ""}
              />
            </label>
          ))}
          <div className="flex gap-2">
            <Button disabled={disabled || !complete} onClick={answer} type="button">Send</Button>
          </div>
        </div>
      )}

      {affordance.locked.map((question) => (
        <p className="mt-2 text-xs text-ink-muted break-words" key={question.id}>
          {question.label}: answered on the machine.
        </p>
      ))}

      {affordance.reasons.length === 0 ? null : (
        <div className="mt-3 text-xs text-ink-muted">
          {interactionIsLocalOnly(affordance) ? (
            <p>Resolve this one on the machine running the session.</p>
          ) : null}
          {affordance.reasons.map((reason) => <p key={reason}>{reason}</p>)}
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
