import type { TextareaHTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, rows = 2, ...rest }: TextareaProps) {
  return (
    <textarea
      className={cn(
        "w-full min-h-11 resize-none rounded-md border border-line bg-surface-input px-3 py-2",
        "text-base text-ink placeholder:text-ink-muted",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      rows={rows}
      {...rest}
    />
  );
}
