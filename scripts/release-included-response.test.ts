import { describe, expect, test } from "bun:test";

import { parseGitHubIncludedJsonResponse } from "./release-included-response";

function response(status: number, reason: string, body: unknown): Uint8Array {
  return Buffer.from([
    `HTTP/2.0 ${String(status)} ${reason}`,
    "Content-Type: application/json; charset=utf-8",
    "X-Github-Request-Id: ABC:123",
    "",
    JSON.stringify(body),
  ].join("\n"));
}

describe("bounded GitHub included response", () => {
  test("uses the structured HTTP status and JSON body", () => {
    expect(parseGitHubIncludedJsonResponse(response(404, "Not Found", {
      message: "Not Found",
      status: "404",
    }))).toEqual({
      body: { message: "Not Found", status: "404" },
      status: 404,
    });
  });

  test("rejects diagnostic text and ambiguous multiple response blocks", () => {
    expect(() => parseGitHubIncludedJsonResponse(Buffer.from("gh: Not Found (HTTP 404)"))).toThrow();
    const first = Buffer.from(response(200, "OK", { id: 1 })).toString("utf8");
    const second = Buffer.from(response(404, "Not Found", { status: "404" })).toString("utf8");
    expect(() => parseGitHubIncludedJsonResponse(Buffer.from(`${first}\n\n${second}`))).toThrow();
  });
});
