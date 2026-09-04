import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type DialogProps = Readonly<{
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  open: boolean;
}>;

/**
 * The native `<dialog>` element, not a Radix portal.
 *
 * `showModal()` already provides the top layer, the focus trap, the inert
 * background, and Escape-to-close, so an owned wrapper is smaller and more
 * correct than a re-implementation, and it adds no dependency. The backdrop is
 * styled through `backdrop:` utilities in the one same-origin stylesheet, which
 * is what `style-src 'self'` requires.
 */
export function Dialog({ children, className, label, onClose, open }: DialogProps) {
  const reference = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = reference.current;
    if (element === null) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      aria-label={label}
      className={cn(
        "m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line",
        "bg-surface-raised p-4 text-ink backdrop:bg-black/60",
        className,
      )}
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
  return <h2 className="text-base font-semibold">{children}</h2>;
}

export function DialogDescription({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="mt-1 text-sm text-ink-muted">{children}</p>;
}

export function DialogFooter({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>;
}
