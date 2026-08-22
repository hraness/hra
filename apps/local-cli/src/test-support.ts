import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fixedLocalObservationPaths, type LocalDesktopProfile } from "./discovery";

export interface FakeLocalRuntime {
  readonly home: string;
  readonly close: () => Promise<void>;
}

export function createFakeHome(): string {
  return mkdtempSync(join(tmpdir(), "hra-local-cli-"));
}

function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startFakeLocalRuntime(options: Readonly<{
  home: string;
  profile: LocalDesktopProfile;
  capability?: string;
  response: (requestText: string, socket: Socket) => unknown;
}>): Promise<FakeLocalRuntime> {
  const paths = fixedLocalObservationPaths(options.home, options.profile);
  mkdirSync(dirname(paths.directory), { recursive: true, mode: 0o700 });
  mkdirSync(paths.directory, { mode: 0o700 });
  chmodSync(paths.directory, 0o700);
  writeFileSync(paths.capability, options.capability ?? "A".repeat(43), {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(paths.capability, 0o600);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      void Promise.resolve(options.response(text.slice(0, newline), socket)).then(
        (response) => {
          if (response !== undefined && !socket.destroyed) {
            socket.end(typeof response === "string" ? response : JSON.stringify(response));
          }
        },
        () => socket.destroy(),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(paths.socket, 0o600);
  return {
    home: options.home,
    close: async () => {
      await closeServer(server, sockets);
      rmSync(options.home, { recursive: true, force: true });
    },
  };
}
