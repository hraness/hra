import type { HTMLAttributes, ReactNode } from "react";

import { classNames } from "./class-names";
import { Disclosure } from "./disclosure";

export interface AccordionItem {
  readonly content: ReactNode;
  readonly defaultExpanded?: boolean;
  readonly id: string;
  readonly title: ReactNode;
}

export interface AccordionProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly items: readonly AccordionItem[];
  readonly size?: "compact" | "default" | "large";
}

/** A server-renderable group of independently operable native disclosures. */
export function Accordion({ className, items, size = "default", ...props }: AccordionProps) {
  return (
    <div {...props} className={classNames("jungle-accordion", className)}>
      {items.map((item) => (
        <Disclosure
          {...(item.defaultExpanded === undefined ? {} : { defaultOpen: item.defaultExpanded })}
          key={item.id}
          size={size}
          title={item.title}
        >
          {item.content}
        </Disclosure>
      ))}
    </div>
  );
}
