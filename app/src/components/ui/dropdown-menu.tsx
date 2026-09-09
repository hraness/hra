import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { dropdownMenuStyles } from "./primitives.stylex";

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
  xstyle?: StyleXStyles;
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
  xstyle,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const rootPresentation = stylex.props(dropdownMenuStyles.root, xstyle);

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
    <div className={staticStylexClassName(rootPresentation, className)} ref={container}>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className={stylex.props(dropdownMenuStyles.trigger).className}
        onClick={() => { setOpen((current) => !current); }}
        type="button"
      >
        {trigger}
      </button>
      {open ? (
        <div
          className={stylex.props(
            dropdownMenuStyles.list,
            align === "end" ? dropdownMenuStyles.listEnd : dropdownMenuStyles.listStart,
          ).className}
          id={menuId}
          ref={list}
          role="menu"
          tabIndex={-1}
        >
          {items.map((item) => (
            <button
              className={stylex.props(
                dropdownMenuStyles.item,
                item.tone === "danger"
                  ? dropdownMenuStyles.itemDanger
                  : dropdownMenuStyles.itemDefault,
              ).className}
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
