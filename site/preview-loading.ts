export type PreviewLoadingState = "idle" | "loading" | "ready" | "failed";

/** The viewport observer may arrive after the child is already ready. A
 * settled load cannot be restarted except by explicitly selecting a new one. */
export function createPreviewLoading<Timer>(ports: Readonly<{
  publish: (state: PreviewLoadingState) => void;
  schedule: (callback: () => void) => Timer;
  cancel: (timer: Timer) => void;
}>) {
  let state: PreviewLoadingState = "idle";
  let timer: Timer | undefined;
  let generation = 0;
  const clear = (): void => { if (timer !== undefined) ports.cancel(timer); timer = undefined; };
  const set = (next: PreviewLoadingState): void => { state = next; ports.publish(next); };
  return {
    begin(): void {
      if (state !== "idle") return;
      const expected = generation;
      set("loading");
      timer = ports.schedule(() => {
        if (generation !== expected || state !== "loading") return;
        timer = undefined;
        set("failed");
      });
    },
    complete(success: boolean): void { clear(); set(success ? "ready" : "failed"); },
    reset(): void { generation += 1; clear(); set("idle"); },
    state: (): PreviewLoadingState => state,
  };
}
