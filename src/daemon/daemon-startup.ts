import { z } from "zod";

import type { CommandResponse } from "../domain/contracts";
import type { StatePaths } from "../storage/paths";
import {
  DAEMON_PROTOCOL,
  DaemonAuthoritySafetyError,
  DaemonLock,
  readDaemonAuthorityReceipt,
  type DaemonAuthorityReceipt,
} from "./daemon-lock";

export const daemonIdentitySchema = z.object({
  protocol: z.literal(DAEMON_PROTOCOL),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  generation: z.number().int().positive(),
  bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u),
}).strict();

export type DaemonIdentity = z.infer<typeof daemonIdentitySchema>;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const daemonStatusDataSchema = z.object({
  running: z.literal(true),
  daemon: daemonIdentitySchema,
}).passthrough();

export function identityFromReceipt(receipt: DaemonAuthorityReceipt): DaemonIdentity | null {
  if (receipt.generation === undefined || receipt.bootId === undefined) return null;
  return daemonIdentitySchema.parse({
    protocol: receipt.protocol,
    pid: receipt.pid,
    nonce: receipt.nonce,
    generation: receipt.generation,
    bootId: receipt.bootId,
  });
}

export function daemonStatusIdentity(response: CommandResponse): DaemonIdentity {
  if (!response.ok) throw new Error(response.error.message);
  return daemonStatusDataSchema.parse(response.data).daemon;
}

export function sameDaemonIdentity(left: DaemonIdentity, right: DaemonIdentity): boolean {
  return left.pid === right.pid
    && left.nonce === right.nonce
    && left.generation === right.generation
    && left.bootId === right.bootId;
}

type StartupChildObservation = Readonly<{
  pid: number;
  exited: boolean;
  exitCode?: number;
  diagnostic?: string;
}>;

type DaemonStartupChild = Readonly<{
  exited: Promise<number>;
  kill(signal: "SIGKILL" | "SIGTERM"): unknown;
}>;

const waitForStartupChildExit = async (
  child: DaemonStartupChild,
  deadlineMs: number,
): Promise<boolean> => await Promise.race([
  child.exited.then(() => true, () => false),
  Bun.sleep(deadlineMs).then(() => false),
]);

export async function terminateDaemonStartupChild(
  child: DaemonStartupChild,
  input: Readonly<{
    deadlineMs?: number;
    waitForExit?: (child: DaemonStartupChild, deadlineMs: number) => Promise<boolean>;
  }> = {},
): Promise<void> {
  const deadlineMs = input.deadlineMs ?? 2_000;
  const waitForExit = input.waitForExit ?? waitForStartupChildExit;
  const signalErrors: unknown[] = [];
  try {
    child.kill("SIGTERM");
  } catch (error: unknown) {
    signalErrors.push(error);
  }
  if (await waitForExit(child, deadlineMs)) return;
  try {
    child.kill("SIGKILL");
  } catch (error: unknown) {
    signalErrors.push(error);
  }
  if (await waitForExit(child, deadlineMs)) return;
  const unreaped = new Error("The failed daemon child could not be reaped after forced termination.");
  if (signalErrors.length === 0) throw unreaped;
  throw new AggregateError(
    [...signalErrors, unreaped],
    "The failed daemon child could not be reaped and one or more exact signals failed.",
  );
}

export async function waitForDaemonReady(input: {
  paths: StatePaths;
  queryStatus: () => Promise<CommandResponse>;
  observeChild?: () => StartupChildObservation;
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<DaemonIdentity> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const startedAt = now();
  const deadline = startedAt + (input.deadlineMs ?? 30_000);
  let lastError: unknown;
  let lastReceipt: DaemonAuthorityReceipt | null = null;
  while (now() <= deadline) {
    try {
      lastReceipt = await readDaemonAuthorityReceipt(input.paths);
      if (lastReceipt?.state === "failed") {
        const child = input.observeChild?.();
        const currentFailure = child?.pid === lastReceipt.pid
          || lastReceipt.updatedAt > startedAt
          || (startedAt - lastReceipt.updatedAt <= 30_000 && processIsAlive(lastReceipt.pid));
        if (currentFailure) {
          throw new Error(`The HRA daemon failed during startup: ${lastReceipt.failure ?? "unknown failure"}`);
        }
      }
      if (lastReceipt?.state === "ready") {
        const receiptIdentity = identityFromReceipt(lastReceipt);
        if (receiptIdentity === null) throw new Error("The ready daemon receipt lacks an authority identity.");
        try {
          const statusIdentity = daemonStatusIdentity(await input.queryStatus());
          if (!sameDaemonIdentity(receiptIdentity, statusIdentity)) {
            lastError = new Error("The daemon status did not match the published startup authority.");
          } else {
            return statusIdentity;
          }
        } catch (error: unknown) {
          lastError = error;
        }
      }
      const child = input.observeChild?.();
      if (child?.exited === true) {
        const anotherBootIsLive = lastReceipt !== null
          && (lastReceipt.state === "booting" || lastReceipt.state === "ready")
          && lastReceipt.pid !== child.pid
          && await DaemonLock.isAuthorityHeld(input.paths);
        if (!anotherBootIsLive) {
          const suffix = child.diagnostic === undefined || child.diagnostic.length === 0 ? "" : `: ${child.diagnostic}`;
          throw new Error(`The HRA daemon process exited with status ${child.exitCode ?? "unknown"}${suffix}`);
        }
      }
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      if (error instanceof Error && /failed during startup|process exited/iu.test(error.message)) throw error;
      lastError = error;
    }
    await sleep(input.pollMs ?? 50);
  }
  const state = lastReceipt === null ? "no startup receipt" : `${lastReceipt.state} receipt for pid ${lastReceipt.pid}`;
  const diagnostic = lastError instanceof Error ? ` Last observation: ${lastError.message}` : "";
  throw new Error(`The HRA daemon did not become ready before the startup deadline (${state}).${diagnostic}`);
}

export async function waitForDaemonAuthorityRelease(input: {
  paths: StatePaths;
  expected: DaemonIdentity;
  deadlineMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<{ replacement: DaemonIdentity | null; finalReceipt: DaemonAuthorityReceipt | null }> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? (async (milliseconds: number) => { await Bun.sleep(milliseconds); });
  const deadline = now() + (input.deadlineMs ?? 10_000);
  while (now() <= deadline) {
    const receipt = await readDaemonAuthorityReceipt(input.paths);
    if (receipt !== null && receipt.nonce !== input.expected.nonce) {
      return { replacement: identityFromReceipt(receipt), finalReceipt: receipt };
    }
    if (!await DaemonLock.isAuthorityHeld(input.paths)) {
      const finalReceipt = await readDaemonAuthorityReceipt(input.paths);
      if (finalReceipt !== null && finalReceipt.nonce !== input.expected.nonce) {
        return { replacement: identityFromReceipt(finalReceipt), finalReceipt };
      }
      return { replacement: null, finalReceipt };
    }
    await sleep(input.pollMs ?? 25);
  }
  throw new Error(`Daemon pid ${input.expected.pid} did not release authority generation ${input.expected.generation} before the shutdown deadline.`);
}
