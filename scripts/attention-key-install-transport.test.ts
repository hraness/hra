import { describe, expect, test } from "bun:test";

import { hraAttentionResendApiKeyEnvironmentName } from "../convex/resendApiKey";
import { createAttentionKeyInstallTransport } from "./attention-key-install-transport";
import { HRA_CONVEX_PROJECT_ID, HRA_CONVEX_TEAM_ID, type ConvexTarget } from "./convex-target";

const target: ConvexTarget = {
  deploymentId: 7_654_321, deploymentName: "steady-otter-321",
  deploymentUrl: "https://steady-otter-321.convex.cloud",
  projectId: HRA_CONVEX_PROJECT_ID, teamId: HRA_CONVEX_TEAM_ID,
};
const credentials = { adminKey: "synthetic-admin", attentionKey: "re_synthetic_attention", target };

describe("bounded attention key provider transport", () => {
  test("uses the pinned closed query and one-name update wire contracts", async () => {
    const calls: { input: string; init: RequestInit | undefined }[] = [];
    const transport = createAttentionKeyInstallTransport({
      ...credentials,
      fetcher: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push({ input: url, init });
        return url.endsWith("/api/query")
          ? Response.json({ status: "success", value: [{ name: "HRA_TEST", value: "private" }], logLines: [] })
          : new Response("", { status: 200 });
      },
    });
    expect(await transport.readEnvironment()).toEqual([{ name: "HRA_TEST", value: "private" }]);
    await transport.installAttentionKey();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.input).toBe(`${target.deploymentUrl}/api/query`);
    expect(calls[0]?.init?.body).toBe(JSON.stringify({
      args: [{}], format: "convex_encoded_json", path: "_system/cli/queryEnvironmentVariables",
    }));
    expect(calls[1]?.input).toBe(`${target.deploymentUrl}/api/update_environment_variables`);
    expect(calls[1]?.init?.body).toBe(JSON.stringify({
      changes: [{ name: hraAttentionResendApiKeyEnvironmentName, value: credentials.attentionKey }],
    }));
    for (const call of calls) {
      expect(call.init?.method).toBe("POST");
      expect(call.init?.redirect).toBe("error");
      expect(call.init?.cache).toBe("no-store");
      expect(new Headers(call.init?.headers).get("Authorization")).toBe(`Convex ${credentials.adminKey}`);
      expect(new Headers(call.init?.headers).get("Content-Type")).toBe("application/json");
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test.each([204, 301, 302, 307, 400, 401, 404, 429, 500, 503])("HTTP %i never retries or acknowledges", async (status) => {
    let calls = 0;
    const transport = createAttentionKeyInstallTransport({
      ...credentials, fetcher: async () => {
        calls += 1;
        return new Response(null, { status });
      },
    });
    await expect(transport.installAttentionKey()).rejects.toThrow("provider_unacknowledged");
    expect(calls).toBe(1);
  });

  test("accepts only HTTP 200 acknowledgement without inventing a body schema", async () => {
    for (const body of ["", "{}", "provider acknowledged"]) {
      const transport = createAttentionKeyInstallTransport({ ...credentials, fetcher: async () => new Response(body) });
      await expect(transport.installAttentionKey()).resolves.toBeUndefined();
    }
  });

  test("bounds response bodies and does not reflect them through errors", async () => {
    let calls = 0;
    const transport = createAttentionKeyInstallTransport({ ...credentials, fetcher: async () => {
      calls += 1;
      return new Response("private".repeat(2_000));
    } });
    await expect(transport.installAttentionKey()).rejects.toThrow("provider_body_limit");
    expect(calls).toBe(1);
    const read = createAttentionKeyInstallTransport({ ...credentials,
      fetcher: async () => new Response("x".repeat(256 * 1024 + 1)) });
    await expect(read.readEnvironment()).rejects.toThrow("provider_body_limit");
  });

  test("one transport exception is one invocation", async () => {
    let calls = 0;
    const transport = createAttentionKeyInstallTransport({ ...credentials, fetcher: async () => {
      calls += 1;
      throw new Error("synthetic transport failure");
    } });
    await expect(transport.installAttentionKey()).rejects.toThrow("synthetic transport failure");
    expect(calls).toBe(1);
  });

  test("header and stalled-body deadlines abort once even when fetch ignores its signal", async () => {
    for (const bodyStalls of [false, true]) {
      let calls = 0;
      let signal: AbortSignal | null | undefined;
      const transport = createAttentionKeyInstallTransport({ ...credentials, timeoutMs: 5,
        fetcher: async (_input, init) => {
          calls += 1;
          signal = init?.signal;
          if (!bodyStalls) return await new Promise<Response>(() => {});
          return new Response(new ReadableStream<Uint8Array>({ start() {} }));
        },
      });
      await expect(transport.installAttentionKey()).rejects.toThrow("provider_deadline");
      expect(calls).toBe(1);
      expect(signal?.aborted).toBe(true);
    }
  });

  test("refuses unbound targets and malformed or duplicate environment responses", async () => {
    expect(() => createAttentionKeyInstallTransport({ ...credentials,
      target: { ...target, deploymentUrl: "https://other-otter-321.convex.cloud" } })).toThrow("target_mismatch");
    for (const response of [
      [], { status: "error", errorMessage: "private" }, { status: "success", value: null },
      { status: "success", value: [{ name: "X", value: "a" }, { name: "X", value: "b" }] },
      { status: "success", value: [{ name: "X", value: 1 }] },
    ]) {
      const transport = createAttentionKeyInstallTransport({ ...credentials,
        fetcher: async () => Response.json(response) });
      await expect(transport.readEnvironment()).rejects.toThrow();
    }
  });
});
