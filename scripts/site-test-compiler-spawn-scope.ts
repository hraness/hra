import type { ChildProcess, spawn } from "node:child_process";

type SpawnOwner = { spawn: typeof spawn };
type ChildJoin = Readonly<{ assertOpen: () => void; own: (child: ChildProcess) => void; close: () => Promise<void> }>;

/** Installed only in the isolated compiler child, before its Vite preload. */
export function installSiteTestCompilerSpawnScope(
  owner: SpawnOwner,
  join: ChildJoin,
  admit: (arguments_: readonly unknown[]) => void,
  onFailure: (error: unknown) => void,
): Readonly<{ close: () => Promise<void> }> {
  const original = owner.spawn;
  let acquiring = false;
  const captured = function (this: unknown, ...arguments_: Parameters<typeof spawn>): ChildProcess {
    try {
      if (acquiring) throw new Error("SITE_COMPILER_SPAWN_REENTRANT");
      join.assertOpen();
      acquiring = true;
      try {
        admit(arguments_);
        // Keep the actual receiver, complete argv, and genuine child identity.
        const child = Reflect.apply(original, this, arguments_);
        join.own(child);
        return child;
      } finally { acquiring = false; }
    } catch (error: unknown) {
      try { onFailure(error); }
      catch (reportError: unknown) { throw new AggregateError([error, reportError], "SITE_COMPILER_SPAWN_REPORT_FAILED"); }
      throw error;
    }
  } as typeof spawn;
  owner.spawn = captured;
  let closing: Promise<void> | undefined;
  return {
    close() {
      closing ??= (async () => {
        const failures: unknown[] = [];
        try { await join.close(); } catch (error: unknown) { failures.push(error); }
        // Never overwrite a replacement owned by another scope, or discard
        // an earlier shutdown failure when ownership was also replaced.
        if (owner.spawn !== captured) failures.push(new Error("SITE_COMPILER_SPAWN_SCOPE_REPLACED"));
        else owner.spawn = original;
        if (failures.length > 0) throw new AggregateError(failures, "SITE_COMPILER_SPAWN_SCOPE_FAILED");
      })();
      return closing;
    },
  };
}
