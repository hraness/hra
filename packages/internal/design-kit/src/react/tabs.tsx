"use client";

import type { ReactNode } from "react";
import {
  Tab,
  TabList,
  TabPanel as AriaTabPanel,
  type TabPanelProps as AriaTabPanelProps,
  Tabs as AriaTabs,
} from "react-aria-components";

import { classNames } from "./class-names";
import { JellySurface } from "./jelly-surface";
import { ownedStringIdForKey } from "./selection";

export interface TabItem<Id extends string> {
  readonly badge?: ReactNode;
  readonly id: Id;
  readonly isDisabled?: boolean;
  readonly label: ReactNode;
  readonly leading?: ReactNode;
}

export interface TabsProps<Id extends string> {
  readonly "aria-label": string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly end?: ReactNode;
  readonly items: readonly TabItem<Id>[];
  readonly onChange: (id: Id) => void;
  readonly size?: "compact" | "default";
  readonly value: Id;
}

export function Tabs<Id extends string>({
  "aria-label": ariaLabel,
  children,
  className,
  end,
  items,
  onChange,
  size = "default",
  value,
}: TabsProps<Id>) {
  return (
    <AriaTabs
      className={classNames("jungle-tabs", className)}
      data-size={size}
      onSelectionChange={(key) => {
        const next = ownedStringIdForKey(items, key);
        if (next !== null) onChange(next);
      }}
      selectedKey={value}
    >
      <JellySurface className="jungle-tabs__surface" interaction="press" tone="neutral">
        <div className="jungle-tabs__bar">
          <TabList aria-label={ariaLabel} className="jungle-tabs__list">
            {items.map((item) => (
              <Tab
                className="jungle-tabs__tab"
                id={item.id}
                key={item.id}
                {...(item.isDisabled === undefined ? {} : { isDisabled: item.isDisabled })}
              >
                {item.leading}
                <span className="jungle-tabs__label">{item.label}</span>
                {item.badge}
              </Tab>
            ))}
          </TabList>
          {end}
        </div>
      </JellySurface>
      {children}
    </AriaTabs>
  );
}

export type TabPanelProps = Omit<AriaTabPanelProps, "className"> & {
  readonly className?: string;
};

export function TabPanel({ className, ...props }: TabPanelProps) {
  return <AriaTabPanel {...props} className={classNames("jungle-tab-panel", className)} />;
}
