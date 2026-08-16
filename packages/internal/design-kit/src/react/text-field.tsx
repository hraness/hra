"use client";

import type { ComponentProps, ReactNode, Ref } from "react";
import {
  FieldError,
  Input as AriaInput,
  Label,
  Text,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";

export type FieldSize = "compact" | "default" | "large";
export type FieldSurface = "card" | "default" | "pane";

type SharedFieldProps = Omit<AriaTextFieldProps, "children" | "className"> & {
  readonly className?: string;
  readonly description?: ReactNode;
  readonly errorMessage?: ReactNode;
  readonly label: ReactNode;
  /** Supplementary action rendered beside the real clickable field label. */
  readonly labelAccessory?: ReactNode;
  readonly placeholder?: string;
  readonly showLabel?: boolean;
  readonly size?: FieldSize;
  readonly surface?: FieldSurface;
};

export type TextFieldProps = SharedFieldProps & {
  readonly inputAttributes?: Pick<
    ComponentProps<typeof AriaInput>,
    | "autoCapitalize"
    | "autoComplete"
    | "inputMode"
    | "max"
    | "min"
    | "spellCheck"
    | "step"
  >;
  readonly inputClassName?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
};

export function TextField({
  className,
  description,
  errorMessage,
  inputAttributes,
  inputClassName,
  inputRef,
  isDisabled = false,
  label,
  labelAccessory,
  placeholder,
  showLabel = true,
  size = "default",
  surface = "default",
  ...props
}: TextFieldProps) {
  return (
    <AriaTextField
      {...props}
      className={classNames("jungle-field", className)}
      data-size={size}
      data-surface={surface}
      isDisabled={isDisabled}
    >
      {showLabel && labelAccessory !== undefined ? (
        <div className="jungle-field__label-row">
          <Label className="jungle-field__label">{label}</Label>
          <span className="jungle-field__label-accessory">{labelAccessory}</span>
        </div>
      ) : showLabel ? (
        <Label className="jungle-field__label">{label}</Label>
      ) : (
        <Label className="jungle-visually-hidden">{label}</Label>
      )}
      <JellySurface
        className="jungle-field__surface"
        interaction="field"
        isDisabled={isDisabled}
        tone="field"
      >
        <AriaInput
          {...inputAttributes}
          className={classNames("jungle-field__input", inputClassName)}
          ref={inputRef}
          {...(placeholder === undefined ? {} : { placeholder })}
        />
      </JellySurface>
      {description === undefined ? null : (
        <Text className="jungle-field__description" slot="description">{description}</Text>
      )}
      {errorMessage === undefined ? null : (
        <FieldError className="jungle-field__error">{errorMessage}</FieldError>
      )}
    </AriaTextField>
  );
}

export type TextAreaFieldProps = SharedFieldProps & {
  /** Textareas stay layout-stable by default; opt into native vertical resizing when useful. */
  readonly resize?: "none" | "vertical";
  readonly textAreaClassName?: string;
  readonly textAreaProps?: Pick<
    ComponentProps<typeof AriaTextArea>,
    "maxLength" | "minLength" | "rows" | "wrap"
  >;
  readonly textAreaRef?: Ref<HTMLTextAreaElement>;
};

export function TextAreaField({
  className,
  description,
  errorMessage,
  isDisabled = false,
  label,
  labelAccessory,
  placeholder,
  resize = "none",
  showLabel = true,
  size = "default",
  surface = "default",
  textAreaClassName,
  textAreaProps,
  textAreaRef,
  ...props
}: TextAreaFieldProps) {
  return (
    <AriaTextField
      {...props}
      className={classNames("jungle-field", "jungle-field--multiline", className)}
      data-resize={resize}
      data-size={size}
      data-surface={surface}
      isDisabled={isDisabled}
    >
      {showLabel && labelAccessory !== undefined ? (
        <div className="jungle-field__label-row">
          <Label className="jungle-field__label">{label}</Label>
          <span className="jungle-field__label-accessory">{labelAccessory}</span>
        </div>
      ) : showLabel ? (
        <Label className="jungle-field__label">{label}</Label>
      ) : (
        <Label className="jungle-visually-hidden">{label}</Label>
      )}
      <JellySurface
        className="jungle-field__surface"
        interaction="field"
        isDisabled={isDisabled}
        tone="field"
      >
        <AriaTextArea
          {...textAreaProps}
          className={classNames("jungle-field__input", textAreaClassName)}
          ref={textAreaRef}
          {...(placeholder === undefined ? {} : { placeholder })}
        />
      </JellySurface>
      {description === undefined ? null : (
        <Text className="jungle-field__description" slot="description">{description}</Text>
      )}
      {errorMessage === undefined ? null : (
        <FieldError className="jungle-field__error">{errorMessage}</FieldError>
      )}
    </AriaTextField>
  );
}
