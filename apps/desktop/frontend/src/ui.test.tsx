import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Button,
  IconButton,
  NativeSelectField,
  SwitchField,
  TextAreaField,
  TextField,
  ToggleButton,
} from "./ui";

describe("HRA React Aria control adapter", () => {
  test("preserves action classes, state attributes, and focus while pending", () => {
    const button = renderToStaticMarkup(
      <Button
        controlClassName="save-control"
        isDisabled
        isPending
        size="compact"
        variant="primary"
      >
        Save
      </Button>,
    );
    expect(button).toContain('class="hraness-button"');
    expect(button).toContain('class="hraness-button__control save-control"');
    expect(button).toContain('data-pending="true"');
    expect(button).toContain('aria-busy="true"');
    expect(button).toContain('data-slot="action-spinner"');
    expect(button).not.toContain(" disabled");

    const icon = renderToStaticMarkup(
      <IconButton aria-label="Refresh" controlClassName="refresh-control">
        <span aria-hidden="true">↻</span>
      </IconButton>,
    );
    expect(icon).toContain('aria-label="Refresh"');
    expect(icon).toContain('class="hraness-icon-button__control refresh-control"');
    expect(icon).toContain('data-slot="icon-button-content"');

    const toggle = renderToStaticMarkup(
      <ToggleButton isSelected size="compact">Fast</ToggleButton>,
    );
    expect(toggle).toContain('class="hraness-toggle-button"');
    expect(toggle).toContain('aria-pressed="true"');
  });

  test("keeps field labels, control slots, descriptions, and validation connected", () => {
    const text = renderToStaticMarkup(
      <TextField description="Local label" label="Device" value="This Mac" />,
    );
    expect(text).toContain('data-slot="text-field"');
    expect(text).toContain('class="hraness-field__input"');
    expect(text).toContain("Device");
    expect(text).toContain("Local label");

    const area = renderToStaticMarkup(
      <TextAreaField label="Message" resize="none" showLabel={false} value="Hello" />,
    );
    expect(area).toContain('data-slot="text-area-field"');
    expect(area).toContain('class="hraness-field__label hraness-visually-hidden"');
    expect(area).toContain("<textarea");

    const select = renderToStaticMarkup(
      <NativeSelectField
        description="Bounded context"
        errorMessage="Choose a quota"
        id="quota"
        isInvalid
        label="Context quota"
        options={[{ id: "1", label: "1 MiB" }]}
        value="1"
      />,
    );
    expect(select).toContain('aria-describedby="quota-description quota-error"');
    expect(select).toContain('aria-invalid="true"');
    expect(select).toContain('data-slot="native-select-field"');
  });

  test("retains React Aria switch semantics and shared styling hooks", () => {
    const html = renderToStaticMarkup(
      <SwitchField
        description="Allow recursive work"
        isSelected
        label="Recursive sessions"
      />,
    );

    expect(html).toContain('class="hraness-switch-field"');
    expect(html).toContain('data-slot="switch-control"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('checked=""');
    expect(html).toContain("Recursive sessions");
  });
});
