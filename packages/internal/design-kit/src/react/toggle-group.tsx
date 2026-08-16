"use client";

import type { CSSProperties, ReactNode, Ref } from "react";
import {
  ToggleButton,
  ToggleButtonGroup,
  type ToggleButtonGroupProps as AriaToggleButtonGroupProps,
} from "react-aria-components";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";
import { firstOwnedStringId } from "./selection";

export interface ToggleItem<Id extends string> {
  readonly id: Id;
  readonly label: ReactNode;
  readonly leading?: ReactNode;
  readonly style?: CSSProperties;
}

export interface ToggleGroupProps<Id extends string> {
  readonly "aria-label": string;
  readonly className?: string;
  readonly groupRef?: Ref<HTMLDivElement>;
  readonly isDisabled?: boolean;
  readonly items: readonly ToggleItem<Id>[];
  readonly onChange: (id: Id | null) => void;
  readonly onItemBlur?: (id: Id) => void;
  readonly onItemFocus?: (id: Id) => void;
  readonly onItemHoverEnd?: (id: Id) => void;
  readonly onItemHoverStart?: (id: Id) => void;
  readonly orientation?: AriaToggleButtonGroupProps["orientation"];
  readonly surfaceClassName?: string;
  readonly value: Id | null;
}

export function ToggleGroup<Id extends string>({
  "aria-label": ariaLabel,
  className,
  groupRef,
  isDisabled = false,
  items,
  onChange,
  onItemBlur,
  onItemFocus,
  onItemHoverEnd,
  onItemHoverStart,
  orientation = "horizontal",
  surfaceClassName,
  value,
}: ToggleGroupProps<Id>) {
  const normalizedValue = value === null
    ? null
    : firstOwnedStringId(items, new Set([value]));
  const selectedKeys = normalizedValue === null ? [] : [normalizedValue];

  return (
    <JellySurface
      className={classNames("jungle-toggle-group__surface", surfaceClassName)}
      interaction="press"
      isDisabled={isDisabled}
      tone="neutral"
    >
      <ToggleButtonGroup
        aria-label={ariaLabel}
        className={classNames("jungle-toggle-group", className)}
        isDisabled={isDisabled}
        onSelectionChange={(keys) => onChange(firstOwnedStringId(items, keys))}
        orientation={orientation}
        ref={groupRef}
        selectedKeys={selectedKeys}
        selectionMode="single"
      >
        {items.map((item) => (
          <ToggleButton
            aria-keyshortcuts="Enter Space"
            className="jungle-toggle-group__item"
            id={item.id}
            key={item.id}
            onBlur={() => onItemBlur?.(item.id)}
            onFocus={() => onItemFocus?.(item.id)}
            onHoverEnd={() => onItemHoverEnd?.(item.id)}
            onHoverStart={() => onItemHoverStart?.(item.id)}
            {...(item.style === undefined ? {} : { style: item.style })}
          >
            {item.leading}
            <span className="jungle-toggle-group__label">{item.label}</span>
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </JellySurface>
  );
}
