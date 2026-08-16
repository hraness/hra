import type { AnchorHTMLAttributes, HTMLAttributes, ReactNode } from "react";

import { classNames } from "./class-names";

export interface BreadcrumbItem {
  readonly href?: string;
  readonly id: string;
  readonly label: ReactNode;
}

export interface BreadcrumbsProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  readonly "aria-label"?: string;
  readonly items: readonly [BreadcrumbItem, ...BreadcrumbItem[]];
}

export function Breadcrumbs({
  "aria-label": ariaLabel = "Breadcrumbs",
  className,
  items,
  ...props
}: BreadcrumbsProps) {
  return (
    <nav {...props} aria-label={ariaLabel} className={classNames("jungle-breadcrumbs", className)}>
      <ol>
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={item.id}>
              {item.href === undefined || current
                ? <span aria-current={current ? "page" : undefined}>{item.label}</span>
                : <a href={item.href}>{item.label}</a>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export type PaginationPart = number | "ellipsis";

export function paginationRange(
  currentPage: number,
  totalPages: number,
  siblings = 1,
): readonly PaginationPart[] {
  const total = Math.max(1, Math.trunc(Number.isFinite(totalPages) ? totalPages : 1));
  const current = Math.min(total, Math.max(1, Math.trunc(Number.isFinite(currentPage) ? currentPage : 1)));
  const radius = Math.max(0, Math.trunc(Number.isFinite(siblings) ? siblings : 1));
  const pages = new Set([1, total]);
  for (let page = current - radius; page <= current + radius; page += 1) {
    if (page > 1 && page < total) pages.add(page);
  }
  if (current <= radius + 2) {
    for (let page = 2; page <= Math.min(total - 1, 2 + radius * 2); page += 1) pages.add(page);
  }
  if (current >= total - radius - 1) {
    for (let page = Math.max(2, total - 1 - radius * 2); page < total; page += 1) pages.add(page);
  }

  const ordered = [...pages].sort((left, right) => left - right);
  const result: PaginationPart[] = [];
  for (const page of ordered) {
    const previous = result.at(-1);
    if (typeof previous === "number" && page - previous > 1) result.push("ellipsis");
    result.push(page);
  }
  return result;
}

export interface PaginationProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  readonly "aria-label"?: string;
  readonly currentPage: number;
  readonly hrefForPage: (page: number) => string;
  readonly siblings?: number;
  readonly totalPages: number;
}

function pageLinkProps(page: number, current: number): AnchorHTMLAttributes<HTMLAnchorElement> {
  return page === current ? { "aria-current": "page" } : {};
}

export function Pagination({
  "aria-label": ariaLabel = "Pagination",
  className,
  currentPage,
  hrefForPage,
  siblings = 1,
  totalPages,
  ...props
}: PaginationProps) {
  const total = Math.max(1, Math.trunc(totalPages));
  const current = Math.min(total, Math.max(1, Math.trunc(currentPage)));
  const parts = paginationRange(current, total, siblings);
  const previous = current - 1;
  const next = current + 1;
  return (
    <nav {...props} aria-label={ariaLabel} className={classNames("jungle-pagination", className)}>
      {previous < 1
        ? <span aria-disabled="true" className="jungle-pagination__boundary" data-direction="previous">Previous</span>
        : <a className="jungle-pagination__boundary" data-direction="previous" href={hrefForPage(previous)} rel="prev">Previous</a>}
      <ol>
        {parts.map((part, index) => (
          <li key={`${String(part)}-${String(index)}`}>
            {part === "ellipsis"
              ? <span aria-hidden="true" className="jungle-pagination__ellipsis">…</span>
              : <a {...pageLinkProps(part, current)} href={hrefForPage(part)}>{part}</a>}
          </li>
        ))}
      </ol>
      {next > total
        ? <span aria-disabled="true" className="jungle-pagination__boundary" data-direction="next">Next</span>
        : <a className="jungle-pagination__boundary" data-direction="next" href={hrefForPage(next)} rel="next">Next</a>}
    </nav>
  );
}
