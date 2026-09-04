import { useState, type ReactNode } from "react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { useCommandState } from "../data/commands";
import type { RemoteCommandPayload } from "../hra/cloud";
import {
  interactionAffordance,
  interactionKindLabel,
  interactionRestriction,
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
 * The summary is the whole of what the projection carries: the exact command
 * text, the affected paths, and the requested permission values are deliberately
 * not in it, so this panel can only ever offer the decisions the daemon will
 * accept from a device that cannot see them. `interactionAffordance` holds that
 * table and explains each entry.
 */
export function InteractionPanel({
  commandPublicId,
  interaction,
  onResolve,
  submitting,
}: InteractionPanelProps): ReactNode {
  const [answer, setAnswer] = useState("");
  const command = useCommandState(commandPublicId);
  const affordance = interactionAffordance(interaction.interactionKind);
  const restriction = interactionRestriction(interaction.interactionKind);
  const disabled = submitting || command?.state === "pending";

  const decide = (decision: "once" | "decline") => {
    onResolve({
      decision,
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
        <Badge tone="attention">{interactionKindLabel[interaction.interactionKind]}</Badge>
        {interaction.blocking ? (
          <span className="text-xs text-ink-muted">Blocking the turn</span>
        ) : null}
      </div>
      <p className="mt-2 text-sm break-words">{interaction.summary}</p>
      {restriction === null ? null : (
        <p className="mt-1 text-xs text-ink-muted">{restriction}</p>
      )}

      {affordance.kind === "approve_or_decline" ? (
        <div className="mt-3 flex gap-2">
          <Button disabled={disabled} onClick={() => { decide("once"); }}>Approve</Button>
          <Button disabled={disabled} onClick={() => { decide("decline"); }} variant="secondary">
            Decline
          </Button>
        </div>
      ) : null}

      {affordance.kind === "decline_only" ? (
        <div className="mt-3 flex gap-2">
          <Button disabled={disabled} onClick={() => { decide("decline"); }} variant="secondary">
            Decline
          </Button>
        </div>
      ) : null}

      {affordance.kind === "answers" ? (
        <div className="mt-3 flex gap-2">
          <Input
            aria-label="Answer"
            disabled
            onChange={(event) => { setAnswer(event.target.value); }}
            placeholder="Answer on the execution machine"
            value={answer}
          />
          <Button disabled type="button">Send</Button>
        </div>
      ) : null}

      {affordance.kind === "local_only" ? (
        <p className="mt-3 text-xs text-ink-muted">
          This one is resolved on the machine running the session.
        </p>
      ) : null}

      {command === null ? null : (
        <p className="mt-2 text-xs text-ink-muted" role="status">
          Decision {command.state}
          {command.resultCode === null ? "" : `: ${command.resultCode}`}.
        </p>
      )}
    </section>
  );
}
