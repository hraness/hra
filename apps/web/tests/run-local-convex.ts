#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONVEX_BINARY = fileURLToPath(new URL("../node_modules/.bin/convex", import.meta.url));
const SUCCESS_MARKER = "✓ local Convex black-box acceptance passed";

async function main(): Promise<void> {
  const child = Bun.spawn(
    [
      CONVEX_BINARY,
      "dev",
      "--once",
      "--tail-logs",
      "disable",
      "--start",
      "bun run test:local",
    ],
    {
      cwd: WEB_ROOT,
      env: { ...process.env, CONVEX_AGENT_MODE: "anonymous" },
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (stdout.length > 0) process.stdout.write(stdout);
  if (stderr.length > 0) process.stderr.write(stderr);
  const successes = stdout.split(SUCCESS_MARKER).length - 1;
  if (exitCode !== 0) {
    throw new Error(`Convex local acceptance supervisor exited with code ${exitCode}.`);
  }
  if (successes !== 1) {
    throw new Error("Convex local acceptance child did not publish exactly one success marker.");
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : "Convex local acceptance failed.");
  process.exitCode = 1;
}
