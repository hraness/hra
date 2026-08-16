"use client";

import { type InputHTMLAttributes, type ReactNode, type Ref, useId } from "react";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";

export type CheckboxFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children" | "size" | "type"
> & {
  readonly className?: string;
  readonly description?: ReactNode;
  readonly inputClassName?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly label: ReactNode;
};

export function CheckboxField({
  "aria-describedby": ariaDescribedBy,
  "aria-labelledby": ariaLabelledBy,
  className,
  description,
  disabled = false,
  id,
  inputClassName,
  inputRef,
  label,
  ...props
}: CheckboxFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const labelId = `${controlId}-label`;
  const descriptionId = `${controlId}-description`;
  const labelledBy = [ariaLabelledBy, labelId]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ");
  const describedBy = [ariaDescribedBy, description === undefined ? undefined : descriptionId]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ") || undefined;

  return (
    <div className={classNames("jungle-checkbox-field", className)}>
      <label className="jungle-checkbox-field__control">
        <JellySurface
          className="jungle-checkbox-field__surface"
          interaction="press"
          isDisabled={disabled}
          tone="field"
        >
          <input
            {...props}
            aria-describedby={describedBy}
            aria-labelledby={labelledBy}
            className={classNames("jungle-checkbox-field__input", inputClassName)}
            disabled={disabled}
            id={controlId}
            ref={inputRef}
            type="checkbox"
          />
          <span aria-hidden="true" className="jungle-checkbox-field__indicator" />
        </JellySurface>
        <span className="jungle-checkbox-field__copy">
          <span className="jungle-checkbox-field__label" id={labelId}>{label}</span>
          {description === undefined ? null : (
            <span className="jungle-checkbox-field__description" id={descriptionId}>
              {description}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}
