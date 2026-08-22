#!/usr/bin/env bun

import { userInfo } from "node:os";

import { parseLocalCliArgs, localCliUsage, LocalCliUsageError } from "./args";
import { LocalCliFailure, queryLocalDesktop } from "./client";
import {
  processLocalCliIo,
  writeLocalCliError,
  writeLocalCliJson,
  type LocalCliIo,
} from "./output";

interface RunLocalCliOptions {
  readonly io?: LocalCliIo;
  readonly homeDirectory?: string;
  readonly expectedUid?: number;
  readonly timeoutMilliseconds?: number;
}

export async function runLocalCli(
  argv: readonly string[],
  options: RunLocalCliOptions = {},
): Promise<number> {
  const io = options.io ?? processLocalCliIo;
  let command;
  try {
    command = parseLocalCliArgs(argv);
  } catch (error: unknown) {
    if (!(error instanceof LocalCliUsageError)) throw error;
    io.stderr.write(`${localCliUsage}\n`);
    return 2;
  }

  try {
    const response = await queryLocalDesktop(command.operation, {
      homeDirectory: options.homeDirectory ?? userInfo().homedir,
      ...(options.expectedUid === undefined ? {} : { expectedUid: options.expectedUid }),
      ...(options.timeoutMilliseconds === undefined
        ? {}
        : { timeoutMilliseconds: options.timeoutMilliseconds }),
    });
    if (!response.ok) {
      writeLocalCliError(io, response.error.code);
      return 1;
    }
    writeLocalCliJson(io, response.result.projection);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof LocalCliFailure
      ? error.code
      : "runtime_unavailable";
    writeLocalCliError(io, code);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runLocalCli(process.argv.slice(2));
}
