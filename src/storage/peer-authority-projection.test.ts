import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";

import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const roots: string[] = [];
const stores: StateStore[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Real current StateStore APIs, synthetic cached provider facts, no provider
// runtime or historical producer claim. Only the peer journal begins here.
async function fixture(provider: "codex" | "claude") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hra-peer-authority-projection-")));
  roots.push(root);
  const paths = resolveStatePaths({ homeDirectory: root, platform: "darwin" });
  await initializeStatePaths(paths);
  let now = 1_800_000_000_000;
  const store = new StateStore(paths, { now: () => now++, resolveMachineTimeZone: () => "UTC" });
  stores.push(store);
  store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
  const directory = join(root, "project");
  await mkdir(directory);
  const project = await store.createProject("Peer authority projection", directory);
  const makeSession = (label: string, active: boolean) => {
    const profile = store.nextProfileGeneration(store.createProfile(label).id);
    const email = `${label.toLowerCase()}@example.com`;
    expect(store.setProfileState(profile.id, profile.processGeneration, "signed_in", { email, plan: "Plus" }))
      .toBe(true);
    let authority = store.requireProviderAccountAuthority(profile.id, provider);
    if (provider === "claude") {
      for (let index = 0; index < 3; index += 1) {
        authority = store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider,
          expectedProcessGeneration: authority.processGeneration });
      }
      expect(authority.processGeneration).not.toBe(profile.processGeneration);
    }
    const session = store.upsertProviderSession({ profileId: profile.id, provider, providerAuthority: authority,
      providerAccountKey: `v1:${provider}:${hash(email)}`, providerThreadId: `thread-${label}`,
      projectId: project.id, title: label, preset: provider === "codex" ? "high" : "fable-max",
      fastEnabled: false, state: active ? "active" : "idle",
      ...(active ? { activeTurnId: `turn-${label}` } : {}),
    });
    const policy = store.requirePeerSessionPolicy(session.id);
    if (policy.mode !== "coordinate") store.setPeerSessionPolicy({ sessionId: session.id,
      expectedRevision: policy.revision, mode: "coordinate" });
    return { session, profile, authority };
  };
  const actor = makeSession("Actor", true);
  const target = makeSession("Target", false);
  const inspection = { actorSessionId: actor.session.id, actorTurnId: "turn-Actor",
    targetSessionId: target.session.id, expectedTargetRevision: target.session.revision };
  const request = () => ({ ...inspection, delivery: "send" as const,
    requestDigest: hash("peer request"), messageDigest: hash("peer message"),
    reasonDigest: hash("peer reason"), idempotencyKey: randomUUID() });
  const snapshot = () => {
    const db = new Database(paths.database, { readonly: true, strict: true });
    try {
      const tables = db.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      ).all();
      return {
        schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
        rows: tables.map(({ name }) => ({ name, digest: hash(JSON.stringify(
          db.query(`SELECT * FROM ${quote(name)}`).all().map((row) => JSON.stringify(row)).sort(),
        )) })),
      };
    } finally { db.close(false); }
  };
  return { store, actor, target, inspection, request, snapshot };
}

describe("peer session authority metadata projection", () => {
  test.each(["codex", "claude"] as const)(
    "%s rich session authority supports inspection, admission, replay and direct begin", async (provider) => {
      const f = await fixture(provider);
      for (const source of [f.actor, f.target]) {
        const rich = f.store.requireSessionProviderAuthority(source.session.id);
        expect(rich).toMatchObject({ ...source.authority, sessionId: source.session.id,
          authorityRevision: 1, routingProvenance: "explicit", appliedPointerRevision: null });
        expect(Object.hasOwn(rich, "createdAt")).toBe(true);
        // Preserve the strict base API: the fix belongs in its peer callers.
        expect(() => f.store.assertProviderAccountAuthorityCurrent(rich)).toThrow();
        expect(f.store.assertProviderAccountAuthorityCurrent(source.authority).id)
          .toBe(source.authority.providerAccountId);
      }
      const beforeInspection = f.snapshot();
      expect(f.store.assertPeerSessionInspection(f.inspection).id).toBe(f.target.session.id);
      expect(f.snapshot()).toEqual(beforeInspection);
      const request = f.request();
      const admitted = f.store.admitPeerSessionAction(request);
      expect(admitted).toMatchObject({ replay: false, action: { state: "prepared", delivery: "send" } });
      const beforeReplay = f.snapshot();
      expect(f.store.admitPeerSessionAction(request)).toMatchObject({ replay: true, action: { id: admitted.action.id } });
      expect(f.snapshot()).toEqual(beforeReplay);
      expect(f.store.beginPeerSessionActionEffect(admitted.action.id)).toMatchObject({
        id: admitted.action.id, state: "effect_started",
      });
      expect(f.store.requireCapturedSessionProviderAuthority(f.actor.session.id)).toMatchObject(f.actor.authority);
      expect(f.store.requireCapturedSessionProviderAuthority(f.target.session.id)).toMatchObject(f.target.authority);
    },
  );

  test.each(["actor", "target"] as const)(
    "direct begin and admission still refuse an expired %s Claude process without writes", async (side) => {
      const f = await fixture("claude");
      const request = f.request();
      const admitted = f.store.admitPeerSessionAction(request);
      const selected = f[side];
      f.store.advanceProviderAccountProcessGeneration({ profileId: selected.profile.id, provider: "claude",
        expectedProcessGeneration: selected.authority.processGeneration });
      const before = f.snapshot();
      expect(() => f.store.admitPeerSessionAction(f.request())).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
      expect(() => f.store.admitPeerSessionAction(request)).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
      expect(() => f.store.beginPeerSessionActionEffect(admitted.action.id)).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
      if (side === "actor") {
        expect(() => f.store.assertPeerSessionInspection(f.inspection)).toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
      }
      expect(f.store.requirePeerSessionAction(admitted.action.id).state).toBe("prepared");
      expect(f.snapshot()).toEqual(before);
    },
  );

  test.each(["codex", "claude"] as const)(
    "%s seeded turn and revision mismatches remain inert after projecting base authority", async (provider) => {
      const f = await fixture(provider);
      const before = f.snapshot();
      fc.assert(fc.property(fc.boolean(), fc.integer({ min: 1, max: 1_000 }), (changeTurn, delta) => {
        const changed = changeTurn ? { actorTurnId: `turn-other-${String(delta)}` }
          : { expectedTargetRevision: f.target.session.revision + delta };
        const code = changeTurn ? "PEER_SESSION_ACTOR_TURN_REFUSED" : "PEER_SESSION_REVISION_CONFLICT";
        expect(() => f.store.assertPeerSessionInspection({ ...f.inspection, ...changed })).toThrow(code);
        expect(() => f.store.admitPeerSessionAction({ ...f.request(), ...changed })).toThrow(code);
      }), { seed: provider === "codex" ? 8_014 : 8_015, numRuns: 30 });
      expect(f.snapshot()).toEqual(before);
    },
  );
});
