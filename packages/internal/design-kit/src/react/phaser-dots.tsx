"use client";

import { useEffect, useRef, type CSSProperties, type HTMLAttributes } from "react";
import { classNames } from "./class-names";

export interface PhaserDotsProps extends HTMLAttributes<HTMLDivElement> {
  fadeDirection?: "top" | "bottom" | "left" | "right" | "none";
  mouseGlow?: boolean;
  /** Override the static dot layer's color/opacity classes. */
  dotClassName?: string;
  /** Override the mouse-trail canvas color class. */
  trailClassName?: string;
}

const DOT_PATTERN = "jungle-phaser-dots__static";

const DEFAULT_DOT_STYLE: CSSProperties = {
  color: "var(--phaser-dots-static-color, var(--foreground))",
  opacity: "var(--phaser-dots-static-opacity, 0.025)",
};

const DEFAULT_TRAIL_STYLE: CSSProperties = {
  color: "var(--phaser-dots-trail-color, var(--foreground))",
  opacity: "var(--phaser-dots-trail-opacity, 0.25)",
};

export function PhaserDots({
  className,
  fadeDirection = "none",
  mouseGlow = false,
  dotClassName,
  trailClassName,
  style,
  ...props
}: PhaserDotsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!mouseGlow) return;
    // Motion accessibility: the pointer-trail is a JS/canvas animation the
    // global prefers-reduced-motion CSS block can't reach, so gate it here.
    // The static dot layer still renders; only the animated trail is skipped.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const DOT_STEP = 6;
    const PRIMARY_TRAIL_ALPHA = 0.48;
    const PRIMARY_TRAIL_DECAY_MS = 3800;
    const SECONDARY_TRAIL_ALPHA = 0.34;
    const SECONDARY_TRAIL_DECAY_MS = 10500;
    const MAX_TRAIL_POINTS = 160;
    const POINT_SPACING = DOT_STEP;
    const MAX_INTERPOLATION_STEPS = 2;
    const MAX_RENDERED_PRIMARY_TRAIL_POINTS = 24;
    const MAX_RENDERED_SECONDARY_TRAIL_POINTS = 16;
    const CLICK_TRAIL_STAMP = [
      { dx: 0, dy: 0 },
      { dx: DOT_STEP, dy: 0 },
      { dx: -DOT_STEP, dy: 0 },
      { dx: 0, dy: DOT_STEP },
      { dx: 0, dy: -DOT_STEP },
    ] as const;

    const HOVER_BRUSH_RADIUS = 54;
    const HOVER_BRUSH_ALPHA = 0.6;
    const HOVER_BRUSH_DECAY_MS = 900;
    const MAX_HOVER_POINTS = 6;

    const INTERACTION_PAD = HOVER_BRUSH_RADIUS;
    const RECT_CACHE_MS = 180;
    const FRAME_MIN_INTERVAL_MS = 33;
    const COLOR_CACHE_MS = 1000;
    const DOT_KEY_STRIDE = 8192;
    const CANVAS_DOT_SIZE = 2;
    const CANVAS_DOT_HALF = CANVAS_DOT_SIZE / 2;

    const trail: { x: number; y: number; t: number }[] = [];
    const hoverBrush: { x: number; y: number; t: number }[] = [];
    const dotAlpha = new Map<number, number>();
    const hoverOffsets: Array<{ dx: number; dy: number; weight: number }> = [];

    let lastPoint: { x: number; y: number } | null = null;
    let lastHoverPoint: { x: number; y: number } | null = null;
    let pendingMove: { x: number; y: number } | null = null;
    let pendingDown: { x: number; y: number } | null = null;
    let cachedRect = container.getBoundingClientRect();
    let lastRectRead = 0;
    let lastFrameTime = 0;
    let lastColorRead = 0;
    let drawColor = getComputedStyle(canvas).color;
    let raf = 0;
    let dpr = Math.max(1, window.devicePixelRatio || 1);
    let canvasWidth = Math.max(1, Math.round(cachedRect.width));
    let canvasHeight = Math.max(1, Math.round(cachedRect.height));

    const snapToGrid = (value: number) =>
      Math.round(value / DOT_STEP) * DOT_STEP;

    const resizeCanvas = () => {
      const rect = container.getBoundingClientRect();
      cachedRect = rect;
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const nextDpr = Math.max(1, window.devicePixelRatio || 1);
      if (
        width === canvasWidth &&
        height === canvasHeight &&
        nextDpr === dpr &&
        canvas.width === Math.round(width * nextDpr) &&
        canvas.height === Math.round(height * nextDpr)
      ) {
        return;
      }
      canvasWidth = width;
      canvasHeight = height;
      dpr = nextDpr;
      canvas.width = Math.round(canvasWidth * dpr);
      canvas.height = Math.round(canvasHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    };

    for (
      let dx = -HOVER_BRUSH_RADIUS;
      dx <= HOVER_BRUSH_RADIUS;
      dx += DOT_STEP
    ) {
      for (
        let dy = -HOVER_BRUSH_RADIUS;
        dy <= HOVER_BRUSH_RADIUS;
        dy += DOT_STEP
      ) {
        const dist = Math.hypot(dx, dy);
        if (dist > HOVER_BRUSH_RADIUS) continue;
        hoverOffsets.push({
          dx,
          dy,
          weight: 1 - dist / HOVER_BRUSH_RADIUS,
        });
      }
    }

    resizeCanvas();
    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas();
    });
    resizeObserver.observe(container);

    const getContainerRect = (now: number) => {
      if (now - lastRectRead > RECT_CACHE_MS) {
        cachedRect = container.getBoundingClientRect();
        lastRectRead = now;
      }
      return cachedRect;
    };

    const getLocalPoint = (clientX: number, clientY: number, now: number) => {
      const rect = getContainerRect(now);
      const nearContainer =
        clientX >= rect.left - INTERACTION_PAD &&
        clientX <= rect.right + INTERACTION_PAD &&
        clientY >= rect.top - INTERACTION_PAD &&
        clientY <= rect.bottom + INTERACTION_PAD;
      if (!nearContainer) return null;

      return {
        x: snapToGrid(clientX - rect.left),
        y: snapToGrid(clientY - rect.top),
      };
    };

    const putDot = (x: number, y: number, alpha: number) => {
      if (alpha <= 0) return;
      const sx = snapToGrid(x);
      const sy = snapToGrid(y);
      if (sx < 0 || sy < 0 || sx > canvasWidth || sy > canvasHeight) return;
      const key = sx + sy * DOT_KEY_STRIDE;
      const prev = dotAlpha.get(key);
      if (prev === undefined || alpha > prev) {
        dotAlpha.set(key, alpha);
      }
    };

    const pushHoverBrushPoint = (x: number, y: number) => {
      if (lastHoverPoint?.x === x && lastHoverPoint.y === y) return;
      hoverBrush.push({ x, y, t: performance.now() });
      if (hoverBrush.length > MAX_HOVER_POINTS) {
        hoverBrush.splice(0, hoverBrush.length - MAX_HOVER_POINTS);
      }
      lastHoverPoint = { x, y };
    };

    const pushTrailPoint = (x: number, y: number) => {
      const now = performance.now();
      if (!lastPoint) {
        trail.push({ x, y, t: now });
      } else {
        const dx = x - lastPoint.x;
        const dy = y - lastPoint.y;
        const dist = Math.hypot(dx, dy);
        if (dist < POINT_SPACING) return;
        const steps = Math.min(
          MAX_INTERPOLATION_STEPS,
          Math.max(1, Math.floor(dist / POINT_SPACING)),
        );
        for (let i = 1; i <= steps; i += 1) {
          const ratio = i / steps;
          const px = snapToGrid(lastPoint.x + dx * ratio);
          const py = snapToGrid(lastPoint.y + dy * ratio);
          if (
            trail[trail.length - 1]?.x === px &&
            trail[trail.length - 1]?.y === py
          ) {
            continue;
          }
          trail.push({ x: px, y: py, t: now });
        }
      }
      if (trail.length > MAX_TRAIL_POINTS) {
        trail.splice(0, trail.length - MAX_TRAIL_POINTS);
      }
      lastPoint = { x, y };
    };

    const stampClickTrail = (x: number, y: number, t: number) => {
      for (const offset of CLICK_TRAIL_STAMP) {
        trail.push({
          x: snapToGrid(x + offset.dx),
          y: snapToGrid(y + offset.dy),
          t,
        });
      }
      if (trail.length > MAX_TRAIL_POINTS) {
        trail.splice(0, trail.length - MAX_TRAIL_POINTS);
      }
    };

    const renderDots = (now: number) => {
      dotAlpha.clear();

      for (let i = hoverBrush.length - 1; i >= 0; i -= 1) {
        const p = hoverBrush[i]!;
        const baseAlpha =
          HOVER_BRUSH_ALPHA *
          Math.max(0, 1 - (now - p.t) / HOVER_BRUSH_DECAY_MS);
        if (baseAlpha <= 0) continue;
        for (let j = 0; j < hoverOffsets.length; j += 1) {
          const off = hoverOffsets[j]!;
          putDot(p.x + off.dx, p.y + off.dy, baseAlpha * off.weight);
        }
      }

      let primaryCount = 0;
      let secondaryCount = 0;
      let sampledPrimaryCounter = 0;
      let sampledSecondaryCounter = 0;
      for (
        let i = trail.length - 1;
        i >= 0 &&
        (primaryCount < MAX_RENDERED_PRIMARY_TRAIL_POINTS ||
          secondaryCount < MAX_RENDERED_SECONDARY_TRAIL_POINTS);
        i -= 1
      ) {
        const p = trail[i]!;
        const agePrimary = (now - p.t) / PRIMARY_TRAIL_DECAY_MS;
        const ageSecondary = (now - p.t) / SECONDARY_TRAIL_DECAY_MS;
        if (ageSecondary > 1) continue;

        if (
          primaryCount < MAX_RENDERED_PRIMARY_TRAIL_POINTS &&
          agePrimary <= 1
        ) {
          if (agePrimary > 0.35) {
            const stride = agePrimary > 0.75 ? 4 : 2;
            if (sampledPrimaryCounter % stride !== 0) {
              sampledPrimaryCounter += 1;
            } else {
              putDot(
                p.x,
                p.y,
                PRIMARY_TRAIL_ALPHA * Math.max(0, 1 - agePrimary),
              );
              primaryCount += 1;
              sampledPrimaryCounter += 1;
            }
          } else {
            putDot(p.x, p.y, PRIMARY_TRAIL_ALPHA * Math.max(0, 1 - agePrimary));
            primaryCount += 1;
          }
        }

        if (secondaryCount < MAX_RENDERED_SECONDARY_TRAIL_POINTS) {
          if (ageSecondary > 0.3) {
            const stride = ageSecondary > 0.75 ? 5 : 3;
            if (sampledSecondaryCounter % stride !== 0) {
              sampledSecondaryCounter += 1;
              continue;
            }
            sampledSecondaryCounter += 1;
          }
          putDot(
            p.x,
            p.y,
            SECONDARY_TRAIL_ALPHA * Math.max(0, 1 - ageSecondary),
          );
          secondaryCount += 1;
        }
      }

      if (dotAlpha.size === 0) {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        return;
      }

      if (now - lastColorRead > COLOR_CACHE_MS) {
        drawColor = getComputedStyle(canvas).color;
        lastColorRead = now;
      }

      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
      ctx.fillStyle = drawColor;
      for (const [key, alpha] of dotAlpha) {
        const x = key % DOT_KEY_STRIDE;
        const y = (key - x) / DOT_KEY_STRIDE;
        ctx.globalAlpha = alpha;
        ctx.fillRect(
          x - CANVAS_DOT_HALF,
          y - CANVAS_DOT_HALF,
          CANVAS_DOT_SIZE,
          CANVAS_DOT_SIZE,
        );
      }
      ctx.globalAlpha = 1;
    };

    const tick = (frameTime: number) => {
      if (
        lastFrameTime !== 0 &&
        frameTime - lastFrameTime < FRAME_MIN_INTERVAL_MS
      ) {
        raf = requestAnimationFrame(tick);
        return;
      }
      lastFrameTime = frameTime;
      const now = performance.now();

      if (pendingDown) {
        const point = getLocalPoint(pendingDown.x, pendingDown.y, now);
        pendingDown = null;
        if (point) {
          pushHoverBrushPoint(point.x, point.y);
          stampClickTrail(point.x, point.y, now);
          pushTrailPoint(point.x, point.y);
        }
      }

      if (pendingMove) {
        const point = getLocalPoint(pendingMove.x, pendingMove.y, now);
        pendingMove = null;
        if (point) {
          pushHoverBrushPoint(point.x, point.y);
          pushTrailPoint(point.x, point.y);
        } else {
          lastPoint = null;
          lastHoverPoint = null;
        }
      }

      while (
        hoverBrush.length > 0 &&
        now - hoverBrush[0]!.t > HOVER_BRUSH_DECAY_MS
      ) {
        hoverBrush.shift();
      }
      while (trail.length > 0 && now - trail[0]!.t > SECONDARY_TRAIL_DECAY_MS) {
        trail.shift();
      }

      if (hoverBrush.length === 0 && trail.length === 0) {
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
        raf = 0;
        return;
      }

      renderDots(now);
      raf = requestAnimationFrame(tick);
    };

    const handleMove = (e: PointerEvent) => {
      pendingMove = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const handleDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pendingDown = { x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(tick);
    };

    const handleUp = () => {
      lastPoint = null;
    };

    const passive = { passive: true };
    document.addEventListener("pointermove", handleMove, passive);
    document.addEventListener("pointerdown", handleDown, passive);
    document.addEventListener("pointerup", handleUp, passive);
    document.addEventListener("pointercancel", handleUp, passive);

    return () => {
      document.removeEventListener("pointermove", handleMove);
      document.removeEventListener("pointerdown", handleDown);
      document.removeEventListener("pointerup", handleUp);
      document.removeEventListener("pointercancel", handleUp);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    };
  }, [mouseGlow]);

  const maskGradient =
    fadeDirection === "top"
      ? "linear-gradient(to top, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)"
      : fadeDirection === "bottom"
        ? "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)"
        : fadeDirection === "left"
          ? "linear-gradient(to left, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)"
          : fadeDirection === "right"
            ? "linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 100%)"
            : undefined;

  const mergedStyle: CSSProperties | undefined = maskGradient
    ? {
        ...style,
        WebkitMaskImage: maskGradient,
        maskImage: maskGradient,
      }
    : style;

  return (
    <div
      {...props}
      ref={containerRef}
      role="presentation"
      aria-hidden="true"
      className={classNames("jungle-phaser-dots", className)}
      style={mergedStyle}
    >
      <div
        className={classNames(DOT_PATTERN, dotClassName)}
        style={dotClassName ? undefined : DEFAULT_DOT_STYLE}
      />
      {mouseGlow && (
        <canvas
          ref={canvasRef}
          className={classNames("jungle-phaser-dots__trail", trailClassName)}
          style={trailClassName ? undefined : DEFAULT_TRAIL_STYLE}
        />
      )}
    </div>
  );
}
