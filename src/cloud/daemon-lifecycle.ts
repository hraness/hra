import type {
  CloudDaemonBridge,
  CloudDaemonCycleResult,
} from "./daemon-bridge";

export type CloudDaemonLifecycleOptions = Readonly<{
  bridge: CloudDaemonBridge;
  intervalMs?: number;
  liveIntervalMs?: number;
  onCycle?: (result: CloudDaemonCycleResult) => void;
}>;

export interface CloudDaemonLifecycle {
  close(): Promise<void>;
  join(): Promise<void>;
  start(): void;
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

export class PollingCloudDaemonLifecycle implements CloudDaemonLifecycle {
  readonly #bridge: CloudDaemonBridge;
  readonly #controller = new AbortController();
  readonly #intervalMs: number;
  readonly #liveIntervalMs: number;
  readonly #onCycle: ((result: CloudDaemonCycleResult) => void) | undefined;
  #run: Promise<void> | null = null;

  constructor(options: CloudDaemonLifecycleOptions) {
    const intervalMs = options.intervalMs ?? 15_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) {
      throw new Error("Cloud daemon polling interval is invalid.");
    }
    const liveIntervalMs = options.liveIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(liveIntervalMs) || liveIntervalMs < 250 || liveIntervalMs > 10_000) {
      throw new Error("Cloud daemon live interval is invalid.");
    }
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
    this.#run = this.#loop();
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
        await abortableDelay(this.#intervalMs, this.#controller.signal);
      }
    } finally {
      await live;
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
