import type { ReactNode } from "react";

/**
 * Icons as inline SVG.
 *
 * `img-src 'none'` and `default-src 'none'` leave no way to fetch an icon file,
 * and a sprite sheet would be another request the policy refuses, so every glyph
 * is drawn here as owned source. They inherit `currentColor` and size from the
 * class the caller passes, and they carry no title: each one lives inside a
 * control that already has an accessible name.
 */

const strokeProps = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.75,
} as const;

function Glyph({ children }: Readonly<{ children: ReactNode }>): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      focusable="false"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...strokeProps}
    >
      {children}
    </svg>
  );
}

export function SettingsIcon(): ReactNode {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.1a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </Glyph>
  );
}

export function KebabIcon(): ReactNode {
  return (
    <Glyph>
      <circle cx="12" cy="5" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="12" cy="19" r="1" />
    </Glyph>
  );
}

export function BackIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M15 5l-7 7 7 7" />
    </Glyph>
  );
}

export function SendIcon(): ReactNode {
  return (
    <Glyph>
      <path d="M4 12h15" />
      <path d="M13 6l6 6-6 6" />
    </Glyph>
  );
}

export function StopIcon(): ReactNode {
  return (
    <Glyph>
      <rect height="12" rx="1.5" width="12" x="6" y="6" />
    </Glyph>
  );
}

export function DragHandleIcon(): ReactNode {
  return (
    <Glyph>
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </Glyph>
  );
}

export function ScheduleIcon(): ReactNode {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </Glyph>
  );
}

export function ChevronIcon({ open }: Readonly<{ open: boolean }>): ReactNode {
  return (
    <Glyph>
      <path d={open ? "M6 15l6-6 6 6" : "M9 6l6 6-6 6"} />
    </Glyph>
  );
}
