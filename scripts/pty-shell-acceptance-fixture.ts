import type { CommandResponse, LocalCommand } from "../src/domain/contracts";
import { runPersistentShell } from "../src/cli";

const accountId = `acct_${"1".repeat(32)}`;
const sessionId = `sess_${"2".repeat(32)}`;
const messages: string[] = [];
let watchStarted = false;

const success = (data: unknown): CommandResponse => ({
  data,
  ok: true,
  requestId: crypto.randomUUID(),
  version: 1,
});

const callDaemon = (command: LocalCommand, signal?: AbortSignal): Promise<CommandResponse> => {
  if (command.kind === "daemon.status") {
    return Promise.resolve(success({
      daemon: {
        bootId: `boot_${"3".repeat(32)}`,
        generation: 1,
        nonce: "10000000-0000-4000-8000-000000000001",
        pid: process.pid,
        protocol: "hra-control-plane-local-v2",
      },
      running: true,
    }));
  }
  if (command.kind === "account.show") {
    return Promise.resolve(success({ account: { id: accountId } }));
  }
  if (command.kind === "session.status") {
    return Promise.resolve(success({ version: 1, session: { id: sessionId, profileId: accountId } }));
  }
  if (command.kind === "session.interactions") {
    return Promise.resolve(success({ sessionId, interactions: [], nextCursor: null }));
  }
  if (command.kind === "session.events") {
    if (!watchStarted) {
      watchStarted = true;
      process.stdout.write("WATCH_STARTED\n");
    }
    return new Promise<CommandResponse>((_resolve, reject) => {
      const abort = () => reject(
        signal?.reason ?? new DOMException("Deterministic watch stopped.", "AbortError"),
      );
      if (signal?.aborted === true) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  if (command.kind === "session.send") {
    messages.push(command.message);
    return Promise.resolve(success({ sent: true }));
  }
  throw new Error(`Unexpected deterministic PTY fixture command: ${command.kind}`);
};

const exitCode = await runPersistentShell(undefined, {
  callDaemon,
  interactive: true,
});
if (exitCode !== 0) throw new Error(`The deterministic PTY shell exited with ${String(exitCode)}.`);
if (
  messages.length !== 3
  || messages[0] !== "/slash-one"
  || messages[1] !== "/slash-two"
  || messages[2] !== "/after-watch"
) {
  throw new Error("The deterministic PTY shell did not preserve exact leading-slash messages across watch cancellation.");
}
process.stdout.write("Deterministic PTY shell preserved // and /send payloads across watch cancellation.\n");
