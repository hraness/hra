"use client";

import type { ReactNode } from "react";
import {
  Header,
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  type ListBoxItemProps as AriaListBoxItemProps,
  type ListBoxProps as AriaListBoxProps,
  ListBoxSection as AriaListBoxSection,
  type Key,
  type Selection,
} from "react-aria-components";

import { classNames } from "./class-names";

export type { Key, Selection };

export type ListBoxProps<T extends object> = Omit<AriaListBoxProps<T>, "className"> & {
  readonly className?: string;
};

export function ListBox<T extends object>({ className, ...props }: ListBoxProps<T>) {
  return <AriaListBox {...props} className={classNames("jungle-list-box", className)} />;
}

export type ListBoxItemProps = Omit<AriaListBoxItemProps, "className"> & {
  readonly className?: string;
};

export function ListBoxItem({ className, ...props }: ListBoxItemProps) {
  return <AriaListBoxItem {...props} className={classNames("jungle-list-box__item", className)} />;
}

export interface ListBoxSectionProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: ReactNode;
}

export function ListBoxSection({ children, className, title }: ListBoxSectionProps) {
  return (
    <AriaListBoxSection className={classNames("jungle-list-box__section", className)}>
      {title === undefined ? null : <Header className="jungle-list-box__header">{title}</Header>}
      {children}
    </AriaListBoxSection>
  );
}
