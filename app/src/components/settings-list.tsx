import type { ReactNode } from "react";
import { useId } from "react";

import { cn } from "../lib/cn";
import { Card } from "./ui/card";

/**
 * The list and row primitives the settings screen is built from.
 *
 * They are here rather than in `components/ui` because they are HRA layout, not
 * a general interface primitive: a titled section, a labelled row with a
 * control on the right, and a segmented three-way choice. Every visual is a
 * Tailwind class in the one same-origin stylesheet, and the one icon is inline
 * SVG rather than an image, because `img-src` is `'none'`.
 */

export function SettingsSection({
  children,
  description,
  title,
}: Readonly<{ children: ReactNode; description?: string; title: string }>) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description === undefined
          ? null
          : <p className="text-xs text-ink-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingsCard({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  return <Card className={cn("flex flex-col divide-y divide-line", className)}>{children}</Card>;
}

/**
 * One labelled row. `control` sits at the end on a wide screen and wraps under
 * the label on a phone, so a 44 px target never has to share a narrow line.
 */
export function SettingsRow({
  children,
  control,
  description,
  title,
}: Readonly<{
  children?: ReactNode;
  control?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}>) {
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate text-sm font-medium">{title}</span>
          {description === undefined
            ? null
            : <span className="text-xs text-ink-muted">{description}</span>}
        </div>
        {control === undefined ? null : <div className="flex items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  );
}

export function EmptyRow({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="p-3 text-xs text-ink-muted">{children}</p>;
}

/**
 * A command line the reader is meant to run on a machine. It is text in a
 * `code` element, never a link and never a copy button: `clipboard-read` is
 * denied by the Permissions-Policy the app is served with.
 */
export function CommandHint({ children }: Readonly<{ children: string }>) {
  return (
    <code className="block overflow-x-auto rounded bg-surface-input px-2 py-1 font-mono text-xs text-ink-muted">
      {children}
    </code>
  );
}

export type ChoiceOption<Value extends string> = Readonly<{ label: string; value: Value }>;

/**
 * A segmented choice rendered as a radio group: one tab stop for the group and
 * arrow keys inside it are what `role="radiogroup"` buys, and it costs no
 * dependency. Selection is reported through `onSelect`; the control stays
 * controlled by the caller so an unapplied command never moves it.
 */
export function ChoiceGroup<Value extends string>({
  disabled = false,
  label,
  onSelect,
  options,
  value,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onSelect: (value: Value) => void;
  options: readonly ChoiceOption<Value>[];
  value: Value;
}>) {
  const groupId = useId();
  return (
    <div
      aria-label={label}
      className="flex flex-wrap items-center gap-1 rounded-md border border-line p-1"
      id={groupId}
      role="radiogroup"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            className={cn(
              "inline-flex min-h-11 items-center justify-center rounded px-3 text-xs font-medium",
              "disabled:cursor-not-allowed disabled:opacity-50",
              selected ? "bg-accent text-surface" : "bg-transparent text-ink-muted hover:text-ink",
            )}
            disabled={disabled}
            key={option.value}
            onClick={() => { onSelect(option.value); }}
            role="radio"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function BackIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M15 19 8 12l7-7" />
    </svg>
  );
}
