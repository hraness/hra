"use client";

import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { ComponentProps, Ref } from "react";
import {
  Input as AriaInput,
  Label,
  SearchField as AriaSearchField,
  type SearchFieldProps as AriaSearchFieldProps,
} from "react-aria-components";

import { IconButton } from "./button";
import { classNames } from "./class-names";
import { Icon } from "./icon";
import { JellySurface } from "./jelly-surface";

export type SearchFieldSize = "compact" | "default" | "large";
export type SearchFieldSurface = "card" | "default" | "pane";

export type SearchFieldProps = Omit<
  AriaSearchFieldProps,
  "aria-label" | "children" | "className"
> & {
  readonly className?: string;
  readonly clearLabel?: string;
  readonly inputClassName?: string;
  readonly inputProps?: Omit<
    ComponentProps<typeof AriaInput>,
    "className" | "placeholder" | "ref" | "type"
  >;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly label: string;
  readonly placeholder?: string;
  readonly showLabel?: boolean;
  readonly size?: SearchFieldSize;
  readonly surface?: SearchFieldSurface;
};

export function SearchField({
  className,
  clearLabel = "Clear search",
  inputClassName,
  inputProps,
  inputRef,
  isDisabled = false,
  label,
  placeholder = "Search…",
  showLabel = false,
  size = "default",
  surface = "default",
  ...props
}: SearchFieldProps) {
  return (
    <AriaSearchField
      {...props}
      className={classNames("jungle-search-field", className)}
      data-size={size}
      data-surface={surface}
      isDisabled={isDisabled}
    >
      {({ isEmpty }) => (
        <>
          <Label className={showLabel ? "jungle-search-field__label" : "jungle-visually-hidden"}>
            {label}
          </Label>
          <JellySurface
            className="jungle-search-field__control"
            interaction="field"
            isDisabled={isDisabled}
            tone="field"
          >
            <Icon className="jungle-search-field__search-icon" icon={Search01Icon} />
            <AriaInput
              {...inputProps}
              className={classNames("jungle-search-field__input", inputClassName)}
              placeholder={placeholder}
              ref={inputRef}
              type="search"
            />
            {isEmpty ? null : (
              <IconButton aria-label={clearLabel} className="jungle-search-field__clear" size="compact">
                <Icon icon={Cancel01Icon} />
              </IconButton>
            )}
          </JellySurface>
        </>
      )}
    </AriaSearchField>
  );
}
