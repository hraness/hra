import type { ChildProcess } from "node:child_process";

/** Test-driver child-close observations, never process-group absence proof. */
export function createSiteTestCompilerChildJoin(dependencies: Readonly<{
  stop: () => Promise<void>;
  keepAlive: () => () => void;
  onFailure: (error: unknown) => void;
}>) {
  const { stop, keepAlive, onFailure } = dependencies;
  const children = new Map<ChildProcess, { closed: boolean; close: Promise<void> }>();
  const failures: Error[] = [];
  let state: "open" | "closing" | "closed" = "open";
  let closing: Promise<void> | undefined;

  const recordFailure = (tag: string, cause: unknown): void => {
    const failure = new Error(tag, { cause });
    failures.push(failure);
    try { onFailure(failure); }
    catch (error: unknown) {
      failures.push(new Error("SITE_COMPILER_CHILD_FAILURE_REPORT_FAILED", { cause: error }));
    }
  };

  const assertOpen = (): void => {
    if (state !== "open") throw new Error("SITE_COMPILER_CHILD_JOIN_NOT_OPEN");
    if (children.size >= 16) throw new Error("SITE_COMPILER_CHILD_ACQUISITION_LIMIT");
  };

  return {
    assertOpen,
    own(child: ChildProcess): void {
      assertOpen();
      if (children.has(child)) throw new Error("SITE_COMPILER_CHILD_ALREADY_OWNED");
      let resolveClose!: () => void;
      const entry = {
        closed: false,
        close: new Promise<void>((resolve) => { resolveClose = resolve; }),
      };
      children.set(child, entry);
      child.once("close", () => {
        entry.closed = true;
        resolveClose();
      });
      const observedFailures = new Set<"child" | "stdin" | "stdout">();
      const observeFailure = (source: "child" | "stdin" | "stdout", cause: unknown): void => {
        if (observedFailures.has(source)) return;
        observedFailures.add(source);
        const tags = {
          child: "SITE_COMPILER_CHILD_ERROR",
          stdin: "SITE_COMPILER_CHILD_STDIN_ERROR",
          stdout: "SITE_COMPILER_CHILD_STDOUT_ERROR",
        } as const;
        recordFailure(tags[source], cause);
      };
      // Keep observing after close: a later real error must still fail the
      // isolated driver. Retain only the first error per source and child, so
      // repeated errors cannot grow the fixed sixteen-acquisition ledger.
      child.on("error", (error: unknown) => { observeFailure("child", error); });
      child.stdin?.on("error", (error: unknown) => { observeFailure("stdin", error); });
      child.stdout?.on("error", (error: unknown) => { observeFailure("stdout", error); });
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      state = "closing";
      // Reserve the exact shared task before invoking any reentrant dependency.
      closing = Promise.resolve().then(async () => {
        let release: (() => void) | undefined;
        try { release = keepAlive(); }
        catch (error: unknown) { recordFailure("SITE_COMPILER_CHILD_KEEP_ALIVE_FAILED", error); }
        for (const [child, entry] of children) {
          if (entry.closed) continue;
          try { child.ref(); }
          catch (error: unknown) { recordFailure("SITE_COMPILER_CHILD_REF_FAILED", error); }
        }
        try { await stop(); }
        catch (error: unknown) { recordFailure("SITE_COMPILER_CHILD_STOP_FAILED", error); }
        await Promise.all([...children.values()].map((entry) => entry.close));
        try { release?.(); }
        catch (error: unknown) { recordFailure("SITE_COMPILER_CHILD_KEEP_ALIVE_RELEASE_FAILED", error); }
        state = "closed";
        if (failures.length > 0) throw new AggregateError([...failures], "SITE_COMPILER_CHILD_JOIN_FAILED");
      });
      void closing.catch(() => undefined);
      return closing;
    },
  };
}
