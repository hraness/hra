import { useEffect, useRef, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type SheetSide = "bottom" | "right";

export type SheetProps = Readonly<{
  children: ReactNode;
  className?: string;
  label: string;
  onClose: () => void;
  open: boolean;
  side?: SheetSide;
}>;

const sideClasses: Readonly<Record<SheetSide, string>> = {
  bottom: [
    "mt-auto mb-0 ml-0 mr-0 w-full max-w-none rounded-b-none rounded-t-lg",
    "pb-[calc(1rem+env(safe-area-inset-bottom))]",
  ].join(" "),
  right: [
    "ml-auto mr-0 mt-0 mb-0 h-full max-h-none w-[min(28rem,100vw)] rounded-r-none rounded-l-lg",
    "pr-[calc(1rem+env(safe-area-inset-right))]",
  ].join(" "),
};

/**
 * The same native `<dialog>` contract as `Dialog`, anchored to an edge. On a
 * phone the bottom sheet clears the home indicator through the safe-area inset,
 * expressed as a Tailwind arbitrary value so it stays in the stylesheet rather
 * than becoming a style attribute.
 */
export function Sheet({
  children,
  className,
  label,
  onClose,
  open,
  side = "bottom",
}: SheetProps) {
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
        "max-h-[85dvh] overflow-y-auto border border-line bg-surface-raised p-4 text-ink",
        "backdrop:bg-black/60",
        sideClasses[side],
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
