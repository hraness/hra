import { buildSite } from "../scripts/build-site";
import { siteTestBuildOptions, siteTestBuildTerminal, siteTestBuildTerminalPrefix } from "./build-site-test-protocol";

// Static test entry point: arguments are data, never interpolated executable
// source. A separate process owns each compiler and its native descendants.
const input = await Bun.stdin.text();
if (Buffer.byteLength(input) > 16_384) throw new Error("SITE_COMPILER_REQUEST_TOO_LARGE");
const options = siteTestBuildOptions.parse(JSON.parse(input) as unknown);
let terminal: ReturnType<typeof siteTestBuildTerminal.parse>;
try {
  terminal = { status: "success", mismatches: [...await buildSite({
    check: options.check, repositoryRoot: options.repositoryRoot,
    ...(options.sourceRoot === undefined ? {} : { sourceRoot: options.sourceRoot }),
    ...(options.releaseCommit === undefined ? {} : { releaseCommit: options.releaseCommit }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  })] };
} catch (error: unknown) {
  terminal = error instanceof Error
    ? { status: "failure", name: error.name, message: error.message, stack: error.stack }
    : { status: "failure", name: "Error", message: String(error) };
  process.exitCode = 1;
}
process.stdout.write(`\n${siteTestBuildTerminalPrefix}${JSON.stringify(siteTestBuildTerminal.parse(terminal))}\n`);
