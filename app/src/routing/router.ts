/**
 * The hash router.
 *
 * `hashchange` is the whole subscription: the browser keeps one history entry
 * per screen, so the hardware back gesture and the in-app back control both
 * work without a history-state protocol. In-app back navigates to the grid
 * rather than calling `history.back()`, because a session opened from a shared
 * link has no earlier in-app entry to return to and `history.back()` would then
 * leave the app.
 */
import { useEffect, useMemo, useState } from "react";

import { gridRoute, parseRoute, routeHash, type Route } from "./route";

function currentHash(): string {
  return window.location.hash;
}

export function useRoute(): Route {
  const [hash, setHash] = useState<string>(currentHash);

  useEffect(() => {
    const listen = () => { setHash(currentHash()); };
    window.addEventListener("hashchange", listen);
    listen();
    return () => { window.removeEventListener("hashchange", listen); };
  }, []);

  return useMemo(() => parseRoute(hash), [hash]);
}

export function navigate(route: Route): void {
  const next = routeHash(route);
  if (window.location.hash === next) return;
  window.location.hash = next;
}

export function navigateBack(): void {
  navigate(gridRoute);
}
