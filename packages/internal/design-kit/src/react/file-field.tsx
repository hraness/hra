"use client";

import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { useId } from "react";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";

export type FileFieldProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "children" | "defaultValue" | "size" | "type" | "value"
> & {
  readonly className?: string;
  readonly description?: ReactNode;
  readonly inputClassName?: string;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly label: ReactNode;
  readonly showLabel?: boolean;
};

export function FileField({
  "aria-describedby": ariaDescribedBy,
  className,
  description,
  disabled = false,
  id,
  inputClassName,
  inputRef,
  label,
  showLabel = true,
  ...props
}: FileFieldProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = `${controlId}-description`;
  const describedBy = [ariaDescribedBy, description === undefined ? undefined : descriptionId]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ") || undefined;

  return (
    <div className={classNames("jungle-file-field", className)}>
      <label
        className={showLabel ? "jungle-file-field__label" : "jungle-visually-hidden"}
        htmlFor={controlId}
      >
        {label}
      </label>
      <JellySurface
        className="jungle-file-field__surface"
        interaction="field"
        isDisabled={disabled}
        tone="field"
      >
        <input
          {...props}
          aria-describedby={describedBy}
          className={classNames("jungle-file-field__input", inputClassName)}
          disabled={disabled}
          id={controlId}
          ref={inputRef}
          type="file"
        />
      </JellySurface>
      {description === undefined ? null : (
        <span className="jungle-file-field__description" id={descriptionId}>{description}</span>
      )}
    </div>
  );
}
