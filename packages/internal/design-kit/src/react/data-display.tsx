import type {
  HTMLAttributes,
  ImgHTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
} from "react";

import { classNames } from "./class-names";

export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "?";
  const selected = words.length === 1 ? words : [words[0] ?? "", words.at(-1) ?? ""];
  return selected.flatMap((word) => Array.from(word).slice(0, 1)).join("").toLocaleUpperCase();
}

export interface AvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly alt?: string;
  readonly name: string;
  readonly size?: "large" | "small" | "default";
  readonly src?: string;
}

export function Avatar({ alt = "", className, name, size = "default", src, ...props }: AvatarProps) {
  const imageProps: ImgHTMLAttributes<HTMLImageElement> = { alt, src };
  return (
    <span {...props} className={classNames("jungle-avatar", className)} data-size={size} title={name}>
      {src === undefined
        ? <span aria-hidden="true">{avatarInitials(name)}</span>
        : <img {...imageProps} />}
    </span>
  );
}

export interface DataTableColumn<Row> {
  readonly align?: "center" | "end" | "start";
  readonly cell: (row: Row) => ReactNode;
  readonly header: ReactNode;
  readonly id: string;
}

export interface DataTableProps<Row> extends Omit<TableHTMLAttributes<HTMLTableElement>, "children"> {
  readonly caption?: string;
  readonly columns: readonly [DataTableColumn<Row>, ...DataTableColumn<Row>[]];
  readonly empty?: ReactNode;
  readonly getRowId: (row: Row) => string;
  readonly rows: readonly Row[];
  readonly wrapperClassName?: string;
}

export function DataTable<Row>({
  caption,
  className,
  columns,
  empty = "No results.",
  getRowId,
  rows,
  wrapperClassName,
  ...props
}: DataTableProps<Row>) {
  return (
    <div className={classNames("jungle-data-table", wrapperClassName)}>
      <table {...props} className={classNames("jungle-data-table__table", className)}>
        {caption === undefined ? null : <caption>{caption}</caption>}
        <thead>
          <tr>{columns.map((column) => <th data-align={column.align ?? "start"} key={column.id} scope="col">{column.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0
            ? <tr><td className="jungle-data-table__empty" colSpan={columns.length}>{empty}</td></tr>
            : rows.map((row) => (
                <tr key={getRowId(row)}>
                  {columns.map((column) => <td data-align={column.align ?? "start"} key={column.id}>{column.cell(row)}</td>)}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
