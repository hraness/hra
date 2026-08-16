"use client";

import { PhaserDots } from "./phaser-dots";

/** The shared fixed aurora canvas and interactive 6 px dot grid. */
export function AuroraDotsBackground() {
  return (
    <>
      <div aria-hidden="true" className="jungle-aurora-background" />
      <div aria-hidden="true" className="jungle-aurora-dots">
        <PhaserDots mouseGlow />
      </div>
    </>
  );
}
