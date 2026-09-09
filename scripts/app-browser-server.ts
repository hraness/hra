import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

type AssetResponse = Readonly<{ status: number; headers: Readonly<Record<string, string>>; body: Buffer | undefined }>;
const productAssetKey = /^examples\/app\/(?:index\.html|stylex\.css|graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/u;
export function browserAssetResponse(options: Readonly<{
  method: string | undefined; url: string | undefined; files: ReadonlyMap<string, Buffer>;
  csp: string; previewCsp?: string; productPreviewCsp?: string; assetPath: (path: string, fonts: ReadonlySet<string>) => string | null;
  contentType: (key: string) => string;
}>): AssetResponse {
  if (options.method !== "GET" && options.method !== "HEAD") return { status: 405, headers: {}, body: undefined };
  const url = options.url;
  if (url === undefined || url.length > 8192 || !url.startsWith("/") || url.startsWith("//")) return { status: 400, headers: {}, body: undefined };
  let pathname: string;
  try { pathname = new URL(url, "http://127.0.0.1").pathname; }
  catch { return { status: 400, headers: {}, body: undefined }; }
  const fonts = new Set([...options.files.keys()].filter((path) => path.endsWith(".woff2")));
  const key = options.assetPath(pathname, fonts), bytes = key === null ? undefined : options.files.get(key);
  if (key === null || bytes === undefined) return { status: 404, headers: {}, body: undefined };
  const product = key.startsWith("examples/app/");
  let csp = pathname === "/preview/" && options.previewCsp !== undefined ? options.previewCsp : options.csp;
  if (product) {
    if (options.productPreviewCsp === undefined || !productAssetKey.test(key)) {
      return { status: 404, headers: {}, body: undefined };
    }
    csp = options.productPreviewCsp;
  }
  return { status: 200, headers: {
    "Cache-Control": "no-store", "Content-Security-Policy": csp,
    "Content-Type": options.contentType(key), "X-Content-Type-Options": "nosniff",
    ...(product ? {
      "Access-Control-Allow-Origin": "*",
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow",
    } : { "Cross-Origin-Opener-Policy": "same-origin" }),
  }, body: options.method === "HEAD" ? undefined : bytes };
}

export function browserServerCloser(operations: Readonly<{
  close: () => Promise<void>; terminateConnections: () => void; listening: () => boolean; connections: () => number;
}>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= (async () => {
      const closed = operations.close(); operations.terminateConnections();
      await closed;
      const deadline = performance.now() + 4000;
      while (operations.connections() !== 0 && performance.now() < deadline) await new Promise((done) => setTimeout(done, 10));
      assert.equal(operations.listening(), false, "Browser server listener survived close");
      assert.equal(operations.connections(), 0, "Browser server connections survived close");
    })();
    return closing;
  };
}

export async function serveBrowserAssets(options: Omit<Parameters<typeof browserAssetResponse>[0], "method" | "url">): Promise<Readonly<{ origin: string; stop: () => Promise<void> }>> {
  const sockets = new Set<Socket>();
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const result = browserAssetResponse({ ...options, method: request.method, url: request.url });
    response.writeHead(result.status, result.headers); response.end(result.body);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.requestTimeout = 20_000; server.headersTimeout = 20_000;
  let runtimeFailure: Error | undefined;
  server.on("error", (error) => { runtimeFailure = error; });
  const stop = browserServerCloser({
    close: async () => {
      await new Promise<void>((done, reject) => {
        server.close((error) => { if (error !== undefined) reject(error); else done(); });
      });
      if (runtimeFailure !== undefined) throw runtimeFailure;
    },
    terminateConnections: () => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
    },
    listening: () => server.listening, connections: () => sockets.size,
  });
  // Install cleanup before the first asynchronous acquisition boundary.
  try {
    const admission = new AbortController();
    const timer = setTimeout(() => admission.abort(), 5000);
    try {
      await new Promise<void>((done, reject) => {
        const failed = (error: Error) => { server.off("error", failed); reject(error); };
        admission.signal.addEventListener("abort", () => failed(new Error("Browser server admission deadline")), { once: true });
        server.once("error", failed);
        server.listen({ host: "127.0.0.1", port: 0, signal: admission.signal }, () => {
          server.off("error", failed);
          if (admission.signal.aborted) reject(new Error("Browser server admission cancelled")); else done();
        });
      });
    } finally { clearTimeout(timer); }
    const address = server.address(); assert.ok(address !== null && typeof address === "object" && address.address === "127.0.0.1");
    return { origin: `http://127.0.0.1:${address.port}`, stop };
  } catch (error) {
    if (server.listening) {
      try { await stop(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Browser server acquisition and cleanup failed"); }
    }
    throw error instanceof Error ? error : new Error("Browser server acquisition failed", { cause: error });
  }
}
