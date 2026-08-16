export const hraComparisonSlugs = [
  "codex-app",
  "opencode-desktop",
  "paseo",
  "conductor",
  "superset",
  "openchamber",
  "happy-coder",
] as const;

export type HraComparisonSlug = (typeof hraComparisonSlugs)[number];

const publicComparisonPaths: ReadonlySet<string> = new Set([
  "/alternatives",
  ...hraComparisonSlugs.map((slug) => `/alternatives/${slug}`),
]);

export function isHraPublicComparisonPath(pathname: string): boolean {
  const canonicalPath = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  return publicComparisonPaths.has(canonicalPath);
}
