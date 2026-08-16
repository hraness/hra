import { ImageResponse } from "next/og";

import { LARGE_SOCIAL_IMAGE } from "./discovery";

export const socialImageSize = LARGE_SOCIAL_IMAGE;
export const socialImageContentType = "image/png";

export type SocialImageTheme = Readonly<{
  accent: string;
  background: string;
  foreground: string;
  muted: string;
}>;

export type SocialImageDetails = Readonly<{
  description: string;
  domain: string;
  eyebrow?: string;
  mark?: string;
  theme?: Partial<SocialImageTheme>;
  title: string;
}>;

export const plainSocialImageTheme = {
  accent: "#2457A6",
  background: "#FFFFFF",
  foreground: "#171717",
  muted: "#666666",
} as const satisfies SocialImageTheme;

function color(value: string, label: string): string {
  if (!/^#[0-9A-F]{6}$/iu.test(value)) {
    throw new RangeError(`${label} must be a six-digit hex color; received ${value}.`);
  }
  return value;
}

export function createSocialImageResponse(
  details: SocialImageDetails,
): ImageResponse {
  const theme = {
    accent: color(
      details.theme?.accent ?? plainSocialImageTheme.accent,
      "accent",
    ),
    background: color(
      details.theme?.background ?? plainSocialImageTheme.background,
      "background",
    ),
    foreground: color(
      details.theme?.foreground ?? plainSocialImageTheme.foreground,
      "foreground",
    ),
    muted: color(
      details.theme?.muted ?? plainSocialImageTheme.muted,
      "muted",
    ),
  };

  return new ImageResponse(
    (
      <div
        style={{
          background: theme.background,
          color: theme.foreground,
          display: "flex",
          flexDirection: "column",
          fontFamily: "Arial, Helvetica, sans-serif",
          height: "100%",
          justifyContent: "space-between",
          padding: "58px 66px",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            borderBottom: `1px solid ${theme.muted}`,
            color: theme.foreground,
            display: "flex",
            fontSize: 22,
            fontWeight: 700,
            justifyContent: "space-between",
            paddingBottom: 18,
          }}
        >
          <span>{details.eyebrow ?? details.domain}</span>
          {details.mark === undefined
            ? null
            : <span style={{ fontSize: 36 }}>{details.mark}</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize: details.title.length > 58 ? 52 : 64,
              fontWeight: 700,
              letterSpacing: "-0.025em",
              lineHeight: 1.08,
              maxWidth: 1040,
            }}
          >
            {details.title}
          </div>
          <div
            style={{
              color: theme.muted,
              fontSize: 26,
              lineHeight: 1.4,
              maxWidth: 980,
            }}
          >
            {details.description}
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            borderTop: `1px solid ${theme.muted}`,
            fontSize: 21,
            justifyContent: "space-between",
          }}
        >
          <span style={{ color: theme.accent, paddingTop: 18 }}>
            {details.domain}
          </span>
        </div>
      </div>
    ),
    LARGE_SOCIAL_IMAGE,
  );
}
