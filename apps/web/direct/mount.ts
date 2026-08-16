import type { DirectSessionActivation } from "@hraness/direct/testing";
import { installDirectBrowser } from "@hraness/direct/web";

import {
  createAgentTasksDirectSession,
  type AgentTasksDirectSession,
} from "./runtime";

export interface MountedAgentTasksDirect {
  readonly session: AgentTasksDirectSession;
  readonly dispose: () => undefined;
}

export type AgentTasksDirectMountError = Readonly<{
  code: "activation-failed" | "browser-install-failed";
  message: string;
}>;

export type AgentTasksDirectMountResult =
  | Readonly<{ ok: true; value: MountedAgentTasksDirect }>
  | Readonly<{ ok: false; error: AgentTasksDirectMountError }>;

export interface AgentTasksDirectMountOptions {
  readonly target?: object;
}

/** Own one complete session and browser boundary so React replay can replace both safely. */
export function mountAgentTasksDirect(
  activation: DirectSessionActivation,
  options: AgentTasksDirectMountOptions = {},
): AgentTasksDirectMountResult {
  const created = createAgentTasksDirectSession(activation);
  if (!created.ok) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: "activation-failed",
        message: created.error.message,
      }),
    });
  }

  const session = created.value;
  const browser = installDirectBrowser({
    session,
    reset: () => {
      globalThis.location?.reload();
      return undefined;
    },
    firewall: { onBlocked: session.harness.recordBlockedNetworkRequest },
    ...(options.target === undefined ? {} : { target: options.target }),
  });
  if (!browser.ok) {
    session.dispose();
    return Object.freeze({
      ok: false,
      error: Object.freeze({
        code: "browser-install-failed",
        message: browser.error.message,
      }),
    });
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({ session, dispose: session.dispose }),
  });
}
