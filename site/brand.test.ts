import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

describe("Oompa orange-circle mark", () => {
  test("uses an accessible name and self-contained circle geometry", async () => {
    const source = await readFile(new URL("./favicon.svg", import.meta.url), "utf8");
    const { document } = parseHTML(source);
    const svg = document.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 64 64");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Oompa");
    const circle = svg?.querySelector("circle");
    expect(svg?.children.length).toBe(1);
    expect(circle?.getAttribute("cx")).toBe("32");
    expect(circle?.getAttribute("cy")).toBe("32");
    expect(circle?.getAttribute("r")).toBe("27");
    expect(circle?.getAttribute("fill")).toBe("#f58220");
    expect(circle?.getAttribute("stroke")).toBe("#ad430d");
    expect(circle?.getAttribute("stroke-width")).toBe("2");
    // Geometry is local and static. No font, emoji renderer, external asset,
    // executable element or theme-specific background defines the mark.
    expect(document.querySelector("script, style, image, use, foreignObject, text, rect, path")).toBeNull();
    expect(source).not.toMatch(/(?:href|on\w+)\s*=|url\(/iu);
    expect(source).not.toMatch(/\bhra\b/iu);
  });
});
