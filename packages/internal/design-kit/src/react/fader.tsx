"use client";

import type { ReactNode, Ref, RefObject } from "react";
import {
  Label,
  Slider as AriaSlider,
  SliderFill,
  SliderOutput,
  type SliderProps as AriaSliderProps,
  SliderThumb,
  SliderTrack,
} from "react-aria-components";

import { classNames } from "./class-names";

export type FaderProps = Omit<
  AriaSliderProps<number>,
  "children" | "className"
> & {
  readonly className?: string;
  readonly density?: "compact" | "default";
  readonly faderRef?: Ref<HTMLDivElement>;
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  readonly label: ReactNode;
  /** Supplementary action rendered beside the real clickable slider label. */
  readonly labelAccessory?: ReactNode;
  readonly showLabel?: boolean;
  readonly showOutput?: boolean;
};

/** A single-value vertical slider with a touch-sized track and native keyboard semantics. */
export function Fader({
  className,
  density = "default",
  faderRef,
  inputRef,
  label,
  labelAccessory,
  orientation = "vertical",
  showLabel = false,
  showOutput = false,
  ...props
}: FaderProps) {
  return (
    <AriaSlider
      {...props}
      className={classNames("jungle-fader", className)}
      data-density={density}
      orientation={orientation}
      ref={faderRef}
    >
      {showLabel && labelAccessory !== undefined ? (
        <div className="jungle-fader__label-row">
          <Label className="jungle-fader__label">{label}</Label>
          <span className="jungle-fader__label-accessory">{labelAccessory}</span>
        </div>
      ) : showLabel ? (
        <Label className="jungle-fader__label">{label}</Label>
      ) : (
        <Label className="jungle-visually-hidden">{label}</Label>
      )}
      {showOutput ? <SliderOutput className="jungle-fader__output" /> : null}
      <SliderTrack className="jungle-fader__track">
        <SliderFill className="jungle-fader__fill" />
        <SliderThumb
          className="jungle-fader__thumb"
          {...(inputRef === undefined ? {} : { inputRef })}
        />
      </SliderTrack>
    </AriaSlider>
  );
}
