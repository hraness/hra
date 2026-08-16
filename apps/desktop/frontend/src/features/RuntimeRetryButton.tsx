import { useCallback, useEffect, useRef, useState } from "react";

import { IconButton } from "@hraness/ui";

import type { RuntimeShell } from "../runtime";
import { HRAIcon } from "./chat/Icon";

export interface RuntimeRetryCoordinator {
  readonly isPending: () => boolean;
  readonly retry: () => Promise<void>;
  readonly setMounted: (mounted: boolean) => void;
}

/**
 * Coalesces the one global runtime recovery action and contains its rejection.
 * RuntimeShell retains the authoritative failure, so a rejected retry remains
 * visible through the same action instead of escaping as an unhandled promise.
 */
export function createRuntimeRetryCoordinator(
  reconnect: () => Promise<void>,
  onPendingChange: (pending: boolean) => void,
): RuntimeRetryCoordinator {
  let mounted = true;
  let task: Promise<void> | null = null;

  return {
    isPending: () => task !== null,
    retry: () => {
      if (task !== null) return task;
      if (mounted) onPendingChange(true);
      let reconnectTask: Promise<void>;
      try {
        reconnectTask = reconnect();
      } catch {
        reconnectTask = Promise.resolve();
      }
      const started = reconnectTask
        .catch(() => {
          // RuntimeShell already retained the authoritative failure.
        })
        .finally(() => {
          if (task === started) task = null;
          if (mounted) onPendingChange(false);
        });
      task = started;
      return started;
    },
    setMounted: (nextMounted) => {
      mounted = nextMounted;
    },
  };
}

export function RuntimeRetryButton({ shell }: { readonly shell: RuntimeShell }) {
  const [pending, setPending] = useState(false);
  const reconnectRef = useRef(shell.reconnect.bind(shell));
  reconnectRef.current = shell.reconnect.bind(shell);
  const coordinatorRef = useRef<RuntimeRetryCoordinator | null>(null);
  if (coordinatorRef.current === null) {
    coordinatorRef.current = createRuntimeRetryCoordinator(
      () => reconnectRef.current(),
      setPending,
    );
  }

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    coordinator?.setMounted(true);
    return () => coordinator?.setMounted(false);
  }, []);

  const retry = useCallback(() => coordinatorRef.current?.retry(), []);

  return (
    <IconButton
      aria-label="Retry local runtime"
      isDisabled={pending}
      isPending={pending}
      onPress={() => void retry()}
      size="compact"
      tooltip="Retry local runtime"
      type="button"
      variant="quiet"
    >
      <HRAIcon name="refresh" />
    </IconButton>
  );
}
