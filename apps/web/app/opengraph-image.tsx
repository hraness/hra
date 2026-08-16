import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { HRA_BRAND_EMOJI } from "./site";

export const alt = "HRA: a durable metaharness for Codex";
export const contentType = "image/png";
export const size = { height: 630, width: 1200 };

export default async function OpenGraphImage() {
  const phoenixIconData = await readFile(
    join(process.cwd(), "app", "icon.png"),
    "base64",
  );
  const phoenixIconSource = `data:image/png;base64,${phoenixIconData}`;

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "stretch",
          background: "#f4f1e9",
          color: "#181817",
          display: "flex",
          flexDirection: "column",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          height: "100%",
          justifyContent: "space-between",
          padding: "72px 78px",
          position: "relative",
          width: "100%",
        }}
      >
        <div
          style={{
            border: "1px solid #c9c4b8",
            borderRadius: 999,
            display: "flex",
            height: 300,
            position: "absolute",
            right: -80,
            top: -100,
            width: 300,
          }}
        />
        <div style={{ alignItems: "center", display: "flex", gap: 18 }}>
          <div
            style={{
              alignItems: "center",
              background: "#181817",
              borderRadius: 14,
              color: "#f4f1e9",
              display: "flex",
              fontSize: 34,
              fontWeight: 800,
              height: 66,
              justifyContent: "center",
              width: 66,
            }}
          >
            <img alt={HRA_BRAND_EMOJI} height={66} src={phoenixIconSource} width={66} />
          </div>
          <div style={{ display: "flex", fontSize: 30, fontWeight: 750, letterSpacing: 8 }}>
            HRA
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 940 }}>
          <div style={{ color: "#6d39d8", display: "flex", fontSize: 22, fontWeight: 750, letterSpacing: 4 }}>
            A METAHARNESS FOR CODEX
          </div>
          <div style={{ display: "flex", fontFamily: "Georgia, Times New Roman, serif", fontSize: 68, fontWeight: 600, letterSpacing: -3, lineHeight: 1.04 }}>
            Give Codex a team, a memory, and a budget.
          </div>
        </div>
        <div style={{ borderTop: "1px solid #c9c4b8", display: "flex", fontSize: 23, justifyContent: "space-between", paddingTop: 26 }}>
          <span>Authorized accounts · Durable delegation · Recoverable work</span>
          <span>hra.sh</span>
        </div>
      </div>
    ),
    size,
  );
}
