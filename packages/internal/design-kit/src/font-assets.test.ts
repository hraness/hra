import { expect, test } from "bun:test";

type FontAssetFixture = Readonly<{
  artifact: string;
  bytes: number;
  sha256: string;
  license: string;
  licenseSha256: string;
  provenance: string;
  provenanceFacts: readonly string[];
}>;

const fixtures: readonly FontAssetFixture[] = [
  {
    artifact: "./fonts/geist/Geist[wght].ttf",
    bytes: 169_056,
    sha256: "73894e0448cae90a92b6c2f8732b7bb9acb7b94c418bff559dad4a18e1de9659",
    license: "./fonts/geist/OFL.txt",
    licenseSha256: "1781d2806a07d91c4edf4740b88449fab7d0eadad53f7c351b94cd4d4eb8c00f",
    provenance: "./fonts/geist/PROVENANCE.md",
    provenanceFacts: [
      "352f6b7d9d6cc4fa9e242b931291d31b21a6dc84",
      "ofl/geist/Geist[wght].ttf",
      "Version: 1.800",
      "Artifact bytes: 169056",
    ],
  },
  {
    artifact: "./fonts/geist-mono/GeistMono[wght].woff2",
    bytes: 71_596,
    sha256: "afaacc4c5fbba89d2ebf7a02dc4070208540874592a5504d57175782fe893101",
    license: "./fonts/geist-mono/OFL.txt",
    licenseSha256: "942560b236adfa83745b2c64e5fc09ebaf91cb331751b1157eb92187e5d6e930",
    provenance: "./fonts/geist-mono/PROVENANCE.md",
    provenanceFacts: [
      "10dc7658f13c38a474cde201bb09a4617267545b",
      "fonts/GeistMono/webfonts/GeistMono[wght].woff2",
    ],
  },
];

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

test("Geist assets retain exact pinned bytes, OFL licenses, and provenance", async () => {
  for (const fixture of fixtures) {
    const artifactBytes = new Uint8Array(
      await Bun.file(new URL(fixture.artifact, import.meta.url)).arrayBuffer(),
    );
    const licenseBytes = new Uint8Array(
      await Bun.file(new URL(fixture.license, import.meta.url)).arrayBuffer(),
    );
    const provenance = await Bun.file(
      new URL(fixture.provenance, import.meta.url),
    ).text();

    expect(artifactBytes.byteLength).toBe(fixture.bytes);
    expect(sha256(artifactBytes)).toBe(fixture.sha256);
    expect(sha256(licenseBytes)).toBe(fixture.licenseSha256);
    expect(provenance).toContain(fixture.sha256);
    expect(provenance).toContain(fixture.licenseSha256);
    for (const fact of fixture.provenanceFacts) expect(provenance).toContain(fact);
  }
});
