import type { SVGProps } from "react";

export type HRAIconName =
  | "branch"
  | "check"
  | "close"
  | "command"
  | "edit"
  | "folder"
  | "eye"
  | "import"
  | "more"
  | "open"
  | "panes"
  | "plus"
  | "rollback"
  | "power"
  | "refresh"
  | "network"
  | "revoke"
  | "send"
  | "settings"
  | "search"
  | "sparkle"
  | "stop";

const paths: Readonly<Record<HRAIconName, readonly string[]>> = {
  branch: ["M5 3v7a4 4 0 0 0 4 4h6", "m12 11 3 3-3 3", "M5 7h5a3 3 0 0 0 3-3V3"],
  check: ["M4 10.25 8 14l8-8"],
  close: ["m5 5 10 10", "M15 5 5 15"],
  command: ["M4 5.25h12v9.5H4z", "m6.25 8-2 2 2 2", "M9.5 12h3"],
  edit: ["M4 14.75V17h2.25L16 7.25 12.75 4 4 12.75Z", "m11.25 5.5 3.25 3.25"],
  folder: ["M2.75 5.5A1.75 1.75 0 0 1 4.5 3.75h3l1.75 2h6.25a1.75 1.75 0 0 1 1.75 1.75v7A1.75 1.75 0 0 1 15.5 16.25h-11a1.75 1.75 0 0 1-1.75-1.75Z"],
  eye: ["M2.5 10s2.5-4.5 7.5-4.5 7.5 4.5 7.5 4.5-2.5 4.5-7.5 4.5S2.5 10 2.5 10Z", "M10 7.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"],
  import: ["M10 3v9", "m6.5 8.5 3.5 3.5 3.5-3.5", "M4 14v2.5h12V14"],
  more: ["M10 4h.01", "M10 10h.01", "M10 16h.01"],
  network: ["M10 2.75a7.25 7.25 0 1 0 0 14.5 7.25 7.25 0 0 0 0-14.5Z", "M2.75 10h14.5", "M10 2.75c2 2 3 4.4 3 7.25s-1 5.25-3 7.25c-2-2-3-4.4-3-7.25s1-5.25 3-7.25Z"],
  open: ["M7 4H4.5A1.5 1.5 0 0 0 3 5.5v10A1.5 1.5 0 0 0 4.5 17h10a1.5 1.5 0 0 0 1.5-1.5V13", "m10 3 4 0 0 4", "M9 11 17 3"],
  panes: ["M3 3h5.5v5.5H3z", "M11.5 3H17v5.5h-5.5z", "M3 11.5h5.5V17H3z", "M11.5 11.5H17V17h-5.5z"],
  plus: ["M10 3.5v13", "M3.5 10h13"],
  rollback: ["M6 7H3V4", "M3.5 7A7 7 0 1 1 4 14"],
  power: ["M10 2.5v7", "M5.25 5.25a6 6 0 1 0 9.5 0"],
  refresh: ["M15 6V3l2.5 2.5L15 8V6a6 6 0 1 0 1 7.3"],
  search: ["M8.75 3.5a5.25 5.25 0 1 0 0 10.5 5.25 5.25 0 0 0 0-10.5Z", "m12.5 12.5 4 4"],
  revoke: ["M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M4.5 17v-1.5A4.5 4.5 0 0 1 9 11h2", "m13 12 4 4", "m17 12-4 4"],
  send: ["m3 4 14 6-14 6 2.25-5L3 4Z", "M5.25 11 17 10"],
  settings: ["M3 5h8", "M14 5h3", "M3 10h3", "M9 10h8", "M3 15h8", "M14 15h3", "M11 3v4", "M6 8v4", "M11 13v4"],
  sparkle: ["m10 2 1.1 3.4L14.5 6.5l-3.4 1.1L10 11 8.9 7.6 5.5 6.5l3.4-1.1L10 2Z", "m15.5 12 .65 1.85 1.85.65-1.85.65L15.5 17l-.65-1.85L13 14.5l1.85-.65.65-1.85Z"],
  stop: ["M5 5h10v10H5z"],
};

/** Small product-owned line icons keep the pane chrome compact and dependency-free. */
export function HRAIcon({
  name,
  ...props
}: Readonly<{ name: HRAIconName }> & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      className="hra-icon"
      fill="none"
      focusable="false"
      viewBox="0 0 20 20"
      {...props}
    >
      {paths[name].map((path) => (
        <path
          d={path}
          key={path}
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
        />
      ))}
    </svg>
  );
}
