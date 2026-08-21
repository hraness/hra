"use client";

import { AppearanceIcon } from "@hraness/ui";
import { ThemeProvider as NextThemeProvider, useTheme } from "next-themes";
import {
  type ReactNode,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";

import { colors } from "../index";
import { IconButton } from "./button";
import { classNames } from "./class-names";
import { DesignPortalThemeProvider } from "./design-theme-context";
import { setJellyThemeMode } from "./jelly-runtime";
import { Menu, MenuItem, MenuTrigger } from "./menu";
import { SegmentedControl, type SegmentedItem } from "./segmented-control";
import {
  acquireThemeColorMeta,
  type ThemeColorMetaRegistration,
} from "./theme-color-meta";

export const designThemes = ["light", "dark", "system"] as const;
export type DesignTheme = (typeof designThemes)[number];
export type ConcreteDesignTheme = Exclude<DesignTheme, "system">;
export const defaultDesignTheme = "system" as const satisfies DesignTheme;

const concreteThemes = ["light", "dark"] as const;
const emptySubscribe = (): (() => void) => () => undefined;

export function isDesignTheme(value: unknown): value is DesignTheme {
  return typeof value === "string" && designThemes.some((theme) => theme === value);
}

/** Invalid or unavailable persisted values resolve to the deterministic first-visit theme. */
export function normalizeDesignTheme(value: unknown): DesignTheme {
  return isDesignTheme(value) ? value : defaultDesignTheme;
}

function useHydrated(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

function themeStorageGuardScript(storageKey: string): string {
  const serializedKey = JSON.stringify(storageKey)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return `(()=>{try{const key=${serializedKey};const value=localStorage.getItem(key);if(value!==null&&value!=="light"&&value!=="dark"&&value!=="system")localStorage.setItem(key,"${defaultDesignTheme}")}catch{}})();`;
}

function PersistedThemeNormalizer() {
  const { setTheme, theme } = useTheme();

  useEffect(() => {
    if (theme !== undefined && !isDesignTheme(theme)) setTheme(defaultDesignTheme);
  }, [setTheme, theme]);

  return null;
}

function JellyThemeSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (resolvedTheme === "light" || resolvedTheme === "dark") {
      void setJellyThemeMode(resolvedTheme);
    }
  }, [resolvedTheme]);

  return null;
}

function PortalThemeBridge({
  children,
  forcedTheme,
}: Readonly<{
  children: ReactNode;
  forcedTheme: ConcreteDesignTheme | undefined;
}>) {
  const { resolvedTheme } = useTheme();
  const portalTheme = resolvedTheme === "light" || resolvedTheme === "dark"
    ? resolvedTheme
    : forcedTheme;

  return (
    <DesignPortalThemeProvider theme={portalTheme}>
      {children}
    </DesignPortalThemeProvider>
  );
}

export interface DesignThemeProviderProps {
  readonly children: ReactNode;
  /** Locks products with an explicit single-theme identity to one concrete theme. */
  readonly forcedTheme?: ConcreteDesignTheme;
  /** Applied to next-themes' blocking bootstrap script for strict CSPs. */
  readonly nonce?: string;
  /** Defaults to the shared, versioned browser preference key. */
  readonly storageKey?: string;
}

/**
 * Shared appearance boundary for browser products. System is the first-visit
 * preference; the server may retain a concrete light fallback until the
 * blocking bootstrap resolves the live operating-system appearance.
 */
export function DesignThemeProvider({
  children,
  forcedTheme,
  nonce,
  storageKey = "jungle-design-theme-v1",
}: DesignThemeProviderProps) {
  return (
    <>
      {forcedTheme === undefined ? (
        <script
          {...(nonce === undefined ? {} : { nonce })}
          data-jungle-theme-guard=""
          dangerouslySetInnerHTML={{ __html: themeStorageGuardScript(storageKey) }}
          suppressHydrationWarning
        />
      ) : null}
      <NextThemeProvider
        {...(nonce === undefined ? {} : { nonce })}
        attribute="data-theme"
        defaultTheme={forcedTheme ?? defaultDesignTheme}
        disableTransitionOnChange
        enableSystem={forcedTheme === undefined}
        forcedTheme={forcedTheme}
        storageKey={storageKey}
        themes={[...concreteThemes]}
      >
        {forcedTheme === undefined ? <PersistedThemeNormalizer /> : null}
        <JellyThemeSync />
        <PortalThemeBridge forcedTheme={forcedTheme}>{children}</PortalThemeBridge>
      </NextThemeProvider>
    </>
  );
}

export type ThemeToggleLabels = Readonly<Partial<Record<DesignTheme, string>>>;
export type ThemeToggleDisplay = "icons" | "labels";
export type ThemeTogglePresentation = "menu" | "segmented";

function themeToggleLabel(id: DesignTheme, labels?: ThemeToggleLabels): string {
  return labels?.[id] ?? `${id[0]?.toUpperCase() ?? ""}${id.slice(1)}`;
}

export function themeToggleItems(
  labels?: ThemeToggleLabels,
): readonly SegmentedItem<DesignTheme>[] {
  return designThemes.map((id) => ({
    id,
    label: themeToggleLabel(id, labels),
  }));
}

function themeToggleIcon(id: DesignTheme): ReactNode {
  return <AppearanceIcon name={id} />;
}

function themeToggleIconItems(
  labels?: ThemeToggleLabels,
): readonly SegmentedItem<DesignTheme>[] {
  return designThemes.map((id) => ({
    ariaLabel: themeToggleLabel(id, labels),
    id,
    label: themeToggleIcon(id),
    tooltip: themeToggleLabel(id, labels),
  }));
}

interface ThemeToggleBaseProps {
  readonly "aria-label"?: string;
  readonly className?: string;
  readonly labels?: ThemeToggleLabels;
  readonly size?: "compact" | "default";
}

type ThemeTogglePresentationProps =
  | {
    /** Three visible choices for settings and other surfaces with stable inline room. */
    readonly display?: ThemeToggleDisplay;
    readonly presentation?: "segmented";
  }
  | {
    /** One bounded trigger for persistent chrome and text-enlargement reflow. */
    readonly display?: never;
    readonly presentation: "menu";
  };

type ThemeToggleControlProps =
  | {
    readonly onChange?: never;
    readonly value?: never;
  }
  | {
    readonly onChange: (theme: DesignTheme) => void;
    readonly value: DesignTheme;
  };

export type ThemeToggleProps =
  & ThemeToggleBaseProps
  & ThemeToggleControlProps
  & ThemeTogglePresentationProps;

/**
 * A hydration-stable, persisted Light/Dark/System appearance control.
 * Persistent product chrome defaults to the compact menu presentation.
 */
export function ThemeToggle({
  "aria-label": ariaLabel = "Appearance",
  className,
  display,
  labels,
  onChange,
  presentation,
  size = "compact",
  value: controlledValue,
}: ThemeToggleProps) {
  const hydrated = useHydrated();
  const { setTheme, theme } = useTheme();
  const controlled = controlledValue !== undefined;
  const ready = controlled || hydrated;
  const value = controlledValue ?? (hydrated ? normalizeDesignTheme(theme) : defaultDesignTheme);
  const resolvedPresentation = presentation ?? (display === undefined ? "menu" : "segmented");
  const resolvedDisplay = display ?? "icons";
  const items = resolvedDisplay === "icons"
    ? themeToggleIconItems(labels)
    : themeToggleItems(labels);
  const changeTheme = (nextTheme: DesignTheme): void => {
    if (controlled) onChange?.(nextTheme);
    else setTheme(nextTheme);
  };
  const currentLabel = themeToggleLabel(value, labels);

  return (
    <div
      aria-busy={!ready || undefined}
      className={classNames(
        "jungle-theme-toggle",
        "hraness-design-theme-toggle",
        className,
      )}
      data-display={resolvedPresentation === "menu" ? "icons" : resolvedDisplay}
      data-hraness-appearance-menu={resolvedPresentation === "menu" ? "" : undefined}
      data-presentation={resolvedPresentation}
      data-ready={ready ? "true" : "false"}
      data-theme-value={value}
    >
      {resolvedPresentation === "menu" ? (
        <MenuTrigger>
          <IconButton
            aria-label={`${ariaLabel}: ${currentLabel}`}
            controlClassName="jungle-theme-toggle__trigger hraness-design-theme-toggle__trigger"
            isDisabled={!ready}
            size={size}
            tooltip={`${ariaLabel}: ${currentLabel}`}
          >
            {themeToggleIcon(value)}
          </IconButton>
          <Menu
            aria-label={ariaLabel}
            className="jungle-theme-toggle__menu hraness-design-theme-toggle__menu"
            disallowEmptySelection
            onAction={(key) => {
              if (isDesignTheme(key)) changeTheme(key);
            }}
            popoverClassName="jungle-theme-toggle__popover hraness-design-theme-toggle__popover"
            selectedKeys={[value]}
            selectionMode="single"
          >
            {designThemes.map((id) => (
              <MenuItem
                className="jungle-theme-toggle__item hraness-design-theme-toggle__item"
                data-theme-value={id}
                id={id}
                key={id}
                leading={themeToggleIcon(id)}
                textValue={themeToggleLabel(id, labels)}
              >
                {themeToggleLabel(id, labels)}
              </MenuItem>
            ))}
          </Menu>
        </MenuTrigger>
      ) : (
        <SegmentedControl
          aria-label={ariaLabel}
          isDisabled={!ready}
          items={items}
          onChange={changeTheme}
          size={size}
          value={value}
        />
      )}
    </div>
  );
}

export type ThemeMenuButtonProps = ThemeToggleBaseProps & ThemeToggleControlProps;

/**
 * The canonical persistent appearance selector. Render it as the final action
 * in a product header so every surface exposes the same icon-menu pattern.
 */
export function ThemeMenuButton(props: ThemeMenuButtonProps) {
  return <ThemeToggle {...props} presentation="menu" />;
}

export interface ThemeColorSyncProps {
  readonly darkColor?: string;
  readonly lightColor?: string;
  readonly metaName?: string;
}

export function themeColorFor(
  resolvedTheme: string | undefined,
  values: Readonly<{ dark: string; light: string }>,
): string {
  return resolvedTheme === "dark" ? values.dark : values.light;
}

/** Keeps browser and installed-app chrome aligned with the resolved theme. */
export function ThemeColorSync({
  darkColor = colors.dark.background,
  lightColor = colors.light.background,
  metaName = "theme-color",
}: ThemeColorSyncProps) {
  const { resolvedTheme } = useTheme();
  const registrationId = useRef(Symbol("hra-design-theme-color"));
  const registration = useRef<ThemeColorMetaRegistration | null>(null);
  const resolvedColor = resolvedTheme === "light" || resolvedTheme === "dark"
    ? themeColorFor(resolvedTheme, { dark: darkColor, light: lightColor })
    : undefined;
  const hasResolvedColor = resolvedColor !== undefined;
  const latestColor = useRef(resolvedColor);
  latestColor.current = resolvedColor;

  useEffect(() => {
    if (!hasResolvedColor || latestColor.current === undefined) return undefined;
    const current = acquireThemeColorMeta(
      document,
      metaName,
      registrationId.current,
      latestColor.current,
    );
    registration.current = current;
    return () => {
      if (registration.current === current) registration.current = null;
      current.release();
    };
  }, [hasResolvedColor, metaName]);

  useEffect(() => {
    if (resolvedColor !== undefined) registration.current?.update(resolvedColor);
  }, [resolvedColor]);

  return null;
}
