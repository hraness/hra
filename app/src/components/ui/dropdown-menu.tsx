import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "../../lib/cn";

export type DropdownMenuItem = Readonly<{
  disabled?: boolean;
  id: string;
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}>;

export type DropdownMenuProps = Readonly<{
  align?: "start" | "end";
  className?: string;
  items: readonly DropdownMenuItem[];
  label: string;
  trigger: ReactNode;
}>;

/**
 * An owned menu rather than a Radix wrapper. It closes on Escape, on an outside
 * pointer press, and on selection, and it moves focus into the list so a
 * keyboard reaches every item. Positioning is class based, never a style
 * attribute.
 */
export function DropdownMenu({
  align = "end",
  className,
  items,
  label,
  trigger,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && container.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <div className={cn("relative", className)} ref={container}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ink-muted hover:text-ink"
        onClick={() => { setOpen((current) => !current); }}
        type="button"
      >
        {trigger}
      </button>
      {open ? (
        <div
          className={cn(
            "absolute z-10 mt-1 min-w-44 rounded-md border border-line bg-surface-raised p-1",
            align === "end" ? "right-0" : "left-0",
          )}
          id={menuId}
          ref={list}
          role="menu"
          tabIndex={-1}
        >
          {items.map((item) => (
            <button
              className={cn(
                "block w-full min-h-11 rounded px-3 text-left text-sm",
                "hover:bg-surface-input disabled:cursor-not-allowed disabled:opacity-50",
                item.tone === "danger" ? "text-danger" : "text-ink",
              )}
              disabled={item.disabled ?? false}
              key={item.id}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              role="menuitem"
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
