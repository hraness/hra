import { Database } from "bun:sqlite";

// Executable extraction of the exact public v0.5.0 StateStore version gate.
// generate-v0.5.0.ts verifies both the source digest and these two released
// source literals before it will replace the logical state fixture.
export const RELEASED_HRA_SCHEMA_VERSION = 33;

export const assertReleasedHraReadonlySchema = (databasePath: string): void => {
  const database = new Database(databasePath, { create: false, readonly: true, strict: true });
  try {
    const row = database.query("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > RELEASED_HRA_SCHEMA_VERSION) {
      throw new Error(`STATE_SCHEMA_NEWER:${String(row.user_version)}:${String(RELEASED_HRA_SCHEMA_VERSION)}`);
    }
    if (row.user_version < RELEASED_HRA_SCHEMA_VERSION) {
      throw new Error(
        `STATE_SCHEMA_MIGRATION_REQUIRED:${String(row.user_version)}:${String(RELEASED_HRA_SCHEMA_VERSION)}`,
      );
    }
  } finally {
    database.close(false);
  }
};
