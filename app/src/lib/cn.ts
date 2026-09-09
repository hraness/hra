/**
 * Class name joiner.
 *
 * The app's finite class-name inputs need neither `clsx` nor a merge library.
 * Primitive-owned StyleX classes come first and an ordinary caller class name
 * remains last so the native extension seam keeps its existing order.
 */
export type ClassValue = string | false | null | undefined;

export function cn(...values: readonly ClassValue[]): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

/**
 * Turn a compiled static StyleX presentation into the app's class-only CSP
 * contract. Dynamic StyleX values would produce an inline `style` object, so
 * they fail closed instead of silently weakening `style-src 'self'`.
 */
export function staticStylexClassName(
  presentation: Readonly<{ className?: string; style?: unknown }>,
  className?: string,
): string {
  if (presentation.style !== undefined) {
    throw new Error("HRA primitives accept only extracted static StyleX styles.");
  }
  return cn(presentation.className, className);
}
