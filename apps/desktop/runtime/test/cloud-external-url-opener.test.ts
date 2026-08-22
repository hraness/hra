import { describe, expect, test } from "bun:test";

import {
  safeDesktopPairingUrl,
} from "../src/cloud/external-url-opener";

const webOrigin = "https://app.hra.example.com";
const pairingId = "pair_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("desktop pairing browser URL", () => {
  test("accepts only the configured web origin and pairing locator path", () => {
    expect(
      safeDesktopPairingUrl(
        `${webOrigin}/pair/desktop/${pairingId}`,
        webOrigin,
      ),
    ).toBe(`${webOrigin}/pair/desktop/${pairingId}`);
  });

  test.each([
    `https://other.example.com/pair/desktop/${pairingId}`,
    `${webOrigin}/pair/desktop/${pairingId}?verifier=secret`,
    `${webOrigin}/pair/desktop/${pairingId}#secret`,
    `${webOrigin}/pair/desktop/short`,
    `${webOrigin}/other/${pairingId}`,
    `https://user:password@app.hra.example.com/pair/desktop/${pairingId}`,
    "not a URL",
  ])("rejects unsafe verification URL %s", (value) => {
    expect(() => safeDesktopPairingUrl(value, webOrigin)).toThrow();
  });

  test("supports the exact configured loopback origin for development", () => {
    expect(safeDesktopPairingUrl(
      `http://127.0.0.1:5173/pair/desktop/${pairingId}`,
      "http://127.0.0.1:5173",
    )).toBe(`http://127.0.0.1:5173/pair/desktop/${pairingId}`);
  });
});
