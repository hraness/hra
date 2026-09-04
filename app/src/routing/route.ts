/**
 * The route model.
 *
 * The app is one static shell behind a rewrite, so navigation lives entirely in
 * the fragment: no history API, no server route table, and no way for a crafted
 * link to reach anything but these three screens. Parsing is framework free and
 * total, so an unknown or malformed fragment resolves to the grid rather than
 * rendering nothing.
 */
import { isOpaqueIdentifier } from "../hra/cloud";

export type Route =
  | Readonly<{ kind: "grid" }>
  | Readonly<{ kind: "session"; sessionPublicId: string }>
  | Readonly<{ kind: "settings" }>;

export const gridRoute: Route = Object.freeze({ kind: "grid" });
export const settingsRoute: Route = Object.freeze({ kind: "settings" });

export function sessionRoute(sessionPublicId: string): Route {
  return { kind: "session", sessionPublicId };
}

export function parseRoute(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [head, tail] = segments;
  if (segments.length === 1 && head === "settings") return settingsRoute;
  if (
    segments.length === 2
    && head === "session"
    && tail !== undefined
    && isOpaqueIdentifier(tail)
  ) return sessionRoute(tail);
  return gridRoute;
}

export function routeHash(route: Route): string {
  switch (route.kind) {
    case "session": return `#/session/${route.sessionPublicId}`;
    case "settings": return "#/settings";
    case "grid": return "#/";
  }
}

export function sameRoute(left: Route, right: Route): boolean {
  return routeHash(left) === routeHash(right);
}
