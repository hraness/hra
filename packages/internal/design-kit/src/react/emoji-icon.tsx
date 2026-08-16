"use client";

import {
  useId,
  type CSSProperties,
  type SVGAttributes,
} from "react";

import { classNames } from "./class-names";

const HEX_COLOR = /^#[0-9A-F]{6}$/u;

const DUOTONE_PRIMARY = "#F2F2ED";
const DUOTONE_SECONDARY = "#858982";

const EMBEDDED_IMAGE_SOURCE = /^data:image\/(?:png|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u;

export type EmojiIconSource = Readonly<{
  /** Root-relative same-origin image URL, or an embedded gallery fixture. */
  src: string;
  /** Number of square cells from the left edge of the sprite page. */
  column: number;
  /** Number of square cells from the top edge of the sprite page. */
  row: number;
  /** Side length of one sprite cell in source pixels. */
  cellSize: number;
  /** Full sprite-page width in source pixels. */
  pageWidth: number;
  /** Full sprite-page height in source pixels. */
  pageHeight: number;
}>;

type EmojiIconBaseProps = Omit<
  SVGAttributes<SVGSVGElement>,
  "aria-hidden" | "aria-label" | "children" | "color" | "role"
> & {
  /** Optional accessible name. Omit it when adjacent text already names the icon. */
  readonly label?: string;
  /** Square icon size in CSS pixels. */
  readonly size?: number;
  /** Cropped sprite page and cell coordinates supplied by the consuming product. */
  readonly source: EmojiIconSource;
};

export type EmojiIconProps = EmojiIconBaseProps & (
  | {
      readonly dominantColor: string;
      readonly variant: "dominant-color-duotone";
    }
  | {
      readonly dominantColor?: never;
      readonly variant?: "duotone";
    }
);

type Rgb = readonly [number, number, number];

function parseHexColor(value: string): Rgb {
  if (!HEX_COLOR.test(value)) {
    throw new Error(`EmojiIcon colors must use uppercase six-digit hex: ${value}`);
  }

  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
  ];
}

function transferValues(secondary: Rgb, primary: Rgb, channel: 0 | 1 | 2) {
  return `${secondary[channel].toFixed(6)} ${primary[channel].toFixed(6)}`;
}

function assertPositiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`EmojiIcon source ${field} must be a positive safe integer.`);
  }
}

function assertNonnegativeSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`EmojiIcon source ${field} must be a nonnegative safe integer.`);
  }
}

function resolveSpriteCrop(source: EmojiIconSource) {
  if (source.src.length === 0) {
    throw new Error("EmojiIcon source src must be nonempty.");
  }

  if (!EMBEDDED_IMAGE_SOURCE.test(source.src)) {
    let parsed: URL;
    try {
      parsed = new URL(source.src, "https://emoji-icon.invalid");
    } catch {
      throw new Error("EmojiIcon source src must be a root-relative same-origin image URL.");
    }
    if (
      !source.src.startsWith("/")
      || source.src.startsWith("//")
      || parsed.origin !== "https://emoji-icon.invalid"
    ) {
      throw new Error("EmojiIcon source src must be a root-relative same-origin image URL.");
    }
  }

  assertNonnegativeSafeInteger(source.column, "column");
  assertNonnegativeSafeInteger(source.row, "row");
  assertPositiveSafeInteger(source.cellSize, "cellSize");
  assertPositiveSafeInteger(source.pageWidth, "pageWidth");
  assertPositiveSafeInteger(source.pageHeight, "pageHeight");

  const x = source.column * source.cellSize;
  const y = source.row * source.cellSize;
  if (!Number.isSafeInteger(x) || x + source.cellSize > source.pageWidth) {
    throw new Error("EmojiIcon source column falls outside the sprite page.");
  }
  if (!Number.isSafeInteger(y) || y + source.cellSize > source.pageHeight) {
    throw new Error("EmojiIcon source row falls outside the sprite page.");
  }

  return { x, y } as const;
}

/**
 * Crops one cell from a consumer-supplied sprite page and applies a two-color
 * luminance transfer. Emoji identity and asset resolution stay product-owned.
 */
export function EmojiIcon({
  className,
  dominantColor,
  label,
  size = 18,
  source,
  style,
  variant = "duotone",
  ...props
}: EmojiIconProps) {
  const filterId = `emoji-duotone-${useId().replaceAll(":", "")}`;

  if (label !== undefined && label.trim().length === 0) {
    throw new Error("EmojiIcon labels must be nonempty when provided.");
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new Error("EmojiIcon size must be a positive finite number.");
  }

  const primaryColor = variant === "dominant-color-duotone"
    ? dominantColor
    : DUOTONE_PRIMARY;
  if (primaryColor === undefined) {
    throw new Error("Dominant-color duotone emoji icons require a dominant color.");
  }
  const primary = parseHexColor(primaryColor);
  const secondary = parseHexColor(DUOTONE_SECONDARY);
  const crop = resolveSpriteCrop(source);
  const dimensions: CSSProperties = { height: size, width: size, ...style };

  return (
    <svg
      {...props}
      {...(label === undefined
        ? { "aria-hidden": true }
        : { "aria-label": label, role: "img" })}
      className={classNames("jungle-emoji-icon", className)}
      data-slot="emoji-icon"
      data-variant={variant}
      style={dimensions}
      viewBox={`0 0 ${source.cellSize} ${source.cellSize}`}
    >
      <defs>
        <filter
          colorInterpolationFilters="sRGB"
          height="140%"
          id={filterId}
          width="140%"
          x="-20%"
          y="-20%"
        >
          <feColorMatrix type="saturate" values="0" />
          <feComponentTransfer>
            <feFuncR
              tableValues={transferValues(secondary, primary, 0)}
              type="discrete"
            />
            <feFuncG
              tableValues={transferValues(secondary, primary, 1)}
              type="discrete"
            />
            <feFuncB
              tableValues={transferValues(secondary, primary, 2)}
              type="discrete"
            />
          </feComponentTransfer>
        </filter>
      </defs>
      <image
        aria-hidden="true"
        filter={`url(#${filterId})`}
        focusable="false"
        height={source.pageHeight}
        href={source.src}
        preserveAspectRatio="none"
        width={source.pageWidth}
        x={-crop.x}
        y={-crop.y}
      />
    </svg>
  );
}
