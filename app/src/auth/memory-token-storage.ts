/**
 * In-memory token custody (HRA v2 F5).
 *
 * Convex Auth writes its JWT, its refresh token, and its OAuth verifier through
 * a `TokenStorage` object, defaulting to `localStorage`. A refresh token in
 * `localStorage` survives the tab, is readable by anything that evaluates in
 * the origin, and outlives the idle lock. This adapter keeps all three in a
 * `Map` that dies with the tab, so a reload asks for a new one-time code and a
 * closed tab leaves nothing behind.
 *
 * There is no React and no `window` here: the module holds one process-wide
 * instance so the provider's `useMemo` sees a stable identity across renders.
 */
export type MemoryTokenStorage = Readonly<{
  clear: () => void;
  getItem: (key: string) => string | null;
  keys: () => readonly string[];
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  size: () => number;
}>;

export function createMemoryTokenStorage(): MemoryTokenStorage {
  const values = new Map<string, string>();
  return {
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    keys() {
      return [...values.keys()].sort();
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
    size() {
      return values.size;
    },
  };
}

/** The single instance handed to `ConvexAuthProvider`. */
export const memoryTokenStorage = createMemoryTokenStorage();
