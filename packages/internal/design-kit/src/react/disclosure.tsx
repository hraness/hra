"use client";

import {
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type SyntheticEvent,
  useState,
} from "react";
import { Focusable } from "react-aria-components";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";
import type { SurfaceShape } from "./surfaces";
import { Tooltip } from "./tooltip";

export type DisclosureSize = "compact" | "default" | "large";

export type DisclosureProps = Omit<HTMLAttributes<HTMLElement>, "children" | "onToggle" | "title"> & {
  readonly children: ReactNode;
  readonly defaultOpen?: boolean;
  readonly disclosureRef?: Ref<HTMLElement>;
  readonly isOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly shape?: SurfaceShape;
  readonly size?: DisclosureSize;
  readonly title: ReactNode;
  /** Required for a visually icon-only summary; shown on hover and focus. */
  readonly tooltip?: ReactNode;
};

function assignRef(ref: Ref<HTMLElement> | undefined, value: HTMLElement | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref !== null && ref !== undefined) ref.current = value;
}

/** Closes the shared disclosure containing a nested control and restores focus to its summary. */
export function dismissClosestDisclosure(origin: Element): boolean {
  const host = origin.closest<HTMLElement>(".jungle-disclosure");
  const details = host?.querySelector<HTMLDetailsElement>(".jungle-disclosure__details") ?? null;
  if (details === null) return false;
  details.open = false;
  details.querySelector<HTMLElement>(".jungle-disclosure__summary")?.focus();
  return true;
}

/**
 * An always-functional native disclosure painted by Jelly. The details/summary
 * pair remains operable during SSR, hydration, runtime-load failure, and reduced motion.
 */
export function Disclosure({
  children,
  className,
  defaultOpen = false,
  disclosureRef,
  isOpen,
  onOpenChange,
  shape = "rounded",
  size = "default",
  title,
  tooltip,
  ...props
}: DisclosureProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = isOpen ?? uncontrolledOpen;

  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>): void => {
    const next = event.currentTarget.open;
    if (next === open) return;
    if (isOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
    if (isOpen !== undefined) event.currentTarget.open = open;
  };

  const summary = (
    <summary className="jungle-disclosure__summary">
      <span className="jungle-disclosure__title">{title}</span>
    </summary>
  );

  return (
    <JellySurface
      {...props}
      className={classNames("jungle-disclosure", className)}
      data-open={open ? "true" : undefined}
      data-shape={shape}
      data-size={size}
      interaction="press"
      surfaceRef={(host) => assignRef(disclosureRef, host)}
    >
      <details className="jungle-disclosure__details" onToggle={handleToggle} open={open}>
        {tooltip === undefined
          ? summary
          : (
              <Tooltip label={tooltip}>
                <Focusable>{summary}</Focusable>
              </Tooltip>
            )}
        <div className="jungle-disclosure__content">{children}</div>
      </details>
    </JellySurface>
  );
}
