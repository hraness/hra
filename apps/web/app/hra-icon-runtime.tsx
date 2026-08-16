"use client";

import {
  createElement,
  forwardRef,
  type RefAttributes,
  type SVGProps,
} from "react";

import type { HraIconData } from "./hra-icon-data";

export type IconSvgElement = HraIconData;
export type SVGAttributes = Partial<SVGProps<SVGSVGElement>>;
export type HraSvgIconProps = SVGAttributes & RefAttributes<SVGSVGElement> & Readonly<{
  absoluteStrokeWidth?: boolean;
  altIcon?: IconSvgElement;
  disableSecondaryOpacity?: boolean;
  icon: IconSvgElement;
  primaryColor?: string;
  secondaryColor?: string;
  showAlt?: boolean;
  size?: number | string;
  strokeWidth?: number;
}>;

const HraSvgIcon = forwardRef<SVGSVGElement, HraSvgIconProps>(function HraSvgIcon({
  absoluteStrokeWidth = false,
  altIcon,
  color = "currentColor",
  disableSecondaryOpacity = false,
  icon,
  primaryColor,
  secondaryColor,
  showAlt = false,
  size = 24,
  strokeWidth,
  ...props
}, ref) {
  const resolvedStrokeWidth = strokeWidth === undefined
    ? undefined
    : absoluteStrokeWidth
      ? (strokeWidth * 24) / Number(size)
      : strokeWidth;
  const glyph = showAlt && altIcon !== undefined ? altIcon : icon;
  const children = glyph.map(([tag, attributes]) => {
    const secondary = attributes.opacity !== undefined;
    const palette = secondaryColor === undefined
      ? {}
      : attributes.stroke === undefined
        ? { fill: secondary ? secondaryColor : (primaryColor ?? color) }
        : { stroke: secondary ? secondaryColor : (primaryColor ?? color) };
    return createElement(tag, {
      ...attributes,
      ...(resolvedStrokeWidth === undefined ? {} : { strokeWidth: resolvedStrokeWidth }),
      ...palette,
      key: attributes.key,
      opacity: secondary && !disableSecondaryOpacity ? attributes.opacity : undefined,
    });
  });

  return (
    <svg
      {...props}
      color={primaryColor ?? color}
      fill="none"
      height={size}
      ref={ref}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={resolvedStrokeWidth}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
});

export { HraSvgIcon as HugeiconsIcon };
export default HraSvgIcon;
