"use client";

import {
  PlayIcon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import type { ReactNode, Ref } from "react";

import { IconButton } from "./button";
import { classNames } from "./class-names";
import { Spinner } from "./feedback";
import { Icon } from "./icon";
import { Toolbar } from "./toolbar";

type AccessibleName =
  | { readonly "aria-label": string; readonly "aria-labelledby"?: never }
  | { readonly "aria-label"?: never; readonly "aria-labelledby": string };

export type PlaybackTransportStatus = "idle" | "pending" | "playing";

export type PlaybackTransportProps = AccessibleName & {
  readonly buttonAriaKeyShortcuts?: string;
  readonly buttonId?: string;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly className?: string;
  readonly isPlayDisabled?: boolean;
  readonly onPlay: () => void;
  readonly onStop: () => void;
  readonly pendingLabel?: string;
  readonly playLabel?: string;
  readonly status: PlaybackTransportStatus;
  readonly stopLabel?: string;
  readonly trailingControls?: ReactNode;
};

/**
 * One stable, icon-only playback command for product-owned audio behavior.
 *
 * The same touch-sized node starts idle playback, cancels pending startup, and
 * stops active playback. Its accessible name and glyph describe the current
 * command without adding a persistent visual label to compact transport chrome.
 */
export function PlaybackTransport({
  buttonAriaKeyShortcuts,
  buttonId,
  buttonRef,
  className,
  isPlayDisabled = false,
  onPlay,
  onStop,
  pendingLabel = "Cancel playback start",
  playLabel = "Play",
  status,
  stopLabel = "Stop",
  trailingControls,
  ...accessibleName
}: PlaybackTransportProps) {
  const isPending = status === "pending";
  const isIdle = status === "idle";
  const commandLabel = isIdle
    ? playLabel
    : isPending
      ? pendingLabel
      : stopLabel;

  return (
    <Toolbar
      {...accessibleName}
      className={classNames("jungle-playback-transport", className)}
      data-playback-status={status}
    >
      <IconButton
        aria-busy={isPending || undefined}
        aria-label={commandLabel}
        {...(buttonAriaKeyShortcuts === undefined
          ? {}
          : { "aria-keyshortcuts": buttonAriaKeyShortcuts })}
        {...(buttonId === undefined ? {} : { id: buttonId })}
        {...(buttonRef === undefined ? {} : { buttonRef })}
        className="jungle-playback-transport__button"
        data-playback-command={isIdle ? "play" : "stop"}
        isDisabled={isIdle && isPlayDisabled}
        onPress={() => {
          if (isIdle) {
            if (!isPlayDisabled) onPlay();
            return;
          }
          onStop();
        }}
        size="large"
        variant="primary"
      >
        {isPending
          ? <Spinner />
          : <Icon icon={isIdle ? PlayIcon : StopIcon} size={24} />}
      </IconButton>
      {trailingControls}
    </Toolbar>
  );
}
