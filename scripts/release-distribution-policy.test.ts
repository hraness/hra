import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  assertReleaseAssetBytes,
  parseGitHubRelease,
  parseNpmRelease,
} from "./release-distribution-policy";

const version = "1.2.3";
const tarball = Buffer.from("exact HRA tarball");
const tarballDigest = createHash("sha256").update(tarball).digest("hex");
const checksum = Buffer.from(`${tarballDigest}  hraness-hra-1.2.3.tgz\n`);
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const asset = (name: string, bytes: Uint8Array, id: number) => ({
  browser_download_url: `https://github.com/hraness/hra/releases/download/v1.2.3/${name}`,
  digest: `sha256:${digest(bytes)}`,
  id,
  name,
  size: bytes.byteLength,
  state: "uploaded",
});

describe("HRA public distribution policy", () => {
  test("requires npm trusted-publisher provenance", () => {
    const payload = {
      _npmUser: {
        email: "npm-oidc-no-reply@github.com",
        name: "GitHub Actions",
        trustedPublisher: { id: "github", oidcConfigId: "oidc:12345678-1234-1234-1234-123456789abc" },
      },
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: "https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2fhra@1.2.3",
        },
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        shasum: "b".repeat(40),
        tarball: "https://registry.npmjs.org/@hraness/hra/-/hra-1.2.3.tgz",
      },
      license: "MIT",
      name: "@hraness/hra",
      version,
    };
    expect(parseNpmRelease(payload, version).tarball).toEndWith("/hra-1.2.3.tgz");
    delete (payload._npmUser as { trustedPublisher?: unknown }).trustedPublisher;
    expect(() => parseNpmRelease(payload, version)).toThrow("trusted publisher");
  });

  test("requires exactly the immutable tarball and checksum bytes", () => {
    const coordinate = parseGitHubRelease({
      assets: [
        asset("hraness-hra-1.2.3.tgz", tarball, 1),
        asset("SHA256SUMS", checksum, 2),
      ],
      draft: false,
      immutable: true,
      prerelease: false,
      tag_name: "v1.2.3",
    }, version);
    expect(() => assertReleaseAssetBytes(coordinate, tarball, checksum, digest)).not.toThrow();
    expect(() => assertReleaseAssetBytes(coordinate, Buffer.from("changed"), checksum, digest))
      .toThrow("immutable metadata");
  });
});
