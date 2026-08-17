import { useCallback, useEffect, useMemo, useState } from "react";

import type { RuntimeTransport } from "../src/runtime-bridge";

import {
  applyStagedDevelopmentUpdate,
  type DevApplyOutcome,
} from "./apply";
import {
  reloadAndConfirmDevelopmentCandidate,
  takeAuthoritativeRuntimeSnapshot,
} from "./native-runtime";
import {
  DEV_STATUS_EVENT,
  parseDevStatusEnvelope,
  type DevStatusEnvelope,
} from "./protocol";
import {
  createDevStatusClient,
  type DevStatusClient,
} from "./status-client";

type DevConnection =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "status"; readonly status: DevStatusEnvelope };

type DevAction =
  | "idle"
  | "applying"
  | "activeWork"
  | "runtimeBusy"
  | "runtimeUnavailable"
  | "acceptedUnconfirmed"
  | "failed";

interface DevFeedbackFence {
  readonly candidateId: string | null;
  readonly revision: number;
}

export function devFeedbackIsStale(
  fence: DevFeedbackFence,
  status: DevStatusEnvelope,
): boolean {
  return status.revision > fence.revision || status.candidateId !== fence.candidateId;
}

export interface DevHudPresentation {
  readonly label: string;
  readonly tone: "live" | "working" | "ready" | "attention";
  readonly title: string;
  readonly detail: string;
}

export function devHudPresentation(
  connection: DevConnection,
  action: DevAction,
): DevHudPresentation {
  if (connection.kind === "loading") return {
    label: "DEV · Connecting",
    tone: "working",
    title: "Development mode",
    detail: "Connecting to the development coordinator…",
  };
  if (connection.kind === "unavailable") return {
    label: "DEV · Coordinator unavailable",
    tone: "attention",
    title: "Development coordinator unavailable",
    detail: "Interface edits may still be live. Restart bun hra to restore runtime staging.",
  };
  const { status } = connection;
  if (status.authority === "uiOnly") return {
    label: "DEV · UI live",
    tone: "live",
    title: "UI-only development",
    detail: "Interface edits are live. Start HRA with bun hra to stage runtime updates.",
  };
  switch (action) {
    case "applying":
      return {
        label: "DEV · Applying runtime",
        tone: "working",
        title: "Applying runtime update",
        detail: "HRA is switching to the staged runtime and verifying the new generation.",
      };
    case "activeWork":
      return {
        label: "DEV · Runtime waiting",
        tone: "attention",
        title: "Active work is protected",
        detail: "A pane, workspace, or recursive session is still working. Apply again after it settles.",
      };
    case "runtimeBusy":
      return {
        label: "DEV · Runtime busy",
        tone: "attention",
        title: "Runtime update is waiting",
        detail: "The runtime is still handling work. The staged update remains ready for a later attempt.",
      };
    case "runtimeUnavailable":
      return {
        label: "DEV · Apply unavailable",
        tone: "attention",
        title: "Runtime update was not applied",
        detail: "The current runtime is unchanged. Try again after HRA finishes starting or stopping.",
      };
    case "acceptedUnconfirmed":
      return {
        label: "DEV · Restart needed",
        tone: "attention",
        title: "Runtime switch needs verification",
        detail: "Native accepted the update, but HRA could not confirm readiness. Restart bun hra before applying another update.",
      };
    case "failed":
      return {
        label: "DEV · Apply failed",
        tone: "attention",
        title: "Runtime update was not applied",
        detail: "HRA kept the current runtime. Fix the issue or restart bun hra, then try again.",
      };
    case "idle":
      break;
  }
  switch (status.state) {
    case "current":
      return {
        label: "DEV · UI live",
        tone: "live",
        title: "Malleable development",
        detail: "UI edits appear as you save. Actor-policy text and data compile in the background.",
      };
    case "building":
      return {
        label: "DEV · Runtime compiling",
        tone: "working",
        title: "Runtime update compiling",
        detail: "The current runtime stays active while the next update is checked.",
      };
    case "staged":
      return {
        label: "DEV · Runtime ready",
        tone: "ready",
        title: "Runtime update ready",
        detail: "Apply after active turns and recursive sessions have settled.",
      };
    case "applying":
      return {
        label: "DEV · Runtime applying",
        tone: "working",
        title: "Runtime update applying",
        detail: "HRA is verifying the new runtime generation before marking it current.",
      };
    case "restartRequired":
      return {
        label: "DEV · Restart needed",
        tone: "attention",
        title: "Full development restart needed",
        detail: "Restart bun hra to apply other runtime, native, contract, dependency, or supervisor changes.",
      };
    case "failed":
      return {
        label: "DEV · Update failed",
        tone: "attention",
        title: "Background update failed",
        detail: "HRA is still using the last working runtime. Save another edit after fixing the source.",
      };
  }
}

function connectionWithStatus(status: DevStatusEnvelope): DevConnection {
  return { kind: "status", status };
}

function nextConnection(
  current: DevConnection,
  status: DevStatusEnvelope,
): DevConnection {
  if (current.kind !== "status") return connectionWithStatus(status);
  if (status.sessionId !== current.status.sessionId) return current;
  return status.revision > current.status.revision
    ? connectionWithStatus(status)
    : current;
}

function outcomeAction(outcome: DevApplyOutcome): DevAction {
  switch (outcome.kind) {
    case "applied":
    case "stale":
      return "idle";
    case "activeWork":
      return "activeWork";
    case "runtimeBusy":
      return "runtimeBusy";
    case "runtimeUnavailable":
      return "runtimeUnavailable";
    case "acceptedUnconfirmed":
      return "acceptedUnconfirmed";
    case "failed":
      return "failed";
  }
}

export interface DevHudProps {
  readonly transport: RuntimeTransport | null;
  readonly statusClient?: DevStatusClient;
}

export function DevHud({ transport, statusClient }: DevHudProps) {
  const statuses = useMemo(
    () => statusClient ?? createDevStatusClient(),
    [statusClient],
  );
  const [connection, setConnection] = useState<DevConnection>({ kind: "loading" });
  const [action, setAction] = useState<DevAction>("idle");
  const [feedbackFence, setFeedbackFence] = useState<DevFeedbackFence | null>(null);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const status = await statuses.read();
      setConnection((current) => nextConnection(current, status));
    } catch {
      setConnection((current) => current.kind === "loading"
        ? { kind: "unavailable" }
        : current);
    }
  }, [statuses]);

  useEffect(() => {
    void refresh();
    const hot = import.meta.hot;
    if (hot === undefined) return;
    const receive = (value: unknown): void => {
      let status: DevStatusEnvelope;
      try {
        status = parseDevStatusEnvelope(value);
      } catch {
        return;
      }
      setConnection((current) => current.kind === "loading"
        ? current
        : nextConnection(current, status));
    };
    const statusHot = hot as unknown as {
      on(this: void, event: typeof DEV_STATUS_EVENT, listener: (value: unknown) => void): void;
      off(this: void, event: typeof DEV_STATUS_EVENT, listener: (value: unknown) => void): void;
    };
    statusHot.on(DEV_STATUS_EVENT, receive);
    return () => statusHot.off(DEV_STATUS_EVENT, receive);
  }, [refresh]);

  useEffect(() => {
    const receiveFocus = (): void => void refresh();
    window.addEventListener("focus", receiveFocus);
    return () => window.removeEventListener("focus", receiveFocus);
  }, [refresh]);

  const status = connection.kind === "status" ? connection.status : null;

  useEffect(() => {
    if (
      action !== "idle" &&
      action !== "applying" &&
      status !== null &&
      feedbackFence !== null &&
      devFeedbackIsStale(feedbackFence, status)
    ) {
      setAction("idle");
      setFeedbackFence(null);
    }
  }, [action, feedbackFence, status]);

  const canApply = transport !== null && status?.authority === "launcher" &&
    status.state === "staged" && status.candidateId !== null && action !== "applying";
  const presentation = devHudPresentation(connection, action);

  const apply = useCallback(async () => {
    if (!canApply || transport === null || status === null) return;
    setAction("applying");
    setFeedbackFence({ revision: status.revision, candidateId: status.candidateId });
    const outcome = await applyStagedDevelopmentUpdate(status, {
      statuses,
      takeSnapshot: () => takeAuthoritativeRuntimeSnapshot(transport),
      reloadAndConfirm: (candidateId) => (
        reloadAndConfirmDevelopmentCandidate(transport, candidateId)
      ),
    });
    const outcomeStatus = outcome.status;
    if (outcomeStatus !== null) {
      setConnection((current) => nextConnection(current, outcomeStatus));
      setFeedbackFence({
        revision: outcomeStatus.revision,
        candidateId: outcomeStatus.candidateId,
      });
    }
    const nextAction = outcomeAction(outcome);
    setAction(nextAction);
    if (nextAction === "idle") setFeedbackFence(null);
  }, [canApply, status, statuses, transport]);

  return (
    <aside className="hra-dev" aria-label="Development mode">
      <button
        aria-controls="hra-dev-panel"
        aria-expanded={expanded}
        className={`hra-dev__pill hra-dev__pill--${presentation.tone}`}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <span aria-hidden="true" className="hra-dev__dot" />
        <span aria-live="polite">{presentation.label}</span>
      </button>
      {expanded ? (
        <section className="hra-dev__panel" id="hra-dev-panel">
          <div className="hra-dev__copy">
            <h2>{presentation.title}</h2>
            <p>{presentation.detail}</p>
          </div>
          <dl className="hra-dev__rules" aria-label="Development reload guide">
            <div><dt>Interface</dt><dd>Live as you save</dd></div>
            <div><dt>Actor-policy data</dt><dd>Compile, then apply when idle</dd></div>
            <div><dt>Other runtime + native</dt><dd>Restart bun hra</dd></div>
          </dl>
          {status?.state === "staged" ? (
            <button
              className="hra-dev__apply"
              disabled={!canApply}
              onClick={() => void apply()}
              type="button"
            >
              {action === "applying" ? "Applying…" : "Apply runtime update"}
            </button>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
