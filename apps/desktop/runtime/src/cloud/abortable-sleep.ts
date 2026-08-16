export async function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (cancelTimer: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (cancelTimer && timer !== null) clearTimeout(timer);
      resolve();
    };
    const onAbort = (): void => finish(true);
    timer = setTimeout(() => finish(false), milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the race where the signal aborted after the first check but
    // before its listener was installed.
    if (signal.aborted) onAbort();
  });
}
