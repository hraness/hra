"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { Link as AriaLink, type LinkProps as AriaLinkProps } from "react-aria-components";

import { classNames } from "./class-names";
import type { ContentHeadingLevel } from "./content-primitives";
import { useDesignKitLinkPrefetch } from "./router-provider";

export interface NavigationRailProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly "aria-label"?: string;
  readonly footer?: ReactNode;
  readonly header?: ReactNode;
}

export function NavigationRail({
  "aria-label": ariaLabel = "Primary navigation",
  children,
  className,
  footer,
  header,
  ...props
}: NavigationRailProps) {
  return (
    <aside {...props} aria-label={ariaLabel} className={classNames("jungle-navigation-rail", className)}>
      {header === undefined ? null : <header className="jungle-navigation-rail__header">{header}</header>}
      <nav aria-label={ariaLabel} className="jungle-navigation-rail__navigation">{children}</nav>
      {footer === undefined ? null : <footer className="jungle-navigation-rail__footer">{footer}</footer>}
    </aside>
  );
}

export interface RailSectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly title?: ReactNode;
  readonly titleAs?: ContentHeadingLevel;
}

export function RailSection({
  children,
  className,
  title,
  titleAs = "h2",
  ...props
}: RailSectionProps) {
  const Heading = titleAs;
  return (
    <section {...props} className={classNames("jungle-rail-section", className)}>
      {title === undefined ? null : <Heading className="jungle-rail-section__title">{title}</Heading>}
      <div className="jungle-rail-section__items">{children}</div>
    </section>
  );
}

export interface RailItemProps extends Omit<AriaLinkProps, "children" | "className"> {
  readonly badge?: ReactNode;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  readonly isActive?: boolean;
  readonly label: ReactNode;
}

export function RailItem({
  badge,
  className,
  description,
  href,
  icon,
  isActive = false,
  label,
  onFocus,
  onHoverStart,
  ...props
}: RailItemProps) {
  const prefetch = useDesignKitLinkPrefetch(href);
  return (
    <AriaLink
      {...props}
      aria-current={isActive ? "page" : undefined}
      className={classNames("jungle-rail-item", className)}
      {...(href === undefined ? {} : { href })}
      onFocus={(event) => {
        onFocus?.(event);
        prefetch();
      }}
      onHoverStart={(event) => {
        onHoverStart?.(event);
        prefetch();
      }}
    >
      {icon === undefined ? null : <span aria-hidden="true" className="jungle-rail-item__icon">{icon}</span>}
      <span className="jungle-rail-item__copy">
        <span className="jungle-rail-item__label">{label}</span>
        {description === undefined ? null : <span className="jungle-rail-item__description">{description}</span>}
      </span>
      {badge === undefined ? null : <span className="jungle-rail-item__badge">{badge}</span>}
    </AriaLink>
  );
}
