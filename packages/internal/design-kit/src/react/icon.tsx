"use client";

import {
  Icon as PortableIcon,
  type IconProps as PortableIconProps,
} from "@hraness/ui";
import { classNames } from "./class-names";

export type IconProps = PortableIconProps;

/**
 * Canonical web renderer for HugeIcons. Icons are decorative by default, inherit
 * `currentColor`, and retain their intrinsic size in flex rows. Put the accessible
 * name on the adjacent text or enclosing icon button.
 */
export function Icon({
  className,
  icon,
  size = 20,
  strokeWidth = 1.5,
}: IconProps) {
  return (
    <PortableIcon
      className={classNames("jungle-icon", className)}
      icon={icon}
      size={size}
      strokeWidth={strokeWidth}
    />
  );
}
