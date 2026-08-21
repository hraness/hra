"use client";

import {
  AppearanceIcon as PublicAppearanceIcon,
  Autocomplete as PublicAutocomplete,
  Badge as PublicBadge,
  Button as PublicButton,
  Card as PublicCard,
  CardContent as PublicCardContent,
  CardDescription as PublicCardDescription,
  CardFooter as PublicCardFooter,
  CardHeader as PublicCardHeader,
  CardTitle as PublicCardTitle,
  IconButton as PublicIconButton,
  Icon as PublicIcon,
  Knob as PublicKnob,
  ListBox as PublicListBox,
  ListBoxItem as PublicListBoxItem,
  LinkButton as PublicLinkButton,
  QuietSiteFooter as PublicQuietSiteFooter,
  SearchField as PublicSearchField,
  SocialIcon as PublicSocialIcon,
  Tag as PublicTag,
  TextField as PublicTextField,
} from "@hraness/ui";
import {
  Cancel01Icon,
  CopyLinkIcon,
  Download01Icon,
  MoreHorizontalIcon,
  PlayIcon,
  PlusSignIcon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { type ReactNode, useEffect, useMemo, useState } from "react";

import { Accordion } from "./accordion";
import { AnimatedRailStage } from "./animated-rail-stage";
import { AppShell } from "./app-shell";
import { AuroraDotsBackground } from "./aurora-dots-background";
import { Button, IconButton, ToggleButton } from "./button";
import { Card, Pressable, PressableCard } from "./card";
import { ChatComposer, ChatMessage } from "./chat";
import { BarListChart, RadarProfileChart, RangePlotChart } from "./charts";
import { CheckboxField } from "./checkbox-field";
import {
  EmptyState,
  InlineAlert,
  KeyHint,
  PageIntro,
  ProductionDataPreviewNotice,
  SettingsCard,
} from "./content-primitives";
import { Avatar, DataTable, type DataTableColumn } from "./data-display";
import { Disclosure } from "./disclosure";
import { EmojiIcon, type EmojiIconSource } from "./emoji-icon";
import { Fader } from "./fader";
import { Progress, Skeleton, Spinner } from "./feedback";
import { FileField } from "./file-field";
import { Icon } from "./icon";
import { InlineHelp } from "./inline-help";
import { IconLink, LinkButton, LinkCard } from "./link-button";
import { ListBox, ListBoxItem, ListBoxSection } from "./list-box";
import { DialogTrigger, Modal } from "./modal";
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from "./menu";
import { Breadcrumbs, Pagination } from "./navigation-primitives";
import { NavigationRail, RailItem, RailSection } from "./navigation-rail";
import { NumberField } from "./number-field";
import { ParticleHalo } from "./particle-halo";
import { PhaserDots } from "./phaser-dots";
import { PlaybackTransport } from "./playback-transport";
import { ProceduralBackdrop } from "./procedural-backdrop";
import { RouteErrorPage, RouteLoadingPage, RouteNotFoundPage } from "./route-state";
import { SearchField } from "./search-field";
import { SegmentedControl } from "./segmented-control";
import { SelectField } from "./select-field";
import { SkipLink } from "./skip-link";
import {
  SplitButton,
  SplitButtonMenuTrigger,
  SplitButtonPrimary,
} from "./split-button";
import { Badge, StatusDot } from "./status";
import { SyntaxCode } from "./syntax-code";
import {
  BottomBar,
  DitherSurface,
  DockedFooter,
  PageCanvas,
  ThemedSurface,
  TopBar,
  ViewportFrame,
  WrappingRow,
} from "./surfaces";
import { TabPanel, Tabs } from "./tabs";
import { TextAreaField, TextField } from "./text-field";
import {
  type ConcreteDesignTheme,
  type DesignTheme,
} from "./theme";
import { ToggleGroup } from "./toggle-group";
import { Toolbar } from "./toolbar";
import { Tooltip } from "./tooltip";

const SYNTHETIC_EMOJI_SPRITE = {
  cellSize: 16,
  column: 0,
  pageHeight: 16,
  pageWidth: 32,
  row: 0,
  src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDMyIDE2Ij48cGF0aCBmaWxsPSIjRThFOEU4IiBkPSJNOCAxIDEzIDggOCAxNSAzIDhaIi8+PGNpcmNsZSBmaWxsPSIjMjAyMDIwIiBjeD0iOCIgY3k9IjgiIHI9IjIiLz48cGF0aCBmaWxsPSIjRThFOEU4IiBkPSJNMjEgMmg2djJsLTEgMnYybDQgNXYySDE4di0ybDQtNVY2bC0xLTJaIi8+PHBhdGggZmlsbD0iIzIwMjAyMCIgZD0iTTIwIDExaDhsMiAzSDE4WiIvPjwvc3ZnPg==",
} as const satisfies EmojiIconSource;

const SYNTHETIC_EMOJI_SPRITE_SECOND_CELL = {
  ...SYNTHETIC_EMOJI_SPRITE,
  column: 1,
} as const satisfies EmojiIconSource;

export const designGallerySections = [
  { id: "principles", label: "Principles" },
  { id: "foundations", label: "Foundations" },
  { id: "actions", label: "Actions" },
  { id: "fields", label: "Fields" },
  { id: "selection", label: "Selection" },
  { id: "content", label: "Content" },
  { id: "overlays", label: "Overlays" },
  { id: "layouts", label: "Layouts" },
  { id: "accessibility", label: "Accessibility" },
] as const;

export const designGalleryComponentAnchors = [
  { id: "structure-navigation", label: "Structure & navigation" },
  { id: "content-data", label: "Content & data" },
  { id: "feedback-communication", label: "Feedback & communication" },
  { id: "effects", label: "Effects" },
] as const;

export const designGalleryPatternAnchors = [
  { id: "structural-surfaces", label: "Structural surfaces" },
  { id: "split-actions", label: "Split actions" },
] as const;

type DesignGalleryRecipeFixture =
  | "actions"
  | "content-data"
  | "effects"
  | "feedback-communication"
  | "fields"
  | "hero"
  | "overlays"
  | "route-states"
  | "selection"
  | "structure-navigation";

/**
 * Checked public visual inventory. Each entry names the rendered fixture that
 * carries its `data-design-recipes` evidence in the living specification.
 */
export const designGalleryVisualRecipeCoverage = [
  { fixture: "content-data", recipe: "Accordion" },
  { fixture: "content-data", recipe: "Avatar" },
  { fixture: "content-data", recipe: "BarListChart" },
  { fixture: "structure-navigation", recipe: "AnimatedRailStage" },
  { fixture: "structure-navigation", recipe: "AppShell" },
  { fixture: "effects", recipe: "AuroraDotsBackground" },
  { fixture: "actions", recipe: "Button" },
  { fixture: "hero", recipe: "Badge" },
  { fixture: "structure-navigation", recipe: "BottomBar" },
  { fixture: "structure-navigation", recipe: "Breadcrumbs" },
  { fixture: "content-data", recipe: "Card" },
  { fixture: "feedback-communication", recipe: "ChatComposer" },
  { fixture: "feedback-communication", recipe: "ChatMessage" },
  { fixture: "fields", recipe: "CheckboxField" },
  { fixture: "content-data", recipe: "DataTable" },
  { fixture: "content-data", recipe: "DitherSurface" },
  { fixture: "structure-navigation", recipe: "DockedFooter" },
  { fixture: "content-data", recipe: "Disclosure" },
  { fixture: "content-data", recipe: "EmptyState" },
  { fixture: "selection", recipe: "Fader" },
  { fixture: "fields", recipe: "FileField" },
  { fixture: "actions", recipe: "EmojiIcon" },
  { fixture: "actions", recipe: "Icon" },
  { fixture: "actions", recipe: "IconButton" },
  { fixture: "actions", recipe: "IconLink" },
  { fixture: "content-data", recipe: "InlineAlert" },
  { fixture: "fields", recipe: "InlineHelp" },
  { fixture: "content-data", recipe: "KeyHint" },
  { fixture: "actions", recipe: "LinkButton" },
  { fixture: "content-data", recipe: "LinkCard" },
  { fixture: "selection", recipe: "ListBox" },
  { fixture: "selection", recipe: "ListBoxItem" },
  { fixture: "selection", recipe: "ListBoxSection" },
  { fixture: "overlays", recipe: "Menu" },
  { fixture: "overlays", recipe: "MenuItem" },
  { fixture: "overlays", recipe: "MenuSection" },
  { fixture: "overlays", recipe: "MenuSeparator" },
  { fixture: "overlays", recipe: "Modal" },
  { fixture: "structure-navigation", recipe: "NavigationRail" },
  { fixture: "fields", recipe: "NumberField" },
  { fixture: "structure-navigation", recipe: "PageCanvas" },
  { fixture: "content-data", recipe: "PageIntro" },
  { fixture: "structure-navigation", recipe: "Pagination" },
  { fixture: "effects", recipe: "ParticleHalo" },
  { fixture: "effects", recipe: "PhaserDots" },
  { fixture: "actions", recipe: "PlaybackTransport" },
  { fixture: "content-data", recipe: "PressableCard" },
  { fixture: "content-data", recipe: "Pressable" },
  { fixture: "content-data", recipe: "ProductionDataPreviewNotice" },
  { fixture: "feedback-communication", recipe: "Progress" },
  { fixture: "structure-navigation", recipe: "RailItem" },
  { fixture: "structure-navigation", recipe: "RailSection" },
  { fixture: "route-states", recipe: "RouteErrorPage" },
  { fixture: "route-states", recipe: "RouteLoadingPage" },
  { fixture: "route-states", recipe: "RouteNotFoundPage" },
  { fixture: "content-data", recipe: "RadarProfileChart" },
  { fixture: "content-data", recipe: "RangePlotChart" },
  { fixture: "fields", recipe: "SearchField" },
  { fixture: "selection", recipe: "SegmentedControl" },
  { fixture: "fields", recipe: "SelectField" },
  { fixture: "content-data", recipe: "SettingsCard" },
  { fixture: "content-data", recipe: "SyntaxCode" },
  { fixture: "hero", recipe: "SkipLink" },
  { fixture: "feedback-communication", recipe: "Skeleton" },
  { fixture: "actions", recipe: "SplitButton" },
  { fixture: "actions", recipe: "SplitButtonMenuTrigger" },
  { fixture: "actions", recipe: "SplitButtonPrimary" },
  { fixture: "feedback-communication", recipe: "Spinner" },
  { fixture: "hero", recipe: "StatusDot" },
  { fixture: "selection", recipe: "TabPanel" },
  { fixture: "selection", recipe: "Tabs" },
  { fixture: "fields", recipe: "TextAreaField" },
  { fixture: "fields", recipe: "TextField" },
  { fixture: "content-data", recipe: "ThemedSurface" },
  { fixture: "actions", recipe: "ToggleButton" },
  { fixture: "selection", recipe: "ToggleGroup" },
  { fixture: "actions", recipe: "Toolbar" },
  { fixture: "actions", recipe: "Tooltip" },
  { fixture: "structure-navigation", recipe: "TopBar" },
  { fixture: "effects", recipe: "ProceduralBackdrop" },
  { fixture: "structure-navigation", recipe: "ViewportFrame" },
  { fixture: "structure-navigation", recipe: "WrappingRow" },
] as const satisfies readonly Readonly<{
  fixture: DesignGalleryRecipeFixture;
  recipe: string;
}>[];

/** Public React exports that intentionally have no independent visual fixture. */
export const designGalleryRecipeExclusions = [
  {
    exportName: "DesignPortalThemeProvider",
    reason: "Context-only portal theme propagation is exercised through menu, modal, and tooltip fixtures.",
  },
  {
    exportName: "DesignThemeProvider",
    reason: "Application appearance provider has no visual output; the product header owns its selector.",
  },
  {
    exportName: "DesignKitRouterProvider",
    reason: "Router adapter provider has no visual output; link recipes exercise its consumer contract.",
  },
  {
    exportName: "DialogTrigger",
    reason: "Behavior-only composition wrapper emits no DOM; the Modal fixture exercises it.",
  },
  {
    exportName: "MenuTrigger",
    reason: "Behavior-only composition wrapper emits no DOM; the Menu fixture exercises it.",
  },
  {
    exportName: "ThemeColorSync",
    reason: "Document metadata synchronizer has no visual output.",
  },
  {
    exportName: "ThemeMenuButton",
    reason: "Persistent appearance selection belongs to the host product header, outside nested gallery content.",
  },
  {
    exportName: "ThemeToggle",
    reason: "The compatibility control is represented by the host header's canonical ThemeMenuButton.",
  },
  {
    exportName: "GlobalErrorDocument",
    reason: "Document-owning boundary cannot be nested in a valid gallery document; RouteErrorPage covers its visible composition.",
  },
  {
    exportName: "HelpPopover",
    reason: "Behavior-only overlay content is exercised as the opened half of the InlineHelp fixture.",
  },
  {
    exportName: "DesignSystemGallery",
    reason: "The living-spec host cannot recursively render itself.",
  },
] as const;

function recipeEvidence(fixture: DesignGalleryRecipeFixture): string {
  return designGalleryVisualRecipeCoverage
    .filter((entry) => entry.fixture === fixture)
    .map(({ recipe }) => recipe)
    .join(" ");
}

const fieldOptions = [
  { id: "quiet", label: "Quiet" },
  { id: "balanced", label: "Balanced" },
  { id: "expressive", label: "Expressive" },
] as const;

const longFieldOptions = [
  { id: "summary", label: "A concise summary with supporting detail available on demand" },
  { id: "timeline", label: "A chronological view with intentionally long option copy" },
] as const;

const densityItems = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
] as const;

const viewItems = [
  { id: "canvas", label: "Canvas" },
  { id: "list", label: "List" },
  { id: "split", label: "Split" },
] as const;

const tabItems = [
  { id: "preview", label: "Preview" },
  { id: "details", label: "Details", badge: <Badge>3</Badge> },
  { id: "history", label: "History" },
] as const;

type FieldOption = typeof fieldOptions[number]["id"];
type Density = typeof densityItems[number]["id"];
type View = typeof viewItems[number]["id"];
type GalleryTab = typeof tabItems[number]["id"];
type GalleryTheme = DesignTheme;

/** Resolves the standalone gallery's System choice through the live OS preference. */
export function resolveGalleryTheme(
  theme: GalleryTheme,
  prefersDark: boolean,
): ConcreteDesignTheme {
  return theme === "system" ? (prefersDark ? "dark" : "light") : theme;
}

const designGalleryNavigationItems = [
  ...designGallerySections,
  ...designGalleryComponentAnchors,
  ...designGalleryPatternAnchors,
] as const;

function useActiveGallerySection(): string {
  const sectionIds = useMemo(() => designGalleryNavigationItems.map(({ id }) => id), []);
  const [active, setActive] = useState<string>(sectionIds[0] ?? "");

  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter(({ isIntersecting }) => isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
      const next = visible[0]?.target.id;
      if (next !== undefined) setActive(next);
    }, { rootMargin: "-16% 0px -72% 0px" });

    for (const id of sectionIds) {
      const section = document.getElementById(id);
      if (section !== null) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [sectionIds]);

  return active;
}

function GallerySection({
  children,
  description,
  eyebrow,
  id,
  recipeFixture,
  title,
}: Readonly<{
  children: ReactNode;
  description: ReactNode;
  eyebrow: string;
  id: typeof designGallerySections[number]["id"];
  recipeFixture?: DesignGalleryRecipeFixture;
  title: string;
}>) {
  return (
    <section
      className="design-gallery__section"
      data-design-recipe-fixture={recipeFixture}
      data-design-recipes={recipeFixture === undefined ? undefined : recipeEvidence(recipeFixture)}
      data-design-section
      id={id}
    >
      <header className="design-gallery__section-header">
        <p className="design-gallery__eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

function Specimen({ children, id, title }: Readonly<{
  children: ReactNode;
  id?: typeof designGalleryPatternAnchors[number]["id"];
  title: string;
}>) {
  return (
    <article className="design-gallery__specimen" id={id}>
      <h3>{title}</h3>
      <div className="design-gallery__specimen-body">{children}</div>
    </article>
  );
}

function Principle({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  return (
    <Card className="design-gallery__principle" tone="quiet">
      <h3>{title}</h3>
      <p>{children}</p>
    </Card>
  );
}

function ComponentAnchor({
  children,
  description,
  id,
  recipeFixture,
  title,
}: Readonly<{
  children: ReactNode;
  description: ReactNode;
  id: typeof designGalleryComponentAnchors[number]["id"];
  recipeFixture: DesignGalleryRecipeFixture;
  title: string;
}>) {
  return (
    <section
      className="design-gallery__component-group"
      data-design-component-anchor
      data-design-recipe-fixture={recipeFixture}
      data-design-recipes={recipeEvidence(recipeFixture)}
      id={id}
    >
      <header className="design-gallery__component-header">
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

interface GalleryDataRow {
  readonly id: string;
  readonly name: string;
  readonly owner: string;
  readonly status: "Active" | "Paused" | "Review";
}

const galleryDataRows: readonly GalleryDataRow[] = [
  { id: "alpha", name: "Atlas migration", owner: "Maya Ortiz", status: "Active" },
  {
    id: "beta",
    name: "Long-running accessibility and interaction verification",
    owner: "Rin Shah",
    status: "Review",
  },
] as const;

const galleryDataColumns = [
  {
    cell: (row: GalleryDataRow) => (
      <span className="design-gallery__table-person">
        <Avatar name={row.owner} size="small" />
        <span>{row.owner}</span>
      </span>
    ),
    header: "Owner",
    id: "owner",
  },
  { cell: (row: GalleryDataRow) => row.name, header: "Project", id: "project" },
  {
    align: "end",
    cell: (row: GalleryDataRow) => <Badge>{row.status}</Badge>,
    header: "Status",
    id: "status",
  },
] as const satisfies readonly [
  DataTableColumn<GalleryDataRow>,
  ...DataTableColumn<GalleryDataRow>[],
];

function GalleryNavigationRail() {
  return (
    <NavigationRail
      footer={<span className="design-gallery__rail-footer">v0.1 · Shared kit</span>}
      header={<strong>HRA</strong>}
    >
      <RailSection title="Workspace" titleAs="h4">
        <RailItem
          badge={<Badge>8</Badge>}
          description="Current component inventory"
          href="#structure-navigation"
          icon={<Icon icon={Search01Icon} size={16} />}
          isActive
          label="Design system"
        />
        <RailItem
          description="Long labels truncate without moving badges"
          href="#content-data"
          icon={<Icon icon={MoreHorizontalIcon} size={16} />}
          label="Content and data patterns"
        />
      </RailSection>
    </NavigationRail>
  );
}

function StructureNavigationFixtures() {
  const rail = <GalleryNavigationRail />;
  return (
    <ComponentAnchor
      description="A bounded shell proves that persistent navigation, equal-axis compact chrome, page canvas, and animated route content compose without creating another main landmark."
      id="structure-navigation"
      recipeFixture="structure-navigation"
      title="Structure & navigation"
    >
      <ViewportFrame className="design-gallery__shell-preview">
        <AppShell
          bottomBar={<BottomBar leading="2 selected" actions={<span>Synced</span>}>Keyboard ready</BottomBar>}
          navigationKey="gallery"
          rail={rail}
          topBar={<TopBar actions={<Badge tone="success">Online</Badge>} title="Workspace">Equal-axis compact chrome</TopBar>}
        >
          <AnimatedRailStage stageKey="gallery-shell">
            <PageCanvas as="div" inset="none" size="full">
              <DitherSurface
                as="section"
                className="design-gallery__shell-surface"
                density="fine"
                shape="rectangular"
                tone="secondary"
              >
                <p className="design-gallery__eyebrow">Adaptive canvas</p>
                <h4>Changing content stays inside persistent chrome</h4>
                <p>Long copy wraps inside one content gutter while the workspace reaches its edges.</p>
              </DitherSurface>
            </PageCanvas>
          </AnimatedRailStage>
        </AppShell>
      </ViewportFrame>
      <WrappingRow className="design-gallery__navigation-primitives">
        <Breadcrumbs
          items={[
            { href: "#layouts", id: "gallery", label: "Gallery" },
            { href: "#structure-navigation", id: "components", label: "Components" },
            { id: "navigation", label: "Navigation" },
          ]}
        />
        <Pagination
          currentPage={4}
          hrefForPage={() => "#structure-navigation"}
          siblings={1}
          totalPages={12}
        />
      </WrappingRow>
    </ComponentAnchor>
  );
}

function StructuralSurfaceFixture() {
  return (
    <Specimen id="structural-surfaces" title="Structural surfaces">
      <div className="design-gallery__structural-preview">
        <PageCanvas as="div" inset="none" size="full">
          <ThemedSurface
            as="section"
            className="design-gallery__structural-workspace"
            shape="rectangular"
            tone="secondary"
          >
            <p className="design-gallery__eyebrow">Dense workspace</p>
            <h4>Architecture reaches the parent edge</h4>
            <p>
              Content owns the internal gutter. The singular workspace does not become a floating
              card.
            </p>
          </ThemedSurface>
        </PageCanvas>
        <DockedFooter
          contentClassName="design-gallery__docked-footer-content"
          inset="content"
          position="absolute"
          size="full"
          surface="glass"
        >
          <span>Persistent controls stay flush to the bottom and sides.</span>
          <Badge>Rectangular</Badge>
        </DockedFooter>
      </div>
      <p className="design-gallery__hint">
        Structural surfaces stay rectangular. Bounded content uses the fixed card role. Full
        round belongs only to circles and compact single-line chips.
      </p>
    </Specimen>
  );
}

function ContentDataFixtures() {
  return (
    <ComponentAnchor
      description="Representative empty, long, alert, settings, disclosure, and tabular states keep hierarchy legible without turning every boundary into a box."
      id="content-data"
      recipeFixture="content-data"
      title="Content & data"
    >
      <div className="design-gallery__content-recipes">
        <div className="design-gallery__content-recipes-column">
          <PageIntro
            actions={<Button isDisabled size="compact">Unavailable</Button>}
            description="Changes apply to everyone in this workspace."
            title="Workspace settings"
            titleAs="h4"
          />
          <ProductionDataPreviewNotice surfaceOrigin="https://preview.example.vercel.app" />
          <InlineAlert title="Ready to review" tone="success">
            The checked fixtures are available in every registered browser project.
          </InlineAlert>
          <InlineAlert title="Connection needs attention" tone="danger">
            Retry when the preview service is available.
          </InlineAlert>
          <SettingsCard
            actions={<Pressable aria-label="Open density details" className="design-gallery__dense-press">Details</Pressable>}
            description="Secondary explanation remains compact and the action stays keyboard reachable."
            title="Interface density"
            titleAs="h4"
          >
            <p>Use <KeyHint>⌘</KeyHint> <KeyHint>K</KeyHint> to open command search.</p>
          </SettingsCard>
        </div>
        <div className="design-gallery__content-recipes-column">
          <EmptyState
            action={<Button isDisabled>Nothing to resolve</Button>}
            icon={<Icon icon={Search01Icon} />}
            description="Try a broader query or clear filters. This long description must stay centered without touching the rounded edge."
            title="No matching records"
            titleAs="h4"
          />
          <div className="design-gallery__surface-pair">
            <ThemedSurface as="section" className="design-gallery__themed-sample" tone="accent">
              <strong>Accent surface</strong>
              <span>Color contrast carries the grouping.</span>
            </ThemedSurface>
            <DitherSurface as="section" className="design-gallery__themed-sample" density="coarse" tone="inverse">
              <strong>Dither surface</strong>
              <span>Texture stays decorative and pointer transparent.</span>
            </DitherSurface>
          </div>
        </div>
      </div>
      <Accordion
        className="design-gallery__accordion"
        items={[
          {
            content: <p>Expanded content keeps enough inset for Jelly deformation and long explanatory copy.</p>,
            defaultExpanded: true,
            id: "expanded",
            title: "Expanded implementation notes",
          },
          {
            content: <p>Less critical metadata remains available on demand.</p>,
            id: "closed",
            title: "A closed disclosure with a deliberately long title that must wrap safely",
          },
        ]}
      />
      <figure className="design-gallery__syntax-sample">
        <figcaption>Server-rendered TypeScript with semantic theme tokens</figcaption>
        <pre tabIndex={0}>
          <SyntaxCode
            code={'type Result<T> = { ok: true; value: T } | { ok: false; error: Error };'}
            language="typescript"
          />
        </pre>
      </figure>
      <DataTable
        caption="Responsive project status"
        columns={galleryDataColumns}
        getRowId={(row) => row.id}
        rows={galleryDataRows}
      />
      <div className="design-gallery__chart-grid">
        <article className="design-gallery__chart-sample">
          <h4>Ranked comparison</h4>
          <p className="design-gallery__hint">Bars compare one shared unit; the exact value remains visible.</p>
          <BarListChart
            aria-label="Example quality ranking"
            data={[
              { color: "var(--info)", detail: "12 ms", id: "alpha", label: "Alpha", value: 82 },
              { color: "var(--success)", detail: "18 ms", id: "beta", label: "Beta", value: 68 },
              { color: "var(--warning)", detail: "9 ms", id: "gamma", label: "Gamma", value: 51 },
            ]}
            domain={[0, 100]}
            formatValue={(value) => value.toFixed(0)}
          />
        </article>
        <article className="design-gallery__chart-sample">
          <h4>Multi-metric profile</h4>
          <p className="design-gallery__hint">A radar reveals shape; the hidden table preserves exact values.</p>
          <RadarProfileChart
            aria-label="Example product profiles"
            axes={[
              { id: "speed", label: "Speed" },
              { id: "quality", label: "Quality" },
              { id: "reach", label: "Reach" },
              { id: "efficiency", label: "Efficiency" },
            ]}
            series={[
              {
                color: "var(--info)",
                id: "alpha",
                label: "Alpha",
                values: { efficiency: 72, quality: 86, reach: 58, speed: 76 },
              },
              {
                color: "var(--success)",
                id: "beta",
                label: "Beta",
                values: { efficiency: 88, quality: 68, reach: 81, speed: 55 },
              },
            ]}
          />
        </article>
        <article className="design-gallery__chart-sample design-gallery__chart-sample--wide">
          <h4>Distribution range</h4>
          <p className="design-gallery__hint">Intervals show spread; the dot marks the median.</p>
          <RangePlotChart
            aria-label="Example score ranges"
            data={[
              { color: "var(--info)", detail: "5 observations", id: "one", label: "Group one", maximum: 92, median: 71, minimum: 42 },
              { color: "var(--success)", detail: "8 observations", id: "two", label: "Group two", maximum: 80, median: 62, minimum: 35 },
              { color: "var(--warning)", detail: "4 observations", id: "three", label: "Group three", maximum: 74, median: 53, minimum: 28 },
            ]}
            formatValue={(value) => value.toFixed(0)}
          />
        </article>
      </div>
    </ComponentAnchor>
  );
}

function FeedbackCommunicationFixtures() {
  const [draft, setDraft] = useState("A concise update with enough context to act.");
  return (
    <ComponentAnchor
      description="Loading, progress, messaging, route fallbacks, and decorative motion remain understandable with long copy, disabled actions, and reduced motion."
      id="feedback-communication"
      recipeFixture="feedback-communication"
      title="Feedback & communication"
    >
      <div className="design-gallery__feedback-grid">
        <article className="design-gallery__feedback-card">
          <h4>Progress and loading</h4>
          <p className="design-gallery__hint">Three decorative spinner sizes</p>
          <div className="design-gallery__spinner-row">
            <Spinner size="small" />
            <Spinner />
            <Spinner size="large" />
          </div>
          <Progress label="Verification" showValue value={68} />
          <div className="design-gallery__skeleton-stack">
            <Skeleton isText width="92%" />
            <Skeleton isText width="64%" />
            <Skeleton height="5rem" />
          </div>
        </article>
        <article
          className="design-gallery__feedback-card design-gallery__chat-preview"
          data-design-intentional-loading-fixture
        >
          <h4>Conversation</h4>
          <ChatMessage
            avatar={<Avatar name="Avery Chen" size="small" />}
            meta="Just now"
            name="Avery"
            role="assistant"
          >
            The responsive verification passed. Review the remaining contrast note when convenient.
          </ChatMessage>
          <ChatMessage meta="Draft" role="user">I’ll check the narrow layout next.</ChatMessage>
          <ChatMessage role="system">Preview reconnecting; no work has been lost.</ChatMessage>
          <ChatComposer
            isPending
            onSubmit={() => undefined}
            onValueChange={setDraft}
            value={draft}
          />
        </article>
      </div>
      <div
        className="design-gallery__route-states"
        data-design-recipe-fixture="route-states"
        data-design-recipes={recipeEvidence("route-states")}
      >
        <RouteNotFoundPage canvasAs="div" showThemeToggle={false} titleAs="h4" />
        <RouteErrorPage
          announce={false}
          autoFocus={false}
          canvasAs="div"
          error={new Error("Gallery route-state fixture")}
          reset={() => undefined}
          showThemeToggle={false}
          titleAs="h4"
        />
        <RouteLoadingPage announce={false} canvasAs="div" />
      </div>
    </ComponentAnchor>
  );
}

function EffectsFixtures() {
  return (
    <ComponentAnchor
      description="Deterministic atmosphere, geometry, and particles add a restrained modern accent without replacing the warm semantic canvas or hiding meaningful content."
      id="effects"
      recipeFixture="effects"
      title="Effects"
    >
      <div className="design-gallery__effects-grid">
        <article className="design-gallery__effect-preview">
          <ProceduralBackdrop seed="design-gallery-atmosphere" variant="composite" />
          <div className="design-gallery__effect-copy">
            <p className="design-gallery__eyebrow">Procedural backdrop</p>
            <h4>A stable brand field behind ordinary content</h4>
            <p>Seed and integer variation preserve the composition across SSR and hydration.</p>
          </div>
        </article>
        <div className="design-gallery__effect-preview design-gallery__effect-preview--halo">
          <ParticleHalo seed="design-gallery-halo">
            <strong className="design-gallery__halo-mark">HRA</strong>
          </ParticleHalo>
          <p>Semantic artwork stays in the DOM; only its surrounding particles are decorative.</p>
        </div>
        <article className="design-gallery__effect-preview">
          <AuroraDotsBackground />
          <PhaserDots className="design-gallery__standalone-dots" fadeDirection="right" />
          <div className="design-gallery__effect-copy">
            <p className="design-gallery__eyebrow">Decorative field</p>
            <h4>Aurora and phaser dots stay behind content</h4>
            <p>The static layer survives hydration; the pointer trail yields to reduced motion.</p>
          </div>
        </article>
      </div>
    </ComponentAnchor>
  );
}

/**
 * Interactive, product-neutral living documentation for the shared browser kit.
 * Every Next product mounts this exact composition at `/design`.
 */
export function DesignSystemGallery({
  isNestedInMain = false,
}: Readonly<{ isNestedInMain?: boolean }>) {
  const activeSection = useActiveGallerySection();
  const [density, setDensity] = useState<Density>("comfortable");
  const [autocompleteActivationCount, setAutocompleteActivationCount] = useState(0);
  const [autocompleteChoice, setAutocompleteChoice] = useState("None");
  const [fieldOption, setFieldOption] = useState<FieldOption>("balanced");
  const [faderValue, setFaderValue] = useState(68);
  const [knobValue, setKnobValue] = useState(64);
  const [isPendingGeometry, setPendingGeometry] = useState(false);
  const [isPinned, setPinned] = useState(false);
  const [tab, setTab] = useState<GalleryTab>("preview");
  const [view, setView] = useState<View>("canvas");
  const Root = isNestedInMain ? "div" : "main";

  return (
    <Root
      className="design-gallery"
      data-design-gallery-nested={isNestedInMain ? "true" : "false"}
      id="design-gallery-main"
      tabIndex={-1}
    >
      <SkipLink href="#design-gallery-main">Skip to design specimens</SkipLink>
      <header
        className="design-gallery__hero"
        data-design-recipe-fixture="hero"
        data-design-recipes={recipeEvidence("hero")}
      >
        <div>
          <p className="design-gallery__eyebrow">HRA design system</p>
          <h1>Browser design system</h1>
          <p className="design-gallery__lede">
            Inspect edge-aligned architecture, bounded Jelly objects, shared spacing, compact
            information patterns, and the interaction states required for touch, pointer, and
            keyboard input. Selectable browser surfaces start with System appearance; explicit
            Light, Dark, and System choices persist.
          </p>
        </div>
        {isNestedInMain
          ? null
          : (
              <div className="design-gallery__hero-actions">
                <Badge tone="success"><StatusDot tone="success" />Live specification</Badge>
              </div>
            )}
      </header>

      {isNestedInMain
        ? null
        : (
            <nav aria-label="Design system sections" className="design-gallery__mobile-nav">
              {designGalleryNavigationItems.map((section) => (
                <a
                  aria-current={activeSection === section.id ? "location" : undefined}
                  href={`#${section.id}`}
                  key={section.id}
                >
                  {section.label}
                </a>
              ))}
            </nav>
          )}

      <div className="design-gallery__layout">
        {isNestedInMain
          ? null
          : (
              <nav aria-label="Design system sections" className="design-gallery__side-nav">
                <p>Sections</p>
                {designGallerySections.map((section) => (
                  <a
                    aria-current={activeSection === section.id ? "location" : undefined}
                    href={`#${section.id}`}
                    key={section.id}
                  >
                    {section.label}
                  </a>
                ))}
                <p>Component groups</p>
                {designGalleryComponentAnchors.map((section) => (
                  <a
                    aria-current={activeSection === section.id ? "location" : undefined}
                    href={`#${section.id}`}
                    key={section.id}
                  >
                    {section.label}
                  </a>
                ))}
                <p>Patterns</p>
                {designGalleryPatternAnchors.map((section) => (
                  <a
                    aria-current={activeSection === section.id ? "location" : undefined}
                    href={`#${section.id}`}
                    key={section.id}
                  >
                    {section.label}
                  </a>
                ))}
              </nav>
            )}

        <div className="design-gallery__content">
          <GallerySection
            description="These defaults remove noise before a product adds any personality. Exceptions need a concrete interaction or information reason."
            eyebrow="01 · Direction"
            id="principles"
            title="Design principles"
          >
            <div className="design-gallery__principles">
              <Principle title="Contrast before borders">
                Separate hierarchy with surface tone and spacing. Draw a line only when adjacent
                backgrounds cannot explain the boundary.
              </Principle>
              <Principle title="Icons before repeated labels">
                Use a familiar icon for compact actions, retain a programmatic name, and reveal
                extra explanation on hover, focus, or demand.
              </Principle>
              <Principle title="Progressive disclosure">
                Keep primary state visible. Move metadata, secondary controls, and implementation
                detail into menus, disclosures, or dedicated detail views.
              </Principle>
              <Principle title="Structure is behavior">
                Padding, radius, stacking, focus, and target size are testable contracts—not final
                polish applied after a feature works.
              </Principle>
              <Principle title="One spacing owner">
                Each nesting boundary owns one inset. A child does not repeat its parent’s page,
                panel, or toolbar padding.
              </Principle>
              <Principle title="Keep structural surfaces rectangular">
                App shells, workspaces, persistent bars, full-width sections, and dense row
                collections reach their parent edge. Content-bearing cards use a fixed card
                curve. Full round belongs only to circles and compact single-line chips.
              </Principle>
              <Principle title="Stable action identity">
                Pending work swaps a reserved icon for a spinner. The action label, width, order,
                and focus target stay fixed from press through completion.
              </Principle>
              <Principle title="Center visible control content">
                Treat an icon and its label as one centered cluster. Never add an empty mirror
                slot that shifts the visible pair, and size one-character commands like icons.
              </Principle>
              <Principle title="Literal headings">
                Start with one object, task, data view, or state label. Add an eyebrow or
                description only when it supplies distinct context or instruction.
              </Principle>
            </div>
          </GallerySection>

          <GallerySection
            description="The scale is deliberately small: a few stable tokens produce a coherent rhythm across light and dark products."
            eyebrow="02 · Tokens"
            id="foundations"
            title="Foundations"
          >
            <div className="design-gallery__specimen-grid">
              <Specimen title="Type hierarchy">
                <div className="design-gallery__type-stack">
                  <p data-kind="display">Display with restraint</p>
                  <p data-kind="title">A decisive page title</p>
                  <p data-kind="heading">A scannable section heading</p>
                  <p data-kind="body">Body copy stays calm and readable at ordinary density.</p>
                  <p data-kind="caption">Caption · secondary, never illegible</p>
                </div>
              </Specimen>
              <Specimen title="Surface hierarchy">
                <div className="design-gallery__theme-pair">
                  <div className="design-gallery__theme" data-theme="light">
                    <span data-surface="canvas">Canvas</span>
                    <span data-surface="surface">Surface</span>
                    <span data-surface="raised">Raised</span>
                  </div>
                  <div className="design-gallery__theme" data-theme="dark">
                    <span data-surface="canvas">Canvas</span>
                    <span data-surface="surface">Surface</span>
                    <span data-surface="raised">Raised</span>
                  </div>
                </div>
              </Specimen>
              <Specimen title="Radius and spacing">
                <div className="design-gallery__token-row">
                  <span data-radius="control">Control</span>
                  <span data-radius="card">Card</span>
                  <span data-radius="overlay">Overlay</span>
                  <span data-radius="round">Round</span>
                </div>
                <p className="design-gallery__hint">
                  Control, card, and overlay curves stay bounded. Round is an explicit circle or
                  compact single-line pill, never a multiline container.
                </p>
              </Specimen>
              <Specimen title="Plain site theme">
                <div className="plain-site plain-publication design-gallery__plain-theme">
                  <header className="plain-header">
                    <div className="plain-header__inner">
                      <a className="plain-wordmark" href="#foundations">project</a>
                      <nav aria-label="Plain site example" className="plain-nav">
                        <a href="#foundations">Articles</a>
                        <a href="#principles">About</a>
                      </nav>
                    </div>
                  </header>
                  <div className="plain-publication__index-content plain-publication__shell">
                    <p className="plain-publication__eyebrow">Engineering</p>
                    <div className="plain-publication__article-list">
                      <article className="plain-publication__entry">
                        <h3><a href="#content-data">A factual article title</a></h3>
                        <p>One direct sentence that tells the reader what the article covers.</p>
                        <p className="plain-publication__entry-meta">July 2026 · 5 min read</p>
                      </article>
                    </div>
                  </div>
                  <footer className="plain-footer">
                    <p>project</p>
                    <div className="plain-footer__links">
                      <a href="#principles">Source</a>
                    </div>
                  </footer>
                </div>
              </Specimen>
            </div>
          </GallerySection>

          <GallerySection
            description="Actions remain intrinsically sized, keep a 48 px touch target by default, and expose every state without shifting surrounding layout."
            eyebrow="03 · Controls"
            id="actions"
            recipeFixture="actions"
            title="Actions"
          >
            <div className="design-gallery__specimen-grid">
              <Specimen title="Hierarchy and size">
                <div className="design-gallery__control-wrap">
                  <Button variant="primary">Continue</Button>
                  <Button variant="secondary">Save draft</Button>
                  <Tooltip label="Dismiss for now">
                    <Button variant="quiet">Not now</Button>
                  </Tooltip>
                  <Button variant="danger">Remove</Button>
                  <Button size="compact">Compact</Button>
                  <Button size="large" variant="primary">Large primary</Button>
                  <Button leading={<Icon icon={PlayIcon} />} size="large" variant="primary">
                    Play
                  </Button>
                  <Button aria-label="Mute channel" data-design-glyph-button size="compact">M</Button>
                  <Button aria-label="Bypass channel" data-design-glyph-button>B</Button>
                  <Button aria-label="Cue channel" data-design-glyph-button size="large">C</Button>
                  <LinkButton href="#fields" variant="secondary">Jump to fields</LinkButton>
                </div>
                <p className="design-gallery__hint">
                  Leading icons and labels center as one cluster; single glyphs inherit the same
                  20 px visual scale and square target footprint as shared icons.
                </p>
              </Specimen>
              <Specimen title="Portable public core">
                <PublicCard
                  className="design-gallery__sample-card"
                  data-design-public-ui-core
                  tone="card"
                >
                  <PublicCardHeader>
                    <PublicBadge tone="info">@hraness/ui</PublicBadge>
                    <div className="design-gallery__control-wrap">
                      <PublicTag
                        accentColor="#D97706"
                        icon={(
                          <EmojiIcon
                            dominantColor="#D97706"
                            size={14}
                            source={SYNTHETIC_EMOJI_SPRITE}
                            variant="dominant-color-duotone"
                          />
                        )}
                        variant="outline"
                      >
                        linked project
                      </PublicTag>
                      <PublicTag variant="outline">
                        default outline
                      </PublicTag>
                      <PublicTag
                        icon={<EmojiIcon size={14} source={SYNTHETIC_EMOJI_SPRITE_SECOND_CELL} />}
                      >
                        project
                      </PublicTag>
                      <PublicTag variant="muted">reading</PublicTag>
                    </div>
                    <PublicCardTitle>Shared behavior and styling</PublicCardTitle>
                    <PublicCardDescription>
                      HRA supplies its product typography and theme while the public core owns
                      portable controls, shared glyphs, and quiet-site geometry.
                    </PublicCardDescription>
                  </PublicCardHeader>
                  <PublicCardContent>
                    <PublicTextField
                      description="The same field contract is available to Ocean and other consumers."
                      label="Portable field"
                      placeholder="Type here"
                      surface="card"
                    />
                    <div className="design-gallery__control-wrap">
                      <PublicSocialIcon name="instagram" />
                      <PublicSocialIcon name="substack" />
                      <PublicSocialIcon name="threads" />
                      <PublicSocialIcon name="x" />
                      <PublicAppearanceIcon name="light" />
                      <PublicAppearanceIcon name="dark" />
                      <PublicAppearanceIcon name="system" />
                    </div>
                  </PublicCardContent>
                  <PublicCardFooter>
                    <div className="design-gallery__control-wrap">
                      <PublicButton variant="primary">Continue</PublicButton>
                      <PublicLinkButton href="#fields">View fields</PublicLinkButton>
                      <PublicIconButton aria-label="Refresh public example">
                        <PublicIcon icon={RefreshIcon} />
                      </PublicIconButton>
                    </div>
                  </PublicCardFooter>
                </PublicCard>
                <PublicQuietSiteFooter>
                  <span>Quiet-site footer</span>
                  <PublicAppearanceIcon name="system" />
                </PublicQuietSiteFooter>
              </Specimen>
              <Specimen title="Icon actions">
                <Toolbar aria-label="Document actions" className="design-gallery__toolbar">
                  <IconButton aria-label="Search"><Icon icon={Search01Icon} /></IconButton>
                  <IconButton aria-label="Copy link"><Icon icon={CopyLinkIcon} /></IconButton>
                  <IconButton aria-label="Download"><Icon icon={Download01Icon} /></IconButton>
                  <IconButton aria-label="Add" size="large" variant="secondary">
                    <Icon icon={PlusSignIcon} />
                  </IconButton>
                  <IconButton aria-label="Close" size="compact"><Icon icon={Cancel01Icon} /></IconButton>
                  <IconLink aria-label="Jump to overlays" href="#overlays" size="compact">
                    <Icon icon={MoreHorizontalIcon} />
                  </IconLink>
                </Toolbar>
                <p className="design-gallery__hint">
                  Every icon action derives a hover and focus tooltip from its accessible name.
                </p>
              </Specimen>
              <Specimen title="State stability">
                <div className="design-gallery__control-wrap">
                  <ToggleButton isSelected={isPinned} onChange={setPinned}>Pinned</ToggleButton>
                  <ToggleButton aria-label="Loop" isIconOnly size="large">
                    <Icon icon={RefreshIcon} />
                  </ToggleButton>
                  <ToggleButton data-design-danger-toggle isSelected variant="danger">
                    Destructive mode
                  </ToggleButton>
                  <Button data-haptic-demo="enabled" hapticFeedback="press">Tactile press</Button>
                  <Button data-haptic-demo="disabled" hapticFeedback="press" isDisabled>
                    Unavailable
                  </Button>
                </div>
              </Specimen>
              <Specimen title="Playback lifecycle">
                <div
                  className="design-gallery__control-wrap"
                  data-design-intentional-loading-fixture
                  data-design-playback-transport-states
                >
                  <PlaybackTransport
                    aria-label="Idle playback controls"
                    onPlay={() => undefined}
                    onStop={() => undefined}
                    status="idle"
                    trailingControls={<ToggleButton>Loop</ToggleButton>}
                  />
                  <PlaybackTransport
                    aria-label="Pending playback controls"
                    onPlay={() => undefined}
                    onStop={() => undefined}
                    status="pending"
                    trailingControls={<ToggleButton>Loop</ToggleButton>}
                  />
                  <PlaybackTransport
                    aria-label="Playing playback controls"
                    onPlay={() => undefined}
                    onStop={() => undefined}
                    status="playing"
                    trailingControls={<ToggleButton isSelected>Loop</ToggleButton>}
                  />
                </div>
                <p className="design-gallery__hint">
                  One larger icon command starts playback, cancels startup, and stops playback
                  without adding a second transport target or persistent label.
                </p>
              </Specimen>
              <Specimen title="Pending geometry">
                <div className="design-gallery__control-wrap" data-design-pending-geometry>
                  <Button
                    data-design-pending-state={isPendingGeometry ? "pending" : "ready"}
                    data-design-pending-target
                    data-haptic-demo={isPendingGeometry ? "pending" : undefined}
                    hapticFeedback="press"
                    isDisabled={isPendingGeometry}
                    isPending={isPendingGeometry}
                    variant="primary"
                  >
                    Save changes
                  </Button>
                  <Button
                    data-design-pending-transition
                    onPress={() => setPendingGeometry((current) => !current)}
                    size="compact"
                    variant="quiet"
                  >
                    Toggle pending
                  </Button>
                  <IconButton
                    aria-label="Unavailable action"
                    data-design-disabled-icon-tooltip
                    isDisabled
                  >
                    <Icon icon={MoreHorizontalIcon} />
                  </IconButton>
                  <IconLink
                    aria-label="Unavailable destination"
                    data-design-disabled-icon-link-tooltip
                    href="#overlays"
                    isDisabled
                  >
                    <Icon icon={CopyLinkIcon} />
                  </IconLink>
                  <Pressable
                    aria-label="Unavailable compact action"
                    className="design-gallery__dense-press"
                    data-design-disabled-pressable-tooltip
                    isDisabled
                  >
                    <Icon icon={PlusSignIcon} />
                  </Pressable>
                </div>
                <p className="design-gallery__hint">
                  Ready and pending keep one label, footprint, DOM order, focus target, and a
                  centered visible-content cluster.
                </p>
              </Specimen>
              <Specimen id="split-actions" title="Split action">
                <SplitButton
                  aria-label="Publish actions"
                  className="design-gallery__split-action"
                  data-design-split-action
                  variant="primary"
                >
                  <SplitButtonPrimary
                    className="design-gallery__split-action-primary"
                    data-design-split-segment="primary"
                  >
                    Publish
                  </SplitButtonPrimary>
                  <SplitButtonMenuTrigger
                    aria-label="More publish options"
                    className="design-gallery__split-action-menu"
                    data-design-split-segment="menu"
                    menu={(
                      <Menu aria-label="Publish options">
                      <MenuItem id="schedule">Schedule publish</MenuItem>
                      <MenuItem id="draft">Save as draft</MenuItem>
                      </Menu>
                    )}
                    tooltip="More publish options"
                  >
                    <Icon icon={MoreHorizontalIcon} />
                  </SplitButtonMenuTrigger>
                </SplitButton>
                <p className="design-gallery__hint">
                  The text segment performs the default action; the named icon segment opens
                  adjacent variants. Each remains a separate keyboard target.
                </p>
              </Specimen>
            </div>
          </GallerySection>

          <GallerySection
            description="Labels clarify unfamiliar input, descriptions appear only when they prevent error, and every field keeps its inset at long and narrow sizes."
            eyebrow="04 · Input"
            id="fields"
            recipeFixture="fields"
            title="Fields"
          >
            <div className="design-gallery__field-matrix" data-design-field-matrix>
              <Specimen title="Text input · size, surface, state">
                <div className="design-gallery__field-stack">
                  <TextField
                    defaultValue="Compact card"
                    label="Compact text field"
                    labelAccessory={(
                      <InlineHelp aria-label="About compact text fields">
                        Compact fields preserve the same typing and validation semantics in less space.
                      </InlineHelp>
                    )}
                    size="compact"
                    surface="card"
                  />
                  <TextField
                    defaultValue="missing-at-sign"
                    errorMessage="Enter a valid email address."
                    isInvalid
                    label="Default invalid text field"
                    type="email"
                  />
                  <TextField
                    defaultValue="A deliberately long disabled value that must remain inset and wrap safely"
                    description="Disabled supporting copy remains readable against a pane surface."
                    isDisabled
                    label="Large disabled text field with long content"
                    size="large"
                    surface="pane"
                  />
                </div>
              </Specimen>

              <Specimen title="Textarea · size, surface, state">
                <div className="design-gallery__field-stack">
                  <TextAreaField
                    defaultValue="Compact note"
                    label="Compact card textarea"
                    size="compact"
                    surface="card"
                    textAreaProps={{ rows: 2 }}
                  />
                  <TextAreaField
                    defaultValue="Too short"
                    errorMessage="Add enough context for another person to act."
                    isInvalid
                    label="Default invalid textarea"
                    textAreaProps={{ rows: 3 }}
                  />
                  <TextAreaField
                    defaultValue="This deliberately long disabled note checks that multiline copy keeps generous inset spacing on narrow layouts without colliding with the rounded Jelly edge."
                    description="Long copy, disabled contrast, and resize-safe geometry share one fixture."
                    isDisabled
                    label="Large disabled pane textarea"
                    size="large"
                    surface="pane"
                    textAreaProps={{ rows: 4 }}
                  />
                </div>
              </Specimen>

              <Specimen title="Search · size, surface, state">
                <div className="design-gallery__field-stack">
                  <SearchField
                    defaultValue="jelly"
                    label="Compact card search"
                    showLabel
                    size="compact"
                    surface="card"
                  />
                  <SearchField
                    defaultValue="A long query that must never crowd the clear action"
                    isInvalid
                    label="Default invalid search"
                    showLabel
                  />
                  <SearchField
                    defaultValue="Disabled search retains its text contrast"
                    isDisabled
                    label="Large disabled pane search"
                    showLabel
                    size="large"
                    surface="pane"
                  />
                </div>
              </Specimen>

              <Specimen title="Select · size, surface, state">
                <div className="design-gallery__field-stack">
                  <SelectField
                    label="Compact card selection"
                    onChange={setFieldOption}
                    options={fieldOptions}
                    size="compact"
                    surface="card"
                    value={fieldOption}
                  />
                  <SelectField
                    errorMessage="Choose an available mode."
                    isInvalid
                    label="Default invalid selection"
                    options={fieldOptions}
                    placeholder="Choose a mode"
                  />
                  <SelectField
                    disabled
                    label="Large disabled pane selection with long content"
                    options={longFieldOptions}
                    size="large"
                    surface="pane"
                    value="summary"
                  />
                </div>
              </Specimen>

              <Specimen title="Number · size, surface, state">
                <div className="design-gallery__field-stack">
                  <NumberField
                    defaultValue={2}
                    label="Compact card quantity"
                    maxValue={9}
                    minValue={0}
                    size="compact"
                    surface="card"
                  />
                  <NumberField
                    defaultValue={99}
                    errorMessage="Enter a value from 1 to 12."
                    isInvalid
                    label="Default invalid quantity"
                    maxValue={12}
                    minValue={1}
                  />
                  <NumberField
                    defaultValue={3}
                    description="A long disabled description checks wrapping beside fixed-size step controls."
                    isDisabled
                    label="Large disabled pane quantity"
                    maxValue={12}
                    minValue={1}
                    size="large"
                    surface="pane"
                  />
                </div>
              </Specimen>

              <Specimen title="Native capability fields · state">
                <div className="design-gallery__field-stack">
                  <CheckboxField
                    defaultChecked
                    description="A full-row target keeps this deliberately long label easy to understand and hit."
                    label="Send a completion update when every background task has finished"
                  />
                  <CheckboxField
                    aria-invalid="true"
                    description="Resolve the required choice before continuing."
                    label="Invalid required checkbox"
                  />
                  <CheckboxField
                    disabled
                    description="Disabled copy remains readable without compounded opacity."
                    label="Disabled checkbox"
                  />
                  <FileField
                    accept="image/*"
                    description="PNG, JPEG, or WebP; long filenames must wrap without widening the page."
                    label="Reference image"
                  />
                  <FileField
                    aria-invalid="true"
                    description="Choose a supported reference image before continuing."
                    label="Invalid file input"
                  />
                  <FileField
                    accept="image/*"
                    description="Disabled native file controls retain legible supporting copy."
                    disabled
                    label="Disabled file input"
                  />
                </div>
              </Specimen>
            </div>
          </GallerySection>

          <GallerySection
            description="Selection widgets own arrow-key movement, one visible selected surface across compositions, and recovery when controlled values change."
            eyebrow="05 · Choice"
            id="selection"
            recipeFixture="selection"
            title="Selection and navigation"
          >
            <div className="design-gallery__specimen-grid">
              <Specimen title="Segmented control">
                <div className="design-gallery__state-stack">
                  <SegmentedControl
                    aria-label="Preview density"
                    items={densityItems}
                    onChange={setDensity}
                    value={density}
                  />
                  <SegmentedControl
                    aria-label="Disabled density"
                    isDisabled
                    items={densityItems}
                    onChange={() => undefined}
                    size="compact"
                    value="compact"
                  />
                </div>
              </Specimen>
              <Specimen title="Toggle group">
                <div className="design-gallery__state-stack">
                  <ToggleGroup
                    aria-label="Workspace view"
                    items={viewItems}
                    onChange={(next) => {
                      if (next !== null) setView(next);
                    }}
                    value={view}
                  />
                  <ToggleGroup
                    aria-label="Disabled workspace view"
                    isDisabled
                    items={viewItems.slice(0, 2)}
                    onChange={() => undefined}
                    value="canvas"
                  />
                </div>
              </Specimen>
              <Specimen title="Tabs">
                <div className="design-gallery__state-stack">
                  <Tabs
                    aria-label="Record sections"
                    items={tabItems}
                    onChange={setTab}
                    size="compact"
                    value={tab}
                  >
                    <TabPanel id="preview">A focused preview with no secondary metadata.</TabPanel>
                    <TabPanel id="details">Three compact details live behind this tab.</TabPanel>
                    <TabPanel id="history">Prior states remain keyboard reachable.</TabPanel>
                  </Tabs>
                  <Tabs
                    aria-label="Tabs with an unavailable destination"
                    items={[
                      { id: "current", label: "Current" },
                      { id: "unavailable", isDisabled: true, label: "Unavailable" },
                    ]}
                    onChange={() => undefined}
                    size="compact"
                    value="current"
                  >
                    <TabPanel id="current">The disabled tab stays visible and unreachable.</TabPanel>
                    <TabPanel id="unavailable">Unavailable content.</TabPanel>
                  </Tabs>
                </div>
              </Specimen>
              <Specimen title="List box">
                <ListBox
                  aria-label="Interface expression"
                  defaultSelectedKeys={["calm"]}
                  selectionMode="single"
                >
                  <ListBoxSection title="Available">
                    <ListBoxItem id="calm" textValue="Calm">Calm</ListBoxItem>
                    <ListBoxItem id="compact" textValue="Compact">Compact</ListBoxItem>
                    <ListBoxItem id="expressive" textValue="Expressive">Expressive</ListBoxItem>
                  </ListBoxSection>
                  <ListBoxSection title="Unavailable">
                    <ListBoxItem isDisabled id="unavailable" textValue="Unavailable">
                      Unavailable long-content choice
                    </ListBoxItem>
                  </ListBoxSection>
                </ListBox>
              </Specimen>
              <Specimen title="Searchable list">
                <div
                  className="design-gallery__field-stack"
                  data-design-autocomplete
                >
                  <PublicAutocomplete
                    filter={(textValue, inputValue) => (
                      textValue.toLocaleLowerCase("en-US").includes(
                        inputValue.toLocaleLowerCase("en-US"),
                      )
                    )}
                  >
                    <PublicSearchField
                      label="Search interface modes"
                      placeholder="Search modes"
                      showLabel
                      surface="card"
                    />
                    <PublicListBox
                      aria-label="Searchable interface modes"
                      renderEmptyState={() => (
                        <p className="design-gallery__hint" role="status">
                          No matching modes.
                        </p>
                      )}
                    >
                      {([
                        ["calm", "Calm interface"],
                        ["compact", "Compact interface"],
                        ["expressive", "Expressive interface"],
                      ] as const).map(([id, label]) => (
                        <PublicListBoxItem
                          id={id}
                          key={id}
                          onAction={() => {
                            setAutocompleteActivationCount(count => count + 1);
                            setAutocompleteChoice(label);
                          }}
                          textValue={label}
                        >
                          {label}
                        </PublicListBoxItem>
                      ))}
                    </PublicListBox>
                  </PublicAutocomplete>
                  <output
                    data-activation-count={autocompleteActivationCount}
                    data-choice={autocompleteChoice}
                    data-design-autocomplete-result
                  >
                    {autocompleteChoice} · {autocompleteActivationCount}
                  </output>
                </div>
                <p className="design-gallery__hint">
                  Search keeps DOM focus while arrow keys move virtual option focus.
                </p>
              </Specimen>
              <Specimen title="Fader">
                <div className="design-gallery__fader-demo">
                  <Fader
                    label="Output level"
                    maxValue={100}
                    minValue={0}
                    onChange={setFaderValue}
                    showLabel
                    showOutput
                    value={faderValue}
                  />
                  <Fader
                    defaultValue={42}
                    density="compact"
                    isDisabled
                    label="Disabled output level"
                    maxValue={100}
                    minValue={0}
                    showLabel
                    showOutput
                  />
                </div>
              </Specimen>
              <Specimen title="Knob">
                <div className="design-gallery__knob-demo">
                  <PublicKnob
                    label="Output level"
                    onChange={setKnobValue}
                    value={knobValue}
                  />
                  <PublicKnob
                    defaultValue={42}
                    density="compact"
                    disabled
                    label="Disabled output level"
                    outputVisibility="visually-hidden"
                  />
                </div>
                <p className="design-gallery__hint">
                  Drag right or up to increase. Drag left or down to decrease.
                  Shift-drag makes fine adjustments; arrow keys remain available.
                </p>
              </Specimen>
            </div>
          </GallerySection>

          <GallerySection
            description="Cards establish a padded grouping. Disclosures keep less critical information available without making it compete with the primary task."
            eyebrow="06 · Surfaces"
            id="content"
            recipeFixture="content-data"
            title="Content and status"
          >
            <ContentDataFixtures />
            <EffectsFixtures />
            <div className="design-gallery__content-grid">
              <Card className="design-gallery__sample-card">
                <div className="design-gallery__card-heading">
                  <div>
                    <p className="design-gallery__eyebrow">Workspace</p>
                    <h3>Design review</h3>
                  </div>
                  <Badge tone="success"><StatusDot tone="success" />Ready</Badge>
                </div>
                <p>Primary content has room to breathe without wasting the narrow viewport.</p>
                <Button size="compact" variant="primary">Open</Button>
              </Card>
              <PressableCard className="design-gallery__sample-card" onPress={() => undefined}>
                <span className="design-gallery__card-heading">
                  <span>
                    <span className="design-gallery__eyebrow">Interactive card</span>
                    <strong>One semantic target</strong>
                  </span>
                  <Badge tone="warning">Needs review</Badge>
                </span>
                <span>Press, focus, and disabled states never create nested controls.</span>
              </PressableCard>
              <LinkCard className="design-gallery__sample-card" href="#layouts">
                <span className="design-gallery__sample-link-copy">
                  <span className="design-gallery__eyebrow">Semantic link card</span>
                  <strong>Open responsive stress cases</strong>
                  <span>One anchor owns the padded surface and its focus state.</span>
                </span>
              </LinkCard>
              <div className="design-gallery__disclosure-matrix" data-design-disclosure-matrix>
                <Disclosure defaultOpen size="compact" title="Compact metadata">
                  <div className="design-gallery__disclosure-copy">
                    <p>Version 0.1 · Jelly surface · native details semantics</p>
                  </div>
                </Disclosure>
                <Disclosure size="default" title="Default closed disclosure">
                  <div className="design-gallery__disclosure-copy">
                    <p>This secondary detail remains available without competing with the card.</p>
                  </div>
                </Disclosure>
                <Disclosure
                  defaultOpen
                  size="large"
                  title="Large disclosure with a deliberately long title that must wrap before the chevron"
                >
                  <div className="design-gallery__disclosure-copy">
                    <p>
                      Long disclosure content checks padding, wrapping, rounded containment, and
                      stable open-state geometry at narrow and wide viewport sizes.
                    </p>
                  </div>
                </Disclosure>
              </div>
            </div>
          </GallerySection>

          <GallerySection
            description="Portalled UI stays above surrounding content, fits the visual viewport, restores focus, and remains dismissible by Escape. Contextual utilities share the label or toolbar row they qualify."
            eyebrow="07 · Layers"
            id="overlays"
            recipeFixture="overlays"
            title="Menus and dialogs"
          >
            <div className="design-gallery__overlay-stage" data-design-overlay-stage>
              <div>
                <div className="design-gallery__context-row">
                  <p className="design-gallery__eyebrow">Anchored menu</p>
                  <MenuTrigger>
                    <IconButton aria-label="More actions"><Icon icon={MoreHorizontalIcon} /></IconButton>
                    <Menu aria-label="More actions">
                      <MenuSection title="Document">
                        <MenuItem
                          id="duplicate"
                          leading={<Icon icon={CopyLinkIcon} />}
                        >
                          Duplicate
                        </MenuItem>
                        <MenuItem
                          description="Downloads a local copy"
                          id="export"
                          leading={<Icon icon={Download01Icon} />}
                        >
                          Export
                        </MenuItem>
                      </MenuSection>
                      <MenuSeparator />
                      <MenuItem id="delete" variant="danger">Delete</MenuItem>
                    </Menu>
                  </MenuTrigger>
                </div>
                <p>Open it near the stage edge to exercise collision handling and stacking.</p>
              </div>
              <div className="design-gallery__control-wrap">
                <DialogTrigger>
                  <Button variant="primary">Open dialog</Button>
                  <Modal
                    description="The heading and close action share one compact row while the body and footer keep a single inset owner."
                    footer={({ close }) => (
                      <div className="design-gallery__dialog-actions">
                        <Button onPress={close} variant="quiet">Cancel</Button>
                        <Button onPress={close} variant="primary">Save changes</Button>
                      </div>
                    )}
                    size="small"
                    title="Review changes before publishing"
                  >
                    <TextAreaField
                      label="Summary"
                      placeholder="Describe the change…"
                      textAreaProps={{ rows: 4 }}
                    />
                  </Modal>
                </DialogTrigger>
              </div>
            </div>
          </GallerySection>

          <GallerySection
            description="These fixtures deliberately combine long copy, uneven content, constrained columns, and action groups—the conditions that exposed the original regressions."
            eyebrow="08 · Stress cases"
            id="layouts"
            title="Responsive layouts"
          >
            <StructureNavigationFixtures />
            <StructuralSurfaceFixture />
            <div className="design-gallery__layout-fixtures">
              <Card className="design-gallery__fixture" data-fixture="compact-card">
                <p className="design-gallery__eyebrow">320 px safe</p>
                <h3>Long content cannot erase the inset</h3>
                <p>
                  extraordinarily-long-identifier-that-must-wrap-without-widening-the-document.example
                </p>
                <div className="design-gallery__dialog-actions">
                  <Button variant="quiet">Later</Button>
                  <Button variant="primary">Resolve</Button>
                </div>
              </Card>
              <Card className="design-gallery__fixture" data-fixture="split-row">
                <div>
                  <p className="design-gallery__eyebrow">Adaptive row</p>
                  <h3>Text and actions stack before they collide</h3>
                  <p>Metadata yields to the primary label and remains available in the menu.</p>
                </div>
                <IconButton aria-label="Row actions"><Icon icon={MoreHorizontalIcon} /></IconButton>
              </Card>
              <Card className="design-gallery__fixture" data-fixture="dense-statuses">
                <p className="design-gallery__eyebrow">Status wrap</p>
                <div className="design-gallery__status-wrap">
                  <Badge tone="success">Complete</Badge>
                  <Badge tone="warning">Needs reply</Badge>
                  <Badge tone="danger">Blocked</Badge>
                  <Badge>Draft</Badge>
                </div>
              </Card>
              <Card className="design-gallery__fixture" data-fixture="scroll-rail">
                <p className="design-gallery__eyebrow">Clipping stress</p>
                <h3>Scrollable Jelly cards keep their canvas gutter</h3>
                <p>The rail clips content deliberately while leaving each soft edge room to deform.</p>
                <div
                  aria-label="Scrollable card layout"
                  className="design-gallery__scroll-rail"
                  data-design-scroll-rail="true"
                  role="group"
                >
                  {['Queued', 'Reviewing', 'Ready'].map((label) => (
                    <PressableCard
                      aria-label={`${label} fixture`}
                      className="design-gallery__rail-card"
                      key={label}
                      onPress={() => undefined}
                      tone="quiet"
                    >
                      <strong>{label}</strong>
                      <span>Long secondary copy remains inside the rounded surface.</span>
                    </PressableCard>
                  ))}
                </div>
              </Card>
            </div>
          </GallerySection>

          <GallerySection
            description="Automated verification checks these claims at phone, tablet, desktop, coarse-pointer, reduced-motion, and forced-colors conditions."
            eyebrow="09 · Quality gate"
            id="accessibility"
            title="Interaction requirements"
          >
            <FeedbackCommunicationFixtures />
            <div className="design-gallery__requirements">
              {[
                ["Keyboard", "Logical Tab order, arrow-key collections, Escape dismissal, focus restoration."],
                ["Focus", "A visible focus indicator that is not clipped by the Jelly canvas."],
                ["Touch", "At least 44 × 44 CSS pixels, with the shared default remaining 48 × 48."],
                ["Contrast", "Readable text and state colors in light, dark, high-contrast, and disabled states."],
                ["Motion", "Reduced-motion disables decorative movement without removing state feedback."],
                ["Haptics", "Best-effort feedback after a real user action, never required to understand success."],
              ].map(([title, copy]) => (
                <Card className="design-gallery__requirement" key={title} tone="quiet">
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </Card>
              ))}
            </div>
          </GallerySection>
        </div>
      </div>
    </Root>
  );
}
