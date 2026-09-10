import { z } from "zod";

import { oompaAttentionResendApiKeyEnvironmentName } from "../convex/resendApiKey";
import { createBoundedAuthorityFetch, type AuthorityFetcher } from "./bounded-authority-fetch";
import { parseConvexTarget, type ConvexTarget } from "./convex-target";

const environmentSchema = z.array(z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u).max(256),
  value: z.string().max(64 * 1024),
}).strict()).max(1_024);

export type AttentionEnvironment = z.infer<typeof environmentSchema>;

export type AttentionKeyInstallTransport = Readonly<{
  readEnvironment: () => Promise<AttentionEnvironment>;
  installAttentionKey: () => Promise<void>;
}>;

// Convex 1.45's env.ts sends this one-name changes document. Unlike the CLI's
// deploymentFetch, this transport has no application retry loop. HTTP 200 is
// acknowledgement only: env.ts specifies no acknowledgement body schema.
export function createAttentionKeyInstallTransport(options: Readonly<{
  adminKey: string;
  attentionKey: string;
  fetcher?: AuthorityFetcher;
  target: ConvexTarget;
  timeoutMs?: number;
}>): AttentionKeyInstallTransport {
  const target = parseConvexTarget(options.target);
  if (target.deploymentUrl !== `https://${target.deploymentName}.convex.cloud`) {
    throw new Error("target_mismatch");
  }
  const boundedFetch = createBoundedAuthorityFetch(
    options.fetcher ?? fetch, options.timeoutMs ?? 30_000, "provider_deadline",
  );
  const request = async (operation: "read" | "install"): Promise<string> => {
    const response = await boundedFetch(new URL(operation === "read"
      ? "/api/query" : "/api/update_environment_variables", target.deploymentUrl), {
      body: JSON.stringify(operation === "read" ? {
        args: [{}], format: "convex_encoded_json", path: "_system/cli/queryEnvironmentVariables",
      } : {
        changes: [{ name: oompaAttentionResendApiKeyEnvironmentName, value: options.attentionKey }],
      }),
      cache: "no-store",
      headers: { Authorization: `Convex ${options.adminKey}`, "Content-Type": "application/json" },
      method: "POST",
      redirect: "error",
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (reader !== undefined) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > (operation === "read" ? 256 * 1024 : 8 * 1024)) {
            throw new Error("provider_body_limit");
          }
          chunks.push(chunk.value);
        }
      }
      if (response.status !== 200 || response.redirected) throw new Error("provider_unacknowledged");
      return Buffer.concat(chunks).toString("utf8");
    } finally {
      // Cancellation is best effort and must never create an unbounded wait.
      void reader?.cancel().catch(() => undefined);
    }
  };
  return {
    async readEnvironment() {
      // Exact ConvexHttpClient query wire envelope; the pinned system query
      // returns only string name/value entries, needing no rich-value decoding.
      const response = z.object({ status: z.literal("success"), value: environmentSchema })
        .parse(JSON.parse(await request("read")) as unknown);
      const entries = response.value;
      if (new Set(entries.map(({ name }) => name)).size !== entries.length) {
        throw new Error("environment_ambiguous");
      }
      return entries;
    },
    async installAttentionKey() { await request("install"); },
  };
}
