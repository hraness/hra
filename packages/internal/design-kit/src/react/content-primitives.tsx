import type {
  HTMLAttributes,
  ReactNode,
} from "react";

import { classNames } from "./class-names";
import type { SurfaceShape } from "./surfaces";

export type ContentHeadingLevel = "h1" | "h2" | "h3" | "h4";

export interface ProductionDataPreviewNoticeProps {
  readonly surfaceOrigin?: string | undefined;
}

export function ProductionDataPreviewNotice({
  surfaceOrigin,
}: ProductionDataPreviewNoticeProps) {
  if (surfaceOrigin === undefined || surfaceOrigin === "") return null;

  return (
    <aside
      aria-label="Production data Preview warning"
      className="jungle-production-data-preview-notice"
      role="alert"
    >
      <strong>Production data Preview</strong>
      <span>This Preview uses production data. Actions are real and affect production.</span>
    </aside>
  );
}

export type KeyHintProps = HTMLAttributes<HTMLElement> & Readonly<{
  children: ReactNode;
}>;

export function KeyHint({ children, className, ...props }: KeyHintProps) {
  return <kbd {...props} className={classNames("jungle-key-hint", className)}>{children}</kbd>;
}

export interface PageIntroProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly actions?: ReactNode;
  /** Supporting instruction, constraint, or interpretation not already supplied by visible content. */
  readonly description?: ReactNode;
  /** Parent scope, navigation context, or status that is distinct from the title. */
  readonly eyebrow?: ReactNode;
  readonly title: ReactNode;
  readonly titleAs?: ContentHeadingLevel;
}

export function PageIntro({
  actions,
  children,
  className,
  description,
  eyebrow,
  title,
  titleAs = "h1",
  ...props
}: PageIntroProps) {
  const Heading = titleAs;
  return (
    <section {...props} className={classNames("jungle-page-intro", className)}>
      <div className="jungle-page-intro__copy">
        {eyebrow === undefined ? null : <div className="jungle-page-intro__eyebrow">{eyebrow}</div>}
        <Heading className="jungle-page-intro__title">{title}</Heading>
        {description === undefined ? null : <div className="jungle-page-intro__description">{description}</div>}
      </div>
      {actions === undefined ? null : <div className="jungle-page-intro__actions">{actions}</div>}
      {children}
    </section>
  );
}

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly action?: ReactNode;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  readonly title: ReactNode;
  readonly titleAs?: ContentHeadingLevel;
}

export function EmptyState({
  action,
  className,
  description,
  icon,
  title,
  titleAs = "h2",
  ...props
}: EmptyStateProps) {
  const Heading = titleAs;
  return (
    <section {...props} className={classNames("jungle-empty-state", className)}>
      {icon === undefined ? null : <div aria-hidden="true" className="jungle-empty-state__icon">{icon}</div>}
      <Heading className="jungle-empty-state__title">{title}</Heading>
      {description === undefined ? null : <div className="jungle-empty-state__description">{description}</div>}
      {action === undefined ? null : <div className="jungle-empty-state__action">{action}</div>}
    </section>
  );
}

export type InlineAlertTone = "danger" | "info" | "success" | "warning";

export interface InlineAlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly icon?: ReactNode;
  readonly isLive?: boolean;
  readonly title?: ReactNode;
  readonly tone?: InlineAlertTone;
}

export function InlineAlert({
  "aria-live": ariaLive,
  children,
  className,
  icon,
  isLive = false,
  role,
  title,
  tone = "info",
  ...props
}: InlineAlertProps) {
  const resolvedAriaLive = ariaLive ?? (
    isLive ? tone === "danger" ? "assertive" : "polite" : undefined
  );
  const resolvedRole = role ?? (
    isLive ? tone === "danger" ? "alert" : "status" : undefined
  );
  return (
    <div
      {...props}
      aria-live={resolvedAriaLive}
      className={classNames("jungle-inline-alert", className)}
      data-tone={tone}
      role={resolvedRole}
    >
      {icon === undefined ? null : <div aria-hidden="true" className="jungle-inline-alert__icon">{icon}</div>}
      <div className="jungle-inline-alert__content">
        {title === undefined ? null : <div className="jungle-inline-alert__title">{title}</div>}
        <div className="jungle-inline-alert__body">{children}</div>
      </div>
    </div>
  );
}

export interface SettingsCardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  readonly actions?: ReactNode;
  readonly description?: ReactNode;
  readonly shape?: SurfaceShape;
  readonly title: ReactNode;
  readonly titleAs?: ContentHeadingLevel;
}

export function SettingsCard({
  actions,
  children,
  className,
  description,
  shape = "rounded",
  title,
  titleAs = "h2",
  ...props
}: SettingsCardProps) {
  const Heading = titleAs;
  return (
    <section
      {...props}
      className={classNames("jungle-settings-card", className)}
      data-shape={shape}
    >
      <header className="jungle-settings-card__header">
        <div>
          <Heading className="jungle-settings-card__title">{title}</Heading>
          {description === undefined ? null : <div className="jungle-settings-card__description">{description}</div>}
        </div>
        {actions === undefined ? null : <div className="jungle-settings-card__actions">{actions}</div>}
      </header>
      <div className="jungle-settings-card__body">{children}</div>
    </section>
  );
}
