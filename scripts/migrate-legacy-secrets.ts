import {
  BunLegacySecretReader,
  LegacySecretMigrationError,
  migrateLegacySecrets,
  preflightLegacySecretMigration,
  type LegacySecretReader,
} from "../src/storage/legacy-secret-migration";
import { resolveStatePaths, type StatePaths } from "../src/storage/paths";
import {
  DaemonAuthorityBusyError,
  DaemonAuthoritySafetyError,
  DaemonLock,
} from "../src/daemon/daemon-lock";

type Operation = "execute" | "preflight";

export function parseLegacySecretMigrationArguments(
  arguments_: readonly string[],
): Operation {
  if (arguments_.length !== 1) throw new Error("usage_invalid");
  if (arguments_[0] === "preflight") return "preflight";
  if (arguments_[0] === "--execute") return "execute";
  throw new Error("usage_invalid");
}

type OperatorOptions = Readonly<{
  arguments: readonly string[];
  legacyReader?: LegacySecretReader;
  paths?: StatePaths;
  platform?: NodeJS.Platform;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
}>;

const refusalCode = (error: unknown): string => {
  if (error instanceof LegacySecretMigrationError) return error.code;
  if (error instanceof DaemonAuthorityBusyError) return "daemon_running";
  if (error instanceof DaemonAuthoritySafetyError) return "daemon_authority_unsafe";
  if (error instanceof Error && error.message === "usage_invalid") return "usage_invalid";
  return "migration_failed";
};

export async function executeLegacySecretMigrationOperator(
  options: OperatorOptions,
): Promise<number> {
  try {
    const operation = parseLegacySecretMigrationArguments(options.arguments);
    const paths = options.paths ?? resolveStatePaths();
    if (operation === "preflight") {
      const outcome = await preflightLegacySecretMigration(paths);
      options.stdout.write(`${JSON.stringify({
        copiesPending: outcome.copiesPending,
        copiesPresent: outcome.copiesPresent,
        copiesRequired: outcome.copiesRequired,
        nextAction: outcome.nextAction,
        schemaVersion: 1,
        status: outcome.status,
      })}\n`);
      return 0;
    }
    if ((options.platform ?? process.platform) !== "darwin") {
      throw new Error("unsupported_platform");
    }
    const authority = await DaemonLock.acquire(paths, { state: "maintenance" });
    let outcome: Awaited<ReturnType<typeof migrateLegacySecrets>>;
    try {
      outcome = await migrateLegacySecrets(
        paths,
        options.legacyReader ?? new BunLegacySecretReader(),
        authority,
      );
      await authority.assertCurrent();
    } finally {
      await authority.release();
    }
    options.stdout.write(`${JSON.stringify({
      copiesPresent: outcome.copiesPresent,
      copiesRequired: outcome.copiesRequired,
      legacyEntriesRetained: outcome.legacyEntriesRetained,
      schemaVersion: 1,
      status: outcome.status,
    })}\n`);
    return 0;
  } catch (error: unknown) {
    const code = error instanceof Error && error.message === "unsupported_platform"
      ? "unsupported_platform"
      : refusalCode(error);
    options.stderr.write(`${JSON.stringify({ code, schemaVersion: 1, status: "refused" })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await executeLegacySecretMigrationOperator({
    arguments: process.argv.slice(2),
    stderr: process.stderr,
    stdout: process.stdout,
  });
}
