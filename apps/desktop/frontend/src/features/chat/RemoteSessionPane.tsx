import { memo, useEffect, useRef, useState } from "react";

import { IconButton } from "../../ui";

import type { RemoteSessionSummaryProjection } from "../../../../contracts/runtime";
import { paneAccessibleName } from "./model";

export const remoteSessionObservationCapability = "summary-v1" as const;

const statePresentation: Readonly<Record<
  RemoteSessionSummaryProjection["state"],
  Readonly<{ glyph: string; label: string }>
>> = {
  attention: { glyph: "!", label: "Needs attention" },
  error: { glyph: "!", label: "Error" },
  offline: { glyph: "○", label: "Offline" },
  ready: { glyph: "◇", label: "Ready" },
  revoked: { glyph: "×", label: "Revoked" },
  updateRequired: { glyph: "↑", label: "Update required" },
  working: { glyph: "◐", label: "Working" },
};

function RemoteDeviceGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="remote-session-pane__device-icon"
      fill="none"
      focusable="false"
      viewBox="0 0 20 20"
    >
      <path
        d="M4 4.5h12v8H4zM2.75 15.5h14.5M8 15.5l.5-3h3l.5 3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export const RemoteSessionPane = memo(function RemoteSessionPane({
  collisionLine,
  session,
}: {
  readonly collisionLine: string | null;
  readonly session: RemoteSessionSummaryProjection;
}) {
  const state = statePresentation[session.state];
  const deviceTooltipId = `remote-device-tooltip-${session.gridPosition}`;
  const deviceTriggerRef = useRef<HTMLButtonElement>(null);
  const [deviceDetailsOpen, setDeviceDetailsOpen] = useState(false);
  const accessibleName = paneAccessibleName({
    gridPosition: session.gridPosition,
    kind: "remote",
    ownerDeviceName: session.originDeviceName,
    repositoryDisplayName: session.repositoryDisplayName,
    stateLabel: state.label,
    title: session.title,
  });
  useEffect(() => {
    if (!deviceDetailsOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node
        && !deviceTriggerRef.current?.contains(event.target)
      ) setDeviceDetailsOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setDeviceDetailsOpen(false);
      deviceTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeFromKeyboard, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeFromKeyboard, true);
    };
  }, [deviceDetailsOpen]);
  return (
    <article
      aria-label={accessibleName}
      className="remote-session-pane"
      data-observation-capability={remoteSessionObservationCapability}
      data-session-state={session.state}
    >
      <header className="remote-session-pane__header">
        <strong title={session.title}>{session.title}</strong>
        <span className="remote-session-pane__indicators">
          <span
            className="remote-session-pane__device"
            data-open={deviceDetailsOpen || undefined}
          >
            <IconButton
              aria-controls={deviceTooltipId}
              aria-describedby={deviceTooltipId}
              aria-expanded={deviceDetailsOpen}
              aria-label={`Device: ${session.originDeviceName}, ${state.label}`}
              buttonRef={deviceTriggerRef}
              controlClassName="remote-session-pane__device-trigger"
              onPress={(event) => {
                if (event.pointerType !== "touch") {
                  setDeviceDetailsOpen((current) => !current);
                }
              }}
              onPointerDown={(event) => {
                if (event.pointerType !== "touch") return;
                event.preventDefault();
                event.currentTarget.focus();
                setDeviceDetailsOpen((current) => !current);
              }}
              size="compact"
              tooltip={`Device: ${session.originDeviceName}, ${state.label}`}
              type="button"
              variant="quiet"
            >
              <RemoteDeviceGlyph />
            </IconButton>
            <span
              className="remote-session-pane__device-tooltip"
              id={deviceTooltipId}
              role="tooltip"
            >
              {session.originDeviceName} · {state.label}
            </span>
          </span>
          <span
            aria-label={state.label}
            className="remote-session-pane__state"
            role="img"
            title={state.label}
          >
            {state.glyph}
          </span>
        </span>
      </header>
      {collisionLine === null ? null : (
        <p className="remote-session-pane__collision" title={collisionLine}>
          {collisionLine}
        </p>
      )}
    </article>
  );
});
