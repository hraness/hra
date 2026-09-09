import { fileURLToPath } from "node:url";

/** A classic external script applies the saved palette before the page paints. */
export async function buildHraAppearance(): Promise<string> {
  const result = await Bun.build({
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    entrypoints: [fileURLToPath(new URL("../app/src/appearance-entry.ts", import.meta.url))],
    format: "iife",
    minify: true,
    sourcemap: "none",
    target: "browser",
    write: false,
  });
  const output = result.outputs[0];
  if (!result.success || result.outputs.length !== 1 || output === undefined) {
    throw new Error(`HRA appearance bundle failed: ${result.logs.map((log) => log.message).join("\n")}`);
  }
  return await output.text();
}

if (import.meta.main) process.stdout.write(await buildHraAppearance());
