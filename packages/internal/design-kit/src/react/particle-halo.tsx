import type {
  CSSProperties,
  HTMLAttributes,
  ReactNode,
} from "react";

import { classNames } from "./class-names";
import {
  createParticleHaloRecipe,
  type ProceduralColorRole,
  type ProceduralEffectInput,
} from "./procedural-recipe";

type ProceduralStyle = CSSProperties & Record<`--jungle-${string}`, string | number>;

export type ParticleHaloProps = ProceduralEffectInput
  & Omit<HTMLAttributes<HTMLDivElement>, "aria-hidden" | "children"> & Readonly<{
    children: ReactNode;
  }>;

const colorVariables = {
  highlight: "var(--jungle-procedural-highlight)",
  key: "var(--jungle-procedural-key)",
  shadow: "var(--jungle-procedural-shadow)",
  support: "var(--jungle-procedural-support)",
} as const satisfies Readonly<Record<ProceduralColorRole, string>>;

/**
 * Wraps ordinary semantic artwork in a deterministic decorative particle
 * field. The children stay visible and remain the only meaningful content.
 */
export function ParticleHalo({
  children,
  className,
  palette,
  seed,
  style,
  variation,
  ...props
}: ParticleHaloProps) {
  const recipe = createParticleHaloRecipe({
    seed,
    ...(palette === undefined ? {} : { palette }),
    ...(variation === undefined ? {} : { variation }),
  });
  const rootStyle: ProceduralStyle = {
    ...style,
    "--jungle-procedural-highlight": recipe.palette.highlight,
    "--jungle-procedural-key": recipe.palette.key,
    "--jungle-procedural-shadow": recipe.palette.shadow,
    "--jungle-procedural-support": recipe.palette.support,
  };

  return (
    <div
      {...props}
      className={classNames("jungle-particle-halo", className)}
      data-recipe-version={recipe.version}
      data-variation={recipe.variation}
      style={rootStyle}
    >
      <span
        aria-hidden="true"
        className="jungle-particle-halo__particles"
        role="presentation"
      >
        {recipe.particles.map((particle, index) => {
          const particleStyle: ProceduralStyle = {
            "--jungle-particle-color": colorVariables[particle.color],
            "--jungle-particle-delay": `${particle.delay}ms`,
            "--jungle-particle-drift-x": `${particle.driftX}px`,
            "--jungle-particle-drift-y": `${particle.driftY}px`,
            "--jungle-particle-duration": `${particle.duration}ms`,
            "--jungle-particle-opacity": particle.opacity,
            "--jungle-particle-size": `${particle.size}px`,
            "--jungle-particle-x": `${particle.x}%`,
            "--jungle-particle-y": `${particle.y}%`,
          };
          return (
            <i
              className="jungle-particle-halo__particle"
              key={index}
              style={particleStyle}
            />
          );
        })}
      </span>
      <div className="jungle-particle-halo__content">{children}</div>
    </div>
  );
}
