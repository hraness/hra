import { BunBoundedCommandRunner, type BoundedCommandRunner } from "./bundle.ts";
import { DesktopSwitchError } from "./errors.ts";
import type { DesktopProcessIdentity, DesktopProcessPort } from "./switch.ts";

interface ProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly command: string;
}

export class MacOsDesktopProcessPort implements DesktopProcessPort {
  readonly #runner: BoundedCommandRunner;
  readonly #quiescenceSets = new Map<number, readonly ProcessRow[]>();

  constructor(runner: BoundedCommandRunner = new BunBoundedCommandRunner()) {
    this.#runner = runner;
  }

  async listExact(executablePath: string): Promise<readonly DesktopProcessIdentity[]> {
    const rows = await this.#processRows();
    return rows
      .filter((row) => row.command === executablePath)
      .map((row) => ({ pid: row.pid, executablePath }));
  }

  async requestGracefulQuit(process: DesktopProcessIdentity): Promise<void> {
    const rows = await this.#processRows();
    const source = rows.find(
      (row) => row.pid === process.pid && row.command === process.executablePath,
    );
    if (source === undefined) {
      throw new DesktopSwitchError("PROCESS_AMBIGUOUS", "the selected ChatGPT process changed");
    }
    this.#quiescenceSets.set(process.pid, descendantsIncluding(rows, source));
    const result = await this.#runner.run(
      ["/usr/bin/osascript", "-e", 'tell application id "com.openai.codex" to quit'],
      10_000,
    );
    if (result.exitCode !== 0) {
      throw new DesktopSwitchError("RECOVERY_REQUIRED", "ChatGPT rejected the graceful quit request");
    }
  }

  async waitForExit(process: DesktopProcessIdentity, timeoutMs: number): Promise<boolean> {
    const targets = this.#quiescenceSets.get(process.pid) ?? [
      { pid: process.pid, parentPid: 0, command: process.executablePath },
    ];
    const deadline = Date.now() + boundedTimeout(timeoutMs);
    while (Date.now() <= deadline) {
      const rows = await this.#processRows();
      const live = new Map(rows.map((row) => [row.pid, row.command]));
      if (targets.every((target) => live.get(target.pid) !== target.command)) {
        this.#quiescenceSets.delete(process.pid);
        return true;
      }
      await Bun.sleep(100);
    }
    return false;
  }

  launch(input: {
    readonly executablePath: string;
    readonly environment: Readonly<Record<string, string>>;
  }): Promise<DesktopProcessIdentity> {
    const child = Bun.spawn([input.executablePath], {
      env: { ...input.environment },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    child.unref();
    return Promise.resolve({ pid: child.pid, executablePath: input.executablePath });
  }

  async waitForExactProcess(
    executablePath: string,
    expectedPid: number,
    timeoutMs: number,
  ): Promise<DesktopProcessIdentity | null> {
    const deadline = Date.now() + boundedTimeout(timeoutMs);
    while (Date.now() <= deadline) {
      const exact = await this.listExact(executablePath);
      const match = exact.find((process) => process.pid === expectedPid);
      if (match !== undefined) return match;
      await Bun.sleep(100);
    }
    return null;
  }

  async #processRows(): Promise<readonly ProcessRow[]> {
    const result = await this.#runner.run(
      ["/bin/ps", "-axo", "pid=,ppid=,command="],
      10_000,
    );
    if (result.exitCode !== 0) {
      throw new DesktopSwitchError("CAPABILITY_MISSING", "could not inspect desktop processes");
    }
    const rows: ProcessRow[] = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        throw new DesktopSwitchError("CAPABILITY_MISSING", "process listing format changed");
      }
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(parentPid) || parentPid < 0) {
        throw new DesktopSwitchError("CAPABILITY_MISSING", "process listing contained an invalid PID");
      }
      rows.push({ pid, parentPid, command: match[3] });
      if (rows.length > 100_000) {
        throw new DesktopSwitchError("CAPABILITY_MISSING", "process listing exceeded its limit");
      }
    }
    return rows;
  }
}

function descendantsIncluding(rows: readonly ProcessRow[], root: ProcessRow): readonly ProcessRow[] {
  const output = [root];
  const found = new Set([root.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!found.has(row.pid) && found.has(row.parentPid)) {
        found.add(row.pid);
        output.push(row);
        changed = true;
      }
    }
  }
  return output;
}

function boundedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new DesktopSwitchError("CAPABILITY_MISSING", "desktop process timeout is invalid");
  }
  return value;
}
