"use client";

import {
  type ChangeEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  useId,
} from "react";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";
import type { FieldSize, FieldSurface } from "./text-field";

export interface SelectOption<Id extends string> {
  readonly disabled?: boolean;
  readonly id: Id;
  readonly label: ReactNode;
}

export type SelectFieldProps<Id extends string> = Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "children" | "defaultValue" | "onChange" | "size" | "value"
> & {
  readonly className?: string;
  readonly defaultValue?: Id | "";
  readonly description?: ReactNode;
  readonly errorMessage?: ReactNode;
  readonly isInvalid?: boolean;
  readonly label: ReactNode;
  /** Supplementary action rendered beside the real clickable field label. */
  readonly labelAccessory?: ReactNode;
  readonly onChange?: (value: Id, event: ChangeEvent<HTMLSelectElement>) => void;
  readonly options: readonly SelectOption<Id>[];
  readonly placeholder?: string;
  readonly selectClassName?: string;
  readonly selectRef?: Ref<HTMLSelectElement>;
  readonly showLabel?: boolean;
  readonly size?: FieldSize;
  readonly surface?: FieldSurface;
  readonly value?: Id | "";
};

export function SelectField<Id extends string>({
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  className,
  defaultValue,
  description,
  disabled = false,
  errorMessage,
  id,
  isInvalid,
  label,
  labelAccessory,
  onChange,
  options,
  placeholder,
  selectClassName,
  selectRef,
  showLabel = true,
  size = "default",
  surface = "default",
  value,
  ...props
}: SelectFieldProps<Id>) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = description === undefined ? undefined : `${controlId}-description`;
  const errorId = errorMessage === undefined ? undefined : `${controlId}-error`;
  const describedBy = [ariaDescribedBy, descriptionId, errorId]
    .filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0)
    .join(" ") || undefined;
  const ariaReportsInvalid = ariaInvalid === true
    || ariaInvalid === "true"
    || ariaInvalid === "grammar"
    || ariaInvalid === "spelling";
  const invalid = isInvalid === true || ariaReportsInvalid || errorMessage !== undefined;
  const resolvedAriaInvalid = ariaReportsInvalid
    ? ariaInvalid
    : invalid
      ? true
      : ariaInvalid;

  return (
    <div
      className={classNames("jungle-select-field", className)}
      data-invalid={invalid ? "true" : undefined}
      data-size={size}
      data-surface={surface}
    >
      {showLabel && labelAccessory !== undefined ? (
        <div className="jungle-select-field__label-row">
          <label className="jungle-select-field__label" htmlFor={controlId}>{label}</label>
          <span className="jungle-select-field__label-accessory">{labelAccessory}</span>
        </div>
      ) : showLabel ? (
        <label className="jungle-select-field__label" htmlFor={controlId}>{label}</label>
      ) : (
        <label className="jungle-visually-hidden" htmlFor={controlId}>{label}</label>
      )}
      <JellySurface
        className="jungle-select-field__surface"
        interaction="field"
        isDisabled={disabled}
        tone="field"
      >
        <select
          {...props}
          aria-describedby={describedBy}
          aria-invalid={resolvedAriaInvalid}
          className={classNames("jungle-select-field__control", selectClassName)}
          disabled={disabled}
          {...(defaultValue === undefined ? {} : { defaultValue })}
          id={controlId}
          onChange={(event) => {
            const next = options.find((option) => option.id === event.currentTarget.value);
            if (next !== undefined) onChange?.(next.id, event);
          }}
          ref={selectRef}
          {...(value === undefined ? {} : { value })}
        >
          {placeholder === undefined ? null : <option disabled value="">{placeholder}</option>}
          {options.map((option) => (
            <option disabled={option.disabled} key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </JellySurface>
      {description === undefined ? null : (
        <span className="jungle-select-field__description" id={descriptionId}>{description}</span>
      )}
      {errorMessage === undefined ? null : (
        <span className="jungle-select-field__error" id={errorId}>{errorMessage}</span>
      )}
    </div>
  );
}
