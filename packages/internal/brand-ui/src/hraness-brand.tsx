import type { ComponentPropsWithoutRef } from "react";

function classNames(...values: readonly (false | null | string | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

export type RaMarkProps = Readonly<{
  className?: string;
  title?: string;
}> & Omit<ComponentPropsWithoutRef<"svg">, "children" | "className">;

/**
 * The one-color Hraness identity mark. The sun ring and falcon eye are true
 * transparent cutouts, so the mark remains legible on any surface.
 */
export function RaMark({
  className,
  title,
  ...props
}: RaMarkProps) {
  const accessibility = title === undefined
    ? { "aria-hidden": true as const }
    : { "aria-label": title, role: "img" as const };

  return (
    <svg
      {...accessibility}
      {...props}
      className={classNames("hraness-ra-mark", className)}
      fill="none"
      focusable="false"
      viewBox="0 0 512 512"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M372 141a116 116 0 1 1-232 0 116 116 0 1 1 232 0Zm-14 0a102 102 0 1 0-204 0 102 102 0 1 0 204 0Zm-8 0a94 94 0 1 1-188 0 94 94 0 1 1 188 0Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      <path
        d="M211 252c75-8 154 30 204 94 32 40 51 89 59 142H184c20-28 29-57 22-87-9-39-26-71-28-99-2-22 9-39 33-50Z"
        fill="currentColor"
      />
      <path
        d="M246 270c-27-20-67-23-100-9-25 11-42 31-46 56l-34 20 38 12c4 25 14 47 31 66 15 13 22 32 18 56l-14 17h116c-20-27-23-50-8-68 6-8 14-14 23-21 23-20 34-50 28-79-5-22-23-40-52-50ZM132 309c9-14 22-22 38-22 13 0 25 7 34 19-10 14-23 22-39 22-14 0-25-6-33-19Z"
        fill="currentColor"
        fillRule="evenodd"
      />
      <path
        d="M151 410c-2 30-16 57-43 78h197c-19-27-40-49-63-63-28-18-59-23-91-15Z"
        fill="currentColor"
      />
      <circle cx="166" cy="307" fill="currentColor" r="8" />
    </svg>
  );
}

export type HranessBrandProps = Readonly<{
  className?: string;
  href?: string;
}> & Omit<ComponentPropsWithoutRef<"a">, "children" | "className" | "href">;

/**
 * Canonical footer lockup for Hraness web surfaces.
 */
export function HranessBrand({
  className,
  href = "https://hraness.com",
  ...props
}: HranessBrandProps) {
  return (
    <a
      {...props}
      aria-label="hraness"
      className={classNames("hraness-brand", className)}
      href={href}
    >
      <RaMark />
      <span className="hraness-brand__name">hraness</span>
    </a>
  );
}
