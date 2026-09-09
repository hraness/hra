import { link, unlink, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { transformWithEsbuild } from "vite";

const [readyPath] = Bun.argv.slice(2);
if (Bun.argv.length !== 3 || readyPath === undefined || !isAbsolute(readyPath)) throw new Error("SITE_COMPILER_NATIVE_FIXTURE_ARGUMENT_INVALID");
// Start the same native compiler service before reporting readiness. The owner
// must collect both this deliberately stalled leader and its compiler child.
await transformWithEsbuild("export const ready: boolean = true;", "owned-native-compiler.ts");
process.on("SIGTERM", () => {});
await writeFile(`${readyPath}.pending`, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
await link(`${readyPath}.pending`, readyPath);
await unlink(`${readyPath}.pending`);
setInterval(() => {}, 1_000);
