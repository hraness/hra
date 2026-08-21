import { describe, expect, test } from "bun:test";

import {
  appendVaryAccept,
  HTML_MEDIA_TYPE,
  MARKDOWN_MEDIA_TYPE,
  NOT_ACCEPTABLE_BODY,
  preferredPublicDocumentType,
} from "./accept-negotiation";

describe("public document Accept negotiation", () => {
  test("uses the acceptmarkdown.com ranking vectors", () => {
    expect(preferredPublicDocumentType("text/markdown")).toBe(MARKDOWN_MEDIA_TYPE);
    expect(preferredPublicDocumentType("text/markdown, text/html;q=0.8"))
      .toBe(MARKDOWN_MEDIA_TYPE);
    expect(preferredPublicDocumentType("text/html")).toBe(HTML_MEDIA_TYPE);
    expect(preferredPublicDocumentType("text/markdown;q=0, text/html"))
      .toBe(HTML_MEDIA_TYPE);
    expect(preferredPublicDocumentType("text/markdown;q=0")).toBeNull();
    expect(preferredPublicDocumentType(null)).toBe(HTML_MEDIA_TYPE);
    expect(preferredPublicDocumentType("")).toBe(HTML_MEDIA_TYPE);
    expect(preferredPublicDocumentType("*/*")).toBe(HTML_MEDIA_TYPE);
  });

  test("breaks equal quality by client order and specificity", () => {
    expect(preferredPublicDocumentType("text/markdown, text/html"))
      .toBe(MARKDOWN_MEDIA_TYPE);
    expect(preferredPublicDocumentType("text/html, text/markdown"))
      .toBe(HTML_MEDIA_TYPE);
    expect(preferredPublicDocumentType("text/html;q=0, */*;q=1"))
      .toBe(MARKDOWN_MEDIA_TYPE);
    expect(preferredPublicDocumentType("text/*;q=0.8, text/markdown"))
      .toBe(MARKDOWN_MEDIA_TYPE);
    expect(preferredPublicDocumentType("application/pdf")).toBeNull();
    expect(preferredPublicDocumentType("application/pdf, text/csv")).toBeNull();
  });

  test("does not substring-match a Chrome-style Accept list", () => {
    expect(preferredPublicDocumentType(
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    )).toBe(HTML_MEDIA_TYPE);
  });

  test("appends Accept to Vary without duplicating it", () => {
    const empty = new Headers();
    appendVaryAccept(empty);
    expect(empty.get("Vary")).toBe("Accept");

    const existing = new Headers({
      Vary: "rsc, next-router-state-tree",
    });
    appendVaryAccept(existing);
    expect(existing.get("Vary")).toBe("rsc, next-router-state-tree, Accept");
    appendVaryAccept(existing);
    expect(existing.get("Vary")).toBe("rsc, next-router-state-tree, Accept");
  });

  test("keeps a 406 body that lists the available representations", () => {
    expect(NOT_ACCEPTABLE_BODY).toContain("text/html");
    expect(NOT_ACCEPTABLE_BODY).toContain("text/markdown");
  });
});
