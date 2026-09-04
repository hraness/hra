import type {
  CloudDaemonActivity,
  CloudDaemonBridge,
  CloudDaemonCycleResult,
} from "./daemon-bridge";
import type { CloudPushWakePort, CloudPushWakeStatus } from "./push-wake";

/*
 * Sync cadence. The poll loop sleeps for the interval below, or until the
 * hosted push-wake subscription reports that this device's pending-command
 * set changed, whichever comes first. The fast interval applies while a
 * second device is present or a local session is mid-turn; the idle interval
 * applies otherwise. A wake is a hint: the cycle it starts claims, binds, and
 * settles each pending command exactly as a timer-driven cycle would, so a
 * wake racing the timer costs at most one extra cycle.
 */
export const activeCloudDaemonIntervalMs = 1_000;
export const idleCloudDaemonIntervalMs = 15_000;

export type CloudSyncCadenceReason =
  | "browser_device_present"
  | "idle"
  | "local_turn_active";

export type CloudSyncCadenceStatus = Readonly<{
  intervalMs: number;
  mode: "active" | "idle";
  pushWake: CloudPushWakeStatus | null;
  reason: CloudSyncCadenceReason;
}>;

export type CloudDaemonLifecycleOptions = Readonly<{
  activeIntervalMs?: number;
  bridge: CloudDaemonBridge;
  intervalMs?: number;
  liveIntervalMs?: number;
  onCycle?: (result: CloudDaemonCycleResult) => void;
}>;

export interface CloudDaemonLifecycle {
  close(): Promise<void>;
  join(): Promise<void>;
  start(): void;
  /** The interval the next sleep will use, and the push-wake state behind it. */
  syncCadence(): CloudSyncCadenceStatus;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function cloudSyncCadenceReason(
  activity: CloudDaemonActivity | undefined,
): CloudSyncCadenceReason {
  if (activity === undefined) return "idle";
  if (activity.peerDevicePresent) return "browser_device_present";
  if (activity.localTurnActive) return "local_turn_active";
  return "idle";
}

export class PollingCloudDaemonLifecycle implements CloudDaemonLifecycle {
  readonly #activeIntervalMs: number;
  readonly #bridge: CloudDaemonBridge;
  readonly #controller = new AbortController();
  readonly #intervalMs: number;
  readonly #liveIntervalMs: number;
  readonly #onCycle: ((result: CloudDaemonCycleResult) => void) | undefined;
  #reason: CloudSyncCadenceReason = "idle";
  #run: Promise<void> | null = null;
  #wake: CloudPushWakePort | null = null;

  constructor(options: CloudDaemonLifecycleOptions) {
    const intervalMs = options.intervalMs ?? idleCloudDaemonIntervalMs;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
      throw new Error("Cloud daemon polling interval is invalid.");
    }
    const activeIntervalMs = Math.min(
      options.activeIntervalMs ?? activeCloudDaemonIntervalMs,
      intervalMs,
    );
    if (
      !Number.isSafeInteger(activeIntervalMs)
      || activeIntervalMs < 250
      || activeIntervalMs > 60_000
    ) throw new Error("Cloud daemon active polling interval is invalid.");
    const liveIntervalMs = options.liveIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(liveIntervalMs) || liveIntervalMs < 250 || liveIntervalMs > 10_000) {
      throw new Error("Cloud daemon live interval is invalid.");
    }
    this.#activeIntervalMs = activeIntervalMs;
    this.#bridge = options.bridge;
    this.#intervalMs = intervalMs;
    this.#liveIntervalMs = liveIntervalMs;
    this.#onCycle = options.onCycle;
  }

  start(): void {
    if (this.#run !== null) return;
    if (this.#controller.signal.aborted) {
      throw new Error("A closed cloud daemon lifecycle cannot be restarted.");
    }
    this.#wake = this.#bridge.pushWake?.() ?? null;
    this.#run = this.#loop();
  }

  syncCadence(): CloudSyncCadenceStatus {
    const mode = this.#reason === "idle" ? "idle" as const : "active" as const;
    return {
      intervalMs: mode === "idle" ? this.#intervalMs : this.#activeIntervalMs,
      mode,
      pushWake: (this.#wake ?? this.#bridge.pushWake?.() ?? null)?.status() ?? null,
      reason: this.#reason,
    };
  }

  async close(): Promise<void> {
    this.#controller.abort(new Error("Cloud daemon lifecycle is closing."));
    await this.join();
    await this.#bridge.close?.();
  }

  async join(): Promise<void> {
    await (this.#run ?? Promise.resolve());
  }

  async #loop(): Promise<void> {
    const live = this.#liveLoop();
    try {
      while (!this.#controller.signal.aborted) {
        const result = await this.#bridge.cycle(this.#controller.signal);
        this.#onCycle?.(result);
        this.#reason = cloudSyncCadenceReason(result.activity);
        await this.#waitForNextCycle();
      }
    } finally {
      await live;
    }
  }

  /*
   * Sleeps for the current interval, or until the push wake fires. The race
   * runs under its own controller so the losing waiter releases its timer and
   * its listener immediately instead of surviving until the interval elapses.
   */
  async #waitForNextCycle(): Promise<void> {
    const signal = this.#controller.signal;
    const wake = this.#wake;
    const intervalMs = this.syncCadence().intervalMs;
    if (wake === null) {
      await abortableDelay(intervalMs, signal);
      return;
    }
    // The lifecycle may have been closed while the cycle ran; a listener added
    // now would never fire, so an already-aborted signal ends the wait at once.
    if (signal.aborted) return;
    const gate = new AbortController();
    const forward = (): void => { gate.abort(signal.reason); };
    signal.addEventListener("abort", forward, { once: true });
    try {
      await Promise.race([
        abortableDelay(intervalMs, gate.signal),
        wake.wait(gate.signal),
      ]);
    } finally {
      signal.removeEventListener("abort", forward);
      gate.abort(new Error("Cloud daemon cycle wait completed."));
    }
  }

  /*
   * The live projection ticks on its own short cadence so streaming text
   * reaches the hosted detail stream within about a second while the full
   * sync cycle keeps its longer interval. A bridge without liveTick runs no
   * live loop at all.
   */
  async #liveLoop(): Promise<void> {
    const tick = this.#bridge.liveTick?.bind(this.#bridge);
    if (tick === undefined) return;
    while (!this.#controller.signal.aborted) {
      try {
        await tick(this.#controller.signal);
      } catch {
        // Live upload failures are reported by the bridge through the next
        // cycle result; the loop itself never dies on them.
      }
      await abortableDelay(this.#liveIntervalMs, this.#controller.signal);
    }
  }
}

export function createCloudDaemonLifecycle(
  options: CloudDaemonLifecycleOptions,
): CloudDaemonLifecycle {
  return new PollingCloudDaemonLifecycle(options);
}
