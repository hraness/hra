import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { z } from "zod";
import { createSiteTestCompilerChildJoin } from "./site-test-compiler-child-join";
import { holdSiteTestCompilerEventLoop } from "./site-test-compiler-event-loop";
import { installSiteTestCompilerSpawnScope } from "./site-test-compiler-spawn-scope";

const require = createRequire(import.meta.url);
const modulePath = require.resolve("esbuild");
// This adapter depends on the pinned CJS module's dynamic spawn acquisition.
// A dependency update needs a fresh source review and native lifetime proof.
if (createHash("sha256").update(readFileSync(modulePath)).digest("hex")
  !== "7c43f01f4763db2c2bc339edf6e8a81537fbf894152a691d68f7826a889851a7") {
  throw new Error("SITE_COMPILER_ESBUILD_MODULE_MISMATCH");
}
const platform = z.enum(["darwin", "linux"]).parse(process.platform);
const architecture = z.enum(["arm64", "x64"]).parse(process.arch);
const nativeRequire = createRequire(modulePath);
const nativePath = realpathSync(nativeRequire.resolve(`@esbuild/${platform}-${architecture}/bin/esbuild`));
const nativeArguments = z.tuple([
  z.string(), z.tuple([z.literal("--service=0.27.0"), z.literal("--ping")]),
  z.object({ cwd: z.literal(process.cwd()), windowsHide: z.literal(true),
    stdio: z.tuple([z.literal("pipe"), z.literal("pipe"), z.literal("inherit")]),
  }).strict(),
]);
let stop: () => Promise<void> = () => Promise.reject(new Error("SITE_COMPILER_ESBUILD_NOT_READY"));
const join = createSiteTestCompilerChildJoin({
  stop: () => stop(),
  onFailure: () => { process.exitCode = 1; },
  keepAlive: holdSiteTestCompilerEventLoop,
});
const scope = installSiteTestCompilerSpawnScope(childProcess, join, (input) => {
  const [command] = nativeArguments.parse(input);
  if (realpathSync(command) !== nativePath) throw new Error("SITE_COMPILER_NATIVE_COMMAND_MISMATCH");
}, () => { process.exitCode = 1; });
const esbuild = await import("esbuild");
if (esbuild.version !== "0.27.0") throw new Error("SITE_COMPILER_ESBUILD_VERSION_MISMATCH");
stop = esbuild.stop;

export const stopSiteTestCompiler = (): Promise<void> => scope.close();
