import type { Database } from "bun:sqlite";
import { z } from "@hra-internal/schema";

const quickCheckSchema = z
  .array(z.object({ quick_check: z.string() }).passthrough())
  .min(1);

export class ControlPlaneIntegrityError extends Error {
  readonly code = "integrity_check_failed" as const;
  readonly recovery = "restore_verified_backup" as const;

  constructor() {
    super(
      "Control-plane database integrity could not be verified. Quit HRA and restore a verified control-plane backup before retrying.",
    );
    this.name = "ControlPlaneIntegrityError";
  }
}

function assertQuickIntegrity(database: Database): void {
  let values: unknown[];
  try {
    // One diagnostic is enough to reject the database and bounds both the
    // returned data and any accidental disclosure from a corrupt page.
    values = database.query("PRAGMA quick_check(1)").all();
  } catch {
    throw new ControlPlaneIntegrityError();
  }
  const parsed = quickCheckSchema.safeParse(values);
  if (
    !parsed.success || parsed.data.length !== 1 ||
    parsed.data[0]?.quick_check !== "ok"
  ) {
    throw new ControlPlaneIntegrityError();
  }
}

function assertForeignKeyIntegrity(database: Database): void {
  let violation: unknown;
  try {
    // `get` stops materializing after the first violation. Raw table and row
    // coordinates never leave this private boundary or its generic error.
    violation = database.query("PRAGMA foreign_key_check").get();
  } catch {
    throw new ControlPlaneIntegrityError();
  }
  if (violation !== null) throw new ControlPlaneIntegrityError();
}

/** Bounded, path-free physical and relational SQLite integrity verification. */
export function assertBoundedControlPlaneIntegrity(database: Database): void {
  assertQuickIntegrity(database);
  assertForeignKeyIntegrity(database);
}
