import { expect, test } from "bun:test"
import { inspectSiteCssResources } from "./site-css-resources.ts"

test("ordinary CSS inspection includes local custom-property textures and typed font/image URLs", () => {
  const source = '@font-face{font-family:f;src:url(./font.woff2)}.x{--field:url(./grain.svg),var(--fallback,url(./cells.svg));background:image-set("./one.png" 1x,url(./two.png) 2x)}'
  expect(inspectSiteCssResources(source, "fixture.css"))
    .toEqual(["./font.woff2", "./grain.svg", "./cells.svg", "./one.png", "./two.png"])
  expect(source).toContain("--field:url(./grain.svg)")
  expect(inspectSiteCssResources('.x{width:min(12rem,calc(100vw - 2rem));height:clamp(2rem,4vw,8rem)}', "fixture.css"))
    .toEqual([])
})

test("ordinary CSS inspection finds escaped and raw image-set URLs without treating content or MIME strings as requests", () => {
  expect(inspectSiteCssResources(String.raw`.x{--field:u\72l(https://example.test/a.svg);content:"url(not-a-request)"}`, "fixture.css"))
    .toEqual(["https://example.test/a.svg"])
  expect(inspectSiteCssResources('.x{--images:image-set("./one.avif" type("image/avif") 1x,url(./two.png) 2x)}', "fixture.css"))
    .toEqual(["./one.avif", "./two.png"])
  expect(inspectSiteCssResources(String.raw`.x{--images:IMAGE-SET("./upper.png" 1x);--escaped:i\6d age-set("./escaped.png" 1x)}`, "fixture.css"))
    .toEqual(["./upper.png", "./escaped.png"])
  expect(inspectSiteCssResources('.x{background-image:image-set("https://example.test/a.png" 1x)}', "fixture.css"))
    .toEqual(["https://example.test/a.png"])
})

test("ordinary CSS inspection rejects imports, malformed CSS, unsupported raw image functions and excessive resources", () => {
  expect(() => inspectSiteCssResources('@import "https://example.test/style.css";', "fixture.css")).toThrow("unresolved stylesheet import")
  expect(() => inspectSiteCssResources('.x{color:rgb( ;}', "fixture.css")).toThrow()
  expect(() => inspectSiteCssResources('.x{--image:image("https://example.test/a.png")}', "fixture.css")).toThrow("unsupported unparsed image")
  expect(() => inspectSiteCssResources(Array.from({ length: 65 }, (_, index) => `.x${index}{--image:url(./${index}.svg)}`).join(""), "fixture.css"))
    .toThrow("excessive resource")
})

test.each([
  '.x{--remote:"https://example.test/a.svg";background:image-set(var(--remote) 1x)}',
  '.x{--remote:"https://example.test/a.svg";--field:image-set(var(--remote) 1x);background:var(--field)}',
  '.x{--field:image-set(var(--remote,"https://example.test/a.svg") 1x);background:var(--field)}',
  '.x{--field:image-set(env(--remote) 1x);background:var(--field)}',
  '.x{--field:image-set(attr(data-image) 1x);background:var(--field)}',
  '.x{--field:image-set("./one.png" type(var(--mime)) 1x);background:var(--field)}',
])("ordinary CSS inspection rejects resource-producing substitutions: %s", source => {
  expect(() => inspectSiteCssResources(source, "fixture.css")).toThrow()
})
