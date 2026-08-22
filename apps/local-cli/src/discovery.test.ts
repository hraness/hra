import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";

import {
  discoverFixedLocalObservationEndpoints,
  fixedLocalObservationPaths,
  type LocalDesktopProfile,
} from "./discovery";
import { createFakeHome } from "./test-support";

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) =>
    await new Promise<void>((resolve) => server.close(() => resolve()))
  ));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function createCandidate(
  profile: LocalDesktopProfile,
): Promise<ReturnType<typeof fixedLocalObservationPaths>> {
  const home = createFakeHome();
  homes.push(home);
  const paths = fixedLocalObservationPaths(home, profile);
  mkdirSync(dirname(paths.directory), { recursive: true, mode: 0o700 });
  mkdirSync(paths.directory, { mode: 0o700 });
  chmodSync(paths.directory, 0o700);
  writeFileSync(paths.capability, "A".repeat(43), { mode: 0o600 });
  chmodSync(paths.capability, 0o600);
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths.socket, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(paths.socket, 0o600);
  return paths;
}

describe("fixed local desktop discovery", () => {
  test("keeps production and source-development endpoints separate", async () => {
    const production = await createCandidate("production");
    expect(discoverFixedLocalObservationEndpoints(homes[0]!).map(({ profile }) => profile))
      .toEqual(["production"]);
    expect(production.directory).toContain("OPRTE");

    const development = await createCandidate("development");
    expect(discoverFixedLocalObservationEndpoints(homes[1]!).map(({ profile }) => profile))
      .toEqual(["development"]);
    expect(development.directory).toContain("HRA Source Development");
    expect(production.directory).not.toBe(development.directory);
  });

  test("rejects foreign ownership and non-private modes", async () => {
    const paths = await createCandidate("production");
    expect(discoverFixedLocalObservationEndpoints(homes[0]!, {
      expectedUid: (process.getuid?.() ?? 0) + 1,
    })).toEqual([]);
    chmodSync(paths.capability, 0o640);
    expect(discoverFixedLocalObservationEndpoints(homes[0]!)).toEqual([]);
    chmodSync(paths.capability, 0o600);
    chmodSync(paths.socket, 0o660);
    expect(discoverFixedLocalObservationEndpoints(homes[0]!)).toEqual([]);
  });

  test("rejects symbolic and hard-linked capability files", async () => {
    const paths = await createCandidate("development");
    unlinkSync(paths.capability);
    const target = join(homes[0]!, "capability-target");
    writeFileSync(target, "A".repeat(43), { mode: 0o600 });
    symlinkSync(target, paths.capability);
    expect(discoverFixedLocalObservationEndpoints(homes[0]!)).toEqual([]);
    unlinkSync(paths.capability);
    linkSync(target, paths.capability);
    expect(discoverFixedLocalObservationEndpoints(homes[0]!)).toEqual([]);
  });

  test("rejects wrong endpoint types and linked discovery directories", async () => {
    const paths = await createCandidate("production");
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    writeFileSync(paths.socket, "not a socket", { mode: 0o600 });
    expect(discoverFixedLocalObservationEndpoints(homes[0]!)).toEqual([]);
    unlinkSync(paths.socket);
    unlinkSync(paths.capability);
    rmSync(paths.directory, { recursive: true });
    const target = join(homes[0]!, "linked-directory");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, paths.directory);
    expect(discoverFixedLocalObservationEndpoints(homes[0]!)).toEqual([]);
  });
});
