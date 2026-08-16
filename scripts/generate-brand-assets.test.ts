import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import {
  checkPhoenixAssets,
  PHOENIX_LICENSE_PATH,
  PHOENIX_LICENSE_SHA256,
  PHOENIX_INSET,
  PHOENIX_SHARP_VERSION,
  PHOENIX_SOURCE_PATH,
  PHOENIX_SOURCE_SHA256,
  PHOENIX_SOURCE_PATH_UPSTREAM,
  PHOENIX_TARGETS,
  PHOENIX_UPSTREAM_COMMIT,
} from "./generate-brand-assets";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function read(repositoryPath: string): Promise<Uint8Array> {
  return Bun.file(new URL(`../${repositoryPath}`, import.meta.url)).arrayBuffer().then(
    (bytes) => new Uint8Array(bytes),
  );
}

describe("phoenix brand asset generator", () => {
  test("pins the supplied Noto source and license and validates generated RGB targets", async () => {
    expect(hash(await read(PHOENIX_SOURCE_PATH))).toBe(PHOENIX_SOURCE_SHA256);
    expect(hash(await read(PHOENIX_LICENSE_PATH))).toBe(PHOENIX_LICENSE_SHA256);
    const provenance = await Bun.file(
      new URL("../assets/brand/phoenix/PROVENANCE.md", import.meta.url),
    ).text();
    expect(provenance).toContain(`Commit: \`${PHOENIX_UPSTREAM_COMMIT}\``);
    expect(provenance).toContain(`Upstream path: \`${PHOENIX_SOURCE_PATH_UPSTREAM}\``);
    expect(provenance).toContain(`Source SHA-256: \`${PHOENIX_SOURCE_SHA256}\``);
    expect(provenance).toContain(`License SHA-256: \`${PHOENIX_LICENSE_SHA256}\``);
    expect(provenance).toContain(`sharp \`${PHOENIX_SHARP_VERSION}\``);
    expect(provenance).toContain(`${PHOENIX_INSET * 100}% inset`);
    expect(await checkPhoenixAssets()).toEqual([]);

    for (const target of PHOENIX_TARGETS) {
      const metadata = await sharp(await read(target.path)).metadata();
      expect(metadata).toMatchObject({
        channels: 3,
        format: "png",
        height: target.size,
        width: target.size,
      });
      expect(metadata.hasAlpha).toBe(false);
    }
  });
});
