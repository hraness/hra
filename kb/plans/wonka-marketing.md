---
title: Restrained story-inspired marketing artwork
status: in-progress
date: 2026-09-10
---

# Direction

Extend the existing product homepage with a sculptural top hat, engraved surface marks, and four small metallic seals referencing a ticket, cane, glass elevator, and gobstopper. Keep the product copy, actual interface, availability boundaries, theme selector, orange-circle identity, and documentation unchanged.

The artwork should suggest a fantastical future workshop through material and geometry. The hat sits at the edge of the hero and fades before the reading area. Localized champagne, lavender, and teal reflections belong to the artwork. They do not replace the shared semantic palette or turn the page into a rainbow surface.

# Rendering decision

[Paper Shaders](https://github.com/paper-design/shaders) supports image dithering, organic halftone dots, and masked liquid metal. [Vercel vgpu](https://github.com/vercel-labs/vgpu) supports custom WebGPU shaders. A small procedural mesh with a bounded WebGL renderer fits this single ornament without adding a runtime dependency or requiring WebGPU. Fine contours and sparse surface marks carry the engraving. The small seals use layered SVG paths and spot foil, informed by the material treatment of [AI Charts model cards](https://aicharts.io/models).

The scene remains almost still until pointer movement changes its angle and light. Rendering stops when settled, offscreen, or hidden. Reduced motion and data-saving preferences keep a fixed pose. Pixel count is bounded. A static vector print remains available without JavaScript, on GPU initialization failure, or after context loss. No remote assets, persistent state, runtime styles, or CSP exceptions are introduced.

# Acceptance

- Implementation: complete. Homepage-only decoration stays outside the accessibility tree and never intercepts controls. Geometry has 5,698 vertices and 10,560 triangles; it requires no external model or texture.
- Focused validation: eight geometry/lifecycle tests, seven existing homepage semantic tests, two marketing layout tests, and 33 CI equivalence tests pass. Focused lint and the first production build pass. Final typecheck and refined build are queued at submission.
- Visual acceptance: actual GPU output checked at desktop width in light and dark themes and at 390px mobile width. No horizontal overflow or console errors; preview enlargement, Escape/focus return, and scene switching work. The initial solid material was refined into translucent engraving with lower mobile opacity; final confirmation and static-print inspection remain pending at submission.
- Independent review: complete. A reviewer who authored no changed files reviewed the entire diff and the final shader changes. The sole test assertion finding was repaired and the focused tests passed again.
- Delivery: pending. Preserve the required exact-head and current-base CI gate before merge, then verify the matching production deployment.
