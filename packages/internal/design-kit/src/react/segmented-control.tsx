"use client";

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Radio, RadioGroup } from "react-aria-components";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";
import { firstOwnedStringId } from "./selection";
import { Tooltip } from "./tooltip";

export interface SegmentedItem<Id extends string> {
  /** Required when the visible label is an icon or otherwise non-textual. */
  readonly ariaLabel?: string;
  readonly id: Id;
  readonly label: ReactNode;
  readonly leading?: ReactNode;
  /** Supplementary pointer and keyboard discovery for compact icon choices. */
  readonly tooltip?: ReactNode;
}

export interface SegmentedControlProps<Id extends string> {
  readonly "aria-label": string;
  readonly className?: string;
  readonly isDisabled?: boolean;
  readonly items: readonly SegmentedItem<Id>[];
  readonly onChange: (id: Id) => void;
  readonly size?: "compact" | "default";
  readonly surfaceClassName?: string;
  readonly value: Id;
}

interface SegmentedRadioItemProps {
  readonly hoveredTooltipId: string | null;
  readonly isFocusTooltipDismissed: boolean;
  readonly item: SegmentedItem<string>;
  readonly setHoveredTooltipId: (id: string | null) => void;
  readonly setIsFocusTooltipDismissed: (isDismissed: boolean) => void;
}

interface SegmentedRadioTooltipProps {
  readonly isOpen: boolean;
  readonly label: ReactNode;
  readonly setHoveredTooltipId: (id: string | null) => void;
  readonly setIsFocusTooltipDismissed: (isDismissed: boolean) => void;
  readonly triggerRef: RefObject<HTMLLabelElement | null>;
}

function SegmentedRadioTooltip({
  isOpen,
  label,
  setHoveredTooltipId,
  setIsFocusTooltipDismissed,
  triggerRef,
}: Readonly<SegmentedRadioTooltipProps>) {
  useEffect(() => {
    if (!isOpen) return undefined;
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setIsFocusTooltipDismissed(true);
      setHoveredTooltipId(null);
    };
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => document.removeEventListener("keydown", dismissOnEscape, true);
  }, [isOpen, setHoveredTooltipId, setIsFocusTooltipDismissed]);

  return <Tooltip isOpen={isOpen} label={label} triggerRef={triggerRef} />;
}

function SegmentedRadioItem({
  hoveredTooltipId,
  isFocusTooltipDismissed,
  item,
  setHoveredTooltipId,
  setIsFocusTooltipDismissed,
}: Readonly<SegmentedRadioItemProps>) {
  const labelRef = useRef<HTMLLabelElement>(null);
  return (
    <Radio
      {...(item.ariaLabel === undefined ? {} : { "aria-label": item.ariaLabel })}
      className="jungle-segmented-control__item"
      onBlur={() => setIsFocusTooltipDismissed(false)}
      onFocus={() => setIsFocusTooltipDismissed(false)}
      onHoverEnd={() => setHoveredTooltipId(null)}
      onHoverStart={() => {
        setIsFocusTooltipDismissed(false);
        setHoveredTooltipId(item.id);
      }}
      onPressStart={() => {
        setIsFocusTooltipDismissed(true);
        setHoveredTooltipId(null);
      }}
      ref={labelRef}
      value={item.id}
    >
      {({ isFocusVisible }) => {
        const isTooltipOpen = item.tooltip !== undefined
          && (
            hoveredTooltipId === null
              ? isFocusVisible && !isFocusTooltipDismissed
              : hoveredTooltipId === item.id
          );
        return (
          <span className="jungle-segmented-control__item-content">
            {item.leading === undefined ? null : (
              <span className="jungle-segmented-control__item-leading">{item.leading}</span>
            )}
            <span className="jungle-segmented-control__item-label">{item.label}</span>
            {item.tooltip === undefined ? null : (
              <SegmentedRadioTooltip
                isOpen={isTooltipOpen}
                label={item.tooltip}
                setHoveredTooltipId={setHoveredTooltipId}
                setIsFocusTooltipDismissed={setIsFocusTooltipDismissed}
                triggerRef={labelRef}
              />
            )}
          </span>
        );
      }}
    </Radio>
  );
}

export function SegmentedControl<Id extends string>({
  "aria-label": ariaLabel,
  className,
  isDisabled = false,
  items,
  onChange,
  size = "default",
  surfaceClassName,
  value,
}: SegmentedControlProps<Id>) {
  const [hoveredTooltipId, setHoveredTooltipId] = useState<string | null>(null);
  const [isFocusTooltipDismissed, setIsFocusTooltipDismissed] = useState(false);
  const normalizedValue = firstOwnedStringId(items, new Set([value])) ?? items[0]?.id;
  return (
    <JellySurface
      className={classNames("jungle-segmented-control__surface", surfaceClassName)}
      interaction="press"
      isDisabled={isDisabled}
      tone="neutral"
    >
      <RadioGroup
        aria-label={ariaLabel}
        className={classNames("jungle-segmented-control", className)}
        data-size={size}
        isDisabled={isDisabled}
        onChange={(key) => {
          const next = firstOwnedStringId(items, new Set([key]));
          if (next !== null) onChange(next);
        }}
        orientation="horizontal"
        {...(normalizedValue === undefined ? {} : { value: normalizedValue })}
      >
        {items.map((item) => (
          <SegmentedRadioItem
            hoveredTooltipId={hoveredTooltipId}
            isFocusTooltipDismissed={isFocusTooltipDismissed}
            item={item}
            key={item.id}
            setHoveredTooltipId={setHoveredTooltipId}
            setIsFocusTooltipDismissed={setIsFocusTooltipDismissed}
          />
        ))}
      </RadioGroup>
    </JellySurface>
  );
}
