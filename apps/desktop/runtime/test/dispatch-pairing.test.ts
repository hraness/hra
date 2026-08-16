import { afterEach, describe, expect, test } from "bun:test";
import {
  agentPresetScopes,
  createBearerSecret,
  createLocator,
  createOpaqueId,
  formatCredentialToken,
  parseCredentialToken,
} from "@hraness/agent-tasks-protocol";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DispatchPairingError,
  loadPairedDispatchAuthorization,
  parseDispatchRepositoryMappings,
  recoverPairedDispatchAuthorization,
} from "../src/dispatch/pairing";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => {
    await rm(path, { force: true, recursive: true });
  }));
});

function bytes(length: number, value: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

async function writePairingFixture(input: {
  readonly root: string;
  readonly credential: string;
  readonly sessionExpiresAt: number;
  readonly sessionId: string;
}): Promise<{ readonly credentialFile: string; readonly profileFile: string }> {
  const credentialFile = join(input.root, "credentials.json");
  const profileFile = join(input.root, "profile.json");
  const parsedCredential = parseCredentialToken(input.credential);
  if (parsedCredential === null) throw new Error("credential fixture is invalid");
  await writeFile(profileFile, JSON.stringify({
    version: 1,
    apiUrl: "http://127.0.0.1:3211",
    agentId: `agt_${createLocator(bytes(26, 4))}`,
    scopes: agentPresetScopes.dispatcher,
  }), { mode: 0o600 });
  await writeFile(`${credentialFile}.metadata`, JSON.stringify({
    version: 1,
    state: "active",
    secretStore: "keychain",
    credentialLocator: parsedCredential.locator,
    sessionId: input.sessionId,
    sessionExpiresAt: input.sessionExpiresAt,
  }), { mode: 0o600 });
  return { credentialFile, profileFile };
}

describe("desktop dispatch pairing", () => {
  test("loads a dispatcher session from taskctl metadata and keychain custody", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-pairing-"));
    temporaryRoots.push(root);
    const credentialFile = join(root, "credentials.json");
    const profileFile = join(root, "profile.json");
    const credential = formatCredentialToken(
      createLocator(bytes(26, 1)),
      createBearerSecret(bytes(32, 2)),
    );
    const parsedCredential = parseCredentialToken(credential);
    if (parsedCredential === null) throw new Error("credential fixture is invalid");
    const sessionId = createOpaqueId("ses", bytes(26, 3));
    await writeFile(profileFile, JSON.stringify({
      version: 1,
      apiUrl: "http://127.0.0.1:3211",
      agentId: `agt_${createLocator(bytes(26, 4))}`,
      scopes: agentPresetScopes.dispatcher,
    }), { mode: 0o600 });
    await writeFile(`${credentialFile}.metadata`, JSON.stringify({
      version: 1,
      state: "active",
      secretStore: "keychain",
      credentialLocator: parsedCredential.locator,
      sessionId,
      sessionExpiresAt: 2_000,
    }), { mode: 0o600 });
    const keychainReads: Array<{ service: string; name: string }> = [];

    expect(await loadPairedDispatchAuthorization({
      environment: {
        TASKCTL_CREDENTIAL_FILE: credentialFile,
        TASKCTL_PROFILE_FILE: profileFile,
      },
      now: 1_000,
      secrets: {
        get: (input) => {
          keychainReads.push(input);
          return Promise.resolve(credential);
        },
      },
    })).toEqual({
      apiOrigin: "http://127.0.0.1:3211",
      credential,
      sessionId,
    });
    expect(keychainReads).toEqual([{
      service: "com.jungle.taskctl",
      name: `agent:${credentialFile}`,
    }]);
  });

  test("fails closed for expired sessions and file-backed credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-pairing-"));
    temporaryRoots.push(root);
    const credentialFile = join(root, "credentials.json");
    const profileFile = join(root, "profile.json");
    await writeFile(profileFile, JSON.stringify({
      version: 1,
      apiUrl: "http://127.0.0.1:3211",
      agentId: `agt_${createLocator(bytes(26, 5))}`,
      scopes: agentPresetScopes.dispatcher,
    }), { mode: 0o600 });
    await writeFile(`${credentialFile}.metadata`, JSON.stringify({
      version: 1,
      state: "active",
      secretStore: "file",
      credentialLocator: createLocator(bytes(26, 6)),
      sessionId: createOpaqueId("ses", bytes(26, 7)),
      sessionExpiresAt: 900,
    }), { mode: 0o600 });

    expect(loadPairedDispatchAuthorization({
      environment: {
        TASKCTL_CREDENTIAL_FILE: credentialFile,
        TASKCTL_PROFILE_FILE: profileFile,
      },
      now: 1_000,
      secrets: { get: () => Promise.resolve(null) },
    })).rejects.toBeInstanceOf(DispatchPairingError);
  });

  test("recovers an expired local session from the keychain credential and persists it", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-pairing-"));
    temporaryRoots.push(root);
    const credential = formatCredentialToken(
      createLocator(bytes(26, 10)),
      createBearerSecret(bytes(32, 11)),
    );
    const expiredSessionId = createOpaqueId("ses", bytes(26, 12));
    const refreshedSessionId = createOpaqueId("ses", bytes(26, 13));
    const paths = await writePairingFixture({
      root,
      credential,
      sessionId: expiredSessionId,
      sessionExpiresAt: 900,
    });
    const attempts: string[] = [];
    const options = {
      environment: {
        TASKCTL_CREDENTIAL_FILE: paths.credentialFile,
        TASKCTL_PROFILE_FILE: paths.profileFile,
      },
      now: 1_000,
      random: { bytes: (length: number) => bytes(length, 14) },
      secrets: { get: () => Promise.resolve(credential) },
    } as const;

    expect(await recoverPairedDispatchAuthorization({
      ...options,
      sessionStarter: {
        startSession: (input) => {
          attempts.push(input.idempotencyKey);
          return Promise.resolve({
            ok: true as const,
            data: { sessionId: refreshedSessionId, expiresAt: 120_000 },
            requestId: createOpaqueId("req", bytes(26, 15)),
          });
        },
      },
    })).toEqual({
      apiOrigin: "http://127.0.0.1:3211",
      credential,
      sessionId: refreshedSessionId,
    });
    expect(attempts).toHaveLength(1);
    expect(stat(`${paths.credentialFile}.session-attempt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(`${paths.credentialFile}.metadata`)).mode & 0o777).toBe(0o600);
    const persisted = await readFile(`${paths.credentialFile}.metadata`, "utf8");
    expect(JSON.parse(persisted)).toEqual({
      version: 1,
      state: "active",
      secretStore: "keychain",
      credentialLocator: parseCredentialToken(credential)?.locator,
      sessionId: refreshedSessionId,
      sessionExpiresAt: 120_000,
    });
    expect(persisted).not.toContain(credential);

    expect(await recoverPairedDispatchAuthorization({
      ...options,
      now: 2_000,
      sessionStarter: {
        startSession: () => {
          throw new Error("a persisted refreshed session must survive restart");
        },
      },
    })).toMatchObject({ sessionId: refreshedSessionId });
  });

  test("fails closed when the service rejects a revoked or invalid credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-pairing-"));
    temporaryRoots.push(root);
    const credential = formatCredentialToken(
      createLocator(bytes(26, 16)),
      createBearerSecret(bytes(32, 17)),
    );
    const paths = await writePairingFixture({
      root,
      credential,
      sessionId: createOpaqueId("ses", bytes(26, 18)),
      sessionExpiresAt: 900,
    });

    expect(recoverPairedDispatchAuthorization({
      environment: {
        TASKCTL_CREDENTIAL_FILE: paths.credentialFile,
        TASKCTL_PROFILE_FILE: paths.profileFile,
      },
      now: 1_000,
      random: { bytes: (length) => bytes(length, 19) },
      secrets: { get: () => Promise.resolve(credential) },
      sessionStarter: {
        startSession: () => Promise.resolve({
          ok: false as const,
          error: {
            kind: "remote" as const,
            code: "AUTHENTICATION_FAILED" as const,
            requestId: createOpaqueId("req", bytes(26, 20)),
          },
        }),
      },
    })).rejects.toThrow("did not authorize");
    const persisted = JSON.parse(
      await readFile(`${paths.credentialFile}.metadata`, "utf8"),
    ) as { sessionId: string; sessionExpiresAt: number };
    expect(persisted).toMatchObject({
      sessionId: createOpaqueId("ses", bytes(26, 18)),
      sessionExpiresAt: 900,
    });
    expect(stat(`${paths.credentialFile}.session-attempt`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("replays an indeterminate session start with the same durable key", async () => {
    const root = await mkdtemp(join(tmpdir(), "oprte-pairing-"));
    temporaryRoots.push(root);
    const credential = formatCredentialToken(
      createLocator(bytes(26, 21)),
      createBearerSecret(bytes(32, 22)),
    );
    const paths = await writePairingFixture({
      root,
      credential,
      sessionId: createOpaqueId("ses", bytes(26, 23)),
      sessionExpiresAt: 900,
    });
    const observedKeys: string[] = [];
    const base = {
      environment: {
        TASKCTL_CREDENTIAL_FILE: paths.credentialFile,
        TASKCTL_PROFILE_FILE: paths.profileFile,
      },
      now: 1_000,
      random: { bytes: (length: number) => bytes(length, 24) },
      secrets: { get: () => Promise.resolve(credential) },
    } as const;
    expect(recoverPairedDispatchAuthorization({
      ...base,
      sessionStarter: {
        startSession: (input) => {
          observedKeys.push(input.idempotencyKey);
          return Promise.resolve({ ok: false as const, error: { kind: "network" as const } });
        },
      },
    })).rejects.toBeInstanceOf(DispatchPairingError);
    const storedAttempt = JSON.parse(
      await readFile(`${paths.credentialFile}.session-attempt`, "utf8"),
    ) as { idempotencyKey: string };

    const recovered = await recoverPairedDispatchAuthorization({
      ...base,
      sessionStarter: {
        startSession: (input) => {
          observedKeys.push(input.idempotencyKey);
          return Promise.resolve({
            ok: true as const,
            data: {
              sessionId: createOpaqueId("ses", bytes(26, 25)),
              expiresAt: 120_000,
            },
            requestId: createOpaqueId("req", bytes(26, 26)),
          });
        },
      },
    });
    expect(observedKeys).toEqual([storedAttempt.idempotencyKey, storedAttempt.idempotencyKey]);
    expect(recovered).toMatchObject({ sessionId: createOpaqueId("ses", bytes(26, 25)) });
  });

  test("accepts only unique opaque repository mappings with absolute local paths", () => {
    const repositoryId = `repo_${createLocator(bytes(26, 8))}`;
    expect(parseDispatchRepositoryMappings({
      HRA_RUNNER_REPOSITORIES: JSON.stringify([
        { repositoryId, repositoryPath: "/private/fixture/repository" },
      ]),
    })).toEqual([{ repositoryId, repositoryPath: "/private/fixture/repository" }]);
    expect(() => parseDispatchRepositoryMappings({
      HRA_RUNNER_REPOSITORIES: JSON.stringify([
        { repositoryId, repositoryPath: "/private/fixture/repository" },
        { repositoryId, repositoryPath: "/private/fixture/other" },
      ]),
    })).toThrow(DispatchPairingError);
    expect(() => parseDispatchRepositoryMappings({
      HRA_RUNNER_REPOSITORIES: JSON.stringify([
        { repositoryId, repositoryPath: "relative/repository" },
      ]),
    })).toThrow(DispatchPairingError);
  });
});
