import { useEffect, useRef, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { dialogStyles } from "./primitives.stylex";

export type DialogProps = Readonly<{
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  open: boolean;
  xstyle?: StyleXStyles;
}>;

/**
 * The native `<dialog>` element, not a Radix portal.
 *
 * `showModal()` already provides the top layer, the focus trap, the inert
 * background, and Escape-to-close, so an owned wrapper is smaller and more
 * correct than a re-implementation, and it adds no dependency. Its extracted
 * backdrop rule ships in the one same-origin stylesheet required by
 * `style-src 'self'`.
 */
export function Dialog({ children, className, label, onClose, open, xstyle }: DialogProps) {
  const reference = useRef<HTMLDialogElement>(null);
  const presentation = stylex.props(dialogStyles.root, xstyle);

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

export function DialogTitle({ children }: Readonly<{ children: ReactNode }>) {
  return <h2 className={stylex.props(dialogStyles.title).className}>{children}</h2>;
}

export function DialogDescription({ children }: Readonly<{ children: ReactNode }>) {
  return <p className={stylex.props(dialogStyles.description).className}>{children}</p>;
}

export function DialogFooter({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={stylex.props(dialogStyles.footer).className}>{children}</div>;
}
