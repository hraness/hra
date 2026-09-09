import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { switchStyles } from "./primitives.stylex";

export type SwitchProps = Readonly<{
  checked: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  xstyle?: StyleXStyles;
}>;

/**
 * An owned switch rather than a Radix wrapper: `role="switch"` on a button with
 * `aria-checked` is the whole contract, and it keeps the dependency count at
 * zero for a primitive this app uses once.
 */
export function Switch({
  checked,
  className,
  disabled = false,
  id,
  label,
  onCheckedChange,
  xstyle,
}: SwitchProps) {
  const presentation = stylex.props(
    switchStyles.root,
    checked ? switchStyles.checked : switchStyles.unchecked,
    xstyle,
  );
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={staticStylexClassName(presentation, className)}
      disabled={disabled}
      id={id}
      onClick={() => { onCheckedChange(!checked); }}
      role="switch"
      type="button"
    >
      <span
        className={stylex.props(
          switchStyles.knob,
          checked ? switchStyles.knobChecked : switchStyles.knobUnchecked,
        ).className}
      />
    </button>
  );
}
