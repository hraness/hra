import { rm } from "node:fs/promises";
import { join } from "node:path";

import { verifyBunCompiler } from "./verify-runtime-pins";

async function main(): Promise<void> {
  const compiler = await verifyBunCompiler();
  const output = join(import.meta.dir, "dist/oprte-gateway");
  await rm(output, { force: true });
  const child = Bun.spawn([
    compiler.executable,
    "build",
    "--compile",
    "--minify",
    "--sourcemap=none",
    join(import.meta.dir, "src/main.ts"),
    "--outfile",
    output,
  ], {
    cwd: join(import.meta.dir, ".."),
    env: process.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Pinned Bun gateway compilation failed with exit code ${exitCode}.`);
  }
}

if (import.meta.main) await main();
