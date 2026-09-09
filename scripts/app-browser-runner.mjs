// Keep this bootstrap executable without a compiler or a global runtime shim.
// Node 24 strips the helper's erasable TypeScript; the browser graph itself is
// compiled by the separately supervised, pinned Bun preparation process.
import process from "node:process";
import console from "node:console";
if (process.versions.bun !== undefined || process.versions.node !== "24.18.1") {
  throw new Error("Browser acceptance requires genuine Node 24.18.1");
}
const { runBrowserBootstrap } = await import("./app-browser-runner.ts");
try { await runBrowserBootstrap(); }
catch {
  console.error("Browser acceptance failed; retained run evidence contains diagnostics.");
  process.exitCode = 1;
}
