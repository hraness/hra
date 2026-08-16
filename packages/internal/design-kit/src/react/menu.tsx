"use client";

import type { ReactNode } from "react";
import {
  Header,
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  MenuSection as AriaMenuSection,
  MenuTrigger,
  type Placement,
  Popover,
  Separator,
} from "react-aria-components";

import { classNames } from "./class-names";
import { useDesignPortalClassName, useDesignPortalTheme } from "./design-theme-context";
import { JellySurface } from "./jelly-surface";

export { MenuTrigger };

const jellyOverlayClearance = 24;

type MenuSelectionProps = Pick<
  AriaMenuProps<object>,
  "disallowEmptySelection" | "selectedKeys" | "selectionMode"
>;

export interface MenuProps extends MenuSelectionProps {
  readonly "aria-label": string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly footer?: ReactNode;
  readonly matchTriggerWidth?: boolean;
  readonly onAction?: (key: string) => void;
  readonly placement?: Placement;
  readonly popoverClassName?: string;
  readonly shouldCloseOnSelect?: boolean;
}

export function Menu({
  "aria-label": ariaLabel,
  children,
  className,
  disallowEmptySelection,
  footer,
  matchTriggerWidth = false,
  onAction,
  placement = "bottom end",
  popoverClassName,
  selectedKeys,
  selectionMode,
  shouldCloseOnSelect = true,
}: MenuProps) {
  const designTheme = useDesignPortalTheme();
  const portalClassName = useDesignPortalClassName();

  return (
    <Popover
      className={classNames("jungle-menu-popover", portalClassName, popoverClassName)}
      containerPadding={jellyOverlayClearance}
      data-match-trigger-width={matchTriggerWidth || undefined}
      data-theme={designTheme}
      offset={6}
      placement={placement}
    >
      <JellySurface className="jungle-menu__surface" tone="overlay">
        <AriaMenu
          aria-label={ariaLabel}
          className={classNames("jungle-menu", className)}
          {...(disallowEmptySelection === undefined ? {} : { disallowEmptySelection })}
          onAction={(key) => onAction?.(String(key))}
          {...(selectedKeys === undefined ? {} : { selectedKeys })}
          {...(selectionMode === undefined ? {} : { selectionMode })}
          shouldCloseOnSelect={shouldCloseOnSelect}
        >
          {children}
        </AriaMenu>
        {footer === undefined ? null : <div className="jungle-menu__footer">{footer}</div>}
      </JellySurface>
    </Popover>
  );
}

export type MenuItemProps = Omit<
  AriaMenuItemProps,
  "children" | "className" | "id"
> & {
  readonly children: ReactNode;
  readonly className?: string;
  readonly description?: ReactNode;
  readonly id: string;
  readonly leading?: ReactNode;
  readonly shortcut?: ReactNode;
  readonly variant?: "danger" | "default";
};

export function MenuItem({
  children,
  className,
  description,
  leading,
  shortcut,
  variant = "default",
  ...props
}: MenuItemProps) {
  return (
    <AriaMenuItem
      {...props}
      className={classNames("jungle-menu__item", className)}
      data-has-description={description === undefined ? undefined : "true"}
      data-variant={variant}
    >
      {leading === undefined ? null : (
        <span className="jungle-menu__leading">{leading}</span>
      )}
      <span className="jungle-menu__copy">
        <span className="jungle-menu__label">{children}</span>
        {description === undefined ? null : (
          <span className="jungle-menu__description">{description}</span>
        )}
      </span>
      {shortcut === undefined ? null : <kbd className="jungle-menu__shortcut">{shortcut}</kbd>}
    </AriaMenuItem>
  );
}

export function MenuSeparator({ className }: { readonly className?: string }) {
  return <Separator className={classNames("jungle-menu__separator", className)} />;
}

export interface MenuSectionProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: ReactNode;
}

export function MenuSection({ children, className, title }: MenuSectionProps) {
  return (
    <AriaMenuSection className={classNames("jungle-menu__section", className)}>
      {title === undefined ? null : <Header className="jungle-menu__header">{title}</Header>}
      {children}
    </AriaMenuSection>
  );
}
