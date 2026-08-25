import type { CommandResponse, LocalCommand } from "../src/domain/contracts";
import { runPersistentShell } from "../src/cli";

const accountId = `acct_${"1".repeat(32)}`;
const sessionId = `sess_${"2".repeat(32)}`;
const messages: string[] = [];

const success = (data: unknown): CommandResponse => ({
  data,
  ok: true,
  requestId: crypto.randomUUID(),
  version: 1,
});

const callDaemon = (command: LocalCommand): Promise<CommandResponse> => {
  if (command.kind === "daemon.status") {
    return Promise.resolve(success({
      daemon: {
        bootId: `boot_${"3".repeat(32)}`,
        generation: 1,
        nonce: "10000000-0000-4000-8000-000000000001",
        pid: process.pid,
        protocol: "hra-control-plane-local-v1",
      },
      running: true,
    }));
  }
  if (command.kind === "account.show") {
    return Promise.resolve(success({ account: { id: accountId } }));
  }
  if (command.kind === "session.status") {
    return Promise.resolve(success({ session: { id: sessionId, profileId: accountId } }));
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
if (messages.length !== 2 || messages[0] !== "/slash-one" || messages[1] !== "/slash-two") {
  throw new Error("The deterministic PTY shell did not preserve exact leading-slash messages.");
}
process.stdout.write("Deterministic PTY shell preserved // and /send payloads.\n");
