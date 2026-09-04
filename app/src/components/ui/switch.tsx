import { cn } from "../../lib/cn";

export type SwitchProps = Readonly<{
  checked: boolean;
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}>;

/**
 * An owned switch rather than a Radix wrapper: `role="switch"` on a button with
 * `aria-checked` is the whole contract, and it keeps the dependency count at
 * zero for a primitive this app uses once.
 */
export function Switch({
  checked,
  className,
  disabled = false,
  id,
  label,
  onCheckedChange,
}: SwitchProps) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-line",
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-surface-input",
        className,
      )}
      disabled={disabled}
      id={id}
      onClick={() => { onCheckedChange(!checked); }}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "pointer-events-none block h-4 w-4 rounded-full bg-ink transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );
}
