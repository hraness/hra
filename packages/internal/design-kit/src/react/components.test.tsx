import { expect, test } from "bun:test";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { Menu as AriaMenu } from "react-aria-components";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Accordion,
  AppShell,
  AuroraDotsBackground,
  Avatar,
  Badge,
  BottomBar,
  Breadcrumbs,
  Button,
  Card,
  ChatMessage,
  CheckboxField,
  DataTable,
  DitherSurface,
  DockedFooter,
  Disclosure,
  DialogTrigger,
  EmptyState,
  EmojiIcon,
  Fader,
  FileField,
  GlobalErrorDocument,
  Icon,
  IconButton,
  IconLink,
  InlineAlert,
  InlineHelp,
  KeyHint,
  ListBox,
  ListBoxItem,
  LinkButton,
  LinkCard,
  Menu,
  MenuItem,
  MenuTrigger,
  Modal,
  NavigationRail,
  NumberField,
  PageCanvas,
  PageIntro,
  ParticleHalo,
  Pagination,
  Progress,
  PressableCard,
  ProceduralBackdrop,
  ProductionDataPreviewNotice,
  RailItem,
  RailSection,
  RouteErrorPage,
  RouteLoadingPage,
  RouteNotFoundPage,
  SearchField,
  SelectField,
  SegmentedControl,
  SettingsCard,
  Skeleton,
  SkipLink,
  SplitButton,
  SplitButtonMenuTrigger,
  SplitButtonPrimary,
  Spinner,
  StatusDot,
  TabPanel,
  Tabs,
  TextAreaField,
  TextField,
  ThemedSurface,
  ToggleGroup,
  ToggleButton,
  Toolbar,
  TopBar,
  ViewportFrame,
  WrappingRow,
} from "./index";
import { dispatchButtonHaptic, resolveControlLabelStyle } from "./button";

test("production data Preview notice is gated by its build marker", () => {
  expect(renderToStaticMarkup(<ProductionDataPreviewNotice />)).toBe("");
  expect(renderToStaticMarkup(
    <ProductionDataPreviewNotice surfaceOrigin="" />,
  )).toBe("");

  const html = renderToStaticMarkup(
    <ProductionDataPreviewNotice
      surfaceOrigin="https://example-git-topic-team.vercel.app"
    />,
  );

  expect(html).toContain('class="jungle-production-data-preview-notice"');
  expect(html).toContain('role="alert"');
  expect(html).toContain('aria-label="Production data Preview warning"');
  expect(html).toContain("<strong>Production data Preview</strong>");
  expect(html).toContain(
    "This Preview uses production data. Actions are real and affect production.",
  );
  expect(html).not.toContain("example-git-topic-team.vercel.app");
});

function namedNumberSlotsInsideJellyCards(markup: string): string[] {
  // The pinned Jelly Card shadow tree exposes only a default slot. A named
  // light-DOM descendant under that host becomes unassigned after upgrade.
  const nestedSlots: string[] = [];
  let jellyCardDepth = 0;

  for (const match of markup.matchAll(
    /<\/?jelly-card\b[^>]*>|<[^>]*\bslot="(?:decrement|increment)"[^>]*>/g,
  )) {
    const tag = match[0];
    if (tag.startsWith("</jelly-card")) {
      jellyCardDepth = Math.max(0, jellyCardDepth - 1);
    } else if (tag.startsWith("<jelly-card")) {
      jellyCardDepth += 1;
    } else if (jellyCardDepth > 0) {
      const slot = /\bslot="([^"]+)"/.exec(tag)?.[1];
      if (slot !== undefined) nestedSlots.push(slot);
    }
  }

  return nestedSlots;
}

test("aurora dots render a decorative static grid before client enhancement", () => {
  const html = renderToStaticMarkup(<AuroraDotsBackground />);

  expect(html).toContain('class="jungle-aurora-background"');
  expect(html).toContain('class="jungle-aurora-dots"');
  expect(html).toContain("jungle-phaser-dots__static");
  expect(html).toContain("<canvas");
  expect(html).toContain('aria-hidden="true"');
});

test("procedural backdrops render deterministic decoration without replacing page semantics", () => {
  const html = renderToStaticMarkup(
    <ProceduralBackdrop
      palette={{
        highlight: "#f7d9a4",
        key: "#e98679",
        shadow: "#6d6175",
        support: "#70bbc4",
      }}
      seed="example.com"
      variation={2}
    />,
  );

  expect(html).toStartWith('<div aria-hidden="true"');
  expect(html).toContain('inert=""');
  expect(html).toContain('class="jungle-procedural-backdrop"');
  expect(html).toContain('data-recipe-version="1"');
  expect(html).toContain('data-variation="2"');
  expect(html).toContain('data-variant="composite"');
  expect(html.match(/jungle-procedural-backdrop__cloud/g)).toHaveLength(5);
  expect(html).toContain("jungle-procedural-backdrop__grid");
  expect(html.match(/jungle-procedural-backdrop__ripple"/g)).toHaveLength(4);
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain("<img");

  const grid = renderToStaticMarkup(
    <ProceduralBackdrop seed="catalog.example" variant="grid" />,
  );
  expect(grid).toContain("jungle-procedural-backdrop__grid");
  expect(grid).not.toContain("jungle-procedural-backdrop__cloud");
  expect(grid).not.toContain('jungle-procedural-backdrop__ripple"');
});

test("particle halos keep authored children visible outside decorative content", () => {
  const html = renderToStaticMarkup(
    <ParticleHalo seed="example.com">
      <strong>Semantic brand mark</strong>
    </ParticleHalo>,
  );

  expect(html).toStartWith('<div class="jungle-particle-halo"');
  expect(html.match(/aria-hidden="true"/g)).toHaveLength(1);
  expect(html).toContain('class="jungle-particle-halo__particles"');
  expect(html.match(/class="jungle-particle-halo__particle"/g)).toHaveLength(24);
  expect(html).toContain(
    '<div class="jungle-particle-halo__content"><strong>Semantic brand mark</strong></div>',
  );
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain("<img");
});

test("icons share a decorative current-color renderer with portable defaults", () => {
  const html = renderToStaticMarkup(<Icon icon={Search01Icon} />);

  expect(html).toContain("<svg");
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('class="hraness-icon jungle-icon"');
  expect(html).toContain('color="currentColor"');
  expect(html).toContain('width="20"');
  expect(html).toContain('stroke-width="1.5"');
});

test("emoji icons expose deterministic duotone and dominant-color treatments", () => {
  const source = {
    cellSize: 160,
    column: 2,
    pageHeight: 480,
    pageWidth: 640,
    row: 1,
    src: "/_emoji/apple-emoji.synthetic.webp",
  } as const;
  const duotone = renderToStaticMarkup(<EmojiIcon source={source} />);
  const dominant = renderToStaticMarkup(
    <EmojiIcon
      dominantColor="#CC41C3"
      label="DNA"
      source={source}
      variant="dominant-color-duotone"
    />,
  );

  expect(duotone).toContain('data-slot="emoji-icon"');
  expect(duotone).toContain('data-variant="duotone"');
  expect(duotone).toContain('aria-hidden="true"');
  expect(duotone).toContain('viewBox="0 0 160 160"');
  expect(duotone).toContain('<image aria-hidden="true"');
  expect(duotone).toContain('href="/_emoji/apple-emoji.synthetic.webp"');
  expect(duotone).toContain('height="480"');
  expect(duotone).toContain('width="640"');
  expect(duotone).toContain('x="-320"');
  expect(duotone).toContain('y="-160"');
  expect(duotone.match(/<image\b/gu)).toHaveLength(1);
  expect(duotone).not.toContain("<text");
  expect(duotone).not.toContain("Apple Color Emoji");
  expect(duotone).toContain('tableValues="0.521569 0.949020"');
  expect(duotone).toContain('tableValues="0.537255 0.949020"');
  expect(duotone).toContain('tableValues="0.509804 0.929412"');
  expect(dominant).toContain('data-variant="dominant-color-duotone"');
  expect(dominant).toContain('aria-label="DNA"');
  expect(dominant).toContain('role="img"');
  expect(dominant).toContain('tableValues="0.521569 0.800000"');
  expect(dominant).toContain('tableValues="0.537255 0.254902"');
  expect(dominant).toContain('tableValues="0.509804 0.764706"');
});

test("emoji icons reject malformed colors, labels, URLs, coordinates, and sizes", () => {
  const source = {
    cellSize: 160,
    column: 0,
    pageHeight: 320,
    pageWidth: 320,
    row: 0,
    src: "/_emoji/apple-emoji.synthetic.webp",
  } as const;
  expect(() => renderToStaticMarkup(
    <EmojiIcon
      dominantColor="#cc41c3"
      source={source}
      variant="dominant-color-duotone"
    />,
  )).toThrow("uppercase six-digit hex");
  expect(() => renderToStaticMarkup(<EmojiIcon label=" " source={source} />)).toThrow(
    "labels must be nonempty",
  );
  expect(() => renderToStaticMarkup(<EmojiIcon size={0} source={source} />)).toThrow(
    "positive finite number",
  );

  for (const src of [
    "",
    "apple-emoji.webp",
    "//assets.example/apple-emoji.webp",
    "https://assets.example/apple-emoji.webp",
    "data:text/plain;base64,SGVsbG8=",
  ]) {
    expect(() => renderToStaticMarkup(
      <EmojiIcon source={{ ...source, src }} />,
    )).toThrow(/source src/u);
  }

  for (const invalidSource of [
    { ...source, column: -1 },
    { ...source, row: 0.5 },
    { ...source, cellSize: 0 },
    { ...source, pageWidth: 159 },
    { ...source, pageHeight: 159 },
    { ...source, column: 2 },
    { ...source, row: 2 },
  ]) {
    expect(() => renderToStaticMarkup(<EmojiIcon source={invalidSource} />)).toThrow(
      /EmojiIcon source/u,
    );
  }
});

test("emoji icon CSS crops sprites without platform emoji-font dependencies", async () => {
  const css = await Bun.file(new URL("../components.css", import.meta.url)).text();

  expect(css).toContain(".jungle-emoji-icon {");
  expect(css).toContain("overflow: hidden;");
  expect(css).not.toContain("Apple Color Emoji");
  expect(css).not.toContain("Segoe UI Emoji");
  expect(css).not.toContain("Noto Color Emoji");
  expect(css).not.toContain(".jungle-emoji-icon text");
});

test("status recipes expose presentation tones without product-domain states", () => {
  const html = renderToStaticMarkup(
    <Badge isLive tone="warning"><StatusDot tone="warning" />Connecting</Badge>,
  );

  expect(html).toContain('class="jungle-badge"');
  expect(html).toContain('class="jungle-status-dot"');
  expect(html.match(/data-tone="warning"/g)).toHaveLength(2);
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('role="status"');
  expect(html).toContain('live=""');
  expect(html).not.toContain("waiting");
  expect(html).not.toContain("blocked");
});

test("buttons preserve native semantics while exposing React Aria state recipes", () => {
  const html = renderToStaticMarkup(
    <Button
      aria-label="Create account"
      className="account-action-surface"
      controlClassName="account-action-control"
      isDisabled
      variant="primary"
    >
      Create account
    </Button>,
  );

  expect(html).toContain("<button");
  expect(html).toContain('aria-label="Create account"');
  expect(html).toContain("<jelly-card");
  expect(html).toContain("jungle-jelly-surface jungle-button account-action-surface");
  expect(html).toContain('class="jungle-button__control account-action-control"');
  expect(html).toContain('disabled=""');
  expect(html).toContain('data-disabled="true"');
  expect(html).toContain('data-tone="primary"');
  expect(html).toContain('data-variant="primary"');

  const pending = renderToStaticMarkup(<Button isPending>Saving</Button>);
  expect(pending).toContain('aria-busy="true"');
  expect(pending.match(/<button\b[^>]*>/u)?.[0]).toContain('aria-busy="true"');
  expect(pending).toContain('data-pending="true"');
  expect(pending).toContain('class="jungle-button__leading"');
  expect(pending).toContain('class="jungle-spinner jungle-button__spinner"');
  expect(pending).toContain('class="jungle-button__label">Saving</span>');
  expect(pending).not.toContain("data-pending-leading-empty");
  expect(pending).not.toContain("jungle-button__trailing");

  const pendingAndDisabled = renderToStaticMarkup(<Button isDisabled isPending>Saving</Button>);
  expect(pendingAndDisabled).toContain('aria-disabled="true"');
  expect(pendingAndDisabled).toContain('data-pending="true"');
  expect(pendingAndDisabled).not.toContain('disabled=""');
  expect(pendingAndDisabled).not.toContain('data-disabled="true"');

  const pendingReady = renderToStaticMarkup(<Button isPending={false}>Saving</Button>);
  const pendingReadyHost = pendingReady.match(/<jelly-card\b[^>]*>/u)?.[0];
  const pendingReadyControl = pendingReady.match(/<button\b[^>]*>/u)?.[0];
  expect(pendingReady).not.toContain('aria-busy="true"');
  expect(pendingReadyHost).toBeDefined();
  expect(pendingReadyControl).toBeDefined();
  expect(pendingReadyHost ?? "").not.toContain("data-pending-leading-empty");
  expect(pendingReadyControl ?? "").toContain('data-pending-leading-empty="true"');
  expect(pendingReady).toContain('class="jungle-button__leading"></span>');
  expect(pendingReady).toContain('class="jungle-button__label">Saving</span>');
  expect(pendingReady).not.toContain("jungle-button__trailing");
  expect(pendingReady).not.toContain("jungle-button__spinner");

  const glyph = renderToStaticMarkup(
    <Button aria-label="Open mixer channel" size="compact">M</Button>,
  );
  expect(glyph).toContain('data-label-style="glyph"');
  expect(glyph).toContain('data-glyph-only="true"');
  expect(glyph).toContain(">M</button>");
  const textOverride = renderToStaticMarkup(<Button labelStyle="text">A</Button>);
  expect(textOverride).toContain('data-label-style="text"');
  const toggleGlyph = renderToStaticMarkup(
    <ToggleButton aria-label="Select channel">T</ToggleButton>,
  );
  expect(toggleGlyph).toContain('data-label-style="glyph"');
  expect(toggleGlyph).toContain('data-glyph-only="true"');
  const largeIconToggle = renderToStaticMarkup(
    <ToggleButton aria-label="Loop" isIconOnly size="large">
      <Icon icon={Search01Icon} />
    </ToggleButton>,
  );
  expect(largeIconToggle).toContain('data-icon-only="true"');
  expect(largeIconToggle).toContain('data-size="large"');

  const pendingIcon = renderToStaticMarkup(
    <IconButton aria-label="Refresh" isPending><Icon icon={Search01Icon} /></IconButton>,
  );
  expect(pendingIcon).toContain('aria-busy="true"');
  expect(pendingIcon.match(/<button\b[^>]*>/u)?.[0]).toContain('aria-busy="true"');
  expect(pendingIcon).toContain('data-tone="quiet"');
  expect(pendingIcon).toContain('data-variant="quiet"');
  expect(pendingIcon).toContain("jungle-icon-button__spinner");

  const pendingAndDisabledIcon = renderToStaticMarkup(
    <IconButton aria-label="Refresh" isDisabled isPending><Icon icon={Search01Icon} /></IconButton>,
  );
  expect(pendingAndDisabledIcon).toContain('aria-disabled="true"');
  expect(pendingAndDisabledIcon).toContain('data-pending="true"');
  expect(pendingAndDisabledIcon).not.toContain('disabled=""');
  expect(pendingAndDisabledIcon).not.toContain('data-disabled="true"');

  const busyIcon = renderToStaticMarkup(
    <IconButton aria-busy aria-label="Refresh"><Icon icon={Search01Icon} /></IconButton>,
  );
  expect(busyIcon).toContain('aria-busy="true"');
  expect(busyIcon.match(/<button\b[^>]*>/u)?.[0]).toContain('aria-busy="true"');
  expect(busyIcon).not.toContain("jungle-icon-button__spinner");
  expect(busyIcon).not.toContain('data-pending="true"');

  const largeIcon = renderToStaticMarkup(
    <IconButton aria-label="Large search" size="large" variant="secondary">
      <Icon icon={Search01Icon} />
    </IconButton>,
  );
  expect(largeIcon).toContain('data-size="large"');
  expect(largeIcon).toContain('data-tone="neutral"');
  expect(largeIcon).toContain('data-variant="secondary"');
  const staticIcon = renderToStaticMarkup(
    <IconButton
      aria-label="Static repeated action"
      isDisabled
      size="compact"
      surfaceMotion="static"
    >
      <Icon icon={Search01Icon} />
    </IconButton>,
  );
  expect(staticIcon).toContain("<button");
  expect(staticIcon).toContain('aria-label="Static repeated action"');
  expect(staticIcon).toContain('data-surface-motion="static"');
  expect(staticIcon).toContain('data-size="compact"');
  expect(staticIcon).toContain('data-variant="quiet"');
  expect(staticIcon).toContain('disabled=""');
  expect(staticIcon).not.toContain("<jelly-card");
  const largeIconLink = renderToStaticMarkup(
    <IconLink aria-label="Large destination" href="#destination" size="large">
      <Icon icon={Search01Icon} />
    </IconLink>,
  );
  expect(largeIconLink).toContain('data-size="large"');

  const slotted = renderToStaticMarkup(
    <>
      <Button slot="close">Close</Button>
      <IconButton aria-label="Close" slot="close"><Icon icon={Search01Icon} /></IconButton>
      <ToggleButton slot="selection">Select</ToggleButton>
    </>,
  );
  expect(slotted.match(/slot="(?:close|selection)"/gu)).toHaveLength(3);
});

test("split buttons give both segments one shared size and visual variant", () => {
  const html = renderToStaticMarkup(
    <SplitButton
      aria-label="Publish actions"
      className="publish-actions"
      size="compact"
      variant="primary"
    >
      <SplitButtonPrimary className="publish-now">Publish</SplitButtonPrimary>
      <SplitButtonMenuTrigger
        aria-label="More publish options"
        className="publish-menu"
        menu={(
          <Menu aria-label="Publish options">
            <MenuItem id="schedule">Schedule</MenuItem>
          </Menu>
        )}
      >
        <Icon icon={Search01Icon} />
      </SplitButtonMenuTrigger>
    </SplitButton>,
  );

  expect(html).toContain('class="jungle-split-button publish-actions"');
  expect(html).toContain('role="group"');
  expect(html).toContain('aria-label="Publish actions"');
  expect(html).toContain("jungle-split-button__primary publish-now");
  expect(html).toContain("jungle-split-button__menu publish-menu");
  expect(html.match(/data-size="compact"/gu)).toHaveLength(3);
  expect(html.match(/data-variant="primary"/gu)).toHaveLength(3);
  expect(html.match(/data-tone="primary"/gu)).toHaveLength(2);
  expect(html).not.toContain('data-variant="quiet"');
  expect(html).toContain('data-split-button-segment="primary"');
  expect(html).toContain('data-split-button-segment="menu"');
  expect(html).toContain('aria-haspopup="true"');

  expect(() => renderToStaticMarkup(
    <SplitButton aria-label="Invalid split action">
      <SplitButtonPrimary>First</SplitButtonPrimary>
      <SplitButtonPrimary>Second</SplitButtonPrimary>
    </SplitButton>,
  )).toThrow("SplitButton requires SplitButtonPrimary followed by SplitButtonMenuTrigger.");
});

test("single-character command labels use icon-scale typography unless explicitly overridden", () => {
  for (const glyph of ["A", "?", "+", 1]) {
    expect(resolveControlLabelStyle(glyph, undefined)).toBe("glyph");
  }
  expect(resolveControlLabelStyle("Aa", undefined)).toBe("text");
  expect(resolveControlLabelStyle(<span>A</span>, undefined)).toBe("text");
  expect(resolveControlLabelStyle("A", "text")).toBe("text");
  expect(resolveControlLabelStyle("Save", "glyph")).toBe("glyph");
});

test("button haptics dispatch only for an enabled completed semantic press", () => {
  const feedback: string[] = [];
  const trigger = (value: "error" | "press" | "selection" | "success" | "warning") => {
    feedback.push(value);
    return Promise.resolve(true);
  };

  expect(dispatchButtonHaptic({
    feedback: "selection",
    isDisabled: false,
    isPending: false,
    trigger,
  })).toBeTrue();
  expect(dispatchButtonHaptic({
    feedback: "press",
    isDisabled: true,
    isPending: false,
    trigger,
  })).toBeFalse();
  expect(dispatchButtonHaptic({
    feedback: "success",
    isDisabled: false,
    isPending: true,
    trigger,
  })).toBeFalse();
  expect(dispatchButtonHaptic({
    feedback: undefined,
    isDisabled: false,
    isPending: false,
    trigger,
  })).toBeFalse();
  expect(feedback).toEqual(["selection"]);
});

test("toolbars and toggle buttons expose labelled command navigation semantics", () => {
  const html = renderToStaticMarkup(
    <Toolbar aria-label="Loop transport">
      <Button>Play</Button>
      <ToggleButton
        className="loop-surface"
        controlClassName="loop-control"
        isSelected
      >Loop</ToggleButton>
      <IconButton
        aria-label="Close transport"
        className="close-surface"
        controlClassName="close-control"
      >×</IconButton>
    </Toolbar>,
  );

  expect(html).toContain('role="toolbar"');
  expect(html).toContain('aria-label="Loop transport"');
  expect(html).toContain("jungle-button jungle-toggle-button loop-surface");
  expect(html).toContain('class="jungle-button__control jungle-toggle-button loop-control"');
  expect(html).toContain("jungle-icon-button close-surface");
  expect(html).toContain('class="jungle-icon-button__control close-control"');
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('data-selected="true"');
});

test("faders expose labelled scalar ranges in both orientations", () => {
  const html = renderToStaticMarkup(
    <Fader
      formatOptions={{ style: "unit", unit: "percent" }}
      label="Master volume"
      maxValue={100}
      minValue={0}
      showOutput
      step={5}
      value={75}
    />,
  );

  expect(html).toContain('class="jungle-fader"');
  expect(html).toContain('data-density="default"');
  expect(html).toContain('data-orientation="vertical"');
  expect(html).toContain('type="range"');
  expect(html).toContain('aria-orientation="vertical"');
  expect(html).toContain('min="0"');
  expect(html).toContain('max="100"');
  expect(html).toContain('value="75"');
  expect(html).toContain('aria-valuetext="75%"');
  expect(html).toContain("Master volume");
  expect(html).toContain(">75%</output>");

  const minimum = renderToStaticMarkup(
    <Fader density="compact" label="Minimum" maxValue={100} minValue={0} value={0} />,
  );
  const maximum = renderToStaticMarkup(
    <Fader density="compact" label="Maximum" maxValue={100} minValue={0} value={100} />,
  );

  expect(minimum).toContain(
    'top:100%;transform:translate(-50%, -50%)',
  );
  expect(maximum).toContain(
    'top:0%;transform:translate(-50%, -50%)',
  );

  const horizontal = renderToStaticMarkup(
    <Fader
      density="compact"
      label="Tone"
      maxValue={100}
      minValue={0}
      orientation="horizontal"
      value={58}
    />,
  );

  expect(horizontal).toContain('data-orientation="horizontal"');
  expect(horizontal).toContain('data-density="compact"');
  expect(horizontal).toContain('aria-orientation="horizontal"');
  expect(horizontal).toContain('value="58"');
  expect(horizontal).toContain('transform:translate(-50%, -50%)');
  expect(horizontal).toContain("Tone");
});

test("search owns a labelled search input and keyboard-reachable clear action", () => {
  const html = renderToStaticMarkup(
    <SearchField defaultValue="codex" label="Search accounts" />,
  );

  expect(html).toContain("Search accounts");
  expect(html).toContain("<jelly-card");
  expect(html).toContain('type="search"');
  expect(html).toContain('aria-label="Clear search"');
});

test("text fields associate labels, descriptions, and validation messages", () => {
  const input = renderToStaticMarkup(
    <TextField
      description="Use the address where orders should arrive."
      errorMessage="Enter a valid email address."
      inputAttributes={{
        autoCapitalize: "none",
        inputMode: "numeric",
        max: 10,
        min: 0,
        spellCheck: false,
        step: 1,
      }}
      isInvalid
      label="Email"
      labelAccessory={(
        <InlineHelp aria-label="About email addresses">
          Use an inbox you check regularly.
        </InlineHelp>
      )}
      placeholder="you@example.com"
      type="email"
    />,
  );
  const textarea = renderToStaticMarkup(
    <TextAreaField
      label="Description"
      textAreaProps={{ maxLength: 280, minLength: 12, rows: 4 }}
    />,
  );

  expect(input).toContain("Email");
  expect(input).toContain('class="jungle-field__label-row"');
  expect(input).toMatch(
    /class="jungle-field__label"[^>]*>Email<\/label>[\s\S]*aria-label="About email addresses"/u,
  );
  expect(input).toContain('aria-expanded="false"');
  expect(input).toContain("jungle-field__surface");
  expect(input).toContain('type="email"');
  expect(input).toContain('aria-describedby="');
  expect(input).toContain('aria-invalid="true"');
  expect(input).toContain('autoCapitalize="none"');
  expect(input).toContain('inputMode="numeric"');
  expect(input).toContain('max="10"');
  expect(input).toContain('min="0"');
  expect(input).toContain('step="1"');
  expect(input).toContain('spellCheck="false"');
  expect(textarea).toContain("<textarea");
  expect(textarea).toContain("Description");
  expect(textarea).toContain('data-resize="none"');
  expect(textarea).toContain('maxLength="280"');
  expect(textarea).toContain('minLength="12"');
  expect(renderToStaticMarkup(
    <TextAreaField label="Notes" resize="vertical" />,
  )).toContain('data-resize="vertical"');
});

test("checkbox and select supporting copy use descriptions instead of inflating names", () => {
  const checkbox = renderToStaticMarkup(
    <CheckboxField
      aria-describedby="external-checkbox-help"
      description="Only completion events are sent."
      label="Send updates"
    />,
  );
  const select = renderToStaticMarkup(
    <SelectField
      aria-describedby="external-select-help"
      description="Controls visual density."
      errorMessage="Choose an available density."
      isInvalid
      label="Density"
      options={[{ id: "compact", label: "Compact" }]}
    />,
  );

  expect(checkbox).toMatch(/aria-describedby="external-checkbox-help [^"]+-description"/u);
  expect(checkbox).toMatch(/aria-labelledby="[^"]+-label"/u);
  expect(checkbox).toMatch(/class="jungle-checkbox-field__label" id="[^"]+-label">Send updates/u);
  expect(checkbox).toMatch(/class="jungle-checkbox-field__description" id="[^"]+-description"/u);
  expect(checkbox).toMatch(
    /<label class="jungle-checkbox-field__control">[\s\S]*class="jungle-checkbox-field__description"[\s\S]*<\/label>/u,
  );
  expect(checkbox).toContain('class="jungle-checkbox-field__copy"');
  expect(select).toMatch(
    /aria-describedby="external-select-help [^"]+-description [^"]+-error"/u,
  );
  expect(select).toContain('aria-invalid="true"');
  expect(select).toContain('data-invalid="true"');
});

test("select fields expose every public size, surface, and disabled state to CSS", () => {
  const html = renderToStaticMarkup(
    <>
      <SelectField
        label="Compact card"
        options={[{ id: "one", label: "One" }]}
        size="compact"
        surface="card"
        value="one"
      />
      <SelectField
        isInvalid
        label="Default invalid"
        options={[{ id: "one", label: "One" }]}
        size="default"
        surface="default"
      />
      <SelectField
        disabled
        label="Large pane"
        options={[{ id: "one", label: "A deliberately long option label" }]}
        size="large"
        surface="pane"
        value="one"
      />
    </>,
  );

  expect(html).toContain('data-size="compact" data-surface="card"');
  expect(html).toContain('data-invalid="true" data-size="default" data-surface="default"');
  expect(html).toContain('data-size="large" data-surface="pane"');
  expect(html).toContain('disabled=""');
  expect(html).toContain("A deliberately long option label");
});

test("select fields preserve specific ARIA invalid tokens and paint them as invalid", () => {
  const html = renderToStaticMarkup(
    <>
      <SelectField
        aria-invalid="grammar"
        label="Grammar-aware selection"
        options={[{ id: "one", label: "One" }]}
      />
      <SelectField
        aria-invalid="spelling"
        isInvalid={false}
        label="Spelling-aware selection"
        options={[{ id: "two", label: "Two" }]}
      />
      <SelectField
        aria-invalid="false"
        isInvalid
        label="Explicit invalid selection"
        options={[{ id: "three", label: "Three" }]}
      />
    </>,
  );

  expect(html).toContain('aria-invalid="grammar"');
  expect(html).toContain('aria-invalid="spelling"');
  expect(html.match(/data-invalid="true"/gu)).toHaveLength(3);
  expect(html.match(/aria-invalid="true"/gu)).toHaveLength(1);
});

test("number fields expose typing, arrow-key, and labelled stepper semantics", () => {
  const html = renderToStaticMarkup(
    <NumberField label="Quantity" maxValue={25} minValue={1} value={3} />,
  );

  expect(html).toContain('aria-roledescription="Number field"');
  expect(html).toContain("jungle-number-field__control");
  expect(html).toContain('inputMode="numeric"');
  expect(html).toContain('aria-label="Decrease value"');
  expect(html).toContain('aria-label="Increase value"');
  expect(html).toContain('slot="decrement"');
  expect(html).toContain('slot="increment"');
});

test("number field named slots remain composed after Jelly upgrades", () => {
  const html = renderToStaticMarkup(
    <NumberField label="Quantity" maxValue={25} minValue={1} value={3} />,
  );

  expect(html.match(/<jelly-card\b/g)).toHaveLength(1);
  expect(html).toMatch(/<button\b[^>]*\bslot="decrement"/);
  expect(html).toMatch(/<button\b[^>]*\bslot="increment"/);
  expect(html).toContain("jungle-number-field__surface");
  expect(html).toContain('aria-hidden="true"');
  expect(namedNumberSlotsInsideJellyCards(html)).toEqual([]);
});

test("skip links point keyboard users at a named page landmark", () => {
  const html = renderToStaticMarkup(<SkipLink />);

  expect(html).toContain('class="jungle-skip-link"');
  expect(html).toContain('href="#main-content"');
  expect(html).toContain("Skip to main content");
});

test("tabs and segmented controls render controlled composite semantics", () => {
  const tabs = renderToStaticMarkup(
    <Tabs
      aria-label="Account sections"
      items={[
        { id: "account", label: "Account" },
        { id: "usage", label: "Usage" },
      ]}
      onChange={() => undefined}
      value="account"
    >
      <TabPanel id="account">Account details</TabPanel>
      <TabPanel id="usage">Usage details</TabPanel>
    </Tabs>,
  );
  const segmented = renderToStaticMarkup(
    <SegmentedControl
      aria-label="Runtime mode"
      className="runtime-mode-control"
      items={[
        { id: "normal", label: "Normal" },
        { id: "fast", label: "Fast" },
      ]}
      onChange={() => undefined}
      surfaceClassName="runtime-mode-surface"
      value="normal"
    />,
  );

  expect(tabs).toContain('role="tablist"');
  expect(tabs).toContain("jungle-tabs__surface");
  expect(tabs).toContain('role="tab"');
  expect(tabs).toContain('aria-selected="true"');
  expect(segmented).toContain('role="radiogroup"');
  expect(segmented).toContain("jungle-segmented-control__surface");
  expect(segmented).toContain("runtime-mode-surface");
  expect(segmented).toContain("jungle-segmented-control runtime-mode-control");
  expect(segmented).toContain('type="radio"');
  expect(segmented).toContain('checked=""');
  expect(segmented).toContain('aria-label="Runtime mode"');
});

test("selection composites and faders expose representative disabled semantics", () => {
  const html = renderToStaticMarkup(
    <>
      <SegmentedControl
        aria-label="Disabled density"
        isDisabled
        items={[{ id: "compact", label: "Compact" }]}
        onChange={() => undefined}
        size="compact"
        value="compact"
      />
      <ToggleGroup
        aria-label="Disabled view"
        isDisabled
        items={[{ id: "canvas", label: "Canvas" }]}
        onChange={() => undefined}
        value="canvas"
      />
      <Tabs
        aria-label="Partially disabled tabs"
        items={[
          { id: "current", label: "Current" },
          { id: "disabled", isDisabled: true, label: "Disabled" },
        ]}
        onChange={() => undefined}
        size="compact"
        value="current"
      >
        <TabPanel id="current">Current panel</TabPanel>
        <TabPanel id="disabled">Disabled panel</TabPanel>
      </Tabs>
      <ListBox aria-label="Availability" selectionMode="single">
        <ListBoxItem id="available">Available</ListBoxItem>
        <ListBoxItem isDisabled id="unavailable">Unavailable</ListBoxItem>
      </ListBox>
      <Fader
        defaultValue={42}
        isDisabled
        label="Disabled output"
        maxValue={100}
        minValue={0}
      />
    </>,
  );

  expect(html).toContain('aria-label="Disabled density"');
  expect(html).toContain('data-size="compact"');
  expect(html).toContain('aria-label="Disabled view"');
  expect(html).toContain('aria-label="Partially disabled tabs"');
  expect(html).toContain('aria-label="Availability"');
  expect(html).toContain("Disabled output");
  expect(html.match(/data-disabled="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
});

test("segmented controls normalize stale values to a reachable owned option", () => {
  const html = renderToStaticMarkup(
    <SegmentedControl
      aria-label="Runtime mode"
      items={[
        { id: "normal", label: "Normal" },
        { id: "fast", label: "Fast" },
      ]}
      onChange={() => undefined}
      value="foreign"
    />,
  );

  expect(html).toContain('tabindex="0"');
  expect(html).toContain('checked=""');
  expect(html).toContain('value="normal"');
});

test("the listbox renders interactive collection semantics for short client-owned lists", () => {
  const html = renderToStaticMarkup(
    <ListBox aria-label="Codex accounts" selectionMode="single">
      <ListBoxItem id="personal">Personal</ListBoxItem>
      <ListBoxItem id="work">Work</ListBoxItem>
    </ListBox>,
  );

  expect(html).toContain('role="listbox"');
  expect(html).toContain('role="option"');
  expect(html).toContain("Personal");
  expect(html).toContain("Work");
});

test("menu and dialog triggers compose with shared React Aria pressables", () => {
  const menu = renderToStaticMarkup(
    <MenuTrigger defaultOpen>
      <Button>Account actions</Button>
      <Menu aria-label="Account actions" footer={<p>Changes save automatically.</p>}>
        <MenuItem description="Permanently deletes this account." id="remove" variant="danger">
          Remove account
        </MenuItem>
      </Menu>
    </MenuTrigger>,
  );
  const dialog = renderToStaticMarkup(
    <DialogTrigger>
      <Button>Open settings</Button>
      <Modal isCloseDisabled title="Settings">Settings body</Modal>
    </DialogTrigger>,
  );
  const menuItem = renderToStaticMarkup(
    <AriaMenu aria-label="Account actions">
      <MenuItem id="open" leading={<span aria-hidden="true">↗</span>}>
        Open account
      </MenuItem>
      <MenuItem description="Permanently deletes this account." id="remove" variant="danger">
        Remove account
      </MenuItem>
    </AriaMenu>,
  );

  expect(menu).toContain("Account actions");
  expect(menuItem).toContain("Permanently deletes this account.");
  expect(menuItem).toContain('class="jungle-menu__leading"');
  expect(menuItem.match(/data-has-description="true"/gu)).toHaveLength(1);
  expect(menuItem).toMatch(
    /class="jungle-menu__leading"[\s\S]*?class="jungle-menu__copy"/u,
  );
  expect(menuItem).toContain('class="jungle-menu__description"');
  expect(dialog).toContain("Open settings");
});

test("modal headings and close actions share one owned header row", async () => {
  const source = await Bun.file(new URL("./modal.tsx", import.meta.url)).text();

  expect(source).toMatch(
    /<header className="jungle-modal__header">[\s\S]*?<div className="jungle-modal__heading">[\s\S]*?<\/div>[\s\S]*?<IconButton[\s\S]*?className="jungle-modal__close"[\s\S]*?<\/IconButton>[\s\S]*?<\/header>/u,
  );
  expect(source).not.toMatch(
    /<IconButton[\s\S]*?className="jungle-modal__close"[\s\S]*?<\/IconButton>\s*<header className="jungle-modal__header">/u,
  );
});

test("gap primitives keep native semantics on Jelly surfaces", () => {
  const html = renderToStaticMarkup(
    <>
      <LinkButton href="/account" variant="primary">Account</LinkButton>
      <SelectField
        label="Status"
        options={[
          { id: "open", label: "Open" },
          { id: "done", label: "Done" },
        ]}
        value="open"
      />
      <CheckboxField defaultChecked label="Unread only" name="unread" />
      <FileField
        accept="image/png"
        aria-describedby="artwork-policy"
        description="PNG only"
        id="artwork"
        label="Artwork"
      />
    </>,
  );

  expect(html).toContain('href="/account"');
  expect(html).toContain("<select");
  expect(html).toContain('type="checkbox"');
  expect(html).toContain('type="file"');
  expect(html).toContain('aria-describedby="artwork-policy artwork-description"');
  expect(html).toContain('id="artwork-description"');
  expect(html.match(/<jelly-card/g)).toHaveLength(4);
});

test("cards and disclosures expose stable server markup before Jelly upgrades", () => {
  const html = renderToStaticMarkup(
    <>
      <Card><p>Surface content</p></Card>
      <Disclosure defaultOpen title="Details"><p>Disclosure content</p></Disclosure>
      <Disclosure
        title={<><span aria-hidden="true">Aa</span><span className="jungle-visually-hidden">Text size</span></>}
        tooltip="Text size"
      >
        <p>Text controls</p>
      </Disclosure>
    </>,
  );

  expect(html).toContain("<jelly-card");
  expect(html).toContain("<details");
  expect(html).toContain("<summary");
  expect(html).toContain('open=""');
  expect(html).toContain("Disclosure content");
  expect(html).toContain("Text size");
  expect(html).not.toContain('title="Text size"');
});

test("disclosures expose compact, default, and large recipes with stable open states", () => {
  const html = renderToStaticMarkup(
    <>
      <Disclosure defaultOpen size="compact" title="Compact details">Compact body</Disclosure>
      <Disclosure size="default" title="Default details">Default body</Disclosure>
      <Disclosure
        defaultOpen
        size="large"
        title="A deliberately long disclosure title that must wrap safely"
      >
        Long body
      </Disclosure>
    </>,
  );

  expect(html).toContain('data-open="true" data-shape="rounded" data-size="compact"');
  expect(html).toContain('data-size="default"');
  expect(html).toContain('data-open="true" data-shape="rounded" data-size="large"');
  expect(html.match(/open=""/g)).toHaveLength(2);
  expect(html).toContain("A deliberately long disclosure title that must wrap safely");
});

test("a disabled action does not disable its containing passive Card", () => {
  const html = renderToStaticMarkup(
    <Card><Button isDisabled>Unavailable action</Button></Card>,
  );
  const hosts = [...html.matchAll(/<jelly-card\b[^>]*>/g)].map(([host]) => host);

  expect(hosts).toHaveLength(2);
  expect(hosts[0]).not.toContain("data-disabled");
  expect(hosts[1]).toContain('data-disabled="true"');
});

test("toggle groups render an optional single selection with owned keys", () => {
  const selected = renderToStaticMarkup(
    <ToggleGroup
      aria-label="Visible providers"
      className="provider-control"
      items={[
        { id: "anthropic", label: "Anthropic" },
        { id: "openai", label: "OpenAI" },
      ]}
      onChange={() => undefined}
      surfaceClassName="provider-surface"
      value="openai"
    />,
  );
  const empty = renderToStaticMarkup(
    <ToggleGroup
      aria-label="Visible providers"
      items={[
        { id: "anthropic", label: "Anthropic" },
        { id: "openai", label: "OpenAI" },
      ]}
      onChange={() => undefined}
      value="foreign"
    />,
  );

  expect(selected).toContain('role="radiogroup"');
  expect(selected).toContain('aria-checked="true"');
  expect(selected).toContain('aria-label="Visible providers"');
  expect(selected).toContain("jungle-toggle-group__surface provider-surface");
  expect(selected).toContain("jungle-toggle-group provider-control");
  expect(empty).not.toContain('aria-checked="true"');
});

test("page, feedback, and settings primitives keep semantic server markup", () => {
  const html = renderToStaticMarkup(
    <PageCanvas>
      <PageIntro
        actions={<Button>Invite</Button>}
        description="Manage the workspace without leaving this page."
        eyebrow="Workspace"
        title="Settings"
      />
      <InlineAlert isLive title="Saved" tone="success">Preferences are current.</InlineAlert>
      <SettingsCard actions={<Button>Change</Button>} description="Shared across devices." title="Profile">
        Account controls
      </SettingsCard>
      <EmptyState action={<Button>Create one</Button>} title="No projects" />
      <KeyHint>⌘K</KeyHint>
      <Spinner label="Loading projects" />
      <Skeleton isText width="12rem" />
      <Progress label="Import" showValue value={42} />
    </PageCanvas>,
  );

  expect(html).toContain("jungle-page-canvas");
  expect(html).toContain("jungle-page-intro");
  expect(html).toContain('data-tone="success"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("jungle-settings-card");
  expect(html).toContain("jungle-empty-state");
  expect(html).toContain("<kbd");
  expect(html).toContain('role="status"');
  expect(html).toContain("<progress");
  expect(html).toContain('value="42"');
});

test("structural surfaces opt into rectangular geometry and edge-owned insets", () => {
  const html = renderToStaticMarkup(
    <>
      <ViewportFrame as="main">
        <WrappingRow as="header">
          <span>Long responsive content</span>
          <span>Available action</span>
        </WrappingRow>
      </ViewportFrame>
      <PageCanvas inset="none" size="full">
        <ThemedSurface shape="rectangular">Workspace</ThemedSurface>
        <Card shape="rectangular">Section</Card>
        <PressableCard shape="rectangular">Action row</PressableCard>
        <LinkCard href="/details" shape="rectangular">Link row</LinkCard>
        <Disclosure shape="rectangular" title="Details">Disclosure body</Disclosure>
        <SettingsCard shape="rectangular" title="Settings">Settings body</SettingsCard>
      </PageCanvas>
      <DockedFooter
        contentClassName="product-dock-content"
        density="compact"
        inset="none"
        position="absolute"
        size="full"
        surface="glass"
      >
        Transport
      </DockedFooter>
    </>,
  );

  expect(html).toContain('<main class="jungle-viewport-frame">');
  expect(html).toContain('<header class="jungle-wrapping-row">');
  expect(html).toContain('class="jungle-page-canvas" data-inset="none" data-size="full"');
  expect(html.match(/data-shape="rectangular"/gu)).toHaveLength(6);
  expect(html).toContain(
    'class="jungle-docked-footer" data-position="absolute" data-surface="glass"',
  );
  expect(html).toContain(
    'class="jungle-docked-footer__content product-dock-content" data-density="compact" data-inset="none" data-size="full"',
  );
});

test("structural surface CSS keeps chrome flush while content owns safe-area insets", async () => {
  const resetCss = await Bun.file(new URL("../reset.css", import.meta.url)).text();
  const jellyCss = await Bun.file(new URL("../jelly.css", import.meta.url)).text();
  const zov2Css = await Bun.file(new URL("../zov2.css", import.meta.url)).text();

  expect(zov2Css).toMatch(
    /\.jungle-viewport-frame\s*\{[^}]*inline-size:\s*100%;[^}]*min-inline-size:\s*0;[^}]*block-size:\s*100vh;[^}]*block-size:\s*100svh;[^}]*block-size:\s*100dvh;[^}]*min-block-size:\s*0;[^}]*overflow:\s*clip;/su,
  );
  expect(zov2Css).toMatch(
    /\.jungle-wrapping-row\s*\{[^}]*min-inline-size:\s*0;[^}]*max-inline-size:\s*100%;[^}]*flex-wrap:\s*wrap;[^}]*overflow-wrap:\s*anywhere;/su,
  );
  expect(zov2Css).toMatch(
    /\.jungle-wrapping-row > \*\s*\{[^}]*min-inline-size:\s*0;[^}]*max-inline-size:\s*100%;/su,
  );
  expect(resetCss).toMatch(
    /:where\(\s*blockquote,[\s\S]*?p\s*\)\s*\{[^}]*overflow-wrap:\s*anywhere;/u,
  );
  expect(resetCss).toMatch(
    /:where\(canvas, img, picture, svg, video\)\s*\{[^}]*max-inline-size:\s*100%;/su,
  );
  expect(zov2Css).toMatch(
    /\.jungle-button\.jungle-toggle-button:has\(\s*>\s*\.jungle-button__control\.jungle-toggle-button\[data-selected\]\s*\)\s*\{[^}]*--jelly-fill:\s*var\(--primary\);[^}]*--jelly-label:\s*var\(--primary-foreground\);[^}]*color:\s*var\(--primary-foreground\);/su,
  );
  expect(zov2Css).toMatch(
    /\.jungle-themed-surface\[data-shape="rectangular"\]\s*\{[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/su,
  );
  expect(zov2Css.indexOf('.jungle-themed-surface[data-shape="rectangular"]')).toBeGreaterThan(
    zov2Css.indexOf('.jungle-themed-surface[data-tone="popover"]'),
  );
  expect(zov2Css).toMatch(
    /\.jungle-page-canvas:where\(\[data-inset="none"\]\)\s*\{\s*--jungle-page-canvas-inset:\s*0px;\s*\}/u,
  );
  expect(zov2Css).toMatch(
    /\.jungle-docked-footer\s*\{[^}]*right:\s*0;[^}]*bottom:\s*0;[^}]*left:\s*0;[^}]*border-top:\s*1px solid var\(--line\);[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;/su,
  );
  expect(zov2Css).toMatch(
    /\.jungle-docked-footer__content\s*\{[^}]*padding:\s*var\(--layout-chrome-inset\);[^}]*padding-right:\s*max\(var\(--layout-chrome-inset\), env\(safe-area-inset-right\)\);[^}]*padding-bottom:\s*max\(var\(--layout-chrome-inset\), env\(safe-area-inset-bottom\)\);[^}]*padding-left:\s*max\(var\(--layout-chrome-inset\), env\(safe-area-inset-left\)\);/su,
  );
  expect(zov2Css).toMatch(
    /\.jungle-docked-footer__content\[data-density="compact"\] :is\([\s\S]*?\.jungle-pressable[\s\S]*?\):is\(\[data-focus-visible\], :focus-visible\)\s*\{[^}]*outline-offset:\s*-3px;[^}]*box-shadow:\s*none;/u,
  );
  expect(jellyCss).toMatch(
    /jelly-card\.jungle-card\[data-shape="rectangular"\],[\s\S]*?--jelly-radius:\s*1px;[\s\S]*?border-radius:\s*0;[\s\S]*?box-shadow:\s*none;/u,
  );
  expect(jellyCss).toMatch(
    /\.jungle-link-card\[data-shape="rectangular"\] \.jungle-link-card__control,[\s\S]*?border-radius:\s*0;/u,
  );
  expect(jellyCss).toMatch(
    /\.jungle-pressable-card\[data-shape="rectangular"\][\s\S]*?\.jungle-pressable-card__control:is\(\[data-focus-visible\], :focus-visible\),[\s\S]*?\.jungle-link-card\[data-shape="rectangular"\][\s\S]*?\.jungle-link-card__control:is\(\[data-focus-visible\], :focus-visible\)\s*\{[^}]*outline-offset:\s*-2px;/u,
  );
  expect(jellyCss).toMatch(
    /\.jungle-disclosure\[data-shape="rectangular"\][\s\S]*?\.jungle-disclosure__summary:focus-visible\s*\{[^}]*outline-offset:\s*-2px;/u,
  );
});

test("live alerts use urgency-appropriate semantics and preserve explicit roles", () => {
  const danger = renderToStaticMarkup(
    <InlineAlert isLive tone="danger">The save failed.</InlineAlert>,
  );
  const explicit = renderToStaticMarkup(
    <InlineAlert aria-live="assertive" role="alert">Review required.</InlineAlert>,
  );
  const explicitLive = renderToStaticMarkup(
    <InlineAlert aria-live="polite" isLive role="status" tone="danger">
      A background retry failed.
    </InlineAlert>,
  );

  expect(danger).toContain('aria-live="assertive"');
  expect(danger).toContain('role="alert"');
  expect(explicit).toContain('aria-live="assertive"');
  expect(explicit).toContain('role="alert"');
  expect(explicitLive).toContain('aria-live="polite"');
  expect(explicitLive).toContain('role="status"');
});

test("route fallbacks share branded recovery and loading semantics", () => {
  const notFound = renderToStaticMarkup(<RouteNotFoundPage />);
  const selectableNotFound = renderToStaticMarkup(
    <RouteNotFoundPage showThemeToggle />,
  );
  const error = renderToStaticMarkup(
    <RouteErrorPage error={new Error("fixture failure")} reset={() => undefined} />,
  );
  const loading = renderToStaticMarkup(<RouteLoadingPage />);
  const shellNotFound = renderToStaticMarkup(
    <RouteNotFoundPage canvasAs="div" showThemeToggle={false} />,
  );
  const shellError = renderToStaticMarkup(
    <RouteErrorPage
      canvasAs="div"
      error={new Error("shell fixture failure")}
      reset={() => undefined}
      showThemeToggle={false}
    />,
  );
  const shellLoading = renderToStaticMarkup(<RouteLoadingPage canvasAs="div" />);
  const silentError = renderToStaticMarkup(
    <RouteErrorPage
      announce={false}
      autoFocus={false}
      canvasAs="div"
      error={new Error("inert fixture failure")}
      reset={() => undefined}
      showThemeToggle={false}
      titleAs="h4"
    />,
  );
  const silentLoading = renderToStaticMarkup(
    <RouteLoadingPage announce={false} canvasAs="div" />,
  );
  const nestedNotFound = renderToStaticMarkup(
    <RouteNotFoundPage canvasAs="div" showThemeToggle={false} titleAs="h4" />,
  );
  const globalError = renderToStaticMarkup(
    <GlobalErrorDocument error={new Error("global fixture failure")} reset={() => undefined} />,
  );
  const fixedGlobalError = renderToStaticMarkup(
    <GlobalErrorDocument
      bodyClassName="fixture-product-theme"
      error={new Error("fixed global fixture failure")}
      reset={() => undefined}
      theme="dark"
    />,
  );

  expect(notFound).toContain("Page not found");
  expect(notFound.match(/<h1(?:\s|>)/g)).toHaveLength(1);
  expect(notFound).toContain('href="/"');
  expect(notFound).not.toContain("data-hraness-appearance-menu");
  expect(selectableNotFound).toContain('<header class="jungle-route-state__header">');
  expect(selectableNotFound).toContain('aria-label="Appearance: System"');
  expect(error).toContain("This view could not load");
  expect(error.match(/<h1(?:\s|>)/g)).toHaveLength(1);
  expect(error).toContain("Try again");
  expect(error).toContain('aria-live="assertive"');
  expect(error).toContain('tabindex="-1"');
  expect(error).not.toContain("Your work is safe");
  expect(loading).toContain('aria-busy="true"');
  expect(loading.match(/role="status"/g)).toHaveLength(1);
  expect(loading.match(/Loading page/g)).toHaveLength(1);
  expect(silentError).toContain("<h4");
  expect(silentError).not.toContain("aria-live");
  expect(silentLoading).not.toContain("aria-busy");
  expect(silentLoading).not.toContain('role="status"');
  expect(nestedNotFound).toContain("<h4");
  expect(globalError.match(/<h1(?:\s|>)/g)).toHaveLength(1);
  expect(globalError).toContain('data-theme="light"');
  expect(globalError).toContain('data-jungle-theme-guard=""');
  expect(globalError).toContain("jungle-design-theme-v1");
  expect(globalError).not.toContain("data-hraness-appearance-menu");
  expect(fixedGlobalError).toContain('data-theme="dark"');
  expect(fixedGlobalError).toContain('<body class="fixture-product-theme">');
  expect(fixedGlobalError).not.toContain('data-jungle-theme-guard=""');
  for (const shellFallback of [shellNotFound, shellError, shellLoading]) {
    expect(shellFallback).not.toContain("<main");
    expect(shellFallback).not.toContain("data-hraness-appearance-menu");
  }
});

test("navigation and data primitives expose landmarks, current state, and table structure", () => {
  const html = renderToStaticMarkup(
    <>
      <Breadcrumbs items={[
        { href: "/", id: "home", label: "Home" },
        { id: "settings", label: "Settings" },
      ]} />
      <Pagination currentPage={3} hrefForPage={(page) => `/page/${String(page)}`} totalPages={8} />
      <Avatar name="Ada Lovelace" />
      <DataTable
        columns={[
          { cell: (row) => row.name, header: "Name", id: "name" },
          { align: "end", cell: (row) => row.status, header: "Status", id: "status" },
        ]}
        getRowId={(row) => row.id}
        rows={[{ id: "ada", name: "Ada", status: "Ready" }]}
      />
      <Accordion items={[{ content: "Account details", defaultExpanded: true, id: "account", title: "Account" }]} />
    </>,
  );

  expect(html).toContain('aria-label="Breadcrumbs"');
  expect(html.match(/aria-current="page"/g)).toHaveLength(2);
  expect(html).toContain('href="/page/4"');
  expect(html).toContain(">AL</span>");
  expect(html).toContain("<table");
  expect(html).toContain('scope="col"');
  expect(html).toContain('data-align="end"');
  expect(html).toContain("<details");
  expect(html).toContain('open=""');
});

test("pagination boundaries are inert elements instead of keyboard-active disabled links", () => {
  const first = renderToStaticMarkup(
    <Pagination currentPage={1} hrefForPage={(page) => `/page/${String(page)}`} totalPages={3} />,
  );
  const last = renderToStaticMarkup(
    <Pagination currentPage={3} hrefForPage={(page) => `/page/${String(page)}`} totalPages={3} />,
  );

  expect(first).toContain('<span aria-disabled="true" class="jungle-pagination__boundary" data-direction="previous">Previous</span>');
  expect(first).not.toContain('href="/page/1" rel="prev"');
  expect(last).toContain('<span aria-disabled="true" class="jungle-pagination__boundary" data-direction="next">Next</span>');
  expect(last).not.toContain('href="/page/3" rel="next"');
});

test("progress associates rich visible labels with the native control", () => {
  const html = renderToStaticMarkup(
    <Progress label={<><strong>Indexing</strong> sources</>} value={25} />,
  );
  const labelledBy = /<progress aria-labelledby="([^"]+)"/u.exec(html)?.[1];

  expect(labelledBy).toBeDefined();
  expect(html).toContain(`id="${labelledBy ?? "missing"}"`);
  expect(html).toContain("<strong>Indexing</strong> sources");
});

test("the shared shell composes persistent rail, bars, surfaces, and chat roles", () => {
  const rail = (
    <NavigationRail header="HRA">
      <RailSection title="Workspace">
        <RailItem href="/inbox" isActive label="Inbox" />
      </RailSection>
    </NavigationRail>
  );
  const html = renderToStaticMarkup(
    <AppShell
      bottomBar={<BottomBar actions={<Button>Save</Button>}>Draft</BottomBar>}
      rail={rail}
      topBar={<TopBar actions={<Button>Share</Button>} title="Project" />}
    >
      <ThemedSurface><DitherSurface tone="accent">Preview</DitherSurface></ThemedSurface>
      <ChatMessage name="Codex" role="assistant">Ready when you are.</ChatMessage>
    </AppShell>,
  );

  expect(html).toContain("jungle-app-shell");
  expect(html).toContain('aria-label="Primary navigation"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain("jungle-top-bar__actions");
  expect(html).toContain("jungle-bottom-bar__actions");
  expect(html).toContain('data-density="medium"');
  expect(html).toContain('data-role="assistant"');
});

test("top bars opt into sticky site chrome without changing the default", () => {
  const sticky = renderToStaticMarkup(
    <TopBar position="sticky" surface="glass" title="Article" />,
  );
  const ordinary = renderToStaticMarkup(<TopBar title="Workspace" />);

  expect(sticky).toContain('data-position="sticky"');
  expect(sticky).toContain('data-surface="glass"');
  expect(ordinary).toContain('data-position="static"');
  expect(ordinary).toContain('data-surface="solid"');
});
