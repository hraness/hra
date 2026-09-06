import { ClaudeError } from "./errors.ts";
import {
  ClaudeHostToolSocketClient,
  readClaudeHostToolBinding,
  runClaudeHostToolStdio,
} from "./host-tool-bridge.ts";

const bindingPathFromArgv = (argv: readonly string[]): string => {
  if (argv.length !== 2 || argv[0] !== "--binding" || argv[1] === undefined) {
    throw new ClaudeError("INVALID_INPUT", "Claude host-tool bridge requires one binding");
  }
  return argv[1];
};

export async function runClaudeHostToolBridgeMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const material = await readClaudeHostToolBinding(bindingPathFromArgv(argv));
  const source = process.stdin as unknown as AsyncIterable<Uint8Array>;
  await runClaudeHostToolStdio({
    handler: new ClaudeHostToolSocketClient(material),
    onSafeDiagnostic: (message) => process.stderr.write(`${message}\n`),
    source,
    write: async (line) => await new Promise<void>((resolvePromise, rejectPromise) => {
      process.stdout.write(line, (error) => {
        if (error === null || error === undefined) resolvePromise();
        else rejectPromise(error);
      });
    }),
  });
}

if (import.meta.main) {
  try {
    await runClaudeHostToolBridgeMain();
  } catch (error: unknown) {
    const code = error instanceof ClaudeError ? error.code : "unknown";
    process.stderr.write(`Claude host-tool bridge failed: ${code}\n`);
    process.exitCode = 1;
  }
}
