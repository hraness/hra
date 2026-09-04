import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

export type CardProps = HTMLAttributes<HTMLDivElement>;

export function Card({ className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-line bg-surface-raised text-ink",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: CardProps) {
  return <div className={cn("flex flex-col gap-1 p-3", className)} {...rest} />;
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-sm font-semibold leading-snug", className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-ink-muted", className)} {...rest} />;
}

export function CardContent({ className, ...rest }: CardProps) {
  return <div className={cn("px-3 pb-3", className)} {...rest} />;
}

export function CardFooter({ className, ...rest }: CardProps) {
  return <div className={cn("flex items-center gap-2 px-3 pb-3", className)} {...rest} />;
}
