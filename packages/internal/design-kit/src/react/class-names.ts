export function classNames(...values: readonly (false | null | string | undefined)[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join(" ");
}
