import { resolve } from "node:path";
import { isatty } from "node:tty";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { parseConvexTarget } from "./convex-target";

export const MEMORY_READBACK_INPUT_MAXIMUM_BYTES = 24 * 1024;
export const memoryReadbackUserIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9_-]+$/u);
const publicIdSchema = z.string().uuid();
export const memoryReadbackCursorSchema = z.string().max(16 * 1024).refine((value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
});
const owner = { userId: memoryReadbackUserIdSchema };
const page = { ...owner, cursor: memoryReadbackCursorSchema.nullable() };

export const memoryReadbackOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    devicePublicIds: z.tuple([publicIdSchema, publicIdSchema]),
    kind: z.literal("bind_devices"),
  }).strict(),
  z.object({ ...owner, kind: z.literal("read_category") }).strict(),
  z.object({ ...page, kind: z.literal("audit_memory_spaces") }).strict(),
  z.object({ ...page, kind: z.literal("audit_memory_operations") }).strict(),
]).superRefine((operation, context) => {
  if (operation.kind === "bind_devices"
    && operation.devicePublicIds[0] === operation.devicePublicIds[1]) {
    context.addIssue({ code: "custom", message: "Device identities must differ." });
  }
});
export type MemoryReadbackOperation = z.infer<typeof memoryReadbackOperationSchema>;

const inputSchema = z.object({
  operation: memoryReadbackOperationSchema,
  target: z.unknown().transform((value, context) => {
    try { return parseConvexTarget(value); } catch {
      context.addIssue({ code: "custom", message: "Invalid readback target." });
      return z.NEVER;
    }
  }),
  version: z.literal(1),
}).strict();

const invalid = (): never => { throw new Error("memory_readback_input_invalid"); };

export function parseMemoryReadbackInput(bytes: Uint8Array): z.infer<typeof inputSchema> {
  if (bytes.byteLength === 0 || bytes.byteLength > MEMORY_READBACK_INPUT_MAXIMUM_BYTES) {
    return invalid();
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return inputSchema.parse(value);
  } catch { return invalid(); }
}

/** Fixed read-only commands. Neither a function name nor executable comes from stdin. */
export function memoryReadbackCliArguments(bytes: Uint8Array): readonly string[] {
  const input = parseMemoryReadbackInput(bytes);
  const operation = input.operation;
  const deployment = ["--deployment", input.target.deploymentName];
  if (operation.kind === "bind_devices") {
    // The only interpolated values are schema-checked public IDs encoded as JSON literals.
    const ids = JSON.stringify(operation.devicePublicIds);
    const query = `await (async () => {
      const ids = ${ids};
      const rows = await Promise.all(ids.map(publicId => ctx.db.query("devices")
        .withIndex("by_public_id", q => q.eq("publicId", publicId)).take(2)));
      if (rows.some(matches => matches.length !== 1)) throw new Error("binding_refused");
      const [a, b] = rows.map(matches => matches[0]);
      if (a._id === b._id || a.userId !== b.userId || a.status !== "active"
        || b.status !== "active" || a.deviceClass !== "daemon" || b.deviceClass !== "daemon"
        || a.publicId !== ids[0] || b.publicId !== ids[1]) throw new Error("binding_refused");
      return { userId: a.userId };
    })()`;
    return ["run", "--inline-query", query, ...deployment];
  }
  if (operation.kind === "read_category") {
    return ["run", "quota:readUser", JSON.stringify({ userId: operation.userId }), ...deployment];
  }
  return ["run", "quota:auditDirectTablePage", JSON.stringify({
    paginationOpts: { cursor: operation.cursor, numItems: 200 },
    table: operation.kind === "audit_memory_spaces" ? "memorySpaces" : "memoryOperations",
    userId: operation.userId,
  }), ...deployment];
}

export async function readMemoryReadbackInput(
  stream: ReadableStream<Uint8Array>,
  timeoutMs = 10_000,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reading = async (): Promise<Uint8Array> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MEMORY_READBACK_INPUT_MAXIMUM_BYTES) return invalid();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  };
  try {
    return await Promise.race([
      reading(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("memory_readback_input_invalid")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2 || isatty(0)) invalid();
    const arguments_ = memoryReadbackCliArguments(await readMemoryReadbackInput(Bun.stdin.stream()));
    const packageRoot = resolve(import.meta.dir, "..", "node_modules", "convex");
    const metadata: unknown = await Bun.file(resolve(packageRoot, "package.json")).json();
    z.object({ name: z.literal("convex"), version: z.literal("1.45.0") }).parse(metadata);
    const cli = resolve(packageRoot, "bin", "main.js");
    // Mutate only JS argv inside this bounded child; private IDs never enter OS argv.
    // The parent waits for process exit, not this shim's dynamic-import completion.
    process.argv = [process.execPath, cli, ...arguments_];
    await import(pathToFileURL(cli).href);
  } catch {
    process.stderr.write("memory_readback_child_failed\n");
    process.exitCode = 1;
  }
}
