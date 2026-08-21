import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  HumanSessionCoordinator,
  humanAuthenticationSnapshotSchema,
  type HumanAuthenticationStore,
} from "@hraness/hra-human-client";

import { HRAPromotionHttpTransport } from "../src/promotion/http-transport";
import { applyMigrations } from "../src/state/database";
import { LocalPromotionV2Store } from "../src/state/local-promotion-v2-store";
import { LocalTaskStore } from "../src/state/local-task-store";

const LOCATOR = "0123456789ABCDEFGHJKMNPQRS";
const REQUEST_ID = `req_${LOCATOR}`;
const INSTALLATION_ID = "install_promotion_http";
const WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STAGING_WORKSPACE_ID = "wsp_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROMOTION_ID = "promotion_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACCESS_TOKEN = "human-access-token-that-must-stay-in-the-header";

function fixture() {
  const database = new Database(":memory:", { strict: true });
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  const tasks = new LocalTaskStore(database, new Uint8Array(32).fill(0x73));
  tasks.registerInstallation(INSTALLATION_ID, 1);
  tasks.onboardProject({
    installationId: INSTALLATION_ID,
    repository: {
      repositoryId: REPOSITORY_ID,
      name: "Promotion HTTP repository",
      provider: "github",
      publicUrl: "https://github.com/example/promotion-http.git",
      canonicalRepositoryPath: "/private/promotion-http",
      canonicalGitCommonDir: "/private/promotion-http/.git",
    },
    workspace: {
      workspaceId: WORKSPACE_ID,
      name: "Promotion HTTP",
      slug: "promotion-http",
      keyPrefix: "PHT",
    },
  }, 2);
  tasks.execute({
    kind: "workspace.rename",
    operationId: "op_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    authority: {
      kind: "local_owner",
      workspaceId: WORKSPACE_ID,
      installationId: INSTALLATION_ID,
    },
    expectedWorkspaceRevision: 1,
    name: "Promotion HTTP frozen",
  }, undefined, 3);
  const promotions = new LocalPromotionV2Store(database);
  promotions.freezeSourceSnapshot({
    workspaceId: WORKSPACE_ID,
    promotionId: PROMOTION_ID,
    destinationOrganizationId: "org_destination",
    now: 4,
  });
  return { database, promotions };
}

function session(signedIn = true): HumanSessionCoordinator {
  const snapshot = humanAuthenticationSnapshotSchema.parse({
    generation: 1,
    authentication: {
      version: 2,
      apiUrl: "https://hra.example.com",
      accessToken: ACCESS_TOKEN,
      refreshToken: "refresh-token-that-must-stay-in-keychain",
      user: {
        id: "usr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        email: "chef@example.com",
      },
      organization: {
        id: "org_destination",
        name: "Destination",
        role: "owner",
        status: "active",
      },
    },
  });
  const store: HumanAuthenticationStore = {
    read: () => Promise.resolve(signedIn ? snapshot : null),
    compareAndSwap: () => Promise.resolve(null),
    preserveForRecovery: () => Promise.resolve(false),
    clear: () => Promise.resolve(false),
  };
  return new HumanSessionCoordinator({
    store,
    refresh: {
      refresh: () => Promise.resolve({
        ok: false,
        outcome: "authentication_failed",
      }),
    },
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OPRTE promotion HTTP transport", () => {
  test("uses strict routes, bearer-only credentials, and a durable replay key", async () => {
    const { database, promotions } = fixture();
    const requests: Request[] = [];
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return Promise.resolve(json({
        ok: true,
        data: {
          promotionId: PROMOTION_ID,
          stagingWorkspaceId: STAGING_WORKSPACE_ID,
          state: "receiving",
        },
        requestId: REQUEST_ID,
      }));
    };
    try {
      const input = {
        organizationId: "org_destination",
        manifest: promotions.manifest(PROMOTION_ID),
      };
      const first = new HRAPromotionHttpTransport({
        apiUrl: "https://hra.example.com",
        session: session(),
        idempotencyKeys: promotions,
        fetch,
        now: () => 1_720_000_000_123,
      });
      expect(await first.start(input)).toEqual({
        ok: true,
        value: {
          promotionId: PROMOTION_ID,
          stagingWorkspaceId: STAGING_WORKSPACE_ID,
          state: "receiving",
        },
      });
      const afterRestart = new HRAPromotionHttpTransport({
        apiUrl: "https://hra.example.com",
        session: session(),
        idempotencyKeys: promotions,
        fetch,
        now: () => 1_720_000_001_000,
      });
      expect(await afterRestart.start(input)).toMatchObject({ ok: true });
      expect(requests).toHaveLength(2);
      const firstKey = requests[0]?.headers.get("idempotency-key");
      expect(firstKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      expect(requests[1]?.headers.get("idempotency-key")).toBe(firstKey);
      expect(requests[0]?.headers.get("authorization")).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      expect(requests[0]?.url).toBe(
        "https://hra.example.com/v1/hra/promotions",
      );
      expect(requests[0]?.url).not.toContain(ACCESS_TOKEN);
      expect(await requests[0]?.text()).not.toContain(ACCESS_TOKEN);
      expect(database.query<{ count: number }, []>(`
        SELECT count(*) AS count FROM local_promotion_http_operations
      `).get()?.count).toBe(1);
    } finally {
      database.close();
    }
  });

  test("classifies uncertain mutation responses conservatively", async () => {
    const { database, promotions } = fixture();
    let calls = 0;
    const transport = new HRAPromotionHttpTransport({
      apiUrl: "https://hra.example.com",
      session: session(),
      idempotencyKeys: promotions,
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("response lost after commit"));
      },
      now: () => 1_720_000_000_123,
    });
    try {
      expect(await transport.start({
        organizationId: "org_destination",
        manifest: promotions.manifest(PROMOTION_ID),
      })).toEqual({ ok: false, kind: "outcome_unknown" });
      expect(await transport.lookup(PROMOTION_ID)).toEqual({
        ok: false,
        kind: "offline",
      });
      expect(calls).toBe(2);
    } finally {
      database.close();
    }
  });

  test("returns unauthorized before network access when signed out", async () => {
    const { database, promotions } = fixture();
    let calls = 0;
    const transport = new HRAPromotionHttpTransport({
      apiUrl: "https://hra.example.com",
      session: session(false),
      idempotencyKeys: promotions,
      fetch: () => {
        calls += 1;
        return Promise.reject(new Error("network must not run"));
      },
      now: () => 1_720_000_000_123,
    });
    try {
      expect(await transport.start({
        organizationId: "org_destination",
        manifest: promotions.manifest(PROMOTION_ID),
      })).toEqual({ ok: false, kind: "unauthorized" });
      expect(calls).toBe(0);
    } finally {
      database.close();
    }
  });
});
