import { expect, test } from "bun:test";

import { createDevStatusClient } from "./status-client";
import { DEV_APPLY_PATH, DEV_APPLY_SCHEMA } from "./protocol";

const sessionId = "a".repeat(64);
const candidateId = "b".repeat(64);

function status(state: "applying" | "staged") {
  return {
    schema: "hra-dev-status/v1",
    sessionId,
    authority: "launcher",
    revision: state === "staged" ? 1 : 2,
    state,
    target: "gateway",
    changeCount: 1,
    candidateId,
  };
}

test("coordinator mutation binds the exact session and candidate", async () => {
  const requests: Array<{ readonly input: string; readonly init: RequestInit | undefined }> = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const inputText = typeof input === "string"
      ? input
      : input instanceof URL ? input.href : input.url;
    requests.push({ input: inputText, init });
    const body = JSON.stringify(status("applying"));
    return Promise.resolve(new Response(body, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Length": String(new TextEncoder().encode(body).byteLength),
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    }));
  }) as typeof fetch;
  const client = createDevStatusClient(fetcher);

  expect((await client.reserve(sessionId, candidateId)).state).toBe("applying");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.input).toBe(DEV_APPLY_PATH);
  expect(requests[0]?.init?.method).toBe("POST");
  const body = requests[0]?.init?.body;
  expect(typeof body).toBe("string");
  if (typeof body !== "string") throw new Error("Expected one JSON request body.");
  expect(JSON.parse(body)).toEqual({
    schema: DEV_APPLY_SCHEMA,
    sessionId,
    candidateId,
  });
});

test("coordinator reads reject oversized status before JSON parsing", () => {
  const fetcher = (() => Promise.resolve(new Response("{}", {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": "9000",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  }))) as unknown as typeof fetch;

  expect(createDevStatusClient(fetcher).read()).rejects.toThrow(
    "development coordinator is unavailable",
  );
});
