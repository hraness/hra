import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InlineHelp } from "./inline-help";
import { Fader } from "./fader";
import { NumberField } from "./number-field";
import { SelectField } from "./select-field";
import { TextField } from "./text-field";

test("InlineHelp composes one named trigger with React Aria dialog state", async () => {
  const html = renderToStaticMarkup(
    <InlineHelp
      aria-label="About sale date"
      placement="bottom start"
      tooltip="Why this date matters"
      triggerClassName="product-help"
      defaultOpen
    >
      Use the date the sale proceeds become yours.
    </InlineHelp>,
  );

  expect(html).toContain("jungle-inline-help product-help");
  expect(html).toContain('aria-label="About sale date"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain('title="');

  const source = await Bun.file(new URL("./inline-help.tsx", import.meta.url)).text();
  expect(source).toContain('<div className="jungle-help-popover__content">{children}</div>');
});

test("field label accessories remain siblings of real visible labels", () => {
  const help = (name: string) => (
    <InlineHelp aria-label={`About ${name}`}>Supplementary explanation.</InlineHelp>
  );
  const text = renderToStaticMarkup(<TextField label="Name" labelAccessory={help("name")} />);
  const fader = renderToStaticMarkup(
    <Fader label="Growth" labelAccessory={help("growth")} showLabel value={5} />,
  );
  const select = renderToStaticMarkup(
    <SelectField
      label="Type"
      labelAccessory={help("type")}
      options={[{ id: "one", label: "One" }]}
    />,
  );

  expect(text).toMatch(
    /class="jungle-field__label-row">[\s\S]*?<label class="jungle-field__label"[^>]*>Name<\/label>[\s\S]*?jungle-field__label-accessory/u,
  );
  expect(fader).toMatch(
    /class="jungle-fader__label-row">[\s\S]*?<label class="jungle-fader__label"[^>]*>Growth<\/label>[\s\S]*?jungle-fader__label-accessory/u,
  );
  expect(select).toMatch(
    /class="jungle-select-field__label-row">[\s\S]*?<label class="jungle-select-field__label"[^>]*>Type<\/label>[\s\S]*?jungle-select-field__label-accessory/u,
  );
  expect(text).toContain('aria-label="About name"');
  expect(fader).toContain('aria-label="About growth"');
  expect(select).toContain('aria-label="About type"');
});

test("fields without accessories preserve their direct-label DOM contract", () => {
  const text = renderToStaticMarkup(<TextField label="Name" />);
  const number = renderToStaticMarkup(<NumberField label="Basis" value={100} />);
  const select = renderToStaticMarkup(
    <SelectField label="Type" options={[{ id: "one", label: "One" }]} />,
  );

  expect(text).toMatch(/class="jungle-field"[^>]*><label class="jungle-field__label"/u);
  expect(number).toMatch(
    /class="jungle-number-field"[^>]*><label class="jungle-number-field__label"/u,
  );
  expect(select).toMatch(
    /class="jungle-select-field"[^>]*><label class="jungle-select-field__label"/u,
  );
  expect(text).not.toContain("jungle-field__label-row");
  expect(number).not.toContain("jungle-number-field__label-row");
  expect(select).not.toContain("jungle-select-field__label-row");
});

test("hidden field labels do not strand visible label accessories", () => {
  const html = renderToStaticMarkup(
    <TextField
      label="Private label"
      labelAccessory={<InlineHelp aria-label="Stranded help">Help</InlineHelp>}
      showLabel={false}
    />,
  );

  expect(html).toContain('class="jungle-visually-hidden"');
  expect(html).not.toContain("jungle-field__label-row");
  expect(html).not.toContain("Stranded help");
});

test("number fields isolate label actions from increment and decrement slots", () => {
  const html = renderToStaticMarkup(
    <NumberField
      label="Basis"
      labelAccessory={<InlineHelp aria-label="About basis">Confirm the lot basis.</InlineHelp>}
      value={100}
    />,
  );

  expect(html).toContain('class="jungle-number-field__label-row"');
  expect(html).toContain('class="jungle-number-field__label"');
  expect(html).toContain('class="jungle-number-field__label-accessory"');
  expect(html).toContain('aria-label="About basis"');
  expect(html).toContain('aria-label="Increase value"');
  expect(html).toContain('aria-label="Decrease value"');
});

test("shared help CSS owns durable overlay and disabled checkbox cursor contracts", async () => {
  const componentsCss = await Bun.file(new URL("../components.css", import.meta.url)).text();
  const jellyCss = await Bun.file(new URL("../jelly.css", import.meta.url)).text();

  expect(componentsCss).toContain(".jungle-help-popover {");
  expect(componentsCss).toContain(".jungle-help-popover__dialog {");
  expect(componentsCss).toContain(".jungle-field__label-row,");
  expect(jellyCss).toContain("jelly-card.jungle-help-popover__surface {");
  expect(jellyCss).toMatch(
    /\.jungle-checkbox-field:has\(\.jungle-checkbox-field__input:disabled\)[\s\S]*?\.jungle-checkbox-field__control \{[\s\S]*?cursor: not-allowed;/u,
  );
});
