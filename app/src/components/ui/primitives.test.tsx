import { expect, test } from "bun:test";
import * as stylex from "@stylexjs/stylex";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

import { staticStylexClassName } from "../../lib/cn";
import { Badge, type BadgeProps } from "./badge";
import { Button, type ButtonProps } from "./button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  type CardDescriptionProps,
  type CardProps,
  type CardTitleProps,
} from "./card";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "./dialog";
import { DropdownMenu } from "./dropdown-menu";
import { Input, type InputProps } from "./input";
import {
  badgeStyles,
  buttonStyles,
  cardStyles,
  dialogStyles,
  dropdownMenuStyles,
  fieldStyles,
  sheetStyles,
  switchStyles,
} from "./primitives.stylex";
import { Sheet } from "./sheet";
import { Switch } from "./switch";
import { Textarea, type TextareaProps } from "./textarea";

const consumerStyles = stylex.create({
  override: {
    color: "rebeccapurple",
    outlineColor: "orange",
  },
});

const typedBadge: BadgeProps = { tone: "accent", xstyle: consumerStyles.override };
const typedButton: ButtonProps = { xstyle: consumerStyles.override };
// @ts-expect-error Oompa primitive xstyle accepts compiled StyleX recipes, not raw CSS objects.
const rawButtonXstyle: ButtonProps = { xstyle: { color: "red" } };
// @ts-expect-error Oompa primitives never accept caller inline styles.
const inlineBadge: BadgeProps = { style: { color: "red" } };
// @ts-expect-error Oompa primitives never accept caller inline styles.
const inlineButton: ButtonProps = { style: { color: "red" } };
// @ts-expect-error Oompa primitives never accept caller inline styles.
const inlineCard: CardProps = { style: { color: "red" } };
// @ts-expect-error Oompa primitives never accept caller inline styles.
const inlineCardTitle: CardTitleProps = { style: { color: "red" } };
// @ts-expect-error Oompa primitives never accept caller inline styles.
const inlineCardDescription: CardDescriptionProps = { style: { color: "red" } };
// @ts-expect-error Oompa primitives never accept caller inline styles.
const inlineInput: InputProps = { style: { color: "red" } };
// @ts-expect-error Oompa primitives never accept caller inline styles.
const inlineTextarea: TextareaProps = { style: { color: "red" } };
void [
  inlineBadge,
  inlineButton,
  inlineCard,
  inlineCardDescription,
  inlineCardTitle,
  inlineInput,
  inlineTextarea,
  rawButtonXstyle,
  typedBadge,
  typedButton,
];

function openingTag(markup: string, name: string): string {
  const tag = markup.match(new RegExp(`<${name}[^>]*>`, "u"))?.[0];
  if (tag === undefined) throw new Error(`Missing ${name} opening tag`);
  return tag;
}

function expectedClassName(
  ...styles: readonly stylex.StaticStyles[]
): string {
  const className = stylex.props(...styles).className;
  if (className === undefined) throw new Error("Expected extracted StyleX classes");
  return className;
}

test("primitive xstyle composes after finite recipes and before the native class seam", () => {
  const badge = openingTag(renderToStaticMarkup(
    <Badge className="consumer-badge" tone="danger" xstyle={consumerStyles.override} />,
  ), "span");
  expect(badge).toContain(
    `class="${expectedClassName(
      badgeStyles.root,
      badgeStyles.danger,
      consumerStyles.override,
    )} consumer-badge"`,
  );
  expect(badge).not.toContain("xstyle=");
  expect(badge).not.toContain("style=");

  const button = openingTag(renderToStaticMarkup(
    <Button
      aria-label="Remove"
      className="consumer-button"
      disabled
      size="small"
      type="submit"
      variant="danger"
      xstyle={consumerStyles.override}
    />,
  ), "button");
  expect(button).toContain(
    `class="${expectedClassName(
      buttonStyles.root,
      buttonStyles.smallSize,
      buttonStyles.danger,
      consumerStyles.override,
    )} consumer-button"`,
  );
  expect(button).toContain('aria-label="Remove"');
  expect(button).toContain("disabled");
  expect(button).toContain('type="submit"');
  expect(button).not.toContain("style=");
});

test("card family preserves semantic elements, data, and caller-last classes", () => {
  const html = renderToStaticMarkup(
    <Card
      className="consumer-card"
      data-session-id="session-1"
      xstyle={consumerStyles.override}
    >
      <CardHeader className="consumer-header">
        <CardTitle className="consumer-title">Session</CardTitle>
        <CardDescription className="consumer-description">Ready</CardDescription>
      </CardHeader>
      <CardContent className="consumer-content">Transcript</CardContent>
      <CardFooter className="consumer-footer">Actions</CardFooter>
    </Card>,
  );

  expect(openingTag(html, "div")).toContain(
    `class="${expectedClassName(
      cardStyles.root,
      consumerStyles.override,
    )} consumer-card"`,
  );
  expect(html).toContain('data-session-id="session-1"');
  expect(html).toContain(
    `class="${expectedClassName(cardStyles.header)} consumer-header"`,
  );
  expect(html).toContain(
    `<h2 class="${expectedClassName(cardStyles.title)} consumer-title">Session</h2>`,
  );
  expect(html).toContain(
    `<p class="${expectedClassName(cardStyles.description)} consumer-description">Ready</p>`,
  );
  expect(html).toContain(
    `class="${expectedClassName(cardStyles.content)} consumer-content"`,
  );
  expect(html).toContain(
    `class="${expectedClassName(cardStyles.footer)} consumer-footer"`,
  );
  expect(html).not.toContain("style=");
});

test("native dialog and sheet keep labels, conditional children, sides, and backdrop recipes", () => {
  const dialog = renderToStaticMarkup(
    <Dialog
      className="consumer-dialog"
      label="Details"
      onClose={() => undefined}
      open
      xstyle={consumerStyles.override}
    >
      <DialogTitle>Details</DialogTitle>
      <DialogDescription>Description</DialogDescription>
      <DialogFooter>Done</DialogFooter>
    </Dialog>,
  );
  expect(openingTag(dialog, "dialog")).toContain(
    `class="${expectedClassName(
      dialogStyles.root,
      consumerStyles.override,
    )} consumer-dialog"`,
  );
  expect(dialog).toContain('aria-label="Details"');
  expect(dialog).toContain(
    `<h2 class="${expectedClassName(dialogStyles.title)}">Details</h2>`,
  );
  expect(dialog).toContain(
    `<p class="${expectedClassName(dialogStyles.description)}">Description</p>`,
  );
  expect(dialog).not.toContain("style=");

  const closed = renderToStaticMarkup(
    <Dialog label="Closed" onClose={() => undefined} open={false}>Hidden</Dialog>,
  );
  expect(closed).not.toContain("Hidden");

  const sheet = renderToStaticMarkup(
    <Sheet
      className="consumer-sheet"
      label="Navigation"
      onClose={() => undefined}
      open
      side="right"
      xstyle={consumerStyles.override}
    >
      Navigation
    </Sheet>,
  );
  expect(openingTag(sheet, "dialog")).toContain(
    `class="${expectedClassName(
      sheetStyles.root,
      sheetStyles.right,
      consumerStyles.override,
    )} consumer-sheet"`,
  );
  expect(sheet).toContain(">Navigation</dialog>");
  expect(sheet).not.toContain("style=");
});

test("fields and switch preserve native attributes and finite state recipes", () => {
  const input = openingTag(renderToStaticMarkup(
    <Input
      className="consumer-input"
      disabled
      name="query"
      placeholder="Search"
      xstyle={consumerStyles.override}
    />,
  ), "input");
  expect(input).toContain(
    `class="${expectedClassName(
      fieldStyles.input,
      consumerStyles.override,
    )} consumer-input"`,
  );
  expect(input).toContain('name="query"');
  expect(input).toContain('placeholder="Search"');
  expect(input).toContain("disabled");

  const textarea = openingTag(renderToStaticMarkup(
    <Textarea className="consumer-textarea" name="reply" rows={4} />,
  ), "textarea");
  expect(textarea).toContain(
    `class="${expectedClassName(fieldStyles.textarea)} consumer-textarea"`,
  );
  expect(textarea).toContain('name="reply"');
  expect(textarea).toContain('rows="4"');

  const switchMarkup = renderToStaticMarkup(
    <Switch
      checked
      className="consumer-switch"
      id="sync"
      label="Sync"
      onCheckedChange={() => undefined}
      xstyle={consumerStyles.override}
    />,
  );
  const switchTag = openingTag(switchMarkup, "button");
  expect(switchTag).toContain('aria-checked="true"');
  expect(switchTag).toContain('aria-label="Sync"');
  expect(switchTag).toContain('role="switch"');
  expect(switchTag).toContain(
    `class="${expectedClassName(
      switchStyles.root,
      switchStyles.checked,
      consumerStyles.override,
    )} consumer-switch"`,
  );
  expect(switchMarkup).toContain(
    `class="${expectedClassName(switchStyles.knob, switchStyles.knobChecked)}"`,
  );
  expect(`${input}${textarea}${switchMarkup}`).not.toContain("style=");
});

test("dropdown keeps the closed native menu contract and typed root override", () => {
  const html = renderToStaticMarkup(
    <DropdownMenu
      className="consumer-menu"
      items={[{ id: "remove", label: "Remove", onSelect: () => undefined, tone: "danger" }]}
      label="Session actions"
      trigger={<span>...</span>}
      xstyle={consumerStyles.override}
    />,
  );
  expect(openingTag(html, "div")).toContain(
    `class="${expectedClassName(
      dropdownMenuStyles.root,
      consumerStyles.override,
    )} consumer-menu"`,
  );
  const trigger = openingTag(html, "button");
  expect(trigger).toContain('aria-expanded="false"');
  expect(trigger).toContain('aria-haspopup="menu"');
  expect(trigger).toContain('aria-label="Session actions"');
  expect(trigger).toContain(`class="${expectedClassName(dropdownMenuStyles.trigger)}"`);
  expect(html).not.toContain('role="menu"');
  expect(html).not.toContain("style=");
});

test("class-only StyleX composition fails closed on a dynamic presentation", () => {
  expect(() => staticStylexClassName(
    { className: "x-static", style: { color: "red" } },
    "consumer",
  )).toThrow("Oompa primitives accept only extracted static StyleX styles.");
});

test("native primitive boundaries reject caller inline styles at runtime", () => {
  for (const [name, component] of [
    ["badge", Badge],
    ["button", Button],
    ["card", Card],
    ["card header", CardHeader],
    ["card title", CardTitle],
    ["card description", CardDescription],
    ["card content", CardContent],
    ["card footer", CardFooter],
    ["input", Input],
    ["textarea", Textarea],
  ] as const) {
    expect(
      () => { Reflect.apply(component, undefined, [{ style: { color: "red" } }]); },
      name,
    ).toThrow("Oompa primitives do not accept caller inline styles.");
  }
});

function uncompiledClassNames(source: string): readonly string[] {
  const file = ts.createSourceFile("primitive.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const invalid: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "className") {
      const initializer = node.initializer;
      const expression = initializer !== undefined && ts.isJsxExpression(initializer)
        ? initializer.expression : undefined;
      const composed = expression !== undefined && ts.isCallExpression(expression)
        && ts.isIdentifier(expression.expression)
        && expression.expression.text === "staticStylexClassName"
        && expression.arguments.length >= 1 && expression.arguments.length <= 2
        && expression.arguments.every((argument, index) => ts.isIdentifier(argument)
          && (index === 0 || argument.text === "className"));
      const extracted = expression !== undefined && ts.isPropertyAccessExpression(expression)
        && expression.name.text === "className"
        && ts.isCallExpression(expression.expression)
        && ts.isPropertyAccessExpression(expression.expression.expression)
        && ts.isIdentifier(expression.expression.expression.expression)
        && expression.expression.expression.expression.text === "stylex"
        && expression.expression.expression.name.text === "props";
      if (!composed && !extracted) invalid.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return invalid;
}

test("primitive class guard checks JSX presentation, not CSS value substrings", () => {
  expect(uncompiledClassNames(`
    const recipe = { transitionProperty: "color, border-color, text-decoration-color" };
    const first = <div className={staticStylexClassName(presentation, className)} />;
    const second = <div className={stylex.props(styles.root, active && styles.active).className} />;
  `)).toEqual([]);
  for (const attribute of [
    'className="p-4 text-sm"', 'className={"bg-red-500"}',
    'className={cn("flex gap-2")}', 'className={legacyClasses}',
    'className={staticStylexClassName(presentation, "border-2")}',
  ]) expect(uncompiledClassNames(`<div ${attribute} />`)).toEqual([attribute]);
});

test("owned primitives route every class attribute through compiled presentation", async () => {
  const directory = new URL("./", import.meta.url);
  const paths = [
    "badge.tsx",
    "button.tsx",
    "card.tsx",
    "dialog.tsx",
    "dropdown-menu.tsx",
    "input.tsx",
    "primitives.stylex.ts",
    "sheet.tsx",
    "switch.tsx",
    "textarea.tsx",
  ] as const;
  const sources = await Promise.all(paths.map((path) => Bun.file(new URL(path, directory)).text()));
  const globalCss = await Bun.file(new URL("../../index.css", directory)).text();
  const main = await Bun.file(new URL("../../main.tsx", directory)).text();

  for (const source of sources) {
    expect(uncompiledClassNames(source)).toEqual([]);
  }
  expect(globalCss).not.toContain('@import "tailwindcss"');
  expect(globalCss).not.toContain("@theme");
  expect(globalCss).not.toContain(".attention-glow");
  expect(globalCss).toContain("--color-accent: var(--primary)");
  expect(main).toContain('import "@hraness/design-kit/compiler-palettes.css"');
  expect(main).toContain('import "./index.css"');
  expect(main.indexOf('import "@hraness/design-kit/compiler-palettes.css"')).toBeLessThan(
    main.indexOf('import "./index.css"'),
  );
});

test("every primitive transition has a static reduced-motion branch", async () => {
  const source = await Bun.file(new URL("./primitives.stylex.ts", import.meta.url)).text();
  expect(source).toContain('const reducedMotion = "@media (prefers-reduced-motion: reduce)"');
  const durations = [...source.matchAll(/transitionDuration:\s*([^\n]+),/gu)].map((match) => match[1]);
  expect(durations).toHaveLength(3);
  expect(durations.every((value) => value === '{ default: "150ms", [reducedMotion]: "0s" }')).toBe(true);
});

test("primitive text and native date-time controls retain the removed preflight contract", async () => {
  const recipeSource = await Bun.file(new URL("./primitives.stylex.ts", import.meta.url)).text();
  const globalCss = await Bun.file(new URL("../../index.css", import.meta.url)).text();
  const cardSource = recipeSource.slice(
    recipeSource.indexOf("export const cardStyles"),
    recipeSource.indexOf("export const dialogStyles"),
  );
  const dialogSource = recipeSource.slice(
    recipeSource.indexOf("export const dialogStyles"),
    recipeSource.indexOf("export const dropdownMenuStyles"),
  );
  const branch = (source: string, name: string): string => {
    const body = source.match(new RegExp(`${name}:\\s*\\{([^}]*)\\}`, "u"))?.[1];
    if (body === undefined) throw new Error(`Missing ${name} primitive recipe`);
    return body;
  };
  const cardTitle = branch(cardSource, "title");
  const cardDescription = branch(cardSource, "description");
  const dialogTitle = branch(dialogSource, "title");
  const dialogDescription = branch(dialogSource, "description");

  for (const [name, source] of [
    ["card title", cardTitle], ["dialog title", dialogTitle],
  ] as const) {
    expect(source, name).toContain('fontFamily: "var(--font-sans)"');
    expect(source, name).toContain('overflowWrap: "normal"');
    for (const side of ["Bottom", "Left", "Right", "Top"]) {
      expect(source, `${name} margin${side}`).toContain(`margin${side}: 0`);
    }
  }
  for (const [name, source, marginTop] of [
    ["card description", cardDescription, "0"],
    ["dialog description", dialogDescription, '"0.25rem"'],
  ] as const) {
    expect(source, name).toContain('overflowWrap: "normal"');
    for (const side of ["Bottom", "Left", "Right"]) {
      expect(source, `${name} margin${side}`).toContain(`margin${side}: 0`);
    }
    expect(source, `${name} marginTop`).toContain(`marginTop: ${marginTop}`);
  }

  for (const block of [
    "::-webkit-date-and-time-value {\n    min-height: 1lh;\n    text-align: inherit;\n  }",
    "::-webkit-datetime-edit {\n    display: inline-flex;\n  }",
    "::-webkit-datetime-edit-fields-wrapper {\n    padding: 0;\n  }",
    "::-webkit-datetime-edit,\n  ::-webkit-datetime-edit-year-field,\n  ::-webkit-datetime-edit-month-field,\n  ::-webkit-datetime-edit-day-field,\n  ::-webkit-datetime-edit-hour-field,\n  ::-webkit-datetime-edit-minute-field,\n  ::-webkit-datetime-edit-second-field,\n  ::-webkit-datetime-edit-millisecond-field,\n  ::-webkit-datetime-edit-meridiem-field {\n    padding-block: 0;\n  }",
    "::-webkit-calendar-picker-indicator {\n    line-height: 1;\n  }",
    ":-moz-ui-invalid {\n    box-shadow: none;\n  }",
  ]) expect(globalCss).toContain(block);
  expect(globalCss).toContain(
    "line-height: 1.5;\n    tab-size: 4;\n    -webkit-tap-highlight-color: transparent;",
  );
  expect(globalCss).toContain(
    "@media (forced-colors: active) {\n    :focus-visible {\n      outline-color: Highlight;\n    }\n  }",
  );
});
