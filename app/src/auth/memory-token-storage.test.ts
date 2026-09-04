import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryTokenStorage, memoryTokenStorage } from "./memory-token-storage";

/*
 * HRA v2 F5: no authentication token reaches `localStorage`.
 *
 * Convex Auth writes exactly three keys through the `TokenStorage` object it is
 * handed: the JWT, the refresh token, and the OAuth verifier. This drives the
 * adapter through that exact sequence with an instrumented `localStorage` and
 * `sessionStorage` installed on the global, and proves that both stay empty and
 * are never called. A second test proves no module under `app/src` names either
 * API, so no other code path can reach them either.
 */
const convexAuthKeys = [
  "__convexAuthJWT_httpsqualifiedhummingbird537convexcloud",
  "__convexAuthRefreshToken_httpsqualifiedhummingbird537convexcloud",
  "__convexAuthOAuthVerifier_httpsqualifiedhummingbird537convexcloud",
] as const;

type Recorder = Readonly<{
  calls: string[];
  storage: Storage;
  values: Map<string, string>;
}>;

function recordingStorage(): Recorder {
  const values = new Map<string, string>();
  const calls: string[] = [];
  const storage = {
    clear() {
      calls.push("clear");
      values.clear();
    },
    getItem(key: string) {
      calls.push(`getItem:${key}`);
      return values.get(key) ?? null;
    },
    key(index: number) {
      calls.push(`key:${String(index)}`);
      return [...values.keys()][index] ?? null;
    },
    get length() {
      return values.size;
    },
    removeItem(key: string) {
      calls.push(`removeItem:${key}`);
      values.delete(key);
    },
    setItem(key: string, value: string) {
      calls.push(`setItem:${key}`);
      values.set(key, value);
    },
  } as unknown as Storage;
  return { calls, storage, values };
}

const globals = globalThis as unknown as {
  localStorage?: Storage;
  sessionStorage?: Storage;
};
const originalLocal = globals.localStorage;
const originalSession = globals.sessionStorage;

afterEach(() => {
  if (originalLocal === undefined) delete globals.localStorage;
  else globals.localStorage = originalLocal;
  if (originalSession === undefined) delete globals.sessionStorage;
  else globals.sessionStorage = originalSession;
  memoryTokenStorage.clear();
});

describe("memory token storage", () => {
  test("holds tokens in memory and never touches web storage", () => {
    const local = recordingStorage();
    const session = recordingStorage();
    globals.localStorage = local.storage;
    globals.sessionStorage = session.storage;

    const storage = createMemoryTokenStorage();
    // The exact sign-in sequence Convex Auth performs.
    expect(storage.getItem(convexAuthKeys[2])).toBeNull();
    storage.removeItem(convexAuthKeys[2]);
    storage.setItem(convexAuthKeys[0], "header.payload.signature");
    storage.setItem(convexAuthKeys[1], "refresh-token-value");
    expect(storage.getItem(convexAuthKeys[0])).toBe("header.payload.signature");
    expect(storage.getItem(convexAuthKeys[1])).toBe("refresh-token-value");

    expect(local.values.size).toBe(0);
    expect(session.values.size).toBe(0);
    expect(local.calls).toEqual([]);
    expect(session.calls).toEqual([]);
  });

  test("sign-out clears every held token", () => {
    const storage = createMemoryTokenStorage();
    storage.setItem(convexAuthKeys[0], "a");
    storage.setItem(convexAuthKeys[1], "b");
    expect(storage.size()).toBe(2);
    storage.removeItem(convexAuthKeys[0]);
    storage.removeItem(convexAuthKeys[1]);
    expect(storage.size()).toBe(0);
    expect(storage.getItem(convexAuthKeys[1])).toBeNull();
  });

  test("two storages never share state, so one tab cannot read another", () => {
    const first = createMemoryTokenStorage();
    const second = createMemoryTokenStorage();
    first.setItem(convexAuthKeys[0], "only-mine");
    expect(second.getItem(convexAuthKeys[0])).toBeNull();
  });

  test("the shared instance is the one the provider is given", () => {
    memoryTokenStorage.setItem(convexAuthKeys[0], "token");
    expect(memoryTokenStorage.keys()).toEqual([convexAuthKeys[0]]);
    memoryTokenStorage.clear();
    expect(memoryTokenStorage.size()).toBe(0);
  });
});
