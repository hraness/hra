import type { CSSProperties, HTMLAttributes } from "react";

import { classNames } from "./class-names";
import {
  createProceduralBackdropRecipe,
  type ProceduralBackdropInput,
  type ProceduralColorRole,
} from "./procedural-recipe";

type ProceduralStyle = CSSProperties & Record<`--jungle-${string}`, string | number>;

export type ProceduralBackdropProps = ProceduralBackdropInput
  & Omit<
    HTMLAttributes<HTMLDivElement>,
    | "accessKey"
    | "aria-hidden"
    | "children"
    | "contentEditable"
    | "inert"
    | "role"
    | "suppressContentEditableWarning"
    | "tabIndex"
  >;

const colorVariables = {
  highlight: "var(--jungle-procedural-highlight)",
  key: "var(--jungle-procedural-key)",
  shadow: "var(--jungle-procedural-shadow)",
  support: "var(--jungle-procedural-support)",
} as const satisfies Readonly<Record<ProceduralColorRole, string>>;

/**
 * A deterministic, server-rendered atmosphere, grid, ripple, or composite
 * field. It never captures or replaces the semantic page beneath it.
 */
export function ProceduralBackdrop({
  className,
  palette,
  seed,
  style,
  variation,
  variant,
  ...props
}: ProceduralBackdropProps) {
  const recipe = createProceduralBackdropRecipe({
    seed,
    ...(palette === undefined ? {} : { palette }),
    ...(variation === undefined ? {} : { variation }),
    ...(variant === undefined ? {} : { variant }),
  });
  const rootStyle: ProceduralStyle = {
    ...style,
    "--jungle-procedural-highlight": recipe.palette.highlight,
    "--jungle-procedural-key": recipe.palette.key,
    "--jungle-procedural-shadow": recipe.palette.shadow,
    "--jungle-procedural-support": recipe.palette.support,
  };
  const showAtmosphere = recipe.variant === "atmosphere"
    || recipe.variant === "composite";
  const showGrid = recipe.variant === "grid" || recipe.variant === "composite";
  const showRipple = recipe.variant === "ripple"
    || recipe.variant === "composite";
  const gridStyle: ProceduralStyle = {
    "--jungle-procedural-grid-offset-x": `${recipe.grid.offsetX}px`,
    "--jungle-procedural-grid-offset-y": `${recipe.grid.offsetY}px`,
    "--jungle-procedural-grid-opacity": recipe.grid.opacity,
    "--jungle-procedural-grid-rotation": `${recipe.grid.rotation}deg`,
    "--jungle-procedural-grid-size": `${recipe.grid.size}px`,
  };
  const rippleStyle: ProceduralStyle = {
    "--jungle-procedural-ripple-aspect": recipe.ripple.aspect,
    "--jungle-procedural-ripple-color":
      colorVariables[recipe.ripple.color],
    "--jungle-procedural-ripple-rotation":
      `${recipe.ripple.rotation}deg`,
    "--jungle-procedural-ripple-x": `${recipe.ripple.x}%`,
    "--jungle-procedural-ripple-y": `${recipe.ripple.y}%`,
  };

  return (
    <div
      {...props}
      aria-hidden="true"
      className={classNames("jungle-procedural-backdrop", className)}
      data-recipe-version={recipe.version}
      data-variation={recipe.variation}
      data-variant={recipe.variant}
      inert
      role="presentation"
      style={rootStyle}
    >
      {showAtmosphere ? (
        <span className="jungle-procedural-backdrop__atmosphere">
          {recipe.atmosphere.map((layer, index) => {
            const layerStyle: ProceduralStyle = {
              "--jungle-procedural-layer-blur": `${layer.blur}px`,
              "--jungle-procedural-layer-color": colorVariables[layer.color],
              "--jungle-procedural-layer-delay": `${layer.delay}ms`,
              "--jungle-procedural-layer-drift-x": `${layer.driftX}px`,
              "--jungle-procedural-layer-drift-y": `${layer.driftY}px`,
              "--jungle-procedural-layer-duration": `${layer.duration}ms`,
              "--jungle-procedural-layer-height": `${layer.height}%`,
              "--jungle-procedural-layer-opacity": layer.opacity,
              "--jungle-procedural-layer-rotation": `${layer.rotation}deg`,
              "--jungle-procedural-layer-scale": layer.scale,
              "--jungle-procedural-layer-width": `${layer.width}%`,
              "--jungle-procedural-layer-x": `${layer.x}%`,
              "--jungle-procedural-layer-y": `${layer.y}%`,
            };
            return (
              <i
                className="jungle-procedural-backdrop__cloud"
                key={index}
                style={layerStyle}
              />
            );
          })}
        </span>
      ) : null}
      {showGrid ? (
        <span
          className="jungle-procedural-backdrop__grid"
          style={gridStyle}
        />
      ) : null}
      {showRipple ? (
        <span
          className="jungle-procedural-backdrop__ripples"
          style={rippleStyle}
        >
          {recipe.ripple.contours.map((contour, index) => {
            const contourStyle: ProceduralStyle = {
              "--jungle-procedural-ripple-delay": `${contour.delay}ms`,
              "--jungle-procedural-ripple-duration":
                `${contour.duration}ms`,
              "--jungle-procedural-ripple-opacity": contour.opacity,
              "--jungle-procedural-ripple-size": `${contour.size}%`,
            };
            return (
              <i
                className="jungle-procedural-backdrop__ripple"
                key={index}
                style={contourStyle}
              />
            );
          })}
        </span>
      ) : null}
    </div>
  );
}
