import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  HTML_MEDIA_TYPE,
  MARKDOWN_MEDIA_TYPE,
  preferredPublicDocumentType,
} from "./accept-negotiation";

const mediaType = fc.constantFrom(
  HTML_MEDIA_TYPE,
  MARKDOWN_MEDIA_TYPE,
  "application/pdf",
  "text/plain",
  "text/*",
  "*/*",
);
const quality = fc.float({
  max: 1,
  maxExcluded: false,
  min: 0,
  minExcluded: false,
  noNaN: true,
});

test("an explicit q=0 type is never selected over a positive alternative", () => {
  assertProperty(fc.property(quality, (htmlQuality) => {
    const header = `text/markdown;q=0, text/html;q=${htmlQuality}`;
    const preferred = preferredPublicDocumentType(header);
    if (htmlQuality <= 0) expect(preferred).toBeNull();
    else expect(preferred).toBe(HTML_MEDIA_TYPE);
  }));
});

test("a missing or wildcard-only Accept header never returns 406", () => {
  assertProperty(fc.property(
    fc.constantFrom(null, "", "*/*", "*/*;q=1", "text/*", "text/*;q=0.2"),
    (header) => {
      expect(preferredPublicDocumentType(header)).toBe(HTML_MEDIA_TYPE);
    },
  ));
});

test("produced types other than HTML and Markdown never win", () => {
  assertProperty(fc.property(
    fc.array(fc.tuple(mediaType, quality), { maxLength: 6 }),
    (entries) => {
      const header = entries
        .map(([type, q]) => `${type};q=${q}`)
        .join(", ");
      const preferred = preferredPublicDocumentType(header.length === 0 ? null : header);
      expect(
        preferred === null
        || preferred === HTML_MEDIA_TYPE
        || preferred === MARKDOWN_MEDIA_TYPE,
      ).toBeTrue();
    },
  ));
});
