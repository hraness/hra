import { describe, expect, test } from "bun:test";
import { createLocator, enrollmentTokenSchema } from "@hraness/agent-tasks-protocol";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RandomSource, StoragePaths } from "./config";
import {
  compareAndSwapHumanAuthentication,
  readHumanAuthentication,
  resolveHumanStoragePaths,
  writeHumanAuthentication,
  type HumanAuthentication,
  type HumanSecretStore,
} from "./human-config";
import { runCli } from "./index";
import type { CliIo } from "./output";

const REQUEST_ID = "req_00000000000000000000000000";
const IDEMPOTENCY_KEY = "018f22e2-7b44-7cc0-8e5d-657f31f9064a"; // gitleaks:allow - deterministic test vector
const random: RandomSource = (length) =>
  Uint8Array.from({ length }, (_, index) => (length + index * 11) % 256);

function captureIo(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      readStdin: () => Promise.resolve(""),
      stdinIsTTY: false,
    },
  };
}

function memoryKeychain(): HumanSecretStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  const key = (input: { readonly service: string; readonly name: string }): string =>
    `${input.service}:${input.name}`;
  return {
    values,
    get: (input) => Promise.resolve(values.get(key(input)) ?? null),
    set: (input) => {
      values.set(key(input), input.value);
      return Promise.resolve();
    },
    delete: (input) => Promise.resolve(values.delete(key(input))),
  };
}

function lostCleanupKeychain(): HumanSecretStore & {
  readonly values: Map<string, string>;
} {
  const base = memoryKeychain();
  let cleanupFailures = 1;
  return {
    values: base.values,
    get: async (input) => await base.get(input),
    set: async (input) => await base.set(input),
    delete: async (input) => {
      if (cleanupFailures > 0) {
        cleanupFailures -= 1;
        throw new Error("retired Keychain cleanup response was lost");
      }
      return await base.delete(input);
    },
  };
}

async function temporaryStorage(): Promise<{
  readonly directory: string;
  readonly paths: StoragePaths;
}> {
  const directory = await mkdtemp(join(tmpdir(), "taskctl-human-index-"));
  return {
    directory,
    paths: {
      credentialFile: join(directory, "credentials.json"),
      profileFile: join(directory, "profile.json"),
    },
  };
}

function inputUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url);
}

const organization = {
  id: "organization-1",
  name: "Hraness",
  role: "owner",
  status: "active",
} as const;

const workspace = {
  id: "workspace-1",
  organizationId: "organization-1",
  slug: "core",
  name: "Core",
  taskKeyPrefix: "OPS",
  roles: ["planner"],
} as const;

function accountAuthentication(): HumanAuthentication {
  return {
    version: 2,
    apiUrl: "http://127.0.0.1:3211",
    accessToken: "account-access-token-long-enough",
    refreshToken: "account-refresh-token-long-enough",
    user: { id: "user_abc123", email: "human@example.com" },
    organization,
  };
}

describe("human CLI", () => {
  test("logs in through browser pairing without exposing verifier or bearer secrets", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const captured = captureIo();
    const accessToken = "human-access-token-that-must-stay-secret";
    const refreshToken = "human-refresh-token-that-must-stay-secret";
    let verifier = "";
    let now = 1_000;
    let requestCount = 0;
    try {
      const exitCode = await runCli(
        ["auth", "login", "--no-browser", "--json"],
        {
          environment: {
            TASKCTL_API_URL: "http://127.0.0.1:3211",
            TASKCTL_WEB_URL: "https://hra.sh",
          },
          storagePaths: paths,
          humanSecretStore: keychain,
          io: captured.io,
          now: () => now,
          random,
          sleep: (milliseconds) => {
            now += milliseconds;
            return Promise.resolve();
          },
          fetch: (input, init) => {
            requestCount += 1;
            const url = inputUrl(input);
            if (url.pathname === "/v1/auth/desktop-pairings") {
              return Promise.resolve(
                Response.json({
                  ok: true,
                  data: {
                    pairingId: "pair_00000000000000000000000000",
                    verificationUri:
                      "https://hra.sh/pair/desktop/pair_00000000000000000000000000",
                    comparisonCode: "2345-6789",
                    expiresAt: 301_000,
                    pollIntervalMs: 1_000,
                  },
                  requestId: REQUEST_ID,
                }),
              );
            }
            const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
            if (typeof body !== "object" || body === null || !("verifier" in body)) {
              throw new Error("missing pairing verifier");
            }
            verifier = String(body.verifier);
            return Promise.resolve(
              Response.json({
                ok: true,
                data: {
                  status: "approved",
                  authentication: {
                    accessToken,
                    refreshToken,
                    user: { id: "user_abc123", email: "human@example.com" },
                    organization,
                    workspace: { ...workspace, roles: [...workspace.roles] },
                  },
                },
                requestId: REQUEST_ID,
              }),
            );
          },
        },
      );

      expect(exitCode).toBe(0);
      expect(requestCount).toBe(2);
      const allOutput = `${captured.stdout.join("")}\n${captured.stderr.join("")}`;
      expect(allOutput).toContain("2345-6789");
      expect(allOutput).not.toContain(verifier);
      expect(allOutput).not.toContain(accessToken);
      expect(allOutput).not.toContain(refreshToken);
      expect(JSON.parse(captured.stdout.join(""))).toMatchObject({
        authenticated: true,
        source: "keychain",
        user: { id: "user_abc123" },
      });
      expect(keychain.values.size).toBe(1);

      const status = captureIo();
      expect(
        await runCli(["auth", "status", "--json"], {
          environment: {},
          storagePaths: paths,
          humanSecretStore: keychain,
          io: status.io,
          random,
        }),
      ).toBe(0);
      expect(JSON.parse(status.stdout.join(""))).toMatchObject({
        human: { authenticated: true, source: "keychain" },
      });

      const logout = captureIo();
      expect(
        await runCli(["auth", "logout", "--json"], {
          environment: {},
          storagePaths: paths,
          humanSecretStore: keychain,
          io: logout.io,
          random,
        }),
      ).toBe(0);
      expect(JSON.parse(logout.stdout.join(""))).toMatchObject({
        loggedOut: true,
        humanLoggedOut: true,
      });
      expect(keychain.values.size).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("requires a pinned browser origin before pairing is displayed or opened", async () => {
    const { directory, paths } = await temporaryStorage();
    const captured = captureIo();
    let requests = 0;
    let opens = 0;
    try {
      expect(
        await runCli(["auth", "login", "--json"], {
          environment: { TASKCTL_API_URL: "http://127.0.0.1:3211" },
          storagePaths: paths,
          io: captured.io,
          random,
          fetch: () => {
            requests += 1;
            return Promise.reject(new Error("must not fetch"));
          },
          openBrowser: () => {
            opens += 1;
            return Promise.resolve();
          },
        }),
      ).toBe(2);
      expect(requests).toBe(0);
      expect(opens).toBe(0);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "VALIDATION_ERROR" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("quarantines local authority when organization selection loses its response", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    let selectionRequests = 0;
    try {
      await writeHumanAuthentication(humanPaths, accountAuthentication(), "keychain", random, keychain);
      const evidenceBefore = [...keychain.values.entries()];
      const exitCode = await runCli(["organization", "use", organization.id, "--json"], {
        environment: { TASKCTL_API_URL: "http://127.0.0.1:3211" },
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        now: () => 1_720_000_000_000,
        random,
        fetch: (input) => {
          const url = inputUrl(input);
          if (url.pathname === "/v1/organizations") {
            return Promise.resolve(
              Response.json({
                ok: true,
                data: { organizations: [organization], cursor: null },
                requestId: REQUEST_ID,
              }),
            );
          }
          selectionRequests += 1;
          return Promise.reject(new Error("lost after dispatch"));
        },
      });

      expect(exitCode).toBe(6);
      expect(selectionRequests).toBe(1);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "AUTH_REFRESH_INDETERMINATE" },
      });
      expect(await readHumanAuthentication(humanPaths, keychain)).toBeNull();
      expect([...keychain.values.entries()]).toEqual(evidenceBefore);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("quarantines both possible credentials when selected custody cannot commit", async () => {
    const { directory, paths } = await temporaryStorage();
    const baseKeychain = memoryKeychain();
    let sets = 0;
    const keychain: HumanSecretStore & { readonly values: Map<string, string> } = {
      values: baseKeychain.values,
      get: async (input) => await baseKeychain.get(input),
      set: async (input) => {
        sets += 1;
        await baseKeychain.set(input);
        if (sets === 2) throw new Error("injected lost Keychain write response");
      },
      delete: async (input) => await baseKeychain.delete(input),
    };
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    const selectedAccess = "selected-access-token-that-must-stay-secret";
    const selectedRefresh = "selected-refresh-token-that-must-stay-secret";
    try {
      await writeHumanAuthentication(humanPaths, accountAuthentication(), "keychain", random, keychain);
      const exitCode = await runCli(["organization", "use", organization.id, "--json"], {
        environment: {},
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        random,
        fetch: (input) => {
          const url = inputUrl(input);
          if (url.pathname === "/v1/organizations") {
            return Promise.resolve(Response.json({
              ok: true,
              data: { organizations: [organization], cursor: null },
              requestId: REQUEST_ID,
            }));
          }
          return Promise.resolve(Response.json({
            ok: true,
            data: {
              accessToken: selectedAccess,
              refreshToken: selectedRefresh,
              user: accountAuthentication().user,
              organization,
            },
            requestId: REQUEST_ID,
          }));
        },
      });

      expect(exitCode).toBe(6);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "AUTH_REFRESH_INDETERMINATE" },
      });
      expect(await readHumanAuthentication(humanPaths, keychain)).toBeNull();
      expect(keychain.values.size).toBe(2);
      expect([...keychain.values.values()].some((value) =>
        value.includes(selectedAccess) && value.includes(selectedRefresh)
      )).toBeTrue();
      expect(`${captured.stdout.join("")}\n${captured.stderr.join("")}`)
        .not.toContain(selectedAccess);
      expect(`${captured.stdout.join("")}\n${captured.stderr.join("")}`)
        .not.toContain(selectedRefresh);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("contains the committed selection when retired-slot cleanup throws", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = lostCleanupKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    const selectedAccess = "cleanup-selected-access-token-that-must-stay-secret";
    const selectedRefresh = "cleanup-selected-refresh-token-that-must-stay-secret";
    try {
      await writeHumanAuthentication(
        humanPaths,
        accountAuthentication(),
        "keychain",
        random,
        keychain,
      );
      const exitCode = await runCli(["organization", "use", organization.id, "--json"], {
        environment: {},
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        random,
        fetch: (input) => {
          const url = inputUrl(input);
          if (url.pathname === "/v1/organizations") {
            return Promise.resolve(Response.json({
              ok: true,
              data: { organizations: [organization], cursor: null },
              requestId: REQUEST_ID,
            }));
          }
          return Promise.resolve(Response.json({
            ok: true,
            data: {
              accessToken: selectedAccess,
              refreshToken: selectedRefresh,
              user: accountAuthentication().user,
              organization,
            },
            requestId: REQUEST_ID,
          }));
        },
      });

      expect(exitCode).toBe(6);
      expect(await readHumanAuthentication(humanPaths, keychain)).toBeNull();
      expect([...keychain.values.values()].some((source) =>
        source.includes(selectedAccess) && source.includes(selectedRefresh)
      )).toBeTrue();
      const rendered = `${captured.stdout.join("")}\n${captured.stderr.join("")}`;
      expect(rendered).not.toContain(selectedAccess);
      expect(rendered).not.toContain(selectedRefresh);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves exact Keychain bytes when refresh dispatch has an indeterminate outcome", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    try {
      await writeHumanAuthentication(
        humanPaths,
        accountAuthentication(),
        "keychain",
        random,
        keychain,
      );
      const evidenceBefore = [...keychain.values.entries()];
      const exitCode = await runCli(["workspace", "list", "--json"], {
        environment: {},
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        random,
        fetch: (input) => {
          const url = inputUrl(input);
          if (url.pathname === "/v1/auth/refresh") {
            return Promise.reject(new Error("refresh response lost after dispatch"));
          }
          return Promise.resolve(Response.json({
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Authentication failed.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, { status: 401 }));
        },
      });

      expect(exitCode).toBe(6);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: {
          code: "AUTH_REFRESH_INDETERMINATE",
        },
      });
      expect(captured.stderr.join("")).toContain("preserved for recovery");
      expect(await readHumanAuthentication(humanPaths, keychain)).toBeNull();
      expect([...keychain.values.entries()]).toEqual(evidenceBefore);
      const rendered = `${captured.stdout.join("")}\n${captured.stderr.join("")}`;
      expect(rendered).not.toContain(accountAuthentication().accessToken);
      expect(rendered).not.toContain(accountAuthentication().refreshToken);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("contains the committed successor when refresh cleanup loses its response", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = lostCleanupKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    const rotatedAccess = "cleanup-rotated-access-token-long-enough";
    const rotatedRefresh = "cleanup-rotated-refresh-token-long-enough";
    try {
      await writeHumanAuthentication(
        humanPaths,
        accountAuthentication(),
        "keychain",
        random,
        keychain,
      );
      const exitCode = await runCli(["workspace", "list", "--json"], {
        environment: {},
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        random,
        fetch: (input) => {
          const url = inputUrl(input);
          if (url.pathname === "/v1/auth/refresh") {
            return Promise.resolve(Response.json({
              ok: true,
              data: {
                accessToken: rotatedAccess,
                refreshToken: rotatedRefresh,
                user: accountAuthentication().user,
                organization,
              },
              requestId: REQUEST_ID,
            }));
          }
          return Promise.resolve(Response.json({
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Authentication failed.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, { status: 401 }));
        },
      });

      expect(exitCode).toBe(6);
      expect(await readHumanAuthentication(humanPaths, keychain)).toBeNull();
      expect([...keychain.values.values()].some((source) =>
        source.includes(rotatedAccess) && source.includes(rotatedRefresh)
      )).toBeTrue();
      expect(`${captured.stdout.join("")}\n${captured.stderr.join("")}`)
        .not.toContain(rotatedRefresh);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("contains a successfully refreshed credential rejected by the replay", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    const rotatedAccess = "replay-rejected-access-token-long-enough";
    const rotatedRefresh = "replay-rejected-refresh-token-long-enough";
    try {
      await writeHumanAuthentication(
        humanPaths,
        accountAuthentication(),
        "keychain",
        random,
        keychain,
      );
      const exitCode = await runCli(["workspace", "list", "--json"], {
        environment: {},
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        random,
        fetch: (input) => {
          const url = inputUrl(input);
          if (url.pathname === "/v1/auth/refresh") {
            return Promise.resolve(Response.json({
              ok: true,
              data: {
                accessToken: rotatedAccess,
                refreshToken: rotatedRefresh,
                user: accountAuthentication().user,
                organization,
              },
              requestId: REQUEST_ID,
            }));
          }
          return Promise.resolve(Response.json({
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Authentication failed.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, { status: 401 }));
        },
      });

      expect(exitCode).not.toBe(0);
      expect(JSON.parse(captured.stderr.join(""))).toMatchObject({
        error: { code: "AUTHENTICATION_FAILED" },
      });
      expect(await readHumanAuthentication(humanPaths, keychain)).toBeNull();
      expect([...keychain.values.values()].some((source) =>
        source.includes(rotatedAccess) && source.includes(rotatedRefresh)
      )).toBeTrue();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("replay rejection never contains a concurrently selected newer winner", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    const rotatedAccess = "concurrent-refresh-access-token-long-enough";
    const rotatedRefresh = "concurrent-refresh-token-long-enough";
    let workspaceRequests = 0;
    let selectedWinner: HumanAuthentication | null = null;
    try {
      await writeHumanAuthentication(
        humanPaths,
        accountAuthentication(),
        "keychain",
        random,
        keychain,
      );
      const exitCode = await runCli(["workspace", "list", "--json"], {
        environment: {},
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        random,
        fetch: async (input) => {
          const url = inputUrl(input);
          if (url.pathname === "/v1/auth/refresh") {
            return Response.json({
              ok: true,
              data: {
                accessToken: rotatedAccess,
                refreshToken: rotatedRefresh,
                user: accountAuthentication().user,
                organization,
              },
              requestId: REQUEST_ID,
            });
          }
          workspaceRequests += 1;
          if (workspaceRequests === 2) {
            const refreshed = await readHumanAuthentication(humanPaths, keychain);
            if (refreshed === null) throw new Error("refreshed credential disappeared");
            const nextWinner: HumanAuthentication = {
              ...refreshed.authentication,
              accessToken: "concurrent-selection-access-token-long-enough",
              refreshToken: "concurrent-selection-refresh-token-long-enough",
              workspace: {
                ...workspace,
                roles: [...workspace.roles],
              },
            };
            const replaced = await compareAndSwapHumanAuthentication(
              humanPaths,
              refreshed,
              nextWinner,
              random,
              keychain,
            );
            if (replaced === null) throw new Error("concurrent selection lost unexpectedly");
            selectedWinner = nextWinner;
          }
          return Response.json({
            error: {
              code: "AUTHENTICATION_FAILED",
              message: "Authentication failed.",
              requestId: REQUEST_ID,
              details: {},
            },
          }, { status: 401 });
        },
      });

      expect(exitCode).not.toBe(0);
      if (selectedWinner === null) throw new Error("selected winner was not committed");
      expect((await readHumanAuthentication(humanPaths, keychain))?.authentication)
        .toEqual(selectedWinner);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rotates once after an expired access token and retries the authorized read", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const captured = captureIo();
    const rotatedAccess = "rotated-human-access-token-long-enough";
    const rotatedRefresh = "rotated-human-refresh-token-long-enough";
    const authorizations: string[] = [];
    let workspaceRequests = 0;
    let refreshRequests = 0;
    try {
      await writeHumanAuthentication(
        humanPaths,
        {
          ...accountAuthentication(),
        },
        "keychain",
        random,
        keychain,
      );
      const exitCode = await runCli(["workspace", "list", "--json"], {
        environment: {},
        storagePaths: paths,
        humanSecretStore: keychain,
        io: captured.io,
        random,
        fetch: (input, init) => {
          const url = inputUrl(input);
          const authorization = new Headers(init?.headers).get("Authorization");
          if (authorization !== null) authorizations.push(authorization);
          if (url.pathname === "/v1/auth/refresh") {
            refreshRequests += 1;
            return Promise.resolve(
              Response.json({
                ok: true,
                data: {
                  accessToken: rotatedAccess,
                  refreshToken: rotatedRefresh,
                  user: { id: "user_abc123", email: "human@example.com" },
                  organization,
                },
                requestId: REQUEST_ID,
              }),
            );
          }
          workspaceRequests += 1;
          if (workspaceRequests === 1) {
            return Promise.resolve(
              Response.json(
                {
                  error: {
                    code: "AUTHENTICATION_FAILED",
                    message: "Authentication failed.",
                    requestId: REQUEST_ID,
                    details: {},
                  },
                },
                { status: 401 },
              ),
            );
          }
          return Promise.resolve(
            Response.json({
              ok: true,
              data: { workspaces: [workspace], cursor: null },
              requestId: REQUEST_ID,
            }),
          );
        },
      });

      expect(exitCode).toBe(0);
      expect(refreshRequests).toBe(1);
      expect(workspaceRequests).toBe(2);
      expect(authorizations).toEqual([
        "Bearer account-access-token-long-enough",
        "Bearer account-refresh-token-long-enough",
        `Bearer ${rotatedAccess}`,
      ]);
      expect((await readHumanAuthentication(humanPaths, keychain))?.authentication).toMatchObject({
        accessToken: rotatedAccess,
        refreshToken: rotatedRefresh,
        organization,
      });
      expect(captured.stdout.join("")).not.toContain(rotatedAccess);
      expect(captured.stderr.join("")).not.toContain(rotatedRefresh);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("selects a workspace and creates an agent with enrollment only in the explicit file", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const enrollmentOut = join(directory, "enrollments", "builder.token");
    const selectedCaptured = captureIo();
    const createdCaptured = captureIo();
    let enrollmentFromRequest: string | undefined;
    try {
      await writeHumanAuthentication(
        humanPaths,
        {
          ...accountAuthentication(),
        },
        "keychain",
        random,
        keychain,
      );
      const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = inputUrl(input);
        if (url.pathname === "/v1/workspaces") {
          return Promise.resolve(
            Response.json({
              ok: true,
              data: { workspaces: [workspace], cursor: null },
              requestId: REQUEST_ID,
            }),
          );
        }
        if (url.pathname === "/v1/auth/selection") {
          return Promise.resolve(
            Response.json({
              ok: true,
              data: {
                accessToken: "workspace-access-token-long-enough",
                refreshToken: "workspace-refresh-token-long-enough",
                user: accountAuthentication().user,
                organization,
                workspace: { ...workspace, roles: [...workspace.roles] },
              },
              requestId: REQUEST_ID,
            }),
          );
        }
        const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
        if (typeof body !== "object" || body === null || !("enrollment" in body)) {
          throw new Error("missing enrollment");
        }
        enrollmentFromRequest = String(body.enrollment);
        return Promise.resolve(
          Response.json({
            ok: true,
            data: {
              agent: {
                id: "agent-1",
                workspaceId: workspace.id,
                name: "Builder",
                status: "active",
                scopes: ["tasks:read", "tasks:claim"],
              },
              enrollment: {
                locator: enrollmentFromRequest.slice(4, 30),
                expiresAt: 1_800_000_000_000,
              },
            },
            requestId: REQUEST_ID,
          }),
        );
      };

      expect(
        await runCli(["workspace", "use", workspace.id, "--json"], {
          environment: {},
          storagePaths: paths,
          humanSecretStore: keychain,
          io: selectedCaptured.io,
          random,
          fetch,
        }),
      ).toBe(0);
      expect(
        await runCli(
          [
            "agent",
            "create",
            "--name",
            "Builder",
            "--preset",
            "worker",
            "--scopes",
            "tasks:read,tasks:claim",
            "--enrollment-out",
            enrollmentOut,
            "--idempotency-key",
            IDEMPOTENCY_KEY,
            "--json",
          ],
          {
            environment: {},
            storagePaths: paths,
            humanSecretStore: keychain,
            io: createdCaptured.io,
            random,
            fetch,
          },
        ),
      ).toBe(0);

      if (enrollmentFromRequest === undefined) throw new Error("enrollment was not captured");
      expect(enrollmentTokenSchema.safeParse(enrollmentFromRequest).success).toBeTrue();
      expect(await readFile(enrollmentOut, "utf8")).toBe(`${enrollmentFromRequest}\n`);
      expect((await stat(enrollmentOut)).mode & 0o777).toBe(0o600);
      const output = createdCaptured.stdout.join("");
      expect(output).not.toContain(enrollmentFromRequest);
      expect(output).toContain(enrollmentOut);
      expect(JSON.parse(output)).toMatchObject({
        agent: { id: "agent-1" },
        enrollmentOut,
        idempotencyKey: IDEMPOTENCY_KEY,
      });

      const recoveredCaptured = captureIo();
      expect(
        await runCli(
          [
            "agent",
            "create",
            "--name",
            "Builder",
            "--preset",
            "worker",
            "--scopes",
            "tasks:read,tasks:claim",
            "--enrollment-out",
            enrollmentOut,
            "--idempotency-key",
            IDEMPOTENCY_KEY,
            "--json",
          ],
          {
            environment: {},
            storagePaths: paths,
            humanSecretStore: keychain,
            io: recoveredCaptured.io,
            random,
            fetch,
          },
        ),
      ).toBe(0);
      expect(await readFile(enrollmentOut, "utf8")).toBe(`${enrollmentFromRequest}\n`);
      expect(recoveredCaptured.stdout.join("")).not.toContain(enrollmentFromRequest);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("administers an existing agent within the authoritative selected workspace", async () => {
    const { directory, paths } = await temporaryStorage();
    const keychain = memoryKeychain();
    const humanPaths = resolveHumanStoragePaths({}, paths);
    const enrollmentOut = join(directory, "enrollments", "agent-1.token");
    const credentialId = createLocator(new Uint8Array(26));
    const agent = {
      id: "agent-1",
      workspaceId: workspace.id,
      name: "Builder",
      scopes: ["tasks:read", "tasks:claim"],
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    } as const;
    const requests: { readonly url: URL; readonly init?: RequestInit }[] = [];
    let issuedEnrollment: string | undefined;
    try {
      await writeHumanAuthentication(
        humanPaths,
        {
          ...accountAuthentication(),
          workspace: { ...workspace, roles: [...workspace.roles] },
        },
        "keychain",
        random,
        keychain,
      );
      const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = inputUrl(input);
        requests.push({ url, ...(init === undefined ? {} : { init }) });
        const method = init?.method ?? "GET";
        const path = url.pathname;
        if (method === "GET" && path === "/v1/agents") {
          return Promise.resolve(
            Response.json({ ok: true, data: { agents: [agent], cursor: null }, requestId: REQUEST_ID }),
          );
        }
        if (method === "GET" && path === `/v1/agents/${agent.id}`) {
          return Promise.resolve(Response.json({ ok: true, data: { agent }, requestId: REQUEST_ID }));
        }
        if (method === "POST" && path === `/v1/agents/${agent.id}/enrollments`) {
          const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
          if (typeof body !== "object" || body === null || !("enrollment" in body)) {
            throw new Error("missing enrollment");
          }
          issuedEnrollment = String(body.enrollment);
          return Promise.resolve(
            Response.json({
              ok: true,
              data: { enrollment: { locator: issuedEnrollment.slice(4, 30), expiresAt: 100 } },
              requestId: REQUEST_ID,
            }),
          );
        }
        if (method === "GET" && path === `/v1/agents/${agent.id}/credentials`) {
          return Promise.resolve(
            Response.json({
              ok: true,
              data: {
                credentials: [
                  {
                    id: credentialId,
                    agentId: agent.id,
                    workspaceId: workspace.id,
                    scopes: agent.scopes,
                    status: "active",
                    createdAt: 1,
                    expiresAt: 100,
                    lastUsedAt: 2,
                  },
                ],
                cursor: null,
              },
              requestId: REQUEST_ID,
            }),
          );
        }
        if (
          method === "POST" &&
          path === `/v1/agents/${agent.id}/credentials/${credentialId}/revoke`
        ) {
          return Promise.resolve(
            Response.json({
              ok: true,
              data: {
                credential: {
                  id: credentialId,
                  agentId: agent.id,
                  workspaceId: workspace.id,
                  scopes: agent.scopes,
                  status: "revoked",
                  createdAt: 1,
                  expiresAt: 100,
                  lastUsedAt: 2,
                  revokedAt: 3,
                },
              },
              requestId: REQUEST_ID,
            }),
          );
        }
        if (method === "GET" && path === `/v1/agents/${agent.id}/sessions`) {
          return Promise.resolve(
            Response.json({
              ok: true,
              data: {
                sessions: [
                  {
                    agentId: agent.id,
                    workspaceId: workspace.id,
                    credentialId,
                    status: "active",
                    createdAt: 1,
                    lastSeenAt: 2,
                    idleExpiresAt: 100,
                  },
                ],
                cursor: null,
              },
              requestId: REQUEST_ID,
            }),
          );
        }
        if (method === "POST" && path === `/v1/agents/${agent.id}/disable`) {
          return Promise.resolve(
            Response.json({
              ok: true,
              data: { agent: { ...agent, status: "disabled", updatedAt: 4 } },
              requestId: REQUEST_ID,
            }),
          );
        }
        throw new Error(`unexpected request: ${method} ${path}`);
      };

      const outputs: string[] = [];
      const runAdmin = async (argv: readonly string[]): Promise<void> => {
        const captured = captureIo();
        expect(
          await runCli([...argv, "--json"], {
            environment: {},
            storagePaths: paths,
            humanSecretStore: keychain,
            io: captured.io,
            random,
            fetch,
          }),
        ).toBe(0);
        expect(captured.stderr).toEqual([]);
        outputs.push(captured.stdout.join(""));
      };

      await runAdmin(["agent", "list"]);
      await runAdmin(["agent", "show", agent.id]);
      await runAdmin([
        "agent",
        "enrollment",
        "create",
        agent.id,
        "--enrollment-out",
        enrollmentOut,
        "--idempotency-key",
        IDEMPOTENCY_KEY,
      ]);
      await runAdmin([
        "agent",
        "enrollment",
        "create",
        agent.id,
        "--enrollment-out",
        enrollmentOut,
        "--idempotency-key",
        IDEMPOTENCY_KEY,
      ]);
      await runAdmin(["agent", "credential", "list", agent.id]);
      await runAdmin([
        "agent",
        "credential",
        "revoke",
        agent.id,
        credentialId,
        "--idempotency-key",
        IDEMPOTENCY_KEY,
      ]);
      await runAdmin(["agent", "session", "list", agent.id]);
      await runAdmin([
        "agent",
        "disable",
        agent.id,
        "--idempotency-key",
        IDEMPOTENCY_KEY,
      ]);

      if (issuedEnrollment === undefined) throw new Error("enrollment was not captured");
      expect(enrollmentTokenSchema.safeParse(issuedEnrollment).success).toBeTrue();
      expect(await readFile(enrollmentOut, "utf8")).toBe(`${issuedEnrollment}\n`);
      expect((await stat(enrollmentOut)).mode & 0o777).toBe(0o600);
      expect(outputs.join("\n")).not.toContain(issuedEnrollment);
      expect(outputs[2]).toContain(enrollmentOut);
      requests.forEach(({ init }) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("X-Taskctl-Session")).toBeNull();
      });
      requests.forEach(({ url, init }) => {
        if ((init?.method ?? "GET") === "GET") {
          expect(url.searchParams.get("workspaceId")).toBe(workspace.id);
          return;
        }
        const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "null");
        expect(body).toMatchObject({ workspaceId: workspace.id });
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
