import type {
  HTMLAttributes,
  ReactNode,
} from "react";
import { forwardRef } from "react";

import { classNames } from "./class-names";

export type ThemedSurfaceTone = "accent" | "card" | "inverse" | "popover" | "secondary";
export type SurfaceShape = "rectangular" | "rounded";

export interface ViewportFrameProps extends HTMLAttributes<HTMLElement> {
  readonly as?: "div" | "main" | "section";
}

/** Owns exactly one visual viewport; descendants own any intentional scrolling. */
export function ViewportFrame({
  as = "div",
  className,
  ...props
}: ViewportFrameProps) {
  const Element = as;
  return (
    <Element
      {...props}
      className={classNames("jungle-viewport-frame", className)}
    />
  );
}

export interface WrappingRowProps extends HTMLAttributes<HTMLElement> {
  readonly as?: "div" | "footer" | "header" | "nav" | "section" | "span";
}

/** Keeps inline content inside its available width by wrapping before clipping. */
export function WrappingRow({
  as = "div",
  className,
  ...props
}: WrappingRowProps) {
  const Element = as;
  return (
    <Element
      {...props}
      className={classNames("jungle-wrapping-row", className)}
    />
  );
}

export interface ThemedSurfaceProps extends HTMLAttributes<HTMLElement> {
  readonly as?: "article" | "div" | "section";
  readonly shape?: SurfaceShape;
  readonly tone?: ThemedSurfaceTone;
}

export function ThemedSurface({
  as = "div",
  className,
  shape = "rounded",
  tone = "card",
  ...props
}: ThemedSurfaceProps) {
  const Element = as;
  return (
    <Element
      {...props}
      className={classNames("jungle-themed-surface", className)}
      data-shape={shape}
      data-tone={tone}
    />
  );
}

export interface DitherSurfaceProps extends ThemedSurfaceProps {
  readonly density?: "coarse" | "fine" | "medium";
}

export function DitherSurface({
  className,
  density = "medium",
  ...props
}: DitherSurfaceProps) {
  return (
    <ThemedSurface
      {...props}
      className={classNames("jungle-dither-surface", className)}
      data-density={density}
    />
  );
}

export interface TopBarProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly actions?: ReactNode;
  readonly leading?: ReactNode;
  readonly position?: "static" | "sticky";
  readonly surface?: "glass" | "solid";
  readonly title?: ReactNode;
}

export function TopBar({
  actions,
  children,
  className,
  leading,
  position = "static",
  surface = "solid",
  title,
  ...props
}: TopBarProps) {
  return (
    <header
      {...props}
      className={classNames("jungle-top-bar", className)}
      data-position={position}
      data-surface={surface}
    >
      <div className="jungle-top-bar__leading">
        {leading}
        {title === undefined ? null : <div className="jungle-top-bar__title">{title}</div>}
      </div>
      {children === undefined ? null : <div className="jungle-top-bar__content">{children}</div>}
      {actions === undefined ? null : <div className="jungle-top-bar__actions">{actions}</div>}
    </header>
  );
}

export interface BottomBarProps extends HTMLAttributes<HTMLElement> {
  readonly actions?: ReactNode;
  readonly leading?: ReactNode;
}

export function BottomBar({ actions, children, className, leading, ...props }: BottomBarProps) {
  return (
    <footer {...props} className={classNames("jungle-bottom-bar", className)}>
      {leading === undefined ? null : <div className="jungle-bottom-bar__leading">{leading}</div>}
      <div className="jungle-bottom-bar__content">{children}</div>
      {actions === undefined ? null : <div className="jungle-bottom-bar__actions">{actions}</div>}
    </footer>
  );
}

export interface PageCanvasProps extends HTMLAttributes<HTMLElement> {
  readonly as?: "div" | "main";
  readonly inset?: "content" | "none";
  readonly size?: "default" | "full" | "wide";
}

export function PageCanvas({
  as = "main",
  className,
  inset = "content",
  size = "default",
  ...props
}: PageCanvasProps) {
  const Element = as;
  return (
    <Element
      {...props}
      className={classNames("jungle-page-canvas", className)}
      data-inset={inset}
      data-size={size}
    />
  );
}

export interface DockedFooterProps extends HTMLAttributes<HTMLElement> {
  readonly contentClassName?: string;
  readonly density?: "compact" | "default";
  readonly inset?: "content" | "none";
  readonly position?: "absolute" | "fixed" | "sticky";
  readonly size?: "default" | "full" | "wide";
  readonly surface?: "glass" | "solid";
}

export const DockedFooter = forwardRef<HTMLElement, DockedFooterProps>(function DockedFooter(
  {
    children,
    className,
    contentClassName,
    density = "default",
    inset = "content",
    position = "fixed",
    size = "default",
    surface = "solid",
    ...props
  },
  ref,
) {
  return (
    <footer
      {...props}
      className={classNames("jungle-docked-footer", className)}
      data-position={position}
      data-surface={surface}
      ref={ref}
    >
      <div
        className={classNames("jungle-docked-footer__content", contentClassName)}
        data-density={density}
        data-inset={inset}
        data-size={size}
      >
        {children}
      </div>
    </footer>
  );
});
