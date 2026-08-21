"use client";

import { useEffect, useId, type ReactNode } from "react";

import { Button } from "./button";
import { EmptyState, type ContentHeadingLevel } from "./content-primitives";
import { LinkButton } from "./link-button";
import { Skeleton, Spinner } from "./feedback";
import { PageCanvas } from "./surfaces";
import {
  defaultDesignTheme,
  DesignThemeProvider,
  type DesignTheme,
  ThemeColorSync,
  ThemeMenuButton,
} from "./theme";

export interface RouteErrorPageProps {
  /** Set false only for an already-visible, inert demonstration of this state. */
  readonly announce?: boolean;
  /** Disable only when the full-page composition is rendered as an inert preview. */
  readonly autoFocus?: boolean;
  readonly canvasAs?: "div" | "main";
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
  /** Adds a standalone header menu; product layouts should normally own it. */
  readonly showThemeToggle?: boolean;
  readonly titleAs?: ContentHeadingLevel;
}

export interface RouteNotFoundPageProps {
  readonly canvasAs?: "div" | "main";
  /** Adds a standalone header menu; product layouts should normally own it. */
  readonly showThemeToggle?: boolean;
  readonly titleAs?: ContentHeadingLevel;
}

export interface RouteLoadingPageProps {
  /** Set false only for an already-visible, inert demonstration of this state. */
  readonly announce?: boolean;
  readonly canvasAs?: "div" | "main";
}

export interface GlobalErrorDocumentProps extends RouteErrorPageProps {
  readonly bodyClassName?: string;
  readonly diagnostics?: ReactNode;
  readonly theme?: DesignTheme;
}

function RouteActions({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="jungle-route-state__actions">{children}</div>;
}

/** Shared root-segment 404 treatment for Next products. */
export function RouteNotFoundPage({
  canvasAs = "main",
  showThemeToggle = false,
  titleAs = "h1",
}: RouteNotFoundPageProps = {}) {
  return (
    <PageCanvas as={canvasAs} className="jungle-route-state">
      {showThemeToggle ? (
        <header className="jungle-route-state__header">
          <ThemeMenuButton />
        </header>
      ) : null}
      <div className="jungle-route-state__content">
        <EmptyState
          action={<LinkButton href="/" variant="primary">Return home</LinkButton>}
          description="The address may be out of date, or this page may have moved."
          icon={<span aria-hidden="true">404</span>}
          title="Page not found"
          titleAs={titleAs}
        />
      </div>
    </PageCanvas>
  );
}

/** Shared recoverable route-error treatment for Next products. */
export function RouteErrorPage({
  announce = true,
  autoFocus = true,
  canvasAs = "main",
  error,
  reset,
  showThemeToggle = false,
  titleAs = "h1",
}: RouteErrorPageProps) {
  const focusId = `${useId()}-route-error`;
  useEffect(() => {
    if (autoFocus) document.getElementById(focusId)?.focus();
  }, [autoFocus, error, focusId]);

  return (
    <PageCanvas
      aria-label="This view could not load"
      aria-live={announce ? "assertive" : undefined}
      as={canvasAs}
      className="jungle-route-state"
      id={focusId}
      tabIndex={-1}
    >
      {showThemeToggle ? (
        <header className="jungle-route-state__header">
          <ThemeMenuButton />
        </header>
      ) : null}
      <div className="jungle-route-state__content">
        <EmptyState
          action={(
            <RouteActions>
              <Button onPress={reset} variant="primary">Try again</Button>
              <LinkButton href="/">Return home</LinkButton>
            </RouteActions>
          )}
          description="Retry this view, or return home and continue from there."
          icon={<span aria-hidden="true">!</span>}
          title="This view could not load"
          titleAs={titleAs}
        />
      </div>
    </PageCanvas>
  );
}

/** Shared root loading treatment for Next products. */
export function RouteLoadingPage({
  announce = true,
  canvasAs = "main",
}: RouteLoadingPageProps = {}) {
  return (
    <PageCanvas
      aria-busy={announce ? "true" : undefined}
      as={canvasAs}
      className="jungle-route-state"
    >
      <div className="jungle-route-state__content">
        <section className="jungle-route-state__loading" role={announce ? "status" : undefined}>
          <div className="jungle-route-state__loading-title">
            <Spinner />
            <strong>Loading page</strong>
          </div>
          <div aria-hidden="true" className="jungle-route-state__skeletons">
            <Skeleton height="1rem" isText width="88%" />
            <Skeleton height="1rem" isText width="64%" />
            <Skeleton height="8rem" width="100%" />
          </div>
        </section>
      </div>
    </PageCanvas>
  );
}

/**
 * Last-resort Next boundary. It owns the document because global-error replaces
 * the root layout, including its normal appearance provider.
 */
export function GlobalErrorDocument({
  bodyClassName,
  diagnostics,
  theme = defaultDesignTheme,
  ...props
}: GlobalErrorDocumentProps) {
  const content = (
    <>
      {diagnostics}
      <RouteErrorPage {...props} showThemeToggle={false} />
    </>
  );

  return (
    <html data-theme={theme === "system" ? "light" : theme} lang="en" suppressHydrationWarning>
      <body className={bodyClassName}>
        {theme === "system" ? (
          <DesignThemeProvider>
            <ThemeColorSync />
            {content}
          </DesignThemeProvider>
        ) : content}
      </body>
    </html>
  );
}
