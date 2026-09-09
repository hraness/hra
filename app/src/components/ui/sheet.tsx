import { useEffect, useRef, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { sheetStyles } from "./primitives.stylex";

export type SheetSide = "bottom" | "right";

export type SheetProps = Readonly<{
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  open: boolean;
  side?: SheetSide;
  xstyle?: StyleXStyles;
}>;

const sideStyles: Readonly<Record<SheetSide, StyleXStyles>> = {
  bottom: sheetStyles.bottom,
  right: sheetStyles.right,
};

/**
 * The same native `<dialog>` contract as `Dialog`, anchored to an edge. On a
 * phone the bottom sheet clears the home indicator through an extracted
 * safe-area rule rather than an inline style attribute.
 */
export function Sheet({
  children,
  className,
  label,
  onClose,
  open,
  side = "bottom",
  xstyle,
}: SheetProps) {
  const reference = useRef<HTMLDialogElement>(null);
  const presentation = stylex.props(sheetStyles.root, sideStyles[side], xstyle);

  useEffect(() => {
    const element = reference.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      aria-label={label}
      className={staticStylexClassName(presentation, className)}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      ref={reference}
    >
      {open ? children : null}
    </dialog>
  );
}
