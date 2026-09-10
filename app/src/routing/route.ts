/**
 * The route model.
 *
 * The app is one static shell behind a rewrite, so navigation lives entirely in
 * the fragment: no history API, no server route table, and no way for a crafted
 * link to reach anything but these two screens. Parsing is framework free and
 * total, so an unknown or malformed fragment, including an old
 * `#/session/<id>` link, resolves to the grid rather than rendering nothing.
 * Every conversation lives in its grid card.
 */
export type Route =
  | Readonly<{ kind: "grid" }>
  | Readonly<{ kind: "settings" }>;

export const gridRoute: Route = Object.freeze({ kind: "grid" });
export const settingsRoute: Route = Object.freeze({ kind: "settings" });

export function parseRoute(hash: string): Route {
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const [head] = segments;
  if (segments.length === 1 && head === "settings") return settingsRoute;
  return gridRoute;
}

export function routeHash(route: Route): string {
  switch (route.kind) {
    case "settings": return "#/settings";
    case "grid": return "#/";
  }
}

export function sameRoute(left: Route, right: Route): boolean {
  return routeHash(left) === routeHash(right);
}
