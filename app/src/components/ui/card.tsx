import type { HTMLAttributes } from "react";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";

import { staticStylexClassName } from "../../lib/cn";
import { cardStyles } from "./primitives.stylex";

/**
 * `data-session-id` is declared rather than left to JSX's hyphen escape hatch,
 * because a component's props are type checked: the grid's pointer drag reads
 * it back through `elementFromPoint`, so the attribute has to survive the
 * spread onto the element.
 */
export type CardProps = Omit<HTMLAttributes<HTMLDivElement>, "style"> & Readonly<{
  "data-session-id"?: string;
  style?: never;
  xstyle?: StyleXStyles;
}>;

function rejectInlineStyle(style: unknown): void {
  if (style !== undefined) throw new Error("HRA primitives do not accept caller inline styles.");
}

export function Card({ className, style, xstyle, ...rest }: CardProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(cardStyles.root, xstyle);
  return (
    <div
      className={staticStylexClassName(presentation, className)}
      {...rest}
    />
  );
}

export function CardHeader({ className, style, xstyle, ...rest }: CardProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(cardStyles.header, xstyle);
  return <div className={staticStylexClassName(presentation, className)} {...rest} />;
}

export type CardTitleProps = Omit<HTMLAttributes<HTMLHeadingElement>, "style"> & Readonly<{
  style?: never;
  xstyle?: StyleXStyles;
}>;

export function CardTitle({ className, style, xstyle, ...rest }: CardTitleProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(cardStyles.title, xstyle);
  return <h2 className={staticStylexClassName(presentation, className)} {...rest} />;
}

export type CardDescriptionProps = Omit<HTMLAttributes<HTMLParagraphElement>, "style"> & Readonly<{
  style?: never;
  xstyle?: StyleXStyles;
}>;

export function CardDescription({ className, style, xstyle, ...rest }: CardDescriptionProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(cardStyles.description, xstyle);
  return <p className={staticStylexClassName(presentation, className)} {...rest} />;
}

export function CardContent({ className, style, xstyle, ...rest }: CardProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(cardStyles.content, xstyle);
  return <div className={staticStylexClassName(presentation, className)} {...rest} />;
}

export function CardFooter({ className, style, xstyle, ...rest }: CardProps) {
  rejectInlineStyle(style);
  const presentation = stylex.props(cardStyles.footer, xstyle);
  return <div className={staticStylexClassName(presentation, className)} {...rest} />;
}
