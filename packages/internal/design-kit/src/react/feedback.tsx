import { type CSSProperties, type HTMLAttributes, type ReactNode, useId } from "react";

import { classNames } from "./class-names";

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  readonly label?: string;
  readonly size?: "large" | "small" | "default";
}

export function Spinner({ className, label, size = "default", ...props }: SpinnerProps) {
  return (
    <span
      {...props}
      aria-hidden={label === undefined ? "true" : undefined}
      className={classNames("jungle-spinner", className)}
      data-size={size}
      role={label === undefined ? undefined : "status"}
    >
      {label === undefined ? null : <span className="jungle-visually-hidden">{label}</span>}
    </span>
  );
}

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  readonly height?: CSSProperties["height"];
  readonly isText?: boolean;
  readonly width?: CSSProperties["width"];
}

export function Skeleton({
  className,
  height,
  isText = false,
  style,
  width,
  ...props
}: SkeletonProps) {
  return (
    <div
      {...props}
      aria-hidden="true"
      className={classNames("jungle-skeleton", className)}
      data-text={isText || undefined}
      style={{ ...style, height, width }}
    />
  );
}

export interface NormalizedProgress {
  readonly maximum: number;
  readonly percent: number;
  readonly value: number;
}

export function normalizeProgress(value: number, maximum: number): NormalizedProgress {
  const safeMaximum = Number.isFinite(maximum) && maximum > 0 ? maximum : 100;
  const finiteValue = Number.isFinite(value) ? value : 0;
  const safeValue = Math.min(safeMaximum, Math.max(0, finiteValue));
  return {
    maximum: safeMaximum,
    percent: (safeValue / safeMaximum) * 100,
    value: safeValue,
  };
}

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly label: ReactNode;
  readonly max?: number;
  readonly showValue?: boolean;
  readonly value: number;
}

export function Progress({
  className,
  label,
  max = 100,
  showValue = false,
  value,
  ...props
}: ProgressProps) {
  const normalized = normalizeProgress(value, max);
  const labelId = `${useId()}-label`;
  return (
    <div {...props} className={classNames("jungle-progress", className)}>
      <div className="jungle-progress__label-row">
        <span id={labelId}>{label}</span>
        {showValue ? <span>{Math.round(normalized.percent)}%</span> : null}
      </div>
      <progress
        aria-labelledby={labelId}
        className="jungle-progress__control"
        max={normalized.maximum}
        value={normalized.value}
      />
    </div>
  );
}
