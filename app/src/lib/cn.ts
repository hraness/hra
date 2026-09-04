/**
 * Class name joiner.
 *
 * shadcn/ui ships `cn` on top of `clsx` and `tailwind-merge`. Neither earns a
 * dependency here: the primitives in `components/ui` accept an optional
 * `className` that is appended last, and Tailwind's later-wins ordering inside
 * one stylesheet is enough for the overrides this app makes.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...values: readonly ClassValue[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}
