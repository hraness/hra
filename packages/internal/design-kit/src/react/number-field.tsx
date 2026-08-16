"use client";

import { MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { ReactNode, Ref } from "react";
import {
  ButtonContext,
  FieldError,
  Input as AriaInput,
  Label,
  NumberField as AriaNumberField,
  Provider,
  Text,
  type NumberFieldProps as AriaNumberFieldProps,
} from "react-aria-components";

import { Pressable } from "./card";
import { classNames } from "./class-names";
import { Icon } from "./icon";
import { JellySurface } from "./jelly-surface";
import type { FieldSize, FieldSurface } from "./text-field";

export type NumberFieldProps = Omit<AriaNumberFieldProps, "children" | "className"> & {
  readonly className?: string;
  readonly decrementLabel?: string;
  readonly description?: ReactNode;
  readonly errorMessage?: ReactNode;
  readonly incrementLabel?: string;
  readonly inputClassName?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly label: ReactNode;
  /** Supplementary action rendered beside the real clickable field label. */
  readonly labelAccessory?: ReactNode;
  readonly showLabel?: boolean;
  readonly size?: FieldSize;
  readonly surface?: FieldSurface;
};

export function NumberField({
  className,
  decrementLabel = "Decrease value",
  description,
  errorMessage,
  incrementLabel = "Increase value",
  inputClassName,
  inputRef,
  isDisabled = false,
  label,
  labelAccessory,
  showLabel = true,
  size = "default",
  surface = "default",
  ...props
}: NumberFieldProps) {
  return (
    <AriaNumberField
      {...props}
      className={classNames("jungle-number-field", className)}
      data-size={size}
      data-surface={surface}
      isDisabled={isDisabled}
    >
      {showLabel && labelAccessory !== undefined ? (
        <div className="jungle-number-field__label-row">
          <Label className="jungle-number-field__label">{label}</Label>
          <Provider values={[[ButtonContext, null]]}>
            <span className="jungle-number-field__label-accessory">{labelAccessory}</span>
          </Provider>
        </div>
      ) : showLabel ? (
        <Label className="jungle-number-field__label">{label}</Label>
      ) : (
        <Label className="jungle-visually-hidden">{label}</Label>
      )}
      <div className="jungle-number-field__control">
        <JellySurface
          aria-hidden="true"
          className="jungle-number-field__surface"
          interaction="passive"
          isDisabled={isDisabled}
          tone="field"
        >
          <span className="jungle-number-field__surface-fill" />
        </JellySurface>
        <Pressable
          aria-label={decrementLabel}
          className="jungle-number-field__step"
          slot="decrement"
          type="button"
        >
          <Icon icon={MinusSignIcon} />
        </Pressable>
        <AriaInput
          className={classNames("jungle-number-field__input", inputClassName)}
          ref={inputRef}
        />
        <Pressable
          aria-label={incrementLabel}
          className="jungle-number-field__step"
          slot="increment"
          type="button"
        >
          <Icon icon={PlusSignIcon} />
        </Pressable>
      </div>
      {description === undefined ? null : (
        <Text className="jungle-number-field__description" slot="description">{description}</Text>
      )}
      {errorMessage === undefined ? null : (
        <FieldError className="jungle-number-field__error">{errorMessage}</FieldError>
      )}
    </AriaNumberField>
  );
}
