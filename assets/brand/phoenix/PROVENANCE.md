# Phoenix brand asset provenance

The HRA phoenix is the Unicode `🐦‍🔥` sequence (`U+1F426 U+200D U+1F525`) rendered from the open-licensed Noto Emoji source below.

- Repository: `googlefonts/noto-emoji`
- Commit: `8998f5dd683424a73e2314a8c1f1e359c19e8742`
- Upstream path: `svg/emoji_u1f426_200d_1f525.svg`
- Vendored source: `emoji_u1f426_200d_1f525.svg`
- Source SHA-256: `823a9add5f88eb5e92582855698ab55ce5f9e96aa29523d7aac799b1ef1ca629`
- License: Apache-2.0
- Vendored license: `LICENSE`
- License SHA-256: `611ceab36dae96644ca84e8ace6873821790192bf6f73b0d0624a21b24b4b332`

The product icons are deterministic RGB PNGs rendered by `scripts/generate-brand-assets.ts` with sharp `0.35.3`. Each square canvas uses an opaque black background. The source SVG is rendered into a centered square with an 8% inset on every side, then flattened to RGB. The checked targets are 1024×1024 for the desktop icon, 512×512 for the web icon, and 180×180 for the Apple touch icon.

- `apps/desktop/assets/icon.png` SHA-256: `451bf4681fe1ac0b1210e0d53668d13ea47405df41f29bb8998e40fa401e8320`
- `apps/web/app/icon.png` SHA-256: `17f58b8c253691f5302d5a742f540e04e7b8105bad1032cd1f1320a9388029e1`
- `apps/web/app/apple-icon.png` SHA-256: `b9d3d18a3375f026afca7a82c222ce961187e3383714a8f600a5dc9692e98520`
