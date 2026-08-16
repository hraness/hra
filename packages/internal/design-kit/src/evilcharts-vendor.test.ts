import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

const vendorRoot = new URL("../vendor/evilcharts/", import.meta.url);
const licenseHash = "7b6baf25f6caa0de061a2c99a47205d6651cdefc6e636910bc51bb3853ed056e";

test("the EvilCharts adaptation retains audited license and source provenance", async () => {
  const license = await Bun.file(new URL("LICENSE", vendorRoot)).arrayBuffer();
  const actual = createHash("sha256").update(new Uint8Array(license)).digest("hex");
  expect(actual).toBe(licenseHash);

  const provenance = await Bun.file(new URL("UPSTREAM.md", vendorRoot)).text();
  expect(provenance).toContain("https://evilcharts.com/docs");
  expect(provenance).toContain("fee646d585602a1c957df94697b35d9e94e16ac8");
  expect(provenance).toContain(licenseHash);
});
